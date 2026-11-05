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
export type CheckpointServerOptions = {
  databasePath: string;
  capabilities: Capability[];
  /** Synchronous predicate: only literal true admits a checkpoint. Not a Folio validator. */
  validateCheckpoint: (checkpoint: Checkpoint) => boolean;
  host?: "127.0.0.1";
  port?: number;
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
  if (response.destroyed) return;
  const content = canonicalJson(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(content),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(content);
}

/** Local fixture/reference server, never a public deployment entrypoint. */
export async function startCheckpointServer(
  options: CheckpointServerOptions,
): Promise<{
  url: string;
  serverEpoch: string;
  close(): Promise<void>;
}> {
  requireCondition(
    options.host === undefined || options.host === "127.0.0.1",
    "loopback-only",
  );
  requireCondition(
    typeof options.validateCheckpoint === "function",
    "checkpoint-validator-required",
  );
  requireCondition(options.capabilities.length > 0, "capabilities-required");
  const owners = new Map<string, string>();
  const capabilities = options.capabilities.map((capability) => {
    identifier(capability.workspaceId);
    identifier(capability.ownerId);
    requireCondition(
      typeof capability.token === "string" &&
        /^[A-Za-z0-9_-]{32,512}$/.test(capability.token),
      "invalid-capability",
    );
    requireCondition(
      !owners.has(capability.workspaceId) ||
        owners.get(capability.workspaceId) === capability.ownerId,
      "workspace-owner-mismatch",
    );
    owners.set(capability.workspaceId, capability.ownerId);
    return {
      ...capability,
      token: undefined,
      digest: createHash("sha256").update(capability.token).digest(),
    };
  });
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
      try {
        const validated: unknown = options.validateCheckpoint(
          parseCheckpoint(operation.checkpoint),
        );
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
      const head = readHead(operation.workspaceId);
      const identity = {
        protocol: 1 as const,
        workspaceId: operation.workspaceId,
        clientId: operation.clientId,
        operationId: operation.operationId,
        serverEpoch,
        fingerprint,
      };
      let result: CommitResult;
      if (operation.baseRevision !== head.revision) {
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
        /^\/v1\/workspaces\/([A-Za-z0-9_-]+)\/(head|commits|changes|operations\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+))$/.exec(
          url.pathname,
        );
      requireCondition(match, "not-found", 404);
      const workspaceId = identifier(match[1]);
      const supplied = request.headers.authorization;
      const digest = createHash("sha256")
        .update(
          typeof supplied === "string" && supplied.startsWith("Bearer ")
            ? supplied.slice(7)
            : "",
        )
        .digest();
      const authorized = capabilities.some(
        (capability) =>
          capability.workspaceId === workspaceId &&
          timingSafeEqual(capability.digest, digest),
      );
      requireCondition(authorized, "unauthorized", 401);
      storage.assertUsable();
      const route = match[2];
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
        const row = storage.db
          .prepare(
            "SELECT result_json FROM checkpoint_operations WHERE workspace_id=? AND client_id=? AND operation_id=?",
          )
          .get(workspaceId, identifier(match[3]), identifier(match[4]));
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
        requireCondition(
          operation.workspaceId === workspaceId,
          "workspace-mismatch",
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
