import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkspaceSyncIntentFile, type SyncApplyTarget } from "../src/main/workspace-sync-intent";
import { applyRestartIntent } from "../src/main/workspace-sync-restart";
import { Store } from "../src/persistence/store";
import { emptyCrashRecoverySnapshot } from "../src/shared/crash-recovery";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import { validateWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { openWorkspaceSync } from "../src/sync/workspace-sync";
import { WorkspaceSyncStore } from "../src/sync/workspace-store";

const clean = () => ({ status: "empty" as const, generation: 0 });

type Server = Awaited<ReturnType<typeof startCheckpointServer>>;

function stageRemoteRevision(
  server: Server,
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
  server: Server,
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
  const staged = joiner.stagedTarget();
  if (!staged) throw new Error("no staged target");
  receiver.store.close();
  stores.splice(stores.indexOf(receiver.store), 1);
  const reopened = new Store(receiver.store.path);
  stores.push(reopened);
  const intent: SyncApplyTarget = {
    workspaceId,
    clientId: receiver.clientId,
    bindingId: receiver.bindingId,
    serverEpoch: server.serverEpoch,
    ...staged,
  };
  return { receiver, reopened, page, intent };
}

function statusOf(
  receiver: ReturnType<typeof stageRemoteRevision>,
  reopened: Store,
  serverEpoch: string,
) {
  return new WorkspaceSyncStore(reopened, { ...receiver, serverEpoch }).status();
}

it("refuses a corrupt restart intent without applying or removing it", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-lv4-restart-corrupt-"));
  const workspaceId = randomUUID(), ownerId = randomUUID();
  const server = await startCheckpointServer({
    databasePath: join(root, "server.sqlite"),
    capabilities: [],
    workspaces: [{ workspaceId, ownerId }],
    validateCheckpoint: validateWorkspaceCheckpoint,
  });
  const stores: Store[] = [];
  try {
    const { receiver, reopened, intent } = await stagedReceiver(
      server, root, stores, workspaceId, ownerId,
    );
    expect(reopened.pages()).toEqual([]);
    const file = new WorkspaceSyncIntentFile(receiver.directory);
    const corrupt = Buffer.from(JSON.stringify({
      ...intent,
      format: "folio-sync-apply-intent/v1",
      revision: 0,
    }), "utf8");
    writeFileSync(file.path, corrupt);
    expect(file.read()).toEqual({ status: "blocked" });

    expect(await applyRestartIntent({
      directory: receiver.directory,
      sync: { ...receiver, store: reopened },
      readRecovery: clean,
    })).toBe("blocked");

    expect(reopened.pages()).toEqual([]);
    expect(statusOf(receiver, reopened, server.serverEpoch)).toMatchObject({
      appliedRevision: 0,
      receivedCursor: 1,
    });
    expect(file.read()).toEqual({ status: "blocked" });
    expect(readFileSync(file.path)).toEqual(corrupt);
  } finally {
    for (const store of stores) store.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it("refuses mismatched identity and epoch while preserving the intent and staged content", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-lv4-restart-identity-"));
  const workspaceId = randomUUID(), ownerId = randomUUID();
  const server = await startCheckpointServer({
    databasePath: join(root, "server.sqlite"),
    capabilities: [],
    workspaces: [{ workspaceId, ownerId }],
    validateCheckpoint: validateWorkspaceCheckpoint,
  });
  const stores: Store[] = [];
  try {
    const { receiver, reopened, intent } = await stagedReceiver(
      server, root, stores, workspaceId, ownerId,
    );
    expect(reopened.pages()).toEqual([]);
    const file = new WorkspaceSyncIntentFile(receiver.directory);
    const sync = { ...receiver, store: reopened };

    const foreign = { ...intent, clientId: randomUUID() };
    file.create(foreign);
    expect(await applyRestartIntent({
      directory: receiver.directory,
      sync,
      readRecovery: clean,
    })).toBe("target-changed");
    expect(reopened.pages()).toEqual([]);
    expect(statusOf(receiver, reopened, server.serverEpoch)).toMatchObject({
      appliedRevision: 0,
      receivedCursor: 1,
    });
    expect(file.read()).toEqual({ status: "ready", target: foreign });

    file.cancel(foreign);
    const wrongEpoch = { ...intent, serverEpoch: randomUUID() };
    file.create(wrongEpoch);
    expect(await applyRestartIntent({
      directory: receiver.directory,
      sync,
      readRecovery: clean,
    })).toBe("blocked");
    expect(reopened.pages()).toEqual([]);
    expect(statusOf(receiver, reopened, server.serverEpoch)).toMatchObject({
      appliedRevision: 0,
      receivedCursor: 1,
    });
    expect(file.read()).toEqual({ status: "ready", target: wrongEpoch });
  } finally {
    for (const store of stores) store.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it("refuses blocked or pending recovery without applying or consuming the intent", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-lv4-restart-recovery-"));
  const workspaceId = randomUUID(), ownerId = randomUUID();
  const server = await startCheckpointServer({
    databasePath: join(root, "server.sqlite"),
    capabilities: [],
    workspaces: [{ workspaceId, ownerId }],
    validateCheckpoint: validateWorkspaceCheckpoint,
  });
  const stores: Store[] = [];
  try {
    const { receiver, reopened, intent } = await stagedReceiver(
      server, root, stores, workspaceId, ownerId,
    );
    expect(reopened.pages()).toEqual([]);
    const file = new WorkspaceSyncIntentFile(receiver.directory);
    file.create(intent);
    const sync = { ...receiver, store: reopened };

    expect(await applyRestartIntent({
      directory: receiver.directory,
      sync,
      readRecovery: () => ({ status: "blocked", generation: 1 }),
    })).toBe("recovery-input");
    expect(reopened.pages()).toEqual([]);
    expect(statusOf(receiver, reopened, server.serverEpoch)).toMatchObject({
      appliedRevision: 0,
      receivedCursor: 1,
    });
    expect(file.read()).toEqual({ status: "ready", target: intent });

    const snapshot = emptyCrashRecoverySnapshot();
    snapshot.rawDrafts.push({
      scope: "record",
      pageId: "page-1",
      key: "draft",
      value: "pending",
    });
    expect(await applyRestartIntent({
      directory: receiver.directory,
      sync,
      readRecovery: () => ({ status: "ready", generation: 1, snapshot }),
    })).toBe("recovery-input");
    expect(reopened.pages()).toEqual([]);
    expect(statusOf(receiver, reopened, server.serverEpoch)).toMatchObject({
      appliedRevision: 0,
      receivedCursor: 1,
    });
    expect(file.read()).toEqual({ status: "ready", target: intent });
  } finally {
    for (const store of stores) store.close();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
