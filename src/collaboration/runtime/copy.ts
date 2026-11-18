import { createHash } from "node:crypto";
import { BLOCK_TYPES } from "../../editor/block-identity";
import type { Doc, Property } from "../../shared/types";
import { inspectSharedDocument } from "../document-input";
import { canonical } from "./canonical";
import {
  CollaborationError,
  demand,
  identifier,
  safeCounter,
  scopeKey,
  wellFormed,
  type Cut,
  type Json,
  type Scope,
} from "./contract";
import { derivedId } from "./digest";
import { initialState } from "./document";
import { applyRecords } from "./records";
import { seedTables } from "./table-commands";
import type { StoragePort } from "./storage-port";

export type CopyProperty = Property;
export type CopyScalar = string | number | boolean;

export type SharedCopyDatabaseMetadata = {
  kind: "database";
  properties: CopyProperty[];
};

export type SharedCopyRecordMetadata = {
  kind: "record";
  databaseId: string;
  position: number;
  values: Record<string, CopyScalar>;
};

/** Optional metadata distinguishes an ordinary Page source from a registered
 * database or an explicitly selected record. */
export type SharedCopyMetadata =
  | SharedCopyDatabaseMetadata
  | SharedCopyRecordMetadata;

export type SharedCopySource = {
  id: string;
  parentId: string | null;
  title?: string;
  raw: string;
  assets: { hash: string; bytes: Uint8Array }[];
  metadata?: SharedCopyMetadata;
};

export type CopyDatabase = {
  sourceId: string;
  properties: CopyProperty[];
};

export type CopyRecord = {
  sourceId: string;
  databaseSourceId: string;
  databaseId: string;
  position: number;
  title: string;
  values: Record<string, CopyScalar>;
};

export type CopyTarget = { orgId: string; workspaceId: string };

export type CopyWarning = {
  code: "EXTERNAL_PRIVATE_PAGE_LINK";
  sourceId: string;
  pageId: string;
  targetId: string;
  targetPageId: string;
  href: string;
};

export type CopySourceHash = { sourceId: string; hash: string };

export type CopyDocument = {
  sourceId: string;
  sourceRaw: string;
  scope: Scope;
  title: string;
  raw: string;
  document: Doc;
};

export type CopyAssetManifest = {
  sourceId: string;
  hash: string;
  bytes: number;
};

export type CopyAsset = { sourceId: string; hash: string; bytes: Uint8Array };

export type CopyPreview = {
  fingerprint: string;
  target: CopyTarget;
  sourceIds: string[];
  sourceHashes: CopySourceHash[];
  sourceHashById: Record<string, string>;
  scopes: Scope[];
  documents: CopyDocument[];
  databases: CopyDatabase[];
  records: CopyRecord[];
  assetManifests: CopyAssetManifest[];
  assets: CopyAsset[];
  warnings: CopyWarning[];
};

export const COPY_DOCUMENTS_NAMESPACE = "documents";
export const COPY_PAGES_NAMESPACE = "pages";
export const COPY_TITLES_NAMESPACE = "page.titles";
export const COPY_LIFECYCLES_NAMESPACE = "doclifecycles";
export const COPY_DATABASES_NAMESPACE = "databases";
export const COPY_RECORDS_NAMESPACE = "records";
export const COPY_ASSETS_NAMESPACE = "asset";
export const MAX_DOCUMENT_BYTES = 2_000_000;
export const MAX_ASSET_BYTES = 20_000_000;
export const MAX_ASSET_SPACE_BYTES = 100 * 1024 * 1024;

const DEFAULT_TITLE = "共有ページ";
const META_NAMESPACE = "meta";
const HEAD_KEY = "head";
const SOURCE_KEYS = new Set([
  "id",
  "parentId",
  "title",
  "raw",
  "assets",
  "metadata",
]);
const ASSET_KEYS = new Set(["hash", "bytes"]);
const DATABASE_METADATA_KEYS = new Set(["kind", "properties"]);
const RECORD_METADATA_KEYS = new Set([
  "kind",
  "databaseId",
  "position",
  "values",
]);
const PROPERTY_KEYS = new Set(["id", "name", "type", "options"]);
const HASH = /^[a-f0-9]{64}$/;

type NormalizedAsset = { hash: string; bytes: Uint8Array; bytesHash: string };
type PreparedSource = {
  source: SharedCopySource;
  document: Doc;
  title: string;
  assets: NormalizedAsset[];
  hash: string;
  scope: Scope;
  metadata: SharedCopyMetadata | null;
};

function fail(code: string): never {
  throw new CollaborationError(code);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function copyDigest(value: unknown): string {
  return createHash("sha256")
    .update(canonical(value, 100_000_000))
    .digest("hex");
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function plainRecord(value: unknown, code: string): Record<string, unknown> {
  demand(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null) &&
      Object.getOwnPropertySymbols(value).length === 0,
    code,
  );
  const names = Object.getOwnPropertyNames(value);
  const keys = Object.keys(value);
  demand(names.length === keys.length, code);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    demand(
      descriptor !== undefined &&
        "value" in descriptor &&
        descriptor.enumerable,
      code,
    );
  }
  return value as Record<string, unknown>;
}

function sourceTitle(value: unknown): string {
  if (value === undefined) return DEFAULT_TITLE;
  if (typeof value !== "string" || value.length > 500 || !wellFormed(value))
    fail("INVALID_TITLE");
  return value;
}

function strictKeys(
  value: unknown,
  allowed: ReadonlySet<string>,
  code: string,
): Record<string, unknown> {
  const record = plainRecord(value, code);
  for (const key of Object.keys(record))
    if (!allowed.has(key)) fail(code);
  return record;
}

function copyText(value: unknown, max: number, code: string): string {
  demand(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= max &&
      wellFormed(value),
    code,
  );
  return value;
}

function copyPropertyName(value: unknown): string {
  const name = copyText(value, 200, "INVALID_PROPERTY_NAME");
  return name;
}

function copyPropertyId(value: unknown): string {
  const id = copyText(value, 500, "INVALID_PROPERTY_ID");
  demand(id !== "__proto__", "INVALID_PROPERTY_ID");
  return id;
}

/** Validates the actual Property model used by Page.database and record values. */
export function normalizeCopyProperties(value: unknown): CopyProperty[] {
  demand(Array.isArray(value), "INVALID_PROPERTIES");
  demand(value.length <= 1000, "INVALID_PROPERTIES");
  const seen = new Set<string>();
  const properties: CopyProperty[] = [];
  for (const raw of value) {
    const item = strictKeys(raw, PROPERTY_KEYS, "INVALID_PROPERTY");
    const id = copyPropertyId(item.id);
    demand(!seen.has(id), "DUPLICATE_PROPERTY_ID");
    seen.add(id);
    const name = copyPropertyName(item.name);
    const type = item.type;
    if (
      type !== "text" &&
      type !== "number" &&
      type !== "select" &&
      type !== "date" &&
      type !== "checkbox"
    )
      fail("INVALID_PROPERTY_TYPE");
    if (type === "select") {
      const rawOptions = item.options;
      if (
        !Array.isArray(rawOptions) ||
        rawOptions.length === 0 ||
        rawOptions.length > 1000
      )
        fail("INVALID_OPTIONS");
      const options: string[] = [];
      for (const option of rawOptions) {
        const text = copyText(option, 200, "INVALID_OPTION");
        demand(!options.includes(text), "INVALID_OPTIONS");
        options.push(text);
      }
      properties.push({ id, name, type, options });
    } else {
      demand(!Object.hasOwn(item, "options"), "INVALID_OPTIONS");
      properties.push({ id, name, type });
    }
  }
  return properties;
}

function copyInteger(value: unknown): number {
  demand(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      !Object.is(value, -0),
    "INVALID_POSITION",
  );
  return value;
}

function copyScalar(value: unknown, code: string): CopyScalar {
  if (typeof value === "string") {
    demand(wellFormed(value), code);
    return value;
  }
  if (typeof value === "boolean") return value;
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    !Object.is(value, -0) &&
    (!Number.isInteger(value) || Number.isSafeInteger(value))
  )
    return value;
  return fail(code);
}

function strictDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return (
    day <=
    [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  );
}

function typedScalar(
  property: CopyProperty,
  value: unknown,
  code: string,
): CopyScalar {
  const scalar = copyScalar(value, code);
  switch (property.type) {
    case "text":
      demand(typeof scalar === "string", code);
      return scalar;
    case "number":
      demand(typeof scalar === "number", code);
      return scalar;
    case "checkbox":
      demand(typeof scalar === "boolean", code);
      return scalar;
    case "date":
      demand(
        typeof scalar === "string" &&
          (scalar === "" || strictDate(scalar)),
        code,
      );
      return scalar;
    case "select":
      demand(
        typeof scalar === "string" &&
          (scalar === "" || property.options?.includes(scalar)),
        code,
      );
      return scalar;
  }
}

/** Raw membership values: scalar shape only; property membership is checked
 * after the owning database has been resolved. */
export function normalizeCopyValues(
  value: unknown,
): Record<string, CopyScalar> {
  const record = plainRecord(value, "INVALID_RECORD_VALUES");
  const entries = Object.entries(record);
  demand(entries.length <= 1000, "INVALID_RECORD_VALUES");
  const values: Record<string, CopyScalar> = {};
  for (const [key, cell] of entries) {
    demand(
      key.length > 0 && key.length <= 500 && key !== "__proto__",
      "INVALID_RECORD_VALUES",
    );
    values[key] = copyScalar(cell, "INVALID_RECORD_VALUES");
  }
  return values;
}

/** Values are trusted only when every key names an actual property and every
 * scalar matches that property's type and options. */
export function normalizeTypedCopyValues(
  value: unknown,
  properties: CopyProperty[],
): Record<string, CopyScalar> {
  const raw = normalizeCopyValues(value);
  const byId = new Map(properties.map((property) => [property.id, property]));
  const values: Record<string, CopyScalar> = {};
  for (const [key, cell] of Object.entries(raw)) {
    const property = byId.get(key);
    demand(property !== undefined, "UNKNOWN_PROPERTY");
    values[key] = typedScalar(property, cell, "INVALID_RECORD_VALUE");
  }
  return values;
}

export function normalizeCopyMetadata(
  value: unknown,
): SharedCopyMetadata | undefined {
  if (value === undefined) return undefined;
  const record = plainRecord(value, "INVALID_SOURCE_METADATA");
  const kind = record.kind;
  if (kind === "database") {
    strictKeys(record, DATABASE_METADATA_KEYS, "INVALID_SOURCE_METADATA");
    return {
      kind,
      properties: normalizeCopyProperties(record.properties),
    };
  }
  if (kind === "record") {
    strictKeys(record, RECORD_METADATA_KEYS, "INVALID_SOURCE_METADATA");
    return {
      kind,
      databaseId: identifier(record.databaseId),
      position: copyInteger(record.position),
      values: normalizeCopyValues(record.values),
    };
  }
  return fail("INVALID_SOURCE_METADATA");
}

function assertSource(input: unknown): SharedCopySource {
  if (input && typeof input === "object" && ["recordOwner", "record", "db", "database"].some(key => Object.hasOwn(input, key))) fail("RECORD_COPY_UNSUPPORTED");
  const source = strictKeys(input, SOURCE_KEYS, "UNKNOWN_SOURCE_FIELD");
  identifier(source.id);
  if (source.parentId !== null) identifier(source.parentId);
  sourceTitle(source.title);
  demand(typeof source.raw === "string", "INVALID_SOURCE_RAW");
  demand(Array.isArray(source.assets), "INVALID_SOURCE_ASSETS");
  normalizeCopyMetadata(source.metadata);
  return input as SharedCopySource;
}

function normalizeAssets(source: SharedCopySource): NormalizedAsset[] {
  const byHash = new Map<string, NormalizedAsset>();
  const assets: NormalizedAsset[] = [];
  for (const input of source.assets) {
    const asset = plainRecord(input, "INVALID_ASSET");
    for (const key of Object.keys(asset))
      if (!ASSET_KEYS.has(key)) fail("INVALID_ASSET");
    const rawHash = asset.hash;
    if (typeof rawHash !== "string" || !HASH.test(rawHash))
      fail("INVALID_ASSET_HASH");
    const hash = rawHash;
    const bytes = asset.bytes;
    demand(bytes instanceof Uint8Array, "INVALID_ASSET_BYTES");
    if (bytes.byteLength > MAX_ASSET_BYTES) fail("ASSET_TOO_LARGE");
    const bytesHash = sha256(bytes);
    if (bytesHash !== hash) fail("ASSET_HASH_MISMATCH");
    const previous = byHash.get(hash);
    if (previous !== undefined) {
      if (previous.bytesHash !== bytesHash) fail("CONFLICTING_ASSET_BYTES");
      continue;
    }
    const normalized = { hash, bytes, bytesHash };
    byHash.set(hash, normalized);
    assets.push(normalized);
  }
  assets.sort((left, right) => left.hash.localeCompare(right.hash));
  return assets;
}

function sourceFingerprint(
  source: SharedCopySource,
  assets: NormalizedAsset[],
): string {
  return copyDigest({
    id: source.id,
    parentId: source.parentId,
    title: source.title ?? DEFAULT_TITLE,
    raw: source.raw,
    assets: assets.map((asset) => ({
      hash: asset.hash,
      bytesHash: asset.bytesHash,
    })),
    metadata: normalizeCopyMetadata(source.metadata) ?? null,
  });
}

function pageTarget(href: string): string | null {
  const match = /^folio-page:\/\/([A-Za-z0-9_-]{1,128})\/?$/.exec(href);
  if (match) return match[1];
  if (/^\s*folio-page:/i.test(href)) fail("INVALID_PAGE_LINK");
  return null;
}

function rewriteDocument(
  document: Doc,
  mapping: ReadonlyMap<string, string>,
  pageId: string,
  incarnationId: string,
  sourceId: string,
): { document: Doc; warnings: CopyWarning[] } {
  const used = new Set<string>();
  const warnings: CopyWarning[] = [];
  const warnedTargets = new Set<string>();
  let index = 0;

  function freshBlockId(original: string): string {
    let attempt = 0;
    while (true) {
      const id = derivedId(
        pageId,
        incarnationId,
        "block",
        String(index),
        original,
        String(attempt),
      );
      if (!used.has(id)) return id;
      attempt++;
    }
  }

  function walk(node: Doc): Doc {
    index++;
    const next: Doc = { ...node };
    if (node.attrs) next.attrs = { ...node.attrs };
    if (node.marks) {
      next.marks = node.marks.map((mark) => {
        const copy = { ...mark };
        if (mark.attrs) copy.attrs = { ...mark.attrs };
        if (
          copy.type === "link" &&
          copy.attrs &&
          typeof copy.attrs.href === "string"
        ) {
          const target = pageTarget(copy.attrs.href);
          if (target !== null) {
            const mapped = mapping.get(target);
            if (mapped !== undefined)
              copy.attrs.href = `folio-page://${mapped}`;
            else if (!warnedTargets.has(target)) {
              warnedTargets.add(target);
              warnings.push({
                code: "EXTERNAL_PRIVATE_PAGE_LINK",
                sourceId,
                pageId,
                targetId: target,
                targetPageId: target,
                href: copy.attrs.href,
              });
            }
          }
        }
        return copy;
      });
    }
    if (BLOCK_TYPES.includes(node.type)) {
      if (!next.attrs) next.attrs = {};
      const original = typeof next.attrs.id === "string" ? next.attrs.id : "";
      const id = freshBlockId(original);
      next.attrs.id = id;
      used.add(id);
    }
    if (node.content) next.content = node.content.map(walk);
    return next;
  }

  return { document: walk(document), warnings };
}

function fingerprintData(preview: CopyPreview): unknown {
  return {
    target: {
      orgId: preview.target.orgId,
      workspaceId: preview.target.workspaceId,
    },
    sourceIds: preview.sourceIds,
    sourceHashes: preview.sourceHashes,
    scopes: preview.scopes,
    documents: preview.documents.map((entry) => ({
      sourceId: entry.sourceId,
      sourceRaw: entry.sourceRaw,
      scope: entry.scope,
      title: entry.title,
      raw: entry.raw,
    })),
    databases: preview.databases,
    records: preview.records,
    assetManifests: preview.assetManifests,
    warnings: preview.warnings,
  };
}

function pageKey(scope: Scope): string {
  return [scope.orgId, scope.workspaceId, scope.documentId]
    .map(identifier)
    .join(":");
}

function lifecycleKey(scope: Scope): string {
  return pageKey(scope);
}

function modelKey(scope: Scope, id: string): string {
  return [scope.orgId, scope.workspaceId, id].map(identifier).join(":");
}

function blobScope(target: CopyTarget): string {
  return `${identifier(target.orgId)}:${identifier(target.workspaceId)}`;
}

function workspacePrefix(target: CopyTarget): string {
  return `${blobScope(target)}:`;
}

function readHeadCut(store: StoragePort): Cut {
  const raw = store.get(META_NAMESPACE, HEAD_KEY);
  if (raw === null) fail("HEAD_MISSING");
  const record = plainRecord(raw, "CORRUPT_HEAD");
  const epoch = identifier(record.epoch);
  const seq = safeCounter(record.seq);
  const hash = record.hash;
  if (typeof hash !== "string" || !HASH.test(hash)) fail("CORRUPT_HEAD");
  return { epoch, seq, hash };
}

type PublishedAsset = { hash: string; bytes: number; uploads: string[] };

function publishedAsset(value: unknown, hash: string): PublishedAsset {
  const record = plainRecord(value, "CORRUPT_ASSET_META");
  if (
    typeof record.hash !== "string" ||
    !HASH.test(record.hash) ||
    record.hash !== hash
  )
    fail("CORRUPT_ASSET_META");
  const bytes = safeCounter(record.bytes);
  const uploads = record.uploads;
  demand(Array.isArray(uploads), "CORRUPT_ASSET_META");
  const checked: string[] = [];
  for (const upload of uploads) checked.push(identifier(upload));
  return { hash, bytes, uploads: checked };
}

type ResolvedMetadata = {
  databases: CopyDatabase[];
  records: CopyRecord[];
};

function resolveCopyMetadata(
  entries: PreparedSource[],
  target: { orgId: string; workspaceId: string },
): ResolvedMetadata {
  const databases: CopyDatabase[] = [];
  const records: CopyRecord[] = [];
  const databaseBySource = new Map<
    string,
    {
      entry: PreparedSource;
      properties: CopyProperty[];
      options: Map<string, CopyProperty>;
      mapping: Map<string, string>;
    }
  >();

  for (const entry of [...entries.filter(item => item.metadata?.kind === "database"), ...entries.filter(item => item.metadata?.kind !== "database")]) {
    const metadata = entry.metadata;
    if (metadata === null) continue;
    if (metadata.kind === "database") {
      const used = new Set<string>();
      const mapping = new Map<string, string>();
      const properties = metadata.properties.map((property) => {
        const id = identifier(
          derivedId(
            target.orgId,
            target.workspaceId,
            entry.scope.documentId,
            "property",
            property.id,
          ),
        );
        demand(!used.has(id), "DUPLICATE_PROPERTY_ID");
        used.add(id);
        mapping.set(property.id, id);
        return property.type === "select"
          ? {
              id,
              name: property.name,
              type: property.type,
              options: [...(property.options ?? [])],
            }
          : { id, name: property.name, type: property.type };
      });
      const copy: CopyDatabase = { sourceId: entry.source.id, properties };
      databases.push(copy);
      databaseBySource.set(entry.source.id, {
        entry,
        properties,
        options: new Map(
          metadata.properties.map((property) => [property.id, property]),
        ),
        mapping,
      });
      continue;
    }

    const database = databaseBySource.get(metadata.databaseId);
    demand(database !== undefined, "RECORD_DATABASE_NOT_SELECTED");
    const values = normalizeTypedCopyValues(
      metadata.values,
      [...database.options.values()],
    );
    const remapped: Record<string, CopyScalar> = {};
    for (const [key, value] of Object.entries(values)) {
      const targetId = database.mapping.get(key);
      demand(targetId !== undefined, "UNKNOWN_PROPERTY");
      remapped[targetId] = value;
    }
    records.push({
      sourceId: entry.source.id,
      databaseSourceId: metadata.databaseId,
      databaseId: database.entry.scope.documentId,
      position: metadata.position,
      title: entry.title,
      values: remapped,
    });
  }

  return { databases, records };
}

export function previewSharedCopy(
  sources: SharedCopySource[],
  selectedIds: string[],
  target: { orgId: string; workspaceId: string },
  allocate: () => string,
): CopyPreview {
  demand(Array.isArray(sources), "INVALID_SOURCES");
  demand(Array.isArray(selectedIds), "INVALID_SELECTION");
  const targetRecord = plainRecord(target, "INVALID_TARGET");
  const orgId = identifier(targetRecord.orgId);
  const workspaceId = identifier(targetRecord.workspaceId);
  demand(typeof allocate === "function", "INVALID_ALLOCATOR");

  const byId = new Map<string, unknown>();
  for (const source of sources) {
    const id = identifier(plainRecord(source, "INVALID_SOURCE").id);
    demand(!byId.has(id), "DUPLICATE_SOURCE_ID");
    byId.set(id, source);
  }

  const selected: PreparedSource[] = [];
  const selectedSet = new Set<string>();
  const pageIds = new Set<string>();

  for (const rawId of selectedIds) {
    const sourceId = identifier(rawId);
    demand(!selectedSet.has(sourceId), "DUPLICATE_SELECTED_ID");
    selectedSet.add(sourceId);
    demand(byId.has(sourceId), "SELECTED_SOURCE_MISSING");
    const source = assertSource(byId.get(sourceId));
    const parsed = inspectSharedDocument(source.raw);
    if (!parsed.ok) fail(parsed.code);
    const assets = normalizeAssets(source);
    const documentId = identifier(allocate());
    demand(
      !byId.has(documentId) && !pageIds.has(documentId),
      "NON_FRESH_PAGE_ID",
    );
    pageIds.add(documentId);
    const incarnationId = identifier(
      derivedId(orgId, workspaceId, documentId, sourceId, "incarnation"),
    );
    selected.push({
      source,
      document: parsed.document,
      title: sourceTitle(source.title),
      assets,
      hash: sourceFingerprint(source, assets),
      scope: { orgId, workspaceId, documentId, incarnationId },
      metadata: normalizeCopyMetadata(source.metadata) ?? null,
    });
  }

  const resolved = resolveCopyMetadata(selected, { orgId, workspaceId });

  const mapping = new Map(
    selected.map((entry) => [entry.source.id, entry.scope.documentId]),
  );
  const documents: CopyDocument[] = [];
  const assetManifests: CopyAssetManifest[] = [];
  const assets: CopyAsset[] = [];
  const warnings: CopyWarning[] = [];

  for (const entry of selected) {
    const rewritten = rewriteDocument(
      entry.document,
      mapping,
      entry.scope.documentId,
      entry.scope.incarnationId,
      entry.source.id,
    );
    documents.push({
      sourceId: entry.source.id,
      sourceRaw: entry.source.raw,
      scope: entry.scope,
      title: entry.title,
      raw: canonical(rewritten.document, MAX_DOCUMENT_BYTES),
      document: rewritten.document,
    });
    warnings.push(...rewritten.warnings);
    for (const asset of entry.assets) {
      assetManifests.push({
        sourceId: entry.source.id,
        hash: asset.hash,
        bytes: asset.bytes.byteLength,
      });
      assets.push({
        sourceId: entry.source.id,
        hash: asset.hash,
        bytes: asset.bytes.slice(),
      });
    }
  }

  const sourceHashes: CopySourceHash[] = selected.map((entry) => ({
    sourceId: entry.source.id,
    hash: entry.hash,
  }));
  const preview: CopyPreview = {
    fingerprint: "",
    target: { orgId, workspaceId },
    sourceIds: selected.map((entry) => entry.source.id),
    sourceHashes,
    sourceHashById: Object.fromEntries(
      sourceHashes.map((entry) => [entry.sourceId, entry.hash]),
    ),
    scopes: selected.map((entry) => entry.scope),
    documents,
    databases: resolved.databases,
    records: resolved.records,
    assetManifests,
    assets,
    warnings,
  };
  preview.fingerprint = copyDigest(fingerprintData(preview));
  return preview;
}

export function commitSharedCopy(
  store: StoragePort,
  preview: CopyPreview,
  currentSources: SharedCopySource[],
): Scope[] {
  demand(store !== null && typeof store === "object", "INVALID_STORE");
  demand(store.db !== null && typeof store.db === "object", "INVALID_STORE");
  demand(store.db.isTransaction === true, "TRANSACTION_REQUIRED");
  const previewRecord = plainRecord(preview, "INVALID_PREVIEW");
  demand(Array.isArray(currentSources), "INVALID_SOURCES");
  const targetRecord = plainRecord(previewRecord.target, "INVALID_PREVIEW");
  const target: CopyTarget = {
    orgId: identifier(targetRecord.orgId),
    workspaceId: identifier(targetRecord.workspaceId),
  };
  demand(typeof previewRecord.fingerprint === "string", "INVALID_PREVIEW");

  const sourceIds = previewRecord.sourceIds;
  const sourceHashes = previewRecord.sourceHashes;
  const scopes = previewRecord.scopes;
  const documents = previewRecord.documents;
  const previewDatabases = previewRecord.databases;
  const previewRecords = previewRecord.records;
  const assetManifests = previewRecord.assetManifests;
  const previewAssets = previewRecord.assets;
  const warnings = previewRecord.warnings;
  demand(Array.isArray(sourceIds), "INVALID_PREVIEW");
  demand(Array.isArray(sourceHashes), "INVALID_PREVIEW");
  demand(Array.isArray(scopes), "INVALID_PREVIEW");
  demand(Array.isArray(documents), "INVALID_PREVIEW");
  demand(Array.isArray(previewDatabases), "INVALID_PREVIEW");
  demand(Array.isArray(previewRecords), "INVALID_PREVIEW");
  demand(Array.isArray(assetManifests), "INVALID_PREVIEW");
  demand(Array.isArray(previewAssets), "INVALID_PREVIEW");
  demand(Array.isArray(warnings), "INVALID_PREVIEW");
  demand(sourceHashes.length === sourceIds.length, "INVALID_PREVIEW");
  demand(scopes.length === sourceIds.length, "INVALID_PREVIEW");
  demand(documents.length === sourceIds.length, "INVALID_PREVIEW");
  if (copyDigest(fingerprintData(preview)) !== previewRecord.fingerprint)
    fail("PREVIEW_CHANGED");

  const scopeBySource = new Map<string, Scope>();
  const mapping = new Map<string, string>();
  const documentIds = new Set<string>();
  const expected: CopyDocument[] = [];

  for (let index = 0; index < sourceIds.length; index++) {
    const sourceId = identifier(sourceIds[index]);
    demand(!scopeBySource.has(sourceId), "INVALID_PREVIEW");
    const scopeRecord = plainRecord(scopes[index], "INVALID_PREVIEW");
    const scope: Scope = {
      orgId: identifier(scopeRecord.orgId),
      workspaceId: identifier(scopeRecord.workspaceId),
      documentId: identifier(scopeRecord.documentId),
      incarnationId: identifier(scopeRecord.incarnationId),
    };
    demand(
      scope.orgId === target.orgId && scope.workspaceId === target.workspaceId,
      "PREVIEW_TARGET_MISMATCH",
    );
    demand(!documentIds.has(scope.documentId), "INVALID_PREVIEW");
    documentIds.add(scope.documentId);
    scopeBySource.set(sourceId, scope);
    mapping.set(sourceId, scope.documentId);

    const sourceHash = plainRecord(sourceHashes[index], "INVALID_PREVIEW");
    demand(sourceHash.sourceId === sourceId, "INVALID_PREVIEW");
    demand(
      typeof sourceHash.hash === "string" && HASH.test(sourceHash.hash),
      "INVALID_PREVIEW",
    );

    const document = plainRecord(documents[index], "INVALID_PREVIEW");
    demand(document.sourceId === sourceId, "INVALID_PREVIEW");
    demand(typeof document.sourceRaw === "string", "INVALID_PREVIEW");
    demand(typeof document.raw === "string", "INVALID_PREVIEW");
    demand(
      typeof document.title === "string" &&
        document.title.length <= 500 &&
        wellFormed(document.title),
      "INVALID_PREVIEW",
    );
    const storedScope = plainRecord(document.scope, "INVALID_PREVIEW");
    demand(
      storedScope.orgId === scope.orgId &&
        storedScope.workspaceId === scope.workspaceId &&
        storedScope.documentId === scope.documentId &&
        storedScope.incarnationId === scope.incarnationId,
      "INVALID_PREVIEW",
    );
    demand(
      document.document !== null && typeof document.document === "object",
      "INVALID_PREVIEW",
    );
    expected.push(document as unknown as CopyDocument);
  }

  const hashById = plainRecord(previewRecord.sourceHashById, "INVALID_PREVIEW");
  if (Object.keys(hashById).length !== sourceIds.length)
    fail("INVALID_PREVIEW");
  for (const sourceHash of sourceHashes) {
    const entry = plainRecord(sourceHash, "INVALID_PREVIEW");
    if (hashById[identifier(entry.sourceId)] !== entry.hash)
      fail("INVALID_PREVIEW");
  }

  const verifiedAssets = new Map<
    string,
    { bytes: Uint8Array; length: number }
  >();
  const derivedManifests: CopyAssetManifest[] = [];
  for (const rawAsset of previewAssets) {
    const asset = plainRecord(rawAsset, "INVALID_PREVIEW");
    const sourceId = identifier(asset.sourceId);
    demand(scopeBySource.has(sourceId), "INVALID_PREVIEW");
    const rawHash = asset.hash;
    if (typeof rawHash !== "string" || !HASH.test(rawHash))
      fail("INVALID_ASSET_HASH");
    const hash = rawHash;
    const bytes = asset.bytes;
    demand(bytes instanceof Uint8Array, "INVALID_ASSET_BYTES");
    if (bytes.byteLength > MAX_ASSET_BYTES) fail("ASSET_TOO_LARGE");
    if (sha256(bytes) !== hash) fail("ASSET_HASH_MISMATCH");
    const previous = verifiedAssets.get(hash);
    if (previous !== undefined && previous.length !== bytes.byteLength)
      fail("CONFLICTING_ASSET_BYTES");
    if (previous === undefined)
      verifiedAssets.set(hash, { bytes, length: bytes.byteLength });
    derivedManifests.push({ sourceId, hash, bytes: bytes.byteLength });
  }
  if (canonical(derivedManifests) !== canonical(assetManifests))
    fail("PREVIEW_ASSET_MISMATCH");

  const currentById = new Map<string, unknown>();
  for (const source of currentSources) {
    const id = identifier(plainRecord(source, "INVALID_SOURCE").id);
    demand(!currentById.has(id), "DUPLICATE_SOURCE_ID");
    currentById.set(id, source);
  }

  const prepared: PreparedSource[] = [];
  const expectedWarnings: CopyWarning[] = [];
  const expectedManifests: CopyAssetManifest[] = [];

  for (let index = 0; index < sourceIds.length; index++) {
    const sourceId = identifier(sourceIds[index]);
    demand(currentById.has(sourceId), "SOURCE_MISSING");
    const source = assertSource(currentById.get(sourceId));
    const sourceHash = plainRecord(sourceHashes[index], "INVALID_PREVIEW");
    const normalizedAssets = normalizeAssets(source);
    const hash = sourceFingerprint(source, normalizedAssets);
    if (hash !== sourceHash.hash) fail("SOURCE_CHANGED");
    if (source.raw !== expected[index].sourceRaw) fail("SOURCE_CHANGED");
    const parsed = inspectSharedDocument(source.raw);
    if (!parsed.ok) fail(parsed.code);
    const scope = scopeBySource.get(sourceId)!;
    const title = sourceTitle(source.title);
    const rewritten = rewriteDocument(
      parsed.document,
      mapping,
      scope.documentId,
      scope.incarnationId,
      sourceId,
    );
    const raw = canonical(rewritten.document, MAX_DOCUMENT_BYTES);
    if (
      raw !== expected[index].raw ||
      canonical(expected[index].document) !== raw
    )
      fail("PREVIEW_SOURCE_MISMATCH");
    if (title !== expected[index].title) fail("PREVIEW_SOURCE_MISMATCH");
    expectedWarnings.push(...rewritten.warnings);
    for (const asset of normalizedAssets) {
      expectedManifests.push({
        sourceId,
        hash: asset.hash,
        bytes: asset.bytes.byteLength,
      });
      const previewAsset = verifiedAssets.get(asset.hash);
      if (
        previewAsset === undefined ||
        previewAsset.length !== asset.bytes.byteLength
      )
        fail("PREVIEW_ASSET_MISMATCH");
    }
    prepared.push({
      source,
      document: rewritten.document,
      title,
      assets: normalizedAssets,
      hash,
      scope,
      metadata: normalizeCopyMetadata(source.metadata) ?? null,
    });
  }

  const expectedMetadata = resolveCopyMetadata(prepared, target);
  if (canonical(expectedMetadata.databases) !== canonical(previewDatabases))
    fail("PREVIEW_SOURCE_MISMATCH");
  if (canonical(expectedMetadata.records) !== canonical(previewRecords))
    fail("PREVIEW_SOURCE_MISMATCH");

  if (canonical(expectedManifests) !== canonical(assetManifests))
    fail("PREVIEW_ASSET_MISMATCH");
  if (canonical(expectedWarnings) !== canonical(warnings))
    fail("PREVIEW_WARNING_MISMATCH");
  if (
    verifiedAssets.size !==
    new Set(assetManifests.map((entry) => entry.hash)).size
  )
    fail("PREVIEW_ASSET_MISMATCH");

  const cut = readHeadCut(store);
  const prefix = workspacePrefix(target);

  let assetSpace = 0;
  for (const row of store.all(COPY_ASSETS_NAMESPACE)) {
    if (!row.key.startsWith(prefix)) continue;
    const hash = row.key.slice(prefix.length);
    if (!HASH.test(hash)) fail("CORRUPT_ASSET_META");
    const record = publishedAsset(row.value, hash);
    assetSpace += record.bytes;
  }
  for (const [hash, asset] of verifiedAssets) {
    const existing = store.get(COPY_ASSETS_NAMESPACE, `${prefix}${hash}`);
    if (existing === null) {
      assetSpace += asset.length;
      if (assetSpace > MAX_ASSET_SPACE_BYTES) fail("ASSET_QUOTA_EXCEEDED");
    } else {
      const record = publishedAsset(existing, hash);
      if (record.bytes !== asset.length) fail("ASSET_CONFLICT");
      const blob = store.blobGet(blobScope(target), hash);
      if (blob === null) fail("ASSET_MISSING");
      if (blob.byteLength !== asset.length || sha256(blob) !== hash)
        fail("ASSET_TAMPERED");
    }
  }

  const writes = prepared.map((entry, index) => {
    const state = seedTables(
      initialState(entry.document),
      entry.scope.incarnationId,
    );
    const raw = canonical(state);
    const parentId =
      entry.source.parentId !== null && mapping.has(entry.source.parentId)
        ? mapping.get(entry.source.parentId)!
        : null;
    return { entry, state, raw, parentId, index };
  });

  for (const write of writes) {
    const scope = write.entry.scope;
    const key = scopeKey(scope);
    demand(
      store.get(COPY_DOCUMENTS_NAMESPACE, key) === null,
      "DESTINATION_EXISTS",
    );
    demand(
      store.get(COPY_TITLES_NAMESPACE, key) === null,
      "DESTINATION_EXISTS",
    );
    demand(
      store.get(COPY_PAGES_NAMESPACE, pageKey(scope)) === null,
      "DESTINATION_EXISTS",
    );
    demand(
      store.get(COPY_LIFECYCLES_NAMESPACE, lifecycleKey(scope)) === null,
      "DESTINATION_EXISTS",
    );
    // A fresh copy ID may not silently replace or merge an existing database
    // or record of either kind.
    demand(
      store.get(COPY_DATABASES_NAMESPACE, modelKey(scope, scope.documentId)) ===
        null,
      "DESTINATION_EXISTS",
    );
    demand(
      store.get(COPY_RECORDS_NAMESPACE, modelKey(scope, scope.documentId)) ===
        null,
      "DESTINATION_EXISTS",
    );
    if (utf8Bytes(write.raw) > MAX_DOCUMENT_BYTES) fail("DOCUMENT_TOO_LARGE");
  }

  const assetOrder = [...verifiedAssets.keys()].sort();
  for (const hash of assetOrder) {
    const asset = verifiedAssets.get(hash)!;
    if (store.get(COPY_ASSETS_NAMESPACE, `${prefix}${hash}`) !== null) continue;
    store.blobPut(blobScope(target), hash, asset.bytes);
    store.set(COPY_ASSETS_NAMESPACE, `${prefix}${hash}`, {
      hash,
      bytes: asset.length,
      uploads: [],
    });
  }

  const databaseBySource = new Map(
    expectedMetadata.databases.map((database) => [database.sourceId, database]),
  );
  const recordBySource = new Map(
    expectedMetadata.records.map((record) => [record.sourceId, record]),
  );

  const plainWrites = writes.filter(
    (write) => write.entry.metadata === null,
  );
  const databaseWrites = writes.filter(
    (write) => write.entry.metadata?.kind === "database",
  );
  const recordWrites = writes.filter(
    (write) => write.entry.metadata?.kind === "record",
  );

  const orderedDatabases: typeof databaseWrites = [];
  const availablePages = new Set(
    plainWrites.map((write) => write.entry.scope.documentId),
  );
  const pendingDatabases = [...databaseWrites];
  while (pendingDatabases.length) {
    let progressed = false;
    for (let index = 0; index < pendingDatabases.length; index++) {
      const write = pendingDatabases[index];
      if (write.parentId !== null && !availablePages.has(write.parentId))
        continue;
      pendingDatabases.splice(index, 1);
      orderedDatabases.push(write);
      availablePages.add(write.entry.scope.documentId);
      progressed = true;
      break;
    }
    if (!progressed) {
      // A parent outside the selection was already mapped to null, so a cycle
      // here is a malformed preview rather than an external parent.
      fail("INVALID_PREVIEW");
    }
  }

  recordWrites.sort((left, right) => {
    const leftRecord = recordBySource.get(left.entry.source.id)!;
    const rightRecord = recordBySource.get(right.entry.source.id)!;
    return (
      leftRecord.databaseId.localeCompare(rightRecord.databaseId) ||
      leftRecord.position - rightRecord.position ||
      left.index - right.index
    );
  });

  const orderedWrites = [
    ...plainWrites,
    ...orderedDatabases,
    ...recordWrites,
  ];

  const orders = new Map<string, number>();
  for (const write of orderedWrites) {
    const scope = write.entry.scope;
    const key = scopeKey(scope);
    const metadata = write.entry.metadata;
    if (metadata?.kind === "database") {
      const database = databaseBySource.get(write.entry.source.id)!;
      applyRecords(store, scope, {
        kind: "resource",
        action: "db.create",
        payload: {
          databaseId: scope.documentId,
          revision: 0,
          properties: database.properties,
          parentId: write.parentId,
        } as unknown as Json,
      });
    } else if (metadata?.kind === "record") {
      const record = recordBySource.get(write.entry.source.id)!;
      applyRecords(store, scope, {
        kind: "resource",
        action: "record.create",
        payload: {
          databaseId: record.databaseId,
          revision: 0,
          title: record.title,
          values: record.values,
          document: write.entry.document,
        } as unknown as Json,
      });
    }
    store.set(COPY_DOCUMENTS_NAMESPACE, key, write.state);
    store.set(COPY_TITLES_NAMESPACE, key, write.entry.title);
    const orderKey = write.parentId ?? "";
    const order = orders.get(orderKey) ?? 0;
    orders.set(orderKey, order + 1);
    store.set(COPY_PAGES_NAMESPACE, pageKey(scope), {
      id: scope.documentId,
      parentId: write.parentId,
      order,
    });
    store.set(COPY_LIFECYCLES_NAMESPACE, lifecycleKey(scope), {
      activeIncarnation: scope.incarnationId,
      deleted: false,
      cut,
    });
  }

  return sourceIds.map((sourceId) => scopeBySource.get(identifier(sourceId))!);
}
