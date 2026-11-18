import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, statfsSync, unlinkSync, constants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { syncPath, writeNewFileDurably } from "../persistence/durable-file";
import { DEFAULT_STORAGE_RESERVE_BYTES } from "../shared/storage-pressure";
import { pinPrivateRoot, assertPrivateRoot, type PrivateRootPin } from "./m3-private-root";
import { canonicalJson, MAX_SYNC_ASSET_BYTES, requireCondition, sha256, SyncError } from "./protocol";
import { inspectServerHistory } from "./server-history-validation";
import { copyVerifiedServerFile, inspectVerifiedServerFile } from "./server-verified-file";
import { inspectFullServerBackup, verifyStagedFullServerBackup } from "./server-full-inspection";
import { acquireServerDirectoryLease, type ServerDirectoryLease } from "./server-directory-lease";
import { writeServerOpsConfig, assertNativeServerHandoffAncestors } from "./server-ops-config";
import { SyncSqliteGuard } from "./sqlite-guard";
import { SERVER_FULL_MANIFEST, SERVER_FULL_MARKER, type ServerFullBackupManifest } from "./server-full-types";
import type { ServerHistoryInventory } from "./server-full-types";
import type { NativePrivateFile, NativePrivateIdentity } from "../platform/private-persistence";
import type { PrivateAuthorityLease } from "../platform/windows/authority-lease";
import {
  windowsServerNative,
  onceNativeServerClose,
  closeNativeServerResources,
  type NativeServerFailure,
  type WindowsServerNativePort,
} from "../platform/windows/server-native";

const MAX_DB = 256 * 1024 * 1024;
const MAX_ASSETS = 256 * 1024 * 1024;
const MAX_MANIFEST = 4 * 1024 * 1024;
const MARKER_TEXT = "Folio server output is incomplete; do not start or restore it.\n";
function optional(path: string) {try {return lstatSync(path);} catch (e) {if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e;}}
function inside(root: string, path: string) {const r = relative(root, path); return !r || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r));}
function destinationPath(destination: string, source: string) {
  requireCondition(typeof destination === "string" && destination.length > 0 && destination.length <= 4096 && !destination.includes("\0"), "server-full-destination", 409);
  const path = resolve(destination);
  requireCondition(!optional(path), "server-full-destination-exists", 409);
  const parent = realpathSync(dirname(path)), stat = lstatSync(parent);
  requireCondition(stat.isDirectory() && !stat.isSymbolicLink() && ((stat.mode & 0o022) === 0 || (stat.mode & 0o1000) !== 0), "server-full-destination", 409);
  const actual = join(parent, basename(path));
  requireCondition(!inside(source, actual) && !inside(actual, source) && !optional(actual), "server-full-destination", 409);
  return actual;
}
function capacity(parent: string, bytes: number) {
  requireCondition(Number.isSafeInteger(bytes) && bytes >= 0, "server-full-limit", 409);
  const stat = statfsSync(parent, {bigint: true});
  requireCondition(stat.bsize > 0n && stat.bavail >= 0n &&
    stat.bsize * stat.bavail >= BigInt(bytes) + BigInt(DEFAULT_STORAGE_RESERVE_BYTES), "insufficient-storage", 507);
}
function reserve(path: string) {
  const parent = lstatSync(dirname(path));
  mkdirSync(path, {mode: 0o700});
  const root = pinPrivateRoot(path);
  requireCondition(lstatSync(dirname(path)).ino === parent.ino && lstatSync(dirname(path)).dev === parent.dev, "server-full-destination", 409);
  writeNewFileDurably(join(root.path, SERVER_FULL_MARKER), MARKER_TEXT, {mode: 0o600, syncParentDirectory: true});
  syncPath(dirname(root.path));
  return {root, marker: lstatSync(join(root.path, SERVER_FULL_MARKER))};
}
function finish(root: PrivateRootPin, marker: {dev: number; ino: number}) {
  assertPrivateRoot(root);
  const path = join(root.path, SERVER_FULL_MARKER), current = lstatSync(path);
  requireCondition(current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && current.dev === marker.dev && current.ino === marker.ino,
    "server-full-incomplete", 409);
  unlinkSync(path);
  try {syncPath(root.path);} catch (e) {
    try {writeNewFileDurably(path, MARKER_TEXT, {mode: 0o600, syncParentDirectory: true});} catch {}
    throw e;
  }
}
function syncFile(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {const stat = fstatSync(fd); requireCondition(stat.isFile() && stat.nlink === 1, "server-full-invalid", 422); fsyncSync(fd);}
  finally {closeSync(fd);}
}
function syncAssetDirectories(destination: string, assets: readonly {path: string}[]) {
  for (const directory of new Set(assets.map(asset => dirname(join(destination, asset.path))))) syncPath(directory);
  syncPath(join(destination, "blobs")); syncPath(destination);
}
function normalize(error: unknown): never {
  if (error instanceof SyncError) throw error;
  if ((error as NodeJS.ErrnoException)?.code === "ENOSPC" || /disk is full/.test(String((error as Error)?.message)))
    throw new SyncError("insufficient-storage", 507);
  throw new SyncError("server-full-write-failed", 500);
}

/** Offline operational backup. Every production server/admin entry holds this
 * directory lease, so no legitimate writer/upload can interleave. */
export function createServerFullBackup(options: {sourceDirectory: string; destination: string; lease: ServerDirectoryLease}): {destination: string; manifest: ServerFullBackupManifest} {
  const native = windowsServerNative();
  if (native !== undefined) return createServerFullBackupNative(native, options);
  if (process.platform === "win32") throw new SyncError("server-native-unsafe", 409);
  let database: DatabaseSync | undefined;
  let published = false;
  try {
    const source = pinPrivateRoot(options.sourceDirectory);
    options.lease.assertOwned();
    requireCondition(options.lease.directory === source.path && !optional(join(source.path, SERVER_FULL_MARKER)), "server-full-incomplete", 409);
    const databasePath = join(source.path, "server.sqlite");
    inspectVerifiedServerFile(databasePath, undefined, MAX_DB);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const stat = optional(databasePath + suffix);
      requireCondition(!stat || (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === source.uid && stat.size <= MAX_DB), "server-full-invalid", 422);
      requireCondition(suffix !== "-journal" || !stat || stat.size === 0, "server-recovery-required", 409);
    }
    database = new DatabaseSync(databasePath, {readOnly: true});
    const before = inspectServerHistory(database);
    const total = before.assets.reduce((n, asset) => n + asset.bytes, 0);
    requireCondition(total <= MAX_ASSETS, "server-full-limit", 409);
    const allocation = Number(database.prepare("PRAGMA page_count").get()!.page_count) * Number(database.prepare("PRAGMA page_size").get()!.page_size);
    requireCondition(Number.isSafeInteger(allocation) && allocation <= MAX_DB, "server-full-limit", 409);
    const destination = destinationPath(options.destination, source.path);
    capacity(dirname(destination), allocation * 2 + total + MAX_MANIFEST);
    const output = reserve(destination);
    const snapshot = join(destination, "server.sqlite");
    database.prepare("VACUUM INTO ?").run(snapshot);
    chmodSync(snapshot, 0o600); syncFile(snapshot); syncPath(destination);
    const file = inspectVerifiedServerFile(snapshot, undefined, MAX_DB);
    const copy = new DatabaseSync(pathToFileURL(snapshot).href + "?mode=ro&immutable=1", {readOnly: true});
    let inventory;
    try {inventory = inspectServerHistory(copy);} finally {copy.close();}
    requireCondition(canonicalJson(inventory, 8 * 1024 * 1024) === canonicalJson(before, 8 * 1024 * 1024), "server-full-changed", 409);
    mkdirSync(join(destination, "blobs"), {mode: 0o700});
    const assets: ServerFullBackupManifest["assets"] = [];
    for (const asset of inventory.assets) {
      options.lease.assertOwned();
      const relativePath = `blobs/${sha256(asset.workspaceId)}/${asset.sha256}`;
      mkdirSync(dirname(join(destination, relativePath)), {recursive: true, mode: 0o700});
      copyVerifiedServerFile(join(source.path, relativePath), join(destination, relativePath), asset);
      assets.push({...asset, path: relativePath});
    }
    syncAssetDirectories(destination, assets);
    requireCondition(canonicalJson(inspectServerHistory(database), 8 * 1024 * 1024) === canonicalJson(before, 8 * 1024 * 1024), "server-full-changed", 409);
    const {serverEpoch, workspaces, changes, operations, devices, activeDevices, revokedDevices} = inventory;
    const manifest: ServerFullBackupManifest = {format: "folio-server-full/v1", createdAt: new Date().toISOString(), serverEpoch,
      database: {path: "server.sqlite", ...file}, assets, workspaces, counts: {changes, operations, devices, activeDevices, revokedDevices}};
    const text = JSON.stringify(manifest);
    requireCondition(Buffer.byteLength(text) <= MAX_MANIFEST, "server-full-limit", 409);
    writeNewFileDurably(join(destination, SERVER_FULL_MANIFEST), text, {mode: 0o600, syncParentDirectory: true});
    options.lease.assertOwned(); assertPrivateRoot(source);
    verifyStagedFullServerBackup(destination, output.marker);
    finish(output.root, output.marker);
    published = true;
    return {destination, manifest: inspectFullServerBackup(destination)};
  } catch (e) {if (published) throw new SyncError("server-full-published-unverified", 409); return normalize(e);}
  finally {try {database?.close();} catch (e) {if (published) throw new SyncError("server-full-published-unverified", 409); normalize(e);}}
}

/** Restore only into a fresh private directory. Old devices stay revoked;
 * historical operations/receipts are retained as evidence, never re-stamped. */
export function restoreServerFullBackup(options: {backupDirectory: string; destination: string; port: number}): {destination: string; previousEpoch: string; serverEpoch: string} {
  const native = windowsServerNative();
  if (native !== undefined) return restoreServerFullBackupNative(native, options);
  if (process.platform === "win32") throw new SyncError("server-native-unsafe", 409);
  let lease: ServerDirectoryLease | undefined;
  let guard: SyncSqliteGuard | undefined;
  let published = false;
  try {
    const source = pinPrivateRoot(options.backupDirectory), manifest = inspectFullServerBackup(source.path);
    requireCondition(manifest.workspaces.length === 1 && Number.isInteger(options.port) && options.port > 0 && options.port <= 65535, "server-full-unsupported", 409);
    const manifestHash = inspectVerifiedServerFile(join(source.path, SERVER_FULL_MANIFEST), undefined, MAX_MANIFEST).sha256;
    const destination = destinationPath(options.destination, source.path);
    capacity(dirname(destination), manifest.database.bytes * 2 + manifest.assets.reduce((n, a) => n + a.bytes, 0) + MAX_MANIFEST);
    const output = reserve(destination);
    lease = acquireServerDirectoryLease(destination);
    const databasePath = join(destination, "server.sqlite");
    copyVerifiedServerFile(join(source.path, "server.sqlite"), databasePath, manifest.database, MAX_DB);
    mkdirSync(join(destination, "blobs"), {mode: 0o700});
    for (const asset of manifest.assets) {
      mkdirSync(dirname(join(destination, asset.path)), {recursive: true, mode: 0o700});
      copyVerifiedServerFile(join(source.path, asset.path), join(destination, asset.path), asset);
    }
    syncAssetDirectories(destination, manifest.assets);
    guard = new SyncSqliteGuard(new DatabaseSync(databasePath));
    guard.db.exec("PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
    let serverEpoch = randomUUID(); while (serverEpoch === manifest.serverEpoch) serverEpoch = randomUUID();
    guard.transaction(() => {
      guard!.db.prepare("UPDATE checkpoint_server_identity SET epoch=? WHERE singleton=1").run(serverEpoch);
      guard!.db.prepare("UPDATE checkpoint_devices SET revoked=1").run();
    });
    const restored = inspectServerHistory(guard.db);
    requireCondition(restored.serverEpoch === serverEpoch && restored.activeDevices === 0 && restored.devices === manifest.counts.devices &&
      restored.changes === manifest.counts.changes && restored.operations === manifest.counts.operations &&
      canonicalJson(restored.workspaces) === canonicalJson(manifest.workspaces), "server-full-invalid", 422);
    guard.close(); guard = undefined; syncFile(databasePath); syncPath(destination);
    const workspace = manifest.workspaces[0];
    writeServerOpsConfig(destination, {format: "folio-server-config/v1", workspaceId: workspace.workspaceId, ownerId: workspace.ownerId, port: options.port});
    writeNewFileDurably(join(destination, "restore-receipt.json"), JSON.stringify({format: "folio-server-restore/v1", previousEpoch: manifest.serverEpoch,
      serverEpoch, backupManifestHash: manifestHash, restoredAt: new Date().toISOString()}), {mode: 0o600, syncParentDirectory: true});
    for (const asset of manifest.assets) inspectVerifiedServerFile(join(destination, asset.path), asset);
    requireCondition(inspectVerifiedServerFile(join(source.path, SERVER_FULL_MANIFEST), undefined, MAX_MANIFEST).sha256 === manifestHash, "server-full-changed", 409);
    inspectFullServerBackup(source.path); lease.assertOwned();
    finish(output.root, output.marker);
    published = true;
    return {destination, previousEpoch: manifest.serverEpoch, serverEpoch};
  } catch (e) {return normalize(e);}
  finally {
    try {try {guard?.close();} finally {lease?.close();}}
    catch (e) {if (published) throw new SyncError("server-full-published-unverified", 409); normalize(e);}
  }
}

/* ==================== Windows native branch ====================
 * Product publication checks expressed through the K-native port, without
 * claiming POSIX durability equivalence:
 * pinned native identities instead of dev/ino, held C leases instead of
 * POSIX lock semantics, and bounded namespace hints instead of POSIX stat
 * proof. The strict manifest/inventory checks below mirror
 * server-full-inspection.ts exactly; that module stays POSIX-only and is
 * not modified. */

const N_INCOMPLETE = "server-full-incomplete";
const N_INVALID = "server-full-invalid";
const N_LIMIT = "server-full-limit";
const MAX_ASSET_BYTES = MAX_SYNC_ASSET_BYTES;
const MAX_ASSET_COUNT = 4096;
const MAX_WORKSPACES = 4096;
const MAX_BLOB_ENTRIES = 8192;
const N_WORKSPACE_KEYS = ["workspaceId", "ownerId", "revision", "checkpointHash"] as const;
const N_COUNT_KEYS = ["changes", "operations", "devices", "activeDevices", "revokedDevices"] as const;
const N_DATABASE_KEYS = ["path", "bytes", "sha256"] as const;
const N_ASSET_KEYS = ["workspaceId", "sha256", "bytes", "path"] as const;
const N_MANIFEST_KEYS = ["format", "createdAt", "serverEpoch", "database", "assets", "workspaces", "counts"] as const;

type NJsonRecord = Record<string, unknown>;

function nIncomplete(): never { throw new SyncError(N_INCOMPLETE, 409); }
function nInvalid(): never { throw new SyncError(N_INVALID, 422); }
function nLimit(): never { throw new SyncError(N_LIMIT, 409); }
function nRecord(value: unknown): NJsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) nInvalid();
  return value as NJsonRecord;
}
function nExact(value: unknown, keys: readonly string[]): NJsonRecord {
  const object = nRecord(value);
  const own = Object.keys(object);
  if (own.length !== keys.length || keys.some((key) => !Object.hasOwn(object, key))) nInvalid();
  return object;
}
function nIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) nInvalid();
  return value;
}
function nHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) nInvalid();
  return value;
}
function nDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function nCounter(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) nInvalid();
  return value;
}
function nIsoTime(value: unknown): string {
  if (typeof value !== "string" || value.length < 20 || value.length > 32) nInvalid();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) nInvalid();
  return value;
}
function nUtf8(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  const text = buffer.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buffer)) nInvalid();
  return text;
}

/** Exact manifest parser — the same strictness as the POSIX inspector:
 * key sets, formats, ISO stamps, identifier/hash shapes, path and
 * duplicate rules, and every bound (4MiB manifest, 256MiB database/assets,
 * 20MB asset, 4096 assets/workspaces). */
function nParseManifest(text: string): ServerFullBackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return nInvalid();
  }
  const manifest = nExact(value, N_MANIFEST_KEYS);
  if (manifest.format !== "folio-server-full/v1") nInvalid();
  const createdAt = nIsoTime(manifest.createdAt);
  const serverEpoch = nIdentifier(manifest.serverEpoch);
  const database = nExact(manifest.database, N_DATABASE_KEYS);
  if (database.path !== "server.sqlite") nInvalid();
  const databaseBytes = nCounter(database.bytes);
  if (databaseBytes > MAX_DB) nLimit();
  const databaseSha = nHash(database.sha256);
  if (!Array.isArray(manifest.assets)) nInvalid();
  if (manifest.assets.length > MAX_ASSET_COUNT) nLimit();
  const assetKeys = new Set<string>();
  let totalAssetBytes = 0;
  const assets: ServerFullBackupManifest["assets"] = manifest.assets.map((item) => {
    const asset = nExact(item, N_ASSET_KEYS);
    const workspaceId = nIdentifier(asset.workspaceId);
    const assetSha = nHash(asset.sha256);
    const bytes = nCounter(asset.bytes);
    if (bytes > MAX_ASSET_BYTES) nLimit();
    totalAssetBytes += bytes;
    if (totalAssetBytes > MAX_ASSETS) nLimit();
    const expectedPath = `blobs/${nDigest(workspaceId)}/${assetSha}`;
    if (asset.path !== expectedPath) nInvalid();
    const key = `${workspaceId}\0${assetSha}`;
    if (assetKeys.has(key)) nInvalid();
    assetKeys.add(key);
    return { workspaceId, sha256: assetSha, bytes, path: expectedPath };
  });
  if (!Array.isArray(manifest.workspaces)) nInvalid();
  if (manifest.workspaces.length > MAX_WORKSPACES) nLimit();
  const workspaceKeys = new Set<string>();
  const workspaces: ServerHistoryInventory["workspaces"] = manifest.workspaces.map((item) => {
    const workspace = nExact(item, N_WORKSPACE_KEYS);
    const workspaceId = nIdentifier(workspace.workspaceId);
    const ownerId = nIdentifier(workspace.ownerId);
    const revision = nCounter(workspace.revision);
    let checkpointHash: string | null = null;
    if (revision === 0) {
      if (workspace.checkpointHash !== null) nInvalid();
    } else {
      checkpointHash = nHash(workspace.checkpointHash);
    }
    if (workspaceKeys.has(workspaceId)) nInvalid();
    workspaceKeys.add(workspaceId);
    return { workspaceId, ownerId, revision, checkpointHash };
  });
  const countsObject = nExact(manifest.counts, N_COUNT_KEYS);
  const counts = {} as ServerFullBackupManifest["counts"];
  for (const key of N_COUNT_KEYS) counts[key] = nCounter(countsObject[key]);
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

function nJoinRel(native: WindowsServerNativePort, base: string, relativePath: string): string {
  const parts = relativePath.split("/");
  if (parts.length < 1 || parts.some((part) => part.length === 0 || part === "." || part === "..")) nInvalid();
  return parts.reduce((path, part) => native.join(path, part), base);
}

function nVerifyFile(
  native: WindowsServerNativePort,
  path: string,
  expected: { bytes: number; sha256: string },
  maxBytes: number,
): NativePrivateFile {
  const kind = native.kindOf(path);
  if (kind === "absent") nIncomplete();
  if (kind !== "file") nInvalid();
  const file = native.inspectFile(path, maxBytes);
  if (file.bytes > maxBytes) nLimit();
  if (file.bytes !== expected.bytes || file.sha256 !== expected.sha256) nInvalid();
  return file;
}

/** integrity_check + inspectServerHistory under a held C lease; the
 * database closes before the C handle and any close failure surfaces. */
function nOpenDatabase(native: WindowsServerNativePort, path: string): ServerHistoryInventory {
  const lease = native.acquireSqliteLease(path);
  let inventory: ServerHistoryInventory | undefined;
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(pathToFileURL(path).href + "?mode=ro&immutable=1", { readOnly: true });
  } catch (error) { return native.retainUnknown(lease, error); }
  const close = onceNativeServerClose(native, () => database.close());
  let primary: NativeServerFailure | undefined;
  try {
    lease.assertHeld();
    database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0");
    const checks = database.prepare("PRAGMA integrity_check").all();
    if (!Array.isArray(checks) || checks.length !== 1) nInvalid();
    if (nExact(checks[0], ["integrity_check"]).integrity_check !== "ok") nInvalid();
    inventory = inspectServerHistory(database);
    lease.assertHeld();
  } catch (error) {
    primary = { error };
  }
  closeNativeServerResources(native, [close, () => lease.close()], primary);
  return inventory!;
}

function nClose(
  native: WindowsServerNativePort,
  parts: readonly (() => void)[],
  primary: NativeServerFailure | undefined,
  published: boolean,
): void {
  try { closeNativeServerResources(native, parts, primary); }
  catch (error) {
    if (published && !(error instanceof SyncError && error.code === "server-full-published-unverified"))
      throw Object.assign(new SyncError("server-full-published-unverified", 409), { cause: error });
    throw error;
  }
}

function nCompareAssets(
  left: { workspaceId: string; sha256: string; bytes: number },
  right: { workspaceId: string; sha256: string; bytes: number },
): number {
  if (left.workspaceId !== right.workspaceId) return left.workspaceId < right.workspaceId ? -1 : 1;
  if (left.sha256 !== right.sha256) return left.sha256 < right.sha256 ? -1 : 1;
  return left.bytes - right.bytes;
}

function nCompareInventory(manifest: ServerFullBackupManifest, inventory: ServerHistoryInventory): void {
  if (manifest.serverEpoch !== inventory.serverEpoch) nInvalid();
  const manifestWorkspaces = [...manifest.workspaces].sort((left, right) =>
    left.workspaceId < right.workspaceId ? -1 : 1,
  );
  if (manifestWorkspaces.length !== inventory.workspaces.length) nInvalid();
  manifestWorkspaces.forEach((workspace, index) => {
    const actual = inventory.workspaces[index];
    if (
      actual.workspaceId !== workspace.workspaceId ||
      actual.ownerId !== workspace.ownerId ||
      actual.revision !== workspace.revision ||
      actual.checkpointHash !== workspace.checkpointHash
    )
      nInvalid();
  });
  for (const key of N_COUNT_KEYS) {
    if (manifest.counts[key] !== inventory[key]) nInvalid();
  }
  const manifestAssets = manifest.assets
    .map((asset) => ({ workspaceId: asset.workspaceId, sha256: asset.sha256, bytes: asset.bytes }))
    .sort(nCompareAssets);
  if (manifestAssets.length !== inventory.assets.length) nInvalid();
  manifestAssets.forEach((asset, index) => {
    if (nCompareAssets(asset, inventory.assets[index]) !== 0) nInvalid();
  });
}

function nInspectBlobs(
  native: WindowsServerNativePort,
  dir: string,
  assets: ServerFullBackupManifest["assets"],
): void {
  const expected = new Map<string, Set<string>>();
  for (const asset of assets) {
    const directory = nDigest(asset.workspaceId);
    const names = expected.get(directory) ?? new Set<string>();
    names.add(asset.sha256);
    expected.set(directory, names);
  }
  const blobsPath = native.join(dir, "blobs");
  const kind = native.kindOf(blobsPath);
  if (kind === "absent") {
    if (expected.size === 0) return;
    nIncomplete();
  }
  if (kind !== "directory") nInvalid();
  const blobsPin = native.inspectDirectory(blobsPath);
  let entries = 0;
  const workspaceNames = native.listNames(blobsPath, MAX_ASSET_COUNT);
  entries += workspaceNames.length;
  if (entries > MAX_BLOB_ENTRIES) nLimit();
  const seenWorkspaces = new Set<string>();
  for (const name of workspaceNames) {
    const wanted = expected.get(name);
    if (wanted === undefined || seenWorkspaces.has(name)) nInvalid();
    seenWorkspaces.add(name);
    const workspacePath = native.join(blobsPath, name);
    if (native.kindOf(workspacePath) !== "directory") nInvalid();
    const workspacePin = native.inspectDirectory(workspacePath);
    const items = native.listNames(workspacePath, MAX_ASSET_COUNT);
    entries += items.length;
    if (entries > MAX_BLOB_ENTRIES) nLimit();
    const seen = new Set<string>();
    for (const item of items) {
      if (!wanted.has(item) || seen.has(item)) nInvalid();
      if (native.kindOf(native.join(workspacePath, item)) !== "file") nInvalid();
      seen.add(item);
    }
    if (seen.size !== wanted.size) nIncomplete();
    native.assertDirectory(workspacePath, workspacePin);
  }
  if (seenWorkspaces.size !== expected.size) nIncomplete();
  native.assertDirectory(blobsPath, blobsPin);
}

/** Full published/staged backup inspection through K. When `marker` is set
 * the pinned incomplete marker must still be present (builder staging);
 * otherwise its presence is an incomplete verdict. Root children are
 * exactly the expected set; SQLite sidecars must be absent; every file is
 * re-proven by native identity at the end. */
function nInspectBackup(
  native: WindowsServerNativePort,
  directory: string,
  marker?: NativePrivateFile,
): ServerFullBackupManifest {
  try {
    const dir = native.canonical(directory);
    const dirKind = native.kindOf(dir);
    if (dirKind === "absent") nIncomplete();
    if (dirKind !== "directory") nInvalid();
    const root = native.inspectDirectory(dir);
    const markerPath = native.join(dir, SERVER_FULL_MARKER);
    const checkMarker = () => {
      const kind = native.kindOf(markerPath);
      if (marker === undefined) {
        if (kind !== "absent") nIncomplete();
        return;
      }
      if (kind !== "file") nInvalid();
      const current = native.inspectFile(markerPath, MAX_MANIFEST);
      if (!native.sameIdentity(current, marker) || current.bytes !== marker.bytes || current.sha256 !== marker.sha256) nInvalid();
    };
    checkMarker();
    const allowed = new Set(["server.sqlite", SERVER_FULL_MANIFEST, "blobs", ...(marker ? [SERVER_FULL_MARKER] : [])]);
    const names = native.listNames(dir, 4);
    if (names.length > allowed.size) nLimit();
    for (const name of names) if (!allowed.has(name)) nInvalid();
    const manifestPath = native.join(dir, SERVER_FULL_MANIFEST);
    const manifestFile = (() => {
      const kind = native.kindOf(manifestPath);
      if (kind === "absent") nIncomplete();
      if (kind !== "file") nInvalid();
      const file = native.inspectFile(manifestPath, MAX_MANIFEST);
      if (file.bytes > MAX_MANIFEST) nLimit();
      return file;
    })();
    const manifestBytes = native.readFile(manifestPath, manifestFile, MAX_MANIFEST);
    if (manifestBytes.byteLength !== manifestFile.bytes) nInvalid();
    const manifest = nParseManifest(nUtf8(manifestBytes));
    const databasePath = native.join(dir, "server.sqlite");
    // Zero SQLite sidecars: a publishable backup is a quiescent snapshot.
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      if (native.kindOf(databasePath + suffix) !== "absent") nInvalid();
    }
    const databaseFile = nVerifyFile(native, databasePath, manifest.database, MAX_DB);
    const assetFiles = new Map<string, NativePrivateFile>();
    for (const asset of manifest.assets) {
      assetFiles.set(asset.path, nVerifyFile(native, nJoinRel(native, dir, asset.path), asset, MAX_ASSET_BYTES));
    }
    const databaseIdentity = native.inspectFileIdentity(databasePath);
    const inventory = nOpenDatabase(native, databasePath);
    if (!native.sameIdentity(native.inspectFileIdentity(databasePath), databaseIdentity)) nInvalid();
    nCompareInventory(manifest, inventory);
    nInspectBlobs(native, dir, manifest.assets);
    const reprove = (path: string, pinned: NativePrivateFile, maxBytes: number) => {
      const current = native.inspectFile(path, maxBytes);
      if (!native.sameIdentity(current, pinned) || current.bytes !== pinned.bytes || current.sha256 !== pinned.sha256) nInvalid();
    };
    reprove(manifestPath, manifestFile, MAX_MANIFEST);
    reprove(databasePath, databaseFile, MAX_DB);
    for (const [relativePath, file] of assetFiles) {
      reprove(nJoinRel(native, dir, relativePath), file, MAX_ASSET_BYTES);
    }
    for (const suffix of ["-wal", "-shm", "-journal"])
      if (native.kindOf(databasePath + suffix) !== "absent") nInvalid();
    const finalNames = native.listNames(dir, 4);
    if (finalNames.length !== names.length || finalNames.some(name => !names.includes(name))) nInvalid();
    nInspectBlobs(native, dir, manifest.assets);
    native.assertDirectory(dir, root);
    checkMarker();
    return manifest;
  } catch (error) {
    if (
      error instanceof SyncError &&
      (error.code === N_INCOMPLETE || error.code === N_INVALID || error.code === N_LIMIT)
    )
      throw error;
    throw Object.assign(new SyncError(N_INVALID, 422), { cause: error });
  }
}

function nDestination(
  native: WindowsServerNativePort,
  destination: string,
  sourceDir: string,
): { path: string; parent: string; parentId: NativePrivateIdentity } {
  requireCondition(
    typeof destination === "string" && destination.length > 0 && destination.length <= 240 && !destination.includes("\0"),
    "server-full-destination",
    409,
  );
  const path = native.canonical(destination);
  assertNativeServerHandoffAncestors(native, path);
  requireCondition(native.kindOf(path) === "absent", "server-full-destination-exists", 409);
  const parent = native.parent(path);
  const parentId = native.inspectDirectory(parent);
  requireCondition(!native.overlaps(path, sourceDir), "server-full-destination", 409);
  return { path, parent, parentId };
}

/** Exclusive output directory + pinned incomplete marker. EXISTS/UNKNOWN
 * propagate from the adapter; nothing is retried or deleted. */
function nReserve(
  native: WindowsServerNativePort,
  path: string,
): { rootId: NativePrivateIdentity; marker: NativePrivateFile } {
  const parent = native.parent(path);
  const parentId = native.inspectDirectory(parent);
  const rootId = native.createDirectory(path);
  const marker = native.writeNewFile(
    native.join(path, SERVER_FULL_MARKER),
    Buffer.from(MARKER_TEXT, "utf8"),
    MAX_MANIFEST,
  );
  native.assertDirectory(parent, parentId);
  return { rootId, marker };
}

/** Remove the pinned marker only after its identity is re-proven. Never
 * called on an UNKNOWN path and never re-adds the marker automatically. */
function nFinish(
  native: WindowsServerNativePort,
  dir: string,
  rootId: NativePrivateIdentity,
  marker: NativePrivateFile,
): void {
  native.assertDirectory(dir, rootId);
  const markerPath = native.join(dir, SERVER_FULL_MARKER);
  const current = native.inspectFile(markerPath, MAX_MANIFEST);
  requireCondition(
    native.sameIdentity(current, marker) && current.bytes === marker.bytes && current.sha256 === marker.sha256,
    "server-full-incomplete",
    409,
  );
  native.unlinkExact(markerPath, current);
}

/** Create-or-pin: fresh exclusive create for a new directory, identity pin
 * for an existing one. Anything else is an invalid destination. */
function nEnsureDirectory(native: WindowsServerNativePort, path: string): void {
  const kind = native.kindOf(path);
  if (kind === "directory") {
    native.inspectDirectory(path);
    return;
  }
  if (kind !== "absent") throw new SyncError("server-full-destination", 409);
  native.createDirectory(path);
}

function createServerFullBackupNative(
  native: WindowsServerNativePort,
  options: { sourceDirectory: string; destination: string; lease: ServerDirectoryLease },
): { destination: string; manifest: ServerFullBackupManifest } {
  let database: DatabaseSync | undefined;
  let mainLease: PrivateAuthorityLease | undefined;
  let closeDatabaseNative: (() => void) | undefined;
  let primary: NativeServerFailure | undefined;
  let published = false;
  try {
    const dir = native.canonical(options.sourceDirectory);
    const source = native.inspectDirectory(dir);
    options.lease.assertOwned();
    requireCondition(
      native.samePath(options.lease.directory, dir) &&
        native.kindOf(native.join(dir, SERVER_FULL_MARKER)) === "absent",
      "server-full-incomplete",
      409,
    );
    const databasePath = native.join(dir, "server.sqlite");
    native.inspectFile(databasePath, MAX_DB);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const kind = native.kindOf(databasePath + suffix);
      requireCondition(kind === "absent" || kind === "file", "server-full-invalid", 422);
      if (kind === "file") {
        const sidecar = native.inspectFile(databasePath + suffix, MAX_DB);
        requireCondition(suffix !== "-journal" || sidecar.bytes === 0, "server-recovery-required", 409);
      }
    }
    mainLease = native.acquireSqliteLease(databasePath);
    mainLease.assertHeld();
    try { database = new DatabaseSync(databasePath, { readOnly: true }); }
    catch (error) { return native.retainUnknown(mainLease, error); }
    closeDatabaseNative = onceNativeServerClose(native, () => database!.close());
    database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0");
    const before = inspectServerHistory(database);
    const total = before.assets.reduce((n, asset) => n + asset.bytes, 0);
    requireCondition(total <= MAX_ASSETS, "server-full-limit", 409);
    const allocation =
      Number(database.prepare("PRAGMA page_count").get()!.page_count) *
      Number(database.prepare("PRAGMA page_size").get()!.page_size);
    requireCondition(Number.isSafeInteger(allocation) && allocation <= MAX_DB, "server-full-limit", 409);
    const destination = nDestination(native, options.destination, dir);
    native.assertCapacity(destination.parent, allocation * 2 + total + MAX_MANIFEST);
    const output = nReserve(native, destination.path);
    const snapshotPath = native.join(destination.path, "server.sqlite");
    const snapshot = native.snapshotSqlite(database, snapshotPath);
    const file = native.inspectFile(snapshotPath, MAX_DB);
    requireCondition(native.sameIdentity(file, snapshot.identity) &&
      file.bytes === snapshot.identity.bytes && file.sha256 === snapshot.identity.sha256, "server-full-invalid", 422);
    const inventory = nOpenDatabase(native, snapshotPath);
    requireCondition(canonicalJson(inventory, 8 * 1024 * 1024) === canonicalJson(before, 8 * 1024 * 1024), "server-full-changed", 409);
    nEnsureDirectory(native, native.join(destination.path, "blobs"));
    const assets: ServerFullBackupManifest["assets"] = [];
    for (const asset of inventory.assets) {
      options.lease.assertOwned();
      const relativePath = `blobs/${sha256(asset.workspaceId)}/${asset.sha256}`;
      nEnsureDirectory(native, native.join(native.join(destination.path, "blobs"), sha256(asset.workspaceId)));
      copyVerifiedServerFile(
        nJoinRel(native, dir, relativePath),
        nJoinRel(native, destination.path, relativePath),
        asset,
      );
      assets.push({ ...asset, path: relativePath });
    }
    requireCondition(canonicalJson(inspectServerHistory(database), 8 * 1024 * 1024) === canonicalJson(before, 8 * 1024 * 1024), "server-full-changed", 409);
    const { serverEpoch, workspaces, changes, operations, devices, activeDevices, revokedDevices } = inventory;
    const manifest: ServerFullBackupManifest = {
      format: "folio-server-full/v1",
      createdAt: new Date().toISOString(),
      serverEpoch,
      database: { path: "server.sqlite", bytes: file.bytes, sha256: file.sha256 },
      assets,
      workspaces,
      counts: { changes, operations, devices, activeDevices, revokedDevices },
    };
    const text = JSON.stringify(manifest);
    requireCondition(Buffer.byteLength(text) <= MAX_MANIFEST, "server-full-limit", 409);
    native.writeNewFile(native.join(destination.path, SERVER_FULL_MANIFEST), Buffer.from(text, "utf8"), MAX_MANIFEST);
    options.lease.assertOwned();
    native.assertDirectory(dir, source);
    nInspectBackup(native, destination.path, output.marker);
    mainLease.assertHeld();
    closeDatabaseNative();
    mainLease.close();
    closeDatabaseNative = undefined;
    mainLease = undefined;
    nFinish(native, destination.path, output.rootId, output.marker);
    published = true;
    return { destination: destination.path, manifest: nInspectBackup(native, destination.path) };
  } catch (e) {
    const error = published ? Object.assign(new SyncError("server-full-published-unverified", 409), { cause: e }) : e;
    primary = { error };
    throw error;
  } finally {
    nClose(native, [
      () => native.assertCurrent(),
      () => closeDatabaseNative?.(),
      () => mainLease?.close(),
    ], primary, published);
  }
}

function restoreServerFullBackupNative(
  native: WindowsServerNativePort,
  options: { backupDirectory: string; destination: string; port: number },
): { destination: string; previousEpoch: string; serverEpoch: string } {
  let lease: ServerDirectoryLease | undefined;
  let mainLease: PrivateAuthorityLease | undefined;
  let guard: SyncSqliteGuard | undefined;
  let closeGuard: (() => void) | undefined;
  let primary: NativeServerFailure | undefined;
  let published = false;
  try {
    const dir = native.canonical(options.backupDirectory);
    native.inspectDirectory(dir);
    const manifest = nInspectBackup(native, dir);
    requireCondition(
      manifest.workspaces.length === 1 && Number.isInteger(options.port) && options.port > 0 && options.port <= 65535,
      "server-full-unsupported",
      409,
    );
    const manifestPath = native.join(dir, SERVER_FULL_MANIFEST);
    const manifestHash = native.inspectFile(manifestPath, MAX_MANIFEST).sha256;
    const destination = nDestination(native, options.destination, dir);
    native.assertCapacity(
      destination.parent,
      manifest.database.bytes * 2 + manifest.assets.reduce((n, asset) => n + asset.bytes, 0) + MAX_MANIFEST,
    );
    const output = nReserve(native, destination.path);
    lease = acquireServerDirectoryLease(destination.path);
    const databasePath = native.join(destination.path, "server.sqlite");
    copyVerifiedServerFile(native.join(dir, "server.sqlite"), databasePath, manifest.database, MAX_DB);
    nEnsureDirectory(native, native.join(destination.path, "blobs"));
    for (const asset of manifest.assets) {
      nEnsureDirectory(native, native.join(native.join(destination.path, "blobs"), nDigest(asset.workspaceId)));
      copyVerifiedServerFile(
        nJoinRel(native, dir, asset.path),
        nJoinRel(native, destination.path, asset.path),
        asset,
      );
    }
    mainLease = native.acquireSqliteLease(databasePath);
    mainLease.assertHeld();
    let connection: DatabaseSync;
    try { connection = new DatabaseSync(databasePath); }
    catch (error) { return native.retainUnknown({ mainLease, lease }, error); }
    try { guard = new SyncSqliteGuard(connection); }
    catch (error) { return native.retainUnknown({ connection, mainLease, lease }, error); }
    closeGuard = onceNativeServerClose(native, () => guard!.close());
    guard.db.exec("PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
    let serverEpoch = randomUUID();
    while (serverEpoch === manifest.serverEpoch) serverEpoch = randomUUID();
    guard.transaction(() => {
      guard!.db.prepare("UPDATE checkpoint_server_identity SET epoch=? WHERE singleton=1").run(serverEpoch);
      guard!.db.prepare("UPDATE checkpoint_devices SET revoked=1").run();
    });
    const restored = inspectServerHistory(guard.db);
    requireCondition(
      restored.serverEpoch === serverEpoch && restored.activeDevices === 0 && restored.devices === manifest.counts.devices &&
        restored.changes === manifest.counts.changes && restored.operations === manifest.counts.operations &&
        canonicalJson(restored.workspaces) === canonicalJson(manifest.workspaces),
      "server-full-invalid",
      422,
    );
    // The writable SQLite closes before the C handle is released.
    closeGuard();
    guard = undefined;
    closeGuard = undefined;
    mainLease.assertHeld();
    native.proveSyncFile(databasePath, native.inspectFile(databasePath, MAX_DB));
    mainLease.close();
    mainLease = undefined;
    const workspace = manifest.workspaces[0];
    writeServerOpsConfig(destination.path, {
      format: "folio-server-config/v1",
      workspaceId: workspace.workspaceId,
      ownerId: workspace.ownerId,
      port: options.port,
    });
    native.writeNewFile(
      native.join(destination.path, "restore-receipt.json"),
      Buffer.from(
        JSON.stringify({
          format: "folio-server-restore/v1",
          previousEpoch: manifest.serverEpoch,
          serverEpoch,
          backupManifestHash: manifestHash,
          restoredAt: new Date().toISOString(),
        }),
        "utf8",
      ),
      MAX_MANIFEST,
    );
    for (const asset of manifest.assets) {
      inspectVerifiedServerFile(nJoinRel(native, destination.path, asset.path), asset);
    }
    requireCondition(
      native.inspectFile(manifestPath, MAX_MANIFEST).sha256 === manifestHash,
      "server-full-changed",
      409,
    );
    nInspectBackup(native, dir);
    lease.assertOwned();
    nFinish(native, destination.path, output.rootId, output.marker);
    published = true;
    return { destination: destination.path, previousEpoch: manifest.serverEpoch, serverEpoch };
  } catch (e) {
    const error = published ? Object.assign(new SyncError("server-full-published-unverified", 409), { cause: e }) : e;
    primary = { error };
    throw error;
  } finally {
    nClose(native, [
      () => native.assertCurrent(),
      () => closeGuard?.(),
      () => mainLease?.close(),
      () => lease?.close(),
    ], primary, published);
  }
}

/** Native inspection dispatcher for the parent's CLI `inspect` lane. The
 * unowned POSIX inspector is unchanged and still serves POSIX callers. */
export function inspectOperationalServerFullBackup(directory: string): ServerFullBackupManifest {
  const native = windowsServerNative();
  if (native !== undefined) return nInspectBackup(native, directory);
  if (process.platform === "win32") throw new SyncError("server-native-unsafe", 409);
  return inspectFullServerBackup(directory);
}
