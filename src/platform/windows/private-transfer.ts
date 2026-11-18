import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, opendirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import { CollaborationError } from "../../collaboration/runtime/contract";
import { requireCondition, SyncError } from "../../sync/protocol";
import {
  privatePersistencePort,
  type NativePrivateFile,
  type NativePrivateFilesystemPort,
  type NativePrivateIdentity,
  type NativePrivateReceipt,
  type PrivatePersistenceOptions,
} from "../private-persistence";
import {
  createProductPrivatePlatform,
  type ProductPrivateJournalOptions,
} from "../product-private-journals";
import {
  defaultPrivatePlatform,
  synchronousPrivatePlatform,
  type PrivatePlatform,
} from "../../sync/private-platform";
import { preflightExistingJournal } from "../../sync/journal-preflight";
import { SqliteConnectionOwner, closeSqlitePlatform } from "../../sync/sqlite-connection-owner";
import {
  NativePrivatePersistenceError,
  WINDOWS_PRIVATE_HEADER_MAX_BYTES,
  type NativePrivatePersistenceAuthority,
} from "./private-persistence";
import { WINDOWS_PROBE_TIMEOUT_MS } from "./private-root";
import {
  asciiCaseFold,
  assertWindowsProbe,
  validateWindowsPath,
  type WindowsProbeEvidence,
} from "./path-policy";
import type {
  WindowsRuntimeDirectoryIdentity,
  WindowsRuntimeRootIdentity,
} from "./runtime-platform";

/**
 * Native transfer IO: the append primitive the generic K filesystem port does
 * not carry (append-at-EOF is a mutation, never a read/replace). Appending is
 * single-dispatch with the same immutable reserve/capture/terminal archive
 * discipline as the private-persistence port: intent is durable BEFORE the
 * helper runs, raw pipes before parsing, terminal verdict before success.
 * Ambiguity is UNKNOWN — never retried, deleted, or treated as absent.
 */
export type NativeTransferIoPort = Readonly<{
  platform: "win32";
  version: 1;
  synchronous: true;
  append(
    path: string,
    expected: NativePrivateFile,
    bytes: Uint8Array,
    maxBytes: number,
  ): NativePrivateReceipt;
}>;

export type NativeTransferOptions = PrivatePersistenceOptions &
  Readonly<{ nativeTransferIo?: NativeTransferIoPort; privateJournals?: ProductPrivateJournalOptions }>;

export type NativeTransferContext = Readonly<{
  filesystem: NativePrivateFilesystemPort;
  append?: NativeTransferIoPort;
}>;

const context = new AsyncLocalStorage<NativeTransferOptions>();

const HASH = /^[0-9a-f]{64}$/;
const FILE_ID = /^[0-9a-fA-F]{32}$/;
const VOLUME_ID = /^[0-9a-fA-F]{16}$/;

function invalid(cause?: unknown): SyncError {
  const error = new SyncError("native-transfer-port-invalid", 503);
  if (cause !== undefined) error.cause = cause;
  return error;
}

function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function"))
    return false;
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return true;
  }
}

function observe(result: unknown): void {
  try {
    if (types.isPromise(result))
      Promise.prototype.then.call(result, undefined, () => undefined);
  } catch {
    /* Observation failure must never mask the rejection below. */
  }
}

function receiptShape(value: unknown): NativePrivateReceipt {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "native-transfer-port-invalid",
    503,
  );
  const v = value as Record<string, unknown>;
  requireCondition(
    v.profile === "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1" &&
      v.scope === "PROCESS_CRASH",
    "native-transfer-port-invalid",
    503,
  );
  const identity = v.identity as Record<string, unknown> | undefined;
  requireCondition(
    identity !== undefined && identity !== null &&
      typeof identity === "object" &&
      !Array.isArray(identity) &&
      typeof identity.path === "string" &&
      typeof identity.fileId === "string" &&
      FILE_ID.test(identity.fileId) &&
      typeof identity.volumeId === "string" &&
      VOLUME_ID.test(identity.volumeId) &&
      typeof identity.bytes === "number" &&
      Number.isSafeInteger(identity.bytes) &&
      identity.bytes >= 0 &&
      typeof identity.sha256 === "string" &&
      HASH.test(identity.sha256),
    "native-transfer-port-invalid",
    503,
  );
  return Object.freeze({
    profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1",
    scope: "PROCESS_CRASH",
    identity: Object.freeze({
      path: identity.path,
      fileId: identity.fileId,
      volumeId: identity.volumeId,
      bytes: identity.bytes,
      sha256: identity.sha256,
    }),
  });
}

const failedAppendPorts = new WeakSet<object>();
function bindAppend(raw: Record<string, unknown>): NativeTransferIoPort {
  requireCondition(
    raw.platform === "win32" && raw.version === 1 && raw.synchronous === true,
    "native-transfer-port-invalid",
    503,
  );
  let method: unknown;
  try {
    method = raw.append;
  } catch (error) {
    throw invalid(error);
  }
  requireCondition(
    typeof method === "function" &&
      !types.isAsyncFunction(method) &&
      !types.isGeneratorFunction(method),
    "native-transfer-port-invalid",
    503,
  );
  const bound = (method as (...args: never[]) => unknown).bind(
    raw,
  ) as unknown as (
    path: string,
    expected: NativePrivateFile,
    bytes: Uint8Array,
    maxBytes: number,
  ) => unknown;
  return Object.freeze({
    platform: "win32" as const,
    version: 1 as const,
    synchronous: true as const,
    append(path, expected, bytes, maxBytes) {
      requireCondition(!failedAppendPorts.has(raw), "native-transfer-port-unknown", 503);
      let result: unknown;
      try {
        result = bound(path, expected, bytes, maxBytes);
        if (isThenable(result)) {
          observe(result);
          throw invalid();
        }
        return receiptShape(result);
      } catch (error) {
        if (isThenable(error)) observe(error);
        failedAppendPorts.add(raw);
        throw error;
      }
    },
  });
}

/**
 * Scope native-transfer port selection for `work`, including async
 * continuations. `undefined` inherits the ambient context; an explicit options
 * object replaces it for the nested scope and always wins.
 */
export function withNativeTransfer<T>(
  options: NativeTransferOptions | undefined,
  work: () => T,
): T {
  if (options === undefined) return work();
  requireCondition(
    options !== null && typeof options === "object" && !Array.isArray(options),
    "native-transfer-port-invalid",
    503,
  );
  return context.run(options, work);
}

/**
 * Resolve the configured native-transfer context: the K filesystem port plus
 * the optional append port. The K port alone satisfies read/cache operations;
 * append paths require `nativeTransferIo`. A configured append without a
 * filesystem (or vice versa) is malformed — never silently falls back. On a
 * real Windows host an unconfigured caller fails closed.
 */
export function nativeTransferPort(
  options?: NativeTransferOptions,
): NativeTransferContext | undefined {
  const selected = options !== undefined ? options : context.getStore();
  const filesystem = privatePersistencePort(selected);
  if (filesystem === undefined) {
    if (
      selected !== undefined &&
      (selected as { nativeTransferIo?: unknown }).nativeTransferIo !==
        undefined
    )
      throw invalid();
    return undefined;
  }
  const raw =
    selected === undefined
      ? undefined
      : (selected as { nativeTransferIo?: unknown }).nativeTransferIo;
  if (raw === undefined)
    return Object.freeze({ filesystem, append: undefined });
  requireCondition(
    raw !== null && typeof raw === "object" && !Array.isArray(raw),
    "native-transfer-port-invalid",
    503,
  );
  return Object.freeze({
    filesystem,
    append: bindAppend(raw as Record<string, unknown>),
  });
}

/**
 * Resolved append port or a hard refusal. Native append paths have no POSIX
 * substitute: a selected context without `nativeTransferIo` fails closed.
 */
export function requireNativeAppend(
  selected: NativeTransferContext,
): NativeTransferIoPort {
  requireCondition(
    selected.append !== undefined,
    "native-transfer-append-required",
    503,
  );
  return selected.append;
}

export function isNativeRejected(error: unknown): boolean {
  return (
    error instanceof NativePrivatePersistenceError && error.state === "REJECTED"
  );
}

export function isNativeExists(error: unknown): boolean {
  return (
    error instanceof NativePrivatePersistenceError && error.state === "EXISTS"
  );
}

export function isNativeUnknown(error: unknown): boolean {
  return (
    error instanceof NativePrivatePersistenceError && error.state === "UNKNOWN"
  );
}

export function sameNativeIdentity(a: NativePrivateIdentity, b: NativePrivateIdentity): boolean {
  return a.path === b.path && same(a.fileId, b.fileId) && same(a.volumeId, b.volumeId);
}

/** Absence is only a namespace observation, never a native operation verdict. */
export function nativePathPresent(filesystem: NativePrivateFilesystemPort, path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (!nativePathPresent(filesystem, parent)) return false;
    const pin = filesystem.inspectDirectory(parent);
    try { lstatSync(path); return true; }
    catch (again) {
      if ((again as NodeJS.ErrnoException).code !== "ENOENT") throw again;
    }
    requireCondition(sameNativeIdentity(pin, filesystem.inspectDirectory(parent)),
      "native-transfer-path-changed", 409);
    return false;
  }
}

export function nativeOptionalFile(
  filesystem: NativePrivateFilesystemPort, path: string, maxBytes: number,
): NativePrivateFile | undefined {
  if (!nativePathPresent(filesystem, path)) return undefined;
  // REJECTED also includes ACL, identity and size failures: it is NOT ENOENT.
  return filesystem.inspectFile(path, maxBytes);
}

/** Canonical directory proof: inspect existing, optionally create first. */
export function nativeEnsureDirectory(
  filesystem: NativePrivateFilesystemPort,
  path: string,
  create: boolean,
): string {
  if (nativePathPresent(filesystem, path)) return filesystem.inspectDirectory(path).path;
  if (!create) return resolve(path);
  const parent = dirname(path);
  if (!nativePathPresent(filesystem, parent)) nativeEnsureDirectory(filesystem, parent, true);
  const pin = filesystem.inspectDirectory(parent);
  const created = filesystem.createDirectory(path);
  requireCondition(sameNativeIdentity(pin, filesystem.inspectDirectory(parent)) &&
    sameNativeIdentity(created, filesystem.inspectDirectory(path)), "native-transfer-path-changed", 409);
  return created.path;
}

/**
 * Bounded lock across async work: a fresh B `PrivatePlatform` owns
 * `transfer-lock.sqlite` under the proved directory; a distinct versioned
 * lock schema is validated BEFORE any PRAGMA/journal mutation; an exclusive
 * SQLite transaction covers the async work; native directory/file/sidecar
 * assertions run before and after the await; commit/close failures surface.
 */
export async function withNativeTransferLock<T>(
  directory: string,
  work: () => Promise<T> | T,
  privateJournals?: ProductPrivateJournalOptions,
  nativeTransfer?: NativeTransferOptions,
): Promise<T> {
  const LOCK_NAME = "transfer-lock.sqlite";
  // The owner is reserved BEFORE nativeTransferPort validation and the
  // product factory — either may inspect/acquire, and any later failure must
  // still have one ordered cleanup path.
  let ownedPlatform: PrivatePlatform | undefined;
  const owner = new SqliteConnectionOwner(() => closeSqlitePlatform(ownedPlatform));
  let database: DatabaseSync | undefined;
  let inTransaction = false;
  let result!: T;
  try {
    const native = nativeTransferPort(nativeTransfer);
    requireCondition(native !== undefined, "native-transfer-lock-required", 503);
    const raw = createProductPrivatePlatform(directory, LOCK_NAME,
      privateJournals ?? (nativeTransfer ?? context.getStore())?.privateJournals) ??
      defaultPrivatePlatform(process.platform);
    ownedPlatform = raw;
    const platform = synchronousPrivatePlatform(raw);
    ownedPlatform = platform;
    const root = platform.bind(directory);
    const lockPath = join(root, LOCK_NAME);
    platform.createExclusive(lockPath);
    const assertOwned = () => {
      platform.assertRoot(); platform.assertFile(lockPath); platform.assertSidecars(lockPath);
    };
    assertOwned();
    const validate = (db: DatabaseSync) => {
      const schema = db.prepare("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
      requireCondition(schema.length === 1 && schema[0].name === "transfer_lock_identity" &&
        schema[0].type === "table", "native-transfer-lock-invalid", 503);
      const rows = db.prepare("SELECT * FROM transfer_lock_identity").all();
      requireCondition(rows.length === 1 && rows[0].id === 1 && rows[0].role === "transfer-lock" &&
        rows[0].version === 1, "native-transfer-lock-invalid", 503);
    };
    const existing = lstatSync(lockPath).size > 0;
    if (existing) preflightExistingJournal(lockPath, assertOwned, validate, platform, owner);
    else platform.assertEmptyFile(lockPath);
    database = new DatabaseSync(lockPath);
    owner.opened(database);
    // Semantic role/version proof BEFORE PRAGMA or journal-mode mutation: an
    // existing file must already be exactly the transfer-lock schema.
    if (existing) validate(database);
    try {
      database.exec("PRAGMA busy_timeout = 0");
      database.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        ((error as { errcode?: unknown }).errcode === 5 ||
          (error as { errcode?: unknown }).errcode === 6)
      ) {
        const mapped = new SyncError("blob-upload-in-progress", 409);
        mapped.cause = error;
        throw mapped;
      }
      const mapped = new SyncError("blob-upload-lock-failed", 500);
      mapped.cause = error;
      throw mapped;
    }
    inTransaction = true;
    if (!existing) {
      database.exec(
        "CREATE TABLE transfer_lock_identity(id INTEGER PRIMARY KEY CHECK(id=1),role TEXT NOT NULL,version INTEGER NOT NULL)",
      );
      database
        .prepare(
          "INSERT INTO transfer_lock_identity VALUES(1,'transfer-lock',1)",
        )
        .run();
    }
    platform.assertRoot();
    platform.assertFile(lockPath);
    platform.assertSidecars(lockPath);
    result = await work();
    platform.assertRoot();
    platform.assertFile(lockPath);
    platform.assertSidecars(lockPath);
    database.exec("COMMIT");
    inTransaction = false;
    assertOwned();
  } catch (error) {
    let failure: unknown = error;
    if (database && inTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch (cleanup) {
        failure = new AggregateError(
          [error, cleanup],
          "native transfer lock rollback failed",
        );
      }
    }
    owner.fail(failure);
  }
  // Outside the try: a close failure must not trigger another cleanup attempt.
  owner.close();
  return result;
}

export type NativeTransferBudget = Readonly<{
  bytes: number;
  entries: number;
  directories: number;
  overLimit: boolean;
}>;

const TRANSFER_BUDGET_MAX_BYTES = 128 * 1024 * 1024;
const TRANSFER_BUDGET_MAX_ENTRIES = 2048;
const TRANSFER_BUDGET_MAX_DIRECTORIES = 128;
const TRANSFER_BUDGET_MAX_DEPTH = 4;
const TRANSFER_SCOPE_DIRECTORIES = [
  ".folio-sync-transfers",
  ".folio-sync-assets-staging",
] as const;

/**
 * Native budget admission: same 128MiB / 2048-entry / 128-directory / depth-4
 * limits as the POSIX walker. opendir/lstat only enumerate names and sample
 * bytes; every root and child is proven through the K port identities.
 */
export function inspectNativeTransferBudget(
  native: NativeTransferContext,
  workspaceDirectory: string,
  limits?: { maxBytes?: number; maxEntries?: number; maxDirectories?: number },
): NativeTransferBudget {
  const maxBytes = limits?.maxBytes ?? TRANSFER_BUDGET_MAX_BYTES;
  const maxEntries = limits?.maxEntries ?? TRANSFER_BUDGET_MAX_ENTRIES;
  const maxDirectories =
    limits?.maxDirectories ?? TRANSFER_BUDGET_MAX_DIRECTORIES;
  requireCondition(
    [maxBytes, maxEntries, maxDirectories].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ),
    "blob-transfer-budget-unsafe",
    409,
  );
  let bytes = 0;
  let entries = 0;
  let directories = 0;
  let overLimit = false;
  let stopped = false;
  const unsafe: () => never = () => {
    throw new SyncError("blob-transfer-budget-unsafe", 409);
  };
  const reserve = (directory: boolean): boolean => {
    if (
      entries >= maxEntries ||
      (directory && directories >= maxDirectories)
    ) {
      overLimit = true;
      stopped = true;
      return false;
    }
    if (directory) directories++;
    entries++;
    return true;
  };
  const addBytes = (size: number): void => {
    bytes += size;
    if (!Number.isSafeInteger(bytes)) unsafe();
    if (bytes > maxBytes) overLimit = true;
  };
  const workspacePin = native.filesystem.inspectDirectory(resolve(workspaceDirectory));
  const visit = (pin: NativePrivateIdentity, depth: number): void => {
    if (stopped) return;
    let handle;
    try {
      handle = opendirSync(pin.path);
    } catch {
      unsafe();
    }
    try {
      for (;;) {
        let entry;
        try {
          entry = handle.readSync();
        } catch {
          unsafe();
        }
        if (entry === null) break;
        if (entry.name === "." || entry.name === ".." || entry.name.includes("\0"))
          unsafe();
        const child = join(pin.path, entry.name);
        const after = native.filesystem.inspectDirectory(pin.path);
        if (
          after.fileId !== pin.fileId ||
          after.volumeId !== pin.volumeId
        )
          unsafe();
        if (entry.isDirectory()) {
          if (!reserve(true)) break;
          let childPin: NativePrivateIdentity;
          try {
            childPin = native.filesystem.inspectDirectory(child);
          } catch {
            unsafe();
          }
          if (depth + 1 > TRANSFER_BUDGET_MAX_DEPTH) {
            overLimit = true;
            stopped = true;
            break;
          }
          visit(childPin, depth + 1);
          continue;
        }
        if (!entry.isFile()) unsafe();
        // Byte sample via lstat is not proof; identity is proven natively.
        const fileId = native.filesystem.inspectFileIdentity(child);
        const sampled = lstatSync(child), size = sampled.size;
        if (!sampled.isFile() || sampled.isSymbolicLink() ||
          !Number.isSafeInteger(size) || size < 0) unsafe();
        let afterSample: number;
        try {
          afterSample = lstatSync(child).size;
        } catch {
          unsafe();
        }
        if (afterSample !== size) unsafe();
        const current = native.filesystem.inspectFileIdentity(child);
        if (
          current.fileId !== fileId.fileId ||
          current.volumeId !== fileId.volumeId
        )
          unsafe();
        if (!reserve(false)) break;
        addBytes(size);
      }
    } finally {
      handle.closeSync();
    }
    const after = native.filesystem.inspectDirectory(pin.path);
    if (after.fileId !== pin.fileId || after.volumeId !== pin.volumeId)
      unsafe();
  };
  for (const name of TRANSFER_SCOPE_DIRECTORIES) {
    if (stopped) break;
    const path = join(resolve(workspaceDirectory), name);
    if (!nativePathPresent(native.filesystem, path)) continue;
    const pin = native.filesystem.inspectDirectory(path);
    if (!reserve(true)) break;
    visit(pin, 0);
  }
  if (!sameNativeIdentity(workspacePin, native.filesystem.inspectDirectory(workspacePin.path))) unsafe();
  return Object.freeze({ bytes, entries, directories, overLimit });
}

export type NativeTransferInventoryItem = {
  name: string;
  kind:
    | "active"
    | "completed"
    | "blocked"
    | "releasing"
    | "orphan"
    | "unsafe"
    | "metadata";
  bytes: number | null;
  key?: string;
};

export type NativeTransferInventory = {
  items: NativeTransferInventoryItem[];
  totalBytes: number;
  unsafeCount: number;
  overLimit: boolean;
};

const INVENTORY_METADATA = new Set([
  "state.sqlite",
  "state.sqlite-journal",
  "state.sqlite-wal",
  "state.sqlite-shm",
]);
const INVENTORY_MAX_ENTRIES = 1000;
const INVENTORY_METADATA_ALLOWANCE = 16;
const INVENTORY_MAX_KEY_BYTES = 251;
const INVENTORY_MAX_NAME_BYTES = 255;
const INVENTORY_MAX_PARTIAL_BYTES = 100 * 1024 * 1024;

/**
 * Per-journal inventory with native proofs. Mirrors the POSIX inventory
 * limits (records ≤ journal maxEntries, bytes ≤100MiB, ≤16 metadata
 * allowances) and item kinds; identity comes from the K port, never dev/ino.
 */
export function inspectNativeTransferInventory(
  native: NativeTransferContext,
  directory: string,
  records: readonly {
    key: string;
    partialName: string;
    state: "active" | "completed" | "blocked" | "releasing";
    offset: number;
    bytes: number;
    sha256: string;
    prefixHash: string;
  }[],
  limits?: { maxEntries?: number; maxBytes?: number },
): NativeTransferInventory {
  const maxEntries = limits?.maxEntries ?? INVENTORY_MAX_ENTRIES;
  const maxBytes = limits?.maxBytes ?? INVENTORY_MAX_PARTIAL_BYTES;
  requireCondition(
    Number.isSafeInteger(maxEntries) &&
      maxEntries > 0 &&
      maxEntries <= INVENTORY_MAX_ENTRIES &&
      Number.isSafeInteger(maxBytes) &&
      maxBytes >= 0 &&
      maxBytes <= INVENTORY_MAX_PARTIAL_BYTES,
    "invalid-blob-transfer-limits",
    409,
  );
  const root = native.filesystem.inspectDirectory(directory);
  const byName = new Map<string, (typeof records)[number]>();
  for (const record of records) {
    requireCondition(
      record !== null &&
        typeof record === "object" &&
        typeof record.key === "string" &&
        record.key.length > 0 &&
        record.key.length <= INVENTORY_MAX_KEY_BYTES &&
        HASH.test(record.key) &&
        HASH.test(record.prefixHash) &&
        record.partialName === record.key + ".part" &&
        typeof record.partialName === "string" &&
        record.partialName.length <= INVENTORY_MAX_NAME_BYTES &&
        ["active", "completed", "blocked", "releasing"].includes(
          record.state,
        ) &&
        Number.isSafeInteger(record.offset) &&
        Number.isSafeInteger(record.bytes) &&
        record.offset >= 0 &&
        record.offset <= record.bytes &&
        HASH.test(record.sha256),
      "invalid-blob-transfer-records",
    );
    requireCondition(
      !byName.has(record.partialName),
      "invalid-blob-transfer-records",
    );
    byName.set(record.partialName, record);
  }
  const items: NativeTransferInventoryItem[] = [];
  let dataEntries = 0;
  let metadataEntries = 0;
  let totalBytes = 0;
  let unsafeCount = 0;
  let overLimit = false;
  let names: string[] = [];
  try {
    const handle = opendirSync(root.path);
    try {
      for (let entry; (entry = handle.readSync()) !== null; ) {
        requireCondition(
          names.length < maxEntries + INVENTORY_METADATA_ALLOWANCE + 64,
          "blob-transfer-inventory-limit",
        );
        names.push(entry.name);
      }
    } finally {
      handle.closeSync();
    }
  } catch (error) {
    if (error instanceof SyncError) throw error;
    throw new SyncError("invalid-blob-transfer-root");
  }
  const unsafeEntry = (item: NativeTransferInventoryItem) => {
    unsafeCount++;
    item.kind = "unsafe";
    return item;
  };
  for (const name of names) {
    if (name === "." || name === ".." || name.includes("\0") || name.length > INVENTORY_MAX_NAME_BYTES) {
      items.push(unsafeEntry({ name, kind: "unsafe", bytes: null }));
      continue;
    }
    const record = byName.get(name);
    const metadataName = INVENTORY_METADATA.has(name);
    const item: NativeTransferInventoryItem = record
      ? { name, kind: record.state, bytes: null, key: record.key }
      : { name, kind: "orphan", bytes: null };
    if (metadataName) {
      if (metadataEntries >= INVENTORY_METADATA_ALLOWANCE) overLimit = true;
      metadataEntries++;
      try {
        const identity = native.filesystem.inspectFileIdentity(
          join(root.path, name),
        );
        const stat = lstatSync(join(root.path, name));
        if (
          stat.isSymbolicLink() ||
          !stat.isFile() ||
          stat.size < 0 ||
          stat.size > 32 * 1024 * 1024
        ) {
          items.push(unsafeEntry(item));
          continue;
        }
        const after = native.filesystem.inspectFileIdentity(
          join(root.path, name),
        );
        if (
          after.fileId !== identity.fileId ||
          after.volumeId !== identity.volumeId
        ) {
          items.push(unsafeEntry(item));
          continue;
        }
        item.kind = "metadata";
        item.bytes = stat.size;
        totalBytes += stat.size;
      } catch {
        items.push(unsafeEntry(item));
        continue;
      }
      items.push(item);
      continue;
    }
    if (dataEntries >= maxEntries) overLimit = true;
    dataEntries++;
    let file: NativePrivateFile;
    try {
      file = native.filesystem.inspectFile(join(root.path, name), maxBytes);
    } catch {
      items.push(unsafeEntry(item));
      continue;
    }
    item.bytes = file.bytes;
    totalBytes += file.bytes;
    items.push(item);
  }
  if (totalBytes > maxBytes || dataEntries > maxEntries) overLimit = true;
  requireCondition(sameNativeIdentity(root, native.filesystem.inspectDirectory(root.path)),
    "blob-transfer-partial-changed", 409);
  return { items, totalBytes, unsafeCount, overLimit };
}

const SERVER_BLOB_MAX_BYTES = 256 * 1024 * 1024;
const SERVER_BLOB_MAX_ENTRIES = 4096;
const SERVER_HASH = /^[a-f0-9]{64}$/;
const SERVER_PARTIAL = /^\.partial-[a-f0-9]{64}$/;
const SERVER_LOCK_METADATA = /^(transfer-lock|transfer-outcomes|\.folio-upload-lock|cache-maintenance)\.sqlite(-journal|-shm|-wal)?$/;
const SERVER_BLOB_FILE_MAX = 20_000_000;

/**
 * Native server-side quota scanner. Preserves the POSIX retention limits
 * (256MiB / 4096 entries, tighter configured caps) and the unknown-namespace
 * hold: only hash-named workspace directories, hash or `.partial-` files, and
 * lock metadata are known names. Enumeration samples lstat; identity and file
 * sizes are proven through K — a size sample is never capacity evidence.
 */
export function inspectNativeServerBlobRetention(
  native: NativeTransferContext,
  directory: string,
  limits?: { maxBytes?: number; maxEntries?: number },
): { bytes: number; entries: number; held: boolean } {
  const maxBytes = limits?.maxBytes ?? SERVER_BLOB_MAX_BYTES;
  const maxEntries = limits?.maxEntries ?? SERVER_BLOB_MAX_ENTRIES;
  requireCondition(
    (limits === undefined || (limits !== null && typeof limits === "object" && !Array.isArray(limits))) &&
    Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes <= SERVER_BLOB_MAX_BYTES &&
    Number.isSafeInteger(maxEntries) && maxEntries >= 0 && maxEntries <= SERVER_BLOB_MAX_ENTRIES,
    "server-blob-retention-unknown", 409);
  const unknown: () => never = () => {
    throw new SyncError("server-blob-retention-unknown", 409);
  };
  let bytes = 0;
  let entries = 0;
  const addBytes = (size: number): void => {
    bytes += size;
    if (!Number.isSafeInteger(bytes)) unknown();
    if (bytes > maxBytes) unknown();
  };
  let rootPin: NativePrivateIdentity;
  try {
    rootPin = native.filesystem.inspectDirectory(directory);
  } catch {
    unknown();
  }
  const names = (pin: NativePrivateIdentity, depth: number): string[] => {
    let handle;
    try {
      handle = opendirSync(pin.path);
    } catch {
      unknown();
    }
    const result: string[] = [];
    try {
      for (;;) {
        const entry = handle.readSync();
        if (entry === null) break;
        if (result.length >= SERVER_BLOB_MAX_ENTRIES + 64) unknown();
        result.push(entry.name);
      }
    } finally {
      handle.closeSync();
    }
    const after = native.filesystem.inspectDirectory(pin.path);
    if (after.fileId !== pin.fileId || after.volumeId !== pin.volumeId)
      unknown();
    void depth;
    return result;
  };
  const fileSize = (path: string, maximum: number): number => {
    let sampled: number;
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0)
        unknown();
      sampled = stat.size;
    } catch (error) {
      if (error instanceof SyncError) throw error;
      unknown();
    }
    let identity;
    try {
      identity = native.filesystem.inspectFileIdentity(path);
    } catch {
      unknown();
    }
    let after: number;
    try {
      after = lstatSync(path).size;
    } catch {
      unknown();
    }
    if (after !== sampled) unknown();
    const current = native.filesystem.inspectFileIdentity(path);
    if (
      current.fileId !== identity.fileId ||
      current.volumeId !== identity.volumeId
    )
      unknown();
    if (sampled > maximum) unknown();
    return sampled;
  };
  let workspaces = 0;
  for (const name of names(rootPin, 0)) {
    if (workspaces++ > 4096) unknown();
    if (name === "." || name === ".." || name.includes("\0")) unknown();
    const child = join(rootPin.path, name);
    if (SERVER_LOCK_METADATA.test(name)) {
      addBytes(fileSize(child, 16 * 1024 * 1024));
      continue;
    }
    if (!SERVER_HASH.test(name)) unknown();
    let pin: NativePrivateIdentity;
    try {
      pin = native.filesystem.inspectDirectory(child);
    } catch {
      unknown();
    }
    let depthEntries = 0;
    for (const inner of names(pin, 1)) {
      if (depthEntries++ > 4096 + 64) unknown();
      const file = join(pin.path, inner);
      if (SERVER_LOCK_METADATA.test(inner)) {
        addBytes(fileSize(file, 16 * 1024 * 1024));
        continue;
      }
      if (!(SERVER_HASH.test(inner) || SERVER_PARTIAL.test(inner))) unknown();
      addBytes(fileSize(file, SERVER_BLOB_FILE_MAX));
      entries++;
      if (entries > maxEntries) unknown();
    }
  }
  if (!sameNativeIdentity(rootPin, native.filesystem.inspectDirectory(rootPin.path))) unknown();
  return { bytes, entries, held: bytes > maxBytes || entries > maxEntries };
}

export function assertNativeServerBlobAdmission(
  native: NativeTransferContext,
  directory: string,
  additionalBytes: number,
  limits?: { maxBytes?: number; maxEntries?: number },
  additionalEntries = 1,
): void {
  const maxBytes = limits?.maxBytes ?? SERVER_BLOB_MAX_BYTES;
  const maxEntries = limits?.maxEntries ?? SERVER_BLOB_MAX_ENTRIES;
  if (
    typeof additionalBytes !== "number" ||
    !Number.isSafeInteger(additionalBytes) ||
    additionalBytes < 0 ||
    !Number.isSafeInteger(additionalEntries) ||
    additionalEntries < 0 ||
    additionalEntries > 1
  )
    throw new SyncError("server-blob-retention-unknown", 409);
  const inspection = inspectNativeServerBlobRetention(native, directory, {
    maxBytes,
    maxEntries,
  });
  if (
    inspection.held ||
    inspection.bytes + additionalBytes > maxBytes ||
    inspection.entries + additionalEntries > maxEntries
  )
    throw new SyncError("server-blob-retention-held", 409);
}

/* ------------------------------------------------------------------ */
/*  Append port factory: single-dispatch `--private-transfer-io`.       */
/* ------------------------------------------------------------------ */

const TRANSFER_IO_MAX_PAYLOAD = 1024 * 1024;
const TRANSFER_IO_MAX_REPLY = 16 * 1024;
const TRANSFER_IO_MAX_BYTES = 20_000_000;
const ATTEMPT = /^[0-9a-f]{32}$/;
const SID = /^S-1-[0-9]+(?:-[0-9]+)+$/;
const DIGEST = /^[0-9a-f]{64}$/;

export type WindowsNativeTransferIoOptions = Readonly<{
  root: string;
  probeExecutable: string;
  expectedHash: string;
  systemRoot: string;
  expectedRoot: WindowsRuntimeRootIdentity;
  authority: NativePrivatePersistenceAuthority;
  directoryIdentity(path: string): WindowsRuntimeDirectoryIdentity;
  assertCurrent(): void;
}>;

export type WindowsNativeTransferIoExecRequest = Readonly<{
  executable: string;
  args: readonly ["--private-transfer-io"];
  cwd: string;
  env: Readonly<{ SystemRoot: string; windir: string; TEMP: string; TMP: string }>;
  input: Uint8Array;
  timeoutMs: number;
  maxBuffer: number;
  shell: false;
  windowsHide: true;
  stdio: "pipe";
  encoding: "buffer";
}>;

export type WindowsNativeTransferIoExecResult = Readonly<{
  status: number | null;
  signal: string | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  errorCode?: string;
}>;

export type WindowsNativeTransferIoTestPort = Readonly<{
  fs: Readonly<{
    lstat(path: string): {
      isFile(): boolean;
      isDirectory(): boolean;
      isSymbolicLink(): boolean;
      nlink: number;
      dev: number;
      ino: number;
      size: number;
      mtimeMs: number;
    };
    readFile(path: string): Uint8Array;
  }>;
  exec(
    request: WindowsNativeTransferIoExecRequest,
  ): WindowsNativeTransferIoExecResult;
}>;

function fail(code: string): never {
  throw new CollaborationError(`WINDOWS_PRIVATE_TRANSFER_${code}`);
}

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const same = (a: string, b: string): boolean =>
  asciiCaseFold(a) === asciiCaseFold(b);

const nativePort: WindowsNativeTransferIoTestPort = {
  fs: { lstat: lstatSync, readFile: readFileSync },
  exec(request) {
    const result = spawnSync(request.executable, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      input: request.input,
      timeout: request.timeoutMs,
      maxBuffer: request.maxBuffer,
      shell: false,
      windowsHide: true,
      stdio: "pipe",
      encoding: "buffer",
    });
    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout ?? new Uint8Array(0),
      stderr: result.stderr ?? new Uint8Array(0),
      ...(result.error ? { errorCode: "EXEC_FAILED" } : {}),
    };
  },
};

/**
 * Production append port. Windows-only: helper identity is pinned by hash +
 * stat before/after every dispatch; authority archive precedes any mutation.
 */
export function createWindowsNativeTransferIo(
  options: WindowsNativeTransferIoOptions,
): NativeTransferIoPort {
  if (arguments.length !== 1) fail("OPTIONS");
  if (process.platform !== "win32") fail("UNSUPPORTED_PLATFORM");
  return create(options, nativePort);
}

/**
 * Non-Windows contract-only adapter for finite transport simulations. It is
 * explicitly labelled untrusted contract simulation — never native Windows
 * proof and never OS acceptance.
 */
export function createWindowsNativeTransferIoForTesting(
  options: WindowsNativeTransferIoOptions,
  port: WindowsNativeTransferIoTestPort,
): NativeTransferIoPort {
  if (process.platform === "win32") fail("TEST_PORT_FORBIDDEN");
  return create(options, port);
}

const failedAuthorities = new WeakSet<object>();

function record(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null) fail("SCHEMA");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail("SCHEMA");
  const names = Reflect.ownKeys(value);
  if (keys.some((key) => !names.includes(key))) fail("SCHEMA");
  for (const key of names) {
    if (
      typeof key !== "string" ||
      (!keys.includes(key) && !optional.includes(key))
    )
      fail("SCHEMA");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      fail("SCHEMA");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) fail("SCHEMA");
  return value;
}

function canonical(value: unknown, root?: string): string {
  if (
    typeof value !== "string" ||
    value.length > 240 ||
    !/^[A-Z]:\\[\x20-\x7e]*$/.test(value)
  )
    fail("PATH");
  try {
    if (
      validateWindowsPath(value, root ?? `${value[0]}:\\`).canonical !== value
    )
      fail("PATH");
  } catch {
    fail("PATH");
  }
  return value;
}

function isAsyncLike(value: unknown): boolean {
  return (
    typeof value !== "function" ||
    types.isAsyncFunction(value) ||
    types.isGeneratorFunction(value)
  );
}

type Pin = Readonly<{ dev: number; ino: number; size: number; mtimeMs: number }>;
function samePin(a: Pin, b: Pin): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs
  );
}
function pinExecutable(
  fs: WindowsNativeTransferIoTestPort["fs"],
  path: string,
  hash: string,
): Pin {
  const stat = (): Pin => {
    const s = fs.lstat(path);
    if (!s.isFile() || s.isDirectory() || s.isSymbolicLink() || s.nlink !== 1)
      fail("HELPER_UNTRUSTED");
    const pin = {
      dev: s.dev,
      ino: s.ino,
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
    if (
      Object.values(pin).some((n) => !Number.isFinite(n) || n < 0) ||
      !Number.isSafeInteger(pin.size)
    )
      fail("HELPER_UNTRUSTED");
    return Object.freeze(pin);
  };
  try {
    const before = stat();
    const bytes = fs.readFile(path);
    const after = stat();
    if (
      bytes.byteLength !== before.size ||
      digest(bytes) !== hash ||
      !samePin(before, after)
    )
      fail("HELPER_UNTRUSTED");
    return after;
  } catch {
    return fail("HELPER_UNTRUSTED");
  }
}

const REQUEST_ORDER = [
  "attemptId",
  "byteLength",
  "contractVersion",
  "directoryFileId",
  "directoryVolumeId",
  "expectedSha256",
  "fileId",
  "maxBytes",
  "operation",
  "path",
  "payloadSha256",
  "root",
  "rootFileId",
  "rootVolumeId",
  "volumeId",
] as const;

function encodeRequest(
  header: Record<string, unknown>,
  payload: Uint8Array,
): Buffer {
  const out: Record<string, unknown> = Object.create(null);
  for (const key of REQUEST_ORDER) if (key in header) out[key] = header[key];
  const json = JSON.stringify(out);
  if (
    Buffer.byteLength(json, "ascii") !== json.length ||
    json.length > WINDOWS_PRIVATE_HEADER_MAX_BYTES
  )
    fail("HEADER");
  const jsonBytes = Buffer.from(json, "ascii");
  const frame = Buffer.alloc(4 + jsonBytes.byteLength + payload.byteLength);
  frame.writeUInt32LE(jsonBytes.byteLength, 0);
  jsonBytes.copy(frame, 4);
  frame.set(payload, 4 + jsonBytes.byteLength);
  return frame;
}

function parseHeader(bytes: Uint8Array): Record<string, unknown> {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > WINDOWS_PRIVATE_HEADER_MAX_BYTES
  )
    fail("HEADER");
  for (const byte of bytes) if (byte > 0x7f) fail("HEADER");
  const source = Buffer.from(bytes).toString("latin1");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail("JSON");
  }
  // Accept only canonical JSON from the pinned helper serializer. This also
  // rejects duplicate/escaped keys that JSON.parse alone would collapse.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
    JSON.stringify(parsed) !== source) fail("JSON");
  return parsed as Record<string, unknown>;
}

function decodeResponse(stdout: Uint8Array): { header: Record<string, unknown>; payload: Uint8Array } {
  if (
    !(stdout instanceof Uint8Array) ||
    stdout.byteLength < 4 ||
    stdout.byteLength > 4 + TRANSFER_IO_MAX_REPLY
  )
    fail("OUTPUT");
  const headerLength =
    stdout[0] | (stdout[1] << 8) | (stdout[2] << 16) | (stdout[3] << 24);
  if (
    headerLength <= 0 ||
    headerLength > TRANSFER_IO_MAX_REPLY ||
    stdout.byteLength !== 4 + headerLength
  )
    fail("OUTPUT");
  return Object.freeze({
    header: parseHeader(stdout.subarray(4, 4 + headerLength)),
    payload: new Uint8Array(0),
  });
}

function create(
  options: WindowsNativeTransferIoOptions,
  port: WindowsNativeTransferIoTestPort,
): NativeTransferIoPort {
  let root: string, executable: string, systemRoot: string;
  let expectedRoot: WindowsRuntimeRootIdentity;
  let initialPin: Pin;
  let fs: WindowsNativeTransferIoTestPort["fs"],
    exec: WindowsNativeTransferIoTestPort["exec"];
  let authority: NativePrivatePersistenceAuthority, authorityObject: object;
  let directoryIdentityFor: (path: string) => WindowsRuntimeDirectoryIdentity;
  let revalidate: () => void;
  try {
    const o = record(options, [
      "root",
      "probeExecutable",
      "expectedHash",
      "systemRoot",
      "expectedRoot",
      "authority",
      "directoryIdentity",
      "assertCurrent",
    ]);
    root = canonical(o.root);
    executable = canonical(o.probeExecutable);
    systemRoot = canonical(o.systemRoot);
    if (!/\.exe$/i.test(executable)) fail("OPTIONS");
    text(o.expectedHash, HASH);
    const r = record(o.expectedRoot, ["rootFileId", "volumeId"]);
    expectedRoot = Object.freeze({
      rootFileId: text(r.rootFileId, FILE_ID),
      volumeId: text(r.volumeId, VOLUME_ID),
    });
    const candidate = o.authority as Record<string, unknown> | null;
    if (
      candidate === null ||
      (typeof candidate !== "object" && typeof candidate !== "function")
    )
      fail("AUTHORITY");
    if (candidate.version !== 1 || candidate.independent !== true)
      fail("AUTHORITY");
    const bound: Record<string, unknown> = {};
    for (const name of [
      "reserve",
      "capture",
      "terminal",
      "assertCurrent",
    ] as const) {
      const method = candidate[name];
      if (isAsyncLike(method)) fail("AUTHORITY");
      bound[name] = (method as (...args: unknown[]) => unknown).bind(candidate);
    }
    authority = bound as unknown as NativePrivatePersistenceAuthority;
    authorityObject = o.authority as object;
    if (
      isAsyncLike(o.directoryIdentity) ||
      isAsyncLike(o.assertCurrent)
    )
      fail("OPTIONS");
    directoryIdentityFor =
      o.directoryIdentity as WindowsNativeTransferIoOptions["directoryIdentity"];
    revalidate =
      o.assertCurrent as WindowsNativeTransferIoOptions["assertCurrent"];
    const p = record(port, ["fs", "exec"]);
    const f = record(p.fs, ["lstat", "readFile"]);
    if (
      isAsyncLike(f.lstat) ||
      isAsyncLike(f.readFile) ||
      isAsyncLike(p.exec)
    )
      fail("OPTIONS");
    fs = {
      lstat: port.fs.lstat.bind(port.fs),
      readFile: port.fs.readFile.bind(port.fs),
    };
    exec = port.exec.bind(port);
    initialPin = pinExecutable(fs, executable, text(o.expectedHash, HASH));
  } catch {
    return fail("OPTIONS_OR_HELPER_UNTRUSTED");
  }

  let authorityFailed = false;
  let active = false;
  let checkingCurrent = false;
  let pinnedSid: string | undefined;
  const poisoned = (): boolean =>
    authorityFailed || failedAuthorities.has(authorityObject);
  const poison = (): void => {
    authorityFailed = true;
    failedAuthorities.add(authorityObject);
  };
  const assertPin = (): void => {
    if (
      !samePin(
        initialPin,
        pinExecutable(fs, executable, text(options.expectedHash, HASH)),
      )
    )
      fail("HELPER_CHANGED");
  };
  const syncVoid = (call: () => unknown): void => {
    let outcome: unknown;
    try {
      outcome = call();
    } catch {
      fail("REVALIDATE");
    }
    if (types.isPromise(outcome))
      Promise.prototype.then.call(outcome, undefined, () => undefined);
    if (outcome !== undefined || isThenable(outcome)) fail("REVALIDATE");
  };
  const checkCurrent = (): void => {
    if (checkingCurrent) fail("REENTRANT");
    checkingCurrent = true;
    try {
      syncVoid(() => revalidate());
      syncVoid(() => authority.assertCurrent());
    } finally {
      checkingCurrent = false;
    }
  };
  const ack = (call: () => unknown): boolean => {
    if (poisoned()) return false;
    try {
      const result = call();
      if (types.isPromise(result))
        Promise.prototype.then.call(result, undefined, () => undefined);
      return result === undefined && !poisoned();
    } catch {
      return false;
    }
  };
  const evidence = (
    raw: unknown,
    path: string,
    fileId?: string,
  ): WindowsProbeEvidence => {
    assertWindowsProbe(raw, { canonicalPath: path, canonicalRoot: root });
    const p = raw as WindowsProbeEvidence;
    canonical(p.canonicalPath, root);
    canonical(p.canonicalRoot);
    if (
      !same(p.rootFileId, expectedRoot.rootFileId) ||
      !same(p.rootVolumeId, expectedRoot.volumeId) ||
      !same(p.volumeId, expectedRoot.volumeId) ||
      (fileId !== undefined && !same(p.fileId, fileId)) ||
      !SID.test(p.sid) ||
      (pinnedSid !== undefined && p.sid !== pinnedSid)
    )
      fail("EVIDENCE");
    return p;
  };

  const captureOf = (raw: unknown) => {
    const pick = (
      key: "stdout" | "stderr",
    ): Uint8Array => {
      if (raw === null || typeof raw !== "object") return new Uint8Array(0);
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (
        !descriptor ||
        !("value" in descriptor) ||
        !(descriptor.value instanceof Uint8Array)
      )
        return new Uint8Array(0);
      return Uint8Array.from(descriptor.value);
    };
    const out: {
      stdout: Uint8Array;
      stderr: Uint8Array;
      status: number | null;
      signal: string | null;
      errorCode?: string;
    } = { stdout: pick("stdout"), stderr: pick("stderr"), status: null, signal: null };
    if (raw !== null && typeof raw === "object") {
      const r: Record<string, unknown> = {};
      for (const key of ["status", "signal", "errorCode"]) {
        const descriptor = Object.getOwnPropertyDescriptor(raw, key);
        if (descriptor && "value" in descriptor) r[key] = descriptor.value;
      }
      if (typeof r.status === "number" || r.status === null)
        out.status = r.status as number | null;
      if (typeof r.signal === "string" || r.signal === null)
        out.signal = r.signal as string | null;
      if (typeof r.errorCode === "string") out.errorCode = r.errorCode;
    }
    return out;
  };

  const terminalSafe = (
    attemptId: string,
    state: "APPLIED" | "UNKNOWN",
    body: Record<string, unknown>,
  ): void => {
    let receipt: string;
    try {
      receipt = JSON.stringify({ attemptId, state, ...body });
      if (Buffer.byteLength(receipt) > 48 * 1024)
        receipt = JSON.stringify({ attemptId, state, evidenceOmitted: true });
    } catch {
      receipt = JSON.stringify({ attemptId, state, evidenceOmitted: true });
    }
    if (!ack(() => authority.terminal(attemptId, state, receipt))) poison();
  };

  const append = (
    path: string,
    expected: NativePrivateFile,
    bytes: Uint8Array,
    maxBytes: number,
  ): NativePrivateReceipt => {
    if (poisoned())
      throw new NativePrivatePersistenceError("UNKNOWN", "AUTHORITY");
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > TRANSFER_IO_MAX_PAYLOAD ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      maxBytes > TRANSFER_IO_MAX_BYTES
    )
      fail("REQUEST");
    const f = record(expected, [
      "path",
      "fileId",
      "volumeId",
      "bytes",
      "sha256",
    ]);
    const p = canonical(f.path, root);
    const expectedFile = Object.freeze({
      path: p,
      fileId: text(f.fileId, FILE_ID),
      volumeId: text(f.volumeId, VOLUME_ID),
      bytes:
        typeof f.bytes === "number" &&
        Number.isSafeInteger(f.bytes) &&
        f.bytes >= 0 &&
        f.bytes <= TRANSFER_IO_MAX_BYTES
          ? f.bytes
          : (fail("SIZE") as never),
      sha256: text(f.sha256, DIGEST),
    });
    if (!same(canonical(path, root), p) || !same(expectedFile.volumeId, expectedRoot.volumeId))
      fail("PATH");
    if (
      !Number.isSafeInteger(expectedFile.bytes + bytes.byteLength) ||
      expectedFile.bytes + bytes.byteLength > maxBytes ||
      expectedFile.bytes + bytes.byteLength > TRANSFER_IO_MAX_BYTES
    )
      fail("SIZE");
    const parent = p.slice(0, p.lastIndexOf("\\"));
    let rawDirectory: unknown;
    try {
      rawDirectory = directoryIdentityFor(
        p.lastIndexOf("\\") === 2 ? p.slice(0, 3) : parent,
      );
    } catch {
      fail("IDENTITY");
    }
    if (types.isPromise(rawDirectory) || isThenable(rawDirectory))
      fail("IDENTITY");
    const dr = record(rawDirectory, ["fileId", "volumeId"]);
    const directory = Object.freeze({
      fileId: text(dr.fileId, FILE_ID),
      volumeId: text(dr.volumeId, VOLUME_ID),
    });
    if (
      !same(directory.volumeId, expectedRoot.volumeId) ||
      (same(
        p.lastIndexOf("\\") === 2 ? p.slice(0, 3) : parent,
        root,
      ) &&
        !same(directory.fileId, expectedRoot.rootFileId))
    )
      fail("IDENTITY");
    const attemptId = randomUUID().replace(/-/g, "");
    if (!ATTEMPT.test(attemptId)) fail("ATTEMPT");
    const header = {
      attemptId,
      byteLength: expectedFile.bytes,
      contractVersion: 1,
      directoryFileId: directory.fileId,
      directoryVolumeId: directory.volumeId,
      expectedSha256: expectedFile.sha256,
      fileId: expectedFile.fileId,
      maxBytes,
      operation: "append",
      path: p,
      payloadSha256: digest(bytes),
      root,
      rootFileId: expectedRoot.rootFileId,
      rootVolumeId: expectedRoot.volumeId,
      volumeId: expectedFile.volumeId,
    };
    const wire = encodeRequest(header, bytes);
    checkCurrent();
    if (
      !ack(() =>
        authority.reserve({
          attemptId,
          targetKey: `target:${digest(
            Buffer.from(
              asciiCaseFold(expectedRoot.volumeId) +
                "|" +
                asciiCaseFold(expectedRoot.rootFileId) +
                "|" +
                asciiCaseFold(directory.volumeId) +
                "|" +
                asciiCaseFold(directory.fileId) +
                "|" +
                asciiCaseFold(p.slice(p.lastIndexOf("\\") + 1)),
              "utf8",
            ),
          )}`,
          wire: Uint8Array.from(wire),
          payload: Uint8Array.from(bytes),
          maxCaptureBytes: 4 + TRANSFER_IO_MAX_REPLY + 1024 * 1024,
        }),
      )
    ) {
      poison();
      throw new NativePrivatePersistenceError("UNKNOWN", "RESERVE");
    }
    try {
      checkCurrent();
    } catch {
      terminalSafe(attemptId, "UNKNOWN", { phase: "pre-dispatch" });
      throw new NativePrivatePersistenceError("UNKNOWN", "REVALIDATE");
    }
    let raw: unknown;
    try {
      assertPin();
      raw = exec(
        Object.freeze({
          executable,
          args: Object.freeze(["--private-transfer-io"] as const),
          cwd: systemRoot,
          env: Object.freeze({
            SystemRoot: systemRoot,
            windir: systemRoot,
            TEMP: `${systemRoot}\\Temp`,
            TMP: `${systemRoot}\\Temp`,
          }),
          input: wire,
          timeoutMs: WINDOWS_PROBE_TIMEOUT_MS,
          maxBuffer: 4 + TRANSFER_IO_MAX_REPLY,
          shell: false,
          windowsHide: true,
          stdio: "pipe",
          encoding: "buffer",
        }),
      );
    } catch {
      raw = undefined;
    }
    let pinChanged = false;
    try {
      assertPin();
    } catch {
      pinChanged = true; // Capture original pipes even when the executable changed.
    }
    if (!ack(() => authority.capture(attemptId, captureOf(raw)))) {
      poison();
      throw new NativePrivatePersistenceError("UNKNOWN", "CAPTURE");
    }
    let result: Record<string, unknown> | undefined;
    if (raw !== null && typeof raw === "object") {
      try {
        result = record(raw, ["status", "signal", "stdout", "stderr"], [
          "errorCode",
        ]);
      } catch {
        result = undefined;
      }
    }
    const ok =
      !pinChanged && result !== undefined &&
      result.signal === null &&
      !("errorCode" in result) &&
      result.stderr instanceof Uint8Array &&
      result.stderr.byteLength === 0 &&
      result.stdout instanceof Uint8Array &&
      Number.isInteger(result.status);
    if (!ok || result === undefined) {
      terminalSafe(attemptId, "UNKNOWN", { phase: "dispatch", malformed: true });
      throw new NativePrivatePersistenceError("UNKNOWN", "DISPATCH");
    }
    let framed: { header: Record<string, unknown>; payload: Uint8Array };
    try {
      framed = decodeResponse(result.stdout as Uint8Array);
    } catch {
      terminalSafe(attemptId, "UNKNOWN", {
        phase: "append",
        malformed: true,
      });
      throw new NativePrivatePersistenceError("UNKNOWN", "FRAME");
    }
    const r = framed.header;
    const status = result.status as number;
    try {
      record(r, [
        "contractVersion",
        "operation",
        "path",
        "root",
        "attemptId",
        "state",
      ], ["reason", "file", "directory", "byteLength", "sha256",
        "filesystem", "durability", "contentFlushed"]);
      if (
        r.contractVersion !== 1 ||
        r.operation !== "append" ||
        r.path !== p ||
        r.root !== root ||
        r.attemptId !== attemptId
      )
        fail("ENVELOPE");
    } catch {
      terminalSafe(attemptId, "UNKNOWN", {
        phase: "append",
        status,
        reply: { malformed: true },
      });
      throw new NativePrivatePersistenceError("UNKNOWN", "ENVELOPE");
    }
    if (r.state !== "APPLIED") {
      let state: "REJECTED" | "EXISTS" | "UNKNOWN";
      try {
        const fr = record(r, [
          "contractVersion",
          "operation",
          "path",
          "root",
          "attemptId",
          "state",
          "reason",
        ]);
        state = fr.state as "REJECTED" | "EXISTS" | "UNKNOWN";
        if (
          !(
            (state === "REJECTED" && status === 1) ||
            (state === "EXISTS" && status === 2) ||
            (state === "UNKNOWN" && status === 3)
          ) ||
          typeof fr.reason !== "string"
        )
          fail("FAILURE");
      } catch {
        terminalSafe(attemptId, "UNKNOWN", {
          phase: "append",
          status,
          reply: { malformed: true },
        });
        throw new NativePrivatePersistenceError("UNKNOWN", "FAILURE_ENVELOPE");
      }
      terminalSafe(attemptId, "UNKNOWN", { phase: "append", status, reply: r });
      throw new NativePrivatePersistenceError(state, String(r.reason));
    }
    const newBytes = expectedFile.bytes + bytes.byteLength;
    let receipt: NativePrivateReceipt;
    try {
      checkCurrent();
      const response = record(
        r,
        [
          "contractVersion",
          "operation",
          "path",
          "root",
          "attemptId",
          "state",
          "file",
          "directory",
          "byteLength",
          "sha256",
          "filesystem",
          "durability",
          "contentFlushed",
        ],
      );
      if (
        status !== 0 || !Number.isSafeInteger(response.byteLength) ||
        (response.byteLength as number) !== newBytes ||
        response.filesystem !== "NTFS" ||
        response.contentFlushed !== true
      )
        fail("RECEIPT");
      const durability = record(response.durability, ["profile", "scope"]);
      if (
        durability.profile !== "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1" ||
        durability.scope !== "PROCESS_CRASH"
      )
        fail("RECEIPT");
      const sha256 = text(response.sha256, DIGEST);
      const file = evidence(response.file, p, expectedFile.fileId);
      const dir = evidence(
        response.directory,
        p.lastIndexOf("\\") === 2 ? p.slice(0, 3) : parent,
        directory.fileId,
      );
      if (file.sid !== dir.sid || !same(dir.volumeId, directory.volumeId))
        fail("EVIDENCE");
      pinnedSid = file.sid;
      receipt = Object.freeze({
        profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1" as const,
        scope: "PROCESS_CRASH" as const,
        identity: Object.freeze({
          path: file.canonicalPath,
          fileId: file.fileId,
          volumeId: file.volumeId,
          bytes: newBytes,
          sha256,
        }),
      });
    } catch {
      terminalSafe(attemptId, "UNKNOWN", {
        phase: "append",
        status,
        reply: { malformed: true },
      });
      throw new NativePrivatePersistenceError("UNKNOWN", "RECEIPT");
    }
    if (
      !ack(() =>
        authority.terminal(
          attemptId,
          "APPLIED",
          JSON.stringify({ attemptId, operation: "append", path: p, status, reply: r }),
        ),
      )
    ) {
      poison();
      throw new NativePrivatePersistenceError("UNKNOWN", "TERMINAL");
    }
    return receipt;
  };

  return Object.freeze({
    platform: "win32" as const,
    version: 1 as const,
    synchronous: true as const,
    append(path, expected, bytes, maxBytes) {
      if (active) {
        poison();
        throw new NativePrivatePersistenceError("UNKNOWN", "REENTRANT");
      }
      active = true;
      try {
        const result = append(path, expected, bytes, maxBytes);
        if (poisoned()) throw new NativePrivatePersistenceError("UNKNOWN", "AUTHORITY");
        return result;
      } catch (error) {
        if (isNativeUnknown(error)) poison();
        throw error;
      } finally { active = false; }
    },
  });
}
