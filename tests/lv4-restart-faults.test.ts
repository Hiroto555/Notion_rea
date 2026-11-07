import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkspaceSyncIntentFile } from "../src/main/workspace-sync-intent";
import { applyRestartIntent } from "../src/main/workspace-sync-restart";
import { runStartupWorkspaceSync, runStartupWorkspaceSyncDetailed } from "../src/main/workspace-sync-startup";
import { Store } from "../src/persistence/store";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import { validateWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { openWorkspaceSync } from "../src/sync/workspace-sync";
import { WorkspaceSyncStore } from "../src/sync/workspace-store";
import { FaultProxy } from "./fixtures/sync-level4-support";

const clean = () => ({ status: "empty" as const, generation: 0 });

function stageRemoteRevision(
  server: Awaited<ReturnType<typeof startCheckpointServer>>,
  root: string,
  stores: Store[],
  workspaceId: string,
  ownerId: string,
  name: string,
) {
  const directory = join(root, name);
  mkdirSync(directory);
  mkdirSync(join(directory, "assets"));
  const store = new Store(join(directory, "workspace.sqlite"));
  stores.push(store);
  const clientId = randomUUID(), bindingId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  server.registerDevice({ workspaceId, ownerId, clientId, token });
  return {
    store,
    directory,
    workspaceId,
    clientId,
    bindingId,
    token,
    baseUrl: server.url,
    canApply: () => true,
  };
}

async function stagedReceiver(
  server: Awaited<ReturnType<typeof startCheckpointServer>>,
  root: string,
  stores: Store[],
  workspaceId: string,
  ownerId: string,
) {
  const publisher = stageRemoteRevision(server, root, stores, workspaceId, ownerId, "a");
  const receiver = stageRemoteRevision(server, root, stores, workspaceId, ownerId, "b");
  const page = publisher.store.create(null, "page", "remote");
  const sender = await openWorkspaceSync({ ...publisher, mode: "publish" });
  await sender.sendPending();
  const joiner = await openWorkspaceSync({ ...receiver, mode: "join" });
  await joiner.receiveAndStage();
  const target = joiner.stagedTarget();
  if (!target) throw new Error("no staged target");
  receiver.store.close();
  stores.splice(stores.indexOf(receiver.store), 1);
  const reopened = new Store(receiver.store.path);
  stores.push(reopened);
  const intent = {
    workspaceId,
    clientId: receiver.clientId,
    bindingId: receiver.bindingId,
    serverEpoch: server.serverEpoch,
    ...target,
  };
  const file = new WorkspaceSyncIntentFile(receiver.directory);
  file.create(intent);
  return { receiver, reopened, page, intent, file };
}

it("keeps a restart intent when the preflight request is aborted instead of refused", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-lv4-restart-abort-"));
  const workspaceId = randomUUID(), ownerId = randomUUID();
  const server = await startCheckpointServer({
    databasePath: join(root, "server.sqlite"),
    capabilities: [],
    workspaces: [{ workspaceId, ownerId }],
    validateCheckpoint: validateWorkspaceCheckpoint,
  });
  const stores: Store[] = [];
  let proxy: FaultProxy | undefined;
  try {
    const { receiver, reopened, page, intent, file } = await stagedReceiver(
      server, root, stores, workspaceId, ownerId,
    );
    proxy = await FaultProxy.start(server.url, "abort-next-request");
    const env = {
      FOLIO_SYNC_ENABLED: "1",
      FOLIO_DATA_DIR: receiver.directory,
      FOLIO_SYNC_URL: proxy.url,
      FOLIO_SYNC_WORKSPACE: workspaceId,
      FOLIO_SYNC_CLIENT: receiver.clientId,
      FOLIO_SYNC_BINDING: receiver.bindingId,
      FOLIO_SYNC_TOKEN: receiver.token,
    };
    const startup = await runStartupWorkspaceSyncDetailed(reopened, clean, env);
    const message = startup.message;
    expect(proxy.counts.aborted).toBe(1);
    expect(startup.reconnect).toBeUndefined();
    expect(message).toContain("起動時同期を保留");
    expect(message).not.toContain("受信版を適用済み");
    expect(reopened.pages()).toEqual([]);
    expect(new WorkspaceSyncStore(reopened, {
      ...receiver,
      serverEpoch: server.serverEpoch,
    }).status()).toMatchObject({ appliedRevision: 0, receivedCursor: 1 });
    expect(file.read()).toEqual({ status: "ready", target: intent });

    await proxy.close();
    proxy = undefined;
    const retried = await runStartupWorkspaceSync(reopened, clean, {
      ...env,
      FOLIO_SYNC_URL: server.url,
    });
    expect(retried).toContain("適用済み 1");
    expect(reopened.get(page.id).title).toBe("remote");
    expect(file.read()).toEqual({ status: "empty" });
  } finally {
    if (proxy) await proxy.close();
    for (const store of stores) store.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it("retains a restart intent and the staged revision when the backup write fails", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-lv4-restart-backup-"));
  const workspaceId = randomUUID(), ownerId = randomUUID();
  const server = await startCheckpointServer({
    databasePath: join(root, "server.sqlite"),
    capabilities: [],
    workspaces: [{ workspaceId, ownerId }],
    validateCheckpoint: validateWorkspaceCheckpoint,
  });
  const stores: Store[] = [];
  try {
    const { receiver, reopened, page, intent, file } = await stagedReceiver(
      server, root, stores, workspaceId, ownerId,
    );
    let rejectBackup = true;
    const admission = (_bytes: number, purpose: "content" | "assets" | "backup") => {
      if (rejectBackup && purpose === "backup") throw new Error("backup denied");
    };
    const options = { ...receiver, store: reopened, admitBytes: admission };
    expect(await applyRestartIntent({
      directory: receiver.directory,
      sync: options,
      readRecovery: clean,
    })).toBe("blocked");
    expect(reopened.pages()).toEqual([]);
    expect(new WorkspaceSyncStore(reopened, {
      ...receiver,
      serverEpoch: server.serverEpoch,
    }).status()).toMatchObject({ appliedRevision: 0, receivedCursor: 1 });
    expect(file.read()).toEqual({ status: "ready", target: intent });

    rejectBackup = false;
    expect(await applyRestartIntent({
      directory: receiver.directory,
      sync: options,
      readRecovery: clean,
    })).toBe("applied");
    expect(reopened.get(page.id).title).toBe("remote");
    expect(file.read()).toEqual({ status: "empty" });
    expect(new WorkspaceSyncStore(reopened, {
      ...receiver,
      serverEpoch: server.serverEpoch,
    }).status().appliedRevision).toBe(1);
  } finally {
    for (const store of stores) store.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
