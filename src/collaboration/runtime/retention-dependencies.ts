import { createHash } from "node:crypto";
import { canonical } from "./canonical";
import {
  demand,
  identifier,
  type Cut,
  type DocumentState,
  type Json,
} from "./contract";
import { DurableQueue } from "./durable-queue";
import { checkedState } from "./document";
import type { RuntimeStore } from "./store";
import { parseAttempt, parseCut, parseScope } from "./wire";

/**
 * Retention contract: inspect persisted evidence, never erase it. A candidate
 * means only "no observed persisted incoming reference", not permission to
 * delete. In-memory LocalHistory, other stores and backup durability are not
 * observable here. Editor states/versions and published assets are root-bound;
 * changing them requires the authority's audited commit, not direct SQL.
 * The caller must authorize this whole-store read using current authority.
 */
export type RetentionDependencyLimits = {
  maxRows?: number;
  maxRecordBytes?: number;
  maxReferences?: number;
  maxScanNodes?: number;
};

export type RetentionRecordKind =
  | "raw" | "intent" | "attempt" | "receipt" | "undo" | "event"
  | "editor-version" | "editor-state" | "current-state" | "history"
  | "asset" | "staging" | "recovery" | "other";

export type RetentionReference = Readonly<{
  namespace: string;
  key: string;
  path: string;
  kind: "asset" | "hash" | "raw" | "intent" | "attempt" | "receipt"
    | "undo" | "editor-version" | "event" | "cut";
  target: string;
}>;

type RecordEntry = Readonly<{
  namespace: string;
  key: string;
  bytes: number;
  hash: string;
  kinds: readonly RetentionRecordKind[];
}>;
type BlobEntry = Readonly<{ scope: string; hash: string; bytes: number }>;
type Unresolved = Readonly<{
  namespace: string;
  key: string;
  attemptId: string;
  state: "PREPARED" | "UNKNOWN";
  base: Cut;
}>;
export type RetentionTarget = Readonly<{
  kind: "asset" | "editor-state";
  namespace: "asset" | "editor.states";
  key: string;
  hash: string;
  bytes: number;
  blobScope: string | null;
}>;
export type RetentionDependencyInventory = Readonly<{
  v: 1;
  cut: Cut | null;
  fingerprint: string;
  records: readonly RecordEntry[];
  blobs: readonly BlobEntry[];
  recordBytes: number;
  blobBytes: number;
  references: readonly RetentionReference[];
  unresolved: readonly Unresolved[];
  targets: readonly RetentionTarget[];
  coverage: Readonly<{
    persistedRecords: "enumerated";
    blobContents: "NOT_VERIFIED";
    liveHistory: "UNAVAILABLE";
    otherStores: "NOT_ENUMERATED";
  }>;
}>;

const HASH = /^[a-f0-9]{64}$/;
const ASSET = "folio-asset://";
const scanCounts = new WeakMap<RetentionDependencyInventory, number>();
export function retentionInventoryScanNodes(inventory: RetentionDependencyInventory): number {
  const nodes = scanCounts.get(inventory);
  demand(nodes !== undefined, "RETENTION_DEPENDENCY_DRIFT");
  return nodes;
}
const DEFAULTS = {
  maxRows: 10_000,
  maxRecordBytes: 8_000_000,
  maxReferences: 20_000,
  maxScanNodes: 100_000,
};
const CEILINGS = {
  maxRows: 100_000,
  maxRecordBytes: 64 * 1024 * 1024,
  maxReferences: 100_000,
  maxScanNodes: 1_000_000,
};
const KINDS: Readonly<Record<string, readonly RetentionRecordKind[]>> = {
  "client.queue": ["raw", "intent", "attempt", "receipt"],
  "client.archived": ["raw", "intent", "attempt", "receipt"],
  "resource-client.archive": ["raw", "intent", "attempt", "receipt"],
  "client.editing": ["raw"],
  "client.drafts": ["raw"],
  "client.snapshots": ["current-state", "event", "receipt"],
  "authority.attempts": ["attempt", "intent", "receipt"],
  "authority.intents": ["intent", "receipt"],
  "authority.undo": ["undo"],
  "authority.events": ["event", "receipt"],
  "authority.archive.events": ["event", "receipt"],
  "authority.checkpoint": ["history"],
  "authority.prefix": ["history"],
  "history": ["history"],
  "restoreSeeds": ["history"],
  "documents": ["current-state"],
  "editor.versions": ["editor-version"],
  "editor.states": ["editor-state"],
  "asset": ["asset"],
  "asset.holds": ["asset"],
  "asset.staging": ["asset", "staging"],
  "asset.staging.owners": ["asset", "staging"],
  "copy.staging": ["staging", "raw"],
  "retention.releases": ["recovery"],
  "retention.recovery": ["recovery"],
};

function limits(input: RetentionDependencyLimits): typeof DEFAULTS {
  canonical(input);
  record(input);
  demand(
    Object.keys(input).every((key) => Object.hasOwn(DEFAULTS, key)),
    "INVALID_RETENTION_LIMIT",
  );
  const result = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) {
    const value = Object.hasOwn(input, key) ? input[key] : DEFAULTS[key];
    demand(
      typeof value === "number" && Number.isSafeInteger(value) &&
        value > 0 && value <= CEILINGS[key],
      "INVALID_RETENTION_LIMIT",
    );
    result[key] = value;
  }
  return result;
}

function record(value: unknown): Record<string, unknown> {
  demand(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "RETENTION_DEPENDENCY_DRIFT",
  );
  return value as Record<string, unknown>;
}

function count(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  demand(
    typeof number === "number" && Number.isSafeInteger(number) && number >= 0,
    "RETENTION_DEPENDENCY_DRIFT",
  );
  return number;
}

function text(value: unknown): string {
  demand(typeof value === "string" && value.length > 0, "RETENTION_DEPENDENCY_DRIFT");
  return value;
}

function hash(value: unknown): string {
  demand(typeof value === "string" && HASH.test(value), "RETENTION_DEPENDENCY_DRIFT");
  return value;
}

function sha(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Optional out-param for callers that need the internal scan cost. */
export type RetentionScanStats = { scanNodes?: number };

/**
 * No raw documents/blob payloads leave this inventory. Limits fail, never
 * truncate. Pass null explicitly for headless client stores: their queue bases
 * and snapshot cuts are observations, never an invented authority head.
 * `stats.scanNodes`, when supplied, receives the bounded value-scan cost so a
 * caller can enforce an aggregate bound across stores.
 */
export function inspectRetentionDependencies(
  store: RuntimeStore,
  expectedCut: Cut | null,
  input: RetentionDependencyLimits = {},
  stats?: RetentionScanStats,
  scanBudget?: { remaining: number },
): RetentionDependencyInventory {
  const bounded = limits(input);
  const expected = expectedCut === null ? null : parseCut(expectedCut);
  return store.transaction(() => {
    const totals = record(store.db.prepare(`
      SELECT
        (SELECT count(*) FROM runtime_records) AS records,
        (SELECT count(*) FROM runtime_blobs) AS blobs,
        (SELECT coalesce(sum(length(CAST(raw AS BLOB))),0) FROM runtime_records) AS recordBytes,
        (SELECT coalesce(sum(length(bytes)),0) FROM runtime_blobs) AS blobBytes
    `).get());
    const recordCount = count(totals.records), blobCount = count(totals.blobs);
    const recordBytes = count(totals.recordBytes), blobBytes = count(totals.blobBytes);
    demand(
      recordCount + blobCount <= bounded.maxRows &&
        recordBytes <= bounded.maxRecordBytes,
      "RETENTION_INVENTORY_LIMIT",
    );
    const head = store.get("meta", "head");
    demand(head !== null || expected === null, "RETENTION_HEAD_UNAVAILABLE");
    const cut = head === null ? null : parseCut(head);
    demand(canonical(cut) === canonical(expected), "RETENTION_PLAN_STALE");
    const rows = store.db.prepare(
      "SELECT namespace,key,length(CAST(raw AS BLOB)) AS bytes FROM runtime_records ORDER BY namespace,key LIMIT ?",
    ).all(bounded.maxRows + 1);
    const blobRows = store.db.prepare(
      "SELECT scope,hash,length(bytes) AS bytes FROM runtime_blobs ORDER BY scope,hash LIMIT ?",
    ).all(bounded.maxRows + 1);
    demand(
      rows.length === recordCount && blobRows.length === blobCount,
      "RETENTION_DEPENDENCY_DRIFT",
    );
    const blobs = blobRows.map((row): BlobEntry => ({
      scope: text(row.scope), hash: hash(row.hash), bytes: count(row.bytes),
    }));
    const blobSizes = new Map(blobs.map((blob) => [
      blob.scope + "\u0000" + blob.hash, blob.bytes,
    ]));
    const records: RecordEntry[] = [];
    const references: RetentionReference[] = [];
    const unresolved: Unresolved[] = [];
    const targets: RetentionTarget[] = [];
    const states = new Set<string>();
    const versionTargets: string[] = [];
    const fingerprint = createHash("sha256");
    let nodes = 0;

    for (const row of rows) {
      const namespace = text(row.namespace), key = text(row.key);
      const value = store.get(namespace, key);
      demand(value !== null, "RETENTION_DEPENDENCY_DRIFT");
      const raw = canonical(value, bounded.maxRecordBytes);
      const bytes = count(row.bytes);
      demand(Buffer.byteLength(raw) === bytes, "RETENTION_DEPENDENCY_DRIFT");
      const entry = {
        namespace, key, bytes, hash: sha(raw),
        kinds: Object.hasOwn(KINDS, namespace) ? KINDS[namespace] : ["other"],
      } satisfies RecordEntry;
      records.push(entry);
      fingerprint.update(canonical([namespace, key, entry.hash]) + "\n");
      const add = (kind: RetentionReference["kind"], target: string, path: string) => {
        demand(
          references.length < bounded.maxReferences && path.length <= 2048 &&
            target.length <= 2048,
          "RETENTION_INVENTORY_LIMIT",
        );
        references.push({ namespace, key, path, kind, target });
      };

      if (namespace === "client.queue") {
        const parts = key.split(":");
        demand(parts.length === 6, "RETENTION_DEPENDENCY_DRIFT");
        const scope = parseScope({
          orgId: parts[0], workspaceId: parts[1],
          documentId: parts[2], incarnationId: parts[3],
        });
        const queue = new DurableQueue(store, { scope, writerId: identifier(parts[4]) });
        demand(queue.read(identifier(parts[5])), "RETENTION_DEPENDENCY_DRIFT");
      }
      if (namespace === "editor.states") {
        hash(key);
        demand(sha(raw) === key, "EDITOR_VERSION_CORRUPT");
        checkedState(value as DocumentState);
        states.add(key);
        targets.push({ kind: "editor-state", namespace, key, hash: key, bytes, blobScope: null });
      }
      if (namespace === "editor.versions") {
        const parts = key.split(":");
        demand(parts.length === 6 && /^[0-9]{16}$/.test(parts[5]), "EDITOR_VERSION_CORRUPT");
        for (const part of parts.slice(0, 5)) identifier(part);
        count(Number(parts[5]));
        versionTargets.push(hash(value));
        add("editor-version", hash(value), "");
      }
      if (namespace === "asset") {
        const parts = key.split(":"), asset = record(value);
        demand(parts.length === 3, "RETENTION_DEPENDENCY_DRIFT");
        identifier(parts[0]); identifier(parts[1]);
        const assetHash = hash(parts[2]), size = count(asset.bytes);
        demand(
          Object.keys(asset).sort().join(",") === "bytes,hash,uploads" &&
            asset.hash === assetHash && Array.isArray(asset.uploads),
          "RETENTION_DEPENDENCY_DRIFT",
        );
        for (const upload of asset.uploads) identifier(upload);
        const blobScope = parts.slice(0, 2).join(":");
        demand(
          blobSizes.get(blobScope + "\u0000" + assetHash) === size,
          "RETENTION_DEPENDENCY_DRIFT",
        );
        targets.push({ kind: "asset", namespace, key, hash: assetHash, bytes: size, blobScope });
      }
      if (namespace !== "asset" && namespace !== "editor.states")
        for (const part of key.split(":"))
          if (HASH.test(part)) add("hash", part, "/$key");

      const walk = (item: unknown, path: string, depth: number): void => {
        if (scanBudget !== undefined) {
          demand(Number.isSafeInteger(scanBudget.remaining) && scanBudget.remaining > 0,
            "RETENTION_INVENTORY_LIMIT");
          scanBudget.remaining--;
        }
        demand(
          ++nodes <= bounded.maxScanNodes && depth <= 100 && path.length <= 2048,
          "RETENTION_INVENTORY_LIMIT",
        );
        if (typeof item === "string") {
          // A published asset's own identity is not an incoming reference.
          if (namespace === "asset" && path === "/hash") return;
          if (HASH.test(item)) add("hash", item, path);
          if (item.startsWith(ASSET)) {
            const target = item.slice(ASSET.length).replace(/\/$/, "");
            demand(HASH.test(target), "RETENTION_UNKNOWN_REFERENCE");
            add("asset", target, path);
          } else if (item.includes(ASSET) || /^\s*[\[{"]/.test(item)) {
            let decoded: unknown;
            try { decoded = JSON.parse(item); }
            catch {
              demand(!item.includes(ASSET), "RETENTION_UNKNOWN_REFERENCE");
              return;
            }
            walk(decoded, path + "/$json", depth + 1);
          }
          return;
        }
        if (Array.isArray(item)) {
          item.forEach((child, index) => walk(child, path + "/" + index, depth + 1));
        } else if (item !== null && typeof item === "object") {
          const object = record(item);
          if ((object.state === "UNKNOWN" || object.state === "PREPARED") && object.attempt) {
            const attempt = parseAttempt(object.attempt);
            unresolved.push({
              namespace, key, attemptId: attempt.attemptId,
              state: object.state, base: attempt.base,
            });
          }
          if ("epoch" in object && "seq" in object && "hash" in object &&
              Object.keys(object).length === 3)
            add("cut", canonical(parseCut(object)), path);
          if (object.v === 1 && typeof object.intentId === "string" &&
              typeof object.attemptId === "string" &&
              ["SERVER_ACCEPTED", "REJECTED", "INVALIDATED"].includes(String(object.status)))
            add("receipt", sha(canonical(object, bounded.maxRecordBytes)), path);
          if ("previousHash" in object && "receipt" in object && "seq" in object)
            add("event", hash(object.hash), path);
          for (const [name, child] of Object.entries(object)) {
            const segment = name.length > 128 ? "$key-sha256:" + sha(name) : name;
            const childPath = path + "/" + segment.replace(/~/g, "~0").replace(/\//g, "~1");
            if (HASH.test(name)) add("hash", name, childPath + "/$key");
            if (name === "raw" && typeof child === "string") add("raw", sha(child), childPath);
            if (typeof child === "string" &&
                (name === "intentId" || name === "attemptId" || name === "undoOf"))
              add(name === "intentId" ? "intent" : name === "attemptId" ? "attempt" : "undo", child, childPath);
            walk(child, childPath, depth + 1);
          }
        }
      };
      walk(value, "", 0);
    }
    demand(versionTargets.every((target) => states.has(target)), "EDITOR_VERSION_CORRUPT");
    for (const blob of blobs) fingerprint.update(canonical([blob.scope, blob.hash, blob.bytes]) + "\n");
    if (stats !== undefined) stats.scanNodes = nodes;
    const result: RetentionDependencyInventory = {
      v: 1, cut, fingerprint: fingerprint.digest("hex"),
      records, blobs, recordBytes, blobBytes, references, unresolved, targets,
      coverage: {
        persistedRecords: "enumerated", blobContents: "NOT_VERIFIED",
        liveHistory: "UNAVAILABLE", otherStores: "NOT_ENUMERATED",
      },
    };
    scanCounts.set(result, nodes);
    return result;
  });
}

export type RetentionReclamationPlan = Readonly<{
  v: 1;
  mode: "PLAN_ONLY";
  execution: "UNSUPPORTED";
  cut: Cut;
  fingerprint: string;
  candidates: readonly RetentionTarget[];
  protected: readonly Readonly<{ target: RetentionTarget; references: number }>[];
  unresolved: readonly Unresolved[];
  deletions: readonly never[];
  requiredConditions: readonly string[];
}>;

/**
 * Re-reads the live store, never trusts a caller-supplied inventory/proof.
 * Recheck BOTH cut and fingerprint at any future integration boundary: drafts,
 * holds and staging can change without advancing the authority head.
 * Historical version indexes, raw/intents/attempts/receipts/Undo/events are not
 * deletion targets. Even unindexed editor.states remain authority-root-bound.
 */
export function planRetentionReclamation(
  store: RuntimeStore,
  expectedCut: Cut,
  input: RetentionDependencyLimits = {},
): RetentionReclamationPlan {
  const inventory = inspectRetentionDependencies(store, parseCut(expectedCut), input);
  demand(inventory.cut !== null, "RETENTION_HEAD_UNAVAILABLE");
  const incoming = new Map<string, number>();
  for (const reference of inventory.references)
    if (reference.kind === "hash" || reference.kind === "asset" ||
        reference.kind === "editor-version")
      incoming.set(reference.target, (incoming.get(reference.target) ?? 0) + 1);
  const candidates: RetentionTarget[] = [];
  const protectedTargets: { target: RetentionTarget; references: number }[] = [];
  for (const target of inventory.targets) {
    const references = incoming.get(target.hash) ?? 0;
    if (references > 0) protectedTargets.push({ target, references });
    else candidates.push(target);
  }
  return {
    v: 1, mode: "PLAN_ONLY", execution: "UNSUPPORTED",
    cut: inventory.cut, fingerprint: inventory.fingerprint,
    candidates, protected: protectedTargets, unresolved: inventory.unresolved,
    deletions: [],
    requiredConditions: [
      "CURRENT_WHOLE_STORE_AUTHORIZATION",
      "DURABLE_WRITER_FENCE",
      "VERIFIED_BACKUP_FOR_EXACT_SNAPSHOT",
      "COMPLETE_LIVE_HISTORY_AND_EXTERNAL_ROOTS",
      "VERIFIED_BLOB_CONTENT_AND_REFERENCE_CLOSURE",
      "RECHECK_CUT_AND_FINGERPRINT_IN_AUTHORITY_TRANSACTION",
      "AUDITED_AUTHORITY_ROOTED_COMMIT",
    ],
  };
}

/** Public aliases for the bounded inventory entries above. */
export type RetentionRecordEntry = RecordEntry;
export type RetentionBlobEntry = BlobEntry;
export type RetentionUnresolvedEntry = Unresolved;

export const RETENTION_AUTHORITY_STORE_ID = "authority";
export const RETENTION_RELEASES_NAMESPACE = "retention.releases";
export const RETENTION_RECOVERY_NAMESPACE = "retention.recovery";

/**
 * Namespace retention contract: who owns the records, which caller writes
 * them, and what may ever happen to them. The catalog is deliberately
 * explicit for the runtime-owned namespaces catalogued here; ANY namespace absent
 * from it is unclassified evidence and must block a release rather than be
 * silently scoped into a deletion plan.
 *
 * `obligation` is a non-exclusive preservation classification (what a
 * retention path may do with the records); `authorityRooted` separately
 * records whether the namespace is bound by the authority state root —
 * the two are orthogonal (immutable evidence can still be rooted).
 *
 * - IMMUTABLE_EVIDENCE: raw/intent/attempt/receipt/undo/event/history and
 *   queue/archive payloads. Never released; a missing receipt is not
 *   non-application.
 * - ROOTED_STATE: records that only change via audited commits; a release
 *   path must not touch them.
 * - UNROOTED_OPERATIONAL: live metadata (head/control, staging, private
 *   caches). Changes are caught by the combined fingerprint, not by head
 *   movement.
 * - EXPLICIT_HOLD: asset.holds rows. The ONLY thing a verified retention
 *   release may remove, and only after durable recovery evidence exists.
 * - RECOVERY_EVIDENCE: retention.releases release receipts and
 *   retention.recovery artifact manifests. Immutable once written; they
 *   carry the asset references that keep released evidence recoverable.
 *
 * `authorityRooted` mirrors state-root.ts AUTHORITATIVE_NAMESPACES:
 * true for every namespace in the authority state root, "MIXED" for meta
 * (only some keys are rooted), false otherwise — including private
 * non-authority stores. This is the namespace's authority-context property,
 * not a claim that a private client/cache belongs to the authority root.
 */
export type RetentionObligation =
  | "IMMUTABLE_EVIDENCE"
  | "ROOTED_STATE"
  | "UNROOTED_OPERATIONAL"
  | "EXPLICIT_HOLD"
  | "RECOVERY_EVIDENCE";

export type RetentionNamespaceContract = Readonly<{
  namespace: string;
  owner: string;
  caller: string;
  obligation: RetentionObligation;
  authorityRooted: boolean | "MIXED";
}>;

const ROOTED = new Set([
  // Mirrors state-root.ts AUTHORITATIVE_NAMESPACES exactly.
  "asset",
  "authority.attempts",
  "authority.intents",
  "authority.undo",
  "databases",
  "copy.staging",
  "doclifecycles",
  "documents",
  "editor.states",
  "editor.versions",
  "identity.devices",
  "identity.invites",
  "identity.membership-generations",
  "identity.recovery",
  "identity.recovery-status",
  "identity.sessions",
  "identity.users",
  "operations.fences",
  "operations.upgrades",
  "operations.protocol",
  "organization",
  "page.titles",
  "pages",
  "records",
  "restoreSeeds",
  "workspace.roles",
  "workspaces",
]);

function contract(
  namespace: string,
  owner: string,
  caller: string,
  obligation: RetentionObligation,
): RetentionNamespaceContract {
  return {
    namespace,
    owner,
    caller,
    obligation,
    authorityRooted:
      namespace === "meta" ? "MIXED" : ROOTED.has(namespace),
  };
}

const CONTRACTS: readonly RetentionNamespaceContract[] = [
  contract("meta", "store", "RuntimeStore/SharedAuthority", "UNROOTED_OPERATIONAL"),
  contract("asset", "assets", "SharedAssets.publish", "ROOTED_STATE"),
  contract("asset.holds", "assets", "SharedAssets.hold", "EXPLICIT_HOLD"),
  contract("asset.staging", "assets", "SharedAssets.stage", "UNROOTED_OPERATIONAL"),
  contract("asset.staging.owners", "authority", "SharedAuthority.stageAsset", "UNROOTED_OPERATIONAL"),
  contract("authority.attempts", "authority", "SharedAuthority.commit", "IMMUTABLE_EVIDENCE"),
  contract("authority.intents", "authority", "SharedAuthority.commit", "IMMUTABLE_EVIDENCE"),
  contract("authority.undo", "authority", "undo-witness", "IMMUTABLE_EVIDENCE"),
  contract("authority.events", "authority", "SharedAuthority.commit", "IMMUTABLE_EVIDENCE"),
  contract("authority.archive.events", "retention", "RetentionService.compact", "IMMUTABLE_EVIDENCE"),
  contract("authority.checkpoint", "retention", "RetentionService.compact", "IMMUTABLE_EVIDENCE"),
  contract("authority.prefix", "authority", "SharedAuthority.commit", "IMMUTABLE_EVIDENCE"),
  contract("backup.verifications", "operations", "SharedAuthority.retention.verifyBackup", "IMMUTABLE_EVIDENCE"),
  contract("client.queue", "client", "DurableQueue", "IMMUTABLE_EVIDENCE"),
  contract("client.archived", "client", "SharedClient", "IMMUTABLE_EVIDENCE"),
  contract("client.drafts", "client", "SharedClient", "IMMUTABLE_EVIDENCE"),
  contract("client.editing", "client", "SharedClient", "IMMUTABLE_EVIDENCE"),
  contract("client.snapshots", "client", "SharedClient", "IMMUTABLE_EVIDENCE"),
  contract("connections", "main/shared-runtime-service", "SharedRuntimeService.cache", "UNROOTED_OPERATIONAL"),
  contract("resource-client.archive", "resource-client", "ResourceClient", "IMMUTABLE_EVIDENCE"),
  contract("copy.staging", "copy", "SharedCopyStaging", "ROOTED_STATE"),
  contract("databases", "records", "applyRecords", "ROOTED_STATE"),
  contract("doclifecycles", "lifecycle", "DocumentLifecycle", "ROOTED_STATE"),
  contract("documents", "lifecycle", "SharedAuthority document commit", "ROOTED_STATE"),
  contract("editor.states", "editor", "rememberEditorVersions", "ROOTED_STATE"),
  contract("editor.versions", "editor", "rememberEditorVersions", "ROOTED_STATE"),
  contract("history", "lifecycle", "DocumentLifecycle.capture", "IMMUTABLE_EVIDENCE"),
  contract("identity.devices", "identity", "IdentityAuthority", "ROOTED_STATE"),
  contract("identity.invites", "identity", "IdentityAuthority", "ROOTED_STATE"),
  contract("identity.membership-generations", "identity", "IdentityAuthority", "ROOTED_STATE"),
  contract("identity.recovery", "identity", "IdentityAuthority", "ROOTED_STATE"),
  contract("identity.recovery-status", "identity", "IdentityAuthority", "ROOTED_STATE"),
  contract("identity.sessions", "identity", "IdentityAuthority", "ROOTED_STATE"),
  contract("identity.users", "identity", "IdentityAuthority", "ROOTED_STATE"),
  contract("operations.backups", "operations", "RuntimeOperations.recordBackup", "UNROOTED_OPERATIONAL"),
  contract("operations.fences", "operations", "RuntimeOperations", "ROOTED_STATE"),
  contract("operations.protocol", "operations", "migrateEditorProtocol", "ROOTED_STATE"),
  contract("operations.upgrades", "operations", "RuntimeOperations", "ROOTED_STATE"),
  contract("organization", "organization", "OrganizationService", "ROOTED_STATE"),
  contract("organization.audit", "organization", "OrganizationService", "IMMUTABLE_EVIDENCE"),
  contract("page.titles", "pages", "SharedAuthority", "ROOTED_STATE"),
  contract("pages", "pages", "SharedAuthority", "ROOTED_STATE"),
  contract("records", "records", "applyRecords", "ROOTED_STATE"),
  contract("restoreSeeds", "lifecycle", "DocumentLifecycle.restore", "IMMUTABLE_EVIDENCE"),
  contract("workspaces", "policy", "WorkspacePolicy", "ROOTED_STATE"),
  contract("workspace.roles", "policy", "WorkspacePolicy", "ROOTED_STATE"),
  contract("retention.releases", "retention", "SharedRetentionRelease", "RECOVERY_EVIDENCE"),
  contract("retention.recovery", "retention", "SharedRetentionRelease", "RECOVERY_EVIDENCE"),
];

const CONTRACT_BY_NAMESPACE = new Map(
  CONTRACTS.map((entry) => [entry.namespace, entry]),
);

/** The catalog itself, for audits; lookup uses retentionNamespaceContract. */
export function retentionNamespaceContracts(): readonly RetentionNamespaceContract[] {
  return CONTRACTS;
}

/** null means unclassified persisted evidence: a release must fail closed. */
export function retentionNamespaceContract(
  namespace: string,
): RetentionNamespaceContract | null {
  return CONTRACT_BY_NAMESPACE.get(namespace) ?? null;
}

/**
 * Trusted host coverage for a retention release. This is configured host
 * integration, NEVER serialized caller input: the caller cannot enumerate or
 * vouch for the product's stores. The parent that wires this port must map a
 * real product roster (authority RuntimeStore under the stable id
 * "authority", every other live RuntimeStore, and typed RETAIN_ALL entries
 * for non-RuntimeStore durable evidence such as an ordinary private Store or
 * a Windows publication journal) and a real live-history quiescence export.
 * Anything the host cannot account for stays in unaccountedStores and blocks.
 * inspect() is synchronous. The host must hold a lease excluding live-history,
 * roster and opaque-store mutations for the ENTIRE maintenance invocation.
 * RetentionHostRegistry supplies that host boundary for owned offline hosts.
 */
export type RetentionCoverageStore =
  | Readonly<{ id: string; store: RuntimeStore }>
  | Readonly<{
      id: string;
      retention: "RETAIN_ALL";
      generation: string;
      fingerprint: string;
      /** Production SQLite scan charges against the shared release budget. */
      statistics?: Readonly<{ rows: number; bytes: number; nodes: number }>;
    }>;

export type RetentionLiveHistory =
  | Readonly<{ status: "QUIESCENT"; generation: string; roots: Json }>
  | Readonly<{ status: "UNAVAILABLE" }>;

export type RetentionReleaseCoverage = Readonly<{
  requiredStoreIds: readonly string[];
  stores: readonly RetentionCoverageStore[];
  liveHistory: RetentionLiveHistory;
  unaccountedStores: readonly string[];
}>;

export interface RetentionReleaseEnvironment {
  inspect(): RetentionReleaseCoverage;
}
