import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { markRecordStoreVersion } from "../src/persistence/record-version";

function fixture() {
  const root = mkdtempSync(resolve("output/record-schema-guard-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const database = store.create(null, "database", "DB");
  const records = new RecordRepository(store);
  store.transaction(() => {
    records.createSchema();
    records.registerDatabase(database.id);
  });
  const record = records.create(database.id, "Before", { status: "old" });
  return {
    store, database, record,
    dispose() { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

function rawPage(store: Store, id: string) {
  return store.db.prepare("SELECT data FROM pages WHERE id=?").get(id)?.data;
}

it("refuses record Page writes for missing v3 or v4 membership/history tables without changing data", () => {
  for (const version of [3, 4]) {
    for (const table of ["record_databases", "record_memberships", "record_value_versions", ...(version === 4 ? ["folio_record_schema"] : [])]) {
      const f = fixture();
      try {
        if (version === 4) f.store.transaction(() => markRecordStoreVersion(f.store.db));
        const before = rawPage(f.store, f.record.pageId);
        // Simulate an externally damaged store in this isolated fixture.
        f.store.db.exec("PRAGMA foreign_keys=OFF");
        f.store.db.exec(`DROP TABLE ${table}`);
        expect(() => f.store.updateRecordPage(f.record.pageId, f.database.id, 0, { title: "bad" }))
          .toThrow(/record store/);
        expect(rawPage(f.store, f.record.pageId)).toBe(before);
        expect(f.store.versions(f.record.pageId)).toHaveLength(0);
      } finally { f.dispose(); }
    }
  }
});

it("rejects absent, unknown or ambiguous v3 and v4 marker contents before record Page writes", () => {
  for (const version of [3, 4]) {
    for (const rows of [[], [99], [1, 1], [1, 99]]) {
      const f = fixture();
      try {
        if (version === 4) f.store.transaction(() => markRecordStoreVersion(f.store.db));
        else f.store.db.exec("CREATE TABLE folio_record_schema(version INTEGER NOT NULL)");
        f.store.db.exec("DELETE FROM folio_record_schema");
        for (const marker of rows)
          f.store.db.prepare("INSERT INTO folio_record_schema(version) VALUES(?)").run(marker);
        const before = rawPage(f.store, f.record.pageId);
        const values = f.store.db.prepare("SELECT values_json FROM record_memberships WHERE page_id=?").get(f.record.pageId)?.values_json;
        expect(() => f.store.updateRecordPage(f.record.pageId, f.database.id, 0, { title: "bad" }))
          .toThrow(/record store/);
        expect(rawPage(f.store, f.record.pageId)).toBe(before);
        expect(f.store.db.prepare("SELECT values_json FROM record_memberships WHERE page_id=?").get(f.record.pageId)?.values_json).toBe(values);
        expect(f.store.versions(f.record.pageId)).toHaveLength(0);
      } finally { f.dispose(); }
    }
  }
});

it("refuses a marker with unknown columns in both v3 and v4", () => {
  for (const version of [3, 4]) {
    const f = fixture();
    try {
      if (version === 4) f.store.transaction(() => markRecordStoreVersion(f.store.db));
      else f.store.db.exec("CREATE TABLE folio_record_schema(version INTEGER NOT NULL); INSERT INTO folio_record_schema VALUES(1)");
      f.store.db.exec("ALTER TABLE folio_record_schema ADD COLUMN future TEXT");
      const before = rawPage(f.store, f.record.pageId);
      expect(() => f.store.updateRecordPage(f.record.pageId, f.database.id, 0, { title: "bad" }))
        .toThrow(/record store/);
      expect(rawPage(f.store, f.record.pageId)).toBe(before);
      expect(f.store.versions(f.record.pageId)).toHaveLength(0);
    } finally { f.dispose(); }
  }
});

it("keeps marker-free experimental v3 records and ordinary legacy v3 Pages writable", () => {
  const f = fixture();
  try {
    expect(f.store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    const ordinary = f.store.create(null, "page", "Ordinary");
    expect(f.store.update(ordinary.id, 0, { title: "Updated" }).title).toBe("Updated");
    expect(f.store.updateRecordPage(f.record.pageId, f.database.id, 0, { title: "Updated record" }).title).toBe("Updated record");
  } finally { f.dispose(); }
});

it("accepts the known single-column version-one marker in v3 and v4", () => {
  for (const version of [3, 4]) {
    const f = fixture();
    try {
      if (version === 4) f.store.transaction(() => markRecordStoreVersion(f.store.db));
      else f.store.db.exec("CREATE TABLE folio_record_schema(version INTEGER NOT NULL); INSERT INTO folio_record_schema VALUES(1)");
      const updated = f.store.updateRecordPage(f.record.pageId, f.database.id, 0, { title: "known" });
      expect(updated.title).toBe("known");
      expect(updated.revision).toBe(1);
    } finally { f.dispose(); }
  }
});

it("keeps a legacy v3 workspace with no record tables writable", () => {
  const root = mkdtempSync(resolve("output/record-schema-legacy-"));
  const store = new Store(join(root, "workspace.sqlite"));
  try {
    expect(store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    const page = store.create(null, "page", "Legacy");
    expect(store.update(page.id, page.revision, { title: "Updated" }).title).toBe("Updated");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
