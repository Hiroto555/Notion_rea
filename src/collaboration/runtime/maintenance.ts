import {
  CollaborationError,
  identifier,
  wellFormed,
  type AuthContext,
  type Cut,
  type Json,
  type Scope,
} from "./contract";
import type { Overview } from "./operations";
import type {
  BackupVerification,
  CompactResult,
  RetentionInspection,
} from "./retention";
import type { RuntimeStore } from "./store";
import type { StoragePort } from "./storage-port";

const ASSET_NAMESPACE = "asset";
const STAGING_NAMESPACE = "asset.staging";
const HOLDS_NAMESPACE = "asset.holds";
const META_NAMESPACE = "meta";
const HEAD_KEY = "head";
const FENCES_NAMESPACE = "operations.fences";
const UPGRADES_NAMESPACE = "operations.upgrades";
const ASSET_PREFIX = "folio-asset://";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SKIP_REFERENCE_SCAN = new Set([
  ASSET_NAMESPACE,
  STAGING_NAMESPACE,
  HOLDS_NAMESPACE,
]);

type PublishedRecord = Readonly<{
  hash: string;
  bytes: number;
  uploads: readonly string[];
}>;

export type AssetCollectionPreview = Readonly<{
  scope: Readonly<{ orgId: string; workspaceId: string }>;
  cut: Cut;
  referenced: readonly string[];
  held: readonly string[];
  published: number;
  unreferenced: readonly string[];
  bytes: number;
}>;

export type AssetCollectionResult = Readonly<{
  removed: readonly string[];
  bytes: number;
  baseCut: Cut;
}>;

export type MaintenancePreview = Readonly<{
  cut: Cut;
  retention: RetentionInspection;
  overview: Overview;
  writerFenced: boolean;
}>;

export interface MaintenanceAuthority {
  readonly store: RuntimeStore;
  readonly operations: {
    overview(auth: AuthContext, orgId: string): Overview;
  };
  readonly policy: {
    authorize(
      auth: AuthContext,
      scope: Scope,
      action: "read" | "write" | "manage" | "audit",
    ): void;
  };
  collectAssetPlan(token: string, scope: Scope, cut: Cut, expected: readonly string[]): AssetCollectionResult;
  session(token: string, orgId: string): AuthContext;
  head(): Cut;
  retention(token: string, orgId: string): {
    inspect(): RetentionInspection;
    verifyBackup(
      cut: Cut,
      destination: StoragePort,
      newEpoch: string,
    ): BackupVerification;
    compact(cut: Cut, verification: BackupVerification): CompactResult;
  };

}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!isRecord(value)) throw new CollaborationError(code);
  return value;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: string,
): Record<string, unknown> {
  const entry = record(value, code);
  const actual = Object.keys(entry).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    !actual.every((key, index) => key === expected[index])
  )
    throw new CollaborationError(code);
  return entry;
}

function hashValue(value: unknown, code = "INVALID_HASH"): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value))
    throw new CollaborationError(code);
  return value;
}

function idValue(value: unknown, code = "INVALID_ID"): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value))
    throw new CollaborationError(code);
  return value;
}

function counterValue(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new CollaborationError(code);
  return Number(value);
}

function cutValue(value: unknown, code = "INVALID_CUT"): Cut {
  const entry = exactRecord(value, ["epoch", "seq", "hash"], code);
  return {
    epoch: idValue(entry.epoch, code),
    seq: counterValue(entry.seq, code),
    hash: hashValue(entry.hash, code),
  };
}

function scopeValue(value: unknown): Scope {
  const entry = exactRecord(
    value,
    ["orgId", "workspaceId", "documentId", "incarnationId"],
    "INVALID_SCOPE",
  );
  return {
    orgId: identifier(entry.orgId),
    workspaceId: identifier(entry.workspaceId),
    documentId: identifier(entry.documentId),
    incarnationId: identifier(entry.incarnationId),
  };
}

function sameCut(left: Cut, right: Cut): boolean {
  return (
    left.epoch === right.epoch &&
    left.seq === right.seq &&
    left.hash === right.hash
  );
}

function readHead(store: RuntimeStore): Cut {
  const value = store.get(META_NAMESPACE, HEAD_KEY);
  if (value === null) throw new CollaborationError("HEAD_MISSING");
  return cutValue(value, "CORRUPT_HEAD");
}

function allNamespaces(store: RuntimeStore): string[] {
  const rows = store.db
    .prepare(
      "SELECT DISTINCT namespace FROM runtime_records ORDER BY namespace",
    )
    .all() as Record<string, unknown>[];
  return rows.map((row) => {
    if (
      typeof row.namespace !== "string" ||
      row.namespace.length === 0 ||
      !wellFormed(row.namespace)
    )
      throw new CollaborationError("CORRUPT_STORAGE");
    return row.namespace;
  });
}

function scanReferences(value: unknown, keep: Set<string>): void {
  if (typeof value === "string") {
    if (!value.startsWith(ASSET_PREFIX)) {
      if (value.includes(ASSET_PREFIX)) {
        try { scanReferences(JSON.parse(value), keep); }
        catch { throw new CollaborationError("UNKNOWN_REFERENCE"); }
      }
      return;
    }
    let hash = value.slice(ASSET_PREFIX.length);
    if (hash.endsWith("/")) hash = hash.slice(0, -1);
    if (!HASH_PATTERN.test(hash))
      throw new CollaborationError("UNKNOWN_REFERENCE");
    keep.add(hash);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) scanReferences(item, keep);
    return;
  }
  if (isRecord(value))
    for (const item of Object.values(value)) scanReferences(item, keep);
}

function publishedRecord(value: unknown): PublishedRecord {
  const entry = exactRecord(
    value,
    ["hash", "bytes", "uploads"],
    "CORRUPT_ASSET_META",
  );
  const hash = hashValue(entry.hash, "CORRUPT_ASSET_META");
  const bytes = counterValue(entry.bytes, "CORRUPT_ASSET_META");
  if (
    !Array.isArray(entry.uploads) ||
    !entry.uploads.every(
      (upload) => typeof upload === "string" && ID_PATTERN.test(upload),
    )
  )
    throw new CollaborationError("CORRUPT_ASSET_META");
  return { hash, bytes, uploads: [...entry.uploads] as string[] };
}

function readPublished(
  store: RuntimeStore,
  key: string,
): Map<string, PublishedRecord> {
  const prefix = key + ":";
  const published = new Map<string, PublishedRecord>();
  for (const entry of store.all(ASSET_NAMESPACE)) {
    if (!entry.key.startsWith(prefix)) continue;
    const hash = entry.key.slice(prefix.length);
    hashValue(hash, "CORRUPT_ASSET_META");
    const record = publishedRecord(entry.value);
    if (record.hash !== hash)
      throw new CollaborationError("CORRUPT_ASSET_META");
    const blob = store.blobGet(key, hash);
    if (blob === null) throw new CollaborationError("ASSET_MISSING");
    if (blob.byteLength !== record.bytes)
      throw new CollaborationError("ASSET_TAMPERED");
    published.set(hash, record);
  }
  return published;
}

function readHeld(store: RuntimeStore, key: string): Set<string> {
  const prefix = key + ":";
  const held = new Set<string>();
  for (const entry of store.all(HOLDS_NAMESPACE)) {
    if (!entry.key.startsWith(prefix)) continue;
    const parts = entry.key.slice(prefix.length).split(":");
    if (parts.length !== 2)
      throw new CollaborationError("CORRUPT_HOLD");
    const hash = hashValue(parts[0], "CORRUPT_HOLD");
    const holdId = idValue(parts[1], "CORRUPT_HOLD");
    const record = exactRecord(
      entry.value,
      ["hash", "holdId"],
      "CORRUPT_HOLD",
    );
    if (record.hash !== hash || record.holdId !== holdId)
      throw new CollaborationError("CORRUPT_HOLD");
    held.add(hash);
  }
  return held;
}

function buildAssetPreview(
  store: RuntimeStore,
  scope: Scope,
  expectedCut?: Cut,
): AssetCollectionPreview {
  const orgId = identifier(scope.orgId);
  const workspaceId = identifier(scope.workspaceId);
  const key = orgId + ":" + workspaceId;
  const cut = readHead(store);
  if (expectedCut !== undefined && !sameCut(cut, cutValue(expectedCut)))
    throw new CollaborationError("STALE_CUT");

  const referenced = new Set<string>();
  for (const namespace of allNamespaces(store)) {
    if (SKIP_REFERENCE_SCAN.has(namespace)) continue;
    for (const entry of store.all(namespace))
      scanReferences(entry.value, referenced);
  }
  const held = readHeld(store, key);
  const published = readPublished(store, key);
  const keep = new Set<string>([...referenced, ...held]);
  const unreferenced = [...published.keys()]
    .filter((hash) => !keep.has(hash))
    .sort();
  let bytes = 0;
  for (const hash of unreferenced)
    bytes += published.get(hash)?.bytes ?? 0;
  return {
    scope: { orgId, workspaceId },
    cut,
    referenced: [...referenced].sort(),
    held: [...held].sort(),
    published: published.size,
    unreferenced,
    bytes,
  };
}

function expectedHashes(value: readonly string[]): string[] {
  if (!Array.isArray(value))
    throw new CollaborationError("INVALID_REFERENCE");
  const hashes = value.map((hash) => hashValue(hash));
  const sorted = [...new Set(hashes)].sort();
  if (sorted.length !== hashes.length)
    throw new CollaborationError("DUPLICATE_REFERENCE");
  return sorted;
}

function sameHashes(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((hash, index) => hash === right[index])
  );
}

function assertBackupVerification(
  value: unknown,
): asserts value is BackupVerification {
  const entry = exactRecord(
    value,
    ["v", "backupHash", "cut", "restoreEpoch", "restoreCut"],
    "BACKUP_NOT_VERIFIED",
  );
  if (entry.v !== 1) throw new CollaborationError("BACKUP_NOT_VERIFIED");
  hashValue(entry.backupHash, "BACKUP_NOT_VERIFIED");
  cutValue(entry.cut, "BACKUP_NOT_VERIFIED");
  idValue(entry.restoreEpoch, "BACKUP_NOT_VERIFIED");
  cutValue(entry.restoreCut, "BACKUP_NOT_VERIFIED");
}

function writerFenced(store: RuntimeStore): boolean {
  for (const row of store.all(FENCES_NAMESPACE)) {
    const entry = record(row.value, "CORRUPT_FENCE");
    if (typeof entry.readOnly !== "boolean")
      throw new CollaborationError("CORRUPT_FENCE");
    if (entry.readOnly) return true;
  }
  for (const row of store.all(UPGRADES_NAMESPACE)) {
    const entry = record(row.value, "CORRUPT_UPGRADE");
    if (
      entry.status === "ACTIVE" ||
      entry.status === "RECOVERY_REQUIRED"
    )
      return true;
    if (entry.status !== "COMMITTED")
      throw new CollaborationError("CORRUPT_UPGRADE");
  }
  return false;
}

export class SharedMaintenance {
  constructor(private readonly authority: MaintenanceAuthority) {
    if (!authority || typeof authority !== "object")
      throw new CollaborationError("INVALID_AUTHORITY");
  }

  preview(token: string, orgId: string): MaintenancePreview {
    const org = identifier(orgId);
    const auth = this.authority.session(token, org);
    const retention = this.authority.retention(token, org).inspect();
    const overview = this.authority.operations.overview(auth, org);
    return {
      cut: this.authority.head(),
      retention,
      overview,
      writerFenced: writerFenced(this.authority.store),
    };
  }

  verify(
    token: string,
    orgId: string,
    destination: RuntimeStore,
    newEpoch: string,
  ): BackupVerification {
    const org = identifier(orgId);
    this.authority.session(token, org);
    if (destination === this.authority.store)
      throw new CollaborationError("DESTINATION_NOT_ISOLATED");
    if (destination.path === this.authority.store.path)
      throw new CollaborationError("DESTINATION_NOT_ISOLATED");
    const cut = this.authority.head();
    return this.authority
      .retention(token, org)
      .verifyBackup(cut, destination, identifier(newEpoch));
  }

  compact(
    token: string,
    orgId: string,
    proof: BackupVerification,
  ): CompactResult {
    const org = identifier(orgId);
    this.authority.session(token, org);
    assertBackupVerification(proof);
    return this.authority
      .retention(token, org)
      .compact(proof.cut, proof);
  }

  collectPreview(token: string, scope: Scope): AssetCollectionPreview {
    const checked = scopeValue(scope);
    const auth = this.authority.session(token, checked.orgId);
    this.authority.policy.authorize(auth, checked, "manage");
    return buildAssetPreview(this.authority.store, checked);
  }

  collect(
    token: string,
    scope: Scope,
    expectedCut: Cut,
    expected: readonly string[],
  ): AssetCollectionResult {
    const checked = scopeValue(scope);
    const cut = cutValue(expectedCut);
    const hashes = expectedHashes(expected);
    if (hashes.length === 0)
      throw new CollaborationError("EMPTY_COLLECT_PLAN");
    return this.authority.collectAssetPlan(token, checked, cut, hashes);
  }
}

/** Called only inside the authority's authenticated control transaction. */
export function executeAssetCollection(
  store: RuntimeStore,
  assets: { collect(scope: Scope, references: readonly string[], cut: Cut): { removed: string[]; bytes: number } },
  scope: Scope, cut: Cut, expected: readonly string[],
): AssetCollectionResult {
  const hashes = expectedHashes(expected);
  const preview = buildAssetPreview(store, scope, cut);
  if (!sameHashes(preview.unreferenced, hashes)) throw new CollaborationError("COLLECT_PLAN_MISMATCH");
  const result = assets.collect(scope, [...new Set([...preview.referenced, ...preview.held])], cut);
  const removed = [...result.removed].sort();
  if (!sameHashes(removed, hashes)) throw new CollaborationError("COLLECT_RESULT_MISMATCH");
  return { removed, bytes: result.bytes, baseCut: { ...cut } };
}
