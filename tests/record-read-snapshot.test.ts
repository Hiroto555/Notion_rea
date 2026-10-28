import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { requestSchema } from "../src/shared/types";

function fixture() {
  const root = mkdtempSync(resolve("output/record-read-snapshot-"));
  const path = join(root, "workspace.sqlite");
  const store = new Store(path);
  const db = store.create(null, "database", "Owner");
  const records = new RecordRepository(store);
  store.transaction(() => {
    records.createSchema();
    records.registerDatabase(db.id);
  });
  const record = records.create(db.id, "before", { status: "before" });
  return { root, path, store, db, record, records };
}

it("reads the Page and values from the same SQLite snapshot during another writer's update", () => {
  const f = fixture();
  const other = new Store(f.path);
  try {
    const get = f.store.get.bind(f.store);
    let changed = false;
    const spy = vi.spyOn(f.store, "get").mockImplementation((id) => {
      const page = get(id);
      if (id === f.record.pageId && !changed) {
        changed = true;
        other.updateRecordPage(id, f.db.id, page.revision, {
          title: "after",
          doc: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "new body" }],
              },
            ],
          },
        });
      }
      return page;
    });
    const pair = f.records.readSnapshot(f.record.pageId);
    spy.mockRestore();
    expect(changed).toBe(true);
    expect(pair.page.title).toBe("before");
    expect(pair.record.title).toBe("before");
    expect(pair.record.revision).toBe(pair.page.revision);
    expect(other.get(f.record.pageId).title).toBe("after");
    expect(other.get(f.record.pageId).revision).toBe(pair.page.revision + 1);
  } finally {
    other.close();
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("rejects deleted, unsupported and unregistered owners and keeps source data", () => {
  const f = fixture();
  try {
    const before = f.store.get(f.record.pageId);
    expect(
      f.store.handle({ type: "record:read", pageId: f.record.pageId }),
    ).toMatchObject({ page: { id: before.id }, record: { pageId: before.id } });
    f.store.write({ ...f.db, deletedAt: Date.now() });
    expect(() => f.records.readSnapshot(before.id)).toThrow();
    f.store.write(f.db);
    const source = (
      f.store.db.prepare("SELECT data FROM pages WHERE id=?").get(f.db.id) as {
        data: string;
      }
    ).data;
    const unknown = JSON.parse(source);
    unknown.database.future = { keep: true };
    const raw = JSON.stringify(unknown);
    f.store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(raw, f.db.id);
    expect(() => f.records.readSnapshot(before.id)).toThrow();
    expect(
      (
        f.store.db
          .prepare("SELECT data FROM pages WHERE id=?")
          .get(f.db.id) as { data: string }
      ).data,
    ).toBe(raw);
    f.store.db
      .prepare("UPDATE pages SET data=? WHERE id=?")
      .run(source, f.db.id);
    f.store.db
      .prepare("DELETE FROM record_databases WHERE database_page_id=?")
      .run(f.db.id);
    expect(() => f.records.readSnapshot(before.id)).toThrow();
    expect(f.store.get(before.id)).toEqual(before);
    expect(
      requestSchema.safeParse({
        type: "record:read",
        pageId: before.id,
        extra: true,
      }).success,
    ).toBe(false);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
