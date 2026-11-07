import { hasCrashRecoveryInput, type CrashRecoveryRead } from "../shared/crash-recovery";
import { WorkspaceSync } from "../sync/workspace-sync";
import { checkSyncApplyTarget } from "./workspace-sync-apply-guard";
import { WorkspaceSyncIntentFile, type SyncApplyTarget } from "./workspace-sync-intent";
import { canonicalJson } from "../sync/protocol";

type Options = Parameters<typeof WorkspaceSync.openStaged>[0];
export type RestartApplyResult = "no-intent" | "cancelled" | "applied" | "already-applied" | "recovery-input" | "workspace-changed" | "target-changed" | "blocked";
function cleanRecovery(read: CrashRecoveryRead): boolean {
  return read.status === "empty" || (read.status === "ready" && !!read.snapshot && !hasCrashRecoveryInput(read.snapshot));
}

/** Windowless startup seam. It performs no server call. Any uncertain result
 * leaves the intent for inspection/retry; an already committed target is
 * cleared only after checking the stored applied checkpoint hash. Startup uses
 * this helper; the product still needs a safe way to create an intent while
 * coordinating restart cancellation and the window lifetime. */
export async function applyRestartIntent(options: {
  directory: string;
  sync: Options;
  readRecovery: () => CrashRecoveryRead;
  /** Pin the intent checked by an earlier asynchronous server preflight. */
  expected?: SyncApplyTarget | null;
}): Promise<RestartApplyResult> {
  try {
    const file = new WorkspaceSyncIntentFile(options.directory);
    const intent = file.read();
    if (intent.status === "blocked") return "blocked";
    if (intent.status === "empty") return options.expected ? "cancelled" : "no-intent";
    if (options.expected === null || (options.expected && canonicalJson(intent.target) !== canonicalJson(options.expected)))
      return "target-changed";
    const {target} = intent;
    if (target.workspaceId !== options.sync.workspaceId || target.clientId !== options.sync.clientId || target.bindingId !== options.sync.bindingId)
      return "target-changed";
    const recovery = options.readRecovery();
    if (!cleanRecovery(recovery)) return "recovery-input";
    const sync = WorkspaceSync.openStaged({...options.sync, canApply: () => {
      try {return options.sync.canApply() && cleanRecovery(options.readRecovery());} catch {return false;}
    }}, target.serverEpoch);
    if (sync.appliedMatches(target)) {
      file.cancelIfMatches(target);
      return "already-applied";
    }
    // A lost ACK can leave a verified self echo before the consent target.
    // Reconcile that metadata only after the target and recovery checks; this
    // does not replace content and leaves unrelated pending edits protected.
    await sync.reconcileStagedTarget(target);
    // Cancellation or replacement can happen while reconciliation yields.
    // Recheck the durable decision immediately before the synchronous apply.
    const current = file.read();
    if (current.status === "empty") return "cancelled";
    if (current.status === "blocked") return "blocked";
    if (canonicalJson(current.target) !== canonicalJson(target)) return "target-changed";
    const status = sync.status();
    const check = checkSyncApplyTarget({target, identity: target, status, incoming: sync.stagedChange(), recovery});
    if (check !== "ready") return check;
    await sync.applyStaged(target);
    if (!sync.appliedMatches(target)) return "workspace-changed";
    file.cancelIfMatches(target);
    return "applied";
  } catch {
    return "blocked";
  }
}
