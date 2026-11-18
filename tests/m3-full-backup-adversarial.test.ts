import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { startCheckpointServer, type CheckpointServerHandle } from "../src/sync/checkpoint-server";
import { CheckpointRemote } from "../src/sync/client";
import { acquireServerDirectoryLease } from "../src/sync/server-directory-lease";
import { createServerFullBackup, restoreServerFullBackup } from "../src/sync/server-full-backup";
import { inspectFullServerBackup } from "../src/sync/server-full-inspection";
import { SERVER_FULL_MANIFEST, SERVER_FULL_MARKER } from "../src/sync/server-full-types";
import { hashCheckpoint, SyncError, type Checkpoint, type Commit } from "../src/sync/protocol";
import { WorkspaceBlobStore } from "../src/sync/workspace-blobs";

const WORKSPACE = "workspace";
const OWNER = "owner";
const WINNER = "winner";
const LOSER = "loser";
const REVOKED = "revoked";
const MARKER_TEXT = "Folio server output is incomplete; do not start or restore it.\n";
const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const BLOB_DIR = sha256(WORKSPACE);

type CoreSnapshot = {
  epoch: string;
  operations: Array<Record<string, unknown>>;
  changes: Array<Record<string, unknown>>;
  heads: Array<Record<string, unknown>>;
  devices: Array<{ clientId: string; ownerId: string; tokenHash: string; revoked: number }>;
};

const roots: string[] = [];
let suiteRoot = "";
let sourceSnapshot: CoreSnapshot;
const fixture = {
  source: "",
  backup: "",
  winnerToken: "",
  loserToken: "",
  oldEpoch: "",
  assetBytes: Buffer.alloc(0),
  assetSha: "",
  assetId: "",
  headHash: "",
  counts: { changes: 0, operations: 0, devices: 0, activeDevices: 0, revokedDevices: 0 },
};

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function checkpoint(text: string, assets: Checkpoint["assets"] = []): Checkpoint {
  return { format: "folio-checkpoint/v1", name: "test-fixture", version: 1, payload: { text }, assets };
}

function validateFixture(value: Checkpoint): boolean {
  if (value.name !== "test-fixture" || value.version !== 1 || typeof value.payload.text !== "string")
    throw new Error("fixture schema");
  return true;
}

function commitOf(
  clientId: string,
  operationId: string,
  baseRevision: number,
  serverEpoch: string,
  value: Checkpoint,
): Commit {
  return {
    protocol: 1,
    workspaceId: WORKSPACE,
    clientId,
    operationId,
    serverEpoch,
    baseRevision,
    checkpointHash: hashCheckpoint(value),
    checkpoint: value,
  };
}

function readCore(databasePath: string): CoreSnapshot {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const all = (sql: string): Array<Record<string, unknown>> =>
      db.prepare(sql).all() as Array<Record<string, unknown>>;
    const identity = db
      .prepare("SELECT epoch FROM checkpoint_server_identity WHERE singleton=1")
      .get() as { epoch: unknown };
    return {
      epoch: String(identity.epoch),
      operations: all(
        "SELECT workspace_id,client_id,operation_id,fingerprint,commit_json,result_json FROM checkpoint_operations ORDER BY client_id,operation_id",
      ),
      changes: all("SELECT workspace_id,revision,change_json FROM checkpoint_changes ORDER BY revision"),
      heads: all(
        "SELECT workspace_id,owner_id,revision,checkpoint_hash,checkpoint_json FROM checkpoint_heads ORDER BY workspace_id",
      ),
      devices: all(
        "SELECT client_id,owner_id,token_hash,revoked FROM checkpoint_devices ORDER BY client_id",
      ).map((row) => ({
        clientId: String(row.client_id),
        ownerId: String(row.owner_id),
        tokenHash: String(row.token_hash),
        revoked: Number(row.revoked),
      })),
    };
  } finally {
    db.close();
  }
}

function failure(action: () => unknown): SyncError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SyncError);
    return error as SyncError;
  }
  throw new Error("expected an operation to fail");
}

function makeBackup(label: string): ReturnType<typeof createServerFullBackup> {
  const lease = acquireServerDirectoryLease(fixture.source);
  try {
    return createServerFullBackup({
      sourceDirectory: fixture.source,
      destination: join(suiteRoot, `backup-${label}`),
      lease,
    });
  } finally {
    lease.close();
  }
}

function copySource(label: string): string {
  const root = join(suiteRoot, label);
  mkdirSync(root, { mode: 0o700 });
  for (const name of readdirSync(fixture.source)) {
    if (name === ".folio-server-lock.sqlite" || name === SERVER_FULL_MARKER || name.startsWith("server.sqlite-"))
      continue;
    cpSync(join(fixture.source, name), join(root, name), { recursive: true });
  }
  chmodSync(root, 0o700);
  chmodSync(join(root, "blobs"), 0o700);
  chmodSync(join(root, "blobs", BLOB_DIR), 0o700);
  return realpathSync(root);
}

function snapshotBackup(root: string): { listing: string[]; blobListing: string[]; files: Buffer[] } {
  return {
    listing: readdirSync(root).sort(),
    blobListing: readdirSync(join(root, "blobs", BLOB_DIR)).sort(),
    files: [SERVER_FULL_MANIFEST, "server.sqlite", `blobs/${BLOB_DIR}/${fixture.assetSha}`].map((path) =>
      readFileSync(join(root, path)),
    ),
  };
}

function armCommitFault(mode: "before" | "after"): void {
  const native = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
    const statement = String(sql);
    if (!statement.includes("COMMIT")) return native.call(this, sql);
    if (mode === "before") throw new Error("inject-before-destination-commit");
    native.call(this, sql);
    throw new Error("inject-after-destination-commit");
  });
}

function expectMarker(destination: string): void {
  expect(existsSync(join(destination, SERVER_FULL_MARKER))).toBe(true);
  expect(readFileSync(join(destination, SERVER_FULL_MARKER), "utf8")).toBe(MARKER_TEXT);
  expect(existsSync(join(destination, "restore-receipt.json"))).toBe(false);
  expect(existsSync(join(destination, SERVER_FULL_MANIFEST))).toBe(false);
}

async function expectRestoredServer(destination: string, serverEpoch: string): Promise<void> {
  let server: CheckpointServerHandle | undefined;
  try {
    server = await startCheckpointServer({
      databasePath: join(destination, "server.sqlite"),
      capabilities: [],
      workspaces: [{ workspaceId: WORKSPACE, ownerId: OWNER }],
      validateCheckpoint: validateFixture,
    });
    const stale = new CheckpointRemote({ baseUrl: server.url, workspaceId: WORKSPACE, token: fixture.winnerToken });
    await expect(stale.head()).rejects.toMatchObject({ code: "unauthorized" });
    expect(() =>
      server!.registerDevice({ workspaceId: WORKSPACE, ownerId: OWNER, clientId: WINNER, token: fixture.winnerToken }),
    ).toThrow(/device-revoked/);
    const fresh = randomBytes(32).toString("hex");
    server.registerDevice({ workspaceId: WORKSPACE, ownerId: OWNER, clientId: "after", token: fresh });
    const head = await new CheckpointRemote({ baseUrl: server.url, workspaceId: WORKSPACE, token: fresh }).head();
    expect(head.serverEpoch).toBe(serverEpoch);
    expect(head.head).toMatchObject({ revision: 2, checkpointHash: fixture.headHash });
  } finally {
    if (server) await server.close();
  }
}

beforeAll(async () => {
  suiteRoot = tempRoot("folio-full-adversarial-");
  const source = join(suiteRoot, "source");
  mkdirSync(source, { mode: 0o700 });
  fixture.source = realpathSync(source);
  fixture.winnerToken = randomBytes(32).toString("hex");
  fixture.loserToken = randomBytes(32).toString("hex");
  const revokedToken = randomBytes(32).toString("hex");
  const server = await startCheckpointServer({
    databasePath: join(fixture.source, "server.sqlite"),
    capabilities: [],
    workspaces: [{ workspaceId: WORKSPACE, ownerId: OWNER }],
    validateCheckpoint: validateFixture,
    blobs: new WorkspaceBlobStore(join(fixture.source, "blobs")),
  });
  try {
    server.registerDevice({ workspaceId: WORKSPACE, ownerId: OWNER, clientId: WINNER, token: fixture.winnerToken });
    server.registerDevice({ workspaceId: WORKSPACE, ownerId: OWNER, clientId: LOSER, token: fixture.loserToken });
    server.registerDevice({ workspaceId: WORKSPACE, ownerId: OWNER, clientId: REVOKED, token: revokedToken });
    server.revokeDevice(WORKSPACE, REVOKED);

    const winner = new CheckpointRemote({ baseUrl: server.url, workspaceId: WORKSPACE, token: fixture.winnerToken });
    const one = checkpoint("one");
    const first = await winner.commit(commitOf(WINNER, "op-1", 0, server.serverEpoch, one));
    expect(first.status).toBe("applied");
    const two = checkpoint("two");
    const second = await winner.commit(commitOf(WINNER, "op-2", 1, server.serverEpoch, two));
    expect(second.status).toBe("applied");
    fixture.headHash = hashCheckpoint(two);

    fixture.assetBytes = Buffer.from("receipt-only historical attachment");
    fixture.assetSha = sha256(fixture.assetBytes);
    fixture.assetId = randomUUID();
    const put = await fetch(`${server.url}/v1/workspaces/${WORKSPACE}/blobs/${fixture.assetSha}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${fixture.loserToken}`, "Content-Type": "application/octet-stream" },
      body: fixture.assetBytes,
    });
    expect(put.status).toBe(201);
    await put.arrayBuffer();

    const loser = new CheckpointRemote({ baseUrl: server.url, workspaceId: WORKSPACE, token: fixture.loserToken });
    const stale = checkpoint("losing-candidate", [
      { id: fixture.assetId, sha256: fixture.assetSha, bytes: fixture.assetBytes.length },
    ]);
    const conflict = await loser.commit(commitOf(LOSER, "op-loser", 0, server.serverEpoch, stale));
    expect(conflict.status).toBe("conflict");
    fixture.oldEpoch = server.serverEpoch;
  } finally {
    await server.close();
  }

  sourceSnapshot = readCore(join(fixture.source, "server.sqlite"));
  dependsOnReceiptOnlyAsset(sourceSnapshot);
  const created = makeBackup("shared");
  fixture.backup = created.destination;
  fixture.counts = created.manifest.counts;
});

function dependsOnReceiptOnlyAsset(snapshot: CoreSnapshot): void {
  const loser = snapshot.operations.find((row) => row.operation_id === "op-loser");
  expect(loser).toBeDefined();
  const result = JSON.parse(String(loser!.result_json)) as { status: string; head: { revision: number } };
  expect(result.status).toBe("conflict");
  expect(result.head.revision).toBe(2);
  const commit = JSON.parse(String(loser!.commit_json)) as { baseRevision: number; checkpoint: Checkpoint };
  expect(commit.baseRevision).toBe(0);
  expect(commit.checkpoint.assets).toEqual([
    { id: fixture.assetId, sha256: fixture.assetSha, bytes: fixture.assetBytes.length },
  ]);
  const heads = snapshot.heads.filter((head) => head.revision !== 0);
  expect(heads).toHaveLength(1);
  expect(heads[0].revision).toBe(2);
  expect(JSON.parse(String(heads[0].checkpoint_json)).assets).toEqual([]);
  expect(snapshot.changes).toHaveLength(2);
  for (const change of snapshot.changes) {
    expect((JSON.parse(String(change.change_json)) as { checkpoint: Checkpoint }).checkpoint.assets).toEqual([]);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it(
  "backs up the receipt-only attachment and restores two independent revoked epochs without rewriting history",
  async () => {
    expect(readCore(join(fixture.source, "server.sqlite"))).toEqual(sourceSnapshot);
    expect(readFileSync(join(fixture.source, `blobs/${BLOB_DIR}/${fixture.assetSha}`))).toEqual(fixture.assetBytes);

    const manifest = inspectFullServerBackup(fixture.backup);
    expect(manifest.serverEpoch).toBe(fixture.oldEpoch);
    expect(manifest.counts).toEqual(fixture.counts);
    expect(manifest.assets).toEqual([
      {
        workspaceId: WORKSPACE,
        sha256: fixture.assetSha,
        bytes: fixture.assetBytes.length,
        path: `blobs/${BLOB_DIR}/${fixture.assetSha}`,
      },
    ]);
    expect(manifest.workspaces).toEqual([
      { workspaceId: WORKSPACE, ownerId: OWNER, revision: 2, checkpointHash: fixture.headHash },
    ]);
    const backupCore = readCore(join(fixture.backup, "server.sqlite"));
    expect(backupCore.operations).toEqual(sourceSnapshot.operations);
    expect(backupCore.changes).toEqual(sourceSnapshot.changes);
    expect(backupCore.heads).toEqual(sourceSnapshot.heads);
    expect(backupCore.devices).toEqual(sourceSnapshot.devices);
    expect(readFileSync(join(fixture.backup, `blobs/${BLOB_DIR}/${fixture.assetSha}`))).toEqual(fixture.assetBytes);

    const first = restoreServerFullBackup({
      backupDirectory: fixture.backup,
      destination: join(suiteRoot, "restore-first"),
      port: 17801,
    });
    const second = restoreServerFullBackup({
      backupDirectory: fixture.backup,
      destination: join(suiteRoot, "restore-second"),
      port: 17802,
    });
    expect(first.previousEpoch).toBe(fixture.oldEpoch);
    expect(second.previousEpoch).toBe(fixture.oldEpoch);
    expect(first.serverEpoch).not.toBe(fixture.oldEpoch);
    expect(second.serverEpoch).not.toBe(fixture.oldEpoch);
    expect(first.serverEpoch).not.toBe(second.serverEpoch);

    for (const restored of [first, second]) {
      const core = readCore(join(restored.destination, "server.sqlite"));
      expect(core.epoch).toBe(restored.serverEpoch);
      expect(core.operations).toEqual(sourceSnapshot.operations);
      expect(core.changes).toEqual(sourceSnapshot.changes);
      expect(core.heads).toEqual(sourceSnapshot.heads);
      expect(core.devices).toEqual(sourceSnapshot.devices.map((device) => ({ ...device, revoked: 1 })));
      expect(core.devices.filter((device) => device.revoked === 0)).toHaveLength(0);
    }

    await expectRestoredServer(first.destination, first.serverEpoch);
    await expectRestoredServer(second.destination, second.serverEpoch);
    expect(readCore(join(fixture.source, "server.sqlite"))).toEqual(sourceSnapshot);
  },
  30_000,
);

it(
  "blocks a missing or wrong receipt-only attachment and retains an incomplete destination",
  () => {
    for (const mode of ["missing", "wrong"] as const) {
      const copy = copySource(`source-${mode}-asset`);
      const assetPath = join(copy, `blobs/${BLOB_DIR}/${fixture.assetSha}`);
      if (mode === "missing") rmSync(assetPath);
      else writeFileSync(assetPath, Buffer.alloc(fixture.assetBytes.length, 0x41), { mode: 0o600 });
      const destination = join(suiteRoot, `destination-${mode}-asset`);
      const lease = acquireServerDirectoryLease(copy);
      try {
        const error = failure(() =>
          createServerFullBackup({ sourceDirectory: copy, destination, lease }),
        );
        expect(error.code).toBe(mode === "missing" ? "server-file-unsafe" : "server-file-mismatch");
      } finally {
        lease.close();
      }
      expect(existsSync(destination)).toBe(true);
      expectMarker(destination);
      expect(readCore(join(copy, "server.sqlite"))).toEqual(sourceSnapshot);
    }
  },
  20_000,
);

it(
  "never overwrites an existing destination and forbids a destination nested in the source",
  () => {
    const existing = join(suiteRoot, "existing-destination");
    mkdirSync(existing, { mode: 0o700 });
    writeFileSync(join(existing, "sentinel.txt"), "keep-me", { mode: 0o600 });
    const existingLease = acquireServerDirectoryLease(fixture.source);
    try {
      const error = failure(() =>
        createServerFullBackup({ sourceDirectory: fixture.source, destination: existing, lease: existingLease }),
      );
      expect(error.code).toBe("server-full-destination-exists");
    } finally {
      existingLease.close();
    }
    expect(readFileSync(join(existing, "sentinel.txt"), "utf8")).toBe("keep-me");
    expect(existsSync(join(existing, SERVER_FULL_MARKER))).toBe(false);

    const nested = join(fixture.source, "nested-destination");
    const nestedLease = acquireServerDirectoryLease(fixture.source);
    try {
      const error = failure(() =>
        createServerFullBackup({ sourceDirectory: fixture.source, destination: nested, lease: nestedLease }),
      );
      expect(error.code).toBe("server-full-destination");
    } finally {
      nestedLease.close();
    }
    expect(existsSync(nested)).toBe(false);
    expect(readCore(join(fixture.source, "server.sqlite"))).toEqual(sourceSnapshot);
  },
  20_000,
);

it(
  "refuses a second source lease and refuses a source carrying the incomplete marker",
  () => {
    const first = acquireServerDirectoryLease(fixture.source);
    try {
      const error = failure(() => acquireServerDirectoryLease(fixture.source));
      expect(error.code).toBe("server-maintenance-busy");
      expect(error.status).toBe(409);
    } finally {
      first.close();
    }

    const copy = copySource("source-marked-incomplete");
    writeFileSync(join(copy, SERVER_FULL_MARKER), MARKER_TEXT, { mode: 0o600 });
    const destination = join(suiteRoot, "destination-marked-incomplete");
    const lease = acquireServerDirectoryLease(copy);
    try {
      const error = failure(() =>
        createServerFullBackup({ sourceDirectory: copy, destination, lease }),
      );
      expect(error.code).toBe("server-full-incomplete");
      expect(error.status).toBe(409);
    } finally {
      lease.close();
    }
    expect(existsSync(destination)).toBe(false);
    expect(readCore(join(copy, "server.sqlite"))).toEqual(sourceSnapshot);
  },
  20_000,
);

it(
  "keeps the destination incomplete and the source untouched when the epoch COMMIT fails before SQLite",
  () => {
    const before = snapshotBackup(fixture.backup);
    const destination = join(suiteRoot, "restore-fault-before-commit");
    armCommitFault("before");
    const error = failure(() =>
      restoreServerFullBackup({ backupDirectory: fixture.backup, destination, port: 17811 }),
    );
    vi.restoreAllMocks();
    expect(error.code).toBe("server-full-write-failed");
    expect(error.status).toBe(500);
    expectMarker(destination);
    const core = readCore(join(destination, "server.sqlite"));
    expect(core.epoch).toBe(fixture.oldEpoch);
    expect(core.devices).toEqual(sourceSnapshot.devices);
    expect(snapshotBackup(fixture.backup)).toEqual(before);
    expect(readCore(join(fixture.source, "server.sqlite"))).toEqual(sourceSnapshot);
  },
  20_000,
);

it(
  "keeps the destination incomplete and the source untouched when the epoch COMMIT fails after SQLite",
  () => {
    const before = snapshotBackup(fixture.backup);
    const destination = join(suiteRoot, "restore-fault-after-commit");
    armCommitFault("after");
    const error = failure(() =>
      restoreServerFullBackup({ backupDirectory: fixture.backup, destination, port: 17812 }),
    );
    vi.restoreAllMocks();
    expect(error.code).toBe("server-full-write-failed");
    expect(error.status).toBe(500);
    expectMarker(destination);
    const core = readCore(join(destination, "server.sqlite"));
    expect(core.epoch).not.toBe(fixture.oldEpoch);
    expect(core.devices).toEqual(sourceSnapshot.devices.map((device) => ({ ...device, revoked: 1 })));
    expect(snapshotBackup(fixture.backup)).toEqual(before);
    expect(readCore(join(fixture.source, "server.sqlite"))).toEqual(sourceSnapshot);
  },
  20_000,
);
