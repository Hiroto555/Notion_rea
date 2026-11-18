import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CollaborationError, wellFormed } from "../../collaboration/runtime/contract";
import { canonical } from "../../collaboration/runtime/canonical";
import { preflightExistingJournal } from "../../sync/journal-preflight";
import { synchronousPrivatePlatform, type PrivatePlatform } from "../../sync/private-platform";
import { SyncSqliteGuard } from "../../sync/sqlite-guard";
import { SqliteConnectionOwner, closeSqlitePlatform } from "../../sync/sqlite-connection-owner";
import { asciiCaseFold, validateWindowsPath } from "./path-policy";
import {
  WINDOWS_BACKUP_ARTIFACT_MAX_BYTES,
  WINDOWS_BACKUP_ARTIFACT_MAX_WIRE_BYTES,
  WINDOWS_BACKUP_ARTIFACT_MAX_CAPTURE_BYTES,
} from "./backup-artifact";

export const WINDOWS_BACKUP_ARTIFACT_JOURNAL_DATABASE = "windows-backup-artifact-v1.sqlite";
/** Logical lifecycle capacity. A 256 MiB artifact reserves
 * 3*B + 6*MAX_WIRE + 256 KiB ~= 2.25 GiB; the separate cap is 3 GiB.
 * SQLite page/rollback-journal physical overhead is separate (bounded by the
 * platform sidecar checks and the archive-only max_page_count pragma below);
 * this constant is a logical reservation ceiling, not a disk guarantee. */
export const WINDOWS_BACKUP_ARTIFACT_JOURNAL_MAX_BYTES = 3 * 1024 * 1024 * 1024;
export const WINDOWS_BACKUP_ARTIFACT_JOURNAL_MAX_ATTEMPTS = 64;
export const WINDOWS_BACKUP_ARTIFACT_JOURNAL_MAX_BLOBS_PER_ATTEMPT = 12;
export const WINDOWS_BACKUP_ARTIFACT_METADATA_MAX_BYTES = 48 * 1024;
const ROLE = "windows-backup-artifact-v1";
const VERSION = 1;
const METADATA_OVERHEAD = 256 * 1024;
/** Archive-only physical bound. Sidecars (rollback
 * journal) are additional bounded overhead under the platform proofs. */
export const WINDOWS_BACKUP_ARTIFACT_MAX_DATABASE_BYTES = 4 * 1024 * 1024 * 1024;
export const WINDOWS_BACKUP_ARTIFACT_MAX_SIDECAR_BYTES = 8 * 1024 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const ATTEMPT_ID = /^[0-9a-f]{32}$/;

function fail(code: string): never {
  throw new CollaborationError(`WINDOWS_BACKUP_ARTIFACT_JOURNAL_${code}`);
}

const sha = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Lexical separation only — identical syntax rules as the recovery archive,
 * never filesystem evidence. */
type LexicalPath = Readonly<{ separator: "\\" | "/"; folded: string }>;
function lexicalPath(value: unknown): LexicalPath | null {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !wellFormed(value))
    return null;
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    let canonicalPath: string;
    try {
      canonicalPath = validateWindowsPath(value, `${value[0].toUpperCase()}:\\`).canonical;
    } catch {
      return null;
    }
    return { separator: "\\", folded: asciiCaseFold(canonicalPath) };
  }
  if (value.startsWith("/")) {
    let trimmed = value.replace(/\/+$/, "");
    if (trimmed === "") trimmed = "/";
    if (trimmed === "/") return { separator: "/", folded: "/" };
    const segments = trimmed.split("/");
    for (let index = 1; index < segments.length; index++) {
      const segment = segments[index];
      if (segment === "" || segment === "." || segment === "..") return null;
    }
    return { separator: "/", folded: trimmed };
  }
  return null;
}

function overlapsLexical(a: LexicalPath, b: LexicalPath): boolean {
  if (a.separator !== b.separator) return false;
  const contains = (parent: string, candidate: string): boolean =>
    candidate === parent ||
    (parent.endsWith(a.separator)
      ? candidate.startsWith(parent)
      : candidate.startsWith(parent + a.separator));
  return contains(a.folded, b.folded) || contains(b.folded, a.folded);
}

/** Wraps the injected platform to prove kind and retain close causes that the
 * guard would otherwise drop after a failed open. */
class ArchivePlatformProxy implements PrivatePlatform {
  readonly kind = "windows" as const;
  boundDirectory: string | undefined;
  readonly closeFailures: unknown[] = [];
  private closed = false;
  readonly withHotJournalSnapshot?: PrivatePlatform["withHotJournalSnapshot"];

  constructor(
    private readonly inner: PrivatePlatform,
    private readonly roots: readonly LexicalPath[],
  ) {
    if (inner.withHotJournalSnapshot !== undefined)
      this.withHotJournalSnapshot = inner.withHotJournalSnapshot.bind(inner);
  }

  bind(directory: string): string {
    const bound = this.inner.bind(directory);
    const lex = lexicalPath(bound);
    if (lex === null) fail("PLATFORM");
    for (const root of this.roots)
      if (overlapsLexical(lex, root)) fail("FORBIDDEN_ROOT");
    this.boundDirectory = bound;
    return bound;
  }
  assertRoot(): void { this.inner.assertRoot(); }
  assertFile(path: string): void { this.inner.assertFile(path); }
  assertSidecars(path: string): void { this.inner.assertSidecars(path); }
  createExclusive(path: string): void { this.inner.createExclusive(path); }
  assertEmptyFile(path: string): void { this.inner.assertEmptyFile(path); }
  close(): void {
    if (this.closed) return;
    try { this.inner.close(); this.closed = true; }
    catch (error) { this.closeFailures.push(error); throw error; }
  }
}

export type BackupArtifactBlobKind =
  | "original"
  | "wire:prepare"
  | "wire:commit-prepared"
  | "capture:prepare:stdout"
  | "capture:prepare:stderr"
  | "capture:commit-prepared:stdout"
  | "capture:commit-prepared:stderr"
  | "evidence:prepared"
  | "evidence:callback";

const BLOB_KINDS: ReadonlySet<string> = new Set<BackupArtifactBlobKind>([
  "original",
  "wire:prepare",
  "wire:commit-prepared",
  "capture:prepare:stdout",
  "capture:prepare:stderr",
  "capture:commit-prepared:stdout",
  "capture:commit-prepared:stderr",
  "evidence:prepared",
  "evidence:callback",
]);

/** Per-kind immutable bounds: the original is the artifact, each wire frame
 * carries a full payload, each captured pipe is bounded by the wire maximum,
 * and evidence JSON stays small. */
const BLOB_BOUNDS: Readonly<Record<BackupArtifactBlobKind, number>> = {
  "original": WINDOWS_BACKUP_ARTIFACT_MAX_BYTES,
  "wire:prepare": WINDOWS_BACKUP_ARTIFACT_MAX_WIRE_BYTES,
  "wire:commit-prepared": WINDOWS_BACKUP_ARTIFACT_MAX_WIRE_BYTES,
  "capture:prepare:stdout": WINDOWS_BACKUP_ARTIFACT_MAX_CAPTURE_BYTES,
  "capture:prepare:stderr": WINDOWS_BACKUP_ARTIFACT_MAX_CAPTURE_BYTES,
  "capture:commit-prepared:stdout": WINDOWS_BACKUP_ARTIFACT_MAX_CAPTURE_BYTES,
  "capture:commit-prepared:stderr": WINDOWS_BACKUP_ARTIFACT_MAX_CAPTURE_BYTES,
  "evidence:prepared": WINDOWS_BACKUP_ARTIFACT_METADATA_MAX_BYTES,
  "evidence:callback": WINDOWS_BACKUP_ARTIFACT_METADATA_MAX_BYTES,
};

function requireText(value: unknown, pattern: RegExp, code: string): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}

/**
 * Independent private SQLite authority for the Windows shared-backup artifact
 * export. This is NOT PrivateLedger (its 8 MiB cap cannot hold a 256 MiB raw
 * original) and NOT the recovery archive (no recovery_heads/CAS/read
 * authority): one own BEGIN IMMEDIATE per step over immutable
 * attempt/blob/terminal records only. No delete, purge, retry, resume or
 * reconcile; a reopened journal keeps every retained record but holds no
 * dispatch rights for attempts another instance reserved.
 */
export class WindowsBackupArtifactJournal {
  private readonly guard!: SyncSqliteGuard;
  private readonly platform: ArchivePlatformProxy;
  private readonly owner: SqliteConnectionOwner;
  private readonly path!: string;
  /** Attempts this instance reserved durably — the only dispatch rights. */
  private readonly localAttempts = new Set<string>();
  private closed = false;
  private closing = false;
  private unavailable = false;
  private failure: unknown;

  constructor(
    directory: string,
    platform: PrivatePlatform,
    binding: string,
    forbiddenRoots: readonly string[] = [],
  ) {
    let kind: unknown;
    try {
      kind = typeof platform === "object" && platform !== null ? platform.kind : undefined;
    } catch {
      fail("PLATFORM");
    }
    if (kind !== "windows") fail("PLATFORM");
    const dirLex = lexicalPath(directory);
    if (dirLex === null) fail("DIRECTORY");
    if (typeof binding !== "string" || binding.length === 0 ||
        Buffer.byteLength(binding) > WINDOWS_BACKUP_ARTIFACT_METADATA_MAX_BYTES || !wellFormed(binding))
      fail("BINDING");
    if (!Array.isArray(forbiddenRoots)) fail("FORBIDDEN_ROOT");
    const roots: LexicalPath[] = [];
    for (const root of forbiddenRoots) {
      const lex = lexicalPath(root);
      if (lex === null) fail("FORBIDDEN_ROOT");
      roots.push(lex);
    }
    for (const root of roots)
      if (overlapsLexical(dirLex, root)) fail("FORBIDDEN_ROOT");
    // Reserved before facade wrap/proxy bind/any SQLite open; the closure
    // still releases the raw supplied platform when wrapping itself fails.
    let cleanup: ArchivePlatformProxy | PrivatePlatform | undefined;
    this.owner = new SqliteConnectionOwner(() =>
      closeSqlitePlatform(cleanup ?? platform),
    );
    try {
      const proxy = (cleanup = new ArchivePlatformProxy(
        synchronousPrivatePlatform(platform),
        roots,
      ));
      this.platform = proxy;
      const bound = proxy.bind(directory);
      const path = join(bound, WINDOWS_BACKUP_ARTIFACT_JOURNAL_DATABASE);
      const assertFilesystem = (): void => {
        proxy.assertRoot();
        proxy.assertFile(path);
        proxy.assertSidecars(path);
        this.assertPhysicalBounds(path);
      };
      proxy.createExclusive(path);
      proxy.assertFile(path);
      proxy.assertSidecars(path);
      this.assertPhysicalBounds(path);
      if (lstatSync(path).size > 0)
        preflightExistingJournal(path, assertFilesystem, (candidate) =>
          this.validateExisting(candidate, binding), proxy, this.owner);
      const db = new DatabaseSync(path);
      this.owner.opened(db);
      this.guard = this.owner.guarded(db);
      db.exec(
          "PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;",
        );
        const pageSize = db.prepare("PRAGMA page_size").get() as { page_size: number };
        if (!Number.isSafeInteger(pageSize.page_size) || pageSize.page_size < 512 ||
            pageSize.page_size > 65536) fail("PAGE_SIZE");
        const maximumPages = Math.floor(WINDOWS_BACKUP_ARTIFACT_MAX_DATABASE_BYTES / pageSize.page_size);
        const pageLimit = db.prepare(`PRAGMA max_page_count=${maximumPages}`).get() as { max_page_count: number };
        if (!Number.isSafeInteger(pageLimit.max_page_count) ||
            pageLimit.max_page_count < 1 || pageLimit.max_page_count > maximumPages) fail("CAPACITY");
        this.path = path;
        (this.guard as SyncSqliteGuard).transaction(() => {
          this.assertOwned();
          const schema = db
            .prepare("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
            .all() as { name: string; type: string }[];
          if (schema.length === 0) {
            this.platform.assertEmptyFile(path);
            db.exec(
              "CREATE TABLE artifact_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), role TEXT NOT NULL, version INTEGER NOT NULL, binding TEXT NOT NULL);" +
                "CREATE TABLE artifact_attempts(attempt_id TEXT PRIMARY KEY, target_key TEXT NOT NULL UNIQUE, metadata TEXT NOT NULL, budget INTEGER NOT NULL);" +
                "CREATE TABLE artifact_blobs(attempt_id TEXT NOT NULL, kind TEXT NOT NULL, bytes BLOB NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(attempt_id,kind));" +
                "CREATE TABLE artifact_terminals(attempt_id TEXT PRIMARY KEY, receipt TEXT NOT NULL);" +
                "CREATE TABLE artifact_releases(attempt_id TEXT PRIMARY KEY, released_bytes INTEGER NOT NULL CHECK(released_bytes>=0));",
            );
            db.prepare("INSERT INTO artifact_identity VALUES(1,?,?,?)").run(ROLE, VERSION, binding);
          } else {
            this.validateSchema(db, binding);
          }
          this.assertOwned();
        });
      if (this.path === undefined) fail("PLATFORM");
    } catch (error) {
      // Owned constructor cleanup: never retries an attempted close, never
      // releases the held platform while a handle is unproven.
      this.owner.fail(error);
    }
  }

  private validateSchema(db: DatabaseSync, binding: string): void {
    const schema = db
      .prepare("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all() as { name: string; type: string }[];
    const names = new Set(schema.filter((row) => row.type === "table").map((row) => String(row.name)));
    const expected = [
      "artifact_identity",
      "artifact_attempts",
      "artifact_blobs",
      "artifact_terminals",
      "artifact_releases",
    ];
    if (schema.length !== expected.length || !expected.every((name) => names.has(name)))
      fail("SCHEMA");
    const identity = db.prepare("SELECT * FROM artifact_identity").all() as Record<string, unknown>[];
    if (identity.length !== 1 || identity[0].singleton !== 1 || identity[0].role !== ROLE ||
        identity[0].version !== VERSION || identity[0].binding !== binding)
      fail("BINDING");
  }

  private validateExisting(db: DatabaseSync, binding: string): void {
    this.validateSchema(db, binding);
  }

  private assertPhysicalBounds(path: string): void {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      let size: number;
      try { size = lstatSync(path + suffix).size; }
      catch (error) {
        if (suffix !== "" && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const bound = suffix === "" ? WINDOWS_BACKUP_ARTIFACT_MAX_DATABASE_BYTES : WINDOWS_BACKUP_ARTIFACT_MAX_SIDECAR_BYTES;
      if (!Number.isSafeInteger(size) || size < 0 || size > bound) fail("PHYSICAL_CAPACITY");
    }
  }

  private assertOwned(): void {
    if (this.unavailable) throw this.failure;
    if (this.closing || this.closed) fail("CLOSED");
    this.platform.assertRoot();
    this.platform.assertFile(this.path);
    this.platform.assertSidecars(this.path);
    this.assertPhysicalBounds(this.path);
    this.guard.assertUsable();
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
      if (finished) {
        this.unavailable = true;
        this.failure = error;
        this.localAttempts.clear();
      }
      throw error;
    }
  }

  private storedBytes(row: unknown, expectedSha: string): Uint8Array {
    if (typeof row !== "object" || row === null) fail("STORED");
    const r = row as { bytes?: unknown; sha256?: unknown };
    const bytes = r.bytes;
    if (!(bytes instanceof Uint8Array) || typeof r.sha256 !== "string" ||
        r.sha256 !== expectedSha || sha(bytes) !== expectedSha)
      fail("STORED_HASH");
    return Uint8Array.from(bytes);
  }

  private blobRow(attemptId: string, kind: BackupArtifactBlobKind): Uint8Array | undefined {
    const row = this.guard.db
      .prepare("SELECT bytes,sha256 FROM artifact_blobs WHERE attempt_id=? AND kind=?")
      .get(attemptId, kind) as { bytes: Uint8Array; sha256: string } | undefined;
    if (row === undefined) return undefined;
    return this.storedBytes(row, row.sha256);
  }

  /**
   * Reserve one attempt and persist the immutable original bytes in the same
   * BEGIN IMMEDIATE. The conservative lifecycle budget is
   *   3*B + 6*MAX_WIRE + 256 KiB
   * (original B + prepare payload B + commit payload B + four worst-case
   * stdout/stderr captures including each bounded overshoot allowance + two
   * MAX_WIRE covering that allowance/framing/evidence + metadata). Checked against global
   * and per-attempt caps BEFORE insert; the call returns only after COMMIT and
   * a byte/hash readback. Immutable attempt/target/original/evidence records
   * never change. Only unused virtual capacity of an acknowledged PUBLISHED
   * terminal can be released, using a separate immutable accounting row.
   */
  reserve(request: {
    attemptId: string;
    targetKey: string;
    metadata: Record<string, unknown>;
    original: Uint8Array;
  }): void {
    const attemptId = requireText(request.attemptId, ATTEMPT_ID, "ATTEMPT");
    if (typeof request.targetKey !== "string" || request.targetKey.length === 0 ||
        request.targetKey.length > 200 || !wellFormed(request.targetKey))
      fail("TARGET");
    const metadata = canonical(request.metadata, WINDOWS_BACKUP_ARTIFACT_METADATA_MAX_BYTES);
    if (!(request.original instanceof Uint8Array) ||
        request.original.byteLength > WINDOWS_BACKUP_ARTIFACT_MAX_BYTES)
      fail("ORIGINAL");
    const original = Uint8Array.from(request.original);
    const originalSha = sha(original);
    const declared = original.byteLength;
    const budget =
      3 * declared + 6 * WINDOWS_BACKUP_ARTIFACT_MAX_WIRE_BYTES + METADATA_OVERHEAD;
    if (!Number.isSafeInteger(budget) || budget <= 0 ||
        budget > WINDOWS_BACKUP_ARTIFACT_JOURNAL_MAX_BYTES) fail("BUDGET");
    let parsed: unknown;
    try { parsed = JSON.parse(metadata); } catch { fail("METADATA"); }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail("METADATA");
    const targetPath = lexicalPath((parsed as Record<string, unknown>).path);
    if (targetPath === null || targetPath.separator !== "\\") fail("TARGET");
    this.transact(() => {
      const db = this.guard.db;
      // A parent-directory reincarnation must not evade the prior immutable
      // target merely because its native File ID changed.
      const previous = db.prepare("SELECT metadata FROM artifact_attempts").all() as { metadata: string }[];
      if (previous.length > WINDOWS_BACKUP_ARTIFACT_JOURNAL_MAX_ATTEMPTS) fail("STORED");
      for (const row of previous) {
        const prior = JSON.parse(row.metadata) as Record<string, unknown>;
        const oldPath = lexicalPath(prior.path);
        if (oldPath === null || oldPath.separator !== "\\") fail("STORED");
        if (oldPath.folded === targetPath.folded) fail("TARGET_CONSUMED");
      }
      const attempts = db.prepare(
        "SELECT COUNT(*) AS n,COALESCE(SUM(a.budget-COALESCE(r.released_bytes,0)),0) AS budget " +
        "FROM artifact_attempts a LEFT JOIN artifact_releases r ON r.attempt_id=a.attempt_id",
      )
        .get() as { n: number; budget: number };
      const blobs = db.prepare("SELECT COUNT(*) AS rows,COALESCE(SUM(length(bytes)),0) AS bytes FROM artifact_blobs")
        .get() as { rows: number; bytes: number };
      if (!Number.isFinite(attempts.n) || !Number.isFinite(attempts.budget) ||
          !Number.isFinite(blobs.rows) || !Number.isFinite(blobs.bytes) ||
          attempts.n >= WINDOWS_BACKUP_ARTIFACT_JOURNAL_MAX_ATTEMPTS ||
          attempts.budget + budget + METADATA_OVERHEAD > WINDOWS_BACKUP_ARTIFACT_JOURNAL_MAX_BYTES ||
          blobs.bytes + original.byteLength > WINDOWS_BACKUP_ARTIFACT_JOURNAL_MAX_BYTES)
        fail("CAPACITY");
      // A duplicate attempt or target is a deterministic conflict, never a retry.
      db.prepare("INSERT INTO artifact_attempts(attempt_id,target_key,metadata,budget) VALUES(?,?,?,?)")
        .run(attemptId, request.targetKey, metadata, budget);
      db.prepare("INSERT INTO artifact_blobs(attempt_id,kind,bytes,sha256) VALUES(?,?,?,?)")
        .run(attemptId, "original", original, originalSha);
    });
    const readback = this.transact(() => this.blobRow(attemptId, "original"));
    if (readback === undefined || !Buffer.from(readback).equals(original)) fail("READBACK");
    this.localAttempts.add(attemptId);
  }

  /** Insert one immutable wire/capture/evidence blob for an attempt this
   * instance reserved. The primary key makes a second write under the same
   * kind a deterministic conflict; per-kind bounds and per-attempt/global
   * bytes stay within the durable reservation budget. */
  record(attemptId: string, kind: BackupArtifactBlobKind, bytes: Uint8Array): void {
    requireText(attemptId, ATTEMPT_ID, "ATTEMPT");
    if (!BLOB_KINDS.has(kind)) fail("KIND");
    const bound = BLOB_BOUNDS[kind];
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > bound)
      fail("BLOB");
    const copy = Uint8Array.from(bytes);
    const digest = sha(copy);
    this.transact(() => {
      if (!this.localAttempts.has(attemptId)) fail("DISPATCH_RIGHTS");
      const db = this.guard.db;
      if (db.prepare("SELECT 1 FROM artifact_terminals WHERE attempt_id=?").get(attemptId))
        fail("TERMINATED");
      const attempt = db.prepare("SELECT budget FROM artifact_attempts WHERE attempt_id=?").get(attemptId) as
        | { budget: number } | undefined;
      if (attempt === undefined || !Number.isSafeInteger(attempt.budget)) fail("ATTEMPT");
      const stats = db
        .prepare("SELECT COUNT(*) AS rows,COALESCE(SUM(length(bytes)),0) AS bytes FROM artifact_blobs WHERE attempt_id=?")
        .get(attemptId) as { rows: number; bytes: number };
      const globalBytes = db.prepare("SELECT COALESCE(SUM(length(bytes)),0) AS bytes FROM artifact_blobs")
        .get() as { bytes: number };
      if (!Number.isFinite(stats.rows) || !Number.isFinite(stats.bytes) || !Number.isFinite(globalBytes.bytes) ||
          stats.rows >= WINDOWS_BACKUP_ARTIFACT_JOURNAL_MAX_BLOBS_PER_ATTEMPT ||
          stats.bytes + copy.byteLength + METADATA_OVERHEAD > attempt.budget ||
          globalBytes.bytes + copy.byteLength > WINDOWS_BACKUP_ARTIFACT_JOURNAL_MAX_BYTES)
        fail("CAPACITY");
      db.prepare("INSERT INTO artifact_blobs(attempt_id,kind,bytes,sha256) VALUES(?,?,?,?)")
        .run(attemptId, kind, copy, digest);
    });
    const readback = this.transact(() => this.blobRow(attemptId, kind));
    if (readback === undefined || !Buffer.from(readback).equals(copy)) fail("READBACK");
  }

  /** Immutable terminal record. Only valid after the final exact evidence was
   * validated and the raw capture archived by the caller; the receipt text is
   * the caller's canonical JSON. Never updates. */
  recordTerminal(attemptId: string, receipt: string): void {
    requireText(attemptId, ATTEMPT_ID, "ATTEMPT");
    if (typeof receipt !== "string" || receipt.length === 0 || !wellFormed(receipt) ||
        Buffer.byteLength(receipt) > WINDOWS_BACKUP_ARTIFACT_METADATA_MAX_BYTES)
      fail("RECEIPT");
    let parsed: unknown;
    try { parsed = JSON.parse(receipt); } catch { fail("RECEIPT"); }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail("RECEIPT");
    const terminal = parsed as Record<string, unknown>;
    if (terminal.attemptId !== attemptId ||
        !["PUBLISHED", "UNKNOWN", "REJECTED"].includes(String(terminal.outcome))) fail("RECEIPT");
    this.transact(() => {
      if (!this.localAttempts.has(attemptId)) fail("DISPATCH_RIGHTS");
      this.guard.db.prepare("INSERT INTO artifact_terminals(attempt_id,receipt) VALUES(?,?)")
        .run(attemptId, receipt);
    });
    const row = this.transact(
      () => this.guard.db.prepare("SELECT receipt FROM artifact_terminals WHERE attempt_id=?")
        .get(attemptId) as { receipt: string } | undefined,
    );
    if (row === undefined || row.receipt !== receipt) fail("READBACK");
    if (terminal.outcome === "PUBLISHED") {
      // Separate transaction, only after exact terminal COMMIT/readback.
      // Reopened instances have no localAttempt capability and cannot settle
      // another live writer. UNKNOWN/missing acknowledgements retain budget.
      const released = this.transact(() => {
        if (!this.localAttempts.has(attemptId)) fail("DISPATCH_RIGHTS");
        const db = this.guard.db;
        const attempt = db.prepare("SELECT budget FROM artifact_attempts WHERE attempt_id=?")
          .get(attemptId) as { budget: number } | undefined;
        const blobs = db.prepare("SELECT kind,length(bytes) AS size FROM artifact_blobs WHERE attempt_id=?")
          .all(attemptId) as { kind: string; size: number }[];
        if (!attempt || blobs.length !== BLOB_KINDS.size ||
            ![...BLOB_KINDS].every(kind => blobs.some(blob => blob.kind === kind))) fail("INCOMPLETE");
        let retained = METADATA_OVERHEAD;
        for (const blob of blobs) {
          if (!Number.isSafeInteger(blob.size) || blob.size < 0) fail("STORED");
          retained += blob.size;
        }
        const unused = attempt.budget - retained;
        if (!Number.isSafeInteger(unused) || unused < 0) fail("CAPACITY");
        db.prepare("INSERT INTO artifact_releases(attempt_id,released_bytes) VALUES(?,?)")
          .run(attemptId, unused);
        return unused;
      });
      const settled = this.transact(() => this.guard.db
        .prepare("SELECT released_bytes FROM artifact_releases WHERE attempt_id=?")
        .get(attemptId) as { released_bytes: number } | undefined);
      if (settled?.released_bytes !== released) fail("READBACK");
    }
    this.localAttempts.delete(attemptId);
  }

  /** Read back one stored blob with length/hash verification; allowed after
   * reopen since reads carry no dispatch authority. */
  readBlob(attemptId: string, kind: BackupArtifactBlobKind): Uint8Array | undefined {
    requireText(attemptId, ATTEMPT_ID, "ATTEMPT");
    if (!BLOB_KINDS.has(kind)) fail("KIND");
    return this.transact(() => this.blobRow(attemptId, kind));
  }

  readMetadata(attemptId: string): Record<string, unknown> | undefined {
    requireText(attemptId, ATTEMPT_ID, "ATTEMPT");
    return this.transact(() => {
      const row = this.guard.db.prepare("SELECT metadata FROM artifact_attempts WHERE attempt_id=?")
        .get(attemptId) as { metadata: string } | undefined;
      if (row === undefined) return undefined;
      let parsed: unknown;
      try { parsed = JSON.parse(row.metadata); } catch { fail("STORED"); }
      if (canonical(parsed) !== row.metadata) fail("STORED");
      return parsed as Record<string, unknown>;
    });
  }

  terminalReceipt(attemptId: string): string | undefined {
    requireText(attemptId, ATTEMPT_ID, "ATTEMPT");
    return this.transact(() => {
      const row = this.guard.db.prepare("SELECT receipt FROM artifact_terminals WHERE attempt_id=?")
        .get(attemptId) as { receipt: string } | undefined;
      return row?.receipt;
    });
  }

  /** A reserved-but-not-terminated attempt blocks a new write for the same
   * canonical target path — including after restart — until an explicit
   * future resolution (none in scope). Metadata is canonical JSON, so the
   * path field is an exact substring. Bounded to the attempt cap. */
  pendingAttempts(path: string): readonly string[] {
    if (typeof path !== "string" || !wellFormed(path)) fail("TARGET");
    const folded = asciiCaseFold(path);
    return this.transact(() => {
      const db = this.guard.db;
      const rows = db
        .prepare(
          "SELECT a.attempt_id,a.metadata,t.receipt FROM artifact_attempts a LEFT JOIN artifact_terminals t ON t.attempt_id=a.attempt_id",
        )
        .all() as { attempt_id: string; metadata: string; receipt: string | null }[];
      if (rows.length > WINDOWS_BACKUP_ARTIFACT_JOURNAL_MAX_ATTEMPTS) fail("STORED");
      const blocked: string[] = [];
      for (const row of rows) {
        let metadata: unknown;
        try { metadata = JSON.parse(row.metadata); } catch { fail("STORED"); }
        if (canonical(metadata) !== row.metadata) fail("STORED");
        const m = metadata as Record<string, unknown>;
        if (typeof m.path !== "string" || asciiCaseFold(m.path) !== folded) continue;
        if (row.receipt === null) { blocked.push(row.attempt_id); continue; }
        let receipt: unknown;
        try { receipt = JSON.parse(row.receipt); } catch { fail("STORED"); }
        const outcome = (receipt as Record<string, unknown>).outcome;
        if (outcome !== "PUBLISHED") blocked.push(row.attempt_id);
      }
      return blocked;
    });
  }

  /** Only a fully successful close is final; a failed attempt stays owned and
   * an explicit retry may finish the remaining cleanup — never dropped. */
  close(): void {
    if (this.closed) return;
    this.closing = true;
    this.owner.close();
    this.closed = true;
    // Dispatch rights are dropped only after successful owned cleanup.
    this.localAttempts.clear();
  }
}
