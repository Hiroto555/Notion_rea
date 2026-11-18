import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, relative, isAbsolute, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import { synchronousPrivatePlatform, type PrivatePlatform } from "../../sync/private-platform";
import { preflightExistingJournal } from "../../sync/journal-preflight";
import { SyncSqliteGuard } from "../../sync/sqlite-guard";
import { SqliteConnectionOwner, closeSqlitePlatform } from "../../sync/sqlite-connection-owner";
import { isAuthorityLeasePlatform } from "./authority-lease";
import type { NativePrivatePersistenceAuthority } from "./private-persistence";
import {asciiCaseFold, assertWindowsProbe, validateWindowsPath, type WindowsProbeEvidence} from "./path-policy";
import type { NativePrivateFile, NativePrivateIdentity, NativePrivateTree } from "../private-persistence";
import type { WindowsRecoveryMissingReceipt } from "./private-recovery-io";
import {
  getKCapacityRefusal,
  observeKReserveInvocation,
  recordKCapacityRefusal,
  type KReserveObservationFacts,
} from "../private-mutation-diagnostic";
import { assertWindowsMaintenanceScope, decodeWindowsMaintenanceOrigin,
  encodeWindowsMaintenanceOrigin, WINDOWS_MAINTENANCE_ORIGIN_MAX_BYTES,
  type WindowsMaintenanceOriginProvider, type WindowsMaintenanceOriginRequest } from "./private-maintenance-scope";

const NAME = "private-persistence-v1.sqlite";
const MAX_DATA = 512 * 1024 * 1024;
const MAX_METADATA = 8 * 1024 * 1024;
const MAX_VALUE = 64 * 1024;
const MAX_ATTEMPTS = 64;
const MAX_ROWS = 4096;
export type WindowsPrivateMaintenanceContext = Readonly<{
  workspace: string; workspaceId: string; workspaceFingerprint: string;
  writerId: string; sessionId: string; osSid: string;
}>;
export type WindowsPrivatePersistenceInspection = Readonly<{
  attemptId: string; fingerprint: string; binding: string;
  target: string; resources: readonly string[]; metadata: string;
  original: Uint8Array; wire: Uint8Array; origin?: Uint8Array;
  captures: Readonly<{stdout?: Uint8Array; stderr?: Uint8Array; status?: Uint8Array}>;
  terminal: Readonly<{state: string; receipt: string}> | null;
  resolution: string | null;
}>;
/** Production supplies these from its bound native ports, never request JSON.
 * In particular ABSENT must come from C3 readMissing on the held parent. */
export type WindowsPrivatePersistenceMaintenanceProof = Readonly<{
  assertCurrent(context: WindowsPrivateMaintenanceContext): void;
  directory(path: string): NativePrivateIdentity;
  file(path: string, maxBytes: number): NativePrivateFile;
  tree(path: string): NativePrivateTree;
  missing(path: string, parent: Readonly<{fileId: string; volumeId: string}>): WindowsRecoveryMissingReceipt;
}>;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`PRIVATE_PERSISTENCE_JOURNAL_${message}`);
}
function resourceKey(path: unknown): string {
  requireValue(typeof path === "string" && /^[A-Z]:\\[\x20-\x7e]*$/.test(path) && path.length <= 240, "RESOURCE");
  requireValue(validateWindowsPath(path, path.slice(0, 3)).canonical === path, "RESOURCE");
  return asciiCaseFold(path).replace(/\\$/, "");
}
function overlapping(a: string, b: string): boolean {
  return a === b || a.startsWith(b + "\\") || b.startsWith(a + "\\");
}
function voidCall(fn: () => void): void {
  requireValue(!types.isAsyncFunction(fn) && !types.isGeneratorFunction(fn), "ASYNC");
  const result: unknown = fn();
  if (types.isPromise(result)) Promise.prototype.then.call(result, undefined, () => undefined);
  requireValue(result === undefined, "ACK");
}
function assertSeparated(directory: string, forbiddenRoots: readonly string[]): void {
  for (const root of forbiddenRoots) {
    const a = relative(root, directory), b = relative(directory, root);
    const inside = (s: string) => s === "" || (!isAbsolute(s) && s !== ".." && !s.startsWith("../") && !s.startsWith("..\\"));
    requireValue(!inside(a) && !inside(b), "ROOT_OVERLAP");
  }
}

/**
 * Separate append-only SQLite data authority. It never borrows PrivateLedger's
 * 8MiB/4096-row allowance: metadata retains those bounds here, and exact binary
 * originals/wire/captures use a separate 512MiB reservation. No row is updated
 * or deleted. An unresolved target blocks all subsequent mutations after reopen.
 *
 * Production requires C's native held authority platform. The platform owns
 * root/main handles with no DELETE sharing while allowing SQLite READ|WRITE.
 * Tests may supply an explicitly labelled POSIX contract adapter on non-Windows.
 */
export class WindowsPrivatePersistenceJournal implements NativePrivatePersistenceAuthority {
  readonly version = 1 as const;
  readonly independent = true as const;
  private readonly platform: PrivatePlatform;
  private readonly guard: SyncSqliteGuard;
  private readonly owner: SqliteConnectionOwner;
  private readonly path: string;
  private readonly local = new Set<string>();
  private poisoned = false;
  private closed = false;
  private closing = false;
  private readonly current: () => void;
  private readonly bindingBytes: number;
  private readonly binding: string;

  private readonly originProvider: WindowsMaintenanceOriginProvider | undefined;

  constructor(directory: string, platform: PrivatePlatform, binding: string,
    assertCurrent: () => void, forbiddenRoots: readonly string[],
    originProvider?: WindowsMaintenanceOriginProvider) {
    if (originProvider !== undefined)
      requireValue(typeof originProvider === "function" && !types.isAsyncFunction(originProvider) &&
        !types.isGeneratorFunction(originProvider), "PROVIDER");
    requireValue(typeof binding === "string" && binding.length > 0 &&
      Buffer.byteLength(binding) <= MAX_VALUE, "BINDING");
    requireValue(typeof assertCurrent === "function" && !types.isAsyncFunction(assertCurrent) &&
      !types.isGeneratorFunction(assertCurrent), "CURRENT");
    requireValue(forbiddenRoots.length > 0, "SEPARATE_ROOT_REQUIRED");
    assertSeparated(directory, forbiddenRoots);
    if (process.platform === "win32") requireValue(isAuthorityLeasePlatform(platform), "NATIVE_LEASE_REQUIRED");
    // Reserved after pure validation but before facade wrap/native bind/any
    // SQLite open; the closure still releases the raw supplied platform when
    // facade wrapping itself fails.
    let facade: PrivatePlatform | undefined;
    this.owner = new SqliteConnectionOwner(() => closeSqlitePlatform(facade ?? platform));
    this.current = assertCurrent;
    this.originProvider = originProvider;
    this.bindingBytes = Buffer.byteLength(binding);
    this.binding = binding;
    try {
      const wrapped = facade = synchronousPrivatePlatform(platform);
      const root = wrapped.bind(directory);
      assertSeparated(root, forbiddenRoots);
      this.platform = wrapped;
      this.path = join(root, NAME);
      wrapped.createExclusive(this.path);
      wrapped.assertFile(this.path);
      wrapped.assertSidecars(this.path);
      const schema = (db: DatabaseSync) => {
        const names = db.prepare("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
        requireValue((names.length === 5 || names.length === 6) && names.every(row => row.type === "table" &&
          ["identity", "attempts", "blobs", "terminals", "reservation_releases", "resolutions"].includes(String(row.name))) &&
          ["identity", "attempts", "blobs", "terminals", "reservation_releases"].every(name => names.some(row => row.name === name)), "SCHEMA");
        const rows = db.prepare("SELECT * FROM identity").all();
        requireValue(rows.length === 1 && rows[0].version === 2 && rows[0].binding === binding, "BINDING");
      };
      if (lstatSync(this.path).size > 0) preflightExistingJournal(this.path, () => {
        wrapped.assertRoot(); wrapped.assertFile(this.path); wrapped.assertSidecars(this.path);
      }, schema, wrapped, this.owner);
      const db = new DatabaseSync(this.path);
      this.owner.opened(db);
      const guard = this.owner.guarded(db);
      this.guard = guard;
      requireValue(guard.db.prepare("PRAGMA page_size").get()?.page_size === 4096, "PAGE_SIZE");
      guard.db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA max_page_count=262144");
      guard.transaction(() => {
        if (guard!.db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length === 0) {
          this.platform.assertEmptyFile(this.path);
          guard!.db.exec("CREATE TABLE identity(version INTEGER NOT NULL,binding TEXT NOT NULL);" +
            "CREATE TABLE attempts(id TEXT PRIMARY KEY,target TEXT NOT NULL,resources TEXT NOT NULL,budget INTEGER NOT NULL,metadata TEXT NOT NULL);" +
            "CREATE TABLE blobs(id TEXT NOT NULL,kind TEXT NOT NULL,bytes BLOB NOT NULL,sha TEXT NOT NULL,PRIMARY KEY(id,kind));" +
            "CREATE TABLE terminals(id TEXT PRIMARY KEY,state TEXT NOT NULL,receipt TEXT NOT NULL);" +
            "CREATE TABLE reservation_releases(id TEXT PRIMARY KEY,unused INTEGER NOT NULL,receipt_sha TEXT NOT NULL)");
          guard!.db.prepare("INSERT INTO identity VALUES(2,?)").run(binding);
        } else schema(guard!.db);
        // Additive v2 extension; identity, originals, terminals and the parent's
        // exact-byte reservation releases are never rewritten.
        guard!.db.exec("CREATE TABLE IF NOT EXISTS resolutions(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,receipt TEXT NOT NULL)");
      });
      this.assertCurrent();
    } catch (error) {
      // Owned constructor cleanup: never retries an attempted close, never
      // releases the native lease while a handle is unproven.
      this.owner.fail(error);
    }
  }

  assertCurrent(): void {
    requireValue(!this.closed && !this.closing && !this.poisoned, "UNAVAILABLE");
    this.platform.assertRoot(); this.platform.assertFile(this.path); this.platform.assertSidecars(this.path);
    this.guard.assertUsable();
    voidCall(this.current);
  }
  private transaction(work: () => void, facts?: KReserveObservationFacts): void {
    this.assertCurrent();
    let committed = false;
    try {
      this.guard.transaction(() => { this.assertCurrent(); work(); this.assertCurrent(); });
      committed = true;
      this.assertCurrent();
    } catch (error) {
      if (facts !== undefined) {
        if (this.guard.isUncertainFailure(error)) facts.uncertainty = "TRANSACTION";
        else if (committed) facts.uncertainty = "READBACK";
      }
      this.poisoned = true; throw error;
    }
  }
  private put(id: string, kind: string, bytes: Uint8Array): void {
    this.guard.db.prepare("INSERT INTO blobs VALUES(?,?,?,?)").run(id, kind, bytes, hash(bytes));
  }
  /** Synchronous provider fence: the scope must be identical when sampled
   * before and inside the append transaction. An async answer is rejected
   * before any side effect. */
  private provisionOrigin(request: WindowsMaintenanceOriginRequest): Uint8Array | undefined {
    const provider = this.originProvider;
    if (provider === undefined) return undefined;
    const provided: unknown = provider(request);
    if (types.isPromise(provided)) Promise.prototype.then.call(provided, undefined, () => undefined);
    requireValue(provided === undefined || (provided !== null && typeof provided === "object"), "PROVIDER");
    return provided === undefined ? undefined : encodeWindowsMaintenanceOrigin(provided);
  }
  private originRequest(attemptId: string, wire: Uint8Array, header: {path: string; destination?: string; root?: string}):
      WindowsMaintenanceOriginRequest & Readonly<{root: string}> {
    const root = header.root;
    requireValue(typeof root === "string", "HEADER");
    const seen = new Set<string>(), paths: string[] = [];
    for (const p of [header.path, header.destination]) {
      if (typeof p !== "string") continue;
      const k = asciiCaseFold(p).replace(/\\$/, "");
      if (!seen.has(k)) { seen.add(k); paths.push(p); }
    }
    return Object.freeze({family: "filesystem", attemptId, requestSha256: hash(wire),
      root, paths: Object.freeze(paths)});
  }
  /** Bind a supplied scope to the immutable wire before it is persisted: the
   * retained root and endpoint parent native IDs must equal the wire's. */
  private assertOriginBound(origin: Uint8Array,
      request: WindowsMaintenanceOriginRequest & Readonly<{root: string}>,
      header: {path: string; destination?: string}): void {
    const scope = decodeWindowsMaintenanceOrigin(origin);
    const folded = (v: unknown) => typeof v === "string" ? asciiCaseFold(v).replace(/\\$/, "") : undefined;
    const destDiffers = folded(header.destination) !== undefined && folded(header.destination) !== folded(header.path);
    requireValue(scope.family === request.family && scope.attemptId === request.attemptId &&
      scope.requestSha256 === request.requestSha256 &&
      folded(scope.root.path) === folded(request.root) &&
      scope.root.fileId === (header as Record<string, unknown>).rootFileId &&
      scope.root.volumeId === (header as Record<string, unknown>).rootVolumeId &&
      scope.endpoints.length === request.paths.length, "PROVIDER");
    const h = header as Record<string, unknown>;
    requireValue(scope.endpoints.every((e, i) => {
      const dest = i === request.paths.length - 1 && destDiffers;
      return asciiCaseFold(e.path) === asciiCaseFold(request.paths[i]) &&
        e.parent.fileId === (dest ? h.destinationDirectoryFileId : h.directoryFileId) &&
        e.parent.volumeId === (dest ? h.destinationDirectoryVolumeId : h.directoryVolumeId);
    }), "PROVIDER");
  }
  private originBlobBytes(): number {
    return Number(this.guard.db.prepare(
      "SELECT coalesce(sum(length(bytes)),0) AS n FROM blobs WHERE kind='origin:scope'").get()?.n ?? 0);
  }
  private read(id: string, kind: string): Buffer {
    const row = this.guard.db.prepare("SELECT bytes,sha FROM blobs WHERE id=? AND kind=?").get(id, kind);
    requireValue(row?.bytes instanceof Uint8Array && row.sha === hash(row.bytes), "READBACK");
    return Buffer.from(row.bytes);
  }
  reserve(intent: Parameters<NativePrivatePersistenceAuthority["reserve"]>[0]): void {
    observeKReserveInvocation(intent, facts => this.reserveCore(intent, facts));
  }
  private reserveCore(
    intent: Parameters<NativePrivatePersistenceAuthority["reserve"]>[0],
    facts?: KReserveObservationFacts,
  ): void {
    requireValue(/^[a-f0-9]{32}$/.test(intent.attemptId), "ATTEMPT");
    requireValue(intent.wire instanceof Uint8Array && intent.payload instanceof Uint8Array &&
      intent.wire.length <= 32 * 1024 * 1024 + 16384 && intent.payload.length <= 32 * 1024 * 1024 + 4096, "WIRE");
    requireValue(Number.isSafeInteger(intent.maxCaptureBytes) && intent.maxCaptureBytes >= 0 &&
      intent.maxCaptureBytes <= 34 * 1024 * 1024, "CAPTURE_BOUND");
    const wire = Buffer.from(intent.wire), payload = Buffer.from(intent.payload);
    const n = wire.readUInt32LE(0);
    requireValue(n > 0 && n <= 8192 && wire.length >= n + 4, "HEADER");
    const header = JSON.parse(wire.subarray(4, n + 4).toString("ascii"));
    requireValue(header.attemptId === intent.attemptId && typeof header.path === "string", "HEADER");
    // Both names are consumed for rename/copy, so UNKNOWN cannot be bypassed by
    // selecting another destination. Canonical Windows names fold ASCII case.
    const resources: string[] = [header.path, ...(typeof header.destination === "string" ? [header.destination] : [])]
      .map(resourceKey);
    const metadata = JSON.stringify({ targetKey: intent.targetKey, wire: hash(wire), payload: hash(payload),
      maxCaptureBytes: intent.maxCaptureBytes });
    requireValue(Buffer.byteLength(metadata) <= MAX_VALUE, "METADATA");
    // The origin scope is sampled once outside and once inside the append
    // transaction; any drift fails the reservation atomically, never a
    // downgrade to the legacy inside-workspace predicate. With no provider
    // configured nothing is claimed and the request fields are not required.
    const originReq = this.originProvider === undefined ? undefined :
      this.originRequest(intent.attemptId, wire, header);
    const origin = originReq === undefined ? undefined : this.provisionOrigin(originReq);
    const budget = wire.length + payload.length + 2 * intent.maxCaptureBytes + 4096 + (origin?.length ?? 0);
    this.transaction(() => {
      const inside = originReq === undefined ? undefined : this.provisionOrigin(originReq);
      requireValue((origin === undefined) === (inside === undefined) &&
        (origin === undefined || Buffer.from(origin).equals(Buffer.from(inside!))), "PROVIDER_DRIFT");
      if (origin !== undefined && originReq !== undefined) this.assertOriginBound(origin, originReq, header);
      const db = this.guard.db;
      const rows = db.prepare("SELECT a.*,t.state,t.receipt,r.unused,r.receipt_sha,s.receipt AS resolution FROM attempts a LEFT JOIN terminals t ON t.id=a.id LEFT JOIN reservation_releases r ON r.id=a.id LEFT JOIN resolutions s ON s.id=a.id").all();
      let capturedOriginBytes: number | undefined;
      let metadataAdmitted: boolean | undefined;
      try {
        requireValue(metadataAdmitted = (
          rows.length < MAX_ATTEMPTS && (rows.length + 1) * 10 + 1 <= MAX_ROWS &&
          this.bindingBytes + (rows.length + 1) * (3 * MAX_VALUE + 8192) +
          (capturedOriginBytes = this.originBlobBytes()) +
          (origin?.length ?? 0) <= MAX_METADATA
        ), "METADATA_CAPACITY");
      } catch (error) {
        if (metadataAdmitted === false && capturedOriginBytes !== undefined) {
          const rowCount = rows.length;
          const slotBytes = 3 * MAX_VALUE + 8192;
          const originLength = origin?.length ?? 0;
          const prior = this.bindingBytes + rowCount * slotBytes + capturedOriginBytes;
          const candidate = this.bindingBytes + (rowCount + 1) * slotBytes + capturedOriginBytes + originLength;
          if (Number.isSafeInteger(rowCount) && rowCount >= 0 && rowCount < MAX_ATTEMPTS &&
            (rowCount + 1) * 10 + 1 <= MAX_ROWS &&
            Number.isSafeInteger(this.bindingBytes) && this.bindingBytes >= 0 &&
            Number.isSafeInteger(capturedOriginBytes) && capturedOriginBytes >= 0 &&
            Number.isSafeInteger(originLength) && originLength >= 0 &&
            Number.isSafeInteger(prior) && prior >= 0 && prior <= MAX_METADATA &&
            Number.isSafeInteger(candidate) && candidate >= 0 && candidate > MAX_METADATA &&
            ((typeof error === "object" && error !== null) || typeof error === "function")) {
            recordKCapacityRefusal(error as object, intent.attemptId, "PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY");
            if (facts !== undefined) facts.capacityRefusal = getKCapacityRefusal(error);
          }
        }
        throw error;
      }
      let dataCapacityEligible = Number.isSafeInteger(budget) && budget >= 0;
      let charged = budget;
      for (const row of rows) {
        const resolved = row.resolution !== null;
        if (resolved) {
          const inspection = this.inspect(String(row.id));
          const resolution = JSON.parse(String(row.resolution));
          requireValue(resolution.state === "APPLIED_OBSERVED" && resolution.fingerprint === inspection.fingerprint, "RESOLUTION");
        }
        const blocked = row.state !== "APPLIED" && !resolved;
        if (blocked) requireValue(!(JSON.parse(String(row.resources)) as string[]).some(p => resources.some(q => overlapping(p, q))), "UNRESOLVED");
        const unused = row.unused === null ? 0 : Number(row.unused);
        requireValue(Number.isSafeInteger(unused) && unused >= 0 && unused <= Number(row.budget) &&
          (unused === 0 || ((row.state === "APPLIED" || resolved) &&
            row.receipt_sha === hash(String(resolved ? row.resolution : row.receipt)))), "RESERVATION_RELEASE");
        if (row.unused !== null) {
          const retained = Number(db.prepare("SELECT coalesce(sum(length(bytes)),0) AS n FROM blobs WHERE id=?").get(row.id)?.n);
          requireValue((row.state === "APPLIED" || resolved) && row.receipt_sha === hash(String(resolved ? row.resolution : row.receipt)) &&
            retained === Number(row.budget) - unused, "RESERVATION_RELEASE");
        }
        const rowBudget = Number(row.budget);
        const contribution = rowBudget - unused;
        charged += contribution;
        dataCapacityEligible = dataCapacityEligible &&
          Number.isSafeInteger(rowBudget) && rowBudget >= 0 &&
          Number.isSafeInteger(contribution) && contribution >= 0 &&
          Number.isSafeInteger(charged) && charged >= 0;
      }
      try {
        requireValue(charged <= MAX_DATA, "DATA_CAPACITY");
      } catch (error) {
        const prior = charged - budget;
        if (dataCapacityEligible &&
          Number.isSafeInteger(charged) && charged >= 0 &&
          Number.isSafeInteger(budget) && budget >= 0 &&
          Number.isSafeInteger(prior) && prior >= 0 &&
          prior <= MAX_DATA && charged > MAX_DATA &&
          ((typeof error === "object" && error !== null) || typeof error === "function")) {
          recordKCapacityRefusal(error as object, intent.attemptId, "PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY");
          if (facts !== undefined) facts.capacityRefusal = getKCapacityRefusal(error);
        }
        throw error;
      }
      db.prepare("INSERT INTO attempts VALUES(?,?,?,?,?)").run(intent.attemptId, intent.targetKey,
        JSON.stringify(resources), budget, metadata);
      this.put(intent.attemptId, "wire", wire); this.put(intent.attemptId, "original", payload);
      if (origin !== undefined) this.put(intent.attemptId, "origin:scope", origin);
    }, facts);
    try {
      requireValue(this.read(intent.attemptId, "wire").equals(wire) &&
        this.read(intent.attemptId, "original").equals(payload) &&
        (origin === undefined || this.read(intent.attemptId, "origin:scope").equals(Buffer.from(origin))), "READBACK");
      this.assertCurrent();
      if (facts !== undefined) facts.uncertainty = "ASSOCIATION";
      this.local.add(intent.attemptId); // Reopen never acquires old dispatch rights.
      if (facts !== undefined) facts.uncertainty = undefined;
    } catch (error) {
      if (facts !== undefined && facts.uncertainty === undefined) facts.uncertainty = "READBACK";
      this.poisoned = true; throw error;
    }
  }
  capture(id: string, capture: Parameters<NativePrivatePersistenceAuthority["capture"]>[1]): void {
    requireValue(this.local.has(id), "NOT_OWNER");
    const out = Buffer.from(capture.stdout), err = Buffer.from(capture.stderr);
    this.transaction(() => {
      const row = this.guard.db.prepare("SELECT metadata FROM attempts WHERE id=?").get(id);
      const max = JSON.parse(String(row?.metadata)).maxCaptureBytes;
      requireValue(out.length <= max && err.length <= max, "CAPTURE_CAPACITY");
      this.put(id, "stdout", out); this.put(id, "stderr", err);
      const status = Buffer.from(JSON.stringify({ status: capture.status, signal: capture.signal, errorCode: capture.errorCode }));
      requireValue(status.length <= 4096, "STATUS");
      this.put(id, "status", status);
    });
    try { requireValue(this.read(id, "stdout").equals(out) && this.read(id, "stderr").equals(err), "READBACK"); }
    catch (error) { this.poisoned = true; throw error; }
  }
  terminal(id: string, state: "APPLIED" | "UNKNOWN", receipt: string): void {
    requireValue(this.local.has(id) && (state === "APPLIED" || state === "UNKNOWN") &&
      Buffer.byteLength(receipt) <= MAX_VALUE, "TERMINAL");
    this.transaction(() => {
      if (state === "APPLIED") {
        const wire = this.read(id, "wire"), original = this.read(id, "original"), stdout = this.read(id, "stdout");
        const requestSize = wire.readUInt32LE(0), replySize = stdout.readUInt32LE(0);
        requireValue(requestSize > 0 && requestSize <= 8192 && requestSize + 4 <= wire.length &&
          replySize > 0 && replySize <= 8192 && replySize + 4 <= stdout.length, "APPLIED_FRAME");
        const request = JSON.parse(wire.subarray(4, requestSize + 4).toString("ascii"));
        const replyText = stdout.subarray(4, replySize + 4).toString("ascii"), reply = JSON.parse(replyText);
        const body = JSON.parse(receipt), status = JSON.parse(this.read(id, "status").toString("utf8"));
        requireValue(wire.subarray(requestSize + 4).equals(original) && this.read(id, "stderr").length === 0 &&
          status.status === 0 && status.signal === null && status.errorCode === undefined &&
          body.attemptId === id && body.operation === request.operation && body.path === (request.destination ?? request.path) &&
          body.status === 0 && JSON.stringify(body.reply) === replyText && JSON.stringify(reply) === replyText &&
          reply.contractVersion === 4 && reply.attemptId === id && reply.state === "APPLIED" &&
          reply.operation === request.operation && reply.path === request.path && reply.root === request.root, "APPLIED_EVIDENCE");
      }
      this.guard.db.prepare("INSERT INTO terminals VALUES(?,?,?)").run(id, state, receipt);
      if (state === "APPLIED") {
        const budget = Number(this.guard.db.prepare("SELECT budget FROM attempts WHERE id=?").get(id)?.budget);
        const retained = Number(this.guard.db.prepare("SELECT coalesce(sum(length(bytes)),0) AS n FROM blobs WHERE id=?").get(id)?.n);
        requireValue(Number.isSafeInteger(budget) && Number.isSafeInteger(retained) && retained >= 0 && retained <= budget, "RESERVATION_RELEASE");
        // Only unused worst-case capacity is released. Every original, wire,
        // capture, intent and terminal remains immutable and fully charged.
        this.guard.db.prepare("INSERT INTO reservation_releases VALUES(?,?,?)").run(id, budget - retained, hash(receipt));
      }
    });
    const row = this.guard.db.prepare("SELECT state,receipt FROM terminals WHERE id=?").get(id);
    if (row?.state !== state || row.receipt !== receipt) { this.poisoned = true; throw new Error("TERMINAL_READBACK_UNKNOWN"); }
    this.local.delete(id);
  }
  listAttempts(): readonly string[] {
    this.assertCurrent();
    const rows = this.guard.db.prepare("SELECT id FROM attempts ORDER BY id LIMIT 65").all();
    requireValue(rows.length <= MAX_ATTEMPTS, "CAPACITY");
    return Object.freeze(rows.map(row => String(row.id)));
  }
  /** Exact originals/captures are detached copies. The fingerprint covers all
   * immutable source bytes and the original terminal, excluding appended proof. */
  inspect(id: string): WindowsPrivatePersistenceInspection {
    this.assertCurrent();
    requireValue(/^[a-f0-9]{32}$/.test(id), "ATTEMPT");
    const db = this.guard.db, row = db.prepare("SELECT * FROM attempts WHERE id=?").get(id);
    requireValue(row, "MISSING");
    const blobs = db.prepare("SELECT kind,length(bytes) AS n,sha FROM blobs WHERE id=? ORDER BY kind").all(id);
    requireValue(blobs.length >= 2 && blobs.length <= 6 &&
      blobs.every(b => ["original", "wire", "stdout", "stderr", "status", "origin:scope"].includes(String(b.kind))) &&
      blobs.reduce((sum, b) => sum + Number(b.n), 0) <= Number(row.budget) && Number(row.budget) <= MAX_DATA, "BLOBS");
    const wire = this.read(id, "wire"), original = this.read(id, "original");
    const metadata = JSON.parse(String(row.metadata));
    requireValue(metadata.wire === hash(wire) && metadata.payload === hash(original) &&
      Buffer.byteLength(String(row.metadata)) <= MAX_VALUE, "METADATA");
    const optional = (kind: string) => blobs.some(b => b.kind === kind) ? this.read(id, kind) : undefined;
    const origin = optional("origin:scope");
    if (origin !== undefined) {
      // A retained scope is re-validated against its own immutable wire on
      // every read — a tampered/mismatched blob fails closed, never falls
      // back to the legacy inside-workspace predicate.
      requireValue(origin.length <= WINDOWS_MAINTENANCE_ORIGIN_MAX_BYTES, "BLOBS");
      const scope = decodeWindowsMaintenanceOrigin(origin);
      const n2 = wire.readUInt32LE(0);
      const h2 = JSON.parse(wire.subarray(4, n2 + 4).toString("ascii"));
      const req = this.originRequest(id, wire, h2);
      requireValue(scope.family === "filesystem" && scope.attemptId === id &&
        scope.requestSha256 === req.requestSha256 &&
        asciiCaseFold(scope.root.path) === asciiCaseFold(req.root) &&
        scope.endpoints.length === req.paths.length &&
        scope.endpoints.every((e, i) => asciiCaseFold(e.path) === asciiCaseFold(req.paths[i])), "ORIGIN");
    }
    const captures = {stdout: optional("stdout"), stderr: optional("stderr"), status: optional("status")};
    const terminalRow = db.prepare("SELECT state,receipt FROM terminals WHERE id=?").get(id);
    const terminal = terminalRow ? {state: String(terminalRow.state), receipt: String(terminalRow.receipt)} : null;
    requireValue(terminal === null || (["UNKNOWN", "APPLIED"].includes(terminal.state) &&
      Buffer.byteLength(terminal.receipt) <= MAX_VALUE), "TERMINAL");
    const fingerprint = hash(JSON.stringify({binding: this.binding, id, target: row.target,
      resources: row.resources, budget: row.budget, metadata: row.metadata, blobs, terminal}));
    const resolution = db.prepare("SELECT fingerprint,receipt FROM resolutions WHERE id=?").get(id);
    requireValue(!resolution || resolution.fingerprint === fingerprint, "RESOLUTION_FINGERPRINT");
    this.assertCurrent();
    return Object.freeze({attemptId: id, fingerprint, binding: this.binding, target: String(row.target),
      resources: Object.freeze(JSON.parse(String(row.resources)) as string[]), metadata: String(row.metadata),
      wire, original, origin: origin && Uint8Array.from(origin), captures: Object.freeze(captures),
      terminal: terminal && Object.freeze(terminal),
      resolution: resolution ? String(resolution.receipt) : null});
  }

  /** Explicit append-only observation. No native mutation, replay, deletion or
   * grant of old dispatch rights occurs, including after a process restart. */
  investigate(request: Readonly<{attemptId: string; fingerprint: string; context: WindowsPrivateMaintenanceContext}>,
    proof: WindowsPrivatePersistenceMaintenanceProof): WindowsPrivatePersistenceInspection {
    requireValue(/^[a-f0-9]{64}$/.test(request.fingerprint), "FINGERPRINT");
    const context = JSON.parse(JSON.stringify(request.context)) as WindowsPrivateMaintenanceContext;
    requireValue(context && Object.keys(context).sort().join(",") ===
      "osSid,sessionId,workspace,workspaceFingerprint,workspaceId,writerId" &&
      /^[a-f0-9]{64}$/.test(context.workspaceFingerprint) && /^S-1-\d+(?:-\d+)+$/.test(context.osSid) &&
      [context.workspaceId, context.writerId, context.sessionId].every(s => typeof s === "string" && s.length > 0 && s.length <= 128) &&
      Buffer.byteLength(JSON.stringify(context)) <= 4096, "CONTEXT");
    resourceKey(context.workspace);
    for (const method of ["assertCurrent", "directory", "file", "tree", "missing"] as const)
      requireValue(typeof proof[method] === "function" && !types.isAsyncFunction(proof[method]) &&
        !types.isGeneratorFunction(proof[method]), "ASYNC");
    const current = () => voidCall(() => proof.assertCurrent(context));
    current();
    const initial = this.inspect(request.attemptId);
    requireValue(initial.fingerprint === request.fingerprint && initial.resolution === null &&
      initial.terminal?.state !== "APPLIED", "CONFLICT");
    // Investigation never shares dispatch rights with a still-local attempt.
    // Revocation is conservative even if the subsequent observation fails.
    this.local.delete(initial.attemptId);
    const evidence = this.proveApplied(initial, context, proof);
    current();
    const receipt = JSON.stringify({state: "APPLIED_OBSERVED", attemptId: initial.attemptId,
      fingerprint: initial.fingerprint, originalBinding: initial.binding, context, evidence});
    requireValue(Buffer.byteLength(receipt) <= MAX_VALUE, "METADATA");
    this.transaction(() => {
      current(); // Authorization and session fence INSIDE the append CAS.
      const before = this.inspect(request.attemptId);
      requireValue(before.fingerprint === initial.fingerprint && before.resolution === null, "CONFLICT");
      requireValue(JSON.stringify(this.proveApplied(before, context, proof)) === JSON.stringify(evidence), "NATIVE_CHANGED");
      current();
      const db = this.guard.db;
      const used = Number(db.prepare("SELECT coalesce(sum(length(CAST(metadata AS BLOB))),0) AS n FROM attempts").get()?.n) +
        Number(db.prepare("SELECT coalesce(sum(length(CAST(receipt AS BLOB))),0) AS n FROM terminals").get()?.n) +
        Number(db.prepare("SELECT coalesce(sum(length(CAST(receipt AS BLOB))),0) AS n FROM resolutions").get()?.n) +
        this.originBlobBytes();
      requireValue(this.bindingBytes + used + Buffer.byteLength(receipt) <= MAX_METADATA, "METADATA_CAPACITY");
      db.prepare("INSERT INTO resolutions VALUES(?,?,?)").run(initial.attemptId, initial.fingerprint, receipt);
      const budget = Number(db.prepare("SELECT budget FROM attempts WHERE id=?").get(initial.attemptId)?.budget);
      const retained = Number(db.prepare("SELECT coalesce(sum(length(bytes)),0) AS n FROM blobs WHERE id=?").get(initial.attemptId)?.n);
      requireValue(Number.isSafeInteger(retained) && retained >= 0 && retained <= budget, "RESERVATION_RELEASE");
      db.prepare("INSERT INTO reservation_releases VALUES(?,?,?)").run(initial.attemptId, budget - retained, hash(receipt));
      current();
    });
    current();
    const after = this.inspect(initial.attemptId);
    requireValue(after.resolution === receipt && after.fingerprint === initial.fingerprint, "RESOLUTION_READBACK_UNKNOWN");
    return after;
  }

  private proveApplied(item: WindowsPrivatePersistenceInspection, context: WindowsPrivateMaintenanceContext,
    proof: WindowsPrivatePersistenceMaintenanceProof): Record<string, unknown> {
    const frame = (bytes: Uint8Array) => {
      const b = Buffer.from(bytes);
      requireValue(b.length >= 4, "UNKNOWN_UNRESOLVABLE");
      const n = b.readUInt32LE(0);
      requireValue(n > 0 && n <= 8192 && b.length >= 4 + n, "UNKNOWN_UNRESOLVABLE");
      const text = b.subarray(4, n + 4).toString("ascii");
      requireValue([...b.subarray(4, n + 4)].every(c => c >= 32 && c <= 126), "UNKNOWN_UNRESOLVABLE");
      const header = JSON.parse(text);
      requireValue(header !== null && typeof header === "object" && !Array.isArray(header) &&
        JSON.stringify(header) === text, "UNKNOWN_UNRESOLVABLE");
      return {header, payload: b.subarray(n + 4)};
    };
    const {header: h, payload} = frame(item.wire);
    requireValue(h.contractVersion === 4 && h.attemptId === item.attemptId &&
      payload.equals(Buffer.from(item.original)) && Number.isSafeInteger(h.byteLength) &&
      h.byteLength >= 0 && h.byteLength <= 256 * 1024 * 1024 &&
      (h.maxBytes === undefined || (Number.isSafeInteger(h.maxBytes) && h.maxBytes >= h.byteLength &&
        h.maxBytes <= 256 * 1024 * 1024)), "UNKNOWN_UNRESOLVABLE");
    const source = resourceKey(h.path), destination = h.destination === undefined ? source : resourceKey(h.destination);
    // The retained origin scope — not the current workspace predicate —
    // decides which native root a legacy UNKNOWN is re-proven under. An
    // internal legacy record keeps the old strict predicate; an external
    // legacy record stays UNKNOWN_UNRESOLVABLE forever.
    assertWindowsMaintenanceScope(item.origin,
      this.originRequest(item.attemptId, item.wire, h),
      {workspace: context.workspace, workspaceId: context.workspaceId, osSid: context.osSid},
      {directory: path => proof.directory(path)});
    const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && asciiCaseFold(a) === asciiCaseFold(b);
    const root = proof.directory(h.root);
    requireValue(same(root.path, h.root) && same(root.fileId, h.rootFileId) && same(root.volumeId, h.rootVolumeId), "ROOT_CHANGED");
    const target = h.destination ?? h.path, parentPath = win32.dirname(target);
    const parent = proof.directory(parentPath);
    requireValue(same(parent.path, parentPath) && same(parent.fileId, h.destinationDirectoryFileId ?? h.directoryFileId) &&
      same(parent.volumeId, h.destinationDirectoryVolumeId ?? h.directoryVolumeId), "DIRECTORY_CHANGED");
    const rename = h.operation === "rename-new" || h.operation === "rename-directory-new";
    const absent = (path: string, id: {fileId: string; volumeId: string}) => {
      const result = proof.missing(path, id);
      requireValue(result.contractVersion === 3 && result.state === "ABSENT" && result.path === path &&
        same(result.directory.fileId, id.fileId) && same(result.directory.volumeId, id.volumeId), "UNKNOWN_UNRESOLVABLE");
      return result;
    };
    if (rename) {
      requireValue(/^[a-fA-F0-9]{32}$/.test(h.sourceFileId) && /^[a-f0-9]{64}$/.test(h.sourceSha256) &&
        h.sourceVolumeId === h.rootVolumeId && item.original.length === 0, "UNKNOWN_UNRESOLVABLE");
      const targetProof = h.operation === "rename-directory-new" ? proof.tree(target) : proof.file(target, h.maxBytes);
      requireValue(same(targetProof.path, target) && same(targetProof.fileId, h.sourceFileId) &&
        same(targetProof.volumeId, h.sourceVolumeId) && targetProof.sha256 === h.sourceSha256 &&
        targetProof.bytes === h.byteLength &&
        (h.operation !== "rename-directory-new" || (targetProof as NativePrivateTree).entries === h.entries), "UNKNOWN_UNRESOLVABLE");
      const sourceParent = proof.directory(win32.dirname(h.path));
      requireValue(same(sourceParent.path, win32.dirname(h.path)) &&
        same(sourceParent.fileId, h.directoryFileId) && same(sourceParent.volumeId, h.directoryVolumeId) &&
        (h.operation !== "rename-directory-new" || (Number.isSafeInteger(h.entries) && h.entries >= 1 && h.entries <= 4096)),
      "DIRECTORY_CHANGED");
      const missing = absent(h.path, {fileId: h.directoryFileId, volumeId: h.directoryVolumeId});
      return {operation: h.operation, root, parent, target: targetProof, sourceParent, missing};
    }
    // New outputs need their ORIGINAL captured native ID. Equal current bytes,
    // empty/missing captures, or absence alone cannot establish application.
    requireValue(["write-new", "copy-new", "unlink-exact", "prove-sync"].includes(h.operation) &&
      item.captures.stdout && item.captures.stderr?.length === 0 && item.captures.status, "UNKNOWN_UNRESOLVABLE");
    const status = JSON.parse(Buffer.from(item.captures.status).toString("utf8"));
    requireValue(status.status === 0 && status.signal === null && status.errorCode === undefined, "UNKNOWN_UNRESOLVABLE");
    const {header: ack, payload: ackPayload} = frame(item.captures.stdout);
    const ackKeys = ["contractVersion", "operation", "path", "root", "state", "file", "directory",
      "byteLength", "sha256", "filesystem", "attemptId", "sourceDirectory", "destination", "unlinked", "contentFlushed",
      ...(h.operation === "unlink-exact" ? [] : ["durability"])];
    requireValue(Object.keys(ack).every(key => ackKeys.includes(key)) &&
      (ack.destination === undefined || ack.destination === h.destination), "UNKNOWN_UNRESOLVABLE");
    requireValue(ack.contractVersion === 4 && ack.state === "APPLIED" && ack.attemptId === item.attemptId &&
      ack.operation === h.operation && ack.path === h.path && ack.root === h.root && ack.filesystem === "NTFS" &&
      ack.byteLength === h.byteLength && ack.sha256 === (h.sha256 ?? h.sourceSha256 ?? h.expectedSha256), "UNKNOWN_UNRESOLVABLE");
    const native = (value: unknown, path: string): WindowsProbeEvidence => {
      assertWindowsProbe(value, {canonicalPath: path, canonicalRoot: h.root});
      const v = value as WindowsProbeEvidence;
      requireValue(same(v.rootFileId, h.rootFileId) && same(v.rootVolumeId, h.rootVolumeId) &&
        same(v.volumeId, h.rootVolumeId) && v.sid === context.osSid, "UNKNOWN_UNRESOLVABLE");
      return v;
    };
    const f = native(ack.file, target), dir = native(ack.directory, parentPath);
    requireValue(same(dir.fileId, parent.fileId) && same(dir.volumeId, parent.volumeId), "UNKNOWN_UNRESOLVABLE");
    if (h.operation === "copy-new") {
      const sourceDir = native(ack.sourceDirectory, win32.dirname(h.path));
      requireValue(same(sourceDir.fileId, h.directoryFileId) && same(sourceDir.volumeId, h.directoryVolumeId), "UNKNOWN_UNRESOLVABLE");
    }
    if (h.operation === "write-new") requireValue(ackPayload.equals(Buffer.from(item.original)) &&
      hash(item.original) === h.sha256 && item.original.length === h.byteLength, "UNKNOWN_UNRESOLVABLE");
    else requireValue(ackPayload.length === 0 && item.original.length === 0, "UNKNOWN_UNRESOLVABLE");
    if (h.operation === "unlink-exact") {
      requireValue(ack.unlinked === true && same(f.fileId, h.fileId) && same(f.volumeId, h.volumeId), "UNKNOWN_UNRESOLVABLE");
      return {operation: h.operation, root, parent, originalAck: hash(item.captures.stdout), missing: absent(h.path, parent)};
    }
    requireValue(ack.contentFlushed === true && ack.durability?.profile === "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1" &&
      ack.durability?.scope === "PROCESS_CRASH" && Object.keys(ack.durability).sort().join(",") === "profile,scope",
    "UNKNOWN_UNRESOLVABLE");
    if (h.operation === "prove-sync") requireValue(same(f.fileId, h.fileId) && same(f.volumeId, h.volumeId), "UNKNOWN_UNRESOLVABLE");
    const actual = proof.file(target, h.maxBytes ?? h.byteLength);
    requireValue(same(actual.path, target) && same(actual.fileId, f.fileId) && same(actual.volumeId, f.volumeId) &&
      actual.bytes === ack.byteLength && actual.sha256 === ack.sha256, "UNKNOWN_UNRESOLVABLE");
    return {operation: h.operation, root, parent, originalAck: hash(item.captures.stdout), target: actual};
  }
  close(): void {
    if (this.closed) return;
    this.closing = true;
    // Owned ordered cleanup: proven SQLite close first, then the native held
    // lease; an unconfirmed handle retains the lease.
    this.owner.close();
    this.closed = true;
  }
}
