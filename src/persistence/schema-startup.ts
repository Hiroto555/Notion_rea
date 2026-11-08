import { sqliteHeader } from "./sqlite-header";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { dirname } from "node:path";
import { validateRecordStoreVersion } from "./record-version";
import { validateWorkspaceSyncSchema } from "../sync/workspace-checkpoint";

export { validateWorkspaceSyncSchema };

/** A version-5 claim is only accepted with both the record marker and the
 * complete durable sync structure. A partial v5 is reported as an unsupported
 * (newer) workspace rather than interpreted as v4. Promotion itself happens
 * only through the explicit WorkspaceSyncStore.enable transaction; the host
 * must hold exclusive workspace ownership until that transaction commits. */
export function validateV5WorkspaceSchema(connection: DatabaseSync): void {
  try {
    validateRecordStoreVersion(connection);
    validateWorkspaceSyncSchema(connection);
  } catch (error) {
    throw new Error(
      "This workspace requires a newer Folio version. Incomplete or unsupported version 5 workspace" +
        (error instanceof Error ? `: ${error.message}` : ""),
    );
  }
}

export type StoreStartupOptions = {
  allowIncompleteRecovery?: boolean;
  /**
   * Called before a writable database is opened and before its directory is
   * created. `additionalBytes` is a conservative estimate of the temporary
   * space needed for pre-migration snapshots; it is zero when no snapshot is
   * required. Throwing refuses startup without touching the workspace.
   */
  beforeOpen?: (additionalBytes: number) => void;
  /** Open an existing v3/v4 workspace without initialization or migration. */
  readOnly?: boolean;
};

export type WritableStartupPlan = {
  version: number;
  additionalBytes: number;
};

const DATABASE_SIDECARS = ["-wal", "-shm", "-journal"] as const;
const MAX_SAFE_BYTES = Number.MAX_SAFE_INTEGER;

function lstatOptional(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isSafeRegularFile(info: Stats): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
}

/** Connection state must be observable before a connection is handed out. */
export function assertConnectionState(connection: DatabaseSync): void {
  if (
    typeof connection.isOpen !== "boolean" ||
    typeof connection.isTransaction !== "boolean"
  )
    throw new Error(
      "SQLite connection and transaction state APIs are required",
    );
}

export function assertPrivateApplicationId(connection: DatabaseSync): void {
  if (connection.prepare("PRAGMA application_id").get()?.application_id !== 0)
    throw new Error(
      "This workspace requires a newer Folio version. Foreign application id.",
    );
}

export function readUserVersion(connection: DatabaseSync): number {
  const row = connection.prepare("PRAGMA user_version").get() as
    { user_version?: unknown } | undefined;
  const version = row?.user_version;
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 0
  )
    throw new Error("Unsupported SQLite schema version");
  return version;
}

function pragmaInteger(connection: DatabaseSync, name: string): number {
  const row = connection.prepare("PRAGMA " + name).get() as
    Record<string, unknown> | undefined;
  const raw = row?.[name];
  const value = typeof raw === "bigint" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("SQLite allocation exceeds the supported size range");
  return value;
}

function logicalPageBytes(connection: DatabaseSync): number {
  const pages = pragmaInteger(connection, "page_count"),
    size = pragmaInteger(connection, "page_size");
  if (pages === 0 || size === 0) return 0;
  if (pages > Math.floor(MAX_SAFE_BYTES / size)) return MAX_SAFE_BYTES;
  return pages * size;
}

function addBytes(total: number, additional: number): number {
  if (additional < 0 || total < 0) throw new Error("Invalid byte estimate");
  if (additional > MAX_SAFE_BYTES - total) return MAX_SAFE_BYTES;
  return total + additional;
}

function statBytes(info: Stats | undefined): number {
  if (!info) return 0;
  if (!Number.isSafeInteger(info.size) || info.size < 0)
    throw new Error("SQLite file size exceeds the supported size range");
  return info.size;
}

/**
 * A conservative size for one `VACUUM INTO` image of the current database.
 * The logical page count covers committed WAL frames; file sizes cover header
 * and sidecar overhead. The extra MiB absorbs page and journal overhead.
 */
export function estimateSnapshotBytes(
  connection: DatabaseSync,
  main: Stats,
  wal: Stats | undefined,
): number {
  const byFile = Math.max(statBytes(main), logicalPageBytes(connection));
  const withWal = addBytes(byFile, statBytes(wal));
  return addBytes(withWal, 1024 * 1024);
}

function assertSafeSource(
  main: Stats | undefined,
  sidecars: (Stats | undefined)[],
): void {
  if (main) {
    if (!isSafeRegularFile(main))
      throw new Error(
        "Workspace database is not a safe regular file; startup refused",
      );
  } else if (sidecars.some((info) => info !== undefined)) {
    throw new Error(
      "Workspace database sidecars exist without the database file; startup refused",
    );
  }
  for (const [index, info] of sidecars.entries()) {
    if (!info) continue;
    if (!isSafeRegularFile(info))
      throw new Error(
        `Workspace database sidecar ${DATABASE_SIDECARS[index]} is unsafe; startup refused`,
      );
  }
}

/**
 * Inspect an existing workspace through a read-only connection before any
 * writable open, directory creation, journal-mode change or schema change.
 * Page bodies are never decoded. The callback receives only the extra space
 * needed for the snapshots required by the migration path.
 */
export function inspectWritableStartup(
  databasePath: string,
  supportedVersion: number,
): WritableStartupPlan {
  const main = lstatOptional(databasePath),
    sidecars = DATABASE_SIDECARS.map((suffix) =>
      lstatOptional(databasePath + suffix),
    );
  assertSafeSource(main, sidecars);
  if (!main) return { version: 0, additionalBytes: 0 };
  const header = sqliteHeader(databasePath);
  if (
    header &&
    (header.version > supportedVersion || header.applicationId !== 0)
  )
    throw new Error("This workspace requires a newer Folio version.");

  const connection = new DatabaseSync(databasePath, { readOnly: true });
  let plan: WritableStartupPlan;
  try {
    connection.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000");
    assertPrivateApplicationId(connection);
    const version = readUserVersion(connection);
    if (version > supportedVersion)
      throw new Error("This workspace requires a newer Folio version.");
    // Unknown v4 record schemas and incomplete v5 sync structures are rejected
    // before journal mode or schema is touched, matching the writable
    // constructor's requirements. Promotion to v5 is explicit and never occurs
    // here; the host must hold exclusive workspace ownership around it.
    if (version === 4) validateRecordStoreVersion(connection);
    if (version === 5) validateV5WorkspaceSchema(connection);
    let additionalBytes = 0;
    if (version === 1 || version === 2) {
      // One fresh rollback image is published before the only migration step
      // that applies to this source version (v1 -> v2 or v2 -> v3).
      additionalBytes = estimateSnapshotBytes(
        connection,
        main,
        lstatOptional(databasePath + "-wal"),
      );
    }
    plan = { version, additionalBytes };
  } catch (error) {
    try {
      connection.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "Read-only preflight close failed after a startup error",
      );
    }
    throw error;
  }
  connection.close();
  return plan;
}

/** Open a completed v3/v4 workspace without init, migration, seed or WAL. */
export function openReadOnlyStore(
  databasePath: string,
  supportedVersion: number,
): DatabaseSync {
  assertSafeSource(
    lstatOptional(databasePath),
    DATABASE_SIDECARS.map((suffix) => lstatOptional(databasePath + suffix)),
  );
  const header = sqliteHeader(databasePath);
  if (
    header &&
    (header.version > supportedVersion || header.applicationId !== 0)
  )
    throw new Error("This workspace requires a newer Folio version.");
  const connection = new DatabaseSync(databasePath, { readOnly: true });
  try {
    connection.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000");
    assertPrivateApplicationId(connection);
    const version = readUserVersion(connection);
    if (version > supportedVersion)
      throw new Error("This workspace requires a newer Folio version.");
    if (version < 3)
      throw new Error(
        "This workspace schema is too old for read-only access; startup refused.",
      );
    if (version === 4) validateRecordStoreVersion(connection);
    if (version === 5) validateV5WorkspaceSchema(connection);
    return connection;
  } catch (error) {
    try {
      connection.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "Read-only SQLite close failed after a startup error",
      );
    }
    throw error;
  }
}

function hasTable(connection: DatabaseSync, name: string): boolean {
  return !!connection
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function hasColumn(
  connection: DatabaseSync,
  table: string,
  column: string,
): boolean {
  return (
    connection.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[]
  ).some((entry) => entry.name === column);
}

/**
 * Verify the fresh snapshot independently before it can gate a migration.
 * Only schema metadata is inspected; Page JSON is never decoded.
 */
function verifySchemaSnapshot(path: string, expectedVersion: number): void {
  const snapshot = new DatabaseSync(path, { readOnly: true });
  let failure: unknown;
  try {
    snapshot.exec("PRAGMA query_only=ON");
    const checks = snapshot.prepare("PRAGMA integrity_check").all() as {
      integrity_check: string;
    }[];
    if (checks.length !== 1 || checks[0].integrity_check !== "ok")
      throw new Error("Schema snapshot integrity check failed");
    const version = readUserVersion(snapshot);
    if (version !== expectedVersion)
      throw new Error("Schema snapshot version does not match the source");
    for (const name of ["pages", "settings", "versions", "save_receipts"])
      if (!hasTable(snapshot, name))
        throw new Error("Schema snapshot is missing a required table");
    if (expectedVersion === 2 && !hasColumn(snapshot, "versions", "database"))
      throw new Error("Schema snapshot is missing legacy history data");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      snapshot.close();
    } catch (closeError) {
      if (failure !== undefined)
        throw new AggregateError(
          [failure, closeError],
          "Schema snapshot close failed after verification error",
        );
      throw closeError;
    }
  }
}

function syncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function publishNoClobber(stagedPath: string, canonicalPath: string): string {
  try {
    linkSync(stagedPath, canonicalPath);
    return canonicalPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // Never replace a partial, stale or foreign snapshot. A second, uniquely
  // named hard link preserves the verified fresh image instead.
  for (let attempt = 0; attempt < 8; attempt++) {
    const fallback = `${canonicalPath}.${Date.now()}-${randomUUID()}.sqlite`;
    try {
      linkSync(stagedPath, fallback);
      return fallback;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("Unable to publish a unique schema snapshot");
}

/**
 * Create, verify, fsync and no-clobber publish a fresh pre-migration image.
 * The caller must hold exclusive workspace ownership and must not be inside a
 * transaction. A failure never advances the migration; every prior snapshot
 * (including a suspect canonical file) is left untouched.
 */
export function publishSchemaSnapshot(
  connection: DatabaseSync,
  databasePath: string,
  sourceVersion: 1 | 2,
): string {
  if (connection.isTransaction)
    throw new Error("Schema snapshot requires no active transaction");
  const canonicalPath = `${databasePath}.pre-v${sourceVersion + 1}.sqlite`,
    stagedPath = `${canonicalPath}.staging-${randomUUID()}`;
  connection.prepare("VACUUM INTO ?").run(stagedPath);
  const stagedInfo = lstatOptional(stagedPath);
  if (!stagedInfo || !isSafeRegularFile(stagedInfo) || stagedInfo.size === 0)
    throw new Error("Schema snapshot is not a safe non-empty regular file");
  verifySchemaSnapshot(stagedPath, sourceVersion);
  syncFile(stagedPath);
  const published = publishNoClobber(stagedPath, canonicalPath);
  syncFile(published);
  const parentDescriptor = openSync(dirname(published), "r");
  try {
    fsyncSync(parentDescriptor);
  } finally {
    closeSync(parentDescriptor);
  }
  // The published name is now durable; staging is only this attempt's second
  // link. Cleanup failure must not make a successfully published snapshot
  // unusable or advance migration with an unknown staging identity.
  try {
    unlinkSync(stagedPath);
  } catch {}
  return published;
}
