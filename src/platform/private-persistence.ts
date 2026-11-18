import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import { requireCondition, SyncError } from "../sync/protocol";

/**
 * Native private persistence port: a synchronous, identity-pinned filesystem
 * primitive family backed by the pinned Windows helper. Every returned
 * identity carries the NTFS file ID and volume serial of the exact object the
 * helper proved on a held handle; callers compare those identities instead of
 * trusting paths, dev/ino pairs, or byte counts.
 *
 * The port is deliberately synchronous and single-dispatch: a helper reply
 * that cannot be proven is UNKNOWN, never silently retried, deleted, or
 * treated as absent. Missing durable evidence is never proof that an
 * operation did not apply.
 */
export type NativePrivateIdentity = Readonly<{
  path: string;
  fileId: string;
  volumeId: string;
}>;

export type NativePrivateFile = NativePrivateIdentity &
  Readonly<{ bytes: number; sha256: string }>;

export type NativePrivateTree = NativePrivateIdentity & Readonly<{
  entries: number; bytes: number; sha256: string;
}>;
export type NativePrivateDirectoryReceipt = Readonly<{
  profile: "WINDOWS_LOCAL_NTFS_DIRECTORY_RENAME_V1";
  scope: "PROCESS_CRASH";
  identity: NativePrivateTree;
}>;
export interface NativePrivateSqliteLease { assertHeld(): void; close(): void; }
export type NativePrivateCurrentCheck = (phase: "reserve" | "dispatch" | "success") => void;

/**
 * Durability receipt for a completed native mutation. The profile is
 * explicitly file-metadata flush scope only, a PROCESS_CRASH candidate.
 * It is not Windows OS acceptance evidence and never represents directory
 * fsync or machine-crash durability.
 */
export type NativePrivateReceipt = Readonly<{
  profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1";
  scope: "PROCESS_CRASH";
  identity: NativePrivateFile;
}>;

export interface NativePrivateFilesystemPort {
  readonly platform: "win32";
  readonly version: 1;
  readonly synchronous: true;
  /** Prove the pinned directory identity of an existing directory. */
  inspectDirectory(path: string): NativePrivateIdentity;
  /** Prove the identity + bounded size/hash of an existing file. */
  inspectFile(path: string, maxBytes: number): NativePrivateFile;
  /**
   * Metadata-only identity of an existing file (for example an open SQLite
   * database): the helper opens READ_ATTRIBUTES with READ|WRITE share but
   * NOT DELETE share and makes no byte-consistency assertion.
   */
  inspectFileIdentity(path: string): NativePrivateIdentity;
  /** Read a file whose opened-handle identity and hash match `expected`. */
  read(path: string, expected: NativePrivateFile, maxBytes: number): Uint8Array;
  /** Exclusive-create a new private file with flushed metadata; no replace. */
  writeNew(path: string, bytes: Uint8Array, maxBytes: number): NativePrivateReceipt;
  /** Streaming exclusive copy of an expected source into a new file. */
  copyNew(
    source: string,
    destination: string,
    expected: NativePrivateFile,
    maxBytes: number,
  ): NativePrivateReceipt;
  /** No-replace rename of an expected file onto a fresh destination name. */
  renameNew(
    source: string,
    destination: string,
    expected: NativePrivateFile,
    maxBytes: number,
  ): NativePrivateReceipt;
  /** Delete only the exact expected file on a held DELETE handle. */
  unlinkExact(path: string, expected: NativePrivateFile, maxBytes: number): void;
  /** Actual file FlushFileBuffers proof only; never a directory-fsync stand-in. */
  proveSync(path: string, expected: NativePrivateFile): NativePrivateReceipt;
  /** Create a new private directory through the durable exclusive adapter. */
  createDirectory(path: string): NativePrivateIdentity;
  /** Consistent VACUUM INTO on a protected new file under a native held lease. */
  snapshotSqlite(db: DatabaseSync, destination: string): NativePrivateReceipt;
  inspectTree?(path: string): NativePrivateTree;
  renameDirectoryNew?(source: string, destination: string, expected: NativePrivateTree,
    assertCurrent?: NativePrivateCurrentCheck): NativePrivateDirectoryReceipt;
  acquireSqliteLease?(path: string, expected: NativePrivateIdentity): NativePrivateSqliteLease;
}

export type PrivatePersistenceOptions = Readonly<{
  nativePrivateFilesystem?: NativePrivateFilesystemPort;
}>;

const context = new AsyncLocalStorage<PrivatePersistenceOptions>();

function invalid(cause?: unknown): SyncError {
  const error = new SyncError("private-persistence-port-invalid", 503);
  if (cause !== undefined) error.cause = cause;
  return error;
}

const METHODS = [
  "inspectDirectory",
  "inspectFile",
  "inspectFileIdentity",
  "read",
  "writeNew",
  "copyNew",
  "renameNew",
  "unlinkExact",
  "proveSync",
  "createDirectory",
  "snapshotSqlite",
] as const;

const OPTIONAL_METHODS = ["inspectTree", "renameDirectoryNew", "acquireSqliteLease"] as const;
type MethodName = (typeof METHODS)[number] | (typeof OPTIONAL_METHODS)[number];

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

const HASH = /^[0-9a-f]{64}$/;
const FILE_ID = /^[0-9a-fA-F]{32}$/;
const VOLUME_ID = /^[0-9a-fA-F]{16}$/;

function identityShape(value: unknown): NativePrivateIdentity {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "private-persistence-port-invalid",
    503,
  );
  const v = value as Record<string, unknown>;
  requireCondition(
    typeof v.path === "string" &&
      typeof v.fileId === "string" &&
      FILE_ID.test(v.fileId) &&
      typeof v.volumeId === "string" &&
      VOLUME_ID.test(v.volumeId),
    "private-persistence-port-invalid",
    503,
  );
  return Object.freeze({
    path: v.path,
    fileId: v.fileId,
    volumeId: v.volumeId,
  });
}

function fileShape(value: unknown): NativePrivateFile {
  const identity = identityShape(value);
  const v = value as Record<string, unknown>;
  requireCondition(
    typeof v.bytes === "number" &&
      Number.isSafeInteger(v.bytes) &&
      v.bytes >= 0 &&
      typeof v.sha256 === "string" &&
      HASH.test(v.sha256),
    "private-persistence-port-invalid",
    503,
  );
  return Object.freeze({ ...identity, bytes: v.bytes, sha256: v.sha256 });
}

function receiptShape(value: unknown): NativePrivateReceipt {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "private-persistence-port-invalid",
    503,
  );
  const v = value as Record<string, unknown>;
  requireCondition(
    v.profile === "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1" &&
      v.scope === "PROCESS_CRASH",
    "private-persistence-port-invalid",
    503,
  );
  return Object.freeze({
    profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1",
    scope: "PROCESS_CRASH",
    identity: fileShape(v.identity),
  });
}

function treeShape(value: unknown): NativePrivateTree {
  const file = fileShape(value);
  const entries = (value as Record<string, unknown>).entries;
  requireCondition(typeof entries === "number" && Number.isSafeInteger(entries) &&
    entries >= 1 && entries <= 4096 && file.bytes <= 256 * 1024 * 1024,
  "private-persistence-port-invalid", 503);
  return Object.freeze({ ...file, entries });
}

function syncMethod(method: unknown, receiver: unknown): (...args: unknown[]) => unknown {
  requireCondition(typeof method === "function" && !types.isAsyncFunction(method) &&
    !types.isGeneratorFunction(method), "private-persistence-port-invalid", 503);
  return (...args) => {
    const value: unknown = Reflect.apply(method as Function, receiver, args);
    if (isThenable(value)) { observe(value); throw invalid(); }
    requireCondition(value === undefined, "private-persistence-port-invalid", 503);
    return undefined;
  };
}

function leaseShape(value: unknown): NativePrivateSqliteLease {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value),
    "private-persistence-port-invalid", 503);
  const lease = value as NativePrivateSqliteLease;
  const assertHeld = syncMethod(lease.assertHeld, lease);
  const close = syncMethod(lease.close, lease);
  return Object.freeze({ assertHeld: () => { assertHeld(); }, close: () => { close(); } });
}

/**
 * Scope native private-persistence port selection for the duration of `work`,
 * including async continuations scheduled inside it. `undefined` inherits the
 * ambient context; an explicit options object replaces it for the nested
 * scope only and always wins over the inherited one.
 */
export function withPrivatePersistence<T>(
  options: PrivatePersistenceOptions | undefined,
  work: () => T,
): T {
  if (options === undefined) return work();
  requireCondition(
    options !== null && typeof options === "object" && !Array.isArray(options),
    "private-persistence-port-invalid",
    503,
  );
  return context.run(options, work);
}

/**
 * Resolve the configured native private filesystem port. Returns `undefined`
 * only when nothing is configured AND this is not a real win32 host: on a
 * real Windows build an unconfigured caller must fail closed rather than fall
 * through to POSIX semantics. A configured port is validated for synchronous
 * shape and wrapped in a frozen facade that revalidates every result; any
 * Promise/thenable, malformed identity, or weak durability claim rejects.
 */
export function privatePersistencePort(
  options?: PrivatePersistenceOptions,
): NativePrivateFilesystemPort | undefined {
  const selected = options !== undefined ? options : context.getStore();
  if (selected === undefined) {
    requireCondition(
      process.platform !== "win32",
      "private-persistence-port-required",
      503,
    );
    return undefined;
  }
  requireCondition(
    selected !== null &&
      typeof selected === "object" &&
      !Array.isArray(selected),
    "private-persistence-port-invalid",
    503,
  );
  const raw: unknown = selected.nativePrivateFilesystem;
  if (raw === undefined) {
    requireCondition(
      process.platform !== "win32",
      "private-persistence-port-required",
      503,
    );
    return undefined;
  }
  requireCondition(
    raw !== null && typeof raw === "object" && !Array.isArray(raw),
    "private-persistence-port-invalid",
    503,
  );
  const candidate = raw as Record<string, unknown>;
  requireCondition(
    candidate.platform === "win32" &&
      candidate.version === 1 &&
      candidate.synchronous === true,
    "private-persistence-port-invalid",
    503,
  );
  const bound = {} as Record<MethodName, (...args: never[]) => unknown>;
  for (const name of [...METHODS, ...OPTIONAL_METHODS]) {
    let method: unknown;
    try {
      method = candidate[name];
    } catch (error) {
      throw invalid(error);
    }
    if (method === undefined && (OPTIONAL_METHODS as readonly string[]).includes(name)) continue;
    requireCondition(
      typeof method === "function" &&
        !types.isAsyncFunction(method) &&
        !types.isGeneratorFunction(method),
      "private-persistence-port-invalid",
      503,
    );
    bound[name] = (method as (...args: never[]) => unknown).bind(raw);
  }
  const invoke = (
    name: MethodName,
    args: readonly unknown[],
    shape: (value: unknown) => unknown,
  ): never => {
    let result: unknown;
    try {
      result = Reflect.apply(bound[name], raw, args);
    } catch (error) {
      if (isThenable(error)) observe(error);
      throw error;
    }
    if (isThenable(result)) {
      observe(result);
      throw invalid();
    }
    return shape(result) as never;
  };
  const facade: NativePrivateFilesystemPort = {
    platform: "win32",
    version: 1,
    synchronous: true,
    inspectDirectory: (path) =>
      invoke("inspectDirectory", [path], identityShape) as NativePrivateIdentity,
    inspectFile: (path, maxBytes) =>
      invoke("inspectFile", [path, maxBytes], fileShape) as NativePrivateFile,
    inspectFileIdentity: (path) =>
      invoke("inspectFileIdentity", [path], identityShape) as NativePrivateIdentity,
    read: (path, expected, maxBytes) => {
      const result = invoke("read", [path, expected, maxBytes], (value) => {
        requireCondition(
          value instanceof Uint8Array,
          "private-persistence-port-invalid",
          503,
        );
        return value;
      }) as Uint8Array;
      return result;
    },
    writeNew: (path, bytes, maxBytes) =>
      invoke("writeNew", [path, bytes, maxBytes], receiptShape) as NativePrivateReceipt,
    copyNew: (source, destination, expected, maxBytes) =>
      invoke(
        "copyNew",
        [source, destination, expected, maxBytes],
        receiptShape,
      ) as NativePrivateReceipt,
    renameNew: (source, destination, expected, maxBytes) =>
      invoke(
        "renameNew",
        [source, destination, expected, maxBytes],
        receiptShape,
      ) as NativePrivateReceipt,
    unlinkExact: (path, expected, maxBytes) => {
      invoke("unlinkExact", [path, expected, maxBytes], (value) => {
        requireCondition(
          value === undefined,
          "private-persistence-port-invalid",
          503,
        );
        return value;
      });
    },
    proveSync: (path, expected) =>
      invoke("proveSync", [path, expected], receiptShape) as NativePrivateReceipt,
    createDirectory: (path) =>
      invoke("createDirectory", [path], identityShape) as NativePrivateIdentity,
    snapshotSqlite: (db, path) =>
      invoke("snapshotSqlite", [db, path], receiptShape) as NativePrivateReceipt,
  };
  if (Object.hasOwn(bound, "inspectTree")) facade.inspectTree = path =>
    invoke("inspectTree", [path], treeShape) as NativePrivateTree;
  if (Object.hasOwn(bound, "renameDirectoryNew")) facade.renameDirectoryNew = (source, destination, expected, check) => {
    const guarded = check === undefined ? undefined : syncMethod(check, undefined);
    return invoke("renameDirectoryNew", [source, destination, expected, guarded], value => {
      requireCondition(value !== null && typeof value === "object",
        "private-persistence-port-invalid", 503);
      const r = value as NativePrivateDirectoryReceipt;
      requireCondition(r.profile === "WINDOWS_LOCAL_NTFS_DIRECTORY_RENAME_V1" &&
        r.scope === "PROCESS_CRASH", "private-persistence-port-invalid", 503);
      return Object.freeze({ profile: r.profile, scope: r.scope, identity: treeShape(r.identity) });
    }) as NativePrivateDirectoryReceipt;
  };
  if (Object.hasOwn(bound, "acquireSqliteLease")) facade.acquireSqliteLease = (path, expected) =>
    invoke("acquireSqliteLease", [path, expected], leaseShape) as NativePrivateSqliteLease;
  return Object.freeze(facade);
}
