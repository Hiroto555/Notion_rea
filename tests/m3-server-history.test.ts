import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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
    mkdtempSync(join(realpathSync(tmpdir()), "folio-server-history-")),
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

async function fixture(): Promise<Fixture> {
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

  const asset = {
    id: randomUUID(),
    sha256: "b".repeat(64),
    bytes: 7,
  };
  const loser = await commit(remote, 0, "loser", "op-loser", [asset]);
  expect(loser.status).toBe("conflict");

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

function inspect(databasePath: string, limits?: { maxRows?: number; maxJsonBytes?: number }) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return inspectServerHistory(db, limits);
  } finally {
    db.close();
  }
}

it("returns a fixed summary and gathers assets from losing receipts", async () => {
  const built = await fixture();
  const inventory = inspect(built.databasePath);

  expect(inventory.serverEpoch).toBe(built.serverEpoch);
  expect(inventory.workspaces).toEqual([
    {
      workspaceId: WORKSPACE_ID,
      ownerId: OWNER_ID,
      revision: 2,
      checkpointHash: built.secondHash,
    },
  ]);
  expect(inventory.changes).toBe(2);
  expect(inventory.operations).toBe(3);
  expect(inventory.devices).toBe(2);
  expect(inventory.activeDevices).toBe(1);
  expect(inventory.revokedDevices).toBe(1);
  expect(inventory.assets).toEqual([
    {
      workspaceId: WORKSPACE_ID,
      sha256: built.asset.sha256,
      bytes: built.asset.bytes,
    },
  ]);
  const serialized = JSON.stringify(inventory);
  for (const token of built.tokens)
    expect(serialized).not.toContain(token);
  expect(serialized).not.toContain(built.asset.id);
  expect(serialized).not.toContain("token_hash");
  expect(serialized).not.toContain("payload");
});

it("rejects a corrupt change payload", async () => {
  const built = await fixture();
  open(built.databasePath, (db) => {
    db.prepare(
      "UPDATE checkpoint_changes SET change_json=? WHERE workspace_id=? AND revision=1",
    ).run("not-json", WORKSPACE_ID);
  });
  expectFailure(() => inspect(built.databasePath), "server-history-invalid", 422);
});

it("rejects a corrupt receipt result", async () => {
  const built = await fixture();
  open(built.databasePath, (db) => {
    db.prepare(
      "UPDATE checkpoint_operations SET result_json=? WHERE operation_id=?",
    ).run("{}", "op-1");
  });
  expectFailure(() => inspect(built.databasePath), "server-history-invalid", 422);
});

it("rejects a stored fingerprint that does not match the commit", async () => {
  const built = await fixture();
  open(built.databasePath, (db) => {
    db.prepare(
      "UPDATE checkpoint_operations SET fingerprint=? WHERE operation_id=?",
    ).run("0".repeat(64), "op-1");
  });
  expectFailure(() => inspect(built.databasePath), "server-history-invalid", 422);
});

it("rejects SQL keys that do not match the commit", async () => {
  const built = await fixture();
  open(built.databasePath, (db) => {
    db.prepare(
      "UPDATE checkpoint_operations SET client_id=? WHERE operation_id=?",
    ).run("mismatch", "op-1");
  });
  expectFailure(() => inspect(built.databasePath), "server-history-invalid", 422);
});

it("rejects a change without an applied receipt", async () => {
  const built = await fixture();
  open(built.databasePath, (db) => {
    db.prepare("DELETE FROM checkpoint_operations WHERE operation_id=?").run(
      "op-1",
    );
  });
  expectFailure(() => inspect(built.databasePath), "server-history-invalid", 422);
});

it("rejects a row budget below the stored row count", async () => {
  const built = await fixture();
  expectFailure(
    () => inspect(built.databasePath, { maxRows: 1 }),
    "server-history-limit",
    409,
  );
});

it("rejects a JSON byte cap below the stored payload size", async () => {
  const built = await fixture();
  expectFailure(
    () => inspect(built.databasePath, { maxJsonBytes: 1 }),
    "server-history-limit",
    409,
  );
});
