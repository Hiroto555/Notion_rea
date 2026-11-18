import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  TRANSFER_GENERIC_ERROR,
  TransferMaintenancePanel,
  formatTransferBytes,
  transferErrorMessage,
  transferReleaseConfirmation,
} from "../src/renderer/sync/TransferMaintenancePanel";
import type {
  TransferMaintenanceEntry,
  TransferMaintenanceView,
} from "../src/shared/sync-management";

const entries: TransferMaintenanceEntry[] = [
  {
    entryId: "entry-active",
    scopeHash: "scope-current",
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

const view: TransferMaintenanceView = {
  entries,
  nextCursor: "cursor-2",
  usedBytes: 6656,
  overLimit: true,
  held: "maintenance held by another process",
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

function render(nextView: TransferMaintenanceView = view, busy = false) {
  return renderToStaticMarkup(
    React.createElement(TransferMaintenancePanel, { view: nextView, busy, ...handlers() }),
  );
}

describe("TransferMaintenancePanel SSR", () => {
  it("shows retained bytes, over-limit state, held reason and refresh", () => {
    const html = render();

    expect(html).toContain("保持バイト数");
    expect(html).toContain("6656 バイト（6.5 KiB）");
    expect(html).toContain("上限超過");
    expect(html).toContain(">はい<");
    expect(html).toContain("maintenance held by another process");
    expect(html).toContain("保留中でも更新できます");
    expect(html).toContain('data-cursor="cursor-2"');
    expect(html).toContain(">更新</button>");
  });

  it("shows every given entry with scope, state and reason", () => {
    const html = render();

    expect(html).toContain("entry-active");
    expect(html).toContain("asset-1");
    expect(html).toContain("現在のスコープ");
    expect(html).toContain("古いスコープ");
    expect(html).toContain(">転送中<");
    expect(html).toContain(">ブロック中<");
    expect(html).toContain(">完了<");
    expect(html).toContain(">不明<");
    expect(html).toContain("blocked by sync");
    expect(html).toContain("unreleasable");
    expect(html).toContain("scope-current");
    expect(html).toContain("scope-old-2");
    expect(html).toContain("理由なし");
  });

  it("offers a dry-run preview only for releasable entries", () => {
    const html = render();

    expect((html.match(/>解放内容を確認</g) ?? []).length).toBe(2);
    for (const entry of entries) {
      const start = html.indexOf(`data-entry-id="${entry.entryId}"`);
      const row = html.slice(start, html.indexOf("</tr>", start));
      if (entry.canRelease) expect(row).toContain(">解放内容を確認</button>");
      else expect(row).not.toContain("<button");
    }
    expect(html).toContain("このエントリは保持されます。解放できません。");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("解放を実行");
  });

  it("does not call any action while server rendering", () => {
    const props = { view, busy: false, ...handlers() };

    renderToStaticMarkup(React.createElement(TransferMaintenancePanel, props));

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
    expect(html).not.toContain("さらに読み込む");
    expect(html).not.toContain("保留中でも更新できます");
  });

  it("marks the panel busy and disables actions", () => {
    const html = render(view, true);

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("処理中…");
    expect((html.match(/disabled=""/g) ?? []).length).toBeGreaterThan(0);
  });
});

describe("transfer release model", () => {
  it("uses the exact entry identity for confirmation", () => {
    const confirm = transferReleaseConfirmation(entries[0]);

    expect(confirm.entryId).toBe("entry-active");
    expect(confirm.assetId).toBe("asset-1");
    expect(confirm.scopeHash).toBe("scope-current");
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

  it("never exposes a raw exception message", () => {
    const message = transferErrorMessage(new Error("boom /tmp/secret raw"));

    expect(message).toBe(TRANSFER_GENERIC_ERROR);
    expect(message).not.toContain("boom");
    expect(message).not.toContain("/tmp");
    expect(message).not.toContain("secret");
  });
});
