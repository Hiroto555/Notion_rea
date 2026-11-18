import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { durableFs } from "../src/persistence/durable-file";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import { CheckpointRemote } from "../src/sync/client";
import { acquireServerDirectoryLease } from "../src/sync/server-directory-lease";
import { createServerFullBackup, restoreServerFullBackup } from "../src/sync/server-full-backup";
import { startOperationalServer } from "../src/sync/operational-server";
import { SERVER_FULL_MANIFEST, SERVER_FULL_MARKER } from "../src/sync/server-full-types";
import { hashCheckpoint, SyncError, type Checkpoint, type Commit } from "../src/sync/protocol";
import { WorkspaceBlobStore } from "../src/sync/workspace-blobs";

const WORKSPACE = "workspace";
const OWNER = "owner";
const WINNER = "winner";
const LOSER = "loser";
const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const BLOB_DIR = sha256(WORKSPACE);

const roots: string[] = [];
let suiteRoot = "";
const fixture = {
  source: "",
  backup: "",
  winnerToken: "",
  loserToken: "",
  assetBytes: Buffer.alloc(0),
  assetSha: "",
  assetId: "",
  headHash: "",
};

type SyncEvent = { path: string; markerPresent: boolean };

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

function expectSyncedBeforePublication(destination: string, events: SyncEvent[]): void {
  const required = [destination, join(destination, "blobs"), join(destination, "blobs", BLOB_DIR)];
  for (const directory of required) {
    const hits = events.filter((event) => event.path === directory);
    expect(hits.length, `syncPath(${directory}) was never called`).toBeGreaterThan(0);
    expect(
      hits.some((event) => event.markerPresent),
      `syncPath(${directory}) must run before the marker is unlinked`,
    ).toBe(true);
    if (directory !== destination) {
      expect(
        hits.every((event) => event.markerPresent),
        `syncPath(${directory}) must not run after publication`,
      ).toBe(true);
    }
  }
}

beforeAll(async () => {
  suiteRoot = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "folio-full-dirsync-")));
  chmodSync(suiteRoot, 0o700);
  roots.push(suiteRoot);
  const source = join(suiteRoot, "source");
  mkdirSync(source, { mode: 0o700 });
  fixture.source = realpathSync(source);
  fixture.winnerToken = randomBytes(32).toString("hex");
  fixture.loserToken = randomBytes(32).toString("hex");
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
    const winner = new CheckpointRemote({ baseUrl: server.url, workspaceId: WORKSPACE, token: fixture.winnerToken });
    const one = checkpoint("one");
    expect((await winner.commit(commitOf(WINNER, "op-1", 0, server.serverEpoch, one))).status).toBe("applied");
    const two = checkpoint("two");
    expect((await winner.commit(commitOf(WINNER, "op-2", 1, server.serverEpoch, two))).status).toBe("applied");
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
    expect((await loser.commit(commitOf(LOSER, "op-loser", 0, server.serverEpoch, stale))).status).toBe("conflict");
  } finally {
    await server.close();
  }

  const lease = acquireServerDirectoryLease(fixture.source);
  try {
    fixture.backup = createServerFullBackup({
      sourceDirectory: fixture.source,
      destination: join(suiteRoot, "backup"),
      lease,
    }).destination;
  } finally {
    lease.close();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it(
  "fsyncs destination, blobs and the workspace hash directory before publishing a backup and a restore",
  async () => {
    let marker = "";
    const events: SyncEvent[] = [];
    const original = durableFs.syncPath;
    vi.spyOn(durableFs, "syncPath").mockImplementation((path: string) => {
      events.push({ path, markerPresent: marker !== "" && existsSync(marker) });
      return original.call(durableFs, path);
    });

    const backupDestination = join(suiteRoot, "backup-sync");
    marker = join(backupDestination, SERVER_FULL_MARKER);
    const lease = acquireServerDirectoryLease(fixture.source);
    let backupManifest;
    try {
      backupManifest = createServerFullBackup({
        sourceDirectory: fixture.source,
        destination: backupDestination,
        lease,
      }).manifest;
    } finally {
      lease.close();
    }
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(backupDestination, SERVER_FULL_MANIFEST))).toBe(true);
    expectSyncedBeforePublication(backupDestination, events);
    expect(backupManifest.assets).toEqual([
      {
        workspaceId: WORKSPACE,
        sha256: fixture.assetSha,
        bytes: fixture.assetBytes.length,
        path: `blobs/${BLOB_DIR}/${fixture.assetSha}`,
      },
    ]);
    expect(readFileSync(join(backupDestination, `blobs/${BLOB_DIR}/${fixture.assetSha}`))).toEqual(fixture.assetBytes);

    events.length = 0;
    const restoreDestination = join(suiteRoot, "restore-sync");
    marker = join(restoreDestination, SERVER_FULL_MARKER);
    const restored = restoreServerFullBackup({
      backupDirectory: backupDestination,
      destination: restoreDestination,
      port: 17901,
    });
    expect(existsSync(marker)).toBe(false);
    expectSyncedBeforePublication(restored.destination, events);
    expect(readFileSync(join(restored.destination, `blobs/${BLOB_DIR}/${fixture.assetSha}`))).toEqual(
      fixture.assetBytes,
    );
  },
  30_000,
);

it(
  "refuses to start a restored server when a required blob is missing and leaves the backup unchanged",
  async () => {
    const snapshotBackup = () => ({
      listing: readdirSync(fixture.backup).sort(),
      files: [SERVER_FULL_MANIFEST, "server.sqlite", `blobs/${BLOB_DIR}/${fixture.assetSha}`].map((path) =>
        readFileSync(join(fixture.backup, path)),
      ),
    });
    const before = snapshotBackup();

    const destination = join(suiteRoot, "restore-missing-blob");
    const restored = restoreServerFullBackup({ backupDirectory: fixture.backup, destination, port: 17931 });
    const blob = join(restored.destination, "blobs", BLOB_DIR, fixture.assetSha);
    expect(existsSync(blob)).toBe(true);
    rmSync(blob);

    let started: Awaited<ReturnType<typeof startOperationalServer>> | undefined;
    let error: unknown;
    try {
      started = await startOperationalServer(restored.destination);
    } catch (caught) {
      error = caught;
    } finally {
      if (started) await started.close();
    }

    expect(started).toBeUndefined();
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).code).toBe("server-file-unsafe");
    expect(snapshotBackup()).toEqual(before);
  },
  30_000,
);
