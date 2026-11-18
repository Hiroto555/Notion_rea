import type { SaveOperation } from "../shared/save-contract";
import type { StorageFailureV1 } from "../shared/private-storage-failure";
import type { PageOperationEntry } from "./page-operation-coordinator";
import { storageFailureMessageV1 } from "./private-request";
import type { SaveStateDetailRow } from "./SaveStateDetails";

/** A save lane as the coordinators expose it: the owner's own state and its
 * already-bounded error text. The projection never derives new states and
 * never splits a shared recordcommit into independent value/body results —
 * one lane is one row. */
export type SaveLaneView = {
  id: string;
  label: string;
  state: string;
  error?: string;
};

export type SaveStatePresentationInput = {
  /** Retained ordinary-Page save operations keyed by pageId plus their
   * bounded diagnostics keyed by operationId — the single source of truth. */
  operations: ReadonlyMap<string, SaveOperation>;
  storageFailures: ReadonlyMap<string, StorageFailureV1>;
  /** Pages whose held input was stopped before or after a send. The inputs
   * stay queued, so this set overlaps pendingInputCount: it is a separate
   * fact and the two are never added together. */
  failedPageIds: ReadonlySet<string>;
  /** Record pageIds inside failedPageIds so a held owner keeps its target. */
  recordPageIds: ReadonlySet<string>;
  /** All database pageIds — record-database and legacy, live or already
   * deleted — for target classification only. A held or retained input on
   * one of these owners is never called 本文; a deleted page's ownership
   * is a fact of the loaded snapshot, not a live save target. */
  databasePageIds: ReadonlySet<string>;
  /** Live database targets only (registered members plus non-deleted
   * database Pages). Clean-target existence reads this count, never the
   * classification set — a trashed database is not a saved target. */
  liveDatabaseCount: number;
  pendingInputCount: number;
  /** Ordinary pages that can actually accept a body save. Zero targets means
   * nothing was ever saved — never claim a clean state for an empty set. */
  ordinaryPageCount: number;
  restoringCount: number;
  recordLanes: readonly SaveLaneView[];
  creatingRecordCount: number;
  hasNumberDrafts: boolean;
  databaseLanes: readonly SaveLaneView[];
  hasFilterDrafts: boolean;
  structuralPending: boolean;
  databaseCreation: { state: string; error?: string } | undefined;
  /** Every retained page-creation entry — not just the first unknown or
   * rejected one. Multiple rejections stay individually visible with their
   * own message and diagnostic. */
  pageCreations: readonly PageOperationEntry[];
  creatingPageCount: number;
  pendingRequests: number;
  appError: string;
  recoveryState: string | undefined;
  recoveryError: string | undefined;
  pageTitle: (pageId: string) => string | undefined;
};

/** Read-only projection of the original owner maps into detail rows. It
 * creates no sends, retries, ACKs, clears, normalizers or permission
 * decisions — only text derived from the retained state. */
export function saveStateRows(
  input: SaveStatePresentationInput,
): SaveStateDetailRow[] {
  const rows: SaveStateDetailRow[] = [];
  for (const [pageId, operation] of input.operations) {
    const failure = input.storageFailures.get(operation.operationId);
    const held = input.failedPageIds.has(pageId);
    // A legacy database routes its whole rows/settings patch through the
    // ordinary Page save lane — show it as one atomic database target, never
    // 本文 and never split into separate value/settings claims.
    const databaseOwner =
      input.databasePageIds.has(pageId) ||
      Object.hasOwn(operation.patch, "database");
    rows.push({
      id: `body:${operation.operationId}`,
      target: databaseOwner ? "データベース（行・設定）" : "本文",
      label: input.pageTitle(pageId) || "ページ",
      // An owner whose result was never proven applied is unconfirmed — even
      // when the retained result carried no diagnostic, it is not "sending".
      // Only the still-unsettled in-flight exchange may show 保存中.
      state: held ? "unknown" : "saving",
      detail: failure
        ? storageFailureMessageV1(failure)
        : held
          ? "保存結果が不明です。結果を確認してください。"
          : undefined,
    });
  }
  if (input.pendingInputCount)
    rows.push({
      id: "inputs:pending",
      // One workspace-wide count across body, record values and settings —
      // a neutral target, not a body claim.
      target: "未保存入力",
      label: `${input.pendingInputCount} 件`,
      state: "pending",
    });
  // A held failure without a retained operation is its own fact: the owner
  // was stopped without any request ever being dispatched (stale session,
  // unsupported document or a record/database callback outside its session),
  // so it is a neutral unsaved hold — never an unconfirmed result. The same
  // input is never counted twice and a failure-only hold is never dropped.
  for (const pageId of input.failedPageIds)
    if (!input.operations.has(pageId))
      rows.push({
        id: `held:${pageId}`,
        target: input.recordPageIds.has(pageId)
          ? "レコード"
          : input.databasePageIds.has(pageId)
            ? "データベース（行・設定）"
            : "本文",
        label: `${input.pageTitle(pageId) || "ページ"} の入力を保持`,
        state: "blocked",
        detail: "画面内に未保存の入力を保持しています。新しい保存は停止しています。",
      });
  if (input.restoringCount)
    rows.push({
      id: "body:restoring",
      target: "本文",
      label: `復元中 ${input.restoringCount} 件`,
      state: "pending",
    });
  for (const lane of input.recordLanes)
    if (lane.state !== "saved")
      rows.push({
        id: `record:${lane.id}`,
        target: "レコード",
        label: lane.label,
        state: lane.state,
        detail: lane.error,
      });
  if (input.creatingRecordCount)
    rows.push({
      id: "record:creating",
      target: "レコード",
      label: `新規レコードを作成中 ${input.creatingRecordCount} 件`,
      state: "saving",
    });
  if (input.hasNumberDrafts)
    rows.push({
      id: "record:drafts",
      target: "レコード",
      label: "数値の入力中",
      state: "pending",
    });
  for (const lane of input.databaseLanes)
    if (lane.state !== "saved")
      rows.push({
        id: `database:${lane.id}`,
        target: "データベース設定",
        label: lane.label,
        state: lane.state,
        detail: lane.error,
      });
  if (input.hasFilterDrafts)
    rows.push({
      id: "database:drafts",
      target: "データベース設定",
      label: "表示条件の入力中",
      state: "pending",
    });
  if (input.structuralPending)
    rows.push({
      id: "database:structural",
      target: "データベース設定",
      label: "構造の変更を確認中",
      state: "pending",
    });
  if (input.databaseCreation)
    rows.push({
      id: "database:create",
      target: "データベース設定",
      label: "新しいデータベース",
      state: input.databaseCreation.state,
      detail: input.databaseCreation.error,
    });
  for (const entry of input.pageCreations)
    rows.push({
      id: `pages:create:${entry.operation.operationId}`,
      target: "ページ作成",
      label: entry.message,
      state: entry.state,
      detail: entry.error,
    });
  if (input.creatingPageCount)
    rows.push({
      id: "pages:creating",
      target: "ページ作成",
      label: `${input.creatingPageCount} 件の作成を確認中`,
      state: "saving",
    });
  if (input.pendingRequests)
    rows.push({
      id: "requests:pending",
      target: "保存要求",
      label: `${input.pendingRequests} 件の処理`,
      state: "saving",
    });
  if (input.appError)
    rows.push({
      id: "app:error",
      // fail() also carries database creation, structural, search and raw
      // rescue errors — a neutral whole-app row, never a fabricated body
      // failure.
      target: "全体",
      label: "最新のエラー",
      state: "error",
      detail: input.appError,
    });
  if (input.recoveryError || input.recoveryState !== "saved")
    rows.push({
      id: "recovery",
      target: "復旧用保存",
      label: "チェックポイント",
      state: input.recoveryError ? "error" : (input.recoveryState ?? "unknown"),
      detail: input.recoveryError,
    });
  if (!rows.length)
    rows.push(
      {
        id: "target:body",
        target: "本文",
        label: "通常ページ",
        state: input.ordinaryPageCount ? "saved" : "none",
        ...(input.ordinaryPageCount ? {} : { detail: "対象なし" }),
      },
      {
        id: "target:record",
        target: "レコード",
        label: "値と本文",
        state: input.recordLanes.length ? "saved" : "none",
        ...(input.recordLanes.length ? {} : { detail: "対象なし" }),
      },
      {
        id: "target:database",
        target: "データベース設定",
        label: "ビューと表示条件",
        // Coordinator lanes and standalone live legacy databases are real
        // save targets — a legacy-only workspace is never 対象なし, but a
        // deleted database held in memory is not a target either.
        state:
          input.databaseLanes.length || input.liveDatabaseCount
            ? "saved"
            : "none",
        ...(input.databaseLanes.length || input.liveDatabaseCount
          ? {}
          : { detail: "対象なし" }),
      },
      {
        id: "target:recovery",
        target: "復旧用保存",
        label: "チェックポイント",
        state: "saved",
      },
    );
  return rows;
}

/** Owner states that mean "not provably saved" and must stay recognizable
 * outside a closed disclosure — per target, never collapsed into one banner. */
const ATTENTION_STATES = new Set([
  "unknown",
  "conflict",
  "error",
  "blocked",
  "rejected",
  "uncheckpointed",
]);

export type SaveStateAlert = { target: string; state: string; count: number };

/** Group abnormal rows into concise per-(target,state) chips. Simultaneous
 * failures stay distinct; the chip text is a fixed label — never raw or
 * unbounded error text. */
export function saveStateAlerts(
  rows: readonly SaveStateDetailRow[],
): SaveStateAlert[] {
  const alerts: SaveStateAlert[] = [];
  for (const row of rows) {
    if (!ATTENTION_STATES.has(row.state)) continue;
    const existing = alerts.find(
      (alert) => alert.target === row.target && alert.state === row.state,
    );
    if (existing) existing.count += 1;
    else alerts.push({ target: row.target, state: row.state, count: 1 });
  }
  return alerts;
}

/** Fixed short chip text per owner state — safe for the topbar. */
export const saveStateAlertLabels: Record<string, string> = {
  unknown: "結果を確認",
  conflict: "競合を保持",
  error: "エラー",
  blocked: "停止",
  rejected: "拒否",
  uncheckpointed: "記録待ち",
};
