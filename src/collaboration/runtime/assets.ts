import { createHash } from "node:crypto";
import type { Doc } from "../../shared/types";
import { validDocument } from "../../shared/validation";
import {
  CollaborationError,
  identifier,
  safeCounter,
  type Cut,
  type Scope,
} from "./contract";
import { DOCUMENTS_NAMESPACE, HEAD_KEY, META_NAMESPACE } from "./lifecycle";
import type { StoragePort } from "./storage-port";

const MIB = 1024 * 1024;
const MAX_ASSET_BYTES = 20 * MIB;
const MAX_SPACE_BYTES = 100 * MIB;
const MAX_STAGING_BYTES = 100 * MIB;
const MAX_STAGING_UPLOADS = 1024;

const PUBLISHED_NAMESPACE = "asset";
const STAGING_NAMESPACE = "asset.staging";
const HOLDS_NAMESPACE = "asset.holds";

type PublishedRecord = { hash: string; bytes: number; uploads: string[] };
type StagingRecord = { hash: string; bytes: number; published: boolean };
type HoldRecord = { hash: string; holdId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function hashValue(value: unknown): string {
  if (!isHash(value)) throw new CollaborationError("INVALID_HASH");
  return value;
}

function assetKey(scope: Scope): string {
  return identifier(scope.orgId) + ":" + identifier(scope.workspaceId);
}

function blobScope(key: string): string {
  return key;
}

function stagingScope(key: string): string {
  return "stage:" + key;
}

function publishedKey(key: string, hash: string): string {
  return key + ":" + hash;
}

function stagingKey(key: string, uploadId: string): string {
  return key + ":" + uploadId;
}

function holdKey(key: string, hash: string, holdId: string): string {
  return key + ":" + hash + ":" + holdId;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isSafeBytes(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function publishedRecord(value: unknown): PublishedRecord {
  if (
    !isRecord(value) ||
    !isHash(value.hash) ||
    !isSafeBytes(value.bytes) ||
    !Array.isArray(value.uploads) ||
    !value.uploads.every(isIdentifier)
  )
    throw new CollaborationError("CORRUPT_ASSET_META");
  return { hash: value.hash, bytes: value.bytes, uploads: [...value.uploads] };
}

function stagingRecord(value: unknown): StagingRecord {
  if (
    !isRecord(value) ||
    !isHash(value.hash) ||
    !isSafeBytes(value.bytes) ||
    typeof value.published !== "boolean"
  )
    throw new CollaborationError("CORRUPT_STAGING_META");
  return { hash: value.hash, bytes: value.bytes, published: value.published };
}

function holdRecord(value: unknown): HoldRecord {
  if (!isRecord(value) || !isHash(value.hash) || !isIdentifier(value.holdId))
    throw new CollaborationError("CORRUPT_HOLD");
  return { hash: value.hash, holdId: value.holdId };
}

function readPublished(
  store: StoragePort,
  key: string,
  hash: string,
): PublishedRecord | null {
  const raw = store.get(PUBLISHED_NAMESPACE, publishedKey(key, hash));
  if (raw === null) return null;
  const record = publishedRecord(raw);
  if (record.hash !== hash) throw new CollaborationError("CORRUPT_ASSET_META");
  return record;
}

function readStaging(
  store: StoragePort,
  key: string,
  uploadId: string,
): StagingRecord | null {
  const raw = store.get(STAGING_NAMESPACE, stagingKey(key, uploadId));
  return raw === null ? null : stagingRecord(raw);
}

function sameCut(left: Cut, right: Cut): boolean {
  return (
    left.epoch === right.epoch &&
    left.seq === right.seq &&
    left.hash === right.hash
  );
}

function cutValue(value: unknown, code: string): Cut {
  if (!isRecord(value)) throw new CollaborationError(code);
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !["epoch", "seq", "hash"].every((key) => Object.hasOwn(value, key))
  )
    throw new CollaborationError(code);
  try {
    return {
      epoch: identifier(value.epoch),
      seq: safeCounter(value.seq),
      hash: hashValue(value.hash),
    };
  } catch (error) {
    if (error instanceof CollaborationError) throw new CollaborationError(code);
    throw error;
  }
}

function readHead(store: StoragePort): Cut {
  const raw = store.get(META_NAMESPACE, HEAD_KEY);
  if (raw === null) throw new CollaborationError("STALE_CUT");
  return cutValue(raw, "CORRUPT_HEAD");
}

type Usage = {
  hashes: Map<string, number>;
  staged: Map<string, number>;
  stagingCount: number;
};

function usageFor(store: StoragePort, key: string): Usage {
  const hashes = new Map<string, number>();
  const staged = new Map<string, number>();
  const prefix = key + ":";
  const add = (map: Map<string, number>, hash: string, bytes: number) => {
    const existing = map.get(hash);
    if (existing !== undefined && existing !== bytes)
      throw new CollaborationError("CORRUPT_ASSET_META");
    map.set(hash, bytes);
  };
  for (const entry of store.all(PUBLISHED_NAMESPACE)) {
    if (!entry.key.startsWith(prefix)) continue;
    const hash = entry.key.slice(prefix.length);
    if (!isHash(hash)) throw new CollaborationError("CORRUPT_ASSET_META");
    const record = publishedRecord(entry.value);
    if (record.hash !== hash)
      throw new CollaborationError("CORRUPT_ASSET_META");
    add(hashes, hash, record.bytes);
  }
  let stagingCount = 0;
  for (const entry of store.all(STAGING_NAMESPACE)) {
    if (!entry.key.startsWith(prefix)) continue;
    const uploadId = entry.key.slice(prefix.length);
    if (!isIdentifier(uploadId))
      throw new CollaborationError("CORRUPT_STAGING_META");
    const record = stagingRecord(entry.value);
    if (record.published) continue;
    stagingCount++;
    add(staged, record.hash, record.bytes);
  }
  for (const [hash, bytes] of staged) add(hashes, hash, bytes);
  return { hashes, staged, stagingCount };
}

function isDoc(value: unknown): value is Doc {
  return isRecord(value) && typeof value.type === "string";
}

function checkReference(value: unknown, keep: Set<string>): void {
  if (typeof value !== "string" || !value.startsWith("folio-asset://")) return;
  let id = value.slice("folio-asset://".length);
  if (id.endsWith("/")) id = id.slice(0, -1);
  if (!isHash(id)) throw new CollaborationError("UNKNOWN_REFERENCE");
  keep.add(id);
}

function scanReferences(node: Doc, keep: Set<string>): void {
  if (isRecord(node.attrs))
    for (const value of Object.values(node.attrs)) checkReference(value, keep);
  if (Array.isArray(node.marks))
    for (const mark of node.marks) {
      if (!isRecord(mark)) throw new CollaborationError("UNKNOWN_REFERENCE");
      if (isRecord(mark.attrs))
        for (const value of Object.values(mark.attrs))
          checkReference(value, keep);
    }
  if (node.content !== undefined) {
    if (!Array.isArray(node.content))
      throw new CollaborationError("UNKNOWN_REFERENCE");
    for (const child of node.content) {
      if (!isDoc(child)) throw new CollaborationError("UNKNOWN_REFERENCE");
      scanReferences(child, keep);
    }
  }
}

function documentScope(rawKey: string): Scope {
  const parts = rawKey.split(":");
  if (parts.length !== 4 || !parts.every(isIdentifier))
    throw new CollaborationError("CORRUPT_DOCUMENT_KEY");
  return {
    orgId: parts[0],
    workspaceId: parts[1],
    documentId: parts[2],
    incarnationId: parts[3],
  };
}

function stateDocument(value: unknown): Doc {
  if (!isRecord(value)) throw new CollaborationError("CORRUPT_DOCUMENT");
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !["document", "tables", "tombstones"].every((key) =>
      Object.hasOwn(value, key),
    ) ||
    !Array.isArray(value.tables) ||
    !Array.isArray(value.tombstones)
  )
    throw new CollaborationError("CORRUPT_DOCUMENT");
  const document = value.document;
  if (!isDoc(document) || !validDocument(document))
    throw new CollaborationError("CORRUPT_DOCUMENT");
  return document;
}

export class SharedAssets {
  constructor(private readonly store: StoragePort) {}

  stage(
    scope: Scope,
    uploadId: string,
    bytes: Uint8Array,
  ): { hash: string; bytes: number } {
    const key = assetKey(scope);
    const upload = identifier(uploadId);
    if (!(bytes instanceof Uint8Array))
      throw new CollaborationError("INVALID_BYTES");
    if (bytes.byteLength > MAX_ASSET_BYTES)
      throw new CollaborationError("ASSET_TOO_LARGE");
    const copy = bytes.slice();
    const hash = sha256(copy);
    const size = copy.byteLength;
    return this.store.transaction(() => {
      const existing = readStaging(this.store, key, upload);
      if (existing !== null) {
        if (existing.hash !== hash || existing.bytes !== size)
          throw new CollaborationError("UPLOAD_CONFLICT");
        if (existing.published) return { hash, bytes: size };
        const stored = this.store.blobGet(stagingScope(key), hash);
        if (stored !== null) {
          if (stored.byteLength !== size || sha256(stored) !== hash)
            throw new CollaborationError("STAGING_TAMPERED");
        } else {
          this.store.blobPut(stagingScope(key), hash, copy);
        }
        return { hash, bytes: size };
      }
      const usage = usageFor(this.store, key);
      const total = [...usage.hashes.values()].reduce(
        (sum, value) => sum + value,
        0,
      );
      if (!usage.hashes.has(hash) && total + size > MAX_SPACE_BYTES)
        throw new CollaborationError("QUOTA_EXCEEDED");
      if (!usage.staged.has(hash)) {
        const stagingBytes = [...usage.staged.values()].reduce(
          (sum, value) => sum + value,
          0,
        );
        if (stagingBytes + size > MAX_STAGING_BYTES)
          throw new CollaborationError("STAGING_QUOTA_EXCEEDED");
      }
      if (usage.stagingCount >= MAX_STAGING_UPLOADS)
        throw new CollaborationError("STAGING_LIMIT");
      const stored = this.store.blobGet(stagingScope(key), hash);
      if (stored !== null) {
        if (stored.byteLength !== size || sha256(stored) !== hash)
          throw new CollaborationError("STAGING_TAMPERED");
      } else {
        this.store.blobPut(stagingScope(key), hash, copy);
      }
      this.store.set(STAGING_NAMESPACE, stagingKey(key, upload), {
        hash,
        bytes: size,
        published: false,
      });
      return { hash, bytes: size };
    });
  }

  publish(
    scope: Scope,
    uploadId: string,
    expectedHash: string,
  ): { hash: string; bytes: number } {
    const key = assetKey(scope);
    const upload = identifier(uploadId);
    const expected = hashValue(expectedHash);
    return this.store.transaction(() => {
      const staged = readStaging(this.store, key, upload);
      if (staged === null) throw new CollaborationError("UPLOAD_NOT_FOUND");
      if (staged.hash !== expected)
        throw new CollaborationError("UPLOAD_HASH_MISMATCH");
      const existing = readPublished(this.store, key, expected);
      if (staged.published) {
        if (existing === null)
          throw new CollaborationError("PUBLISHED_MISSING");
        if (existing.bytes !== staged.bytes)
          throw new CollaborationError("CORRUPT_ASSET_META");
        if (!existing.uploads.includes(upload)) {
          existing.uploads.push(upload);
          this.store.set(
            PUBLISHED_NAMESPACE,
            publishedKey(key, expected),
            existing,
          );
        }
        return { hash: expected, bytes: existing.bytes };
      }
      if (existing !== null) {
        if (existing.bytes !== staged.bytes)
          throw new CollaborationError("CORRUPT_ASSET_META");
        const publishedBlob = this.store.blobGet(blobScope(key), expected);
        if (publishedBlob === null)
          throw new CollaborationError("PUBLISHED_MISSING");
        const publishedCopy = publishedBlob.slice();
        if (
          publishedCopy.byteLength !== existing.bytes ||
          sha256(publishedCopy) !== expected
        )
          throw new CollaborationError("ASSET_TAMPERED");
      }
      const stagedBlob = this.store.blobGet(stagingScope(key), expected);
      if (stagedBlob !== null) {
        const copy = stagedBlob.slice();
        if (copy.byteLength !== staged.bytes || sha256(copy) !== expected)
          throw new CollaborationError("STAGING_TAMPERED");
        if (existing === null)
          this.store.blobPut(blobScope(key), expected, copy);
      } else if (existing === null) {
        throw new CollaborationError("STAGING_MISSING");
      }
      if (existing === null) {
        this.store.set(PUBLISHED_NAMESPACE, publishedKey(key, expected), {
          hash: expected,
          bytes: staged.bytes,
          uploads: [upload],
        });
      } else if (!existing.uploads.includes(upload)) {
        existing.uploads.push(upload);
        this.store.set(
          PUBLISHED_NAMESPACE,
          publishedKey(key, expected),
          existing,
        );
      }
      this.store.blobDelete(stagingScope(key), expected);
      this.store.set(STAGING_NAMESPACE, stagingKey(key, upload), {
        hash: expected,
        bytes: staged.bytes,
        published: true,
      });
      return { hash: expected, bytes: staged.bytes };
    });
  }

  readStaged(scope: Scope, uploadId: string, hash: string): Uint8Array {
    const key = assetKey(scope), expected = hashValue(hash);
    const staged = readStaging(this.store, key, identifier(uploadId));
    if (!staged || staged.hash !== expected) throw new CollaborationError("UPLOAD_NOT_FOUND");
    if (staged.published) return this.read(scope, expected);
    const bytes = this.store.blobGet(stagingScope(key), expected);
    if (!bytes) return this.read(scope, expected);
    if (bytes.length !== staged.bytes || sha256(bytes) !== expected) throw new CollaborationError("STAGING_TAMPERED");
    return bytes.slice();
  }
  read(scope: Scope, hash: string): Uint8Array {
    const key = assetKey(scope);
    const expected = hashValue(hash);
    return this.store.transaction(() => {
      const record = readPublished(this.store, key, expected);
      if (record === null) throw new CollaborationError("ASSET_NOT_FOUND");
      const blob = this.store.blobGet(blobScope(key), expected);
      if (blob === null) throw new CollaborationError("ASSET_MISSING");
      const copy = blob.slice();
      if (copy.byteLength !== record.bytes || sha256(copy) !== expected)
        throw new CollaborationError("ASSET_TAMPERED");
      return copy;
    });
  }

  hold(scope: Scope, hash: string, holdId: string): void {
    const key = assetKey(scope);
    const expected = hashValue(hash);
    const id = identifier(holdId);
    this.store.transaction(() => {
      this.store.set(HOLDS_NAMESPACE, holdKey(key, expected, id), {
        hash: expected,
        holdId: id,
      });
    });
  }

  releaseHold(scope: Scope, hash: string, holdId: string): void {
    const key = assetKey(scope);
    const expected = hashValue(hash);
    const id = identifier(holdId);
    this.store.transaction(() => {
      const record = this.store.get(
        HOLDS_NAMESPACE,
        holdKey(key, expected, id),
      );
      if (record !== null) {
        const held = holdRecord(record);
        if (held.hash !== expected || held.holdId !== id)
          throw new CollaborationError("CORRUPT_HOLD");
        this.store.set(HOLDS_NAMESPACE, holdKey(key, expected, id), null);
      }
    });
  }

  collect(
    scope: Scope,
    referencedHashes: readonly string[],
    expectedCut: Cut,
  ): { removed: string[]; bytes: number } {
    const key = assetKey(scope);
    const orgId = identifier(scope.orgId);
    const workspaceId = identifier(scope.workspaceId);
    const expected = cutValue(expectedCut, "INVALID_CUT");
    if (!Array.isArray(referencedHashes))
      throw new CollaborationError("INVALID_REFERENCE");
    const keep = new Set<string>();
    for (const hash of referencedHashes) keep.add(hashValue(hash));
    return this.store.transaction(() => {
      const head = readHead(this.store);
      if (!sameCut(head, expected)) throw new CollaborationError("STALE_CUT");
      const holdPrefix = key + ":";
      for (const entry of this.store.all(HOLDS_NAMESPACE)) {
        if (!entry.key.startsWith(holdPrefix)) continue;
        const rest = entry.key.slice(holdPrefix.length);
        const parts = rest.split(":");
        if (parts.length !== 2) throw new CollaborationError("UNKNOWN_HOLD");
        const hash = hashValue(parts[0]);
        const holdId = identifier(parts[1]);
        const held = holdRecord(entry.value);
        if (held.hash !== hash || held.holdId !== holdId)
          throw new CollaborationError("UNKNOWN_HOLD");
        keep.add(hash);
      }
      for (const entry of this.store.all(DOCUMENTS_NAMESPACE)) {
        const owner = documentScope(entry.key);
        if (owner.orgId !== orgId || owner.workspaceId !== workspaceId)
          continue;
        scanReferences(stateDocument(entry.value), keep);
      }
      const published: PublishedRecord[] = [];
      for (const entry of this.store.all(PUBLISHED_NAMESPACE)) {
        if (!entry.key.startsWith(publishedKey(key, ""))) continue;
        const hash = entry.key.slice(key.length + 1);
        if (!isHash(hash)) throw new CollaborationError("CORRUPT_ASSET_META");
        const record = publishedRecord(entry.value);
        if (record.hash !== hash)
          throw new CollaborationError("CORRUPT_ASSET_META");
        published.push(record);
      }
      const removed: string[] = [];
      let bytes = 0;
      for (const record of published) {
        if (keep.has(record.hash)) continue;
        this.store.blobDelete(blobScope(key), record.hash);
        this.store.set(
          PUBLISHED_NAMESPACE,
          publishedKey(key, record.hash),
          null,
        );
        removed.push(record.hash);
        bytes += record.bytes;
      }
      removed.sort();
      return { removed, bytes };
    });
  }
}
