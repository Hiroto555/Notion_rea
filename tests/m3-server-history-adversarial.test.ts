import { pathToFileURL } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { CheckpointRemote } from "../src/sync/client";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import {
  hashCheckpoint,
  SyncError,
  type Checkpoint,
  type Commit,
} from "../src/sync/protocol";
import { inspectServerHistory } from "../src/sync/server-history-validation";

const WORKSPACE_ID = "workspace";
const OWNER_ID = "owner";
const CLIENT_ID = "client-a";
const OTHER_CLIENT_ID = "client-b";
const SHARED_ASSET_SHA = "b".repeat(64);
const roots: string[] = [];
const servers = new Set<
  Awaited<ReturnType<typeof startCheckpointServer>>
>();

afterEach(async () => {
  for (const server of servers) {
    try {
      await server.close();
    } catch {}
  }
  servers.clear();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "folio-server-history-adversarial-")),
  );
  roots.push(root);
  return root;
}

function validateCheckpoint(value: Checkpoint): boolean {
  if (
    value.name !== "test-fixture" ||
    value.version !== 1 ||
    typeof value.payload.text !== "string"
  )
    throw new Error("fixture schema");
  return true;
}

function checkpoint(
  text: string,
  assets: Checkpoint["assets"] = [],
): Checkpoint {
  return {
    format: "folio-checkpoint/v1",
    name: "test-fixture",
    version: 1,
    payload: { text },
    assets,
  };
}

type RunningServer = Awaited<ReturnType<typeof startCheckpointServer>>;
type Fixture = {
  root: string;
  databasePath: string;
  serverEpoch: string;
  asset: { id: string; sha256: string; bytes: number };
  secondHash: string;
  tokens: string[];
};

async function commit(
  remote: CheckpointRemote,
  baseRevision: number,
  text: string,
  operationId: string,
  assets: Checkpoint["assets"] = [],
): Promise<{ checkpointHash: string; status: string }> {
  const head = await remote.head();
  const value = checkpoint(text, assets);
  const operation: Commit = {
    protocol: 1,
    workspaceId: WORKSPACE_ID,
    clientId: CLIENT_ID,
    operationId,
    serverEpoch: head.serverEpoch,
    baseRevision,
    checkpointHash: hashCheckpoint(value),
    checkpoint: value,
  };
  const result = await remote.commit(operation);
  return { checkpointHash: operation.checkpointHash, status: result.status };
}

async function fixture(
  extra?: (
    remote: CheckpointRemote,
    built: { assetSha: string },
  ) => Promise<void>,
): Promise<Fixture> {
  const root = tempRoot();
  const databasePath = join(root, "server.sqlite");
  const token = randomBytes(32).toString("base64url");
  const otherToken = randomBytes(32).toString("base64url");
  const server: RunningServer = await startCheckpointServer({
    databasePath,
    capabilities: [],
    workspaces: [{ workspaceId: WORKSPACE_ID, ownerId: OWNER_ID }],
    validateCheckpoint,
    blobs: { has: () => true, handle: async () => {} },
  });
  servers.add(server);
  server.registerDevice({
    workspaceId: WORKSPACE_ID,
    ownerId: OWNER_ID,
    clientId: CLIENT_ID,
    token,
  });
  server.registerDevice({
    workspaceId: WORKSPACE_ID,
    ownerId: OWNER_ID,
    clientId: OTHER_CLIENT_ID,
    token: otherToken,
  });
  server.revokeDevice(WORKSPACE_ID, OTHER_CLIENT_ID);

  const remote = new CheckpointRemote({
    baseUrl: server.url,
    workspaceId: WORKSPACE_ID,
    token,
  });
  await commit(remote, 0, "one", "op-1");
  const second = await commit(remote, 1, "two", "op-2");

  const asset = { id: randomUUID(), sha256: SHARED_ASSET_SHA, bytes: 7 };
  const loser = await commit(remote, 0, "loser", "op-loser", [asset]);
  expect(loser.status).toBe("conflict");
  if (extra !== undefined) await extra(remote, { assetSha: SHARED_ASSET_SHA });

  const serverEpoch = server.serverEpoch;
  await server.close();
  servers.delete(server);
  return {
    root,
    databasePath,
    serverEpoch,
    asset,
    secondHash: second.checkpointHash,
    tokens: [token, otherToken],
  };
}

function open(databasePath: string, action: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(databasePath);
  try {
    action(db);
  } finally {
    db.close();
  }
}

function inspect(
  databasePath: string,
  limits?: { maxRows?: number; maxJsonBytes?: number },
) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return inspectServerHistory(db, limits);
  } finally {
    db.close();
  }
}

function expectFailure(
  action: () => unknown,
  code: string,
  status: number,
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).code).toBe(code);
    expect((error as SyncError).status).toBe(status);
    return;
  }
  throw new Error("expected inspection to fail");
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const COUNTED_TABLES = [
  "checkpoint_heads",
  "checkpoint_changes",
  "checkpoint_operations",
  "checkpoint_devices",
  "checkpoint_device_workspaces",
] as const;

function countedRows(databasePath: string): number {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    let total = 0;
    for (const table of COUNTED_TABLES) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
        n: number;
      };
      total += Number(row.n);
    }
    return total;
  } finally {
    db.close();
  }
}

it("rejects an applied receipt whose change identity was rewritten", async () => {
  const built = await fixture();
  open(built.databasePath, (db) => {
    const row = db
      .prepare(
        "SELECT change_json FROM checkpoint_changes WHERE workspace_id=? AND revision=1",
      )
      .get(WORKSPACE_ID) as { change_json: string };
    const change = JSON.parse(row.change_json) as { operationId: string };
    change.operationId = "op-other";
    db.prepare(
      "UPDATE checkpoint_changes SET change_json=? WHERE workspace_id=? AND revision=1",
    ).run(JSON.stringify(change), WORKSPACE_ID);
  });
  expectFailure(() => inspect(built.databasePath), "server-history-invalid", 422);
});

it("rejects a conflict result stored at the commit base revision", async () => {
  const built = await fixture();
  open(built.databasePath, (db) => {
    const row = db
      .prepare(
        "SELECT result_json FROM checkpoint_operations WHERE operation_id=?",
      )
      .get("op-loser") as { result_json: string };
    const result = JSON.parse(row.result_json) as { head: unknown };
    result.head = { revision: 0, checkpointHash: null, checkpoint: null };
    db.prepare(
      "UPDATE checkpoint_operations SET result_json=? WHERE operation_id=?",
    ).run(JSON.stringify(result), "op-loser");
  });
  expectFailure(() => inspect(built.databasePath), "server-history-invalid", 422);
});

it("rejects an altered SQL operation key", async () => {
  const built = await fixture();
  open(built.databasePath, (db) => {
    db.prepare(
      "UPDATE checkpoint_operations SET operation_id=? WHERE operation_id=?",
    ).run("op-forged", "op-1");
  });
  expectFailure(() => inspect(built.databasePath), "server-history-invalid", 422);
});

it("rejects a change whose applied receipt was removed", async () => {
  const built = await fixture();
  open(built.databasePath, (db) => {
    db.prepare("DELETE FROM checkpoint_operations WHERE operation_id=?").run(
      "op-2",
    );
  });
  expectFailure(() => inspect(built.databasePath), "server-history-invalid", 422);
});

it("rejects a view added alongside a legitimate index", async () => {
  const built = await fixture();
  open(built.databasePath, (db) => {
    db.exec("CREATE INDEX extra_change_lookup ON checkpoint_changes(workspace_id)");
    db.exec(
      "CREATE VIEW shadow_history AS SELECT workspace_id FROM checkpoint_heads",
    );
  });
  expectFailure(() => inspect(built.databasePath), "server-history-invalid", 422);
});

it("rejects a trigger added alongside a legitimate index", async () => {
  const built = await fixture();
  open(built.databasePath, (db) => {
    db.exec(
      "CREATE INDEX extra_operation_lookup ON checkpoint_operations(operation_id)",
    );
    db.exec(
      "CREATE TRIGGER shadow_write AFTER INSERT ON checkpoint_operations BEGIN SELECT 1; END",
    );
  });
  expectFailure(() => inspect(built.databasePath), "server-history-invalid", 422);
});

it("rejects duplicate device rows when the schema permits them", async () => {
  const built = await fixture();
  open(built.databasePath, (db) => {
    db.exec("ALTER TABLE checkpoint_devices RENAME TO checkpoint_devices_old");
    db.exec(
      "CREATE TABLE checkpoint_devices(workspace_id TEXT NOT NULL,client_id TEXT NOT NULL,owner_id TEXT NOT NULL,token_hash TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0)",
    );
    db.exec(
      "INSERT INTO checkpoint_devices SELECT workspace_id,client_id,owner_id,token_hash,revoked FROM checkpoint_devices_old",
    );
    db.exec(
      "INSERT INTO checkpoint_devices SELECT workspace_id,client_id,owner_id,token_hash,revoked FROM checkpoint_devices_old LIMIT 1",
    );
    db.exec("DROP TABLE checkpoint_devices_old");
  });
  expectFailure(() => inspect(built.databasePath), "server-history-invalid", 422);
});

it("keeps legacy receipts valid after epoch rotation and device revocation", async () => {
  const built = await fixture();
  open(built.databasePath, (db) => {
    db.prepare("UPDATE checkpoint_server_identity SET epoch=?").run(
      "epoch-rotated",
    );
    db.prepare("UPDATE checkpoint_devices SET revoked=1").run();
  });
  const inventory = inspect(built.databasePath);
  expect(inventory.serverEpoch).toBe("epoch-rotated");
  expect(inventory.changes).toBe(2);
  expect(inventory.operations).toBe(3);
  expect(inventory.devices).toBe(2);
  expect(inventory.activeDevices).toBe(0);
  expect(inventory.revokedDevices).toBe(2);
  expect(inventory.workspaces).toEqual([
    {
      workspaceId: WORKSPACE_ID,
      ownerId: OWNER_ID,
      revision: 2,
      checkpointHash: built.secondHash,
    },
  ]);
  expect(inventory.assets).toEqual([
    {
      workspaceId: WORKSPACE_ID,
      sha256: built.asset.sha256,
      bytes: built.asset.bytes,
    },
  ]);
});

it("rejects conflicting sizes for the same workspace and asset hash", async () => {
  const built = await fixture(async (remote, { assetSha }) => {
    await commit(remote, 2, "three", "op-3", [
      { id: randomUUID(), sha256: assetSha, bytes: 8 },
    ]);
  });
  expectFailure(() => inspect(built.databasePath), "server-history-invalid", 422);
});

it("enforces the JSON byte cap before parsing oversized JSON", async () => {
  const built = await fixture();
  open(built.databasePath, (db) => {
    db.prepare(
      "UPDATE checkpoint_changes SET change_json=? WHERE workspace_id=? AND revision=1",
    ).run("{".repeat(64 * 1024), WORKSPACE_ID);
  });
  expectFailure(
    () => inspect(built.databasePath, { maxJsonBytes: 4096 }),
    "server-history-limit",
    409,
  );
});

it("enforces the row cap from the preflight counts", async () => {
  const built = await fixture();
  const total = countedRows(built.databasePath);
  expect(total).toBeGreaterThan(1);
  expectFailure(
    () => inspect(built.databasePath, { maxRows: total - 1 }),
    "server-history-limit",
    409,
  );
});

it("preserves the source file, query_only state and sidecar layout", async () => {
  const built = await fixture();
  const beforeHash = fileHash(built.databasePath);
  const beforeEntries = readdirSync(built.root).sort();
  const db = new DatabaseSync(pathToFileURL(built.databasePath).href + "?mode=ro&immutable=1", { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON");
    const queryOnly = (): number =>
      Number(
        (
          db.prepare("PRAGMA query_only").get() as {
            query_only: number;
          }
        ).query_only,
      );
    expect(queryOnly()).toBe(1);
    const inventory = inspectServerHistory(db);
    expect(inventory.changes).toBe(2);
    expect(queryOnly()).toBe(1);
  } finally {
    db.close();
  }
  expect(fileHash(built.databasePath)).toBe(beforeHash);
  expect(readdirSync(built.root).sort()).toEqual(beforeEntries);
});
