import { hasCrashRecoveryInput, type CrashRecoveryRead } from "../shared/crash-recovery";
import { WorkspaceSync } from "../sync/workspace-sync";
import { checkSyncApplyTarget } from "./workspace-sync-apply-guard";
import type { SyncApplyTarget } from "./workspace-sync-intent";
import { canonicalJson } from "../sync/protocol";
import { readNormalApply, normalApplyResultMatches } from "../sync/normal-apply-journal";
import { legacyApplyIntentPresent } from "../sync/legacy-apply-intent";
type Options = Parameters<typeof WorkspaceSync.openStaged>[0];
export type RestartApplyResult = "no-intent" | "cancelled" | "applied" | "already-applied" | "recovery-input" | "workspace-changed" | "target-changed" | "blocked";
function cleanRecovery(read: CrashRecoveryRead): boolean {
  return read.status === "empty" || (read.status === "ready" && !!read.snapshot && !hasCrashRecoveryInput(read.snapshot));
}
/** Only SQLite consent is authoritative. Consume and content commit together. */
export async function applyRestartIntent(options: {directory:string;sync:Options;readRecovery:()=>CrashRecoveryRead;
  expected?:SyncApplyTarget|null}):Promise<RestartApplyResult> {
  try {
    if (legacyApplyIntentPresent(options.directory)) return "blocked";
    const db = options.sync.store.db, read = readNormalApply(db);
    if (read.status === "blocked") return "blocked";
    if (read.status === "empty" || read.record.state === "cancelled") return options.expected ? "cancelled" : "no-intent";
    const record = structuredClone(read.record), target = record.target;
    if (target.workspaceId !== options.sync.workspaceId || target.clientId !== options.sync.clientId ||
      target.bindingId !== options.sync.bindingId) return record.state === "consumed" ? "no-intent" : "target-changed";
    if (record.state === "consumed") return normalApplyResultMatches(db,record) ? "already-applied" : "blocked";
    if (options.expected === null || (options.expected && canonicalJson(target) !== canonicalJson(options.expected))) return "target-changed";
    const consentCurrent = () => {
      if (legacyApplyIntentPresent(options.directory)) return false;
      const now = readNormalApply(db);
      return now.status === "ready" && now.raw === read.raw;
    };
    const canApply = () => options.sync.canApply() && cleanRecovery(options.readRecovery()) && consentCurrent();
    if (!cleanRecovery(options.readRecovery())) return "recovery-input";
    const sync = WorkspaceSync.openStaged({...options.sync,canApply},target.serverEpoch);
    if (sync.appliedMatches(target)) return "blocked";
    await sync.reconcileStagedTarget(target);
    if (!consentCurrent()) {
      const now = readNormalApply(db);
      return now.status === "ready" && now.record.state === "cancelled" ? "cancelled" : "target-changed";
    }
    const check = checkSyncApplyTarget({target,identity:target,status:sync.status(),incoming:sync.stagedChange(),recovery:options.readRecovery()});
    if (check !== "ready") return check;
    await sync.applyStaged(target,record);
    const after = readNormalApply(db);
    return after.status === "ready" && after.record.id === record.id && after.record.state === "consumed" &&
      normalApplyResultMatches(db,after.record) ? "applied" : "blocked";
  } catch {return "blocked";}
}
