import { blankDoc, type Page } from "../shared/types";
import { inspectLegacyRecords } from "./legacy-record-plan";
import { createLegacyRecordMap, legacyRecordPageId } from "./legacy-record-map";
import { RecordRepository } from "./record-repository";
import { RecordLifecycle } from "./record-lifecycle";
import { markRecordStoreVersion } from "./record-version";
import type { Store } from "./store";

/**
 * Experimental conversion step, NOT startup-wired. Caller must hold exclusive
 * workspace ownership, make and verify a SQLite+assets snapshot first, and run
 * this inside the transaction; it atomically marks SQLite version 4. Do not
 * enable until history, lifecycle, recovery and UI integration are complete.
 */
export function convertLegacyRecordsInTransaction(
  store: Store,
  afterRecord?: (count: number) => void,
  databasePageIds?: readonly string[],
): { databases: number; records: number } {
  if (!store.db.isTransaction)
    throw new Error("Migration requires a transaction");
  if (
    databasePageIds &&
    (!databasePageIds.length ||
      new Set(databasePageIds).size !== databasePageIds.length)
  )
    throw new Error("Migration scope is empty or duplicated");
  const plan = inspectLegacyRecords(store.db, databasePageIds);
  if (plan.issues.length)
    throw new Error(
      "Migration preflight found unsupported or unsafe data; original retained",
    );
  const repo = new RecordRepository(store);
  repo.createSchema();
  createLegacyRecordMap(store.db);
  store.db.exec(
    "CREATE TABLE IF NOT EXISTS legacy_database_archive(database_page_id TEXT PRIMARY KEY, data TEXT NOT NULL)",
  );
  store.db.exec(
    "CREATE TABLE IF NOT EXISTS legacy_database_versions(version_id INTEGER PRIMARY KEY REFERENCES versions(id) ON DELETE CASCADE, database_page_id TEXT NOT NULL)",
  );
  const current = store.db
    .prepare("SELECT id,data FROM pages ORDER BY id")
    .all() as { id: string; data: string }[];
  const databases = current.filter((row) => {
    if (databasePageIds && !databasePageIds.includes(row.id)) return false;
    const value = JSON.parse(row.data) as { kind?: string };
    return value.kind === "database";
  });
  const sources = new Map(databases.map((row) => [row.id, row]));
  // Reserve IDs even for rows that occur only in historical snapshots.
  for (const item of plan.records) {
    if (!sources.has(item.databasePageId))
      throw new Error("Legacy history belongs to a non-database page");
    legacyRecordPageId(store.db, item.databasePageId, item.legacyRowId);
  }
  let converted = 0,
    created = 0;
  for (const source of databases) {
    if (
      store.db
        .prepare("SELECT 1 FROM record_databases WHERE database_page_id=?")
        .get(source.id)
    )
      continue;
    const database = store.get(source.id);
    if (
      !database.database ||
      database.documentError ||
      !Number.isSafeInteger(database.revision) ||
      database.revision < 0 ||
      database.revision >= Number.MAX_SAFE_INTEGER
    )
      throw new Error("Invalid database");
    store.db
      .prepare(
        "INSERT INTO legacy_database_archive(database_page_id,data) VALUES(?,?)",
      )
      .run(source.id, source.data);
    repo.registerDatabase(source.id);
    store.db
      .prepare(
        "INSERT INTO legacy_database_versions(version_id,database_page_id) SELECT id,pageId FROM versions WHERE pageId=? AND database IS NOT NULL",
      )
      .run(source.id);
    // Clear the editable legacy projection inside the same transaction before
    // attaching records. Each attach validates the owner and must not reparse
    // the entire legacy row array for every row; rollback restores this write.
    store.write({
      ...database,
      database: { ...database.database, rows: [] },
      revision: database.revision + 1,
      updatedAt: Date.now(),
    });
    for (const [position, row] of database.database.rows.entries()) {
      const id = legacyRecordPageId(store.db, source.id, row.id);
      if (store.db.prepare("SELECT 1 FROM pages WHERE id=?").get(id))
        throw new Error("Mapped record page already exists");
      const now = Date.now();
      const page: Page = {
        id,
        schemaVersion: 1,
        parentId: null,
        title: row.title,
        icon: "📄",
        cover: "",
        position,
        doc: blankDoc(),
        kind: "page",
        database: null,
        favorite: false,
        createdAt: now,
        updatedAt: now,
        revision: 0,
        deletedAt: database.deletedAt,
      };
      store.write(page, true);
      repo.attachForMigration(id, source.id, position, row.values);
      created++;
      afterRecord?.(created);
    }
    if (database.deletedAt !== null)
      new RecordLifecycle(store).registerMigratedTrashInTransaction(
        database.id,
      );
    converted++;
  }
  markRecordStoreVersion(store.db);
  return { databases: converted, records: created };
}
