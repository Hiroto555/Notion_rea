import { dirname } from "node:path";
import { realpathSync } from "node:fs";
import { hasCrashRecoveryInput, type CrashRecoveryRead } from "../shared/crash-recovery";
import type { Store } from "../persistence/store";
import { readUserVersion } from "../persistence/schema-startup";
import { requireCondition, SyncError } from "../sync/protocol";
import { openWorkspaceSync, type WorkspaceSync, type WorkspaceSyncAdmission } from "../sync/workspace-sync";
import { applyRestartIntent } from "./workspace-sync-restart";
import { WorkspaceSyncIntentJournal, legacyApplyIntentPresent } from "./normal-apply-intent";
import { readNormalApply, normalApplyBlocks } from "../sync/normal-apply-journal";
import { assertRecoverySyncAllowed } from "../persistence/recovery-origin";
import { safeSyncErrorCode } from "./workspace-sync-errors";
import { CheckpointRemote } from "../sync/client";
import { consumedDecisionMatches, decisionBelongsToCurrentBinding, readConflictDecision } from "../sync/conflict-decision";

function connectionRefused(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const cause = (error as {cause?: unknown}).cause;
  return !!cause && typeof cause === "object" && (cause as {code?: unknown}).code === "ECONNREFUSED";
}

export function startupSyncRequested(env: NodeJS.ProcessEnv): boolean {
  return env.FOLIO_SYNC_ENABLED === "1" && !!env.FOLIO_DATA_DIR;
}

export type WorkspaceSyncStartupResult = {
  message?: string;
  /** A connection opened by this attempt, even if a later transfer failed. */
  opened?: WorkspaceSync;
  /** Manual transfer-only reopen after a startup connection failure. */
  reconnect?: () => Promise<WorkspaceSync>;
};

/** Single-instance owner only, before the first renderer. Receive is staged;
 * workspace content is changed only for a matching durable restart intent. */
export async function runStartupWorkspaceSyncDetailed(
  store: Store,
  readRecovery: () => CrashRecoveryRead,
  env: NodeJS.ProcessEnv,
  admitBytes?: WorkspaceSyncAdmission,
  onOpened?: (sync: WorkspaceSync) => void,
): Promise<WorkspaceSyncStartupResult> {
  if (!startupSyncRequested(env)) return {};
  const canApply = () => {
    const recovery = readRecovery();
    return recovery.status === "empty" || (recovery.status === "ready" &&
      recovery.snapshot !== undefined && !hasCrashRecoveryInput(recovery.snapshot));
  };
  let offlineApplied = false;
  let opened: WorkspaceSync | undefined;
  let reconnect: (() => Promise<WorkspaceSync>) | undefined;
  try {
    assertRecoverySyncAllowed(store.db);
    const mode = env.FOLIO_SYNC_MODE;
    requireCondition(mode === undefined || mode === "publish" || mode === "join" || mode === "recover", "invalid-sync-mode");
    // The previous environment-variable conflict resolution path could replace
    // content at startup without a durable, revision-bound restart intent.
    requireCondition(env.FOLIO_SYNC_CONFLICT_CHOICE === undefined, "explicit-conflict-flow-required", 409);
    const syncMode = mode as "publish" | "join" | "recover" | undefined;
    const options = {
      store, baseUrl: env.FOLIO_SYNC_URL ?? "", workspaceId: env.FOLIO_SYNC_WORKSPACE ?? "",
      clientId: env.FOLIO_SYNC_CLIENT ?? "", bindingId: env.FOLIO_SYNC_BINDING ?? "",
      token: env.FOLIO_SYNC_TOKEN ?? "", canApply, admitBytes,
    };
    const directory = dirname(realpathSync(store.path));
    // Recovery rebind changes device/epoch ownership. Do not combine it with
    // a pending apply intent belonging to the pre-rebind binding.
    const existingIntent = new WorkspaceSyncIntentJournal(directory,store).read();
    if (legacyApplyIntentPresent(directory)) return {message:"旧形式の同期予約を保全し適用を保留しています (legacy-apply-intent-held)"};
    const normal = readNormalApply(store.db);
    if (normal.status === "blocked") return {message:"通常の同期予約を確認できず同期を保留"};
    const conflictDecision = readConflictDecision(store.db);
    // Offer reconnect only for an already bound workspace. Promotion and
    // recovery rebind belong to windowless startup. Recheck at execution too:
    // an intent or schema change could occur after this observation.
    if (existingIntent.status === "empty" && syncMode !== "recover" && readUserVersion(store.db) === 5) {
      reconnect = () => {
        assertRecoverySyncAllowed(store.db);
        requireCondition(env.FOLIO_SYNC_CONFLICT_CHOICE === undefined, "explicit-conflict-flow-required", 409);
        const intent = new WorkspaceSyncIntentJournal(directory,store).read();
        const decision = readConflictDecision(store.db);
        if (intent.status !== "empty" || normalApplyBlocks(store.db) || readUserVersion(store.db) !== 5 || decision.status === "blocked" ||
          (decision.status === "ready" && decision.record.state === "consumed" && decisionBelongsToCurrentBinding(store.db,decision.record) && !consumedDecisionMatches(store.db,decision.record)) ||
          (decision.status === "ready" && decision.record.state === "pending"))
          throw new SyncError("reconnect-held", 409);
        return openWorkspaceSync({...options, mode: undefined});
      };
    }
    if (existingIntent.status === "blocked") return {message: "再起動時の同期適用を保留 (blocked)"};
    if (conflictDecision.status === "blocked") return {message: "競合の選択記録を確認できず同期を保留"};
    if (conflictDecision.status === "ready" && conflictDecision.record.state === "pending") {
      if (existingIntent.status !== "empty" || syncMode === "recover")
        return {message: "競合の選択を保留 (other-intent)", reconnect};
      const record = conflictDecision.record;
      if (record.target.workspaceId !== options.workspaceId || record.target.clientId !== options.clientId ||
        record.target.bindingId !== options.bindingId || !canApply())
        return {message: "競合の選択を保留 (identity-or-recovery)", reconnect};
      // Online only, before any renderer. No send/receive/rebind may precede
      // this guarded choice. The core consumes the record in its own COMMIT.
      const sync = await openWorkspaceSync({...options, mode: undefined});
      opened = sync;
      try {await sync.resolveConflictTarget(record.target, record.id);}
      catch {
        const after = readConflictDecision(store.db);
        if (after.status !== "ready" || after.record.id !== record.id || after.record.state !== "consumed" ||
          !consumedDecisionMatches(store.db, after.record))
          return {message: "競合の選択を保留 · 候補と入力を保持しています", opened};
        return {message: "競合の選択は記録済み · 送信結果は同期で再照合してください", opened};
      }
      const after = readConflictDecision(store.db);
      if (after.status !== "ready" || after.record.id !== record.id || !consumedDecisionMatches(store.db, after.record))
        return {message: "競合の選択結果を確認できず同期を保留", opened};
      onOpened?.(sync);
      return {message: record.target.choice === "local" ? "保存済みのローカル内容を選択済み" : "選択したリモート版を適用済み", opened};
    }
    if (conflictDecision.status === "ready" && conflictDecision.record.state === "consumed" && syncMode !== "recover" &&
      decisionBelongsToCurrentBinding(store.db, conflictDecision.record) &&
      !consumedDecisionMatches(store.db, conflictDecision.record))
      return {message: "競合の選択結果を確認できず同期を保留"};
    if (syncMode === "recover" && existingIntent.status !== "empty")
      return {message: "再起動時の同期適用を保留 (rebind-pending-intent)"};
    if (existingIntent.status === "ready") {
      const target = existingIntent.target;
      if (target.workspaceId !== options.workspaceId || target.clientId !== options.clientId ||
          target.bindingId !== options.bindingId) return {message: "再起動時の同期適用を保留 (target-changed)"};
      if (!canApply()) return {message: "再起動時の同期適用を保留 (recovery-input)"};
      // When the server is reachable, detect a restored/forked history before
      // applying the pinned revision. Only a refused loopback connection is
      // treated as offline; a bad response, authorization failure or a failure
      // after a successful head is never silently converted to offline success.
      const remote = new CheckpointRemote(options);
      let head: Awaited<ReturnType<CheckpointRemote["head"]>> | undefined;
      try {head = await remote.head();}
      catch (error) {if (!connectionRefused(error)) throw error;}
      if (head) {
        if (head.serverEpoch !== target.serverEpoch) return {message: "再起動時の同期適用を保留 (server-epoch-mismatch)"};
        if (head.head.revision < target.revision) return {message: "再起動時の同期適用を保留 (server-head-regressed)"};
        const page = await remote.changes(target.revision - 1);
        const change = page.changes[0];
        if (page.serverEpoch !== target.serverEpoch || !change || change.revision !== target.revision ||
            change.checkpointHash !== target.checkpointHash)
          return {message: "再起動時の同期適用を保留 (server-history-mismatch)"};
      }
    }
    const restart = await applyRestartIntent({directory, sync: options, readRecovery,
      expected: existingIntent.status === "ready" ? existingIntent.target : null});
    if (restart !== "no-intent" && restart !== "cancelled" && restart !== "applied" && restart !== "already-applied")
      return {message: `再起動時の同期適用を保留 (${restart})`};
    offlineApplied = restart === "applied" || restart === "already-applied";
    const sync = await openWorkspaceSync({...options, mode: syncMode});
    opened = sync;
    onOpened?.(sync);
    await sync.sendPending();
    let status = sync.status();
    // Each round reads at most one revision; do not apply during catch-up.
    for (let round = 0; round < 8; round++) {
      const before = status.receivedCursor;
      status = await sync.receiveAndStage();
      if (status.receivedCursor === before) break;
    }
    if (sync.shouldRecordSuccess()) {
      try {sync.recordLastSuccess(new Date().toISOString());} catch { /* Advisory history only. */ }
    }
    const conflict = sync.conflict();
    if (conflict) return {message: `同期競合 · リモート版 ${conflict.result.head.revision} · 両側を保持`, opened};
    if (status.receivedCursor > status.appliedRevision)
      return {message: `同期の受信済み ${status.receivedCursor} · 適用済み ${status.appliedRevision}`, opened};
    return {message: `起動時同期 · 適用済み ${status.appliedRevision}`, opened};
  } catch (error) {
    const code = safeSyncErrorCode(error);
    return {
      message: `${offlineApplied ? "受信版を適用済み · " : ""}起動時同期を保留 (${code})`,
      opened,
      reconnect,
    };
  }
}

/** Compatibility entry point for callers that only need the startup label. */
export async function runStartupWorkspaceSync(
  store: Store,
  readRecovery: () => CrashRecoveryRead,
  env: NodeJS.ProcessEnv,
  admitBytes?: WorkspaceSyncAdmission,
  onOpened?: (sync: WorkspaceSync) => void,
): Promise<string | undefined> {
  const result = await runStartupWorkspaceSyncDetailed(store, readRecovery, env, admitBytes, onOpened);
  return result.message;
}
