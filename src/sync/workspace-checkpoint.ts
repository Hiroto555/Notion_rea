import type { DatabaseSync } from "node:sqlite";
import { parseAssetURL } from "../shared/assets";
import { isLosslessDatabaseData } from "../database/strict-database";
import { normalizeDatabaseData } from "../database/model";
import { isDocument, textOf, type Page } from "../shared/types";
import {
  canonicalJson,
  MAX_CHECKPOINT_BYTES,
  type AssetManifest,
  type Checkpoint,
} from "./protocol";

/**
 * The workspace checkpoint is intentionally narrower than a SQLite dump.
 * Settings, save receipts and recovery metadata stay on the device. Every
 * table below is a product-data table and is covered by a durable generation
 * trigger when a workspace is promoted to version 5.
 */
export const WORKSPACE_CHECKPOINT_NAME = "folio-workspace";
export const WORKSPACE_CHECKPOINT_VERSION = 1;
export const WORKSPACE_SYNC_SCHEMA_VERSION = 1;

export const WORKSPACE_CONTENT_TABLES = [
  "pages",
  "versions",
  "assets",
  "record_databases",
  "record_memberships",
  "record_value_versions",
  "record_database_trash_batches",
  "record_database_trash_members",
  "legacy_database_archive",
  "legacy_database_versions",
  "legacy_record_map",
] as const;

export type WorkspaceContentTable = (typeof WORKSPACE_CONTENT_TABLES)[number];

type ColumnKind = "string" | "integer" | "nullable-string";
type TableSpec = {
  name: WorkspaceContentTable;
  columns: readonly { field: string; kind: ColumnKind }[];
  select: string;
  key: readonly number[];
};

/** Canonical row order is the table primary key order. SQLite's BINARY
 * collation and JavaScript's code-unit comparison agree for the ASCII
 * identifiers Folio stores. */
const TABLE_SPECS: readonly TableSpec[] = [
  {
    name: "pages",
    columns: [
      { field: "id", kind: "string" },
      { field: "data", kind: "string" },
    ],
    select: "SELECT id,data FROM pages ORDER BY id",
    key: [0],
  },
  {
    name: "versions",
    columns: [
      { field: "id", kind: "integer" },
      { field: "pageId", kind: "string" },
      { field: "createdAt", kind: "integer" },
      { field: "title", kind: "string" },
      { field: "doc", kind: "string" },
      { field: "database", kind: "nullable-string" },
    ],
    select:
      "SELECT id,pageId,createdAt,title,doc,database FROM versions ORDER BY id",
    key: [0],
  },
  {
    name: "assets",
    columns: [
      { field: "id", kind: "string" },
      { field: "metadata", kind: "string" },
    ],
    select: "SELECT id,metadata FROM assets ORDER BY id",
    key: [0],
  },
  {
    name: "record_databases",
    columns: [{ field: "database_page_id", kind: "string" }],
    select:
      "SELECT database_page_id FROM record_databases ORDER BY database_page_id",
    key: [0],
  },
  {
    name: "record_memberships",
    columns: [
      { field: "page_id", kind: "string" },
      { field: "database_page_id", kind: "string" },
      { field: "position", kind: "integer" },
      { field: "values_json", kind: "string" },
    ],
    select:
      "SELECT page_id,database_page_id,position,values_json FROM record_memberships ORDER BY page_id",
    key: [0],
  },
  {
    name: "record_value_versions",
    columns: [
      { field: "version_id", kind: "integer" },
      { field: "values_json", kind: "string" },
    ],
    select:
      "SELECT version_id,values_json FROM record_value_versions ORDER BY version_id",
    key: [0],
  },
  {
    name: "record_database_trash_batches",
    columns: [
      { field: "database_page_id", kind: "string" },
      { field: "deleted_revision", kind: "integer" },
      { field: "deleted_at", kind: "integer" },
    ],
    select:
      "SELECT database_page_id,deleted_revision,deleted_at FROM record_database_trash_batches ORDER BY database_page_id",
    key: [0],
  },
  {
    name: "record_database_trash_members",
    columns: [
      { field: "database_page_id", kind: "string" },
      { field: "page_id", kind: "string" },
      { field: "deleted_revision", kind: "integer" },
    ],
    select:
      "SELECT database_page_id,page_id,deleted_revision FROM record_database_trash_members ORDER BY database_page_id,page_id",
    key: [0, 1],
  },
  {
    name: "legacy_database_archive",
    columns: [
      { field: "database_page_id", kind: "string" },
      { field: "data", kind: "string" },
    ],
    select:
      "SELECT database_page_id,data FROM legacy_database_archive ORDER BY database_page_id",
    key: [0],
  },
  {
    name: "legacy_database_versions",
    columns: [
      { field: "version_id", kind: "integer" },
      { field: "database_page_id", kind: "string" },
    ],
    select:
      "SELECT version_id,database_page_id FROM legacy_database_versions ORDER BY version_id",
    key: [0],
  },
  {
    name: "legacy_record_map",
    columns: [
      { field: "database_page_id", kind: "string" },
      { field: "legacy_row_id", kind: "string" },
      { field: "page_id", kind: "string" },
    ],
    select:
      "SELECT database_page_id,legacy_row_id,page_id FROM legacy_record_map ORDER BY database_page_id,legacy_row_id",
    key: [0, 1],
  },
] as const;

type CheckpointValue = string | number | null;
type CheckpointRow = CheckpointValue[];
type ParsedTables = Record<WorkspaceContentTable, CheckpointRow[]>;

type ParsedAssetMetadata = {
  id: string;
  name: string;
  extension: string;
  mime: string;
  storageName: string;
  size: number;
  sha256: string;
};

type InspectedCheckpoint = {
  checkpoint: Checkpoint;
  tables: ParsedTables;
  assets: AssetManifest[];
};

class CheckpointError extends Error {}

function requireCheckpoint(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new CheckpointError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort(),
    expected = [...keys].sort();
  requireCheckpoint(
    actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]),
    `Invalid ${label} fields`,
  );
}

function assertIdentifier(value: unknown, label: string): string {
  requireCheckpoint(
    typeof value === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value),
    `Invalid ${label}`,
  );
  return value;
}

function assertSafeInteger(value: unknown, label: string, minimum = 0): number {
  requireCheckpoint(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= minimum,
    `Invalid ${label}`,
  );
  return value;
}

function assertHash(value: unknown, label: string): string {
  requireCheckpoint(
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    `Invalid ${label}`,
  );
  return value;
}

function assertString(
  value: unknown,
  label: string,
  maximum = 1_000_000,
): string {
  requireCheckpoint(
    typeof value === "string" && value.length <= maximum,
    `Invalid ${label}`,
  );
  return value;
}

/** Exact Store body expression. The search body is never transferred; it is
 * recomputed from the transferred Page JSON during remote apply. */
export function pageSearchBody(page: Page): string {
  return [
    page.title,
    textOf(page.doc),
    ...(page.database?.rows.map(
      (row) => row.title + " " + Object.values(row.values).join(" "),
    ) ?? []),
  ].join("\n");
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function readTable(db: DatabaseSync, spec: TableSpec): CheckpointRow[] {
  if (!hasTable(db, spec.name)) return [];
  const rows = db.prepare(spec.select).all() as Record<string, unknown>[];
  return rows.map((row) =>
    spec.columns.map((column) => {
      const value = row[column.field];
      if (value === null) return null;
      if (typeof value === "bigint") return Number(value);
      if (typeof value === "string" || typeof value === "number") return value;
      throw new CheckpointError(
        `Unsupported ${spec.name}.${column.field} storage type`,
      );
    }),
  );
}

function assetMime(value: unknown): string {
  const mime = assertString(value, "asset mime", 200);
  requireCheckpoint(
    [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "text/plain",
      "application/pdf",
      "application/octet-stream",
    ].includes(mime),
    "Unsupported asset mime",
  );
  return mime;
}

function parseAssetMetadata(value: unknown): ParsedAssetMetadata {
  requireCheckpoint(isPlainObject(value), "Invalid asset metadata");
  exactKeys(
    value,
    ["id", "name", "extension", "mime", "storageName", "size", "sha256"],
    "asset metadata",
  );
  const id = assertString(value.id, "asset id", 200),
    sha256 = assertHash(value.sha256, "asset hash"),
    size = assertSafeInteger(value.size, "asset size");
  requireCheckpoint(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id),
    "Invalid asset id",
  );
  requireCheckpoint(size <= 20_000_000, "Asset exceeds the size limit");
  requireCheckpoint(
    value.storageName === id,
    "Asset storage identity mismatch",
  );
  return {
    id,
    name: assertString(value.name, "asset name", 1000),
    extension: assertString(value.extension, "asset extension", 100),
    mime: assetMime(value.mime),
    storageName: id,
    size,
    sha256,
  };
}

/** Derive the wire manifest from the registry rows. Bad metadata refuses the
 * checkpoint instead of publishing an incomplete attachment list. */
export function assetManifestFromRows(
  rows: readonly CheckpointRow[],
): AssetManifest[] {
  const seen = new Set<string>();
  return rows
    .map((row) => {
      requireCheckpoint(row.length === 2, "Invalid asset registry row");
      const id = assertString(row[0], "asset row id", 200),
        metadata = parseAssetMetadata(JSON.parse(String(row[1])));
      requireCheckpoint(metadata.id === id, "Asset row identity mismatch");
      requireCheckpoint(!seen.has(id), "Duplicate asset row");
      seen.add(id);
      return { id, sha256: metadata.sha256, bytes: metadata.size };
    })
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
}

/** Snapshot every known content table. Optional tables that have not been
 * created by an older workspace are represented by an empty array so the
 * payload has one exact schema. */
export function buildWorkspaceCheckpoint(db: DatabaseSync): Checkpoint {
  assertKnownWorkspaceTables(db);
  const tables = {} as ParsedTables;
  for (const spec of TABLE_SPECS) tables[spec.name] = readTable(db, spec);
  const assets = assetManifestFromRows(tables.assets);
  return {
    format: "folio-checkpoint/v1",
    name: WORKSPACE_CHECKPOINT_NAME,
    version: WORKSPACE_CHECKPOINT_VERSION,
    payload: { tables },
    assets,
  };
}

function parseEnvelope(value: unknown): InspectedCheckpoint {
  requireCheckpoint(isPlainObject(value), "Checkpoint is not an object");
  exactKeys(
    value,
    ["format", "name", "version", "payload", "assets"],
    "checkpoint",
  );
  requireCheckpoint(
    value.format === "folio-checkpoint/v1",
    "Unsupported checkpoint format",
  );
  requireCheckpoint(
    value.name === WORKSPACE_CHECKPOINT_NAME,
    "Unsupported checkpoint name",
  );
  requireCheckpoint(
    value.version === WORKSPACE_CHECKPOINT_VERSION,
    "Unsupported checkpoint version",
  );
  requireCheckpoint(isPlainObject(value.payload), "Invalid checkpoint payload");
  exactKeys(value.payload, ["tables"], "payload");
  requireCheckpoint(
    isPlainObject(value.payload.tables),
    "Invalid checkpoint tables",
  );
  exactKeys(value.payload.tables, WORKSPACE_CONTENT_TABLES, "table");
  const tables = {} as ParsedTables;
  for (const spec of TABLE_SPECS) {
    const raw = value.payload.tables[spec.name];
    requireCheckpoint(Array.isArray(raw), `Invalid ${spec.name} rows`);
    const rows: CheckpointRow[] = [];
    for (const entry of raw) {
      requireCheckpoint(
        Array.isArray(entry) && entry.length === spec.columns.length,
        `Invalid ${spec.name} row`,
      );
      const row: CheckpointRow = [];
      for (const [index, column] of spec.columns.entries()) {
        const item = entry[index];
        if (column.kind === "string")
          row.push(assertString(item, `${spec.name}.${column.field}`));
        else if (column.kind === "integer")
          row.push(assertSafeInteger(item, `${spec.name}.${column.field}`));
        else {
          requireCheckpoint(
            item === null || typeof item === "string",
            `Invalid ${spec.name}.${column.field}`,
          );
          row.push(item === null ? null : item);
        }
      }
      if (rows.length) {
        const previous = rows[rows.length - 1];
        let order = 0;
        for (const index of spec.key) {
          if (row[index] === previous[index]) continue;
          order =
            (row[index] as string | number) <
            (previous[index] as string | number)
              ? -1
              : 1;
          break;
        }
        requireCheckpoint(order > 0, `Unsorted or duplicate ${spec.name} rows`);
      }
      rows.push(row);
    }
    tables[spec.name] = rows;
  }
  requireCheckpoint(Array.isArray(value.assets), "Invalid checkpoint assets");
  const manifest: AssetManifest[] = [];
  for (const entry of value.assets) {
    requireCheckpoint(isPlainObject(entry), "Invalid asset manifest entry");
    exactKeys(entry, ["id", "sha256", "bytes"], "asset manifest entry");
    manifest.push({
      id: assertString(entry.id, "asset manifest id", 200),
      sha256: assertHash(entry.sha256, "asset manifest hash"),
      bytes: assertSafeInteger(entry.bytes, "asset manifest bytes"),
    });
  }
  for (let index = 1; index < manifest.length; index++) {
    requireCheckpoint(
      manifest[index - 1].id < manifest[index].id,
      "Unsorted or duplicate asset manifest",
    );
  }
  // Enforce the wire budget through the same canonical encoder the hash uses.
  canonicalJson(value, MAX_CHECKPOINT_BYTES);
  return {
    checkpoint: value as unknown as Checkpoint,
    tables,
    assets: manifest,
  };
}

function parsePageData(id: string, raw: string): Page {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CheckpointError("Invalid Page JSON");
  }
  requireCheckpoint(isPlainObject(value), "Invalid Page object");
  const allowed = new Set([
    "id",
    "schemaVersion",
    "parentId",
    "title",
    "icon",
    "cover",
    "position",
    "doc",
    "kind",
    "database",
    "favorite",
    "width",
    "createdAt",
    "updatedAt",
    "revision",
    "deletedAt",
    "recoveredFrom",
  ]);
  for (const key of Object.keys(value))
    requireCheckpoint(allowed.has(key), `Unsupported Page field ${key}`);
  requireCheckpoint(value.id === id, "Page identity mismatch");
  requireCheckpoint(
    value.schemaVersion === undefined || value.schemaVersion === 1,
    "Unsupported Page schema",
  );
  requireCheckpoint(
    value.parentId === null ||
      (typeof value.parentId === "string" &&
        value.parentId.length > 0 &&
        value.parentId.length <= 500),
    "Invalid Page parent",
  );
  requireCheckpoint(
    typeof value.title === "string" && value.title.length <= 500,
    "Invalid Page title",
  );
  requireCheckpoint(
    typeof value.icon === "string" && value.icon.length <= 16,
    "Invalid Page icon",
  );
  requireCheckpoint(
    typeof value.cover === "string" && value.cover.length <= 500,
    "Invalid Page cover",
  );
  requireCheckpoint(
    typeof value.position === "number" && Number.isFinite(value.position),
    "Invalid Page position",
  );
  requireCheckpoint(isDocument(value.doc), "Invalid Page document");
  requireCheckpoint(
    value.kind === "page" || value.kind === "database",
    "Invalid Page kind",
  );
  requireCheckpoint(
    value.favorite === true || value.favorite === false,
    "Invalid Page favorite",
  );
  requireCheckpoint(
    value.width === undefined ||
      value.width === "standard" ||
      value.width === "wide",
    "Invalid Page width",
  );
  requireCheckpoint(
    typeof value.createdAt === "number" &&
      Number.isFinite(value.createdAt) &&
      value.createdAt >= 0 &&
      typeof value.updatedAt === "number" &&
      Number.isFinite(value.updatedAt) &&
      value.updatedAt >= 0,
    "Invalid Page timestamps",
  );
  requireCheckpoint(
    value.deletedAt === null ||
      (typeof value.deletedAt === "number" &&
        Number.isFinite(value.deletedAt) &&
        value.deletedAt >= 0),
    "Invalid Page deletion time",
  );
  requireCheckpoint(
    Number.isSafeInteger(value.revision) && (value.revision as number) >= 0,
    "Invalid Page revision",
  );
  if (value.recoveredFrom !== undefined) {
    requireCheckpoint(
      isPlainObject(value.recoveredFrom),
      "Invalid recovery origin",
    );
    exactKeys(
      value.recoveredFrom,
      ["pageId", "recoveredAt"],
      "recovery origin",
    );
    assertString(value.recoveredFrom.pageId, "recovery page id", 500);
    requireCheckpoint(
      typeof value.recoveredFrom.recoveredAt === "number" &&
        Number.isFinite(value.recoveredFrom.recoveredAt) &&
        value.recoveredFrom.recoveredAt >= 0,
      "Invalid recovery time",
    );
  }
  if (value.kind === "page")
    requireCheckpoint(
      value.database === null || value.database === undefined,
      "Page database must be null",
    );
  else {
    requireCheckpoint(value.database != null, "Database definition is missing");
    const normalized = normalizeDatabaseData(value.database);
    requireCheckpoint(
      normalized.ok && isLosslessDatabaseData(value.database),
      "Invalid database definition",
    );
  }
  return value as unknown as Page;
}

function parseVersionDatabase(raw: string | null): void {
  if (raw === null) return;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CheckpointError("Invalid version database JSON");
  }
  if (value === null) return;
  const normalized = normalizeDatabaseData(value);
  requireCheckpoint(
    normalized.ok && isLosslessDatabaseData(value),
    "Invalid version database",
  );
}

function parseRecordValues(
  raw: string,
): Record<string, string | number | boolean> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CheckpointError("Invalid record values JSON");
  }
  requireCheckpoint(isPlainObject(value), "Invalid record values");
  const entries = Object.entries(value);
  requireCheckpoint(entries.length <= 1000, "Too many record values");
  for (const [key, item] of entries) {
    requireCheckpoint(!!key && key.length <= 500, "Invalid record property id");
    requireCheckpoint(
      typeof item === "string" ||
        typeof item === "boolean" ||
        (typeof item === "number" && Number.isFinite(item)),
      "Invalid record value",
    );
  }
  return value as Record<string, string | number | boolean>;
}

function collectAssetReferences(value: unknown, into: Set<string>): void {
  const stack: unknown[] = [value];
  let nodes = 0;
  while (stack.length) {
    requireCheckpoint(++nodes <= 500_000, "Checkpoint graph is too large");
    const item = stack.pop();
    if (typeof item === "string") {
      if (!item.startsWith("folio-asset://")) continue;
      const id = parseAssetURL(item);
      requireCheckpoint(id !== null, "Invalid asset reference");
      into.add(id);
    } else if (Array.isArray(item)) {
      for (const child of item) stack.push(child);
    } else if (isPlainObject(item)) {
      for (const child of Object.values(item)) stack.push(child);
    }
  }
}

function inspectCheckpoint(value: unknown): InspectedCheckpoint {
  const parsed = parseEnvelope(value);
  const { tables, assets } = parsed;
  const references = new Set<string>();

  const pages = new Map<string, Page>();
  for (const row of tables.pages) {
    const id = row[0] as string,
      page = parsePageData(id, row[1] as string);
    requireCheckpoint(!pages.has(id), "Duplicate Page id");
    pages.set(id, page);
  }
  for (const page of pages.values()) {
    if (page.parentId !== null) {
      requireCheckpoint(pages.has(page.parentId), "Page parent is missing");
      const seen = new Set<string>([page.id]);
      let cursor: Page = page;
      for (let depth = 0; cursor.parentId !== null; depth++) {
        requireCheckpoint(depth <= 10_000, "Page hierarchy is too deep");
        requireCheckpoint(
          !seen.has(cursor.parentId),
          "Page hierarchy is cyclic",
        );
        seen.add(cursor.parentId);
        cursor = pages.get(cursor.parentId)!;
      }
    }
  }

  const versions = new Map<
    number,
    { pageId: string; doc: unknown; database: string | null }
  >();
  for (const row of tables.versions) {
    const id = row[0] as number,
      pageId = row[1] as string,
      docText = row[4] as string,
      database = row[5] as string | null;
    requireCheckpoint(!versions.has(id), "Duplicate version id");
    requireCheckpoint(pages.has(pageId), "Version Page is missing");
    requireCheckpoint(id >= 1, "Invalid version id");
    requireCheckpoint(typeof row[3] === "string", "Invalid version title");
    let doc: unknown;
    try {
      doc = JSON.parse(docText);
    } catch {
      throw new CheckpointError("Invalid version document JSON");
    }
    requireCheckpoint(isDocument(doc), "Invalid version document");
    parseVersionDatabase(database);
    versions.set(id, { pageId, doc, database });
  }

  const assetsById = new Map<string, AssetManifest>();
  for (const row of tables.assets) {
    const id = row[0] as string,
      metadataText = row[1] as string;
    requireCheckpoint(!assetsById.has(id), "Duplicate asset id");
    const metadata = parseAssetMetadata(JSON.parse(metadataText));
    requireCheckpoint(metadata.id === id, "Asset row identity mismatch");
    assetsById.set(id, { id, sha256: metadata.sha256, bytes: metadata.size });
  }
  requireCheckpoint(
    assets.length === assetsById.size,
    "Asset manifest does not match the registry",
  );
  for (const entry of assets) {
    const row = assetsById.get(entry.id);
    requireCheckpoint(
      !!row && row.sha256 === entry.sha256 && row.bytes === entry.bytes,
      "Asset manifest does not match the registry",
    );
  }

  const registered = new Set<string>();
  for (const row of tables.record_databases) {
    const id = row[0] as string,
      page = pages.get(id);
    requireCheckpoint(!!page, "Registered database Page is missing");
    requireCheckpoint(!registered.has(id), "Duplicate registered database");
    requireCheckpoint(
      page!.kind === "database",
      "Registered owner is not a database",
    );
    requireCheckpoint(
      page!.documentError === undefined,
      "Registered owner is unreadable",
    );
    requireCheckpoint(
      page!.database !== null && page!.database.rows.length === 0,
      "Registered database still contains legacy rows",
    );
    registered.add(id);
  }

  const members = new Map<string, string>();
  const memberValues = new Map<string, unknown>();
  for (const row of tables.record_memberships) {
    const pageId = row[0] as string,
      databasePageId = row[1] as string,
      values = parseRecordValues(row[3] as string),
      page = pages.get(pageId);
    requireCheckpoint(!members.has(pageId), "Duplicate record membership");
    requireCheckpoint(!!page, "Record Page is missing");
    requireCheckpoint(
      registered.has(databasePageId),
      "Record owner is not registered",
    );
    requireCheckpoint(pageId !== databasePageId, "Record cannot own itself");
    requireCheckpoint(page!.kind === "page", "Record is not a Page");
    requireCheckpoint(
      page!.database == null,
      "Record has a database definition",
    );
    requireCheckpoint(page!.parentId === null, "Record has a parent Page");
    requireCheckpoint(
      page!.documentError === undefined,
      "Record is unreadable",
    );
    members.set(pageId, databasePageId);
    memberValues.set(pageId, values);
  }

  // Record rows and registered databases are fixed anchors. The ordinary
  // create/move paths reject children under them; a checkpoint must not
  // introduce a hierarchy those paths could never edit safely.
  for (const page of pages.values()) {
    if (page.parentId === null) continue;
    requireCheckpoint(
      !members.has(page.parentId) && !registered.has(page.parentId),
      "Record or registered database has a child Page",
    );
  }

  const valueVersions = new Map<number, unknown>();
  for (const row of tables.record_value_versions) {
    const versionId = row[0] as number,
      values = parseRecordValues(row[1] as string),
      version = versions.get(versionId);
    requireCheckpoint(
      !valueVersions.has(versionId),
      "Duplicate record value version",
    );
    requireCheckpoint(!!version, "Record value version is missing");
    requireCheckpoint(
      members.has(version!.pageId),
      "Record value history belongs to a non-record",
    );
    valueVersions.set(versionId, values);
  }
  for (const [id, version] of versions) {
    if (!members.has(version.pageId)) continue;
    requireCheckpoint(
      valueVersions.has(id),
      "Record version is missing its values",
    );
  }

  const trashBatches = new Map<
    string,
    { revision: number; deletedAt: number }
  >();
  for (const row of tables.record_database_trash_batches) {
    const id = row[0] as string,
      revision = row[1] as number,
      deletedAt = row[2] as number,
      owner = pages.get(id);
    requireCheckpoint(!trashBatches.has(id), "Duplicate database trash batch");
    requireCheckpoint(
      registered.has(id),
      "Trash batch owner is not registered",
    );
    requireCheckpoint(!!owner, "Trash batch owner is missing");
    requireCheckpoint(
      owner!.deletedAt !== null,
      "Trash batch owner is not deleted",
    );
    requireCheckpoint(
      owner!.deletedAt === deletedAt && owner!.revision === revision,
      "Trash batch does not match its owner",
    );
    trashBatches.set(id, { revision, deletedAt });
  }
  for (const id of registered) {
    const owner = pages.get(id)!;
    requireCheckpoint(
      owner.deletedAt === null || trashBatches.has(id),
      "Deleted database is missing its trash batch",
    );
  }
  for (const row of tables.record_database_trash_members) {
    const databasePageId = row[0] as string,
      pageId = row[1] as string,
      revision = row[2] as number,
      batch = trashBatches.get(databasePageId),
      page = pages.get(pageId);
    requireCheckpoint(!!batch, "Trash member has no batch");
    requireCheckpoint(!!page, "Trash member Page is missing");
    requireCheckpoint(
      members.get(pageId) === databasePageId,
      "Trash member has a different owner",
    );
    requireCheckpoint(
      page!.deletedAt === batch!.deletedAt && page!.revision === revision,
      "Trash member does not match its Page",
    );
  }

  const archivedOwners = new Set<string>();
  for (const row of tables.legacy_database_archive) {
    const databasePageId = row[0] as string,
      data = row[1] as string,
      page = pages.get(databasePageId);
    requireCheckpoint(
      registered.has(databasePageId),
      "Legacy archive owner is not registered",
    );
    requireCheckpoint(
      !!page && page.kind === "database",
      "Legacy archive owner is not a database",
    );
    const archived = parsePageData(databasePageId, data);
    requireCheckpoint(
      archived.kind === "database",
      "Legacy archive is not a database",
    );
    archivedOwners.add(databasePageId);
    collectAssetReferences(archived, references);
  }
  for (const row of tables.legacy_database_versions) {
    const versionId = row[0] as number,
      databasePageId = row[1] as string,
      version = versions.get(versionId);
    requireCheckpoint(
      registered.has(databasePageId),
      "Legacy version owner is not registered",
    );
    requireCheckpoint(!!version, "Legacy version is missing");
    requireCheckpoint(
      version!.pageId === databasePageId,
      "Legacy version belongs to another Page",
    );
    requireCheckpoint(
      version!.database !== null &&
        (() => {
          try {
            return JSON.parse(version!.database) !== null;
          } catch {
            return false;
          }
        })(),
      "Legacy version has no database snapshot",
    );
    requireCheckpoint(
      tables.legacy_database_archive.some(
        (archive) => archive[0] === databasePageId,
      ),
      "Legacy version has no database archive",
    );
  }
  const mappedPageIds = new Set<string>();
  for (const row of tables.legacy_record_map) {
    const databasePageId = row[0] as string,
      legacyRowId = row[1] as string,
      pageId = row[2] as string;
    requireCheckpoint(
      registered.has(databasePageId),
      "Legacy map owner is not registered",
    );
    requireCheckpoint(
      !!legacyRowId && legacyRowId.length <= 500,
      "Invalid legacy row id",
    );
    requireCheckpoint(
      !mappedPageIds.has(pageId),
      "Duplicate legacy Page mapping",
    );
    mappedPageIds.add(pageId);
    const page = pages.get(pageId);
    // A historical reservation may be absent until its archived row is restored.
    requireCheckpoint(
      page
        ? members.get(pageId) === databasePageId
        : archivedOwners.has(databasePageId),
      "Legacy mapped Page has no matching owner or archive",
    );
  }

  for (const page of pages.values()) collectAssetReferences(page, references);
  for (const version of versions.values()) {
    collectAssetReferences(version.doc, references);
    if (version.database !== null)
      collectAssetReferences(JSON.parse(version.database), references);
  }
  for (const values of memberValues.values())
    collectAssetReferences(values, references);
  for (const values of valueVersions.values())
    collectAssetReferences(values, references);
  for (const id of references)
    requireCheckpoint(
      assetsById.has(id),
      "Asset reference has no registry row",
    );

  return parsed;
}

/**
 * Strict checkpoint validator. It returns false rather than throwing so the
 * host can treat foreign input as data. `previous` is the last applied server
 * checkpoint; retained Pages/assets and record ownership may not disappear.
 */
export function validateWorkspaceCheckpoint(
  checkpoint: Checkpoint,
  previous?: Checkpoint | null,
): boolean {
  try {
    const current = inspectCheckpoint(checkpoint);
    if (previous === undefined || previous === null) return true;
    const prior = inspectCheckpoint(previous);
    const currentPages = new Set(
      current.tables.pages.map((row) => row[0] as string),
    );
    for (const row of prior.tables.pages) {
      const id = row[0] as string;
      requireCheckpoint(currentPages.has(id), "Existing Page was omitted");
      const before = parsePageData(id, row[1] as string);
      const afterRow = current.tables.pages.find((entry) => entry[0] === id)!;
      const after = parsePageData(id, afterRow[1] as string);
      requireCheckpoint(before.kind === after.kind, "Page kind changed");
      requireCheckpoint(
        before.createdAt === after.createdAt,
        "Page creation identity changed",
      );
    }
    const currentAssets = new Map(
      current.assets.map((entry) => [entry.id, entry]),
    );
    for (const before of prior.assets) {
      const after = currentAssets.get(before.id);
      requireCheckpoint(!!after, "Existing asset was omitted");
      requireCheckpoint(
        after!.sha256 === before.sha256 && after!.bytes === before.bytes,
        "Existing asset bytes or hash changed",
      );
    }
    const priorMembers = new Map(
      prior.tables.record_memberships.map((row) => [
        row[0] as string,
        row[1] as string,
      ]),
    );
    const currentMembers = new Map(
      current.tables.record_memberships.map((row) => [
        row[0] as string,
        row[1] as string,
      ]),
    );
    for (const [pageId, databasePageId] of priorMembers)
      requireCheckpoint(
        currentMembers.get(pageId) === databasePageId,
        "Existing record ownership changed or was omitted",
      );
    const currentRegistered = new Set(
      current.tables.record_databases.map((row) => row[0] as string),
    );
    for (const row of prior.tables.record_databases)
      requireCheckpoint(
        currentRegistered.has(row[0] as string),
        "Existing registered database was omitted",
      );

    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Durable version-5 schema                                                    */
/* -------------------------------------------------------------------------- */

type ColumnShape = {
  name: string;
  type: string;
  notnull: number;
  pk: number;
};

const CONTENT_SCHEMA: Record<string, readonly ColumnShape[]> = {
  pages: [
    { name: "id", type: "TEXT", notnull: 0, pk: 1 },
    { name: "data", type: "TEXT", notnull: 1, pk: 0 },
    { name: "body", type: "TEXT", notnull: 1, pk: 0 },
  ],
  versions: [
    { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "pageId", type: "TEXT", notnull: 1, pk: 0 },
    { name: "createdAt", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "title", type: "TEXT", notnull: 1, pk: 0 },
    { name: "doc", type: "TEXT", notnull: 1, pk: 0 },
    { name: "database", type: "TEXT", notnull: 0, pk: 0 },
  ],
  assets: [
    { name: "id", type: "TEXT", notnull: 0, pk: 1 },
    { name: "metadata", type: "TEXT", notnull: 1, pk: 0 },
  ],
  record_databases: [
    { name: "database_page_id", type: "TEXT", notnull: 0, pk: 1 },
  ],
  record_memberships: [
    { name: "page_id", type: "TEXT", notnull: 0, pk: 1 },
    { name: "database_page_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "position", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "values_json", type: "TEXT", notnull: 1, pk: 0 },
  ],
  record_value_versions: [
    { name: "version_id", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "values_json", type: "TEXT", notnull: 1, pk: 0 },
  ],
  record_database_trash_batches: [
    { name: "database_page_id", type: "TEXT", notnull: 0, pk: 1 },
    { name: "deleted_revision", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "deleted_at", type: "INTEGER", notnull: 1, pk: 0 },
  ],
  record_database_trash_members: [
    { name: "database_page_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "page_id", type: "TEXT", notnull: 1, pk: 2 },
    { name: "deleted_revision", type: "INTEGER", notnull: 1, pk: 0 },
  ],
  legacy_database_archive: [
    { name: "database_page_id", type: "TEXT", notnull: 0, pk: 1 },
    { name: "data", type: "TEXT", notnull: 1, pk: 0 },
  ],
  legacy_database_versions: [
    { name: "version_id", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "database_page_id", type: "TEXT", notnull: 1, pk: 0 },
  ],
  legacy_record_map: [
    { name: "database_page_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "legacy_row_id", type: "TEXT", notnull: 1, pk: 2 },
    { name: "page_id", type: "TEXT", notnull: 1, pk: 0 },
  ],
};

const SYNC_SCHEMA: Record<string, readonly ColumnShape[]> = {
  workspace_sync_state: [
    { name: "singleton", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "schema_version", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "workspace_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "client_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "binding_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "server_epoch", type: "TEXT", notnull: 1, pk: 0 },
    { name: "generation", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "clean_generation", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "applied_revision", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "received_cursor", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "suppress_triggers", type: "INTEGER", notnull: 1, pk: 0 },
  ],
  workspace_sync_outbox: [
    { name: "operation_id", type: "TEXT", notnull: 0, pk: 1 },
    { name: "fingerprint", type: "TEXT", notnull: 1, pk: 0 },
    { name: "generation", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "commit_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "result_json", type: "TEXT", notnull: 0, pk: 0 },
  ],
  workspace_sync_inbox: [
    { name: "revision", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "change_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "skip_apply", type: "INTEGER", notnull: 1, pk: 0 },
  ],
  workspace_sync_conflicts: [
    { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "operation_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "local_commit_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "remote_result_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "local_generation", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "local_checkpoint_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "chosen", type: "TEXT", notnull: 0, pk: 0 },
    { name: "chosen_at", type: "INTEGER", notnull: 0, pk: 0 },
  ],
  workspace_sync_archives: [
    { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "operation_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "kind", type: "TEXT", notnull: 1, pk: 0 },
    { name: "checkpoint_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "created_at", type: "INTEGER", notnull: 1, pk: 0 },
  ],
  workspace_sync_applied: [
    { name: "singleton", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "revision", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "checkpoint_json", type: "TEXT", notnull: 1, pk: 0 },
  ],
};

const TRIGGER_OPERATIONS = ["insert", "update", "delete"] as const;

function assertTableShape(
  db: DatabaseSync,
  name: string,
  expected: readonly ColumnShape[],
): void {
  const actual = db.prepare(`PRAGMA table_xinfo("${name}")`).all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
    hidden: number;
  }[];
  requireCheckpoint(
    actual.length === expected.length,
    `Incomplete ${name} table`,
  );
  for (const [index, column] of expected.entries()) {
    const found = actual[index];
    requireCheckpoint(
      found.name === column.name &&
        found.type.toUpperCase() === column.type &&
        found.notnull === column.notnull &&
        found.pk === column.pk &&
        found.hidden === 0 &&
        found.dflt_value === null,
      `Incomplete ${name} table`,
    );
  }
}

const guardedTables = [
  ...WORKSPACE_CONTENT_TABLES,
  "settings",
  "save_receipts",
  "folio_record_schema",
] as const;

export function registerWorkspaceWriteGuard(db: DatabaseSync): void {
  // SQLite resolves this function on each writer's connection. An already
  // running older Store has no function and its DML fails before it can write.
  db.function("folio_sync_v5_write", () => 1);
}

function triggerDefinitions() {
  return guardedTables.flatMap((table, index) =>
    TRIGGER_OPERATIONS.map((operation) => {
      const name = `workspace_sync_${table}_${operation}`;
      const recordGeneration =
        index < WORKSPACE_CONTENT_TABLES.length
          ? " UPDATE workspace_sync_state SET generation=generation+1 WHERE singleton=1 AND suppress_triggers=0;"
          : "";
      return [
        name,
        `CREATE TRIGGER "${name}" AFTER ${operation.toUpperCase()} ON "${table}" BEGIN SELECT folio_sync_v5_write();${recordGeneration} END`,
      ] as const;
    }),
  );
}

export function installWorkspaceSyncTriggers(db: DatabaseSync): void {
  registerWorkspaceWriteGuard(db);
  for (const [, sql] of triggerDefinitions()) db.exec(sql);
}

function assertKnownWorkspaceTables(db: DatabaseSync): void {
  const allowed = new Set([
    ...Object.keys(CONTENT_SCHEMA),
    ...Object.keys(SYNC_SCHEMA),
    "settings",
    "save_receipts",
    "folio_record_schema",
    "sqlite_sequence",
    "crash_recovery_copies",
  ]);
  for (const row of db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .iterate())
    requireCheckpoint(
      typeof row.name === "string" && allowed.has(row.name),
      "Unknown workspace table",
    );
}

function assertTriggerCoverage(db: DatabaseSync): void {
  const expected = new Map(triggerDefinitions());
  for (const row of db
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'")
    .iterate()) {
    const name = String(row.name);
    requireCheckpoint(
      expected.get(name) === row.sql,
      `Unknown or invalid ${name} trigger`,
    );
    expected.delete(name);
  }
  requireCheckpoint(expected.size === 0, "Workspace sync trigger is missing");
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
  );
}

function readInteger(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  requireCheckpoint(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    `Invalid ${key}`,
  );
  return value;
}

/**
 * Verify the complete version-5 durable structure before a writable or
 * read-only Store is exposed. A malformed or partially promoted workspace is
 * never treated as a normal v4 store.
 */
export function validateWorkspaceSyncSchema(db: DatabaseSync): void {
  try {
    assertKnownWorkspaceTables(db);
    for (const [name, columns] of Object.entries(CONTENT_SCHEMA))
      assertTableShape(db, name, columns);
    for (const [name, columns] of Object.entries(SYNC_SCHEMA))
      assertTableShape(db, name, columns);

    const states = db
      .prepare("SELECT * FROM workspace_sync_state")
      .all() as Record<string, unknown>[];
    requireCheckpoint(states.length === 1, "Missing sync identity");
    const state = states[0];
    requireCheckpoint(state.singleton === 1, "Invalid sync identity slot");
    requireCheckpoint(
      state.schema_version === WORKSPACE_SYNC_SCHEMA_VERSION,
      "Unsupported sync schema version",
    );
    requireCheckpoint(isIdentifier(state.workspace_id), "Invalid workspace id");
    requireCheckpoint(isIdentifier(state.client_id), "Invalid client id");
    requireCheckpoint(isIdentifier(state.binding_id), "Invalid binding id");
    requireCheckpoint(isIdentifier(state.server_epoch), "Invalid server epoch");
    const generation = readInteger(state, "generation"),
      cleanGeneration = readInteger(state, "clean_generation"),
      appliedRevision = readInteger(state, "applied_revision"),
      receivedCursor = readInteger(state, "received_cursor");
    requireCheckpoint(
      cleanGeneration <= generation,
      "Clean generation is ahead of the local generation",
    );
    requireCheckpoint(
      state.suppress_triggers === 0,
      "Trigger suppression was left enabled",
    );

    const outbox = db
      .prepare("SELECT * FROM workspace_sync_outbox")
      .all() as Record<string, unknown>[];
    let pending = 0;
    for (const row of outbox) {
      requireCheckpoint(
        isIdentifier(row.operation_id),
        "Invalid outbox operation",
      );
      requireCheckpoint(
        typeof row.fingerprint === "string" &&
          /^[a-f0-9]{64}$/.test(row.fingerprint),
        "Invalid outbox fingerprint",
      );
      readInteger(row, "generation");
      requireCheckpoint(
        typeof row.commit_json === "string" &&
          typeof row.result_json !== "undefined",
        "Invalid outbox row",
      );
      if (row.result_json === null) pending++;
      else
        requireCheckpoint(
          typeof row.result_json === "string",
          "Invalid outbox result",
        );
    }
    requireCheckpoint(pending <= 1, "Multiple pending outbox operations");

    const inbox = db
      .prepare(
        "SELECT count(*) AS count,min(revision) AS minimum,max(revision) AS maximum FROM workspace_sync_inbox",
      )
      .get() as Record<string, unknown>;
    const count = readInteger(inbox, "count"),
      minimum = inbox.minimum,
      maximum = inbox.maximum;
    requireCheckpoint(
      count === receivedCursor &&
        (count === 0
          ? minimum === null && maximum === null
          : minimum === 1 && maximum === receivedCursor),
      "Incomplete inbox",
    );
    for (const row of db
      .prepare("SELECT * FROM workspace_sync_inbox")
      .all() as Record<string, unknown>[]) {
      requireCheckpoint(
        typeof row.change_json === "string",
        "Invalid inbox change",
      );
      requireCheckpoint(
        row.skip_apply === 0 || row.skip_apply === 1,
        "Invalid inbox skip flag",
      );
    }

    const applied = db
      .prepare("SELECT * FROM workspace_sync_applied")
      .all() as Record<string, unknown>[];
    if (appliedRevision === 0)
      requireCheckpoint(applied.length === 0, "Unexpected applied checkpoint");
    else {
      requireCheckpoint(applied.length === 1, "Missing applied checkpoint");
      requireCheckpoint(applied[0].singleton === 1, "Invalid applied slot");
      requireCheckpoint(
        readInteger(applied[0], "revision") === appliedRevision,
        "Applied checkpoint revision mismatch",
      );
      requireCheckpoint(
        typeof applied[0].checkpoint_json === "string",
        "Invalid applied checkpoint",
      );
      let checkpoint: unknown;
      try {
        checkpoint = JSON.parse(applied[0].checkpoint_json);
      } catch {
        throw new CheckpointError("Invalid applied checkpoint JSON");
      }
      requireCheckpoint(
        validateWorkspaceCheckpoint(checkpoint as Checkpoint),
        "Invalid applied checkpoint",
      );
    }

    const conflicts = db
      .prepare("SELECT * FROM workspace_sync_conflicts")
      .all() as Record<string, unknown>[];
    let unresolved = 0;
    for (const row of conflicts) {
      requireCheckpoint(
        typeof row.local_commit_json === "string",
        "Invalid conflict",
      );
      requireCheckpoint(
        typeof row.remote_result_json === "string",
        "Invalid conflict",
      );
      requireCheckpoint(
        readInteger(row, "local_generation") <= generation,
        "Invalid conflict generation",
      );
      requireCheckpoint(
        typeof row.local_checkpoint_json === "string",
        "Invalid conflict checkpoint",
      );
      requireCheckpoint(
        row.chosen === null ||
          row.chosen === "local" ||
          row.chosen === "remote",
        "Invalid conflict choice",
      );
      if (row.chosen === null) unresolved++;
    }
    requireCheckpoint(unresolved <= 1, "Multiple unresolved conflicts");

    for (const row of db
      .prepare("SELECT * FROM workspace_sync_archives")
      .all() as Record<string, unknown>[]) {
      requireCheckpoint(
        isIdentifier(row.operation_id),
        "Invalid archive operation",
      );
      requireCheckpoint(
        typeof row.kind === "string" && !!row.kind,
        "Invalid archive kind",
      );
      requireCheckpoint(
        typeof row.checkpoint_json === "string",
        "Invalid archive checkpoint",
      );
      readInteger(row, "created_at");
    }
    assertTriggerCoverage(db);
  } catch (error) {
    if (
      error instanceof Error &&
      /requires a newer Folio version/.test(error.message)
    )
      throw error;
    throw new Error(
      "This workspace requires a newer Folio version. Incomplete or unsupported workspace sync schema" +
        (error instanceof Error ? `: ${error.message}` : ""),
    );
  }
}
