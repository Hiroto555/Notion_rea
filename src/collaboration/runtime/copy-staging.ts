import { createHash } from "node:crypto";
import {
  CollaborationError,
  demand,
  identifier,
  safeCounter,
  wellFormed,
  type AuthContext,
  type Scope,
} from "./contract";
import { canonical } from "./canonical";
import { SharedAssets } from "./assets";
import {
  MAX_ASSET_BYTES,
  MAX_DOCUMENT_BYTES,
  commitSharedCopy,
  previewSharedCopy,
  type SharedCopySource,
} from "./copy";
import type { StoragePort } from "./storage-port";

export const COPY_STAGING_NAMESPACE = "copy.staging";
export const MAX_COPY_STAGING_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_COPY_STAGING_PART_BYTES = 500_000;
export const MAX_COPY_STAGING_PARTS = 100;
export const MAX_COPY_STAGING_ACTIVE = 8;
export const MAX_COPY_STAGING_RESERVED_BYTES = 32 * 1024 * 1024;

const HASH = /^[a-f0-9]{64}$/;
const MANIFEST_KEYS = [
  "copyId",
  "selectedIds",
  "allocatedIds",
  "fingerprint",
  "sources",
  "parts",
] as const;
const SOURCE_KEYS = ["id", "parts", "assets"] as const;
const ASSET_KEYS = ["hash", "size"] as const;
const PART_KEYS = ["hash", "size"] as const;
const SOURCE_JSON_KEYS = ["id", "parentId", "title", "raw", "assets"] as const;
const SOURCE_ASSET_KEYS = ["hash"] as const;
const RECORD_KEYS = ["v", "manifestHash", "manifest", "actor", "scope"] as const;
const ACTOR_KEYS = ["userId", "deviceId", "writerId"] as const;
const STAGED_PART_KEYS = ["index", "hash", "size", "data"] as const;
const COMMITTED_KEYS = [
  "v",
  "copyId",
  "manifestHash",
  "fingerprint",
  "sourceIds",
  "allocatedIds",
  "scopes",
] as const;

export type SharedCopyStagedAsset = { hash: string; size: number };
export type SharedCopyStagedSource = {
  id: string;
  parts: number;
  assets: SharedCopyStagedAsset[];
};
export type SharedCopyStagedPart = { hash: string; size: number };

/**
 * Immutable, client-built description of one staged large copy. The manifest
 * deliberately carries asset hashes and sizes rather than asset bytes.
 */
export type SharedCopyManifest = {
  copyId: string;
  selectedIds: string[];
  allocatedIds: string[];
  fingerprint: string;
  sources: SharedCopyStagedSource[];
  parts: SharedCopyStagedPart[];
};

export type SharedCopyPrepared = {
  copyId: string;
  manifestHash: string;
  fingerprint: string;
  selectedIds: string[];
  allocatedIds: string[];
  partCount: number;
  totalSourceBytes: number;
  assets: SharedCopyStagedAsset[];
};

export type SharedCopyInspection = SharedCopyPrepared & {
  stagedParts: number;
  missingParts: number[];
  committed: SharedCopyCommitResult | null;
};

export type SharedCopyCommitResult = {
  copyId: string;
  manifestHash: string;
  fingerprint: string;
  sourceIds: string[];
  allocatedIds: string[];
  scopes: Scope[];
};

type Actor = { userId: string; deviceId: string; writerId: string };
type NormalizedScope = {
  orgId: string;
  workspaceId: string;
  documentId: string;
  incarnationId: string;
};
type ManifestRecord = {
  v: 1;
  manifestHash: string;
  manifest: SharedCopyManifest;
  actor: Actor;
  scope: NormalizedScope;
};
type StagedPartRecord = {
  index: number;
  hash: string;
  size: number;
  data: string;
};
type CommittedRecord = {
  v: 1;
  copyId: string;
  manifestHash: string;
  fingerprint: string;
  sourceIds: string[];
  allocatedIds: string[];
  scopes: Scope[];
};

function fail(code: string): never {
  throw new CollaborationError(code);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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

function checkedString(
  value: unknown,
  code: string,
  max: number,
): string {
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

function checkedSize(value: unknown, max: number, code: string, minimum = 1): number {
  demand(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= minimum &&
      value <= max,
    code,
  );
  return value;
}

function authActor(auth: AuthContext): Actor {
  const record = plainRecord(auth, "INVALID_AUTH");
  identifier(record.sessionId);
  return {
    userId: identifier(record.userId),
    deviceId: identifier(record.deviceId),
    writerId: identifier(record.writerId),
  };
}

function normalizedScope(scope: Scope): NormalizedScope {
  const record = plainRecord(scope, "INVALID_SCOPE");
  return {
    orgId: identifier(record.orgId),
    workspaceId: identifier(record.workspaceId),
    documentId: identifier(record.documentId),
    incarnationId: identifier(record.incarnationId),
  };
}

function sameScope(left: NormalizedScope, right: NormalizedScope): boolean {
  return (
    left.orgId === right.orgId &&
    left.workspaceId === right.workspaceId &&
    left.documentId === right.documentId &&
    left.incarnationId === right.incarnationId
  );
}

function sameActor(left: Actor, right: Actor): boolean {
  return (
    left.userId === right.userId &&
    left.deviceId === right.deviceId &&
    left.writerId === right.writerId
  );
}

function transactionBound(store: StoragePort): void {
  demand(store !== null && typeof store === "object", "INVALID_STORE");
  demand(store.db !== null && typeof store.db === "object", "INVALID_STORE");
  demand(store.db.isTransaction === true, "TRANSACTION_REQUIRED");
}

function binding(scope: NormalizedScope, writerId: string): string {
  return sha256(
    canonical({
      scope: [
        scope.orgId,
        scope.workspaceId,
        scope.documentId,
        scope.incarnationId,
      ],
      writerId,
    }),
  );
}

function baseKey(scope: NormalizedScope, writerId: string, copyId: string): string {
  return `${binding(scope, writerId)}:${identifier(copyId)}`;
}

function manifestKey(base: string): string {
  return `${base}:manifest`;
}

function partKey(base: string, index: number): string {
  return `${base}:part:${index}`;
}

function partPrefix(base: string): string {
  return `${base}:part:`;
}

function committedKey(base: string): string {
  return `${base}:committed`;
}

function manifestDigest(manifest: SharedCopyManifest): string {
  return sha256(canonical(manifest));
}

function normalizeManifest(value: unknown): SharedCopyManifest {
  const record = exactKeys(value, MANIFEST_KEYS, "INVALID_COPY_MANIFEST");
  const copyId = identifier(record.copyId);
  const selectedIds = checkedArray(
    record.selectedIds,
    "INVALID_COPY_SELECTION",
  ).map((id) => identifier(id));
  const allocatedIds = checkedArray(
    record.allocatedIds,
    "INVALID_COPY_ALLOCATION",
  ).map((id) => identifier(id));
  demand(selectedIds.length > 0, "INVALID_COPY_SELECTION");
  demand(
    selectedIds.length === allocatedIds.length,
    "COPY_ALLOCATION_MISMATCH",
  );
  demand(
    new Set(selectedIds).size === selectedIds.length,
    "DUPLICATE_SELECTED_ID",
  );
  demand(
    new Set(allocatedIds).size === allocatedIds.length,
    "COPY_ALLOCATION_MISMATCH",
  );
  const fingerprint = checkedHash(
    record.fingerprint,
    "INVALID_COPY_FINGERPRINT",
  );

  const sourceRecords = checkedArray(record.sources, "INVALID_COPY_SOURCES");
  demand(
    sourceRecords.length === selectedIds.length,
    "COPY_SOURCE_COUNT_MISMATCH",
  );
  const sources: SharedCopyStagedSource[] = [];
  const assetSizes = new Map<string, number>();
  let partTotal = 0;

  for (let index = 0; index < sourceRecords.length; index++) {
    const source = exactKeys(
      sourceRecords[index],
      SOURCE_KEYS,
      "INVALID_COPY_SOURCE",
    );
    const id = identifier(source.id);
    demand(id === selectedIds[index], "COPY_SOURCE_ORDER_MISMATCH");
    const parts = safeCounter(source.parts);
    demand(parts > 0, "INVALID_COPY_SOURCE");
    partTotal += parts;
    demand(partTotal <= MAX_COPY_STAGING_PARTS, "COPY_PART_LIMIT");
    const assets: SharedCopyStagedAsset[] = [];
    for (const rawAsset of checkedArray(source.assets, "INVALID_COPY_ASSETS")) {
      const asset = exactKeys(rawAsset, ASSET_KEYS, "INVALID_COPY_ASSET");
      const hash = checkedHash(asset.hash, "INVALID_COPY_ASSET_HASH");
      const size = checkedSize(asset.size, MAX_ASSET_BYTES, "INVALID_COPY_ASSET", 0);
      const previous = assetSizes.get(hash);
      demand(
        previous === undefined || previous === size,
        "COPY_ASSET_SIZE_CONFLICT",
      );
      assetSizes.set(hash, size);
      assets.push({ hash, size });
    }
    sources.push({ id, parts, assets });
  }

  const partRecords = checkedArray(record.parts, "INVALID_COPY_PARTS");
  demand(partRecords.length === partTotal, "COPY_PART_COUNT_MISMATCH");
  demand(partRecords.length <= MAX_COPY_STAGING_PARTS, "COPY_PART_LIMIT");
  const parts: SharedCopyStagedPart[] = [];
  let totalSourceBytes = 0;
  for (const rawPart of partRecords) {
    const part = exactKeys(rawPart, PART_KEYS, "INVALID_COPY_PART");
    const hash = checkedHash(part.hash, "INVALID_COPY_PART_HASH");
    const size = checkedSize(
      part.size,
      MAX_COPY_STAGING_PART_BYTES,
      "INVALID_COPY_PART",
    );
    totalSourceBytes += size;
    demand(
      totalSourceBytes <= MAX_COPY_STAGING_SOURCE_BYTES,
      "COPY_SOURCE_TOO_LARGE",
    );
    parts.push({ hash, size });
  }

  return {
    copyId,
    selectedIds,
    allocatedIds,
    fingerprint,
    sources,
    parts,
  };
}

function manifestAssets(manifest: SharedCopyManifest): SharedCopyStagedAsset[] {
  const byHash = new Map<string, number>();
  for (const source of manifest.sources)
    for (const asset of source.assets) byHash.set(asset.hash, asset.size);
  return [...byHash.entries()]
    .map(([hash, size]) => ({ hash, size }))
    .sort((left, right) => left.hash.localeCompare(right.hash));
}

function preparedSummary(
  manifest: SharedCopyManifest,
  manifestHash: string,
): SharedCopyPrepared {
  return {
    copyId: manifest.copyId,
    manifestHash,
    fingerprint: manifest.fingerprint,
    selectedIds: [...manifest.selectedIds],
    allocatedIds: [...manifest.allocatedIds],
    partCount: manifest.parts.length,
    totalSourceBytes: manifest.parts.reduce((sum, part) => sum + part.size, 0),
    assets: manifestAssets(manifest),
  };
}

function parseManifestRecord(
  value: unknown,
  actor: Actor,
  scope: NormalizedScope,
): ManifestRecord {
  const record = exactKeys(value, RECORD_KEYS, "CORRUPT_COPY_STAGING");
  demand(record.v === 1, "CORRUPT_COPY_STAGING");
  const manifestHash = checkedHash(
    record.manifestHash,
    "CORRUPT_COPY_STAGING",
  );
  const storedActor = exactKeys(
    record.actor,
    ACTOR_KEYS,
    "CORRUPT_COPY_STAGING",
  );
  const stored: Actor = {
    userId: identifier(storedActor.userId),
    deviceId: identifier(storedActor.deviceId),
    writerId: identifier(storedActor.writerId),
  };
  demand(sameActor(stored, actor), "COPY_ACTOR_MISMATCH");
  const storedScope = plainRecord(record.scope, "CORRUPT_COPY_STAGING");
  const scopeValue: NormalizedScope = {
    orgId: identifier(storedScope.orgId),
    workspaceId: identifier(storedScope.workspaceId),
    documentId: identifier(storedScope.documentId),
    incarnationId: identifier(storedScope.incarnationId),
  };
  demand(sameScope(scopeValue, scope), "COPY_SCOPE_MISMATCH");
  const manifest = normalizeManifest(record.manifest);
  demand(manifestDigest(manifest) === manifestHash, "CORRUPT_COPY_STAGING");
  return {
    v: 1,
    manifestHash,
    manifest,
    actor: stored,
    scope: scopeValue,
  };
}

function readManifest(
  store: StoragePort,
  base: string,
  actor: Actor,
  scope: NormalizedScope,
): ManifestRecord {
  const raw = store.get(COPY_STAGING_NAMESPACE, manifestKey(base));
  if (raw === null) fail("COPY_NOT_FOUND");
  demand(store.get(COPY_STAGING_NAMESPACE, base + ":abandoned") === null, "COPY_ABANDONED");
  return parseManifestRecord(raw, actor, scope);
}

function parseCommitted(value: unknown): CommittedRecord {
  const record = exactKeys(value, COMMITTED_KEYS, "CORRUPT_COPY_STAGING");
  demand(record.v === 1, "CORRUPT_COPY_STAGING");
  const copyId = identifier(record.copyId);
  const manifestHash = checkedHash(
    record.manifestHash,
    "CORRUPT_COPY_STAGING",
  );
  const fingerprint = checkedHash(record.fingerprint, "CORRUPT_COPY_STAGING");
  const sourceIds = checkedArray(record.sourceIds, "CORRUPT_COPY_STAGING").map(
    (id) => identifier(id),
  );
  const allocatedIds = checkedArray(
    record.allocatedIds,
    "CORRUPT_COPY_STAGING",
  ).map((id) => identifier(id));
  const scopes = checkedArray(record.scopes, "CORRUPT_COPY_STAGING").map(
    (rawScope) => {
      const scope = plainRecord(rawScope, "CORRUPT_COPY_STAGING");
      return {
        orgId: identifier(scope.orgId),
        workspaceId: identifier(scope.workspaceId),
        documentId: identifier(scope.documentId),
        incarnationId: identifier(scope.incarnationId),
      };
    },
  );
  return {
    v: 1,
    copyId,
    manifestHash,
    fingerprint,
    sourceIds,
    allocatedIds,
    scopes,
  };
}

function readCommitted(
  store: StoragePort,
  base: string,
): CommittedRecord | null {
  const raw = store.get(COPY_STAGING_NAMESPACE, committedKey(base));
  return raw === null ? null : parseCommitted(raw);
}

function commitResult(record: CommittedRecord): SharedCopyCommitResult {
  return {
    copyId: record.copyId,
    manifestHash: record.manifestHash,
    fingerprint: record.fingerprint,
    sourceIds: [...record.sourceIds],
    allocatedIds: [...record.allocatedIds],
    scopes: record.scopes.map((scope) => ({ ...scope })),
  };
}

function parseStagedPart(value: unknown, expectedIndex: number): StagedPartRecord {
  const record = exactKeys(value, STAGED_PART_KEYS, "CORRUPT_COPY_STAGING");
  const index = safeCounter(record.index);
  demand(index === expectedIndex, "CORRUPT_COPY_STAGING");
  const hash = checkedHash(record.hash, "CORRUPT_COPY_STAGING");
  const size = checkedSize(
    record.size,
    MAX_COPY_STAGING_PART_BYTES,
    "CORRUPT_COPY_STAGING",
  );
  const data = record.data;
  demand(typeof data === "string" && wellFormed(data), "CORRUPT_COPY_STAGING");
  demand(textBytes(data) === size, "CORRUPT_COPY_STAGING");
  demand(sha256(data) === hash, "CORRUPT_COPY_STAGING");
  return { index, hash, size, data };
}

function stagedParts(
  store: StoragePort,
  base: string,
  partCount: number,
): Map<number, StagedPartRecord> {
  const prefix = partPrefix(base);
  const parts = new Map<number, StagedPartRecord>();
  for (const row of store.all(COPY_STAGING_NAMESPACE)) {
    if (!row.key.startsWith(prefix)) continue;
    const suffix = row.key.slice(prefix.length);
    demand(/^(0|[1-9][0-9]*)$/.test(suffix), "CORRUPT_COPY_STAGING");
    const index = Number(suffix);
    demand(Number.isSafeInteger(index), "CORRUPT_COPY_STAGING");
    demand(index < partCount, "COPY_UNEXPECTED_PART");
    const part = parseStagedPart(row.value, index);
    parts.set(index, part);
  }
  return parts;
}

function parseSourceJson(
  text: string,
  sourceIndex: number,
  manifest: SharedCopyManifest,
  assetSizes: ReadonlyMap<string, number>,
): SharedCopySource {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("COPY_SOURCE_INVALID");
  }
  let roundtrip: string;
  try {
    roundtrip = canonical(parsed, MAX_COPY_STAGING_SOURCE_BYTES);
  } catch {
    fail("COPY_SOURCE_INVALID");
  }
  if (roundtrip !== text) fail("COPY_SOURCE_NOT_CANONICAL");

  const hasMetadata = parsed !== null && typeof parsed === "object" && Object.hasOwn(parsed, "metadata");
  const source = exactKeys(parsed, hasMetadata ? [...SOURCE_JSON_KEYS, "metadata"] : SOURCE_JSON_KEYS, "COPY_SOURCE_INVALID");
  const expected = manifest.sources[sourceIndex];
  const id = identifier(source.id);
  demand(id === expected.id, "COPY_SOURCE_ORDER_MISMATCH");
  const parentId =
    source.parentId === null ? null : identifier(source.parentId);
  const title = checkedString(source.title, "INVALID_COPY_TITLE", 500);
  const raw = checkedString(
    source.raw,
    "INVALID_COPY_RAW",
    MAX_DOCUMENT_BYTES,
  );
  demand(textBytes(raw) <= MAX_DOCUMENT_BYTES, "COPY_SOURCE_TOO_LARGE");

  const assetHashes: string[] = [];
  for (const rawAsset of checkedArray(source.assets, "INVALID_COPY_ASSETS")) {
    const asset = exactKeys(rawAsset, SOURCE_ASSET_KEYS, "INVALID_COPY_ASSET");
    const hash = checkedHash(asset.hash, "INVALID_COPY_ASSET_HASH");
    demand(assetSizes.has(hash), "COPY_ASSET_MISMATCH");
    assetHashes.push(hash);
  }
  demand(
    canonical(assetHashes) === canonical(expected.assets.map((asset) => asset.hash)),
    "COPY_ASSET_MISMATCH",
  );

  return {
    id,
    parentId,
    title,
    raw,
    ...(hasMetadata ? {metadata: source.metadata as SharedCopySource["metadata"]} : {}),
    assets: assetHashes.map((hash) => ({
      hash,
      bytes: new Uint8Array(0),
    })),
  };
}

function resolveAssets(
  store: StoragePort,
  scope: NormalizedScope,
  manifest: SharedCopyManifest,
  resolve?: (scope: Scope, hash: string) => Uint8Array,
): Map<string, Uint8Array> {
  const assets = new SharedAssets(store);
  const resolved = new Map<string, Uint8Array>();
  for (const entry of manifestAssets(manifest)) {
    let bytes: Uint8Array;
    try {
      bytes = resolve ? resolve(scope, entry.hash) : assets.read(scope, entry.hash);
    } catch (error) {
      if (
        error instanceof CollaborationError &&
        (error.code === "ASSET_NOT_FOUND" || error.code === "ASSET_MISSING")
      )
        fail("COPY_ASSET_MISSING");
      throw error;
    }
    demand(bytes.byteLength === entry.size, "COPY_ASSET_SIZE_MISMATCH");
    resolved.set(entry.hash, bytes);
  }
  return resolved;
}

/**
 * Staged large-copy primitive. The authority layer owns authentication,
 * authority cuts, HTTP/preload wiring, receipts and deduplication. Mutations
 * require an already open StoragePort transaction so that a caller can bind
 * the whole operation to its authenticated same-cut transaction.
 */
export class SharedCopyStaging {
  constructor(private readonly store: StoragePort, private readonly resolveAsset?: (scope: Scope, hash: string) => Uint8Array) {}

  /** Same actor/workspace metadata only; never returns staged source or assets. */
  list(auth: AuthContext, scope: Scope): {scope: Scope; copyId: string; manifestHash: string; stagedParts: number}[] {
    const actor = authActor(auth), target = normalizedScope(scope);
    const rows: {scope: Scope; copyId: string; manifestHash: string; stagedParts: number}[] = [];
    for (const row of this.store.all(COPY_STAGING_NAMESPACE)) {
      if (!row.key.endsWith(":manifest")) continue;
      const base = row.key.slice(0, -":manifest".length);
      if (this.store.get(COPY_STAGING_NAMESPACE, base + ":abandoned") !== null || readCommitted(this.store, base) !== null) continue;
      const value = plainRecord(row.value, "CORRUPT_COPY_STAGING");
      const storedScope = normalizedScope(value.scope as Scope);
      const storedActor = exactKeys(value.actor, ACTOR_KEYS, "CORRUPT_COPY_STAGING");
      if (storedScope.orgId !== target.orgId || storedScope.workspaceId !== target.workspaceId ||
          storedActor.userId !== actor.userId || storedActor.deviceId !== actor.deviceId || storedActor.writerId !== actor.writerId) continue;
      const record = parseManifestRecord(value, actor, storedScope);
      demand(base === baseKey(storedScope, actor.writerId, record.manifest.copyId), "CORRUPT_COPY_STAGING");
      rows.push({scope: storedScope, copyId: record.manifest.copyId, manifestHash: record.manifestHash,
        stagedParts: this.inspect(auth, storedScope, record.manifest.copyId).stagedParts});
    }
    return rows.sort((a,b) => a.copyId.localeCompare(b.copyId));
  }

  prepare(
    auth: AuthContext,
    scope: Scope,
    manifest: unknown,
  ): SharedCopyPrepared {
    transactionBound(this.store);
    const actor = authActor(auth);
    const target = normalizedScope(scope);
    const normalized = normalizeManifest(manifest);
    const manifestHash = manifestDigest(normalized);
    const base = baseKey(target, actor.writerId, normalized.copyId);
    demand(this.store.get(COPY_STAGING_NAMESPACE, base + ":abandoned") === null, "COPY_ABANDONED");
    const committed = readCommitted(this.store, base);
    if (committed !== null) {
      demand(
        committed.manifestHash === manifestHash,
        "COPY_ALREADY_COMMITTED",
      );
      return preparedSummary(committedToManifest(normalized, committed), manifestHash);
    }
    const existing = this.store.get(
      COPY_STAGING_NAMESPACE,
      manifestKey(base),
    );
    if (existing !== null) {
      const record = parseManifestRecord(existing, actor, target);
      demand(
        record.manifestHash === manifestHash &&
          canonical(record.manifest) === canonical(normalized),
        "COPY_MANIFEST_CONFLICT",
      );
      return preparedSummary(record.manifest, record.manifestHash);
    }
    let count = 0, reserved = normalized.parts.reduce((sum, part) => sum + part.size, 0);
    for (const row of this.store.all(COPY_STAGING_NAMESPACE)) {
      if (!row.key.endsWith(":manifest")) continue;
      const priorBase = row.key.slice(0, -":manifest".length);
      if (this.store.get(COPY_STAGING_NAMESPACE, priorBase + ":abandoned") !== null || readCommitted(this.store, priorBase) !== null) continue;
      const raw = plainRecord(row.value, "CORRUPT_COPY_STAGING");
      const actorValue = exactKeys(raw.actor, ACTOR_KEYS, "CORRUPT_COPY_STAGING");
      const priorActor = {userId: identifier(actorValue.userId), deviceId: identifier(actorValue.deviceId), writerId: identifier(actorValue.writerId)};
      const prior = parseManifestRecord(raw, priorActor, normalizedScope(raw.scope as Scope));
      count++;
      reserved += prior.manifest.parts.reduce((sum, part) => sum + part.size, 0);
    }
    demand(count < MAX_COPY_STAGING_ACTIVE && reserved <= MAX_COPY_STAGING_RESERVED_BYTES, "COPY_STAGING_CAPACITY");
    const record: ManifestRecord = {
      v: 1,
      manifestHash,
      manifest: normalized,
      actor,
      scope: target,
    };
    this.store.set(COPY_STAGING_NAMESPACE, manifestKey(base), record);
    return preparedSummary(normalized, manifestHash);
  }

  /** Explicit cancellation after UNKNOWN has been resolved. Immutable ids and audit remain. */
  abandon(auth: AuthContext, scope: Scope, copyId: string, manifestHash: string): {copyId: string; abandoned: true; removedParts: number} {
    transactionBound(this.store);
    const actor = authActor(auth), target = normalizedScope(scope), id = identifier(copyId);
    const base = baseKey(target, actor.writerId, id);
    const raw = this.store.get(COPY_STAGING_NAMESPACE, manifestKey(base));
    demand(raw, "COPY_NOT_FOUND");
    const record = parseManifestRecord(raw, actor, target);
    demand(record.manifestHash === manifestHash, "COPY_MANIFEST_HASH_MISMATCH");
    demand(readCommitted(this.store, base) === null, "COPY_ALREADY_COMMITTED");
    let removedParts = 0;
    for (const row of this.store.all(COPY_STAGING_NAMESPACE)) if (row.key.startsWith(partPrefix(base))) {
      this.store.set(COPY_STAGING_NAMESPACE, row.key, null); removedParts++;
    }
    this.store.set(COPY_STAGING_NAMESPACE, base + ":abandoned", {manifestHash});
    return {copyId: id, abandoned: true, removedParts};
  }
  stagePart(
    auth: AuthContext,
    scope: Scope,
    copyId: string,
    index: unknown,
    raw: unknown,
  ): { copyId: string; index: number; hash: string; size: number } {
    transactionBound(this.store);
    const actor = authActor(auth);
    const target = normalizedScope(scope);
    const id = identifier(copyId);
    const partIndex = safeCounter(index);
    demand(typeof raw === "string" && wellFormed(raw), "INVALID_COPY_PART_DATA");
    const size = textBytes(raw);
    demand(
      size > 0 && size <= MAX_COPY_STAGING_PART_BYTES,
      "INVALID_COPY_PART_DATA",
    );
    const base = baseKey(target, actor.writerId, id);
    const record = readManifest(this.store, base, actor, target);
    demand(record.manifest.copyId === id, "COPY_MANIFEST_CONFLICT");
    if (readCommitted(this.store, base) !== null)
      fail("COPY_ALREADY_COMMITTED");
    demand(partIndex < record.manifest.parts.length, "COPY_PART_INDEX_INVALID");
    const expected = record.manifest.parts[partIndex];
    demand(size === expected.size, "COPY_PART_SIZE_MISMATCH");
    const hash = sha256(raw);
    demand(hash === expected.hash, "COPY_PART_HASH_MISMATCH");

    const existing = this.store.get(
      COPY_STAGING_NAMESPACE,
      partKey(base, partIndex),
    );
    if (existing !== null) {
      const stored = parseStagedPart(existing, partIndex);
      demand(
        stored.hash === hash && stored.size === size && stored.data === raw,
        "COPY_PART_CONFLICT",
      );
      return { copyId: id, index: partIndex, hash, size };
    }
    const stored: StagedPartRecord = {
      index: partIndex,
      hash,
      size,
      data: raw,
    };
    this.store.set(COPY_STAGING_NAMESPACE, partKey(base, partIndex), stored);
    return { copyId: id, index: partIndex, hash, size };
  }

  inspect(
    auth: AuthContext,
    scope: Scope,
    copyId: string,
  ): SharedCopyInspection {
    const actor = authActor(auth);
    const target = normalizedScope(scope);
    const id = identifier(copyId);
    const base = baseKey(target, actor.writerId, id);
    const record = readManifest(this.store, base, actor, target);
    demand(record.manifest.copyId === id, "COPY_MANIFEST_CONFLICT");
    const parts = stagedParts(
      this.store,
      base,
      record.manifest.parts.length,
    );
    const missingParts: number[] = [];
    for (let index = 0; index < record.manifest.parts.length; index++) {
      const part = parts.get(index);
      if (part === undefined) {
        missingParts.push(index);
        continue;
      }
      const expected = record.manifest.parts[index];
      demand(
        part.hash === expected.hash && part.size === expected.size,
        "COPY_PART_MISMATCH",
      );
    }
    const committed = readCommitted(this.store, base);
    demand(
      committed === null ||
        committed.manifestHash === record.manifestHash,
      "CORRUPT_COPY_STAGING",
    );
    return {
      ...preparedSummary(record.manifest, record.manifestHash),
      stagedParts: parts.size,
      missingParts: committed === null ? missingParts : [],
      committed: committed === null ? null : commitResult(committed),
    };
  }

  commit(
    auth: AuthContext,
    scope: Scope,
    copyId: string,
    manifestHash: string,
  ): SharedCopyCommitResult {
    transactionBound(this.store);
    const actor = authActor(auth);
    const target = normalizedScope(scope);
    const id = identifier(copyId);
    const expectedManifestHash = checkedHash(
      manifestHash,
      "INVALID_COPY_MANIFEST_HASH",
    );
    const base = baseKey(target, actor.writerId, id);
    const record = readManifest(this.store, base, actor, target);
    demand(record.manifest.copyId === id, "COPY_MANIFEST_CONFLICT");
    demand(
      record.manifestHash === expectedManifestHash,
      "COPY_MANIFEST_HASH_MISMATCH",
    );

    const already = readCommitted(this.store, base);
    if (already !== null) {
      demand(
        already.manifestHash === expectedManifestHash,
        "COPY_ALREADY_COMMITTED",
      );
      return commitResult(already);
    }

    const manifest = record.manifest;
    const parts = stagedParts(this.store, base, manifest.parts.length);
    const missingParts: number[] = [];
    for (let index = 0; index < manifest.parts.length; index++) {
      const part = parts.get(index);
      if (part === undefined) {
        missingParts.push(index);
        continue;
      }
      const expected = manifest.parts[index];
      demand(
        part.hash === expected.hash && part.size === expected.size,
        "COPY_PART_MISMATCH",
      );
    }
    demand(missingParts.length === 0, "COPY_PART_MISSING");

    let total = 0;
    for (const part of manifest.parts) total += part.size;
    demand(total <= MAX_COPY_STAGING_SOURCE_BYTES, "COPY_SOURCE_TOO_LARGE");

    const assetSizes = new Map<string, number>();
    for (const asset of manifestAssets(manifest))
      assetSizes.set(asset.hash, asset.size);

    const textBySource: string[] = [];
    let offset = 0;
    for (const source of manifest.sources) {
      const chunks: string[] = [];
      for (let index = 0; index < source.parts; index++) {
        chunks.push(parts.get(offset + index)!.data);
      }
      textBySource.push(chunks.join(""));
      offset += source.parts;
    }
    demand(offset === manifest.parts.length, "COPY_PART_COUNT_MISMATCH");

    const sources = textBySource.map((text, index) =>
      parseSourceJson(text, index, manifest, assetSizes),
    );
    const referencedAssets = [
      ...new Set(
        sources.flatMap((source) =>
          source.assets.map((asset) => asset.hash),
        ),
      ),
    ].sort();
    demand(
      canonical(referencedAssets) ===
        canonical(manifestAssets(manifest).map((asset) => asset.hash)),
      "COPY_ASSET_MISMATCH",
    );
    const resolved = resolveAssets(this.store, target, manifest, this.resolveAsset);
    for (const source of sources) {
      source.assets = source.assets.map((asset) => {
        const bytes = resolved.get(asset.hash);
        demand(bytes !== undefined, "COPY_ASSET_MISSING");
        return { hash: asset.hash, bytes: bytes.slice() };
      });
    }

    let allocated = 0;
    const allocate = (): string => {
      if (allocated >= manifest.allocatedIds.length)
        fail("COPY_ALLOCATION_MISMATCH");
      return manifest.allocatedIds[allocated++];
    };
    const preview = previewSharedCopy(
      sources,
      manifest.selectedIds,
      { orgId: target.orgId, workspaceId: target.workspaceId },
      allocate,
    );
    demand(
      allocated === manifest.allocatedIds.length,
      "COPY_ALLOCATION_MISMATCH",
    );
    demand(
      canonical(preview.scopes.map((entry) => entry.documentId)) ===
        canonical(manifest.allocatedIds),
      "COPY_ALLOCATION_MISMATCH",
    );
    demand(
      preview.fingerprint === manifest.fingerprint,
      "COPY_FINGERPRINT_MISMATCH",
    );

    const scopes = commitSharedCopy(this.store, preview, sources);
    const result: CommittedRecord = {
      v: 1,
      copyId: id,
      manifestHash: expectedManifestHash,
      fingerprint: preview.fingerprint,
      sourceIds: [...manifest.selectedIds],
      allocatedIds: [...manifest.allocatedIds],
      scopes: scopes.map((entry) => ({ ...entry })),
    };
    this.store.set(COPY_STAGING_NAMESPACE, committedKey(base), result);
    // Keep the immutable manifest and consumed pointer for idempotency, but
    // release redundant staged source chunks once publication is durable.
    for (const row of this.store.all(COPY_STAGING_NAMESPACE))
      if (row.key.startsWith(partPrefix(base))) this.store.set(COPY_STAGING_NAMESPACE, row.key, null);
    return commitResult(result);
  }
}

function committedToManifest(
  manifest: SharedCopyManifest,
  committed: CommittedRecord,
): SharedCopyManifest {
  demand(
    committed.copyId === manifest.copyId &&
      committed.fingerprint === manifest.fingerprint &&
      canonical(committed.sourceIds) === canonical(manifest.selectedIds) &&
      canonical(committed.allocatedIds) === canonical(manifest.allocatedIds),
    "COPY_ALREADY_COMMITTED",
  );
  return manifest;
}
