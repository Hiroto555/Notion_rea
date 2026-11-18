import { randomBytes, createHash } from "node:crypto";
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { types as utilTypes } from "node:util";
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
import type { NativePrivateFile } from "../platform/private-persistence";
import type { PrivateAuthorityLease } from "../platform/windows/authority-lease";
import {
  windowsServerNative,
  onceNativeServerClose,
  closeNativeServerResources,
  type NativeServerFailure,
  type WindowsServerNativePort,
} from "../platform/windows/server-native";

function optional(path: string) {try {return lstatSync(path);} catch (e) {if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e;}}
function existing(directory: string, recover = false) {
  const root = pinPrivateRoot(directory);
  requireCondition(!optional(join(root.path, SERVER_FULL_MARKER)), "server-full-incomplete", 409);
  const config = readServerOpsConfig(root.path), path = join(root.path, "server.sqlite");
  inspectVerifiedServerFile(path, undefined, 256 * 1024 * 1024);
  assertSqliteSidecars(path, root.uid);
  const before = lstatSync(path), journal = optional(path + "-journal");
  if (recover) {
    // Under the product directory lease, let SQLite recover its own validated
    // sidecars before read-only history inspection. Never unlink sidecars.
    const recovery = new DatabaseSync(path);
    try {recovery.exec("PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL;"); recovery.prepare("SELECT COUNT(*) FROM sqlite_master").get();}
    finally {recovery.close();}
    const after = lstatSync(path);
    requireCondition(before.dev === after.dev && before.ino === after.ino, "server-maintenance-unsafe", 409);
    assertPrivateRoot(root); assertSqliteSidecars(path, root.uid);
  } else requireCondition(!journal || journal.size === 0, "server-recovery-required", 409);
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    const inventory = inspectServerHistory(db);
    requireCondition(inventory.workspaces.length === 1 && inventory.workspaces[0].workspaceId === config.workspaceId &&
      inventory.workspaces[0].ownerId === config.ownerId, "server-config-invalid", 409);
    for (const asset of inventory.assets)
      inspectVerifiedServerFile(join(root.path, "blobs", createHash("sha256").update(asset.workspaceId).digest("hex"), asset.sha256), asset);
  } finally {db.close();}
  assertPrivateRoot(root); return {root, config};
}
function raw(directory: string, config: ServerOpsConfig, port: number) {
  return startCheckpointServer({databasePath: join(directory, "server.sqlite"), capabilities: [],
    workspaces: [{workspaceId: config.workspaceId, ownerId: config.ownerId}],
    validateCheckpoint: validateWorkspaceCheckpoint, blobs: new WorkspaceBlobStore(join(directory, "blobs")), port});
}

/* ==================== Windows native branch ====================
 * No uid/mode/fsync equivalence: all facts come through the ambient
 * WindowsServerNativePort (K proofs + C held leases). The POSIX helpers
 * above are untouched and unreachable while a native context is set. */

function nativeUnsafe(): never { throw new SyncError("server-native-unsafe", 409); }

function nativeSidecars(native: WindowsServerNativePort, path: string): { journal: NativePrivateFile | null } {
  let journal: NativePrivateFile | null = null;
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    const kind = native.kindOf(`${path}${suffix}`);
    if (kind === "absent") continue;
    if (kind !== "file") throw new SyncError("m3-private-root-unsafe", 409);
    const file = native.inspectFile(`${path}${suffix}`, 32 * 1024 * 1024);
    if (suffix === "-journal") journal = file;
  }
  return { journal };
}

function nativeBlobPath(native: WindowsServerNativePort, dir: string, workspaceId: string, sha256Hex: string): string {
  return native.join(
    native.join(native.join(dir, "blobs"), createHash("sha256").update(workspaceId).digest("hex")),
    sha256Hex,
  );
}

function nativeDatabase<T>(
  native: WindowsServerNativePort,
  path: string,
  readOnly: boolean,
  work: (db: DatabaseSync) => T,
): T {
  const lease = native.acquireSqliteLease(path);
  let db: DatabaseSync;
  try { db = new DatabaseSync(path, { readOnly }); }
  catch (error) { return native.retainUnknown(lease, error); }
  const close = onceNativeServerClose(native, () => db.close());
  let primary: NativeServerFailure | undefined;
  let result!: T;
  try { lease.assertHeld(); result = work(db); lease.assertHeld(); }
  catch (error) { primary = { error }; }
  closeNativeServerResources(native, [close, () => lease.close()], primary);
  return result;
}

function existingNative(native: WindowsServerNativePort, directory: string, recover = false) {
  const dir = native.canonical(directory);
  const root = native.inspectDirectory(dir);
  requireCondition(native.kindOf(native.join(dir, SERVER_FULL_MARKER)) === "absent", "server-full-incomplete", 409);
  const config = readServerOpsConfig(dir);
  const path = native.join(dir, "server.sqlite");
  // K hash inspection of the main database only while it is closed.
  inspectVerifiedServerFile(path, undefined, 256 * 1024 * 1024);
  const { journal } = nativeSidecars(native, path);
  const before = native.inspectFileIdentity(path);
  if (!recover) requireCondition(journal === null || journal.bytes === 0, "server-recovery-required", 409);
  try {
    nativeDatabase(native, path, true, (db) => {
      db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0");
      db.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
      const inventory = inspectServerHistory(db);
      requireCondition(
        inventory.workspaces.length === 1 && inventory.workspaces[0].workspaceId === config.workspaceId &&
          inventory.workspaces[0].ownerId === config.ownerId,
        "server-config-invalid",
        409,
      );
      for (const asset of inventory.assets)
        inspectVerifiedServerFile(nativeBlobPath(native, dir, asset.workspaceId, asset.sha256), asset);
    });
  } catch (error) {
    // Only SQLITE_READONLY_ROLLBACK may defer semantic inspection to the
    // host's H-backed disposable-copy preflight. Never recover the original
    // here, before the host has established its role and workspace binding.
    if (!recover || error === null || typeof error !== "object" ||
        (error as { errcode?: unknown }).errcode !== 776) throw error;
    if (native.lifecycleHost === undefined) nativeUnsafe();
  }
  native.assertFileIdentity(path, before);
  native.assertDirectory(dir, root);
  return { dir, root, config };
}

type NativeServerScope = {
  server: CheckpointServerHandle;
  mainLease: PrivateAuthorityLease;
};

function checkHostHandle(value: unknown): asserts value is CheckpointServerHandle {
  const handle = value as CheckpointServerHandle | null | undefined;
  requireCondition(
    handle != null && typeof handle === "object" &&
      typeof handle.url === "string" && handle.url.length > 0 &&
      typeof handle.serverEpoch === "string" &&
      typeof handle.registerDevice === "function" &&
      typeof handle.revokeDevice === "function" &&
      typeof handle.backup === "function" &&
      typeof handle.close === "function",
    "server-native-unsafe",
    409,
  );
  identifier(handle.serverEpoch);
  for (const fn of [handle.registerDevice, handle.revokeDevice, handle.backup])
    if (utilTypes.isAsyncFunction(fn) || utilTypes.isGeneratorFunction(fn)) nativeUnsafe();
  if (utilTypes.isGeneratorFunction(handle.close)) nativeUnsafe();
}

function onceAsyncNativeClose(native: WindowsServerNativePort, parts: readonly (() => void | Promise<void>)[]): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => pending ??= (async () => {
    for (const part of parts) {
      try { if (await part() !== undefined) nativeUnsafe(); }
      catch (error) { native.retainUnknown(parts, error); }
    }
  })();
}

function guardNativeHandle(native: WindowsServerNativePort, server: CheckpointServerHandle, fence: () => void): CheckpointServerHandle {
  const register = server.registerDevice.bind(server);
  const revoke = server.revokeDevice.bind(server);
  const backup = server.backup.bind(server);
  const close = server.close.bind(server);
  const mutate = <T>(work: () => T, validate: (value: T) => void): T => {
    fence();
    try {
      const value = work();
      if (utilTypes.isPromise(value)) Promise.prototype.then.call(value, undefined, () => undefined);
      if (value != null && typeof (value as {then?: unknown}).then === "function") nativeUnsafe();
      validate(value);
      fence();
      return value;
    } catch (error) { return native.poison(error); }
  };
  const exactVoid = (value: unknown) => { if (value !== undefined) nativeUnsafe(); };
  return {
    url: server.url,
    serverEpoch: server.serverEpoch,
    registerDevice(registration) { mutate(() => register(registration), exactVoid); },
    revokeDevice(workspaceId, clientId) { mutate(() => revoke(workspaceId, clientId), exactVoid); },
    backup(destination) {
      return mutate(() => backup(destination), (value) => {
        if (value == null || typeof value !== "object" || typeof value.destination !== "string" ||
            value.manifest?.format !== "folio-checkpoint-server-backup") nativeUnsafe();
      });
    },
    close: onceAsyncNativeClose(native, [async () => { exactVoid(await close()); }]),
  };
}

/** Start the injected native lifecycle host under a held C lease on the
 * main database. The host is REQUIRED parent glue — it owns the real
 * checkpoint server, its native blob adapter, live SQLite protection and
 * the request/current-auth fences. There is no POSIX fallback here. */
async function nativeStart(
  native: WindowsServerNativePort,
  dir: string,
  config: ServerOpsConfig,
  port: number,
  lease: ServerDirectoryLease,
): Promise<NativeServerScope> {
  const host = native.lifecycleHost;
  if (host === undefined) nativeUnsafe();
  const databasePath = native.join(dir, "server.sqlite");
  const mainLease = native.acquireSqliteLease(databasePath);
  let started: unknown;
  try {
    mainLease.assertHeld();
    const fence = () => {
      lease.assertOwned();
      mainLease.assertHeld();
      native.assertCurrent();
    };
    started = await host.start({
      directory: dir,
      databasePath,
      workspaces: [{ workspaceId: config.workspaceId, ownerId: config.ownerId }],
      port,
      assertCurrent() {
        fence();
      },
    });
    checkHostHandle(started);
    fence();
    return { server: guardNativeHandle(native, started, fence), mainLease };
  } catch (error) {
    const handle = started as Partial<CheckpointServerHandle> | undefined;
    if (handle == null || typeof handle.close !== "function" || utilTypes.isGeneratorFunction(handle.close))
      return native.retainUnknown({ mainLease, lease, started, host }, error);
    try {
      const result: unknown = await handle.close();
      if (result !== undefined) nativeUnsafe();
      mainLease.close();
    } catch (closeError) {
      return native.retainUnknown({ mainLease, lease, started },
        new AggregateError([error, closeError], "server start and lease close failed"));
    }
    throw error;
  }
}

async function closeAll(native: WindowsServerNativePort, parts: readonly (() => void | Promise<void>)[], primary?: NativeServerFailure): Promise<void> {
  for (const part of parts) {
    try {
      if (await part() !== undefined) nativeUnsafe();
    } catch (error) {
      native.retainUnknown(parts, primary === undefined ? error :
        new AggregateError([primary.error, error], "server operation and close failed"));
    }
  }
  if (primary !== undefined) throw primary.error;
}

async function administerNative<T>(
  native: WindowsServerNativePort,
  directory: string,
  work: (server: CheckpointServerHandle, config: ServerOpsConfig, lease: ServerDirectoryLease) => Promise<T> | T,
): Promise<T> {
  const lease = acquireServerDirectoryLease(directory);
  let scope: NativeServerScope | undefined;
  let primary: NativeServerFailure | undefined;
  try {
    const { dir, config } = existingNative(native, directory, true);
    scope = await nativeStart(native, dir, config, 0, lease);
    const result = await work(scope.server, config, lease);
    lease.assertOwned();
    return result;
  } catch (error) {
    primary = { error };
    throw error;
  } finally {
    await closeAll(native, [
      async () => { await scope?.server.close(); },
      () => { scope?.mainLease.close(); },
      () => { lease.close(); },
    ], primary);
  }
}
async function initializeNative(native: WindowsServerNativePort, directory: string, config: ServerOpsConfig): Promise<{directory: string; serverEpoch: string}> {
  const requested = native.canonical(directory);
  const parent = native.parent(requested);
  const parentId = native.inspectDirectory(parent);
  requireCondition(native.kindOf(requested) === "absent", "server-destination-exists", 409);
  // Exclusive directory create through the parent-supplied K callback;
  // there is no mkdir on this branch.
  const rootId = native.createDirectory(requested);
  const markerPath = native.join(requested, SERVER_FULL_MARKER);
  const marker = native.writeNewFile(
    markerPath,
    Buffer.from("Incomplete Folio server initialization\n", "utf8"),
    4096,
  );
  const lease = acquireServerDirectoryLease(requested);
  let scope: NativeServerScope | undefined;
  let primary: NativeServerFailure | undefined;
  try {
    writeServerOpsConfig(requested, config);
    // Exclusive empty database file; the injected host opens it writable
    // inside the held C lease its assertCurrent fence re-proves.
    native.writeNewFile(native.join(requested, "server.sqlite"), new Uint8Array(0), 1024);
    scope = await nativeStart(native, requested, config, 0, lease);
    const epoch = scope.server.serverEpoch;
    await scope.server.close();
    scope.mainLease.close();
    scope = undefined;
    lease.assertOwned();
    native.assertDirectory(requested, rootId);
    // Exact held marker unlink only after its identity is re-proven.
    const current = native.inspectFile(markerPath, 4096);
    requireCondition(
      native.sameIdentity(current, marker) && current.bytes === marker.bytes && current.sha256 === marker.sha256,
      "server-full-incomplete",
      409,
    );
    native.unlinkExact(markerPath, current);
    native.assertDirectory(parent, parentId);
    return { directory: requested, serverEpoch: epoch };
  } catch (error) {
    primary = { error };
    throw error;
  } finally {
    const saved = scope;
    await closeAll(native, [
      async () => { await saved?.server.close(); },
      () => { saved?.mainLease.close(); },
      () => { lease.close(); },
    ], primary);
  }
}

export async function initializeOperationalServer(directory: string, config: ServerOpsConfig): Promise<{directory: string; serverEpoch: string}> {
  const native = windowsServerNative();
  if (native !== undefined) return initializeNative(native, directory, config);
  if (process.platform === "win32") nativeUnsafe();
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
  const native = windowsServerNative();
  if (native !== undefined) {
    const lease = acquireServerDirectoryLease(directory);
    let scope: NativeServerScope | undefined;
    try {
      const { dir, config } = existingNative(native, directory, true);
      scope = await nativeStart(native, dir, config, config.port, lease);
      lease.assertOwned();
      const { server, mainLease } = scope;
      scope = undefined;
      // The full guarded handle; the main C lease and the directory lease
      // stay held through the live host close.
      return {
        ...server,
        close: onceAsyncNativeClose(native, [
            async () => { await server.close(); },
            () => { mainLease.close(); },
            () => { lease.close(); },
          ]),
      };
    } catch (error) {
      const saved = scope;
      await closeAll(native, [
        async () => { await saved?.server.close(); },
        () => { saved?.mainLease.close(); },
        () => { lease.close(); },
      ], { error });
      throw error;
    }
  }
  if (process.platform === "win32") nativeUnsafe();
  const lease = acquireServerDirectoryLease(directory);
  try {
    const {root, config} = existing(directory, true), server = await raw(root.path, config, config.port);
    lease.assertOwned();
    return {...server, close: async () => {try {await server.close();} finally {lease.close();}}};
  } catch (error) {lease.close(); throw error;}
}
/** All offline administration uses the same lease as serving and backup. */
export async function administerOperationalServer<T>(directory: string,
  work: (server: CheckpointServerHandle, config: ServerOpsConfig, lease: ServerDirectoryLease) => Promise<T> | T): Promise<T> {
  const native = windowsServerNative();
  if (native !== undefined) return administerNative(native, directory, work);
  if (process.platform === "win32") nativeUnsafe();
  const lease = acquireServerDirectoryLease(directory);
  let server: CheckpointServerHandle | undefined;
  try {
    const {root, config} = existing(directory, true); server = await raw(root.path, config, 0);
    const result = await work(server, config, lease); lease.assertOwned(); return result;
  } finally {try {await server?.close();} finally {lease.close();}}
}
export async function issueOperationalCredential(options: {directory: string; clientId: string; credentialFile: string; reuse?: boolean}): Promise<{clientId: string; baseUrl: string}> {
  const native = windowsServerNative();
  if (native !== undefined) {
    identifier(options.clientId);
    return administerOperationalServer(options.directory, (server, config) => {
      const baseUrl = `http://127.0.0.1:${config.port}`;
      const credential = options.reuse ? readIssuedSyncCredential(options.credentialFile) :
        {format: "folio-sync-credential/v1" as const, baseUrl, workspaceId: config.workspaceId, clientId: options.clientId,
          token: randomBytes(32).toString("base64url")};
      requireCondition(credential.baseUrl === baseUrl && credential.workspaceId === config.workspaceId && credential.clientId === options.clientId,
        "server-credential-mismatch", 409);
      const databasePath = native.join(native.canonical(options.directory), "server.sqlite");
      nativeDatabase(native, databasePath, true, (db) => {
        const prior = db.prepare("SELECT revoked,token_hash FROM checkpoint_devices WHERE workspace_id=? AND client_id=?").get(config.workspaceId, options.clientId);
        requireCondition(!prior || prior.revoked === 0, "device-revoked", 409);
        // Reconcile a lost issue acknowledgement, never roll a later rotation
        // back to an older handoff file's secret.
        if (options.reuse && prior) requireCondition(prior.token_hash === createHash("sha256").update(credential.token).digest("hex"), "server-credential-stale", 409);
      });
      // Durable private handoff precedes registration, so a response loss can
      // be reconciled with --reuse-credential without issuing a second secret.
      if (!options.reuse) writeIssuedSyncCredential(options.credentialFile, credential, [native.canonical(options.directory)]);
      server.registerDevice({workspaceId: config.workspaceId, ownerId: config.ownerId, clientId: credential.clientId, token: credential.token});
      return {clientId: credential.clientId, baseUrl};
    });
  }
  if (process.platform === "win32") nativeUnsafe();
  identifier(options.clientId);
  return administerOperationalServer(options.directory, (server, config) => {
    const baseUrl = `http://127.0.0.1:${config.port}`;
    const credential = options.reuse ? readIssuedSyncCredential(options.credentialFile) :
      {format: "folio-sync-credential/v1" as const, baseUrl, workspaceId: config.workspaceId, clientId: options.clientId,
        token: randomBytes(32).toString("base64url")};
    requireCondition(credential.baseUrl === baseUrl && credential.workspaceId === config.workspaceId && credential.clientId === options.clientId,
      "server-credential-mismatch", 409);
    const db = new DatabaseSync(join(realpathSync(options.directory), "server.sqlite"), {readOnly: true});
    try {
      const prior = db.prepare("SELECT revoked,token_hash FROM checkpoint_devices WHERE workspace_id=? AND client_id=?").get(config.workspaceId, options.clientId);
      requireCondition(!prior || prior.revoked === 0, "device-revoked", 409);
      // Reconcile a lost issue acknowledgement, never roll a later rotation
      // back to an older handoff file's secret.
      if (options.reuse && prior) requireCondition(prior.token_hash === createHash("sha256").update(credential.token).digest("hex"), "server-credential-stale", 409);
    } finally {db.close();}
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
  const native = windowsServerNative();
  if (native !== undefined) {
    const lease = acquireServerDirectoryLease(directory);
    let primary: NativeServerFailure | undefined;
    try {
      const { dir } = existingNative(native, directory, false);
      const path = native.join(dir, "server.sqlite");
      let history, devices, serverEpoch;
      nativeDatabase(native, path, true, (db) => {
          history = inspectSyncRetention(db, "server");
          devices = Number(db.prepare("SELECT COUNT(*) AS n FROM checkpoint_devices").get()!.n);
          serverEpoch = String(db.prepare("SELECT epoch FROM checkpoint_server_identity WHERE singleton=1").get()!.epoch);
      });
      let blobs = null, held: string | null = null;
      try {
        blobs = inspectServerBlobRetention(native.join(dir, "blobs"));
      } catch {
        held = "server-blob-retention-unknown";
      }
      lease.assertOwned();
      return { serverEpoch, history, devices, maxDevices: 512, blobs, held };
    } catch (error) {
      primary = { error };
      throw error;
    } finally {
      closeNativeServerResources(native, [() => lease.close()], primary);
    }
  }
  if (process.platform === "win32") nativeUnsafe();
  const lease = acquireServerDirectoryLease(directory);
  try {
    const {root} = existing(directory), path = join(root.path, "server.sqlite");
    const db = new DatabaseSync(path, {readOnly: true});
    let history, devices, serverEpoch;
    try {
      history = inspectSyncRetention(db, "server");
      devices = Number(db.prepare("SELECT COUNT(*) AS n FROM checkpoint_devices").get()!.n);
      serverEpoch = String(db.prepare("SELECT epoch FROM checkpoint_server_identity WHERE singleton=1").get()!.epoch);
    } finally {db.close();}
    let blobs = null, held: string | null = null;
    try {blobs = inspectServerBlobRetention(join(root.path, "blobs"));} catch {held = "server-blob-retention-unknown";}
    lease.assertOwned();
    return {serverEpoch, history, devices, maxDevices: 512, blobs, held};
  } finally {lease.close();}
}
