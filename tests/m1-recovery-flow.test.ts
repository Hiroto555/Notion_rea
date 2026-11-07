import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { RecordLifecycle } from "../src/persistence/record-lifecycle";
import { convertLegacyRecordsInTransaction } from "../src/persistence/record-migration";
import { attachFile } from "../src/persistence/assets";
import { WorkspaceSyncStore, type WorkspaceSyncIdentity } from "../src/sync/workspace-store";
import { buildWorkspaceCheckpoint, WORKSPACE_CONTENT_TABLES } from "../src/sync/workspace-checkpoint";
import { readConflictArchive } from "../src/sync/conflict-archive-catalog";
import { canonicalJson, hashCheckpoint, type Checkpoint } from "../src/sync/protocol";
import { ConflictRecoveryService } from "../src/main/conflict-recovery-service";
import { RECOVERY_INCOMPLETE, type ArchiveTarget, type RecoveryActionResult } from "../src/shared/conflict-recovery";

const roots: string[] = [];
const stores: Store[] = [];

function tempDirectory(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(path);
  return path;
}

function openStore(path: string, options: { readOnly?: boolean } = {}): Store {
  const store = new Store(path, options);
  stores.push(store);
  return store;
}

function identity(): WorkspaceSyncIdentity {
  return {
    workspaceId: "workspace",
    clientId: "client-a",
    bindingId: "binding-a",
    serverEpoch: "epoch-1",
  };
}

type Tables = Record<string, (string | number | null)[][]>;

function tablesOf(checkpoint: Checkpoint): Tables {
  return (checkpoint.payload as unknown as { tables: Tables }).tables;
}

type Fixture = {
  root: string;
  parent: string;
  store: Store;
  attached: { id: string; sha256: string; size: number };
  normalPageId: string;
  checkpoint: Checkpoint;
  targets: ArchiveTarget[];
};

function makeFixture(kinds: string[] = ["conflict-local"]): Fixture {
  const root = tempDirectory("folio-m1-recovery-src-");
  const parent = tempDirectory("folio-m1-recovery-out-");
  const store = openStore(join(root, "workspace.sqlite"));
  const assets = join(root, "assets");
  mkdirSync(assets);

  const normal = store.create(null, "page", "Alpha");
  store.update(normal.id, 0, {
    doc: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "searchable body" }] }],
    },
  });

  const legacy = store.create(null, "database", "Legacy");
  store.update(legacy.id, 0, {
    database: {
      ...legacy.database!,
      rows: [{ id: "legacy-row", title: "Old row", values: { status: "未着手" } }],
    },
  });

  const sync = new WorkspaceSyncStore(store, identity());
  sync.enable("publish", () => {});
  store.transaction(() => {
    convertLegacyRecordsInTransaction(store);
  });

  const work = store.create(null, "database", "Work");
  const repository = new RecordRepository(store);
  const record = repository.create(work.id, "行", { status: "未着手" });
  repository.patch(record.pageId, work.id, store.get(record.pageId).revision, {
    title: "行更新",
  });
  new RecordLifecycle(store).trashDatabase(work.id, store.get(work.id).revision);

  const file = join(root, "image.png");
  writeFileSync(file, Buffer.from("attachment bytes"));
  const attached = attachFile(store.db, assets, file);

  const checkpoint = buildWorkspaceCheckpoint(store.db);
  const sourceTables = tablesOf(checkpoint);
  for (const name of WORKSPACE_CONTENT_TABLES)
    expect(sourceTables[name].length, `${name} must not be empty`).toBeGreaterThan(0);

  const inserted: number[] = [];
  const base = Date.now();
  for (const [index, kind] of kinds.entries()) {
    const result = store.db
      .prepare(
        "INSERT INTO workspace_sync_archives(operation_id,kind,checkpoint_json,created_at) VALUES(?,?,?,?)",
      )
      .run(randomUUID(), kind, canonicalJson(checkpoint), base + index);
    inserted.push(Number(result.lastInsertRowid));
  }

  const listed = new ConflictRecoveryService(store, root).list();
  const targets = inserted.map((id) => {
    const item = listed.items.find((entry) => entry.id === id);
    if (!item?.target) throw new Error(`archive target ${id} was not listed`);
    return item.target;
  });

  return {root, parent, store, attached, normalPageId: normal.id, checkpoint, targets};
}

function restored(result: RecoveryActionResult) {
  if (result.kind !== "restored") throw new Error(`expected restored: ${JSON.stringify(result)}`);
  return result;
}

function blocked(result: RecoveryActionResult) {
  if (result.kind !== "blocked") throw new Error(`expected blocked: ${JSON.stringify(result)}`);
  return result;
}

function archiveOutputs(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.startsWith("Folio-recovery-")).sort();
}

afterEach(() => {
  for (const store of stores.splice(0))
    try {
      store.close();
    } catch {}
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});

describe("M1 recovery flow", () => {
  it("lists a selected archive and restores an independent v4 copy without changing source", async () => {
    const fixture = makeFixture();
    const service = new ConflictRecoveryService(fixture.store, fixture.root);
    const listed = service.list();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].valid).toBe(true);
    const target = listed.items[0].target!;
    const sourceSnapshot = readConflictArchive(fixture.store.db, target);
    const sourceHash = hashCheckpoint(sourceSnapshot.checkpoint);
    expect(sourceHash).toBe(target.checkpointHash);
    const sourceAsset = readFileSync(join(fixture.root, "assets", fixture.attached.id));

    const result = restored(
      await service.run(target, "restore", async () => fixture.parent, () => true, randomUUID()),
    );
    expect(result.directory.startsWith(fixture.parent + sep)).toBe(true);

    const reopened = openStore(join(result.directory, "workspace.sqlite"), {readOnly: true});
    expect(
      (reopened.db.prepare("PRAGMA user_version").get() as {user_version: number}).user_version,
    ).toBe(4);
    const recovered = buildWorkspaceCheckpoint(reopened.db);
    expect(hashCheckpoint(recovered)).toBe(target.checkpointHash);
    expect(tablesOf(recovered).pages).toEqual(tablesOf(sourceSnapshot.checkpoint).pages);

    const afterSnapshot = readConflictArchive(fixture.store.db, target);
    expect(hashCheckpoint(afterSnapshot.checkpoint)).toBe(sourceHash);
    expect(service.list().items[0].target).toEqual(target);
    expect(readFileSync(join(fixture.root, "assets", fixture.attached.id)).equals(sourceAsset)).toBe(true);
  });

  it("fills all eleven content tables and restores equal content that can be saved with history", async () => {
    const fixture = makeFixture();
    const sourceTables = tablesOf(fixture.checkpoint);
    const service = new ConflictRecoveryService(fixture.store, fixture.root);
    const target = fixture.targets[0];
    const result = restored(
      await service.run(target, "restore", async () => fixture.parent, () => true, randomUUID()),
    );

    const readOnly = openStore(join(result.directory, "workspace.sqlite"), {readOnly: true});
    const recovered = buildWorkspaceCheckpoint(readOnly.db);
    expect(hashCheckpoint(recovered)).toBe(target.checkpointHash);
    const recoveredTables = tablesOf(recovered);
    for (const name of WORKSPACE_CONTENT_TABLES)
      expect(recoveredTables[name], `${name} roundtrip`).toEqual(sourceTables[name]);
    readOnly.close();

    const writable = openStore(join(result.directory, "workspace.sqlite"));
    const before = writable.versions(fixture.normalPageId);
    const page = writable.get(fixture.normalPageId);
    writable.update(page.id, page.revision, {title: "after restore"});
    const after = writable.versions(fixture.normalPageId);
    expect(after).toHaveLength(before.length + 1);
    expect(writable.get(fixture.normalPageId).title).toBe("after restore");
    expect(after[0].title).toBe(page.title);
  });

  it("makes one idempotent effect per operation id and keeps a bounded sixteen-entry session", async () => {
    const fixture = makeFixture(["conflict-local", "conflict-remote"]);
    const [first, second] = fixture.targets;
    const service = new ConflictRecoveryService(fixture.store, fixture.root);
    let picks = 0;

    const oldId = randomUUID();
    const oldPromise = service.run(first, "metadata-only", async () => {
      picks++;
      return fixture.parent;
    }, () => true, oldId);
    const samePromise = service.run(first, "metadata-only", async () => {
      throw new Error("picker must not run for a retry");
    }, () => true, oldId);
    expect(samePromise).toBe(oldPromise);
    expect((await oldPromise).kind).toBe("metadata-only");
    expect(picks).toBe(1);

    const reuseId = randomUUID();
    await service.run(first, "metadata-only", async () => null, () => true, reuseId);
    expect(
      blocked(await service.run(second, "metadata-only", async () => null, () => true, reuseId)),
    ).toMatchObject({reason: "recovery-operation-id-reused"});
    expect(
      blocked(await service.run(first, "complete-bundle", async () => null, () => true, reuseId)),
    ).toMatchObject({reason: "recovery-operation-id-reused"});

    for (let index = 0; index < 14; index++) {
      const cancelled = await service.run(
        first,
        "metadata-only",
        async () => null,
        () => true,
        randomUUID(),
      );
      expect(cancelled.kind).toBe("cancelled");
    }
    expect(
      blocked(await service.run(first, "metadata-only", async () => null, () => true, randomUUID())),
    ).toEqual({kind: "blocked", reason: "recovery-operation-limit"});

    const outputs = archiveOutputs(fixture.parent);
    const retry = service.run(first, "metadata-only", async () => {
      picks++;
      return fixture.parent;
    }, () => true, oldId);
    expect(retry).toBe(oldPromise);
    expect((await retry).kind).toBe("metadata-only");
    expect(picks).toBe(1);
    expect(archiveOutputs(fixture.parent)).toEqual(outputs);

    const restarted = new ConflictRecoveryService(fixture.store, fixture.root);
    expect(await restarted.status(oldId)).toEqual({
      kind: "blocked",
      reason: "recovery-operation-not-found",
    });
  });

  it("keeps an after-complete outcome unknown until the missing attachment is reconciled", async () => {
    const fixture = makeFixture();
    const target = fixture.targets[0];
    let completes = 0;
    const service = new ConflictRecoveryService(fixture.store, fixture.root, {
      fault: (stage) => {
        if (stage === "after-complete" && ++completes === 2)
          throw new Error("after-complete outcome unknown");
      },
    });
    const operationId = randomUUID();
    const result = await service.run(
      target,
      "restore",
      async () => fixture.parent,
      () => true,
      operationId,
    );
    if (result.kind !== "outcome-unknown")
      throw new Error(`expected outcome-unknown: ${JSON.stringify(result)}`);
    expect(existsSync(join(result.directory, RECOVERY_INCOMPLETE))).toBe(false);

    const assetPath = join(result.directory, "assets", fixture.attached.id);
    unlinkSync(assetPath);
    expect(await service.status(operationId)).toMatchObject({
      kind: "outcome-unknown",
      directory: result.directory,
    });

    copyFileSync(join(fixture.root, "assets", fixture.attached.id), assetPath);
    expect(await service.status(operationId)).toMatchObject({
      kind: "restored",
      directory: result.directory,
      checkpointHash: target.checkpointHash,
    });
  });

  it("preserves an incomplete output, keeps the source, and allows a different new destination", async () => {
    const fixture = makeFixture();
    const target = fixture.targets[0];
    const sourceSnapshot = readConflictArchive(fixture.store.db, target);
    const sourceHash = hashCheckpoint(sourceSnapshot.checkpoint);
    const sourceAsset = readFileSync(join(fixture.root, "assets", fixture.attached.id));
    let beforeComplete = 0;
    const service = new ConflictRecoveryService(fixture.store, fixture.root, {
      fault: (stage) => {
        if (stage === "before-complete" && ++beforeComplete === 2)
          throw new Error("stop before publishing");
      },
    });

    const operationId = randomUUID();
    const preserved = blocked(
      await service.run(target, "restore", async () => fixture.parent, () => true, operationId),
    );
    expect(preserved.reason).toBe("recovery-incomplete-preserved");
    expect(preserved.directory).toBeTruthy();
    expect(existsSync(join(preserved.directory!, RECOVERY_INCOMPLETE))).toBe(true);
    expect(await service.status(operationId)).toMatchObject({
      kind: "blocked",
      reason: "recovery-incomplete-preserved",
      directory: preserved.directory,
    });
    expect(hashCheckpoint(readConflictArchive(fixture.store.db, target).checkpoint)).toBe(sourceHash);
    expect(readFileSync(join(fixture.root, "assets", fixture.attached.id)).equals(sourceAsset)).toBe(true);

    const beforeDirs = archiveOutputs(fixture.parent);
    const retry = restored(
      await service.run(target, "restore", async () => fixture.parent, () => true, randomUUID()),
    );
    expect(retry.directory).not.toBe(preserved.directory);
    expect(existsSync(join(preserved.directory!, RECOVERY_INCOMPLETE))).toBe(true);
    expect(archiveOutputs(fixture.parent).length).toBeGreaterThan(beforeDirs.length);
  });

  it("rejects source or backup destinations and post-picker target or authorization changes", async () => {
    const fixture = makeFixture(["conflict-local", "conflict-remote"]);
    const [target, other] = fixture.targets;
    const service = new ConflictRecoveryService(fixture.store, fixture.root);
    const sourceHash = hashCheckpoint(readConflictArchive(fixture.store.db, target).checkpoint);

    const insideSource = join(fixture.root, "nested");
    mkdirSync(insideSource);
    expect(
      blocked(
        await service.run(target, "metadata-only", async () => insideSource, () => true, randomUUID()),
      ),
    ).toMatchObject({reason: "recovery-refused"});

    const backup = join(fixture.parent, "existing-backup");
    const backupChild = join(backup, "child");
    mkdirSync(backup);
    mkdirSync(backupChild);
    writeFileSync(join(backup, "manifest.json"), JSON.stringify({format: "folio-conflict-recovery"}));
    expect(
      blocked(
        await service.run(target, "metadata-only", async () => backupChild, () => true, randomUUID()),
      ),
    ).toMatchObject({reason: "recovery-refused"});

    let authorized = true;
    expect(
      blocked(
        await service.run(target, "metadata-only", async () => {
          authorized = false;
          return fixture.parent;
        }, () => authorized, randomUUID()),
      ),
    ).toMatchObject({reason: "recovery-refused"});

    const outputs = readdirSync(fixture.parent).sort();
    expect(
      blocked(
        await service.run(other, "metadata-only", async () => {
          fixture.store.db
            .prepare("UPDATE workspace_sync_archives SET kind=? WHERE id=?")
            .run("tampered", other.id);
          return fixture.parent;
        }, () => true, randomUUID()),
      ),
    ).toMatchObject({reason: "recovery-refused"});
    expect(readdirSync(fixture.parent).sort()).toEqual(outputs);
    expect(hashCheckpoint(readConflictArchive(fixture.store.db, target).checkpoint)).toBe(sourceHash);
  });
});
