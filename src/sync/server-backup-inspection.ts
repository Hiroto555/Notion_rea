import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  hashCheckpoint,
  parseCheckpoint,
  SyncError,
} from "./protocol";
import {
  CHECKPOINT_SERVER_BACKUP_DATABASE,
  CHECKPOINT_SERVER_BACKUP_FORMAT,
  CHECKPOINT_SERVER_BACKUP_MANIFEST,
  CHECKPOINT_SERVER_BACKUP_MARKER,
  CHECKPOINT_SERVER_BACKUP_MAX_MANIFEST_BYTES,
  CHECKPOINT_SERVER_BACKUP_VERSION,
  type CheckpointServerBackupCounts,
  type CheckpointServerBackupManifest,
  type CheckpointServerBackupWorkspace,
} from "./server-backup";

const HASH_CHUNK_BYTES = 1024 * 1024;
export const DEFAULT_MAX_INSPECTION_DATABASE_BYTES = 1024 * 1024 * 1024;
const MAX_INSPECTION_WORKSPACES = 100_000;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const PUBLICATION_TEMP =
  /^\.manifest-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
const SQLITE_HEADER = "SQLite format 3\u0000";
const INCOMPLETE = "server-backup-incomplete";
const FAILED = "server-backup-verification-failed";
const UNSUPPORTED = "server-backup-unsupported-format";
const UNSAFE = "server-backup-unsafe-file";
const CHANGED = "server-backup-changed-during-inspection";
const EPOCH_MISMATCH = "server-backup-epoch-mismatch";
const ATTACHMENT_NOTICE =
  "Attachment bytes are excluded from this catalog backup.";

export type CheckpointServerBackupInspection = {
  directory: string;
  /** This is not a restore-readiness or complete logical-history check. */
  coverage: {
    scope: "manifest-and-catalog-summary";
    historyAndReceipts: "not-validated";
    restore: "not-validated";
    concurrentWriters: "not-excluded";
  };
  manifest: CheckpointServerBackupManifest;
  database: {
    path: typeof CHECKPOINT_SERVER_BACKUP_DATABASE;
    bytes: number;
    sha256: string;
  };
  serverEpoch: string;
  counts: CheckpointServerBackupCounts;
  workspaces: CheckpointServerBackupWorkspace[];
  attachments: {
    included: false;
    bytes: "excluded";
    headAssetReferences: number;
    message: typeof ATTACHMENT_NOTICE;
  };
};

export type CheckpointServerBackupInspectionOptions = {
  expectedEpoch?: string;
  /** Caller can explicitly select a different limit; no truncation occurs. */
  maxDatabaseBytes?: number;
};

type CatalogSummary = {
  epoch: string;
  heads: CheckpointServerBackupWorkspace[];
  counts: CheckpointServerBackupCounts;
  headAssetReferences: number;
};

type DirectoryEntry = {
  name: string;
  dev: number;
  ino: number;
  kind: "file" | "directory" | "symlink" | "other";
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

type ScannedFile = {
  bytes: number;
  sha256: string;
  stat: Stats;
  header: Buffer;
  data?: Buffer;
};

function verification(value: unknown): asserts value {
  if (!value) throw new SyncError(FAILED, 422);
}

function unsafe(value: unknown): asserts value {
  if (!value) throw new SyncError(UNSAFE, 409);
}

function changed(value: unknown): asserts value {
  if (!value) throw new SyncError(CHANGED, 409);
}

function lstatIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function sameStats(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function entryKind(info: Stats): DirectoryEntry["kind"] {
  if (info.isSymbolicLink()) return "symlink";
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  return "other";
}

function snapshotDirectory(directory: string): DirectoryEntry[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    throw new SyncError(FAILED, 422);
  }
  names.sort();
  return names.map((name) => {
    let info: Stats;
    try {
      info = lstatSync(join(directory, name));
    } catch {
      throw new SyncError(FAILED, 422);
    }
    return {
      name,
      dev: info.dev,
      ino: info.ino,
      kind: entryKind(info),
      nlink: info.nlink,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
    };
  });
}

function sameEntries(
  left: readonly DirectoryEntry[],
  right: readonly DirectoryEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return (
        entry.name === other.name &&
        entry.dev === other.dev &&
        entry.ino === other.ino &&
        entry.kind === other.kind &&
        entry.nlink === other.nlink &&
        entry.size === other.size &&
        entry.mtimeMs === other.mtimeMs &&
        entry.ctimeMs === other.ctimeMs
      );
    })
  );
}

function requireDirectory(directory: string): string {
  if (
    typeof directory !== "string" ||
    directory.length === 0 ||
    directory.length > 4_096 ||
    directory.includes("\0")
  )
    throw new SyncError("invalid-backup-destination");
  const requested = resolve(directory);
  const info = lstatIfExists(requested);
  if (info === undefined) throw new SyncError("invalid-backup-destination");
  unsafe(!info.isSymbolicLink() && info.isDirectory());
  let actual: string;
  try {
    actual = realpathSync(requested);
  } catch {
    throw new SyncError("invalid-backup-destination");
  }
  unsafe(actual === requested);
  return actual;
}

function requireDirectoryShape(
  entries: readonly DirectoryEntry[],
  manifest: Stats,
  database: Stats,
): void {
  const names = new Set(entries.map((entry) => entry.name));
  verification(
    names.has(CHECKPOINT_SERVER_BACKUP_MANIFEST) &&
      names.has(CHECKPOINT_SERVER_BACKUP_DATABASE),
  );
  let publicationLinks = 0;
  for (const entry of entries) {
    if (
      entry.name === CHECKPOINT_SERVER_BACKUP_MANIFEST ||
      entry.name === CHECKPOINT_SERVER_BACKUP_DATABASE
    ) {
      unsafe(entry.kind === "file");
      continue;
    }
    unsafe(PUBLICATION_TEMP.test(entry.name) && entry.kind === "file");
    unsafe(
      entry.dev === manifest.dev &&
        entry.ino === manifest.ino &&
        entry.nlink === 2,
    );
    publicationLinks++;
  }
  unsafe(database.nlink === 1);
  unsafe(
    (manifest.nlink === 1 && publicationLinks === 0) ||
      (manifest.nlink === 2 && publicationLinks === 1),
  );
}

function scanFile(
  path: string,
  maxBytes: number,
  options: { collect: boolean; tooLargeCode: string },
): ScannedFile {
  const before = lstatIfExists(path);
  verification(before !== undefined);
  unsafe(!before.isSymbolicLink() && before.isFile());
  if (before.size > maxBytes)
    throw new SyncError(options.tooLargeCode, 413);
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY |
        (fsConstants.O_NOFOLLOW ?? 0) |
        (fsConstants.O_NONBLOCK ?? 0),
    );
  } catch {
    throw new SyncError(FAILED, 422);
  }
  try {
    const opened = fstatSync(descriptor);
    unsafe(
      opened.isFile() &&
        opened.dev === before.dev &&
        opened.ino === before.ino &&
        opened.nlink === before.nlink,
    );
    const digest = createHash("sha256");
    const chunks: Buffer[] = [];
    const headerParts: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let headerBytes = 0;
    let bytes = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      bytes += read;
      if (bytes > maxBytes)
        throw new SyncError(options.tooLargeCode, 413);
      digest.update(buffer.subarray(0, read));
      if (options.collect) chunks.push(Buffer.from(buffer.subarray(0, read)));
      if (headerBytes < 100) {
        const take = Math.min(100 - headerBytes, read);
        headerParts.push(Buffer.from(buffer.subarray(0, take)));
        headerBytes += take;
      }
    }
    const after = fstatSync(descriptor);
    changed(
      after.isFile() &&
        after.size === bytes &&
        after.dev === opened.dev &&
        after.ino === opened.ino &&
        after.nlink === opened.nlink &&
        after.mtimeMs === opened.mtimeMs &&
        after.ctimeMs === opened.ctimeMs,
    );
    const current = lstatIfExists(path);
    changed(current !== undefined && sameStats(current, after));
    const result: ScannedFile = {
      bytes,
      sha256: digest.digest("hex"),
      stat: after,
      header: Buffer.concat(headerParts, headerBytes),
    };
    if (options.collect) result.data = Buffer.concat(chunks, bytes);
    return result;
  } finally {
    closeSync(descriptor);
  }
}

function object(value: unknown): Record<string, unknown> {
  verification(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}

function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const result = object(value);
  verification(
    Object.keys(result).length === keys.length &&
      keys.every((key) => Object.hasOwn(result, key)),
  );
  return result;
}

function safeInteger(value: unknown, minimum = 0): number {
  verification(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= minimum,
  );
  return value;
}

function hashString(value: unknown): string {
  verification(typeof value === "string" && HASH.test(value));
  return value;
}

function integerIdentifier(value: unknown): string {
  verification(typeof value === "string" && IDENTIFIER.test(value));
  return value;
}

function validateManifest(value: unknown): CheckpointServerBackupManifest {
  const top = exact(value, [
    "format",
    "version",
    "createdAt",
    "serverEpoch",
    "scope",
    "database",
    "counts",
    "workspaces",
    "attachments",
  ]);
  if (
    top.format !== CHECKPOINT_SERVER_BACKUP_FORMAT ||
    top.version !== CHECKPOINT_SERVER_BACKUP_VERSION ||
    top.scope !== "catalog"
  )
    throw new SyncError(UNSUPPORTED, 422);
  verification(
    typeof top.createdAt === "string" &&
      top.createdAt.length <= 64 &&
      Number.isFinite(Date.parse(top.createdAt)),
  );
  const serverEpoch = integerIdentifier(top.serverEpoch);

  const database = exact(top.database, ["path", "bytes", "sha256"]);
  verification(database.path === CHECKPOINT_SERVER_BACKUP_DATABASE);
  const databaseBytes = safeInteger(database.bytes, 1);
  const databaseSha256 = hashString(database.sha256);

  const counts = exact(top.counts, [
    "workspaces",
    "changes",
    "operations",
    "devices",
    "activeDevices",
    "revokedDevices",
  ]);
  const countValues: CheckpointServerBackupCounts = {
    workspaces: safeInteger(counts.workspaces),
    changes: safeInteger(counts.changes),
    operations: safeInteger(counts.operations),
    devices: safeInteger(counts.devices),
    activeDevices: safeInteger(counts.activeDevices),
    revokedDevices: safeInteger(counts.revokedDevices),
  };
  verification(
    countValues.devices ===
      countValues.activeDevices + countValues.revokedDevices,
  );

  verification(
    Array.isArray(top.workspaces) &&
      top.workspaces.length <= MAX_INSPECTION_WORKSPACES,
  );
  const workspaces: CheckpointServerBackupWorkspace[] = [];
  let previous = "";
  for (const [index, item] of top.workspaces.entries()) {
    const workspace = exact(item, [
      "workspaceId",
      "revision",
      "checkpointHash",
    ]);
    const workspaceId = integerIdentifier(workspace.workspaceId);
    if (index > 0) verification(previous < workspaceId);
    previous = workspaceId;
    const revision = safeInteger(workspace.revision);
    let checkpointHash: string | null;
    if (revision === 0) {
      verification(workspace.checkpointHash === null);
      checkpointHash = null;
    } else {
      checkpointHash = hashString(workspace.checkpointHash);
    }
    workspaces.push({ workspaceId, revision, checkpointHash });
  }
  verification(countValues.workspaces === workspaces.length);

  const attachments = exact(top.attachments, [
    "included",
    "headAssetReferences",
  ]);
  verification(attachments.included === false);
  const headAssetReferences = safeInteger(attachments.headAssetReferences);

  return {
    format: CHECKPOINT_SERVER_BACKUP_FORMAT,
    version: CHECKPOINT_SERVER_BACKUP_VERSION,
    createdAt: top.createdAt as string,
    serverEpoch,
    scope: "catalog",
    database: {
      path: CHECKPOINT_SERVER_BACKUP_DATABASE,
      bytes: databaseBytes,
      sha256: databaseSha256,
    },
    counts: countValues,
    workspaces,
    attachments: { included: false, headAssetReferences },
  };
}

function readCatalog(db: DatabaseSync): CatalogSummary {
  try {
    const identity = db
      .prepare(
        "SELECT singleton, version, epoch FROM checkpoint_server_identity",
      )
      .all() as Record<string, unknown>[];
    verification(
      identity.length === 1 &&
        Number(identity[0].singleton) === 1 &&
        Number(identity[0].version) === 1,
    );
    const epoch = integerIdentifier(identity[0].epoch);

    const heads: CheckpointServerBackupWorkspace[] = [];
    let headAssetReferences = 0;
    const headRows = db
      .prepare(
        "SELECT workspace_id, revision, checkpoint_hash, checkpoint_json FROM checkpoint_heads ORDER BY workspace_id LIMIT ?",
      )
      .all(MAX_INSPECTION_WORKSPACES + 1) as Record<string, unknown>[];
    for (const row of headRows) {
      verification(heads.length < MAX_INSPECTION_WORKSPACES);
      const workspaceId = integerIdentifier(row.workspace_id);
      const revision = safeInteger(row.revision);
      const checkpointHash =
        row.checkpoint_hash === null ? null : String(row.checkpoint_hash);
      const checkpointJson =
        row.checkpoint_json === null ? null : String(row.checkpoint_json);
      if (revision === 0) {
        verification(checkpointHash === null && checkpointJson === null);
      } else {
        verification(
          typeof checkpointHash === "string" && HASH.test(checkpointHash),
        );
        verification(typeof checkpointJson === "string");
        const checkpoint = parseCheckpoint(JSON.parse(checkpointJson));
        verification(hashCheckpoint(checkpoint) === checkpointHash);
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
      workspaces: safeInteger(countRow.workspaces),
      changes: safeInteger(countRow.changes),
      operations: safeInteger(countRow.operations),
      devices: safeInteger(countRow.devices),
      activeDevices: safeInteger(countRow.active_devices),
      revokedDevices: safeInteger(countRow.revoked_devices),
    };
    verification(
      counts.workspaces === heads.length &&
        counts.devices === counts.activeDevices + counts.revokedDevices,
    );

    const ranges = db
      .prepare(
        `SELECT workspace_id, COUNT(*) AS count, MIN(revision) AS first, MAX(revision) AS last
         FROM checkpoint_changes GROUP BY workspace_id LIMIT ?`,
      )
      .all(MAX_INSPECTION_WORKSPACES + 1) as Record<string, unknown>[];
    verification(ranges.length <= MAX_INSPECTION_WORKSPACES);
    const rangeById = new Map<
      string,
      { count: number; first: number; last: number }
    >();
    for (const row of ranges) {
      const workspaceId = integerIdentifier(row.workspace_id);
      verification(!rangeById.has(workspaceId));
      rangeById.set(workspaceId, {
        count: safeInteger(row.count),
        first: safeInteger(row.first),
        last: safeInteger(row.last),
      });
    }
    const headIds = new Set(heads.map((head) => head.workspaceId));
    for (const workspaceId of rangeById.keys())
      verification(headIds.has(workspaceId));
    for (const head of heads) {
      const range = rangeById.get(head.workspaceId);
      if (head.revision === 0) {
        verification(range === undefined);
      } else {
        verification(range !== undefined);
        verification(
          range.count === head.revision &&
            range.first === 1 &&
            range.last === head.revision,
        );
      }
    }

    return { epoch, heads, counts, headAssetReferences };
  } catch (error) {
    if (error instanceof SyncError) throw error;
    throw new SyncError(FAILED, 422);
  }
}

function readDatabase(path: string): CatalogSummary {
  let snapshot: DatabaseSync | undefined;
  try {
    // readOnly alone may create WAL/SHM files. Immutable mode prevents SQLite
    // from writing sidecars even if the path changes after the header check.
    snapshot = new DatabaseSync(pathToFileURL(path).href + "?mode=ro&immutable=1", { readOnly: true });
    const integrity = snapshot
      .prepare("PRAGMA integrity_check")
      .all() as Record<string, unknown>[];
    verification(
      integrity.length === 1 &&
        Object.values(integrity[0])[0] === "ok",
    );
    return readCatalog(snapshot);
  } catch (error) {
    if (error instanceof SyncError) throw error;
    throw new SyncError(FAILED, 422);
  } finally {
    try {
      snapshot?.close();
    } catch {}
  }
}

function requireNoSidecars(path: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"])
    verification(lstatIfExists(path + suffix) === undefined);
}

function sameCounts(
  left: CheckpointServerBackupCounts,
  right: CheckpointServerBackupCounts,
): boolean {
  return (
    left.workspaces === right.workspaces &&
    left.changes === right.changes &&
    left.operations === right.operations &&
    left.devices === right.devices &&
    left.activeDevices === right.activeDevices &&
    left.revokedDevices === right.revokedDevices
  );
}

function sameWorkspaces(
  left: readonly CheckpointServerBackupWorkspace[],
  right: readonly CheckpointServerBackupWorkspace[],
): boolean {
  return (
    left.length === right.length &&
    left.every((workspace, index) => {
      const other = right[index];
      return (
        workspace.workspaceId === other.workspaceId &&
        workspace.revision === other.revision &&
        workspace.checkpointHash === other.checkpointHash
      );
    })
  );
}

export function inspectCheckpointServerBackup(
  directory: string,
  options: CheckpointServerBackupInspectionOptions = {},
): CheckpointServerBackupInspection {
  if (options === null || typeof options !== "object" || Array.isArray(options))
    throw new SyncError("invalid-backup-options");
  const maxDatabaseBytes = options.maxDatabaseBytes ?? DEFAULT_MAX_INSPECTION_DATABASE_BYTES;
  if (!Number.isSafeInteger(maxDatabaseBytes) || maxDatabaseBytes <= 0)
    throw new SyncError("invalid-backup-options");
  const root = requireDirectory(directory);
  const manifestPath = join(root, CHECKPOINT_SERVER_BACKUP_MANIFEST);
  const databasePath = join(root, CHECKPOINT_SERVER_BACKUP_DATABASE);
  const markerPath = join(root, CHECKPOINT_SERVER_BACKUP_MARKER);

  if (lstatIfExists(markerPath) !== undefined)
    throw new SyncError(INCOMPLETE, 409);
  requireNoSidecars(databasePath);

  const initialEntries = snapshotDirectory(root);
  const manifestBefore = lstatIfExists(manifestPath);
  const databaseBefore = lstatIfExists(databasePath);
  verification(manifestBefore !== undefined && databaseBefore !== undefined);
  unsafe(
    !manifestBefore.isSymbolicLink() &&
      manifestBefore.isFile() &&
      !databaseBefore.isSymbolicLink() &&
      databaseBefore.isFile(),
  );
  requireDirectoryShape(initialEntries, manifestBefore, databaseBefore);

  const manifestFile = scanFile(
    manifestPath,
    CHECKPOINT_SERVER_BACKUP_MAX_MANIFEST_BYTES,
    { collect: true, tooLargeCode: "server-backup-manifest-too-large" },
  );
  const manifestData = manifestFile.data;
  verification(manifestData !== undefined);
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(manifestData),
    );
  } catch {
    throw new SyncError(FAILED, 422);
  }
  const manifest = validateManifest(manifestValue);
  if (manifest.database.bytes > maxDatabaseBytes)
    throw new SyncError("server-backup-inspection-too-large", 413);

  const databaseFirst = scanFile(databasePath, maxDatabaseBytes, {
    collect: false,
    tooLargeCode: "server-backup-inspection-too-large",
  });
  verification(
    databaseFirst.header.length >= 100 &&
      databaseFirst.header.subarray(0, 16).toString("latin1") ===
        SQLITE_HEADER,
  );
  verification(
    databaseFirst.header[18] !== 2 && databaseFirst.header[19] !== 2,
  );
  verification(
    databaseFirst.bytes === manifest.database.bytes &&
      databaseFirst.sha256 === manifest.database.sha256,
  );
  requireNoSidecars(databasePath);

  const summary = readDatabase(databasePath);
  requireNoSidecars(databasePath);

  const databaseSecond = scanFile(databasePath, maxDatabaseBytes, {
    collect: false,
    tooLargeCode: "server-backup-inspection-too-large",
  });
  verification(
    databaseSecond.bytes === manifest.database.bytes &&
      databaseSecond.sha256 === manifest.database.sha256,
  );
  changed(sameStats(databaseFirst.stat, databaseSecond.stat));

  const manifestSecond = scanFile(
    manifestPath,
    CHECKPOINT_SERVER_BACKUP_MAX_MANIFEST_BYTES,
    { collect: true, tooLargeCode: "server-backup-manifest-too-large" },
  );
  verification(manifestSecond.sha256 === manifestFile.sha256);
  changed(sameStats(manifestFile.stat, manifestSecond.stat));

  if (lstatIfExists(markerPath) !== undefined)
    throw new SyncError(INCOMPLETE, 409);
  const finalEntries = snapshotDirectory(root);
  changed(sameEntries(initialEntries, finalEntries));

  const manifestAfter = lstatIfExists(manifestPath);
  const databaseAfter = lstatIfExists(databasePath);
  changed(
    manifestAfter !== undefined &&
      databaseAfter !== undefined &&
      sameStats(manifestAfter, manifestSecond.stat) &&
      sameStats(databaseAfter, databaseSecond.stat),
  );

  if (summary.epoch !== manifest.serverEpoch)
    throw new SyncError(EPOCH_MISMATCH, 409);
  if (options.expectedEpoch !== undefined) {
    if (
      typeof options.expectedEpoch !== "string" ||
      !IDENTIFIER.test(options.expectedEpoch)
    )
      throw new SyncError("invalid-backup-options");
    if (summary.epoch !== options.expectedEpoch)
      throw new SyncError(EPOCH_MISMATCH, 409);
  }

  verification(sameCounts(summary.counts, manifest.counts));
  verification(sameWorkspaces(summary.heads, manifest.workspaces));
  verification(
    summary.headAssetReferences ===
      manifest.attachments.headAssetReferences,
  );

  return {
    directory: root,
    coverage: {scope: "manifest-and-catalog-summary", historyAndReceipts: "not-validated",
      restore: "not-validated", concurrentWriters: "not-excluded"},
    manifest,
    database: {
      path: CHECKPOINT_SERVER_BACKUP_DATABASE,
      bytes: databaseSecond.bytes,
      sha256: databaseSecond.sha256,
    },
    serverEpoch: summary.epoch,
    counts: summary.counts,
    workspaces: summary.heads,
    attachments: {
      included: false,
      bytes: "excluded",
      headAssetReferences: summary.headAssetReferences,
      message: ATTACHMENT_NOTICE,
    },
  };
}
