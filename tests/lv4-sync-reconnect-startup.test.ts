import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkspaceSyncControl } from "../src/main/workspace-sync-control";
import { WorkspaceSyncGate } from "../src/main/workspace-sync-gate";
import { WorkspaceSyncService } from "../src/main/workspace-sync-service";
import { WorkspaceSyncIntentFile } from "../src/main/workspace-sync-intent";
import { runStartupWorkspaceSyncDetailed } from "../src/main/workspace-sync-startup";
import { readUserVersion } from "../src/persistence/schema-startup";
import { Store } from "../src/persistence/store";
import { startCheckpointServer, type CheckpointServerHandle } from "../src/sync/checkpoint-server";
import { validateWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { openWorkspaceSync } from "../src/sync/workspace-sync";
import type { WorkspaceSyncStatus } from "../src/sync/workspace-store";

it("reconnects only on an explicit manual transfer and never applies staged content", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-sync-reconnect-"));
  const workspaceId = randomUUID(), ownerId = randomUUID();
  const serverOptions = {
    databasePath: join(root, "server.sqlite"),
    capabilities: [],
    workspaces: [{workspaceId, ownerId}],
    validateCheckpoint: validateWorkspaceCheckpoint,
  };
  const firstServer = await startCheckpointServer(serverOptions);
  let server: CheckpointServerHandle | undefined = firstServer;
  const stores: Store[] = [];
  try {
    const device = (name: string) => {
      const directory = join(root, name);
      mkdirSync(directory);
      mkdirSync(join(directory, "assets"));
      const store = new Store(join(directory, "workspace.sqlite"));
      stores.push(store);
      const clientId = randomUUID(), bindingId = randomUUID();
      const token = randomBytes(32).toString("base64url");
      firstServer.registerDevice({workspaceId, ownerId, clientId, token});
      return {store, workspaceId, clientId, bindingId, token, baseUrl: firstServer.url, canApply: () => true};
    };
    const a = device("a"), b = device("b"), c = device("c");
    a.store.create(null, "page", "remote");
    const publisher = await openWorkspaceSync({...a, mode: "publish"});
    await publisher.sendPending(); // revision 1
    await openWorkspaceSync({...b, mode: "join"}); // establish binding before the editor opens
    const port = Number(new URL(firstServer.url).port);
    await firstServer.close();
    server = undefined;

    const disconnectedEnv = {
      FOLIO_DATA_DIR: join(root, "c"), FOLIO_SYNC_ENABLED: "1",
      FOLIO_SYNC_URL: `http://127.0.0.1:${port}`, FOLIO_SYNC_TOKEN: c.token,
      FOLIO_SYNC_WORKSPACE: workspaceId, FOLIO_SYNC_CLIENT: c.clientId,
      FOLIO_SYNC_BINDING: c.bindingId, FOLIO_SYNC_MODE: "publish",
    };
    const unbound = await runStartupWorkspaceSyncDetailed(c.store, () => ({status: "empty", generation: 0}), disconnectedEnv);
    expect(unbound.reconnect).toBeUndefined();
    expect(readUserVersion(c.store.db)).toBe(3);
    expect(existsSync(join(root, "c", ".folio-sync-binding"))).toBe(false);

    const recovering = await runStartupWorkspaceSyncDetailed(b.store, () => ({status: "empty", generation: 0}), {
      ...disconnectedEnv, FOLIO_DATA_DIR: join(root, "b"), FOLIO_SYNC_TOKEN: b.token,
      FOLIO_SYNC_CLIENT: b.clientId, FOLIO_SYNC_BINDING: b.bindingId, FOLIO_SYNC_MODE: "recover",
    });
    expect(recovering.reconnect).toBeUndefined();
    expect(readUserVersion(b.store.db)).toBe(5);

    b.store.create(null, "page", "local");
    const startup = await runStartupWorkspaceSyncDetailed(b.store, () => ({status: "empty", generation: 0}), {
      FOLIO_DATA_DIR: join(root, "b"),
      FOLIO_SYNC_ENABLED: "1",
      FOLIO_SYNC_URL: `http://127.0.0.1:${port}`,
      FOLIO_SYNC_TOKEN: b.token,
      FOLIO_SYNC_WORKSPACE: workspaceId,
      FOLIO_SYNC_CLIENT: b.clientId,
      FOLIO_SYNC_BINDING: b.bindingId,
    });
    expect(startup.opened).toBeUndefined();
    expect(startup.message).toContain("起動時同期を保留");
    expect(startup.reconnect).toBeTypeOf("function");
    expect(readUserVersion(b.store.db)).toBe(5);
    expect(existsSync(join(root, "b", ".folio-sync-binding"))).toBe(true);
    expect(b.store.pages().map((page) => page.title)).toEqual(["local"]);

    const service = WorkspaceSyncService.reconnect<WorkspaceSyncStatus>(startup.reconnect!,
      () => new Date("2026-03-04T05:06:07Z"));
    const control = new WorkspaceSyncControl(service, new WorkspaceSyncGate(), false);
    expect(control.status()).toMatchObject({available: true, connection: "disconnected",
      running: false, workspace: null, lastSuccessAt: null, lastError: null});
    expect(service.status().workspace).toBeNull();

    const revived = await startCheckpointServer({...serverOptions, port});
    server = revived;
    try {
      const file = new WorkspaceSyncIntentFile(join(root, "b"));
      const pinned = {workspaceId, clientId: b.clientId, bindingId: b.bindingId,
        serverEpoch: firstServer.serverEpoch, revision: 1, checkpointHash: "0".repeat(64)};
      file.create(pinned);
      expect(() => startup.reconnect!()).toThrow("reconnect-held");
      expect(file.read()).toEqual({status: "ready", target: pinned});
      file.cancel(pinned);
      const view = await control.transfer();
      expect(view).toMatchObject({available: true, connection: "connected", running: false,
        lastSuccessAt: null, lastError: null});
      const connected = view as Extract<typeof view, {available: true}>;
      expect(connected.workspace).toMatchObject({receivedCursor: 1, appliedRevision: 0, conflict: true, pending: true});
      expect(readUserVersion(b.store.db)).toBe(5);
      expect(b.store.pages().map((page) => page.title)).toEqual(["local"]);
      expect(b.store.pages().some((page) => page.title === "remote")).toBe(false);
    } finally {
      await revived.close();
      server = undefined;
    }
  } finally {
    if (server) await server.close();
    for (const store of stores) store.close();
    rmSync(root, {recursive: true, force: true});
  }
}, 30_000);
