import { randomBytes, randomInt, randomUUID } from "node:crypto";
import {
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
import { afterEach, expect, it } from "vitest";
import { runStartupWorkspaceSyncDetailed } from "../src/main/workspace-sync-startup";
import { attachFile } from "../src/persistence/assets";
import { commitDatabaseOperation } from "../src/persistence/database-operations";
import { createFullBackup } from "../src/persistence/full-backup-create";
import { restoreFullBackup } from "../src/persistence/full-backup-restore";
import { createServer } from "node:net";
import { verifyFullBackup } from "../src/persistence/full-backup-verify";
import { RecordLifecycle } from "../src/persistence/record-lifecycle";
import { RecordRepository } from "../src/persistence/record-repository";
import { Store } from "../src/persistence/store";
import { prepareDatabaseCreation } from "../src/shared/database-operation";
import { preparePageCreation } from "../src/shared/page-operation";
import { emptyDatabase } from "../src/shared/types";
import { CheckpointRemote } from "../src/sync/client";
import {
  consumedDecisionMatches,
  readConflictDecision,
  reserveConflictDecision,
} from "../src/sync/conflict-decision";
import {
  initializeOperationalServer,
  issueOperationalCredential,
  startOperationalServer,
} from "../src/sync/operational-server";
import type { Commit } from "../src/sync/protocol";
import { acquireServerDirectoryLease } from "../src/sync/server-directory-lease";
import {
  createServerFullBackup,
  restoreServerFullBackup,
} from "../src/sync/server-full-backup";
import { inspectFullServerBackup } from "../src/sync/server-full-inspection";
import { openWorkspaceSync } from "../src/sync/workspace-sync";

type RunningServer = Awaited<ReturnType<typeof startOperationalServer>>;
type SyncOptions = {
  store: Store;
  workspaceId: string;
  clientId: string;
  bindingId: string;
  token: string;
  baseUrl: string;
  canApply: () => boolean;
};

const roots: string[] = [];
const stores: Store[] = [];
const servers: RunningServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    try {
      await server.close();
    } catch {}
  }
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function closeServer(server: RunningServer): Promise<void> {
  const index = servers.indexOf(server);
  if (index >= 0) servers.splice(index, 1);
  await server.close();
}

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "folio-m3-lifecycle-")),
  );
  roots.push(root);
  return root;
}

function clientDirectory(root: string, name: string): string {
  const directory = join(root, name);
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(join(directory, "assets"), { mode: 0o700 });
  return directory;
}

function openStore(directory: string): Store {
  const store = new Store(join(directory, "workspace.sqlite"));
  stores.push(store);
  return store;
}

function reopenStore(store: Store): Store {
  const path = store.path;
  const index = stores.indexOf(store);
  if (index >= 0) stores.splice(index, 1);
  store.close();
  const reopened = new Store(path);
  stores.push(reopened);
  return reopened;
}

function syncEnvironment(
  directory: string,
  options: Pick<
    SyncOptions,
    "baseUrl" | "workspaceId" | "clientId" | "bindingId" | "token"
  >,
): NodeJS.ProcessEnv {
  return {
    FOLIO_SYNC_ENABLED: "1",
    FOLIO_DATA_DIR: directory,
    FOLIO_SYNC_URL: options.baseUrl,
    FOLIO_SYNC_WORKSPACE: options.workspaceId,
    FOLIO_SYNC_CLIENT: options.clientId,
    FOLIO_SYNC_BINDING: options.bindingId,
    FOLIO_SYNC_TOKEN: options.token,
  };
}

function clientSnapshot(store: Store) {
  return {
    pages: store.db.prepare("SELECT id,data FROM pages ORDER BY id").all(),
    outbox: store.db
      .prepare(
        "SELECT operation_id,fingerprint,commit_json,result_json FROM workspace_sync_outbox ORDER BY operation_id",
      )
      .all(),
    receipts: store.db
      .prepare(
        "SELECT operation_id,fingerprint,result_json FROM save_receipts ORDER BY operation_id",
      )
      .all(),
    assets: store.db
      .prepare("SELECT id,metadata FROM assets ORDER BY id")
      .all(),
    state: store.db
      .prepare(
        "SELECT workspace_id,client_id,binding_id,server_epoch,generation,clean_generation,applied_revision,received_cursor FROM workspace_sync_state",
      )
      .all(),
  };
}

function checkpointPages(json: string): Array<Record<string, any>> {
  const checkpoint = JSON.parse(json) as {
    payload: { tables: { pages: [string, string][] } };
  };
  return checkpoint.payload.tables.pages.map(([, data]) => JSON.parse(data));
}

function checkpointHasTitle(json: string, title: string): boolean {
  return checkpointPages(json).some((page) => page.title === title);
}

function writeInput(root: string, name: string, bytes: Buffer): string {
  const path = join(root, name);
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

it(
  "preserves rich local content and R2 receipts through a conflict, old-server restore, and explicit new-device recovery",
  async () => {
    const root = temporaryRoot();
    const workspaceId = randomUUID();
    const ownerId = randomUUID();
    const portProbe = createServer();
    await new Promise<void>(resolve => portProbe.listen(0, "127.0.0.1", resolve));
    const port = (portProbe.address() as {port: number}).port;
    await new Promise<void>(resolve => portProbe.close(() => resolve()));
    const serverDirectory = join(root, "server");

    const initialized = await initializeOperationalServer(serverDirectory, {
      format: "folio-server-config/v1",
      workspaceId,
      ownerId,
      port,
    });
    const oldEpoch = initialized.serverEpoch;
    let server = await startOperationalServer(serverDirectory);
    servers.push(server);
    expect(server.serverEpoch).toBe(oldEpoch);

    const aDirectory = clientDirectory(root, "client-a");
    const bDirectory = clientDirectory(root, "client-b");
    const aStore = openStore(aDirectory);
    const bStore = openStore(bDirectory);
    const aClientId = randomUUID();
    const bClientId = randomUUID();
    const aToken = randomBytes(32).toString("base64url");
    const bToken = randomBytes(32).toString("base64url");
    server.registerDevice({
      workspaceId,
      ownerId,
      clientId: aClientId,
      token: aToken,
    });
    server.registerDevice({
      workspaceId,
      ownerId,
      clientId: bClientId,
      token: bToken,
    });

    const home = aStore.commitPageOperation(preparePageCreation("Home")).page!;
    const linkTarget = aStore.commitPageOperation(
      preparePageCreation("Link target"),
    ).page!;
    aStore.update(home.id, home.revision, {
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "target",
                marks: [
                  {
                    type: "link",
                    attrs: { href: `folio-page://${linkTarget.id}` },
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    const { rows: _rows, ...databaseSettings } = emptyDatabase();
    databaseSettings.properties = [
      { id: "status", name: "Status", type: "select", options: ["open", "done"] },
      { id: "note", name: "Note", type: "text" },
    ];
    const owner = commitDatabaseOperation(
      aStore,
      prepareDatabaseCreation("Projects", null, databaseSettings),
    ).page!;
    const records = new RecordRepository(aStore);
    const alpha = records.create(owner.id, "Alpha", {
      status: "open",
      note: "keep",
    });
    records.create(owner.id, "Beta", { status: "done", note: "second" });
    const archivedOwner = commitDatabaseOperation(
      aStore,
      prepareDatabaseCreation("Archive", null, databaseSettings),
    ).page!;
    const archived = records.create(archivedOwner.id, "Archived row", {
      status: "done",
      note: "trash",
    });
    new RecordLifecycle(aStore).trashDatabase(
      archivedOwner.id,
      aStore.get(archivedOwner.id).revision,
    );

    const assetABytes = Buffer.from("alpha attachment bytes");
    const assetBBytes = Buffer.from("beta attachment bytes");
    const assetA = attachFile(
      aStore.db,
      join(aDirectory, "assets"),
      writeInput(root, "alpha.txt", assetABytes),
    );
    const assetB = attachFile(
      aStore.db,
      join(aDirectory, "assets"),
      writeInput(root, "beta.bin", assetBBytes),
    );

    const aOptions: SyncOptions = {
      store: aStore,
      workspaceId,
      clientId: aClientId,
      bindingId: randomUUID(),
      token: aToken,
      baseUrl: server.url,
      canApply: () => true,
    };
    const bOptions: SyncOptions = {
      store: bStore,
      workspaceId,
      clientId: bClientId,
      bindingId: randomUUID(),
      token: bToken,
      baseUrl: server.url,
      canApply: () => true,
    };

    const publisher = await openWorkspaceSync({ ...aOptions, mode: "publish" });
    await publisher.sendPending();
    expect(publisher.status()).toMatchObject({
      appliedRevision: 1,
      receivedCursor: 0,
      conflict: false,
    });

    await closeServer(server);
    const lease = acquireServerDirectoryLease(serverDirectory);
    let r1Backup: ReturnType<typeof createServerFullBackup>;
    try {
      r1Backup = createServerFullBackup({
        sourceDirectory: serverDirectory,
        destination: join(root, "server-r1-backup"),
        lease,
      });
    } finally {
      lease.close();
    }
    server = await startOperationalServer(serverDirectory);
    servers.push(server);
    const r1Manifest = inspectFullServerBackup(r1Backup.destination);
    expect(r1Manifest.counts).toMatchObject({
      changes: 1,
      operations: 1,
      devices: 2,
      activeDevices: 2,
      revokedDevices: 0,
    });
    expect(r1Manifest.assets.map((asset) => asset.sha256).sort()).toEqual(
      [assetA.sha256, assetB.sha256].sort(),
    );

    const receiver = await openWorkspaceSync({ ...bOptions, mode: "join" });
    await receiver.receiveAndStage();
    const staged = receiver.stagedTarget();
    expect(staged).not.toBeNull();
    await receiver.applyStaged(staged!);
    expect(receiver.status()).toMatchObject({
      appliedRevision: 1,
      receivedCursor: 1,
      conflict: false,
    });
    expect(bStore.get(home.id).title).toBe("Home");
    expect(bStore.get(alpha.pageId).title).toBe("Alpha");
    expect(bStore.get(archived.pageId).deletedAt).not.toBeNull();
    expect(existsSync(join(bDirectory, "assets", assetA.id))).toBe(true);
    expect(
      readFileSync(join(bDirectory, "assets", assetB.id)).equals(assetBBytes),
    ).toBe(true);

    aStore.update(home.id, aStore.get(home.id).revision, {
      title: "A remote winner",
    });
    bStore.update(home.id, bStore.get(home.id).revision, {
      title: "B local candidate",
    });
    await publisher.sendPending();
    expect(publisher.status().appliedRevision).toBe(2);
    const conflictStatus = await receiver.sendPending();
    expect(conflictStatus).toMatchObject({
      appliedRevision: 1,
      receivedCursor: 1,
      conflict: true,
    });

    const aOutbox = aStore.db
      .prepare(
        "SELECT operation_id,commit_json,result_json FROM workspace_sync_outbox ORDER BY rowid",
      )
      .all() as {
      operation_id: string;
      commit_json: string;
      result_json: string | null;
    }[];
    expect(aOutbox).toHaveLength(2);
    const r2Row = aOutbox[1];
    expect(r2Row.result_json).not.toBeNull();
    expect(JSON.parse(r2Row.result_json!)).toMatchObject({
      status: "applied",
      revision: 2,
      operationId: r2Row.operation_id,
    });
    const r2Commit = JSON.parse(r2Row.commit_json) as Commit;
    expect(r2Commit.operationId).toBe(r2Row.operation_id);

    const conflictTarget = receiver.conflictResolutionTarget("remote");
    expect(conflictTarget.remoteRevision).toBe(2);
    const decisionId = randomUUID();
    bStore.transaction(() =>
      reserveConflictDecision(bStore.db, decisionId, conflictTarget),
    );
    const reopenedB = reopenStore(bStore);
    const bEnv = syncEnvironment(bDirectory, bOptions);
    const startup = await runStartupWorkspaceSyncDetailed(
      reopenedB,
      () => ({ status: "empty", generation: 0 }),
      bEnv,
    );
    expect(startup.message).toContain("選択したリモート版を適用済み");
    const decision = readConflictDecision(reopenedB.db);
    expect(decision).toMatchObject({
      status: "ready",
      record: { id: decisionId, state: "consumed" },
    });
    if (decision.status === "ready")
      expect(consumedDecisionMatches(reopenedB.db, decision.record)).toBe(true);
    const archives = reopenedB.db
      .prepare("SELECT kind,checkpoint_json FROM workspace_sync_archives ORDER BY id")
      .all() as { kind: string; checkpoint_json: string }[];
    expect(archives.map((archive) => archive.kind)).toEqual(
      expect.arrayContaining(["conflict-local", "conflict-remote"]),
    );
    expect(
      checkpointHasTitle(
        archives.find((archive) => archive.kind === "conflict-local")!
          .checkpoint_json,
        "B local candidate",
      ),
    ).toBe(true);
    expect(
      checkpointHasTitle(
        archives.find((archive) => archive.kind === "conflict-remote")!
          .checkpoint_json,
        "A remote winner",
      ),
    ).toBe(true);
    expect(reopenedB.get(home.id).title).toBe("A remote winner");

    const oldRemoteA = new CheckpointRemote({
      baseUrl: server.url,
      workspaceId,
      token: aToken,
    });
    expect((await oldRemoteA.changes(0)).changes.map(change => change.revision)).toEqual([1]);
    expect((await oldRemoteA.changes(1)).changes.map(change => change.revision)).toEqual([2]);
    const duplicate = await oldRemoteA.commit(r2Commit);
    expect(duplicate).toMatchObject({
      status: "applied",
      revision: 2,
      operationId: r2Commit.operationId,
    });
    expect((await oldRemoteA.changes(0)).changes.map(change => change.revision)).toEqual([1]);
    expect((await oldRemoteA.changes(1)).changes.map(change => change.revision)).toEqual([2]);

    const reopenedAStore = reopenStore(aStore);
    const reopenedA = await openWorkspaceSync({
      ...aOptions,
      store: reopenedAStore,
    });
    await reopenedA.sendPending();
    await reopenedA.sendPending();
    expect((await oldRemoteA.head()).head.revision).toBe(2);
    expect((await oldRemoteA.changes(0)).changes.map(change => change.revision)).toEqual([1]);
    expect((await oldRemoteA.changes(1)).changes.map(change => change.revision)).toEqual([2]);
    expect(reopenedAStore.get(home.id).title).toBe("A remote winner");

    const oldLocalSnapshot = clientSnapshot(reopenedAStore);
    const oldReceiptIds = (
      reopenedAStore.db
        .prepare("SELECT operation_id FROM save_receipts ORDER BY operation_id")
        .all() as { operation_id: string }[]
    ).map((receipt) => receipt.operation_id);
    expect(oldReceiptIds.length).toBeGreaterThanOrEqual(3);

    await closeServer(server);
    const restored = restoreServerFullBackup({
      backupDirectory: r1Backup.destination,
      destination: join(root, "restored-server"),
      port,
    });
    expect(restored.previousEpoch).toBe(oldEpoch);
    expect(restored.serverEpoch).not.toBe(oldEpoch);

    const newClientId = randomUUID();
    const handoffDirectory = join(root, "handoff");
    mkdirSync(handoffDirectory, {mode: 0o700});
    const credentialFile = join(handoffDirectory, "new-client-credential.json");
    await issueOperationalCredential({
      directory: restored.destination,
      clientId: newClientId,
      credentialFile,
    });
    const credential = JSON.parse(readFileSync(credentialFile, "utf8")) as {
      format: string;
      baseUrl: string;
      workspaceId: string;
      clientId: string;
      token: string;
    };
    expect(credential).toMatchObject({
      format: "folio-sync-credential/v1",
      baseUrl: `http://127.0.0.1:${port}`,
      workspaceId,
      clientId: newClientId,
    });

    server = await startOperationalServer(restored.destination);
    servers.push(server);
    expect(server.serverEpoch).toBe(restored.serverEpoch);

    const oldRemoteRestored = new CheckpointRemote({
      baseUrl: server.url,
      workspaceId,
      token: aToken,
    });
    await expect(oldRemoteRestored.head()).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(oldRemoteRestored.commit(r2Commit)).rejects.toMatchObject({
      code: "unauthorized",
    });
    await expect(
      new CheckpointRemote({
        baseUrl: server.url,
        workspaceId,
        token: bToken,
      }).head(),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(() =>
      server.registerDevice({
        workspaceId,
        ownerId,
        clientId: aClientId,
        token: aToken,
      }),
    ).toThrow();

    const staleStartup = await runStartupWorkspaceSyncDetailed(
      reopenedAStore,
      () => ({ status: "empty", generation: 0 }),
      syncEnvironment(aDirectory, aOptions),
    );
    expect(staleStartup.message).toContain("unauthorized");
    await expect(
      openWorkspaceSync({ ...aOptions, store: reopenedAStore }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(clientSnapshot(reopenedAStore)).toEqual(oldLocalSnapshot);

    // Re-enrollment belongs to a verified normal backup restored into a NEW
    // client location. The original physical binding and receipts stay intact.
    const clientBackup = createFullBackup(reopenedAStore.db, aDirectory, join(root, "client-preserved"));
    const recoveryDirectory = join(root, "client-recovered");
    restoreFullBackup(clientBackup.directory, recoveryDirectory, clientBackup.fingerprint);
    const recoveryStore = openStore(recoveryDirectory);
    const recovered = await openWorkspaceSync({
      ...aOptions,
      store: recoveryStore,
      clientId: newClientId,
      bindingId: randomUUID(),
      token: credential.token,
      mode: "recover",
    });
    expect(recovered.status()).toMatchObject({
      appliedRevision: 0,
      receivedCursor: 0,
      generation: 1,
      cleanGeneration: 0,
    });
    expect(recoveryStore.get(home.id).title).toBe("A remote winner");
    expect(recoveryStore.get(alpha.pageId).title).toBe("Alpha");
    expect(recoveryStore.get(archived.pageId).deletedAt).not.toBeNull();
    const recoveredRemote = new CheckpointRemote({
      baseUrl: server.url,
      workspaceId,
      token: credential.token,
    });
    expect((await recoveredRemote.head()).head.revision).toBe(1);
    expect(
      recoveryStore.db
        .prepare(
          "SELECT client_id,server_epoch,applied_revision FROM workspace_sync_state",
        )
        .get(),
    ).toMatchObject({
      client_id: newClientId,
      server_epoch: restored.serverEpoch,
      applied_revision: 0,
    });
    expect(
      (
        recoveryStore.db
          .prepare("SELECT count(*) AS count FROM workspace_sync_outbox")
          .get() as { count: number }
      ).count,
    ).toBe(0);

    const beforeRebindNames = readdirSync(join(recoveryDirectory, "backups"))
      .filter((name) => name.startsWith("sync-before-rebind-"))
      .sort();
    expect(beforeRebindNames).toHaveLength(1);
    const beforeRebindDirectory = join(
      recoveryDirectory,
      "backups",
      beforeRebindNames[0],
    );
    const verified = verifyFullBackup(beforeRebindDirectory);
    expect(verified.manifest.inventory.saveReceipts).toBe(oldReceiptIds.length);
    expect(verified.manifest.inventory.registeredAssets).toBe(2);

    const backupDatabase = new DatabaseSync(
      join(beforeRebindDirectory, "workspace.sqlite"),
      { readOnly: true },
    );
    try {
      expect(
        (
          backupDatabase.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
      ).toBe(5);
      expect(
        backupDatabase
          .prepare(
            "SELECT workspace_id,client_id,binding_id,server_epoch,applied_revision,received_cursor FROM workspace_sync_state",
          )
          .get(),
      ).toMatchObject({
        workspace_id: workspaceId,
        client_id: aClientId,
        binding_id: aOptions.bindingId,
        server_epoch: oldEpoch,
        applied_revision: 2,
      });
      const backupOutbox = backupDatabase
        .prepare(
          "SELECT operation_id,commit_json,result_json FROM workspace_sync_outbox ORDER BY rowid",
        )
        .all() as {
        operation_id: string;
        commit_json: string;
        result_json: string | null;
      }[];
      expect(backupOutbox.map((row) => row.operation_id)).toEqual([
        aOutbox[0].operation_id,
        r2Commit.operationId,
      ]);
      expect(backupOutbox.every((row) => row.result_json !== null)).toBe(true);
      expect(JSON.parse(backupOutbox[0].result_json!)).toMatchObject({
        status: "applied",
        revision: 1,
        operationId: aOutbox[0].operation_id,
      });
      expect(JSON.parse(backupOutbox[1].result_json!)).toMatchObject({
        status: "applied",
        revision: 2,
        operationId: r2Commit.operationId,
      });
      const applied = backupDatabase
        .prepare(
          "SELECT revision,checkpoint_json FROM workspace_sync_applied WHERE singleton=1",
        )
        .get() as { revision: number; checkpoint_json: string };
      expect(applied.revision).toBe(2);
      expect(checkpointHasTitle(applied.checkpoint_json, "A remote winner")).toBe(
        true,
      );
      const checkpoint = JSON.parse(applied.checkpoint_json) as {
        payload: {
          tables: {
            pages: unknown[];
            record_memberships: unknown[];
            record_database_trash_batches: unknown[];
            record_database_trash_members: unknown[];
          };
        };
        assets: { sha256: string }[];
      };
      expect(checkpoint.payload.tables.record_memberships).toHaveLength(3);
      expect(
        checkpoint.payload.tables.record_database_trash_batches,
      ).toHaveLength(1);
      expect(
        checkpoint.payload.tables.record_database_trash_members,
      ).toHaveLength(1);
      expect(checkpoint.assets.map((asset) => asset.sha256).sort()).toEqual(
        [assetA.sha256, assetB.sha256].sort(),
      );
      const databasePages = (
        backupDatabase
          .prepare("SELECT count(*) AS count FROM pages")
          .get() as { count: number }
      ).count;
      expect(checkpoint.payload.tables.pages).toHaveLength(databasePages);
      expect(databasePages).toBeGreaterThanOrEqual(7);
      expect(
        (
          backupDatabase
            .prepare(
              "SELECT count(*) AS count FROM record_database_trash_batches",
            )
            .get() as { count: number }
        ).count,
      ).toBe(1);
      const backupReceiptIds = (
        backupDatabase
          .prepare("SELECT operation_id FROM save_receipts ORDER BY operation_id")
          .all() as { operation_id: string }[]
      ).map((receipt) => receipt.operation_id);
      expect(backupReceiptIds).toEqual(oldReceiptIds);
      const backupAssetIds = (
        backupDatabase
          .prepare("SELECT id FROM assets ORDER BY id")
          .all() as { id: string }[]
      ).map((asset) => asset.id);
      expect(backupAssetIds).toEqual([assetA.id, assetB.id].sort());
    } finally {
      backupDatabase.close();
    }
    expect(clientSnapshot(reopenedAStore)).toEqual(oldLocalSnapshot);
    expect(
      readFileSync(join(beforeRebindDirectory, "assets", assetA.id)).equals(
        assetABytes,
      ),
    ).toBe(true);
    expect(
      readFileSync(join(beforeRebindDirectory, "assets", assetB.id)).equals(
        assetBBytes,
      ),
    ).toBe(true);
  },
  120_000,
);
