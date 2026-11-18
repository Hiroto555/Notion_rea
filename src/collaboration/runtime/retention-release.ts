import { createHash, randomUUID } from "node:crypto";
import { dirname, sep } from "node:path";
import { types } from "node:util";
import { synchronousPort } from "../../platform/synchronous-port";
import { canonical } from "./canonical";
import {
  CollaborationError,
  identifier,
  sameScope,
  type Attempt,
  type AuthContext,
  type Cut,
  type Receipt,
  type Scope,
} from "./contract";
import { digest } from "./digest";
import { SharedAssets } from "./assets";
import { DocumentLifecycle } from "./lifecycle";
import { readRuntimeProtocol } from "./protocol-migration";
import {
  inspectRetentionDependencies,
  retentionInventoryScanNodes,
  retentionNamespaceContract,
  RETENTION_AUTHORITY_STORE_ID,
  RETENTION_RELEASES_NAMESPACE,
  RETENTION_RECOVERY_NAMESPACE,
  type RetentionDependencyInventory,
  type RetentionDependencyLimits,
  type RetentionReclamationPlan,
  type RetentionReleaseEnvironment,
} from "./retention-dependencies";
import type { RuntimeStore } from "./store";
import type { StoragePort } from "./storage-port";
import { parseCut, parseScope } from "./wire";

/**
 * Bounded explicit release of asset.holds rows. The release is only allowed
 * after a durable, hash-bound recovery artifact exists in an isolated
 * RuntimeStore and the whole product surface (authority plus every store and
 * live-history root the trusted host environment enumerates) still matches
 * the fingerprint that was previewed and exported.
 *
 * Trusted boundary: the environment port is configured host integration and
 * is never serialized caller input. A missing port, an unaccounted store, a
 * non-quiescent live history, an unclassified namespace, or an unresolved
 * PREPARED/UNKNOWN attempt fails closed with NO source mutations.
 *
 * Retained obligations: raw/intent/attempt/receipt/undo records are never
 * touched; the release record under retention.releases preserves the exact
 * original hold rows and folio-asset:// references so the existing
 * SharedMaintenance.collect reference scan keeps protecting the assets.
 * bytesReclaimed and assetsDeleted are always 0: only hold rows are removed.
 */

const HASH = /^[a-f0-9]{64}$/;
const ASSET_URI = "folio-asset://";
const HOLDS_NAMESPACE = "asset.holds";
const ASSET_NAMESPACE = "asset";
const META_NAMESPACE = "meta";
const ROLE_KEY = "role";
const HEAD_KEY = "head";
const RECOVERY_ROLE = "retention-recovery";
const RECOVERY_BLOB_SCOPE = "retention-recovery";
const ARTIFACT_KIND = "retention.release";

const MAX_SELECTED_HOLDS = 32;
const MAX_COVERAGE_STORES = 16;
const MAX_ARTIFACT_BYTES = 8_000_000;
const MAX_LIVE_ROOT_BYTES = 2_000_000;
const MAX_TOTAL_ROWS = 10_000;
const MAX_TOTAL_RECORD_BYTES = 8_000_000;
const MAX_TOTAL_REFERENCES = 20_000;
const AUDIT_PUBLISHER_CONTRACT = {
  stageAsset: { result: "object" }, submit: { result: "object" },
} as const;

export interface RetentionArtifactStore extends StoragePort {
  readonly path: string;
}

export type RetentionHoldSelection = Readonly<{
  hash: string;
  holdId: string;
}>;

export type RetentionReleaseRequest = Readonly<{
  scope: Scope;
  expectedCut: Cut;
  holds: readonly RetentionHoldSelection[];
}>;

export type RetentionStoreSummary = Readonly<{
  id: string;
  kind: "runtime" | "retain-only";
  cut: Cut | null;
  fingerprint: string;
}>;

export type RetentionReleasePreview = Readonly<{
  actor: AuthContext;
  scope: Scope;
  cut: Cut;
  combinedFingerprint: string | null;
  holds: readonly Readonly<{
    hash: string;
    holdId: string;
    key: string;
    present: boolean;
    recordHash: string | null;
  }>[];
  stores: readonly RetentionStoreSummary[];
  liveHistory:
    | Readonly<{ status: "QUIESCENT"; generation: string; rootsHash: string }>
    | Readonly<{ status: "UNAVAILABLE" }>;
  blocks: readonly string[];
  releasable: boolean;
  recovery: Readonly<{
    obligation: "EXPLICIT_HOLD";
    holdsSelected: number;
    assetsPreserved: number;
    assetBytes: number;
    bytesReclaimed: 0;
    assetsDeleted: 0;
  }>;
}>;

export type RetentionReleaseArtifactResult = Readonly<{
  artifactHash: string;
  fingerprint: string;
  cut: Cut;
  scope: Scope;
  actor: AuthContext;
  holds: readonly RetentionHoldSelection[];
  assets: readonly Readonly<{ hash: string; uri: string; bytes: number }>[];
  manifestBytes: number;
  blobBytes: number;
  verification: "READBACK_VERIFIED";
}>;

export type RetentionAuditReference = Readonly<{
  hash: string;
  uri: string;
  uploadId: string;
  attemptId: string;
  cut: Cut;
}>;

export type RetentionReleaseResult = Readonly<{
  artifactHash: string;
  fingerprint: string;
  /** The committed rooted audit cut — the authority head after release. */
  cut: Cut;
  /** The requested base cut the audit commit was rooted at. */
  sourceCut: Cut;
  scope: Scope;
  released: readonly RetentionHoldSelection[];
  bytesReclaimed: 0;
  assetsDeleted: 0;
  releaseRecord: string;
  audit: RetentionAuditReference;
}>;

/** The minimum authority surface the release backend needs. */
export interface RetentionReleaseAuthority {
  readonly store: RuntimeStore;
  session(token: string, orgId: string): AuthContext;
  retentionDependencies(
    token: string,
    orgId: string,
    expectedCut: Cut,
    limits?: RetentionDependencyLimits,
  ): RetentionReclamationPlan;
  readonly operations: {
    assertWriter(version: number): void;
  };
  readonly policy: {
    authorize(
      auth: AuthContext,
      scope: Scope,
      action: "read" | "write" | "manage" | "audit",
    ): void;
  };
  head(): Cut;
  verify(): void;
  /**
   * Audited asset staging + commit used by the rooted release receipt.
   * Optional so narrow maintenance surfaces stay assignable; a missing
   * audited path fails closed with RETENTION_AUDIT_UNAVAILABLE.
   */
  stageAsset?(
    token: string,
    scope: Scope,
    uploadId: string,
    bytes: Uint8Array,
  ): { hash: string; bytes: number };
  submit?(token: string, attempt: Attempt): Receipt;
}

type Request = Readonly<{
  scope: Scope;
  cut: Cut;
  holds: readonly RetentionHoldSelection[];
}>;

type ResolvedHold = Readonly<{
  hash: string;
  holdId: string;
  key: string;
  record: Readonly<{ hash: string; holdId: string }> | null;
}>;

type AssetCopy = Readonly<{
  hash: string;
  bytes: number;
  record: PublishedAsset;
  data: Uint8Array;
}>;
type PublishedAsset = Readonly<{ hash: string; bytes: number; uploads: readonly string[] }>;

type RuntimeEntry = Readonly<{ id: string; store: RuntimeStore }>;
type RetainOnlyEntry = Readonly<{
  id: string;
  generation: string;
  fingerprint: string;
  statistics?: Readonly<{ rows: number; bytes: number; nodes: number }>;
}>;

type ParsedCoverage = Readonly<{
  storeIds: readonly string[];
  runtime: readonly RuntimeEntry[];
  retainOnly: readonly RetainOnlyEntry[];
  liveGeneration: string;
  liveRootsHash: string;
}>;

type Assessment = Readonly<{
  fingerprint: string;
  stores: readonly RetentionStoreSummary[];
  live: Readonly<{
    status: "QUIESCENT";
    generation: string;
    rootsHash: string;
  }>;
  blocks: readonly string[];
}>;

type ManifestHold = Readonly<{
  key: string;
  hash: string;
  holdId: string;
  record: Readonly<{ hash: string; holdId: string }>;
}>;

type ManifestAsset = Readonly<{
  hash: string;
  uri: string;
  bytes: number;
  record: PublishedAsset;
}>;

type ManifestBody = Readonly<{
  v: 1;
  kind: typeof ARTIFACT_KIND;
  scope: Scope;
  cut: Cut;
  actor: AuthContext;
  fingerprint: string;
  coverage: Readonly<{
    storeIds: readonly string[];
    stores: readonly RetentionStoreSummary[];
    liveGeneration: string;
    liveRootsHash: string;
  }>;
  holds: readonly ManifestHold[];
  assets: readonly ManifestAsset[];
}>;

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

function field(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key)
    ? value[key]
    : undefined;
}

function hashValue(value: unknown, code = "INVALID_HASH"): string {
  if (typeof value !== "string" || !HASH.test(value))
    throw new CollaborationError(code);
  return value;
}

function counterValue(value: unknown, code: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 0
  )
    throw new CollaborationError(code);
  return number;
}

function sameCut(left: Cut, right: Cut): boolean {
  return (
    left.epoch === right.epoch &&
    left.seq === right.seq &&
    left.hash === right.hash
  );
}

function sameActor(left: AuthContext, right: AuthContext): boolean {
  return (
    left.userId === right.userId &&
    left.deviceId === right.deviceId &&
    left.writerId === right.writerId &&
    left.sessionId === right.sessionId
  );
}

function thenable(value: unknown): boolean {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  )
    return false;
  const then = (value as { then?: unknown }).then;
  return typeof then === "function";
}

/** Structural check: the environment must hand us real RuntimeStore objects. */
function runtimeStore(value: unknown, code: string): RuntimeStore {
  const store = value as RuntimeStore | null;
  if (
    !store ||
    typeof store !== "object" ||
    typeof store.path !== "string" ||
    store.path.length === 0 ||
    !store.db ||
    typeof store.db !== "object" ||
    typeof store.get !== "function" ||
    typeof store.set !== "function" ||
    typeof store.all !== "function" ||
    typeof store.transaction !== "function" ||
    typeof store.blobGet !== "function" ||
    typeof store.blobPut !== "function"
  )
    throw new CollaborationError(code);
  return store;
}

function holdKey(scope: Scope, hash: string, holdId: string): string {
  return (
    scope.orgId + ":" + scope.workspaceId + ":" + hash + ":" + holdId
  );
}

function assetKey(scope: Scope): string {
  return scope.orgId + ":" + scope.workspaceId;
}

function holdRecord(value: unknown): { hash: string; holdId: string } {
  const entry = exactRecord(value, ["hash", "holdId"], "CORRUPT_HOLD");
  return {
    hash: hashValue(field(entry, "hash"), "CORRUPT_HOLD"),
    holdId: identifier(field(entry, "holdId")),
  };
}

function assetRecord(value: unknown): PublishedAsset {
  const entry = exactRecord(
    value,
    ["hash", "bytes", "uploads"],
    "CORRUPT_ASSET_META",
  );
  const hash = hashValue(field(entry, "hash"), "CORRUPT_ASSET_META");
  const bytes = counterValue(field(entry, "bytes"), "CORRUPT_ASSET_META");
  const uploads = field(entry, "uploads");
  if (
    !Array.isArray(uploads) ||
    !uploads.every((upload) => typeof upload === "string")
  )
    throw new CollaborationError("CORRUPT_ASSET_META");
  for (const upload of uploads) identifier(upload);
  return { hash, bytes, uploads: [...uploads] as string[] };
}

function parseRequest(input: unknown): Request {
  const entry = exactRecord(
    input,
    ["scope", "expectedCut", "holds"],
    "INVALID_RELEASE_REQUEST",
  );
  const scope = parseScope(field(entry, "scope"));
  const cut = parseCut(field(entry, "expectedCut"));
  const rawHolds = field(entry, "holds");
  if (!Array.isArray(rawHolds))
    throw new CollaborationError("INVALID_RELEASE_REQUEST");
  if (rawHolds.length === 0 || rawHolds.length > MAX_SELECTED_HOLDS)
    throw new CollaborationError("RETENTION_HOLD_LIMIT");
  const holds = rawHolds.map((raw): RetentionHoldSelection => {
    const hold = exactRecord(raw, ["hash", "holdId"], "INVALID_RELEASE_HOLD");
    const holdId = identifier(field(hold, "holdId"));
    // Reserved namespace: audit/dependency holds are permanent evidence and
    // are never eligible for release selection.
    if (holdId.startsWith("retention-audit-"))
      throw new CollaborationError("INVALID_RELEASE_HOLD");
    return {
      hash: hashValue(field(hold, "hash"), "INVALID_RELEASE_HOLD"),
      holdId,
    };
  });
  const seen = new Set<string>();
  for (const hold of holds) {
    const identity = hold.hash + ":" + hold.holdId;
    if (seen.has(identity)) throw new CollaborationError("DUPLICATE_HOLD");
    seen.add(identity);
  }
  const ordered = [...holds].sort((left, right) =>
    (left.hash + ":" + left.holdId).localeCompare(
      right.hash + ":" + right.holdId,
    ),
  );
  return { scope, cut, holds: ordered };
}

function assertIdle(store: RuntimeStore): void {
  if (store.db?.isTransaction !== false)
    throw new CollaborationError("RETENTION_TRANSACTION_ACTIVE");
}

export class SharedRetentionRelease {
  private environmentFailure: Error | null = null;
  constructor(
    private readonly authority: RetentionReleaseAuthority,
    private readonly environment?: RetentionReleaseEnvironment,
  ) {
    if (!authority || typeof authority !== "object")
      throw new CollaborationError("INVALID_AUTHORITY");
  }

  /**
   * Read-only preview: current actor, scope, head, combined coverage
   * fingerprint, selected hold presence and every block that would stop a
   * release. Caller-input faults (bad scope, stale cut, FORBIDDEN) throw;
   * environmental coverage/evidence gaps are reported in `blocks`.
   */
  preview(token: string, input: unknown): RetentionReleasePreview {
    const request = parseRequest(input);
    const store = this.authority.store;
    const blocks: string[] = [];
    const view = store.transaction(() => {
      this.authority.session(token, request.scope.orgId);
      let coverage: ParsedCoverage | null = null;
      try { coverage = this.inspectEnvironment(); }
      catch (error) {
        if (error instanceof CollaborationError) blocks.push(error.code);
        else throw error;
      }
      const auth = this.authority.session(token, request.scope.orgId);
      this.authority.policy.authorize(auth, request.scope, "manage");
      new DocumentLifecycle(store).assertActive(request.scope);
      const { plan, inventory } = this.planAndInventory(token, request);
      const fence = this.writerBlock(request.scope.orgId);
      if (fence !== null) blocks.push(fence);
      const assessment = coverage === null ? null : this.assessCoverage(coverage, inventory);
      return { auth, plan, inventory, assessment, holds: this.readHolds(request) };
    });
    let missing = false;
    for (const hold of view.holds)
      if (hold.record === null) missing = true;
    if (missing && !blocks.includes("RETENTION_HOLD_MISSING"))
      blocks.push("RETENTION_HOLD_MISSING");
    const assets = this.peekAssets(request);
    if (assets.published !== new Set(request.holds.map(({ hash }) => hash)).size)
      blocks.push("ASSET_MISSING");
    if (assets.bytes > MAX_ARTIFACT_BYTES)
      blocks.push("RETENTION_ARTIFACT_LIMIT");
    const assessment = view.assessment;
    for (const block of assessment?.blocks ?? [])
      if (!blocks.includes(block)) blocks.push(block);
    return {
      actor: view.auth,
      scope: request.scope,
      cut: view.plan.cut,
      combinedFingerprint: assessment?.fingerprint ?? null,
      holds: view.holds.map((hold) => ({
        hash: hold.hash,
        holdId: hold.holdId,
        key: hold.key,
        present: hold.record !== null,
        recordHash: hold.record === null ? null : digest(hold.record),
      })),
      stores: assessment?.stores ?? [],
      liveHistory: assessment?.live ?? { status: "UNAVAILABLE" },
      blocks,
      releasable: assessment !== null && blocks.length === 0,
      recovery: {
        obligation: "EXPLICIT_HOLD",
        holdsSelected: request.holds.length,
        assetsPreserved: assets.published,
        assetBytes: assets.bytes,
        bytesReclaimed: 0,
        assetsDeleted: 0,
      },
    };
  }

  /**
   * Writes the recovery artifact into a dedicated, initially empty,
   * isolated RuntimeStore. No source mutation. The returned plain object is
   * metadata, not an in-memory capability: a release still requires the
   * caller's explicit acknowledgedArtifactHash.
   */
  exportArtifact(
    token: string,
    input: unknown,
    expectedFingerprint: unknown,
    destination: RuntimeStore,
  ): RetentionReleaseArtifactResult {
    const request = parseRequest(input);
    const fingerprint = hashValue(expectedFingerprint, "INVALID_FINGERPRINT");
    const artifact = runtimeStore(destination, "RETENTION_DESTINATION_INVALID");
    assertIdle(this.authority.store);
    assertIdle(artifact);
    const view = this.authority.store.transaction(() => {
      this.authority.session(token, request.scope.orgId);
      const coverage = this.inspectEnvironment();
      const auth = this.authority.session(token, request.scope.orgId);
      this.authority.policy.authorize(auth, request.scope, "manage");
      new DocumentLifecycle(this.authority.store).assertActive(request.scope);
      const { plan, inventory } = this.planAndInventory(token, request);
      const fence = this.writerBlock(request.scope.orgId);
      if (fence !== null) throw new CollaborationError(fence);
      const holds = this.readHolds(request);
      for (const hold of holds)
        if (hold.record === null)
          throw new CollaborationError("RETENTION_HOLD_MISSING");
      const assets = this.readAssets(request);
      const assessment = this.assessCoverage(coverage, inventory);
      return { auth, plan, inventory, holds, assets, coverage, assessment };
    });
    const { coverage, assessment } = view;
    if (assessment.blocks.length > 0)
      throw new CollaborationError(assessment.blocks[0]!);
    if (assessment.fingerprint !== fingerprint)
      throw new CollaborationError("RETENTION_FINGERPRINT_MISMATCH");
    this.assertDestinationIsolated(artifact, coverage);
    const manifest: ManifestBody = {
      v: 1,
      kind: ARTIFACT_KIND,
      scope: request.scope,
      cut: request.cut,
      actor: view.auth,
      fingerprint,
      coverage: {
        storeIds: coverage.storeIds,
        stores: assessment.stores,
        liveGeneration: coverage.liveGeneration,
        liveRootsHash: coverage.liveRootsHash,
      },
      holds: view.holds.map(
        (hold): ManifestHold => ({
          key: hold.key,
          hash: hold.hash,
          holdId: hold.holdId,
          record: hold.record!,
        }),
      ),
      assets: view.assets.map(
        (asset): ManifestAsset => ({
          hash: asset.hash,
          uri: ASSET_URI + asset.hash,
          bytes: asset.bytes,
          record: asset.record,
        }),
      ),
    };
    const artifactHash = digest(manifest);
    const manifestRecord = {
      v: 1,
      kind: ARTIFACT_KIND,
      artifactHash,
      body: manifest,
    };
    let manifestBytes: number;
    try {
      manifestBytes = Buffer.byteLength(
        canonical(manifestRecord, MAX_ARTIFACT_BYTES),
      );
    } catch (error) {
      if (error instanceof CollaborationError)
        throw new CollaborationError("RETENTION_ARTIFACT_LIMIT");
      throw error;
    }
    const blobBytes = view.assets.reduce(
      (total, asset) => total + asset.bytes,
      0,
    );
    if (manifestBytes + blobBytes > MAX_ARTIFACT_BYTES)
      throw new CollaborationError("RETENTION_ARTIFACT_LIMIT");
    this.writeArtifact(artifact, artifactHash, manifestRecord, view.assets);
    return {
      artifactHash,
      fingerprint,
      cut: request.cut,
      scope: request.scope,
      actor: view.auth,
      holds: request.holds,
      assets: manifest.assets.map(({ hash, uri, bytes }) => ({ hash, uri, bytes })),
      manifestBytes,
      blobBytes,
      verification: "READBACK_VERIFIED",
    };
  }

  /**
   * Removes only the selected original asset.holds rows. Also publishes the
   * rooted audit blob and adds reserved audit/dependency holds. Requires a
   * read-back-verified artifact, an explicit acknowledgment equal to the
   * artifact hash, a still-matching combined fingerprint and the same actor
   * context. The immutable retention.releases receipt is written before any
   * hold row is deleted; the artifact is never deleted on any failure.
   */
  releaseHolds(
    token: string,
    input: unknown,
    expectedFingerprint: unknown,
    artifactHashInput: unknown,
    acknowledgedArtifactHash: unknown,
    destination: RetentionArtifactStore,
  ): RetentionReleaseResult {
    const request = parseRequest(input);
    const fingerprint = hashValue(expectedFingerprint, "INVALID_FINGERPRINT");
    const artifactHash = hashValue(artifactHashInput, "INVALID_ARTIFACT_HASH");
    const acknowledged = hashValue(
      acknowledgedArtifactHash,
      "INVALID_ARTIFACT_ACK",
    );
    const artifact = runtimeStore(destination, "RETENTION_DESTINATION_INVALID");
    assertIdle(this.authority.store);
    assertIdle(artifact);
    const view = this.authority.store.transaction(() => {
      const auth = this.authority.session(token, request.scope.orgId);
      this.authority.policy.authorize(auth, request.scope, "manage");
      new DocumentLifecycle(this.authority.store).assertActive(request.scope);
      // A recorded release is reported after the current re-authorization —
      // before the exact-cut inventory, because a successful release
      // legitimately advanced the head — and is never overwritten or resent.
      if (
        this.authority.store.get(RETENTION_RELEASES_NAMESPACE, artifactHash) !==
        null
      ) {
        this.authority.retentionDependencies(token, request.scope.orgId, this.authority.head());
        throw new CollaborationError("RETENTION_ALREADY_RELEASED");
      }
      const { plan, inventory } = this.planAndInventory(token, request);
      const fence = this.writerBlock(request.scope.orgId);
      if (fence !== null) throw new CollaborationError(fence);
      return { auth, plan, inventory };
    });
    if (acknowledged !== artifactHash)
      throw new CollaborationError("RETENTION_ACK_MISMATCH");
    const coverage = this.inspectEnvironment();
    const assessment = this.assessCoverage(coverage, view.inventory);
    if (assessment.blocks.length > 0)
      throw new CollaborationError(assessment.blocks[0]!);
    if (assessment.fingerprint !== fingerprint)
      throw new CollaborationError("RETENTION_FINGERPRINT_MISMATCH");
    this.assertDestinationIsolated(artifact, coverage);
    const manifest = this.readArtifact(artifact, artifactHash);
    if (!sameScope(manifest.scope, request.scope))
      throw new CollaborationError("RETENTION_ARTIFACT_MISMATCH");
    if (!sameCut(manifest.cut, request.cut))
      throw new CollaborationError("RETENTION_ARTIFACT_MISMATCH");
    if (manifest.fingerprint !== fingerprint)
      throw new CollaborationError("RETENTION_ARTIFACT_MISMATCH");
    if (!sameActor(manifest.actor, view.auth))
      throw new CollaborationError("RETENTION_ACTOR_MISMATCH");
    const selected = new Set(
      request.holds.map((hold) => hold.hash + ":" + hold.holdId),
    );
    if (
      manifest.holds.length !== selected.size ||
      !manifest.holds.every((hold) => selected.has(hold.hash + ":" + hold.holdId))
    )
      throw new CollaborationError("RETENTION_ARTIFACT_MISMATCH");

    return this.authority.store.transaction(() => {
      this.authority.session(token, request.scope.orgId);
      const currentCoverage = this.inspectEnvironment();
      this.assertDestinationIsolated(artifact, currentCoverage);
      return this.withCoverageLocks(currentCoverage, () => {
      const auth = this.authority.session(token, request.scope.orgId);
      if (!sameActor(auth, manifest.actor))
        throw new CollaborationError("RETENTION_ACTOR_MISMATCH");
      this.authority.policy.authorize(auth, request.scope, "manage");
      new DocumentLifecycle(this.authority.store).assertActive(request.scope);
      const { inventory } = this.planAndInventory(token, request);
      const protocol = readRuntimeProtocol(
        this.authority.store,
        request.scope.orgId,
      ).protocol;
      this.authority.operations.assertWriter(protocol);
      // A conflicting existing receipt is a recorded status, reported after
      // the current re-authorization — never overwritten, never resent.
      const releases = this.authority.store.get(
        RETENTION_RELEASES_NAMESPACE,
        artifactHash,
      );
      if (releases !== null)
        throw new CollaborationError("RETENTION_ALREADY_RELEASED");
      const reassessed = this.assessCoverage(currentCoverage, inventory);
      if (reassessed.blocks.length > 0)
        throw new CollaborationError(reassessed.blocks[0]!);
      if (reassessed.fingerprint !== fingerprint)
        throw new CollaborationError("RETENTION_FINGERPRINT_MISMATCH");
      if (canonical(manifest.coverage.storeIds) !== canonical(currentCoverage.storeIds) ||
          canonical(manifest.coverage.stores) !== canonical(reassessed.stores) ||
          manifest.coverage.liveGeneration !== currentCoverage.liveGeneration ||
          manifest.coverage.liveRootsHash !== currentCoverage.liveRootsHash)
        throw new CollaborationError("RETENTION_ARTIFACT_MISMATCH");
      let missing = false;
      for (const hold of manifest.holds) {
        const current = this.authority.store.get(HOLDS_NAMESPACE, hold.key);
        if (current === null) {
          missing = true;
          continue;
        }
        if (canonical(current) !== canonical(hold.record))
          throw new CollaborationError("RETENTION_HOLD_CHANGED");
      }
      if (missing)
        throw new CollaborationError("RETENTION_HOLD_MISSING");
      const currentAssets = this.readAssets(request);
      if (canonical(currentAssets.map(({ hash, bytes, record }) => ({
        hash, uri: ASSET_URI + hash, bytes, record,
      }))) !== canonical(manifest.assets))
        throw new CollaborationError("RETENTION_ARTIFACT_MISMATCH");
      // Read the independently committed artifact again at the mutation
      // boundary; a hash-valid manifest is not proof of source closure.
      if (canonical(this.readArtifact(artifact, artifactHash)) !== canonical(manifest))
        throw new CollaborationError("RETENTION_ARTIFACT_MISMATCH");
      // Rooted audit: the complete raw release receipt is published through
      // the normal audited asset path (stageAsset + asset.publish commit).
      // The rooted blob hash therefore binds this release's scope, actor,
      // cut, fingerprint, hold originals and coverage forever; the unrooted
      // retention.releases row is only a lookup index to that blob.
      const payload = {
        v: 2 as const,
        kind: ARTIFACT_KIND,
        artifactHash,
        scope: manifest.scope,
        cut: manifest.cut,
        actor: manifest.actor,
        fingerprint: manifest.fingerprint,
        coverage: manifest.coverage,
        holds: manifest.holds,
        assets: manifest.assets,
      };
      const payloadBytes = new TextEncoder().encode(canonical(payload));
      const auditUploadId = "retention-audit-" + artifactHash;
      identifier(auditUploadId);
      if (
        typeof this.authority.stageAsset !== "function" ||
        typeof this.authority.submit !== "function"
      )
        throw new CollaborationError("RETENTION_AUDIT_UNAVAILABLE");
      // A missing/deferred acknowledgment poisons this authority capability
      // across subsequent calls; it is never permission to resend.
      const publisher = synchronousPort(this.authority, AUDIT_PUBLISHER_CONTRACT);
      const staged = publisher.stageAsset!(
        token,
        manifest.scope,
        auditUploadId,
        payloadBytes,
      );
      if (staged.bytes !== payloadBytes.byteLength ||
          staged.hash !== createHash("sha256").update(payloadBytes).digest("hex"))
        throw new CollaborationError("RETENTION_AUDIT_MISMATCH");
      const attempt: Attempt = {
        v: 1,
        attemptId: randomUUID(),
        base: request.cut,
        ...(protocol === 1004 ? { protocol: 1004 as const } : {}),
        intent: {
          v: 1,
          intentId: randomUUID(),
          writerId: auth.writerId,
          scope: manifest.scope,
          base: request.cut,
          command: {
            kind: "resource",
            action: "asset.publish",
            payload: { uploadId: auditUploadId, hash: staged.hash },
          },
        },
      };
      const authorityReceipt = publisher.submit!(token, attempt);
      if (authorityReceipt.status !== "SERVER_ACCEPTED")
        throw new CollaborationError(
          authorityReceipt.code ?? "RETENTION_AUDIT_REJECTED",
        );
      // Permanent explicit holds keep the audit blob AND every released
      // asset uncollectable: the collect scan never reads audit blob
      // contents, so the originals need real dependency holds of their own,
      // not merely a folio-asset:// reference inside the receipt.
      const assets = new SharedAssets(this.authority.store);
      assets.hold(manifest.scope, staged.hash, auditUploadId);
      for (const asset of manifest.assets)
        assets.hold(manifest.scope, asset.hash, auditUploadId);
      const receipt = {
        v: 2,
        kind: ARTIFACT_KIND,
        artifactHash,
        payload,
        audit: {
          hash: staged.hash,
          uri: ASSET_URI + staged.hash,
          uploadId: auditUploadId,
          attemptId: attempt.attemptId,
          receipt: authorityReceipt,
        },
      };
      this.authority.store.set(RETENTION_RELEASES_NAMESPACE, artifactHash, receipt);
      for (const hold of manifest.holds)
        this.authority.store.set(HOLDS_NAMESPACE, hold.key, null);
      this.authority.verify();
      // In-transaction integrity check: the just-written unrooted row must
      // already verify against the rooted audit blob and accepted event.
      verifyRetentionReleaseReceipt(this.authority, artifactHash);
      const head = this.authority.head();
      if (
        !sameCut(head, authorityReceipt.cut) ||
        head.epoch !== request.cut.epoch ||
        head.seq !== request.cut.seq + 1
      )
        throw new CollaborationError("RETENTION_HEAD_CHANGED");
      return {
        artifactHash,
        fingerprint,
        cut: authorityReceipt.cut,
        sourceCut: request.cut,
        scope: request.scope,
        released: manifest.holds.map((hold) => ({
          hash: hold.hash,
          holdId: hold.holdId,
        })),
        bytesReclaimed: 0 as const,
        assetsDeleted: 0 as const,
        releaseRecord: artifactHash,
        audit: {
          hash: staged.hash,
          uri: ASSET_URI + staged.hash,
          uploadId: auditUploadId,
          attemptId: attempt.attemptId,
          cut: authorityReceipt.cut,
        },
      };
      });
    });
  }

  /** Hold runtime-store write locks until the source mutation has finished.
   * Opaque stores and live memory require the host's synchronous lease. */
  private withCoverageLocks<T>(coverage: ParsedCoverage, work: () => T): T {
    const stores = coverage.runtime
      .filter(({ store }) => store !== this.authority.store)
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const { store } of stores) assertIdle(store);
    const lock = (index: number): T => index === stores.length
      ? work() : stores[index]!.store.transaction(() => lock(index + 1));
    return lock(0);
  }

  /**
   * Runs the real whole-store authorization + verify + plan inside the
   * authority's transaction so a stale cut, a revoked owner/workspace read,
   * or a corrupted root fails before anything else happens.
   */
  private planAndInventory(
    token: string,
    request: Request,
  ): { plan: RetentionReclamationPlan; inventory: RetentionDependencyInventory } {
    const plan = this.authority.retentionDependencies(
      token,
      request.scope.orgId,
      request.cut,
    );
    const inventory = inspectRetentionDependencies(
      this.authority.store,
      request.cut,
    );
    if (
      inventory.cut === null ||
      !sameCut(inventory.cut, request.cut) ||
      inventory.fingerprint !== plan.fingerprint
    )
      throw new CollaborationError("RETENTION_DEPENDENCY_DRIFT");
    return { plan, inventory };
  }

  private writerBlock(orgId: string): string | null {
    try {
      const protocol = readRuntimeProtocol(this.authority.store, orgId).protocol;
      this.authority.operations.assertWriter(protocol);
      return null;
    } catch (error) {
      if (error instanceof CollaborationError) return error.code;
      throw error;
    }
  }

  private readHolds(request: Request): ResolvedHold[] {
    return request.holds.map((hold): ResolvedHold => {
      const key = holdKey(request.scope, hold.hash, hold.holdId);
      const raw = this.authority.store.get(HOLDS_NAMESPACE, key);
      if (raw === null)
        return { hash: hold.hash, holdId: hold.holdId, key, record: null };
      const parsed = holdRecord(raw);
      if (parsed.hash !== hold.hash || parsed.holdId !== hold.holdId)
        throw new CollaborationError("CORRUPT_HOLD");
      return {
        hash: hold.hash,
        holdId: hold.holdId,
        key,
        record: parsed,
      };
    });
  }

  /** Selected assets' metadata only — used by the preview recovery summary. */
  private peekAssets(request: Request): { published: number; bytes: number } {
    const key = assetKey(request.scope);
    const seen = new Set<string>();
    let published = 0;
    let bytes = 0;
    return this.authority.store.transaction(() => {
      for (const hold of request.holds) {
        if (seen.has(hold.hash)) continue;
        seen.add(hold.hash);
        const raw = this.authority.store.get(
          ASSET_NAMESPACE,
          key + ":" + hold.hash,
        );
        if (raw === null) continue;
        const asset = assetRecord(raw);
        published++;
        bytes += asset.bytes;
      }
      return { published, bytes };
    });
  }

  /** Full asset copies for the artifact; blob contents are hash-verified. */
  private readAssets(request: Request): AssetCopy[] {
    const key = assetKey(request.scope);
    const seen = new Set<string>();
    const assets: AssetCopy[] = [];
    let totalBytes = 0;
    for (const hold of request.holds) {
      if (seen.has(hold.hash)) continue;
      seen.add(hold.hash);
      const raw = this.authority.store.get(
        ASSET_NAMESPACE,
        key + ":" + hold.hash,
      );
      if (raw === null) throw new CollaborationError("ASSET_MISSING");
      const asset = assetRecord(raw);
      if (asset.hash !== hold.hash)
        throw new CollaborationError("CORRUPT_ASSET_META");
      totalBytes += asset.bytes;
      if (totalBytes > MAX_ARTIFACT_BYTES)
        throw new CollaborationError("RETENTION_ARTIFACT_LIMIT");
      const blob = this.authority.store.blobGet(key, asset.hash);
      if (blob === null) throw new CollaborationError("ASSET_MISSING");
      if (blob.byteLength !== asset.bytes)
        throw new CollaborationError("ASSET_TAMPERED");
      assets.push({ hash: asset.hash, bytes: asset.bytes, record: asset, data: blob.slice() });
    }
    return assets;
  }

  /**
   * One synchronous call into the configured trusted port. A missing port,
   * a known async/generator inspect function, or a thenable result fails
   * closed before any store is touched.
   */
  private inspectEnvironment(): ParsedCoverage {
    const environment = this.environment;
    if (!environment || typeof environment !== "object")
      throw new CollaborationError("RETENTION_COVERAGE_REQUIRED");
    const inspect = (environment as { inspect?: unknown }).inspect;
    if (typeof inspect !== "function")
      throw new CollaborationError("RETENTION_COVERAGE_REQUIRED");
    if (this.environmentFailure !== null) throw this.environmentFailure;
    if (types.isAsyncFunction(inspect) || types.isGeneratorFunction(inspect))
      throw new CollaborationError("RETENTION_COVERAGE_ASYNC");
    const coverage = (inspect as () => unknown).call(environment);
    try {
      if (thenable(coverage)) {
        if (types.isPromise(coverage))
          Promise.prototype.then.call(coverage, undefined, () => undefined);
        throw new CollaborationError("RETENTION_COVERAGE_ASYNC");
      }
    } catch (error) {
      this.environmentFailure = error instanceof Error
        ? error : new CollaborationError("RETENTION_COVERAGE_ASYNC");
      throw this.environmentFailure;
    }
    return this.parseCoverage(coverage);
  }

  private parseCoverage(value: unknown): ParsedCoverage {
    const entry = exactRecord(
      value,
      ["requiredStoreIds", "stores", "liveHistory", "unaccountedStores"],
      "RETENTION_COVERAGE_INVALID",
    );
    const requiredRaw = field(entry, "requiredStoreIds");
    if (!Array.isArray(requiredRaw) || requiredRaw.length === 0)
      throw new CollaborationError("RETENTION_COVERAGE_INVALID");
    const required = requiredRaw.map((id) => identifier(id));
    if (required.length > MAX_COVERAGE_STORES)
      throw new CollaborationError("RETENTION_COVERAGE_LIMIT");
    if (new Set(required).size !== required.length)
      throw new CollaborationError("RETENTION_COVERAGE_INVALID");
    const storesRaw = field(entry, "stores");
    if (!Array.isArray(storesRaw))
      throw new CollaborationError("RETENTION_COVERAGE_INVALID");
    const runtime: RuntimeEntry[] = [];
    const retainOnly: RetainOnlyEntry[] = [];
    const seenIds = new Set<string>();
    const seenObjects = new Set<RuntimeStore>();
    const seenDbs = new Set<object>();
    const seenPaths = new Set<string>();
    for (const rawEntry of storesRaw) {
      const raw = record(rawEntry, "RETENTION_COVERAGE_INVALID");
      const keys = Object.keys(raw).sort();
      const id = identifier(field(raw, "id"));
      if (seenIds.has(id))
        throw new CollaborationError("RETENTION_COVERAGE_INVALID");
      seenIds.add(id);
      if (keys.join(",") === "id,store") {
        const store = runtimeStore(
          field(raw, "store"),
          "RETENTION_COVERAGE_INVALID",
        );
        if (
          seenObjects.has(store) ||
          seenDbs.has(store.db) ||
          seenPaths.has(store.path)
        )
          throw new CollaborationError("RETENTION_COVERAGE_INVALID");
        seenObjects.add(store);
        seenDbs.add(store.db);
        seenPaths.add(store.path);
        runtime.push({ id, store });
      } else if (["fingerprint,generation,id,retention", "fingerprint,generation,id,retention,statistics"]
        .includes(keys.join(","))) {
        if (field(raw, "retention") !== "RETAIN_ALL")
          throw new CollaborationError("RETENTION_COVERAGE_INVALID");
        let statistics: { rows: number; bytes: number; nodes: number } | undefined;
        if (field(raw, "statistics") !== undefined) {
          const counts = exactRecord(field(raw, "statistics"), ["rows", "bytes", "nodes"], "RETENTION_COVERAGE_INVALID");
          statistics = {
            rows: counterValue(field(counts, "rows"), "RETENTION_COVERAGE_INVALID"),
            bytes: counterValue(field(counts, "bytes"), "RETENTION_COVERAGE_INVALID"),
            nodes: counterValue(field(counts, "nodes"), "RETENTION_COVERAGE_INVALID"),
          };
        }
        retainOnly.push({
          id,
          generation: identifier(field(raw, "generation")),
          fingerprint: hashValue(
            field(raw, "fingerprint"),
            "RETENTION_COVERAGE_INVALID",
          ),
          ...(statistics === undefined ? {} : { statistics }),
        });
      } else {
        throw new CollaborationError("RETENTION_COVERAGE_INVALID");
      }
    }
    // requiredStoreIds and stores must cover EXACTLY the same ids.
    for (const id of required)
      if (!seenIds.has(id))
        throw new CollaborationError("RETENTION_COVERAGE_INVALID");
    for (const id of seenIds)
      if (!required.includes(id))
        throw new CollaborationError("RETENTION_COVERAGE_INVALID");
    // The authority store is mandatory, exactly once, bound to this object.
    const authorityEntries = runtime.filter(
      (entry) => entry.id === RETENTION_AUTHORITY_STORE_ID,
    );
    if (
      authorityEntries.length !== 1 ||
      authorityEntries[0]!.store !== this.authority.store ||
      retainOnly.some((entry) => entry.id === RETENTION_AUTHORITY_STORE_ID)
    )
      throw new CollaborationError("RETENTION_COVERAGE_INVALID");
    const unaccountedRaw = field(entry, "unaccountedStores");
    if (!Array.isArray(unaccountedRaw))
      throw new CollaborationError("RETENTION_COVERAGE_INVALID");
    for (const id of unaccountedRaw) identifier(id);
    if (unaccountedRaw.length > 0)
      throw new CollaborationError("RETENTION_UNACCOUNTED_STORES");
    // A QUIESCENT assertion carries generation + bounded canonical roots;
    // anything else (including an honest UNAVAILABLE) fails closed.
    const liveEntry = record(
      field(entry, "liveHistory"),
      "RETENTION_COVERAGE_INVALID",
    );
    const liveKeys = Object.keys(liveEntry).sort();
    const status = field(liveEntry, "status");
    if (status === "UNAVAILABLE") {
      if (liveKeys.join(",") !== "status")
        throw new CollaborationError("RETENTION_COVERAGE_INVALID");
      throw new CollaborationError("RETENTION_LIVE_HISTORY_UNAVAILABLE");
    }
    if (status !== "QUIESCENT" || liveKeys.join(",") !== "generation,roots,status")
      throw new CollaborationError("RETENTION_COVERAGE_INVALID");
    const generation = identifier(field(liveEntry, "generation"));
    canonical(field(liveEntry, "roots"), MAX_LIVE_ROOT_BYTES);
    const rootsHash = digest(field(liveEntry, "roots"));
    return {
      storeIds: [...required].sort(),
      runtime,
      retainOnly,
      liveGeneration: generation,
      liveRootsHash: rootsHash,
    };
  }

  /**
   * Per-store bounded inventory plus a combined fingerprint binding every
   * store id/path/role/full-inventory fingerprint and the live generation
   * with bounded canonical roots. Evidence blocks (unresolved attempts,
   * unclassified namespaces, aggregate limits) are returned, not thrown, so
   * the preview can report them; export/release throw the first one.
   */
  private assessCoverage(
    coverage: ParsedCoverage,
    authorityInventory: RetentionDependencyInventory,
  ): Assessment {
    const blocks: string[] = [];
    const runtimeById = new Map(
      coverage.runtime.map((entry) => [entry.id, entry]),
    );
    const retainById = new Map(
      coverage.retainOnly.map((entry) => [entry.id, entry]),
    );
    const stores: {
      id: string;
      entry:
        | { kind: "runtime"; path: string; role: unknown; inventory: RetentionDependencyInventory }
        | { kind: "retain-only"; generation: string; fingerprint: string };
    }[] = [];
    let totalRows = 0;
    let totalRecordBytes = 0;
    let totalReferences = 0;
    let unclassified = false;
    let unresolved = false;
    const scanBudget = { remaining: 100_000 - retentionInventoryScanNodes(authorityInventory) };
    for (const id of coverage.storeIds) {
      const runtimeEntry = runtimeById.get(id);
      if (runtimeEntry !== undefined) {
        const store = runtimeEntry.store;
        const inventory =
          id === RETENTION_AUTHORITY_STORE_ID
            ? authorityInventory
            : inspectRetentionDependencies(
                store,
                (() => {
                  const raw = store.get(META_NAMESPACE, HEAD_KEY);
                  return raw === null ? null : parseCut(raw);
                })(),
                {}, undefined, scanBudget,
              );
        totalRows += inventory.records.length + inventory.blobs.length;
        totalRecordBytes += inventory.recordBytes;
        totalReferences += inventory.references.length;
        if (inventory.unresolved.length > 0) unresolved = true;
        for (const row of inventory.records)
          if (retentionNamespaceContract(row.namespace) === null)
            unclassified = true;
        stores.push({
          id,
          entry: {
            kind: "runtime",
            path: store.path,
            role: store.get(META_NAMESPACE, ROLE_KEY),
            inventory,
          },
        });
      } else {
        const retained = retainById.get(id);
        if (retained === undefined)
          throw new CollaborationError("RETENTION_COVERAGE_INVALID");
        totalRows += retained.statistics?.rows ?? 0;
        totalRecordBytes += retained.statistics?.bytes ?? 0;
        scanBudget.remaining -= retained.statistics?.nodes ?? 0;
        stores.push({
          id,
          entry: {
            kind: "retain-only",
            generation: retained.generation,
            fingerprint: retained.fingerprint,
          },
        });
      }
    }
    if (
      totalRows > MAX_TOTAL_ROWS ||
      totalRecordBytes > MAX_TOTAL_RECORD_BYTES ||
      totalReferences > MAX_TOTAL_REFERENCES
      || scanBudget.remaining < 0
    )
      blocks.push("RETENTION_INVENTORY_LIMIT");
    if (unresolved) blocks.push("RETENTION_UNRESOLVED_ATTEMPT");
    if (unclassified) blocks.push("RETENTION_UNCLASSIFIED_EVIDENCE");
    stores.sort((left, right) => left.id.localeCompare(right.id));
    const summaries: RetentionStoreSummary[] = stores.map((entry) =>
      entry.entry.kind === "runtime"
        ? {
            id: entry.id,
            kind: "runtime",
            cut: entry.entry.inventory.cut,
            fingerprint: entry.entry.inventory.fingerprint,
          }
        : {
            id: entry.id,
            kind: "retain-only",
            cut: null,
            fingerprint: entry.entry.fingerprint,
          },
    );
    const live = {
      status: "QUIESCENT" as const,
      generation: coverage.liveGeneration,
      rootsHash: coverage.liveRootsHash,
    };
    const fingerprint = digest({
      stores: stores.map((entry) =>
        entry.entry.kind === "runtime"
          ? {
              id: entry.id,
              kind: "runtime",
              path: entry.entry.path,
              role: entry.entry.role ?? null,
              cut: entry.entry.inventory.cut,
              fingerprint: entry.entry.inventory.fingerprint,
            }
          : {
              id: entry.id,
              kind: "retain-only",
              generation: entry.entry.generation,
              fingerprint: entry.entry.fingerprint,
            },
      ),
      live,
    });
    return { fingerprint, stores: summaries, live, blocks };
  }

  private assertDestinationIsolated(
    destination: RuntimeStore,
    coverage: ParsedCoverage,
  ): void {
    for (const entry of coverage.runtime) {
      if (
        destination === entry.store ||
        destination.db === entry.store.db ||
        destination.path === entry.store.path
      )
        throw new CollaborationError("RETENTION_DESTINATION_NOT_ISOLATED");
      const left = dirname(destination.path);
      const right = dirname(entry.store.path);
      if (
        left === right ||
        left.startsWith(right + sep) ||
        right.startsWith(left + sep)
      )
        throw new CollaborationError("RETENTION_DESTINATION_NOT_ISOLATED");
    }
  }

  /**
   * The artifact store is a dedicated, initially empty private RuntimeStore.
   * Its whole write happens in its own transaction; afterwards the manifest
   * and every blob are re-read and hash-verified — the source transaction is
   * never a durability substitute and export never mutates the source.
   */
  private writeArtifact(
    destination: RuntimeStore,
    artifactHash: string,
    manifestRecord: unknown,
    assets: readonly AssetCopy[],
  ): void {
    assertIdle(destination);
    destination.transaction(() => {
      const totals = record(
        destination.db.prepare(`
          SELECT
            (SELECT count(*) FROM runtime_records) AS records,
            (SELECT count(*) FROM runtime_blobs) AS blobs
        `).get(),
        "RETENTION_ARTIFACT_INVALID",
      );
      const records = counterValue(totals.records, "RETENTION_ARTIFACT_INVALID");
      const blobs = counterValue(totals.blobs, "RETENTION_ARTIFACT_INVALID");
      if (records !== 0 || blobs !== 0)
        throw new CollaborationError("RETENTION_DESTINATION_NOT_EMPTY");
      if (destination.get(META_NAMESPACE, ROLE_KEY) !== null)
        throw new CollaborationError("RETENTION_DESTINATION_NOT_EMPTY");
      destination.set(META_NAMESPACE, ROLE_KEY, RECOVERY_ROLE);
      for (const asset of assets)
        destination.blobPut(RECOVERY_BLOB_SCOPE, asset.hash, asset.data);
      destination.set(RETENTION_RECOVERY_NAMESPACE, artifactHash, manifestRecord);
    });
    destination.transaction(() => {
      if (destination.get(META_NAMESPACE, ROLE_KEY) !== RECOVERY_ROLE)
        throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
      this.readManifest(destination, artifactHash, assets);
    });
  }

  private readArtifact(
    destination: RuntimeStore,
    artifactHash: string,
  ): ManifestBody {
    assertIdle(destination);
    return destination.transaction(() => {
      if (destination.get(META_NAMESPACE, ROLE_KEY) !== RECOVERY_ROLE)
        throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
      return this.readManifest(destination, artifactHash, null);
    });
  }

  /**
   * Parses the manifest record back, binds artifactHash to the canonical
   * body hash, and re-verifies every blob hash/size. Any tampering, missing
   * blob, or malformed shape fails closed; nothing is ever deleted here.
   */
  private readManifest(
    destination: RuntimeStore,
    artifactHash: string,
    expectedAssets: readonly AssetCopy[] | null,
  ): ManifestBody {
    const raw = destination.get(RETENTION_RECOVERY_NAMESPACE, artifactHash);
    if (raw === null) throw new CollaborationError("RETENTION_ARTIFACT_MISSING");
    const stored = exactRecord(
      raw,
      ["v", "kind", "artifactHash", "body"],
      "RETENTION_ARTIFACT_INVALID",
    );
    if (field(stored, "v") !== 1 || field(stored, "kind") !== ARTIFACT_KIND)
      throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
    if (field(stored, "artifactHash") !== artifactHash)
      throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
    const body = field(stored, "body");
    if (digest(body) !== artifactHash)
      throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
    const manifest = exactRecord(
      body,
      [
        "v",
        "kind",
        "scope",
        "cut",
        "actor",
        "fingerprint",
        "coverage",
        "holds",
        "assets",
      ],
      "RETENTION_ARTIFACT_INVALID",
    );
    if (field(manifest, "v") !== 1 || field(manifest, "kind") !== ARTIFACT_KIND)
      throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
    const scope = parseScope(field(manifest, "scope"));
    const cut = parseCut(field(manifest, "cut"));
    const actorRaw = exactRecord(
      field(manifest, "actor"),
      ["userId", "deviceId", "writerId", "sessionId"],
      "RETENTION_ARTIFACT_INVALID",
    );
    const actor: AuthContext = {
      userId: identifier(field(actorRaw, "userId")),
      deviceId: identifier(field(actorRaw, "deviceId")),
      writerId: identifier(field(actorRaw, "writerId")),
      sessionId: identifier(field(actorRaw, "sessionId")),
    };
    const fingerprint = hashValue(
      field(manifest, "fingerprint"),
      "RETENTION_ARTIFACT_INVALID",
    );
    const coverageRaw = exactRecord(
      field(manifest, "coverage"),
      ["storeIds", "stores", "liveGeneration", "liveRootsHash"],
      "RETENTION_ARTIFACT_INVALID",
    );
    const storeIdsRaw = field(coverageRaw, "storeIds");
    if (!Array.isArray(storeIdsRaw) || storeIdsRaw.length === 0 ||
        storeIdsRaw.length > MAX_COVERAGE_STORES ||
        new Set(storeIdsRaw).size !== storeIdsRaw.length)
      throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
    for (const id of storeIdsRaw) identifier(id);
    const liveGeneration = identifier(field(coverageRaw, "liveGeneration"));
    const liveRootsHash = hashValue(
      field(coverageRaw, "liveRootsHash"),
      "RETENTION_ARTIFACT_INVALID",
    );
    const storesRaw = field(coverageRaw, "stores");
    if (!Array.isArray(storesRaw) || storesRaw.length !== storeIdsRaw.length)
      throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
    const stores: RetentionStoreSummary[] = storesRaw.map(
      (rawEntry): RetentionStoreSummary => {
        const item = record(rawEntry, "RETENTION_ARTIFACT_INVALID");
        const id = identifier(field(item, "id"));
        const kind = field(item, "kind");
        if (kind === "runtime") {
          exactRecord(item, ["id", "kind", "cut", "fingerprint"], "RETENTION_ARTIFACT_INVALID");
          const cutRaw = field(item, "cut");
          return {
            id,
            kind: "runtime",
            cut: cutRaw === null ? null : parseCut(cutRaw),
            fingerprint: hashValue(field(item, "fingerprint"), "RETENTION_ARTIFACT_INVALID"),
          };
        }
        if (kind === "retain-only") {
          exactRecord(item, ["id", "kind", "cut", "fingerprint"], "RETENTION_ARTIFACT_INVALID");
          if (field(item, "cut") !== null)
            throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
          return {
            id,
            kind: "retain-only",
            cut: null,
            fingerprint: hashValue(field(item, "fingerprint"), "RETENTION_ARTIFACT_INVALID"),
          };
        }
        throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
      },
    );
    const holdsRaw = field(manifest, "holds");
    if (!Array.isArray(holdsRaw) || holdsRaw.length === 0 ||
        holdsRaw.length > MAX_SELECTED_HOLDS)
      throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
    const holds: ManifestHold[] = holdsRaw.map((rawHold): ManifestHold => {
      const item = exactRecord(
        rawHold,
        ["key", "hash", "holdId", "record"],
        "RETENTION_ARTIFACT_INVALID",
      );
      const hash = hashValue(field(item, "hash"), "RETENTION_ARTIFACT_INVALID");
      const holdId = identifier(field(item, "holdId"));
      const original = holdRecord(field(item, "record"));
      if (original.hash !== hash || original.holdId !== holdId)
        throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
      const key = field(item, "key");
      if (key !== holdKey(scope, hash, holdId))
        throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
      return { key: key as string, hash, holdId, record: original };
    });
    if (holds.length > MAX_SELECTED_HOLDS)
      throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
    if (new Set(holds.map((hold) => hold.key)).size !== holds.length)
      throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
    const assetsRaw = field(manifest, "assets");
    if (!Array.isArray(assetsRaw) || assetsRaw.length > MAX_SELECTED_HOLDS)
      throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
    const assets: ManifestAsset[] = assetsRaw.map(
      (rawAsset): ManifestAsset => {
        const item = exactRecord(
          rawAsset,
          ["hash", "uri", "bytes", "record"],
          "RETENTION_ARTIFACT_INVALID",
        );
        const hash = hashValue(field(item, "hash"), "RETENTION_ARTIFACT_INVALID");
        const bytes = counterValue(field(item, "bytes"), "RETENTION_ARTIFACT_INVALID");
        if (field(item, "uri") !== ASSET_URI + hash)
          throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
        const original = assetRecord(field(item, "record"));
        if (original.hash !== hash || original.bytes !== bytes)
          throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
        return { hash, uri: ASSET_URI + hash, bytes, record: original };
      },
    );
    const selectedHashes = new Set(holds.map((hold) => hold.hash));
    const assetHashes = new Set(assets.map((asset) => asset.hash));
    if (assetHashes.size !== assets.length || assetHashes.size !== selectedHashes.size ||
        [...selectedHashes].some((hash) => !assetHashes.has(hash)) ||
        (expectedAssets !== null && expectedAssets.length !== assets.length))
      throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
    const manifestBytes = Buffer.byteLength(canonical(raw, MAX_ARTIFACT_BYTES));
    if (assets.reduce((total, asset) => total + asset.bytes, manifestBytes) > MAX_ARTIFACT_BYTES)
      throw new CollaborationError("RETENTION_ARTIFACT_LIMIT");
    if (new Set(stores.map((store) => store.id)).size !== stores.length ||
        stores.some((store) => !storeIdsRaw.includes(store.id)))
      throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
    for (const asset of assets) {
      const blob = destination.blobGet(RECOVERY_BLOB_SCOPE, asset.hash);
      if (blob === null || blob.byteLength !== asset.bytes)
        throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
      if (expectedAssets !== null) {
        const expected = expectedAssets.find(
          (entry) => entry.hash === asset.hash,
        );
        if (expected === undefined || expected.bytes !== asset.bytes ||
            canonical(expected.record) !== canonical(asset.record))
          throw new CollaborationError("RETENTION_ARTIFACT_INVALID");
      }
    }
    return {
      v: 1,
      kind: ARTIFACT_KIND,
      scope,
      cut,
      actor,
      fingerprint,
      coverage: {
        storeIds: storeIdsRaw.map((id) => identifier(id)),
        stores,
        liveGeneration,
        liveRootsHash,
      },
      holds,
      assets,
    };
  }
}

type VerificationAuthority = Readonly<{
  store: RuntimeStore;
  verify(): void;
}>;

/**
 * Independently verifies a committed retention release. The
 * `retention.releases` row itself is unrooted lookup data — `verify()` alone
 * does not detect direct edits to it. Verification therefore compares the
 * row's stored canonical payload byte-for-byte against the state-rooted
 * audit blob whose hash/URI/upload ID the row references, requires the
 * rooted accepted publish event for the audit attempt, the permanent audit
 * hold, and a clean authority chain. Any tampering with the row, the raw
 * payload, or the publish reference fails closed. The original selected
 * assets and all other evidence are untouched — this is read-only.
 */
export function verifyRetentionReleaseReceipt(
  authority: VerificationAuthority,
  artifactHashInput: unknown,
): RetentionAuditReference {
  const artifactHash = hashValue(artifactHashInput, "INVALID_ARTIFACT_HASH");
  const store = authority.store;
  const row = exactRecord(
    store.get(RETENTION_RELEASES_NAMESPACE, artifactHash),
    ["v", "kind", "artifactHash", "payload", "audit"],
    "RETENTION_RELEASE_MISSING",
  );
  if (
    field(row, "v") !== 2 ||
    field(row, "kind") !== ARTIFACT_KIND ||
    field(row, "artifactHash") !== artifactHash
  )
    throw new CollaborationError("RETENTION_RELEASE_INVALID");
  const payload = exactRecord(
    field(row, "payload"),
    [
      "v",
      "kind",
      "artifactHash",
      "scope",
      "cut",
      "actor",
      "fingerprint",
      "coverage",
      "holds",
      "assets",
    ],
    "RETENTION_RELEASE_INVALID",
  );
  if (
    field(payload, "v") !== 2 ||
    field(payload, "kind") !== ARTIFACT_KIND ||
    field(payload, "artifactHash") !== artifactHash
  )
    throw new CollaborationError("RETENTION_RELEASE_INVALID");
  hashValue(field(payload, "fingerprint"), "RETENTION_RELEASE_INVALID");
  const payloadCut = parseCut(field(payload, "cut"));
  const actorEntry = exactRecord(
    field(payload, "actor"),
    ["userId", "deviceId", "writerId", "sessionId"],
    "RETENTION_RELEASE_INVALID",
  );
  for (const key of ["userId", "deviceId", "writerId", "sessionId"])
    identifier(field(actorEntry, key));
  // Bind the audited metadata to the acknowledged v1 recovery artifact,
  // not just to an arbitrary blob carrying a claimed artifact hash.
  if (digest({
    v: 1, kind: ARTIFACT_KIND,
    scope: field(payload, "scope"), cut: field(payload, "cut"),
    actor: field(payload, "actor"), fingerprint: field(payload, "fingerprint"),
    coverage: field(payload, "coverage"), holds: field(payload, "holds"),
    assets: field(payload, "assets"),
  }) !== artifactHash)
    throw new CollaborationError("RETENTION_AUDIT_MISMATCH");
  const audit = exactRecord(
    field(row, "audit"),
    ["hash", "uri", "uploadId", "attemptId", "receipt"],
    "RETENTION_RELEASE_INVALID",
  );
  const auditHash = hashValue(field(audit, "hash"), "RETENTION_RELEASE_INVALID");
  const uploadId = identifier(field(audit, "uploadId"));
  const attemptId = identifier(field(audit, "attemptId"));
  if (
    field(audit, "uri") !== ASSET_URI + auditHash ||
    uploadId !== "retention-audit-" + artifactHash
  )
    throw new CollaborationError("RETENTION_RELEASE_INVALID");
  const scope = parseScope(field(payload, "scope"));
  const expected = new TextEncoder().encode(canonical(payload));
  const scopeKey = scope.orgId + ":" + scope.workspaceId;
  const assetRaw = store.get(ASSET_NAMESPACE, scopeKey + ":" + auditHash);
  if (assetRaw === null)
    throw new CollaborationError("RETENTION_AUDIT_MISMATCH");
  const asset = assetRecord(assetRaw);
  if (
    asset.hash !== auditHash ||
    asset.bytes !== expected.byteLength ||
    !asset.uploads.includes(uploadId)
  )
    throw new CollaborationError("RETENTION_AUDIT_MISMATCH");
  const blob = store.blobGet(scopeKey, auditHash);
  if (
    blob === null ||
    blob.byteLength !== expected.byteLength ||
    createHash("sha256").update(blob).digest("hex") !== auditHash ||
    Buffer.compare(Buffer.from(blob), Buffer.from(expected)) !== 0
  )
    throw new CollaborationError("RETENTION_AUDIT_MISMATCH");
  const holdRaw = store.get(
    HOLDS_NAMESPACE,
    scope.orgId + ":" + scope.workspaceId + ":" + auditHash + ":" + uploadId,
  );
  if (holdRaw === null)
    throw new CollaborationError("RETENTION_AUDIT_MISMATCH");
  const hold = holdRecord(holdRaw);
  if (hold.hash !== auditHash || hold.holdId !== uploadId)
    throw new CollaborationError("RETENTION_AUDIT_MISMATCH");
  // Dependency holds are operational (not state-rooted). Explicit receipt
  // verification checks them too; the collector does not read audit blobs.
  const payloadAssets = field(payload, "assets");
  if (
    !Array.isArray(payloadAssets) ||
    !Array.isArray(field(payload, "holds")) ||
    field(record(field(payload, "coverage"), "RETENTION_RELEASE_INVALID"), "storeIds") === undefined
  )
    throw new CollaborationError("RETENTION_RELEASE_INVALID");
  for (const entry of payloadAssets) {
    const assetEntry = exactRecord(entry, ["hash", "uri", "bytes", "record"], "RETENTION_RELEASE_INVALID");
    const assetHash = hashValue(
      field(assetEntry, "hash"),
      "RETENTION_RELEASE_INVALID",
    );
    const original = assetRecord(field(assetEntry, "record"));
    const current = assetRecord(store.get(ASSET_NAMESPACE, scopeKey + ":" + assetHash));
    const bytes = store.blobGet(scopeKey, assetHash);
    if (original.hash !== assetHash ||
        field(assetEntry, "uri") !== ASSET_URI + assetHash ||
        field(assetEntry, "bytes") !== original.bytes ||
        current.hash !== assetHash || current.bytes !== original.bytes ||
        original.uploads.some((upload) => !current.uploads.includes(upload)) ||
        bytes === null || bytes.byteLength !== original.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== assetHash)
      throw new CollaborationError("RETENTION_AUDIT_MISMATCH");
    const dependency = store.get(
      HOLDS_NAMESPACE,
      scope.orgId + ":" + scope.workspaceId + ":" + assetHash + ":" + uploadId,
    );
    if (
      dependency === null ||
      holdRecord(dependency).hash !== assetHash ||
      holdRecord(dependency).holdId !== uploadId
    )
      throw new CollaborationError("RETENTION_AUDIT_MISMATCH");
  }
  // And every hold the payload claims to have released must actually be gone.
  for (const entry of field(payload, "holds") as unknown[]) {
    const holdEntry = record(entry, "RETENTION_RELEASE_INVALID");
    const key = field(holdEntry, "key");
    if (typeof key !== "string" || store.get(HOLDS_NAMESPACE, key) !== null)
      throw new CollaborationError("RETENTION_AUDIT_MISMATCH");
  }
  // The rooted attempt itself must be exactly the audited asset.publish:
  // same upload, hash, writer, scope, and base cut as the stored payload.
  const attemptKey = [
    scope.orgId, scope.workspaceId, scope.documentId, scope.incarnationId,
    field(actorEntry, "writerId"), attemptId,
  ].join(":");
  // SharedAuthority.commit stores an envelope, not the bare attempt.
  const envelope = record(
    store.get("authority.attempts", attemptKey),
    "RETENTION_AUDIT_MISMATCH",
  );
  const attemptEntry = record(
    field(envelope, "attempt"),
    "RETENTION_AUDIT_MISMATCH",
  );
  const receipt = record(field(audit, "receipt"), "RETENTION_AUDIT_MISMATCH");
  if (
    field(attemptEntry, "v") !== 1 ||
    field(attemptEntry, "attemptId") !== attemptId ||
    field(envelope, "state") !== "SERVER_ACCEPTED" ||
    field(envelope, "userId") !== field(actorEntry, "userId") ||
    field(envelope, "deviceId") !== field(actorEntry, "deviceId") ||
    canonical(field(envelope, "receipt")) !== canonical(receipt) ||
    field(envelope, "attemptHash") !== digest(attemptEntry) ||
    field(receipt, "attemptHash") !== digest(attemptEntry)
  )
    throw new CollaborationError("RETENTION_AUDIT_MISMATCH");
  if (!sameCut(parseCut(field(attemptEntry, "base")), payloadCut))
    throw new CollaborationError("RETENTION_AUDIT_MISMATCH");
  const intent = record(field(attemptEntry, "intent"), "RETENTION_AUDIT_MISMATCH");
  if (
    field(intent, "writerId") !== field(actorEntry, "writerId") ||
    field(envelope, "intentHash") !== digest(intent) ||
    field(receipt, "intentHash") !== digest(intent) ||
    field(receipt, "intentId") !== field(intent, "intentId") ||
    !sameCut(parseCut(field(intent, "base")), payloadCut)
  )
    throw new CollaborationError("RETENTION_AUDIT_MISMATCH");
  const command = exactRecord(
    field(intent, "command"),
    ["kind", "action", "payload"],
    "RETENTION_AUDIT_MISMATCH",
  );
  if (
    field(command, "kind") !== "resource" ||
    field(command, "action") !== "asset.publish"
  )
    throw new CollaborationError("RETENTION_AUDIT_MISMATCH");
  const commandPayload = exactRecord(
    field(command, "payload"),
    ["uploadId", "hash"],
    "RETENTION_AUDIT_MISMATCH",
  );
  if (
    field(commandPayload, "uploadId") !== uploadId ||
    field(commandPayload, "hash") !== auditHash ||
    !sameScope(parseScope(field(intent, "scope")), scope)
  )
    throw new CollaborationError("RETENTION_AUDIT_MISMATCH");
  // Exactly one rooted committed event may carry this attempt, and it must
  // carry exactly the stored accepted receipt at the audit cut.
  let found = 0;
  for (const event of [
    ...store.all("authority.events"),
    ...store.all("authority.archive.events"),
  ])
    if (field(record(event.value, "RETENTION_AUDIT_MISMATCH"), "attemptId") === attemptId &&
        field(record(event.value, "RETENTION_AUDIT_MISMATCH"), "writerId") === field(actorEntry, "writerId") &&
        sameScope(parseScope(field(record(event.value, "RETENTION_AUDIT_MISMATCH"), "scope")), scope)) {
      found++;
      const eventEntry = record(event.value, "RETENTION_AUDIT_MISMATCH");
      if (
        canonical(field(eventEntry, "receipt")) !==
          canonical(receipt) ||
        canonical(field(eventEntry, "command")) !== canonical(command) ||
        field(eventEntry, "intentId") !== field(intent, "intentId") ||
        field(eventEntry, "previousHash") !== payloadCut.hash
      )
        throw new CollaborationError("RETENTION_AUDIT_MISMATCH");
      const eventCut = parseCut({
        epoch: field(eventEntry, "epoch"),
        seq: field(eventEntry, "seq"),
        hash: field(eventEntry, "hash"),
      });
      const receiptCut = parseCut(field(receipt, "cut"));
      if (
        field(receipt, "status") !== "SERVER_ACCEPTED" ||
        field(receipt, "attemptId") !== attemptId ||
        !sameScope(parseScope(field(receipt, "scope")), scope) ||
        field(receipt, "writerId") !== field(actorEntry, "writerId") ||
        !sameCut(eventCut, receiptCut) ||
        receiptCut.epoch !== payloadCut.epoch ||
        receiptCut.seq !== payloadCut.seq + 1
      )
        throw new CollaborationError("RETENTION_AUDIT_MISMATCH");
    }
  if (found !== 1) throw new CollaborationError("RETENTION_AUDIT_MISMATCH");
  authority.verify();
  const cut = parseCut(field(record(field(audit, "receipt"), "RETENTION_AUDIT_MISMATCH"), "cut"));
  return {
    hash: auditHash,
    uri: ASSET_URI + auditHash,
    uploadId,
    attemptId,
    cut,
  };
}
