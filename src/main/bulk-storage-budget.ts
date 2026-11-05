import { lstatSync, opendirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sqliteAllocatedBytes } from "../persistence/sqlite-allocation";
import type { VerifiedWorkspaceBackup } from "../shared/workspace-backup";
import {
  addCounts,
  isSafeNonNegativeInteger,
} from "../shared/storage-usage";

/**
 * Conservative, read-only byte budgets for the bulk write paths.
 *
 * Limits:
 * - The budget is an estimate for the payload a backup/restore writes. It is
 *   not a filesystem reservation, so free space can still change between this
 *   check and the copy.
 * - Asset bytes are logical file sizes. Filesystem block rounding, inodes,
 *   extended attributes and directory blocks are covered only by the fixed
 *   metadata allowance below.
 * - SQLite uses `page_count * page_size`: the logical allocated size. In WAL
 *   mode this includes pages whose current content still lives in the `-wal`
 *   file. `VACUUM INTO` compacts the snapshot, so this is an upper bound for
 *   its database file. The physical WAL frame bytes are deliberately not
 *   counted again; they already exist before the operation and are not part
 *   of the new snapshot.
 * - Traversal is bounded. Unknown entry types, symbolic links, unsupported
 *   backup layouts and arithmetic overflow are refusals, never zero-byte
 *   assumptions.
 */
const DATABASE = "workspace.sqlite";
const ASSETS = "assets";
const MANIFEST = "manifest.json";
const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const MAX_TREE_ENTRIES = 100_000;
const MAX_TREE_DEPTH = 64;
const METADATA_BASE_BYTES = 64 * 1024;
const METADATA_ENTRY_BYTES = 512;

type TreeSummary = { bytes: number; entries: number; files: number };

function budgetAdd(total: number, next: number, label: string): number {
  const result = addCounts(total, next);
  if (result.overflow)
    throw new Error(`${label} exceeds the supported size range`);
  return result.value;
}

function budgetMultiply(left: number, right: number, label: string): number {
  if (
    !isSafeNonNegativeInteger(left) ||
    !isSafeNonNegativeInteger(right) ||
    (left !== 0 && right > Math.floor(Number.MAX_SAFE_INTEGER / left))
  )
    throw new Error(`${label} exceeds the supported size range`);
  return left * right;
}

function metadataOverhead(entries: number): number {
  return budgetAdd(
    METADATA_BASE_BYTES,
    budgetMultiply(entries, METADATA_ENTRY_BYTES, "Backup metadata"),
    "Backup metadata",
  );
}

function lstatOptional(path: string) {
  try {
    return lstatSync(path);
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function requireDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  const info = lstatOptional(absolute);
  if (!info) throw new Error(`${label} directory is missing`);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`${label} is not a regular directory`);
  return absolute;
}

function requireFileSize(path: string, label: string): number {
  const info = lstatOptional(path);
  if (!info) throw new Error(`${label} is missing`);
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error(`${label} is not a regular file`);
  if (!isSafeNonNegativeInteger(info.size))
    throw new Error(`${label} size is unsupported`);
  return info.size;
}

/** Reject unsafe SQLite sidecars without counting their bytes: they are not
 * part of the copied snapshot, but following one could read foreign data. */
function assertSafeSidecars(databasePath: string): void {
  for (const suffix of SIDECAR_SUFFIXES) {
    const info = lstatOptional(databasePath + suffix);
    if (info && (info.isSymbolicLink() || !info.isFile()))
      throw new Error("Workspace database has an unsupported sidecar");
  }
}

/** Sum every regular file that `createFullBackup` would copy from the source
 * asset tree, including unregistered and nested files. Directories are walked
 * iteratively so a hostile tree cannot exhaust the JavaScript stack. */
function inspectAssetTree(root: string): TreeSummary {
  const summary: TreeSummary = { bytes: 0, entries: 0, files: 0 };
  const rootInfo = lstatOptional(root);
  if (!rootInfo) return summary;
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    throw new Error("Assets path is not a regular directory");

  const pending: { path: string; depth: number }[] = [
    { path: root, depth: 0 },
  ];
  while (pending.length) {
    const current = pending.pop()!;
    const directory = opendirSync(current.path);
    try {
      for (
        let entry = directory.readSync();
        entry !== null;
        entry = directory.readSync()
      ) {
        summary.entries++;
        if (summary.entries > MAX_TREE_ENTRIES)
          throw new Error("Assets tree exceeds the supported entry count");
        const path = join(current.path, entry.name);
        const info = lstatSync(path);
        if (info.isSymbolicLink())
          throw new Error("Assets tree contains a symbolic link");
        if (info.isDirectory()) {
          if (current.depth >= MAX_TREE_DEPTH)
            throw new Error("Assets tree exceeds the supported depth");
          pending.push({ path, depth: current.depth + 1 });
          continue;
        }
        if (!info.isFile())
          throw new Error("Assets tree contains an unsupported entry type");
        if (!isSafeNonNegativeInteger(info.size))
          throw new Error("Asset file size is unsupported");
        summary.files++;
        summary.bytes = budgetAdd(summary.bytes, info.size, "Asset bytes");
      }
    } finally {
      directory.closeSync();
    }
  }
  return summary;
}

/**
 * Estimate the bytes written by `createFullBackup` for this live workspace.
 * Reads SQLite and the filesystem only; never mutates either. The estimate is
 * evaluated by the backup service only when an admission hook is installed.
 */
export function estimateBackupBytes(
  db: DatabaseSync,
  directory: string,
): number {
  const root = requireDirectory(directory, "Workspace");
  const databasePath = join(root, DATABASE);
  const databaseBytes = requireFileSize(databasePath, "Workspace database");
  assertSafeSidecars(databasePath);

  const allocatedPages = sqliteAllocatedBytes(db);
  // page_count normally equals the file pages, but a stale/truncated main file
  // must not make the estimate smaller than the bytes already on disk.
  const databaseBudget = Math.max(allocatedPages, databaseBytes);
  const assets = inspectAssetTree(join(root, ASSETS));

  return budgetAdd(
    budgetAdd(databaseBudget, assets.bytes, "Backup estimate"),
    metadataOverhead(budgetAdd(assets.entries, 1, "Backup metadata")),
    "Backup estimate",
  );
}

function assertSupportedManifest(
  verified: VerifiedWorkspaceBackup,
): VerifiedWorkspaceBackup["manifest"] {
  if (!verified || typeof verified !== "object")
    throw new Error("Unsupported verified backup");
  const manifest = verified.manifest;
  if (
    !manifest ||
    typeof manifest !== "object" ||
    manifest.format !== "folio-workspace-backup" ||
    manifest.version !== 1
  )
    throw new Error("Unsupported verified backup manifest");
  const database = manifest.database;
  if (
    !database ||
    typeof database !== "object" ||
    database.path !== DATABASE ||
    !isSafeNonNegativeInteger(database.bytes)
  )
    throw new Error("Unsupported verified backup database");
  return manifest;
}

/**
 * Estimate the bytes written by `restoreFullBackup` into a new destination.
 * The asset tree is measured on disk instead of trusting the manifest's asset
 * list: measure what is currently on disk, even if the directory changed
 * since verification. Restore re-verifies before copying. The actual database
 * file size is used when it is larger than the verified manifest declaration;
 * restore itself refuses such a mismatch before copying.
 */
export function estimateRestoreBytes(
  verified: VerifiedWorkspaceBackup,
): number {
  const manifest = assertSupportedManifest(verified);
  const root = requireDirectory(verified.directory, "Backup");
  const databaseBytes = requireFileSize(
    join(root, manifest.database.path),
    "Backup database",
  );
  const databaseBudget = Math.max(manifest.database.bytes, databaseBytes);
  const assets = inspectAssetTree(join(root, ASSETS));

  const manifestInfo = lstatOptional(join(root, MANIFEST));
  let manifestBytes = 0;
  if (manifestInfo) {
    if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile())
      throw new Error("Backup manifest is not a regular file");
    if (!isSafeNonNegativeInteger(manifestInfo.size))
      throw new Error("Backup manifest size is unsupported");
    manifestBytes = manifestInfo.size;
  }

  return budgetAdd(
    budgetAdd(
      budgetAdd(databaseBudget, assets.bytes, "Restore estimate"),
      manifestBytes,
      "Restore estimate",
    ),
    metadataOverhead(budgetAdd(assets.entries, 2, "Restore metadata")),
    "Restore estimate",
  );
}
