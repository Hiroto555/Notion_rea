import { lstatSync, opendirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AssetRegistryObservation,
  StorageOverview,
} from "../shared/storage-overview";
import { sqliteAllocatedBytes } from "./sqlite-allocation";
import { mergeUsageStates } from "../shared/storage-usage";
import type { TreeUsage } from "../shared/storage-usage";
import { readStorageUsage, scanDirectoryTree } from "./storage-usage";

const unknownRegistry: AssetRegistryObservation = {
  state: "partial",
  unregisteredFiles: null,
  missingFiles: null,
};

// Registry entries use flat storage names. Legacy documents can still refer to
// unregistered files, so this observation never grants permission to remove one.
function observeRegistry(
  db: DatabaseSync,
  assets: string,
): AssetRegistryObservation {
  const limit = 20_000;
  try {
    const registry = new Set<string>();
    for (const row of db
      .prepare(
        "SELECT id, substr(metadata,1,65537) AS metadata FROM assets LIMIT ?",
      )
      .iterate(limit + 1)) {
      if (
        registry.size >= limit ||
        typeof row.id !== "string" ||
        typeof row.metadata !== "string" ||
        row.metadata.length > 65536
      )
        return unknownRegistry;
      const meta = JSON.parse(row.metadata);
      if (meta?.id !== row.id || meta?.storageName !== row.id)
        return unknownRegistry;
      registry.add(row.id);
    }
    try {
      if (!lstatSync(assets).isDirectory()) return unknownRegistry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return {
          state: "complete",
          unregisteredFiles: 0,
          missingFiles: registry.size,
        };
      throw error;
    }
    let observed = 0,
      unregistered = 0;
    const dir = opendirSync(assets);
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (++observed > limit || !entry.isFile()) return unknownRegistry;
        if (!registry.delete(entry.name)) unregistered++;
      }
    } finally {
      dir.closeSync();
    }
    return {
      state: "complete",
      unregisteredFiles: unregistered,
      missingFiles: registry.size,
    };
  } catch {
    return unknownRegistry;
  }
}

/**
 * Missing staging contributes zero bytes. A symlink, truncated scan or counter
 * overflow is unmeasured: return null rather than under-report the footprint.
 */
export function syncStagingBytesFromUsage(usage: TreeUsage): number | null {
  if (usage.root === "missing")
    return usage.state === "complete" && usage.bytes === 0 && !usage.overflow &&
      !usage.truncated && usage.symlinks === 0 && usage.unscannedEntries === 0 ? 0 : null;
  if (
    usage.root !== "present" ||
    usage.state !== "complete" ||
    usage.symlinks !== 0 ||
    usage.unscannedEntries !== 0 ||
    usage.overflow ||
    usage.truncated ||
    typeof usage.bytes !== "number" ||
    !Number.isSafeInteger(usage.bytes) ||
    usage.bytes < 0
  )
    return null;
  return usage.bytes;
}

// A dedicated read-only connection avoids Store's migrations and startup writes.
export function readWorkspaceOverview(path: string): StorageOverview {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1500");
    const readSnapshot = <T>(read: () => T): T => {
      db.exec("BEGIN");
      try {
        return read();
      } finally {
        db.exec("ROLLBACK");
      }
    };
    const report = readStorageUsage({ path, db, readSnapshot });

    // The attachment cap includes received staging as well as active assets.
    // Show the same managed footprint rather than a misleading smaller total.
    let syncStagingBytes: number | null = null;
    try {
      syncStagingBytes = syncStagingBytesFromUsage(
        scanDirectoryTree(join(dirname(path), ".folio-sync-assets-staging"))
          .usage,
      );
    } catch {
      /* Keep the rest of the diagnostics available. */
    }
    const withStaging = (value: number | null) => {
      if (value === null || syncStagingBytes === null) return null;
      const sum = value + syncStagingBytes;
      return Number.isSafeInteger(sum) && sum >= 0 ? sum : null;
    };
    const assetBytes = withStaging(report.totals.assetFileBytes);
    const totalBytes = withStaging(report.totals.totalFileBytes);

    const registry = observeRegistry(db, join(dirname(path), "assets"));
    let databaseLogicalBytes: number | null = null;
    try {
      databaseLogicalBytes = sqliteAllocatedBytes(db);
    } catch {
      /* Surface the incomplete observation. */
    }
    return {
      checkedAt: report.generatedAt,
      state: mergeUsageStates([
        report.state,
        registry.state,
        databaseLogicalBytes === null ? "partial" : "complete",
        assetBytes === null || totalBytes === null ? "unknown" : "complete",
        syncStagingBytes === null ? "unknown" : "complete",
      ]),
      databaseLogicalBytes,
      totalBytes,
      databaseBytes: report.totals.databaseFileBytes,
      assetBytes,
      syncStagingBytes,
      backupBytes: report.totals.backupFileBytes,
      receiptRows: report.database.receipts.rows,
      receiptBytes: report.database.receipts.storedBytes,
      completeBackups: report.workspace.backups.complete,
      incompleteBackups: report.workspace.backups.incomplete,
      unknownBackups: report.workspace.backups.unknown,
      registry,
    };
  } finally {
    db.close();
  }
}
