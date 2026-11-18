import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { types as utilTypes } from "node:util";
import { lstatSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { CollaborationError, wellFormed } from "../../collaboration/runtime/contract";
import { canonical } from "../../collaboration/runtime/canonical";
import { preflightExistingJournal } from "../../sync/journal-preflight";
import { SqliteConnectionOwner, closeSqlitePlatform } from "../../sync/sqlite-connection-owner";
import {
  synchronousPrivatePlatform,
  WindowsPrivatePlatform,
  type PrivatePlatform,
} from "../../sync/private-platform";
import { SyncSqliteGuard } from "../../sync/sqlite-guard";
import type { NativePrivateFilesystemPort, NativePrivateIdentity, NativePrivateReceipt, NativePrivateFile, NativePrivateTree, NativePrivateDirectoryReceipt } from "../private-persistence";
import { PrivateFilePublicationUnknownError } from "../private-file-port";
import type { WindowsOperatorConfig } from "./operator-native";
import { asciiCaseFold, assertWindowsProbe, validateWindowsPath, type WindowsProbeEvidence } from "./path-policy";
import {
  WindowsRuntimePlatform,
  type WindowsRuntimeUntrustedTestPort,
  type WindowsRuntimeDirectoryIdentity,
  type WindowsRuntimeRootIdentity,
  type WindowsRuntimePreparedDirectory,
  type WindowsRuntimeFileIdentity,
} from "./runtime-platform";
import type { WindowsHotJournalSnapshotProfile } from "./hot-journal-snapshot";
import {
  createWindowsPrivateRecoveryIo,
  createWindowsPrivateRecoveryIoForTesting,
  WINDOWS_RECOVERY_MAX_BYTES,
  WINDOWS_RECOVERY_MAX_CAPTURE_BYTES,
  WINDOWS_RECOVERY_MAX_WIRE_BYTES,
  type PrivateFileV3Port,
  type WindowsRecoveryIo,
  type WindowsRecoveryIoTestPort,
} from "./private-recovery-io";
import { WindowsRecoveryArchive, WINDOWS_RECOVERY_ARCHIVE_DATABASE, validateRecoveryObservation,
  type WindowsRecoveryPublicationObservation, type WindowsRecoveryMaintenanceInspection } from "./recovery-archive";
import type { WindowsPrivateMaintenanceAuthority, WindowsPrivateMaintenancePort } from "./private-maintenance-cli";
import { assertWindowsMaintenanceScope, decodeWindowsMaintenanceOrigin, encodeWindowsMaintenanceOrigin,
  WINDOWS_MAINTENANCE_ORIGIN_MAX_BYTES,
  type WindowsMaintenanceOriginProvider, type WindowsMaintenanceOriginRequest } from "./private-maintenance-scope";
import { createWindowsRecoveryFilePort, type CrashRecoveryNativePort } from "./recovery-file-port";
import { WindowsPrivatePersistenceJournal, type WindowsPrivatePersistenceInspection,
  type WindowsPrivatePersistenceMaintenanceProof, type WindowsPrivateMaintenanceContext } from "./private-persistence-journal";
import { WindowsPrivateTransferJournal, WINDOWS_PRIVATE_TRANSFER_DATABASE } from "./private-transfer-journal";
import { createWindowsNativeTransferIo, createWindowsNativeTransferIoForTesting,
  type NativeTransferIoPort, type NativeTransferOptions, type WindowsNativeTransferIoTestPort } from "./private-transfer";
import {
  createWindowsPrivatePersistence,
  createWindowsPrivatePersistenceForTesting,
  type WindowsPrivatePersistenceOptions,
  type WindowsPrivatePersistenceTestPort,
} from "./private-persistence";
import { WindowsBackupArtifactJournal, WINDOWS_BACKUP_ARTIFACT_JOURNAL_DATABASE } from "./backup-artifact-journal";
import {
  createWindowsBackupArtifact,
  createWindowsBackupArtifactForTesting,
  WINDOWS_BACKUP_ARTIFACT_PROFILE,
  type WindowsBackupArtifactPort,
  type WindowsBackupArtifactTestPort,
} from "./backup-artifact";
import { WindowsSourceBindings, WINDOWS_SOURCE_BINDINGS_DATABASE, type WindowsSourceIdentity } from "./source-bindings";
import { admitWindowsSelectedSubtree, admitWindowsSelectedFile, inspectWindowsSelectedFile,
  type WindowsSelectedSourceAdmission, type WindowsSelectedSourceAdmissionReceipt,
  type WindowsSelectedFileAdmission, type WindowsSelectedFileAdmissionReceipt,
  type WindowsSelectedFileInspection,
  type WindowsSourceAdmissionPort } from "./source-admission";
import { createWindowsExternalFilesystem, planWindowsExternalSelection, type WindowsExternalCapability,
  type WindowsExternalCapabilityRequest } from "./external-capability";
import {
  createNativeAuthorityLeaseAcquirer,
  isAuthorityLeasePlatform,
  withPrivateAuthorityLease,
  withPrivateAuthorityLeaseForTesting,
  type AcquirePrivateAuthorityLease,
  type NativeAuthorityLeaseOptions,
} from "./authority-lease";

function fail(code: string): never {
  throw new CollaborationError(`WINDOWS_PRODUCT_NATIVE_${code}`);
}

/** RawExportArchive refusals use the recovery-archive vocabulary so the IO
 * treats deterministic conflicts/capacity/metadata as clean rejections
 * instead of poisoning the transport as UNKNOWN. */
function rfail(code: string): never {
  throw new CollaborationError(`WINDOWS_RECOVERY_ARCHIVE_${code}`);
}

const RAW_EXPORT_DATABASE = "raw-export-v3.sqlite";
const WORKSPACE_ID = /^[a-zA-Z0-9-]{1,100}$/;
const ATTEMPT_ID = /^[0-9a-f]{32}$/;
const FILE_ID = /^[0-9a-fA-F]{32}$/;
const VOLUME_ID = /^[0-9a-fA-F]{16}$/;
const sha = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/* ---------------- RawExportArchive ----------------
 * Independent private SQLite authority for raw >1 MiB exports — the
 * structural `WindowsRecoveryIoAuthority` surface WITHOUT checkpoint
 * semantics: immutable attempts/blobs/terminals plus a folded physical
 * target table (an exported file name is consumed permanently). Lifecycle
 * budget = original + 2 wire bounds + 4 capture bounds + metadata
 * overhead; an APPLIED-equivalent (PUBLISHED terminal) attempt releases
 * only the unused virtual reservation — records are never deleted. */

const RAW_ROLE = "windows-raw-export-v3";
const RAW_MAX_BYTES = 512 * 1024 * 1024;
const RAW_MAX_PHYSICAL_BYTES = 1024 * 1024 * 1024;
const RAW_MAX_ATTEMPTS = 64;
const RAW_MAX_BLOBS = 12;
const RAW_META_MAX = 48 * 1024;
const RAW_OVERHEAD = 256;

const RAW_BLOB_KINDS: ReadonlySet<string> = new Set([
  "evidence:maintenance",
  "origin:scope",
  "original", "wire:prepare", "wire:commit-prepared",
  "capture:prepare:stdout", "capture:prepare:stderr", "capture:prepare:metadata",
  "capture:commit-prepared:stdout", "capture:commit-prepared:stderr", "capture:commit-prepared:metadata",
  "evidence:prepared",
]);

function rawFold(path: string): string {
  if (typeof path !== "string" || path.length > 240 || !/^[A-Z]:\\[\x20-\x7e]*$/.test(path))
    rfail("RAW_PATH");
  if (validateWindowsPath(path, `${path[0]}:\\`).canonical !== path) rfail("RAW_PATH");
  return asciiCaseFold(path);
}

export class RawExportArchive {
  private readonly guard!: SyncSqliteGuard;
  private readonly platform: PrivatePlatform;
  private readonly owner: SqliteConnectionOwner;
  private readonly path!: string;
  private readonly localAttempts = new Set<string>();
  private closed = false;
  private closing = false;
  private unavailable = false;
  private failure: unknown;

  private readonly originProvider: WindowsMaintenanceOriginProvider | undefined;

  constructor(
    directory: string,
    platform: PrivatePlatform,
    binding: string,
    forbiddenRoots: readonly string[] = [],
    originProvider?: WindowsMaintenanceOriginProvider,
  ) {
    if (platform?.kind !== "windows") rfail("PLATFORM");
    if (originProvider !== undefined && isAsyncLike(originProvider)) rfail("PROVIDER");
    this.originProvider = originProvider;
    // Same contract as the checkpoint archive: on a real win32 host only a
    // module-branded lease-held platform may back this authority.
    if (process.platform === "win32" && !isAuthorityLeasePlatform(platform)) rfail("NATIVE_LEASE_REQUIRED");
    if (typeof binding !== "string" || binding.length === 0 ||
        Buffer.byteLength(binding) > RAW_META_MAX || !wellFormed(binding)) rfail("BINDING");
    for (const r of forbiddenRoots)
      if (typeof r === "string" && r.length > 0) {
        const a = asciiCaseFold(r).replace(/\\$/, ""), b = asciiCaseFold(directory).replace(/\\$/, "");
        if (a === b || b.startsWith(a + "\\") || a.startsWith(b + "\\")) rfail("FORBIDDEN_ROOT");
      }
    this.platform = synchronousPrivatePlatform(platform);
    // The owner is reserved before the platform bind: it retains every
    // preflight/primary connection and releases this platform only after all
    // handles are provably closed.
    this.owner = new SqliteConnectionOwner(() => closeSqlitePlatform(this.platform));
    let guard: SyncSqliteGuard | undefined;
    try {
      const bound = this.platform.bind(directory);
      const path = join(bound, RAW_EXPORT_DATABASE);
      const assertFs = (): void => {
        this.platform.assertRoot();
        this.platform.assertFile(path);
        this.platform.assertSidecars(path);
        this.assertPhysicalBounds(path);
      };
      this.platform.createExclusive(path);
      this.platform.assertFile(path);
      this.platform.assertSidecars(path);
      this.assertPhysicalBounds(path);
      if (lstatSync(path).size > 0)
        preflightExistingJournal(path, assertFs, (db) => this.validateSchema(db, binding), this.platform, this.owner);
      const db = new DatabaseSync(path);
      guard = this.owner.guarded(db);
      this.guard = guard;
      if (db.prepare("PRAGMA page_size").get()?.page_size !== 4096) rfail("PAGE_SIZE");
      db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA max_page_count=262144;");
      this.path = path;
      guard.transaction(() => {
        this.assertOwned();
        const schema = db.prepare("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
          .all() as { name: string; type: string }[];
        if (schema.length === 0) {
          this.platform.assertEmptyFile(path);
          db.exec(
            "CREATE TABLE raw_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), role TEXT NOT NULL, version INTEGER NOT NULL, binding TEXT NOT NULL);" +
            "CREATE TABLE raw_attempts(attempt_id TEXT PRIMARY KEY, target_key TEXT NOT NULL UNIQUE, metadata TEXT NOT NULL, budget INTEGER NOT NULL);" +
            "CREATE TABLE raw_blobs(attempt_id TEXT NOT NULL, kind TEXT NOT NULL, bytes BLOB NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(attempt_id,kind));" +
            "CREATE TABLE raw_terminals(attempt_id TEXT PRIMARY KEY, receipt TEXT NOT NULL);" +
            "CREATE TABLE raw_targets(folded_path TEXT PRIMARY KEY);");
          db.prepare("INSERT INTO raw_identity VALUES(1,?,?,?)").run(RAW_ROLE, 1, binding);
        } else {
          this.validateSchema(db, binding);
        }
        this.effectiveCharge(db);
        this.assertOwned();
      });
    } catch (error) {
      // One owned cleanup: unconfirmed connections are closed once; the
      // lease/platform is released only when every handle is provably closed.
      // A constructor failure is never retried automatically.
      this.owner.fail(error);
    }
  }

  private validateSchema(db: DatabaseSync, binding: string): void {
    const schema = db.prepare("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all() as { name: string; type: string }[];
    const names = new Set(schema.filter(r => r.type === "table").map(r => String(r.name)));
    const expected = ["raw_identity", "raw_attempts", "raw_blobs", "raw_terminals", "raw_targets"];
    if (schema.length !== expected.length || !expected.every(n => names.has(n))) rfail("SCHEMA");
    const identity = db.prepare("SELECT * FROM raw_identity").all() as Record<string, unknown>[];
    if (identity.length !== 1 || identity[0].singleton !== 1 || identity[0].role !== RAW_ROLE ||
        identity[0].version !== 1 || identity[0].binding !== binding) rfail("BINDING");
  }

  private assertOwned(): void {
    if (this.unavailable) throw this.failure;
    if (this.closing || this.closed) rfail("CLOSED");
    this.platform.assertRoot();
    this.platform.assertFile(this.path);
    this.platform.assertSidecars(this.path);
    this.assertPhysicalBounds(this.path);
    this.guard.assertUsable();
  }

  private assertPhysicalBounds(path: string): void {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      let size: number;
      try { size = lstatSync(path + suffix).size; }
      catch (error) {
        if (suffix !== "" && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!Number.isSafeInteger(size) || size < 0 || size > RAW_MAX_PHYSICAL_BYTES) rfail("PHYSICAL_CAPACITY");
    }
  }

  private transact<T>(work: () => T): T {
    let finished = false;
    try {
      const result = this.guard.transaction(() => {
        this.assertOwned();
        const value = work();
        finished = true;
        this.assertOwned();
        return value;
      });
      this.assertOwned();
      return result;
    } catch (error) {
      if (finished) { this.unavailable = true; this.failure = error; this.localAttempts.clear(); }
      throw error;
    }
  }

  private blobRow(attemptId: string, kind: string): Uint8Array | undefined {
    const row = this.guard.db
      .prepare("SELECT bytes,sha256 FROM raw_blobs WHERE attempt_id=? AND kind=?")
      .get(attemptId, kind) as { bytes: Uint8Array; sha256: string } | undefined;
    if (row === undefined) return undefined;
    if (!(row.bytes instanceof Uint8Array) || row.sha256 !== sha(row.bytes)) rfail("STORED_HASH");
    return Uint8Array.from(row.bytes);
  }

  private effectiveCharge(db: DatabaseSync): number {
    const rows = db.prepare(
      "SELECT a.attempt_id,a.budget,a.metadata," +
      "(SELECT receipt FROM raw_terminals t WHERE t.attempt_id=a.attempt_id) AS receipt," +
      "(SELECT COALESCE(SUM(length(bytes)),0) FROM raw_blobs b WHERE b.attempt_id=a.attempt_id) AS blobBytes " +
      "FROM raw_attempts a").all() as {
        attempt_id: string; budget: number; metadata: string; receipt: string | null; blobBytes: number;
      }[];
    if (rows.length > RAW_MAX_ATTEMPTS) rfail("STORED");
    let total = 0;
    for (const row of rows) {
      if (!Number.isSafeInteger(row.budget) || !Number.isSafeInteger(row.blobBytes)) rfail("STORED");
      if (row.budget <= 0 || row.blobBytes < 0) rfail("STORED");
      const observation = this.blobRow(row.attempt_id, "evidence:maintenance");
      const published = observation !== undefined
        ? (validateRawObservation(this.maintenanceInspection(row.attempt_id)), true)
        : row.receipt !== null && this.validateTerminal(row.attempt_id, row.receipt);
      total += published
        ? row.blobBytes + Buffer.byteLength(row.metadata) + Buffer.byteLength(row.receipt ?? "") + (RAW_MAX_BLOBS + 4) * RAW_OVERHEAD
        : row.budget;
    }
    if (!Number.isSafeInteger(total) || total > RAW_MAX_BYTES) rfail("CAPACITY");
    return total;
  }

  /** Synchronous provider fence — identical to the K journal's double
   * sampling; an async answer fails before any side effect. */
  private provisionOrigin(request: WindowsMaintenanceOriginRequest): Uint8Array | undefined {
    if (this.originProvider === undefined) return undefined;
    const provided: unknown = this.originProvider(request);
    if (utilTypes.isPromise(provided)) Promise.prototype.then.call(provided, undefined, () => undefined);
    if (provided !== undefined && (provided === null || typeof provided !== "object")) rfail("PROVIDER");
    return provided === undefined ? undefined : encodeWindowsMaintenanceOrigin(provided);
  }

  reserve(request: {
    attemptId: string; targetKey: string;
    metadata: Record<string, unknown>; original: Uint8Array;
  }): void {
    if (typeof request.attemptId !== "string" || !ATTEMPT_ID.test(request.attemptId)) rfail("ATTEMPT");
    if (typeof request.targetKey !== "string" || request.targetKey.length === 0 ||
        request.targetKey.length > 200 || !wellFormed(request.targetKey)) rfail("TARGET");
    let body: string;
    try { body = canonical(request.metadata, RAW_META_MAX); } catch { rfail("METADATA"); }
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(body); } catch { rfail("METADATA"); }
    const m = parsed;
    if (Object.keys(m).sort().join() !==
        "attemptId,byteLength,directory,kind,path,root,sha256,stagingPath") rfail("METADATA");
    const root = m.root as Record<string, unknown> | undefined;
    const dir = m.directory as Record<string, unknown> | undefined;
    if (m.kind !== "raw-export" || typeof m.attemptId !== "string" || m.attemptId !== request.attemptId ||
        typeof m.path !== "string" || m.path.length > 240 ||
        typeof m.stagingPath !== "string" ||
        root === undefined || root === null || typeof root.fileId !== "string" || !FILE_ID.test(root.fileId) ||
        typeof root.volumeId !== "string" || !VOLUME_ID.test(root.volumeId) ||
        dir === undefined || dir === null || typeof dir.canonicalPath !== "string" ||
        typeof dir.fileId !== "string" || !FILE_ID.test(dir.fileId) ||
        typeof dir.volumeId !== "string" || !VOLUME_ID.test(dir.volumeId) ||
        typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256) ||
        typeof m.byteLength !== "number" || !Number.isSafeInteger(m.byteLength)) rfail("METADATA");
    const original = request.original;
    if (!(original instanceof Uint8Array) || original.byteLength > WINDOWS_RECOVERY_MAX_BYTES ||
        original.byteLength !== m.byteLength || sha(original) !== m.sha256) rfail("ORIGINAL");
    const copy = Uint8Array.from(original);
    const folded = rawFold(m.path);
    const stage = rawFold(m.stagingPath);
    if (Object.keys(root).sort().join() !== "fileId,volumeId" ||
        Object.keys(dir).sort().join() !== "canonicalPath,fileId,volumeId" ||
        rawFold(win32.dirname(m.path)) !== rawFold(dir.canonicalPath) ||
        rawFold(win32.dirname(m.stagingPath)) !== rawFold(dir.canonicalPath) ||
        folded === stage || asciiCaseFold(root.volumeId) !== asciiCaseFold(dir.volumeId))
      rfail("METADATA_LINK");
    const targetKey = `target:${sha([root.volumeId, root.fileId, dir.volumeId, dir.fileId,
      win32.basename(m.path)].map(asciiCaseFold).join("|"))}`;
    if (targetKey !== request.targetKey) rfail("TARGET");
    // The origin scope is the immutable proof of which native root/workspace
    // this attempt was dispatched under; it is sampled once outside and once
    // inside the append transaction, never recomputed later.
    const originReq: WindowsMaintenanceOriginRequest = Object.freeze({
      family: "raw-export", attemptId: request.attemptId, requestSha256: sha(body),
      paths: Object.freeze([m.path, m.stagingPath] as string[])});
    const origin = this.provisionOrigin(originReq);
    const budget = copy.byteLength + 2 * WINDOWS_RECOVERY_MAX_WIRE_BYTES +
      4 * WINDOWS_RECOVERY_MAX_CAPTURE_BYTES + 4 * RAW_META_MAX + (RAW_MAX_BLOBS + 4) * RAW_OVERHEAD +
      (origin?.byteLength ?? 0);
    if (!Number.isSafeInteger(budget) || budget <= 0) rfail("BUDGET");
    this.transact(() => {
      const inside = this.provisionOrigin(originReq);
      if ((origin === undefined) !== (inside === undefined) ||
          (origin !== undefined && !Buffer.from(origin).equals(Buffer.from(inside!)))) rfail("PROVIDER_DRIFT");
      const db = this.guard.db;
      const count = db.prepare("SELECT COUNT(*) AS n FROM raw_attempts").get() as { n: number };
      if (!Number.isFinite(count.n) || count.n >= RAW_MAX_ATTEMPTS ||
          this.effectiveCharge(db) + budget > RAW_MAX_BYTES) rfail("CAPACITY");
      // The folded physical target is consumed permanently — an exported
      // file is immutable; a repeat under the same name is a conflict.
      if (db.prepare("SELECT folded_path FROM raw_targets WHERE folded_path=?").get(folded) !== undefined)
        rfail("TARGET");
      db.prepare("INSERT INTO raw_targets(folded_path) VALUES(?)").run(folded);
      db.prepare("INSERT INTO raw_attempts(attempt_id,target_key,metadata,budget) VALUES(?,?,?,?)")
        .run(request.attemptId, request.targetKey, body, budget);
      db.prepare("INSERT INTO raw_blobs(attempt_id,kind,bytes,sha256) VALUES(?,?,?,?)")
        .run(request.attemptId, "original", copy, m.sha256 as string);
      if (origin !== undefined)
        db.prepare("INSERT INTO raw_blobs(attempt_id,kind,bytes,sha256) VALUES(?,?,?,?)")
          .run(request.attemptId, "origin:scope", Buffer.from(origin), sha(origin));
    });
    this.transact(() => {
      const read = this.blobRow(request.attemptId, "original");
      if (read === undefined || !Buffer.from(read).equals(copy)) rfail("READBACK");
      const readOrigin = this.blobRow(request.attemptId, "origin:scope");
      if ((origin === undefined) !== (readOrigin === undefined) ||
          (origin !== undefined && !Buffer.from(readOrigin!).equals(Buffer.from(origin)))) rfail("READBACK");
    });
    this.localAttempts.add(request.attemptId);
  }

  record(attemptId: string, kind: string, bytes: Uint8Array): void {
    if (!ATTEMPT_ID.test(attemptId) || !RAW_BLOB_KINDS.has(kind) ||
        kind === "evidence:maintenance" || kind === "origin:scope") rfail("KIND");
    const cap = kind === "original" ? WINDOWS_RECOVERY_MAX_BYTES :
      kind.endsWith(":metadata") || kind === "evidence:prepared" ? RAW_META_MAX :
      kind.startsWith("capture:") ? WINDOWS_RECOVERY_MAX_CAPTURE_BYTES : WINDOWS_RECOVERY_MAX_WIRE_BYTES;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > cap) rfail("BLOB");
    const copy = Uint8Array.from(bytes);
    const digest = sha(copy);
    this.transact(() => {
      if (!this.localAttempts.has(attemptId)) rfail("DISPATCH_RIGHTS");
      const db = this.guard.db;
      const attempt = db.prepare("SELECT budget FROM raw_attempts WHERE attempt_id=?").get(attemptId) as { budget: number } | undefined;
      if (attempt === undefined || !Number.isSafeInteger(attempt.budget)) rfail("ATTEMPT");
      if (db.prepare("SELECT attempt_id FROM raw_terminals WHERE attempt_id=?").get(attemptId) !== undefined)
        rfail("TERMINATED");
      const stats = db.prepare("SELECT COUNT(*) AS rows,COALESCE(SUM(length(bytes)),0) AS bytes FROM raw_blobs WHERE attempt_id=?")
        .get(attemptId) as { rows: number; bytes: number };
      const globalBytes = db.prepare("SELECT COALESCE(SUM(length(bytes)),0) AS bytes FROM raw_blobs")
        .get() as { bytes: number };
      if (stats.rows >= RAW_MAX_BLOBS || stats.bytes + copy.byteLength > attempt.budget ||
          globalBytes.bytes + copy.byteLength > RAW_MAX_BYTES) rfail("CAPACITY");
      db.prepare("INSERT INTO raw_blobs(attempt_id,kind,bytes,sha256) VALUES(?,?,?,?)")
        .run(attemptId, kind, copy, digest);
    });
    const readback = this.transact(() => this.blobRow(attemptId, kind));
    if (readback === undefined || !Buffer.from(readback).equals(copy)) rfail("READBACK");
  }

  recordTerminal(attemptId: string, receipt: string): void {
    if (!ATTEMPT_ID.test(attemptId)) rfail("ATTEMPT");
    if (typeof receipt !== "string" || receipt.length === 0 || !wellFormed(receipt) ||
        Buffer.byteLength(receipt) > RAW_META_MAX) rfail("RECEIPT");
    this.transact(() => {
      if (!this.localAttempts.has(attemptId)) rfail("DISPATCH_RIGHTS");
      this.validateTerminal(attemptId, receipt);
      this.guard.db.prepare("INSERT INTO raw_terminals(attempt_id,receipt) VALUES(?,?)")
        .run(attemptId, receipt);
      this.effectiveCharge(this.guard.db);
    });
    const row = this.transact(() => this.guard.db
      .prepare("SELECT receipt FROM raw_terminals WHERE attempt_id=?")
      .get(attemptId) as { receipt: string } | undefined);
    if (row === undefined || row.receipt !== receipt) rfail("READBACK");
    this.localAttempts.delete(attemptId);
  }

  /** Only an exact retained publication chain releases virtual capacity. */
  private validateTerminal(attemptId: string, receipt: string): boolean {
    let t: Record<string, any>;
    try { t = JSON.parse(receipt); } catch { rfail("RECEIPT"); }
    if (!t || t.attemptId !== attemptId || !["PUBLISHED", "UNKNOWN", "REJECTED"].includes(t.outcome))
      rfail("RECEIPT");
    if (t.outcome !== "PUBLISHED") return false;
    const row = this.guard.db.prepare("SELECT metadata FROM raw_attempts WHERE attempt_id=?")
      .get(attemptId) as {metadata: string} | undefined;
    if (!row) rfail("ATTEMPT");
    const m = JSON.parse(row.metadata);
    const required = (kind: string): Buffer => {
      const bytes = this.blobRow(attemptId, kind);
      if (!bytes) rfail("RECEIPT");
      return Buffer.from(bytes);
    };
    const frame = (kind: string): {header: any; payload: Buffer} => {
      const bytes = required(kind);
      if (bytes.length < 4) rfail("RECEIPT");
      const n = bytes.readUInt32LE(0);
      if (n < 1 || n > 8192 || n + 4 > bytes.length) rfail("RECEIPT");
      return {header: JSON.parse(bytes.subarray(4, n + 4).toString("ascii")), payload: bytes.subarray(n + 4)};
    };
    const original = required("original");
    if (original.length !== m.byteLength || sha(original) !== m.sha256) rfail("RECEIPT");
    const prepare = frame("wire:prepare"), commit = frame("wire:commit-prepared");
    const prepared = frame("capture:prepare:stdout"), published = frame("capture:commit-prepared:stdout");
    for (const phase of ["prepare", "commit-prepared"]) {
      if (required(`capture:${phase}:stderr`).length !== 0) rfail("RECEIPT");
      const capture = JSON.parse(required(`capture:${phase}:metadata`).toString("utf8"));
      if (capture.status !== 0 || capture.signal !== null || capture.errorCode !== null || capture.captureTruncated !== false)
        rfail("RECEIPT");
    }
    if (!prepare.payload.equals(original) || commit.payload.length !== 0 ||
        !prepared.payload.equals(original) || !published.payload.equals(original)) rfail("RECEIPT");
    const evidence = JSON.parse(required("evidence:prepared").toString("utf8"));
    if (evidence.status !== 0 || JSON.stringify(evidence.header) !== JSON.stringify(prepared.header)) rfail("RECEIPT");
    for (const [wire, operation] of [[prepare.header, "prepare"], [commit.header, "commit-prepared"]]) {
      if (wire.contractVersion !== 3 || wire.operation !== operation || wire.attemptId !== attemptId ||
          wire.path !== m.path || wire.stagingPath !== m.stagingPath ||
          wire.rootFileId !== m.root.fileId || wire.rootVolumeId !== m.root.volumeId ||
          wire.directoryFileId !== m.directory.fileId || wire.directoryVolumeId !== m.directory.volumeId ||
          wire.byteLength !== m.byteLength) rfail("RECEIPT");
    }
    const stage = prepared.header.file, final = published.header.file, e = t.evidence;
    if (!stage || !final || !e?.identity || !FILE_ID.test(stage.fileId) ||
        stage.canonicalPath !== m.stagingPath || final.canonicalPath !== m.path ||
        stage.fileId !== final.fileId || stage.volumeId !== m.root.volumeId ||
        final.volumeId !== stage.volumeId || commit.header.fileId !== stage.fileId ||
        commit.header.volumeId !== stage.volumeId || prepare.header.sha256 !== m.sha256 ||
        commit.header.expectedSha256 !== m.sha256) rfail("RECEIPT");
    const canonicalRoot = prepare.header.root;
    if (typeof canonicalRoot !== "string" || validateWindowsPath(m.path, canonicalRoot).canonical !== m.path ||
        commit.header.root !== canonicalRoot) rfail("RECEIPT");
    for (const [header, operation, state] of [[prepared.header, "prepare", "PREPARED"], [published.header, "commit-prepared", "PUBLISHED"]]) {
      if (header.contractVersion !== 3 || header.operation !== operation || header.state !== state ||
          header.attemptId !== attemptId || header.path !== m.path || header.stagingPath !== m.stagingPath ||
          header.byteLength !== m.byteLength || header.sha256 !== m.sha256 || header.contentFlushed !== true ||
          header.filesystem !== "NTFS" || header.directory?.fileId !== m.directory.fileId ||
          header.directory?.volumeId !== m.directory.volumeId) rfail("RECEIPT");
      if (header.root !== canonicalRoot) rfail("RECEIPT");
      assertWindowsProbe(header.file, {canonicalPath: state === "PREPARED" ? m.stagingPath : m.path, canonicalRoot});
      assertWindowsProbe(header.directory, {canonicalPath: m.directory.canonicalPath, canonicalRoot});
      for (const proof of [header.file, header.directory])
        if (proof.rootFileId !== m.root.fileId || proof.rootVolumeId !== m.root.volumeId ||
            proof.sid !== stage.sid) rfail("RECEIPT");
    }
    if (e.phase !== "commit-prepared" || e.status !== 0 || e.path !== m.path ||
        e.byteLength !== m.byteLength || e.sha256 !== m.sha256 ||
        e.stagingDisposition !== "RENAMED_TO_FINAL" || e.identity.canonicalPath !== m.path ||
        e.identity.fileId !== final.fileId || e.identity.volumeId !== final.volumeId ||
        published.header.stagingDisposition !== "RENAMED_TO_FINAL" ||
        published.header.namespace !== "EXCLUSIVE_NO_REPLACE" ||
        published.header.durability?.profile !== "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1" ||
        published.header.durability?.scope !== "PROCESS_CRASH") rfail("RECEIPT");
    return true;
  }

  readBlob(attemptId: string, kind: string): Uint8Array | undefined {
    if (!ATTEMPT_ID.test(attemptId) || !RAW_BLOB_KINDS.has(kind)) rfail("KIND");
    return this.transact(() => this.blobRow(attemptId, kind));
  }

  readMetadata(attemptId: string): Record<string, unknown> | undefined {
    if (!ATTEMPT_ID.test(attemptId)) rfail("ATTEMPT");
    return this.transact(() => {
      const row = this.guard.db.prepare("SELECT metadata FROM raw_attempts WHERE attempt_id=?")
        .get(attemptId) as { metadata: string } | undefined;
      if (row === undefined) return undefined;
      let parsed: unknown;
      try { parsed = JSON.parse(row.metadata); } catch { rfail("STORED"); }
      if (canonical(parsed) !== row.metadata) rfail("STORED");
      return parsed as Record<string, unknown>;
    });
  }

  terminalReceipt(attemptId: string): string | undefined {
    if (!ATTEMPT_ID.test(attemptId)) rfail("ATTEMPT");
    return this.transact(() =>
      (this.guard.db.prepare("SELECT receipt FROM raw_terminals WHERE attempt_id=?")
        .get(attemptId) as { receipt: string } | undefined)?.receipt);
  }

  /** Unresolved attempts (no terminal, or non-PUBLISHED) for the folded
   * physical path — the raw-export analogue of the checkpoint pending scan. */
  pendingAttempts(path: string, _workspaceId: string): readonly string[] {
    const folded = rawFold(path);
    return this.transact(() => {
      const rows = this.guard.db.prepare(
        "SELECT a.attempt_id,a.metadata," +
        "(SELECT receipt FROM raw_terminals t WHERE t.attempt_id=a.attempt_id) AS receipt " +
        "FROM raw_attempts a").all() as { attempt_id: string; metadata: string; receipt: string | null }[];
      const pending: string[] = [];
      for (const row of rows) {
        if (pending.length > RAW_MAX_ATTEMPTS) rfail("STORED");
        let metaPath: string;
        let outcome: string | undefined;
        try {
          metaPath = (JSON.parse(row.metadata) as { path: string }).path;
          outcome = row.receipt === null ? undefined
            : (JSON.parse(row.receipt) as { outcome?: string }).outcome;
        } catch { rfail("STORED"); }
        if (typeof metaPath !== "string" || metaPath.length > 240) rfail("STORED");
        if (outcome === "PUBLISHED") this.validateTerminal(row.attempt_id, row.receipt!);
        const observed = this.blobRow(row.attempt_id, "evidence:maintenance") !== undefined;
        if (observed) validateRawObservation(this.maintenanceInspection(row.attempt_id));
        if (asciiCaseFold(metaPath) === folded && outcome !== "PUBLISHED" && !observed)
          pending.push(row.attempt_id);
      }
      return pending;
    });
  }

  listAttempts(): readonly string[] {
    return this.transact(() => {
      const rows = this.guard.db.prepare("SELECT attempt_id FROM raw_attempts ORDER BY attempt_id LIMIT 65").all();
      if (rows.length > RAW_MAX_ATTEMPTS) rfail("CAPACITY");
      return rows.map(r => String(r.attempt_id));
    });
  }
  private maintenanceInspection(id: string): WindowsRecoveryMaintenanceInspection {
    if (!ATTEMPT_ID.test(id)) rfail("ATTEMPT");
    const db = this.guard.db, row = db.prepare("SELECT metadata FROM raw_attempts WHERE attempt_id=?").get(id);
    if (!row) rfail("ATTEMPT");
    const binding = String(db.prepare("SELECT binding FROM raw_identity").get()?.binding);
    const rows = db.prepare("SELECT kind,bytes,sha256 FROM raw_blobs WHERE attempt_id=? ORDER BY kind").all(id);
    if (rows.length > RAW_MAX_BLOBS) rfail("CAPACITY");
    const blobs: Record<string, Uint8Array> = {}, descriptors: unknown[] = [];
    let resolution: string | null = null;
    for (const b of rows) {
      if (!RAW_BLOB_KINDS.has(String(b.kind)) || !(b.bytes instanceof Uint8Array) || sha(b.bytes) !== b.sha256) rfail("STORED");
      if (b.kind === "evidence:maintenance") resolution = Buffer.from(b.bytes).toString("utf8");
      else { blobs[String(b.kind)] = Uint8Array.from(b.bytes); descriptors.push([b.kind, b.sha256, b.bytes.length]); }
    }
    const terminalRow = db.prepare("SELECT receipt FROM raw_terminals WHERE attempt_id=?").get(id);
    const terminal = terminalRow ? String(terminalRow.receipt) : null, metadata = String(row.metadata);
    // A retained scope is re-validated against its own immutable metadata on
    // every read — mismatched evidence fails closed, never a legacy fallback.
    const storedOrigin = blobs["origin:scope"];
    if (storedOrigin !== undefined) {
      if (storedOrigin.byteLength > WINDOWS_MAINTENANCE_ORIGIN_MAX_BYTES) rfail("STORED");
      const scope = decodeWindowsMaintenanceOrigin(storedOrigin);
      const m = JSON.parse(metadata);
      if (scope.family !== "raw-export" || scope.attemptId !== id || scope.requestSha256 !== sha(metadata) ||
          scope.endpoints.length !== 2 ||
          asciiCaseFold(scope.endpoints[0].path) !== asciiCaseFold(m.path) ||
          asciiCaseFold(scope.endpoints[1].path) !== asciiCaseFold(m.stagingPath)) rfail("STORED");
    }
    return {attemptId: id, fingerprint: sha(canonical({id, binding, metadata, descriptors, terminal}, 256 * 1024)),
      binding, metadata, blobs, terminal, resolution};
  }
  inspectAttempt(id: string): WindowsRecoveryMaintenanceInspection {
    return this.transact(() => this.maintenanceInspection(id));
  }
  observeApplied(id: string, fingerprint: string, context: unknown,
    prove: (item: WindowsRecoveryMaintenanceInspection) => WindowsRecoveryPublicationObservation, current: () => void): WindowsRecoveryMaintenanceInspection {
    if ([prove, current].some(isAsyncLike)) rfail("PROOFS");
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) rfail("FINGERPRINT");
    const contextBody = canonical(context, 4096);
    this.transact(() => {
      const item = this.maintenanceInspection(id);
      if (item.fingerprint !== fingerprint || item.resolution !== null) rfail("CONFLICT");
      this.localAttempts.delete(id);
      checkSync(current);
      const evidence = prove(item);
      const body = canonical({state: "APPLIED_OBSERVED", attemptId: id, fingerprint,
        context: JSON.parse(contextBody), evidence}, RAW_META_MAX);
      checkSync(current);
      validateRawObservation({...item, resolution: body});
      const db = this.guard.db, stats = db.prepare("SELECT count(*) AS n,sum(length(bytes)) AS bytes FROM raw_blobs WHERE attempt_id=?").get(id)!;
      const budget = Number(db.prepare("SELECT budget FROM raw_attempts WHERE attempt_id=?").get(id)?.budget);
      if (Number(stats.n) >= RAW_MAX_BLOBS || Number(stats.bytes) + Buffer.byteLength(body) > budget) rfail("CAPACITY");
      db.prepare("INSERT INTO raw_blobs VALUES(?,?,?,?)").run(id, "evidence:maintenance", Buffer.from(body), sha(body));
      this.effectiveCharge(db);
      this.localAttempts.delete(id); checkSync(current);
    });
    return this.inspectAttempt(id);
  }

  close(): void {
    if (this.closed || this.closing) return;
    this.closing = true;
    try {
      // The owner retries unconfirmed handles first and releases the
      // lease/platform only after every connection is provably closed.
      this.owner.close();
      this.closed = true;
      this.localAttempts.clear();
    } finally {
      this.closing = false;
    }
  }
}

/** Restart validation for a raw-export observation — a mechanical copy of
 * the shared recovery validator with ONLY the inside-workspace path gate
 * replaced by the retained origin scope's exact endpoint checks. An
 * origin-absent record delegates to the shared validator unchanged (its
 * legacy inside-workspace predicate still applies); an origin-bearing
 * record is proven against its own immutable evidence, never a substitute
 * whole-root workspace. Static retained-evidence validation only — the live
 * native proof stays in the product's provePublication. */
function validateRawObservation(item: WindowsRecoveryMaintenanceInspection): {
  context: WindowsPrivateMaintenanceContext; evidence: WindowsRecoveryPublicationObservation;
} {
  if (item.blobs["origin:scope"] === undefined) return validateRecoveryObservation(item);
  const bad = (): never => rfail("MAINTENANCE_EVIDENCE");
  const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) bad();
    const record = value as Record<string, unknown>, actual = Object.keys(record);
    if (actual.length !== keys.length || !keys.every(k => actual.includes(k))) bad();
    return record;
  };
  if (!item.resolution) bad();
  const previous = item.blobs["evidence:maintenance"];
  const r = exact(JSON.parse(item.resolution!), ["state", "attemptId", "fingerprint", "context", "evidence",
    ...(previous ? ["previousObservationSha256"] : [])]);
  if (canonical(r, RAW_META_MAX) !== item.resolution ||
      r.state !== "APPLIED_OBSERVED" || r.attemptId !== item.attemptId || r.fingerprint !== item.fingerprint) bad();
  if (previous && r.previousObservationSha256 !== sha(previous)) bad();
  const c = exact(r.context, ["workspace", "workspaceId", "workspaceFingerprint", "writerId", "sessionId", "osSid"]);
  canonical(c, 4096);
  if (!/^[0-9a-f]{64}$/.test(String(c.workspaceFingerprint)) || !/^S-1-\d+(?:-\d+)+$/.test(String(c.osSid)) ||
      ![c.workspaceId, c.writerId, c.sessionId].every(v => typeof v === "string" && v.length > 0 && v.length <= 128)) bad();
  const m = JSON.parse(item.metadata);
  if (canonical(m, RAW_META_MAX) !== item.metadata ||
      m.kind !== "raw-export" || m.attemptId !== item.attemptId ||
      !Number.isSafeInteger(m.byteLength) || m.byteLength < 0 || m.byteLength > WINDOWS_RECOVERY_MAX_BYTES ||
      !/^[0-9a-f]{64}$/.test(m.sha256) || (m.workspaceId !== undefined && m.workspaceId !== c.workspaceId)) bad();
  exact(m, ["attemptId", "byteLength", "directory", "kind", "path", "root", "sha256", "stagingPath"]);
  // The origin scope replaces ONLY the inside-workspace substring gate: the
  // endpoints must be the exact retained final/staging pair under the exact
  // retained parent, inside the scope's own root, disjoint from its state.
  if (win32.dirname(m.path) !== m.directory.canonicalPath ||
      win32.dirname(m.stagingPath) !== m.directory.canonicalPath ||
      rawFold(m.path) === rawFold(m.stagingPath)) bad();
  const blob = (name: string): Buffer => {
    const b = item.blobs[name]; if (!(b instanceof Uint8Array)) bad(); return Buffer.from(b);
  };
  const frame = (name: string) => {
    const b = blob(name);
    if (b.length < 4) bad();
    const n = b.readUInt32LE(0);
    if (n < 1 || n > 8192 || b.length < n + 4 || ![...b.subarray(4, n + 4)].every(v => v >= 32 && v <= 126)) bad();
    const text = b.subarray(4, n + 4).toString("ascii"), header = JSON.parse(text);
    if (JSON.stringify(header) !== text) bad();
    return {header, payload: b.subarray(n + 4)};
  };
  const original = blob("original"), prepare = frame("wire:prepare"), ack = frame("capture:prepare:stdout"),
    commit = frame("wire:commit-prepared");
  const status = JSON.parse(blob("capture:prepare:metadata").toString("utf8"));
  exact(status, ["status", "signal", "errorCode", "captureTruncated", "stdoutLength", "stderrLength"]);
  if (original.length !== m.byteLength || sha(original) !== m.sha256 || !prepare.payload.equals(original) ||
      !ack.payload.equals(original) || commit.payload.length !== 0 || blob("capture:prepare:stderr").length !== 0 ||
      status.status !== 0 || status.signal !== null || status.errorCode !== null || status.captureTruncated !== false ||
      status.stdoutLength !== blob("capture:prepare:stdout").length || status.stderrLength !== 0) bad();
  const p = ack.header, f = p.file, d = p.directory, root = prepare.header.root;
  const scope = decodeWindowsMaintenanceOrigin(blob("origin:scope"));
  const scopeRoot = rawFold(scope.root.path), scopeState = rawFold(scope.stateRoot);
  if (scope.family !== "raw-export" || scope.attemptId !== item.attemptId ||
      scope.requestSha256 !== sha(item.metadata) ||
      scopeRoot !== rawFold(String(root)) ||
      scope.root.fileId !== m.root.fileId || scope.root.volumeId !== m.root.volumeId ||
      scopeState === scopeRoot || scopeState.startsWith(scopeRoot + "\\") || scopeRoot.startsWith(scopeState + "\\") ||
      scope.endpoints.length !== 2 ||
      rawFold(scope.endpoints[0].path) !== rawFold(m.path) ||
      rawFold(scope.endpoints[1].path) !== rawFold(m.stagingPath) ||
      !scope.endpoints.every(e => e.parent.fileId === m.directory.fileId &&
        e.parent.volumeId === m.directory.volumeId &&
        rawFold(e.parent.path) === rawFold(m.directory.canonicalPath)) ||
      rawFold(String(c.workspace)) !== rawFold(scope.workspace.path) ||
      String(c.osSid) !== scope.osSid ||
      (scope.workspace.workspaceId !== null && scope.workspace.workspaceId !== c.workspaceId)) bad();
  const commonWire = ["contractVersion", "operation", "path", "root", "rootFileId", "rootVolumeId",
    "directoryFileId", "directoryVolumeId", "attemptId", "stagingPath", "byteLength"];
  exact(prepare.header, [...commonWire, "sha256"]);
  exact(commit.header, [...commonWire, "fileId", "volumeId", "expectedSha256"]);
  exact(p, ["contractVersion", "operation", "path", "root", "state", "attemptId", "stagingPath",
    "file", "directory", "byteLength", "sha256", "contentFlushed", "filesystem"]);
  for (const [h, operation] of [[prepare.header, "prepare"], [commit.header, "commit-prepared"]]) {
    if (h.contractVersion !== 3 || h.operation !== operation || h.attemptId !== item.attemptId ||
        h.root !== root || h.path !== m.path || h.stagingPath !== m.stagingPath ||
        h.rootFileId !== m.root.fileId || h.rootVolumeId !== m.root.volumeId ||
        h.directoryFileId !== m.directory.fileId || h.directoryVolumeId !== m.directory.volumeId ||
        h.byteLength !== m.byteLength) bad();
  }
  if (p.contractVersion !== 3 || p.operation !== "prepare" || p.state !== "PREPARED" ||
      p.attemptId !== item.attemptId || p.root !== root || p.path !== m.path || p.stagingPath !== m.stagingPath ||
      p.byteLength !== m.byteLength || p.sha256 !== m.sha256 || p.filesystem !== "NTFS" || p.contentFlushed !== true ||
      prepare.header.sha256 !== m.sha256 || commit.header.expectedSha256 !== m.sha256 ||
      commit.header.fileId !== f?.fileId || commit.header.volumeId !== f?.volumeId) bad();
  assertWindowsProbe(f, {canonicalPath: m.stagingPath, canonicalRoot: root});
  assertWindowsProbe(d, {canonicalPath: m.directory.canonicalPath, canonicalRoot: root});
  for (const native of [f, d]) if (native.rootFileId !== m.root.fileId || native.rootVolumeId !== m.root.volumeId ||
      native.volumeId !== m.root.volumeId || native.sid !== c.osSid) bad();
  if (d.fileId !== m.directory.fileId || d.volumeId !== m.directory.volumeId) bad();
  const prepared = JSON.parse(blob("evidence:prepared").toString("utf8"));
  if (prepared.status !== 0 || canonical(prepared.header) !== canonical(p)) bad();
  const evidence = r.evidence as Record<string, unknown>;
  const legacyRaw = evidence && !Object.hasOwn(evidence, "prior");
  const e = {...exact(evidence, ["originalSha256", "preparedCaptureSha256", "native", "parent", "root", "staging",
    ...(legacyRaw ? [] : ["prior"])]), ...(legacyRaw ? {prior: null} : {})} as unknown as WindowsRecoveryPublicationObservation;
  if (e.originalSha256 !== m.sha256 || e.preparedCaptureSha256 !== sha(blob("capture:prepare:stdout")) ||
      e.native.path !== m.path || e.native.fileId !== f.fileId || e.native.volumeId !== f.volumeId ||
      e.native.bytes !== m.byteLength || e.native.sha256 !== m.sha256 ||
      e.parent.canonicalPath !== m.directory.canonicalPath || e.parent.fileId !== d.fileId || e.parent.volumeId !== d.volumeId ||
      e.root.rootFileId !== m.root.fileId || e.root.volumeId !== m.root.volumeId ||
      e.staging.contractVersion !== 3 || e.staging.state !== "ABSENT" || e.staging.path !== m.stagingPath) bad();
  exact(e.staging, ["contractVersion", "state", "path", "directory"]);
  exact(e.staging.directory, ["fileId", "volumeId"]);
  if (e.staging.directory.fileId !== d.fileId || e.staging.directory.volumeId !== d.volumeId) bad();
  if (e.prior !== null) bad();
  return {context: c as unknown as WindowsPrivateMaintenanceContext, evidence: e};
}

/* ---------------- product composition ---------------- */

export type WindowsProductNativeOptions = Readonly<{
  enrollExistingSources?: boolean;
  /** Global authority/session fence — synchronous, runs immediately before
   * reservation/native dispatch/CAS and before reporting success. */
  assertCurrent(): void;
}>;

/** Host-only rescue authority: an already retained native workspace directory,
 * never a fabricated semantic workspace ID. Source SQLite remains untouched. */
export type WindowsReadOnlyRescueRequest = Readonly<{
  workspaceDirectory: NativePrivateIdentity;
  capabilityRoot: string;
  path: string;
  assertCurrent(): void;
}> & (Readonly<{kind: "raw-rescue"; source?: never}> |
  Readonly<{kind: "backup-source"; source: WindowsSelectedSourceAdmission}>);

export type WindowsProductNative = Readonly<{
  /** Root-only proof: caller fence + native root, no SQLite, no workspace. */
  assertRoot(): void;
  /** Binds the exact canonical workspace directory + ID + current native
   * root/dir IDs — immutable for the factory's lifetime. */
  bindWorkspace(path: string, workspaceId: string, assertWorkspaceCurrent?: () => void): void;
  admitSelectedSource(request: WindowsSelectedSourceAdmission): WindowsSelectedSourceAdmissionReceipt;
  admitSelectedFile(request: WindowsSelectedFileAdmission): WindowsSelectedFileAdmissionReceipt;
  inspectSelectedFile(request: WindowsSelectedFileInspection): NativePrivateFile;
  authorizeExternalCapability(request: WindowsExternalCapabilityRequest): WindowsExternalCapability;
  authorizeReadOnlyRescue(request: WindowsReadOnlyRescueRequest): WindowsExternalCapability;
  privateFilesystem: NativePrivateFilesystemPort;
  privateFileV3Port: PrivateFileV3Port;
  crashRecoveryPort: CrashRecoveryNativePort;
  nativeBackup: WindowsBackupArtifactPort;
  nativeTransferIo: NativeTransferIoPort;
  nativeTransfer: NativeTransferOptions;
  maintenancePort(authority: WindowsPrivateMaintenanceAuthority): WindowsPrivateMaintenancePort;
  close(): void;
}>;

export type WindowsProductNativeTestDeps = Readonly<{
  /** Relabelled contract platform for journal construction (off-win32). */
  platform?: (directory: string, databaseName: string, profile: WindowsHotJournalSnapshotProfile) => PrivatePlatform;
  acquireLease?: (options: NativeAuthorityLeaseOptions) => AcquirePrivateAuthorityLease;
  /** Runtime probe port for the fresh scoped native runtimes. */
  runtimeTestPort?: WindowsRuntimeUntrustedTestPort;
  recoveryIo?: WindowsRecoveryIoTestPort;
  persistenceIo?: WindowsPrivatePersistenceTestPort;
  backupIo?: WindowsBackupArtifactTestPort;
  transferIo?: WindowsNativeTransferIoTestPort;
  sourceEntries?: (path: string) => readonly Readonly<{name: string; directory: boolean}>[];
  /** Physical directory that substitutes the configured state directory. */
  stateDirectory?: string;
}>;

function isAsyncLike(value: unknown): boolean {
  return typeof value !== "function" ||
    utilTypes.isAsyncFunction(value) || utilTypes.isGeneratorFunction(value);
}

function checkSync(call: () => unknown): void {
  const outcome: unknown = call();
  if (utilTypes.isPromise(outcome)) Promise.prototype.then.call(outcome, undefined, () => undefined);
  if (outcome !== undefined) fail("REVALIDATE");
}

export function createWindowsProductNative(
  config: WindowsOperatorConfig, options: WindowsProductNativeOptions,
): WindowsProductNative {
  if (process.platform !== "win32") fail("UNSUPPORTED_PLATFORM");
  return build(config, options, undefined);
}

/** Off-win32 contract composition: real journals on disposable state +
 * injected transports — explicitly untrusted, never OS acceptance. */
export function createWindowsProductNativeForTesting(
  config: WindowsOperatorConfig, options: WindowsProductNativeOptions,
  deps: WindowsProductNativeTestDeps,
): WindowsProductNative {
  if (process.platform === "win32") fail("TEST_DEPS_FORBIDDEN");
  return build(config, options, deps);
}

function build(
  configuration: WindowsOperatorConfig,
  options: WindowsProductNativeOptions,
  deps: WindowsProductNativeTestDeps | undefined,
): WindowsProductNative {
  if (options === null || typeof options !== "object" || isAsyncLike(options.assertCurrent))
    fail("OPTIONS");
  const config = Object.freeze({...configuration});
  const assertCurrent = options.assertCurrent;
  const enroll = options.enrollExistingSources === true;
  let closed = false, closing = false, unavailable: unknown;
  const owners = new Set<{close(): void}>();
  const root = validateWindowsPath(config.root, config.root).canonical;
  const stateRoot = validateWindowsPath(config.publicationStateRoot, config.publicationStateRoot).canonical;
  const stateDirConfig = validateWindowsPath(config.publicationStateDirectory, stateRoot).canonical;
  const key = (s: string) => asciiCaseFold(s).replace(/\\$/, "");
  if (key(root) === key(stateRoot) || key(root).startsWith(key(stateRoot) + "\\") ||
      key(stateRoot).startsWith(key(root) + "\\")) fail("STATE_OVERLAP");
  if (!/^[0-9a-f]{64}$/.test(config.expectedHash)) fail("EXPECTED_HASH");
  const storageCurrent = (): void => {
    if (closed || closing) fail("CLOSED");
    if (unavailable !== undefined) throw unavailable;
  };
  const fence = (): void => {
    storageCurrent();
    checkSync(assertCurrent);
  };
  const physicalStateDir = deps?.stateDirectory ?? stateDirConfig;

  // ---- scoped native runtimes ----
  const pins = new Map<string, WindowsRuntimeRootIdentity>();
  const runtime = (runtimeRoot: string, directory: string, databaseName?: string): WindowsRuntimePlatform => {
    const p = new WindowsRuntimePlatform({
      root: runtimeRoot, probeExecutable: config.probeExecutable,
      expectedHash: config.expectedHash, systemRoot: config.systemRoot,
      expectedRoot: pins.get(key(runtimeRoot)), databaseName,
      untrustedTestPort: deps?.runtimeTestPort,
    });
    try { p.bind(directory); return p; }
    catch (error) {
      try { p.close(); } catch (cleanup) {
        owners.add(p);
        throw unavailable = new AggregateError([error, cleanup], "Native bind and cleanup failed");
      }
      throw error;
    }
  };
  function scoped<T>(p: WindowsRuntimePlatform, work: () => T): T {
    let result: T, cause: unknown, failed = false;
    try { result = work(); } catch (error) { cause = error; failed = true; }
    try { p.close(); } catch (cleanup) {
      owners.add(p);
      throw unavailable = new AggregateError(failed ? [cause, cleanup] : [cleanup], "Native proof cleanup failed");
    }
    if (failed) throw cause;
    return result!;
  }
  function pinRoot(under: string, d: WindowsRuntimePreparedDirectory): WindowsRuntimeRootIdentity {
    const next = {rootFileId: d.rootFileId, volumeId: d.rootVolumeId}, prior = pins.get(key(under));
    if (prior && (key(prior.rootFileId) !== key(next.rootFileId) || key(prior.volumeId) !== key(next.volumeId)))
      fail("ROOT_CHANGED");
    pins.set(key(under), Object.freeze(next));
    return next;
  }
  function nativeDirectory(under: string, path: string): WindowsRuntimePreparedDirectory {
    const p = runtime(under, path);
    return scoped(p, () => { const d = p.validatedDirectoryIdentity(); pinRoot(under, d); return d; });
  }
  const proveRootFor = (ioRoot: string): WindowsRuntimeRootIdentity => {
    const d = nativeDirectory(ioRoot, ioRoot);
    return pinRoot(ioRoot, d);
  };
  const proveRoot = (): WindowsRuntimeRootIdentity => proveRootFor(root);
  let bindings: WindowsSourceBindings | undefined;
  let initializingBindings = false;
  function checkBinding(identity: WindowsSourceIdentity, newlyCreated = false): void {
    const b = sourceBindings();
    if (enroll || newlyCreated) b.enroll(identity); else b.assert(identity);
  }
  function directoryBinding(under: string, d: WindowsRuntimePreparedDirectory, newlyCreated = false): void {
    checkBinding({kind: "root", canonicalPath: under, fileId: d.rootFileId, volumeId: d.rootVolumeId});
    checkBinding({kind: "directory", canonicalPath: d.canonicalPath, fileId: d.directoryFileId, volumeId: d.directoryVolumeId}, newlyCreated);
  }
  const dirProof = (under: string, dirPath: string) => {
    const d = nativeDirectory(under, dirPath);
    directoryBinding(under, d);
    return Object.freeze({canonicalPath: d.canonicalPath, fileId: d.directoryFileId, volumeId: d.directoryVolumeId});
  };
  const creationReservations = new Map<string, string>();
  const proveRetained = (retained: WindowsSourceIdentity, hash: string, bytes: number, ioRoot = root): void => {
    const retainedPath = retained.canonicalPath[0].toUpperCase() + retained.canonicalPath.slice(1);
    const prove = () => {
      const rt = runtime(ioRoot, win32.dirname(retainedPath));
      return scoped(rt, () => rt.validatedPrivateFileIdentity(retainedPath));
    };
    const before = prove();
    if (key(before.fileId) !== retained.fileId || key(before.volumeId) !== retained.volumeId) fail("RETAINED_CHANGED");
    const fsPort = deps?.runtimeTestPort?.fs;
    const stat = fsPort ? fsPort.lstat(retainedPath) : lstatSync(retainedPath);
    if (stat.size !== bytes || bytes > 256 * 1024 * 1024) fail("RETAINED_CHANGED");
    const raw = fsPort ? fsPort.readFile(retainedPath) : readFileSync(retainedPath);
    const after = prove();
    if (raw.byteLength !== bytes || sha(raw) !== hash || canonical(before) !== canonical(after)) fail("RETAINED_CHANGED");
  };
  function sourceFile(path: string, newlyCreated = false, expected?: {fileId: string; volumeId: string}, receiptBoundary = false,
    ioRoot = root): WindowsRuntimeFileIdentity {
    const canonicalPath = validateWindowsPath(path, ioRoot).canonical;
    const p = runtime(ioRoot, win32.dirname(canonicalPath));
    return scoped(p, () => {
      const d = p.validatedDirectoryIdentity(); pinRoot(ioRoot, d); directoryBinding(ioRoot, d);
      const f = p.validatedPrivateFileIdentity(canonicalPath);
      if (expected && (key(f.fileId) !== key(expected.fileId) || key(f.volumeId) !== key(expected.volumeId)))
        fail("FILE_CHANGED");
      if (receiptBoundary) sourceBindings().enrollCreated({...f, kind: "file"},
        (identity, sha256, bytes) => proveRetained(identity, sha256, bytes, ioRoot), creationReservations.get(key(canonicalPath)));
      else checkBinding({...f, kind: "file"}, newlyCreated);
      return f;
    });
  }
  function sourceBindings(): WindowsSourceBindings {
    if (bindings) return bindings;
    if (initializingBindings) fail("BINDING_REENTRANT");
    initializingBindings = true;
    let candidate: WindowsSourceBindings | undefined;
    let owner: {close(): void} | undefined;
    let held: PrivatePlatform | undefined;
    try {
      held = heldPlatform(WINDOWS_SOURCE_BINDINGS_DATABASE, "small-ledger", true);
      // PrivateLedger closes its platform even after a failed DB close.
      // Give it a borrowed view: only this outer owner may close the actual
      // branded held platform, after the ledger confirms successful closure.
      // The view's close is not a native CLOSED acknowledgement.
      const borrowed: PrivatePlatform = {...held, close() {}};
      candidate = new WindowsSourceBindings(physicalStateDir, borrowed, [root]);
      const ledger = candidate, ownedPlatform = held;
      owner = {close() { ledger.close(); ownedPlatform.close(); }};
      owners.add(owner);
      const p = runtime(stateRoot, stateDirConfig, WINDOWS_SOURCE_BINDINGS_DATABASE);
      const identities = scoped(p, (): WindowsSourceIdentity[] => {
        const d = p.validatedDirectoryIdentity(), f = p.validatedFileIdentity(win32.join(stateDirConfig, WINDOWS_SOURCE_BINDINGS_DATABASE));
        pinRoot(stateRoot, d);
        const source = proveRoot();
        return [
          {kind: "root", canonicalPath: stateRoot, fileId: d.rootFileId, volumeId: d.rootVolumeId},
          {kind: "directory", canonicalPath: stateDirConfig, fileId: d.directoryFileId, volumeId: d.directoryVolumeId},
          {...f, kind: "file"},
          {kind: "root", canonicalPath: root, fileId: source.rootFileId, volumeId: source.volumeId},
        ];
      });
      for (const id of identities) enroll ? candidate.enroll(id) : candidate.assert(id);
      bindings = candidate;
      return candidate;
    } catch (error) {
      if (owner) {
        try { owner.close(); owners.delete(owner); }
        catch (cleanup) { throw unavailable = new AggregateError([error, cleanup], "Source binding initialization and cleanup failed"); }
      } else if (held) {
        // The foreign constructor does not expose its partially opened DB.
        // Its thrown error is not proof of closure. Preserve this scope until
        // an explicit future resolver can establish the DB's closed state.
        const retained = held;
        owners.add({close() {
          void retained;
          throw new AggregateError([error], "Source binding constructor closure unconfirmed; native lease retained");
        }});
      }
      throw unavailable = error;
    } finally { initializingBindings = false; }
  }
  function acquirer(opts: NativeAuthorityLeaseOptions): AcquirePrivateAuthorityLease {
    if (!deps) return createNativeAuthorityLeaseAcquirer(opts);
    if (deps.acquireLease) return deps.acquireLease(opts);
    return (path) => {
      const before = canonical(opts.identityFor(path));
      return {trust: "untrusted-test", assertHeld() {
        if (canonical(opts.identityFor(path)) !== before) fail("LEASE_IDENTITY_CHANGED");
      }, close() {}};
    };
  }
  function heldPlatform(databaseName: string, profile: WindowsHotJournalSnapshotProfile = "small-ledger", bootstrap = false): PrivatePlatform {
    fence();
    const state = nativeDirectory(stateRoot, stateDirConfig);
    const ids = pinRoot(stateRoot, state);
    if (!bootstrap) directoryBinding(stateRoot, state);
    const stateRuntime = new WindowsRuntimePlatform({
      root: stateRoot, probeExecutable: config.probeExecutable,
      expectedHash: config.expectedHash, systemRoot: config.systemRoot,
      databaseName, snapshotProfile: profile, expectedRoot: ids,
      expectedDirectory: {fileId: state.directoryFileId, volumeId: state.directoryVolumeId},
      untrustedTestPort: deps?.runtimeTestPort,
    });
    const nativePath = win32.join(stateDirConfig, databaseName);
    const physicalPath = join(physicalStateDir, databaseName);
    const base = deps?.platform ? deps.platform(physicalStateDir, databaseName, profile) : new WindowsPrivatePlatform(stateRuntime);
    let bootstrapChecked = false;
    // Borrows (never releases) the platform: it only retains preflight reader
    // connections so an unconfirmed bootstrap reader can never permit the
    // outer held-platform release. Closed after a successful preflight and
    // again at inner.close for the failure path that already ran fail().
    let bootstrapOwner: SqliteConnectionOwner | undefined;
    function fileProof(): WindowsRuntimeFileIdentity {
      // State authority proof is independent of a source-session veto:
      // exact captures must still be retained after native dispatch revoked
      // that session. Source mutation and CAS use scopeFence separately.
      storageCurrent();
      const d = stateRuntime.validatedDirectoryIdentity(); pinRoot(stateRoot, d);
      const f = stateRuntime.validatedFileIdentity(nativePath);
      if (!bootstrap) { directoryBinding(stateRoot, d); checkBinding({...f, kind: "file"}); }
      return f;
    }
    const inner: PrivatePlatform = {
      kind: "windows",
      bind(path) {
        if (deps?.platform) stateRuntime.bind(stateDirConfig);
        const result = base.bind(path);
        // A missing retained authority is not a new enrollment opportunity.
        if (!enroll && bootstrap) fileProof();
        return result;
      },
      createExclusive(path) {
        if (key(path) !== key(physicalPath)) fail("STATE_DATABASE_PATH");
        if (deps?.platform) {
          let exists = true;
          try { lstatSync(physicalPath); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false; else throw error; }
          if (exists && !bootstrap) checkBinding({...stateRuntime.validatedFileIdentity(nativePath), kind: "file"});
          base.createExclusive(path);
          if (!exists && !bootstrap) sourceBindings().enrollCreated({...stateRuntime.validatedFileIdentity(nativePath), kind: "file"},
            () => fail("STATE_REUSE"));
        } else {
          const receipt = stateRuntime.createExclusiveDurablyWithReceipt(nativePath);
          if (!bootstrap) {
            if (receipt.state === "CREATED") sourceBindings().enrollCreated({...receipt.identity, kind: "file"}, () => fail("STATE_REUSE"));
            else checkBinding({...receipt.identity, kind: "file"});
          }
        }
      },
      assertRoot() { base.assertRoot(); stateRuntime.assertRoot(); },
      assertFile(path) {
        base.assertFile(path);
        const f = fileProof();
        // Bootstrap cannot use its own writable ledger to decide whether
        // that ledger is the retained authority. Compare existing self/source
        // bindings read-only while the lease is already held, before the
        // PrivateLedger constructor can change SQLite mode or schema.
        if (bootstrap && !bootstrapChecked) {
          if (lstatSync(physicalPath).size === 0) {
            if (!enroll) fail("BINDING_REQUIRED");
          } else {
            const d = stateRuntime.validatedDirectoryIdentity(), source = proveRoot();
            const identities: WindowsSourceIdentity[] = [
              {kind: "root", canonicalPath: stateRoot, fileId: d.rootFileId, volumeId: d.rootVolumeId},
              {kind: "directory", canonicalPath: stateDirConfig, fileId: d.directoryFileId, volumeId: d.directoryVolumeId},
              {...f, kind: "file"},
              {kind: "root", canonicalPath: root, fileId: source.rootFileId, volumeId: source.volumeId},
            ];
            const owner = new SqliteConnectionOwner(() => { void base; void stateRuntime; });
            bootstrapOwner = owner;
            try {
            preflightExistingJournal(physicalPath, () => { stateRuntime.assertRoot(); fileProof(); }, db => {
              for (const identity of identities) {
                const value = {...identity, canonicalPath: asciiCaseFold(identity.canonicalPath),
                  fileId: asciiCaseFold(identity.fileId), volumeId: asciiCaseFold(identity.volumeId)};
                const recordKey = `source:${value.kind}:${sha(value.canonicalPath)}`;
                const row = db.prepare("SELECT value FROM m3_private_records WHERE key=?").get(recordKey);
                if (row === undefined) { if (!enroll) fail("BINDING_REQUIRED"); }
                else if (row.value !== canonical(value)) fail("BINDING_CHANGED");
              }
            }, inner, owner);
            } catch (error) { owner.fail(error); }
            owner.close();
          }
          bootstrapChecked = true;
        }
      },
      assertSidecars(path) { base.assertSidecars(path); },
      assertEmptyFile(path) { base.assertEmptyFile(path); },
      close() { bootstrapOwner?.close(); base.close(); if (deps?.platform) stateRuntime.close(); },
      ...(base.withHotJournalSnapshot ? {withHotJournalSnapshot: base.withHotJournalSnapshot.bind(base)} : {}),
    };
    const acquire = acquirer({...config, root: stateRoot, expectedRoot: ids, identityFor(path) {
      if (key(path) !== key(physicalPath)) fail("STATE_DATABASE_PATH");
      const f = fileProof(), d = stateRuntime.validatedDirectoryIdentity();
      return {directoryFileId: d.directoryFileId, directoryVolumeId: d.directoryVolumeId,
        fileId: f.fileId, volumeId: f.volumeId};
    }});
    // Only the archive owner closes this wrapper, after its SQLite connection.
    return deps ? withPrivateAuthorityLeaseForTesting(inner, acquire) : withPrivateAuthorityLease(inner, acquire);
  }

  // ---- lazily-created authorities and IOs ----
  const binding = (): string =>
    canonical({
      root, stateRoot,
      rootFileId: proveRoot().rootFileId, volumeId: proveRoot().volumeId,
    }, 4096);

  let checkpointArchive: WindowsRecoveryArchive | undefined;
  const recoveryArchive = (): WindowsRecoveryArchive => {
    if (checkpointArchive !== undefined) return checkpointArchive;
    if (!bound) fail("UNBOUND");
    const archiveBinding = canonical({source: binding(), workspacePath: key(bound.path),
      workspaceId: bound.workspaceId, directory: bound.dirIdentity}, 4096);
    const a = new WindowsRecoveryArchive(physicalStateDir,
      heldPlatform(WINDOWS_RECOVERY_ARCHIVE_DATABASE, "recovery-archive"), archiveBinding, [root]);
    owners.add(a); checkpointArchive = a; return a;
  };
  let rawArchive: RawExportArchive | undefined;
  const rawExportArchive = (): RawExportArchive => {
    if (rawArchive !== undefined) return rawArchive;
    const a = new RawExportArchive(physicalStateDir, heldPlatform(RAW_EXPORT_DATABASE, "recovery-archive"),
      binding(), [root], maintenanceOriginProvider);
    owners.add(a); rawArchive = a; return a;
  };

  let admissionDirectories: ReadonlyMap<string, WindowsSourceIdentity> | undefined;
  const dirIdentityFor = (path: string, ioRoot = root): WindowsRuntimeDirectoryIdentity => {
    const selected = admissionDirectories?.get(key(path));
    if (selected) {
      const d = nativeDirectory(ioRoot, path);
      if (key(d.directoryFileId) !== key(selected.fileId) || key(d.directoryVolumeId) !== key(selected.volumeId)) fail("ADMISSION_CHANGED");
      return {fileId: d.directoryFileId, volumeId: d.directoryVolumeId};
    }
    const d = dirProof(ioRoot, path);
    return Object.freeze({ fileId: d.fileId, volumeId: d.volumeId });
  };

  let checkpointIo: WindowsRecoveryIo | undefined;
  const checkpointIoGet = (): WindowsRecoveryIo => {
    if (checkpointIo !== undefined) return checkpointIo;
    const opts = {
      root, probeExecutable: config.probeExecutable, expectedHash: config.expectedHash,
      systemRoot: config.systemRoot, expectedRoot: proveRoot(),
      archive: recoveryArchive(), directoryIdentity: dirIdentityFor,
      assertCurrent: workspaceFence,
    };
    checkpointIo = deps?.recoveryIo !== undefined
      ? createWindowsPrivateRecoveryIoForTesting(opts, deps.recoveryIo)
      : createWindowsPrivateRecoveryIo(opts);
    return checkpointIo;
  };
  let rawIo: WindowsRecoveryIo | undefined;
  const rawIoGet = (): WindowsRecoveryIo => {
    if (rawIo !== undefined) return rawIo;
    const opts = {
      root, probeExecutable: config.probeExecutable, expectedHash: config.expectedHash,
      systemRoot: config.systemRoot, expectedRoot: proveRoot(),
      archive: rawExportArchive(), directoryIdentity: dirIdentityFor,
      assertCurrent: scopeFence,
      publicationKind: "raw-export" as const,
    };
    rawIo = deps?.recoveryIo !== undefined
      ? createWindowsPrivateRecoveryIoForTesting(opts, deps.recoveryIo)
      : createWindowsPrivateRecoveryIo(opts);
    return rawIo;
  };

  // ---- workspace binding ----
  let bound: Readonly<{
    path: string; workspaceId: string;
    dirIdentity: WindowsRuntimeDirectoryIdentity; fence(): void;
  }> | undefined;
  /** Mandatory for checkpoint calls: binding must exist, then the global
   * fence AND the workspace callback run. */
  const workspaceFence = (): void => {
    if (bound === undefined) fail("UNBOUND");
    scopeFence();
  };
  /** For general journals (K/J/raw): global fence always, the workspace
   * callback only once a workspace is bound. */
  const scopeFence = (): void => {
    fence();
    const id = proveRoot();
    checkBinding({kind: "root", canonicalPath: root, fileId: id.rootFileId, volumeId: id.volumeId});
    if (bound !== undefined) {
      checkSync(bound.fence);
      const d = dirProof(root, bound.path);
      if (key(d.fileId) !== key(bound.dirIdentity.fileId) || key(d.volumeId) !== key(bound.dirIdentity.volumeId))
        fail("WORKSPACE_CHANGED");
    }
  };

  let rescueWorkspace: Readonly<NativePrivateIdentity> | undefined;
  const bindWorkspace = (path: string, workspaceId: string, assertWorkspaceCurrent?: () => void): void => {
    if (closed) fail("CLOSED");
    if (rescueWorkspace) fail("RESCUE_REBIND");
    if (typeof workspaceId !== "string" || !WORKSPACE_ID.test(workspaceId)) fail("WORKSPACE");
    if (assertWorkspaceCurrent !== undefined && isAsyncLike(assertWorkspaceCurrent)) fail("CALLBACK");
    const canonical = validateWindowsPath(path, root).canonical;
    fence();
    if (assertWorkspaceCurrent !== undefined) checkSync(assertWorkspaceCurrent);
    const dir = dirProof(root, canonical);  // prove the workspace dir itself
    const identity = Object.freeze({ fileId: dir.fileId, volumeId: dir.volumeId });
    if (bound !== undefined) {
      if (key(bound.path) !== key(canonical) || bound.workspaceId !== workspaceId ||
          bound.dirIdentity.fileId !== identity.fileId || bound.dirIdentity.volumeId !== identity.volumeId)
        fail("REBIND");
      return;
    }
    if (enroll) {
      sourceBindings().enroll({
        kind: "directory", canonicalPath: canonical,
        fileId: identity.fileId, volumeId: identity.volumeId,
      });
    } else {
      sourceBindings().assert({
        kind: "directory", canonicalPath: canonical,
        fileId: identity.fileId, volumeId: identity.volumeId,
      });
    }
    bound = Object.freeze({
      path: canonical, workspaceId, dirIdentity: identity,
      fence: () => { if (assertWorkspaceCurrent !== undefined) checkSync(assertWorkspaceCurrent); },
    });
  };

  /** Fresh SID for the workspace directory: mirrors the maintenance CLI's
   * pinned-helper probe. Tests inject the same untrusted probe port the
   * runtime uses; production spawns the pinned native helper directly.
   * Never a raw caller-supplied proof — the evidence is validated and its
   * native IDs are compared against the freshly proved directory/root. */
  const sidProofOf = (path: string, under: string, dir: WindowsRuntimePreparedDirectory): string => {
    let evidence: unknown;
    const port = deps?.runtimeTestPort?.probe;
    if (port !== undefined) {
      evidence = port.probe(path, under);
    } else {
      // The pinned helper is re-proven on BOTH sides of the spawn: a replaced
      // or relinked executable between checks is never trusted.
      const pinned = () => {
        const executable = lstatSync(config.probeExecutable);
        if (!executable.isFile() || executable.isSymbolicLink() || executable.nlink !== 1 ||
            executable.size > 64 * 1024 * 1024 ||
            sha(readFileSync(config.probeExecutable)) !== config.expectedHash) fail("HELPER_PIN");
      };
      pinned();
      const result = spawnSync(config.probeExecutable, [path, under], {shell: false, windowsHide: true,
        cwd: config.systemRoot,
        env: {SystemRoot: config.systemRoot, windir: config.systemRoot,
          TEMP: win32.join(config.systemRoot, "Temp"), TMP: win32.join(config.systemRoot, "Temp")},
        timeout: 15_000, maxBuffer: 64 * 1024, encoding: "utf8"});
      if (result.error !== undefined || result.status !== 0 || result.signal !== null || result.stderr !== "")
        fail("SID_PROOF");
      pinned();
      evidence = JSON.parse(result.stdout);
    }
    assertWindowsProbe(evidence, {canonicalPath: path, canonicalRoot: under});
    const p = evidence as WindowsProbeEvidence;
    if (p.fileId !== dir.directoryFileId || p.volumeId !== dir.directoryVolumeId ||
        p.rootFileId !== dir.rootFileId || p.rootVolumeId !== dir.rootVolumeId) fail("SID_PROOF");
    return p.sid;
  };

  /** Captures the immutable origin scope at K reserve / raw prepare time.
   * The scope pins the exact native root of the request wire, the actual
   * bound workspace (or a null-ID rescue workspace), and the native parent
   * directory of every endpoint — sampled from live native proofs while the
   * operation still holds authority. Returns undefined only for legitimately
   * unbound products or a wire root that cannot contain this root; a stale
   * or mismatched proof throws, never degrades to the legacy predicate. */
  const maintenanceOriginProvider: WindowsMaintenanceOriginProvider = (request) => {
    scopeFence();
    const workspacePath = bound?.path ?? rescueWorkspace?.path;
    const workspaceId = bound?.workspaceId ?? null;
    if (workspacePath === undefined) return undefined;
    const ioRoot = request.family === "raw-export" ? root : request.root;
    if (typeof ioRoot !== "string" || validateWindowsPath(ioRoot, ioRoot).canonical !== ioRoot) return undefined;
    // Only the exact configured native root can pin this workspace; a
    // broader or unrelated wire root claims no origin scope.
    if (key(ioRoot) !== key(root)) return undefined;
    const rd = nativeDirectory(root, root);
    const rootIdentity = Object.freeze({path: root, fileId: rd.rootFileId, volumeId: rd.rootVolumeId});
    const wd = nativeDirectory(root, workspacePath);
    const retained = bound === undefined ? rescueWorkspace! : {fileId: bound.dirIdentity.fileId, volumeId: bound.dirIdentity.volumeId};
    if (key(wd.directoryFileId) !== key(retained.fileId) || key(wd.directoryVolumeId) !== key(retained.volumeId))
      fail("WORKSPACE_CHANGED");
    const sid = sidProofOf(workspacePath, root, wd);
    const endpoints = request.paths.map(p => {
      const path = validateWindowsPath(p, root).canonical;
      const d = dirProof(root, win32.dirname(path));
      return Object.freeze({path, parent: Object.freeze({
        path: d.canonicalPath, fileId: d.fileId, volumeId: d.volumeId})});
    });
    const scope = Object.freeze({
      version: 1 as const, family: request.family, attemptId: request.attemptId,
      requestSha256: request.requestSha256, root: rootIdentity, stateRoot,
      workspace: Object.freeze({path: workspacePath,
        fileId: retained.fileId, volumeId: retained.volumeId, workspaceId}),
      osSid: sid, writerId: null, sessionId: null, endpoints: Object.freeze(endpoints)});
    scopeFence();
    return scope;
  };

  // ---- crash recovery port (checkpoint CAS over the C archive) ----
  let crashPort: CrashRecoveryNativePort | undefined;
  const crashPortGet = (): CrashRecoveryNativePort => {
    if (crashPort !== undefined) return crashPort;
    crashPort = createWindowsRecoveryFilePort({
      archive: recoveryArchive(),
      io: checkpointIoGet(),
      assertCurrent: workspaceFence,
      parentIdentityFor(parentPath) {
        const d = dirProof(root, parentPath);
        return Object.freeze({ fileId: d.fileId, volumeId: d.volumeId });
      },
      assertLegacyAbsent(logicalPath, workspace) {
        requireWorkspace(logicalPath, workspace);
        const parent = win32.dirname(logicalPath);
        const d = dirProof(root, parent);
        const outcome = checkpointIoGet().readMissing({
          path: logicalPath,
          expectedDirectory: { fileId: d.fileId, volumeId: d.volumeId },
        });
        if (outcome.state === "ABSENT") return;
        if (outcome.state === "EXISTS") fail("LEGACY_RECOVERY_PRESENT");
        fail("LEGACY_ABSENCE_UNPROVEN");
      },
    });
    return crashPort;
  };

  // ---- K private persistence (lazy) ----
  const filesystems = new Map<string, NativePrivateFilesystemPort>();
  let persistenceJournal: WindowsPrivatePersistenceJournal | undefined;
  // One shared authority object serves every dedicated K instance so UNKNOWN
  // poisoning in one capability is never bypassed through a sibling port.
  let persistenceAuthority: WindowsPrivatePersistenceOptions["authority"] | undefined;
  let persistenceMutation = false;
  const mutation = <T>(work: () => T): T => {
    if (persistenceMutation) fail("REENTRANT_MUTATION");
    persistenceMutation = true;
    try { return work(); } finally { persistenceMutation = false; }
  };
  const relocationReservations = new Map<string, string>();
  const relocationKey = (source: string, destination: string) => key(source) + "|" + key(destination);
  const completeRelocation = (source: NativePrivateFile | NativePrivateTree,
    receipt: NativePrivateReceipt | NativePrivateDirectoryReceipt, kind: "file" | "directory",
    ioRoot = root, ioFence = scopeFence): void => {
    ioFence();
    const dest = receipt.identity;
    const reservation = relocationReservations.get(relocationKey(source.path, dest.path));
    if (!reservation) fail("RELOCATION_RESERVATION");
    let identity: WindowsSourceIdentity;
    if (kind === "directory") {
      const current = nativeDirectory(ioRoot, dest.path);
      identity = {kind, canonicalPath: current.canonicalPath, fileId: current.directoryFileId, volumeId: current.directoryVolumeId};
    } else {
      const rt = runtime(ioRoot, win32.dirname(dest.path));
      identity = scoped(rt, () => ({...rt.validatedPrivateFileIdentity(dest.path), kind}));
    }
    if (key(identity.fileId) !== key(dest.fileId) || key(identity.volumeId) !== key(dest.volumeId)) fail("RELOCATION_CHANGED");
    sourceBindings().completeMove(reservation, identity, canonical(receipt, 8192));
    relocationReservations.delete(relocationKey(source.path, dest.path));
    ioFence();
  };
  /** One shared K journal serves every ioRoot: the binding stays the original
   * source+state identity while each capability gets its own native helper
   * instance rooted at its authorized common ancestor. */
  const filesystemFor = (ioRoot: string, ioFence: () => void, dedicated = false): NativePrivateFilesystemPort => {
    if (!dedicated) {
      const cached = filesystems.get(key(ioRoot));
      if (cached !== undefined) return cached;
    }
    if (persistenceJournal === undefined) {
      persistenceJournal = new WindowsPrivatePersistenceJournal(
        physicalStateDir, heldPlatform("private-persistence-v1.sqlite", "recovery-archive"), binding(), storageCurrent, [root],
        maintenanceOriginProvider);
      owners.add(persistenceJournal);
      const journal = persistenceJournal;
      persistenceAuthority = {
        version: 1, independent: true,
        assertCurrent: () => journal.assertCurrent(),
        reserve(intent: Parameters<WindowsPrivatePersistenceJournal["reserve"]>[0]) {
          journal.reserve(intent);
          const wire = Buffer.from(intent.wire), length = wire.readUInt32LE(0);
          if (length < 1 || length > 8192 || length + 4 > wire.length) fail("BINDING_INTENT");
          const h = JSON.parse(wire.subarray(4, length + 4).toString("ascii"));
          const reservation = ["write-new", "copy-new"].includes(h.operation)
            ? creationReservations.get(key(h.destination ?? h.path))
            : relocationReservations.get(relocationKey(h.path, h.destination ?? h.path));
          if (reservation) sourceBindings().associateTransition(reservation, intent.attemptId, sha(wire));
        },
        capture: (id: string, capture: Parameters<WindowsPrivatePersistenceJournal["capture"]>[1]) => journal.capture(id, capture),
        terminal: (id: string, state: "APPLIED" | "UNKNOWN", receipt: string) => journal.terminal(id, state, receipt),
      };
    }
    const expectedIoRoot = proveRootFor(ioRoot);
    const opts = {
      root: ioRoot, probeExecutable: config.probeExecutable, expectedHash: config.expectedHash,
      systemRoot: config.systemRoot, expectedRoot: expectedIoRoot,
      authority: persistenceAuthority!,
      directoryIdentity: (path: string) => dirIdentityFor(path, ioRoot),
      beforeCreatedFile(path: string) {
        ioFence();
        creationReservations.set(key(path), sourceBindings().reserveCreation(path));
      },
      onCreatedFile(receipt: NativePrivateReceipt) {
        ioFence();
        sourceFile(receipt.identity.path, true, receipt.identity, true, ioRoot);
        creationReservations.delete(key(receipt.identity.path));
        ioFence();
      },
      beforeRelocation(source: NativePrivateFile | NativePrivateTree, destination: string, kind: "file" | "directory") {
        ioFence();
        const reservation = sourceBindings().reserveMove({kind, canonicalPath: source.path,
          fileId: source.fileId, volumeId: source.volumeId}, destination, source.sha256, source.bytes);
        relocationReservations.set(relocationKey(source.path, destination), reservation);
      },
      onRelocatedFile(source: NativePrivateFile, receipt: NativePrivateReceipt) { completeRelocation(source, receipt, "file", ioRoot, ioFence); },
      onRelocatedDirectory(source: NativePrivateTree, receipt: NativePrivateDirectoryReceipt) { completeRelocation(source, receipt, "directory", ioRoot, ioFence); },
      createDirectory: (p: string) => {
        ioFence();
        dirProof(ioRoot, win32.dirname(p));
        const rt = runtime(ioRoot, win32.dirname(p));
        return scoped(rt, () => {
          const created = rt.createExclusiveDirectory(p);
          // Only an exclusive CREATED receipt may supply a new identity —
          // EXISTS/UNKNOWN outcomes are never adopted.
          if (created.state !== "CREATED") fail("DIRECTORY");
          directoryBinding(ioRoot, created.identity, true);
          createdDirectories.add(key(p));
          return Object.freeze({
            fileId: created.identity.directoryFileId,
            volumeId: created.identity.directoryVolumeId,
          });
        });
      },
      acquireSqliteLease: acquirer({...config, root: ioRoot, expectedRoot: expectedIoRoot, identityFor(path) {
        ioFence();
        const file = sourceFile(path, false, undefined, false, ioRoot);
        const d = dirProof(ioRoot, win32.dirname(path));
        return {directoryFileId: d.fileId, directoryVolumeId: d.volumeId,
          fileId: file.fileId, volumeId: file.volumeId};
      }}),
      assertCurrent: ioFence,
    };
    const created = deps?.persistenceIo !== undefined
      ? createWindowsPrivatePersistenceForTesting(opts, deps.persistenceIo)
      : createWindowsPrivatePersistence(opts);
    // Every mutation crosses one product-global gate: a fence callback or a
    // sibling capability can never re-enter a K mutation mid-operation, while
    // reads and independent SQLite leases stay ungated.
    const guarded: NativePrivateFilesystemPort = {
      ...created,
      writeNew: (path, bytes, maxBytes) => mutation(() => created.writeNew(path, bytes, maxBytes)),
      copyNew: (source, destination, expected, maxBytes) =>
        mutation(() => created.copyNew(source, destination, expected, maxBytes)),
      renameNew: (source, destination, expected, maxBytes) =>
        mutation(() => created.renameNew(source, destination, expected, maxBytes)),
      renameDirectoryNew: created.renameDirectoryNew === undefined ? undefined :
        (source, destination, expected, check) =>
          mutation(() => created.renameDirectoryNew!(source, destination, expected, check)),
      unlinkExact: (path, expected, maxBytes) => mutation(() => created.unlinkExact(path, expected, maxBytes)),
      proveSync: (path, expected) => mutation(() => created.proveSync(path, expected)),
      createDirectory: (path) => mutation(() => created.createDirectory(path)),
      snapshotSqlite: (db, destination) => mutation(() => created.snapshotSqlite(db, destination)),
    };
    if (!dedicated) filesystems.set(key(ioRoot), guarded);
    return guarded;
  };
  const filesystem = (): NativePrivateFilesystemPort => filesystemFor(root, scopeFence);
  const createdDirectories = new Set<string>();
  const snapshotDestinations = new Set<string>();
  const verifyIdentity = (path: string, expected?: NativePrivateIdentity): WindowsRuntimeFileIdentity => {
    scopeFence();
    const id = sourceFile(path);
    if (expected && (key(expected.path) !== key(id.canonicalPath) ||
        key(expected.fileId) !== key(id.fileId) || key(expected.volumeId) !== key(id.volumeId)))
      fail("FILE_CHANGED");
    return id;
  };
  const output = <T extends NativePrivateReceipt>(work: () => T): T => {
    const receipt = work();
    try {
      const id = sourceFile(receipt.identity.path, true, receipt.identity);
      if (key(id.fileId) !== key(receipt.identity.fileId) || key(id.volumeId) !== key(receipt.identity.volumeId))
        fail("FILE_CHANGED");
      scopeFence();
    } catch (cause) {
      throw new PrivateFilePublicationUnknownError("Native output binding acknowledgement unknown",
        receipt.identity.path, receipt.identity.path, {receipt, cause});
    }
    return receipt;
  };
  const privateFilesystem: NativePrivateFilesystemPort = {
    platform: "win32" as const, version: 1 as const, synchronous: true as const,
    inspectDirectory(p) {
      scopeFence();
      const d = dirProof(root, validateWindowsPath(p, root).canonical);
      return {path: d.canonicalPath, fileId: d.fileId, volumeId: d.volumeId};
    },
    inspectFile(p, max) { verifyIdentity(p); return filesystem().inspectFile(p, max); },
    inspectFileIdentity(p) {
      const id = verifyIdentity(p);
      return {path: id.canonicalPath, fileId: id.fileId, volumeId: id.volumeId};
    },
    read(p, e, max) { const expected = {...e}; verifyIdentity(p, expected); return filesystem().read(p, expected, max); },
    writeNew(p, b, max) { const copy = Uint8Array.from(b); scopeFence(); return output(() => filesystem().writeNew(p, copy, max)); },
    copyNew(s, d, e, max) { const expected = {...e}; verifyIdentity(s, expected); return output(() => filesystem().copyNew(s, d, expected, max)); },
    renameNew(s, d, e, max) { const expected = {...e}; verifyIdentity(s, expected); return output(() => filesystem().renameNew(s, d, expected, max)); },
    unlinkExact(p, e, max) { const expected = {...e}; verifyIdentity(p, expected); filesystem().unlinkExact(p, expected, max); },
    proveSync(p, e) { const expected = {...e}; verifyIdentity(p, expected); return filesystem().proveSync(p, expected); },
    createDirectory(p) { scopeFence(); return filesystem().createDirectory(p); },
    snapshotSqlite(db, p) {
      const destination = validateWindowsPath(p, root).canonical;
      scopeFence();
      const source = db.prepare("PRAGMA database_list").all().find(row => row.name === "main");
      if (typeof source?.file !== "string") fail("SQLITE_SOURCE");
      verifyIdentity(source.file);
      if (snapshotDestinations.has(key(destination))) fail("SQLITE_REENTRANT");
      // K invokes the acquirer only after its exclusive-create receipt and
      // a fresh comparison with that receipt's file ID. This local capability
      // cannot be adopted on reopen or used for another destination.
      snapshotDestinations.add(key(destination));
      try { return output(() => filesystem().snapshotSqlite(db, destination)); }
      finally { snapshotDestinations.delete(key(destination)); }
    },
    inspectTree(p) { scopeFence(); dirProof(root, p); return filesystem().inspectTree!(p); },
    renameDirectoryNew(s, d, e, current) {
      const expected = structuredClone(e);
      scopeFence(); dirProof(root, s);
      return filesystem().renameDirectoryNew!(s, d, expected, current);
    },
    acquireSqliteLease(p, e) { const expected = {...e}; verifyIdentity(p, expected); return filesystem().acquireSqliteLease!(p, expected); },
  };

  let transfer: NativeTransferIoPort | undefined;
  let transferJournal: WindowsPrivateTransferJournal | undefined;
  const transferGet = (): NativeTransferIoPort => {
    if (transfer) return transfer;
    const authority = new WindowsPrivateTransferJournal(physicalStateDir,
      heldPlatform(WINDOWS_PRIVATE_TRANSFER_DATABASE, "recovery-archive"), binding(), storageCurrent, [root]);
    transferJournal = authority;
    owners.add(authority);
    const opts = {root, probeExecutable: config.probeExecutable, expectedHash: config.expectedHash,
      systemRoot: config.systemRoot, expectedRoot: proveRoot(), authority,
      directoryIdentity: dirIdentityFor, assertCurrent: scopeFence};
    transfer = deps?.transferIo ? createWindowsNativeTransferIoForTesting(opts, deps.transferIo) : createWindowsNativeTransferIo(opts);
    return transfer;
  };
  const nativeTransferIo: NativeTransferIoPort = Object.freeze({
    platform: "win32", version: 1, synchronous: true,
    append(path: string, expected: NativePrivateFile, bytes: Uint8Array, maxBytes: number) {
      const want = {...expected}, payload = Uint8Array.from(bytes);
      verifyIdentity(path, want); scopeFence();
      const receipt = transferGet().append(path, want, payload, maxBytes);
      verifyIdentity(path, receipt.identity); scopeFence();
      return receipt;
    },
  });
  const nativeTransfer: NativeTransferOptions = Object.freeze({nativePrivateFilesystem: privateFilesystem, nativeTransferIo});

  /** Shared admission port for an ioRoot. The request authority callback is
   * folded into `current` by the admission functions themselves; `ioFence`
   * runs inside K operations so the exact authorized scope is re-validated. */
  const admissionPort = (ioRoot: string, ioFence: () => void,
    requestCurrent: () => void,
    io: NativePrivateFilesystemPort = filesystemFor(ioRoot, ioFence)): WindowsSourceAdmissionPort => ({
    root: ioRoot,
    directory(path) {
      const d = nativeDirectory(ioRoot, path);
      return {kind: "directory", canonicalPath: d.canonicalPath, fileId: d.directoryFileId, volumeId: d.directoryVolumeId};
    },
    file(path) {
      const rt = runtime(ioRoot, win32.dirname(path));
      return scoped(rt, () => ({...rt.validatedPrivateFileIdentity(path), kind: "file" as const}));
    },
    inspectTree: path => io.inspectTree!(path),
    inspectFile: (path, max) => io.inspectFile(path, max ?? 32 * 1024 * 1024),
    readFile: (path, expected) => io.read(path, expected, 32 * 1024 * 1024),
    withDirectories(identities, work) {
      admissionDirectories = new Map(identities.map(i => [key(i.canonicalPath), i]));
      try { return work(); } finally { admissionDirectories = undefined; }
    },
    enroll: (identities, current) => sourceBindings().enrollSelected(identities, current),
    // This fence deliberately avoids re-entering the binding transaction.
    current() { fence(); if (bound) checkSync(bound.fence); checkSync(requestCurrent); proveRootFor(ioRoot); },
    entries: deps?.sourceEntries,
  });

  const admitSelectedSource = (request: WindowsSelectedSourceAdmission): WindowsSelectedSourceAdmissionReceipt => {
    if (request === null || typeof request !== "object") fail("ADMISSION_REQUEST");
    const selected = {...request};
    scopeFence();
    if (admissionDirectories) fail("ADMISSION_REENTRANT");
    // The exact ancestor chain is explicitly proven; the parent does not need
    // to be enrolled beforehand.
    return admitWindowsSelectedSubtree(selected, admissionPort(root, scopeFence, () => {}));
  };

  const admitSelectedFile = (request: WindowsSelectedFileAdmission): WindowsSelectedFileAdmissionReceipt => {
    if (request === null || typeof request !== "object" || request.expected === null ||
        typeof request.expected !== "object") fail("ADMISSION_REQUEST");
    const selected = {...request, expected: {...request.expected}};
    scopeFence();
    if (admissionDirectories) fail("ADMISSION_REENTRANT");
    return admitWindowsSelectedFile(selected, admissionPort(root, scopeFence, () => {}));
  };

  const inspectSelectedFile = (request: WindowsSelectedFileInspection): NativePrivateFile => {
    if (request === null || typeof request !== "object") fail("INSPECTION_REQUEST");
    const selected = {...request};
    scopeFence();
    if (admissionDirectories) fail("INSPECTION_REENTRANT");
    return inspectWindowsSelectedFile(selected, admissionPort(root, scopeFence, () => {}));
  };

  /** Ancestor directory paths strictly beneath `ancestor`, deepest last —
   * includes `leaf` itself. `leaf` must be at or under `ancestor`. */
  const chainDirectories = (ancestor: string, leaf: string): string[] => {
    const out: string[] = [];
    for (let d = leaf; key(d) !== key(ancestor); d = win32.dirname(d)) {
      if (out.length >= 32 || !key(d).startsWith(key(ancestor) + "\\")) fail("EXTERNAL_PATH");
      out.unshift(d);
    }
    return out;
  };

  const authorizeForWorkspace = (request: WindowsExternalCapabilityRequest, workspace: Readonly<{path: string; fence(): void}>): WindowsExternalCapability => {
    // Snapshot every caller-supplied value BEFORE any callback can mutate it.
    if (request === null || typeof request !== "object" || isAsyncLike(request.assertCurrent)) fail("EXTERNAL_REQUEST");
    const requestKind = request.kind;
    const requestPath = request.path;
    const requestRoot = request.capabilityRoot;
    const requestCurrent = request.assertCurrent;
    const source = request.source === undefined ? undefined : {...request.source};
    const file = request.file === undefined ? undefined :
      {...request.file, expected: {...request.file.expected}};
    scopeFence();
    if (admissionDirectories !== undefined) fail("EXTERNAL_REQUEST");
    checkSync(workspace.fence);
    const kinds: readonly string[] = ["raw-rescue", "backup-archive", "orphan-archive", "backup-source", "restore-target"];
    if (!kinds.includes(requestKind)) fail("EXTERNAL_KIND");
    const readOnly = requestKind === "backup-source";
    if (file !== undefined && requestKind !== "orphan-archive") fail("EXTERNAL_FILE");
    if (file === undefined && requestKind === "orphan-archive") fail("EXTERNAL_FILE");
    if (source === undefined && (requestKind === "backup-archive" || readOnly)) fail("EXTERNAL_SOURCE");
    if (source !== undefined && !["backup-archive", "backup-source", "restore-target"].includes(requestKind))
      fail("EXTERNAL_SOURCE");
    // The trusted lexical boundary is evaluated by the shared planner: the
    // common root must be a real private directory (never a drive root),
    // contain the base root and workspace, stay disjoint from the state
    // tree, and the selection must be a strict descendant disjoint from the
    // workspace. The base root itself never changes.
    const plan = planWindowsExternalSelection({root, workspace: workspace.path, stateRoot,
      capabilityRoot: requestRoot, outputParent: requestPath}, requestPath);
    const capabilityRoot = plan.capabilityRoot, selected = plan.path;
    const stateKey = key(stateRoot);
    const selectedKey = key(selected);
    const workspaceKey = key(workspace.path);
    checkSync(requestCurrent);

    // Native-prove the common root and both ancestor chains, then retain all
    // IDs atomically through the original ledger inside the current proof.
    const capRoot = proveRootFor(capabilityRoot);
    if (key(capRoot.volumeId) !== key(proveRoot().volumeId)) fail("EXTERNAL_VOLUME");
    const identities: WindowsSourceIdentity[] = [
      {kind: "root", canonicalPath: capabilityRoot, fileId: capRoot.rootFileId, volumeId: capRoot.volumeId},
    ];
    // The common root directory itself is also retained as a `directory`
    // binding: the root evidence alone is not a directory enrollment, and
    // internal evidence files (for example SQLite snapshot intents) are
    // written directly beneath it.
    const capRootDir = nativeDirectory(capabilityRoot, capabilityRoot);
    identities.push({kind: "directory", canonicalPath: capRootDir.canonicalPath,
      fileId: capRootDir.directoryFileId, volumeId: capRootDir.directoryVolumeId});
    const seen = new Set<string>([`root:${key(capabilityRoot)}`, `directory:${key(capabilityRoot)}`]);
    const pushChain = (leaf: string): void => {
      for (const directory of chainDirectories(capabilityRoot, leaf)) {
        const marker = `directory:${key(directory)}`;
        if (seen.has(marker)) continue;
        seen.add(marker);
        const d = nativeDirectory(capabilityRoot, directory);
        identities.push({kind: "directory", canonicalPath: d.canonicalPath,
          fileId: d.directoryFileId, volumeId: d.directoryVolumeId});
      }
    };
    pushChain(selected);
    pushChain(workspace.path);
    const workspaceFenceCallback = workspace.fence;
    const current = (): void => {
      fence();
      checkSync(workspaceFenceCallback);
      checkSync(requestCurrent);
      for (const identity of identities) {
        if (identity.kind === "root") {
          const r = proveRootFor(capabilityRoot);
          if (key(r.rootFileId) !== key(identity.fileId) || key(r.volumeId) !== key(identity.volumeId)) fail("EXTERNAL_CHANGED");
        } else {
          const d = nativeDirectory(capabilityRoot, identity.canonicalPath);
          if (key(d.directoryFileId) !== key(identity.fileId) || key(d.directoryVolumeId) !== key(identity.volumeId))
            fail("EXTERNAL_CHANGED");
        }
      }
    };
    sourceBindings().enrollSelected(identities, current);
    // Immutable snapshot of the admitted ancestor set; the operation fence
    // re-proves every one of them on every capability call.
    const retained: readonly WindowsSourceIdentity[] = Object.freeze([...identities]);

    // Fresh per-capability operation fence: base root/workspace proof, the
    // picker authority, then a re-assert of every retained ancestor identity
    // on every call. Archive/orphan source identities are intentionally not
    // pinned here — movable sources validly change identity after a move.
    const operationFence = (): void => {
      scopeFence();
      checkSync(workspaceFenceCallback);
      checkSync(requestCurrent);
      for (const identity of retained) {
        if (identity.kind === "root") {
          const r = proveRootFor(capabilityRoot);
          if (key(r.rootFileId) !== key(identity.fileId) || key(r.volumeId) !== key(identity.volumeId))
            fail("EXTERNAL_CHANGED");
        } else {
          const d = nativeDirectory(capabilityRoot, identity.canonicalPath);
          if (key(d.directoryFileId) !== key(identity.fileId) || key(d.directoryVolumeId) !== key(identity.volumeId))
            fail("EXTERNAL_CHANGED");
        }
        sourceBindings().assert(identity);
      }
      checkSync(requestCurrent);
    };

    // A dedicated K instance per capability: the shared journal/binding
    // continuity is retained while request authority and the pinned ioRoot
    // are never diluted by the base filesystem's fence.
    const capabilityFilesystem = filesystemFor(capabilityRoot, operationFence, true);
    const port = admissionPort(capabilityRoot, operationFence, requestCurrent, capabilityFilesystem);
    const readable: string[] = [root, selected];
    const movable: string[] = [];
    if (source !== undefined) {
      const sourcePath = validateWindowsPath(source.path, capabilityRoot).canonical;
      if (sourcePath !== source.path) fail("EXTERNAL_SOURCE");
      if (readOnly) {
        if (source.kind !== "backup" || key(sourcePath) !== selectedKey) fail("EXTERNAL_SOURCE");
      } else if (requestKind === "backup-archive") {
        // Only an explicitly selected backup subtree beneath workspace
        // backups may leave through the archive move boundary.
        if (source.kind !== "backup" || !key(sourcePath).startsWith(workspaceKey + "\\backups\\"))
          fail("EXTERNAL_SOURCE");
      } else if (requestKind === "restore-target") {
        if (source.kind !== "backup") fail("EXTERNAL_SOURCE");
      }
      const receipt = admitWindowsSelectedSubtree(source, port);
      if (!receipt.identities.some(i => i.kind !== "root" && key(i.canonicalPath) === key(sourcePath))) fail("EXTERNAL_SOURCE");
      readable.push(sourcePath);
      if (requestKind === "backup-archive") movable.push(sourcePath);
    }
    if (file !== undefined) {
      const filePath = validateWindowsPath(file.path, capabilityRoot).canonical;
      const fileKey = key(filePath);
      if (filePath !== file.path || file.expected.path !== filePath ||
          fileKey === stateKey || fileKey.startsWith(stateKey + "\\") ||
          fileKey === workspaceKey || workspaceKey.startsWith(fileKey + "\\")) fail("EXTERNAL_FILE");
      const receipt = admitWindowsSelectedFile(file, port);
      if (key(receipt.file.path) !== key(filePath)) fail("EXTERNAL_FILE");
      readable.push(filePath);
      movable.push(filePath);
    }

    // Proof-preserving layer between the scope facade and the raw K port:
    // every file/directory identity is re-proven natively and asserted
    // against the retained ledger BEFORE the delegate is invoked, so the
    // boundary can never expose bare K semantics for arbitrary handles and
    // nothing here may enroll a previously unknown identity.
    const proveExternalFile = (path: string, expected?: NativePrivateIdentity): void => {
      operationFence();
      const canonicalPath = validateWindowsPath(path, capabilityRoot).canonical;
      const rt = runtime(capabilityRoot, win32.dirname(canonicalPath));
      scoped(rt, () => {
        const d = rt.validatedDirectoryIdentity();
        pinRoot(capabilityRoot, d);
        sourceBindings().assert({kind: "root", canonicalPath: capabilityRoot,
          fileId: d.rootFileId, volumeId: d.rootVolumeId});
        sourceBindings().assert({kind: "directory", canonicalPath: d.canonicalPath,
          fileId: d.directoryFileId, volumeId: d.directoryVolumeId});
        const f = rt.validatedPrivateFileIdentity(canonicalPath);
        if (expected && (key(expected.path) !== key(canonicalPath) ||
            key(f.fileId) !== key(expected.fileId) || key(f.volumeId) !== key(expected.volumeId)))
          fail("FILE_CHANGED");
        sourceBindings().assert({...f, kind: "file"});
      });
    };
    const proveExternalDirectory = (path: string): void => {
      operationFence();
      const d = nativeDirectory(capabilityRoot, path);
      sourceBindings().assert({kind: "root", canonicalPath: capabilityRoot,
        fileId: d.rootFileId, volumeId: d.rootVolumeId});
      sourceBindings().assert({kind: "directory", canonicalPath: d.canonicalPath,
        fileId: d.directoryFileId, volumeId: d.directoryVolumeId});
    };
    const proven: NativePrivateFilesystemPort = {
      platform: "win32",
      version: 1,
      synchronous: true,
      inspectDirectory(path) { proveExternalDirectory(path); return capabilityFilesystem.inspectDirectory(path); },
      inspectFile(path, maxBytes) { proveExternalFile(path); return capabilityFilesystem.inspectFile(path, maxBytes); },
      inspectFileIdentity(path) { proveExternalFile(path); return capabilityFilesystem.inspectFileIdentity(path); },
      read(path, expected, maxBytes) {
        const want = {...expected};
        proveExternalFile(path, want);
        return capabilityFilesystem.read(path, want, maxBytes);
      },
      writeNew(path, bytes, maxBytes) {
        operationFence();
        return capabilityFilesystem.writeNew(path, Uint8Array.from(bytes), maxBytes);
      },
      copyNew(src, destination, expected, maxBytes) {
        const want = {...expected};
        proveExternalFile(src, want);
        return capabilityFilesystem.copyNew(src, destination, want, maxBytes);
      },
      renameNew(src, destination, expected, maxBytes) {
        const want = {...expected};
        proveExternalFile(src, want);
        return capabilityFilesystem.renameNew(src, destination, want, maxBytes);
      },
      renameDirectoryNew: capabilityFilesystem.renameDirectoryNew === undefined ? undefined :
        (src, destination, expected, check) => {
          proveExternalDirectory(src);
          return capabilityFilesystem.renameDirectoryNew!(src, destination, {...expected}, check);
        },
      unlinkExact(path, expected, maxBytes) {
        const want = {...expected};
        proveExternalFile(path, want);
        return capabilityFilesystem.unlinkExact(path, want, maxBytes);
      },
      proveSync(path, expected) {
        const want = {...expected};
        proveExternalFile(path, want);
        return capabilityFilesystem.proveSync(path, want);
      },
      createDirectory(path) { operationFence(); return capabilityFilesystem.createDirectory(path); },
      snapshotSqlite(db, destination) {
        const rows = db.prepare("PRAGMA database_list").all();
        const main = rows.find(row => row.name === "main");
        if (typeof main?.file !== "string") fail("EXTERNAL_SOURCE");
        proveExternalFile(main.file);
        return capabilityFilesystem.snapshotSqlite(db, destination);
      },
      inspectTree: capabilityFilesystem.inspectTree === undefined ? undefined :
        (path) => { proveExternalDirectory(path); return capabilityFilesystem.inspectTree!(path); },
      acquireSqliteLease: capabilityFilesystem.acquireSqliteLease === undefined ? undefined :
        (path, expected) => {
          const want = {...expected};
          proveExternalFile(path, want);
          return capabilityFilesystem.acquireSqliteLease!(path, want);
        },
    };
    const scopedFilesystem = createWindowsExternalFilesystem(proven, {
      capabilityRoot,
      writable: readOnly ? undefined : selected,
      readable: Object.freeze(readable),
      movable: Object.freeze(movable),
      assertCurrent: operationFence,
    });
    return Object.freeze({
      kind: requestKind, path: selected, capabilityRoot,
      privateFilesystem: scopedFilesystem,
      assertCurrent() { operationFence(); },
    });
  };

  const authorizeExternalCapability = (request: WindowsExternalCapabilityRequest): WindowsExternalCapability => {
    if (!bound) fail("UNBOUND");
    return authorizeForWorkspace(request, bound);
  };
  const authorizeReadOnlyRescue = (request: WindowsReadOnlyRescueRequest): WindowsExternalCapability => {
    if (request === null || typeof request !== "object" || isAsyncLike(request.assertCurrent) ||
        (request.kind !== "raw-rescue" && request.kind !== "backup-source") ||
        (request as {file?: unknown}).file !== undefined) fail("RESCUE_REQUEST");
    if (bound) fail("RESCUE_BOUND");
    const selected = {...request, workspaceDirectory: {...request.workspaceDirectory},
      ...(request.source ? {source: {...request.source}} : {})};
    const pin = selected.workspaceDirectory;
    const path = validateWindowsPath(pin.path, root).canonical;
    if (path !== pin.path || key(path) === key(root) ||
        !/^[0-9a-fA-F]{32}$/.test(pin.fileId) || !/^[0-9a-fA-F]{16}$/.test(pin.volumeId) ||
        key(selected.capabilityRoot) !== key(root) ||
        (selected.kind === "raw-rescue" && selected.source !== undefined) ||
        (selected.kind === "backup-source" && selected.source?.kind !== "backup")) fail("RESCUE_REQUEST");
    if (rescueWorkspace && canonical(rescueWorkspace) !== canonical(pin)) fail("RESCUE_REBIND");
    const rescueFence = (): void => {
      scopeFence(); checkSync(selected.assertCurrent);
      const directory = nativeDirectory(root, path);
      if (key(directory.directoryFileId) !== key(pin.fileId) || key(directory.directoryVolumeId) !== key(pin.volumeId)) fail("RESCUE_WORKSPACE_CHANGED");
      // Assert ONLY. Initial-enrollment mode cannot authorize an unknown or
      // replaced rescue source by observing it for the first time here.
      sourceBindings().assert({kind: "directory", canonicalPath: path, fileId: pin.fileId, volumeId: pin.volumeId});
      checkSync(selected.assertCurrent);
    };
    rescueFence();
    rescueWorkspace ??= Object.freeze({...pin});
    return authorizeForWorkspace(selected, {path, fence: rescueFence});
  };

  // ---- J backup artifact (lazy) ----
  let backup: WindowsBackupArtifactPort | undefined;
  let backupInFlight = 0;
  let backupJournal: WindowsBackupArtifactJournal | undefined;
  const backupGet = (): WindowsBackupArtifactPort => {
    if (backup !== undefined) return backup;
    backupJournal = new WindowsBackupArtifactJournal(physicalStateDir,
      heldPlatform(WINDOWS_BACKUP_ARTIFACT_JOURNAL_DATABASE, "backup-artifact"), binding(), [root]);
    owners.add(backupJournal);
    const opts = {
      root, probeExecutable: config.probeExecutable, expectedHash: config.expectedHash,
      systemRoot: config.systemRoot, expectedRoot: proveRoot(),
      journal: backupJournal, directoryIdentity: dirIdentityFor,
      assertCurrent: scopeFence,
    };
    const inner = deps?.backupIo !== undefined
      ? createWindowsBackupArtifactForTesting(opts, deps.backupIo)
      : createWindowsBackupArtifact(opts);
    // Preserve the request's async beforePublish/current callback and add the
    // base fence — the source-current async callback stays J's own contract.
    backup = Object.freeze({
      contractVersion: 1 as const, profile: inner.profile, platform: "win32" as const,
      trust: inner.trust,
      publishNew(request: Parameters<WindowsBackupArtifactPort["publishNew"]>[0]) {
        return inner.publishNew(request);
      },
    });
    return backup;
  };
  const nativeBackup: WindowsBackupArtifactPort = {
    contractVersion: 1 as const,
    profile: WINDOWS_BACKUP_ARTIFACT_PROFILE,
    platform: "win32" as const,
    trust: deps !== undefined ? "untrusted-test" as const : "native-helper" as const,
    async publishNew(request) {
      const requestCurrent = request.assertCurrent;
      if (isAsyncLike(requestCurrent)) fail("CALLBACK");
      backupInFlight++;
      try {
      const frozen = {...request, bytes: Uint8Array.from(request.bytes),
        source: structuredClone(request.source), forbiddenRoots: [...request.forbiddenRoots],
        assertCurrent: () => { scopeFence(); checkSync(requestCurrent); }};
      scopeFence();
      const result = await backupGet().publishNew(frozen);
      if (result.state === "PUBLISHED") {
        try {
          const f = sourceFile(result.path, true, result.identity);
          if (key(f.fileId) !== key(result.identity.fileId) || key(f.volumeId) !== key(result.identity.volumeId)) fail("FILE_CHANGED");
          scopeFence();
        } catch (cause) {
          throw new PrivateFilePublicationUnknownError("Backup binding acknowledgement unknown", result.path, result.stagingPath, {result, cause});
        }
      }
      return result;
      } finally { backupInFlight--; }
    },
  };

  // ---- v3 raw-export private file port ----
  const privateFileV3Port: PrivateFileV3Port = {
    contractVersion: 3 as const, platform: "win32" as const,
    publish(request) {
      const frozen = {...request, bytes: Uint8Array.from(request.bytes)};
      scopeFence();
      const canonical = validateWindowsPath(frozen.path, root).canonical;
      const parent = win32.dirname(canonical);
      const d = dirProof(root, parent);
      const outcome = rawIoGet().publishNew({
        path: canonical, stagingPath: frozen.stagingPath,
        attemptId: frozen.attemptId, bytes: frozen.bytes,
        expectedDirectory: { canonicalPath: parent, fileId: d.fileId, volumeId: d.volumeId },
        beforePublish: frozen.beforePublish,
      });
      if (outcome.state !== "PUBLISHED")
        throw new PrivateFilePublicationUnknownError(
          `Raw export publication unresolved: ${outcome.state}`,
          canonical, frozen.stagingPath, outcome);
      try {
        const f = sourceFile(canonical, true, outcome.identity);
        if (key(f.fileId) !== key(outcome.identity.fileId) || key(f.volumeId) !== key(outcome.identity.volumeId)) fail("FILE_CHANGED");
        scopeFence();
      } catch (cause) {
        throw new PrivateFilePublicationUnknownError("Raw export binding acknowledgement unknown", canonical, frozen.stagingPath, {outcome, cause});
      }
      return outcome;
    },
  };

  const requireWorkspace = (path: string, workspaceId: string): void => {
    if (bound === undefined) fail("UNBOUND");
    if (workspaceId !== bound.workspaceId) fail("WORKSPACE");
    if (typeof path !== "string") fail("PATH");
    const folded = key(validateWindowsPath(path, root).canonical), base = key(bound.path);
    if (!folded.startsWith(base + "\\")) fail("PATH");
  };
  const crashRecoveryPort: CrashRecoveryNativePort = {
    contractVersion: 3 as const, platform: "win32" as const,
    read: (p, ws) => { requireWorkspace(p, ws); workspaceFence(); return crashPortGet().read(p, ws); },
    compareAndSwap: (r) => {
      const frozen = {...r, bytes: Uint8Array.from(r.bytes),
        expected: r.expected ? {...r.expected, bytes: Uint8Array.from(r.expected.bytes)} : undefined};
      requireWorkspace(frozen.path, frozen.workspaceId); workspaceFence();
      return crashPortGet().compareAndSwap(frozen);
    },
  };

  const maintenancePort = (authority: WindowsPrivateMaintenanceAuthority): WindowsPrivateMaintenancePort => {
    if (isAsyncLike(authority.assertCurrent)) fail("MAINTENANCE_AUTHORITY");
    const currentAuthority = authority.assertCurrent;
    const context = Object.freeze({workspace: authority.workspace, workspaceId: authority.workspaceId,
      workspaceFingerprint: authority.workspaceFingerprint, writerId: authority.writerId,
      sessionId: authority.sessionId, osSid: authority.osSid});
    if (!/^[a-f0-9]{64}$/.test(context.workspaceFingerprint) || !/^S-1-\d+(?:-\d+)+$/.test(context.osSid) ||
        ![context.workspaceId, context.writerId, context.sessionId].every(v => typeof v === "string" && v.length > 0 && v.length <= 128))
      fail("MAINTENANCE_CONTEXT");
    const current = () => {
      workspaceFence(); checkSync(currentAuthority);
      if (!bound || key(bound.path) !== key(context.workspace) || bound.workspaceId !== context.workspaceId) fail("MAINTENANCE_CONTEXT");
    };
    current();
    const missing = (path: string, parent: {fileId: string; volumeId: string}) => {
      current();
      // The v3 boundary accepts exactly its two-field directory identity.
      // Native parent observations also carry path/root/SID provenance;
      // passing that larger object would make every legitimate absence fail.
      const proof = rawIoGet().readMissing({path, expectedDirectory: {
        fileId: parent.fileId, volumeId: parent.volumeId,
      }});
      current();
      if (proof.state !== "ABSENT") fail("UNKNOWN_UNRESOLVABLE");
      return proof;
    };
    const maintenanceProof: WindowsPrivatePersistenceMaintenanceProof = {
      assertCurrent: () => current(),
      directory(path) {
        if (key(path) === key(root)) {
          const r = proveRoot();
          return {path, fileId: r.rootFileId, volumeId: r.volumeId};
        }
        const d = dirIdentityFor(path);
        return {path, fileId: d.fileId, volumeId: d.volumeId};
      },
      file: (path, max) => filesystem().inspectFile(path, max),
      tree: path => filesystem().inspectTree!(path),
      missing,
    };
    const mutationHeader = (bytes: Uint8Array) => {
      const b = Buffer.from(bytes);
      if (b.length < 4) fail("UNKNOWN_UNRESOLVABLE");
      const n = b.readUInt32LE(0);
      if (n < 1 || n > 8192 || n + 4 > b.length ||
          ![...b.subarray(4, n + 4)].every(c => c >= 32 && c <= 126)) fail("UNKNOWN_UNRESOLVABLE");
      const text = b.subarray(4, n + 4).toString("ascii"), h = JSON.parse(text);
      if (JSON.stringify(h) !== text) fail("UNKNOWN_UNRESOLVABLE");
      return {h, payload: b.subarray(n + 4)};
    };
    /** The retained origin scope of a filesystem attempt — validated against
     * the configured root/state and the CURRENT native workspace/SID before
     * any K observation runs, and re-asserted inside the append CAS. A wire
     * root other than the configured root is never resolvable. */
    const assertFilesystemOrigin = (item: WindowsPrivatePersistenceInspection): void => {
      const {h} = mutationHeader(item.wire);
      if (h.root !== root) fail("UNKNOWN_UNRESOLVABLE");
      try {
        assertWindowsMaintenanceScope(item.origin,
          Object.freeze({family: "filesystem", attemptId: item.attemptId, requestSha256: sha(item.wire), root,
            paths: Object.freeze([h.path, ...(typeof h.destination === "string" && key(h.destination) !== key(h.path)
              ? [h.destination] : [])])}),
          {workspace: context.workspace, workspaceId: context.workspaceId, osSid: context.osSid},
          {directory: (p: string) => maintenanceProof.directory(p)},
          {root, stateRoot});
      } catch { fail("UNKNOWN_UNRESOLVABLE"); }
      // The current workspace SID is freshly proven — the retained scope's
      // recorded SID alone is not live evidence.
      if (bound !== undefined &&
          sidProofOf(bound.path, root, nativeDirectory(root, bound.path)) !== context.osSid)
        fail("UNKNOWN_UNRESOLVABLE");
    };
    /** Recheck an already committed K observation before the independently
     * committed S event. A crash between these commits leaves S's hold intact;
     * the same fingerprint can finish only that exact transition on restart. */
    const verifyBindingObservation = (item: WindowsPrivatePersistenceInspection): NativePrivateFile | NativePrivateTree => {
      if (!item.resolution) fail("UNKNOWN_UNRESOLVABLE");
      const r = JSON.parse(item.resolution), {h, payload} = mutationHeader(item.wire), e = r.evidence;
      const wireRoot = typeof h.root === "string" ? h.root : "";
      if (r.state !== "APPLIED_OBSERVED" || r.attemptId !== item.attemptId || r.fingerprint !== item.fingerprint ||
          r.originalBinding !== item.binding || key(String(r.context?.workspace)) !== key(context.workspace) ||
          r.context?.workspaceId !== context.workspaceId || r.context?.osSid !== context.osSid ||
          h.contractVersion !== 4 || h.attemptId !== item.attemptId || key(wireRoot) !== key(root) ||
          e?.operation !== h.operation ||
          !payload.equals(Buffer.from(item.original))) fail("UNKNOWN_UNRESOLVABLE");
      assertFilesystemOrigin(item);
      const target = h.destination ?? h.path, parentPath = win32.dirname(target);
      const proof = maintenanceProof;
      const rootProof = proof.directory(wireRoot), parent = proof.directory(parentPath);
      if (rootProof.fileId !== h.rootFileId || rootProof.volumeId !== h.rootVolumeId ||
          parent.fileId !== (h.destinationDirectoryFileId ?? h.directoryFileId) ||
          parent.volumeId !== (h.destinationDirectoryVolumeId ?? h.directoryVolumeId) ||
          canonical(rootProof) !== canonical(e.root) || canonical(parent) !== canonical(e.parent)) fail("UNKNOWN_UNRESOLVABLE");
      const rename = h.operation === "rename-new" || h.operation === "rename-directory-new";
      const actual = h.operation === "rename-directory-new" ? proof.tree(target) :
        proof.file(target, h.maxBytes ?? h.byteLength);
      if (canonical(actual) !== canonical(e.target)) fail("UNKNOWN_UNRESOLVABLE");
      if (rename) {
        if (actual.fileId !== h.sourceFileId || actual.volumeId !== h.sourceVolumeId ||
            actual.bytes !== h.byteLength || actual.sha256 !== h.sourceSha256 ||
            (h.operation === "rename-directory-new" && (actual as NativePrivateTree).entries !== h.entries) ||
            item.original.length !== 0) fail("UNKNOWN_UNRESOLVABLE");
        const sourceParent = proof.directory(win32.dirname(h.path));
        if (sourceParent.fileId !== h.directoryFileId || sourceParent.volumeId !== h.directoryVolumeId ||
            canonical(sourceParent) !== canonical(e.sourceParent) ||
            canonical(proof.missing(h.path, sourceParent)) !== canonical(e.missing)) fail("UNKNOWN_UNRESOLVABLE");
      } else {
        if (!["write-new", "copy-new"].includes(h.operation) || !item.captures.stdout || !item.captures.status ||
            item.captures.stderr?.length !== 0 || e.originalAck !== sha(item.captures.stdout)) fail("UNKNOWN_UNRESOLVABLE");
        const status = JSON.parse(Buffer.from(item.captures.status).toString("utf8"));
        const {h: ack, payload: output} = mutationHeader(item.captures.stdout);
        if (status.status !== 0 || status.signal !== null || status.errorCode !== undefined ||
            ack.contractVersion !== 4 || ack.operation !== h.operation || ack.state !== "APPLIED" ||
            ack.attemptId !== item.attemptId || ack.path !== h.path || key(ack.root) !== key(wireRoot) ||
            ack.byteLength !== h.byteLength || ack.sha256 !== (h.sha256 ?? h.sourceSha256) ||
            ack.contentFlushed !== true || ack.filesystem !== "NTFS" ||
            canonical(ack.durability) !== canonical({profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1", scope: "PROCESS_CRASH"})) fail("UNKNOWN_UNRESOLVABLE");
        assertWindowsProbe(ack.file, {canonicalPath: target, canonicalRoot: wireRoot});
        assertWindowsProbe(ack.directory, {canonicalPath: parentPath, canonicalRoot: wireRoot});
        for (const p of [ack.file, ack.directory]) if (p.sid !== context.osSid || p.rootFileId !== h.rootFileId ||
            p.rootVolumeId !== h.rootVolumeId || p.volumeId !== h.rootVolumeId) fail("UNKNOWN_UNRESOLVABLE");
        if (ack.directory.fileId !== parent.fileId || ack.directory.volumeId !== parent.volumeId ||
            actual.fileId !== ack.file.fileId || actual.volumeId !== ack.file.volumeId ||
            actual.bytes !== ack.byteLength || actual.sha256 !== ack.sha256 ||
            (h.operation === "write-new" ? !output.equals(Buffer.from(item.original)) ||
              item.original.length !== h.byteLength || sha(item.original) !== h.sha256 : output.length !== 0 || item.original.length !== 0))
          fail("UNKNOWN_UNRESOLVABLE");
        if (h.operation === "copy-new") {
          assertWindowsProbe(ack.sourceDirectory, {canonicalPath: win32.dirname(h.path), canonicalRoot: wireRoot});
          if (ack.sourceDirectory.fileId !== h.directoryFileId || ack.sourceDirectory.volumeId !== h.directoryVolumeId ||
              ack.sourceDirectory.rootFileId !== h.rootFileId || ack.sourceDirectory.rootVolumeId !== h.rootVolumeId ||
              ack.sourceDirectory.sid !== context.osSid) fail("UNKNOWN_UNRESOLVABLE");
        }
      }
      current(); return actual;
    };
    const provePublication = (family: "checkpoint" | "raw-export", item: WindowsRecoveryMaintenanceInspection,
      prior?: WindowsRecoveryMaintenanceInspection): WindowsRecoveryPublicationObservation => {
      const unknown = (): never => fail("UNKNOWN_UNRESOLVABLE");
      const m = JSON.parse(item.metadata);
      if (typeof m.path !== "string" ||
          (m.workspaceId !== undefined && m.workspaceId !== context.workspaceId)) unknown();
      if (family === "raw-export") {
        // The retained raw origin scope authorizes the exact endpoint pair;
        // without it only the legacy inside-workspace predicate applies.
        if (typeof m.stagingPath !== "string") unknown();
        try {
          assertWindowsMaintenanceScope(item.blobs["origin:scope"],
            Object.freeze({family: "raw-export", attemptId: item.attemptId,
              requestSha256: sha(item.metadata), root, paths: Object.freeze([m.path, m.stagingPath])}),
            {workspace: context.workspace, workspaceId: context.workspaceId, osSid: context.osSid},
            {directory: (p: string) => maintenanceProof.directory(p)},
            {root, stateRoot});
        } catch { unknown(); }
        if (item.blobs["origin:scope"] === undefined &&
            !key(m.path).startsWith(key(context.workspace) + "\\")) unknown();
      } else if (!key(m.path).startsWith(key(context.workspace) + "\\")) unknown();
      const blob = (name: string): Buffer => {
        if (!(item.blobs[name] instanceof Uint8Array)) unknown();
        return Buffer.from(item.blobs[name]);
      };
      const frame = (name: string) => {
        const bytes = blob(name);
        if (bytes.length < 4) unknown();
        const n = bytes.readUInt32LE(0);
        if (n < 1 || n > 8192 || bytes.length < n + 4 ||
            ![...bytes.subarray(4, n + 4)].every(b => b >= 32 && b <= 126)) unknown();
        const text = bytes.subarray(4, n + 4).toString("ascii"), header = JSON.parse(text);
        if (JSON.stringify(header) !== text) unknown();
        return {header, payload: bytes.subarray(n + 4)};
      };
      const original = blob("original"), prepare = frame("wire:prepare"), prepared = frame("capture:prepare:stdout"),
        commit = frame("wire:commit-prepared");
      if (original.length !== m.byteLength || sha(original) !== m.sha256 || !prepare.payload.equals(original) ||
          !prepared.payload.equals(original) || commit.payload.length !== 0 || blob("capture:prepare:stderr").length !== 0) unknown();
      const status = JSON.parse(blob("capture:prepare:metadata").toString("utf8"));
      if (status.status !== 0 || status.signal !== null || status.errorCode !== null || status.captureTruncated !== false) unknown();
      const p = prepared.header, f = p.file, d = p.directory;
      for (const [h, operation] of [[prepare.header, "prepare"], [commit.header, "commit-prepared"]]) {
        if (h.contractVersion !== 3 || h.attemptId !== item.attemptId || h.operation !== operation ||
            h.path !== m.path || h.stagingPath !== m.stagingPath || h.rootFileId !== m.root.fileId ||
            h.rootVolumeId !== m.root.volumeId || h.directoryFileId !== m.directory.fileId ||
            h.directoryVolumeId !== m.directory.volumeId || h.byteLength !== m.byteLength) unknown();
      }
      if (p.contractVersion !== 3 || p.operation !== "prepare" || p.state !== "PREPARED" || p.attemptId !== item.attemptId ||
          p.path !== m.path || p.stagingPath !== m.stagingPath || p.root !== root ||
          p.byteLength !== m.byteLength || p.sha256 !== m.sha256 || p.contentFlushed !== true || p.filesystem !== "NTFS" ||
          prepare.header.root !== root || commit.header.root !== root || prepare.header.sha256 !== m.sha256 ||
          commit.header.expectedSha256 !== m.sha256 || commit.header.fileId !== f?.fileId || commit.header.volumeId !== f?.volumeId) unknown();
      assertWindowsProbe(f, {canonicalPath: m.stagingPath, canonicalRoot: root});
      assertWindowsProbe(d, {canonicalPath: m.directory.canonicalPath, canonicalRoot: root});
      if (f.sid !== context.osSid || d.sid !== context.osSid || f.rootFileId !== m.root.fileId ||
          f.rootVolumeId !== m.root.volumeId || d.fileId !== m.directory.fileId || d.volumeId !== m.directory.volumeId) unknown();
      const freshRoot = proveRoot(), parent = dirProof(root, m.directory.canonicalPath);
      if (freshRoot.rootFileId !== m.root.fileId || freshRoot.volumeId !== m.root.volumeId ||
          parent.fileId !== m.directory.fileId || parent.volumeId !== m.directory.volumeId) unknown();
      // Raw K inspection compares the retained native ID below. It never
      // grants first-read source enrollment to an unknown physical file.
      const actual = filesystem().inspectFile(m.path, m.byteLength);
      if (actual.fileId !== f.fileId || actual.volumeId !== f.volumeId ||
          actual.bytes !== m.byteLength || actual.sha256 !== m.sha256) unknown();
      const absent = missing(m.stagingPath, parent);
      if (absent.state !== "ABSENT") unknown();
      let priorNative: NativePrivateFile | null = null;
      if (prior) {
        const pm = JSON.parse(prior.metadata);
        const prepared = prior.blobs["evidence:prepared"];
        if (!prepared || pm.workspaceId !== context.workspaceId || key(pm.logicalPath) !== key(m.logicalPath) ||
            pm.generation !== m.expectedHead?.generation || prior.attemptId !== m.expectedHead?.attemptId ||
            pm.sha256 !== m.expectedHead?.sha256) unknown();
        const pf = JSON.parse(Buffer.from(prepared).toString("utf8")).header.file;
        priorNative = filesystem().inspectFile(pm.path, pm.byteLength);
        if (priorNative.fileId !== pf.fileId || priorNative.volumeId !== pf.volumeId ||
            priorNative.bytes !== pm.byteLength || priorNative.sha256 !== pm.sha256) unknown();
      }
      current();
      return {originalSha256: sha(original), preparedCaptureSha256: sha(blob("capture:prepare:stdout")),
        native: actual, parent, root: freshRoot, staging: absent, prior: priorNative};
    };
    return Object.freeze({
      inspect(family: Parameters<WindowsPrivateMaintenancePort["inspect"]>[0], id?: string) {
        current();
        let result: unknown;
        if (family === "filesystem") { filesystem(); result = id ? persistenceJournal!.inspect(id) : persistenceJournal!.listAttempts(); }
        else if (family === "checkpoint") result = id ? recoveryArchive().inspectAttempt(id) : recoveryArchive().listAttempts();
        else if (family === "raw-export") result = id ? rawExportArchive().inspectAttempt(id) : rawExportArchive().listAttempts();
        else if (family === "transfer") { transferGet(); result = id ? transferJournal!.inspect(id) : transferJournal!.listAttempts(); }
        else fail("MAINTENANCE_FAMILY");
        const currentNative: unknown[] = [];
        if (id && result && typeof result === "object") {
          const item = result as {metadata?: string; wire?: Uint8Array};
          let target: unknown;
          if ((family === "filesystem" || family === "transfer") && item.wire && item.wire.length >= 4) {
            const wire = Buffer.from(item.wire), n = wire.readUInt32LE(0);
            if (n > 0 && n <= 8192 && n + 4 <= wire.length) {
              const h = JSON.parse(wire.subarray(4, n + 4).toString("ascii"));
              target = h.destination ?? h.path;
            }
          } else if (item.metadata) target = JSON.parse(item.metadata).path;
          if (typeof target === "string") {
            const path = validateWindowsPath(target, root).canonical;
            try { currentNative.push({state: "PROVEN", file: filesystem().inspectFile(path, 256 * 1024 * 1024)}); }
            catch { currentNative.push({state: "UNPROVEN", path}); }
          }
        }
        current();
        return {context, root: proveRoot(), workspace: dirProof(root, context.workspace), currentNative, result};
      },
      resolve(family: Parameters<WindowsPrivateMaintenancePort["resolve"]>[0], id: string, fingerprint: string) {
        current();
        if (family === "transfer") {
          transferGet();
          return transferJournal!.investigate({attemptId: id, fingerprint, context}, {
            ...maintenanceProof, read: (path, identity, maxBytes) => filesystem().read(path, identity, maxBytes),
          });
        }
        if (family === "filesystem") {
          filesystem();
          const before = persistenceJournal!.inspect(id);
          if (before.fingerprint !== fingerprint) fail("MAINTENANCE_CONFLICT");
          const {h} = mutationHeader(before.wire), pending = sourceBindings().pendingTransitions();
          // The retained origin is validated against the configured root/state
          // and current workspace BEFORE any K observation runs — never after.
          assertFilesystemOrigin(before);
          const move = pending.moves.find(p => key(h.path) === p.move.from.canonicalPath && key(h.destination ?? "") === p.move.to &&
            key(String(h.sourceFileId)) === p.move.from.fileId && key(String(h.sourceVolumeId)) === p.move.from.volumeId &&
            h.sourceSha256 === p.move.sha256 && h.byteLength === p.move.bytes &&
            h.operation === (p.move.kind === "directory" ? "rename-directory-new" : "rename-new"));
          const creation = ["write-new", "copy-new"].includes(h.operation)
            ? pending.creations.find(p => p.path === key(h.destination ?? h.path)) : undefined;
          // A prior K observation is reused only after fresh scope and source
          // binding verification below. This is an idempotent observation;
          // no original mutation or dispatch authority is replayed.
          const reservation = move?.reservation ?? creation?.reservation;
          if (reservation) {
            const association = sourceBindings().transitionAssociation(reservation);
            if (association) {
              if (association.attemptId !== id || association.wireSha256 !== sha(before.wire)) fail("MAINTENANCE_ASSOCIATION");
            } else {
              // S1 had no pre-dispatch association. Only a unique retained
              // non-APPLIED intent with this exact mutation may complete its
              // pending binding; historical resolved attempts cannot stand in
              // for a newer unresolved attempt.
              const candidates = persistenceJournal!.listAttempts().map(attempt => persistenceJournal!.inspect(attempt))
                .filter(item => {
                  if (item.terminal?.state === "APPLIED") return false;
                  const candidate = mutationHeader(item.wire).h;
                  const fields = ["operation", "path", "destination", "root", "rootFileId", "rootVolumeId",
                    "directoryFileId", "directoryVolumeId", "destinationDirectoryFileId", "destinationDirectoryVolumeId",
                    "sourceFileId", "sourceVolumeId", "sourceSha256", "sha256", "byteLength", "entries"];
                  return fields.every(field => candidate[field] === h[field]);
                });
              const unresolved = candidates.filter(item => item.resolution === null);
              const eligible = unresolved.length > 0 ? unresolved : candidates;
              if (eligible.length !== 1 || eligible[0].attemptId !== id) fail("MAINTENANCE_ASSOCIATION_AMBIGUOUS");
            }
          }
          if (admissionDirectories) fail("MAINTENANCE_REENTRANT");
          admissionDirectories = new Map(move?.identities.filter(v => v.kind === "directory").map(v => [key(v.canonicalPath), v]) ?? []);
          try {
            const result = before.resolution === null
              ? persistenceJournal!.investigate({attemptId: id, fingerprint, context},
                  {...maintenanceProof, assertCurrent() {
                    // The retained scope is re-validated INSIDE the append
                    // CAS — a replaced root/workspace between observations
                    // fails closed instead of resolving against stale proof.
                    current(); assertFilesystemOrigin(before); current();
                  }}) : before;
            if (move || creation) {
              const link = {attemptId: id, fingerprint, resolutionSha256: sha(result.resolution!)};
              const actual = verifyBindingObservation(result);
              const check = () => {
                current();
                const retained = persistenceJournal!.inspect(id);
                if (retained.fingerprint !== fingerprint || retained.resolution !== result.resolution) fail("MAINTENANCE_CONFLICT");
                verifyBindingObservation(retained);
              };
              const identity: WindowsSourceIdentity = {kind: move?.move.kind ?? "file",
                canonicalPath: actual.path, fileId: actual.fileId, volumeId: actual.volumeId};
              if (move) sourceBindings().completeMove(move.reservation, identity, canonical(link), check);
              else sourceBindings().enrollCreated(identity, proveRetained, creation!.reservation, {link, assertCurrent: check});
              if (!sourceBindings().hasInvestigation(link)) fail("MAINTENANCE_READBACK");
            } else if (before.resolution !== null && ["write-new", "copy-new", "rename-new", "rename-directory-new"].includes(h.operation)) {
              const actual = verifyBindingObservation(result);
              sourceBindings().assert({kind: h.operation === "rename-directory-new" ? "directory" : "file",
                canonicalPath: actual.path, fileId: actual.fileId, volumeId: actual.volumeId});
            }
            current(); return result;
          } finally { admissionDirectories = undefined; }
        }
        if (family === "checkpoint") return recoveryArchive().observeApplied(id, fingerprint, context,
          (item, prior) => provePublication("checkpoint", item, prior), current);
        if (family === "raw-export") return rawExportArchive().observeApplied(id, fingerprint, context,
          item => provePublication("raw-export", item), current);
        fail("MAINTENANCE_FAMILY");
      },
    });
  };

  const close = (): void => {
    if (closed) return;
    if (backupInFlight !== 0) fail("BACKUP_IN_FLIGHT");
    closing = true;
    const failures: unknown[] = [];
    for (const owner of [...owners].reverse()) {
      try { owner.close(); owners.delete(owner); } catch (e) { failures.push(e); }
    }
    closing = false;
    if (failures.length > 0) {
      unavailable = new AggregateError(failures, "product-native close failed");
      throw unavailable;
    }
    closed = true;
  };

  return Object.freeze({
    assertRoot(): void {
      if (closed) fail("CLOSED");
      fence();
      proveRoot();
    },
    bindWorkspace,
    admitSelectedSource,
    admitSelectedFile,
    inspectSelectedFile,
    authorizeExternalCapability,
    authorizeReadOnlyRescue,
    privateFilesystem,
    privateFileV3Port,
    crashRecoveryPort,
    nativeBackup,
    nativeTransferIo,
    nativeTransfer,
    maintenancePort,
    close,
  });
}
