import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Mapping is a migration aid, not the record store. Both schema creation and
 * allocations must run in the same transaction as record creation and the
 * SQLite version bump. This module is deliberately not wired into startup.
 */
export function createLegacyRecordMap(db: DatabaseSync): void {
  requireTransaction(db);
  db.exec(`CREATE TABLE IF NOT EXISTS legacy_record_map (
    database_page_id TEXT NOT NULL,
    legacy_row_id TEXT NOT NULL,
    page_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY (database_page_id, legacy_row_id)
  )`);
}

export function legacyRecordPageId(
  db: DatabaseSync,
  databasePageId: string,
  legacyRowId: string,
  createId: () => string = randomUUID,
): string {
  requireTransaction(db);
  if (!databasePageId || !legacyRowId)
    throw new Error("Empty legacy record identity");
  const existing = db
    .prepare(
      "SELECT page_id FROM legacy_record_map WHERE database_page_id=? AND legacy_row_id=?",
    )
    .get(databasePageId, legacyRowId) as { page_id: string } | undefined;
  if (existing) return existing.page_id;
  const pageExists = db.prepare("SELECT 1 FROM pages WHERE id=?");
  const mappingExists = db.prepare(
    "SELECT 1 FROM legacy_record_map WHERE page_id=?",
  );
  for (let attempt = 0; attempt < 128; attempt++) {
    const id = createId();
    if (!id || pageExists.get(id) || mappingExists.get(id)) continue;
    db.prepare(
      "INSERT INTO legacy_record_map(database_page_id,legacy_row_id,page_id) VALUES(?,?,?)",
    ).run(databasePageId, legacyRowId, id);
    return id;
  }
  throw new Error("Unable to allocate a unique record page ID");
}

function requireTransaction(db: DatabaseSync): void {
  if (!db.isTransaction)
    throw new Error("Legacy record mapping requires a migration transaction");
}
