import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { Store } from "../persistence/store";
import { canonicalJson, requireCondition } from "../sync/protocol";
import { cancelNormalApply, normalApplyBlocks, readNormalApply, reserveNormalApply, type NormalApplyRecord } from "../sync/normal-apply-journal";
import type { SyncApplyIntentRead, SyncApplyTarget } from "./workspace-sync-intent";
import { legacyApplyIntentPresent } from "../sync/legacy-apply-intent";
export { legacyApplyIntentPresent } from "../sync/legacy-apply-intent";

export class WorkspaceSyncIntentJournal {
  private selected?: NormalApplyRecord;
  constructor(readonly directory: string, private readonly store: Store,
    private readonly admitBytes: (bytes: number) => void = () => {}) {
    requireCondition(realpathSync(directory) === directory && dirname(realpathSync(store.path)) === directory,"invalid-intent-workspace");
  }
  prepare(target: SyncApplyTarget): void {
    this.selected = {format:"folio-normal-apply/v1",id:randomUUID(),createdAt:Date.now(),
      target:structuredClone(target),state:"pending"};
  }
  legacyBlocked(): boolean {return legacyApplyIntentPresent(this.directory);}
  pending(): NormalApplyRecord | undefined {
    const read = readNormalApply(this.store.db);
    return read.status === "ready" && read.record.state === "pending" ? structuredClone(read.record) : undefined;
  }
  read(): SyncApplyIntentRead {
    if (legacyApplyIntentPresent(this.directory)) return {status:"blocked"};
    const read = readNormalApply(this.store.db);
    if (read.status === "blocked" || (read.status === "ready" && read.record.state === "consumed" && normalApplyBlocks(this.store.db))) return {status:"blocked"};
    return read.status === "ready" && read.record.state === "pending"
      ? {status:"ready",target:structuredClone(read.record.target)} : {status:"empty"};
  }
  create(target: SyncApplyTarget): void {
    if (!this.selected) this.prepare(target);
    const selected = this.selected!;
    requireCondition(canonicalJson(selected.target) === canonicalJson(target),"apply-intent-mismatch");
    this.store.transaction(() => {
      requireCondition(!legacyApplyIntentPresent(this.directory),"legacy-apply-intent-held");
      this.admitBytes(8192);
      requireCondition(!legacyApplyIntentPresent(this.directory),"legacy-apply-intent-held");
      const current = readNormalApply(this.store.db);
      if (current.status === "ready" && canonicalJson(current.record) === canonicalJson(selected)) return;
      reserveNormalApply(this.store.db,selected);
    });
  }
  cancelIfMatches(target: SyncApplyTarget): "removed" | "absent" | "different" {
    const selected = this.selected;
    if (!selected || canonicalJson(selected.target) !== canonicalJson(target)) return "different";
    const before = readNormalApply(this.store.db);
    if (before.status === "ready" && before.record.id === selected.id && before.record.state === "cancelled") return "absent";
    if (before.status !== "ready" || canonicalJson(before.record) !== canonicalJson(selected)) return "different";
    this.store.transaction(() => cancelNormalApply(this.store.db,selected));
    return "removed";
  }
  cancelStored(expectedId: string): boolean {
    const record = this.pending();
    if (!record || record.id !== expectedId) return false;
    try {this.store.transaction(() => cancelNormalApply(this.store.db,record));}
    catch {
      const after = readNormalApply(this.store.db);
      return after.status === "ready" && after.record.id === record.id && after.record.state === "cancelled";
    }
    return true;
  }
  cancel(target: SyncApplyTarget): void {
    requireCondition(this.cancelIfMatches(target) !== "different","apply-intent-mismatch");
    this.selected = undefined;
  }
}
