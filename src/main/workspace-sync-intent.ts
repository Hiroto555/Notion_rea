import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { syncPath, writeNewFileDurably } from "../persistence/durable-file";
import { canonicalJson, identifier, requireCondition } from "../sync/protocol";

export type SyncApplyTarget = {
  workspaceId: string;
  clientId: string;
  bindingId: string;
  serverEpoch: string;
  revision: number;
  checkpointHash: string;
};
type Intent = SyncApplyTarget & { format: "folio-sync-apply-intent/v1" };
export type SyncApplyIntentRead = { status: "empty" } | { status: "ready"; target: SyncApplyTarget } | { status: "blocked" };

function validated(value: unknown): Intent {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value), "invalid-apply-intent");
  const data = value as Record<string, unknown>;
  requireCondition(Object.keys(data).sort().join(",") === "bindingId,checkpointHash,clientId,format,revision,serverEpoch,workspaceId", "invalid-apply-intent");
  requireCondition(data.format === "folio-sync-apply-intent/v1", "invalid-apply-intent");
  const workspaceId = identifier(data.workspaceId), clientId = identifier(data.clientId);
  const bindingId = identifier(data.bindingId), serverEpoch = identifier(data.serverEpoch);
  requireCondition(Number.isSafeInteger(data.revision) && Number(data.revision) > 0, "invalid-apply-intent");
  requireCondition(typeof data.checkpointHash === "string" && /^[a-f0-9]{64}$/.test(data.checkpointHash), "invalid-apply-intent");
  return {format: "folio-sync-apply-intent/v1", workspaceId, clientId, bindingId, serverEpoch, revision: Number(data.revision), checkpointHash: data.checkpointHash};
}
function targetOf(intent: Intent): SyncApplyTarget {
  const {format: _format, ...target} = intent;
  return target;
}

/** @deprecated Legacy fixture codec only. Product flows use the SQLite journal.
 * Its read/unlink operations are not atomic against an external same-UID writer. */
export class WorkspaceSyncIntentFile {
  readonly path: string;
  constructor(directory: string) {
    requireCondition(isAbsolute(directory) && !directory.includes("\0"), "invalid-apply-intent-directory");
    const canonical = resolve(directory);
    const stat = lstatSync(canonical);
    requireCondition(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(canonical) === canonical, "invalid-apply-intent-directory");
    this.path = join(canonical, ".folio-sync-apply-intent");
  }
  private readValue(): Intent | undefined {
    let descriptor: number;
    try { descriptor = openSync(this.path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    try {
      const stat = fstatSync(descriptor);
      requireCondition(stat.isFile() && stat.nlink === 1 && stat.size <= 4096, "invalid-apply-intent");
      const bytes = readFileSync(descriptor);
      requireCondition(bytes.length === stat.size, "invalid-apply-intent");
      const text = bytes.toString("utf8"), parsed = validated(JSON.parse(text));
      requireCondition(Buffer.from(text).equals(bytes) && canonicalJson(parsed) === text, "invalid-apply-intent");
      return parsed;
    } finally { closeSync(descriptor); }
  }
  read(): SyncApplyIntentRead {
    try { const value = this.readValue(); return value ? {status: "ready", target: targetOf(value)} : {status: "empty"}; }
    catch { return {status: "blocked"}; }
  }
  create(target: SyncApplyTarget): void {
    const intent = validated({...target, format: "folio-sync-apply-intent/v1"});
    const content = canonicalJson(intent);
    const existing = this.readValue();
    if (existing) {
      requireCondition(canonicalJson(existing) === content, "apply-intent-already-exists", 409);
      syncPath(this.path); syncPath(dirname(this.path));
      return;
    }
    writeNewFileDurably(this.path, content, {syncParentDirectory: true});
    requireCondition(canonicalJson(this.readValue()) === content, "apply-intent-readback-failed", 409);
  }
  cancel(target: SyncApplyTarget): void {
    const expected = validated({...target, format: "folio-sync-apply-intent/v1"});
    const existing = this.readValue();
    requireCondition(existing && canonicalJson(existing) === canonicalJson(expected), "apply-intent-mismatch", 409);
    unlinkSync(this.path);
    syncPath(dirname(this.path));
  }

  /** After a completed apply, never remove a newer/different intent. */
  cancelIfMatches(target: SyncApplyTarget): "removed" | "absent" | "different" {
    const expected = validated({...target, format: "folio-sync-apply-intent/v1"});
    const existing = this.readValue();
    // A previous unlink may have succeeded before directory fsync failed.
    // Confirm the missing name durably before acknowledging a retry.
    if (!existing) {syncPath(dirname(this.path)); return "absent";}
    if (canonicalJson(existing) !== canonicalJson(expected)) return "different";
    unlinkSync(this.path);
    syncPath(dirname(this.path));
    return "removed";
  }
}
