import { lstatSync, opendirSync, realpathSync, type Dir, type Dirent, type Stats } from "node:fs";
import { join, resolve } from "node:path";
import { SyncError } from "./protocol";

export type BackupRetentionLimits = {
  maxGenerations?: number;
  maxBytes?: number;
};

export type BackupRetentionInspection = {
  generations: number;
  bytes: number;
  held: boolean;
};

const BACKUPS_DIRECTORY = "backups";
const DEFAULT_MAX_GENERATIONS = 8;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const MAX_DEPTH = 4;
const MAX_ENTRIES = 8192;
const UNKNOWN_CODE = "sync-backup-retention-unknown";
const UNKNOWN_STATUS = 409;

type RootIdentity = { dev: number; ino: number };
type ResolvedLimits = { maxGenerations: number; maxBytes: number };
type WalkState = { entries: number; bytes: number; generations: number };
type LocatedRoot = { path: string; identity: RootIdentity };

function unknown(): never {
  throw new SyncError(UNKNOWN_CODE, UNKNOWN_STATUS);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function positiveLimit(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    unknown();
  }
  if (value > fallback) unknown();
  return value;
}

function resolveLimits(limits: unknown): ResolvedLimits {
  if (limits === undefined) {
    return { maxGenerations: DEFAULT_MAX_GENERATIONS, maxBytes: DEFAULT_MAX_BYTES };
  }
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) {
    unknown();
  }
  const value = limits as Record<string, unknown>;
  return {
    maxGenerations: positiveLimit(value.maxGenerations, DEFAULT_MAX_GENERATIONS),
    maxBytes: positiveLimit(value.maxBytes, DEFAULT_MAX_BYTES),
  };
}

function locateRoot(workspaceDirectory: unknown): LocatedRoot | undefined {
  if (
    typeof workspaceDirectory !== "string" ||
    workspaceDirectory.length === 0 ||
    workspaceDirectory.includes("\0")
  ) {
    unknown();
  }
  const absolute = resolve(workspaceDirectory);
  try {
    const initial = lstatSync(absolute);
    if (initial.isSymbolicLink() || !initial.isDirectory()) unknown();
  } catch (error) {
    if (isMissing(error)) return undefined;
    unknown();
  }
  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = realpathSync(absolute);
  } catch (error) {
    if (isMissing(error)) return undefined;
    unknown();
  }
  let canonicalStat: Stats;
  try {
    canonicalStat = lstatSync(canonicalWorkspace);
  } catch (error) {
    if (isMissing(error)) return undefined;
    unknown();
  }
  if (canonicalStat.isSymbolicLink() || !canonicalStat.isDirectory()) unknown();

  const root = join(canonicalWorkspace, BACKUPS_DIRECTORY);
  let rootStat: Stats;
  try {
    rootStat = lstatSync(root);
  } catch (error) {
    if (isMissing(error)) return undefined;
    unknown();
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) unknown();
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    unknown();
  }
  if (canonicalRoot !== root) unknown();
  return { path: root, identity: { dev: rootStat.dev, ino: rootStat.ino } };
}

function recheckRoot(root: string, identity: RootIdentity): void {
  let stat: Stats;
  try {
    stat = lstatSync(root);
  } catch {
    unknown();
  }
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.dev !== identity.dev ||
    stat.ino !== identity.ino
  ) {
    unknown();
  }
}

function walk(
  root: string,
  directory: string,
  depth: number,
  identity: RootIdentity,
  state: WalkState,
): void {
  recheckRoot(root, identity);
  const directoryPin = lstatSync(directory);
  if (!directoryPin.isDirectory() || directoryPin.isSymbolicLink() || realpathSync(directory) !== directory) unknown();
  let handle: Dir;
  try {
    recheckRoot(directory, directoryPin);
    handle = opendirSync(directory);
  } catch {
    unknown();
  }
  try {
    for (;;) {
      let entry: Dirent | null;
      try {
        entry = handle.readSync();
      } catch {
        unknown();
      }
      if (entry === null) break;

      state.entries += 1;
      if (state.entries > MAX_ENTRIES) unknown();
      if (depth === 0) state.generations += 1;

      const nodeDepth = depth + 1;
      if (nodeDepth > MAX_DEPTH) unknown();

      const child = join(directory, entry.name);
      let stat: Stats;
      try {
        stat = lstatSync(child);
      } catch {
        unknown();
      }
      if (stat.isSymbolicLink() || stat.dev !== identity.dev) unknown();
      if (stat.isFile()) {
        if (!Number.isSafeInteger(stat.size) || stat.size < 0) unknown();
        if (state.bytes > Number.MAX_SAFE_INTEGER - stat.size) unknown();
        state.bytes += stat.size;
      } else if (stat.isDirectory()) {
        walk(root, child, nodeDepth, identity, state);
      } else {
        unknown();
      }
    }
  } finally {
    try {
      handle.closeSync();
    } catch {}
  }
  recheckRoot(directory, directoryPin);
}

function inspectResolved(
  workspaceDirectory: unknown,
  limits: ResolvedLimits,
): BackupRetentionInspection {
  const located = locateRoot(workspaceDirectory);
  if (located === undefined) {
    return { generations: 0, bytes: 0, held: false };
  }
  const state: WalkState = { entries: 0, bytes: 0, generations: 0 };
  walk(located.path, located.path, 0, located.identity, state);
  recheckRoot(located.path, located.identity);
  return {
    generations: state.generations,
    bytes: state.bytes,
    held: state.generations > limits.maxGenerations || state.bytes > limits.maxBytes,
  };
}

export function inspectBackupRetention(
  workspaceDirectory: string,
  limits?: BackupRetentionLimits,
): BackupRetentionInspection {
  try {
    return inspectResolved(workspaceDirectory, resolveLimits(limits));
  } catch (error) {
    if (error instanceof SyncError) throw error;
    unknown();
  }
}

export function assertBackupRetention(
  workspaceDirectory: string,
  additionalBytes: number,
  limits?: BackupRetentionLimits,
): void {
  try {
    if (
      typeof additionalBytes !== "number" ||
      !Number.isSafeInteger(additionalBytes) ||
      additionalBytes < 0
    ) {
      unknown();
    }
    const resolved = resolveLimits(limits);
    const inspection = inspectResolved(workspaceDirectory, resolved);
    if (inspection.generations >= resolved.maxGenerations) throw new SyncError("sync-backup-retention-held", 409);
    if (
      additionalBytes > resolved.maxBytes ||
      inspection.bytes > resolved.maxBytes - additionalBytes
    ) {
      throw new SyncError("sync-backup-retention-held", 409);
    }
  } catch (error) {
    if (error instanceof SyncError) throw error;
    unknown();
  }
}
