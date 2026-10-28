import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { RecordLifecycle } from "../src/persistence/record-lifecycle";

function fixture() {
  const root = mkdtempSync(resolve("output/record-lifecycle-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const database = store.create(null, "database", "DB");
  const a = store.create(null, "page", "First"),
    b = store.create(null, "page", "Second");
  const records = new RecordRepository(store);
  store.transaction(() => {
    records.createSchema();
    records.registerDatabase(database.id);
    records.attachForMigration(a.id, database.id, 4, { status: "one" });
    records.attachForMigration(b.id, database.id, 9, { status: "two" });
  });
  const lifecycle = new RecordLifecycle(store);
  return {
    root,
    store,
    database,
    a,
    b,
    records,
    lifecycle,
    dispose() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it("restores only records in the database trash batch, even when trash times match", () => {
  const f = fixture(),
    clock = vi.spyOn(Date, "now").mockReturnValue(1234567);
  try {
    f.lifecycle.trashRecord(f.b.id, 0);
    f.lifecycle.trashDatabase(f.database.id, 0);
    expect(() => f.lifecycle.restoreRecord(f.a.id, 1)).toThrow(
      "owning database",
    );
    expect(f.store.get(f.a.id).deletedAt).toBe(1234567);
    expect(f.store.get(f.b.id).deletedAt).toBe(1234567);
    f.lifecycle.restoreDatabase(f.database.id, 1);
    expect(f.store.get(f.a.id).deletedAt).toBeNull();
    expect(f.store.get(f.b.id).deletedAt).toBe(1234567);
    expect(f.lifecycle.restoreRecord(f.b.id, 1).deletedAt).toBeNull();
    expect(f.records.projection(f.b.id).databasePageId).toBe(f.database.id);
  } finally {
    clock.mockRestore();
    f.dispose();
  }
});

it("rolls back the complete DB trash operation when a page write fails", () => {
  const f = fixture();
  try {
    f.store.db.exec(
      `CREATE TRIGGER reject_db_delete BEFORE UPDATE ON pages WHEN old.id='${f.database.id}' BEGIN SELECT RAISE(ABORT,'simulated failure'); END`,
    );
    expect(() => f.lifecycle.trashDatabase(f.database.id, 0)).toThrow(
      "simulated failure",
    );
    expect(f.store.get(f.a.id)).toMatchObject({ deletedAt: null, revision: 0 });
    expect(f.store.get(f.b.id)).toMatchObject({ deletedAt: null, revision: 0 });
    expect(f.store.get(f.database.id)).toMatchObject({
      deletedAt: null,
      revision: 0,
    });
    expect(
      f.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='record_database_trash_batches'",
        )
        .get()?.n,
    ).toBe(0);
  } finally {
    f.dispose();
  }
});

it("duplicates records and database into independent identities with local link rewrite and row order", () => {
  const f = fixture();
  try {
    const linkedDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "other",
              marks: [
                { type: "link", attrs: { href: `folio-page://${f.b.id}` } },
              ],
            },
          ],
        },
      ],
    };
    const edited = f.store.updateRecordPage(f.a.id, f.database.id, 0, { doc: linkedDoc });
    const single = f.lifecycle.duplicateRecord(f.a.id, edited.revision);
    expect(single.pageId).not.toBe(f.a.id);
    expect(single.databasePageId).toBe(f.database.id);
    expect(single.values).toEqual({ status: "one" });
    expect(f.store.get(single.pageId).doc).toEqual(linkedDoc);
    f.records.patch(single.pageId, f.database.id, 0, { values: { status: "copy" } });
    expect(f.records.projection(f.a.id).values.status).toBe("one");
    const dbCopy = f.lifecycle.duplicateDatabase(f.database.id, 0);
    const members = f.store.db
      .prepare(
        "SELECT page_id,position FROM record_memberships WHERE database_page_id=? ORDER BY position,page_id",
      )
      .all(dbCopy.id) as { page_id: string; position: number }[];
    expect(members.map((x) => x.position)).toEqual([4, 9, 10]);
    expect(
      members.every(
        (x) => ![f.a.id, f.b.id, single.pageId].includes(x.page_id),
      ),
    ).toBe(true);
    const copiedA = f.store.get(members[0].page_id),
      copiedB = f.store.get(members[1].page_id);
    const mark = copiedA.doc.content![0].content![0].marks![0];
    expect(mark.attrs?.href).toBe(`folio-page://${copiedB.id}`);
    expect(f.store.get(f.a.id).doc).toEqual(linkedDoc);
    f.records.patch(copiedA.id, dbCopy.id, 0, { values: { status: "independent" } });
    expect(f.records.projection(f.a.id).values.status).toBe("one");
  } finally {
    f.dispose();
  }
});

it("supports explicit registration of a migrated trashed legacy DB and rejects ambiguous restore", () => {
  const f = fixture();
  try {
    const stamp = 555;
    f.store.transaction(() => {
      for (const p of [f.database, f.a, f.b])
        f.store.write({ ...p, deletedAt: stamp, revision: 1 });
    });
    expect(() => f.lifecycle.restoreDatabase(f.database.id, 1)).toThrow(
      "batch unavailable",
    );
    f.store.transaction(() =>
      f.lifecycle.registerMigratedTrashInTransaction(f.database.id),
    );
    f.lifecycle.restoreDatabase(f.database.id, 1);
    expect(f.store.get(f.a.id).deletedAt).toBeNull();
    expect(f.store.get(f.b.id).deletedAt).toBeNull();
  } finally {
    f.dispose();
  }
});

it("rejects stale revisions and pages with children before changing data", () => {
  const f = fixture();
  try {
    expect(() => f.lifecycle.trashRecord(f.a.id, 77)).toThrow("競合");
    // Simulate a child that existed before this Page became a record. New
    // children of records are rejected by Store.create.
    const child = f.store.create(null, "page", "child");
    f.store.write({ ...child, parentId: f.a.id });
    expect(() => f.lifecycle.trashDatabase(f.database.id, 0)).toThrow(
      "with children",
    );
    expect(() => f.lifecycle.duplicateRecord(f.a.id, 0)).toThrow(
      "with children",
    );
    expect(f.store.get(child.id).deletedAt).toBeNull();
    expect(f.store.get(f.a.id).deletedAt).toBeNull();
  } finally {
    f.dispose();
  }
});

it("routes strict record lifecycle IPC requests with revision checks", async () => {
  const { requestSchema } = await import("../src/shared/types");
  const f = fixture();
  try {
    expect(
      requestSchema.safeParse({
        type: "record:trash",
        pageId: f.a.id,
        revision: 0,
        extra: true,
      }).success,
    ).toBe(false);
    f.store.handle(
      requestSchema.parse({
        type: "record:trash",
        pageId: f.a.id,
        revision: 0,
      }),
    );
    expect(() =>
      f.store.handle(
        requestSchema.parse({
          type: "record:restore",
          pageId: f.a.id,
          revision: 0,
        }),
      ),
    ).toThrow("競合");
    const restored = f.store.handle(
      requestSchema.parse({
        type: "record:restore",
        pageId: f.a.id,
        revision: 1,
      }),
    );
    expect(restored).toMatchObject({
      pageId: f.a.id,
      revision: 2,
      deletedAt: null,
    });
    const copy = f.store.handle(
      requestSchema.parse({
        type: "record:duplicate",
        pageId: f.a.id,
        revision: 2,
      }),
    );
    expect(copy).toMatchObject({ databasePageId: f.database.id, revision: 0 });
  } finally {
    f.dispose();
  }
});

it("rejects a delayed body save while its owner is trashed, preserving DB restore", () => {
  const f = fixture();
  try {
    f.lifecycle.trashDatabase(f.database.id, 0);
    const deleted = f.store.get(f.a.id);
    const before = f.store.db
      .prepare("SELECT data FROM pages WHERE id=?")
      .get(f.a.id)?.data;
    expect(() =>
      f.store.update(f.a.id, deleted.revision, { title: "delayed" }),
    ).toThrow("未保存変更");
    expect(
      f.store.db.prepare("SELECT data FROM pages WHERE id=?").get(f.a.id)?.data,
    ).toBe(before);
    f.lifecycle.restoreDatabase(f.database.id, 1);
    expect(f.store.get(f.a.id).deletedAt).toBeNull();
    expect(f.store.get(f.a.id).title).toBe("First");
  } finally {
    f.dispose();
  }
});

it("creates records through IPC and routes generic page actions through atomic lifecycle", async () => {
  const { requestSchema } = await import("../src/shared/types");
  const f = fixture();
  try {
    expect(
      requestSchema.safeParse({
        type: "record:create",
        databasePageId: f.database.id,
        title: "new",
        values: { status: null },
      }).success,
    ).toBe(false);
    const created = f.store.handle(
      requestSchema.parse({
        type: "record:create",
        databasePageId: f.database.id,
        title: "new",
        values: { status: "open" },
      }),
    ) as { pageId: string };
    expect(f.store.get(created.pageId).title).toBe("new");
    const duplicate = f.store.handle({
      type: "duplicate",
      id: created.pageId,
    }) as { id: string };
    expect(duplicate.id).not.toBe(created.pageId);
    f.store.handle({ type: "trash", id: f.database.id });
    expect(f.store.get(created.pageId).deletedAt).not.toBeNull();
    f.store.handle({ type: "restore", id: f.database.id });
    expect(f.store.get(created.pageId).deletedAt).toBeNull();
    expect(f.store.get(duplicate.id).deletedAt).toBeNull();
  } finally {
    f.dispose();
  }
});
