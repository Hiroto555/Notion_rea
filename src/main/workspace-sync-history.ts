import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { WorkspaceSyncIdentity } from "../sync/workspace-store";

const PREFIX = "folio.sync.last-success.v1.";

/** Local-only setting. Bind it to the complete identity so restoring a backup
 * or re-enrolling a device cannot make another binding's time look current. */
function historyKey(identity: WorkspaceSyncIdentity): string {
  const material = JSON.stringify([identity.workspaceId, identity.clientId, identity.bindingId, identity.serverEpoch]);
  return PREFIX + createHash("sha256").update(material).digest("hex");
}
function validTime(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function readSyncSuccess(db: DatabaseSync, identity: WorkspaceSyncIdentity): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(historyKey(identity));
  return validTime(row?.value) ? row.value : null;
}

/** Do not replace an unexpected/corrupt existing value. SQLite is the durable
 * owner; failures are reported to the caller and never invalidate a transfer. */
export function writeSyncSuccess(db: DatabaseSync, identity: WorkspaceSyncIdentity, at: string): void {
  if (!validTime(at)) throw new Error("invalid-sync-success-time");
  const key = historyKey(identity);
  const previous = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  if (previous && !validTime(previous.value)) throw new Error("invalid-sync-success-history");
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, at);
}
