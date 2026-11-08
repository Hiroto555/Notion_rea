import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import { CheckpointRemote } from "../src/sync/client";
import { acquireServerDirectoryLease } from "../src/sync/server-directory-lease";
import { createServerFullBackup, restoreServerFullBackup } from "../src/sync/server-full-backup";
import { inspectFullServerBackup } from "../src/sync/server-full-inspection";
import { hashCheckpoint, type Checkpoint } from "../src/sync/protocol";

it("backs up an actual receipt and restores a fresh epoch with old devices revoked", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-m3-full-"))), source = join(root, "source");
  mkdirSync(source, {mode: 0o700});
  const token = randomBytes(32).toString("hex");
  let server = await startCheckpointServer({databasePath: join(source, "server.sqlite"), capabilities: [],
    workspaces: [{workspaceId: "workspace", ownerId: "owner"}], validateCheckpoint: () => true});
  let closed = false;
  try {
    server.registerDevice({workspaceId: "workspace", ownerId: "owner", clientId: "before", token});
    const remote = new CheckpointRemote({baseUrl: server.url, workspaceId: "workspace", token});
    const checkpoint: Checkpoint = {format: "folio-checkpoint/v1", name: "fixture", version: 1, payload: {text: "retained"}, assets: []};
    await remote.commit({protocol: 1, workspaceId: "workspace", clientId: "before", operationId: "committed", serverEpoch: server.serverEpoch,
      baseRevision: 0, checkpoint, checkpointHash: hashCheckpoint(checkpoint)});
    const oldEpoch = server.serverEpoch;
    await server.close(); closed = true;
    const lease = acquireServerDirectoryLease(source);
    let backup;
    try {backup = createServerFullBackup({sourceDirectory: source, destination: join(root, "backup"), lease});}
    finally {lease.close();}
    expect(backup.manifest.counts.operations).toBe(1);
    const restored = restoreServerFullBackup({backupDirectory: backup.destination, destination: join(root, "restored"), port: 17777});
    expect(restored.serverEpoch).not.toBe(oldEpoch);
    expect(inspectFullServerBackup(backup.destination).serverEpoch).toBe(oldEpoch);
    server = await startCheckpointServer({databasePath: join(restored.destination, "server.sqlite"), capabilities: [],
      workspaces: [{workspaceId: "workspace", ownerId: "owner"}], validateCheckpoint: () => true}); closed = false;
    await expect(new CheckpointRemote({baseUrl: server.url, workspaceId: "workspace", token}).head()).rejects.toMatchObject({code: "unauthorized"});
    expect(() => server.registerDevice({workspaceId: "workspace", ownerId: "owner", clientId: "before", token})).toThrow();
    const next = randomBytes(32).toString("hex");
    server.registerDevice({workspaceId: "workspace", ownerId: "owner", clientId: "after", token: next});
    const head = await new CheckpointRemote({baseUrl: server.url, workspaceId: "workspace", token: next}).head();
    expect(head).toMatchObject({serverEpoch: restored.serverEpoch, head: {revision: 1, checkpointHash: hashCheckpoint(checkpoint)}});
  } finally {if (!closed) await server.close(); rmSync(root, {recursive: true, force: true});}
});
