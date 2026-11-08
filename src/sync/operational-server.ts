import { randomBytes } from "node:crypto";
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startCheckpointServer, type CheckpointServerHandle } from "./checkpoint-server";
import { acquireServerDirectoryLease, type ServerDirectoryLease } from "./server-directory-lease";
import { pinPrivateRoot, assertPrivateRoot, assertSqliteSidecars } from "./m3-private-root";
import { readServerOpsConfig, writeServerOpsConfig, writeIssuedSyncCredential, readIssuedSyncCredential, type ServerOpsConfig } from "./server-ops-config";
import { SERVER_FULL_MARKER } from "./server-full-types";
import { inspectServerHistory } from "./server-history-validation";
import { inspectVerifiedServerFile } from "./server-verified-file";
import { WorkspaceBlobStore } from "./workspace-blobs";
import { validateWorkspaceCheckpoint } from "./workspace-checkpoint";
import { requireCondition, identifier, SyncError } from "./protocol";
import { inspectSyncRetention } from "./sync-retention";
import { inspectServerBlobRetention } from "./server-blob-retention";
import { syncPath, writeNewFileDurably } from "../persistence/durable-file";

function optional(path: string) {try {return lstatSync(path);} catch (e) {if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e;}}
function existing(directory: string) {
  const root = pinPrivateRoot(directory);
  requireCondition(!optional(join(root.path, SERVER_FULL_MARKER)), "server-full-incomplete", 409);
  const config = readServerOpsConfig(root.path), path = join(root.path, "server.sqlite");
  inspectVerifiedServerFile(path, undefined, 256 * 1024 * 1024);
  assertSqliteSidecars(path, root.uid);
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    const inventory = inspectServerHistory(db);
    requireCondition(inventory.workspaces.length === 1 && inventory.workspaces[0].workspaceId === config.workspaceId &&
      inventory.workspaces[0].ownerId === config.ownerId, "server-config-invalid", 409);
  } finally {db.close();}
  assertPrivateRoot(root); return {root, config};
}
function raw(directory: string, config: ServerOpsConfig, port: number) {
  return startCheckpointServer({databasePath: join(directory, "server.sqlite"), capabilities: [],
    workspaces: [{workspaceId: config.workspaceId, ownerId: config.ownerId}],
    validateCheckpoint: validateWorkspaceCheckpoint, blobs: new WorkspaceBlobStore(join(directory, "blobs")), port});
}
export async function initializeOperationalServer(directory: string, config: ServerOpsConfig): Promise<{directory: string; serverEpoch: string}> {
  const requested = resolve(directory), parent = pinPrivateRoot(realpathSync(dirname(requested)));
  requireCondition(!optional(requested), "server-destination-exists", 409);
  const path = join(parent.path, requested.slice(requested.lastIndexOf("/") + 1));
  mkdirSync(path, {mode: 0o700}); syncPath(parent.path); assertPrivateRoot(parent);
  const root = pinPrivateRoot(path);
  writeNewFileDurably(join(path, SERVER_FULL_MARKER), "Incomplete Folio server initialization\n", {mode: 0o600, syncParentDirectory: true});
  const marker = lstatSync(join(path, SERVER_FULL_MARKER)), lease = acquireServerDirectoryLease(path);
  let server: CheckpointServerHandle | undefined;
  try {
    writeServerOpsConfig(path, config);
    const fd = openSync(join(path, "server.sqlite"), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {fsyncSync(fd);} finally {closeSync(fd);} syncPath(path);
    server = await raw(path, config, 0); const epoch = server.serverEpoch;
    await server.close(); server = undefined;
    lease.assertOwned(); assertPrivateRoot(root);
    const current = lstatSync(join(path, SERVER_FULL_MARKER));
    requireCondition(current.isFile() && current.nlink === 1 && current.dev === marker.dev && current.ino === marker.ino, "server-full-incomplete", 409);
    unlinkSync(join(path, SERVER_FULL_MARKER));
    try {syncPath(path);} catch (error) {
      try {writeNewFileDurably(join(path, SERVER_FULL_MARKER), "Incomplete Folio server initialization\n", {mode: 0o600, syncParentDirectory: true});} catch {}
      throw error;
    }
    return {directory: path, serverEpoch: epoch};
  } finally {try {await server?.close();} finally {lease.close();}}
}
/** Product entry point; owns the directory lease until the listener closes. */
export async function startOperationalServer(directory: string): Promise<CheckpointServerHandle> {
  const lease = acquireServerDirectoryLease(directory);
  try {
    const {root, config} = existing(directory), server = await raw(root.path, config, config.port);
    lease.assertOwned();
    return {...server, close: async () => {try {await server.close();} finally {lease.close();}}};
  } catch (error) {lease.close(); throw error;}
}
/** All offline administration uses the same lease as serving and backup. */
export async function administerOperationalServer<T>(directory: string,
  work: (server: CheckpointServerHandle, config: ServerOpsConfig, lease: ServerDirectoryLease) => Promise<T> | T): Promise<T> {
  const lease = acquireServerDirectoryLease(directory);
  let server: CheckpointServerHandle | undefined;
  try {
    const {root, config} = existing(directory); server = await raw(root.path, config, 0);
    const result = await work(server, config, lease); lease.assertOwned(); return result;
  } finally {try {await server?.close();} finally {lease.close();}}
}
export async function issueOperationalCredential(options: {directory: string; clientId: string; credentialFile: string; reuse?: boolean}): Promise<{clientId: string; baseUrl: string}> {
  identifier(options.clientId);
  return administerOperationalServer(options.directory, (server, config) => {
    const baseUrl = `http://127.0.0.1:${config.port}`;
    const credential = options.reuse ? readIssuedSyncCredential(options.credentialFile) :
      {format: "folio-sync-credential/v1" as const, baseUrl, workspaceId: config.workspaceId, clientId: options.clientId,
        token: randomBytes(32).toString("base64url")};
    requireCondition(credential.baseUrl === baseUrl && credential.workspaceId === config.workspaceId && credential.clientId === options.clientId,
      "server-credential-mismatch", 409);
    // Durable private handoff precedes registration, so a response loss can be
    // reconciled with --reuse-credential without issuing a second secret.
    if (!options.reuse) writeIssuedSyncCredential(options.credentialFile, credential, [realpathSync(options.directory)]);
    server.registerDevice({workspaceId: config.workspaceId, ownerId: config.ownerId, clientId: credential.clientId, token: credential.token});
    return {clientId: credential.clientId, baseUrl};
  });
}
export function safeServerOpsError(error: unknown): string {
  if (error instanceof SyncError && /^[a-z][a-z0-9-]{1,80}$/.test(error.code)) return error.code;
  return "server-operation-held";
}

/** Offline bounded diagnostics; no token hashes, receipts or payloads escape. */
export function inspectOperationalServer(directory: string) {
  const lease = acquireServerDirectoryLease(directory);
  try {
    const {root} = existing(directory), path = join(root.path, "server.sqlite");
    const db = new DatabaseSync(path, {readOnly: true});
    let history, devices;
    try {
      history = inspectSyncRetention(db, "server");
      devices = Number(db.prepare("SELECT COUNT(*) AS n FROM checkpoint_devices").get()!.n);
    } finally {db.close();}
    let blobs = null, held: string | null = null;
    try {blobs = inspectServerBlobRetention(join(root.path, "blobs"));} catch {held = "server-blob-retention-unknown";}
    lease.assertOwned();
    return {history, devices, maxDevices: 512, blobs, held};
  } finally {lease.close();}
}
