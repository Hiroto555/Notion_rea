import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { types } from "node:util";
import {
  privatePersistencePort,
  type NativePrivateFilesystemPort,
  type NativePrivateIdentity,
} from "../platform/private-persistence";
import { isAuthorityLeasePlatform } from "../platform/windows/authority-lease";
import type { PrivatePlatform } from "./private-platform";
import { preflightExistingJournal } from "./journal-preflight";
import { SqliteConnectionOwner, closeSqlitePlatform } from "./sqlite-connection-owner";
import { inspectServerHistory } from "./server-history-validation";
import { SyncSqliteGuard, SyncStorageUnavailable } from "./sqlite-guard";
import {
  assertSyncRetentionAdmission,
  inspectSyncRetention,
  type SyncRetentionLimits,
} from "./sync-retention";
import {
  createCheckpointServerBackup,
  type CheckpointServerBackup,
} from "./server-backup";
import {
  canonicalJson,
  fingerprintCommit,
  identifier,
  MAX_WIRE_BYTES,
  parseCheckpoint,
  parseCommit,
  requireCondition,
  SyncError,
  type AssetManifest,
  type Checkpoint,
  type CheckpointHead,
  type Commit,
  type CommitResult,
} from "./protocol";

export type Capability = {
  token: string;
  ownerId: string;
  workspaceId: string;
};

/** Enables device-scoped authentication for a workspace. */
export type WorkspaceScope = {
  workspaceId: string;
  ownerId: string;
};

export type DeviceRegistration = {
  workspaceId: string;
  ownerId: string;
  clientId: string;
  token: string;
};

export type CheckpointBlobAdapter = {
  has(workspaceId: string, asset: AssetManifest): boolean;
  /** Existing native server history has hash/length requirements, without
   * a client-local asset name. Required for native history with attachments. */
  hasStoredAssetBytes?(workspaceId: string, asset: {sha256: string; bytes: number}): boolean;
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    context: {
      workspaceId: string;
      sha256: string;
      assertAuthorized: () => void;
    },
  ): Promise<void>;
};

/**
 * Returns literal `true` to admit a checkpoint. The optional `previous` is the
 * checkpoint at the operation's actual base revision and is supplied only when
 * that base equals the current head; it is `null` for revision zero and for a
 * stale CAS candidate so successor/omission checks are never made against the
 * wrong base. A rejected stale candidate never becomes a persisted conflict.
 */
export type CheckpointValidator = (
  checkpoint: Checkpoint,
  previous: Checkpoint | null,
) => boolean;

/** Host-owned native resources outlive every SQLite and HTTP callback. */
export type CheckpointServerNativeLifetime = Readonly<{
  platform: PrivatePlatform;
  validateCurrent(): void;
  scope<T>(work: () => T): T;
  backup(db: DatabaseSync, destination: string, serverEpoch: string): CheckpointServerBackup;
  close(): void;
}>;

export type CheckpointServerOptions = {
  databasePath: string;
  capabilities: Capability[];
  /**
   * Device-mode workspaces. `capabilities` may be empty when this is present,
   * but every request to one of these workspaces requires a device registered
   * through the returned handle. A capability token never bypasses this scope.
   */
  workspaces?: WorkspaceScope[];
  validateCheckpoint: CheckpointValidator;
  /** Optional attachment transport owned by the host/asset lane. */
  blobs?: CheckpointBlobAdapter;
  /**
   * Optional lower retention caps for this server. The shared admission helper
   * rejects values above the server defaults (1024 rows, 64 MiB).
   */
  retentionLimits?: SyncRetentionLimits;
  host?: "127.0.0.1";
  port?: number;
  nativePrivateFilesystem?: NativePrivateFilesystemPort;
  nativeLifetime?: CheckpointServerNativeLifetime;
};

export type CheckpointServerHandle = {
  url: string;
  serverEpoch: string;
  /**
   * Explicit host-side administrative call. Re-registering an active client
   * rotates its token (the old token stops matching immediately); a revoked
   * client can never be enrolled again.
   */
  registerDevice(registration: DeviceRegistration): void;
  revokeDevice(workspaceId: string, clientId: string): void;
  /**
   * Administrative catalog snapshot. It is intentionally not an HTTP route.
   * The backup runs synchronously through the server's guarded connection, so
   * it blocks request handling while the snapshot is copied.
   */
  backup(destination: string): CheckpointServerBackup;
  close(): Promise<void>;
};

type Authorization = {
  mode: "capability" | "device";
  workspaceId: string;
  ownerId: string;
  clientId: string | null;
};

function body(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let length = 0;
    let ended = false;
    const chunks: Buffer[] = [];
    const fail = (error: Error) => {
      if (ended) return;
      ended = true;
      chunks.length = 0;
      reject(error);
    };
    request.on("data", (chunk: Buffer) => {
      if (ended) return;
      length += chunk.length;
      if (length > MAX_WIRE_BYTES)
        return fail(new SyncError("payload-too-large", 413));
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (ended) return;
      ended = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new SyncError("invalid-json"));
      }
    });
    request.on("aborted", () => fail(new SyncError("request-aborted")));
    request.on("error", () => fail(new SyncError("request-failed")));
  });
}

function send(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const content = canonicalJson(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(content),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(content);
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function requireToken(token: unknown): string {
  requireCondition(
    typeof token === "string" && /^[A-Za-z0-9_-]{32,512}$/.test(token),
    "invalid-capability",
  );
  return token;
}

/** SQLite/native release chain for one server lifetime: the owner tracks every
 * DatabaseSync; its cleanup callback runs the post-DB native proof and the
 * lifetime close inside `lifetime.scope`, only after all handles are proven
 * closed. `beforeNativeRelease` is the post-DB pre-native proof. */
type CheckpointSqliteOwnership = {
  owner: SqliteConnectionOwner;
  beforeNativeRelease?: () => void;
  nativeClosed: boolean;
  /** Proof/operation diagnostics observed inside the release callback while
   * the actual lifetime-close result is decided separately. Drained at the
   * public caller boundaries so a known-complete cleanup is never surfaced
   * to the owner as uncertainty; a real close failure still throws through
   * the callback itself. */
  releaseProofErrors: unknown[];
};

/** Local fixture/reference server, never a public deployment entrypoint. */
export async function startCheckpointServer(
  options: CheckpointServerOptions,
): Promise<CheckpointServerHandle> {
  const lifetime = options.nativeLifetime;
  requireCondition(
    (lifetime === undefined) === (options.nativePrivateFilesystem === undefined),
    "server-native-capability-required", 503,
  );
  requireCondition(process.platform !== "win32" || lifetime !== undefined,
    "server-native-capability-required", 503);
  if (lifetime !== undefined)
    requireCondition(lifetime !== null && typeof lifetime === "object" &&
      typeof lifetime.validateCurrent === "function" &&
      !types.isAsyncFunction(lifetime.validateCurrent) && !types.isGeneratorFunction(lifetime.validateCurrent) &&
      typeof lifetime.close === "function" && !types.isAsyncFunction(lifetime.close) &&
      !types.isGeneratorFunction(lifetime.close) &&
      typeof lifetime.scope === "function" && typeof lifetime.backup === "function" &&
      lifetime.platform?.kind === "windows" &&
      (process.platform !== "win32" || isAuthorityLeasePlatform(lifetime.platform)),
    "server-native-capability-required", 503);
  // One owner for every SQLite handle plus the native lifetime. The cleanup
  // callback runs the post-DB native proof inside lifetime.scope and closes
  // the lifetime exactly once — after all handles are proven closed.
  let ownership!: CheckpointSqliteOwnership;
  const owner = new SqliteConnectionOwner(() => {
    if (lifetime === undefined || ownership.nativeClosed) return;
    lifetime.scope(() => {
      // The post-DB proof is a diagnostic kept for the caller boundary; only
      // the actual lifetime close decides this callback's acknowledgement.
      try { ownership.beforeNativeRelease?.(); }
      catch (error) { ownership.releaseProofErrors.push(error); }
      closeSqlitePlatform(lifetime);
      ownership.nativeClosed = true;
    });
  });
  ownership = { owner, nativeClosed: false, releaseProofErrors: [] };
  try {
    return await (lifetime === undefined
      ? startCheckpointServerInScope(options, ownership)
      : lifetime.scope(() => startCheckpointServerInScope(options, ownership)));
  } catch (error) {
    // owner.fail sees the primary failure and the real cleanup result only;
    // deferred proof diagnostics attach here, outside the owner.
    const failures: unknown[] = [];
    try { owner.fail(error); } catch (failure) { failures.push(failure); }
    failures.push(...ownership.releaseProofErrors.splice(0));
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures,
      "Server startup, native cleanup and release proof failed");
  }
}

async function startCheckpointServerInScope(
  options: CheckpointServerOptions,
  ownership: CheckpointSqliteOwnership,
): Promise<CheckpointServerHandle> {
  requireCondition(
    options.host === undefined || options.host === "127.0.0.1",
    "loopback-only",
  );
  requireCondition(
    typeof options.validateCheckpoint === "function",
    "checkpoint-validator-required",
  );
  const capabilityOptions = options.capabilities ?? [];
  const workspaceOptions = options.workspaces ?? [];
  requireCondition(Array.isArray(capabilityOptions), "invalid-capabilities");
  requireCondition(Array.isArray(workspaceOptions), "invalid-workspaces");
  requireCondition(
    capabilityOptions.length > 0 || workspaceOptions.length > 0,
    "capabilities-required",
  );
  const owners = new Map<string, string>();
  const registerOwner = (workspaceId: string, ownerId: string): void => {
    identifier(workspaceId);
    identifier(ownerId);
    const previous = owners.get(workspaceId);
    requireCondition(
      previous === undefined || previous === ownerId,
      "workspace-owner-mismatch",
    );
    owners.set(workspaceId, ownerId);
  };
  const capabilities = capabilityOptions.map((capability) => {
    identifier(capability.workspaceId);
    identifier(capability.ownerId);
    registerOwner(capability.workspaceId, capability.ownerId);
    const token = requireToken(capability.token);
    return {
      workspaceId: capability.workspaceId,
      ownerId: capability.ownerId,
      digest: createHash("sha256").update(token).digest(),
    };
  });
  const deviceWorkspaces = new Set<string>();
  for (const workspace of workspaceOptions) {
    registerOwner(workspace.workspaceId, workspace.ownerId);
    deviceWorkspaces.add(workspace.workspaceId);
  }

  const native = options.nativeLifetime;
  const filesystem = options.nativePrivateFilesystem === undefined ? undefined :
    privatePersistencePort({ nativePrivateFilesystem: options.nativePrivateFilesystem });
  const scope = <T>(work: () => T): T => native === undefined ? work() : native.scope(work);
  let nativeFailure: unknown;
  let nativeFailed = false;
  let directoryIdentity: NativePrivateIdentity | undefined;
  let databaseIdentity: NativePrivateIdentity | undefined;
  const sameIdentity = (a: NativePrivateIdentity, b: NativePrivateIdentity): boolean =>
    a.path.toLowerCase() === b.path.toLowerCase() &&
    a.fileId.toLowerCase() === b.fileId.toLowerCase() &&
    a.volumeId.toLowerCase() === b.volumeId.toLowerCase();
  const assertNativeCurrent = (): void => {
    if (native === undefined) return;
    if (nativeFailed) throw nativeFailure;
    try {
      const ack: unknown = native.validateCurrent();
      if (types.isPromise(ack)) void Promise.prototype.then.call(ack, undefined, () => undefined);
      requireCondition(ack === undefined, "server-native-current-invalid", 503);
      native.platform.assertRoot();
      native.platform.assertFile(options.databasePath);
      native.platform.assertSidecars(options.databasePath);
      requireCondition(filesystem !== undefined && directoryIdentity !== undefined &&
        databaseIdentity !== undefined &&
        sameIdentity(directoryIdentity, filesystem.inspectDirectory(dirname(options.databasePath))) &&
        sameIdentity(databaseIdentity, filesystem.inspectFileIdentity(options.databasePath)),
      "server-native-identity-changed", 503);
    } catch (error) {
      nativeFailed = true;
      nativeFailure = error;
      throw error;
    }
  };
  // Post-DB-closed, pre-native-release proof — invoked inside lifetime.scope
  // by the owner cleanup callback once every connection is proven closed.
  ownership.beforeNativeRelease = assertNativeCurrent;
  if (native !== undefined) {
    requireCondition(filesystem !== undefined, "server-native-capability-required", 503);
    const initial: unknown = native.validateCurrent();
    if (types.isPromise(initial)) void Promise.prototype.then.call(initial, undefined, () => undefined);
    requireCondition(initial === undefined, "server-native-current-invalid", 503);
    directoryIdentity = filesystem.inspectDirectory(dirname(options.databasePath));
    databaseIdentity = filesystem.inspectFileIdentity(options.databasePath);
    // The host bound this platform; its original C acquirer takes a held lease
    // before any writable SQLite open, including an empty new database.
    native.platform.createExclusive(options.databasePath);
    assertNativeCurrent();
    const size = lstatSync(options.databasePath).size; // size hint, never identity
    requireCondition(Number.isSafeInteger(size) && size >= 0 && size <= 256 * 1024 * 1024,
      "server-native-database-size", 409);
    if (size === 0) native.platform.assertEmptyFile(options.databasePath);
    else preflightExistingJournal(options.databasePath, assertNativeCurrent, (db) => {
      const inventory = inspectServerHistory(db);
      requireCondition(inventory.workspaces.length === owners.size &&
        inventory.workspaces.every(w => owners.get(w.workspaceId) === w.ownerId),
      "workspace-owner-mismatch", 409);
      for (const asset of inventory.assets) {
        requireCondition(options.blobs?.hasStoredAssetBytes?.(asset.workspaceId, asset), "server-asset-missing-or-corrupt", 422);
        assertNativeCurrent();
      }
      const registered = db.prepare("SELECT workspace_id FROM checkpoint_device_workspaces").all();
      requireCondition(registered.length === deviceWorkspaces.size &&
        registered.every(row => deviceWorkspaces.has(String(row.workspace_id))),
      "workspace-device-mode-required", 409);
      inspectSyncRetention(db, "server", options.retentionLimits);
    }, native.platform, ownership.owner);
    assertNativeCurrent();
  }
  const connection = new DatabaseSync(options.databasePath);
  ownership.owner.opened(connection);
  const storage: SyncSqliteGuard = ownership.owner.guarded(connection);
  const assertUsable = (): void => {
    assertNativeCurrent();
    storage.assertUsable();
  };
  const transaction = <T>(work: () => T): T => {
    assertUsable();
    const value = storage.transaction(() => {
      assertNativeCurrent();
      const result = work();
      assertNativeCurrent();
      return result;
    });
    assertUsable();
    return value;
  };
  const closeStorage = (): void => {
    const errors: unknown[] = [];
    // A released native lifetime is never re-probed: the lease is gone, so
    // assertNativeCurrent would only poison the retry path.
    if (!ownership.nativeClosed) {
      try { assertNativeCurrent(); } catch (error) { errors.push(error); }
    }
    // owner.close() proves every connection closed, then runs the native
    // release callback (post-DB proof + lifetime.close inside lifetime.scope).
    try { ownership.owner.close(); } catch (error) { errors.push(error); }
    // Deferred proof diagnostics surface here, never inside the owner, so a
    // confirmed cleanup cannot be branded uncertain. splice(0) also keeps a
    // confirmed-closed retry from replaying already-reported diagnostics.
    errors.push(...ownership.releaseProofErrors.splice(0));
    if (errors.length) throw errors.length === 1 ? errors[0] :
      new AggregateError(errors, "Server storage and native lifetime close failed");
  };
  let serverEpoch!: string;
  try {
    assertUsable();
    const tables = storage.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    requireCondition(
      tables.length === 0 ||
        tables.some((row) => row.name === "checkpoint_server_identity"),
      "not-a-checkpoint-server",
    );
    storage.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
    transaction(() => {
      storage.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoint_server_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, epoch TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoint_heads(workspace_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, revision INTEGER NOT NULL, checkpoint_hash TEXT, checkpoint_json TEXT);
      CREATE TABLE IF NOT EXISTS checkpoint_operations(workspace_id TEXT NOT NULL, client_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, commit_json TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(workspace_id,client_id,operation_id));
      CREATE TABLE IF NOT EXISTS checkpoint_changes(workspace_id TEXT NOT NULL, revision INTEGER NOT NULL, change_json TEXT NOT NULL, PRIMARY KEY(workspace_id,revision));
      CREATE TABLE IF NOT EXISTS checkpoint_device_workspaces(workspace_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS checkpoint_devices(workspace_id TEXT NOT NULL, client_id TEXT NOT NULL, owner_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)), PRIMARY KEY(workspace_id,client_id));
    `);
      const existing = storage.db
        .prepare("SELECT * FROM checkpoint_server_identity WHERE singleton=1")
        .get();
      if (existing) {
        requireCondition(existing.version === 1, "unsupported-server-version");
        serverEpoch = identifier(existing.epoch);
      } else {
        requireCondition(tables.length === 0, "missing-server-identity");
        serverEpoch = randomUUID();
        storage.db
          .prepare("INSERT INTO checkpoint_server_identity VALUES(1,1,?)")
          .run(serverEpoch);
      }
      for (const [workspaceId, ownerId] of owners) {
        const scope = storage.db
          .prepare("SELECT 1 FROM checkpoint_device_workspaces WHERE workspace_id=?")
          .get(workspaceId);
        requireCondition(!scope || deviceWorkspaces.has(workspaceId), "workspace-device-mode-required");
        if (deviceWorkspaces.has(workspaceId))
          storage.db.prepare("INSERT OR IGNORE INTO checkpoint_device_workspaces VALUES(?)").run(workspaceId);
        const owner = storage.db
          .prepare("SELECT owner_id FROM checkpoint_heads WHERE workspace_id=?")
          .get(workspaceId);
        requireCondition(
          !owner || owner.owner_id === ownerId,
          "workspace-owner-mismatch",
        );
        storage.db
          .prepare(
            "INSERT OR IGNORE INTO checkpoint_heads(workspace_id,owner_id,revision) VALUES(?,?,0)",
          )
          .run(workspaceId, ownerId);
        for (const device of storage.db
          .prepare(
            "SELECT owner_id FROM checkpoint_devices WHERE workspace_id=?",
          )
          .all(workspaceId))
          requireCondition(
            device.owner_id === ownerId,
            "workspace-owner-mismatch",
          );
      }
    });
  } catch (error) {
    // SQLite/native cleanup belongs to the public owner.fail path — running
    // closeStorage here would burn the single allowed close attempt early.
    throw error;
  }
  const readHead = (workspaceId: string): CheckpointHead => {
    assertUsable();
    const row = storage.db
      .prepare("SELECT * FROM checkpoint_heads WHERE workspace_id=?")
      .get(workspaceId)!;
    return {
      revision: Number(row.revision),
      checkpointHash:
        row.checkpoint_hash === null ? null : String(row.checkpoint_hash),
      checkpoint:
        row.checkpoint_json === null
          ? null
          : parseCheckpoint(JSON.parse(String(row.checkpoint_json))),
    };
  };

  const authorize = (
    request: IncomingMessage,
    workspaceId: string,
  ): Authorization => {
    assertUsable();
    const supplied = request.headers.authorization;
    const digest = createHash("sha256")
      .update(
        typeof supplied === "string" && supplied.startsWith("Bearer ")
          ? supplied.slice(7)
          : "",
      )
      .digest();
    if (deviceWorkspaces.has(workspaceId)) {
      const ownerId = owners.get(workspaceId);
      requireCondition(ownerId !== undefined, "workspace-owner-mismatch");
      let matched: Authorization | undefined;
      for (const device of storage.db
        .prepare(
          "SELECT client_id, owner_id, token_hash, revoked FROM checkpoint_devices WHERE workspace_id=?",
        )
        .all(workspaceId)) {
        const stored = Buffer.from(String(device.token_hash), "hex");
        if (
          stored.length !== digest.length ||
          !timingSafeEqual(stored, digest)
        )
          continue;
        if (Number(device.revoked) !== 0) continue;
        if (device.owner_id !== ownerId) continue;
        matched = {
          mode: "device",
          workspaceId,
          ownerId,
          clientId: identifier(String(device.client_id)),
        };
      }
      requireCondition(matched !== undefined, "unauthorized", 401);
      return matched;
    }
    for (const capability of capabilities) {
      if (
        capability.workspaceId === workspaceId &&
        timingSafeEqual(capability.digest, digest)
      )
        return {
          mode: "capability",
          workspaceId,
          ownerId: capability.ownerId,
          clientId: null,
        };
    }
    throw new SyncError("unauthorized", 401);
  };

  const authorizeDeviceWorkspace = (
    workspaceId: string,
    ownerId: string,
  ): void => {
    requireCondition(
      deviceWorkspaces.has(workspaceId),
      "workspace-not-found",
      404,
    );
    requireCondition(
      owners.get(workspaceId) === ownerId,
      "workspace-owner-mismatch",
      403,
    );
    const head = storage.db
      .prepare("SELECT owner_id FROM checkpoint_heads WHERE workspace_id=?")
      .get(workspaceId);
    requireCondition(
      head !== undefined && head.owner_id === ownerId,
      "workspace-owner-mismatch",
      403,
    );
  };

  const registerDevice = (registration: DeviceRegistration): void => {
    const workspaceId = identifier(registration.workspaceId);
    const ownerId = identifier(registration.ownerId);
    const clientId = identifier(registration.clientId);
    const digest = tokenDigest(requireToken(registration.token));
    transaction(() => {
      authorizeDeviceWorkspace(workspaceId, ownerId);
      const existing = storage.db
        .prepare(
          "SELECT owner_id, token_hash, revoked FROM checkpoint_devices WHERE workspace_id=? AND client_id=?",
        )
        .get(workspaceId, clientId);
      if (existing) {
        requireCondition(
          existing.owner_id === ownerId,
          "workspace-owner-mismatch",
          403,
        );
        requireCondition(
          Number(existing.revoked) === 0,
          "device-revoked",
          409,
        );
        if (String(existing.token_hash) === digest) return;
        const collision = storage.db
          .prepare(
            "SELECT 1 FROM checkpoint_devices WHERE token_hash=? AND NOT (workspace_id=? AND client_id=?)",
          )
          .get(digest, workspaceId, clientId);
        requireCondition(collision === undefined, "token-in-use", 409);
        storage.db
          .prepare(
            "UPDATE checkpoint_devices SET token_hash=? WHERE workspace_id=? AND client_id=?",
          )
          .run(digest, workspaceId, clientId);
        return;
      }
      const collision = storage.db
        .prepare("SELECT 1 FROM checkpoint_devices WHERE token_hash=?")
        .get(digest);
      requireCondition(collision === undefined, "token-in-use", 409);
      const deviceCount = Number(storage.db.prepare("SELECT COUNT(*) AS n FROM checkpoint_devices").get()!.n);
      requireCondition(Number.isSafeInteger(deviceCount) && deviceCount < 512, "server-device-retention-held", 409);
      storage.db
        .prepare(
          "INSERT INTO checkpoint_devices(workspace_id,client_id,owner_id,token_hash,revoked) VALUES(?,?,?,?,0)",
        )
        .run(workspaceId, clientId, ownerId, digest);
    });
  };

  const revokeDevice = (workspaceIdInput: string, clientIdInput: string): void => {
    const workspaceId = identifier(workspaceIdInput);
    const clientId = identifier(clientIdInput);
    transaction(() => {
      const existing = storage.db
        .prepare(
          "SELECT 1 FROM checkpoint_devices WHERE workspace_id=? AND client_id=?",
        )
        .get(workspaceId, clientId);
      requireCondition(existing !== undefined, "device-not-found", 404);
      storage.db
        .prepare(
          "UPDATE checkpoint_devices SET revoked=1 WHERE workspace_id=? AND client_id=?",
        )
        .run(workspaceId, clientId);
    });
  };

  const commit = (operation: Commit): CommitResult => {
    const fingerprint = fingerprintCommit(operation);
    return transaction(() => {
      const previous = storage.db
        .prepare(
          "SELECT * FROM checkpoint_operations WHERE workspace_id=? AND client_id=? AND operation_id=?",
        )
        .get(operation.workspaceId, operation.clientId, operation.operationId);
      if (previous) {
        requireCondition(
          previous.fingerprint === fingerprint,
          "operation-id-reused",
          409,
        );
        const result = JSON.parse(String(previous.result_json)) as CommitResult;
        return result;
      }
      const assets = operation.checkpoint.assets.map((asset) => ({
        ...asset,
      }));
      requireCondition(
        assets.length === 0 || options.blobs !== undefined,
        "attachments-not-supported",
        422,
      );
      const head = readHead(operation.workspaceId);
      const baseIsHead = operation.baseRevision === head.revision;
      const previousCheckpoint = baseIsHead ? head.checkpoint : null;
      try {
        // A detached value prevents a validator from mutating the receipt.
        const candidate = JSON.parse(
          canonicalJson(operation.checkpoint),
        ) as Checkpoint;
        const previous =
          previousCheckpoint === null
            ? null
            : (JSON.parse(canonicalJson(previousCheckpoint)) as Checkpoint);
        const validated: unknown = options.validateCheckpoint(candidate, previous);
        // TypeScript rejects async predicates; defend JS callers too and consume rejection.
        if (
          validated &&
          (typeof validated === "object" || typeof validated === "function") &&
          typeof (validated as { then?: unknown }).then === "function"
        ) {
          void Promise.resolve(validated).catch(() => {});
        }
        requireCondition(validated === true, "checkpoint-schema-rejected", 422);
      } catch {
        throw new SyncError("checkpoint-schema-rejected", 422);
      }
      if (assets.length > 0) {
        requireCondition(options.blobs !== undefined, "attachments-not-supported", 422);
        for (const asset of assets)
          requireCondition(
            options.blobs.has(operation.workspaceId, asset),
            "blob-missing",
            409,
          );
      }
      const identity = {
        protocol: 1 as const,
        workspaceId: operation.workspaceId,
        clientId: operation.clientId,
        operationId: operation.operationId,
        serverEpoch,
        fingerprint,
      };
      const commitJson = canonicalJson(operation);
      if (!baseIsHead) {
        const result: CommitResult = { ...identity, status: "conflict", head };
        const resultJson = canonicalJson(result);
        assertSyncRetentionAdmission(
          storage.db,
          "server",
          {
            rows: 1,
            bytes:
              Buffer.byteLength(commitJson) + Buffer.byteLength(resultJson),
          },
          options.retentionLimits,
        );
        // The losing operation and the competing head remain in the same durable receipt.
        storage.db
          .prepare("INSERT INTO checkpoint_operations VALUES(?,?,?,?,?,?)")
          .run(
            operation.workspaceId,
            operation.clientId,
            operation.operationId,
            fingerprint,
            commitJson,
            resultJson,
          );
        return result;
      }
      requireCondition(
        head.revision < Number.MAX_SAFE_INTEGER,
        "revision-exhausted",
        409,
      );
      const revision = head.revision + 1;
      const change = {
        revision,
        clientId: operation.clientId,
        operationId: operation.operationId,
        fingerprint,
        checkpointHash: operation.checkpointHash,
        checkpoint: operation.checkpoint,
      };
      const changeJson = canonicalJson(change);
      const result: CommitResult = {
        ...identity,
        status: "applied",
        revision,
        checkpointHash: operation.checkpointHash,
      };
      const resultJson = canonicalJson(result);
      // Admit the change row and the operation receipt together before the head
      // update; a held transaction leaves no partial revision behind.
      assertSyncRetentionAdmission(
        storage.db,
        "server",
        {
          rows: 2,
          bytes:
            Buffer.byteLength(changeJson) +
            Buffer.byteLength(commitJson) +
            Buffer.byteLength(resultJson),
        },
        options.retentionLimits,
      );
      storage.db
        .prepare(
          "UPDATE checkpoint_heads SET revision=?,checkpoint_hash=?,checkpoint_json=? WHERE workspace_id=?",
        )
        .run(
          revision,
          operation.checkpointHash,
          canonicalJson(operation.checkpoint),
          operation.workspaceId,
        );
      storage.db
        .prepare("INSERT INTO checkpoint_changes VALUES(?,?,?)")
        .run(operation.workspaceId, revision, changeJson);
      storage.db
        .prepare("INSERT INTO checkpoint_operations VALUES(?,?,?,?,?,?)")
        .run(
          operation.workspaceId,
          operation.clientId,
          operation.operationId,
          fingerprint,
          commitJson,
          resultJson,
        );
      return result;
    });
  };

  const requests = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const active = scope(async () => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const match =
        /^\/v1\/workspaces\/([A-Za-z0-9_-]+)\/(head|commits|changes|operations\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)|blobs\/([a-f0-9]{64}))$/.exec(
          url.pathname,
        );
      requireCondition(match, "not-found", 404);
      const workspaceId = identifier(match[1]);
      const route = match[2];
      const authorization = authorize(request, workspaceId);
      assertUsable();
      if (route.startsWith("blobs/")) {
        requireCondition(url.search === "", "unexpected-query");
        requireCondition(options.blobs !== undefined, "not-found", 404);
        requireCondition(
          request.method === "GET" ||
            request.method === "PUT" ||
            request.method === "HEAD",
          "method-not-allowed",
          405,
        );
        await options.blobs.handle(request, response, {
          workspaceId,
          sha256: match[5],
          assertAuthorized: () => {
            authorize(request, workspaceId);
            assertUsable();
          },
        });
        return;
      }
      if (request.method === "GET" && route === "head") {
        requireCondition(url.search === "", "unexpected-query");
        return send(response, 200, {
          protocol: 1,
          workspaceId,
          serverEpoch,
          head: readHead(workspaceId),
        });
      }
      if (request.method === "GET" && route === "changes") {
        const afterText = url.searchParams.get("after");
        requireCondition(
          [...url.searchParams].length === 1 &&
            afterText !== null &&
            /^(0|[1-9][0-9]*)$/.test(afterText),
          "invalid-cursor",
        );
        const after = Number(afterText);
        const headRevision = readHead(workspaceId).revision;
        requireCondition(
          Number.isSafeInteger(after) && after <= headRevision,
          "cursor-ahead",
          409,
        );
        const changes = storage.db
          .prepare(
            "SELECT change_json FROM checkpoint_changes WHERE workspace_id=? AND revision>? ORDER BY revision LIMIT 1",
          )
          .all(workspaceId, after)
          .map((row) => JSON.parse(String(row.change_json)));
        return send(response, 200, {
          protocol: 1,
          workspaceId,
          serverEpoch,
          after,
          headRevision,
          changes,
        });
      }
      if (request.method === "GET" && route.startsWith("operations/")) {
        requireCondition(url.search === "", "unexpected-query");
        const clientId = identifier(match[3]);
        const operationId = identifier(match[4]);
        requireCondition(
          authorization.mode !== "device" ||
            authorization.clientId === clientId,
          "client-mismatch",
          403,
        );
        const row = storage.db
          .prepare(
            "SELECT result_json FROM checkpoint_operations WHERE workspace_id=? AND client_id=? AND operation_id=?",
          )
          .get(workspaceId, clientId, operationId);
        requireCondition(row, "operation-not-found", 404);
        return send(response, 200, JSON.parse(String(row.result_json)));
      }
      if (request.method === "POST" && route === "commits") {
        requireCondition(url.search === "", "unexpected-query");
        requireCondition(
          request.headers["content-type"]?.split(";")[0] === "application/json",
          "json-required",
          415,
        );
        const operation = parseCommit(await body(request));
        // A device can be rotated/revoked while its body is in flight.
        const current = authorize(request, workspaceId);
        assertUsable();
        requireCondition(
          operation.workspaceId === workspaceId,
          "workspace-mismatch",
          403,
        );
        requireCondition(
          current.mode !== "device" ||
            operation.clientId === current.clientId,
          "client-mismatch",
          403,
        );
        requireCondition(
          operation.serverEpoch === serverEpoch,
          "server-epoch-mismatch",
          409,
        );
        return send(response, 200, commit(operation));
      }
      throw new SyncError("method-not-allowed", 405);
    }).catch((error) => scope(() => {
      const known =
        error instanceof SyncError || error instanceof SyncStorageUnavailable;
      send(response, known ? error.status : 500, {
        error: known ? error.code : "internal-error",
      });
    }));
    requests.add(active);
    void active.then(() => requests.delete(active), () => requests.delete(active));
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  let port!: number;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    assertUsable();
    const address = server.address();
    requireCondition(
      address && typeof address !== "string",
      "server-address-unavailable",
    );
    port = address.port;
  } catch (error) {
    // HTTP is released here; SQLite/native cleanup propagates to the public
    // owner.fail — closeStorage must not run inside startup catches.
    try {
      if (server.listening) await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      await Promise.allSettled([...requests]);
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "Server listen and close failed",
      );
    }
    throw error;
  }
  let httpClosed = false;
  let closeResult: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}`,
    serverEpoch,
    registerDevice: registration => scope(() => registerDevice(registration)),
    revokeDevice: (workspaceId, clientId) => scope(() => revokeDevice(workspaceId, clientId)),
    backup(destination: string) {
      return scope(() => {
      assertUsable();
      const result = native !== undefined
        ? native.backup(storage.db, destination, serverEpoch)
        : createCheckpointServerBackup({
        db: storage.db,
        databasePath: options.databasePath,
        destination,
        serverEpoch,
      });
      assertUsable();
      return result;
      });
    },
    close() {
      const closeOwned = async () => {
      const errors: unknown[] = [];
      if (!httpClosed) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
        httpClosed = true;
      }
      // HTTP close does not by itself await asynchronous blob-lock cleanup.
      // Retain SQLite, C leases and the factory until every handler settled.
      await Promise.allSettled([...requests]);
      try { closeStorage(); } catch (error) { errors.push(error); }
      if (errors.length) throw errors.length === 1 ? errors[0] :
        new AggregateError(errors, "Server close failed");
      };
      // After the native lifetime has been released once, its scope may be
      // disposed — a rejected-then-retried close must not re-enter it. The
      // owner never replays the native close itself.
      closeResult ??= (ownership.nativeClosed ? closeOwned() : scope(closeOwned)).catch(error => {
        // A rejected close is not an acknowledgement that SQLite closed.
        // Retain its protector and allow the owner to retry cleanup once the
        // original close fault has been removed. No request or mutation runs.
        closeResult = undefined;
        throw error;
      });
      return closeResult;
    },
  };
}
