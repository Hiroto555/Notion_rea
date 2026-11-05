import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  BackupFile,
  SnapshotInspection,
  VerifiedWorkspaceBackup,
  WorkspaceBackupManifest,
  WorkspaceInventory,
} from "../shared/workspace-backup";
import { validateRecordStoreVersion } from "./record-version";
import { validateV5WorkspaceSchema } from "./schema-startup";

const FORMAT = "folio-workspace-backup";
const FORMAT_VERSION = 1;
const DATABASE_FILE = "workspace.sqlite";
const ASSETS_DIRECTORY = "assets";
const MANIFEST_FILE = "manifest.json";
const INCOMPLETE_MARKER = "FOLIO-RECOVERY-INCOMPLETE";
const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"];
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_ASSETS = 100_000;
const MAX_ASSET_NAME_LENGTH = 255;
const HASH_CHUNK_BYTES = 1024 * 1024;

const INVENTORY_KEYS = [
  "pages",
  "recordDatabases",
  "records",
  "versions",
  "settings",
  "saveReceipts",
  "registeredAssets",
] as const;
const MANIFEST_KEYS = [
  "format",
  "version",
  "createdAt",
  "database",
  "storeVersion",
  "inventory",
  "logicalSha256",
  "assets",
] as const;
const BACKUP_FILE_KEYS = ["path", "bytes", "sha256"] as const;

type PlainObject = Record<string, unknown>;
type ColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
  hidden: number;
};
type HashFileInfo = { bytes: number; sha256: string };

function isPlainObject(value: unknown): value is PlainObject {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function quoteIdentifier(name: string): string {
  if (typeof name !== "string" || !name || name.includes("\u0000"))
    throw new Error("Unsafe SQLite identifier");
  return `"${name.replace(/"/g, '""')}"`;
}

function exactKeys(
  value: PlainObject,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    throw new Error(`Invalid ${label} fields`);
}

function safeFileName(name: string, label: string): void {
  if (
    typeof name !== "string" ||
    !name ||
    name === "." ||
    name === ".." ||
    name.length > MAX_ASSET_NAME_LENGTH ||
    /[/\\\u0000]/.test(name)
  )
    throw new Error(`Unsafe ${label} name`);
}

function lstatOptional(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function requireDirectory(path: string, label: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`${label} is not a regular directory`);
}

function requireRegularFile(path: string, label: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error(`${label} is not a regular file`);
}

function openRegularFile(path: string, label: string) {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile())
    throw new Error(`${label} is not a regular file`);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw new Error(`${label} changed while opening`);
    return { fd, opened };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function hashRegularFile(path: string, label: string): HashFileInfo {
  const { fd, opened } = openRegularFile(path, label);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let bytes = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      bytes += read;
      if (!Number.isSafeInteger(bytes))
        throw new Error(`${label} is too large`);
      hash.update(buffer.subarray(0, read));
    }
    const after = fstatSync(fd);
    if (
      after.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.size !== opened.size ||
      bytes !== opened.size
    )
      throw new Error(`${label} changed while hashing`);
    return { bytes, sha256: hash.digest("hex") };
  } finally {
    closeSync(fd);
  }
}

function readBoundedFile(path: string, label: string): Buffer {
  const { fd, opened } = openRegularFile(path, label);
  try {
    if (opened.size > MAX_MANIFEST_BYTES)
      throw new Error(`${label} exceeds the size limit`);
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    const after = fstatSync(fd);
    if (
      after.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.size !== opened.size ||
      offset !== opened.size
    )
      throw new Error(`${label} changed while reading`);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function tableCount(db: DatabaseSync, name: string): number {
  if (!tableExists(db, name)) return 0;
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`)
    .get() as { count: number };
  return row.count;
}

function tableColumns(db: DatabaseSync, name: string): ColumnInfo[] {
  return db
    .prepare(`PRAGMA table_xinfo(${quoteIdentifier(name)})`)
    .all() as ColumnInfo[];
}

/** SQLite's own quote() preserves INTEGER/REAL/TEXT/BLOB/NULL exactly and
 * avoids JavaScript number precision loss for 64-bit history IDs. */
function logicalDigest(db: DatabaseSync): string {
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('sqlite_master','sqlite_temp_master') ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  const hash = createHash("sha256");
  hash.update("folio-workspace-logical-v1\n");
  for (const table of tables) {
    const columns = tableColumns(db, table);
    hash.update(
      "T" +
        JSON.stringify({
          table,
          columns: columns.map((column) => [
            column.name,
            column.type,
            column.notnull,
            column.pk,
            column.hidden,
          ]),
        }) +
        "\n",
    );
    if (!columns.length) {
      hash.update("E\n");
      continue;
    }
    const select = columns
      .map(
        (column, index) =>
          `quote(${quoteIdentifier(column.name)}) AS c${index}`,
      )
      .join(", ");
    const order = columns
      .map((_, index) => `${index + 1} COLLATE BINARY`)
      .join(", ");
    const rows = db
      .prepare(
        `SELECT ${select} FROM ${quoteIdentifier(table)} ORDER BY ${order}`,
      )
      .iterate();
    for (const row of rows) {
      const values = columns.map(
        (_, index) => (row as Record<string, unknown>)[`c${index}`],
      );
      hash.update("R" + JSON.stringify(values) + "\n");
    }
    hash.update("E\n");
  }
  return hash.digest("hex");
}

function parseRecordValues(raw: unknown, label: string): PlainObject {
  if (typeof raw !== "string") throw new Error(`Invalid ${label}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
  if (!isPlainObject(parsed)) throw new Error(`Invalid ${label}`);
  const entries = Object.entries(parsed);
  if (
    entries.length > 1000 ||
    entries.some(
      ([key, value]) =>
        !key ||
        key.length > 500 ||
        !(
          typeof value === "string" ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value))
        ),
    )
  )
    throw new Error(`Invalid ${label}`);
  return parsed;
}

function validatePageRelationships(
  db: DatabaseSync,
): Map<string, PlainObject> {
  const pages = new Map<string, PlainObject>();
  const parents = new Map<string, string | null>();
  const rows = db.prepare("SELECT id,data FROM pages ORDER BY id").all() as {
    id: unknown;
    data: unknown;
  }[];
  for (const row of rows) {
    if (typeof row.id !== "string" || !row.id)
      throw new Error("Invalid page identity");
    if (typeof row.data !== "string")
      throw new Error("Invalid page document JSON");
    let page: unknown;
    try {
      // Parse only for relationship checks. The raw TEXT value remains the
      // source of truth in the logical digest, so unknown nodes/fields survive.
      page = JSON.parse(row.data);
    } catch {
      throw new Error("Invalid page document JSON");
    }
    if (!isPlainObject(page) || page.id !== row.id)
      throw new Error("Page identity does not match its row");
    if (
      !(
        page.parentId === null ||
        (typeof page.parentId === "string" && page.parentId.length > 0)
      )
    )
      throw new Error("Invalid page parent reference");
    if (pages.has(row.id)) throw new Error("Duplicate page identity");
    pages.set(row.id, page);
    parents.set(row.id, page.parentId as string | null);
  }
  for (const [id, parentId] of parents)
    if (parentId !== null && !pages.has(parentId))
      throw new Error("Page parent reference is missing");

  // Detect cycles without recursion so a corrupted hierarchy cannot exhaust
  // the JavaScript stack.
  const state = new Map<string, 0 | 1 | 2>();
  for (const id of pages.keys()) {
    const path: string[] = [];
    let current: string | null = id;
    while (current !== null) {
      const seen = state.get(current) ?? 0;
      if (seen === 1) throw new Error("Page hierarchy contains a cycle");
      if (seen === 2) break;
      state.set(current, 1);
      path.push(current);
      current = parents.get(current) ?? null;
    }
    for (const item of path) state.set(item, 2);
  }
  return pages;
}

const RECORD_TABLE_SHAPES: Record<
  string,
  [string, string, number, number][]
> = {
  record_databases: [["database_page_id", "TEXT", 0, 1]],
  record_memberships: [
    ["page_id", "TEXT", 0, 1],
    ["database_page_id", "TEXT", 1, 0],
    ["position", "INTEGER", 1, 0],
    ["values_json", "TEXT", 1, 0],
  ],
  record_value_versions: [
    ["version_id", "INTEGER", 0, 1],
    ["values_json", "TEXT", 1, 0],
  ],
};

function validateRecordTableShapes(db: DatabaseSync): void {
  for (const [table, expected] of Object.entries(RECORD_TABLE_SHAPES)) {
    const actual = tableColumns(db, table);
    if (
      actual.length !== expected.length ||
      actual.some(
        (column, index) =>
          column.name !== expected[index][0] ||
          column.type.toUpperCase() !== expected[index][1] ||
          column.notnull !== expected[index][2] ||
          column.pk !== expected[index][3] ||
          column.hidden !== 0 ||
          column.dflt_value !== null,
      )
    )
      throw new Error("Incomplete or unsupported record store");
  }
}

function validateRecordRelationships(
  db: DatabaseSync,
  storeVersion: number,
  pages: Map<string, PlainObject>,
): void {
  const names = ["record_databases", "record_memberships", "record_value_versions"];
  const present = names.filter((name) => tableExists(db, name));
  if (present.length && present.length !== names.length)
    throw new Error("Incomplete or unsupported record store");
  const marked = tableExists(db, "folio_record_schema");
  if (marked || storeVersion >= 4) validateRecordStoreVersion(db);
  if (present.length === names.length) validateRecordTableShapes(db);
  if (!present.length) {
    if (marked) throw new Error("Incomplete or unsupported record store");
    return;
  }

  const registered = new Set<string>();
  const databases = db
    .prepare("SELECT database_page_id FROM record_databases ORDER BY database_page_id")
    .all() as { database_page_id: unknown }[];
  for (const row of databases) {
    if (typeof row.database_page_id !== "string" || !row.database_page_id)
      throw new Error("Invalid record database owner");
    const owner = pages.get(row.database_page_id);
    if (!owner) throw new Error("Record database owner page is missing");
    if (
      owner.kind !== "database" ||
      !isPlainObject(owner.database) ||
      !Array.isArray(owner.database.rows) ||
      owner.database.rows.length !== 0
    )
      throw new Error("Record database owner is invalid");
    registered.add(row.database_page_id);
  }

  const members = db
    .prepare(
      "SELECT page_id,database_page_id,position,values_json FROM record_memberships ORDER BY page_id",
    )
    .all() as {
    page_id: unknown;
    database_page_id: unknown;
    position: unknown;
    values_json: unknown;
  }[];
  const memberOwners = new Map<string, string>();
  for (const row of members) {
    if (
      typeof row.page_id !== "string" ||
      !row.page_id ||
      typeof row.database_page_id !== "string" ||
      !row.database_page_id
    )
      throw new Error("Invalid record membership identity");
    if (row.page_id === row.database_page_id)
      throw new Error("Record cannot own itself");
    const page = pages.get(row.page_id);
    if (!page) throw new Error("Record page is missing");
    if (!registered.has(row.database_page_id))
      throw new Error("Record owner is not registered");
    if (page.kind !== "page" || page.database !== null)
      throw new Error("Record page shape is invalid");
    if (!Number.isSafeInteger(row.position) || (row.position as number) < 0)
      throw new Error("Invalid record position");
    parseRecordValues(row.values_json, "record values");
    memberOwners.set(row.page_id, row.database_page_id);
  }

  const versionIds = new Set(
    (
      db.prepare("SELECT id FROM versions ORDER BY id").all() as {
        id: unknown;
      }[]
    ).map((row) => row.id),
  );
  const valueVersions = db
    .prepare(
      "SELECT version_id,values_json FROM record_value_versions ORDER BY version_id",
    )
    .all() as { version_id: unknown; values_json: unknown }[];
  for (const row of valueVersions) {
    if (!versionIds.has(row.version_id))
      throw new Error("Record value version references missing history");
    parseRecordValues(row.values_json, "record value version");
  }

  const archivedOwners = new Set<string>();
  if (tableExists(db, "legacy_database_archive")) {
    const rows = db
      .prepare("SELECT database_page_id,data FROM legacy_database_archive")
      .all() as { database_page_id: unknown; data: unknown }[];
    for (const row of rows) {
      if (
        typeof row.database_page_id !== "string" ||
        !pages.has(row.database_page_id) ||
        typeof row.data !== "string"
      )
        throw new Error("Invalid legacy database archive");
      archivedOwners.add(row.database_page_id);
    }
  }
  if (tableExists(db, "legacy_database_versions")) {
    const rows = db
      .prepare("SELECT version_id,database_page_id FROM legacy_database_versions")
      .all() as { version_id: unknown; database_page_id: unknown }[];
    for (const row of rows)
      if (
        !versionIds.has(row.version_id) ||
        typeof row.database_page_id !== "string" ||
        !pages.has(row.database_page_id)
      )
        throw new Error("Invalid legacy database version");
  }
  if (tableExists(db, "legacy_record_map")) {
    const rows = db
      .prepare("SELECT database_page_id,legacy_row_id,page_id FROM legacy_record_map")
      .all() as { database_page_id: unknown; legacy_row_id: unknown; page_id: unknown }[];
    for (const row of rows) {
      if (typeof row.database_page_id !== "string" || !registered.has(row.database_page_id) ||
          typeof row.legacy_row_id !== "string" || !row.legacy_row_id ||
          typeof row.page_id !== "string" || !row.page_id)
        throw new Error("Invalid legacy record mapping");
      // Conversion reserves an ID for rows that only exist in history.
      const valid = pages.has(row.page_id)
        ? memberOwners.get(row.page_id) === row.database_page_id
        : archivedOwners.has(row.database_page_id);
      if (!valid) throw new Error("Invalid legacy record mapping");
    }
  }
  if (tableExists(db, "record_database_trash_batches")) {
    const rows = db
      .prepare("SELECT database_page_id FROM record_database_trash_batches")
      .all() as { database_page_id: unknown }[];
    for (const row of rows)
      if (
        typeof row.database_page_id !== "string" ||
        !registered.has(row.database_page_id)
      )
        throw new Error("Invalid record trash batch");
  }
  if (tableExists(db, "record_database_trash_members")) {
    const rows = db
      .prepare("SELECT database_page_id,page_id FROM record_database_trash_members")
      .all() as { database_page_id: unknown; page_id: unknown }[];
    for (const row of rows)
      if (
        typeof row.database_page_id !== "string" ||
        typeof row.page_id !== "string" ||
        !registered.has(row.database_page_id) ||
        !pages.has(row.page_id)
      )
        throw new Error("Invalid record trash member");
  }
}

function inventoryOf(
  db: DatabaseSync,
  overrides: Partial<WorkspaceInventory> = {},
): WorkspaceInventory {
  return {
    pages: tableCount(db, "pages"),
    recordDatabases: tableCount(db, "record_databases"),
    records: tableCount(db, "record_memberships"),
    versions: tableCount(db, "versions"),
    settings: tableCount(db, "settings"),
    saveReceipts: tableCount(db, "save_receipts"),
    registeredAssets: tableCount(db, "assets"),
    ...overrides,
  };
}

function inspectAssets(
  directory: string,
  registered: Map<string, HashFileInfo>,
): BackupFile[] {
  const assetsPath = join(directory, ASSETS_DIRECTORY);
  const assetsInfo = lstatOptional(assetsPath);
  if (!assetsInfo) {
    if (registered.size)
      throw new Error("Assets directory is missing registered files");
    return [];
  }
  if (assetsInfo.isSymbolicLink() || !assetsInfo.isDirectory())
    throw new Error("Assets path is not a regular directory");
  const names = readdirSync(assetsPath).sort();
  const files: BackupFile[] = [];
  const actual = new Map<string, HashFileInfo>();
  for (const name of names) {
    safeFileName(name, "asset file");
    const info = hashRegularFile(join(assetsPath, name), `Asset ${name}`);
    actual.set(name, info);
    files.push({
      path: `${ASSETS_DIRECTORY}/${name}`,
      bytes: info.bytes,
      sha256: info.sha256,
    });
  }
  for (const [id, expected] of registered) {
    const info = actual.get(id);
    if (!info) throw new Error(`Registered asset is missing: ${id}`);
    if (info.bytes !== expected.bytes || info.sha256 !== expected.sha256)
      throw new Error(`Registered asset does not match its registry: ${id}`);
  }
  return files;
}

function readAssetRegistry(db: DatabaseSync) {
  const rows = db
    .prepare("SELECT id,metadata FROM assets ORDER BY id")
    .all() as { id: unknown; metadata: unknown }[];
  const registered = new Map<string, HashFileInfo>();
  for (const row of rows) {
    if (typeof row.id !== "string" || !row.id)
      throw new Error("Invalid asset identity");
    safeFileName(row.id, "asset identity");
    if (typeof row.metadata !== "string")
      throw new Error(`Invalid asset metadata: ${row.id}`);
    let metadata: unknown;
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      throw new Error(`Invalid asset metadata: ${row.id}`);
    }
    if (!isPlainObject(metadata)) throw new Error(`Invalid asset metadata: ${row.id}`);
    if (
      metadata.id !== row.id ||
      metadata.storageName !== row.id ||
      !Number.isSafeInteger(metadata.size) ||
      (metadata.size as number) < 0 ||
      typeof metadata.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(metadata.sha256)
    )
      throw new Error(`Invalid asset metadata: ${row.id}`);
    registered.set(row.id, {
      bytes: metadata.size as number,
      sha256: metadata.sha256,
    });
  }
  return registered;
}

/**
 * Inspect the canonical workspace snapshot layout without consulting a
 * manifest. The SQLite file is opened read-only; the Store constructor is
 * deliberately not used because it creates tables and may migrate a database.
 */
export function inspectWorkspaceSnapshot(directory: string): SnapshotInspection {
  requireDirectory(directory, "Workspace snapshot");
  const databasePath = join(directory, DATABASE_FILE);
  requireRegularFile(databasePath, "Workspace database");
  for (const suffix of SIDECAR_SUFFIXES)
    if (lstatOptional(databasePath + suffix))
      throw new Error("Workspace database has an unsafe SQLite sidecar");

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });
    db.exec("BEGIN");
    const checks = db.prepare("PRAGMA integrity_check").all() as {
      integrity_check: string;
    }[];
    if (checks.length !== 1 || checks[0].integrity_check !== "ok")
      throw new Error("Workspace database failed its integrity check");
    const version = (
      db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    if (version !== 3 && version !== 4 && version !== 5)
      throw new Error("Unsupported workspace database version");
    if (version === 5) validateV5WorkspaceSchema(db);
    for (const required of [
      "pages",
      "settings",
      "versions",
      "save_receipts",
      "assets",
    ])
      if (!tableExists(db, required))
        throw new Error(`Workspace database is missing ${required}`);

    const pages = validatePageRelationships(db);
    validateRecordRelationships(db, version, pages);
    const registered = readAssetRegistry(db);
    const inventory = inventoryOf(db, { registeredAssets: registered.size });
    const logicalSha256 = logicalDigest(db);
    const assets = inspectAssets(directory, registered);
    db.exec("COMMIT");
    return { storeVersion: version, inventory, logicalSha256, assets };
  } catch (error) {
    if (db?.isTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {}
    }
    throw error;
  } finally {
    db?.close();
  }
}

function canonicalRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.length > 1024)
    throw new Error(`Invalid ${label} path`);
  if (
    value.includes("\u0000") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`Invalid ${label} path`);
  return value;
}

function backupFile(
  value: unknown,
  label: string,
  asset: boolean,
): BackupFile {
  if (!isPlainObject(value)) throw new Error(`Invalid ${label}`);
  exactKeys(value, BACKUP_FILE_KEYS, label);
  const path = canonicalRelativePath(value.path, label);
  if (asset) {
    if (!path.startsWith(`${ASSETS_DIRECTORY}/`))
      throw new Error(`Invalid ${label} path`);
    const name = path.slice(ASSETS_DIRECTORY.length + 1);
    safeFileName(name, `${label} file`);
  } else if (path !== DATABASE_FILE) throw new Error(`Invalid ${label} path`);
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0)
    throw new Error(`Invalid ${label} bytes`);
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256))
    throw new Error(`Invalid ${label} hash`);
  return {
    path,
    bytes: value.bytes as number,
    sha256: value.sha256,
  };
}

function parseManifest(value: unknown): WorkspaceBackupManifest {
  if (!isPlainObject(value)) throw new Error("Invalid backup manifest");
  exactKeys(value, MANIFEST_KEYS, "backup manifest");
  if (value.format !== FORMAT || value.version !== FORMAT_VERSION)
    throw new Error("Unsupported backup manifest format");
  if (
    typeof value.createdAt !== "string" ||
    value.createdAt.length > 64 ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  )
    throw new Error("Invalid backup creation time");
  if (
    !Number.isSafeInteger(value.storeVersion) ||
    (value.storeVersion !== 3 && value.storeVersion !== 4 && value.storeVersion !== 5)
  )
    throw new Error("Unsupported workspace database version");
  if (!isPlainObject(value.inventory))
    throw new Error("Invalid backup inventory");
  exactKeys(value.inventory, INVENTORY_KEYS, "backup inventory");
  const inventory = {} as WorkspaceInventory;
  for (const key of INVENTORY_KEYS) {
    const count = value.inventory[key];
    if (!Number.isSafeInteger(count) || (count as number) < 0)
      throw new Error("Invalid backup inventory");
    inventory[key] = count as number;
  }
  if (
    typeof value.logicalSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.logicalSha256)
  )
    throw new Error("Invalid logical digest");
  const database = backupFile(value.database, "backup database", false);
  if (!Array.isArray(value.assets) || value.assets.length > MAX_ASSETS)
    throw new Error("Invalid backup asset list");
  const assets: BackupFile[] = [];
  const paths = new Set<string>();
  for (const item of value.assets) {
    const file = backupFile(item, "backup asset", true);
    if (paths.has(file.path)) throw new Error("Duplicate backup asset path");
    paths.add(file.path);
    assets.push(file);
  }
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    createdAt: value.createdAt,
    database,
    storeVersion: value.storeVersion as number,
    inventory,
    logicalSha256: value.logicalSha256,
    assets,
  };
}

function sameInventory(
  left: WorkspaceInventory,
  right: WorkspaceInventory,
): boolean {
  return INVENTORY_KEYS.every((key) => left[key] === right[key]);
}

function sameAssets(left: BackupFile[], right: BackupFile[]): boolean {
  const orderedLeft = [...left].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const orderedRight = [...right].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return (
    orderedLeft.length === orderedRight.length &&
    orderedLeft.every(
      (file, index) =>
        file.path === orderedRight[index].path &&
        file.bytes === orderedRight[index].bytes &&
        file.sha256 === orderedRight[index].sha256,
    )
  );
}

/**
 * Verify a complete backup directory. Every manifest field is checked against
 * the actual file bytes and a fresh read-only inspection, including orphan
 * assets. The returned fingerprint is the SHA-256 of the exact manifest bytes.
 */
export function verifyFullBackup(
  directory: string,
  options: { allowIncomplete?: boolean } = {},
): VerifiedWorkspaceBackup {
  requireDirectory(directory, "Backup directory");
  const allowIncomplete = options?.allowIncomplete === true;
  const entries = readdirSync(directory);
  const allowed = new Set([MANIFEST_FILE, DATABASE_FILE, ASSETS_DIRECTORY]);
  if (allowIncomplete) allowed.add(INCOMPLETE_MARKER);
  for (const name of entries) {
    const path = join(directory, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink())
      throw new Error("Backup contains a symbolic link");
    if (!allowed.has(name))
      throw new Error(`Unexpected backup entry: ${name}`);
    if (name === ASSETS_DIRECTORY) {
      if (!info.isDirectory())
        throw new Error("Backup assets path is not a directory");
    } else if (!info.isFile()) {
      throw new Error(`Backup entry is not a regular file: ${name}`);
    }
  }
  const marker = lstatOptional(join(directory, INCOMPLETE_MARKER));
  if (marker && !allowIncomplete)
    throw new Error(
      "Incomplete recovery workspace; FOLIO-RECOVERY-INCOMPLETE is present",
    );
  if (marker && (marker.isSymbolicLink() || !marker.isFile()))
    throw new Error("Incomplete recovery marker is not a regular file");

  const manifestPath = join(directory, MANIFEST_FILE);
  const manifestBytes = readBoundedFile(manifestPath, "Backup manifest");
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes),
    );
  } catch {
    throw new Error("Malformed backup manifest");
  }
  const manifest = parseManifest(parsed);

  const databaseInfo = hashRegularFile(
    join(directory, DATABASE_FILE),
    "Backup database",
  );
  if (
    databaseInfo.bytes !== manifest.database.bytes ||
    databaseInfo.sha256 !== manifest.database.sha256
  )
    throw new Error("Backup database bytes or hash do not match the manifest");

  const inspection = inspectWorkspaceSnapshot(directory);
  if (inspection.storeVersion !== manifest.storeVersion)
    throw new Error("Backup store version does not match the manifest");
  if (!sameInventory(inspection.inventory, manifest.inventory))
    throw new Error("Backup inventory does not match the manifest");
  if (inspection.logicalSha256 !== manifest.logicalSha256)
    throw new Error("Backup logical digest does not match the manifest");
  if (!sameAssets(inspection.assets, manifest.assets))
    throw new Error("Backup asset list does not match the manifest");

  return {
    directory,
    manifest,
    fingerprint: createHash("sha256").update(manifestBytes).digest("hex"),
  };
}
