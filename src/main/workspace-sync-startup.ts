import {
  hasCrashRecoveryInput,
  type CrashRecoveryRead,
} from "../shared/crash-recovery";
import type { Store } from "../persistence/store";
import { requireCondition, SyncError } from "../sync/protocol";
import { openWorkspaceSync } from "../sync/workspace-sync";

export function startupSyncRequested(env: NodeJS.ProcessEnv): boolean {
  return env.FOLIO_SYNC_ENABLED === "1" && !!env.FOLIO_DATA_DIR;
}

/** Only called by the single-instance owner before creating any window.
 * Recovery input keeps the receive queue from replacing the editor's base. */
export async function runStartupWorkspaceSync(
  store: Store,
  readRecovery: () => CrashRecoveryRead,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (!startupSyncRequested(env)) return;
  const canApply = () => {
    const recovery = readRecovery();
    return (
      recovery.status === "empty" ||
      (recovery.status === "ready" &&
        recovery.snapshot !== undefined &&
        !hasCrashRecoveryInput(recovery.snapshot))
    );
  };
  try {
    const mode = env.FOLIO_SYNC_MODE;
    const choice = env.FOLIO_SYNC_CONFLICT_CHOICE;
    const revision = Number(env.FOLIO_SYNC_CONFLICT_REVISION);
    requireCondition(
      mode === undefined || mode === "publish" || mode === "join",
      "invalid-sync-mode",
    );
    requireCondition(
      choice === undefined ||
        ((choice === "local" || choice === "remote") &&
          Number.isSafeInteger(revision) &&
          revision > 0),
      "invalid-conflict-choice",
    );
    const sync = await openWorkspaceSync({
      store,
      baseUrl: env.FOLIO_SYNC_URL ?? "",
      workspaceId: env.FOLIO_SYNC_WORKSPACE ?? "",
      clientId: env.FOLIO_SYNC_CLIENT ?? "",
      bindingId: env.FOLIO_SYNC_BINDING ?? "",
      token: env.FOLIO_SYNC_TOKEN ?? "",
      mode,
      canApply,
    });
    if (choice) await sync.resolveConflict(choice, revision);
    let status = sync.status();
    // Bound catch-up at launch. Each round reads and stages at most one change.
    for (let round = 0; round < 8; round++) {
      const previous = status;
      status = await sync.syncOnce();
      if (
        status.receivedCursor === previous.receivedCursor &&
        status.appliedRevision === previous.appliedRevision
      )
        break;
    }
    const conflict = sync.conflict();
    if (conflict)
      return `同期競合 · リモート版 ${conflict.result.head.revision} · 両側を保持`;
    if (status.receivedCursor > status.appliedRevision)
      return `同期の受信済み ${status.receivedCursor} · 適用済み ${status.appliedRevision}`;
    return `起動時同期 · 適用済み ${status.appliedRevision}`;
  } catch (error) {
    const code =
      error instanceof SyncError ? error.code : "local-or-network-error";
    return `起動時同期を保留 (${code})`;
  }
}
