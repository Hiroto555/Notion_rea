import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SyncError } from "./protocol";
import { syncPath } from "../persistence/durable-file";
import {
  windowsServerNative,
  onceNativeServerClose,
  closeNativeServerResources,
  type NativeServerFailure,
} from "../platform/windows/server-native";

const LOCK_NAME = ".folio-server-lock.sqlite";
const MAX_LOCK_BYTES = 1024 * 1024;

export type ServerDirectoryLease = {
  readonly directory: string;
  close(): void;
  assertOwned(): void;
};

type RootPin = { path: string; dev: number; ino: number };
type LockPin = {
  path: string;
  root: RootPin;
  dev: number;
  ino: number;
  fd: number;
};

function unsafe(): never {
  throw new SyncError("server-maintenance-unsafe", 409);
}

function busy(): never {
  throw new SyncError("server-maintenance-busy", 409);
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function closeQuietly(descriptor: number | undefined): void {
  if (descriptor === undefined) return;
  try {
    closeSync(descriptor);
  } catch {}
}

function ownUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertRootStat(stat: Stats): void {
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (stat.mode & 0o777) !== 0o700
  )
    unsafe();
  const uid = ownUid();
  if (uid !== undefined && stat.uid !== uid) unsafe();
}

function pinRoot(directory: string): RootPin {
  if (typeof directory !== "string" || directory.length === 0) unsafe();
  let absolute: string;
  try {
    absolute = resolve(directory);
  } catch {
    unsafe();
  }
  let listed: Stats;
  try {
    listed = lstatSync(absolute);
  } catch {
    unsafe();
  }
  if (listed.isSymbolicLink() || !listed.isDirectory()) unsafe();
  let path: string;
  try {
    path = realpathSync(absolute);
  } catch {
    unsafe();
  }
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    unsafe();
  }
  if (stat.dev !== listed.dev || stat.ino !== listed.ino) unsafe();
  assertRootStat(stat);
  return { path, dev: stat.dev, ino: stat.ino };
}

function assertRoot(pin: RootPin): void {
  let stat: Stats;
  try {
    stat = lstatSync(pin.path);
  } catch {
    unsafe();
  }
  if (stat.dev !== pin.dev || stat.ino !== pin.ino) unsafe();
  assertRootStat(stat);
}

function assertLockStat(stat: Stats): void {
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > MAX_LOCK_BYTES
  )
    unsafe();
  const uid = ownUid();
  if (uid !== undefined && stat.uid !== uid) unsafe();
}

function openLockFile(path: string): { fd: number; created: boolean } {
  try {
    return {
      fd: openSync(path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK),
      created: false,
    };
  } catch (error) {
    if (errorCode(error) !== "ENOENT") unsafe();
  }
  try {
    return {
      fd: openSync(
        path,
        fsConstants.O_RDWR |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      ),
      created: true,
    };
  } catch (error) {
    if (errorCode(error) !== "EEXIST") unsafe();
  }
  try {
    return {
      fd: openSync(path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK),
      created: false,
    };
  } catch {
    unsafe();
  }
}

function openLock(root: RootPin): LockPin {
  const path = join(root.path, LOCK_NAME);
  const opened = openLockFile(path);
  const descriptor = opened.fd;
  try {
    const fdStat = fstatSync(descriptor);
    assertLockStat(fdStat);
    const pathStat = lstatSync(path);
    assertLockStat(pathStat);
    if (pathStat.dev !== fdStat.dev || pathStat.ino !== fdStat.ino) unsafe();
    if (opened.created) {
      fsyncSync(descriptor); syncPath(root.path);
      assertRoot(root);
      const after = lstatSync(path);
      assertLockStat(after);
      if (after.dev !== fdStat.dev || after.ino !== fdStat.ino) unsafe();
    }
    return { path, root, dev: fdStat.dev, ino: fdStat.ino, fd: descriptor };
  } catch (error) {
    closeQuietly(descriptor);
    throw error;
  }
}

function assertLock(pin: LockPin): void {
  let fdStat: Stats;
  try {
    fdStat = fstatSync(pin.fd);
  } catch {
    unsafe();
  }
  assertLockStat(fdStat);
  if (fdStat.dev !== pin.dev || fdStat.ino !== pin.ino) unsafe();
  let pathStat: Stats;
  try {
    pathStat = lstatSync(pin.path);
  } catch {
    unsafe();
  }
  assertLockStat(pathStat);
  if (pathStat.dev !== pin.dev || pathStat.ino !== pin.ino) unsafe();
}

function isBusy(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const value = error as {
    errcode?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (value.errcode === 5 || value.errcode === 6) return true;
  if (value.code === "SQLITE_BUSY" || value.code === "SQLITE_LOCKED")
    return true;
  return (
    typeof value.message === "string" &&
    /(?:database|table) is locked|SQLITE_(?:BUSY|LOCKED)/i.test(value.message)
  );
}

function isTransactionActive(database: DatabaseSync): boolean {
  try {
    return database.isTransaction === true;
  } catch {
    return false;
  }
}

function closeDatabase(database: DatabaseSync): void {
  if (isTransactionActive(database)) {
    try {
      database.exec("ROLLBACK");
    } catch {}
  }
  try {
    database.close();
  } catch {}
}

function openDatabase(path: string): DatabaseSync {
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path);
  } catch {
    unsafe();
  }
  try {
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec("PRAGMA synchronous = FULL");
    database.exec("BEGIN EXCLUSIVE");
    if (!isTransactionActive(database)) unsafe();
    return database;
  } catch (error) {
    closeDatabase(database);
    if (error instanceof SyncError) throw error;
    if (isBusy(error)) busy();
    unsafe();
  }
}

function assertDatabase(database: DatabaseSync): void {
  let open: unknown;
  try {
    open = database.isOpen;
  } catch {
    unsafe();
  }
  if (open !== true) unsafe();
  if (!isTransactionActive(database)) unsafe();
}

function createLease(
  pin: LockPin,
  database: DatabaseSync,
): ServerDirectoryLease {
  let closed = false;
  return {
    directory: pin.root.path,
    assertOwned(): void {
      if (closed) unsafe();
      assertRoot(pin.root);
      assertLock(pin);
      assertDatabase(database);
      assertRoot(pin.root);
      assertLock(pin);
    },
    close(): void {
      if (closed) return;
      closed = true;
      const errors: unknown[] = [];
      if (isTransactionActive(database)) {
        try {
          database.exec("ROLLBACK");
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        database.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        closeSync(pin.fd);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1)
        throw new AggregateError(
          errors,
          "server directory lease close failed",
        );
    },
  };
}

/**
 * Windows branch: the lock file is created-or-pinned once through the
 * authority platform (its createExclusive acquires the held C lease before
 * any SQLite open; an EXISTS race fails without retry), then a real SQLite
 * BEGIN EXCLUSIVE on the same file provides cross-process directory
 * exclusion. assertOwned re-proves root + lock native identities, the held
 * C scope, and the transaction on every assert. The database always closes
 * before the C handle; close failures are aggregated and an unknown close
 * outcome stays a stable failure — never silent success or a retry.
 */
function acquireNativeLease(directory: string): ServerDirectoryLease {
  const native = windowsServerNative()!;
  const path = native.canonical(directory);
  const platform = native.authorityPlatform();
  let database: DatabaseSync | undefined;
  let opening = false;
  let closeDatabaseNative: (() => void) | undefined;
  const closePlatform = onceNativeServerClose(native, () => {
    native.assertCurrent();
    platform.close();
  });
  try {
    platform.bind(path);
    const lockPath = native.join(path, LOCK_NAME);
    platform.createExclusive(lockPath);
    platform.assertRoot();
    platform.assertFile(lockPath);
    platform.assertSidecars(lockPath);
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      const sidecar = `${lockPath}${suffix}`;
      const kind = native.kindOf(sidecar);
      if (kind === "absent") continue;
      if (kind !== "file") unsafe();
      // Lock databases contain no product records. Refuse hot sidecars rather
      // than recover an uninspected original to acquire directory authority.
      if (native.inspectFile(sidecar, MAX_LOCK_BYTES).bytes !== 0)
        throw new SyncError("server-recovery-required", 409);
    }
    if (native.inspectFile(lockPath, MAX_LOCK_BYTES).bytes > 0) {
      opening = true;
      const check = new DatabaseSync(lockPath, { readOnly: true });
      opening = false;
      let primary: NativeServerFailure | undefined;
      try {
        check.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0");
        if (check.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all().length !== 0) unsafe();
        platform.assertRoot();
        platform.assertFile(lockPath);
      } catch (error) { primary = { error }; }
      closeNativeServerResources(native, [onceNativeServerClose(native, () => check.close())], primary);
    }
    opening = true;
    database = new DatabaseSync(lockPath);
    opening = false;
    closeDatabaseNative = onceNativeServerClose(native, () => database!.close());
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec("PRAGMA synchronous = FULL");
    database.exec("BEGIN EXCLUSIVE");
    platform.assertRoot();
    platform.assertFile(lockPath);
    assertDatabase(database);
    let closed = false;
    const close = onceNativeServerClose(native, () => {
      // A poisoned inner scope may still be live. Keep directory exclusion
      // held until its owner can reconcile the unknown outcome.
      native.assertCurrent();
      closed = true;
      // SQLite close ends the owned exclusive transaction. Never use the
      // POSIX best-effort close helper before releasing the native handle.
      closeNativeServerResources(native, [closeDatabaseNative!, closePlatform]);
    });
    return {
      directory: path,
      assertOwned(): void {
        if (closed) unsafe();
        platform.assertRoot();
        platform.assertFile(lockPath);
        assertDatabase(database!);
        platform.assertRoot();
        platform.assertFile(lockPath);
      },
      close,
    };
  } catch (error) {
    if (opening) return native.retainUnknown(platform, error);
    const primary = isBusy(error) ?
      Object.assign(new SyncError("server-maintenance-busy", 409), { cause: error }) : error;
    closeNativeServerResources(native,
      [...(closeDatabaseNative ? [closeDatabaseNative] : []), closePlatform],
      { error: primary });
    throw primary;
  }
}

export function acquireServerDirectoryLease(
  directory: string,
): ServerDirectoryLease {
  if (windowsServerNative() !== undefined) return acquireNativeLease(directory);
  if (process.platform === "win32") unsafe();
  const root = pinRoot(directory);
  const lock = openLock(root);
  let database: DatabaseSync | undefined;
  try {
    assertRoot(root);
    assertLock(lock);
    database = openDatabase(lock.path);
    assertRoot(root);
    assertLock(lock);
    assertDatabase(database);
    return createLease(lock, database);
  } catch (error) {
    if (database) closeDatabase(database);
    closeQuietly(lock.fd);
    throw error;
  }
}
