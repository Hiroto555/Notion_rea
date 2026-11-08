import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  realpathSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { SyncError } from "./protocol";

export type ServerBlobRetentionLimits = {
  maxBytes?: number;
  maxEntries?: number;
};

export type ServerBlobRetentionInspection = {
  bytes: number;
  entries: number;
  held: boolean;
};

const UNKNOWN_CODE = "server-blob-retention-unknown";
const HELD_CODE = "server-blob-retention-held";
const ERROR_STATUS = 409;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 4096;
const MAX_PATH_LENGTH = 4096;
const PRIVATE_DIRECTORY_MODE = 0o700;
const ENTRY_SCAN_SLACK = 64;
const HASH = /^[a-f0-9]{64}$/;
const PARTIAL = /^\.partial-[a-f0-9]{64}$/;
const FILE_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
const DIRECTORY_FLAGS =
  fsConstants.O_RDONLY |
  (fsConstants.O_DIRECTORY ?? 0) |
  fsConstants.O_NOFOLLOW |
  fsConstants.O_NONBLOCK;

type ResolvedLimits = {
  maxBytes: number;
  maxEntries: number;
};

type ScanState = ResolvedLimits & {
  bytes: number;
  entries: number;
  held: boolean;
  visited: number;
};

function unknown(): never {
  throw new SyncError(UNKNOWN_CODE, ERROR_STATUS);
}

function held(): never {
  throw new SyncError(HELD_CODE, ERROR_STATUS);
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
  } catch {
    // Preserve the inspection result or the original error.
  }
}

function currentUid(): number {
  if (process.platform === "win32") unknown();
  const getuid = process.getuid;
  if (typeof getuid !== "function") unknown();
  let uid: unknown;
  try {
    uid = getuid.call(process);
  } catch {
    unknown();
  }
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0)
    unknown();
  return uid;
}

function resolveLimits(limits: unknown): ResolvedLimits {
  if (limits === undefined) {
    return { maxBytes: DEFAULT_MAX_BYTES, maxEntries: DEFAULT_MAX_ENTRIES };
  }
  if (limits === null || typeof limits !== "object" || Array.isArray(limits))
    unknown();
  const value = limits as Record<string, unknown>;
  const maxBytes =
    value.maxBytes === undefined ? DEFAULT_MAX_BYTES : value.maxBytes;
  const maxEntries =
    value.maxEntries === undefined ? DEFAULT_MAX_ENTRIES : value.maxEntries;
  if (
    typeof maxBytes !== "number" ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > DEFAULT_MAX_BYTES
  )
    unknown();
  if (
    typeof maxEntries !== "number" ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 0 ||
    maxEntries > DEFAULT_MAX_ENTRIES
  )
    unknown();
  return { maxBytes, maxEntries };
}

function pathStat(path: string): Stats {
  try {
    return lstatSync(path);
  } catch {
    unknown();
  }
}

function canonicalRoot(directory: string): string | null {
  if (
    typeof directory !== "string" ||
    directory.length === 0 ||
    directory.length > MAX_PATH_LENGTH ||
    directory.includes("\0") ||
    !isAbsolute(directory)
  )
    unknown();
  const absolute = resolve(directory);
  let stat: Stats;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    unknown();
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) unknown();
  if (stat.uid !== currentUid()) unknown();
  if ((stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) unknown();
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch {
    unknown();
  }
  if (canonical !== absolute) unknown();
  return canonical;
}

function openDirectory(path: string): number {
  try {
    return openSync(path, DIRECTORY_FLAGS);
  } catch {
    unknown();
  }
}

function pinDirectory(path: string): Stats {
  const before = pathStat(path);
  if (before.isSymbolicLink() || !before.isDirectory()) unknown();
  const descriptor = openDirectory(path);
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isDirectory() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      unknown();
  } catch (error) {
    if (error instanceof SyncError) throw error;
    unknown();
  } finally {
    closeQuietly(descriptor);
  }
  return before;
}

function pinnedFileBytes(path: string, before: Stats): number {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, FILE_FLAGS);
  } catch {
    unknown();
  }
  try {
    if (descriptor === undefined) unknown();
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      unknown();
    const after = pathStat(path);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    )
      unknown();
    return opened.size;
  } catch (error) {
    if (error instanceof SyncError) throw error;
    unknown();
  } finally {
    closeQuietly(descriptor);
  }
}

function sameDirectory(before: Stats, after: Stats): boolean {
  return (
    !before.isSymbolicLink() &&
    !after.isSymbolicLink() &&
    before.isDirectory() &&
    after.isDirectory() &&
    before.dev === after.dev &&
    before.ino === after.ino
  );
}

function addBytes(current: number, delta: number): number {
  const next = current + delta;
  return Number.isSafeInteger(next) && next >= 0
    ? next
    : Number.MAX_SAFE_INTEGER;
}

function checkOverflow(state: ScanState): void {
  if (state.bytes > state.maxBytes || state.entries > state.maxEntries)
    state.held = true;
}

function readEntry(dir: ReturnType<typeof opendirSync>): Dirent | null {
  try {
    return dir.readSync();
  } catch {
    unknown();
  }
}

function closeDirectory(dir: ReturnType<typeof opendirSync>): void {
  try {
    dir.closeSync();
  } catch {
    // A completed bounded listing is not invalidated by a close failure.
  }
}

function scanDirectory(path: string, depth: number, state: ScanState): void {
  const pin = pinDirectory(path);
  let dir: ReturnType<typeof opendirSync>;
  try {
    dir = opendirSync(path);
  } catch {
    unknown();
  }
  const scanLimit = state.maxEntries + 1 + ENTRY_SCAN_SLACK;
  let scanned = 0;
  try {
    for (;;) {
      if (state.held) break;
      const entry = readEntry(dir);
      if (entry === null) break;
      if (++state.visited > state.maxEntries + 1 + ENTRY_SCAN_SLACK) {state.held = true; break;}
      scanned += 1;
      if (scanned > scanLimit) {
        state.held = true;
        break;
      }
      const name = entry.name;
      if (
        typeof name !== "string" ||
        name.length === 0 ||
        name === "." ||
        name === ".." ||
        name.includes("\0") ||
        name.includes("/")
      )
        unknown();
      const childPath = join(path, name);
      const child = pathStat(childPath);
      if (child.isSymbolicLink()) unknown();
      if (child.isDirectory()) {
        if (depth !== 0 || !HASH.test(name)) unknown();
        scanDirectory(childPath, 1, state);
        continue;
      }
      if (!child.isFile()) unknown();
      const bytes = pinnedFileBytes(childPath, child);
      state.bytes = addBytes(state.bytes, bytes);
      if (depth > 0 && (HASH.test(name) || PARTIAL.test(name)))
        state.entries += 1;
      checkOverflow(state);
    }
  } finally {
    closeDirectory(dir);
  }
  const after = pathStat(path);
  if (!sameDirectory(pin, after)) unknown();
}

function inspectWithLimits(
  directory: string,
  limits: ResolvedLimits,
): ServerBlobRetentionInspection {
  const root = canonicalRoot(directory);
  if (root === null) return { bytes: 0, entries: 0, held: false };
  const state: ScanState = {
    maxBytes: limits.maxBytes,
    maxEntries: limits.maxEntries,
    bytes: 0,
    entries: 0,
    held: false,
    visited: 0,
  };
  scanDirectory(root, 0, state);
  return { bytes: state.bytes, entries: state.entries, held: state.held };
}

export function inspectServerBlobRetention(
  directory: string,
  limits?: ServerBlobRetentionLimits,
): ServerBlobRetentionInspection {
  const resolved = resolveLimits(limits);
  return inspectWithLimits(directory, resolved);
}

export function assertServerBlobAdmission(
  directory: string,
  additionalBytes: number,
  limits?: ServerBlobRetentionLimits,
): void {
  const resolved = resolveLimits(limits);
  if (
    typeof additionalBytes !== "number" ||
    !Number.isSafeInteger(additionalBytes) ||
    additionalBytes < 0
  )
    unknown();
  const inspection = inspectWithLimits(directory, resolved);
  const projected = addBytes(inspection.bytes, additionalBytes);
  if (
    inspection.held ||
    projected > resolved.maxBytes ||
    inspection.entries + 1 > resolved.maxEntries
  )
    held();
}
