import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { RecordLifecycle } from "../src/persistence/record-lifecycle";
import { markRecordStoreVersion } from "../src/persistence/record-version";

function fixture() {
  const root = mkdtempSync(resolve("output/move-record-isolation-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const database = store.create(null, "database", "DB");
  const first = store.create(null, "page", "First"), second = store.create(null, "page", "Second");
  const records = new RecordRepository(store);
  store.transaction(() => { records.createSchema(); records.registerDatabase(database.id); });
  const active = records.create(database.id, "Active", { status: "active" });
  const trashed = records.create(database.id, "Trashed", { status: "trash" });
  new RecordLifecycle(store).trashRecord(trashed.pageId, trashed.revision);
  return { root, store, database, first, second, active, trashed,
    dispose() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function bytes(store: Store, id: string) {
  return store.db.prepare("SELECT id,data,body FROM pages WHERE id=?").get(id);
}
function membership(store: Store, id: string) {
  return store.db.prepare("SELECT * FROM record_memberships WHERE page_id=?").get(id);
}

it("reorders ordinary root Pages without touching active or trashed record Page bytes, history or membership", () => {
  const f = fixture();
  try {
    const ids = [f.active.pageId, f.trashed.pageId];
    const before = ids.map((id) => ({ page: bytes(f.store, id), membership: membership(f.store, id), versions: f.store.versions(id) }));
    const ownerBefore = bytes(f.store, f.database.id);
    f.store.move(f.second.id, null, f.first.id);
    expect(f.store.get(f.second.id).position).toBeLessThan(f.store.get(f.first.id).position);
    expect(ids.map((id) => ({ page: bytes(f.store, id), membership: membership(f.store, id), versions: f.store.versions(id) }))).toEqual(before);
    expect(f.store.get(f.active.pageId).revision).toBe(f.active.revision);
    expect(bytes(f.store, f.database.id)).toEqual(ownerBefore);
  } finally { f.dispose(); }
});

it("rejects moving a record, targeting a record, or moving a subtree containing a record", () => {
  const f = fixture();
  try {
    const initial = bytes(f.store, f.active.pageId);
    expect(() => f.store.move(f.active.pageId, null, null)).toThrow(/レコード/);
    expect(() => f.store.move(f.first.id, f.active.pageId, null)).toThrow(/レコード/);
    expect(() => f.store.move(f.first.id, null, f.active.pageId)).toThrow(/レコード/);
    expect(bytes(f.store, f.active.pageId)).toEqual(initial);
    // Simulate an already inconsistent hierarchy; a move must not carry it.
    const record = f.store.get(f.active.pageId);
    f.store.write({ ...record, parentId: f.first.id });
    const before = bytes(f.store, f.active.pageId);
    expect(() => f.store.move(f.first.id, f.second.id, null)).toThrow(/レコード/);
    expect(bytes(f.store, f.active.pageId)).toEqual(before);
  } finally { f.dispose(); }
});

it("rejects moves before any writes on partial record schema or an unknown marker", () => {
  for (const variant of ["v3-partial", "v4-partial", "v3-marker", "v4-marker"]) {
    const f = fixture();
    try {
      if (variant.startsWith("v4")) f.store.transaction(() => markRecordStoreVersion(f.store.db));
      if (variant.endsWith("partial")) {
        f.store.db.exec("PRAGMA foreign_keys=OFF; DROP TABLE record_databases");
      } else {
        if (variant.startsWith("v3")) f.store.db.exec("CREATE TABLE folio_record_schema(version INTEGER NOT NULL); INSERT INTO folio_record_schema VALUES(99)");
        else f.store.db.exec("UPDATE folio_record_schema SET version=99");
      }
      const before = [bytes(f.store, f.first.id), bytes(f.store, f.second.id), bytes(f.store, f.active.pageId)];
      expect(() => f.store.move(f.second.id, null, f.first.id)).toThrow(/record store/);
      expect([bytes(f.store, f.first.id), bytes(f.store, f.second.id), bytes(f.store, f.active.pageId)]).toEqual(before);
    } finally { f.dispose(); }
  }
});

it("leaves all Pages untouched when the moved Page write fails", () => {
  const f = fixture();
  try {
    const before = [bytes(f.store, f.database.id), bytes(f.store, f.first.id), bytes(f.store, f.second.id), bytes(f.store, f.active.pageId)];
    f.store.db.exec(`CREATE TRIGGER fail_move_later BEFORE UPDATE ON pages WHEN old.id='${f.second.id}' BEGIN SELECT RAISE(ABORT, 'synthetic later failure'); END`);
    expect(() => f.store.move(f.second.id, null, f.first.id)).toThrow(/synthetic later failure/);
    expect([bytes(f.store, f.database.id), bytes(f.store, f.first.id), bytes(f.store, f.second.id), bytes(f.store, f.active.pageId)]).toEqual(before);
  } finally { f.dispose(); }
});

it("preserves normal legacy v3 Page moves when no record schema exists", () => {
  const root = mkdtempSync(resolve("output/move-legacy-v3-")), store = new Store(join(root, "workspace.sqlite"));
  try {
    const a = store.create(null, "page", "A"), b = store.create(null, "page", "B");
    expect(store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    store.move(b.id, null, a.id);
    expect(store.get(b.id).position).toBe(0);
    expect(store.get(a.id).position).toBe(1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});


it("rejects moving or entering a registered database but permits a Page before it", () => {
  const f = fixture();
  try {
    const ownerBefore = bytes(f.store, f.database.id);
    expect(() => f.store.move(f.database.id, null, null)).toThrow(/データベース/);
    expect(() => f.store.move(f.first.id, f.database.id, null)).toThrow(/データベース/);
    f.store.move(f.first.id, null, f.database.id);
    expect(f.store.get(f.first.id).position).toBeLessThan(f.store.get(f.database.id).position);
    expect(bytes(f.store, f.database.id)).toEqual(ownerBefore);
    const owner = f.store.get(f.database.id);
    f.store.write({ ...owner, parentId: f.first.id });
    const nested = bytes(f.store, f.database.id);
    expect(() => f.store.move(f.first.id, f.second.id, null)).toThrow(/データベース/);
    expect(bytes(f.store, f.database.id)).toEqual(nested);
  } finally { f.dispose(); }
});


it("preserves mixed DB ordering without rewriting the DB or unrelated Page across restart", () => {
  const f = fixture();
  try {
    const ownerBefore = bytes(f.store, f.database.id), firstBefore = bytes(f.store, f.first.id);
    f.store.move(f.second.id, null, f.first.id);
    const order = () => f.store.pages().filter((page) => page.parentId === null &&
      [f.database.id, f.first.id, f.second.id].includes(page.id)).map((page) => page.id);
    expect(order()).toEqual([f.database.id, f.second.id, f.first.id]);
    expect(bytes(f.store, f.database.id)).toEqual(ownerBefore);
    expect(bytes(f.store, f.first.id)).toEqual(firstBefore);
    const orderBeforeClose = order();
    const path = join(f.root, "workspace.sqlite");
    f.store.close();
    const reopened = new Store(path);
    try {
      expect(reopened.pages().filter((page) => page.parentId === null &&
        [f.database.id, f.first.id, f.second.id].includes(page.id)).map((page) => page.id)).toEqual(orderBeforeClose);
      expect(bytes(reopened, f.database.id)).toEqual(ownerBefore);
    } finally { reopened.close(); }
  } finally { try { f.store.close(); } catch {} rmSync(f.root, { recursive: true, force: true }); }
});

it("rejects creating children under a registered database or record without changing originals", () => {
  const f = fixture();
  try {
    const before = [bytes(f.store, f.database.id), bytes(f.store, f.active.pageId), membership(f.store, f.active.pageId)];
    const count = f.store.pages().length;
    expect(() => f.store.create(f.database.id, "page", "Blocked under DB")).toThrow(/追加できません/);
    expect(() => f.store.create(f.active.pageId, "page", "Blocked under record")).toThrow(/追加できません/);
    expect(() => f.store.create(f.database.id, "database", "Blocked nested DB")).toThrow(/追加できません/);
    expect(f.store.pages()).toHaveLength(count);
    expect([bytes(f.store, f.database.id), bytes(f.store, f.active.pageId), membership(f.store, f.active.pageId)]).toEqual(before);
  } finally { f.dispose(); }
});

it("rejects an unrepresentable mixed-order slot without touching Pages", () => {
  const f = fixture();
  try {
    f.store.write({ ...f.store.get(f.database.id), position: 1 });
    f.store.write({ ...f.store.get(f.first.id), position: 1 + Number.EPSILON });
    const before = [bytes(f.store, f.database.id), bytes(f.store, f.first.id), bytes(f.store, f.second.id)];
    expect(() => f.store.move(f.second.id, null, f.first.id)).toThrow(/並び順に空き/);
    expect([bytes(f.store, f.database.id), bytes(f.store, f.first.id), bytes(f.store, f.second.id)]).toEqual(before);
  } finally { f.dispose(); }
});

it("preserves ordinary children of a legacy unregistered database", () => {
  const root = mkdtempSync(resolve("output/create-legacy-db-")), store = new Store(join(root, "workspace.sqlite"));
  try {
    const owner = store.create(null, "database", "Legacy DB");
    const child = store.create(owner.id, "page", "Legacy child");
    expect(child.parentId).toBe(owner.id);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

it("refuses to move unknown, lossy or noncanonical Page JSON without rewriting original bytes", () => {
  for (const variant of ["unknown-large", "duplicate-key", "noncanonical", "unknown-recovery", "invalid-position", "invalid-parent", "invalid-kind", "invalid-recovery"]) {
    const f = fixture();
    try {
      const original = (bytes(f.store, f.second.id) as { data: string }).data;
      const raw = variant === "unknown-large" ? original.slice(0, -1) + ',"future":9007199254740993}' :
        variant === "duplicate-key" ? original.slice(0, -1) + ',"title":"replacement"}' :
        variant === "noncanonical" ? " " + original :
        variant === "unknown-recovery" ? original.slice(0, -1) + ',"recoveredFrom":{"pageId":"old","recoveredAt":1,"future":true}}' :
        JSON.stringify({ ...JSON.parse(original), ...(variant === "invalid-position" ? { position: "unsupported" } :
          variant === "invalid-parent" ? { parentId: 123 } : variant === "invalid-kind" ? { kind: "future" } :
          { recoveredFrom: { pageId: 123, recoveredAt: 1 } }) });
      f.store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(raw, f.second.id);
      const owner = bytes(f.store, f.database.id), other = bytes(f.store, f.first.id);
      expect(() => f.store.move(f.second.id, null, f.first.id)).toThrow(/原本/);
      expect((bytes(f.store, f.second.id) as { data: string }).data).toBe(raw);
      expect(bytes(f.store, f.database.id)).toEqual(owner);
      expect(bytes(f.store, f.first.id)).toEqual(other);
    } finally { f.dispose(); }
  }
});

it("does not rewrite an unknown sibling even in an empty record store", () => {
  const root = mkdtempSync(resolve("output/move-empty-record-store-")), store = new Store(join(root, "workspace.sqlite"));
  try {
    const first = store.create(null, "page", "First"), second = store.create(null, "page", "Second");
    store.transaction(() => { new RecordRepository(store).createSchema(); markRecordStoreVersion(store.db); });
    const original = (bytes(store, first.id) as { data: string }).data;
    const unknown = original.slice(0, -1) + ',"future":9007199254740993}';
    store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(unknown, first.id);
    store.move(second.id, null, first.id);
    expect((bytes(store, first.id) as { data: string }).data).toBe(unknown);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

it("rejects unknown record table columns before create or move without rewriting originals", () => {
  for (const table of ["record_databases", "record_memberships", "record_value_versions"]) {
    const f = fixture();
    try {
      f.store.db.exec(`ALTER TABLE ${table} ADD COLUMN future_data TEXT`);
      const before = [bytes(f.store, f.first.id), bytes(f.store, f.second.id), bytes(f.store, f.database.id)];
      const count = f.store.pages().length;
      expect(() => f.store.create(null, "page", "New")).toThrow(/unsupported record store/);
      expect(() => f.store.move(f.second.id, null, f.first.id)).toThrow(/unsupported record store/);
      expect(f.store.pages()).toHaveLength(count);
      expect([bytes(f.store, f.first.id), bytes(f.store, f.second.id), bytes(f.store, f.database.id)]).toEqual(before);
    } finally { f.dispose(); }
  }
});

it("reserves positions of trashed ordinary Pages when creating or moving and restores without a tie", () => {
  const f = fixture();
  try {
    f.store.trash(f.first.id);
    const oldPosition = f.store.get(f.first.id).position;
    const created = f.store.create(null, "page", "New");
    expect(created.position).not.toBe(oldPosition);
    f.store.move(f.second.id, null, null);
    expect(f.store.get(f.second.id).position).not.toBe(oldPosition);
    f.store.restore(f.first.id);
    const positions = [f.database.id, f.first.id, f.second.id, created.id].map((id) => f.store.get(id).position);
    expect(new Set(positions).size).toBe(positions.length);
  } finally { f.dispose(); }
});

it("refuses to create a Page when a sibling position is nonfinite, duplicated or cannot advance", () => {
  for (const variant of ["infinite", "duplicate", "max"]) {
    const f = fixture();
    try {
      if (variant === "infinite") {
        const original = (bytes(f.store, f.first.id) as { data: string }).data;
        f.store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(original.replace(/\"position\":-?\d+(?:\.\d+)?/, '"position":1e400'), f.first.id);
      } else {
        const page = f.store.get(f.first.id);
        f.store.write({ ...page, position: variant === "max" ? Number.MAX_VALUE : f.store.get(f.database.id).position });
      }
      const before = [bytes(f.store, f.first.id), bytes(f.store, f.second.id), bytes(f.store, f.database.id)];
      const count = f.store.pages().length;
      expect(() => f.store.create(null, "page", "New")).toThrow(/並び順/);
      expect(f.store.pages()).toHaveLength(count);
      expect([bytes(f.store, f.first.id), bytes(f.store, f.second.id), bytes(f.store, f.database.id)]).toEqual(before);
    } finally { f.dispose(); }
  }
});


it("rejects child creation under an unsupported parent and preserves raw bytes", () => {
  const f = fixture();
  try {
    const original = (bytes(f.store, f.first.id) as { data: string }).data;
    const unknown = JSON.stringify({ ...JSON.parse(original), schemaVersion: 99 });
    f.store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(unknown, f.first.id);
    const count = f.store.pages().length;
    expect(() => f.store.create(f.first.id, "page", "Blocked")).toThrow(/原本/);
    expect((bytes(f.store, f.first.id) as { data: string }).data).toBe(unknown);
    expect(f.store.pages()).toHaveLength(count);
  } finally { f.dispose(); }
});

it("refuses writes if an already-open record store changes to an older runtime version", () => {
  for (const version of [0, 1, 2, 5]) {
    const f = fixture();
    try {
      f.store.db.exec(`PRAGMA user_version=${version}`);
      const before = [bytes(f.store, f.first.id), bytes(f.store, f.second.id), bytes(f.store, f.database.id)];
      expect(() => f.store.create(null, "page", "Blocked")).toThrow(/unsupported record store/);
      expect(() => f.store.move(f.second.id, null, f.first.id)).toThrow(/unsupported record store/);
      expect(() => f.store.update(f.first.id, f.first.revision, { title: "Blocked" })).toThrow(/unsupported record store/);
      expect([bytes(f.store, f.first.id), bytes(f.store, f.second.id), bytes(f.store, f.database.id)]).toEqual(before);
    } finally { f.dispose(); }
  }
});
