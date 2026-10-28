import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { emptyDatabase } from "../src/shared/types";

const legacy = () => ({
  properties: [{ id: "status", name: "Status", type: "text" }],
  rows: [{ id: "row", title: "Legacy", values: { status: "kept" } }],
  view: "table", filter: "", sort: "title",
});

function fixture(pageDatabase: unknown, histories: unknown[]) {
  const root = mkdtempSync(resolve("output/raw-database-guard-"));
  const path = join(root, "workspace.sqlite");
  let store = new Store(path);
  const page = store.create(null, "database", "source");
  const source = JSON.stringify({ ...page, database: pageDatabase }, null, 2);
  store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(source, page.id);
  const docs = histories.map((database) => JSON.stringify(database, null, 2));
  for (const [index, database] of docs.entries()) {
    store.db.prepare("INSERT INTO versions(pageId,createdAt,title,doc,database) VALUES(?,?,?,?,?)")
      .run(page.id, index + 1, `history-${index}`, JSON.stringify(page.doc), database);
  }
  store.db.exec("PRAGMA user_version=2");
  store.close();
  store = new Store(path);
  return {
    root, path, store, page, source, docs,
    rawPage() { return (store.db.prepare("SELECT data FROM pages WHERE id=?").get(page.id) as {data:string}).data; },
    rawHistory() { return (store.db.prepare("SELECT database FROM versions WHERE pageId=? ORDER BY id").all(page.id) as {database:string}[]).map((row) => row.database); },
    dispose() { store.close(); rmSync(root, {recursive:true, force:true}); },
  };
}

it.each(["database", "property", "row", "view", "lossy-view"])(
  "protects unsupported %s data in a current page and all its history",
  (location) => {
    const source: any = location === "view" ? emptyDatabase() : legacy();
    if (location === "database") source.future = { raw: "keep" };
    if (location === "property") source.properties[0].future = "keep";
    if (location === "row") source.rows[0].future = "keep";
    if (location === "view") source.views[0].future = "keep";
    if (location === "lossy-view") source.view = "future-view";
    const f = fixture(source, [legacy(), { ...legacy(), futureHistory: "keep" }]);
    try {
      expect(f.rawPage()).toBe(f.source);
      expect(f.rawHistory()).toEqual(f.docs);
      const loaded = f.store.get(f.page.id);
      expect(loaded.documentError).toMatch(/未対応/);
      expect(() => f.store.update(f.page.id, loaded.revision, {title: "overwrite"})).toThrow(/未対応/);
      // A caller must not bypass the raw check using its own normalized Page.
      expect(() => f.store.write({...f.page, title:"forged"})).toThrow(/未対応/);
      expect(f.rawPage()).toBe(f.source);
      expect(f.rawHistory()).toEqual(f.docs);
    } finally { f.dispose(); }
  },
);

it("keeps an unknown history byte-for-byte while converting known current and history data", () => {
  const unknown = legacy() as any;
  unknown.rows[0].future = { nested: "preserve" };
  const f = fixture(legacy(), [unknown, legacy()]);
  try {
    expect(f.rawHistory()[0]).toBe(f.docs[0]);
    expect(JSON.parse(f.rawHistory()[1]).schemaVersion).toBe(2);
    const page = f.store.get(f.page.id);
    expect(page.documentError).toBeUndefined();
    expect(page.database?.rows).toEqual(legacy().rows);
    expect(page.database?.views[0].type).toBe("table");
    const unknownVersion = f.store.versions(page.id).find((v) => v.title === "history-0")!;
    const before = f.rawPage();
    expect(() => f.store.handle({type: "restoreVersion", id: page.id, versionId: unknownVersion.id, revision: page.revision})).toThrow(/未対応/);
    expect(f.rawPage()).toBe(before);
    expect(f.rawHistory()[0]).toBe(f.docs[0]);
    const saved = f.store.update(page.id, page.revision, {title:"edited"});
    expect(saved.title).toBe("edited");
    expect(f.rawHistory()[0]).toBe(f.docs[0]);
  } finally { f.dispose(); }
});

it("rejects lossy changes in incoming database objects without changing the original", () => {
  const f = fixture(legacy(), []);
  try {
    const page = f.store.get(f.page.id), raw = f.rawPage();
    const unsafe = structuredClone(page.database!) as any;
    unsafe.properties[0].future = "keep";
    expect(() => f.store.write({...page, database: unsafe})).toThrow();
    expect(f.rawPage()).toBe(raw);
  } finally { f.dispose(); }
});
