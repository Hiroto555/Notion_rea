import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { attachFile } from "../src/persistence/assets";
import { emptyCrashRecoverySnapshot } from "../src/shared/crash-recovery";
import { WorkspaceSyncIntentJournal } from "../src/main/normal-apply-intent";
import { applyRestartIntent } from "../src/main/workspace-sync-restart";
import { runStartupWorkspaceSync } from "../src/main/workspace-sync-startup";
import { WorkspaceSyncGate } from "../src/main/workspace-sync-gate";
import { WorkspaceSyncControl } from "../src/main/workspace-sync-control";
import { WorkspaceSyncService } from "../src/main/workspace-sync-service";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import { WorkspaceBlobStore } from "../src/sync/workspace-blobs";
import { validateWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { openWorkspaceSync, WorkspaceSync } from "../src/sync/workspace-sync";

it("stages without changing content and applies one revision with the server offline", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-lv4-split-"));
  const workspaceId = randomUUID(), ownerId = randomUUID();
  const server = await startCheckpointServer({databasePath: join(root, "server.sqlite"), capabilities: [], workspaces: [{workspaceId, ownerId}], validateCheckpoint: validateWorkspaceCheckpoint, blobs: new WorkspaceBlobStore(join(root, "blobs"))});
  const stores: Store[] = [];
  let closed = false;
  try {
    const options = (name: string) => {
      const directory = join(root, name); mkdirSync(directory); mkdirSync(join(directory, "assets"));
      const store = new Store(join(directory, "workspace.sqlite")); stores.push(store);
      const clientId = randomUUID(), bindingId = randomUUID(), token = randomBytes(32).toString("base64url");
      server.registerDevice({workspaceId, ownerId, clientId, token});
      return {store, workspaceId, clientId, bindingId, token, baseUrl: server.url, canApply: () => true};
    };
    const a = options("a"), b = options("b");
    let allowed = true, rejectBackup = false;
    b.canApply = () => allowed;
    const admission = (_bytes: number, purpose: "content" | "assets" | "backup") => {if (rejectBackup && purpose === "backup") throw new Error("backup denied");};
    const page = a.store.create(null, "page", "remote");
    const file = join(root, "input.txt"); writeFileSync(file, "attachment bytes");
    const asset = attachFile(a.store.db, join(root, "a", "assets"), file);
    const publisher = await openWorkspaceSync({...a, mode: "publish"});
    await publisher.sendPending();
    const receiver = await openWorkspaceSync({...b, mode: "join", admitBytes: admission});
    const before = receiver.status();
    const control = new WorkspaceSyncControl(new WorkspaceSyncService(receiver), new WorkspaceSyncGate(), false);
    const transfer = await control.transfer();
    expect(transfer.available).toBe(true);
    const staged = receiver.status();
    expect(staged.receivedCursor).toBe(1);
    expect(staged.appliedRevision).toBe(before.appliedRevision);
    expect(b.store.pages()).toEqual([]);
    expect(existsSync(join(root, "b", "assets", asset.id))).toBe(false);
    expect(readFileSync(join(root, "b", ".folio-sync-assets-staging", asset.id), "utf8")).toBe("attachment bytes");
    const target = receiver.stagedTarget()!;
    b.store.close(); stores.splice(stores.indexOf(b.store), 1);
    await server.close(); closed = true;
    const reopenedStore = new Store(b.store.path); stores.push(reopenedStore);
    const offline = WorkspaceSync.openStaged({...b, store: reopenedStore, admitBytes: admission}, server.serverEpoch);
    const intentFile = new WorkspaceSyncIntentJournal(join(root, "b"), reopenedStore);
    const intent = {workspaceId, clientId: b.clientId, bindingId: b.bindingId, serverEpoch: server.serverEpoch, ...target};
    intentFile.create(intent);
    const restoredServer = await startCheckpointServer({databasePath: join(root, "restored-server.sqlite"), capabilities: [],
      workspaces: [{workspaceId, ownerId}], validateCheckpoint: validateWorkspaceCheckpoint});
    try {
      restoredServer.registerDevice({workspaceId, ownerId, clientId: b.clientId, token: b.token});
      const mismatch = await runStartupWorkspaceSync(reopenedStore, () => ({status: "empty", generation: 0}), {
        FOLIO_SYNC_ENABLED: "1", FOLIO_DATA_DIR: join(root, "b"), FOLIO_SYNC_URL: restoredServer.url,
        FOLIO_SYNC_WORKSPACE: workspaceId, FOLIO_SYNC_CLIENT: b.clientId,
        FOLIO_SYNC_BINDING: b.bindingId, FOLIO_SYNC_TOKEN: b.token,
      }, admission);
      expect(mismatch).toContain("server-epoch-mismatch");
      expect(offline.status().appliedRevision).toBe(0);
      expect(intentFile.read().status).toBe("ready");
    } finally {await restoredServer.close();}
    // A mis-restored server with the old epoch must also stop on a lower head
    // or a different history at the same revision.
    const rollbackPath = join(root, "rollback-server.sqlite");
    const seed = new DatabaseSync(rollbackPath);
    seed.exec("CREATE TABLE checkpoint_server_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, epoch TEXT NOT NULL)");
    seed.prepare("INSERT INTO checkpoint_server_identity VALUES(1,1,?)").run(server.serverEpoch);
    seed.close();
    const rollbackServer = await startCheckpointServer({databasePath: rollbackPath, capabilities: [], workspaces: [{workspaceId, ownerId}], validateCheckpoint: validateWorkspaceCheckpoint});
    try {
      rollbackServer.registerDevice({workspaceId, ownerId, clientId: b.clientId, token: b.token});
      const rollbackEnv = {FOLIO_SYNC_ENABLED: "1", FOLIO_DATA_DIR: join(root, "b"), FOLIO_SYNC_URL: rollbackServer.url,
        FOLIO_SYNC_WORKSPACE: workspaceId, FOLIO_SYNC_CLIENT: b.clientId, FOLIO_SYNC_BINDING: b.bindingId, FOLIO_SYNC_TOKEN: b.token};
      expect(await runStartupWorkspaceSync(reopenedStore, () => ({status: "empty", generation: 0}), rollbackEnv, admission)).toContain("server-head-regressed");
      const forkDir = join(root, "fork"); mkdirSync(forkDir); mkdirSync(join(forkDir, "assets"));
      const forkStore = new Store(join(forkDir, "workspace.sqlite")); stores.push(forkStore);
      const forkClient = randomUUID(), forkToken = randomBytes(32).toString("base64url");
      rollbackServer.registerDevice({workspaceId, ownerId, clientId: forkClient, token: forkToken});
      forkStore.create(null, "page", "different history");
      const fork = await openWorkspaceSync({store: forkStore, workspaceId, clientId: forkClient, bindingId: randomUUID(), token: forkToken, baseUrl: rollbackServer.url, canApply: () => true, mode: "publish"});
      await fork.sendPending();
      expect(await runStartupWorkspaceSync(reopenedStore, () => ({status: "empty", generation: 0}), rollbackEnv, admission)).toContain("server-history-mismatch");
      rollbackServer.revokeDevice(workspaceId, b.clientId);
      expect(await runStartupWorkspaceSync(reopenedStore, () => ({status: "empty", generation: 0}), rollbackEnv, admission)).toContain("unauthorized");
      expect(offline.status().appliedRevision).toBe(0);
      expect(intentFile.read().status).toBe("ready");
    } finally {await rollbackServer.close();}
    expect(await runStartupWorkspaceSync(reopenedStore, () => ({status: "empty", generation: 0}), {
      FOLIO_SYNC_ENABLED: "1", FOLIO_DATA_DIR: join(root, "b"), FOLIO_SYNC_MODE: "recover",
    })).toContain("rebind-pending-intent");
    expect(intentFile.read().status).toBe("ready");
    const recovery = emptyCrashRecoverySnapshot();
    recovery.rawDrafts.push({scope: "record", pageId: "page", key: "draft", value: "unsaved"});
    const restartOptions = {directory: join(root, "b"), sync: {...b, store: reopenedStore, admitBytes: admission}, readRecovery: () => ({status: "empty" as const, generation: 0})};
    expect(await applyRestartIntent({...restartOptions, readRecovery: () => ({status: "ready", generation: 1, snapshot: recovery})})).toBe("recovery-input");
    expect(intentFile.read().status).toBe("ready");
    await expect(offline.receiveAndStage()).rejects.toThrow("offline-sync-instance");
    await expect(offline.applyStaged({...target, revision: 2})).rejects.toThrow("staged-target-mismatch");
    const stagedAsset = join(root, "b", ".folio-sync-assets-staging", asset.id);
    writeFileSync(stagedAsset, "tampered");
    await expect(offline.applyStaged(target,intentFile.pending())).rejects.toThrow();
    expect(offline.status().appliedRevision).toBe(0);
    expect(reopenedStore.pages()).toEqual([]);
    writeFileSync(stagedAsset, "attachment bytes");
    allowed = false;
    expect((await offline.applyStaged(target,intentFile.pending())).appliedRevision).toBe(0);
    allowed = true; rejectBackup = true;
    await expect(offline.applyStaged(target,intentFile.pending())).rejects.toThrow("backup denied");
    expect(offline.status().appliedRevision).toBe(0);
    expect(reopenedStore.pages()).toEqual([]);
    rejectBackup = false;
    reopenedStore.db.exec(`CREATE TEMP TRIGGER fail_lv4_apply BEFORE UPDATE OF applied_revision
      ON workspace_sync_state BEGIN SELECT RAISE(ABORT,'injected apply failure'); END`);
    await expect(offline.applyStaged(target,intentFile.pending())).rejects.toThrow("injected apply failure");
    expect(offline.status()).toMatchObject({receivedCursor: 1, appliedRevision: 0});
    expect(reopenedStore.pages()).toEqual([]);
    reopenedStore.db.exec("DROP TRIGGER fail_lv4_apply");
    const startupEnv = {FOLIO_SYNC_ENABLED: "1", FOLIO_DATA_DIR: join(root, "b"), FOLIO_SYNC_URL: b.baseUrl,
      FOLIO_SYNC_WORKSPACE: workspaceId, FOLIO_SYNC_CLIENT: b.clientId,
      FOLIO_SYNC_BINDING: b.bindingId, FOLIO_SYNC_TOKEN: b.token};
    expect(await runStartupWorkspaceSync(reopenedStore, restartOptions.readRecovery, startupEnv, admission)).toContain("受信版を適用済み");
    expect(offline.status().appliedRevision).toBe(1);
    expect(reopenedStore.get(page.id).title).toBe("remote");
    expect(readFileSync(join(root, "b", "assets", asset.id), "utf8")).toBe("attachment bytes");
    expect(intentFile.read().status).toBe("empty");
    // The consumed SQLite result survives COMMIT acknowledgement loss without new consent.
    expect(await applyRestartIntent(restartOptions)).toBe("already-applied");
    expect(intentFile.read().status).toBe("empty");
  } finally {
    if (!closed) await server.close();
    for (const store of stores) store.close();
    rmSync(root, {recursive: true, force: true});
  }
});

it("retains a prepared local send when receiving an unrelated revision and the server fails", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-lv4-pending-"));
  const workspaceId = randomUUID(), ownerId = randomUUID();
  const server = await startCheckpointServer({databasePath: join(root, "server.sqlite"), capabilities: [], workspaces: [{workspaceId, ownerId}], validateCheckpoint: validateWorkspaceCheckpoint});
  const stores: Store[] = []; let closed = false;
  try {
    const options = (name: string) => {
      const directory = join(root, name); mkdirSync(directory); mkdirSync(join(directory, "assets"));
      const store = new Store(join(directory, "workspace.sqlite")); stores.push(store);
      const clientId = randomUUID(), bindingId = randomUUID(), token = randomBytes(32).toString("base64url");
      server.registerDevice({workspaceId, ownerId, clientId, token});
      return {store, workspaceId, clientId, bindingId, token, baseUrl: server.url, canApply: () => true};
    };
    const a = options("a"), b = options("b");
    a.store.create(null, "page", "remote");
    const publisher = await openWorkspaceSync({...a, mode: "publish"}); await publisher.sendPending();
    const receiver = await openWorkspaceSync({...b, mode: "join"});
    const localPage = b.store.create(null, "page", "unsent local");
    const { WorkspaceSyncStore } = await import("../src/sync/workspace-store");
    const queue = new WorkspaceSyncStore(b.store, {...b, serverEpoch: server.serverEpoch});
    const pending = queue.prepare()!;
    const staged = await receiver.receiveAndStage();
    expect(staged).toMatchObject({pending: true, receivedCursor: 1, appliedRevision: 0});
    expect((await receiver.applyStaged(receiver.stagedTarget()!)).appliedRevision).toBe(0);
    await server.close(); closed = true;
    await expect(receiver.sendPending()).rejects.toThrow();
    expect(queue.prepare()?.operationId).toBe(pending.operationId);
    expect(receiver.status()).toMatchObject({pending: true, receivedCursor: 1, appliedRevision: 0});
    expect(b.store.get(localPage.id).title).toBe("unsent local");
  } finally {
    if (!closed) await server.close();
    for (const store of stores) store.close();
    rmSync(root, {recursive: true, force: true});
  }
});

it("stages attachments for every received revision before going offline", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-lv4-multi-assets-"));
  const workspaceId = randomUUID(), ownerId = randomUUID();
  const server = await startCheckpointServer({databasePath: join(root, "server.sqlite"), capabilities: [], workspaces: [{workspaceId, ownerId}], validateCheckpoint: validateWorkspaceCheckpoint, blobs: new WorkspaceBlobStore(join(root, "blobs"))});
  const stores: Store[] = []; let closed = false;
  try {
    const options = (name: string) => {
      const dir = join(root, name); mkdirSync(dir); mkdirSync(join(dir, "assets"));
      const store = new Store(join(dir, "workspace.sqlite")); stores.push(store);
      const clientId = randomUUID(), bindingId = randomUUID(), token = randomBytes(32).toString("base64url");
      server.registerDevice({workspaceId, ownerId, clientId, token});
      return {store, workspaceId, clientId, bindingId, token, baseUrl: server.url, canApply: () => true};
    };
    const a = options("a"), b = options("b");
    a.store.create(null, "page", "first");
    const publisher = await openWorkspaceSync({...a, mode: "publish"});
    await publisher.sendPending();
    const source = join(root, "later.txt"); writeFileSync(source, "later revision");
    const asset = attachFile(a.store.db, join(root, "a", "assets"), source);
    await publisher.sendPending();
    let rejectAssets = true;
    const receiver = await openWorkspaceSync({...b, mode: "join", admitBytes: (_bytes, purpose) => {
      if (rejectAssets && purpose === "assets") throw new Error("asset admission denied");
    }});
    await receiver.receiveAndStage();
    await expect(receiver.receiveAndStage()).rejects.toThrow("asset admission denied");
    expect(receiver.status()).toMatchObject({receivedCursor: 2, appliedRevision: 0});
    rejectAssets = false;
    await receiver.receiveAndStage(); // Retry even though the cursor already advanced.
    expect(receiver.status()).toMatchObject({receivedCursor: 2, appliedRevision: 0});
    expect(readFileSync(join(root, "b", ".folio-sync-assets-staging", asset.id), "utf8")).toBe("later revision");
    await server.close(); closed = true;
    await receiver.applyStaged(receiver.stagedTarget()!);
    expect(receiver.status().appliedRevision).toBe(1);
    await receiver.applyStaged(receiver.stagedTarget()!);
    expect(receiver.status().appliedRevision).toBe(2);
    expect(readFileSync(join(root, "b", "assets", asset.id), "utf8")).toBe("later revision");
  } finally {
    if (!closed) await server.close();
    for (const store of stores) store.close();
    rmSync(root, {recursive: true, force: true});
  }
});

it("resolves a remote conflict whose head is more than one revision past the cursor", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-lv4-conflict-gap-"));
  const workspaceId = randomUUID(), ownerId = randomUUID();
  const server = await startCheckpointServer({
    databasePath: join(root, "server.sqlite"),
    capabilities: [],
    workspaces: [{ workspaceId, ownerId }],
    validateCheckpoint: validateWorkspaceCheckpoint,
  });
  const stores: Store[] = [];
  let closed = false;
  try {
    const options = (name: string) => {
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
    const a = options("a"), b = options("b");
    const page = a.store.create(null, "page", "base");
    const publisher = await openWorkspaceSync({...a, mode: "publish"});
    await publisher.sendPending(); // revision 1

    const receiver = await openWorkspaceSync({...b, mode: "join"});
    await receiver.receiveAndStage();
    await receiver.applyStaged(receiver.stagedTarget()!); // applied = 1

    // A publishes revisions 2 and 3 while B's cursor stays at 1.
    a.store.update(page.id, a.store.get(page.id).revision, {title: "remote 2"});
    await publisher.sendPending(); // revision 2
    a.store.update(page.id, a.store.get(page.id).revision, {title: "remote 3"});
    await publisher.sendPending(); // revision 3

    // B conflicts at head 3 without having received revisions 2 or 3.
    b.store.create(null, "page", "local");
    await receiver.sendPending();
    const conflict = receiver.conflict()!;
    expect(conflict.result.head.revision).toBe(3);
    expect(receiver.status()).toMatchObject({
      receivedCursor: 1,
      appliedRevision: 1,
      conflict: true,
    });

    // One explicit remote choice must apply the observed head.
    const status = await receiver.resolveConflict("remote", 3);
    expect(status).toMatchObject({appliedRevision: 3, conflict: false});
    expect(receiver.status()).toMatchObject({receivedCursor: 3, appliedRevision: 3, conflict: false});
    expect(b.store.get(page.id).title).toBe("remote 3");
  } finally {
    if (!closed) await server.close();
    for (const store of stores) store.close();
    rmSync(root, {recursive: true, force: true});
  }
});

it("keeps both candidates if the remote head advances during a choice", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-lv4-conflict-gap-"));
  const workspaceId = randomUUID(), ownerId = randomUUID();
  const server = await startCheckpointServer({
    databasePath: join(root, "server.sqlite"),
    capabilities: [],
    workspaces: [{ workspaceId, ownerId }],
    validateCheckpoint: validateWorkspaceCheckpoint,
  });
  const stores: Store[] = [];
  let closed = false;
  try {
    const options = (name: string) => {
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
    const a = options("a"), b = options("b");
    const page = a.store.create(null, "page", "base");
    const publisher = await openWorkspaceSync({...a, mode: "publish"});
    await publisher.sendPending(); // revision 1

    const receiver = await openWorkspaceSync({...b, mode: "join"});
    await receiver.receiveAndStage();
    await receiver.applyStaged(receiver.stagedTarget()!); // applied = 1

    // A publishes revisions 2 and 3 while B's cursor stays at 1.
    a.store.update(page.id, a.store.get(page.id).revision, {title: "remote 2"});
    await publisher.sendPending(); // revision 2
    a.store.update(page.id, a.store.get(page.id).revision, {title: "remote 3"});
    await publisher.sendPending(); // revision 3

    // B conflicts at head 3 without having received revisions 2 or 3.
    const local = b.store.create(null, "page", "local");
    await receiver.sendPending();
    const conflict = receiver.conflict()!;
    expect(conflict.result.head.revision).toBe(3);
    expect(receiver.status()).toMatchObject({
      receivedCursor: 1,
      appliedRevision: 1,
      conflict: true,
    });

    // A newer remote head invalidates the previously observed choice.
    a.store.update(page.id, a.store.get(page.id).revision, {title: "remote 4"});
    await publisher.sendPending();
    await expect(receiver.resolveConflict("remote", 3)).rejects.toThrow("conflict-head-changed");
    expect(receiver.status()).toMatchObject({appliedRevision: 1, conflict: true});
    expect(b.store.get(local.id).title).toBe("local");
    expect(receiver.conflict()?.result.head.revision).toBe(3);
  } finally {
    if (!closed) await server.close();
    for (const store of stores) store.close();
    rmSync(root, {recursive: true, force: true});
  }
});

it("retains a conflict while receiving a long history over multiple choices", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-lv4-conflict-gap-"));
  const workspaceId = randomUUID(), ownerId = randomUUID();
  const server = await startCheckpointServer({
    databasePath: join(root, "server.sqlite"),
    capabilities: [],
    workspaces: [{ workspaceId, ownerId }],
    validateCheckpoint: validateWorkspaceCheckpoint,
  });
  const stores: Store[] = [];
  let closed = false;
  try {
    const options = (name: string) => {
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
    const a = options("a"), b = options("b");
    const page = a.store.create(null, "page", "base");
    const publisher = await openWorkspaceSync({...a, mode: "publish"});
    await publisher.sendPending(); // revision 1

    const receiver = await openWorkspaceSync({...b, mode: "join"});
    await receiver.receiveAndStage();
    await receiver.applyStaged(receiver.stagedTarget()!); // applied = 1

    // A publishes ten revisions while B's cursor stays at 1.
    for (let revision = 2; revision <= 11; revision++) {
      a.store.update(page.id, a.store.get(page.id).revision, {title: `remote ${revision}`});
      await publisher.sendPending();
    }

    // B conflicts without having received the newer revisions.
    const local = b.store.create(null, "page", "local");
    await receiver.sendPending();
    const conflict = receiver.conflict()!;
    expect(conflict.result.head.revision).toBe(11);
    expect(receiver.status()).toMatchObject({
      receivedCursor: 1,
      appliedRevision: 1,
      conflict: true,
    });

    await expect(receiver.resolveConflict("remote", 11)).rejects.toThrow("conflict-catchup-required");
    expect(receiver.status()).toMatchObject({receivedCursor: 9, appliedRevision: 1, conflict: true});
    expect(b.store.get(local.id).title).toBe("local");
    const status = await receiver.resolveConflict("remote", 11);
    expect(status).toMatchObject({receivedCursor: 11, appliedRevision: 11, conflict: false});
    expect(b.store.get(page.id).title).toBe("remote 11");
  } finally {
    if (!closed) await server.close();
    for (const store of stores) store.close();
    rmSync(root, {recursive: true, force: true});
  }
});
