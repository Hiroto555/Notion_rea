import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { durableFs } from "../src/persistence/durable-file";
import { CheckpointRemote } from "../src/sync/client";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import {
  hashCheckpoint,
  type Checkpoint,
  type Commit,
} from "../src/sync/protocol";
import {
  CHECKPOINT_SERVER_BACKUP_DATABASE,
  CHECKPOINT_SERVER_BACKUP_FORMAT,
  CHECKPOINT_SERVER_BACKUP_MANIFEST,
  CHECKPOINT_SERVER_BACKUP_MARKER,
  assertServerBackupCapacity,
  createCheckpointServerBackup,
  type CheckpointServerBackupManifest,
} from "../src/sync/server-backup";

const WORKSPACE_ID = "workspace";
const OWNER_ID = "owner";
const CLIENT_ID = "client-a";
const roots: string[] = [];
const servers = new Set<
  Awaited<ReturnType<typeof startCheckpointServer>>
>();
const nativeWriteFile = durableFs.writeFileSync;

afterEach(async () => {
  durableFs.writeFileSync = nativeWriteFile;
  for (const server of servers) {
    try {
      await server.close();
    } catch {
      // A failed test already reports the actionable failure.
    }
  }
  servers.clear();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "folio-server-backup-")),
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

type RunningServer = Awaited<ReturnType<typeof startCheckpointServer>>;

async function boot(
  root: string,
  options: { deviceMode?: boolean; databasePath?: string } = {},
): Promise<{ server: RunningServer; token: string; databasePath: string }> {
  const token = randomBytes(32).toString("base64url");
  const databasePath = options.databasePath ?? join(root, "server.sqlite");
  const server = await startCheckpointServer({
    databasePath,
    capabilities: options.deviceMode
      ? []
      : [{ workspaceId: WORKSPACE_ID, ownerId: OWNER_ID, token }],
    ...(options.deviceMode
      ? { workspaces: [{ workspaceId: WORKSPACE_ID, ownerId: OWNER_ID }] }
      : {}),
    validateCheckpoint,
  });
  servers.add(server);
  if (options.deviceMode)
    server.registerDevice({
      workspaceId: WORKSPACE_ID,
      ownerId: OWNER_ID,
      clientId: CLIENT_ID,
      token,
    });
  return { server, token, databasePath };
}

function checkpoint(text: string): Checkpoint {
  return {
    format: "folio-checkpoint/v1",
    name: "test-fixture",
    version: 1,
    payload: { text },
    assets: [],
  };
}

async function commit(
  server: RunningServer,
  token: string,
  baseRevision: number,
  text: string,
  operationId: string,
): Promise<{ serverEpoch: string; checkpointHash: string }> {
  const remote = new CheckpointRemote({
    baseUrl: server.url,
    workspaceId: WORKSPACE_ID,
    token,
  });
  const head = await remote.head();
  expect(head.head.revision).toBe(baseRevision);
  const value = checkpoint(text);
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
  expect(result.status).toBe("applied");
  return { serverEpoch: head.serverEpoch, checkpointHash: operation.checkpointHash };
}

it("creates a verified catalog backup while the server remains active", async () => {
  const root = tempRoot();
  const { server, token, databasePath } = await boot(root, {
    deviceMode: true,
  });
  await commit(server, token, 0, "one", "op-1");
  const second = await commit(server, token, 1, "two", "op-2");

  const destination = join(root, "catalog-backup");
  const backup = server.backup(destination);
  expect(backup.destination).toBe(destination);

  const manifestPath = join(
    destination,
    CHECKPOINT_SERVER_BACKUP_MANIFEST,
  );
  const manifestText = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(
    manifestText,
  ) as CheckpointServerBackupManifest;
  expect(manifest.format).toBe(CHECKPOINT_SERVER_BACKUP_FORMAT);
  expect(manifest.version).toBe(1);
  expect(manifest.serverEpoch).toBe(second.serverEpoch);
  expect(manifest.scope).toBe("catalog");
  expect(manifest.counts).toEqual({
    workspaces: 1,
    changes: 2,
    operations: 2,
    devices: 1,
    activeDevices: 1,
    revokedDevices: 0,
  });
  expect(manifest.workspaces).toEqual([
    {
      workspaceId: WORKSPACE_ID,
      revision: 2,
      checkpointHash: second.checkpointHash,
    },
  ]);
  expect(manifest.attachments).toEqual({
    included: false,
    headAssetReferences: 0,
  });
  expect(manifestText).not.toContain(token);

  const snapshotPath = join(
    destination,
    CHECKPOINT_SERVER_BACKUP_DATABASE,
  );
  const snapshotBytes = readFileSync(snapshotPath);
  expect(manifest.database).toEqual({
    path: CHECKPOINT_SERVER_BACKUP_DATABASE,
    bytes: snapshotBytes.length,
    sha256: createHash("sha256").update(snapshotBytes).digest("hex"),
  });
  expect(snapshotBytes.includes(Buffer.from(token))).toBe(false);

  const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    expect(
      (snapshot.prepare("PRAGMA integrity_check").all() as Record<
        string,
        unknown
      >[]),
    ).toEqual([{ integrity_check: "ok" }]);
    expect(
      snapshot
        .prepare(
          "SELECT epoch FROM checkpoint_server_identity WHERE singleton=1",
        )
        .get(),
    ).toEqual({ epoch: second.serverEpoch });
    expect(
      snapshot
        .prepare(
          "SELECT revision, checkpoint_hash FROM checkpoint_heads WHERE workspace_id=?",
        )
        .get(WORKSPACE_ID),
    ).toEqual({
      revision: 2,
      checkpoint_hash: second.checkpointHash,
    });
    expect(
      snapshot
        .prepare("SELECT COUNT(*) AS count FROM checkpoint_changes")
        .get(),
    ).toEqual({ count: 2 });
    expect(
      snapshot
        .prepare("SELECT COUNT(*) AS count FROM checkpoint_operations")
        .get(),
    ).toEqual({ count: 2 });
    expect(
      snapshot
        .prepare("SELECT COUNT(*) AS count FROM checkpoint_devices")
        .get(),
    ).toEqual({ count: 1 });
  } finally {
    snapshot.close();
  }

  expect(
    existsSync(join(destination, CHECKPOINT_SERVER_BACKUP_MARKER)),
  ).toBe(false);
  if (process.platform !== "win32") {
    expect(lstatSync(destination).mode & 0o777).toBe(0o700);
    expect(lstatSync(snapshotPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(manifestPath).mode & 0o777).toBe(0o600);
  }

  const third = await commit(server, token, 2, "three", "op-3");
  const next = server.backup(join(root, "catalog-backup-2"));
  expect(next.manifest.workspaces).toEqual([
    {
      workspaceId: WORKSPACE_ID,
      revision: 3,
      checkpointHash: third.checkpointHash,
    },
  ]);
  expect(manifest.workspaces).toEqual([
    {
      workspaceId: WORKSPACE_ID,
      revision: 2,
      checkpointHash: second.checkpointHash,
    },
  ]);
  expect(lstatSync(databasePath).isFile()).toBe(true);
});

it("never overwrites existing paths or follows destination symlinks", async () => {
  const root = tempRoot();
  const { server, token } = await boot(root);

  const existing = join(root, "existing");
  mkdirSync(existing);
  const sentinel = join(existing, "sentinel");
  writeFileSync(sentinel, "keep");
  expect(() => server.backup(existing)).toThrow(
    "backup-destination-exists",
  );
  expect(readFileSync(sentinel, "utf8")).toBe("keep");

  const actual = join(root, "actual");
  mkdirSync(actual);
  const actualSentinel = join(actual, "sentinel");
  writeFileSync(actualSentinel, "keep");
  const link = join(root, "link");
  symlinkSync(actual, link, "dir");
  expect(() => server.backup(link)).toThrow("backup-destination-exists");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readFileSync(actualSentinel, "utf8")).toBe("keep");

  const dangling = join(root, "dangling");
  symlinkSync(join(root, "missing"), dangling, "dir");
  expect(() => server.backup(dangling)).toThrow(
    "backup-destination-exists",
  );
  expect(lstatSync(dangling).isSymbolicLink()).toBe(true);

  const regular = join(root, "regular");
  writeFileSync(regular, "keep");
  expect(() => server.backup(regular)).toThrow(
    "backup-destination-exists",
  );
  expect(readFileSync(regular, "utf8")).toBe("keep");

  expect(() =>
    server.backup(join(root, "missing-parent", "backup")),
  ).toThrow("invalid-backup-destination");
  expect(existsSync(join(root, "missing-parent"))).toBe(false);

  expect(() => server.backup(join(root, "server.sqlite"))).toThrow(
    "backup-destination-exists",
  );

  const response = await fetch(
    `${server.url}/v1/workspaces/${WORKSPACE_ID}/backup`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "not-found" });
});

it("marks attachment references as excluded instead of claiming completeness", async () => {
  const root = tempRoot();
  const token = randomBytes(32).toString("base64url");
  const server = await startCheckpointServer({
    databasePath: join(root, "server.sqlite"),
    capabilities: [{ workspaceId: WORKSPACE_ID, ownerId: OWNER_ID, token }],
    validateCheckpoint,
    blobs: {
      has: () => true,
      handle: async () => {},
    },
  });
  servers.add(server);

  const remote = new CheckpointRemote({
    baseUrl: server.url,
    workspaceId: WORKSPACE_ID,
    token,
  });
  const head = await remote.head();
  const value: Checkpoint = {
    ...checkpoint("with asset"),
    assets: [{ id: randomUUID(), sha256: "a".repeat(64), bytes: 1 }],
  };
  const operation: Commit = {
    protocol: 1,
    workspaceId: WORKSPACE_ID,
    clientId: CLIENT_ID,
    operationId: "op-asset",
    serverEpoch: head.serverEpoch,
    baseRevision: 0,
    checkpointHash: hashCheckpoint(value),
    checkpoint: value,
  };
  expect((await remote.commit(operation)).status).toBe("applied");

  const backup = server.backup(join(root, "asset-backup"));
  expect(backup.manifest.attachments).toEqual({
    included: false,
    headAssetReferences: 1,
  });
  expect(backup.manifest.counts.changes).toBe(1);
});

it("leaves a marked partial snapshot when manifest publication is interrupted", async () => {
  const root = tempRoot();
  const { server, token } = await boot(root);
  await commit(server, token, 0, "one", "op-1");
  const destination = join(root, "interrupted");

  const original = durableFs.writeFileSync;
  durableFs.writeFileSync = ((
    ...args: Parameters<typeof original>
  ) => {
    const data = args[1];
    const text =
      typeof data === "string"
        ? data
        : Buffer.from(
            data.buffer,
            data.byteOffset,
            data.byteLength,
          ).toString("utf8");
    if (text.includes(CHECKPOINT_SERVER_BACKUP_FORMAT))
      throw new Error("injected manifest write failure");
    return original(...args);
  }) as unknown as typeof durableFs.writeFileSync;
  try {
    expect(() => server.backup(destination)).toThrow(
      "injected manifest write failure",
    );
  } finally {
    durableFs.writeFileSync = original;
  }

  expect(
    existsSync(join(destination, CHECKPOINT_SERVER_BACKUP_MARKER)),
  ).toBe(true);
  expect(
    existsSync(join(destination, CHECKPOINT_SERVER_BACKUP_MANIFEST)),
  ).toBe(false);
  expect(
    lstatSync(join(destination, CHECKPOINT_SERVER_BACKUP_DATABASE)).isFile(),
  ).toBe(true);

  const retry = server.backup(join(root, "retry"));
  expect(retry.manifest.workspaces[0].revision).toBe(1);
});

it("refuses to start while the source connection is in a transaction", () => {
  const root = tempRoot();
  const databasePath = join(root, "server.sqlite");
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("BEGIN IMMEDIATE");
    const destination = join(root, "busy");
    expect(() =>
      createCheckpointServerBackup({
        db,
        databasePath,
        destination,
        serverEpoch: "epoch",
      }),
    ).toThrow("server-backup-busy");
    expect(existsSync(destination)).toBe(false);
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
});

it("refuses a source path that does not belong to the SQLite handle", () => {
  const root = tempRoot();
  const first = new DatabaseSync(join(root, "first.sqlite"));
  const second = new DatabaseSync(join(root, "second.sqlite"));
  try {
    const destination = join(root, "backup");
    expect(() => createCheckpointServerBackup({db: first, databasePath: join(root, "second.sqlite"),
      destination, serverEpoch: "epoch"})).toThrow("unsafe-backup-source");
    expect(existsSync(destination)).toBe(false);
  } finally {first.close(); second.close();}
});

it("refuses an unexpected server epoch before creating output", async () => {
  const root = tempRoot();
  const {databasePath} = await boot(root);
  const db = new DatabaseSync(databasePath);
  try {
    const destination = join(root, "wrong-epoch");
    expect(() => createCheckpointServerBackup({db, databasePath, destination, serverEpoch: "wrong-epoch"}))
      .toThrow("server-backup-epoch-mismatch");
    expect(existsSync(destination)).toBe(false);
  } finally {db.close();}
});

it("fails closed on low or unknown disk capacity before starting a snapshot", () => {
  const root = tempRoot();
  const db = new DatabaseSync(join(root, "source.sqlite"));
  try {
    const checked: string[] = [];
    expect(() => assertServerBackupCapacity(db, [root], () => ({bsize: 4096n, bavail: 1n})))
      .toThrow("insufficient-storage");
    const destination = join(root, "rejected");
    expect(() => createCheckpointServerBackup({db, databasePath: join(root, "source.sqlite"),
      destination, serverEpoch: "epoch", capacityProbe: () => ({bsize: 4096n, bavail: 1n})}))
      .toThrow("insufficient-storage");
    expect(existsSync(destination)).toBe(false);
    expect(() => assertServerBackupCapacity(db, [root], () => {throw new Error("private path");}))
      .toThrow("server-backup-capacity-unknown");
    expect(() => assertServerBackupCapacity(db, [root, root], (path) => {
      checked.push(path); return {bsize: 4096n, bavail: 1_000_000n};
    })).not.toThrow();
    expect(checked).toEqual([root, root]);
  } finally {db.close();}
});

it("refuses a symlinked live database as a backup source", async () => {
  const root = tempRoot();
  const token = randomBytes(32).toString("base64url");
  const real = join(root, "real.sqlite");
  const first = await startCheckpointServer({
    databasePath: real,
    capabilities: [{ workspaceId: WORKSPACE_ID, ownerId: OWNER_ID, token }],
    validateCheckpoint,
  });
  await first.close();
  const linked = join(root, "linked.sqlite");
  symlinkSync(real, linked);
  const server = await startCheckpointServer({
    databasePath: linked,
    capabilities: [{ workspaceId: WORKSPACE_ID, ownerId: OWNER_ID, token }],
    validateCheckpoint,
  });
  servers.add(server);

  const destination = join(root, "backup");
  expect(() => server.backup(destination)).toThrow(
    "unsafe-backup-source",
  );
  expect(existsSync(destination)).toBe(false);
});
