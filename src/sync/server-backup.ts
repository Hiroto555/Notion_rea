import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statfsSync,
  unlinkSync,
} from "node:fs";
import {
  basename,
  dirname,
  join,
  resolve,
} from "node:path";
import { DatabaseSync } from "node:sqlite";
import { syncPath, writeNewFileDurably } from "../persistence/durable-file";
import { sqliteAllocatedBytes } from "../persistence/sqlite-allocation";
import { DEFAULT_STORAGE_RESERVE_BYTES } from "../shared/storage-pressure";
import {
  hashCheckpoint,
  identifier,
  parseCheckpoint,
  requireCondition,
  SyncError,
} from "./protocol";

export const CHECKPOINT_SERVER_BACKUP_FORMAT = "folio-checkpoint-server-backup";
export const CHECKPOINT_SERVER_BACKUP_VERSION = 1;
export const CHECKPOINT_SERVER_BACKUP_DATABASE = "server.sqlite";
export const CHECKPOINT_SERVER_BACKUP_MANIFEST = "manifest.json";
export const CHECKPOINT_SERVER_BACKUP_MARKER =
  "FOLIO-SERVER-BACKUP-INCOMPLETE";
export const CHECKPOINT_SERVER_BACKUP_MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

const INCOMPLETE_MESSAGE =
  "Server backup incomplete; do not use this snapshot.\n";
const HASH_CHUNK_BYTES = 1024 * 1024;
const MAX_BACKUP_WORKSPACES = 100_000;

export type CheckpointServerBackupWorkspace = {
  workspaceId: string;
  revision: number;
  checkpointHash: string | null;
};

export type CheckpointServerBackupCounts = {
  workspaces: number;
  changes: number;
  operations: number;
  devices: number;
  activeDevices: number;
  revokedDevices: number;
};

/**
 * Catalog-scoped backup manifest. Attachment blobs are owned by the host's
 * blob adapter and are deliberately excluded from this snapshot. The count
 * records how many asset references the current heads contain so an operator
 * cannot mistake this catalog backup for a complete attachment backup.
 */
export type CheckpointServerBackupManifest = {
  format: typeof CHECKPOINT_SERVER_BACKUP_FORMAT;
  version: typeof CHECKPOINT_SERVER_BACKUP_VERSION;
  createdAt: string;
  serverEpoch: string;
  scope: "catalog";
  database: {
    path: typeof CHECKPOINT_SERVER_BACKUP_DATABASE;
    bytes: number;
    sha256: string;
  };
  counts: CheckpointServerBackupCounts;
  workspaces: CheckpointServerBackupWorkspace[];
  attachments: {
    included: false;
    headAssetReferences: number;
  };
};

export type CheckpointServerBackup = {
  /** The caller's requested path, resolved; existing symlink ancestors may
   * mean the actual directory lives at its canonical path. */
  destination: string;
  manifest: CheckpointServerBackupManifest;
};

export type CheckpointServerBackupOptions = {
  db: DatabaseSync;
  databasePath: string;
  destination: string;
  serverEpoch: string;
  /** Optional filesystem probe seam for isolated tests. */
  capacityProbe?: (path: string) => {bsize: bigint; bavail: bigint};
};

type CatalogSummary = {
  epoch: string;
  heads: CheckpointServerBackupWorkspace[];
  counts: CheckpointServerBackupCounts;
  headAssetReferences: number;
};

/** Best-effort preflight, not a reservation: other processes may consume
 * space after this check. Probe source and destination volumes before writing. */
export function assertServerBackupCapacity(
  db: DatabaseSync,
  directories: readonly string[],
  probe: (path: string) => {bsize: bigint; bavail: bigint} = (path) => statfsSync(path, {bigint: true}),
): void {
  let required: bigint;
  try {
    required = BigInt(sqliteAllocatedBytes(db)) * 2n +
      BigInt(CHECKPOINT_SERVER_BACKUP_MAX_MANIFEST_BYTES + DEFAULT_STORAGE_RESERVE_BYTES);
  } catch {throw new SyncError("server-backup-capacity-unknown", 503);}
  for (const directory of directories) {
    let stats: {bsize: bigint; bavail: bigint};
    try {stats = probe(directory);} catch {throw new SyncError("server-backup-capacity-unknown", 503);}
    if (!stats || typeof stats.bsize !== "bigint" || typeof stats.bavail !== "bigint" ||
        stats.bsize <= 0n || stats.bavail < 0n)
      throw new SyncError("server-backup-capacity-unknown", 503);
    if (stats.bsize * stats.bavail < required) throw new SyncError("insufficient-storage", 507);
  }
}

function lstatIfExists(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Resolve existing ancestors, but never silently accept a missing parent. */
function actualPath(path: string): string {
  const absolute = resolve(path);
  const info = lstatIfExists(absolute);
  if (info) {
    try {
      return realpathSync(absolute);
    } catch {
      throw new SyncError("invalid-backup-destination");
    }
  }
  const parent = dirname(absolute);
  if (parent === absolute)
    throw new SyncError("invalid-backup-destination");
  const actualParent = actualPath(parent);
  const parentInfo = lstatIfExists(actualParent);
  requireCondition(
    parentInfo !== undefined && parentInfo.isDirectory(),
    "invalid-backup-destination",
  );
  return join(actualParent, basename(absolute));
}

function requireSafeSource(databasePath: string): string {
  requireCondition(typeof databasePath === "string" && databasePath.length > 0 && !databasePath.includes("\0"),
    "unsafe-backup-source", 409);
  const source = resolve(databasePath);
  let info!: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(source);
  } catch {
    throw new SyncError("unsafe-backup-source", 409);
  }
  requireCondition(
    !info.isSymbolicLink() && info.isFile() && info.nlink === 1,
    "unsafe-backup-source",
    409,
  );
  try {
    return realpathSync(source);
  } catch {
    throw new SyncError("unsafe-backup-source", 409);
  }
}

/** Exclusive creation reserves the exact destination directory. */
function prepareDestination(destination: string, source: string): string {
  requireCondition(
    typeof destination === "string" &&
      destination.length > 0 &&
      destination.length <= 4_096 && !destination.includes("\0"),
    "invalid-backup-destination",
  );
  const requested = resolve(destination);
  requireCondition(
    lstatIfExists(requested) === undefined,
    "backup-destination-exists",
    409,
  );
  const target = actualPath(requested);
  requireCondition(
    lstatIfExists(target) === undefined,
    "backup-destination-exists",
    409,
  );
  requireCondition(
    target !== source &&
      target !== source + "-wal" &&
      target !== source + "-shm" &&
      target !== source + "-journal",
    "unsafe-backup-destination",
    409,
  );
  try {
    mkdirSync(target, { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST")
      throw new SyncError("backup-destination-exists", 409);
    if (
      code === "ENOENT" ||
      code === "ENOTDIR" ||
      code === "ENAMETOOLONG"
    )
      throw new SyncError("invalid-backup-destination");
    if (code === "ENOSPC")
      throw new SyncError("insufficient-storage", 507);
    throw error;
  }
  const created = lstatSync(target);
  let canonical!: string;
  try {
    canonical = realpathSync(target);
  } catch {
    throw new SyncError("unsafe-backup-destination", 409);
  }
  requireCondition(
    !created.isSymbolicLink() &&
      created.isDirectory() &&
      canonical === target,
    "unsafe-backup-destination",
    409,
  );
  return target;
}

function safeCount(value: unknown): number {
  const number = Number(value);
  requireCondition(
    Number.isSafeInteger(number) && number >= 0,
    "server-backup-verification-failed",
    422,
  );
  return number;
}

function readCatalog(
  db: DatabaseSync,
  expectedEpoch?: string,
): CatalogSummary {
  let summary!: CatalogSummary;
  try {
    const identity = db
      .prepare(
        "SELECT singleton, version, epoch FROM checkpoint_server_identity",
      )
      .all() as Record<string, unknown>[];
    requireCondition(
      identity.length === 1 &&
        Number(identity[0].singleton) === 1 &&
        Number(identity[0].version) === 1,
      "server-backup-verification-failed",
      422,
    );
    const epoch = identifier(identity[0].epoch);

    const heads: CheckpointServerBackupWorkspace[] = [];
    let headAssetReferences = 0;
    const headRows = db
      .prepare(
        "SELECT workspace_id, revision, checkpoint_hash, checkpoint_json FROM checkpoint_heads ORDER BY workspace_id LIMIT ?",
      )
      .all(MAX_BACKUP_WORKSPACES + 1) as Record<string, unknown>[];
    for (const row of headRows) {
      requireCondition(
        heads.length < MAX_BACKUP_WORKSPACES,
        "server-backup-too-large",
        413,
      );
      const workspaceId = identifier(row.workspace_id);
      const revision = Number(row.revision);
      requireCondition(
        Number.isSafeInteger(revision) && revision >= 0,
        "server-backup-verification-failed",
        422,
      );
      const checkpointHash =
        row.checkpoint_hash === null ? null : String(row.checkpoint_hash);
      const checkpointJson =
        row.checkpoint_json === null ? null : String(row.checkpoint_json);
      if (revision === 0) {
        requireCondition(
          checkpointHash === null && checkpointJson === null,
          "server-backup-verification-failed",
          422,
        );
      } else {
        requireCondition(
          typeof checkpointHash === "string" &&
            /^[a-f0-9]{64}$/.test(checkpointHash),
          "server-backup-verification-failed",
          422,
        );
        requireCondition(
          typeof checkpointJson === "string",
          "server-backup-verification-failed",
          422,
        );
        const checkpoint = parseCheckpoint(JSON.parse(checkpointJson));
        requireCondition(
          hashCheckpoint(checkpoint) === checkpointHash,
          "server-backup-verification-failed",
          422,
        );
        headAssetReferences += checkpoint.assets.length;
      }
      heads.push({ workspaceId, revision, checkpointHash });
    }

    const countRow = db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM checkpoint_heads) AS workspaces,
          (SELECT COUNT(*) FROM checkpoint_changes) AS changes,
          (SELECT COUNT(*) FROM checkpoint_operations) AS operations,
          (SELECT COUNT(*) FROM checkpoint_devices) AS devices,
          (SELECT COUNT(*) FROM checkpoint_devices WHERE revoked=0) AS active_devices,
          (SELECT COUNT(*) FROM checkpoint_devices WHERE revoked=1) AS revoked_devices`,
      )
      .get() as Record<string, unknown>;
    const counts: CheckpointServerBackupCounts = {
      workspaces: safeCount(countRow.workspaces),
      changes: safeCount(countRow.changes),
      operations: safeCount(countRow.operations),
      devices: safeCount(countRow.devices),
      activeDevices: safeCount(countRow.active_devices),
      revokedDevices: safeCount(countRow.revoked_devices),
    };
    requireCondition(
      counts.workspaces === heads.length &&
        counts.devices === counts.activeDevices + counts.revokedDevices,
      "server-backup-verification-failed",
      422,
    );

    const ranges = db
      .prepare(
        `SELECT workspace_id, COUNT(*) AS count, MIN(revision) AS first, MAX(revision) AS last
         FROM checkpoint_changes GROUP BY workspace_id LIMIT ?`,
      )
      .all(MAX_BACKUP_WORKSPACES + 1) as Record<string, unknown>[];
    requireCondition(ranges.length <= MAX_BACKUP_WORKSPACES, "server-backup-too-large", 413);
    const rangeById = new Map<
      string,
      { count: number; first: number; last: number }
    >();
    for (const row of ranges) {
      const workspaceId = identifier(row.workspace_id);
      requireCondition(
        !rangeById.has(workspaceId),
        "server-backup-verification-failed",
        422,
      );
      rangeById.set(workspaceId, {
        count: safeCount(row.count),
        first: safeCount(row.first),
        last: safeCount(row.last),
      });
    }
    const headIds = new Set(heads.map((head) => head.workspaceId));
    for (const workspaceId of rangeById.keys())
      requireCondition(
        headIds.has(workspaceId),
        "server-backup-verification-failed",
        422,
      );
    for (const head of heads) {
      const range = rangeById.get(head.workspaceId);
      if (head.revision === 0) {
        requireCondition(
          range === undefined,
          "server-backup-verification-failed",
          422,
        );
      } else {
        requireCondition(
          range !== undefined,
          "server-backup-verification-failed",
          422,
        );
        requireCondition(
          range.count === head.revision &&
            range.first === 1 &&
            range.last === head.revision,
          "server-backup-verification-failed",
          422,
        );
      }
    }

    summary = { epoch, heads, counts, headAssetReferences };
  } catch (error) {
    if (
      error instanceof SyncError &&
      (error.code === "server-backup-verification-failed" ||
        error.code === "server-backup-too-large")
    )
      throw error;
    throw new SyncError("server-backup-verification-failed", 422);
  }
  if (expectedEpoch !== undefined)
    requireCondition(
      summary.epoch === expectedEpoch,
      "server-backup-epoch-mismatch",
      409,
    );
  return summary;
}

function catalogFingerprint(summary: CatalogSummary): string {
  return createHash("sha256")
    .update(JSON.stringify(summary))
    .digest("hex");
}

function inspectSnapshot(path: string): { bytes: number; sha256: string } {
  const before = lstatSync(path);
  requireCondition(
    !before.isSymbolicLink() && before.isFile(),
    "server-backup-verification-failed",
    422,
  );
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY |
        (fsConstants.O_NOFOLLOW ?? 0) |
        fsConstants.O_NONBLOCK,
    );
  } catch {
    throw new SyncError("server-backup-verification-failed", 422);
  }
  try {
    const opened = fstatSync(descriptor);
    requireCondition(
      opened.isFile() &&
        opened.dev === before.dev &&
        opened.ino === before.ino,
      "server-backup-verification-failed",
      422,
    );
    if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let bytes = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      bytes += read;
      digest.update(buffer.subarray(0, read));
    }
    const after = fstatSync(descriptor);
    requireCondition(
      after.isFile() &&
        after.size === bytes &&
        after.dev === opened.dev &&
        after.ino === opened.ino,
      "server-backup-verification-failed",
      422,
    );
    return { bytes, sha256: digest.digest("hex") };
  } finally {
    closeSync(descriptor);
  }
}

function verifySnapshot(
  path: string,
  expectedEpoch: string,
): {
  file: { bytes: number; sha256: string };
  summary: CatalogSummary;
} {
  for (const suffix of ["-wal", "-shm", "-journal"])
    requireCondition(
      lstatIfExists(path + suffix) === undefined,
      "server-backup-verification-failed",
      422,
    );
  const file = inspectSnapshot(path);
  let snapshot: DatabaseSync | undefined;
  try {
    snapshot = new DatabaseSync(path, { readOnly: true });
    const integrity = snapshot
      .prepare("PRAGMA integrity_check")
      .all() as Record<string, unknown>[];
    requireCondition(
      integrity.length === 1 &&
        Object.values(integrity[0])[0] === "ok",
      "server-backup-verification-failed",
      422,
    );
    return {
      file,
      summary: readCatalog(snapshot, expectedEpoch),
    };
  } catch (error) {
    if (error instanceof SyncError) throw error;
    throw new SyncError("server-backup-verification-failed", 422);
  } finally {
    snapshot?.close();
  }
}

function manifestFor(
  summary: CatalogSummary,
  file: { bytes: number; sha256: string },
): CheckpointServerBackupManifest {
  return {
    format: CHECKPOINT_SERVER_BACKUP_FORMAT,
    version: CHECKPOINT_SERVER_BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    serverEpoch: summary.epoch,
    scope: "catalog",
    database: {
      path: CHECKPOINT_SERVER_BACKUP_DATABASE,
      bytes: file.bytes,
      sha256: file.sha256,
    },
    counts: summary.counts,
    workspaces: summary.heads,
    attachments: {
      included: false,
      headAssetReferences: summary.headAssetReferences,
    },
  };
}

function writeManifest(
  target: string,
  manifest: CheckpointServerBackupManifest,
): void {
  const content = JSON.stringify(manifest, null, 2);
  requireCondition(
    Buffer.byteLength(content) <= CHECKPOINT_SERVER_BACKUP_MAX_MANIFEST_BYTES,
    "server-backup-manifest-too-large",
    413,
  );
  const pending = join(target, `.manifest-${randomUUID()}.tmp`);
  const published = join(target, CHECKPOINT_SERVER_BACKUP_MANIFEST);
  // `writeNewFileDurably` only removes a file that its own exclusive create
  // proved it created. Do not unlink `pending` when that write fails.
  writeNewFileDurably(pending, content, { mode: 0o600 });
  try {
    // Hard-link publication is exclusive and never replaces an existing file.
    linkSync(pending, published);
  } catch (error) {
    // Keep the temporary file for inspection: its path may have been replaced
    // since creation, so a cleanup by name could remove another file.
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new SyncError("server-backup-publication-failed", 500);
    throw error;
  }
  syncPath(published);
  syncPath(target);
  // Retain the small extra hard link rather than deleting an unverified path.
}

/**
 * Create a catalog backup of a live checkpoint server through its own guarded
 * connection. `VACUUM INTO` runs synchronously on the server's event loop, so
 * no in-process commit can interleave with the snapshot. Source summaries are
 * read before and after the copy and compared with the snapshot. These
 * summaries detect some changes but do not exclude every external writer;
 * SQLite provides the consistency of the point-in-time snapshot.
 *
 * The destination directory is created exclusively. Existing files, symlinks,
 * the live database, and its sidecars are never replaced or removed. Any
 * failure after reservation leaves the incomplete marker and partial output for
 * diagnosis. No restore, epoch rotation, or attachment export is provided here.
 */
export function createCheckpointServerBackup(
  options: CheckpointServerBackupOptions,
): CheckpointServerBackup {
  requireCondition(
    options !== null && typeof options === "object",
    "invalid-backup-options",
  );
  const serverEpoch = identifier(options.serverEpoch);
  requireCondition(
    options.db !== null &&
      typeof options.db === "object" &&
      options.db.isTransaction === false,
    "server-backup-busy",
    409,
  );
  const source = requireSafeSource(options.databasePath);
  try {
    const main = options.db.prepare("PRAGMA database_list").all().find((row) => row.name === "main");
    requireCondition(typeof main?.file === "string" && realpathSync(main.file) === source,
      "unsafe-backup-source", 409);
  } catch (error) {
    if (error instanceof SyncError) throw error;
    throw new SyncError("unsafe-backup-source", 409);
  }
  requireCondition(typeof options.destination === "string" && options.destination.length > 0 &&
    options.destination.length <= 4096 && !options.destination.includes("\0"), "invalid-backup-destination");
  requireCondition(lstatIfExists(resolve(options.destination)) === undefined, "backup-destination-exists", 409);
  const targetForCapacity = actualPath(options.destination);
  assertServerBackupCapacity(options.db, [dirname(source), dirname(targetForCapacity)], options.capacityProbe);
  const before = readCatalog(options.db, serverEpoch);
  const target = prepareDestination(options.destination, source);
  const marker = join(target, CHECKPOINT_SERVER_BACKUP_MARKER);
  writeNewFileDurably(marker, INCOMPLETE_MESSAGE, {
    mode: 0o600,
    syncParentDirectory: true,
  });
  syncPath(dirname(target));

  const snapshotPath = join(target, CHECKPOINT_SERVER_BACKUP_DATABASE);
  try {
    options.db.prepare("VACUUM INTO ?").run(snapshotPath);
  } catch (error) {
    const message = String((error as Error)?.message);
    if (
      (error as NodeJS.ErrnoException).code === "ENOSPC" ||
      /database or disk is full/i.test(message)
    )
      throw new SyncError("insufficient-storage", 507);
    if (/database is locked|database is busy/i.test(message))
      throw new SyncError("server-backup-busy", 409);
    throw error;
  }

  const snapshot = verifySnapshot(snapshotPath, serverEpoch);
  const after = readCatalog(options.db, serverEpoch);
  const expected = catalogFingerprint(snapshot.summary);
  requireCondition(
    catalogFingerprint(before) === expected &&
      catalogFingerprint(after) === expected,
    "server-backup-changed-during-backup",
    409,
  );
  const rechecked = inspectSnapshot(snapshotPath);
  requireCondition(rechecked.bytes === snapshot.file.bytes && rechecked.sha256 === snapshot.file.sha256,
    "server-backup-verification-failed", 422);
  syncPath(target);

  const manifest = manifestFor(snapshot.summary, snapshot.file);
  writeManifest(target, manifest);
  unlinkSync(marker);
  try {
    syncPath(target);
  } catch (error) {
    try {
      writeNewFileDurably(marker, INCOMPLETE_MESSAGE, { mode: 0o600 });
      syncPath(target);
    } catch {
      // Preserve the original durability failure.
    }
    throw error;
  }
  return { destination: resolve(options.destination), manifest };
}
