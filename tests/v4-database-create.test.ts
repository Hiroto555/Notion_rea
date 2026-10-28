import { mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { markRecordStoreVersion } from "../src/persistence/record-version";
import { blankDoc, emptyDatabase } from "../src/shared/types";

function fixture(v4: boolean) {
  const root = mkdtempSync(resolve("output/v4-create-"));
  const store = new Store(join(root, "workspace.sqlite"));
  if (v4) store.transaction(() => {
    new RecordRepository(store).createSchema();
    markRecordStoreVersion(store.db);
  });
  return { store, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

it("creates a registered empty record database in v4 and supports record creation", () => {
  const f = fixture(true);
  try {
    const page = f.store.create(null, "database", "new db");
    expect(f.store.db.prepare("SELECT database_page_id FROM record_databases WHERE database_page_id=?").get(page.id)).toBeTruthy();
    expect(f.store.get(page.id).database?.rows).toEqual([]);
    const record = new RecordRepository(f.store).create(page.id, "row", { status: "done" });
    expect(record).toMatchObject({ databasePageId: page.id, title: "row", values: { status: "done" } });
    expect(f.store.get(page.id).database?.rows).toEqual([]);
  } finally { f.close(); }
});

it("rolls back both page and registration on failure, even if outer transaction catches it", () => {
  const f = fixture(true);
  try {
    f.store.db.exec("CREATE TRIGGER fail_registration BEFORE INSERT ON record_databases BEGIN SELECT RAISE(ABORT, 'registration failure'); END");
    const before = f.store.db.prepare("SELECT id,data FROM pages ORDER BY id").all();
    expect(() => f.store.create(null, "database", "outside")).toThrow("registration failure");
    f.store.transaction(() => {
      expect(() => f.store.create(null, "database", "inside")).toThrow("registration failure");
      expect(f.store.db.prepare("SELECT id,data FROM pages ORDER BY id").all()).toEqual(before);
      f.store.create(null, "page", "unrelated");
    });
    expect(f.store.pages().map(p => p.title)).toEqual(["unrelated"]);
    expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM record_databases").get()?.n).toBe(0);
  } finally { f.close(); }
});

it("rejects nonempty legacy rows or malformed structure through direct writes without modifying the source", () => {
  const f = fixture(true);
  try {
    const page = f.store.create(null, "database", "new db");
    const original = f.store.db.prepare("SELECT data FROM pages WHERE id=?").get(page.id)?.data;
    const injected = { ...page, database: { ...page.database!, rows: [{ id: "legacy", title: "row", values: {} }] } };
    expect(() => f.store.write(injected)).toThrow("旧形式");
    expect(() => f.store.write({ ...page, database: null })).toThrow("不正な構造");
    expect(f.store.db.prepare("SELECT data FROM pages WHERE id=?").get(page.id)?.data).toBe(original);
    expect(injected.database.rows[0].title).toBe("row");
  } finally { f.close(); }
});

it("rejects legacy recovery of rows atomically without changing the caller's input or destination", () => {
  const f = fixture(true);
  try {
    const input = { format: "folio-recovery", schemaVersion: 2, pages: [
      { id: "ordinary", title: "ordinary", kind: "page", schemaVersion: 1, doc: blankDoc(), database: null, icon: "📄", cover: "", favorite: false },
      { id: "legacy-db", title: "legacy", kind: "database", schemaVersion: 1, doc: blankDoc(), database: { ...emptyDatabase(), rows: [{ id: "row", title: "original row", values: { status: "old" } }] }, icon: "▦", cover: "", favorite: false },
    ] };
    const raw = JSON.stringify(input), before = f.store.db.prepare("SELECT id,data FROM pages ORDER BY id").all();
    expect(() => f.store.recover(input)).toThrow("旧形式");
    expect(JSON.stringify(input)).toBe(raw);
    expect(f.store.db.prepare("SELECT id,data FROM pages ORDER BY id").all()).toEqual(before);
    expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM record_databases").get()?.n).toBe(0);
  } finally { f.close(); }
});

it("keeps legacy v3 database creation and legacy row recovery behavior", () => {
  const f = fixture(false);
  try {
    const db = f.store.create(null, "database", "old");
    expect(f.store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    expect(f.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_databases'").get()).toBeUndefined();
    const data = { ...db.database!, rows: [{ id: "r", title: "legacy", values: {} }] };
    expect(f.store.update(db.id, db.revision, { database: data }).database?.rows).toEqual(data.rows);
    const input = { format: "folio-recovery", schemaVersion: 2, pages: [{ id: "old-db", title: "restored", kind: "database", schemaVersion: 1, doc: blankDoc(), database: data, icon: "▦", cover: "", favorite: false }] };
    const [restored] = f.store.recover(input);
    expect(restored.database?.rows).toEqual(data.rows);
  } finally { f.close(); }
});

it("rolls back a successful nested database creation when the outer transaction fails", () => {
  const f = fixture(true);
  try {
    expect(() => f.store.transaction(() => {
      const page = f.store.create(null, "database", "rollback");
      expect(f.store.db.prepare("SELECT 1 FROM record_databases WHERE database_page_id=?").get(page.id)).toBeTruthy();
      throw new Error("outer failure");
    })).toThrow("outer failure");
    expect(f.store.pages()).toEqual([]);
    expect(f.store.db.prepare("SELECT COUNT(*) AS n FROM record_databases").get()?.n).toBe(0);
  } finally { f.close(); }
});
