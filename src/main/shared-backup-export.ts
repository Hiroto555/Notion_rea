import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { canonical } from "../collaboration/runtime/canonical";
import { wellFormed, type Cut } from "../collaboration/runtime/contract";
import { validateRuntimeBackup } from "../collaboration/runtime/backup";
import type {
  BackupDownload,
  BackupExportResult,
} from "../collaboration/runtime/backup-port";
import {
  assertExternalOutput,
  assertOutsideFolioData,
} from "../persistence/output-path";

type BackupExportOptions = {
  download: () => Promise<BackupDownload>;
  pick: () => Promise<string | null>;
  isAuthorized: () => boolean;
  forbiddenRoots: readonly string[];
};

type CodedError = Error & { code: string };
type RootPin = { path: string; dev: number; ino: number };
type FrozenBackup = { raw: string; head: Cut; hash: string };

const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const MAX_PATH_LENGTH = 4096;
const WINDOWS_RESERVED =
  /^(CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9])$/;

function fail(code: string, cause?: unknown): never {
  const error = new Error(
    code,
    cause === undefined ? undefined : { cause },
  ) as CodedError;
  error.code = code;
  throw error;
}

function sameIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function within(root: string, path: string): boolean {
  const rest = relative(root, path);
  return (
    rest === "" ||
    (rest !== ".." && !rest.startsWith(".." + sep) && !isAbsolute(rest))
  );
}

function actualPath(path: string): string {
  const absolute = resolve(path);
  try {
    lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(actualPath(parent), basename(absolute));
  }
  return realpathSync(absolute);
}

function pinRoot(value: unknown): RootPin {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.includes("\0") ||
    !wellFormed(value)
  )
    fail("INVALID_FORBIDDEN_ROOT");
  let path = "";
  let stat: Stats | undefined;
  try {
    path = actualPath(value);
    stat = lstatSync(path);
  } catch (error) {
    fail("INVALID_FORBIDDEN_ROOT", error);
  }
  if (stat === undefined || stat.isSymbolicLink())
    fail("INVALID_FORBIDDEN_ROOT");
  return { path, dev: stat.dev, ino: stat.ino };
}

function assertRootPinned(pin: RootPin): void {
  let path = "";
  let stat: Stats | undefined;
  try {
    path = actualPath(pin.path);
    stat = lstatSync(path);
  } catch (error) {
    fail("FORBIDDEN_ROOT_CHANGED", error);
  }
  if (
    stat === undefined ||
    path !== pin.path ||
    stat.isSymbolicLink() ||
    stat.dev !== pin.dev ||
    stat.ino !== pin.ino
  )
    fail("FORBIDDEN_ROOT_CHANGED");
}

function freezeDownload(download: unknown): FrozenBackup {
  if (
    download === null ||
    typeof download !== "object" ||
    Array.isArray(download)
  )
    fail("INVALID_DOWNLOAD");
  const value = download as Record<string, unknown>;
  const { raw, head, hash } = value;
  if (typeof raw !== "string" || raw.length === 0) fail("INVALID_DOWNLOAD");
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail("INVALID_BACKUP", error);
  }
  const backup = validateRuntimeBackup(parsed);
  if (raw !== canonical(parsed, MAX_BACKUP_BYTES)) fail("NON_CANONICAL_BACKUP");
  let downloadedHead = "";
  try {
    downloadedHead = canonical(head);
  } catch (error) {
    fail("INVALID_DOWNLOAD", error);
  }
  if (downloadedHead !== canonical(backup.head))
    fail("BACKUP_DOWNLOAD_MISMATCH");
  if (typeof hash !== "string" || hash !== backup.hash)
    fail("BACKUP_DOWNLOAD_MISMATCH");
  return {
    raw,
    head: {
      epoch: backup.head.epoch,
      seq: backup.head.seq,
      hash: backup.head.hash,
    },
    hash: backup.hash,
  };
}

function assertPortableDestination(selected: unknown): {
  destination: string;
  parent: string;
} {
  if (
    typeof selected !== "string" ||
    selected.length === 0 ||
    selected.length > MAX_PATH_LENGTH ||
    selected.includes("\0") ||
    !wellFormed(selected)
  )
    fail("INVALID_DESTINATION");
  if (
    selected.startsWith("\\\\?\\") ||
    selected.startsWith("\\\\.\\") ||
    /^[A-Za-z]:/.test(selected)
  )
    fail("RESERVED_WINDOWS_PREFIX");
  if (!isAbsolute(selected)) fail("INVALID_DESTINATION");
  const destination = resolve(selected);
  const name = basename(destination);
  if (!name || name === "." || name === "..") fail("INVALID_DESTINATION");
  if (
    /[\x00-\x1f\x7f<>:"|?*\\]/.test(name) ||
    /[. ]$/.test(name) ||
    /~\d/.test(name)
  )
    fail("INVALID_DESTINATION");
  if (WINDOWS_RESERVED.test(name.split(".")[0]!.toUpperCase()))
    fail("RESERVED_WINDOWS_NAME");
  return { destination, parent: dirname(destination) };
}

function destinationExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function prepareDestination(
  selected: unknown,
  roots: readonly RootPin[],
): { destination: string; parent: string; parentStat: Stats } {
  const target = assertPortableDestination(selected);
  const parentStat = lstatSync(target.parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    realpathSync(target.parent) !== target.parent
  )
    fail("UNSAFE_DESTINATION");
  assertOutsideFolioData(target.parent);

  const actualTarget = actualPath(target.destination);
  for (const pin of roots) {
    assertRootPinned(pin);
    if (
      (parentStat.dev === pin.dev && parentStat.ino === pin.ino) ||
      within(pin.path, target.parent) ||
      within(target.parent, pin.path) ||
      within(pin.path, actualTarget) ||
      within(actualTarget, pin.path)
    )
      fail("FORBIDDEN_DESTINATION");
    assertExternalOutput(pin.path, target.destination);
  }

  if (destinationExists(target.destination)) fail("FILE_EXISTS");
  return { ...target, parentStat };
}

function readExact(fd: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count <= 0) throw new Error("READ_INCOMPLETE");
    offset += count;
  }
  return bytes;
}

function assertParentStable(parent: string, fd: number, initial: Stats): void {
  const byFd = fstatSync(fd);
  const byPath = lstatSync(parent);
  if (
    !byFd.isDirectory() ||
    !byPath.isDirectory() ||
    byPath.isSymbolicLink() ||
    realpathSync(parent) !== parent ||
    !sameIdentity(initial, byFd) ||
    !sameIdentity(byFd, byPath)
  )
    throw new Error("DESTINATION_PARENT_CHANGED");
}

function cleanupTemporary(
  path: string | undefined,
  created: Stats | undefined,
): void {
  if (path === undefined || created === undefined) return;
  try {
    const current = lstatSync(path);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      !sameIdentity(created, current)
    )
      return;
    unlinkSync(path);
  } catch {}
}

export async function exportSharedBackup(
  options: BackupExportOptions,
): Promise<BackupExportResult> {
  if (options === null || typeof options !== "object") fail("INVALID_OPTIONS");
  const { download, pick, isAuthorized, forbiddenRoots } = options;
  if (
    typeof download !== "function" ||
    typeof pick !== "function" ||
    typeof isAuthorized !== "function" ||
    !Array.isArray(forbiddenRoots)
  )
    fail("INVALID_OPTIONS");
  if (process.platform === "win32") fail("WINDOWS_EXPORT_UNSUPPORTED");

  const requireAuthorized = (): void => {
    if (isAuthorized() !== true) fail("UNAUTHORIZED");
  };

  requireAuthorized();
  const roots = forbiddenRoots.map(pinRoot);
  const downloaded = await download();
  requireAuthorized();
  const backup = freezeDownload(downloaded);
  requireAuthorized();

  const selected = await pick();
  requireAuthorized();
  if (selected === null) return { state: "CANCELLED" };

  const target = prepareDestination(selected, roots);
  requireAuthorized();

  const bytes = Buffer.from(backup.raw, "utf8");
  if (bytes.toString("utf8") !== backup.raw) fail("NON_CANONICAL_BACKUP");

  const parentInitial = target.parentStat;
  const parentFd = openSync(
    target.parent,
    constants.O_RDONLY |
      (constants.O_DIRECTORY ?? 0) |
      (constants.O_NOFOLLOW ?? 0),
  );
  let temporary: string | undefined;
  let created: Stats | undefined;
  try {
    assertParentStable(target.parent, parentFd, parentInitial);
    for (const pin of roots) assertRootPinned(pin);
    if (destinationExists(target.destination)) fail("FILE_EXISTS");
    requireAuthorized();

    temporary = join(
      target.parent,
      `.${basename(target.destination)}.folio-export-${randomUUID()}.tmp`,
    );
    const fd = openSync(
      temporary,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const opened = fstatSync(fd);
      created = opened;
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        !sameIdentity(opened, lstatSync(temporary))
      )
        throw new Error("STAGING_IDENTITY_CHANGED");
      let offset = 0;
      while (offset < bytes.length) {
        const count = writeSync(fd, bytes, offset, bytes.length - offset);
        if (count <= 0) throw new Error("WRITE_INCOMPLETE");
        offset += count;
      }
      fsyncSync(fd);
      const saved = fstatSync(fd);
      if (
        !saved.isFile() ||
        saved.size !== bytes.length ||
        !sameIdentity(opened, saved)
      )
        throw new Error("STAGING_IDENTITY_CHANGED");
      if (!readExact(fd, bytes.length).equals(bytes))
        throw new Error("STAGING_CONTENT_CHANGED");
    } finally {
      closeSync(fd);
    }

    if (created === undefined) throw new Error("STAGING_IDENTITY_CHANGED");
    const staging = lstatSync(temporary);
    if (
      !staging.isFile() ||
      staging.isSymbolicLink() ||
      staging.size !== bytes.length ||
      !sameIdentity(created, staging)
    )
      throw new Error("STAGING_IDENTITY_CHANGED");
    const owned = created;

    assertParentStable(target.parent, parentFd, parentInitial);
    for (const pin of roots) assertRootPinned(pin);
    if (destinationExists(target.destination)) fail("FILE_EXISTS");
    requireAuthorized();
    fsyncSync(parentFd);

    try {
      linkSync(temporary, target.destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        fail("FILE_EXISTS");
      throw error;
    }

    try {
      const published = lstatSync(target.destination);
      if (
        !published.isFile() ||
        published.isSymbolicLink() ||
        published.size !== bytes.length ||
        !sameIdentity(owned, published)
      )
        throw new Error("PUBLISHED_IDENTITY_CHANGED");
      const afterLink = openSync(
        target.destination,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const stat = fstatSync(afterLink);
        if (
          !stat.isFile() ||
          stat.size !== bytes.length ||
          !sameIdentity(owned, stat)
        )
          throw new Error("PUBLISHED_IDENTITY_CHANGED");
        if (!readExact(afterLink, bytes.length).equals(bytes))
          throw new Error("PUBLISHED_CONTENT_CHANGED");
      } finally {
        closeSync(afterLink);
      }
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      temporary = undefined;
      fsyncSync(parentFd);
      assertParentStable(target.parent, parentFd, parentInitial);
      return {
        state: "EXPORTED",
        path: target.destination,
        head: backup.head,
        hash: backup.hash,
      };
    } catch {
      return {
        state: "UNKNOWN",
        path: target.destination,
        head: backup.head,
        hash: backup.hash,
      };
    }
  } catch (error) {
    cleanupTemporary(temporary, created);
    throw error;
  } finally {
    try {
      closeSync(parentFd);
    } catch {}
  }
}
