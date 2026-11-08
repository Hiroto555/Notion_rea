import { lstatSync, opendirSync, realpathSync, type Stats } from "node:fs";
import { resolve } from "node:path";
import { SyncError } from "./protocol";

const UNSAFE = "blob-transfer-budget-unsafe";
const SCOPE_DIRECTORIES = [
  ".folio-sync-transfers",
  ".folio-sync-assets-staging",
] as const;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 2048;
const DEFAULT_MAX_DIRECTORIES = 128;
const MAX_DEPTH = 4;

export type WorkspaceTransferBudget = {
  bytes: number;
  files: number;
  directories: number;
  entries: number;
  overLimit: boolean;
};

export type WorkspaceTransferBudgetLimits = {
  maxBytes?: number;
  maxEntries?: number;
  maxDirectories?: number;
};

type DirectoryPin = { path: string; device: number; inode: number };

function unsafe(): never {
  throw new SyncError(UNSAFE);
}

function lstatOptional(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    unsafe();
  }
}

function requireDirectory(path: string): Stats {
  const stat = lstatOptional(path);
  if (stat === null) unsafe();
  if (stat.isSymbolicLink() || !stat.isDirectory()) unsafe();
  return stat;
}

function pinDirectory(path: string): DirectoryPin {
  const before = requireDirectory(path);
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    throw new SyncError(UNSAFE);
  }
  if (canonical !== path) unsafe();
  const current = requireDirectory(canonical);
  if (current.dev !== before.dev || current.ino !== before.ino) unsafe();
  return { path: canonical, device: current.dev, inode: current.ino };
}

function pinRoot(directory: string): DirectoryPin {
  if (
    typeof directory !== "string" ||
    directory.length === 0 ||
    directory.length > 4096 ||
    directory.includes("\0")
  )
    unsafe();
  let requested: string;
  try {
    requested = resolve(directory);
  } catch {
    unsafe();
  }
  const before = requireDirectory(requested);
  let canonical: string;
  try {
    canonical = realpathSync(requested);
  } catch {
    throw new SyncError(UNSAFE);
  }
  const current = requireDirectory(canonical);
  if (current.dev !== before.dev || current.ino !== before.ino) unsafe();
  return { path: canonical, device: current.dev, inode: current.ino };
}

function normalizeLimits(limits?: WorkspaceTransferBudgetLimits): {
  maxBytes: number;
  maxEntries: number;
  maxDirectories: number;
} {
  if (limits === undefined)
    return {
      maxBytes: DEFAULT_MAX_BYTES,
      maxEntries: DEFAULT_MAX_ENTRIES,
      maxDirectories: DEFAULT_MAX_DIRECTORIES,
    };
  if (limits === null || typeof limits !== "object" || Array.isArray(limits))
    unsafe();
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxDirectories = limits.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
  for (const value of [maxBytes, maxEntries, maxDirectories])
    if (!Number.isSafeInteger(value) || value < 0) unsafe();
  return { maxBytes, maxEntries, maxDirectories };
}

export function inspectWorkspaceTransferBudget(
  workspaceDirectory: string,
  limits?: WorkspaceTransferBudgetLimits,
): WorkspaceTransferBudget {
  const root = pinRoot(workspaceDirectory);
  const maximum = normalizeLimits(limits);
  let bytes = 0;
  let files = 0;
  let directories = 0;
  let entries = 0;
  let overLimit = false;
  let stopped = false;

  const reserve = (directory: boolean): boolean => {
    if (
      entries >= maximum.maxEntries ||
      (directory && directories >= maximum.maxDirectories)
    ) {
      overLimit = true;
      stopped = true;
      return false;
    }
    entries++;
    if (directory) directories++;
    return true;
  };

  const addBytes = (size: number): void => {
    if (!Number.isSafeInteger(size) || size < 0) {
      overLimit = true;
      bytes = Number.MAX_SAFE_INTEGER;
      return;
    }
    if (size > Number.MAX_SAFE_INTEGER - bytes) {
      overLimit = true;
      bytes = Number.MAX_SAFE_INTEGER;
      return;
    }
    bytes += size;
    if (bytes > maximum.maxBytes) overLimit = true;
  };

  const visit = (pin: DirectoryPin, depth: number): void => {
    if (stopped) return;
    let handle;
    try {
      handle = opendirSync(pin.path);
    } catch {
      throw new SyncError(UNSAFE);
    }
    try {
      const opened = requireDirectory(pin.path);
      if (opened.dev !== pin.device || opened.ino !== pin.inode) unsafe();
      for (;;) {
        if (stopped) break;
        let entry;
        try {
          entry = handle.readSync();
        } catch {
          throw new SyncError(UNSAFE);
        }
        if (entry === null) break;
        const childDepth = depth + 1;
        if (childDepth > MAX_DEPTH) {
          overLimit = true;
          stopped = true;
          break;
        }
        const childPath = resolve(pin.path, entry.name);
        const stat = lstatOptional(childPath);
        if (stat === null) continue;
        if (
          stat.isSymbolicLink() ||
          stat.isFIFO() ||
          stat.isSocket() ||
          stat.isBlockDevice() ||
          stat.isCharacterDevice()
        )
          unsafe();
        if (stat.isDirectory()) {
          if (!reserve(true)) break;
          visit(pinDirectory(childPath), childDepth);
          continue;
        }
        if (!stat.isFile()) unsafe();
        if (!reserve(false)) break;
        files++;
        addBytes(stat.size);
      }
    } finally {
      try {
        handle.closeSync();
      } catch {
        // Read-only traversal; a close failure never changes the source.
      }
    }
    const after = requireDirectory(pin.path);
    if (after.dev !== pin.device || after.ino !== pin.inode) unsafe();
  };

  for (const name of SCOPE_DIRECTORIES) {
    if (stopped) break;
    const path = resolve(root.path, name);
    const stat = lstatOptional(path);
    if (stat === null) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) unsafe();
    if (!reserve(true)) break;
    visit(pinDirectory(path), 0);
  }

  const finalRoot = requireDirectory(root.path);
  if (finalRoot.dev !== root.device || finalRoot.ino !== root.inode) unsafe();

  return { bytes, files, directories, entries, overLimit };
}
