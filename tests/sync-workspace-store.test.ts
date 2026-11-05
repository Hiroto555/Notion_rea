import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { attachFile } from "../src/persistence/assets";
import { createFullBackup } from "../src/persistence/full-backup-create";
import { markRecordStoreVersion } from "../src/persistence/record-version";
import { RecordLifecycle } from "../src/persistence/record-lifecycle";
import { convertLegacyRecordsInTransaction } from "../src/persistence/record-migration";
import {
  WorkspaceSyncStore,
  validateWorkspaceSyncSchema,
  type WorkspaceSyncIdentity,
} from "../src/sync/workspace-store";
import {
  validateWorkspaceCheckpoint,
  WORKSPACE_CONTENT_TABLES,
} from "../src/sync/workspace-checkpoint";
import {
  fingerprintCommit,
  hashCheckpoint,
  type Change,
  type Checkpoint,
  type Commit,
  type CommitResult,
} from "../src/sync/protocol";

const roots: string[] = [];
const stores: Store[] = [];

function makeStore(): { store: Store; path: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "folio-sync-workspace-"));
  roots.push(root);
  const path = join(root, "workspace.sqlite");
  const store = new Store(path);
  stores.push(store);
  return { store, path, root };
}

function identity(clientId = "client-a"): WorkspaceSyncIdentity {
  return {
    workspaceId: "workspace",
    clientId,
    bindingId: "binding-" + clientId,
    serverEpoch: "epoch-1",
  };
}

function userVersion(store: Store): number {
  return (
    store.db.prepare("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
}

function asChange(commit: Commit, revision: number): Change {
  return {
    revision,
    clientId: commit.clientId,
    operationId: commit.operationId,
    fingerprint: fingerprintCommit(commit),
    checkpointHash: commit.checkpointHash,
    checkpoint: commit.checkpoint,
  };
}

function applied(
  commit: Commit,
  revision: number,
): Extract<CommitResult, { status: "applied" }> {
  return {
    protocol: 1,
    workspaceId: commit.workspaceId,
    clientId: commit.clientId,
    operationId: commit.operationId,
    serverEpoch: commit.serverEpoch,
    fingerprint: fingerprintCommit(commit),
    status: "applied",
    revision,
    checkpointHash: commit.checkpointHash,
  };
}

function conflictResult(
  commit: Commit,
  revision: number,
  checkpoint: Checkpoint | null,
): Extract<CommitResult, { status: "conflict" }> {
  return {
    protocol: 1,
    workspaceId: commit.workspaceId,
    clientId: commit.clientId,
    operationId: commit.operationId,
    serverEpoch: commit.serverEpoch,
    fingerprint: fingerprintCommit(commit),
    status: "conflict",
    head: {
      revision,
      checkpointHash: checkpoint ? hashCheckpoint(checkpoint) : null,
      checkpoint,
    },
  };
}

function changePage(
  workspaceId: string,
  serverEpoch: string,
  after: number,
  headRevision: number,
  changes: Change[],
): Parameters<WorkspaceSyncStore["stageChanges"]>[0] {
  return {
    protocol: 1,
    workspaceId,
    serverEpoch,
    after,
    headRevision,
    changes,
  };
}

afterEach(() => {
  for (const store of stores.splice(0))
    try {
      store.close();
    } catch {}
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("explicit version-5 promotion", () => {
  it("creates the durable schema, triggers and identity in one opt-in call", () => {
    const { store, path } = makeStore(),
      sync = new WorkspaceSyncStore(store, identity());
    let backups = 0;
    sync.enable("publish", () => backups++);
    expect(backups).toBe(1);
    expect(userVersion(store)).toBe(5);
    const tables = (
      store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    for (const name of [
      "workspace_sync_state",
      "workspace_sync_outbox",
      "workspace_sync_inbox",
      "workspace_sync_conflicts",
      "workspace_sync_archives",
      "workspace_sync_applied",
      "record_database_trash_batches",
      "legacy_database_archive",
      "legacy_record_map",
    ])
      expect(tables).toContain(name);
    const triggers = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
      .all() as { name: string }[];
    expect(triggers).toHaveLength((WORKSPACE_CONTENT_TABLES.length + 3) * 3);
    expect(sync.status()).toEqual({
      receivedCursor: 0,
      appliedRevision: 0,
      generation: 1,
      cleanGeneration: 0,
      pending: true,
      conflict: false,
    });

    const prepared = sync.prepare()!;
    expect(prepared.baseRevision).toBe(0);
    expect(prepared.checkpoint.assets).toEqual([]);
    expect(validateWorkspaceCheckpoint(prepared.checkpoint)).toBe(true);
    // A pending immutable envelope is resumed, never re-created.
    expect(sync.prepare()!.operationId).toBe(prepared.operationId);
    sync.recordResult(prepared, applied(prepared, 1));
    expect(sync.status()).toMatchObject({
      appliedRevision: 1,
      generation: 1,
      cleanGeneration: 1,
      pending: false,
    });

    // Identical identity is idempotent and does not require another backup.
    sync.enable("join", () => backups++);
    expect(backups).toBe(1);
    expect(userVersion(store)).toBe(5);
    expect(() =>
      new WorkspaceSyncStore(store, identity("other")).enable(
        "publish",
        () => {},
      ),
    ).toThrow(/identity-mismatch/);

    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = new Store(path);
    stores.push(reopened);
    const resumed = new WorkspaceSyncStore(reopened, identity());
    expect(resumed.status()).toMatchObject({
      appliedRevision: 1,
      pending: false,
    });
    expect(() => validateWorkspaceSyncSchema(reopened.db)).not.toThrow();
  });

  it("an inherited v4 Store binary refuses the promoted v5 workspace", () => {
    const root = mkdtempSync(resolve("output/sync-old-store-"));
    roots.push(root);
    const { store, path } = makeStore();
    new WorkspaceSyncStore(store, identity()).enable("publish", () => {});
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const source = join(root, "source");
    mkdirSync(source);
    const archive = execFileSync("git", ["archive", "0dc5117", "src"], {
      maxBuffer: 20_000_000,
    });
    execFileSync("tar", ["-xf", "-", "-C", source], { input: archive });
    const bundle = join(root, "old-store.cjs");
    buildSync({
      entryPoints: [join(source, "src/persistence/store.ts")],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      logLevel: "silent",
    });
    const script = `const {Store}=require(process.argv[1]); try { new Store(process.argv[2]).close(); console.log("opened"); } catch(e) { console.error(e.message); process.exit(3); }`;
    try {
      execFileSync(process.execPath, ["-e", script, bundle, path], {
        encoding: "utf8",
        stdio: "pipe",
      });
      throw new Error("old Store unexpectedly opened the v5 workspace");
    } catch (error: any) {
      expect(error.status).toBe(3);
      expect(String(error.stderr)).toContain("requires a newer Folio version");
    }
  });

  it("refuses join on non-empty content before calling the backup barrier", () => {
    const { store } = makeStore(),
      sync = new WorkspaceSyncStore(store, identity());
    store.create(null, "page", "existing");
    let backups = 0;
    expect(() => sync.enable("join", () => backups++)).toThrow(
      /empty-workspace/,
    );
    expect(backups).toBe(0);
    expect(userVersion(store)).toBe(3);
    expect(
      store.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name='workspace_sync_state'",
        )
        .get(),
    ).toBeUndefined();
  });

  it("rolls back a promotion interrupted after the v5 marker was written", () => {
    const { store } = makeStore();
    const page = store.create(null, "page", "Preserve before promotion");
    const sync = new WorkspaceSyncStore(store, identity());
    const exec = store.db.exec.bind(store.db);
    const fault = vi.spyOn(store.db, "exec").mockImplementation((sql) => {
      exec(sql);
      if (sql === "PRAGMA user_version=5")
        throw new Error("migration interrupted");
    });
    try {
      expect(() => sync.enable("publish", () => {})).toThrow(
        "migration interrupted",
      );
      expect(userVersion(store)).toBe(3);
      expect(store.get(page.id)).toEqual(page);
      expect(
        store.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name LIKE 'workspace_sync_%'",
          )
          .all(),
      ).toEqual([]);
    } finally {
      fault.mockRestore();
    }
    sync.enable("publish", () => {});
    expect(userVersion(store)).toBe(5);
    expect(sync.prepare()).not.toBeNull();
  });

  it("preserves the user version when the legacy record marker runs on v5", () => {
    const { store } = makeStore(),
      sync = new WorkspaceSyncStore(store, identity());
    sync.enable("publish", () => {});
    store.transaction(() => {
      new RecordRepository(store).createSchema();
      markRecordStoreVersion(store.db);
    });
    expect(userVersion(store)).toBe(5);
  });
});

describe("durable trigger capture and checkpoint payload", () => {
  it("captures pages, history, direct asset DML and record tables", () => {
    const { store, root } = makeStore(),
      sync = new WorkspaceSyncStore(store, identity());
    sync.enable("publish", () => {});
    const empty = sync.prepare()!;
    sync.recordResult(empty, applied(empty, 1));

    const page = store.create(null, "page", "Alpha");
    store.update(page.id, 0, {
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "searchable body" }],
          },
        ],
      },
    });
    const database = store.create(null, "database", "DB");
    const repo = new RecordRepository(store);
    const record = repo.create(database.id, "Row", { status: "進行中" });
    const assets = join(root, "assets");
    mkdirSync(assets);
    const file = join(root, "image.png");
    writeFileSync(file, Buffer.from("attachment bytes"));
    const attached = attachFile(store.db, assets, file);

    const status = sync.status();
    expect(status.generation).toBeGreaterThan(1);
    expect(status.pending).toBe(true);
    const prepared = sync.prepare()!;
    const tables = (
      prepared.checkpoint.payload as unknown as {
        tables: Record<string, (string | number | null)[][]>;
      }
    ).tables;
    expect(tables.pages.map((row) => row[0])).toEqual(
      expect.arrayContaining([page.id, database.id, record.pageId]),
    );
    expect(tables.versions).toHaveLength(1);
    expect(tables.assets.map((row) => row[0])).toEqual([attached.id]);
    expect(tables.record_databases.map((row) => row[0])).toEqual([database.id]);
    expect(tables.record_memberships.map((row) => row[0])).toEqual([
      record.pageId,
    ]);
    expect(
      (prepared.checkpoint as unknown as { assets: unknown }).assets,
    ).toEqual([
      { id: attached.id, sha256: attached.sha256, bytes: attached.size },
    ]);
    expect(
      validateWorkspaceCheckpoint(prepared.checkpoint, empty.checkpoint),
    ).toBe(true);
    sync.recordResult(prepared, applied(prepared, 2));
    expect(sync.status().pending).toBe(false);
  });

  it("validates record trash and legacy archive/map relationships", () => {
    const { store } = makeStore();
    const legacy = store.create(null, "database", "Legacy");
    store.update(legacy.id, 0, {
      database: {
        ...legacy.database!,
        rows: [{ id: "legacy-row", title: "Old row", values: {} }],
      },
    });
    const sync = new WorkspaceSyncStore(store, identity());
    sync.enable("publish", () => {});
    const legacyCommit = sync.prepare()!;
    expect(validateWorkspaceCheckpoint(legacyCommit.checkpoint)).toBe(true);
    sync.recordResult(legacyCommit, applied(legacyCommit, 1));
    store.transaction(() => {
      convertLegacyRecordsInTransaction(store);
    });
    expect(userVersion(store)).toBe(5);
    const convertedCommit = sync.prepare()!;
    const converted = convertedCommit.checkpoint;
    const convertedTables = (
      converted.payload as unknown as {
        tables: Record<string, (string | number | null)[][]>;
      }
    ).tables;
    expect(
      convertedTables.legacy_database_archive.map((row) => row[0]),
    ).toEqual([legacy.id]);
    expect(convertedTables.legacy_record_map).toHaveLength(1);
    expect(validateWorkspaceCheckpoint(converted)).toBe(true);
    sync.recordResult(convertedCommit, applied(convertedCommit, 2));

    const database = store.create(null, "database", "Trash DB");
    const repo = new RecordRepository(store);
    const record = repo.create(database.id, "Record", { status: "未着手" });
    new RecordLifecycle(store).trashDatabase(
      database.id,
      store.get(database.id).revision,
    );
    const trashed = sync.prepare()!.checkpoint;
    const trashTables = (
      trashed.payload as unknown as {
        tables: Record<string, (string | number | null)[][]>;
      }
    ).tables;
    expect(
      trashTables.record_database_trash_batches.map((row) => row[0]),
    ).toEqual([database.id]);
    expect(trashTables.record_database_trash_members).toEqual([
      [database.id, record.pageId, expect.any(Number)],
    ]);
    expect(validateWorkspaceCheckpoint(trashed)).toBe(true);
  });

  it("promotes a backed-up v4 database with a history-only legacy ID reservation", () => {
    const { store, root } = makeStore();
    const legacy = store.create(null, "database", "Legacy history");
    const populated = store.update(legacy.id, legacy.revision, {
      database: {
        ...legacy.database!,
        rows: [{ id: "history-only", title: "Historical row", values: {} }],
      },
    });
    store.update(legacy.id, populated.revision, {
      database: { ...legacy.database!, rows: [] },
    });
    store.transaction(() => {
      convertLegacyRecordsInTransaction(store);
    });
    expect(userVersion(store)).toBe(4);
    const mapping = store.db
      .prepare(
        "SELECT page_id FROM legacy_record_map WHERE legacy_row_id='history-only'",
      )
      .get()!;
    expect(() => store.get(String(mapping.page_id))).toThrow();

    const sync = new WorkspaceSyncStore(store, identity());
    sync.enable("publish", () => {
      expect(
        createFullBackup(store.db, root, join(root, "pre-sync")).manifest
          .storeVersion,
      ).toBe(4);
    });
    const checkpoint = sync.prepare()!.checkpoint;
    expect(checkpoint.payload.tables).toMatchObject({
      legacy_record_map: [[legacy.id, "history-only", mapping.page_id]],
    });
    expect(
      createFullBackup(store.db, root, join(root, "post-sync")).manifest
        .storeVersion,
    ).toBe(5);
  });

  it("rejects unknown or partial table schemas and omitted prior pages", () => {
    const { store } = makeStore(),
      sync = new WorkspaceSyncStore(store, identity());
    sync.enable("publish", () => {});
    const page = store.create(null, "page", "kept");
    store.update(page.id, 0, { title: "kept edited" });
    const current = sync.prepare()!.checkpoint;
    expect(validateWorkspaceCheckpoint(current)).toBe(true);

    const unknown = structuredClone(current) as unknown as {
      payload: { tables: Record<string, unknown> };
    };
    unknown.payload.tables.future = [];
    expect(validateWorkspaceCheckpoint(unknown as unknown as Checkpoint)).toBe(
      false,
    );

    const partial = structuredClone(current) as unknown as {
      payload: { tables: Record<string, unknown> };
    };
    delete partial.payload.tables.versions;
    expect(validateWorkspaceCheckpoint(partial as unknown as Checkpoint)).toBe(
      false,
    );

    const emptyStore = makeStore().store,
      emptySync = new WorkspaceSyncStore(emptyStore, identity("client-b"));
    emptySync.enable("publish", () => {});
    expect(
      validateWorkspaceCheckpoint(emptySync.prepare()!.checkpoint, current),
    ).toBe(false);
  });
});

describe("staging, applying and replay", () => {
  function bootPair() {
    const a = makeStore(),
      b = makeStore(),
      syncA = new WorkspaceSyncStore(a.store, identity("client-a")),
      syncB = new WorkspaceSyncStore(b.store, identity("client-b"));
    syncA.enable("publish", () => {});
    syncB.enable("join", () => {});
    const empty = syncA.prepare()!;
    syncA.recordResult(empty, applied(empty, 1));
    const emptyChange = asChange(empty, 1);
    syncB.stageChanges(changePage("workspace", "epoch-1", 0, 1, [emptyChange]));
    syncB.applyNext(emptyChange, () => {});
    return { a, b, syncA, syncB, empty };
  }

  it("applies contiguous changes, recomputes the Store body and rejects replay rewrites", () => {
    const { a, b, syncA, syncB } = bootPair();
    const page = a.store.create(null, "page", "One page");
    a.store.update(page.id, 0, {
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "first page path" }],
          },
        ],
      },
    });
    const commit = syncA.prepare()!;
    expect(commit.baseRevision).toBe(1);
    syncA.recordResult(commit, applied(commit, 2));
    const change = asChange(commit, 2);
    b.store.handle({ type: "setting", key: "activePage", value: page.id });
    b.store.db
      .prepare(
        "INSERT INTO save_receipts(operation_id,fingerprint,result_json) VALUES('receipt','fingerprint','{}')",
      )
      .run();
    syncB.stageChanges(changePage("workspace", "epoch-1", 1, 2, [change]));
    expect(syncB.incoming(2)).toEqual(change);
    expect(syncB.nextIncoming()).toEqual(change);
    syncB.applyNext(change, (assets) => expect(assets).toEqual([]));

    expect(b.store.get(page.id)).toMatchObject({
      id: page.id,
      title: "One page",
    });
    const source = a.store.db
      .prepare("SELECT body FROM pages WHERE id=?")
      .get(page.id) as { body: string };
    const copied = b.store.db
      .prepare("SELECT body FROM pages WHERE id=?")
      .get(page.id) as { body: string };
    expect(copied.body).toBe(source.body);
    expect(copied.body).toContain("first page path");
    expect(syncB.status()).toMatchObject({
      receivedCursor: 2,
      appliedRevision: 2,
      pending: false,
    });
    // Device-local settings and receipts are never part of remote apply.
    expect(b.store.load().settings.activePage).toBe(page.id);
    expect(
      b.store.db.prepare("SELECT count(*) AS count FROM save_receipts").get(),
    ).toEqual({ count: 1 });

    // Identical replay is durable and idempotent.
    syncB.stageChanges(changePage("workspace", "epoch-1", 1, 2, [change]));
    // A different checkpoint at the same revision is a mismatched replay.
    a.store.update(page.id, 1, { title: "rewritten" });
    const different = syncA.prepare()!;
    const rewritten: Change = {
      ...change,
      checkpoint: different.checkpoint,
      checkpointHash: different.checkpointHash,
    };
    expect(() =>
      syncB.stageChanges(changePage("workspace", "epoch-1", 1, 2, [rewritten])),
    ).toThrow(/replay|checkpoint/);
  });

  it("applies database, record history, trash-free assets and record values together", () => {
    const { a, b, syncA, syncB } = bootPair();
    const database = a.store.create(null, "database", "Synced DB");
    const repo = new RecordRepository(a.store);
    const record = repo.create(database.id, "Record", { status: "未着手" });
    repo.patch(record.pageId, database.id, 0, { title: "Renamed" });
    const assets = join(a.root, "assets");
    mkdirSync(assets);
    const file = join(a.root, "file.png");
    writeFileSync(file, Buffer.from("remote asset"));
    const attached = attachFile(a.store.db, assets, file);
    const commit = syncA.prepare()!;
    syncA.recordResult(commit, applied(commit, 2));
    const change = asChange(commit, 2);
    syncB.stageChanges(changePage("workspace", "epoch-1", 1, 2, [change]));
    syncB.applyNext(change, (manifest) => {
      expect(manifest).toEqual([
        { id: attached.id, sha256: attached.sha256, bytes: attached.size },
      ]);
    });
    expect(new RecordRepository(b.store).projection(record.pageId).title).toBe(
      "Renamed",
    );
    expect(b.store.versions(record.pageId)).toHaveLength(1);
    expect(
      b.store.db
        .prepare(
          "SELECT count(*) AS count FROM record_value_versions WHERE version_id IN (SELECT id FROM versions WHERE pageId=?)",
        )
        .get(record.pageId),
    ).toEqual({ count: 1 });
    expect(
      b.store.db
        .prepare("SELECT metadata FROM assets WHERE id=?")
        .get(attached.id),
    ).toBeTruthy();
    expect(
      b.store.db
        .prepare("SELECT title FROM versions WHERE pageId=?")
        .get(record.pageId),
    ).toEqual({ title: "Record" });
    b.store.close();
    stores.splice(stores.indexOf(b.store), 1);
    const reopened = new Store(b.path);
    stores.push(reopened);
    expect(
      new WorkspaceSyncStore(reopened, identity("client-b")).status()
        .appliedRevision,
    ).toBe(2);
    expect(new RecordRepository(reopened).projection(record.pageId).title).toBe(
      "Renamed",
    );
  });

  it("skips acknowledged own revisions without rewriting local content", () => {
    const { store } = makeStore(),
      sync = new WorkspaceSyncStore(store, identity("client-a"));
    sync.enable("publish", () => {});
    const empty = sync.prepare()!;
    sync.recordResult(empty, applied(empty, 1));
    const page = store.create(null, "page", "Own edit");
    const operation = sync.prepare()!;
    sync.stageChanges(
      changePage("workspace", "epoch-1", 0, 1, [asChange(empty, 1)]),
    );
    sync.stageChanges(
      changePage("workspace", "epoch-1", 1, 2, [asChange(operation, 2)]),
    );
    expect(sync.nextIncoming()).toBeNull();
    expect(sync.status()).toMatchObject({
      appliedRevision: 2,
      receivedCursor: 2,
      pending: false,
    });
    expect(store.get(page.id).title).toBe("Own edit");
    // Replaying the real ACK is idempotent against the inferred receipt.
    sync.recordResult(operation, applied(operation, 2));
  });

  it("rolls back content and cursor when the asset callback refuses apply", () => {
    const { a, b, syncA, syncB } = bootPair();
    const page = a.store.create(null, "page", "Needs asset check");
    const commit = syncA.prepare()!;
    syncA.recordResult(commit, applied(commit, 2));
    const change = asChange(commit, 2);
    syncB.stageChanges(changePage("workspace", "epoch-1", 1, 2, [change]));
    expect(() =>
      syncB.applyNext(change, () => {
        throw new Error("required asset missing");
      }),
    ).toThrow(/required asset missing/);
    expect(b.store.load().pages).toEqual([]);
    expect(syncB.status()).toMatchObject({
      receivedCursor: 2,
      appliedRevision: 1,
    });
    expect(syncB.incoming(2)).toEqual(change);
    syncB.applyNext(change, () => {});
    expect(b.store.get(page.id).title).toBe("Needs asset check");
  });

  it("rolls back replaced content when the final applied position write fails, then resumes on reopen", () => {
    const { a, b, syncA, syncB } = bootPair();
    const page = a.store.create(null, "page", "original");
    const initial = syncA.prepare()!;
    syncA.recordResult(initial, applied(initial, 2));
    const firstChange = asChange(initial, 2);
    syncB.stageChanges(changePage("workspace", "epoch-1", 1, 2, [firstChange]));
    syncB.applyNext(firstChange, () => {});

    a.store.update(page.id, page.revision, { title: "next" });
    const next = syncA.prepare()!;
    syncA.recordResult(next, applied(next, 3));
    const secondChange = asChange(next, 3);
    syncB.stageChanges(
      changePage("workspace", "epoch-1", 2, 3, [secondChange]),
    );
    b.store.db.exec(`
      CREATE TEMP TRIGGER fail_apply_position BEFORE UPDATE OF applied_revision
      ON workspace_sync_state BEGIN SELECT RAISE(ABORT,'apply position write failed'); END;
    `);
    expect(() => syncB.applyNext(secondChange, () => {})).toThrow(
      "apply position write failed",
    );
    expect(b.store.get(page.id).title).toBe("original");
    expect(syncB.status()).toMatchObject({
      receivedCursor: 3,
      appliedRevision: 2,
      pending: false,
    });

    b.store.close();
    stores.splice(stores.indexOf(b.store), 1);
    const reopened = new Store(b.path);
    stores.push(reopened);
    const resumed = new WorkspaceSyncStore(reopened, identity("client-b"));
    expect(resumed.nextIncoming()).toEqual(secondChange);
    resumed.applyNext(secondChange, () => {});
    expect(reopened.get(page.id).title).toBe("next");
    expect(resumed.status()).toMatchObject({
      receivedCursor: 3,
      appliedRevision: 3,
      pending: false,
    });
  });
});

describe("conflicts and explicit choices", () => {
  function bootSharedPage() {
    const a = makeStore(),
      b = makeStore(),
      syncA = new WorkspaceSyncStore(a.store, identity("client-a")),
      syncB = new WorkspaceSyncStore(b.store, identity("client-b"));
    syncA.enable("publish", () => {});
    syncB.enable("join", () => {});
    const empty = syncA.prepare()!;
    syncA.recordResult(empty, applied(empty, 1));
    const emptyChange = asChange(empty, 1);
    syncB.stageChanges(changePage("workspace", "epoch-1", 0, 1, [emptyChange]));
    syncB.applyNext(emptyChange, () => {});
    const page = a.store.create(null, "page", "Shared");
    const created = syncA.prepare()!;
    syncA.recordResult(created, applied(created, 2));
    const createdChange = asChange(created, 2);
    syncB.stageChanges(
      changePage("workspace", "epoch-1", 1, 2, [createdChange]),
    );
    syncB.applyNext(createdChange, () => {});
    return { a, b, syncA, syncB, page, createdChange };
  }

  function makeConflict(fixture: ReturnType<typeof bootSharedPage>): {
    aChange: Change;
    bCommit: Commit;
    revision: number;
  } {
    const { a, b, syncA, syncB, page } = fixture;
    a.store.update(page.id, 0, { title: "remote" });
    const aCommit = syncA.prepare()!;
    syncA.recordResult(aCommit, applied(aCommit, 3));
    const aChange = asChange(aCommit, 3);
    b.store.update(page.id, 0, { title: "local" });
    const bCommit = syncB.prepare()!;
    syncB.stageChanges(changePage("workspace", "epoch-1", 2, 3, [aChange]));
    const conflict = conflictResult(bCommit, 3, aCommit.checkpoint);
    conflict.fingerprint = fingerprintCommit(bCommit);
    syncB.recordResult(bCommit, conflict);
    return { aChange, bCommit, revision: 3 };
  }

  it("keeps the local envelope and remote head; chooseLocal CASes on the observed head", () => {
    const fixture = bootSharedPage(),
      { b, syncB } = fixture;
    const { bCommit } = makeConflict(fixture);
    expect(syncB.status().conflict).toBe(true);
    expect(syncB.status().pending).toBe(true);
    expect(syncB.conflict()!.operation.operationId).toBe(bCommit.operationId);
    expect(syncB.prepare()).toBeNull();
    expect(syncB.nextIncoming()!.revision).toBe(3);

    const chosen = syncB.chooseLocal(3);
    expect(chosen.baseRevision).toBe(3);
    expect(syncB.status()).toMatchObject({ appliedRevision: 2, pending: true });
    expect(chosen.operationId).not.toBe(bCommit.operationId);
    expect(b.store.get(fixture.page.id).title).toBe("local");
    expect(syncB.conflict()).toBeNull();
    expect(syncB.prepare()!.operationId).toBe(chosen.operationId);
    const row = b.store.db
      .prepare(
        "SELECT chosen FROM workspace_sync_conflicts WHERE operation_id=?",
      )
      .get(bCommit.operationId) as { chosen: string };
    expect(row.chosen).toBe("local");
    const appliedResult = applied(chosen, 4);
    syncB.recordResult(chosen, appliedResult);
    expect(syncB.status().pending).toBe(false);
  });

  it("chooseRemote archives the conflict and newer local edits, then applies while dirty", () => {
    const fixture = bootSharedPage(),
      { b, syncB } = fixture;
    const { aChange } = makeConflict(fixture);
    const localOnly = b.store.create(null, "page", "Local only");
    expect(syncB.status().generation).toBeGreaterThan(
      syncB.status().cleanGeneration,
    );
    syncB.chooseRemote(aChange, (assets) => expect(assets).toEqual([]));
    expect(b.store.get(fixture.page.id).title).toBe("remote");
    expect(() => b.store.get(localOnly.id)).toThrow();
    expect(syncB.conflict()).toBeNull();
    expect(syncB.status()).toMatchObject({
      appliedRevision: 3,
      generation: syncB.status().cleanGeneration,
      conflict: false,
    });
    const kinds = (
      b.store.db
        .prepare("SELECT kind FROM workspace_sync_archives ORDER BY id")
        .all() as { kind: string }[]
    ).map((row) => row.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "conflict-local",
        "conflict-remote",
        "choose-remote-latest",
      ]),
    );
    b.store.close();
    stores.splice(stores.indexOf(b.store), 1);
    const reopened = new Store(b.path);
    stores.push(reopened);
    expect(
      reopened.db
        .prepare("SELECT count(*) AS count FROM workspace_sync_archives")
        .get(),
    ).toEqual({ count: 3 });
    const resumed = new WorkspaceSyncStore(reopened, identity("client-b"));
    expect(resumed.status().conflict).toBe(false);
  });
});

describe("startup verification", () => {
  it("refuses a promoted workspace whose trigger coverage was damaged", () => {
    const { store, path } = makeStore(),
      sync = new WorkspaceSyncStore(store, identity());
    sync.enable("publish", () => {});
    store.db.exec("DROP TRIGGER workspace_sync_pages_insert");
    expect(() => validateWorkspaceSyncSchema(store.db)).toThrow(
      /workspace sync schema/,
    );
    store.close();
    stores.splice(stores.indexOf(store), 1);
    expect(() => new Store(path)).toThrow(/requires a newer Folio version/);
    expect(() => new Store(path, { readOnly: true })).toThrow(
      /requires a newer Folio version/,
    );
  });
});
