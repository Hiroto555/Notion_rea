import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkspaceSyncIntentJournal } from "../src/main/normal-apply-intent";
import { applyRestartIntent } from "../src/main/workspace-sync-restart";
import { Store } from "../src/persistence/store";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import { validateWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { openWorkspaceSync } from "../src/sync/workspace-sync";

it("does not apply when a restart-intent cancel wins before the apply commit", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-lv4-restart-cancel-"));
  const workspaceId = randomUUID(), ownerId = randomUUID();
  const server = await startCheckpointServer({
    databasePath: join(root, "server.sqlite"),
    capabilities: [],
    workspaces: [{workspaceId, ownerId}],
    validateCheckpoint: validateWorkspaceCheckpoint,
  });
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
      server.registerDevice({workspaceId, ownerId, clientId, token});
      return {store, workspaceId, clientId, bindingId, token, baseUrl: server.url, canApply: () => true};
    };
    const a = device("a"), b = device("b");
    a.store.create(null, "page", "remote");
    const publisher = await openWorkspaceSync({...a, mode: "publish"});
    await publisher.sendPending();
    const receiver = await openWorkspaceSync({...b, mode: "join"});
    await receiver.receiveAndStage();
    const target = receiver.stagedTarget()!;
    expect(receiver.restartTarget()).toEqual({workspaceId, clientId: b.clientId,
      bindingId: b.bindingId, serverEpoch: server.serverEpoch, ...target});
    b.store.close();
    stores.splice(stores.indexOf(b.store), 1);
    const reopened = new Store(b.store.path);
    stores.push(reopened);

    const directory = join(root, "b");
    const intent = {workspaceId, clientId: b.clientId, bindingId: b.bindingId,
      serverEpoch: server.serverEpoch, ...target};
    const file = new WorkspaceSyncIntentJournal(directory, reopened);

    // A binding change must leave the intent untouched and apply nothing.
    const foreign = {...intent, bindingId: randomUUID()};
    file.create(foreign);
    expect(await applyRestartIntent({
      directory, sync: {...b, store: reopened},
      readRecovery: () => ({status: "empty" as const, generation: 0}),
    })).toBe("target-changed");
    expect(reopened.pages()).toEqual([]);
    expect(file.read()).toEqual({status: "ready", target: foreign});
    file.cancel(foreign);

    // A preflight for one intent cannot authorize another intent which was
    // installed before the windowless apply helper begins.
    file.create(intent);
    expect(await applyRestartIntent({directory, sync: {...b, store: reopened},
      readRecovery: () => ({status: "empty", generation: 0}), expected: {...intent, revision: 2}})).toBe("target-changed");
    expect(reopened.pages()).toEqual([]);
    expect(file.read()).toEqual({status: "ready", target: intent});
    file.cancel(intent);

    file.create(intent);
    let cancelled = false;
    void Promise.resolve().then(() => { file.cancel(intent); cancelled = true; });

    const result = await applyRestartIntent({
      directory, sync: {...b, store: reopened},
      readRecovery: () => ({status: "empty" as const, generation: 0}),
    });

    expect(cancelled).toBe(true);
    expect(result).toBe("cancelled");
    expect(reopened.pages()).toEqual([]);
    expect(file.read()).toEqual({status: "empty"});
    file.create(intent);
    const replacement = {...intent, revision: 2};
    void Promise.resolve().then(() => {file.cancel(intent); file.create(replacement);});
    expect(await applyRestartIntent({directory, sync: {...b, store: reopened},
      readRecovery: () => ({status: "empty", generation: 0})})).toBe("target-changed");
    expect(reopened.pages()).toEqual([]);
    expect(file.read()).toEqual({status: "ready", target: replacement});
  } finally {
    for (const store of stores) store.close();
    await server.close();
    rmSync(root, {recursive: true, force: true});
  }
});
