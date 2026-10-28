import type { DatabaseSync } from "node:sqlite";

/** Only called inside the atomic record creation/migration transaction. */
export function markRecordStoreVersion(db: DatabaseSync): void {
  if (!db.isTransaction)
    throw new Error("Record version update requires a transaction");
  for (const name of [
    "record_databases",
    "record_memberships",
    "record_value_versions",
  ]) {
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(name)
    )
      throw new Error("Incomplete record schema");
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS folio_record_schema(version INTEGER NOT NULL); INSERT INTO folio_record_schema(version) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM folio_record_schema);",
  );
  validateRecordStoreVersion(db);
  db.exec("PRAGMA user_version=4");
}

/** Unknown or partially created version-4 stores must not be opened. */
export function validateRecordStoreVersion(db: DatabaseSync): void {
  for (const name of [
    "folio_record_schema",
    "record_databases",
    "record_memberships",
    "record_value_versions",
  ]) {
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(name)
    )
      throw new Error("Incomplete or unsupported record store");
  }
  const columns = db.prepare("PRAGMA table_xinfo(folio_record_schema)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
    hidden: number;
  }[];
  if (
    columns.length !== 1 ||
    columns[0].name !== "version" ||
    columns[0].type.toUpperCase() !== "INTEGER" ||
    columns[0].notnull !== 1 ||
    columns[0].dflt_value !== null ||
    columns[0].pk !== 0 ||
    columns[0].hidden !== 0
  )
    throw new Error("Incomplete or unsupported record store");
  const rows = db.prepare("SELECT version FROM folio_record_schema").all() as {
    version: number;
  }[];
  if (rows.length !== 1 || rows[0].version !== 1)
    throw new Error("Incomplete or unsupported record store");
}
