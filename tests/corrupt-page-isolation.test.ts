import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { prepareDatabaseCreation, type DatabaseOperationResult } from "../src/shared/database-operation";
import { isDocument, type Page } from "../src/shared/types";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "folio-corrupt-isolation-"));
  const path = join(directory, "workspace.sqlite");
  let current = new Store(path);
  return {
    get store() { return current; },
    reopen() { current.close(); current = new Store(path); },
    dispose() { current.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

function registeredDatabase(store: Store, title: string) {
  const result = store.handle({ type: "database:commit", operation: prepareDatabaseCreation(title) }) as DatabaseOperationResult;
  if (result.status !== "applied" || !result.page) throw new Error("Fixture database creation failed");
  const record = new RecordRepository(store).create(result.page.id, `${title} record`, { status: "未着手" });
  return { owner: result.page, record };
}

function rawRows(store: Store) {
  return store.db.prepare("SELECT id,data,body FROM pages ORDER BY id").all();
}

function totalChanges(store: Store) {
  return store.db.prepare("SELECT total_changes() AS count").get();
}

function corrupt(store: Store, page: Page, variant: string, alias: string) {
  const source = variant === "invalid-json" ? '{"id": "incomplete",\n' :
    variant === "missing-metadata" ? JSON.stringify({ id: page.id, doc: page.doc }, null, 2) :
    JSON.stringify({ ...page, id: alias }, null, 2);
  store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(source, page.id);
  return source;
}

function expectReadOnlyDisplay(page: Page | undefined, id: string) {
  expect(page).toBeDefined();
  expect(page!.id).toBe(id);
  expect(typeof page!.documentError).toBe("string");
  expect(page!.documentError!.length).toBeGreaterThan(0);
  expect(typeof page!.title).toBe("string");
  expect(Number.isFinite(page!.position)).toBe(true);
  expect(isDocument(page!.doc)).toBe(true);
}

describe("corrupt page isolation", () => {
  it.each(["invalid-json", "missing-metadata", "mismatched-id"])("loads and searches healthy pages while preserving exact %s source bytes", variant => {
    const f = fixture();
    try {
      const healthy = f.store.create(null, "page", "Healthy searchable needle");
      const broken = f.store.create(null, "page", "Broken original");
      const source = corrupt(f.store, broken, variant, healthy.id);
      const before = rawRows(f.store), changes = totalChanges(f.store);
      const loaded = f.store.load();
      expect(loaded.pages).toHaveLength(2);
      expect(loaded.pages.filter(page => page.id === healthy.id)).toHaveLength(1);
      expect(loaded.pages.find(page => page.id === healthy.id)).toEqual(healthy);
      expectReadOnlyDisplay(loaded.pages.find(page => page.id === broken.id), broken.id);
      const found = f.store.handle({ type: "search", query: "searchable needle" }) as Page[];
      expect(found.map(page => page.id)).toContain(healthy.id);
      expect(f.store.handle({ type: "pageSource", id: broken.id })).toBe(source);
      expect(rawRows(f.store)).toEqual(before);
      expect(totalChanges(f.store)).toEqual(changes);
      expect(f.store.db.isTransaction).toBe(false);

      const edited = f.store.update(healthy.id, healthy.revision, { title: "Healthy edited needle" });
      expect(edited.title).toBe("Healthy edited needle");
      expect(f.store.get(healthy.id)).toEqual(edited);
      expect(f.store.handle({ type: "pageSource", id: broken.id })).toBe(source);
      f.reopen();
      expect(f.store.get(healthy.id)).toEqual(edited);
      expectReadOnlyDisplay(f.store.load().pages.find(page => page.id === broken.id), broken.id);
      expect(f.store.handle({ type: "pageSource", id: broken.id })).toBe(source);
    } finally { f.dispose(); }
  });

  it.each(["invalid-json", "missing-metadata", "mismatched-id"])("keeps strict access and forged writes fail-closed for %s", variant => {
    const f = fixture();
    try {
      const healthy = f.store.create(null, "page", "Healthy");
      const broken = f.store.create(healthy.id, "page", "Broken child");
      const source = corrupt(f.store, broken, variant, healthy.id);
      const before = rawRows(f.store);
      expect(() => f.store.get(broken.id)).toThrow();
      expect(() => f.store.pages()).toThrow();
      expect(() => f.store.write({ ...broken, title: "Forged replacement" })).toThrow();
      expect(() => f.store.update(broken.id, broken.revision, { title: "Replacement" })).toThrow();
      expect(() => f.store.create(null, "page", "Cannot safely classify siblings")).toThrow();
      expect(() => f.store.move(healthy.id, null, null)).toThrow();
      expect(() => f.store.duplicate(healthy.id)).toThrow();
      expect(() => f.store.trash(healthy.id)).toThrow();
      expect(() => f.store.restore(healthy.id)).toThrow();
      expect(rawRows(f.store)).toEqual(before);
      expect(f.store.handle({ type: "pageSource", id: broken.id })).toBe(source);
      expect(f.store.db.isTransaction).toBe(false);
    } finally { f.dispose(); }
  });

  it("omits a corrupt record projection, marks its owner read-only and keeps another database available", () => {
    const f = fixture();
    try {
      const damaged = registeredDatabase(f.store, "Damaged owner");
      const healthy = registeredDatabase(f.store, "Healthy owner");
      const intactSibling = new RecordRepository(f.store).create(damaged.owner.id, "Intact sibling record", {});
      const recordPage = f.store.get(damaged.record.pageId);
      const source = corrupt(f.store, recordPage, "invalid-json", "unused");
      const before = rawRows(f.store), changes = totalChanges(f.store);
      const loaded = f.store.load();
      expectReadOnlyDisplay(loaded.pages.find(page => page.id === recordPage.id), recordPage.id);
      expectReadOnlyDisplay(loaded.pages.find(page => page.id === damaged.owner.id), damaged.owner.id);
      expectReadOnlyDisplay(loaded.pages.find(page => page.id === intactSibling.pageId), intactSibling.pageId);
      expect(loaded.records?.some(record => record.pageId === recordPage.id)).toBe(false);
      expect(loaded.records?.some(record => record.databasePageId === damaged.owner.id)).toBe(false);
      expect(loaded.records?.find(record => record.pageId === healthy.record.pageId)).toEqual(healthy.record);
      expect(loaded.pages.find(page => page.id === healthy.owner.id)?.documentError).toBeUndefined();
      expect((f.store.handle({ type: "search", query: "Healthy owner record" }) as Page[]).map(page => page.id)).toContain(healthy.record.pageId);
      expect(rawRows(f.store)).toEqual(before);
      expect(totalChanges(f.store)).toEqual(changes);
      expect(f.store.handle({ type: "pageSource", id: recordPage.id })).toBe(source);
      expect(() => f.store.updateRecordPage(recordPage.id, damaged.owner.id, recordPage.revision, { title: "overwrite" })).toThrow();
      f.reopen();
      expect(f.store.load().records?.find(record => record.pageId === healthy.record.pageId)).toEqual(healthy.record);
      expect(f.store.handle({ type: "pageSource", id: recordPage.id })).toBe(source);
    } finally { f.dispose(); }
  });

  it("omits projections owned by a corrupt database and refuses record writes without changing membership", () => {
    const f = fixture();
    try {
      const damaged = registeredDatabase(f.store, "Damaged owner");
      const healthy = registeredDatabase(f.store, "Healthy owner");
      const recordPage = f.store.get(damaged.record.pageId);
      const source = corrupt(f.store, damaged.owner, "invalid-json", "unused");
      const before = rawRows(f.store);
      const membersBefore = f.store.db.prepare("SELECT * FROM record_memberships ORDER BY page_id").all();
      const loaded = f.store.load();
      expectReadOnlyDisplay(loaded.pages.find(page => page.id === damaged.owner.id), damaged.owner.id);
      expect(loaded.records?.some(record => record.databasePageId === damaged.owner.id)).toBe(false);
      expect(loaded.records?.find(record => record.pageId === healthy.record.pageId)).toEqual(healthy.record);
      expect(() => f.store.updateRecordPage(recordPage.id, damaged.owner.id, recordPage.revision, { title: "overwrite" })).toThrow();
      expect(rawRows(f.store)).toEqual(before);
      expect(f.store.db.prepare("SELECT * FROM record_memberships ORDER BY page_id").all()).toEqual(membersBefore);
      expect(f.store.handle({ type: "pageSource", id: damaged.owner.id })).toBe(source);
      f.reopen();
      expect(f.store.load().records?.some(record => record.databasePageId === damaged.owner.id)).toBe(false);
      expect(f.store.handle({ type: "pageSource", id: damaged.owner.id })).toBe(source);
    } finally { f.dispose(); }
  });

  it("keeps supported metadata and existing future-document read-only protection", () => {
    const f = fixture();
    try {
      const page = f.store.create(null, "page", "Future document title");
      const source = JSON.stringify({ ...page, schemaVersion: 99 }, null, 2);
      f.store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(source, page.id);
      const loaded = f.store.load().pages.find(item => item.id === page.id)!;
      expectReadOnlyDisplay(loaded, page.id);
      expect(loaded.title).toBe(page.title);
      expect(f.store.get(page.id).documentError).toBeTruthy();
      expect(() => f.store.write({ ...page, title: "forged" })).toThrow();
      expect(() => f.store.update(page.id, page.revision, { title: "forged" })).toThrow();
      expect(f.store.handle({ type: "pageSource", id: page.id })).toBe(source);
    } finally { f.dispose(); }
  });

  it("does not convert unrelated malformed membership values into a successful partial snapshot", () => {
    const f = fixture();
    try {
      const database = registeredDatabase(f.store, "Owner");
      f.store.db.prepare("UPDATE record_memberships SET values_json=? WHERE page_id=?").run("{", database.record.pageId);
      const before = rawRows(f.store);
      expect(() => f.store.load()).toThrow();
      expect(() => f.store.handle({ type: "search", query: "Owner" })).toThrow();
      expect(f.store.db.isTransaction).toBe(false);
      expect(rawRows(f.store)).toEqual(before);
      expect(f.store.db.prepare("SELECT values_json FROM record_memberships WHERE page_id=?").get(database.record.pageId)).toEqual({ values_json: "{" });
    } finally { f.dispose(); }
  });

  it("propagates malformed membership SQL errors and releases its read transaction", () => {
    const f = fixture();
    try {
      registeredDatabase(f.store, "Owner");
      f.store.db.exec("ALTER TABLE record_memberships RENAME COLUMN page_id TO broken_page_id");
      const before = rawRows(f.store);
      expect(() => f.store.load()).toThrow(/page_id/);
      expect(() => f.store.handle({ type: "search", query: "Owner" })).toThrow(/page_id/);
      expect(f.store.db.isTransaction).toBe(false);
      expect(rawRows(f.store)).toEqual(before);
    } finally { f.dispose(); }
  });

  it.each(["storage", "decoder"])("does not quarantine an injected unrelated %s exception", layer => {
    const f = fixture();
    try {
      const page = f.store.create(null, "page", "Healthy");
      const before = rawRows(f.store);
      const failure = new Error(layer === "storage" ? "SQLITE_IOERR: injected read failure" : "Unexpected decoder implementation error");
      let restore: () => void;
      if (layer === "storage") {
        const db = f.store.db, prepare = db.prepare.bind(db);
        const spy = vi.spyOn(db, "prepare").mockImplementation(sql => {
          if (sql === "SELECT id,data FROM pages") throw failure;
          return prepare(sql);
        });
        restore = () => spy.mockRestore();
      } else {
        const spy = vi.spyOn(f.store, "decode").mockImplementation(() => { throw failure; });
        restore = () => spy.mockRestore();
      }
      try {
        expect(() => f.store.load()).toThrow(failure);
        expect(() => f.store.handle({ type: "search", query: "Healthy" })).toThrow(failure);
        expect(f.store.db.isTransaction).toBe(false);
      } finally { restore(); }
      expect(rawRows(f.store)).toEqual(before);
      expect(f.store.load().pages).toEqual([page]);
    } finally { f.dispose(); }
  });
});
