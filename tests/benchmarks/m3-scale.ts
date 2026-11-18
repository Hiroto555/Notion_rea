import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { attachFile } from "../../src/persistence/assets";
import { commitDatabaseOperation } from "../../src/persistence/database-operations";
import { RecordRepository } from "../../src/persistence/record-repository";
import { Store } from "../../src/persistence/store";
import { runStartupWorkspaceSyncDetailed } from "../../src/main/workspace-sync-startup";
import { prepareDatabaseCreation } from "../../src/shared/database-operation";
import { preparePageCreation } from "../../src/shared/page-operation";
import { emptyDatabase, type Doc } from "../../src/shared/types";
import { CheckpointRemote } from "../../src/sync/client";
import {
  initializeOperationalServer,
  issueOperationalCredential,
  startOperationalServer,
} from "../../src/sync/operational-server";
import {
  canonicalJson,
  hashCheckpoint,
  MAX_CHECKPOINT_BYTES,
} from "../../src/sync/protocol";
import {
  createServerFullBackup,
  restoreServerFullBackup,
} from "../../src/sync/server-full-backup";
import { inspectFullServerBackup } from "../../src/sync/server-full-inspection";
import { inspectServerHistory } from "../../src/sync/server-history-validation";
import {
  acquireServerDirectoryLease,
  type ServerDirectoryLease,
} from "../../src/sync/server-directory-lease";
import {
  buildWorkspaceCheckpoint,
  validateWorkspaceCheckpoint,
} from "../../src/sync/workspace-checkpoint";
import { openWorkspaceSync } from "../../src/sync/workspace-sync";

type RunningServer = Awaited<ReturnType<typeof startOperationalServer>>;
type AssetInfo = { id: string; sha256: string; size: number };

const BUDGETS = Object.freeze({
  checkpointBuildHashMs: 500,
  windowlessStartupMs: 10_000,
  offlineBackupMs: 30_000,
  restoreMs: 30_000,
  maxRssBytes: 1024 * 1024 * 1024,
});
const MINIMUM_TEMP_FREE_BYTES = 3 * 1024 * 1024 * 1024;
const ASSET_BYTES = 20_000_000;
const ASSET_COUNT = 5;
const ORDINARY_PAGES = 100;
const RECORDS = 100;
const REVISIONS = 8;
const TEXT_512 = "0123456789abcdef".repeat(32);

function freeBytes(path: string): number {
  const stat = statfsSync(path, { bigint: true });
  return Number(stat.bsize * stat.bavail);
}

function assertFreeSpace(path: string): void {
  const available = freeBytes(path);
  assert.ok(
    available >= MINIMUM_TEMP_FREE_BYTES,
    `temporary free space ${available} is below 3 GiB`,
  );
}

function directoryBytes(path: string): number {
  let total = 0;
  for (const name of readdirSync(path)) {
    const entry = lstatSync(join(path, name));
    total += entry.isDirectory()
      ? directoryBytes(join(path, name))
      : entry.size;
  }
  return total;
}

function treeHashes(path: string, prefix = ""): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const name of readdirSync(path).sort()) {
    // SQLite may create its own empty WAL/SHM on a read-only inspection.
    // Compare persistent DB/config/lock/blob content, not that transient state.
    if (!prefix && ["server.sqlite-wal", "server.sqlite-shm"].includes(name)) continue;
    const child = join(path, name), key = prefix + name;
    if (lstatSync(child).isDirectory()) Object.assign(hashes, treeHashes(child, key + "/"));
    else hashes[key] = createHash("sha256").update(readFileSync(child)).digest("hex");
  }
  return hashes;
}

function richDoc(text: string, references: readonly string[] = []): Doc {
  const content: NonNullable<Doc["content"]> = [
    { type: "paragraph", content: [{ type: "text", text }] },
  ];
  if (references.length)
    content.push({
      type: "paragraph",
      content: references.map((reference) => ({
        type: "text",
        text: reference,
      })),
    });
  return { type: "doc", content };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function serverDatabaseHistory(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return inspectServerHistory(db);
  } finally {
    db.close();
  }
}

function assertBudget(name: string, actual: number, budget: number): void {
  assert.ok(
    actual <= budget,
    `${name} ${actual.toFixed(1)} exceeded budget ${budget}`,
  );
}

async function main(): Promise<void> {
  assertFreeSpace(realpathSync(tmpdir()));
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "folio-m3-scale-")),
  );
  let store: Store | undefined;
  let server: RunningServer | undefined;
  let lease: ServerDirectoryLease | undefined;
  try {
    assertFreeSpace(root);
    const workspaceId = randomUUID();
    const ownerId = randomUUID();
    const clientDirectory = join(root, "client");
    mkdirSync(clientDirectory, { mode: 0o700 });
    mkdirSync(join(clientDirectory, "assets"), { mode: 0o700 });
    store = new Store(join(clientDirectory, "workspace.sqlite"));

    const pages = [];
    for (let index = 0; index < ORDINARY_PAGES; index++) {
      const created = store.commitPageOperation(
        preparePageCreation(`Page ${index}`),
      ).page;
      assert.ok(created);
      pages.push(
        store.update(created.id, created.revision, {
          doc: richDoc(TEXT_512),
        }),
      );
    }
    const target = pages[0];

    const { rows: _rows, ...settings } = emptyDatabase();
    settings.properties = [
      {
        id: "status",
        name: "Status",
        type: "select",
        options: ["open", "done"],
      },
      { id: "note", name: "Note", type: "text" },
    ];
    const databaseOwner = commitDatabaseOperation(
      store,
      prepareDatabaseCreation("Projects", null, settings),
    ).page;
    assert.ok(databaseOwner);
    const records = new RecordRepository(store);
    for (let index = 0; index < RECORDS; index++)
      records.create(databaseOwner.id, `Record ${index}`, {
        status: index % 2 === 0 ? "open" : "done",
        note: `note-${index}`,
      });

    const assets: AssetInfo[] = [];
    const assetReferences: string[] = [];
    for (let index = 0; index < ASSET_COUNT; index++) {
      const file = join(root, `asset-input-${index}.bin`);
      writeFileSync(file, randomBytes(ASSET_BYTES), { mode: 0o600 });
      const asset = attachFile(
        store.db,
        join(clientDirectory, "assets"),
        file,
      );
      assets.push({ id: asset.id, sha256: asset.sha256, size: asset.size });
      assetReferences.push(`folio-asset://${asset.id}`);
    }
    const assetBytes = assets.reduce((total, asset) => total + asset.size, 0);
    assert.equal(assetBytes, 100_000_000);
    assert.equal(new Set(assets.map((asset) => asset.sha256)).size, 5);

    const targetNow = store.get(target.id);
    store.update(target.id, targetNow.revision, {
      doc: richDoc(TEXT_512, assetReferences),
    });

    const buildStarted = performance.now();
    const checkpoint = buildWorkspaceCheckpoint(store.db);
    hashCheckpoint(checkpoint);
    const checkpointBuildHashMs = performance.now() - buildStarted;
    const checkpointBytes = Buffer.byteLength(canonicalJson(checkpoint));
    assert.equal(validateWorkspaceCheckpoint(checkpoint), true);
    assert.ok(checkpointBytes <= MAX_CHECKPOINT_BYTES);
    const checkpointTables = (
      checkpoint.payload as {
        tables: { pages: unknown[]; record_memberships: unknown[] };
      }
    ).tables;
    const pageCount = checkpointTables.pages.length;
    const recordCount = checkpointTables.record_memberships.length;
    assert.equal(pageCount, ORDINARY_PAGES + 1 + RECORDS);
    assert.equal(recordCount, RECORDS);
    assertBudget(
      "checkpoint build+hash",
      checkpointBuildHashMs,
      BUDGETS.checkpointBuildHashMs,
    );

    const port = await freePort();
    const serverDirectory = join(root, "server");
    const initialized = await initializeOperationalServer(serverDirectory, {
      format: "folio-server-config/v1",
      workspaceId,
      ownerId,
      port,
    });
    const oldEpoch = initialized.serverEpoch;
    const handoff = join(root, "handoff");
    mkdirSync(handoff, { mode: 0o700 });
    const clientId = randomUUID();
    const credentialFile = join(handoff, "credential.json");
    await issueOperationalCredential({
      directory: serverDirectory,
      clientId,
      credentialFile,
    });
    const credential = JSON.parse(readFileSync(credentialFile, "utf8")) as {
      format: string;
      baseUrl: string;
      workspaceId: string;
      clientId: string;
      token: string;
    };
    assert.equal(credential.workspaceId, workspaceId);
    assert.equal(credential.clientId, clientId);
    server = await startOperationalServer(serverDirectory);
    assert.equal(server.serverEpoch, oldEpoch);

    const bindingId = randomUUID();
    const publisher = await openWorkspaceSync({
      store,
      workspaceId,
      clientId,
      bindingId,
      token: credential.token,
      baseUrl: server.url,
      canApply: () => true,
      mode: "publish",
    });
    const sendMs: number[] = [];
    for (let revision = 1; revision <= REVISIONS; revision++) {
      const current = store.get(target.id);
      store.update(target.id, current.revision, {
        title: `Sync revision ${revision}`,
      });
      const started = performance.now();
      const status = await publisher.sendPending();
      sendMs.push(performance.now() - started);
      assert.equal(status.appliedRevision, revision);
    }
    assert.equal(publisher.status().appliedRevision, REVISIONS);

    const remote = new CheckpointRemote({
      baseUrl: server.url,
      workspaceId,
      token: credential.token,
    });
    const head = await remote.head();
    assert.equal(head.serverEpoch, oldEpoch);
    assert.equal(head.head.revision, REVISIONS);
    assert.ok(head.head.checkpoint);
    const revisions: number[] = [];
    for (let after = 0; after < REVISIONS; after++) {
      const changePage = await remote.changes(after);
      assert.equal(changePage.changes.length, 1);
      revisions.push(changePage.changes[0].revision);
    }
    assert.deepEqual(revisions, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(new Set(revisions).size, REVISIONS);
    const headAssets = head.head.checkpoint.assets;
    assert.equal(headAssets.length, ASSET_COUNT);
    const assetShas = assets.map((asset) => asset.sha256).sort();
    assert.deepEqual(
      headAssets.map((asset) => asset.sha256).sort(),
      assetShas,
    );
    const headPages = (
      head.head.checkpoint.payload as {
        tables: { pages: [string, string][] };
      }
    ).tables.pages;
    const targetRow = headPages.find(([id]) => id === target.id);
    assert.ok(targetRow);
    const targetDocumentJson = JSON.stringify(
      JSON.parse(targetRow[1]).doc,
    );
    for (const reference of assetReferences)
      assert.ok(targetDocumentJson.includes(reference));
    assert.ok(targetDocumentJson.includes(TEXT_512));

    store.close();
    const startupStarted = performance.now();
    store = new Store(join(clientDirectory, "workspace.sqlite"));
    const startup = await runStartupWorkspaceSyncDetailed(store,
      () => ({status: "empty", generation: 0}), {
        FOLIO_SYNC_ENABLED: "1", FOLIO_DATA_DIR: clientDirectory,
        FOLIO_SYNC_URL: server.url, FOLIO_SYNC_WORKSPACE: workspaceId,
        FOLIO_SYNC_CLIENT: clientId, FOLIO_SYNC_BINDING: bindingId,
        FOLIO_SYNC_TOKEN: credential.token,
      });
    const windowlessStartupMs = performance.now() - startupStarted;
    assert.ok(startup.opened);
    assert.equal(startup.opened.status().appliedRevision, REVISIONS);
    assert.equal(store.pages().length, pageCount);
    assertBudget("windowless startup", windowlessStartupMs, BUDGETS.windowlessStartupMs);

    await server.close();
    server = undefined;
    const originalServerHashes = treeHashes(serverDirectory);
    const backupDirectory = join(root, "server-backup");
    lease = acquireServerDirectoryLease(serverDirectory);
    const backupStarted = performance.now();
    let backup;
    try {
      backup = createServerFullBackup({
        sourceDirectory: serverDirectory,
        destination: backupDirectory,
        lease,
      });
    } finally {
      lease.close();
      lease = undefined;
    }
    const offlineBackupMs = performance.now() - backupStarted;
    assertBudget(
      "offline backup",
      offlineBackupMs,
      BUDGETS.offlineBackupMs,
    );

    const verified = inspectFullServerBackup(backup.destination);
    assert.equal(verified.serverEpoch, oldEpoch);
    assert.equal(verified.counts.changes, REVISIONS);
    assert.equal(verified.counts.operations, REVISIONS);
    assert.equal(verified.counts.devices, 1);
    assert.equal(verified.counts.activeDevices, 1);
    assert.equal(verified.counts.revokedDevices, 0);
    assert.equal(verified.assets.length, ASSET_COUNT);
    assert.equal(
      verified.assets.reduce((total, asset) => total + asset.bytes, 0),
      100_000_000,
    );
    assert.deepEqual(
      verified.assets.map((asset) => asset.sha256).sort(),
      assetShas,
    );
    const backupDatabaseSha = verified.database.sha256;
    const backupCreatedAt = verified.createdAt;
    const backupBytes = directoryBytes(backup.destination);

    const restoreStarted = performance.now();
    const restored = restoreServerFullBackup({
      backupDirectory: backup.destination,
      destination: join(root, "restored-server"),
      port,
    });
    const restoreMs = performance.now() - restoreStarted;
    assertBudget("restore", restoreMs, BUDGETS.restoreMs);
    assert.equal(restored.previousEpoch, oldEpoch);
    assert.notEqual(restored.serverEpoch, oldEpoch);

    const restoredHistory = serverDatabaseHistory(
      join(restored.destination, "server.sqlite"),
    );
    assert.equal(restoredHistory.serverEpoch, restored.serverEpoch);
    assert.equal(restoredHistory.changes, REVISIONS);
    assert.equal(restoredHistory.operations, REVISIONS);
    assert.equal(restoredHistory.devices, 1);
    assert.equal(restoredHistory.activeDevices, 0);
    assert.equal(restoredHistory.revokedDevices, 1);
    assert.equal(restoredHistory.assets.length, ASSET_COUNT);
    assert.deepEqual(
      restoredHistory.assets.map((asset) => asset.sha256).sort(),
      assetShas,
    );

    const restoredHandoff = join(root, "handoff-restored");
    mkdirSync(restoredHandoff, { mode: 0o700 });
    const restoredClientId = randomUUID();
    const restoredCredentialFile = join(
      restoredHandoff,
      "credential.json",
    );
    await issueOperationalCredential({
      directory: restored.destination,
      clientId: restoredClientId,
      credentialFile: restoredCredentialFile,
    });
    const restoredCredential = JSON.parse(
      readFileSync(restoredCredentialFile, "utf8"),
    ) as { token: string };
    server = await startOperationalServer(restored.destination);
    assert.equal(server.serverEpoch, restored.serverEpoch);

    const oldRemote = new CheckpointRemote({
      baseUrl: server.url,
      workspaceId,
      token: credential.token,
    });
    await assert.rejects(
      async () => {
        await oldRemote.head();
      },
      (error: unknown) =>
        (error as { code?: string }).code === "unauthorized",
    );

    const restoredRemote = new CheckpointRemote({
      baseUrl: server.url,
      workspaceId,
      token: restoredCredential.token,
    });
    const restoredHead = await restoredRemote.head();
    assert.equal(restoredHead.serverEpoch, restored.serverEpoch);
    assert.equal(restoredHead.head.revision, REVISIONS);
    assert.ok(restoredHead.head.checkpoint);
    assert.equal(restoredHead.head.checkpoint.assets.length, ASSET_COUNT);
    assert.deepEqual(
      restoredHead.head.checkpoint.assets
        .map((asset) => asset.sha256)
        .sort(),
      assetShas,
    );

    const sourceAfter = inspectFullServerBackup(backup.destination);
    assert.deepEqual(treeHashes(serverDirectory), originalServerHashes);
    assert.equal(sourceAfter.database.sha256, backupDatabaseSha);
    assert.equal(sourceAfter.createdAt, backupCreatedAt);
    assert.deepEqual(
      sourceAfter.assets.map((asset) => asset.sha256).sort(),
      assetShas,
    );
    const restoreBytes = directoryBytes(restored.destination);
    const clientWorkspaceBytes = directoryBytes(clientDirectory);
    const tempEstimatedBytes = directoryBytes(root);
    await server.close();
    server = undefined;

    const maxRssBytes = process.resourceUsage().maxRSS * 1024;
    assertBudget("maxRSS", maxRssBytes, BUDGETS.maxRssBytes);

    const metrics = {
      PASS: true,
      counts: {
        ordinaryPages: ORDINARY_PAGES,
        databaseOwners: 1,
        recordPages: RECORDS,
        pageCount,
        recordCount,
        assets: ASSET_COUNT,
        revisions: REVISIONS,
        headRevision: restoredHead.head.revision,
        changes: restoredHistory.changes,
        operations: restoredHistory.operations,
        devices: restoredHistory.devices,
        activeDevicesAfterRestore: restoredHistory.activeDevices,
        revokedDevicesAfterRestore: restoredHistory.revokedDevices,
      },
      timingsMs: {
        checkpointBuildHash: checkpointBuildHashMs,
        windowlessStartup: windowlessStartupMs,
        sends: sendMs,
        maxSend: Math.max(...sendMs),
        offlineBackup: offlineBackupMs,
        restore: restoreMs,
      },
      sizes: {
        assetsTotalBytes: assetBytes,
        checkpointUtf8Bytes: checkpointBytes,
        backupBytes,
        restoreBytes,
        clientWorkspaceBytes,
        tempEstimatedBytes,
        maxRssBytes,
      },
      checks: {
        checkpointValid: true,
        checkpointWithinLimit: checkpointBytes <= MAX_CHECKPOINT_BYTES,
        headIsEight: restoredHead.head.revision === REVISIONS,
        revisionsUnique: new Set(revisions).size === REVISIONS,
        assetReferencesRetained: true,
        epochChanged: restored.serverEpoch !== oldEpoch,
        oldDevicesRevoked: restoredHistory.activeDevices === 0,
        assetHashesMatch: true,
        countsMatch: true,
        sourceUnchanged: sourceAfter.database.sha256 === backupDatabaseSha,
        originalServerPersistentContentUnchanged: true,
      },
      budgets: BUDGETS,
    };
    console.log(`M3_SCALE_METRICS ${JSON.stringify(metrics)}`);
  } finally {
    if (server) {
      try {
        await server.close();
      } catch {}
    }
    if (lease) {
      try {
        lease.close();
      } catch {}
    }
    if (store) {
      try {
        store.close();
      } catch {}
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
