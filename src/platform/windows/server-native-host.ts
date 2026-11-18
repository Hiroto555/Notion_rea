import {assertNativeServerHandoffAncestors} from "../../sync/server-ops-config";
import { lstatSync } from "node:fs";
import { win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import { startCheckpointServer } from "../../sync/checkpoint-server";
import type { PrivatePlatform } from "../../sync/private-platform";
import { WindowsPrivatePlatform } from "../../sync/private-platform";
import { validateWorkspaceCheckpoint } from "../../sync/workspace-checkpoint";
import { WorkspaceBlobStore } from "../../sync/workspace-blobs";
import { canonicalJson, parseCheckpoint, requireCondition, SyncError } from "../../sync/protocol";
import { inspectServerHistory } from "../../sync/server-history-validation";
import { inspectSyncRetention } from "../../sync/sync-retention";
import {
  assertServerBackupCapacity,
  CHECKPOINT_SERVER_BACKUP_DATABASE,
  CHECKPOINT_SERVER_BACKUP_FORMAT,
  CHECKPOINT_SERVER_BACKUP_MANIFEST,
  CHECKPOINT_SERVER_BACKUP_MARKER,
  CHECKPOINT_SERVER_BACKUP_MAX_MANIFEST_BYTES,
  CHECKPOINT_SERVER_BACKUP_VERSION,
  type CheckpointServerBackup,
  type CheckpointServerBackupManifest,
} from "../../sync/server-backup";
import {
  withPrivatePersistence,
  type NativePrivateFilesystemPort,
  type NativePrivateIdentity,
} from "../private-persistence";
import { withProductPrivateJournals } from "../product-private-journals";
import {
  createNativeAuthorityLeaseAcquirer,
  withPrivateAuthorityLease,
} from "./authority-lease";
import { createWindowsProductNative } from "./product-native";
import { windowsOperatorConfigFromEnvironment, type WindowsOperatorConfig } from "./operator-native";
import { createWindowsSourceBindingGuard } from "./source-binding-guard";
import {
  WindowsRuntimePlatform,
  type WindowsRuntimePreparedDirectory,
  type WindowsRuntimeRootIdentity,
} from "./runtime-platform";
import { asciiCaseFold, validateWindowsPath } from "./path-policy";
import {
  createWindowsServerNative,
  closeNativeServerResources,
  onceNativeServerClose,
  withWindowsServerNative,
  type WindowsServerLifecycleHost,
  type WindowsServerNativePort,
} from "./server-native";
import {
  nativeTransferPort,
  requireNativeAppend,
  withNativeTransfer,
  type NativeTransferOptions,
} from "./private-transfer";

const DB_MAX_BYTES = 256 * 1024 * 1024;
const same = (a: string, b: string): boolean => asciiCaseFold(a) === asciiCaseFold(b);
const sameIdentity = (a: NativePrivateIdentity, b: NativePrivateIdentity): boolean =>
  same(a.path, b.path) && same(a.fileId, b.fileId) && same(a.volumeId, b.volumeId);

function fail(): never { throw new SyncError("server-native-host-unsafe", 503); }
function exactVoid(work: () => unknown): void {
  if (types.isAsyncFunction(work) || types.isGeneratorFunction(work)) fail();
  const result = work();
  if (types.isPromise(result)) void Promise.prototype.then.call(result, undefined, () => undefined);
  if (result !== undefined) fail();
}
function finish(errors: unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}
function closeAfter<T>(resource: { close(): void }, work: () => T): T {
  let value!: T;
  const errors: unknown[] = [];
  try { value = work(); } catch (error) { errors.push(error); }
  try { resource.close(); } catch (error) { errors.push(error); }
  finish(errors, "Native source proof and close failed");
  return value;
}

/** Metadata-only root proof must permit the configured root itself. No K root
 * request, cached configuration, uid, inode, or PID can supply this proof. */
function freshWindowsRuntimePlatform(
  config: WindowsOperatorConfig,
  root: string,
  directory: string,
  databaseName = "server.sqlite",
): WindowsRuntimePlatform {
  const runtime = new WindowsRuntimePlatform({
    root, probeExecutable: config.probeExecutable, expectedHash: config.expectedHash,
    systemRoot: config.systemRoot, databaseName,
  });
  try { runtime.bind(directory); return runtime; }
  catch (error) {
    try { runtime.close(); } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Native root bind and close failed");
    }
    throw error;
  }
}

/** Catalog snapshot uses the same native publication family as full backup.
 * All incomplete output and raw authority evidence remain on any uncertainty. */
export function createWindowsServerCatalogBackup(
  native: WindowsServerNativePort,
  db: DatabaseSync,
  databasePath: string,
  destination: string,
  epoch: string,
  validateCurrent: () => void,
): CheckpointServerBackup {
  validateCurrent();
  requireCondition(!db.isTransaction, "server-backup-busy", 409);
  const source = native.canonical(databasePath);
  const sourceId = native.inspectFileIdentity(source);
  const main = db.prepare("PRAGMA database_list").all().find(row => row.name === "main");
  requireCondition(typeof main?.file === "string" && native.samePath(main.file, source),
    "unsafe-backup-source", 409);
  const target = native.canonical(destination);
  requireCondition(!native.overlaps(target, native.parent(source)) &&
    native.kindOf(target) === "absent", "backup-destination-exists", 409);
  assertNativeServerHandoffAncestors(native, target);
  const parent = native.parent(target);
  const parentId = native.inspectDirectory(parent);
  assertServerBackupCapacity(db, [native.parent(source), parent]);
  native.assertCapacity(parent, DB_MAX_BYTES);
  const before = inspectServerHistory(db);
  inspectSyncRetention(db, "server");
  requireCondition(before.serverEpoch === epoch, "server-backup-epoch-mismatch", 409);
  const targetId = native.createDirectory(target);
  const markerPath = native.join(target, CHECKPOINT_SERVER_BACKUP_MARKER);
  const marker = native.writeNewFile(markerPath, Buffer.from("Incomplete Folio catalog backup\n"), 4096);
  const snapshotPath = native.join(target, CHECKPOINT_SERVER_BACKUP_DATABASE);
  validateCurrent();
  const receipt = native.snapshotSqlite(db, snapshotPath);
  native.assertFileIdentity(source, sourceId);
  const snapshotLease = native.acquireSqliteLease(snapshotPath);
  let snapshot: DatabaseSync | undefined;
  const errors: unknown[] = [];
  let headAssetReferences = 0;
  try {
    snapshotLease.assertHeld();
    native.assertFileIdentity(snapshotPath, receipt.identity);
    snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    snapshot.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0");
    const integrity = snapshot.prepare("PRAGMA integrity_check").all();
    requireCondition(integrity.length === 1 && Object.values(integrity[0])[0] === "ok",
      "server-backup-verification-failed", 422);
    const copied = inspectServerHistory(snapshot);
    inspectSyncRetention(snapshot, "server");
    requireCondition(canonicalJson(copied) === canonicalJson(before) &&
      canonicalJson(inspectServerHistory(db)) === canonicalJson(before),
    "server-backup-changed-during-backup", 409);
    for (const row of snapshot.prepare("SELECT checkpoint_json FROM checkpoint_heads").all())
      if (row.checkpoint_json !== null)
        headAssetReferences += parseCheckpoint(JSON.parse(String(row.checkpoint_json))).assets.length;
    validateCurrent();
    snapshotLease.assertHeld();
    native.assertFileIdentity(snapshotPath, receipt.identity);
  } catch (error) { errors.push(error); }
  const primary = errors.length ? { error: errors.length === 1 ? errors[0] :
    new AggregateError(errors, "Native catalog snapshot inspection failed") } : undefined;
  closeNativeServerResources(native, [
    onceNativeServerClose(native, () => { snapshot?.close(); }),
    () => snapshotLease.close(),
  ], primary);
  const verified = native.inspectFile(snapshotPath, DB_MAX_BYTES);
  requireCondition(sameIdentity(verified, receipt.identity) &&
    verified.bytes === receipt.identity.bytes && verified.sha256 === receipt.identity.sha256,
  "server-backup-verification-failed", 422);
  const manifest: CheckpointServerBackupManifest = {
    format: CHECKPOINT_SERVER_BACKUP_FORMAT, version: CHECKPOINT_SERVER_BACKUP_VERSION,
    createdAt: new Date().toISOString(), serverEpoch: epoch, scope: "catalog",
    database: { path: CHECKPOINT_SERVER_BACKUP_DATABASE, bytes: verified.bytes, sha256: verified.sha256 },
    counts: {
      workspaces: before.workspaces.length, changes: before.changes, operations: before.operations,
      devices: before.devices, activeDevices: before.activeDevices, revokedDevices: before.revokedDevices,
    },
    workspaces: before.workspaces.map(({ workspaceId, revision, checkpointHash }) =>
      ({ workspaceId, revision, checkpointHash })),
    attachments: { included: false, headAssetReferences },
  };
  native.writeNewFile(native.join(target, CHECKPOINT_SERVER_BACKUP_MANIFEST),
    Buffer.from(JSON.stringify(manifest, null, 2)), CHECKPOINT_SERVER_BACKUP_MAX_MANIFEST_BYTES);
  validateCurrent();
  native.assertDirectory(target, targetId);
  native.assertDirectory(parent, parentId);
  native.assertFileIdentity(source, sourceId);
  native.proveSyncFile(snapshotPath, verified);
  native.unlinkExact(markerPath, marker);
  validateCurrent();
  return { destination: target, manifest };
}

export type WindowsServerLifecycleOptions = Readonly<{
  native(): WindowsServerNativePort;
  filesystem: NativePrivateFilesystemPort;
  transfer(): NativeTransferOptions;
  /** Production passes an original C-branded, native runtime-backed platform.
   * Contract drivers on non-Windows are explicitly untrusted. */
  sqlitePlatform(directory: string): PrivatePlatform;
  scope<T>(work: () => T): T;
  opened(): void;
  closed(): void;
}>;

/** The production factory and contract tests use the REAL Node HTTP/SQLite
 * server; there is no substitute request handler on this path. */
export function createWindowsServerLifecycleHost(
  options: WindowsServerLifecycleOptions,
): WindowsServerLifecycleHost {
  return Object.freeze({
    async start(request: Parameters<WindowsServerLifecycleHost["start"]>[0]) {
      return options.scope(async () => {
        const native = options.native();
        request.assertCurrent();
        const transfer = options.transfer();
        const selected = nativeTransferPort(transfer);
        requireCondition(selected !== undefined, "native-transfer-port-invalid", 503);
        requireNativeAppend(selected);
        const rootId = native.inspectDirectory(request.directory);
        const fileId = native.inspectFileIdentity(request.databasePath);
        const platform = options.sqlitePlatform(request.directory);
        let registered = false;
        let platformClosed = false, closeCompleted = false;
        let notificationAttempted = false, notificationFailed = false;
        let notificationFailure: unknown;
        let handedOff = false;
        const validateCurrent = () => {
          request.assertCurrent();
          native.assertCurrent();
          native.assertDirectory(request.directory, rootId);
          native.assertFileIdentity(request.databasePath, fileId);
        };
        const scoped = <T>(work: () => T): T => options.scope(() =>
          withNativeTransfer(transfer, work));
        const close = () => {
          if (closeCompleted) return;
          // Decrement only after confirmed handle closure; UNKNOWN keeps the
          // factory live and prevents destruction of supporting authorities.
          if (!platformClosed) {platform.close(); platformClosed = true;}
          if (registered) {
            if (notificationFailed) throw notificationFailure;
            if (!notificationAttempted) {
              notificationAttempted = true;
              try {options.closed(); registered = false;}
              catch (error) {notificationFailed = true; notificationFailure = error; throw error;}
            }
          }
          closeCompleted = true;
        };
        try {
          platform.bind(request.directory);
          options.opened();
          registered = true;
          const blobs = new WorkspaceBlobStore(native.join(request.directory, "blobs"), undefined, transfer);
          handedOff = true;
          return await scoped(() => startCheckpointServer({
            databasePath: request.databasePath, capabilities: [],
            workspaces: request.workspaces.map(workspace => ({ ...workspace })),
            validateCheckpoint: validateWorkspaceCheckpoint,
            blobs,
            port: request.port,
            nativePrivateFilesystem: options.filesystem,
            nativeLifetime: {
              platform, validateCurrent, scope: scoped, close,
              backup: (db, destination, epoch) =>
                createWindowsServerCatalogBackup(native, db, request.databasePath, destination, epoch, validateCurrent),
            },
          }));
        } catch (error) {
          if (!handedOff) {
            try { close(); } catch (cleanup) {
              throw new AggregateError([error, cleanup], "Native lifecycle startup and close failed");
            }
          }
          throw error;
        }
      });
    },
  });
}

export type WindowsServerNativeFactory = Readonly<{
  native: WindowsServerNativePort;
  scope<T>(work: () => T): T;
  close(): void;
}>;

/** Trusted explicit CLI configuration selects this factory only on win32.
 * Configuration chooses names; fresh native proofs and retained bindings
 * authorize every actual source. Importing this module performs no IO. */
export function createWindowsServerNativeFromEnvironment(
  env: NodeJS.ProcessEnv,
  options: Readonly<{ enrollExistingSources?: boolean; assertCurrent?: () => void }> = {},
): WindowsServerNativeFactory | undefined {
  const config = windowsOperatorConfigFromEnvironment(env);
  if (process.platform !== "win32") {
    requireCondition(config === undefined, "server-native-platform-mismatch", 503);
    return undefined;
  }
  requireCondition(config !== undefined, "server-native-configuration-required", 503);
  const enroll = options.enrollExistingSources === true;
  const currentCheck = options.assertCurrent;
  if (currentCheck !== undefined)
    requireCondition(typeof currentCheck === "function" && !types.isAsyncFunction(currentCheck) &&
      !types.isGeneratorFunction(currentCheck), "server-native-current-invalid", 503);
  const canonical = (path: string, root: string): string => {
    requireCondition(/^[A-Z]:\\[\x20-\x7e]+$/.test(path) && path.length <= 240 &&
      validateWindowsPath(path, root).canonical === path, "server-native-path", 409);
    return path;
  };
  const root = canonical(config.root, config.root);
  const stateRoot = canonical(config.publicationStateRoot, config.publicationStateRoot);
  const stateDirectory = canonical(config.publicationStateDirectory, stateRoot);
  const overlaps = (a: string, b: string): boolean => {
    const x = asciiCaseFold(a).replace(/\\$/, ""), y = asciiCaseFold(b).replace(/\\$/, "");
    return x === y || x.startsWith(y + "\\") || y.startsWith(x + "\\");
  };
  requireCondition(!overlaps(root, stateRoot), "server-native-state-overlap", 409);
  let closed = false;
  let failure: unknown;
  let poisoned = false;
  let liveHosts = 0;
  const current = (): void => {
    if (poisoned) throw failure;
    if (closed) fail();
    if (currentCheck !== undefined) exactVoid(currentCheck);
  };
  const poison = (error: unknown): never => {
    if (!poisoned) { poisoned = true; failure = error; }
    throw error;
  };
  const sourceBindings = createWindowsSourceBindingGuard(config, enroll);
  let product: ReturnType<typeof createWindowsProductNative> | undefined;
  let native!: WindowsServerNativePort;
  let transferOptions: NativeTransferOptions | undefined;
  try {
  product = createWindowsProductNative(config, {
    enrollExistingSources: enroll, assertCurrent: current,
  });
  const filesystem = product.privateFilesystem;
  const pinnedRoots = new Map<string, WindowsRuntimeRootIdentity>();
  const directoryProof = (under: string, path: string): WindowsRuntimePreparedDirectory => {
    current();
    const runtime = freshWindowsRuntimePlatform(config, under, path);
    return closeAfter(runtime, () => {
      const id = runtime.validatedDirectoryIdentity();
      const known = pinnedRoots.get(under);
      requireCondition(known === undefined || same(known.rootFileId, id.rootFileId) &&
        same(known.volumeId, id.rootVolumeId), "server-native-root-changed", 503);
      pinnedRoots.set(under, { rootFileId: id.rootFileId, volumeId: id.rootVolumeId });
      return id;
    });
  };
  const sourceDirectory = (path: string, newlyCreated = false): WindowsRuntimePreparedDirectory => {
    const id = directoryProof(root, canonical(path, root));
    sourceBindings.directory(id, newlyCreated);
    return id;
  };
  const fileProof = (under: string, path: string) => {
    const runtime = freshWindowsRuntimePlatform(config, under, win32.dirname(path));
    return closeAfter(runtime, () => {
      const parent = runtime.validatedDirectoryIdentity();
      const expected = pinnedRoots.get(under);
      requireCondition(expected !== undefined && same(expected.rootFileId, parent.rootFileId) &&
        same(expected.volumeId, parent.rootVolumeId), "server-native-root-changed", 503);
      return runtime.validatedPrivateFileIdentity(path);
    });
  };
  const bindIdentity = (identity: NativePrivateIdentity, newlyCreated: boolean): void => {
    current();
    const path = canonical(identity.path, root);
    const hint = lstatSync(path); // selects native proof kind; never identity
    let proof: NativePrivateIdentity;
    if (hint.isDirectory() && !hint.isSymbolicLink()) {
      const id = directoryProof(root, path);
      proof = { path: id.canonicalPath, fileId: id.directoryFileId, volumeId: id.directoryVolumeId };
      requireCondition(sameIdentity(identity, proof), "server-native-identity-changed", 503);
      sourceBindings.directory(id, newlyCreated);
    } else {
      requireCondition(hint.isFile() && !hint.isSymbolicLink(), "server-native-source-kind", 409);
      sourceDirectory(win32.dirname(path));
      const id = fileProof(root, path);
      proof = { path: id.canonicalPath, fileId: id.fileId, volumeId: id.volumeId };
      requireCondition(sameIdentity(identity, proof), "server-native-identity-changed", 503);
      sourceBindings.file(id, newlyCreated);
    }
    current();
  };
  const rootProof = (): NativePrivateIdentity => {
    const proof = sourceDirectory(root);
    return { path: root, fileId: proof.rootFileId, volumeId: proof.rootVolumeId };
  };
  const sourceRoot = rootProof();
  // Preserve the ORIGINAL function identity minted by C. Root IDs are the
  // SOURCE root's IDs, never the separate state authority's IDs or zeros.
  const acquireSource = createNativeAuthorityLeaseAcquirer({
    ...config, root, expectedRoot: { rootFileId: sourceRoot.fileId, volumeId: sourceRoot.volumeId },
    identityFor(path) {
      current();
      const directory = sourceDirectory(win32.dirname(path));
      const file = fileProof(root, canonical(path, root));
      sourceBindings.file(file);
      return {
        directoryFileId: directory.directoryFileId, directoryVolumeId: directory.directoryVolumeId,
        fileId: file.fileId, volumeId: file.volumeId,
      };
    },
  });
  const sqlitePlatform = (under: string, databaseName: string, source: boolean): PrivatePlatform => {
    const base = new WindowsPrivatePlatform(new WindowsRuntimePlatform({
      root: under, probeExecutable: config.probeExecutable, expectedHash: config.expectedHash,
      systemRoot: config.systemRoot, databaseName, snapshotProfile: "recovery-archive",
    }));
    requireCondition(source && under === root, "server-native-source-root-required", 503);
    const sourcePlatform: PrivatePlatform = {
      kind: "windows",
      bind(directory) {
        native.inspectDirectory(directory);
        return base.bind(directory);
      },
      assertRoot() { base.assertRoot(); },
      assertFile(path) { base.assertFile(path); },
      assertSidecars(path) { base.assertSidecars(path); },
      createExclusive(path) {
        const kind = native.kindOf(path);
        if (kind === "absent") native.writeNewFile(path, new Uint8Array(), 1024);
        else requireCondition(kind === "file", "server-native-source-kind", 409);
        // K's confirmed create records the source binding. Do not issue a
        // second create-or-open if the name vanishes between these proofs.
        base.assertFile(path);
        base.assertSidecars(path);
      },
      assertEmptyFile(path) { base.assertEmptyFile(path); },
      close() { base.close(); },
      ...(base.withHotJournalSnapshot === undefined ? {} : {
        withHotJournalSnapshot: (path: string, callback: (snapshot: string) => void) =>
          base.withHotJournalSnapshot!(path, callback),
      }),
    };
    return withPrivateAuthorityLease(sourcePlatform, acquireSource);
  };
  const scope = <T>(work: () => T): T => withWindowsServerNative(native, () =>
    withPrivatePersistence({ nativePrivateFilesystem: filesystem }, () =>
      withNativeTransfer(transferOptions, () =>
        withProductPrivateJournals({
          // Each B2 lock/outcome ledger gets its exact native basename, K
          // creation receipt, original C lease and H hot-snapshot capability.
          privatePlatformFactory: (_directory, name) => sqlitePlatform(root, name, true),
        }, work))));
  const transfer = (): NativeTransferOptions => {
    if (transferOptions !== undefined) return transferOptions;
    current();
    try {
    // The product factory owns a distinct APPEND-v1 journal. Reusing K's
    // v4 filesystem journal cannot validate an append wire after restart.
    transferOptions = {...product!.nativeTransfer, privateJournals: {
      privatePlatformFactory: (_directory, name) => sqlitePlatform(root, name, true),
    }};
    return transferOptions;
    } catch (error) { return poison(error); }
  };
  const host = createWindowsServerLifecycleHost({
    native: () => native, filesystem, transfer,
    sqlitePlatform: () => sqlitePlatform(root, "server.sqlite", true),
    scope,
    opened() { current(); liveHosts++; },
    closed() { liveHosts--; },
  });
    native = createWindowsServerNative({
      root, nativePrivateFilesystem: filesystem,
      acquireSqliteLease: acquireSource, assertCurrent: current,
      assertSourceIdentity: identity => bindIdentity(identity, false),
      recordCreatedIdentity: identity => {
        try { bindIdentity(identity, true); } catch (error) { poison(error); }
      },
      inspectRoot: rootProof, lifecycleHost: host,
    });
  let closeAttempted = false;
  return Object.freeze({
    native, scope,
    close() {
      if (closed) return;
      if (closeAttempted) throw failure;
      requireCondition(liveHosts === 0, "server-native-host-still-open", 409);
      closeAttempted = true;
      // A poisoned facade may own a retained, unconfirmed SQLite/helper close
      // in an outer L facade. Never tear down its supporting authorities.
      try { native.assertCurrent(); } catch (error) {
        failure = error;
        return native.retainUnknown({ product, sourceBindings }, error);
      }
      try {
        // Stop at the first unconfirmed inner close. No close retries.
        product!.close();
        sourceBindings.close();
      } catch (error) {
        failure = error;
        return native.retainUnknown({ product, sourceBindings }, error);
      }
      closed = true;
    },
  });
  } catch (error) {
    const errors = [error];
    try { product?.close(); } catch (cleanup) { errors.push(cleanup); }
    try { sourceBindings.close(); } catch (cleanup) { errors.push(cleanup); }
    finish(errors, "Native factory startup and close failed");
    throw error;
  }
}
