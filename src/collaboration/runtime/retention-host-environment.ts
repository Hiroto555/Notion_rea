import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import { synchronousPort } from "../../platform/synchronous-port";
import type { SharedAuthority } from "./authority";
import { canonical } from "./canonical";
import type { SharedRuntimeClient } from "./client";
import { CollaborationError, identifier, type Json } from "./contract";
import { digest } from "./digest";
import type {
  RetentionCoverageStore,
  RetentionReleaseCoverage,
  RetentionReleaseEnvironment,
} from "./retention-dependencies";
import type { RuntimeStore } from "./store";

/** An opaque private Store/journal keeps all evidence. Its owner supplies an
 * actual synchronous read lease, not a serialized "complete" flag. */
export interface RetainedEvidenceLease {
  inspect(): Readonly<{ generation: string; fingerprint: string; unresolved: boolean;
    statistics?: Readonly<{ rows: number; bytes: number; nodes: number }> }>;
  release(): void;
}
export interface RetainedEvidenceOwner {
  acquire(): RetainedEvidenceLease;
}

export type RetentionHostRoster = Readonly<{
  authority: SharedAuthority;
  runtimeStores: readonly Readonly<{ id: string; store: RuntimeStore }>[];
  clients: readonly Readonly<{ id: string; client: SharedRuntimeClient }>[];
  retainedStores: readonly Readonly<{ id: string; owner: RetainedEvidenceOwner }>[];
  unaccountedStores: readonly string[];
  generation?: string;
}>;

const OWNER = { acquire: { result: "object" } } as const;
const LEASE = {
  inspect: { result: "object" },
  release: { result: "void", cleanup: true },
} as const;

function binding(authority: SharedAuthority): string {
  const genesis = authority.store.get("meta", "genesis");
  if (genesis === null || authority.store.get("meta", "role") !== "authority")
    throw new CollaborationError("RETENTION_HOST_SOURCE_INVALID");
  return digest({ path: authority.store.path, genesis });
}

/**
 * Process-owned registry for a finite offline/embedded host. Construct it from
 * the actual owned handles, never from maintenance arguments. All clients,
 * caches, ordinary private Store, publication/recovery/source-binding journals
 * must be registered or explicitly unaccounted. It cannot discover remote
 * clients; a distributed host without that coverage must leave them unaccounted.
 *
 * The host serializes roster changes and client dispatch with withLease().
 * JS cannot resume an async client during this synchronous call; busy/pending
 * clients fail the real client snapshot. Opaque owners hold their own leases
 * throughout the operation. RuntimeStore locks are held by the release backend.
 */
export class RetentionHostRegistry implements RetentionReleaseEnvironment {
  readonly sourceBinding: string;
  private readonly roster: RetentionHostRoster;
  private leases: readonly Readonly<{ id: string; lease: RetainedEvidenceLease }>[] | null = null;
  private clientLeases: readonly Readonly<{
    id: string;
    lease: Readonly<{
      inspect(): Readonly<{ generation: string; roots: Json }>;
      release(): void;
    }>;
  }>[] | null = null;
  private state = { poisoned: false };
  /** Optional trusted observer: a producing host freezes roster edits while
   * an issued registry is leased. */
  onLeaseChange?: (leased: boolean) => void;
  /** Optional trusted staleness guard: invoked at lease entry and on every
   * inspect so a registry issued before a roster change cannot act on a
   * stale snapshot. */
  rosterCheck?: () => void;
  private get poisoned(): boolean { return this.state.poisoned; }
  private set poisoned(value: boolean) { this.state.poisoned = value; }

  constructor(roster: RetentionHostRoster) {
    this.sourceBinding = binding(roster.authority);
    const entries = [
      "authority",
      ...roster.runtimeStores.map(({ id }) => identifier(id)),
      ...roster.clients.map(({ id }) => identifier(id)),
      ...roster.retainedStores.map(({ id }) => identifier(id)),
    ];
    if (entries.length > 16 || new Set(entries).size !== entries.length)
      throw new CollaborationError("RETENTION_HOST_ROSTER_INVALID");
    if (roster.unaccountedStores.length > 16)
      throw new CollaborationError("RETENTION_HOST_ROSTER_INVALID");
    for (const id of roster.unaccountedStores) identifier(id);
    this.roster = {
      authority: roster.authority,
      runtimeStores: roster.runtimeStores.map((entry) => ({ ...entry })),
      clients: roster.clients.map((entry) => ({ ...entry })),
      retainedStores: roster.retainedStores.map((entry) => ({
        id: entry.id, owner: synchronousPort(entry.owner, OWNER),
      })),
      unaccountedStores: [...roster.unaccountedStores],
      ...(roster.generation === undefined ? {} : { generation: identifier(roster.generation) }),
    };
  }

  /** Fresh CLI open must still be the same source, not a restored incarnation. */
  bindAuthority(authority: SharedAuthority): RetentionHostRegistry {
    if (this.poisoned || this.leases !== null || binding(authority) !== this.sourceBinding)
      throw new CollaborationError("RETENTION_HOST_SOURCE_CHANGED");
    const bound = new RetentionHostRegistry({ ...this.roster, authority });
    bound.state = this.state;
    bound.onLeaseChange = this.onLeaseChange;
    bound.rosterCheck = this.rosterCheck;
    return bound;
  }

  withLease<T>(work: () => T): T {
    if (types.isAsyncFunction(work) || types.isGeneratorFunction(work))
      throw new CollaborationError("RETENTION_HOST_ASYNC");
    if (this.poisoned || this.leases !== null)
      throw new CollaborationError("RETENTION_HOST_LEASE_UNAVAILABLE");
    this.rosterCheck?.();
    this.onLeaseChange?.(true);
    const acquired: { id: string; lease: RetainedEvidenceLease }[] = [];
    const clientLeases: {
      id: string;
      lease: Readonly<{
        inspect(): Readonly<{ generation: string; roots: Json }>;
        release(): void;
      }>;
    }[] = [];
    let value!: T;
    const failures: unknown[] = [];
    try {
      for (const entry of this.roster.retainedStores) {
        try {
          const lease = synchronousPort(entry.owner.acquire(), LEASE);
          acquired.push({ id: entry.id, lease });
        } catch (cause) {
          this.poisoned = true;
          throw new Error("UNKNOWN: retention evidence lease acquisition", { cause });
        }
      }
      for (const { id, client } of this.roster.clients) {
        try {
          clientLeases.push({ id, lease: client.acquireRetentionLease() });
        } catch (cause) {
          if (cause instanceof CollaborationError) throw cause;
          this.poisoned = true;
          throw new Error("UNKNOWN: retention client lease acquisition", { cause });
        }
      }
      this.clientLeases = clientLeases;
      this.leases = acquired;
      // Guard even the host callback against deferred completion.
      const guarded = synchronousPort({ run: () => ({ value: work() }) }, {
        run: { result: "object" },
      });
      const result = guarded.run();
      const candidate = result.value;
      if (candidate !== null && (typeof candidate === "object" || typeof candidate === "function") &&
          typeof Reflect.get(candidate as object, "then") === "function") {
        this.poisoned = true;
        if (types.isPromise(candidate))
          Promise.prototype.then.call(candidate, undefined, () => undefined);
        throw new CollaborationError("RETENTION_HOST_ASYNC");
      }
      value = candidate;
    } catch (error) { failures.push(error); }
    finally {
      this.leases = null;
      this.clientLeases = null;
      for (const { lease } of clientLeases.reverse()) {
        try { lease.release(); } catch (cause) {
          failures.push(new Error("UNKNOWN: retention client lease cleanup", { cause }));
          this.poisoned = true;
        }
      }
      for (const { lease } of acquired.reverse()) {
        try { lease.release(); } catch (cause) {
          failures.push(new Error("UNKNOWN: retention host lease cleanup", { cause }));
          this.poisoned = true;
        }
      }
      try { this.onLeaseChange?.(false); } catch (cause) {
        failures.push(new Error("UNKNOWN: retention roster observer", { cause }));
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "UNKNOWN: retention host lease cleanup");
    return value;
  }

  inspect(): RetentionReleaseCoverage {
    this.rosterCheck?.();
    if (this.poisoned || this.leases === null)
      throw new CollaborationError("RETENTION_HOST_LEASE_REQUIRED");
    if (binding(this.roster.authority) !== this.sourceBinding)
      throw new CollaborationError("RETENTION_HOST_SOURCE_CHANGED");
    const stores: RetentionCoverageStore[] = [
      { id: "authority", store: this.roster.authority.store },
      ...this.roster.runtimeStores,
    ];
    // The roster declaration itself is a live root: any registration or
    // unaccounted-list drift changes the combined fingerprint.
    const rosterIds = [
      "authority",
      ...this.roster.runtimeStores.map(({ id }) => id),
      ...this.roster.clients.map(({ id }) => id),
      ...this.roster.retainedStores.map(({ id }) => id),
    ];
    const roots: Json[] = [{
      id: "__roster__",
      generation: digest({ roster: rosterIds, unaccounted: [...this.roster.unaccountedStores],
        revision: this.roster.generation ?? "static" }),
      roots: { roster: rosterIds, unaccounted: [...this.roster.unaccountedStores],
        revision: this.roster.generation ?? "static" },
    }];
    const unaccounted = [...this.roster.unaccountedStores];
    for (const { id, client } of this.roster.clients) {
      const lease = this.clientLeases?.find((entry) => entry.id === id);
      if (lease === undefined)
        throw new CollaborationError("RETENTION_HOST_LEASE_REQUIRED");
      const snapshot = lease.lease.inspect();
      roots.push({ id, generation: snapshot.generation, roots: snapshot.roots });
      stores.push({ id, store: client.store });
    }
    for (const { id, lease } of this.leases) {
      const evidence = lease.inspect();
      canonical(evidence, 1024);
      if (typeof evidence.unresolved !== "boolean" ||
          !["fingerprint,generation,unresolved", "fingerprint,generation,statistics,unresolved"]
            .includes(Object.keys(evidence).sort().join(",")) ||
          !/^[a-f0-9]{64}$/.test(evidence.fingerprint))
        throw new CollaborationError("RETENTION_HOST_EVIDENCE_INVALID");
      identifier(evidence.generation);
      stores.push({ id, retention: "RETAIN_ALL",
        generation: evidence.generation, fingerprint: evidence.fingerprint,
        ...(evidence.statistics === undefined ? {} : { statistics: evidence.statistics }) });
      if (evidence.unresolved) unaccounted.push(id);
    }
    canonical(roots, 2_000_000);
    return {
      requiredStoreIds: stores.map(({ id }) => id),
      stores,
      liveHistory: { status: "QUIESCENT", generation: digest(roots), roots },
      unaccountedStores: unaccounted,
    };
  }
}

/** Explicit SQLite cell encoding for evidence hashing: BLOB bytes are
 * hashed byte-exact, TEXT counts real UTF-8 bytes, and any exotic value
 * type fails closed. The original row is never rewritten or reserialized. */
function cellDigest(value: unknown): unknown {
  if (value === null) return { t: "null" };
  if (typeof value === "number") return { t: "number", v: String(value) };
  if (typeof value === "bigint") return { t: "bigint", v: String(value) };
  if (typeof value === "string")
    return { t: "text", n: Buffer.byteLength(value, "utf8"), h: digest(value) };
  if (value instanceof Uint8Array)
    return {
      t: "blob",
      n: value.byteLength,
      h: createHash("sha256").update(value).digest("hex"),
    };
  throw new CollaborationError("RETENTION_HOST_EVIDENCE_INVALID");
}

const NONTERMINAL_EVIDENCE = /PREPARED|UNKNOWN|RESERVED|DISPATCHED|PENDING|IN_FLIGHT|INFLIGHT/i;
/** Attempt/reservation tables only certify terminal lifecycle states;
 * anything else (RESERVED, DISPATCHED, or an unrecognized marker) is a
 * pending reservation that must block even without a literal UNKNOWN. */
const TERMINAL_EVIDENCE_STATE = new Set([
  "ABORTED",
  "ACCEPTED",
  "APPLIED",
  "CANCELLED",
  "COMMITTED",
  "COMPLETED",
  "CONFIRMED",
  "DONE",
  "EXECUTED",
  "EXPIRED",
  "FAILED",
  "FINAL",
  "RECEIPTED",
  "REJECTED",
  "PUBLISHED",
  "RESOLVED",
  "ROLLEDBACK",
  "SETTLED",
  "SUCCEEDED",
]);
const STATE_KEY = /^(state|status|outcome|resolution|result)$/i;
const RESERVATION_TABLE = /attempt|reserv|dispatch|outbox|queue/i;

/** Decode nested serialized evidence without changing the original bytes.
 * Raw substring matching alone misses JSON unicode-escaped UNKNOWN states. */
function unresolvedEvidence(
  value: unknown,
  reservation: boolean,
  budget: { nodes: number },
): boolean {
  const pending: { value: unknown; depth: number; key: string }[] = [
    { value, depth: 0, key: "" },
  ];
  let unresolved = false;
  let terminal = false;
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (++budget.nodes > 100_000 || item.depth > 16)
      throw new CollaborationError("RETENTION_HOST_LIMIT");
    const cell = item.value;
    if (cell instanceof Uint8Array) {
      // Fingerprinting remains byte-exact even if decoding is not possible.
      const raw = Buffer.from(cell).toString("utf8");
      if (NONTERMINAL_EVIDENCE.test(raw.replace(/\0/g, "")))
        unresolved = true;
      if (reservation && STATE_KEY.test(item.key)) unresolved = true;
      pending.push({ value: raw, depth: item.depth + 1, key: item.key });
    } else if (typeof cell === "string") {
      if (NONTERMINAL_EVIDENCE.test(cell)) unresolved = true;
      if (reservation && STATE_KEY.test(item.key) &&
          !TERMINAL_EVIDENCE_STATE.has(cell.toUpperCase()))
        unresolved = true;
      if (reservation && STATE_KEY.test(item.key) &&
          TERMINAL_EVIDENCE_STATE.has(cell.toUpperCase()))
        terminal = true;
      let decoded: unknown;
      try { decoded = JSON.parse(cell); } catch { continue; }
      if (typeof decoded === "string" && decoded === cell) continue;
      pending.push({ value: decoded, depth: item.depth + 1, key: item.key });
    } else if (cell !== null && typeof cell === "object") {
      for (const [key, child] of Object.entries(cell))
        pending.push({ value: child, depth: item.depth + 1, key });
    } else if (reservation && STATE_KEY.test(item.key)) {
      unresolved = true;
    }
  }
  return unresolved || (reservation && !terminal);
}

/** A bounded opaque SQLite inventory for RETAIN_ALL evidence. Reads every
 * schema object and row under the caller-held write lock; never writes,
 * never commits. Nonterminal attempt evidence (or anything shaped like a
 * pending reservation) pushes `unresolved` and blocks release. */
function inspectSqliteDatabase(
  db: DatabaseSync,
  expectedRole: string | null,
  expectedBinding?: string,
): ReturnType<RetainedEvidenceLease["inspect"]> {
  const schema = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master ORDER BY type, name LIMIT 10001",
    )
    .all() as Record<string, unknown>[];
  if (schema.length > 10_000)
    throw new CollaborationError("RETENTION_HOST_LIMIT");
  const schemaDigests = schema.map((row) => {
    const keys = Object.keys(row).sort();
    return digest(keys.map((key) => [key, cellDigest(row[key])]));
  });
  const tables = schema
    .filter((row) => row.type === "table")
    .map((row) => String(row.name));
  let role: string | null = null;
  let identityBinding: unknown;
  if (tables.includes("m3_private_identity")) {
    const rows = db
      .prepare("SELECT * FROM m3_private_identity LIMIT 2")
      .all() as Record<string, unknown>[];
    if (
      rows.length !== 1 ||
      rows[0]!.singleton !== 1 ||
      typeof rows[0]!.role !== "string" ||
      rows[0]!.version !== 1
    )
      throw new CollaborationError("RETENTION_HOST_EVIDENCE_INVALID");
    role = String(rows[0]!.role);
    identityBinding = rows[0]!.binding;
  } else if (tables.includes("artifact_identity")) {
    const rows = db
      .prepare("SELECT * FROM artifact_identity LIMIT 2")
      .all() as Record<string, unknown>[];
    if (
      rows.length !== 1 ||
      rows[0]!.singleton !== 1 ||
      typeof rows[0]!.role !== "string" ||
      rows[0]!.version !== 1
    )
      throw new CollaborationError("RETENTION_HOST_EVIDENCE_INVALID");
    role = String(rows[0]!.role);
    identityBinding = rows[0]!.binding;
  }
  if (expectedRole !== null && role !== expectedRole)
    throw new CollaborationError("RETENTION_HOST_ROLE_MISMATCH");
  if ((identityBinding !== undefined || expectedBinding !== undefined) &&
      (typeof identityBinding !== "string" || identityBinding.length === 0 || identityBinding !== expectedBinding))
    throw new CollaborationError("RETENTION_HOST_SOURCE_BINDING_REQUIRED");
  const rowDigests: string[] = [];
  let rows = 0;
  let bytes = 0;
  let unresolved = false;
  const budget = { nodes: schema.length * 4 };
  for (const row of schema)
    for (const cell of Object.values(row))
      bytes += typeof cell === "string" ? Buffer.byteLength(cell, "utf8") : 8;
  if (bytes > 8_000_000)
    throw new CollaborationError("RETENTION_HOST_LIMIT");
  for (const name of tables) {
    const safe = '"' + name.replace(/"/g, '""') + '"';
    for (const row of db
      .prepare(`SELECT * FROM ${safe} ORDER BY rowid`)
      .iterate()) {
      rows++;
      if (rows > 10_000)
        throw new CollaborationError("RETENTION_HOST_LIMIT");
      const entry = row as Record<string, unknown>;
      const keys = Object.keys(entry).sort();
      for (const key of keys) {
        const cell = entry[key];
        bytes += Buffer.byteLength(key, "utf8") + 8;
        if (typeof cell === "string") {
          bytes += Buffer.byteLength(cell, "utf8");
        } else if (cell instanceof Uint8Array) {
          bytes += cell.byteLength;
        }
        if (bytes > 8_000_000)
          throw new CollaborationError("RETENTION_HOST_LIMIT");
      }
      rowDigests.push(
        digest({ table: name, cells: keys.map((key) => [key, cellDigest(entry[key])]) }),
      );
      const reservation = RESERVATION_TABLE.test(name) ||
        (typeof entry.key === "string" && /(?:^|[:/_-])attempt(?:[:/_-]|$)/i.test(entry.key));
      unresolved = unresolvedEvidence(entry, reservation, budget) || unresolved;
    }
  }
  const fingerprint = digest({ schema: schemaDigests, rows: rowDigests });
  return { generation: fingerprint, fingerprint, unresolved,
    statistics: { rows: rows + schema.length, bytes, nodes: budget.nodes } };
}

/** Retained owner over an ordinary private Store's ALREADY-OPEN owned db.
 * The lease takes BEGIN IMMEDIATE on the real connection (excluding all
 * writers for the lease's duration), re-proves the live transaction on
 * EVERY inspect, and rolls back — never commits, never closes the store.
 * A rollback that fails leaves the owner poisoned: later acquisitions fail
 * rather than silently reading under an ambiguous lock. */
export function createStoreRetainedOwner(store: {
  path: string;
  db: DatabaseSync;
}, assertOwned?: () => void): RetainedEvidenceOwner {
  if (process.platform === "win32" && assertOwned === undefined)
    throw new CollaborationError("RETENTION_NATIVE_EVIDENCE_REQUIRED");
  const proof = assertOwned === undefined ? undefined : synchronousPort(
    { assertOwned }, { assertOwned: { result: "void" } },
  );
  let poisoned = false;
  return {
    acquire(): RetainedEvidenceLease {
      if (poisoned)
        throw new CollaborationError("RETENTION_HOST_LEASE_UNAVAILABLE");
      proof?.assertOwned();
      if (store.db.isTransaction)
        throw new CollaborationError("RETENTION_HOST_LEASE_UNAVAILABLE");
      store.db.exec("BEGIN IMMEDIATE");
      let released = false;
      return {
        inspect() {
          if (released || !store.db.isTransaction)
            throw new CollaborationError("RETENTION_HOST_LEASE_REQUIRED");
          proof?.assertOwned();
          return inspectSqliteDatabase(store.db, null);
        },
        release() {
          if (released) return;
          released = true;
          const failures: unknown[] = [];
          try { proof?.assertOwned(); } catch (error) { failures.push(error); }
          try { store.db.exec("ROLLBACK"); } catch (error) { failures.push(error); }
          if (failures.length > 0) {
            poisoned = true;
            throw new Error("UNKNOWN: retained store rollback", {
              cause: new AggregateError(failures),
            });
          }
        },
      };
    },
  };
}

/** Retained owner over an opaque existing SQLite journal by path. The
 * caller's assertOwned() is mandatory proof, re-run before open, on every
 * inspect and at release. The file must be present with no hot rollback
 * journal or WAL/SHM sidecars (an un-checkpointed writer state is not a
 * quiescent journal); a separate connection takes BEGIN IMMEDIATE with
 * busy_timeout=0 and trusted_schema off, and every exit rolls back and
 * closes the owned connection — never commits, never recovers. */
export function createRetainedSqliteOwner(spec: Readonly<{
  path: string;
  assertOwned: () => void;
  role?: string;
  binding?: string;
}>): RetainedEvidenceOwner {
  const proof = synchronousPort(
    { assertOwned: spec.assertOwned },
    { assertOwned: { result: "void" } },
  );
  let poisoned = false;
  return {
    acquire(): RetainedEvidenceLease {
      if (poisoned)
        throw new CollaborationError("RETENTION_HOST_LEASE_UNAVAILABLE");
      proof.assertOwned();
      if (
        !existsSync(spec.path) ||
        existsSync(spec.path + "-journal") ||
        existsSync(spec.path + "-wal") ||
        existsSync(spec.path + "-shm")
      )
        throw new CollaborationError("RETENTION_HOST_EVIDENCE_INVALID");
      // Existence and native/POSIX ownership must still hold after open.
      const db = new DatabaseSync(spec.path);
      let released = false;
      try {
        db.exec("PRAGMA busy_timeout=0");
        db.exec("PRAGMA trusted_schema=OFF");
        db.exec("BEGIN IMMEDIATE");
        proof.assertOwned();
        return {
          inspect: () => {
            if (released || !db.isTransaction)
              throw new CollaborationError("RETENTION_HOST_LEASE_REQUIRED");
            proof.assertOwned();
            return inspectSqliteDatabase(db, spec.role ?? null, spec.binding);
          },
          release: () => {
            if (released) return;
            released = true;
            const failures: unknown[] = [];
            try { proof.assertOwned(); } catch (error) { failures.push(error); }
            try {
              db.exec("ROLLBACK");
            } catch (error) {
              failures.push(error);
            }
            try {
              db.close();
            } catch (error) {
              failures.push(error);
            }
            if (failures.length > 0) {
              poisoned = true;
              throw new Error("UNKNOWN: retained sqlite cleanup", {
                cause: new AggregateError(failures),
              });
            }
          },
        };
      } catch (error) {
        const failures: unknown[] = [error];
        try {
          if (db.isTransaction) db.exec("ROLLBACK");
        } catch (cleanup) { failures.push(cleanup); }
        try {
          db.close();
        } catch (cleanup) { failures.push(cleanup); }
        if (failures.length > 1) {
          poisoned = true;
          throw new AggregateError(failures, "UNKNOWN: retained sqlite acquisition cleanup");
        }
        throw error;
      }
    },
  };
}

export type RetentionHostRegistration = Readonly<{ close(): void }>;

/**
 * Trusted in-process production host: the app owner registers its REAL
 * handles (runtime stores, live clients, private Stores, retained journals)
 * once; releases are only possible while every expected service ID is
 * registered. Registration is host code, never serialized caller input.
 * Closing a registration removes that coverage; a later registry() then
 * fails closed on the missing expected ID. Any registration change while an
 * issued registry is leased rejects.
 */
export class ProductionRetentionHost {
  private readonly authority: SharedAuthority;
  private readonly sourceBinding: string;
  private readonly expected: readonly string[];
  private readonly unaccounted: readonly string[];
  private readonly runtimeStores = new Map<string, RuntimeStore>();
  private readonly clients = new Map<string, SharedRuntimeClient>();
  private readonly retained = new Map<string, RetainedEvidenceOwner>();
  private readonly paths = new Set<string>();
  private leased = 0;
  /** Monotonic roster revision: every issued registry binds the revision at
   * issue and becomes permanently stale on any later roster change. */
  private revision = 0;

  constructor(options: Readonly<{
    authority: SharedAuthority;
    expectedServiceIds: readonly string[];
    unaccountedStores?: readonly string[];
  }>) {
    this.authority = options.authority;
    this.sourceBinding = binding(options.authority);
    // An authority-only disposable host legitimately declares zero extra
    // services; a distributed/unknown product surface is NOT this host.
    if (
      options.expectedServiceIds.length > 15 ||
      new Set(options.expectedServiceIds).size !==
        options.expectedServiceIds.length
    )
      throw new CollaborationError("RETENTION_HOST_ROSTER_INVALID");
    for (const id of options.expectedServiceIds) identifier(id);
    this.expected = [...options.expectedServiceIds];
    this.unaccounted = [...(options.unaccountedStores ?? [])];
    if (this.unaccounted.length > 16)
      throw new CollaborationError("RETENTION_HOST_ROSTER_INVALID");
    for (const id of this.unaccounted) identifier(id);
    this.paths.add(this.authority.store.path);
  }

  private claim(id: string, path: string | null): void {
    if (this.leased > 0)
      throw new CollaborationError("RETENTION_HOST_ROSTER_FROZEN");
    if (!this.expected.includes(id))
      throw new CollaborationError("RETENTION_HOST_UNEXPECTED");
    if (
      this.runtimeStores.has(id) ||
      this.clients.has(id) ||
      this.retained.has(id)
    )
      throw new CollaborationError("RETENTION_HOST_DUPLICATE");
    if (path !== null && this.paths.has(path))
      throw new CollaborationError("RETENTION_HOST_DUPLICATE");
  }

  private handle(remove: () => void): RetentionHostRegistration {
    let closed = false;
    return {
      close: () => {
        if (closed)
          throw new CollaborationError("RETENTION_HOST_CLOSED");
        if (this.leased > 0)
          throw new CollaborationError("RETENTION_HOST_ROSTER_FROZEN");
        closed = true;
        remove();
        this.revision++;
      },
    };
  }

  registerRuntimeStore(
    id: string,
    store: RuntimeStore,
  ): RetentionHostRegistration {
    identifier(id);
    this.claim(id, store.path);
    this.runtimeStores.set(id, store);
    this.paths.add(store.path);
    this.revision++;
    const path = store.path;
    return this.handle(() => {
      this.runtimeStores.delete(id);
      this.paths.delete(path);
    });
  }

  registerClient(
    id: string,
    client: SharedRuntimeClient,
  ): RetentionHostRegistration {
    identifier(id);
    this.claim(id, client.store.path);
    this.clients.set(id, client);
    this.paths.add(client.store.path);
    this.revision++;
    const path = client.store.path;
    return this.handle(() => {
      this.clients.delete(id);
      this.paths.delete(path);
    });
  }

  registerPrivateStore(
    id: string,
    store: { path: string; db: DatabaseSync },
    assertOwned?: () => void,
  ): RetentionHostRegistration {
    identifier(id);
    this.claim(id, store.path);
    this.retained.set(id, createStoreRetainedOwner(store, assertOwned));
    this.paths.add(store.path);
    this.revision++;
    const path = store.path;
    return this.handle(() => {
      this.retained.delete(id);
      this.paths.delete(path);
    });
  }

  registerRetainedSqlite(
    id: string,
    spec: Readonly<{
      path: string;
      assertOwned: () => void;
      role: string;
      binding?: string;
    }>,
  ): RetentionHostRegistration {
    identifier(id);
    this.claim(id, spec.path);
    this.retained.set(id, createRetainedSqliteOwner(spec));
    this.paths.add(spec.path);
    this.revision++;
    const path = spec.path;
    return this.handle(() => {
      this.retained.delete(id);
      this.paths.delete(path);
    });
  }

  /** Freeze the current roster into a registry bound to the actual
   * authority genesis/path. Any missing expected service ID blocks, and
   * any later roster change (register or close) makes this registry
   * permanently stale — never a silently shrinking snapshot. */
  registry(authority?: SharedAuthority): RetentionHostRegistry {
    const bound = authority ?? this.authority;
    if (binding(bound) !== this.sourceBinding)
      throw new CollaborationError("RETENTION_HOST_SOURCE_CHANGED");
    const missing = this.expected.filter(
      (id) =>
        !this.runtimeStores.has(id) &&
        !this.clients.has(id) &&
        !this.retained.has(id),
    );
    if (missing.length > 0)
      throw new CollaborationError("RETENTION_HOST_INCOMPLETE");
    const revision = this.revision;
    const registry = new RetentionHostRegistry({
      authority: bound,
      runtimeStores: [...this.runtimeStores].map(([id, store]) => ({ id, store })),
      clients: [...this.clients].map(([id, client]) => ({ id, client })),
      retainedStores: [...this.retained].map(([id, owner]) => ({ id, owner })),
      unaccountedStores: [...this.unaccounted],
      generation: String(revision),
    });
    registry.onLeaseChange = (leased) => {
      if (leased && this.leased > 0)
        throw new CollaborationError("RETENTION_HOST_LEASE_UNAVAILABLE");
      this.leased += leased ? 1 : -1;
    };
    registry.rosterCheck = () => {
      if (this.revision !== revision)
        throw new CollaborationError("RETENTION_HOST_ROSTER_STALE");
    };
    return registry;
  }
}
