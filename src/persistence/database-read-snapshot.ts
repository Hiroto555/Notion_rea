import type { DatabaseReadSnapshot } from "../shared/database-operation";
import { RecordRepository } from "./record-repository";
import type { Store } from "./store";

const UNREADABLE = "登録済みデータベースを安全に読み込めません。";

/**
 * Read one registered database owner, its settings and its records from a
 * single SQLite read snapshot. Only the owner and the membership/Page rows of
 * this database are decoded; unrelated Pages and databases are never visited,
 * so a damaged unrelated workspace member cannot block this database.
 */
export function readRegisteredDatabaseSnapshot(
  store: Store,
  databasePageId: string,
): DatabaseReadSnapshot {
  return store.readSnapshot(() => {
    const page = store.get(databasePageId);
    if (
      page.kind !== "database" ||
      !page.database ||
      page.database.rows.length !== 0 ||
      page.deletedAt !== null ||
      page.documentError ||
      !isRegisteredDatabase(store, databasePageId)
    )
      throw new Error(UNREADABLE);
    const { rows: _rows, ...settings } = page.database;
    return {
      page,
      database: {
        settings,
        revision: page.revision,
        records: new RecordRepository(store).projectionsForDatabase(
          databasePageId,
        ),
      },
    };
  });
}

/** The record schema must exist and this exact owner must be registered. A
 * legacy v3 workspace therefore stays unreadable through this path. */
function isRegisteredDatabase(store: Store, databasePageId: string): boolean {
  const tables = store.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('record_memberships','record_databases')",
    )
    .all() as { name: string }[];
  if (tables.length !== 2) return false;
  return !!store.db
    .prepare("SELECT 1 FROM record_databases WHERE database_page_id=?")
    .get(databasePageId);
}
