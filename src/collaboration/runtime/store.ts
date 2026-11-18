import type { RuntimeStorePlatform } from "../../platform/runtime-store-platform";
import { synchronousRuntimeStorePlatform } from "../../platform/synchronous-port";
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  openSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  pinPrivateRoot,
  assertPrivateRoot,
  type PrivateRootPin,
} from "../../sync/m3-private-root";
import { sqliteHeader } from "../../persistence/sqlite-header";
import {
  SqliteConnectionOwner,
  closeSqlitePlatform,
} from "../../sync/sqlite-connection-owner";
import { canonical } from "./canonical";
import { wellFormed } from "./contract";
import type { StoragePort } from "./storage-port";

export const SHARED_RUNTIME_FILE = "shared-runtime.sqlite";
export const SHARED_RUNTIME_APPLICATION_ID = 0x464c5352;
export const SHARED_RUNTIME_VERSION = 1003;
export const DEFAULT_SHARED_RUNTIME_MAX_ROWS = 10_000;
export const DEFAULT_SHARED_RUNTIME_MAX_BYTES = 64 * 1024 * 1024;

const RECORDS_SCHEMA =
  "CREATE TABLE runtime_records(namespace TEXT NOT NULL,key TEXT NOT NULL,raw TEXT NOT NULL,PRIMARY KEY(namespace,key))";
const BLOBS_SCHEMA =
  "CREATE TABLE runtime_blobs(scope TEXT NOT NULL,hash TEXT NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(scope,hash))";
const SIDECARS = ["-wal", "-shm", "-journal"] as const;
const NAMESPACE_LIMIT = 128;
const KEY_LIMIT = 512;
const SCOPE_LIMIT = 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

export type RuntimeStoreOptions = {
  platformAdapter?: RuntimeStorePlatform;
  maxBytes?: number;
  maxRows?: number;
  /** A wrong semantic role must be rejected before writable SQLite recovery. */
  expectedExistingRole?: "authority" | "client";
  requiredExistingRole?: "authority" | "client";
};

type Options = Readonly<{ maxBytes: number; maxRows: number }>;
type Totals = Readonly<{ rows: number; bytes: number }>;

function fail(code: string): never {
  throw new Error(code);
}

function optionInteger(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    return fail("INVALID_SHARED_RUNTIME_OPTIONS");
  return Number(value);
}

function optionalStat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isSafeFile(info: Stats): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
}

function safeFiles(path: string): Stats | undefined {
  const main = optionalStat(path);
  const sidecars = SIDECARS.map((suffix) => optionalStat(path + suffix));
  for (const entry of [main, ...sidecars])
    if (entry && !isSafeFile(entry)) fail("UNSAFE_SHARED_RUNTIME_PATH");
  if (!main && sidecars.some((entry) => entry !== undefined))
    fail("ORPHAN_SHARED_RUNTIME_SIDECAR");
  return main;
}

function textBytes(value: string): number {
  return encoder.encode(value).length;
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++)
    if (left[index] !== right[index]) return false;
  return true;
}

function boundedString(value: unknown, limit: number, code: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > limit ||
    value.includes("\u0000") ||
    !wellFormed(value)
  )
    fail(code);
  return value;
}

function validateNamespace(value: unknown): string {
  return boundedString(
    value,
    NAMESPACE_LIMIT,
    "INVALID_SHARED_RUNTIME_NAMESPACE",
  );
}

function validateKey(value: unknown): string {
  return boundedString(value, KEY_LIMIT, "INVALID_SHARED_RUNTIME_KEY");
}

function validateScope(value: unknown): string {
  return boundedString(value, SCOPE_LIMIT, "INVALID_SHARED_RUNTIME_SCOPE");
}

function validateHash(value: unknown): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value))
    fail("INVALID_SHARED_RUNTIME_HASH");
  return value;
}

function decodeRaw(raw: unknown, maxBytes: number): unknown {
  if (typeof raw !== "string" || textBytes(raw) > maxBytes)
    fail("CORRUPT_SHARED_RUNTIME");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("CORRUPT_SHARED_RUNTIME");
  }
  let roundtrip: string;
  try {
    roundtrip = canonical(parsed, maxBytes);
  } catch {
    fail("CORRUPT_SHARED_RUNTIME");
  }
  if (roundtrip !== raw) fail("CORRUPT_SHARED_RUNTIME");
  return parsed;
}

function pragmaInteger(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as
    Record<string, unknown> | undefined;
  const value = row?.[name];
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)
    fail("CORRUPT_SHARED_RUNTIME");
  return number;
}

export class RuntimeStore implements StoragePort {
  readonly path: string;
  readonly db: DatabaseSync;
  private readonly maxBytes: number;
  private readonly maxRows: number;
  private closed = false;
  private closing = false;
  private readonly owner: SqliteConnectionOwner;
  private readonly rootPin: PrivateRootPin | null;
  private readonly platformAdapter: RuntimeStorePlatform | null;
  private filePin: Stats | undefined;
  private poisoned: Error | undefined;

  constructor(directory: string, options: RuntimeStoreOptions = {}) {
    if (typeof directory !== "string" || directory.length === 0)
      fail("INVALID_SHARED_RUNTIME_DIRECTORY");
    for (const role of [options.expectedExistingRole, options.requiredExistingRole])
      if (role !== undefined && role !== "authority" && role !== "client") fail("INVALID_SHARED_RUNTIME_OPTIONS");
    const limits: Options = {
      maxBytes: optionInteger(
        options.maxBytes,
        DEFAULT_SHARED_RUNTIME_MAX_BYTES,
      ),
      maxRows: optionInteger(options.maxRows, DEFAULT_SHARED_RUNTIME_MAX_ROWS),
    };
    this.maxBytes = limits.maxBytes;
    this.maxRows = limits.maxRows;
    this.platformAdapter = options.platformAdapter ?? null;
    // Reserved before native bind or any SQLite open; the closure reads the
    // field at cleanup time so a failed facade wrap still closes the raw
    // supplied adapter.
    this.owner = new SqliteConnectionOwner(() =>
      closeSqlitePlatform(this.platformAdapter),
    );
    try {
    if (this.platformAdapter) {
      if (process.platform !== "win32") fail("NATIVE_PLATFORM_MISMATCH");
      this.platformAdapter = synchronousRuntimeStorePlatform(this.platformAdapter);
      directory = this.platformAdapter.bind(directory);
      this.rootPin = null;
    } else {
      if (process.platform === "win32")
        fail("WINDOWS_PRIVATE_ADAPTER_REQUIRED");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (lstatSync(directory).isSymbolicLink())
        fail("UNSAFE_SHARED_RUNTIME_PATH");
      directory = realpathSync(directory);
      this.rootPin = pinPrivateRoot(directory);
    }
    this.path = join(directory, SHARED_RUNTIME_FILE);

    const original = safeFiles(this.path);
    const existed = original !== undefined;
    if (existed) this.platformAdapter?.assertDatabase(this.path);
    if (existed) {
      const header = sqliteHeader(this.path);
      if (
        !header ||
        header.version !== SHARED_RUNTIME_VERSION ||
        header.applicationId !== SHARED_RUNTIME_APPLICATION_ID
      )
        fail("NOT_SHARED_RUNTIME_FORMAT");
      const preflight = (path: string, readOnly: boolean): void => {
        const probe = new DatabaseSync(path, {readOnly});
        let failed = false;
        let failure: unknown;
        try {
          this.owner.opened(probe);
          probe.exec(
          "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000",
        );
        this.validate(probe);
        const row = probe.prepare("SELECT raw FROM runtime_records WHERE namespace='meta' AND key='role'").get();
        const role = row === undefined ? null : JSON.parse(String(row.raw));
        if ((options.requiredExistingRole !== undefined && role !== options.requiredExistingRole) ||
            (options.expectedExistingRole !== undefined && role !== null && role !== options.expectedExistingRole)) fail("WRONG_STORE_ROLE");
        } catch (error) {
          failed = true;
          failure = error;
          throw error;
        } finally {
          this.owner.closeConnection(probe, failed ? {error: failure} : undefined);
        }
      };
      try {preflight(this.path, true);}
      catch (error) {
        const snapshot = this.platformAdapter?.withHotJournalSnapshot;
        if ((error as {errcode?: number}).errcode !== 776 || !snapshot) throw error;
        this.platformAdapter!.assertRoot(); this.platformAdapter!.assertDatabase(this.path);
        let active = true, calls = 0, callbackFailure: unknown;
        try {
          snapshot.call(this.platformAdapter, this.path, snapshotPath => {
            calls++;
            if (!active || calls !== 1 || typeof snapshotPath !== "string" || !snapshotPath || snapshotPath === this.path)
              throw new Error("UNKNOWN: invalid RuntimeStore snapshot callback");
            try {preflight(snapshotPath, false);}
            catch (cause) {callbackFailure = cause; throw cause;}
          });
        } catch (cause) {
          if (callbackFailure !== undefined && cause !== callbackFailure)
            throw new AggregateError([callbackFailure, cause], "UNKNOWN: snapshot validation and native proof failed");
          throw cause;
        } finally {active = false;}
        if (callbackFailure !== undefined) throw callbackFailure;
        if (calls !== 1) throw new Error("UNKNOWN: RuntimeStore snapshot did not validate");
        this.platformAdapter!.assertRoot(); this.platformAdapter!.assertDatabase(this.path);
      }
    }

    if (!this.platformAdapter) mkdirSync(directory, { recursive: true });
    if (!existed) {
      if (this.platformAdapter) {
        if (typeof this.platformAdapter.createExclusiveDurably !== "function" ||
            typeof this.platformAdapter.assertEmptyFile !== "function")
          fail("WINDOWS_NATIVE_CREATE_REQUIRED");
        this.platformAdapter.createExclusiveDurably(this.path);
        this.platformAdapter.assertEmptyFile(this.path);
        this.platformAdapter.assertDatabase(this.path);
      } else {
        const descriptor = openSync(this.path, "wx", 0o600);
        closeSync(descriptor);
      }
    }
    const pinned = safeFiles(this.path);
    if (
      !pinned ||
      (original !== undefined &&
        (original.dev !== pinned.dev || original.ino !== pinned.ino))
    )
      fail("SHARED_RUNTIME_PATH_CHANGED");

    this.filePin = pinned;
    const db = new DatabaseSync(this.path);
    this.owner.opened(db);
    this.db = db;
    try {
      const opened = safeFiles(this.path);
      if (!opened || opened.dev !== pinned.dev || opened.ino !== pinned.ino)
        fail("SHARED_RUNTIME_PATH_CHANGED");

      db.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000");
      if (!existed) {
        this.transaction(() => {
          db.exec(RECORDS_SCHEMA);
          db.exec(BLOBS_SCHEMA);
          db.exec(
            `PRAGMA application_id=${SHARED_RUNTIME_APPLICATION_ID}; PRAGMA user_version=${SHARED_RUNTIME_VERSION}`,
          );
        });
      }
      this.validate(db);
      if (existed) {
        const row = db.prepare("SELECT raw FROM runtime_records WHERE namespace='meta' AND key='role'").get();
        const role = row === undefined ? null : JSON.parse(String(row.raw));
        if ((options.requiredExistingRole !== undefined && role !== options.requiredExistingRole) ||
            (options.expectedExistingRole !== undefined && role !== null && role !== options.expectedExistingRole)) fail("WRONG_STORE_ROLE");
      }
      db.exec("PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE");
      if (!existed) this.syncDirectory(directory);
    } catch (error) {
      this.owner.closeConnection(db, {error});
    }
    } catch (error) {
      this.owner.fail(error);
    }
  }

  private syncDirectory(directory: string): void {
    if (this.platformAdapter) {
      this.platformAdapter.syncCreatedDatabase(this.path);
      return;
    }
    const descriptor = openSync(directory, "r");
    let failure: unknown;
    try {
      fsyncSync(descriptor);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        closeSync(descriptor);
      } catch (closeError) {
        if (failure !== undefined)
          throw new AggregateError(
            [failure, closeError],
            "UNKNOWN: directory fsync and close failed",
          );
        throw closeError;
      }
    }
  }

  private assertUsable(): void {
    if (this.closed) fail("SHARED_RUNTIME_CLOSED");
    if (this.closing) fail("SHARED_RUNTIME_CLOSING");
    if (this.poisoned) throw this.poisoned;
    if (this.platformAdapter) {
      this.platformAdapter.assertRoot();
      this.platformAdapter.assertDatabase(this.path);
    } else if (this.rootPin) assertPrivateRoot(this.rootPin);
    const file = safeFiles(this.path);
    if (
      this.filePin &&
      (!file ||
        file.dev !== this.filePin.dev ||
        file.ino !== this.filePin.ino ||
        (this.rootPin &&
          (file.uid !== this.rootPin.uid || (file.mode & 0o077) !== 0)))
    )
      fail("SHARED_RUNTIME_PATH_CHANGED");
    if (this.db.isOpen !== true) fail("SHARED_RUNTIME_CLOSED");
  }

  private assertTransaction(): void {
    this.assertUsable();
    if (typeof this.db.isTransaction !== "boolean")
      this.unknown(
        [new Error("transaction state unavailable")],
        "state unknown",
      );
    if (!this.db.isTransaction) fail("SHARED_RUNTIME_TRANSACTION_REQUIRED");
  }

  private unknown(errors: unknown[], detail: string): never {
    const failure = new AggregateError(
      errors,
      `UNKNOWN: ${detail}; close and reopen required`,
    );
    this.poisoned = failure;
    throw failure;
  }

  private validate(db: DatabaseSync): void {
    if (
      pragmaInteger(db, "application_id") !== SHARED_RUNTIME_APPLICATION_ID ||
      pragmaInteger(db, "user_version") !== SHARED_RUNTIME_VERSION
    )
      fail("NOT_SHARED_RUNTIME_FORMAT");

    const tables = db
      .prepare("SELECT name,sql FROM sqlite_master WHERE type='table'")
      .all() as Record<string, unknown>[];
    const expected = new Map<string, string>([
      ["runtime_records", RECORDS_SCHEMA],
      ["runtime_blobs", BLOBS_SCHEMA],
    ]);
    if (tables.length !== expected.size) fail("CORRUPT_SHARED_RUNTIME_SCHEMA");
    for (const table of tables) {
      if (
        typeof table.name !== "string" ||
        typeof table.sql !== "string" ||
        expected.get(table.name) !== table.sql
      )
        fail("CORRUPT_SHARED_RUNTIME_SCHEMA");
    }
    const others = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('view','trigger') OR (type='index' AND name NOT LIKE 'sqlite_autoindex_%')",
      )
      .all();
    if (others.length !== 0) fail("CORRUPT_SHARED_RUNTIME_SCHEMA");

    const integrity = db.prepare("PRAGMA integrity_check").all() as Record<
      string,
      unknown
    >[];
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok")
      fail("CORRUPT_SHARED_RUNTIME_SCHEMA");

    const totals = this.readTotals(db);
    if (totals.rows > this.maxRows || totals.bytes > this.maxBytes)
      fail("SHARED_RUNTIME_LIMIT");

    for (const row of db
      .prepare("SELECT namespace,key,raw FROM runtime_records")
      .all() as Record<string, unknown>[]) {
      validateNamespace(row.namespace);
      validateKey(row.key);
      decodeRaw(row.raw, this.maxBytes);
    }
    for (const row of db
      .prepare("SELECT scope,hash,bytes FROM runtime_blobs")
      .all() as Record<string, unknown>[]) {
      validateScope(row.scope);
      validateHash(row.hash);
      this.verifyBlob(row.bytes, String(row.hash));
    }
  }

  private readTotals(db: DatabaseSync): Totals {
    const row = db
      .prepare(
        `SELECT
          (SELECT count(*) FROM runtime_records) + (SELECT count(*) FROM runtime_blobs) AS rows,
          (SELECT coalesce(sum(length(CAST(raw AS BLOB))),0) FROM runtime_records) +
          (SELECT coalesce(sum(length(bytes)),0) FROM runtime_blobs) AS bytes`,
      )
      .get() as Record<string, unknown> | undefined;
    const rows = Number(row?.rows);
    const bytes = Number(row?.bytes);
    if (
      !Number.isSafeInteger(rows) ||
      !Number.isSafeInteger(bytes) ||
      rows < 0 ||
      bytes < 0
    )
      fail("CORRUPT_SHARED_RUNTIME");
    return { rows, bytes };
  }

  private verifyBlob(bytes: unknown, hash: string): Uint8Array {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > this.maxBytes)
      fail("CORRUPT_SHARED_RUNTIME");
    if (sha256Hex(bytes) !== hash) fail("CORRUPT_SHARED_RUNTIME");
    return new Uint8Array(bytes);
  }

  transaction<T>(work: () => T): T {
    this.assertUsable();
    if (typeof this.db.isTransaction !== "boolean")
      this.unknown(
        [new Error("transaction state unavailable")],
        "state unknown",
      );
    if (this.db.isTransaction) return work();

    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw error;
    }
    if (!Reflect.get(this.db, "isTransaction"))
      this.unknown(
        [new Error("BEGIN did not start a transaction")],
        "BEGIN outcome unknown",
      );

    let value: T;
    try {
      value = work();
    } catch (workError) {
      try {
        if (!Reflect.get(this.db, "isTransaction"))
          throw new Error("transaction ended before rollback");
        this.db.exec("ROLLBACK");
        if (this.db.isTransaction !== false)
          throw new Error("ROLLBACK did not end the transaction");
      } catch (cleanupError) {
        this.unknown(
          [workError, cleanupError],
          "operation and ROLLBACK failed",
        );
      }
      throw workError;
    }

    try {
      if (!Reflect.get(this.db, "isTransaction"))
        throw new Error("transaction ended before commit");
      this.db.exec("COMMIT");
      if (this.db.isTransaction !== false)
        throw new Error("COMMIT did not end the transaction");
    } catch (commitError) {
      this.unknown([commitError], "COMMIT outcome unknown");
    }
    if (this.platformAdapter) {
      try { this.assertUsable(); }
      catch (error) { this.unknown([error], "native proof after COMMIT"); }
    }
    return value;
  }

  get(namespace: string, key: string): unknown | null {
    this.assertUsable();
    const ns = validateNamespace(namespace);
    const recordKey = validateKey(key);
    const row = this.db
      .prepare("SELECT raw FROM runtime_records WHERE namespace=? AND key=?")
      .get(ns, recordKey) as Record<string, unknown> | undefined;
    return row ? decodeRaw(row.raw, this.maxBytes) : null;
  }

  all(namespace: string): { key: string; value: unknown }[] {
    this.assertUsable();
    const ns = validateNamespace(namespace);
    const rows = this.db
      .prepare(
        "SELECT key,raw FROM runtime_records WHERE namespace=? ORDER BY key",
      )
      .all(ns) as Record<string, unknown>[];
    return rows.map((row) => ({
      key: validateKey(row.key),
      value: decodeRaw(row.raw, this.maxBytes),
    }));
  }

  set(namespace: string, key: string, value: unknown | null): void {
    this.assertTransaction();
    const ns = validateNamespace(namespace);
    const recordKey = validateKey(key);
    if (value === null) {
      this.db
        .prepare("DELETE FROM runtime_records WHERE namespace=? AND key=?")
        .run(ns, recordKey);
      return;
    }

    const raw = canonical(value, this.maxBytes);
    const bytes = textBytes(raw);
    const previous = this.db
      .prepare(
        "SELECT length(CAST(raw AS BLOB)) AS bytes FROM runtime_records WHERE namespace=? AND key=?",
      )
      .get(ns, recordKey) as Record<string, unknown> | undefined;
    const oldBytes = previous === undefined ? 0 : Number(previous.bytes);
    if (!Number.isSafeInteger(oldBytes) || oldBytes < 0)
      fail("CORRUPT_SHARED_RUNTIME");

    const totals = this.readTotals(this.db);
    const nextRows = totals.rows + (previous === undefined ? 1 : 0);
    const nextBytes = totals.bytes - oldBytes + bytes;
    if (nextRows > this.maxRows || nextBytes > this.maxBytes)
      fail("SHARED_RUNTIME_LIMIT");

    this.db
      .prepare(
        "INSERT INTO runtime_records(namespace,key,raw) VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET raw=excluded.raw",
      )
      .run(ns, recordKey, raw);
  }

  blobGet(scope: string, hash: string): Uint8Array | null {
    this.assertUsable();
    const blobScope = validateScope(scope);
    const blobHash = validateHash(hash);
    const row = this.db
      .prepare("SELECT bytes FROM runtime_blobs WHERE scope=? AND hash=?")
      .get(blobScope, blobHash) as Record<string, unknown> | undefined;
    return row ? this.verifyBlob(row.bytes, blobHash) : null;
  }

  blobPut(scope: string, hash: string, bytes: Uint8Array): void {
    this.assertTransaction();
    const blobScope = validateScope(scope);
    const blobHash = validateHash(hash);
    if (!(bytes instanceof Uint8Array)) fail("INVALID_SHARED_RUNTIME_BLOB");
    if (bytes.byteLength > this.maxBytes) fail("SHARED_RUNTIME_LIMIT");
    if (sha256Hex(bytes) !== blobHash)
      fail("SHARED_RUNTIME_BLOB_HASH_MISMATCH");

    const previous = this.db
      .prepare("SELECT bytes FROM runtime_blobs WHERE scope=? AND hash=?")
      .get(blobScope, blobHash) as Record<string, unknown> | undefined;
    if (previous !== undefined) {
      const stored = this.verifyBlob(previous.bytes, blobHash);
      if (bytesEqual(stored, bytes)) return;
      fail("SHARED_RUNTIME_BLOB_HASH_CONFLICT");
    }

    const totals = this.readTotals(this.db);
    if (
      totals.rows + 1 > this.maxRows ||
      totals.bytes + bytes.byteLength > this.maxBytes
    )
      fail("SHARED_RUNTIME_LIMIT");

    this.db
      .prepare("INSERT INTO runtime_blobs(scope,hash,bytes) VALUES(?,?,?)")
      .run(blobScope, blobHash, bytes);
  }

  blobDelete(scope: string, hash: string): void {
    this.assertTransaction();
    const blobScope = validateScope(scope);
    const blobHash = validateHash(hash);
    this.db
      .prepare("DELETE FROM runtime_blobs WHERE scope=? AND hash=?")
      .run(blobScope, blobHash);
  }

  close(): void {
    if (this.closed) return;
    this.closing = true;
    this.owner.close();
    this.closed = true;
  }
}
