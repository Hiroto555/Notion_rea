import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { requireCondition, SyncError } from "./protocol";

const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 20_000_000;
const LOCK_NAME = ".folio-upload-lock.sqlite";
const READ_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

type RootPin = { path: string; dev: number; ino: number };
type FileStat = Stats;

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

function pinDirectory(value: unknown): RootPin {
  requireCondition(
    typeof value === "string" && value.length > 0,
    "invalid-directory",
  );
  let absolute: string;
  try {
    absolute = resolve(value);
  } catch {
    throw new SyncError("unsafe-directory", 409);
  }
  let listed: FileStat;
  try {
    listed = lstatSync(absolute);
  } catch {
    throw new SyncError("unsafe-directory", 409);
  }
  if (listed.isSymbolicLink() || !listed.isDirectory())
    throw new SyncError("unsafe-directory", 409);
  let path: string;
  try {
    path = realpathSync(absolute);
  } catch {
    throw new SyncError("unsafe-directory", 409);
  }
  let stat: FileStat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new SyncError("unsafe-directory", 409);
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.dev !== listed.dev ||
    stat.ino !== listed.ino
  )
    throw new SyncError("unsafe-directory", 409);
  return { path, dev: stat.dev, ino: stat.ino };
}

function assertRoot(pin: RootPin): void {
  let stat: FileStat;
  try {
    stat = lstatSync(pin.path);
  } catch {
    throw new SyncError("unsafe-directory", 409);
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.dev !== pin.dev ||
    stat.ino !== pin.ino
  )
    throw new SyncError("unsafe-directory", 409);
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    fsyncSync(descriptor);
  } catch {
    throw new SyncError("durable-write-failed", 500);
  } finally {
    closeQuietly(descriptor);
  }
}

function lockStat(path: string): FileStat | null {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new SyncError("unsafe-blob-path", 409);
  }
}

function assertLockStat(stat: FileStat): void {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)
    throw new SyncError("unsafe-blob-path", 409);
}

function requireLockStat(path: string): FileStat {
  const stat = lockStat(path);
  if (!stat) throw new SyncError("unsafe-blob-path", 409);
  assertLockStat(stat);
  return stat;
}

function ensureLockFile(root: RootPin, path: string): FileStat {
  const existing = lockStat(path);
  if (existing) {
    assertLockStat(existing);
    return existing;
  }
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDWR |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    created = true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return requireLockStat(path);
    throw new SyncError("unsafe-blob-path", 409);
  } finally {
    closeQuietly(descriptor);
  }
  const stat = requireLockStat(path);
  if (created) {
    assertRoot(root);
    syncDirectory(root.path);
  }
  return stat;
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

function beginExclusive(database: DatabaseSync): void {
  try {
    database.exec("PRAGMA busy_timeout = 0");
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    if (isBusy(error)) throw new SyncError("blob-upload-in-progress", 409);
    throw new SyncError("blob-upload-lock-failed", 500);
  }
}

export async function withBlobUploadLock<T>(
  workspaceDirectory: string,
  work: () => Promise<T>,
): Promise<T> {
  requireCondition(typeof work === "function", "invalid-work");
  const root = pinDirectory(workspaceDirectory);
  const lockPath = join(root.path, LOCK_NAME);
  const pinnedLock = ensureLockFile(root, lockPath);
  assertRoot(root);

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(lockPath);
  } catch {
    throw new SyncError("blob-upload-lock-failed", 500);
  }

  let inTransaction = false;
  try {
    const openedLock = requireLockStat(lockPath);
    if (openedLock.dev !== pinnedLock.dev || openedLock.ino !== pinnedLock.ino)
      throw new SyncError("unsafe-blob-path", 409);
    assertRoot(root);
    beginExclusive(database);
    inTransaction = true;
    assertRoot(root);
    const result = await work();
    assertRoot(root);
    const finalLock = requireLockStat(lockPath);
    if (finalLock.dev !== pinnedLock.dev || finalLock.ino !== pinnedLock.ino)
      throw new SyncError("unsafe-blob-path", 409);
    return result;
  } finally {
    if (inTransaction) {
      try {
        database.exec("COMMIT");
      } catch {
        try {
          database.exec("ROLLBACK");
        } catch {}
      }
    }
    try {
      database.close();
    } catch {}
  }
}

function hashExactly(descriptor: number, size: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < size) {
    const length = Math.min(buffer.length, size - position);
    let read: number;
    try {
      read = readSync(descriptor, buffer, 0, length, position);
    } catch {
      throw new SyncError("asset-unreadable", 422);
    }
    if (read <= 0) throw new SyncError("asset-changed", 409);
    position += read;
    hash.update(buffer.subarray(0, read));
  }
  return hash.digest("hex");
}

function assertPartialPath(
  path: string,
  dev: number,
  ino: number,
  size: number,
): void {
  let stat: FileStat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new SyncError("asset-changed", 409);
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.dev !== dev ||
    stat.ino !== ino ||
    stat.size !== size
  )
    throw new SyncError("asset-changed", 409);
}

export function inspectBlobUploadPartial(
  workspaceDirectory: string,
  sha256: string,
  expectedBytes: number,
): { received: number; prefixHash: string } | null {
  const root = pinDirectory(workspaceDirectory);
  requireCondition(
    typeof sha256 === "string" && HASH.test(sha256),
    "invalid-hash",
  );
  requireCondition(
    Number.isSafeInteger(expectedBytes) &&
      expectedBytes >= 0 &&
      expectedBytes <= MAX_BYTES,
    "invalid-asset-size",
  );

  const path = join(root.path, `.partial-${sha256}`);
  let pinned: FileStat;
  try {
    pinned = lstatSync(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      assertRoot(root);
      return null;
    }
    throw new SyncError("asset-unreadable", 422);
  }
  if (pinned.isSymbolicLink() || !pinned.isFile() || pinned.nlink !== 1)
    throw new SyncError("unsafe-blob-path", 409);
  if (pinned.size > expectedBytes)
    throw new SyncError("blob-size-mismatch", 422);

  let descriptor: number | undefined;
  try {
    try {
      descriptor = openSync(path, READ_FLAGS);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ELOOP") throw new SyncError("unsafe-blob-path", 409);
      if (code === "ENOENT" || code === "ENOTDIR")
        throw new SyncError("asset-changed", 409);
      throw new SyncError("asset-unreadable", 422);
    }

    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== pinned.dev ||
      opened.ino !== pinned.ino ||
      opened.size !== pinned.size ||
      opened.mtimeMs !== pinned.mtimeMs ||
      opened.ctimeMs !== pinned.ctimeMs
    )
      throw new SyncError("asset-changed", 409);
    if (opened.size > expectedBytes)
      throw new SyncError("blob-size-mismatch", 422);

    const prefixHash = hashExactly(descriptor, opened.size);
    const after = fstatSync(descriptor);
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new SyncError("asset-changed", 409);

    try {
      fsyncSync(descriptor);
    } catch {
      throw new SyncError("durable-write-failed", 500);
    }
    assertPartialPath(path, opened.dev, opened.ino, opened.size);
    syncDirectory(root.path);
    assertRoot(root);
    assertPartialPath(path, opened.dev, opened.ino, opened.size);

    return { received: opened.size, prefixHash };
  } finally {
    closeQuietly(descriptor);
  }
}
