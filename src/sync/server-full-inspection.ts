import { createHash } from "node:crypto";
import { lstatSync, openSync, closeSync, fstatSync, readSync, opendirSync, constants, type Stats, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { assertPrivateRoot, pinPrivateRoot, type PrivateRootPin } from "./m3-private-root";
import { inspectServerHistory } from "./server-history-validation";
import { MAX_SYNC_ASSET_BYTES, SyncError } from "./protocol";
import { inspectVerifiedServerFile } from "./server-verified-file";
import {
  SERVER_FULL_MARKER,
  SERVER_FULL_MANIFEST,
  type ServerAssetRequirement,
  type ServerFullBackupManifest,
  type ServerHistoryInventory,
} from "./server-full-types";

const INCOMPLETE = "server-full-incomplete";
const INVALID = "server-full-invalid";
const LIMIT = "server-full-limit";
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_DATABASE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 256 * 1024 * 1024;
const MAX_ASSET_BYTES = MAX_SYNC_ASSET_BYTES;
const MAX_ASSETS = 4096;
const MAX_WORKSPACES = 4096;
const MAX_BLOB_ENTRIES = 8192;
const WORKSPACE_KEYS = ["workspaceId", "ownerId", "revision", "checkpointHash"] as const;
const COUNT_KEYS = ["changes", "operations", "devices", "activeDevices", "revokedDevices"] as const;
const DATABASE_KEYS = ["path", "bytes", "sha256"] as const;
const ASSET_KEYS = ["workspaceId", "sha256", "bytes", "path"] as const;
const MANIFEST_KEYS = ["format", "createdAt", "serverEpoch", "database", "assets", "workspaces", "counts"] as const;

type JsonRecord = Record<string, unknown>;
type FileIdentity = Stats;

function incomplete(): never {
  throw new SyncError(INCOMPLETE, 409);
}
function invalid(): never {
  throw new SyncError(INVALID, 422);
}
function limit(): never {
  throw new SyncError(LIMIT, 409);
}
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink() &&
    left.nlink === 1 && right.nlink === 1 && left.uid === right.uid &&
    left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs &&
    (left.mode & 0o777) === (right.mode & 0o777);
}
function lstatFile(path: string, role: "incomplete" | "invalid"): FileIdentity {
  let stat: FileIdentity;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (isMissing(error) && role === "incomplete") incomplete();
    return invalid();
  }
  if (stat.isSymbolicLink() || !stat.isFile()) invalid();
  return stat;
}
function pinRoot(directory: string): PrivateRootPin {
  let stat: FileIdentity;
  try {
    stat = lstatSync(resolve(directory));
  } catch (error) {
    if (isMissing(error)) incomplete();
    return invalid();
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) invalid();
  try {
    return pinPrivateRoot(directory);
  } catch {
    return invalid();
  }
}
function rejectMarker(root: PrivateRootPin): void {
  try {
    lstatSync(join(root.path, SERVER_FULL_MARKER));
  } catch (error) {
    if (isMissing(error)) return;
    incomplete();
  }
  incomplete();
}

function record(value: unknown): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as JsonRecord;
}
function exact(value: unknown, keys: readonly string[]): JsonRecord {
  const object = record(value);
  const own = Object.keys(object);
  if (own.length !== keys.length || keys.some((key) => !Object.hasOwn(object, key))) invalid();
  return object;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) invalid();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function counter(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalid();
  return value;
}
function isoTime(value: unknown): string {
  if (typeof value !== "string" || value.length < 20 || value.length > 32) invalid();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) invalid();
  return value;
}

function readManifest(path: string, root: PrivateRootPin): { text: string; stat: FileIdentity } {
  const listed = lstatFile(path, "incomplete");
  if (listed.nlink !== 1 || listed.uid !== root.uid || (listed.mode & 0o777) !== 0o600) invalid();
  if (listed.size > MAX_MANIFEST_BYTES) limit();
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!sameFile(listed, fstatSync(fd))) invalid();
    const buffer = Buffer.allocUnsafe(listed.size);
    let offset = 0;
    while (offset < listed.size) {
      const count = readSync(fd, buffer, offset, listed.size - offset, offset);
      if (count <= 0) invalid();
      offset += count;
    }
    if (readSync(fd, Buffer.allocUnsafe(1), 0, 1, offset) > 0) invalid();
    if (!sameFile(listed, fstatSync(fd))) invalid();
    assertPrivateRoot(root);
    if (!sameFile(listed, lstatSync(path))) invalid();
    const text = buffer.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(buffer)) invalid();
    return { text, stat: listed };
  } catch (error) {
    if (error instanceof SyncError) throw error;
    return invalid();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseManifest(text: string): ServerFullBackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid();
  }
  const manifest = exact(value, MANIFEST_KEYS);
  if (manifest.format !== "folio-server-full/v1") invalid();
  const createdAt = isoTime(manifest.createdAt);
  const serverEpoch = identifier(manifest.serverEpoch);
  const database = exact(manifest.database, DATABASE_KEYS);
  if (database.path !== "server.sqlite") invalid();
  const databaseBytes = counter(database.bytes);
  if (databaseBytes > MAX_DATABASE_BYTES) limit();
  const databaseSha = hash(database.sha256);
  if (!Array.isArray(manifest.assets)) invalid();
  if (manifest.assets.length > MAX_ASSETS) limit();
  const assetKeys = new Set<string>();
  let totalAssetBytes = 0;
  const assets: ServerFullBackupManifest["assets"] = manifest.assets.map((item) => {
    const asset = exact(item, ASSET_KEYS);
    const workspaceId = identifier(asset.workspaceId);
    const assetSha = hash(asset.sha256);
    const bytes = counter(asset.bytes);
    if (bytes > MAX_ASSET_BYTES) limit();
    totalAssetBytes += bytes;
    if (totalAssetBytes > MAX_TOTAL_ASSET_BYTES) limit();
    const expectedPath = `blobs/${digest(workspaceId)}/${assetSha}`;
    if (asset.path !== expectedPath) invalid();
    const key = `${workspaceId}\0${assetSha}`;
    if (assetKeys.has(key)) invalid();
    assetKeys.add(key);
    return { workspaceId, sha256: assetSha, bytes, path: expectedPath };
  });
  if (!Array.isArray(manifest.workspaces)) invalid();
  if (manifest.workspaces.length > MAX_WORKSPACES) limit();
  const workspaceKeys = new Set<string>();
  const workspaces: ServerHistoryInventory["workspaces"] = manifest.workspaces.map((item) => {
    const workspace = exact(item, WORKSPACE_KEYS);
    const workspaceId = identifier(workspace.workspaceId);
    const ownerId = identifier(workspace.ownerId);
    const revision = counter(workspace.revision);
    let checkpointHash: string | null = null;
    if (revision === 0) {
      if (workspace.checkpointHash !== null) invalid();
    } else {
      checkpointHash = hash(workspace.checkpointHash);
    }
    if (workspaceKeys.has(workspaceId)) invalid();
    workspaceKeys.add(workspaceId);
    return { workspaceId, ownerId, revision, checkpointHash };
  });
  const countsObject = exact(manifest.counts, COUNT_KEYS);
  const counts = {} as ServerFullBackupManifest["counts"];
  for (const key of COUNT_KEYS) counts[key] = counter(countsObject[key]);
  return {
    format: "folio-server-full/v1",
    createdAt,
    serverEpoch,
    database: { path: "server.sqlite", bytes: databaseBytes, sha256: databaseSha },
    assets,
    workspaces,
    counts,
  };
}

function rejectDatabaseSidecars(root: PrivateRootPin): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      lstatSync(join(root.path, "server.sqlite" + suffix));
    } catch (error) {
      if (isMissing(error)) continue;
      invalid();
    }
    invalid();
  }
}

function verifyFile(path: string, expected: { bytes: number; sha256: string }, maxBytes: number): FileIdentity {
  const listed = lstatFile(path, "incomplete");
  try {
    inspectVerifiedServerFile(path, expected, maxBytes);
  } catch (error) {
    if (error instanceof SyncError && error.code === "server-file-capacity") limit();
    if (error instanceof SyncError && error.code === "server-file-mismatch") invalid();
    return invalid();
  }
  const after = lstatFile(path, "invalid");
  if (!sameFile(listed, after)) invalid();
  return after;
}

function openDatabase(path: string): ServerHistoryInventory {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(pathToFileURL(path).href + "?mode=ro&immutable=1", { readOnly: true });
    const checks = database.prepare("PRAGMA integrity_check").all();
    if (!Array.isArray(checks) || checks.length !== 1) invalid();
    if (exact(checks[0], ["integrity_check"]).integrity_check !== "ok") invalid();
    return inspectServerHistory(database);
  } catch (error) {
    if (error instanceof SyncError) {
      if (error.code === "server-history-limit") limit();
      if (error.code === "server-history-invalid") invalid();
    }
    return invalid();
  } finally {
    try {
      database?.close();
    } catch {}
  }
}

function compareAssets(left: ServerAssetRequirement, right: ServerAssetRequirement): number {
  if (left.workspaceId !== right.workspaceId) return left.workspaceId < right.workspaceId ? -1 : 1;
  if (left.sha256 !== right.sha256) return left.sha256 < right.sha256 ? -1 : 1;
  return left.bytes - right.bytes;
}

function compareInventory(manifest: ServerFullBackupManifest, inventory: ServerHistoryInventory): void {
  if (manifest.serverEpoch !== inventory.serverEpoch) invalid();
  const manifestWorkspaces = [...manifest.workspaces].sort((left, right) =>
    left.workspaceId < right.workspaceId ? -1 : 1,
  );
  if (manifestWorkspaces.length !== inventory.workspaces.length) invalid();
  manifestWorkspaces.forEach((workspace, index) => {
    const actual = inventory.workspaces[index];
    if (
      actual.workspaceId !== workspace.workspaceId ||
      actual.ownerId !== workspace.ownerId ||
      actual.revision !== workspace.revision ||
      actual.checkpointHash !== workspace.checkpointHash
    )
      invalid();
  });
  for (const key of COUNT_KEYS) {
    if (manifest.counts[key] !== inventory[key]) invalid();
  }
  const manifestAssets = manifest.assets
    .map((asset) => ({ workspaceId: asset.workspaceId, sha256: asset.sha256, bytes: asset.bytes }))
    .sort(compareAssets);
  if (manifestAssets.length !== inventory.assets.length) invalid();
  manifestAssets.forEach((asset, index) => {
    if (compareAssets(asset, inventory.assets[index]) !== 0) invalid();
  });
}

function readDirectory(directory: string, accept: (entry: Dirent) => void, count: () => void): void {
  let handle;
  try {
    handle = opendirSync(directory);
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      count();
      accept(entry);
    }
  } catch (error) {
    if (error instanceof SyncError) throw error;
    return invalid();
  } finally {
    try {
      handle?.closeSync();
    } catch {}
  }
}

function inspectBlobs(root: PrivateRootPin, assets: ServerFullBackupManifest["assets"]): void {
  const expected = new Map<string, Set<string>>();
  for (const asset of assets) {
    const directory = digest(asset.workspaceId);
    const names = expected.get(directory) ?? new Set<string>();
    names.add(asset.sha256);
    expected.set(directory, names);
  }
  const blobsPath = join(root.path, "blobs");
  let blobsStat: FileIdentity;
  try {
    blobsStat = lstatSync(blobsPath);
  } catch (error) {
    if (isMissing(error) && expected.size === 0) return;
    return incomplete();
  }
  if (blobsStat.isSymbolicLink() || !blobsStat.isDirectory() || blobsStat.uid !== root.uid) invalid();
  const blobsPin = pinPrivateRoot(blobsPath);
  let entries = 0;
  const count = () => {
    entries += 1;
    if (entries > MAX_BLOB_ENTRIES) limit();
  };
  const seenWorkspaces = new Set<string>();
  readDirectory(
    blobsPath,
    (entry) => {
      const names = expected.get(entry.name);
      if (names === undefined || entry.isSymbolicLink() || !entry.isDirectory()) invalid();
      if (seenWorkspaces.has(entry.name)) invalid();
      seenWorkspaces.add(entry.name);
      const workspacePath = join(blobsPath, entry.name);
      const workspaceStat = lstatSync(workspacePath);
      if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory() || workspaceStat.uid !== root.uid) invalid();
      const workspacePin = pinPrivateRoot(workspacePath);
      const seen = new Set<string>();
      readDirectory(
        workspacePath,
        (item) => {
          if (item.isSymbolicLink() || !item.isFile() || !names.has(item.name) || seen.has(item.name)) invalid();
          seen.add(item.name);
        },
        count,
      );
      if (seen.size !== names.size) incomplete();
      assertPrivateRoot(workspacePin);
    },
    count,
  );
  if (seenWorkspaces.size !== expected.size) incomplete();
  assertPrivateRoot(blobsPin);
}

function inspect(directory: string, marker?: {dev: number; ino: number}): ServerFullBackupManifest {
  try {
    const root = pinRoot(directory);
    const checkMarker = () => {
      if (!marker) return rejectMarker(root);
      const stat = lstatSync(join(root.path, SERVER_FULL_MARKER));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== root.uid ||
        stat.dev !== marker.dev || stat.ino !== marker.ino || (stat.mode & 0o777) !== 0o600) invalid();
    };
    checkMarker();
    readDirectory(root.path, entry => {
      if (!["server.sqlite", SERVER_FULL_MANIFEST, "blobs", ...(marker ? [SERVER_FULL_MARKER] : [])].includes(entry.name)) invalid();
    }, (() => {let entries = 0; return () => {if (++entries > 4) limit();};})());
    const manifestPath = join(root.path, SERVER_FULL_MANIFEST);
    const manifestSource = readManifest(manifestPath, root);
    const manifest = parseManifest(manifestSource.text);
    rejectDatabaseSidecars(root);
    const databasePath = join(root.path, manifest.database.path);
    const databaseStat = verifyFile(databasePath, manifest.database, MAX_DATABASE_BYTES);
    const assetStats = new Map<string, FileIdentity>();
    for (const asset of manifest.assets) {
      assetStats.set(asset.path, verifyFile(join(root.path, asset.path), asset, MAX_ASSET_BYTES));
    }
    const inventory = openDatabase(databasePath);
    compareInventory(manifest, inventory);
    inspectBlobs(root, manifest.assets);
    if (!sameFile(manifestSource.stat, lstatFile(manifestPath, "invalid"))) invalid();
    if (!sameFile(databaseStat, lstatFile(databasePath, "invalid"))) invalid();
    for (const [path, stat] of assetStats) {
      if (!sameFile(stat, lstatFile(join(root.path, path), "invalid"))) invalid();
    }
    assertPrivateRoot(root);
    checkMarker();
    return manifest;
  } catch (error) {
    if (
      error instanceof SyncError &&
      (error.code === INCOMPLETE || error.code === INVALID || error.code === LIMIT)
    )
      throw error;
    return invalid();
  }
}

export function inspectFullServerBackup(directory: string): ServerFullBackupManifest {return inspect(directory);}

/** Builder-only byte verification while its pinned incomplete marker remains.
 * This does not publish a backup or make an incomplete directory restorable. */
export function verifyStagedFullServerBackup(directory: string, marker: {dev: number; ino: number}): ServerFullBackupManifest {
  return inspect(directory, marker);
}
