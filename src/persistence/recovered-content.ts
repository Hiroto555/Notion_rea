import type { Checkpoint } from "../sync/protocol";
import { hashCheckpoint, requireCondition } from "../sync/protocol";
import { buildWorkspaceCheckpoint, pageSearchBody, validateWorkspaceCheckpoint } from "../sync/workspace-checkpoint";
import type { Page } from "../shared/types";
import type { Store } from "./store";
import { RecordRepository } from "./record-repository";
import { createLegacyRecordMap } from "./legacy-record-map";
import { markRecordStoreVersion } from "./record-version";
import { writeRecoveryOrigin } from "./recovery-origin";

/** Only a freshly created, empty local v3 Store. Never source DDL or v5 state. */
export function initializeRecoveredContent(store: Store, checkpoint: Checkpoint, recoveryId: string): void {
  requireCondition(validateWorkspaceCheckpoint(checkpoint), "invalid-recovery-checkpoint");
  store.transaction(() => {
    const db = store.db;
    requireCondition(db.prepare("PRAGMA user_version").get()?.user_version === 3 &&
      db.prepare("SELECT count(*) AS n FROM pages").get()?.n === 0 &&
      db.prepare("SELECT count(*) AS n FROM settings").get()?.n === 0 &&
      db.prepare("SELECT count(*) AS n FROM versions").get()?.n === 0 &&
      db.prepare("SELECT count(*) AS n FROM assets").get()?.n === 0 &&
      db.prepare("SELECT count(*) AS n FROM save_receipts").get()?.n === 0, "recovery-destination-not-empty");
    new RecordRepository(store).createSchema(); createLegacyRecordMap(db);
    db.exec(`CREATE TABLE record_database_trash_batches (
      database_page_id TEXT PRIMARY KEY REFERENCES record_databases(database_page_id), deleted_revision INTEGER NOT NULL, deleted_at INTEGER NOT NULL);
      CREATE TABLE record_database_trash_members (database_page_id TEXT NOT NULL REFERENCES record_database_trash_batches(database_page_id) ON DELETE CASCADE,
      page_id TEXT NOT NULL REFERENCES pages(id), deleted_revision INTEGER NOT NULL, PRIMARY KEY(database_page_id,page_id));
      CREATE TABLE legacy_database_archive(database_page_id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE legacy_database_versions(version_id INTEGER PRIMARY KEY REFERENCES versions(id) ON DELETE CASCADE,database_page_id TEXT NOT NULL);`);
    const tables = checkpoint.payload.tables as unknown as Record<string,(string | number | null)[][]>;
    const pages = db.prepare("INSERT INTO pages(id,data,body) VALUES(?,?,?)");
    for (const row of tables.pages) pages.run(row[0],row[1],pageSearchBody(JSON.parse(String(row[1])) as Page));
    const insert = (sql:string,name:string) => {const stmt=db.prepare(sql); for(const row of tables[name]) stmt.run(...row);};
    insert("INSERT INTO versions(id,pageId,createdAt,title,doc,database) VALUES(?,?,?,?,?,?)","versions");
    insert("INSERT INTO assets(id,metadata) VALUES(?,?)","assets");
    insert("INSERT INTO record_databases(database_page_id) VALUES(?)","record_databases");
    insert("INSERT INTO record_memberships(page_id,database_page_id,position,values_json) VALUES(?,?,?,?)","record_memberships");
    insert("INSERT INTO record_value_versions(version_id,values_json) VALUES(?,?)","record_value_versions");
    insert("INSERT INTO record_database_trash_batches(database_page_id,deleted_revision,deleted_at) VALUES(?,?,?)","record_database_trash_batches");
    insert("INSERT INTO record_database_trash_members(database_page_id,page_id,deleted_revision) VALUES(?,?,?)","record_database_trash_members");
    insert("INSERT INTO legacy_database_archive(database_page_id,data) VALUES(?,?)","legacy_database_archive");
    insert("INSERT INTO legacy_database_versions(version_id,database_page_id) VALUES(?,?)","legacy_database_versions");
    insert("INSERT INTO legacy_record_map(database_page_id,legacy_row_id,page_id) VALUES(?,?,?)","legacy_record_map");
    markRecordStoreVersion(db); writeRecoveryOrigin(db,recoveryId,hashCheckpoint(checkpoint));
    requireCondition(hashCheckpoint(buildWorkspaceCheckpoint(db)) === hashCheckpoint(checkpoint),"recovery-content-mismatch");
  });
}
