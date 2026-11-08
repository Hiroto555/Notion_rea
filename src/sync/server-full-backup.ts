import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, statfsSync, unlinkSync, constants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { syncPath, writeNewFileDurably } from "../persistence/durable-file";
import { DEFAULT_STORAGE_RESERVE_BYTES } from "../shared/storage-pressure";
import { pinPrivateRoot, assertPrivateRoot, type PrivateRootPin } from "./m3-private-root";
import { canonicalJson, requireCondition, sha256, SyncError } from "./protocol";
import { inspectServerHistory } from "./server-history-validation";
import { copyVerifiedServerFile, inspectVerifiedServerFile } from "./server-verified-file";
import { inspectFullServerBackup, verifyStagedFullServerBackup } from "./server-full-inspection";
import { acquireServerDirectoryLease, type ServerDirectoryLease } from "./server-directory-lease";
import { writeServerOpsConfig } from "./server-ops-config";
import { SyncSqliteGuard } from "./sqlite-guard";
import { SERVER_FULL_MANIFEST, SERVER_FULL_MARKER, type ServerFullBackupManifest } from "./server-full-types";

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
  let database: DatabaseSync | undefined;
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
    return {destination, manifest: inspectFullServerBackup(destination)};
  } catch (e) {return normalize(e);}
  finally {database?.close();}
}

/** Restore only into a fresh private directory. Old devices stay revoked;
 * historical operations/receipts are retained as evidence, never re-stamped. */
export function restoreServerFullBackup(options: {backupDirectory: string; destination: string; port: number}): {destination: string; previousEpoch: string; serverEpoch: string} {
  let lease: ServerDirectoryLease | undefined;
  let guard: SyncSqliteGuard | undefined;
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
    return {destination, previousEpoch: manifest.serverEpoch, serverEpoch};
  } catch (e) {return normalize(e);}
  finally {try {guard?.close();} finally {lease?.close();}}
}
