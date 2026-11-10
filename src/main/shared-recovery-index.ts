import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_SHARED_RUNTIME_MAX_BYTES,
  DEFAULT_SHARED_RUNTIME_MAX_ROWS,
  SHARED_RUNTIME_APPLICATION_ID,
  SHARED_RUNTIME_FILE,
  SHARED_RUNTIME_VERSION,
} from "../collaboration/runtime/store";
import {
  DurableQueue,
  type QueueEntry,
} from "../collaboration/runtime/durable-queue";
import { canonical } from "../collaboration/runtime/canonical";
import {
  identifier,
  scopeKey,
  wellFormed,
  type Scope,
} from "../collaboration/runtime/contract";
import { sqliteHeader } from "../persistence/sqlite-header";
import { validateWindowsPath } from "../platform/windows/path-policy";

/**
 * Main-owned local recovery index for previous writer/auth generations.
 *
 * This module is deliberately read-only with respect to writer stores. It
 * never instantiates RuntimeStore (whose constructor can create files and set
 * meta.role) and never re-enqueues, retries, merges or rewrites an intent.
 */

const INDEX_FILE = "shared-recovery-index.sqlite";
const INDEX_APPLICATION_ID = 0x46524349; // "FRCI"
const INDEX_VERSION = 1;
const INDEX_SCHEMA =
  "CREATE TABLE recovery_entries(entry_id TEXT NOT NULL PRIMARY KEY,origin TEXT NOT NULL,org_id TEXT NOT NULL,user_id TEXT NOT NULL,writer_id TEXT NOT NULL,directory TEXT NOT NULL,kind TEXT NOT NULL)";
const INDEX_NAMESPACE_LIMIT = 512;
const MAX_INDEX_ENTRIES = 256;
const MAX_INDEX_BYTES = 1_000_000;
const ORIGIN_LIMIT = 2048;
const USER_LIMIT = 512;
const DIRECTORY_LIMIT = 4096;
const SIDECARS = ["-wal", "-shm", "-journal"] as const;
const RECORDS_SCHEMA =
  "CREATE TABLE runtime_records(namespace TEXT NOT NULL,key TEXT NOT NULL,raw TEXT NOT NULL,PRIMARY KEY(namespace,key))";
const BLOBS_SCHEMA =
  "CREATE TABLE runtime_blobs(scope TEXT NOT NULL,hash TEXT NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(scope,hash))";
const ENTRY_ID_PATTERN = /^rec_[0-9a-f]{64}$/;
const NAMESPACE_LIMIT = 128;
const KEY_LIMIT = 512;
const encoder = new TextEncoder();

export type SharedRecoveryKind = "document" | "resource";

export type SharedRecoveryFilter = Readonly<{
  origin: string;
  orgId: string;
  userId: string;
}>;

export type SharedRecoveryRememberInput = Readonly<{
  origin: string;
  orgId: string;
  userId: string;
  writerId: string;
  directory: string;
  kind: SharedRecoveryKind;
}>;

export type SharedRecoveryStatus = "OK" | "MISSING" | "MALFORMED";

export type SharedRecoveryRawFlags = Readonly<{
  queue: boolean;
  editing: boolean;
  drafts: boolean;
  snapshots: boolean;
  archived: boolean;
  unknown: boolean;
  rejected: boolean;
}>;

export type SharedRecoverySummary = Readonly<{
  entryId: string;
  origin: string;
  orgId: string;
  userId: string;
  writerId: string;
  directory: string;
  kind: SharedRecoveryKind;
  status: SharedRecoveryStatus;
  error: string | null;
  pendingCount: number;
  unknownCount: number;
  rejectedCount: number;
  selectedScope: Scope | null;
  rawFlags: SharedRecoveryRawFlags;
  totals: Readonly<{ rows: number; bytes: number }>;
}>;

export type SharedRecoveryRecord = Readonly<{
  namespace: string;
  key: string;
  raw: string;
  value: unknown;
}>;

export type SharedRecoveryData = Readonly<{
  entryId: string;
  origin: string;
  orgId: string;
  userId: string;
  writerId: string;
  directory: string;
  kind: SharedRecoveryKind;
  role: string | null;
  queue: readonly QueueEntry[];
  records: readonly SharedRecoveryRecord[];
  pendingCount: number;
  unknownCount: number;
  rejectedCount: number;
  selectedScope: Scope | null;
  rawFlags: SharedRecoveryRawFlags;
  totals: Readonly<{ rows: number; bytes: number }>;
}>;

/**
 * Native filesystem proof port. It exists so a Windows build can prove private
 * roots, directories and files with the compiled native helper instead of
 * pretending POSIX uid/mode/chmod checks are meaningful on win32.
 *
 * Injected implementations are contract checks only; they never prove Windows
 * filesystem safety by themselves. On win32 a proof port is mandatory. When it
 * is absent on POSIX the historical uid/mode/chmod behaviour is unchanged.
 */
export type SharedRecoveryFileIdentity = Readonly<{
  fileId: string;
  volumeId: string;
}>;

export type SharedRecoveryFilesystemProof = Readonly<{
  ensureRoot(root: string): void;
  assertRoot(root: string): void;
  assertDirectory(directory: string, root: string): void;
  assertFile(path: string, root: string): void;
  createIndex(path: string, root: string): void;
  identity(path: string, root: string): SharedRecoveryFileIdentity;
}>;

export type SharedRecoveryIndexOptions = Readonly<{
  maxEntries?: number;
  maxMetadataBytes?: number;
  maxStoreRows?: number;
  maxStoreBytes?: number;
  filesystemProof?: SharedRecoveryFilesystemProof;
}>;

const PROOF_METHODS = [
  "ensureRoot",
  "assertRoot",
  "assertDirectory",
  "assertFile",
  "createIndex",
  "identity",
] as const;

function checkedProof(value: unknown): SharedRecoveryFilesystemProof | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("INVALID_RECOVERY_PROOF");
  const input = value as Record<string, unknown>;
  for (const method of PROOF_METHODS)
    if (typeof input[method] !== "function") fail("INVALID_RECOVERY_PROOF");
  return value as SharedRecoveryFilesystemProof;
}

function checkedIdentity(value: unknown): SharedRecoveryFileIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("INVALID_RECOVERY_IDENTITY");
  const record = value as Record<string, unknown>;
  if (
    typeof record.fileId !== "string" ||
    record.fileId.length === 0 ||
    typeof record.volumeId !== "string" ||
    record.volumeId.length === 0
  )
    fail("INVALID_RECOVERY_IDENTITY");
  return Object.freeze({
    fileId: record.fileId,
    volumeId: record.volumeId,
  });
}

function sameIdentity(
  left: SharedRecoveryFileIdentity,
  right: SharedRecoveryFileIdentity,
): boolean {
  return left.fileId === right.fileId && left.volumeId === right.volumeId;
}

export class SharedRecoveryError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "SharedRecoveryError";
  }
}

function fail(code: string): never {
  throw new SharedRecoveryError(code);
}

function optionInteger(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    fail("INVALID_RECOVERY_OPTIONS");
  return Number(value);
}

function bounded(value: unknown, limit: number, code: string): string {
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

function checkedId(value: unknown, code: string): string {
  try {
    return identifier(value);
  } catch {
    return fail(code);
  }
}

function checkedKind(value: unknown): SharedRecoveryKind {
  if (value !== "document" && value !== "resource")
    fail("INVALID_RECOVERY_KIND");
  return value;
}

function checkedFilter(value: unknown): SharedRecoveryFilter {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_RECOVERY_FILTER");
  const input = value as Record<string, unknown>;
  return Object.freeze({
    origin: bounded(input.origin, ORIGIN_LIMIT, "INVALID_RECOVERY_FILTER"),
    orgId: checkedId(input.orgId, "INVALID_RECOVERY_FILTER"),
    userId: bounded(input.userId, USER_LIMIT, "INVALID_RECOVERY_FILTER"),
  });
}

function errorCode(error: unknown): string {
  return error instanceof SharedRecoveryError
    ? error.code
    : "CORRUPT_SHARED_RUNTIME";
}

function pathStats(path: string): Stats | undefined {
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

function safeStoreFiles(path: string): Stats | undefined {
  const main = pathStats(path);
  const sidecars = SIDECARS.map((suffix) => pathStats(path + suffix));
  for (const entry of [main, ...sidecars])
    if (entry && !isSafeFile(entry)) fail("UNSAFE_RECOVERY_STORE_PATH");
  if (!main && sidecars.some((entry) => entry !== undefined))
    fail("ORPHAN_RECOVERY_STORE_SIDECAR");
  return main;
}

function assertPrivateRoot(root: string, create: boolean): string {
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = pathStats(root);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink())
    fail("UNSAFE_RECOVERY_ROOT");
  // The final component must not be a link. Parent links are canonicalized by
  // realpath (macOS /var -> /private/var) and never escape the canonical root.
  const real = realpathSync(root);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    fail("UNSAFE_RECOVERY_ROOT");
  if ((stat.mode & 0o077) !== 0) fail("UNSAFE_RECOVERY_ROOT");
  return real;
}

function safeDirectory(directory: string, rootReal: string): string {
  if (
    typeof directory !== "string" ||
    directory.length === 0 ||
    directory.length > DIRECTORY_LIMIT ||
    directory.includes("\u0000") ||
    !wellFormed(directory)
  )
    fail("INVALID_RECOVERY_DIRECTORY");
  if (!directory.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(directory))
    fail("INVALID_RECOVERY_DIRECTORY");
  const normalized = resolve(directory);
  const components = normalized.split(/[\\/]+/);
  if (components.includes("..")) fail("UNSAFE_RECOVERY_DIRECTORY");
  const stat = pathStats(normalized);
  if (!stat) fail("RECOVERY_STORE_MISSING");
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail("UNSAFE_RECOVERY_DIRECTORY");
  const real = realpathSync(normalized);
  if (real !== rootReal && !real.startsWith(rootReal + sep))
    fail("UNSAFE_RECOVERY_DIRECTORY");
  return real;
}

function entryIdFor(input: {
  origin: string;
  orgId: string;
  userId: string;
  writerId: string;
  directory: string;
  kind: SharedRecoveryKind;
}): string {
  const raw = canonical([
    input.origin,
    input.orgId,
    input.userId,
    input.writerId,
    input.directory,
    input.kind,
  ]);
  return "rec_" + createHash("sha256").update(raw).digest("hex");
}

function decodeRaw(raw: unknown, maxBytes: number): unknown {
  if (typeof raw !== "string" || encoder.encode(raw).length > maxBytes)
    fail("CORRUPT_SHARED_RUNTIME");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("CORRUPT_SHARED_RUNTIME");
  }
  try {
    if (canonical(parsed, maxBytes) !== raw) fail("CORRUPT_SHARED_RUNTIME");
  } catch {
    fail("CORRUPT_SHARED_RUNTIME");
  }
  return parsed;
}

function validateText(
  value: unknown,
  limit: number,
  code: string,
): string {
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

function pragmaInteger(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as
    | Record<string, unknown>
    | undefined;
  const value = row?.[name];
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)
    fail("CORRUPT_SHARED_RUNTIME");
  return number;
}

/**
 * Minimal StoragePort implemented over a read-only SQLite connection. It is
 * only handed to DurableQueue for decoding/validation; every write path fails.
 */
class ReadonlyRuntimeStore {
  readonly db: DatabaseSync;
  readonly path: string;
  private readonly maxBytes: number;
  private readonly maxRows: number;
  private closed = false;

  constructor(
    directory: string,
    rootReal: string,
    limits: { maxBytes: number; maxRows: number },
    proof?: SharedRecoveryFilesystemProof,
    nativePaths = false,
  ) {
    this.maxBytes = limits.maxBytes;
    this.maxRows = limits.maxRows;
    const realDirectory =
      proof && nativePaths
        ? validateWindowsPath(directory, rootReal).canonical
        : safeDirectory(directory, rootReal);
    if (proof) proof.assertDirectory(realDirectory, rootReal);
    this.path = join(realDirectory, SHARED_RUNTIME_FILE);
    const original = safeStoreFiles(this.path);
    if (!original) fail("RECOVERY_STORE_MISSING");
    if (proof) {
      proof.assertFile(this.path, rootReal);
    }
    const originalIdentity = proof
      ? checkedIdentity(proof.identity(this.path, rootReal))
      : undefined;

    let header: ReturnType<typeof sqliteHeader>;
    try {
      header = sqliteHeader(this.path);
    } catch {
      fail("CORRUPT_SHARED_RUNTIME");
    }
    if (
      !header ||
      header.version !== SHARED_RUNTIME_VERSION ||
      header.applicationId !== SHARED_RUNTIME_APPLICATION_ID
    )
      fail("NOT_SHARED_RUNTIME_FORMAT");

    let db: DatabaseSync;
    try {
      db = new DatabaseSync(this.path, { readOnly: true });
    } catch {
      fail("CORRUPT_SHARED_RUNTIME");
    }
    this.db = db;
    try {
      const opened = safeStoreFiles(this.path);
      if (!opened) fail("RECOVERY_STORE_PATH_CHANGED");
      if (proof) {
        proof.assertFile(this.path, rootReal);
        const openedIdentity = checkedIdentity(
          proof.identity(this.path, rootReal),
        );
        if (
          originalIdentity === undefined ||
          !sameIdentity(originalIdentity, openedIdentity)
        )
          fail("RECOVERY_STORE_PATH_CHANGED");
      } else if (
        opened.dev !== original.dev ||
        opened.ino !== original.ino
      )
        fail("RECOVERY_STORE_PATH_CHANGED");
      db.exec(
        "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000",
      );
      this.validate();
    } catch (error) {
      try {
        db.close();
      } catch {
        // Best-effort close; the original failure is what callers need.
      }
      if (error instanceof SharedRecoveryError) throw error;
      fail("CORRUPT_SHARED_RUNTIME");
    }
  }

  private assertOpen(): void {
    if (this.closed || this.db.isOpen !== true)
      fail("RECOVERY_STORE_CLOSED");
  }

  private validate(): void {
    if (
      pragmaInteger(this.db, "application_id") !==
        SHARED_RUNTIME_APPLICATION_ID ||
      pragmaInteger(this.db, "user_version") !== SHARED_RUNTIME_VERSION
    )
      fail("NOT_SHARED_RUNTIME_FORMAT");

    const tables = this.db
      .prepare("SELECT name,sql FROM sqlite_master WHERE type='table'")
      .all() as Record<string, unknown>[];
    const expected = new Map<string, string>([
      ["runtime_records", RECORDS_SCHEMA],
      ["runtime_blobs", BLOBS_SCHEMA],
    ]);
    if (tables.length !== expected.size)
      fail("CORRUPT_SHARED_RUNTIME_SCHEMA");
    for (const table of tables) {
      if (
        typeof table.name !== "string" ||
        typeof table.sql !== "string" ||
        expected.get(table.name) !== table.sql
      )
        fail("CORRUPT_SHARED_RUNTIME_SCHEMA");
    }
    const others = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('view','trigger') OR (type='index' AND name NOT LIKE 'sqlite_autoindex_%')",
      )
      .all();
    if (others.length !== 0) fail("CORRUPT_SHARED_RUNTIME_SCHEMA");

    const integrity = this.db.prepare("PRAGMA integrity_check").all() as Record<
      string,
      unknown
    >[];
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok")
      fail("CORRUPT_SHARED_RUNTIME_SCHEMA");

    const totals = this.totals();
    if (totals.rows > this.maxRows || totals.bytes > this.maxBytes)
      fail("SHARED_RUNTIME_LIMIT");

    for (const row of this.db
      .prepare("SELECT namespace,key,raw FROM runtime_records")
      .all() as Record<string, unknown>[]) {
      validateText(
        row.namespace,
        NAMESPACE_LIMIT,
        "CORRUPT_SHARED_RUNTIME_SCHEMA",
      );
      validateText(row.key, KEY_LIMIT, "CORRUPT_SHARED_RUNTIME_SCHEMA");
      decodeRaw(row.raw, this.maxBytes);
    }
  }

  totals(): { rows: number; bytes: number } {
    this.assertOpen();
    const row = this.db
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

  get(namespace: string, key: string): unknown | null {
    this.assertOpen();
    const ns = validateText(
      namespace,
      NAMESPACE_LIMIT,
      "INVALID_SHARED_RUNTIME_NAMESPACE",
    );
    const recordKey = validateText(
      key,
      KEY_LIMIT,
      "INVALID_SHARED_RUNTIME_KEY",
    );
    const row = this.db
      .prepare("SELECT raw FROM runtime_records WHERE namespace=? AND key=?")
      .get(ns, recordKey) as Record<string, unknown> | undefined;
    return row ? decodeRaw(row.raw, this.maxBytes) : null;
  }

  all(namespace: string): { key: string; value: unknown }[] {
    this.assertOpen();
    const ns = validateText(
      namespace,
      NAMESPACE_LIMIT,
      "INVALID_SHARED_RUNTIME_NAMESPACE",
    );
    const rows = this.db
      .prepare(
        "SELECT key,raw FROM runtime_records WHERE namespace=? ORDER BY key",
      )
      .all(ns) as Record<string, unknown>[];
    return rows.map((row) => ({
      key: validateText(row.key, KEY_LIMIT, "INVALID_SHARED_RUNTIME_KEY"),
      value: decodeRaw(row.raw, this.maxBytes),
    }));
  }

  rawAll(): SharedRecoveryRecord[] {
    this.assertOpen();
    const rows = this.db
      .prepare(
        "SELECT namespace,key,raw FROM runtime_records ORDER BY namespace,key",
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => {
      const namespace = validateText(
        row.namespace,
        NAMESPACE_LIMIT,
        "INVALID_SHARED_RUNTIME_NAMESPACE",
      );
      const key = validateText(row.key, KEY_LIMIT, "INVALID_SHARED_RUNTIME_KEY");
      if (typeof row.raw !== "string") fail("CORRUPT_SHARED_RUNTIME");
      const raw = row.raw;
      return {
        namespace,
        key,
        raw,
        value: decodeRaw(raw, this.maxBytes),
      };
    });
  }

  transaction<T>(_work: () => T): T {
    return fail("RECOVERY_READ_ONLY");
  }

  set(_namespace: string, _key: string, _value: unknown | null): never {
    return fail("RECOVERY_READ_ONLY");
  }

  blobGet(_scope: string, _hash: string): Uint8Array | null {
    return fail("RECOVERY_READ_ONLY");
  }

  blobPut(_scope: string, _hash: string, _bytes: Uint8Array): never {
    return fail("RECOVERY_READ_ONLY");
  }

  blobDelete(_scope: string, _hash: string): never {
    return fail("RECOVERY_READ_ONLY");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

type IndexRow = Readonly<{
  entryId: string;
  origin: string;
  orgId: string;
  userId: string;
  writerId: string;
  directory: string;
  kind: SharedRecoveryKind;
}>;

function checkedIndexRow(row: Record<string, unknown>): IndexRow {
  return Object.freeze({
    entryId: validateText(row.entry_id, INDEX_NAMESPACE_LIMIT, "CORRUPT_RECOVERY_INDEX"),
    origin: bounded(row.origin, ORIGIN_LIMIT, "CORRUPT_RECOVERY_INDEX"),
    orgId: checkedId(row.org_id, "CORRUPT_RECOVERY_INDEX"),
    userId: bounded(row.user_id, USER_LIMIT, "CORRUPT_RECOVERY_INDEX"),
    writerId: checkedId(row.writer_id, "CORRUPT_RECOVERY_INDEX"),
    directory: bounded(row.directory, DIRECTORY_LIMIT, "CORRUPT_RECOVERY_INDEX"),
    kind: checkedKind(row.kind),
  });
}

function rowMatches(row: IndexRow, filter: SharedRecoveryFilter): boolean {
  return (
    row.origin === filter.origin &&
    row.orgId === filter.orgId &&
    row.userId === filter.userId
  );
}

function parseScopeParts(parts: string[], code: string): Scope {
  if (parts.length < 4) fail(code);
  return {
    orgId: checkedId(parts[0], code),
    workspaceId: checkedId(parts[1], code),
    documentId: checkedId(parts[2], code),
    incarnationId: checkedId(parts[3], code),
  };
}

const DOCUMENT_NAMESPACES = new Set([
  "client.queue",
  "client.editing",
  "client.drafts",
  "client.snapshots",
  "client.archived",
]);
const RESOURCE_NAMESPACES = new Set([
  "client.queue",
  "resource-client.archive",
]);
const ARCHIVED_NAMESPACES = new Set([
  "client.archived",
  "resource-client.archive",
]);

type Recovered = Readonly<{
  role: string | null;
  queue: QueueEntry[];
  records: SharedRecoveryRecord[];
  pendingCount: number;
  unknownCount: number;
  rejectedCount: number;
  selectedScope: Scope | null;
  rawFlags: SharedRecoveryRawFlags;
  totals: { rows: number; bytes: number };
}>;

function recoverStore(
  row: IndexRow,
  rootReal: string,
  limits: { maxBytes: number; maxRows: number },
  proof?: SharedRecoveryFilesystemProof,
  nativePaths = false,
): Recovered {
  const reader = new ReadonlyRuntimeStore(
    row.directory,
    rootReal,
    limits,
    proof,
    nativePaths,
  );
  try {
    const role = reader.get("meta", "role");
    if (role !== null && typeof role !== "string")
      fail("WRONG_STORE_ROLE");
    const expectedRole =
      row.kind === "document" ? "client" : "resource-client";
    if (role !== null && role !== expectedRole) fail("WRONG_STORE_ROLE");

    const all = reader.rawAll();
    const namespaces =
      row.kind === "document" ? DOCUMENT_NAMESPACES : RESOURCE_NAMESPACES;

    const scopes = new Map<string, Scope>();
    for (const record of all) {
      if (!namespaces.has(record.namespace)) continue;
      const parts = record.key.split(":");
      const expectedParts =
        record.namespace === "client.queue" ||
        ARCHIVED_NAMESPACES.has(record.namespace)
          ? 6
          : record.namespace === "client.snapshots"
            ? 4
            : 5;
      if (parts.length !== expectedParts) fail("CORRUPT_QUEUE");
      const scope = parseScopeParts(parts, "CORRUPT_QUEUE");
      scopes.set(scopeKey(scope), scope);
    }

    const queue: QueueEntry[] = [];
    for (const scope of scopes.values())
      queue.push(
        ...new DurableQueue(reader, { scope, writerId: row.writerId }).entries(),
      );
    queue.sort((left, right) =>
      left.intent.intentId < right.intent.intentId
        ? -1
        : left.intent.intentId > right.intent.intentId
          ? 1
          : 0,
    );

    const records: SharedRecoveryRecord[] = [];
    const archivedKeys = new Set<string>();
    for (const record of all) {
      if (record.namespace === "meta") {
        records.push(record);
        continue;
      }
      if (!namespaces.has(record.namespace)) continue;
      const parts = record.key.split(":");
      const expectedParts =
        record.namespace === "client.queue" ||
        ARCHIVED_NAMESPACES.has(record.namespace)
          ? 6
          : record.namespace === "client.snapshots"
            ? 4
            : 5;
      if (parts.length !== expectedParts) fail("CORRUPT_QUEUE");
      const scope = parseScopeParts(parts, "CORRUPT_QUEUE");
      const inScope = scopes.has(scopeKey(scope));
      if (!inScope) continue;
      if (
        record.namespace === "client.queue" ||
        ARCHIVED_NAMESPACES.has(record.namespace) ||
        record.namespace === "client.editing"
      ) {
        if (parts[4] !== row.writerId) continue;
        if (ARCHIVED_NAMESPACES.has(record.namespace))
          archivedKeys.add(record.key);
      }
      records.push(record);
    }

    const pending = queue.filter(
      (entry) =>
        entry.state !== "CLIENT_RECEIPT_DURABLE" &&
        !archivedKeys.has(
          `${scopeKey(entry.intent.scope)}:${row.writerId}:${entry.intent.intentId}`,
        ),
    );
    const unknownCount = queue.filter(
      (entry) =>
        entry.state === "UNKNOWN" ||
        entry.attempts.some((attempt) => attempt.state === "UNKNOWN"),
    ).length;
    const rejectedCount = queue.filter(
      (entry) =>
        entry.state === "REJECTED" ||
        entry.attempts.some(
          (attempt) =>
            attempt.state === "REJECTED" ||
            attempt.state === "INVALIDATED",
        ),
    ).length;

    let selectedScope: Scope | null = null;
    for (const record of records)
      if (record.namespace === "client.editing")
        selectedScope = parseScopeParts(
          record.key.split(":"),
          "CORRUPT_QUEUE",
        );
    if (!selectedScope)
      for (const record of records)
        if (record.namespace === "client.snapshots")
          selectedScope = parseScopeParts(
            record.key.split(":"),
            "CORRUPT_QUEUE",
          );
    if (!selectedScope && queue.length) selectedScope = queue[0].intent.scope;
    if (selectedScope) selectedScope = Object.freeze({ ...selectedScope });

    const namespacesPresent = new Set(records.map((r) => r.namespace));
    const rawFlags: SharedRecoveryRawFlags = Object.freeze({
      queue: namespacesPresent.has("client.queue"),
      editing: namespacesPresent.has("client.editing"),
      drafts: namespacesPresent.has("client.drafts"),
      snapshots: namespacesPresent.has("client.snapshots"),
      archived:
        namespacesPresent.has("client.archived") ||
        namespacesPresent.has("resource-client.archive"),
      unknown: unknownCount > 0,
      rejected: rejectedCount > 0,
    });

    return {
      role,
      queue,
      records,
      pendingCount: pending.length,
      unknownCount,
      rejectedCount,
      selectedScope,
      rawFlags,
      totals: reader.totals(),
    };
  } finally {
    reader.close();
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>))
      deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function validateIndexSchema(db: DatabaseSync): void {
  if (
    pragmaIndexInteger(db, "application_id") !== INDEX_APPLICATION_ID ||
    pragmaIndexInteger(db, "user_version") !== INDEX_VERSION
  )
    fail("CORRUPT_RECOVERY_INDEX");
  const tables = db
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='table'")
    .all() as Record<string, unknown>[];
  if (
    tables.length !== 1 ||
    tables[0].name !== "recovery_entries" ||
    tables[0].sql !== INDEX_SCHEMA
  )
    fail("CORRUPT_RECOVERY_INDEX");
  const others = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('view','trigger') OR (type='index' AND name NOT LIKE 'sqlite_autoindex_%')",
    )
    .all();
  if (others.length !== 0) fail("CORRUPT_RECOVERY_INDEX");
}

function pragmaIndexInteger(db: DatabaseSync, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as
    | Record<string, unknown>
    | undefined;
  const value = row?.[name];
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)
    fail("CORRUPT_RECOVERY_INDEX");
  return number;
}

export class SharedRecoveryIndex {
  private readonly maxEntries: number;
  private readonly maxMetadataBytes: number;
  private readonly maxStoreRows: number;
  private readonly maxStoreBytes: number;
  private readonly proof: SharedRecoveryFilesystemProof | undefined;
  private readonly nativeWindows: boolean;

  constructor(
    private readonly root: string,
    options: SharedRecoveryIndexOptions = {},
  ) {
    bounded(root, DIRECTORY_LIMIT, "INVALID_RECOVERY_ROOT");
    if (!root.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(root))
      fail("INVALID_RECOVERY_ROOT");
    this.nativeWindows = process.platform === "win32";
    this.proof = checkedProof(options.filesystemProof);
    if (this.nativeWindows) {
      if (!/^[A-Za-z]:[\\/]/.test(root)) fail("INVALID_RECOVERY_ROOT");
      if (!this.proof) fail("NATIVE_RECOVERY_PROOF_REQUIRED");
    }
    this.maxEntries = optionInteger(options.maxEntries, MAX_INDEX_ENTRIES);
    this.maxMetadataBytes = optionInteger(
      options.maxMetadataBytes,
      MAX_INDEX_BYTES,
    );
    this.maxStoreRows = optionInteger(
      options.maxStoreRows,
      DEFAULT_SHARED_RUNTIME_MAX_ROWS,
    );
    this.maxStoreBytes = optionInteger(
      options.maxStoreBytes,
      DEFAULT_SHARED_RUNTIME_MAX_BYTES,
    );
  }

  private get indexPath(): string {
    if (this.nativeWindows)
      return validateWindowsPath(join(this.root, INDEX_FILE), this.root)
        .canonical;
    return join(resolve(this.root), INDEX_FILE);
  }

  private rootExists(): boolean {
    if (this.nativeWindows) {
      try {
        return existsSync(validateWindowsPath(this.root, this.root).canonical);
      } catch {
        return false;
      }
    }
    return existsSync(resolve(this.root));
  }

  private prepareRoot(create: boolean): string {
    if (!this.proof) return assertPrivateRoot(this.root, create);
    if (create) this.proof.ensureRoot(this.root);
    this.proof.assertRoot(this.root);
    if (this.nativeWindows)
      return validateWindowsPath(this.root, this.root).canonical;
    return realpathSync(resolve(this.root));
  }

  private resolveDirectory(directory: string, rootReal: string): string {
    if (!this.proof) return safeDirectory(directory, rootReal);
    if (!this.nativeWindows) {
      const real = safeDirectory(directory, rootReal);
      this.proof.assertDirectory(real, rootReal);
      return real;
    }
    const canonical = validateWindowsPath(directory, rootReal).canonical;
    this.proof.assertDirectory(canonical, rootReal);
    return canonical;
  }

  private openIndex(create: boolean): DatabaseSync | null {
    const rootReal = this.prepareRoot(create);
    const path = this.indexPath;
    const stat = pathStats(path);
    if (!stat) {
      if (!create) return null;
      return this.createIndexDatabase(path, rootReal);
    }
    if (!isSafeFile(stat)) fail("UNSAFE_RECOVERY_INDEX_PATH");
    let before: SharedRecoveryFileIdentity | undefined;
    if (this.proof) {
      this.proof.assertFile(path, rootReal);
      before = checkedIdentity(this.proof.identity(path, rootReal));
    }
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(path, { readOnly: !create });
    } catch {
      fail("CORRUPT_RECOVERY_INDEX");
    }
    try {
      if (create) db.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000");
      else
        db.exec(
          "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000",
        );
      validateIndexSchema(db);
      if (this.proof) {
        this.proof.assertFile(path, rootReal);
        const after = checkedIdentity(this.proof.identity(path, rootReal));
        if (before === undefined || !sameIdentity(before, after))
          fail("RECOVERY_INDEX_PATH_CHANGED");
      }
      return db;
    } catch (error) {
      try {
        db.close();
      } catch {
        // Preserve the original validation failure.
      }
      throw error;
    }
  }

  private createIndexDatabase(path: string, rootReal: string): DatabaseSync {
    let before: SharedRecoveryFileIdentity | undefined;
    if (this.proof) {
      this.proof.createIndex(path, rootReal);
      this.proof.assertFile(path, rootReal);
      before = checkedIdentity(this.proof.identity(path, rootReal));
    }
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000");
      db.exec(INDEX_SCHEMA);
      db.exec(
        `PRAGMA application_id=${INDEX_APPLICATION_ID}; PRAGMA user_version=${INDEX_VERSION}`,
      );
      db.exec("PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE");
      validateIndexSchema(db);
      if (this.proof) {
        this.proof.assertFile(path, rootReal);
        const after = checkedIdentity(this.proof.identity(path, rootReal));
        if (before === undefined || !sameIdentity(before, after))
          fail("RECOVERY_INDEX_PATH_CHANGED");
      } else {
        chmodSync(path, 0o600);
      }
      return db;
    } catch (error) {
      try {
        db.close();
      } catch {
        // Preserve the original creation failure.
      }
      throw error;
    }
  }

  private readRows(db: DatabaseSync): IndexRow[] {
    const rows = db
      .prepare(
        "SELECT entry_id,origin,org_id,user_id,writer_id,directory,kind FROM recovery_entries ORDER BY entry_id",
      )
      .all() as Record<string, unknown>[];
    if (rows.length > this.maxEntries) fail("RECOVERY_INDEX_LIMIT");
    const parsed = rows.map(checkedIndexRow);
    let bytes = 0;
    for (const row of parsed) {
      bytes += encoder.encode(
        canonical({
          entryId: row.entryId,
          origin: row.origin,
          orgId: row.orgId,
          userId: row.userId,
          writerId: row.writerId,
          directory: row.directory,
          kind: row.kind,
        }),
      ).length;
      if (bytes > this.maxMetadataBytes) fail("RECOVERY_INDEX_LIMIT");
    }
    return parsed;
  }

  remember(input: SharedRecoveryRememberInput): string {
    if (!input || typeof input !== "object" || Array.isArray(input))
      fail("INVALID_RECOVERY_METADATA");
    const origin = bounded(
      input.origin,
      ORIGIN_LIMIT,
      "INVALID_RECOVERY_METADATA",
    );
    const orgId = checkedId(input.orgId, "INVALID_RECOVERY_METADATA");
    const userId = bounded(input.userId, USER_LIMIT, "INVALID_RECOVERY_METADATA");
    const writerId = checkedId(input.writerId, "INVALID_RECOVERY_METADATA");
    const kind = checkedKind(input.kind);

    const rootReal = this.prepareRoot(true);
    const directory = this.resolveDirectory(input.directory, rootReal);
    // Reject unsafe paths/links now, but keep metadata even when the store is
    // (or later becomes) missing/malformed so list/read can surface it.
    safeStoreFiles(join(directory, SHARED_RUNTIME_FILE));
    const indexRow: IndexRow = Object.freeze({
      entryId: entryIdFor({ origin, orgId, userId, writerId, directory, kind }),
      origin,
      orgId,
      userId,
      writerId,
      directory,
      kind,
    });
    if (!ENTRY_ID_PATTERN.test(indexRow.entryId))
      fail("INVALID_RECOVERY_METADATA");

    const db = this.openIndex(true);
    if (!db) fail("RECOVERY_INDEX_UNAVAILABLE");
    try {
      const existing = this.readRows(db);
      const current = existing.find(
        (row) => row.entryId === indexRow.entryId,
      );
      if (!current && existing.length >= this.maxEntries)
        fail("RECOVERY_INDEX_LIMIT");
      let bytes = 0;
      for (const row of existing) {
        if (row.entryId === indexRow.entryId) continue;
        bytes += encoder.encode(
          canonical({
            entryId: row.entryId,
            origin: row.origin,
            orgId: row.orgId,
            userId: row.userId,
            writerId: row.writerId,
            directory: row.directory,
            kind: row.kind,
          }),
        ).length;
      }
      bytes += encoder.encode(
        canonical({
          entryId: indexRow.entryId,
          origin: indexRow.origin,
          orgId: indexRow.orgId,
          userId: indexRow.userId,
          writerId: indexRow.writerId,
          directory: indexRow.directory,
          kind: indexRow.kind,
        }),
      ).length;
      if (bytes > this.maxMetadataBytes) fail("RECOVERY_INDEX_LIMIT");

      db.prepare(
        "INSERT INTO recovery_entries(entry_id,origin,org_id,user_id,writer_id,directory,kind) VALUES(?,?,?,?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET origin=excluded.origin,org_id=excluded.org_id,user_id=excluded.user_id,writer_id=excluded.writer_id,directory=excluded.directory,kind=excluded.kind",
      ).run(
        indexRow.entryId,
        indexRow.origin,
        indexRow.orgId,
        indexRow.userId,
        indexRow.writerId,
        indexRow.directory,
        indexRow.kind,
      );
    } finally {
      db.close();
    }
    return indexRow.entryId;
  }

  list(current: SharedRecoveryFilter): SharedRecoverySummary[] {
    const filter = checkedFilter(current);
    if (!this.rootExists()) return [];
    const rootReal = this.prepareRoot(false);
    const db = this.openIndex(false);
    if (!db) return [];
    let rows: IndexRow[];
    try {
      rows = this.readRows(db);
    } finally {
      db.close();
    }
    const summaries: SharedRecoverySummary[] = [];
    for (const row of rows) {
      if (!rowMatches(row, filter)) continue;
      try {
        const recovered = recoverStore(row, rootReal, {
          maxBytes: this.maxStoreBytes,
          maxRows: this.maxStoreRows,
        }, this.proof, this.nativeWindows);
        summaries.push(
          Object.freeze({
            entryId: row.entryId,
            origin: row.origin,
            orgId: row.orgId,
            userId: row.userId,
            writerId: row.writerId,
            directory: row.directory,
            kind: row.kind,
            status: "OK" as const,
            error: null,
            pendingCount: recovered.pendingCount,
            unknownCount: recovered.unknownCount,
            rejectedCount: recovered.rejectedCount,
            selectedScope: recovered.selectedScope,
            rawFlags: recovered.rawFlags,
            totals: Object.freeze({ ...recovered.totals }),
          }),
        );
      } catch (error) {
        const code = errorCode(error);
        summaries.push(
          Object.freeze({
            entryId: row.entryId,
            origin: row.origin,
            orgId: row.orgId,
            userId: row.userId,
            writerId: row.writerId,
            directory: row.directory,
            kind: row.kind,
            status:
              code === "RECOVERY_STORE_MISSING"
                ? ("MISSING" as const)
                : ("MALFORMED" as const),
            error: code,
            pendingCount: 0,
            unknownCount: 0,
            rejectedCount: 0,
            selectedScope: null,
            rawFlags: Object.freeze({
              queue: false,
              editing: false,
              drafts: false,
              snapshots: false,
              archived: false,
              unknown: false,
              rejected: false,
            }),
            totals: Object.freeze({ rows: 0, bytes: 0 }),
          }),
        );
      }
    }
    return summaries;
  }

  read(
    entryId: string,
    current: SharedRecoveryFilter,
  ): SharedRecoveryData {
    const filter = checkedFilter(current);
    const id = validateText(entryId, INDEX_NAMESPACE_LIMIT, "INVALID_RECOVERY_ENTRY");
    if (!ENTRY_ID_PATTERN.test(id)) fail("INVALID_RECOVERY_ENTRY");
    if (!this.rootExists()) fail("RECOVERY_ENTRY_NOT_FOUND");
    const rootReal = this.prepareRoot(false);
    const db = this.openIndex(false);
    if (!db) fail("RECOVERY_ENTRY_NOT_FOUND");
    let row: IndexRow | undefined;
    try {
      row = this.readRows(db).find((candidate) => candidate.entryId === id);
    } finally {
      db.close();
    }
    if (!row) fail("RECOVERY_ENTRY_NOT_FOUND");
    // A mismatched current user/org must look denied, never reveal metadata.
    if (!rowMatches(row, filter)) fail("RECOVERY_ENTRY_DENIED");

    const recovered = recoverStore(row, rootReal, {
      maxBytes: this.maxStoreBytes,
      maxRows: this.maxStoreRows,
    }, this.proof, this.nativeWindows);
    return deepFreeze({
      entryId: row.entryId,
      origin: row.origin,
      orgId: row.orgId,
      userId: row.userId,
      writerId: row.writerId,
      directory: row.directory,
      kind: row.kind,
      role: recovered.role,
      queue: recovered.queue,
      records: recovered.records,
      pendingCount: recovered.pendingCount,
      unknownCount: recovered.unknownCount,
      rejectedCount: recovered.rejectedCount,
      selectedScope: recovered.selectedScope,
      rawFlags: recovered.rawFlags,
      totals: Object.freeze({ ...recovered.totals }),
    });
  }
}
