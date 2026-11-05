import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { Store } from "../src/persistence/store";
import { readDatabaseSnapshot } from "../src/persistence/database-operations";
import { prepareDatabaseCreation } from "../src/shared/database-operation";
import { preparePageCreation, preparePageDuplication } from "../src/shared/page-operation";
import { RecordRepository } from "../src/persistence/record-repository";
import { PageOperationCoordinator } from "../src/renderer/page-operation-coordinator";
import { duplicateEditorPage } from "../src/renderer/duplicate-editor-page";
import { applyPageOrderRepair, previewPageOrderRepair } from "../src/persistence/page-order-repair";
import { CrashRecoveryFile, crashRecoveryWorkspaceId } from "../src/persistence/crash-recovery-file";
import { emptyCrashRecoverySnapshot, hasCrashRecoveryInput } from "../src/shared/crash-recovery";
import { prepareCrashRecovery } from "../src/renderer/prepare-crash-recovery";
import type { Request } from "../src/shared/types";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "folio-dsh-review-"));
  const store = new Store(join(root, "workspace.sqlite"));
  return { store, dispose() {
    vi.restoreAllMocks(); store.close(); rmSync(root, { recursive: true, force: true });
  }};
}

it("keeps the existing legacy database duplicate action and its rows intact", async () => {
  const f = fixture();
  try {
    const initial = f.store.create(null, "database", "Legacy DB");
    const source = f.store.update(initial.id, initial.revision, { database: {
      ...initial.database!, rows: [{ id: "legacy-row", title: "Keep this row", values: {} }],
    }});
    const seen: Request[] = [];
    const send = async (request: Request) => { seen.push(request); return f.store.handle(request); };
    const coordinator = new PageOperationCoordinator(send);
    const copy = await duplicateEditorPage(source, coordinator, send);
    expect(copy.id).not.toBe(source.id);
    expect(copy.database).toEqual(source.database);
    expect(copy.kind).toBe("database");
    expect(f.store.get(source.id)).toEqual(source);
    expect(seen.map((request) => request.type)).toEqual(["duplicate"]);
    expect(coordinator.hasUnresolved()).toBe(false);
  } finally { f.dispose(); }
});

it("uses the durable operation route for an ordinary editor Page", async () => {
  const f = fixture();
  try {
    const source = f.store.create(null, "page", "Ordinary");
    const seen: Request[] = [];
    const send = async (request: Request) => { seen.push(request); return f.store.handle(request); };
    const coordinator = new PageOperationCoordinator(send);
    const copy = await duplicateEditorPage(source, coordinator, send);
    expect(copy.title).toBe("Ordinary のコピー");
    expect(seen.map((request) => request.type)).toEqual(["page:commit"]);
  } finally { f.dispose(); }
});

it("permanently disables all Store access when snapshot COMMIT and close both fail", () => {
  const f = fixture();
  try {
    const owner = f.store.handle({type: "database:commit", operation: prepareDatabaseCreation("Owner")}) as any;
    const db = f.store.db, exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT") throw new Error("injected commit failure");
      return exec(sql);
    });
    vi.spyOn(db, "close").mockImplementation(() => { throw new Error("injected close failure"); });
    expect(() => readDatabaseSnapshot(f.store, owner.page.id)).toThrow(/connection disabled/);
    expect(db.isOpen).toBe(true);
    // Reusing an unclosed connection must never expose its stale/uncommitted snapshot.
    expect(() => f.store.get(owner.page.id)).toThrow(/unusable/);
    expect(() => readDatabaseSnapshot(f.store, owner.page.id)).toThrow(/unusable/);
  } finally { f.dispose(); }
});

it("combines operation receipts, explicit order repair and scoped database reads", () => {
  const f = fixture();
  try {
    const owner = f.store.handle({type: "database:commit", operation: prepareDatabaseCreation("Owner")}) as any;
    new RecordRepository(f.store).create(owner.page.id, "Retained record", {});
    const beforeDatabase = readDatabaseSnapshot(f.store, owner.page.id);
    const one = preparePageCreation("First"), two = preparePageCreation("Second");
    const first = f.store.commitPageOperation(one).page!;
    const second = f.store.commitPageOperation(two).page!;
    f.store.write({...second, position: first.position}); // disposable legacy-tie fixture
    const receipts = f.store.db.prepare("SELECT * FROM save_receipts ORDER BY operation_id").all();
    const preview = previewPageOrderRepair(f.store);
    expect(preview.canApply).toBe(true);
    const repaired = applyPageOrderRepair(f.store, preview);
    expect(repaired.status).toBe("applied");
    expect(repaired.appliedPages).toBe(1);
    expect(readDatabaseSnapshot(f.store, owner.page.id)).toEqual(beforeDatabase);
    expect(f.store.db.prepare("SELECT * FROM save_receipts ORDER BY operation_id").all()).toEqual(receipts);
    expect(f.store.commitPageOperation(one).page!.id).toBe(first.id);
    expect(f.store.commitPageOperation(two).page!.id).toBe(second.id);
    const changed = repaired.targets[0];
    expect(f.store.commitPageOperation(preparePageDuplication(changed.pageId, changed.fromRevision)).status).toBe("rejected");
    expect(f.store.pages().filter((page) => page.title === "First" || page.title === "Second")).toHaveLength(2);
  } finally { f.dispose(); }
});

it("never commits a new Page alongside a rejected receipt after a partial SQL failure", () => {
  const f = fixture();
  try {
    const operation = preparePageCreation("Must not survive rejection");
    // SQLite FAIL retains earlier effects of the failing statement, unlike ABORT.
    f.store.db.exec("CREATE TRIGGER fail_after_page AFTER INSERT ON pages BEGIN SELECT RAISE(FAIL, 'after insert failure'); END");
    const result = f.store.commitPageOperation(operation);
    expect(result.status).toBe("rejected");
    expect(f.store.pages()).toHaveLength(0);
    expect(f.store.resolvePageOperation(operation)).toEqual(result);
  } finally { f.dispose(); }
});

it("retains an applied ACK with a missing Page ID as unknown until it is resolved", async () => {
  const f = fixture();
  try {
    const coordinator = new PageOperationCoordinator(async (request) => {
      const result = f.store.handle(request) as any;
      if (request.type === "page:commit") {
        const { id: _id, ...withoutId } = result.page;
        return { ...result, page: withoutId };
      }
      return result;
    });
    await expect(coordinator.create(null, "Retain until verified")).rejects.toThrow(/照合/);
    expect(coordinator.hasUnresolved()).toBe(true);
    expect(f.store.pages()).toHaveLength(1);
    expect((await coordinator.resolveNext())?.status).toBe("applied");
    expect(coordinator.hasUnresolved()).toBe(false);
  } finally { f.dispose(); }
});

it("recovers a lost Page ACK from the on-disk checkpoint after both stores reopen", async () => {
  const f = fixture();
  let reopened: Store | undefined;
  try {
    const workspaceId = crashRecoveryWorkspaceId(f.store);
    const path = join(realpathSync(dirname(f.store.path)), "recovery.json");
    const file = new CrashRecoveryFile(path, workspaceId);
    const coordinator = new PageOperationCoordinator(async (request) => {
      const result = f.store.handle(request);
      if (request.type === "page:commit") throw new Error("ACK lost after commit");
      return result;
    }, { persist: async () => {
      file.write(0, {...emptyCrashRecoverySnapshot(), pageOperations: coordinator.unresolvedOperations()});
    }});
    await expect(coordinator.create(null, "Survives restart")).rejects.toThrow(/ACK lost/);
    const retainedId = coordinator.unresolvedOperations()[0].operationId;
    f.store.close();
    reopened = new Store(f.store.path);
    const recoveredFile = new CrashRecoveryFile(path, crashRecoveryWorkspaceId(reopened));
    const recovered = recoveredFile.read();
    expect(recovered.status).toBe("ready");
    expect(recovered.snapshot!.pageOperations![0].operationId).toBe(retainedId);
    const restored = await prepareCrashRecovery(recovered.snapshot!, async (request) => reopened!.handle(request) as any);
    expect(hasCrashRecoveryInput(restored)).toBe(false);
    recoveredFile.write(recovered.generation, restored);
    expect(reopened.pages().map((page) => page.title)).toEqual(["Survives restart"]);
    expect(recoveredFile.read().snapshot!.pageOperations).toEqual([]);
  } finally { reopened?.close(); f.dispose(); }
});
