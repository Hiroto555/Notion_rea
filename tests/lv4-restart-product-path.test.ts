import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { WorkspaceSyncGate } from "../src/main/workspace-sync-gate";
import { WorkspaceSyncIntentFile } from "../src/main/workspace-sync-intent";
import { WorkspaceSyncRestartCoordinator } from "../src/main/workspace-sync-restart-coordinator";
import { applyRestartIntent } from "../src/main/workspace-sync-restart";
import { WorkspaceSyncService } from "../src/main/workspace-sync-service";
import { finishWorkspaceQuit } from "../src/main/workspace-quit";
import { Store } from "../src/persistence/store";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import { validateWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { openWorkspaceSync } from "../src/sync/workspace-sync";

it("holds a requested restart until writes finish and applies the pinned staging after an offline reopen", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-restart-product-path-"));
  const workspaceId = randomUUID(), ownerId = randomUUID();
  const server = await startCheckpointServer({databasePath: join(root, "server.sqlite"), capabilities: [],
    workspaces: [{workspaceId, ownerId}], validateCheckpoint: validateWorkspaceCheckpoint});
  let serverClosed = false;
  const stores: Store[] = [];
  try {
    const device = (name: string) => {
      const directory = join(root, name); mkdirSync(directory); mkdirSync(join(directory, "assets"));
      const store = new Store(join(directory, "workspace.sqlite")); stores.push(store);
      const clientId = randomUUID(), bindingId = randomUUID(), token = randomBytes(32).toString("base64url");
      server.registerDevice({workspaceId, ownerId, clientId, token});
      return {directory, store, workspaceId, clientId, bindingId, token, baseUrl: server.url, canApply: () => true};
    };
    const a = device("a"), b = device("b");
    const page = a.store.create(null, "page", "received");
    const publisher = await openWorkspaceSync({...a, mode: "publish"}); await publisher.sendPending();
    const receiver = await openWorkspaceSync({...b, mode: "join"}); await receiver.receiveAndStage();
    expect(b.store.pages()).toEqual([]);
    const gate = new WorkspaceSyncGate(), service = new WorkspaceSyncService(receiver);
    const intent = new WorkspaceSyncIntentFile(b.directory);
    let windowsClosed = false;
    const coordinator = new WorkspaceSyncRestartCoordinator(intent, {
      target: () => service.restartTarget(), incoming: () => service.stagedChange(),
      status: () => service.status().workspace!, running: () => service.status().running,
      gateIdle: () => gate.isIdle(), recovery: () => ({status: "empty", generation: 0}),
      windowsClosed: () => windowsClosed,
    });
    expect(coordinator.requestRestart().result).toBe("prepared");
    let release!: () => void;
    const write = gate.write(() => new Promise<void>((resolve) => {release = resolve;}));
    windowsClosed = true;
    const preventQuit = vi.fn(), reopenWindow = vi.fn(() => {windowsClosed = false;});
    const options = {commitRestart: () => coordinator.commitAfterWindowsClosed(), preventQuit, reopenWindow,
      closeStore: () => {b.store.close(); stores.splice(stores.indexOf(b.store), 1);}};
    expect(finishWorkspaceQuit(options)).toBe("held");
    expect(intent.read()).toEqual({status: "empty"});
    expect(preventQuit).toHaveBeenCalledOnce();
    release(); await write;
    windowsClosed = true;
    expect(finishWorkspaceQuit(options)).toBe("quit");
    expect(intent.read().status).toBe("ready");
    await server.close(); serverClosed = true;
    const reopened = new Store(join(b.directory, "workspace.sqlite")); stores.push(reopened);
    expect(await applyRestartIntent({directory: b.directory, sync: {...b, store: reopened},
      readRecovery: () => ({status: "empty", generation: 0})})).toBe("applied");
    expect(reopened.get(page.id).title).toBe("received");
    expect(intent.read()).toEqual({status: "empty"});
  } finally {
    if (!serverClosed) await server.close();
    for (const store of stores) store.close();
    rmSync(root, {recursive: true, force: true});
  }
});
