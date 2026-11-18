import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { join, resolve } from "node:path";
import { syncPath } from "../persistence/durable-file";
import type { ReleaseFilePin } from "./cache-release-types";
import { requireCondition, SyncError } from "./protocol";

const PARTIAL = /^[a-f0-9]{64}\.part$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 20_000_000;
const O_READ =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

type Root = Readonly<{ path: string; dev: number; ino: number }>;
type Opened = {
  descriptor: number;
  stat: Stats;
};

function stale(): never {
  throw new SyncError("cache-release-stale", 409);
}
function normalize(error: unknown): SyncError {
  return error instanceof SyncError
    ? error
    : new SyncError("cache-release-stale", 409);
}
function check(value: unknown): asserts value {
  requireCondition(value, "cache-release-stale", 409);
}
function closeQuietly(descriptor: number) {
  try {
    closeSync(descriptor);
  } catch {}
}
function owned(uid: number) {
  return typeof process.getuid === "function" && process.getuid() === uid;
}
function pinDirectory(value: string): Root {
  check(typeof value === "string");
  let listed: Stats;
  try {
    listed = lstatSync(resolve(value));
  } catch {
    return stale();
  }
  check(
    listed.isDirectory() &&
      !listed.isSymbolicLink() &&
      (listed.mode & 0o777) === 0o700 &&
      owned(listed.uid),
  );
  let canonical: string;
  try {
    canonical = realpathSync(resolve(value));
  } catch {
    return stale();
  }
  let pinned: Stats;
  try {
    pinned = lstatSync(canonical);
  } catch {
    return stale();
  }
  check(
    pinned.isDirectory() &&
      !pinned.isSymbolicLink() &&
      pinned.dev === listed.dev &&
      pinned.ino === listed.ino &&
      (pinned.mode & 0o777) === 0o700 &&
      owned(pinned.uid),
  );
  return { path: canonical, dev: pinned.dev, ino: pinned.ino };
}
function assertRoot(root: Root) {
  let listed: Stats;
  try {
    listed = lstatSync(root.path);
  } catch {
    return stale();
  }
  check(
    listed.isDirectory() &&
      !listed.isSymbolicLink() &&
      listed.dev === root.dev &&
      listed.ino === root.ino &&
      (listed.mode & 0o777) === 0o700 &&
      owned(listed.uid),
  );
}
function validatePartialName(value: string) {
  check(typeof value === "string" && PARTIAL.test(value));
  return value;
}
function trashName(value: string) {
  check(typeof value === "string" && UUID.test(value));
  return `.release-${value}.part`;
}
function ticket(pin: ReleaseFilePin) {
  check(
    pin !== null &&
      typeof pin === "object" &&
      Number.isSafeInteger(pin.dev) &&
      pin.dev >= 0 &&
      Number.isSafeInteger(pin.ino) &&
      pin.ino >= 0 &&
      Number.isSafeInteger(pin.size) &&
      pin.size >= 0 &&
      pin.size <= MAX_BYTES &&
      Number.isFinite(pin.mtimeMs) &&
      Number.isFinite(pin.ctimeMs) &&
      typeof pin.sha256 === "string" &&
      HASH.test(pin.sha256),
  );
  return pin;
}

function openFile(path: string): Opened | null {
  let descriptor: number;
  try {
    descriptor = openSync(path, O_READ);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return stale();
  }
  try {
    const stat = fstatSync(descriptor);
    check(
      stat.isFile() &&
        stat.nlink >= 1 &&
        stat.nlink <= 2 &&
        stat.size <= MAX_BYTES && owned(stat.uid),
    );
    return { descriptor, stat };
  } catch (error) {
    closeQuietly(descriptor);
    throw normalize(error);
  }
}
function lstatMaybe(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return stale();
  }
}
function lstatSafe(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return stale();
  }
}
function fstatSafe(descriptor: number) {
  try {
    return fstatSync(descriptor);
  } catch {
    return stale();
  }
}
function digest(opened: Opened) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(
    Math.max(1, Math.min(64 * 1024, opened.stat.size)),
  );
  let position = 0;
  while (position < opened.stat.size) {
    let read: number;
    try {
      read = readSync(
        opened.descriptor,
        buffer,
        0,
        Math.min(buffer.length, opened.stat.size - position),
        position,
      );
    } catch {
      return stale();
    }
    check(read > 0);
    hash.update(buffer.subarray(0, read));
    position += read;
  }
  return hash.digest("hex");
}

function verifyExact(
  opened: Opened,
  path: string,
  root: Root,
  pin: ReleaseFilePin,
) {
  check(
    opened.stat.nlink === 1 &&
      opened.stat.dev === pin.dev &&
      opened.stat.ino === pin.ino &&
      opened.stat.size === pin.size &&
      opened.stat.mtimeMs === pin.mtimeMs &&
      opened.stat.ctimeMs === pin.ctimeMs,
  );
  const sha256 = digest(opened);
  const final = fstatSafe(opened.descriptor);
  const listed = lstatSafe(path);
  assertRoot(root);
  check(
    final.isFile() &&
      final.nlink === 1 &&
      final.dev === pin.dev &&
      final.ino === pin.ino &&
      final.size === pin.size &&
      final.mtimeMs === pin.mtimeMs &&
      final.ctimeMs === pin.ctimeMs &&
      !listed.isSymbolicLink() &&
      listed.isFile() &&
      listed.nlink === 1 &&
      listed.dev === pin.dev &&
      listed.ino === pin.ino &&
      listed.size === pin.size &&
      listed.mtimeMs === pin.mtimeMs &&
      listed.ctimeMs === pin.ctimeMs &&
      sha256 === pin.sha256,
  );
}
function verifyPair(
  originalPath: string,
  trashPath: string,
  root: Root,
  pin: ReleaseFilePin,
) {
  const opened = openFile(originalPath);
  check(opened);
  try {
    const stat = opened.stat;
    check(
      stat.nlink === 2 &&
        stat.dev === pin.dev &&
        stat.ino === pin.ino &&
        stat.size === pin.size && stat.mtimeMs === pin.mtimeMs,
    );
    const original = lstatSafe(originalPath);
    const trash = lstatSafe(trashPath);
    assertRoot(root);
    check(
      !original.isSymbolicLink() &&
        original.isFile() &&
        original.nlink === 2 &&
        original.dev === pin.dev &&
        original.ino === pin.ino &&
        original.size === pin.size &&
        !trash.isSymbolicLink() &&
        trash.isFile() &&
        trash.nlink === 2 &&
        trash.dev === pin.dev &&
        trash.ino === pin.ino &&
        trash.size === pin.size,
    );
    const sha256 = digest(opened);
    const final = fstatSafe(opened.descriptor);
    const finalOriginal = lstatSafe(originalPath);
    const finalTrash = lstatSafe(trashPath);
    assertRoot(root);
    check(
      final.isFile() &&
        final.nlink === 2 &&
        final.dev === pin.dev &&
        final.ino === pin.ino &&
        final.size === pin.size &&
        final.mtimeMs === stat.mtimeMs &&
        final.ctimeMs === stat.ctimeMs &&
        !finalOriginal.isSymbolicLink() &&
        finalOriginal.isFile() &&
        finalOriginal.nlink === 2 &&
        finalOriginal.dev === final.dev &&
        finalOriginal.ino === final.ino &&
        finalOriginal.size === final.size &&
        finalOriginal.mtimeMs === original.mtimeMs &&
        finalOriginal.ctimeMs === original.ctimeMs &&
        !finalTrash.isSymbolicLink() &&
        finalTrash.isFile() &&
        finalTrash.nlink === 2 &&
        finalTrash.dev === final.dev &&
        finalTrash.ino === final.ino &&
        finalTrash.size === final.size &&
        finalTrash.mtimeMs === trash.mtimeMs &&
        finalTrash.ctimeMs === trash.ctimeMs &&
        sha256 === pin.sha256,
    );
  } finally {
    closeQuietly(opened.descriptor);
  }
}
function verifyTrashOnly(
  path: string,
  root: Root,
  pin: ReleaseFilePin,
) {
  const opened = openFile(path);
  check(opened);
  try {
    const stat = opened.stat;
    check(
      stat.nlink === 1 &&
        stat.dev === pin.dev &&
        stat.ino === pin.ino &&
        stat.size === pin.size && stat.mtimeMs === pin.mtimeMs,
    );
    const listedBefore = lstatSafe(path);
    assertRoot(root);
    check(
      !listedBefore.isSymbolicLink() &&
        listedBefore.isFile() &&
        listedBefore.nlink === 1 &&
        listedBefore.dev === pin.dev &&
        listedBefore.ino === pin.ino &&
        listedBefore.size === pin.size,
    );
    const sha256 = digest(opened);
    const final = fstatSafe(opened.descriptor);
    const listed = lstatSafe(path);
    assertRoot(root);
    check(
      final.isFile() &&
        final.nlink === 1 &&
        final.dev === stat.dev &&
        final.ino === stat.ino &&
        final.size === stat.size &&
        final.mtimeMs === stat.mtimeMs &&
        final.ctimeMs === stat.ctimeMs &&
        !listed.isSymbolicLink() &&
        listed.isFile() &&
        listed.nlink === 1 &&
        listed.dev === pin.dev &&
        listed.ino === pin.ino &&
        listed.size === pin.size &&
        listed.mtimeMs === listedBefore.mtimeMs &&
        listed.ctimeMs === listedBefore.ctimeMs &&
        sha256 === pin.sha256,
    );
  } finally {
    closeQuietly(opened.descriptor);
  }
}
function removeOriginal(path: string, root: Root) {
  try {
    unlinkSync(path);
  } catch {
    return stale();
  }
  syncPath(root.path);
  assertRoot(root);
}

export function pinReleaseFile(
  directory: string,
  partialName: string,
): ReleaseFilePin | null {
  try {
    const root = pinDirectory(directory);
    const name = validatePartialName(partialName);
    const path = join(root.path, name);
    const opened = openFile(path);
    if (opened === null) {
      assertRoot(root);
      return null;
    }
    try {
      check(opened.stat.nlink === 1);
      const sha256 = digest(opened);
      const final = fstatSafe(opened.descriptor);
      const listed = lstatSafe(path);
      assertRoot(root);
      check(
        final.isFile() &&
          final.nlink === 1 &&
          final.dev === opened.stat.dev &&
          final.ino === opened.stat.ino &&
          final.size === opened.stat.size &&
          final.mtimeMs === opened.stat.mtimeMs &&
          final.ctimeMs === opened.stat.ctimeMs &&
          !listed.isSymbolicLink() &&
          listed.isFile() &&
          listed.nlink === 1 &&
          listed.dev === final.dev &&
          listed.ino === final.ino &&
          listed.size === final.size &&
          listed.mtimeMs === final.mtimeMs &&
          listed.ctimeMs === final.ctimeMs,
      );
      return Object.freeze({
        dev: final.dev,
        ino: final.ino,
        size: final.size,
        mtimeMs: final.mtimeMs,
        ctimeMs: final.ctimeMs,
        sha256,
      });
    } finally {
      closeQuietly(opened.descriptor);
    }
  } catch (error) {
    throw normalize(error);
  }
}

export function trashReleaseFile(
  directory: string,
  partialName: string,
  operationId: string,
  pin: ReleaseFilePin,
): "trashed" | "absent" {
  try {
    const root = pinDirectory(directory);
    const name = validatePartialName(partialName);
    const expected = ticket(pin);
    const trash = trashName(operationId);
    const originalPath = join(root.path, name);
    const trashPath = join(root.path, trash);

    const original = lstatMaybe(originalPath);
    const existingTrash = lstatMaybe(trashPath);
    if (original === null) {
      if (existingTrash === null) {
        assertRoot(root);
        return "absent";
      }
      verifyTrashOnly(trashPath, root, expected);
      assertRoot(root);
      return "trashed";
    }
    check(original.isFile() && !original.isSymbolicLink());
    if (existingTrash !== null) {
      check(
        existingTrash.isFile() &&
          !existingTrash.isSymbolicLink() &&
          existingTrash.dev === original.dev &&
          existingTrash.ino === original.ino &&
          original.nlink === 2 &&
          existingTrash.nlink === 2,
      );
      verifyPair(originalPath, trashPath, root, expected);
      removeOriginal(originalPath, root);
      return "trashed";
    }

    const opened = openFile(originalPath);
    check(opened);
    try {
      verifyExact(opened, originalPath, root, expected);
      assertRoot(root);
      try {
        linkSync(originalPath, trashPath);
      } catch {
        return stale();
      }
      syncPath(root.path);
    } finally {
      closeQuietly(opened.descriptor);
    }
    verifyPair(originalPath, trashPath, root, expected);
    removeOriginal(originalPath, root);
    return "trashed";
  } catch (error) {
    throw normalize(error);
  }
}

export function unlinkReleaseTrash(
  directory: string,
  operationId: string,
  pin: ReleaseFilePin,
): "removed" | "absent" {
  try {
    const root = pinDirectory(directory);
    const expected = ticket(pin);
    const trashPath = join(root.path, trashName(operationId));
    const opened = openFile(trashPath);
    if (opened === null) {
      assertRoot(root);
      return "absent";
    }
    try {
      const stat = opened.stat;
      check(
        stat.nlink === 1 &&
          stat.dev === expected.dev &&
          stat.ino === expected.ino &&
          stat.size === expected.size && stat.mtimeMs === expected.mtimeMs,
      );
      const sha256 = digest(opened);
      const final = fstatSafe(opened.descriptor);
      const listed = lstatSafe(trashPath);
      assertRoot(root);
      check(
        final.isFile() &&
          final.nlink === 1 &&
          final.dev === stat.dev &&
          final.ino === stat.ino &&
          final.size === stat.size &&
          final.mtimeMs === stat.mtimeMs &&
          final.ctimeMs === stat.ctimeMs &&
          !listed.isSymbolicLink() &&
          listed.isFile() &&
          listed.nlink === 1 &&
          listed.dev === expected.dev &&
          listed.ino === expected.ino &&
          listed.size === expected.size &&
          sha256 === expected.sha256,
      );
      try {
        unlinkSync(trashPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
        return stale();
      }
      syncPath(root.path);
      assertRoot(root);
      return "removed";
    } finally {
      closeQuietly(opened.descriptor);
    }
  } catch (error) {
    throw normalize(error);
  }
}
