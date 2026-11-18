import { describe, expect, it } from "vitest";
import type {
  ArchiveItem,
  ArchivePage,
  ArchiveTarget,
  RecoveryActionResult,
} from "../src/shared/conflict-recovery";
import {
  applyActionResult,
  applyList,
  applyStatus,
  beginExport,
  beginList,
  beginRestore,
  beginStatus,
  canQueryStatus,
  canStartOperation,
  clearSelectedTarget,
  createRecoveryPanelModel,
  disposeRecoveryPanelModel,
  failList,
  failOperation,
  failStatus,
  hasPendingUnknown,
  isPendingUnknownFor,
  selectTarget,
  targetFromItem,
  targetIdentityMatches,
  type RecoveryPanelModel,
} from "../src/renderer/conflict-recovery-model";

const CHECKPOINT_HASH = "a".repeat(64);
const SOURCE = "b".repeat(64);

function makeTarget(overrides: Partial<ArchiveTarget> = {}): ArchiveTarget {
  return {
    source: SOURCE,
    id: 7,
    operationId: "op-7",
    kind: "conflict",
    createdAt: 1_700_000_000_000,
    checkpointHash: CHECKPOINT_HASH,
    ...overrides,
  };
}

function makeItem(overrides: Partial<ArchiveItem> = {}): ArchiveItem {
  return {
    id: 7,
    operationId: "op-7",
    kind: "conflict",
    createdAt: 1_700_000_000_000,
    valid: true,
    bytes: 2048,
    pages: 3,
    assets: 1,
    target: makeTarget(),
    attachmentStatus: "not-checked",
    ...overrides,
  };
}

function makePage(
  items: ArchiveItem[],
  next: ArchivePage["next"] = null,
  total = items.length,
): ArchivePage {
  return { items, next, total };
}

function withUnknown(
  target: ArchiveTarget = makeTarget(),
  directory = "/tmp/folio-unknown",
): RecoveryPanelModel {
  const started = beginExport(createRecoveryPanelModel(), 1, target, "complete-bundle");
  return applyActionResult(started, 1, {
    kind: "outcome-unknown",
    reason: "公開後の応答が不明",
    directory,
    target,
  });
}

describe("conflict recovery model: generation and disposal", () => {
  it("ignores a stale list response after a newer request", () => {
    let model = createRecoveryPanelModel();
    model = beginList(model, 1);
    model = beginList(model, 2);
    const current = model;

    const stale = applyList(model, 1, makePage([makeItem()]));

    expect(stale).toBe(current);
    expect(stale.page).toBeNull();
  });

  it("ignores responses after disposal and refuses new requests", () => {
    let model = beginList(createRecoveryPanelModel(), 1);
    model = disposeRecoveryPanelModel(model);
    const disposed = model;

    expect(applyList(model, 1, makePage([makeItem()]))).toBe(disposed);
    expect(beginList(model, 2)).toBe(disposed);
    expect(canQueryStatus(model)).toBe(false);
  });

  it("ignores a stale status response", () => {
    const model = beginStatus(createRecoveryPanelModel(), 3);
    const stale = applyStatus(model, 2, {
      kind: "restored",
      directory: "/tmp/x",
      checkpointHash: CHECKPOINT_HASH,
    });
    expect(stale).toBe(model);
  });

  it("ignores stale action results and stale failures", () => {
    const target = makeTarget();
    let model = beginRestore(createRecoveryPanelModel(), 1, target);
    model = beginRestore(model, 2, target);
    const current = model;

    expect(
      applyActionResult(model, 1, {
        kind: "restored",
        directory: "/tmp/x",
        checkpointHash: CHECKPOINT_HASH,
      }),
    ).toBe(current);
    expect(failOperation(model, 1, { target, message: "late" })).toBe(current);
    expect(failList(model, 1, "late")).toBe(current);
    expect(failStatus(model, 1, "late")).toBe(current);
  });
});

describe("conflict recovery model: list and pagination", () => {
  it("replaces the page on the first load", () => {
    let model = beginList(createRecoveryPanelModel(), 1);
    model = applyList(model, 1, makePage([makeItem({ id: 2 })]), { append: true });
    const second = beginList(model, 2);
    const replaced = applyList(second, 2, makePage([makeItem({ id: 9 })], null, 1), {
      append: false,
    });

    expect(replaced.page?.items.map((item) => item.id)).toEqual([9]);
    expect(replaced.page?.total).toBe(1);
    expect(replaced.page?.next).toBeNull();
  });

  it("appends pages, keeps the anchor cursor, and deduplicates ids", () => {
    let model = beginList(createRecoveryPanelModel(), 1);
    model = applyList(
      model,
      1,
      makePage([makeItem({ id: 5 }), makeItem({ id: 4 })], { anchor: 5, before: 4 }, 3),
    );

    const paged = beginList(model, 2, { anchor: 5, before: 4 });
    model = applyList(
      paged,
      2,
      makePage([makeItem({ id: 4 }), makeItem({ id: 3 })], { anchor: 5, before: 3 }, 3),
      { append: true },
    );

    expect(model.page?.items.map((item) => item.id)).toEqual([5, 4, 3]);
    expect(model.page?.next).toEqual({ anchor: 5, before: 3 });
    expect(model.page?.total).toBe(3);
    expect(model.busy).toBeNull();
  });

  it("reports list failures without dropping the already loaded page", () => {
    let model = applyList(
      beginList(createRecoveryPanelModel(), 1),
      1,
      makePage([makeItem()], null, 1),
    );
    model = failList(beginList(model, 2, { anchor: 7, before: 7 }), 2, "読取り失敗");

    expect(model.notice).toEqual({ kind: "error", message: "読取り失敗" });
    expect(model.page?.items).toHaveLength(1);
    expect(model.busy).toBeNull();
  });
});

describe("conflict recovery model: target selection", () => {
  it("selects only valid targets with a target snapshot", () => {
    expect(targetFromItem(makeItem())).not.toBeNull();
    expect(targetFromItem(makeItem({ valid: false }))).toBeNull();
    expect(targetFromItem(makeItem({ target: null }))).toBeNull();

    const target = makeTarget();
    const model = selectTarget(createRecoveryPanelModel(), target);
    expect(model.target).toBe(target);
    expect(clearSelectedTarget(model).target).toBeNull();
  });

  it("compares all target identity fields", () => {
    const target = makeTarget();
    expect(targetIdentityMatches(target, { ...target })).toBe(true);
    expect(targetIdentityMatches(target, { ...target, id: 8 })).toBe(false);
    expect(targetIdentityMatches(target, { ...target, operationId: "op-8" })).toBe(
      false,
    );
    expect(targetIdentityMatches(target, { ...target, checkpointHash: "c".repeat(64) })).toBe(
      false,
    );
  });
});

describe("conflict recovery model: export, restore and results", () => {
  it("records a metadata-only export as a success with its path", () => {
    const target = makeTarget();
    let model = beginExport(
      selectTarget(createRecoveryPanelModel(), target),
      1,
      target,
      "metadata-only",
    );
    model = applyActionResult(model, 1, {
      kind: "metadata-only",
      directory: "/tmp/folio-export",
      checkpointHash: CHECKPOINT_HASH,
    });

    expect(model.lastSuccess).toEqual({
      kind: "metadata-only",
      directory: "/tmp/folio-export",
      checkpointHash: CHECKPOINT_HASH,
      target,
    });
    expect(model.pendingUnknown).toBeNull();
    expect(model.busy).toBeNull();
    expect(model.notice?.kind).toBe("info");
  });

  it("records a complete bundle export as a success", () => {
    const target = makeTarget();
    let model = beginExport(createRecoveryPanelModel(), 1, target, "complete-bundle");
    model = applyActionResult(model, 1, {
      kind: "complete-bundle",
      directory: "/tmp/folio-bundle",
      checkpointHash: CHECKPOINT_HASH,
    });
    expect(model.lastSuccess?.kind).toBe("complete-bundle");
    expect(model.lastSuccess?.directory).toBe("/tmp/folio-bundle");
  });

  it("records a new-copy restore as a success", () => {
    const target = makeTarget();
    let model = beginRestore(createRecoveryPanelModel(), 1, target);
    model = applyActionResult(model, 1, {
      kind: "restored",
      directory: "/tmp/folio-restored",
      checkpointHash: CHECKPOINT_HASH,
    });
    expect(model.lastSuccess?.kind).toBe("restored");
    expect(model.lastSuccess?.directory).toBe("/tmp/folio-restored");
  });

  it("treats an outcome-unknown result as a preserved destination, never as success", () => {
    const target = makeTarget();
    const model = withUnknown(target);

    expect(model.lastSuccess).toBeNull();
    expect(model.pendingUnknown).toEqual({
      target,
      directory: "/tmp/folio-unknown",
      reason: "公開後の応答が不明",
    });
    expect(model.notice?.kind).toBe("outcome-unknown");
    expect(model.busy).toBeNull();
    expect(hasPendingUnknown(model)).toBe(true);
  });

  it("blocks a same-result re-application while an outcome is unknown", () => {
    const target = makeTarget();
    const other = makeTarget({ id: 8, operationId: "op-8" });
    const model = withUnknown(target);

    expect(canStartOperation(model, target)).toBe(false);
    expect(canStartOperation(model, other)).toBe(false);
    expect(canStartOperation(model, null)).toBe(false);
    expect(isPendingUnknownFor(model, target)).toBe(true);
    expect(canQueryStatus(model)).toBe(true);
  });

  it("keeps the previous page/selection untouched when starting export", () => {
    const target = makeTarget();
    let model = applyList(
      beginList(createRecoveryPanelModel(), 1),
      1,
      makePage([makeItem()], null, 1),
    );
    model = selectTarget(model, target);
    model = beginExport(model, 2, target, "complete-bundle");

    expect(model.page?.items).toHaveLength(1);
    expect(model.target).toBe(target);
    expect(model.busy).toEqual({ kind: "export", mode: "complete-bundle", target });
  });
});

describe("conflict recovery model: status re-query", () => {
  it("does not promote a success pointing at a different directory", () => {
    const pending = withUnknown();
    const asked = beginStatus(pending, 2);
    const model = applyStatus(asked, 2, {
      kind: "complete-bundle",
      directory: "/tmp/other",
      checkpointHash: CHECKPOINT_HASH,
    });

    expect(model.pendingUnknown).toEqual(pending.pendingUnknown);
    expect(model.lastSuccess).toBeNull();
    expect(model.notice?.kind).toBe("caution");
  });

  it("does not promote a success pointing at a different checkpoint hash", () => {
    const pending = withUnknown();
    const asked = beginStatus(pending, 2);
    const model = applyStatus(asked, 2, {
      kind: "complete-bundle",
      directory: "/tmp/folio-unknown",
      checkpointHash: "d".repeat(64),
    });

    expect(model.pendingUnknown).toEqual(pending.pendingUnknown);
    expect(model.lastSuccess).toBeNull();
  });

  it("recovers to success only when the same destination and hash verify", () => {
    const pending = withUnknown();
    const asked = beginStatus(pending, 2);
    const model = applyStatus(asked, 2, {
      kind: "complete-bundle",
      directory: "/tmp/folio-unknown",
      checkpointHash: CHECKPOINT_HASH,
    });

    expect(model.pendingUnknown).toBeNull();
    expect(model.lastSuccess).toEqual({
      kind: "complete-bundle",
      directory: "/tmp/folio-unknown",
      checkpointHash: CHECKPOINT_HASH,
      target: makeTarget(),
    });
    expect(model.notice?.kind).toBe("info");
  });

  it("keeps the unknown destination when status reports blocked", () => {
    const pending = withUnknown();
    const model = applyStatus(beginStatus(pending, 2), 2, {
      kind: "blocked",
      reason: "再照合で拒否",
    });

    expect(model.pendingUnknown).toEqual(pending.pendingUnknown);
    expect(model.lastSuccess).toBeNull();
    expect(model.notice?.kind).toBe("blocked");
  });

  it("keeps the unknown destination when status reports another unknown", () => {
    const pending = withUnknown();
    const model = applyStatus(beginStatus(pending, 2), 2, {
      kind: "outcome-unknown",
      reason: "まだ不明",
      directory: "/tmp/folio-unknown",
      target: makeTarget(),
    });

    expect(model.pendingUnknown).toEqual({
      target: makeTarget(),
      directory: "/tmp/folio-unknown",
      reason: "まだ不明",
    });
    expect(model.lastSuccess).toBeNull();
    expect(model.notice?.kind).toBe("outcome-unknown");
  });

  it("keeps caution when status returns null with an outstanding unknown", () => {
    const pending = withUnknown();
    const model = applyStatus(beginStatus(pending, 2), 2, null);

    expect(model.pendingUnknown).toEqual(pending.pendingUnknown);
    expect(model.lastSuccess).toBeNull();
    expect(model.notice?.kind).toBe("caution");
  });

  it("clears a cancelled operation and does not report success", () => {
    const pending = withUnknown();
    const model = applyStatus(beginStatus(pending, 2), 2, { kind: "cancelled" });

    expect(model.pendingUnknown).toBeNull();
    expect(model.lastSuccess).toBeNull();
    expect(model.notice?.kind).toBe("info");
  });

  it("reports a status inquiry failure as caution without success", () => {
    const pending = withUnknown();
    const model = failStatus(beginStatus(pending, 2), 2, "照会失敗");

    expect(model.pendingUnknown).toEqual(pending.pendingUnknown);
    expect(model.lastSuccess).toBeNull();
    expect(model.notice?.kind).toBe("caution");
    expect(model.notice?.message).toContain("照会失敗");
  });
});

describe("conflict recovery model: rejected operations", () => {
  it("keeps an output directory as unknown when a failure may have created it", () => {
    const target = makeTarget();
    const model = failOperation(beginRestore(createRecoveryPanelModel(), 1, target), 1, {
      target,
      message: "書込み後に失敗",
      directory: "/tmp/maybe-created",
    });

    expect(model.pendingUnknown).toEqual({
      target,
      directory: "/tmp/maybe-created",
      reason: "書込み後に失敗",
    });
    expect(model.lastSuccess).toBeNull();
    expect(model.notice?.kind).toBe("outcome-unknown");
  });

  it("keeps a request unresolved when its RPC failed without an output path", () => {
    const target = makeTarget();
    const model = failOperation(beginExport(createRecoveryPanelModel(), 1, target, "metadata-only"), 1, {
      target,
      message: "応答喪失",
    });

    expect(model.pendingUnknown?.target).toEqual(target);
    expect(model.pendingUnknown?.directory).toBeUndefined();
    expect(canStartOperation(model,target)).toBe(false);
    expect(model.lastSuccess).toBeNull();
    expect(model.notice?.kind).toBe("outcome-unknown");
    expect(model.busy).toBeNull();
  });

  it("treats a blocked result as a refusal, not a success or unknown", () => {
    const target = makeTarget();
    const blocked: RecoveryActionResult = {
      kind: "blocked",
      reason: "容量不足のため保留",
      target,
    };
    const model = applyActionResult(
      beginExport(createRecoveryPanelModel(), 1, target, "complete-bundle"),
      1,
      blocked,
    );

    expect(model.lastSuccess).toBeNull();
    expect(model.pendingUnknown).toBeNull();
    expect(model.notice?.kind).toBe("blocked");
    expect(model.busy).toBeNull();
  });

  it("treats a cancelled result as neither success nor unknown", () => {
    const target = makeTarget();
    const model = applyActionResult(
      beginRestore(createRecoveryPanelModel(), 1, target),
      1,
      { kind: "cancelled" },
    );

    expect(model.lastSuccess).toBeNull();
    expect(model.pendingUnknown).toBeNull();
    expect(model.notice?.kind).toBe("info");
  });
});
