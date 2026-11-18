import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  TRANSFER_GENERIC_ERROR,
  TransferMaintenancePanel,
  formatTransferBytes,
  formatTransferState,
  pendingTransferEntries,
  shortScopeHash,
  transferEntryPurpose,
  transferErrorMessage,
  transferOutcomeNotice,
  transferReleaseConfirmation,
  transferResumeConfirmation,
  transferUnknownNotice,
} from "../src/renderer/sync/TransferMaintenancePanel";
import type {
  TransferMaintenanceEntry,
  TransferMaintenanceView,
  TransferReleaseResult,
} from "../src/shared/sync-management";

const entries: TransferMaintenanceEntry[] = [
  {
    entryId: "entry-active",
    scopeHash: "scope-current-hash-1234567890",
    assetId: "asset-1",
    bytes: 2048,
    offset: 0,
    state: "active",
    currentScope: true,
    canRelease: true,
    reason: null,
  },
  {
    entryId: "entry-blocked",
    scopeHash: "scope-old",
    assetId: null,
    bytes: 0,
    offset: 0,
    state: "blocked",
    currentScope: false,
    canRelease: false,
    reason: "blocked by sync",
  },
  {
    entryId: "entry-completed",
    scopeHash: "scope-old-2",
    assetId: "asset-2",
    bytes: 4096,
    offset: 1024,
    state: "completed",
    currentScope: false,
    canRelease: true,
    reason: "stale cache",
  },
  {
    entryId: "entry-unknown",
    scopeHash: "scope-unknown",
    assetId: null,
    bytes: 512,
    offset: 0,
    state: "unknown",
    currentScope: false,
    canRelease: false,
    reason: "unreleasable",
  },
];

const pendingEntry: TransferMaintenanceEntry = {
  entryId: "entry-pending",
  scopeHash: "scope-pending-hash-abcdef",
  assetId: "asset-pending",
  bytes: 1024,
  offset: 0,
  state: "releasing",
  currentScope: false,
  canRelease: false,
  reason: "release in progress",
  operationId: "op-resume-1",
};

const view: TransferMaintenanceView = {
  entries,
  nextCursor: "cursor-2",
  usedBytes: 6656,
  overLimit: true,
  held: "別のプロセスがメンテナンスを保留しています",
};

function handlers() {
  return {
    onRefresh: vi.fn(async (_cursor?: string) => {}),
    onPlan: vi.fn(async () => {
      throw new Error("not called during SSR");
    }),
    onRelease: vi.fn(async () => {
      throw new Error("not called during SSR");
    }),
    onResolve: vi.fn(async () => {
      throw new Error("not called during SSR");
    }),
  };
}

function render(
  nextView: TransferMaintenanceView = view,
  busy = false,
  onRefresh: ((cursor?: string) => Promise<void>) | undefined = handlers().onRefresh,
) {
  return renderToStaticMarkup(
    createElement(TransferMaintenancePanel, {
      view: nextView,
      busy,
      ...handlers(),
      onRefresh,
    }),
  );
}

function buttonTag(html: string, label: string): string {
  const text = `>${label}</button>`;
  const index = html.indexOf(text);
  return html.slice(html.lastIndexOf("<button", index), index + text.length);
}

describe("TransferMaintenancePanel Japanese SSR", () => {
  it("shows purpose and a short scope hash with bytes while keeping the full entry id in advanced detail", () => {
    const html = render();

    expect(html).toContain("転送メンテナンス");
    expect(html).toContain("目的とスコープ");
    expect(html).toContain("転送中のキャッシュ");
    expect(html).toContain("scope-cu…");
    expect(html).toContain("2048 バイト（2.0 KiB）");
    expect(html).toContain("<summary>詳細</summary>");
    expect(html).toContain("<dt>エントリ ID</dt>");
    expect(html).toContain("<code>entry-active</code>");
    expect(html).toContain("完全なスコープハッシュ");

    const rowStart = html.indexOf('data-entry-id="entry-active"');
    const rowDetail = html.indexOf("<details>", rowStart);
    const summaryCell = html.slice(rowStart, rowDetail);
    expect(summaryCell).not.toContain("<code>entry-active</code>");
  });

  it("translates retained bytes, over-limit, held state, rows and actions", () => {
    const html = render();

    expect(html).toContain("保持バイト数");
    expect(html).toContain("6656 バイト（6.5 KiB）");
    expect(html).toContain("上限超過");
    expect(html).toContain(">はい<");
    expect(html).toContain("別のプロセスがメンテナンスを保留しています");
    expect(html).toContain("保留中でも更新できます");
    expect(html).toContain(">更新</button>");
    expect(html).toContain(">さらに読み込む</button>");
    expect(html).toContain('data-cursor="cursor-2"');
    expect(html).toContain(">転送中<");
    expect(html).toContain(">ブロック中<");
    expect(html).toContain(">完了<");
    expect(html).toContain(">不明<");
    expect(html).toContain("理由なし");
    expect(html).toContain("このエントリは保持されます。解放できません。");

    expect(html).not.toContain("Retained bytes");
    expect(html).not.toContain("Over limit");
    expect(html).not.toContain("Preview release");
    expect(html).not.toContain("No reason supplied");
    expect(html).not.toContain("Current scope");
    expect(html).not.toContain("Keep this entry");
  });

  it("offers a release preview only for releasable entries", () => {
    const html = render();

    expect((html.match(/>解放内容を確認</g) ?? []).length).toBe(2);
    expect(html).toContain("scope-cu… の解放内容を確認");
    expect(html).toContain("scope-ol… の解放内容を確認");
    expect(html).not.toContain("scope-old の解放内容を確認");
    expect(html).not.toContain("scope-un… の解放内容を確認");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("解放を実行");
  });

  it("shows pending operations from a recreated view and blocks new plans", () => {
    const html = render({ ...view, entries: [...entries, pendingEntry] });

    expect(html).toContain("保留中の解放操作");
    expect(html).toContain("op-resume-1");
    expect(html).toContain("再起動後も残っている解放操作");
    expect(html).toContain("新しい解放チケットは作成しません");
    expect(html).toContain(">結果を照会</button>");
    expect(html).toContain(">解放を再開</button>");
    expect(html).toContain("新しい解放の確認はできません");
    expect(buttonTag(html, "解放内容を確認")).toContain("disabled");
  });

  it("does not call any action while server rendering", () => {
    const props = { view, busy: false, ...handlers() };

    renderToStaticMarkup(createElement(TransferMaintenancePanel, props));

    expect(props.onRefresh).not.toHaveBeenCalled();
    expect(props.onPlan).not.toHaveBeenCalled();
    expect(props.onRelease).not.toHaveBeenCalled();
    expect(props.onResolve).not.toHaveBeenCalled();
  });

  it("handles an empty page and no next cursor", () => {
    const html = render(
      { entries: [], nextCursor: null, usedBytes: 0, overLimit: false, held: null },
      false,
    );

    expect(html).toContain("転送エントリはありません。");
    expect(html).toContain(">いいえ<");
    expect(html).toContain(">なし<");
    expect(html).not.toContain("さらに読み込む");
    expect(html).not.toContain("保留中でも更新できます");
  });

  it("marks the panel busy and disables actions", () => {
    const html = render(view, true);

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("処理中…");
    expect(buttonTag(html, "更新")).toContain("disabled");
    expect(buttonTag(html, "解放内容を確認")).toContain("disabled");
  });

  it("still renders when the optional onRefresh prop is omitted", () => {
    const props = handlers();
    const html = renderToStaticMarkup(
      createElement(TransferMaintenancePanel, {
        view,
        busy: false,
        onPlan: props.onPlan,
        onRelease: props.onRelease,
        onResolve: props.onResolve,
      }),
    );

    expect(html).toContain("転送メンテナンス");
    expect(buttonTag(html, "更新")).toContain("disabled");
  });
});

describe("transfer release model", () => {
  it("uses Japanese labels, the exact entry identity and a short scope", () => {
    const confirm = transferReleaseConfirmation(entries[0]);

    expect(confirm.entryId).toBe("entry-active");
    expect(confirm.assetId).toBe("asset-1");
    expect(confirm.scopeHash).toBe("scope-current-hash-1234567890");
    expect(confirm.shortScopeHash).toBe("scope-cu…");
    expect(confirm.shortScopeHash.length).toBeLessThan(confirm.scopeHash.length);
    expect(confirm.purpose).toBe("転送中のキャッシュ");
    expect(confirm.currentScope).toBe(true);
    expect(confirm.scopeLabel).toBe("現在のスコープ");
    expect(confirm.bytes).toBe(2048);
    expect(confirm.bytesLabel).toBe("2048 バイト（2.0 KiB）");
    expect(confirm.cacheNotice).toContain("不完全なキャッシュは再ダウンロードされます");
  });

  it("shows an explicit missing asset and old scope", () => {
    const confirm = transferReleaseConfirmation(entries[1]);

    expect(confirm.assetId).toBe("なし");
    expect(confirm.scopeLabel).toBe("古いスコープ");
    expect(confirm.bytesLabel).toBe("0 バイト（0 B）");
  });

  it("formats bytes deterministically", () => {
    expect(formatTransferBytes(0)).toBe("0 B");
    expect(formatTransferBytes(512)).toBe("512 B");
    expect(formatTransferBytes(2048)).toBe("2.0 KiB");
    expect(formatTransferBytes(6656)).toBe("6.5 KiB");
  });

  it("shortens only long scope hashes", () => {
    expect(shortScopeHash("old")).toBe("old");
    expect(shortScopeHash("scope-current-hash-1234567890")).toBe("scope-cu…");
    expect(shortScopeHash("scope-current-hash-1234567890", 12)).toBe("scope-curren…");
  });

  it("describes entry purpose and state in Japanese", () => {
    expect(transferEntryPurpose(entries[0])).toBe("転送中のキャッシュ");
    expect(transferEntryPurpose(pendingEntry)).toBe("解放処理中のキャッシュ");
    expect(formatTransferState("releasing")).toBe("解放処理中");
    expect(formatTransferState("empty-scope")).toBe("空のスコープ");
  });

  it("keeps held outcomes honest about released bytes", () => {
    const notice = transferOutcomeNotice({
      operationId: "op-held",
      outcome: "held",
      releasedBytes: 9999,
      reason: "retention policy",
    });

    expect(notice.kind).toBe("held");
    expect(notice.text).toContain("op-held");
    expect(notice.text).toContain("retention policy");
    expect(notice.text).toContain("解放されていません");
    expect(notice.text).not.toContain("9999 バイト（");
    expect(notice.text).not.toContain("を解放しました");
  });

  it("keeps the operation id when an outcome is unknown", () => {
    const notice = transferOutcomeNotice({
      operationId: "op-unknown",
      outcome: "outcome-unknown",
      releasedBytes: 0,
      reason: null,
    });

    expect(notice.kind).toBe("unknown");
    expect(notice.text).toContain("op-unknown");
    expect(notice.text).toContain("新しい解放を開始しないでください");
    expect(notice.text).not.toContain("解放しました");
    expect(transferUnknownNotice("op-error")).toContain("op-error");
  });

  it("reports a successful release with bytes", () => {
    const notice = transferOutcomeNotice({
      operationId: "op-released",
      outcome: "released",
      releasedBytes: 2048,
      reason: null,
    });

    expect(notice.kind).toBe("released");
    expect(notice.text).toContain("op-released");
    expect(notice.text).toContain("2048 バイト（2.0 KiB）");
    expect(notice.text).toContain("解放しました");
  });

  it("never exposes a raw exception message", () => {
    const message = transferErrorMessage(new Error("boom /tmp/secret raw"));

    expect(message).toBe(TRANSFER_GENERIC_ERROR);
    expect(message).not.toContain("boom");
    expect(message).not.toContain("/tmp");
    expect(message).not.toContain("secret");
  });

  it("confirms resume with the same operation id and no new ticket", () => {
    const resume = transferResumeConfirmation(pendingEntry, "op-resume-1");

    expect(resume.operationId).toBe("op-resume-1");
    expect(resume.entryId).toBe("entry-pending");
    expect(resume.usesNewTicket).toBe(false);
    expect(resume.message).toContain("新しい解放チケットは作成しません");
    expect(resume.message).toContain("そのまま");
    expect(resume.bytesLabel).toBe("1024 バイト（1.0 KiB）");
  });

  it("lists only unresolved operations with an operation id", () => {
    const visible = pendingTransferEntries(
      [...entries, pendingEntry, { ...pendingEntry, entryId: "entry-hidden", operationId: "op-hidden" }],
      ["op-resolved"],
      "op-hidden",
    );

    expect(visible.map((entry) => entry.operationId)).toEqual(["op-resume-1"]);
    expect(pendingTransferEntries(entries)).toEqual([]);
  });
});
