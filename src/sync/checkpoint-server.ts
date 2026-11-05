import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { DatabaseSync } from "node:sqlite";
import { SyncSqliteGuard, SyncStorageUnavailable } from "./sqlite-guard";
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
  host?: "127.0.0.1";
  port?: number;
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

/** Local fixture/reference server, never a public deployment entrypoint. */
export async function startCheckpointServer(
  options: CheckpointServerOptions,
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

  const storage = new SyncSqliteGuard(new DatabaseSync(options.databasePath));
  let serverEpoch!: string;
  try {
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
    storage.transaction(() => {
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
    try {
      storage.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "Server initialization and close failed",
      );
    }
    throw error;
  }
  const readHead = (workspaceId: string): CheckpointHead => {
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
    storage.transaction(() => {
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
    storage.transaction(() => {
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
    return storage.transaction(() => {
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
      let result: CommitResult;
      if (!baseIsHead) {
        result = { ...identity, status: "conflict", head };
      } else {
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
          .run(operation.workspaceId, revision, canonicalJson(change));
        result = {
          ...identity,
          status: "applied",
          revision,
          checkpointHash: operation.checkpointHash,
        };
      }
      // The losing operation and the competing head remain in the same durable receipt.
      storage.db
        .prepare("INSERT INTO checkpoint_operations VALUES(?,?,?,?,?,?)")
        .run(
          operation.workspaceId,
          operation.clientId,
          operation.operationId,
          fingerprint,
          canonicalJson(operation),
          canonicalJson(result),
        );
      return result;
    });
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const match =
        /^\/v1\/workspaces\/([A-Za-z0-9_-]+)\/(head|commits|changes|operations\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)|blobs\/([a-f0-9]{64}))$/.exec(
          url.pathname,
        );
      requireCondition(match, "not-found", 404);
      const workspaceId = identifier(match[1]);
      const route = match[2];
      const authorization = authorize(request, workspaceId);
      storage.assertUsable();
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
            storage.assertUsable();
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
        storage.assertUsable();
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
    })().catch((error) => {
      const known =
        error instanceof SyncError || error instanceof SyncStorageUnavailable;
      send(response, known ? error.status : 500, {
        error: known ? error.code : "internal-error",
      });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    try {
      storage.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        "Server listen and close failed",
      );
    }
    throw error;
  }
  const address = server.address();
  requireCondition(
    address && typeof address !== "string",
    "server-address-unavailable",
  );
  let httpClosed = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
    serverEpoch,
    registerDevice,
    revokeDevice,
    async close() {
      if (!httpClosed) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
        httpClosed = true;
      }
      storage.close();
    },
  };
}
