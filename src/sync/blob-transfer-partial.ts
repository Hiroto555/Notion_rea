import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { syncPath } from "../persistence/durable-file";
import { requireCondition, SyncError } from "./protocol";
import type { BlobTransferRecord } from "./blob-transfer-types";

export type BlobTransferPartial = {
  descriptor: number;
  path: string;
  directory: string;
  offset: number;
};
type Pin = {
  dev: number;
  ino: number;
  bytes: number;
  rootDev: number;
  rootIno: number;
};
const pins = new WeakMap<BlobTransferPartial, Pin>();
const HASH = /^[a-f0-9]{64}$/;
function directory(value: string) {
  const stat = lstatSync(resolve(value));
  requireCondition(
    !stat.isSymbolicLink() && stat.isDirectory() && (stat.mode & 0o022) === 0,
    "unsafe-blob-transfer-root",
    409,
  );
  return { path: realpathSync(value), dev: stat.dev, ino: stat.ino };
}
function recordName(record: BlobTransferRecord) {
  requireCondition(
    record &&
      HASH.test(record.key) &&
      HASH.test(record.scopeHash) &&
      HASH.test(record.sha256) &&
      HASH.test(record.prefixHash) &&
      record.partialName === record.key + ".part" &&
      basename(record.partialName) === record.partialName &&
      Number.isSafeInteger(record.bytes) &&
      record.bytes >= 0 &&
      record.bytes <= 20_000_000 &&
      Number.isSafeInteger(record.offset) &&
      record.offset >= 0 &&
      record.offset <= record.bytes,
    "invalid-blob-transfer-record",
  );
  return record.partialName;
}
function prefix(fd: number, bytes: number) {
  const hash = createHash("sha256"),
    buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < bytes) {
    const read = readSync(
      fd,
      buffer,
      0,
      Math.min(bytes - position, buffer.length),
      position,
    );
    requireCondition(read > 0, "blob-transfer-partial-short", 409);
    hash.update(buffer.subarray(0, read));
    position += read;
  }
  return hash.digest("hex");
}
function assertPin(part: BlobTransferPartial, allowTail = true) {
  const pin = pins.get(part);
  requireCondition(pin, "blob-transfer-partial-closed", 409);
  const [stat, path, root] = (() => {
    try {
      return [
        fstatSync(part.descriptor),
        lstatSync(part.path),
        lstatSync(part.directory),
      ];
    } catch {
      throw new SyncError("blob-transfer-partial-changed", 409);
    }
  })();
  requireCondition(
    root.isDirectory() &&
      !root.isSymbolicLink() &&
      root.dev === pin.rootDev &&
      root.ino === pin.rootIno &&
      stat.isFile() &&
      stat.nlink === 1 &&
      stat.dev === pin.dev &&
      stat.ino === pin.ino &&
      path.isFile() &&
      !path.isSymbolicLink() &&
      path.nlink === 1 &&
      path.dev === stat.dev &&
      path.ino === stat.ino &&
      stat.size <= pin.bytes &&
      stat.size >= part.offset &&
      (allowTail || stat.size === part.offset),
    "blob-transfer-partial-changed",
    409,
  );
  return stat;
}

export function openBlobTransferPartial(
  value: string,
  record: BlobTransferRecord,
): BlobTransferPartial {
  const root = directory(value),
    path = join(root.path, recordName(record));
  let descriptor: number | undefined;
  try {
    try {
      descriptor = openSync(
        path,
        constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        if (["ELOOP", "ENXIO", "EISDIR", "ENOTDIR"].includes(code ?? ""))
          throw new SyncError("unsafe-blob-transfer-partial", 409);
        throw new SyncError("blob-transfer-open-failed", 503);
      }
      requireCondition(
        record.offset === 0,
        "blob-transfer-partial-missing",
        409,
      );
      descriptor = openSync(
        path,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      fsyncSync(descriptor);
      syncPath(root.path);
    }
    const stat = fstatSync(descriptor);
    requireCondition(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.size >= record.offset &&
        stat.size <= record.bytes,
      "unsafe-blob-transfer-partial",
      409,
    );
    const part = {
      descriptor,
      path,
      directory: root.path,
      offset: record.offset,
    };
    pins.set(part, {
      dev: stat.dev,
      ino: stat.ino,
      bytes: record.bytes,
      rootDev: root.dev,
      rootIno: root.ino,
    });
    assertPin(part);
    requireCondition(
      prefix(descriptor, record.offset) === record.prefixHash,
      "blob-transfer-prefix-mismatch",
      409,
    );
    assertPin(part);
    // Only this journal-owned, prefix-verified file may lose an uncommitted tail.
    if (stat.size !== record.offset) {
      ftruncateSync(descriptor, record.offset);
      fsyncSync(descriptor);
      syncPath(root.path);
    }
    assertPin(part, false);
    return part;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  }
}
export function checkpointBlobTransferPartial(
  part: BlobTransferPartial,
  offset: number,
) {
  const stat = assertPin(part);
  requireCondition(
    Number.isSafeInteger(offset) &&
      offset >= part.offset &&
      offset <= stat.size,
    "invalid-blob-transfer-offset",
  );
  fsyncSync(part.descriptor);
  syncPath(part.directory);
  const digest = prefix(part.descriptor, offset);
  assertPin(part);
  part.offset = offset;
  return digest;
}
export function closeBlobTransferPartial(part: BlobTransferPartial) {
  if (!pins.has(part)) return;
  pins.delete(part);
  closeSync(part.descriptor);
}

function verifiedFile(
  path: string,
  record: BlobTransferRecord,
  partial = false,
) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(descriptor),
      listed = lstatSync(path);
    requireCondition(
      stat.isFile() &&
        (partial
          ? stat.size >= record.offset && stat.size <= record.bytes
          : stat.size === record.bytes) &&
        !listed.isSymbolicLink() &&
        listed.isFile() &&
        listed.dev === stat.dev &&
        listed.ino === stat.ino,
      "unsafe-blob-transfer-publication",
      409,
    );
    requireCondition(
      prefix(descriptor, partial ? record.offset : stat.size) ===
        (partial ? record.prefixHash : record.sha256),
      "blob-transfer-publication-hash-mismatch",
      409,
    );
    return { descriptor, stat };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}
export function reconcilePublishedPartial(
  value: string,
  record: BlobTransferRecord,
  target: string,
) {
  const root = directory(value),
    path = join(root.path, recordName(record));
  requireCondition(
    resolve(target) !== path && !resolve(target).startsWith(root.path + "/"),
    "unsafe-blob-transfer-publication",
    409,
  );
  const published = verifiedFile(target, record);
  let part: ReturnType<typeof verifiedFile> | undefined;
  try {
    try {
      part = verifiedFile(path, record, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const same =
      part.stat.dev === published.stat.dev &&
      part.stat.ino === published.stat.ino;
    requireCondition(
      part.stat.nlink === 1 || (same && part.stat.nlink === 2),
      "unsafe-blob-transfer-publication",
      409,
    );
    const current = lstatSync(path),
      currentTarget = lstatSync(target),
      currentRoot = lstatSync(root.path);
    requireCondition(
      !current.isSymbolicLink() &&
        current.dev === part.stat.dev &&
        current.ino === part.stat.ino &&
        current.nlink === part.stat.nlink &&
        !currentTarget.isSymbolicLink() &&
        currentTarget.dev === published.stat.dev &&
        currentTarget.ino === published.stat.ino &&
        currentRoot.isDirectory() &&
        !currentRoot.isSymbolicLink() &&
        currentRoot.dev === root.dev &&
        currentRoot.ino === root.ino,
      "blob-transfer-partial-changed",
      409,
    );
    unlinkSync(path);
    syncPath(root.path);
  } finally {
    if (part) closeSync(part.descriptor);
    closeSync(published.descriptor);
  }
}
