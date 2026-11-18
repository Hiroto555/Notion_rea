import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { lstatSync, opendirSync, statfsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { types as utilTypes } from "node:util";
import { SyncError } from "../../sync/protocol";
import type { PrivatePlatform } from "../../sync/private-platform";
import type { CheckpointServerHandle } from "../../sync/checkpoint-server";
import { DEFAULT_STORAGE_RESERVE_BYTES } from "../../shared/storage-pressure";
import {
  privatePersistencePort,
  withPrivatePersistence,
  type NativePrivateFile,
  type NativePrivateFilesystemPort,
  type NativePrivateIdentity,
  type NativePrivateReceipt,
} from "../private-persistence";
import { NativePrivatePersistenceError } from "./private-persistence";
import {
  asciiCaseFold,
  validateWindowsPath,
} from "./path-policy";
import {
  withPrivateAuthorityLease,
  withPrivateAuthorityLeaseForTesting,
  type AcquirePrivateAuthorityLease,
  type PrivateAuthorityLease,
} from "./authority-lease";

/**
 * Native Windows server adapter. This module is the ONLY native surface the
 * cross-platform operational-server facades consume: every filesystem fact is
 * proved through the K private-persistence port (NTFS file IDs, volume serials
 * and held-handle probes), every held SQLite scope goes through the C
 * authority-lease acquirer, and Node lstat/opendir/statfs are used strictly as
 * namespace/capacity hints — never as privacy or identity proof. There are no
 * uid/mode/dev/ino checks and no directory fsync on this branch.
 *
 * Trust boundary: injected ports are untrusted contract checks, not proof of
 * Windows filesystem safety. A mutation that cannot be proven after dispatch
 * is UNKNOWN: the adapter poisons and keeps the original error; it never
 * retries, deletes, or infers non-application from absence.
 */
export const WINDOWS_SERVER_NATIVE_TRUST_BOUNDARY =
  "Injected server native ports are untrusted contract checks, not Windows OS/filesystem acceptance.";

const ERROR_CODE = "server-native-unsafe";
const ERROR_STATUS = 409;
const FILE_ID = /^[0-9a-fA-F]{32}$/;
const VOLUME_ID = /^[0-9a-fA-F]{16}$/;
const LIST_CAP_SLACK = 64;
const LIST_CAP_MAX = 4096 + 1 + LIST_CAP_SLACK;
const SIDECARS = ["-wal", "-shm", "-journal"] as const;
// Unknown live scopes must outlive an async-local context that unwinds.
const retainedUnknownScopes = new Set<unknown>();

function fail(code: string = ERROR_CODE, status = ERROR_STATUS): never {
  throw new SyncError(code, status);
}

function unsafe(): never {
  fail(ERROR_CODE);
}

function isThenable(value: unknown): boolean {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  )
    return false;
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return true;
  }
}

function isAsyncLike(value: unknown): boolean {
  return (
    typeof value !== "function" ||
    utilTypes.isAsyncFunction(value) ||
    utilTypes.isGeneratorFunction(value)
  );
}

function observe(result: unknown): void {
  try {
    if (utilTypes.isPromise(result))
      Promise.prototype.then.call(result, undefined, () => undefined);
  } catch {
    /* Observation failure must never mask the rejection below. */
  }
}

const fold = asciiCaseFold;

function sameIdentity(
  left: NativePrivateIdentity,
  right: NativePrivateIdentity,
): boolean {
  return (
    fold(left.fileId) === fold(right.fileId) &&
    fold(left.volumeId) === fold(right.volumeId) &&
    fold(left.path) === fold(right.path)
  );
}

/** Lifecycle host injected by the parent for the native operational facade.
 * It owns the real checkpoint server construction AND its native blob
 * adapter, live SQLite protection, and request/current-auth fences; the
 * facade never instantiates the POSIX WorkspaceBlobStore on this branch.
 * Before ANY writable original SQLite open, the host must establish readonly
 * role/history/workspace binding, using H's disposable native snapshot for a
 * hot rollback journal; missing H capability fails closed without recovery.
 * `start` may legitimately be async (listener startup); it must resolve to
 * the FULL CheckpointServerHandle including `backup`. */
export type WindowsServerLifecycleHost = Readonly<{
  start(request: Readonly<{
    directory: string;
    databasePath: string;
    workspaces: readonly Readonly<{ workspaceId: string; ownerId: string }>[];
    port: number;
    assertCurrent(): void;
  }>): Promise<CheckpointServerHandle>;
}>;

export type WindowsServerNativeEnvironment = Readonly<{
  root: string;
  probeExecutable: string;
  expectedHash: string;
  systemRoot: string;
}>;

export type WindowsServerNativeOptions = Readonly<{
  /** Canonical Windows private root every adapted path must stay under. */
  root: string;
  /** K: the synchronous NTFS-identity filesystem port (validated here). */
  nativePrivateFilesystem: NativePrivateFilesystemPort;
  /** C: held native file lease acquirer for SQLite arbitration scopes. */
  acquireSqliteLease: AcquirePrivateAuthorityLease;
  /** Synchronous authority/cut/epoch revalidation; exact void required. */
  assertCurrent(): void;
  /** Persisted-source binding check; exact void required. */
  assertSourceIdentity(identity: NativePrivateIdentity): void;
  /** Persisted binding record for a confirmed-new output; exact void. */
  recordCreatedIdentity(identity: NativePrivateIdentity): void;
  /** Synchronous live native proof of the configured root's own identity.
   * The K port contract rejects root-path requests, so the parent MUST
   * supply this (e.g. WindowsRuntimePlatform.validatedDirectoryIdentity
   * refreshed on every call — never a Node stat or a cached boolean). The
   * returned path must equal the configured root; the first proven
   * fileId/volumeId pair is pinned and every later proof must match it.
   * The proof is also passed through the persisted-source binding check. */
  inspectRoot(): NativePrivateIdentity;
  /** Native lifecycle host for operational-server start/init; required by
   * the operational facade, unused by the file/config/lease facades. */
  lifecycleHost?: WindowsServerLifecycleHost;
}>;

export type WindowsServerNativeLeasePlatform = PrivatePlatform;

/** The facade-facing port. Every method is synchronous, revalidates
 * `assertCurrent` and the pinned parent/root native identity around its
 * dispatch, and returns detached frozen records. */
export interface WindowsServerNativePort {
  readonly platform: "win32";
  readonly trust: "native-owned-helper" | "untrusted-test";
  /** Canonical configured private root. */
  readonly root: string;
  readonly lifecycleHost: WindowsServerLifecycleHost | undefined;

  /** Scope the validated K port for ambient privatePersistencePort() users. */
  scope<T>(work: () => T): T;

  /** Canonicalize `path` under the configured root; path must equal its
   * canonical form and differ from the root unless `allowRoot`. */
  canonical(path: string, allowRoot?: boolean): string;
  /** Canonicalize any absolute Windows path (no containment requirement). */
  canonicalAbsolute(path: string): string;
  join(parent: string, name: string): string;
  parent(path: string): string;
  basename(path: string): string;
  samePath(a: string, b: string): boolean;
  /** Containment in either direction over canonical paths. */
  overlaps(a: string, b: string): boolean;
  sameIdentity(a: NativePrivateIdentity, b: NativePrivateIdentity): boolean;

  assertCurrent(): void;
  assertSourceIdentity(identity: NativePrivateIdentity): void;
  /** Permanently reject further dispatch after an uncertain mutation. */
  poison(error: unknown): never;
  /** Keep live resources held when safe ordered close cannot be proved. */
  retainUnknown(resource: unknown, error: unknown): never;

  inspectDirectory(path: string): NativePrivateIdentity;
  assertDirectory(path: string, pinned: NativePrivateIdentity): void;
  createDirectory(path: string): NativePrivateIdentity;
  inspectFile(path: string, maxBytes: number): NativePrivateFile;
  inspectFileIdentity(path: string): NativePrivateIdentity;
  assertFileIdentity(path: string, pinned: NativePrivateIdentity): void;
  readFile(
    path: string,
    expected: NativePrivateFile,
    maxBytes: number,
  ): Uint8Array;
  /** Exclusive create; EXISTS/UNKNOWN propagate, never retried. */
  writeNewFile(
    path: string,
    bytes: Uint8Array,
    maxBytes: number,
  ): NativePrivateFile;
  copyNewFile(
    source: string,
    destination: string,
    expected: NativePrivateFile,
    maxBytes: number,
  ): NativePrivateFile;
  proveSyncFile(path: string, expected: NativePrivateFile): NativePrivateFile;
  /** Delete only a previously pinned/inspected file (marker or explicit GC). */
  unlinkExact(path: string, expected: NativePrivateFile): void;
  /** Consistent VACUUM INTO through K under a C held lease. */
  snapshotSqlite(
    db: DatabaseSync,
    destination: string,
  ): NativePrivateReceipt;

  /** Namespace hint only: distinguishes ENOENT/ENOTDIR from arbitrary
   * errors and re-proves the parent native identity before/after. "absent"
   * is never proof that a dispatched mutation did not apply. */
  kindOf(path: string): "file" | "directory" | "absent" | "other";
  /** Bounded opendir namespace hint (cap max+1+64); every returned name is
   * validated but NOT natively proved — callers must prove each child. */
  listNames(path: string, maxNames: number): string[];
  /** statfs bigint capacity hint + reserve, wrapped in native parent proofs. */
  assertCapacity(directory: string, requiredBytes: number): void;

  /** Fresh K-backed PrivatePlatform wrapped with the C authority lease
   * (production-branded in production, explicitly untrusted on the test
   * seam). `createExclusive` acquires the held lease before any SQLite open. */
  authorityPlatform(): WindowsServerNativeLeasePlatform;
  /** Acquire a C held lease on an existing SQLite path for protected opens. */
  acquireSqliteLease(path: string): PrivateAuthorityLease;
}

function canonicalUnder(path: unknown, root: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 240 ||
    !/^[A-Za-z]:[\\/]/.test(path) ||
    path.includes("\0")
  )
    unsafe();
  let canonical: string;
  try {
    canonical = validateWindowsPath(path, root).canonical;
  } catch {
    unsafe();
  }
  if (canonical !== path) unsafe();
  return canonical;
}

function canonicalAbsolute(path: unknown): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 240 ||
    !/^[A-Za-z]:[\\/]/.test(path) ||
    path.includes("\0")
  )
    unsafe();
  let canonical: string;
  try {
    canonical = validateWindowsPath(path, `${path[0].toUpperCase()}:\\`)
      .canonical;
  } catch {
    unsafe();
  }
  if (canonical !== path) unsafe();
  return canonical;
}

function parentOf(path: string): string {
  const end = path.lastIndexOf("\\");
  return end === 2 ? path.slice(0, 3) : path.slice(0, end);
}

function overlaps(a: string, b: string): boolean {
  const left = fold(a).replace(/\\$/, "");
  const right = fold(b).replace(/\\$/, "");
  return (
    left === right || left.startsWith(`${right}\\`) || right.startsWith(`${left}\\`)
  );
}

function identityShape(value: unknown): NativePrivateIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    unsafe();
  const v = value as Record<string, unknown>;
  if (
    typeof v.path !== "string" ||
    typeof v.fileId !== "string" ||
    !FILE_ID.test(v.fileId) ||
    typeof v.volumeId !== "string" ||
    !VOLUME_ID.test(v.volumeId)
  )
    unsafe();
  return Object.freeze({ path: v.path, fileId: v.fileId, volumeId: v.volumeId });
}

function create(
  options: WindowsServerNativeOptions,
  trust: "native-owned-helper" | "untrusted-test",
): WindowsServerNativePort {
  if (options === null || typeof options !== "object" || Array.isArray(options))
    unsafe();
  const root = canonicalAbsolute(options.root);
  const rawK = options.nativePrivateFilesystem;
  const k = privatePersistencePort({ nativePrivateFilesystem: rawK });
  if (k === undefined) unsafe();
  if (
    isAsyncLike(options.acquireSqliteLease) ||
    isAsyncLike(options.assertCurrent) ||
    isAsyncLike(options.assertSourceIdentity) ||
    isAsyncLike(options.recordCreatedIdentity) ||
    isAsyncLike(options.inspectRoot)
  )
    unsafe();
  // Keep the ORIGINAL branded acquirer reference: withPrivateAuthorityLease
  // verifies the module-local WeakSet brand, and a .bind() wrapper would
  // silently drop it — the production factory could then never prove the
  // owned helper stood in for the C lease.
  const acquireSqliteLease = options.acquireSqliteLease;
  const assertCurrentCb = options.assertCurrent.bind(options);
  const assertSourceCb = options.assertSourceIdentity.bind(options);
  const recordCreatedCb = options.recordCreatedIdentity.bind(options);
  const inspectRootCb = options.inspectRoot.bind(options);
  const host = options.lifecycleHost;
  if (host !== undefined) {
    // host.start legitimately returns a promise (async listener startup);
    // only its callable shape is a contract point.
    if (
      host === null ||
      typeof host !== "object" ||
      typeof host.start !== "function" ||
      utilTypes.isGeneratorFunction(host.start)
    )
      unsafe();
  }

  /** Post-dispatch proof failures poison the adapter permanently; the
   * original error and any K UNKNOWN evidence are preserved, never retried. */
  let poisoned: unknown;
  let hasPoison = false;
  const poison = (error: unknown): never => {
    if (!hasPoison) { poisoned = error; hasPoison = true; }
    throw poisoned;
  };
  const retainUnknown = (resource: unknown, error: unknown): never => {
    retainedUnknownScopes.add({ resource, error });
    if (!hasPoison) { poisoned = error; hasPoison = true; }
    throw error;
  };

  /** Exact synchronous void contract: the callback's own throw propagates;
   * any value — including a thenable — is a contract violation. */
  const syncVoid = (call: () => unknown, code = ERROR_CODE): void => {
    const outcome: unknown = call();
    if (utilTypes.isPromise(outcome)) observe(outcome);
    if (outcome !== undefined || isThenable(outcome)) fail(code);
  };

  const checkCurrent = (): void => {
    if (hasPoison) throw poisoned;
    syncVoid(() => assertCurrentCb());
  };

  const recordCreated = (identity: NativePrivateIdentity): void => {
    try {
      syncVoid(() => recordCreatedCb(identityShape(identity)));
    } catch (error) {
      // Recording failure after a confirmed-new dispatch is ambiguous.
      poison(error);
    }
  };

  const dispatch = <T>(mutating: boolean, call: () => T): T => {
    if (hasPoison) throw poisoned;
    checkCurrent();
    let result: T;
    try {
      result = call();
    } catch (error) {
      if (
        mutating &&
        (!(error instanceof NativePrivatePersistenceError) ||
          error.state === "UNKNOWN")
      )
        poison(error);
      throw error;
    }
    if (isThenable(result)) {
      observe(result);
      try {
        fail(ERROR_CODE);
      } catch (error) {
        return poison(error);
      }
    }
    try {
      checkCurrent();
    } catch (error) {
      // A mutation whose after-dispatch revalidation failed is UNKNOWN:
      // poison stably and preserve the original error, never resend/delete.
      if (mutating) return poison(error);
      throw error;
    }
    return result;
  };

  /** Persisted-source binding on ordinary reads: every identity the facade
   * observes must already be a bound source (or a confirmed-new output the
   * adapter itself recorded). */
  const bindSource = (identity: NativePrivateIdentity): void => {
    syncVoid(() => assertSourceCb(identityShape(identity)));
  };

  /** The configured root's own identity. The K port contract rejects
   * root-path requests outright, so the parent's live native proof is
   * pinned on first use and must stay byte-identical afterwards. */
  let pinnedRoot: NativePrivateIdentity | undefined;
  const inspectRootIdentity = (): NativePrivateIdentity =>
    dispatch(false, () => {
      const result = inspectRootCb();
      if (isThenable(result)) { observe(result); unsafe(); }
      const identity = identityShape(result);
      if (fold(identity.path) !== fold(root)) unsafe();
      const detached = Object.freeze({
        path: root,
        fileId: identity.fileId,
        volumeId: identity.volumeId,
      });
      syncVoid(() => assertSourceCb(detached));
      if (pinnedRoot === undefined) pinnedRoot = detached;
      else if (!sameIdentity(pinnedRoot, detached)) unsafe();
      return pinnedRoot;
    });

  const provePath = <T extends NativePrivateIdentity>(identity: T, path: string): T => {
    const rootIdentity = inspectRootIdentity();
    if (fold(identity.path) !== fold(path) ||
        fold(identity.volumeId) !== fold(rootIdentity.volumeId)) unsafe();
    return identity;
  };
  const sameFile = (left: NativePrivateFile, right: NativePrivateFile): boolean =>
    sameIdentity(left, right) && left.bytes === right.bytes && left.sha256 === right.sha256;
  const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

  const canonical = (path: unknown, allowRoot = false): string => {
    const p = canonicalUnder(path, root);
    if (!allowRoot && fold(p) === fold(root)) unsafe();
    return p;
  };

  const join = (parent: string, name: string): string => {
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.includes("\\") ||
      name.includes("/") ||
      name.includes("\0")
    )
      unsafe();
    const base = canonical(parent, true);
    return canonical(base.endsWith("\\") ? `${base}${name}` : `${base}\\${name}`);
  };

  const inspectDirectory = (path: unknown): NativePrivateIdentity => {
    const p = canonical(path, true);
    if (fold(p) === fold(root)) return inspectRootIdentity();
    return dispatch(false, () => {
      inspectRootIdentity();
      const identity = provePath(identityShape(k.inspectDirectory(p)), p);
      bindSource(identity);
      return identity;
    });
  };

  const assertDirectory = (
    path: unknown,
    pinned: NativePrivateIdentity,
  ): void => {
    const current = inspectDirectory(path);
    if (!sameIdentity(current, identityShape(pinned))) unsafe();
  };

  const inspectFile = (path: unknown, maxBytes: number): NativePrivateFile =>
    dispatch(false, () => {
      if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) < 0) unsafe();
      const p = canonical(path);
      inspectRootIdentity();
      const file = provePath(k.inspectFile(p, maxBytes as number), p);
      if (file.bytes > maxBytes) unsafe();
      bindSource(file);
      return file;
    });

  const inspectFileIdentity = (path: unknown): NativePrivateIdentity =>
    dispatch(false, () => {
      const p = canonical(path);
      inspectRootIdentity();
      const identity = provePath(identityShape(k.inspectFileIdentity(p)), p);
      bindSource(identity);
      return identity;
    });

  const assertFileIdentity = (
    path: unknown,
    pinned: NativePrivateIdentity,
  ): void => {
    const current = inspectFileIdentity(path);
    if (!sameIdentity(current, identityShape(pinned))) unsafe();
  };

  const kindOf = (path: unknown): "file" | "directory" | "absent" | "other" => {
    const p = canonical(path);
    const parent = inspectDirectory(parentOf(p));
    let stat;
    try {
      stat = lstatSync(p);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        assertDirectory(parentOf(p), parent);
        return "absent";
      }
      unsafe();
    }
    assertDirectory(parentOf(p), parent);
    if (stat.isSymbolicLink()) return "other";
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "other";
  };

  const listNames = (path: unknown, maxNames: number): string[] => {
    const p = canonical(path, true);
    if (
      !Number.isSafeInteger(maxNames) ||
      (maxNames as number) < 0 ||
      (maxNames as number) > LIST_CAP_MAX
    )
      unsafe();
    const cap = (maxNames as number) + LIST_CAP_SLACK;
    const dirId = inspectDirectory(p);
    let dir;
    try {
      dir = opendirSync(p);
    } catch {
      unsafe();
    }
    const names: string[] = [];
    try {
      for (;;) {
        let entry;
        try {
          entry = dir.readSync();
        } catch {
          unsafe();
        }
        if (entry === null) break;
        if (names.length >= cap) unsafe();
        const name = entry.name;
        if (
          typeof name !== "string" ||
          name.length === 0 ||
          name.length > 255 ||
          name === "." ||
          name === ".." ||
          name.includes("\\") ||
          name.includes("/") ||
          name.includes("\0")
        )
          unsafe();
        names.push(name);
      }
    } finally {
      try {
        dir.closeSync();
      } catch {
        // A completed bounded listing is not invalidated by a close failure.
      }
    }
    assertDirectory(p, dirId);
    return names;
  };

  const assertCapacity = (directory: unknown, requiredBytes: number): void => {
    const p = canonical(directory, true);
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) unsafe();
    const before = inspectDirectory(p);
    let stat;
    try {
      stat = statfsSync(p, { bigint: true });
    } catch {
      unsafe();
    }
    if (
      stat.bsize <= 0n ||
      stat.bavail < 0n ||
      stat.bsize * stat.bavail <
        BigInt(requiredBytes) + BigInt(DEFAULT_STORAGE_RESERVE_BYTES)
    )
      fail("insufficient-storage", 507);
    assertDirectory(p, before);
  };

  const writeNewFile = (
    path: unknown,
    bytes: Uint8Array,
    maxBytes: number,
  ): NativePrivateFile => {
    const p = canonical(path);
    if (!(bytes instanceof Uint8Array)) unsafe();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) unsafe();
    if (bytes.byteLength > maxBytes) unsafe();
    const data = new Uint8Array(bytes);
    const expectedHash = hash(data);
    const parent = inspectDirectory(parentOf(p));
    const receipt = dispatch(true, () => k.writeNew(p, data, maxBytes));
    // Everything below is post-dispatch: any proof failure poisons stably
    // and preserves the original error; nothing is resent or deleted.
    try {
      const identity = provePath(receipt.identity, p);
      if (identity.bytes !== data.byteLength || identity.sha256 !== expectedHash) unsafe();
      recordCreated(identity);
      if (!sameFile(inspectFile(p, maxBytes), identity)) unsafe();
      assertDirectory(parentOf(p), parent);
      return identity;
    } catch (error) {
      return poison(error);
    }
  };

  const copyNewFile = (
    source: unknown,
    destination: unknown,
    expected: NativePrivateFile,
    maxBytes: number,
  ): NativePrivateFile => {
    const src = canonical(source);
    const dest = canonical(destination);
    const want = { ...expected, path: canonical(expected.path) };
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) unsafe();
    // The declared expected-source path must equal the actual source path.
    if (fold(want.path) !== fold(src)) unsafe();
    const sourcePin = inspectFile(src, maxBytes);
    if (
      !sameIdentity(sourcePin, want) ||
      sourcePin.bytes !== want.bytes ||
      sourcePin.sha256 !== want.sha256
    )
      unsafe();
    const parent = inspectDirectory(parentOf(dest));
    const receipt = dispatch(true, () => k.copyNew(src, dest, want, maxBytes));
    try {
      const identity = provePath(receipt.identity, dest);
      if (identity.bytes !== want.bytes || identity.sha256 !== want.sha256)
        unsafe();
      recordCreated(identity);
      if (!sameFile(inspectFile(dest, maxBytes), identity) ||
          !sameFile(inspectFile(src, maxBytes), sourcePin)) unsafe();
      assertDirectory(parentOf(dest), parent);
      return identity;
    } catch (error) {
      return poison(error);
    }
  };

  const proveSyncFile = (
    path: unknown,
    expected: NativePrivateFile,
  ): NativePrivateFile => {
    const p = canonical(path);
    const want = { ...expected, path: canonical(expected.path) };
    if (fold(want.path) !== fold(p)) unsafe();
    const parent = inspectDirectory(parentOf(p));
    if (!sameFile(inspectFile(p, want.bytes), want)) unsafe();
    const receipt = dispatch(true, () => k.proveSync(p, want));
    try {
      const identity = provePath(receipt.identity, p);
      if (
        !sameIdentity(identity, want) ||
        identity.bytes !== want.bytes ||
        identity.sha256 !== want.sha256
      )
        unsafe();
      if (!sameFile(inspectFile(p, want.bytes), want)) unsafe();
      assertDirectory(parentOf(p), parent);
      return identity;
    } catch (error) {
      return poison(error);
    }
  };

  const unlinkExact = (path: unknown, expected: NativePrivateFile): void => {
    const p = canonical(path);
    const want = { ...expected, path: canonical(expected.path) };
    if (fold(want.path) !== fold(p)) unsafe();
    const parent = inspectDirectory(parentOf(p));
    if (!sameFile(inspectFile(p, want.bytes), want)) unsafe();
    dispatch(true, () => {
      k.unlinkExact(p, want, want.bytes);
      return undefined;
    });
    try {
      assertDirectory(parentOf(p), parent);
    } catch (error) {
      poison(error);
    }
  };

  const readFile = (
    path: unknown,
    expected: NativePrivateFile,
    maxBytes: number,
  ): Uint8Array =>
    dispatch(false, () => {
      const p = canonical(path);
      const want = { ...expected, path: canonical(expected.path) };
      if (fold(want.path) !== fold(p)) unsafe();
      if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) < 0) unsafe();
      bindSource(want);
      inspectRootIdentity();
      const bytes = new Uint8Array(k.read(p, want, maxBytes as number));
      if (bytes.byteLength !== want.bytes || hash(bytes) !== want.sha256) unsafe();
      if (!sameFile(inspectFile(p, maxBytes), want)) unsafe();
      return bytes;
    });

  const createDirectory = (path: unknown): NativePrivateIdentity => {
    const p = canonical(path);
    const parent = inspectDirectory(parentOf(p));
    const identity = dispatch(true, () => identityShape(k.createDirectory(p)));
    try {
      provePath(identity, p);
      recordCreated(identity);
      if (!sameIdentity(inspectDirectory(p), identity)) unsafe();
      assertDirectory(parentOf(p), parent);
      return identity;
    } catch (error) {
      return poison(error);
    }
  };

  const snapshotSqlite = (
    db: DatabaseSync,
    destination: unknown,
  ): NativePrivateReceipt => {
    const dest = canonical(destination);
    const parent = inspectDirectory(parentOf(dest));
    const receipt = dispatch(true, () => k.snapshotSqlite(db, dest));
    // The snapshot is a confirmed-new output: record its persisted binding
    // exactly like an exclusive create.
    try {
      provePath(receipt.identity, dest);
      recordCreated(receipt.identity);
      if (!sameFile(inspectFile(dest, receipt.identity.bytes), receipt.identity)) unsafe();
      assertDirectory(parentOf(dest), parent);
      return receipt;
    } catch (error) {
      return poison(error);
    }
  };

  const checkLease = (value: unknown, path: string, identity: NativePrivateIdentity): PrivateAuthorityLease => {
    if (
      isThenable(value) ||
      value === null ||
      typeof value !== "object" ||
      isAsyncLike((value as PrivateAuthorityLease).assertHeld) ||
      isAsyncLike((value as PrivateAuthorityLease).close)
    ) {
      observe(value);
      unsafe();
    }
    const lease = value as PrivateAuthorityLease;
    // The port's trust label is bound at mint time; a mismatched held scope
    // can never silently stand in for the expected branding.
    if (lease.trust !== trust) unsafe();
    const assertHeld = lease.assertHeld.bind(lease);
    const close = lease.close.bind(lease);
    let closed = false;
    let closeFailed = false;
    let closeError: unknown;
    const held: PrivateAuthorityLease = Object.freeze({
      trust: lease.trust,
      assertHeld(): void {
        // Held scopes also re-prove the ambient authority/current guards.
        if (closed || closeFailed) unsafe();
        checkCurrent();
        let outcome: unknown;
        try {
          outcome = assertHeld();
        } catch (error) {
          throw error;
        }
        if (utilTypes.isPromise(outcome)) observe(outcome);
        if (outcome !== undefined || isThenable(outcome)) unsafe();
        assertFileIdentity(path, identity);
        checkCurrent();
      },
      close(): void {
        if (closeFailed) throw closeError;
        if (closed) return;
        let outcome: unknown;
        try {
          outcome = close();
          if (utilTypes.isPromise(outcome)) observe(outcome);
          if (outcome !== undefined || isThenable(outcome)) unsafe();
          closed = true;
        } catch (error) {
          closeFailed = true;
          closeError = error;
          return retainUnknown(lease, error);
        }
      },
    });
    held.assertHeld();
    return held;
  };

  const acquireLease = (path: unknown): PrivateAuthorityLease => {
    const p = canonical(path);
    checkCurrent();
    const identity = inspectFileIdentity(p);
    const acquired = acquireSqliteLease(p);
    try {
      const lease = checkLease(acquired, p, identity);
      lease.assertHeld();
      return lease;
    } catch (error) {
      return retainUnknown(acquired, error);
    }
  };

  /** K-backed inner PrivatePlatform: bind pins the root directory identity;
   * createExclusive is create-or-pin (exclusive create only when the
   * namespace hint reports absent; an EXISTS race fails without retry). */
  const innerPlatform = (): PrivatePlatform => {
    let bound: NativePrivateIdentity | undefined;
    const files = new Map<string, NativePrivateIdentity>();
    let closed = false;
    const requireBound = (): NativePrivateIdentity => {
      if (closed) unsafe();
      if (bound === undefined) unsafe();
      return bound;
    };
    const pin = (identity: NativePrivateIdentity): NativePrivateIdentity => {
      const key = fold(identity.path);
      const prior = files.get(key);
      if (prior !== undefined && !sameIdentity(prior, identity)) unsafe();
      const detached = identityShape(identity);
      files.set(key, detached);
      return detached;
    };
    return Object.freeze({
      kind: "windows" as const,
      bind(directory: string): string {
        if (closed) unsafe();
        if (bound !== undefined) unsafe();
        const identity = inspectDirectory(directory);
        bound = identityShape(identity);
        return identity.path;
      },
      assertRoot(): void {
        const rootPin = requireBound();
        assertDirectory(rootPin.path, rootPin);
      },
      assertFile(path: string): void {
        requireBound();
        pin(inspectFileIdentity(path));
      },
      assertSidecars(path: string): void {
        requireBound();
        for (const suffix of SIDECARS) {
          const kind = kindOf(`${path}${suffix}`);
          if (kind === "file") {
            pin(inspectFileIdentity(`${path}${suffix}`));
          } else if (kind !== "absent") {
            unsafe();
          }
        }
      },
      createExclusive(path: string): void {
        const rootPin = requireBound();
        const p = canonical(path);
        if (fold(parentOf(p)) !== fold(rootPin.path)) unsafe();
        const kind = kindOf(p);
        if (kind === "absent") {
          pin(writeNewFile(p, new Uint8Array(0), 1024 * 1024));
          return;
        }
        if (kind !== "file") unsafe();
        pin(inspectFile(p, 1024 * 1024));
      },
      assertEmptyFile(path: string): void {
        requireBound();
        const file = inspectFile(path, 1024 * 1024);
        if (file.bytes !== 0) unsafe();
        pin(file);
      },
      close(): void {
        closed = true;
        files.clear();
        bound = undefined;
      },
    });
  };

  const authorityPlatform = (): WindowsServerNativeLeasePlatform => {
    const inner = innerPlatform();
    if (trust === "native-owned-helper")
      return withPrivateAuthorityLease(inner, acquireSqliteLease);
    return withPrivateAuthorityLeaseForTesting(inner, acquireSqliteLease);
  };

  if (trust === "native-owned-helper") {
    // Production requires the ORIGINAL branded acquirer at mint time, not
    // just inside authorityPlatform(): withPrivateAuthorityLease checks the
    // module-local WeakSet and throws for any caller-chosen stand-in. The
    // wrapper result is discarded; authorityPlatform() re-wraps per call.
    withPrivateAuthorityLease(innerPlatform(), acquireSqliteLease);
  }

  return Object.freeze({
    platform: "win32" as const,
    trust,
    root,
    lifecycleHost: host === undefined ? undefined : Object.freeze({ start: host.start.bind(host) }),
    scope<T>(work: () => T): T {
      return withPrivatePersistence({ nativePrivateFilesystem: k }, work);
    },
    canonical,
    canonicalAbsolute,
    join,
    parent: (path: string) => parentOf(canonical(path)),
    basename: (path: string) => {
      const p = canonical(path);
      return p.slice(p.lastIndexOf("\\") + 1);
    },
    samePath: (a: string, b: string) => fold(a) === fold(b),
    overlaps,
    sameIdentity,
    assertCurrent: checkCurrent,
    poison,
    retainUnknown,
    assertSourceIdentity(identity: NativePrivateIdentity): void {
      checkCurrent();
      const detached = identityShape(identity);
      provePath(detached, canonical(detached.path, true));
      bindSource(detached);
    },
    inspectDirectory,
    assertDirectory,
    createDirectory,
    inspectFile,
    inspectFileIdentity,
    assertFileIdentity,
    readFile,
    writeNewFile,
    copyNewFile,
    proveSyncFile,
    unlinkExact,
    snapshotSqlite,
    kindOf,
    listNames,
    assertCapacity,
    authorityPlatform,
    acquireSqliteLease: acquireLease,
  });
}

const minted = new WeakSet<WindowsServerNativePort>();
const context = new AsyncLocalStorage<WindowsServerNativePort>();

/**
 * Production factory: only a real win32 host may mint the trusted port. The
 * injected C acquirer must be the branded output of
 * createNativeAuthorityLeaseAcquirer; withPrivateAuthorityLease re-verifies
 * that brand on every lease acquisition.
 */
export function createWindowsServerNative(
  options: WindowsServerNativeOptions,
): WindowsServerNativePort {
  if (process.platform !== "win32") fail("server-native-platform", 503);
  const port = create(options, "native-owned-helper");
  minted.add(port);
  return port;
}

/**
 * Explicit contract-only seam for non-Windows driver simulations. It is
 * labelled untrusted, forbidden on a real win32 host, and never constitutes
 * Windows OS acceptance evidence.
 */
export function createWindowsServerNativeForTesting(
  options: WindowsServerNativeOptions,
): WindowsServerNativePort {
  if (process.platform === "win32") fail("server-native-platform", 503);
  const port = create(options, "untrusted-test");
  minted.add(port);
  return port;
}

/**
 * Scope the minted adapter for the duration of `work`, including async
 * continuations scheduled inside it. Only ports created by the two factories
 * are accepted; `undefined` inherits/leaves the ambient context.
 */
export function withWindowsServerNative<T>(
  port: WindowsServerNativePort | undefined,
  work: () => T,
): T {
  if (port === undefined) return work();
  if (!minted.has(port)) unsafe();
  return context.run(port, work);
}

/** Resolve the ambient adapter. `undefined` means POSIX delegation; on a
 * real win32 host the POSIX originals fail closed by themselves. */
export function windowsServerNative(): WindowsServerNativePort | undefined {
  return context.getStore();
}

export type NativeServerFailure = { readonly error: unknown };

/** Never retry an ambiguous close, even when a surrounding finally unwinds. */
export function onceNativeServerClose(
  native: WindowsServerNativePort,
  close: () => void,
): () => void {
  let state: "open" | "closed" | "failed" = "open";
  let failure: unknown;
  return () => {
    if (state === "failed") throw failure;
    if (state === "closed") return;
    try {
      const result: unknown = close();
      if (utilTypes.isPromise(result)) observe(result);
      if (result !== undefined) unsafe();
      state = "closed";
    }
    catch (error) {
      state = "failed";
      failure = error;
      native.retainUnknown(close, error);
    }
  };
}

/** Parts are ordered inner-to-outer. Do not release a protector after an
 * unconfirmed inner close; preserve both primary and cleanup evidence. */
export function closeNativeServerResources(
  native: WindowsServerNativePort,
  parts: readonly (() => void)[],
  primary?: NativeServerFailure,
): void {
  for (const part of parts) {
    try {
      if (isAsyncLike(part)) unsafe();
      const result: unknown = part();
      if (utilTypes.isPromise(result)) observe(result);
      if (result !== undefined) unsafe();
    }
    catch (cleanup) {
      native.retainUnknown(parts, primary === undefined ? cleanup :
        new AggregateError([primary.error, cleanup], "native server operation and close failed"));
    }
  }
  if (primary !== undefined) throw primary.error;
}

/** Parse only the shared helper configuration from the environment. The
 * remaining dependencies (K port, C acquirer, authority callbacks, lifecycle
 * host) are declared injected inputs of WindowsServerNativeOptions and are
 * never read from env. */
export function windowsServerConfigFromEnvironment(
  env: NodeJS.ProcessEnv,
): WindowsServerNativeEnvironment | undefined {
  const values = [
    env.FOLIO_WINDOWS_NATIVE_ROOT,
    env.FOLIO_WINDOWS_NATIVE_PROBE,
    env.FOLIO_WINDOWS_NATIVE_SHA256,
  ];
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => !value)) unsafe();
  return Object.freeze({
    root: values[0]!,
    probeExecutable: values[1]!,
    expectedHash: values[2]!,
    systemRoot: env.SystemRoot ?? "C:\\Windows",
  });
}
