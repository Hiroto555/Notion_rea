import { lstatSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { SyncError } from "./protocol";

export type PrivateRootPin = {
  path: string;
  dev: number;
  ino: number;
  uid: number;
};

const ERROR_CODE = "m3-private-root-unsafe";
const ERROR_STATUS = 409;
const PRIVATE_DIRECTORY_MODE = 0o700;
const WRITABLE_ANCESTOR_BITS = 0o022;
const STICKY_BIT = 0o1000;
const MAX_PATH_LENGTH = 4_096;

function fail(): never {
  throw new SyncError(ERROR_CODE, ERROR_STATUS);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function currentUid(): number {
  if (process.platform === "win32") fail();
  const getuid = process.getuid;
  if (typeof getuid !== "function") fail();
  let uid: unknown;
  try {
    uid = getuid.call(process);
  } catch {
    fail();
  }
  if (!isSafeInteger(uid)) fail();
  return uid;
}

function isWithin(parent: string, candidate: string): boolean {
  if (parent === candidate) return true;
  const rest = relative(parent, candidate);
  return (
    rest !== "" &&
    rest !== ".." &&
    !rest.startsWith(".." + sep) &&
    !isAbsolute(rest)
  );
}

function canonicalDirectory(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    value.includes("\0") ||
    !isAbsolute(value)
  )
    fail();
  const absolute = resolve(value);
  let stat: Stats;
  try {
    stat = lstatSync(absolute);
  } catch {
    fail();
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail();
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch {
    fail();
  }
  if (canonical !== absolute) fail();
  return canonical;
}

function assertPrivateStat(stat: Stats, uid: number): void {
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
  )
    fail();
}

function assertSafeAncestors(directory: string): void {
  let current = directory;
  for (;;) {
    let stat: Stats;
    try {
      stat = lstatSync(current);
    } catch {
      fail();
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail();
    if (
      (stat.mode & WRITABLE_ANCESTOR_BITS) !== 0 &&
      (stat.mode & STICKY_BIT) === 0
    )
      fail();
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function pinPrivateRoot(
  directory: string,
  forbiddenRoots: readonly string[] = [],
): PrivateRootPin {
  try {
    if (!Array.isArray(forbiddenRoots)) fail();
    const uid = currentUid();
    const canonical = canonicalDirectory(directory);
    const stat = lstatSync(canonical);
    assertPrivateStat(stat, uid);
    assertSafeAncestors(canonical);
    const roots = forbiddenRoots.map((root) => canonicalDirectory(root));
    for (const root of roots) {
      if (isWithin(root, canonical) || isWithin(canonical, root)) fail();
    }
    return Object.freeze({
      path: canonical,
      dev: stat.dev,
      ino: stat.ino,
      uid,
    });
  } catch (error) {
    if (error instanceof SyncError) throw error;
    fail();
  }
}

export function assertPrivateRoot(pin: PrivateRootPin): void {
  try {
    if (pin === null || typeof pin !== "object" || Array.isArray(pin)) fail();
    const value = pin as unknown as Record<string, unknown>;
    const path = value.path;
    const dev = value.dev;
    const ino = value.ino;
    const uid = value.uid;
    if (
      typeof path !== "string" ||
      !isSafeInteger(dev) ||
      !isSafeInteger(ino) ||
      !isSafeInteger(uid)
    )
      fail();
    const current = currentUid();
    if (uid !== current) fail();
    const canonical = canonicalDirectory(path);
    if (canonical !== path) fail();
    const stat = lstatSync(canonical);
    assertPrivateStat(stat, current);
    if (stat.dev !== dev || stat.ino !== ino || stat.uid !== uid) fail();
    assertSafeAncestors(canonical);
  } catch (error) {
    if (error instanceof SyncError) throw error;
    fail();
  }
}

/** SQLite may open these before application-level schema validation. */
export function assertSqliteSidecars(databasePath: string, uid: number): void {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try {
      const stat = lstatSync(databasePath + suffix);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid ||
          (stat.mode & 0o022) !== 0 || stat.size > 32 * 1024 * 1024) fail();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof SyncError) throw error;
        fail();
      }
    }
  }
}
