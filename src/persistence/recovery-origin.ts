import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { RECOVERY_ORIGIN_KEY } from "../shared/conflict-recovery";
import { canonicalJson, requireCondition } from "../sync/protocol";
export const recoveryOriginSchema = z.object({format: z.literal("folio-recovery-origin/v1"),
  recoveryId: z.string().uuid(), checkpointHash: z.string().regex(/^[a-f0-9]{64}$/),
  sync: z.literal("held")}).strict();
export function readRecoveryOrigin(db: DatabaseSync): "absent" | "recovered" | "blocked" {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get(RECOVERY_ORIGIN_KEY);
    if (!row) return "absent";
    requireCondition(typeof row.value === "string" && Buffer.byteLength(row.value) <= 1024, "invalid-recovery-origin");
    const record = recoveryOriginSchema.parse(JSON.parse(String(row.value)));
    requireCondition(canonicalJson(record) === row.value, "invalid-recovery-origin");
    return "recovered";
  } catch {return "blocked";}
}
export function assertRecoverySyncAllowed(db: DatabaseSync): void {
  requireCondition(readRecoveryOrigin(db) === "absent", "recovered-workspace-sync-held", 409);
}
export function writeRecoveryOrigin(db: DatabaseSync, recoveryId: string, checkpointHash: string): void {
  requireCondition(db.isTransaction, "recovery-origin-transaction-required");
  const record = recoveryOriginSchema.parse({format:"folio-recovery-origin/v1",recoveryId,checkpointHash,sync:"held"});
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(RECOVERY_ORIGIN_KEY,canonicalJson(record));
  db.prepare("INSERT INTO settings(key,value) VALUES('folio.recovery.workspaceId',?)").run(recoveryId);
}
