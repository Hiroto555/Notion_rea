import { hasCrashRecoveryInput, type CrashRecoveryRead } from "../shared/crash-recovery";
import type { Change } from "../sync/protocol";
import { hashCheckpoint } from "../sync/protocol";
import type { WorkspaceSyncIdentity, WorkspaceSyncStatus } from "../sync/workspace-store";
import type { SyncApplyTarget } from "./workspace-sync-intent";

export type ApplyGuardResult = "ready" | "recovery-input" | "workspace-changed" | "target-changed";
export function checkStagedRestartTarget(input: {
  target: SyncApplyTarget;
  status: WorkspaceSyncStatus;
  recovery: CrashRecoveryRead;
  incoming: Change | null;
}): ApplyGuardResult {
  const {target, status, recovery, incoming} = input;
  if (recovery.status !== "empty" &&
      (recovery.status !== "ready" || !recovery.snapshot || hasCrashRecoveryInput(recovery.snapshot)))
    return "recovery-input";
  if (status.pending || status.conflict || status.generation !== status.cleanGeneration)
    return "workspace-changed";
  if (target.revision <= status.appliedRevision || target.revision > status.receivedCursor ||
      !incoming || incoming.clientId === target.clientId ||
      incoming.revision !== target.revision || incoming.checkpointHash !== target.checkpointHash)
    return "target-changed";
  try {
    if (hashCheckpoint(incoming.checkpoint) !== target.checkpointHash) return "target-changed";
  } catch { return "target-changed"; }
  return "ready";
}
/** Called before any apply, while the one workspace owner is still windowless.
 * This is only an admission check; the store must revalidate and transact the
 * actual apply, and attachment verification and backup must also succeed. */
export function checkSyncApplyTarget(input: {
  target: SyncApplyTarget;
  identity: WorkspaceSyncIdentity;
  status: WorkspaceSyncStatus;
  recovery: CrashRecoveryRead;
  incoming: Change | null;
}): ApplyGuardResult {
  const {target, identity, status, recovery, incoming} = input;
  if (recovery.status !== "empty" &&
      (recovery.status !== "ready" || !recovery.snapshot || hasCrashRecoveryInput(recovery.snapshot)))
    return "recovery-input";
  if (status.pending || status.conflict || status.generation !== status.cleanGeneration)
    return "workspace-changed";
  if (target.workspaceId !== identity.workspaceId || target.clientId !== identity.clientId ||
      target.bindingId !== identity.bindingId || target.serverEpoch !== identity.serverEpoch ||
      target.revision !== status.appliedRevision + 1 || target.revision > status.receivedCursor ||
      !incoming || incoming.revision !== target.revision || incoming.checkpointHash !== target.checkpointHash)
    return "target-changed";
  try {
    if (hashCheckpoint(incoming.checkpoint) !== target.checkpointHash) return "target-changed";
  } catch { return "target-changed"; }
  return "ready";
}
