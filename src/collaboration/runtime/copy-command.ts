import { createHash, randomUUID } from "node:crypto";
import {
  CollaborationError,
  demand,
  identifier,
  safeCounter,
  wellFormed,
  type Json,
  type Scope,
} from "./contract";
import { canonical } from "./canonical";
import {
  COPY_LIFECYCLES_NAMESPACE,
  MAX_ASSET_BYTES,
  MAX_DOCUMENT_BYTES,
  commitSharedCopy,
  normalizeCopyMetadata,
  previewSharedCopy,
  type CopyPreview,
  type CopyTarget,
  type SharedCopyMetadata,
  type SharedCopySource,
} from "./copy";
import type { StoragePort } from "./storage-port";

export const MAX_COPY_PAYLOAD_BYTES = 850_000;
export const COPY_ATTEMPT_RESERVE_BYTES = 4_096;
const HASH = /^[a-f0-9]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const PAYLOAD_KEYS = [
  "sources",
  "selectedIds",
  "allocatedIds",
  "fingerprint",
] as const;
const SOURCE_KEYS = ["id", "parentId", "title", "raw", "assets"] as const;
const SOURCE_FIELDS = new Set([...SOURCE_KEYS, "metadata"]);
const ASSET_KEYS = ["hash", "base64"] as const;

function fail(code: string): never {
  throw new CollaborationError(code);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function textBytes(value: string): number {
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

function exactKeys(
  value: unknown,
  keys: readonly string[],
  code: string,
): Record<string, unknown> {
  const record = plainRecord(value, code);
  const names = Object.keys(record);
  demand(
    names.length === keys.length &&
      keys.every((key) => Object.hasOwn(record, key)),
    code,
  );
  return record;
}

function checkedArray(value: unknown, code: string): unknown[] {
  demand(Array.isArray(value), code);
  return value as unknown[];
}

function checkedString(value: unknown, code: string, max: number): string {
  demand(
    typeof value === "string" && value.length <= max && wellFormed(value),
    code,
  );
  return value;
}

function checkedHash(value: unknown, code: string): string {
  demand(typeof value === "string" && HASH.test(value), code);
  return value;
}

function checkedRaw(value: unknown): string {
  const raw = checkedString(value, "INVALID_COPY_RAW", MAX_DOCUMENT_BYTES);
  demand(textBytes(raw) <= MAX_DOCUMENT_BYTES, "COPY_TOO_LARGE");
  return raw;
}

function decodeBase64(value: unknown): Uint8Array {
  const encoded = checkedString(
    value,
    "INVALID_COPY_BASE64",
    Math.ceil((MAX_ASSET_BYTES * 4) / 3) + 4,
  );
  demand(
    encoded.length % 4 === 0 && BASE64.test(encoded),
    "INVALID_COPY_BASE64",
  );
  const bytes = Buffer.from(encoded, "base64");
  demand(bytes.toString("base64") === encoded, "INVALID_COPY_BASE64");
  demand(bytes.byteLength <= MAX_ASSET_BYTES, "ASSET_TOO_LARGE");
  return new Uint8Array(bytes);
}

function payloadWithinCapacity(payload: Json): void {
  let raw: string;
  try {
    raw = canonical(payload, MAX_COPY_PAYLOAD_BYTES);
  } catch (error) {
    if (error instanceof CollaborationError && error.code === "JSON_LIMIT")
      fail("COPY_CAPACITY_EXCEEDED");
    throw error;
  }
  demand(
    textBytes(raw) + COPY_ATTEMPT_RESERVE_BYTES <= MAX_COPY_PAYLOAD_BYTES,
    "COPY_CAPACITY_EXCEEDED",
  );
}

function sourceFrom(value: unknown): SharedCopySource {
  const record = plainRecord(value, "INVALID_COPY_SOURCE");
  for (const key of Object.keys(record))
    demand(SOURCE_FIELDS.has(key), "INVALID_COPY_SOURCE");
  for (const key of SOURCE_KEYS)
    demand(Object.hasOwn(record, key), "INVALID_COPY_SOURCE");
  const parentId =
    record.parentId === null ? null : identifier(record.parentId);
  const title = checkedString(record.title, "INVALID_COPY_TITLE", 500);
  const raw = checkedRaw(record.raw);
  const assets = checkedArray(record.assets, "INVALID_COPY_ASSETS").map(
    (input) => {
      const asset = exactKeys(input, ASSET_KEYS, "INVALID_COPY_ASSET");
      const hash = checkedHash(asset.hash, "INVALID_COPY_ASSET_HASH");
      const bytes = decodeBase64(asset.base64);
      demand(sha256(bytes) === hash, "ASSET_HASH_MISMATCH");
      return { hash, bytes };
    },
  );
  const metadata = normalizeCopyMetadata(record.metadata);
  return {
    id: identifier(record.id),
    parentId,
    title,
    raw,
    assets,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function payloadFrom(preview: CopyPreview, sources: SharedCopySource[]): Json {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const payloadSources: Json[] = preview.documents.map((document) => {
    const source = byId.get(document.sourceId)!;
    return {
      id: document.sourceId,
      parentId: source.parentId,
      title: document.title,
      raw: source.raw,
      assets: preview.assets
        .filter((asset) => asset.sourceId === document.sourceId)
        .map((asset): Json => ({
          hash: asset.hash,
          base64: Buffer.from(asset.bytes).toString("base64"),
        })),
    };
  });
  const payload: Json = {
    sources: payloadSources,
    selectedIds: preview.sourceIds,
    allocatedIds: preview.scopes.map((scope) => scope.documentId),
    fingerprint: preview.fingerprint,
  };
  return payload;
}

export function previewCopyPayload(
  sources: SharedCopySource[],
  selectedIds: string[],
  target: CopyTarget,
): { preview: CopyPreview; payload: Json } {
  const preview = previewSharedCopy(sources, selectedIds, target, () =>
    randomUUID(),
  );
  const payload = payloadFrom(preview, sources);
  payloadWithinCapacity(payload);
  return { preview, payload };
}

function pageKey(scope: Scope): string {
  return [scope.orgId, scope.workspaceId, scope.documentId]
    .map(identifier)
    .join(":");
}

function provisionalCut(store: StoragePort): {
  epoch: string;
  seq: number;
  hash: string;
} {
  const raw = store.get("meta", "head");
  if (raw === null) fail("HEAD_MISSING");
  const head = plainRecord(raw, "CORRUPT_HEAD");
  const epoch = identifier(head.epoch);
  const seq = safeCounter(head.seq);
  checkedHash(head.hash, "CORRUPT_HEAD");
  demand(seq < Number.MAX_SAFE_INTEGER, "SEQUENCE_LIMIT");
  return { epoch, seq: seq + 1, hash: "" };
}

export function applyCopyPayload(
  store: StoragePort,
  scope: Scope,
  payload: Json,
): { scopes: Scope[] } {
  demand(store !== null && typeof store === "object", "INVALID_STORE");
  const record = exactKeys(payload, PAYLOAD_KEYS, "INVALID_COPY_PAYLOAD");
  payloadWithinCapacity(payload);

  const target: CopyTarget = {
    orgId: identifier(scope.orgId),
    workspaceId: identifier(scope.workspaceId),
  };
  const selectedIds = checkedArray(
    record.selectedIds,
    "INVALID_COPY_SELECTION",
  ).map((id) => identifier(id));
  const allocatedIds = checkedArray(
    record.allocatedIds,
    "INVALID_COPY_ALLOCATION",
  ).map((id) => identifier(id));
  demand(
    allocatedIds.length === selectedIds.length,
    "COPY_ALLOCATION_MISMATCH",
  );
  demand(
    new Set(allocatedIds).size === allocatedIds.length,
    "COPY_ALLOCATION_MISMATCH",
  );
  const fingerprint = checkedHash(
    record.fingerprint,
    "INVALID_COPY_FINGERPRINT",
  );
  const sources = checkedArray(record.sources, "INVALID_COPY_SOURCES").map(
    sourceFrom,
  );

  let allocated = 0;
  const allocate = (): string => {
    if (allocated >= allocatedIds.length) fail("COPY_ALLOCATION_MISMATCH");
    return allocatedIds[allocated++];
  };
  const preview = previewSharedCopy(sources, selectedIds, target, allocate);
  demand(allocated === allocatedIds.length, "COPY_ALLOCATION_MISMATCH");
  const actualIds = preview.scopes.map((entry) => entry.documentId);
  if (canonical(actualIds) !== canonical(allocatedIds))
    fail("COPY_ALLOCATION_MISMATCH");
  if (preview.fingerprint !== fingerprint) fail("COPY_FINGERPRINT_MISMATCH");

  const scopes = commitSharedCopy(store, preview, sources);
  const cut = provisionalCut(store);
  for (const created of scopes) {
    store.set(COPY_LIFECYCLES_NAMESPACE, pageKey(created), {
      activeIncarnation: created.incarnationId,
      deleted: false,
      cut,
    });
  }
  return { scopes };
}
