import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats,
} from "node:fs";
import { canonical } from "../collaboration/runtime/canonical";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseAssetURL } from "../shared/assets";
import { isDocument, type Doc } from "../shared/types";
import {
  CollaborationError,
  demand,
  identifier,
  safeCounter,
  wellFormed,
} from "../collaboration/runtime/contract";
import {
  normalizeCopyProperties,
  normalizeCopyValues,
  normalizeTypedCopyValues,
  type SharedCopySource,
  type SharedCopyMetadata,
} from "../collaboration/runtime/copy";
import type { Store } from "../persistence/store";

const HASH = /^[a-f0-9]{64}$/;
const MAX_ASSET_BYTES = 20_000_000;

type AssetMetadata = {
  id: string;
  storageName: string;
  size: number;
  sha256: string;
};

type AssetRow = { metadata: string };

function fail(code: string): never {
  throw new CollaborationError(code);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export type CopyFilesystemProof = {
  file(path: string): {canonicalPath: string; fileId: string; volumeId: string};
  directory(path: string): void;
};
function privateFile(info: Stats, native: boolean): boolean {
  const uid = process.getuid?.();
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 &&
    (native || (process.platform !== "win32" && (info.mode & 0o077) === 0 && typeof uid === "number" && info.uid === uid));
}

function readMetadata(db: DatabaseSync, id: string): AssetMetadata {
  const row = db.prepare("SELECT metadata FROM assets WHERE id=?").get(id) as
    AssetRow | undefined;
  if (!row) fail("ASSET_NOT_FOUND");
  let value: unknown;
  try {
    value = JSON.parse(row.metadata);
  } catch {
    return fail("CORRUPT_ASSET_META");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("CORRUPT_ASSET_META");
  const metadata = value as Record<string, unknown>;
  if (metadata.id !== id || metadata.storageName !== id)
    return fail("CORRUPT_ASSET_META");
  if (typeof metadata.sha256 !== "string" || !HASH.test(metadata.sha256))
    return fail("CORRUPT_ASSET_META");
  const size = safeCounter(metadata.size);
  if (size > MAX_ASSET_BYTES) fail("ASSET_TOO_LARGE");
  return {
    id,
    storageName: id,
    size,
    sha256: metadata.sha256,
  };
}

function readVerifiedAsset(
  db: DatabaseSync,
  assetsDirectory: string,
  id: string,
  proof?: CopyFilesystemProof,
): Uint8Array {
  const metadata = readMetadata(db, id);
  const path = join(assetsDirectory, id);
  let before: Stats;
  try {
    before = lstatSync(path);
  } catch {
    return fail("ASSET_FILE_MISSING");
  }
  const native = proof?.file(path);
  if (!privateFile(before, !!native)) fail("UNSAFE_ASSET_FILE");

  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!privateFile(opened, !!native) || !sameIdentity(before, opened))
      fail("UNSAFE_ASSET_FILE");
    if (opened.size !== metadata.size) fail("ASSET_SIZE_MISMATCH");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      !privateFile(after, !!native) ||
      !sameIdentity(opened, after) ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      fail("UNSAFE_ASSET_FILE");
    if (native && canonical(proof!.file(path)) !== canonical(native)) fail("UNSAFE_ASSET_FILE");
    if (bytes.byteLength !== metadata.size) fail("ASSET_SIZE_MISMATCH");
    if (sha256(bytes) !== metadata.sha256) fail("ASSET_HASH_MISMATCH");
    return new Uint8Array(bytes);
  } finally {
    closeSync(descriptor);
  }
}

function checkAssetsDirectory(assetsDirectory: string, proof?: CopyFilesystemProof): void {
  demand(
    typeof assetsDirectory === "string" && assetsDirectory.length > 0,
    "INVALID_ASSETS_DIRECTORY",
  );
  proof?.directory(assetsDirectory);
  if (process.platform === "win32" && !proof) fail("WINDOWS_ASSET_PROOF_REQUIRED");
  let info: Stats;
  try {
    info = lstatSync(assetsDirectory);
  } catch {
    return fail("ASSETS_DIRECTORY_MISSING");
  }
  if (!info.isDirectory() || info.isSymbolicLink())
    fail("UNSAFE_ASSETS_DIRECTORY");
}

function collectReference(value: unknown, into: Set<string>): void {
  const stack: unknown[] = [value];
  let count = 0;
  while (stack.length) {
    demand(++count <= 100_000, "COPY_SOURCE_TOO_LARGE");
    const item = stack.pop();
    if (typeof item === "string") {
      if (!item.startsWith("folio-asset://")) continue;
      const id = parseAssetURL(item);
      if (id === null) fail("INVALID_ASSET_URL");
      into.add(id);
    } else if (Array.isArray(item)) {
      stack.push(...item);
    } else if (item !== null && typeof item === "object") {
      stack.push(...Object.values(item));
    }
  }
}

function rewriteString(
  value: string,
  mapping: ReadonlyMap<string, string>,
): string {
  if (!value.startsWith("folio-asset://")) return value;
  const id = parseAssetURL(value);
  if (id === null) return fail("INVALID_ASSET_URL");
  return `folio-asset://${mapping.get(id)}`;
}

function rewriteValue(
  value: unknown,
  mapping: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === "string") return rewriteString(value, mapping);
  if (Array.isArray(value))
    return value.map((item) => rewriteValue(item, mapping));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value))
      result[key] = rewriteValue(item, mapping);
    return result;
  }
  return value;
}

function rewriteAttributes(
  attrs: Record<string, unknown>,
  mapping: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs))
    result[key] = rewriteValue(value, mapping);
  return result;
}

function rewriteDocument(
  document: Doc,
  mapping: ReadonlyMap<string, string>,
): Doc {
  const next: Doc = { ...document };
  if (document.attrs) next.attrs = rewriteAttributes(document.attrs, mapping);
  if (document.marks)
    next.marks = document.marks.map((mark) => ({
      ...mark,
      ...(mark.attrs ? { attrs: rewriteAttributes(mark.attrs, mapping) } : {}),
    }));
  if (document.content)
    next.content = document.content.map((node) =>
      rewriteDocument(node, mapping),
    );
  return next;
}

function assertNotRecord(db: DatabaseSync, id: string): void {
  const table = (name: string) =>
    !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name);
  if (
    table("record_memberships") &&
    db.prepare("SELECT 1 FROM record_memberships WHERE page_id=?").get(id)
  )
    fail("COPY_SOURCE_RECORD");
  if (
    table("record_databases") &&
    db
      .prepare("SELECT 1 FROM record_databases WHERE database_page_id=?")
      .get(id)
  )
    fail("COPY_SOURCE_RECORD");
}

function readPage(
  db: DatabaseSync,
  id: string,
): {
  parentId: string | null;
  title: string;
  document: Doc;
} {
  const row = db.prepare("SELECT data FROM pages WHERE id=?").get(id) as
    { data: string } | undefined;
  if (!row) fail("COPY_SOURCE_MISSING");
  let page: unknown;
  try {
    page = JSON.parse(row.data);
  } catch {
    return fail("COPY_SOURCE_UNREADABLE");
  }
  if (!page || typeof page !== "object" || Array.isArray(page))
    return fail("COPY_SOURCE_UNREADABLE");
  const value = page as Record<string, unknown>;
  if (value.id !== id) fail("COPY_SOURCE_UNREADABLE");
  if (value.deletedAt !== null) fail("COPY_SOURCE_DELETED");
  if (value.documentError !== undefined) fail("COPY_SOURCE_DOCUMENT_ERROR");
  if (value.kind !== "page") fail("COPY_SOURCE_RECORD");
  if (value.database !== null && value.database !== undefined)
    fail("COPY_SOURCE_RECORD");
  if (
    typeof value.title !== "string" ||
    value.title.length > 500 ||
    !wellFormed(value.title)
  )
    fail("INVALID_SOURCE_TITLE");
  const parentId = value.parentId === null ? null : identifier(value.parentId);
  if (!isDocument(value.doc)) fail("UNSUPPORTED_DOCUMENT");
  assertNotRecord(db, id);
  return {
    parentId,
    title: value.title,
    document: value.doc,
  };
}

function referencesIn(document: Doc, into: Set<string>): void {
  const stack: Doc[] = [document];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.attrs) collectReference(node.attrs, into);
    for (const mark of node.marks ?? [])
      if (mark.attrs) collectReference(mark.attrs, into);
    stack.push(...(node.content ?? []));
  }
}

type SelectedPage = {
  parentId: string | null;
  title: string;
  document: Doc;
  kind: unknown;
  database: unknown;
};

function readSelectedPage(db: DatabaseSync, id: string): SelectedPage {
  const row = db.prepare("SELECT data FROM pages WHERE id=?").get(id) as
    { data: string } | undefined;
  if (!row) fail("COPY_SOURCE_MISSING");
  let page: unknown;
  try {
    page = JSON.parse(row.data);
  } catch {
    return fail("COPY_SOURCE_UNREADABLE");
  }
  if (!page || typeof page !== "object" || Array.isArray(page))
    return fail("COPY_SOURCE_UNREADABLE");
  const value = page as Record<string, unknown>;
  if (value.id !== id) fail("COPY_SOURCE_UNREADABLE");
  if (value.deletedAt !== null) fail("COPY_SOURCE_DELETED");
  if (value.documentError !== undefined) fail("COPY_SOURCE_DOCUMENT_ERROR");
  if (value.kind !== "page" && value.kind !== "database")
    return fail("COPY_SOURCE_UNREADABLE");
  if (
    typeof value.title !== "string" ||
    value.title.length > 500 ||
    !wellFormed(value.title)
  )
    fail("INVALID_SOURCE_TITLE");
  const parentId = value.parentId === null ? null : identifier(value.parentId);
  if (!isDocument(value.doc)) fail("UNSUPPORTED_DOCUMENT");
  return {
    parentId,
    title: value.title,
    document: value.doc,
    kind: value.kind,
    database: value.database,
  };
}

type MembershipRow = {
  database_page_id: string;
  position: number;
  values_json: string;
};

function readMembership(db: DatabaseSync, id: string): MembershipRow | null {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_memberships'")
    .get();
  if (!table) return null;
  try {
  return (
    (db
      .prepare(
        "SELECT database_page_id,position,values_json FROM record_memberships WHERE page_id=?",
      )
      .get(id) as MembershipRow | undefined) ?? null
  );
  } catch (error) {
    if (error instanceof Error && /no such (column|table)/.test(error.message)) fail("COPY_SOURCE_RECORD");
    throw error;
  }
}

function registeredDatabase(db: DatabaseSync, id: string): boolean {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_databases'")
    .get();
  if (!table) return false;
  return !!db
    .prepare("SELECT 1 FROM record_databases WHERE database_page_id=?")
    .get(id);
}

function databaseMetadata(
  db: DatabaseSync,
  id: string,
  page: SelectedPage,
): SharedCopyMetadata {
  if (page.kind !== "database") fail("COPY_SOURCE_RECORD");
  const database = page.database;
  if (!database || typeof database !== "object" || Array.isArray(database))
    fail("COPY_SOURCE_DATABASE");
  const value = database as Record<string, unknown>;
  if (!Array.isArray(value.rows) || value.rows.length !== 0)
    fail("COPY_SOURCE_DATABASE_ROWS");
  if (!registeredDatabase(db, id)) fail("COPY_SOURCE_DATABASE");
  return { kind: "database", properties: normalizeCopyProperties(value.properties) };
}

function membershipValues(row: MembershipRow): Record<string, string | number | boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.values_json);
  } catch {
    return fail("COPY_SOURCE_RECORD_VALUES");
  }
  return normalizeCopyValues(parsed);
}

/** Read only the selected Page rows and their referenced asset bytes.
 * The private Store is never written and unselected bodies are never read. */
function readPrivateCopySourcesAtSnapshot(
  store: Store,
  assetsDirectory: string,
  ids: string[],
  proof?: CopyFilesystemProof,
): SharedCopySource[] {
  demand(store !== null && typeof store === "object", "INVALID_STORE");
  checkAssetsDirectory(assetsDirectory, proof);
  const db = store.db;
  const selected = ids.map((id) => identifier(id));
  demand(new Set(selected).size === selected.length, "DUPLICATE_SELECTED_ID");
  const positionById = new Map(selected.map((id, index) => [id, index]));

  const pages = new Map<string, SelectedPage>();
  const memberships = new Map<string, MembershipRow>();
  const metadata = new Map<string, SharedCopyMetadata>();

  for (const id of selected) {
    const page = readSelectedPage(db, id);
    const membership = readMembership(db, id);
    if (membership !== null) {
      if (page.kind !== "page" || page.database !== null)
        fail("COPY_SOURCE_RECORD");
      const databaseId = identifier(membership.database_page_id);
      const databaseIndex = positionById.get(databaseId);
      demand(
        databaseIndex !== undefined,
        "COPY_SOURCE_RECORD_OUTSIDE_SELECTION",
      );
      pages.set(id, page);
      memberships.set(id, membership);
    } else if (page.kind === "database") {
      pages.set(id, page);
      metadata.set(id, databaseMetadata(db, id, page));
    } else if (page.kind === "page" && page.database === null) {
      pages.set(id, page);
    } else {
      fail("COPY_SOURCE_RECORD");
    }
  }

  return selected.map((id) => {
    const page = pages.get(id)!;
    const membership = memberships.get(id);
    let sourceMetadata: SharedCopyMetadata | undefined = metadata.get(id);
    if (membership !== undefined) {
      const databaseId = identifier(membership.database_page_id);
      const owner = metadata.get(databaseId);
      if (owner === undefined || owner.kind !== "database")
        fail("COPY_SOURCE_RECORD_OUTSIDE_SELECTION");
      const position = safeCounter(membership.position);
      const values = normalizeTypedCopyValues(
        membershipValues(membership),
        owner.properties,
      );
      sourceMetadata = {
        kind: "record",
        databaseId,
        position,
        values,
      };
    }

    const references = new Set<string>();
    referencesIn(page.document, references);
    const ordered = [...references].sort();
    const mapping = new Map<string, string>();
    const assets: { hash: string; bytes: Uint8Array }[] = [];
    for (const assetId of ordered) {
      const bytes = readVerifiedAsset(db, assetsDirectory, assetId, proof);
      const hash = sha256(bytes);
      mapping.set(assetId, hash);
      assets.push({ hash, bytes });
    }
    const raw = JSON.stringify(rewriteDocument(page.document, mapping));
    return {
      id,
      parentId: page.parentId,
      title: page.title,
      raw,
      assets,
      ...(sourceMetadata === undefined ? {} : { metadata: sourceMetadata }),
    };
  });
}

/** One private SQLite read snapshot, plus independently pinned asset reads. */
export function readPrivateCopySources(
  store: Store,
  assetsDirectory: string,
  ids: string[],
  proof?: CopyFilesystemProof,
): SharedCopySource[] {
  if (store.db.isTransaction)
    return readPrivateCopySourcesAtSnapshot(store, assetsDirectory, ids, proof);
  store.db.exec("BEGIN DEFERRED");
  try {
    const result = readPrivateCopySourcesAtSnapshot(
      store,
      assetsDirectory,
      ids,
      proof,
    );
    store.db.exec("COMMIT");
    return result;
  } catch (error) {
    if (store.db.isTransaction) store.db.exec("ROLLBACK");
    throw error;
  }
}

/** Metadata-only picker. Bodies and asset bytes are read only after selection. */
export function readPrivateCopyCatalog(store: Store): {id: string; title: string; kind: "page" | "database" | "record"}[] {
  const tables = new Set(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
  const databases = tables.has("record_databases") ? new Set(store.db.prepare("SELECT database_page_id FROM record_databases").all().map(row => String(row.database_page_id))) : new Set<string>();
  const records = tables.has("record_memberships") ? new Set(store.db.prepare("SELECT page_id FROM record_memberships").all().map(row => String(row.page_id))) : new Set<string>();
  const rows = store.db.prepare("SELECT id,CASE WHEN json_valid(data) THEN json_extract(data,'$.title') ELSE NULL END AS title,CASE WHEN json_valid(data) THEN json_extract(data,'$.deletedAt') ELSE 1 END AS deleted FROM pages ORDER BY id LIMIT 10001").all();
  demand(rows.length <= 10000, "COPY_CATALOG_CAPACITY");
  return rows.filter(row => row.deleted === null).map(row => ({id: identifier(row.id), title: typeof row.title === "string" ? row.title : "読めないページ", kind: databases.has(String(row.id)) ? "database" : records.has(String(row.id)) ? "record" : "page"}));
}
