import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { RecordLifecycle } from "../src/persistence/record-lifecycle";
import { blankDoc, emptyDatabase, type DatabaseSettings, type Page, type RecordProjection } from "../src/shared/types";
import { prepareDatabaseCreation } from "../src/shared/database-operation";
import { commitDatabaseOperation, readDatabaseSnapshot } from "../src/persistence/database-operations";

type Fixture = {
  root: string;
  path: string;
  store: Store;
  owner: Page;
  settings: DatabaseSettings;
  records: RecordRepository;
  first: RecordProjection;
  second: RecordProjection;
  dispose(): void;
};

function fixture(): Fixture {
  const root = mkdtempSync(resolve("output/database-read-snapshot-")), path = join(root, "workspace.sqlite");
  const store = new Store(path);
  const { rows: _rows, ...settings } = emptyDatabase();
  const created = commitDatabaseOperation(store, prepareDatabaseCreation("Tasks", null, settings));
  const owner = created.page!;
  const records = new RecordRepository(store);
  const first = records.create(owner.id, "First", { status: "未着手" });
  const second = records.create(owner.id, "Second", { status: "完了" });
  return {
    root, path, store, owner, settings, records, first, second,
    dispose() {
      vi.restoreAllMocks();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function rewritePage(f: Fixture, pageId: string, mutate: (page: any) => any) {
  const row = f.store.db.prepare("SELECT data FROM pages WHERE id=?").get(pageId) as { data: string };
  f.store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(JSON.stringify(mutate(JSON.parse(row.data))), pageId);
}

function writeRawPage(f: Fixture, pageId: string, data: string) {
  f.store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(data, pageId);
}

/** Every raw row of the target database, including the record memberships. */
function targetRaw(f: Fixture) {
  return {
    pages: f.store.db.prepare("SELECT id,data,body FROM pages WHERE id IN (?,?,?) ORDER BY id")
      .all(f.owner.id, f.first.pageId, f.second.pageId),
    members: f.store.db.prepare("SELECT page_id,database_page_id,position,values_json FROM record_memberships ORDER BY page_id").all(),
    owners: f.store.db.prepare("SELECT * FROM record_databases ORDER BY database_page_id").all(),
  };
}

it("matches the full load for owner, settings, record order and trashed state", () => {
  const f = fixture();
  try {
    new RecordLifecycle(f.store).trashRecord(f.second.pageId, f.store.get(f.second.pageId).revision);
    // Equal positions force the same page_id tie-break as the full load.
    f.store.db.prepare("UPDATE record_memberships SET position=0 WHERE database_page_id=?").run(f.owner.id);
    const snapshot = f.store.load();
    const page = snapshot.pages.find((item) => item.id === f.owner.id)!;
    const { rows: _rows, ...settings } = page.database!;
    const expected = {
      page,
      database: {
        settings,
        revision: page.revision,
        records: snapshot.records!.filter((record) => record.databasePageId === f.owner.id),
      },
    };
    const read = readDatabaseSnapshot(f.store, f.owner.id);
    expect(read).toEqual(expected);
    expect(read.database.settings).toEqual(f.settings);
    expect(read.database.records.map((record) => record.pageId)).toEqual([f.first.pageId, f.second.pageId].sort());
    expect(read.database.records.find((record) => record.pageId === f.second.pageId)!.deletedAt)
      .toBe(f.store.get(f.second.pageId).deletedAt);
    expect(read.database.records.find((record) => record.pageId === f.first.pageId)!.deletedAt).toBeNull();
    f.store.db.prepare("UPDATE record_memberships SET position=? WHERE page_id=?").run(1, f.second.pageId);
    f.store.db.prepare("UPDATE record_memberships SET position=? WHERE page_id=?").run(0, f.first.pageId);
    expect(readDatabaseSnapshot(f.store, f.owner.id).database.records.map((record) => record.title))
      .toEqual(["First", "Second"]);
  } finally {
    f.dispose();
  }
});

it("keeps a second connection's committed changes out of an in-flight read", () => {
  const f = fixture();
  const other = new Store(f.path);
  try {
    const repo = new RecordRepository(other);
    const get = f.store.get.bind(f.store);
    let injected = false;
    vi.spyOn(f.store, "get").mockImplementation((id) => {
      const page = get(id);
      if (id === f.owner.id && !injected) {
        injected = true;
        other.update(f.owner.id, page.revision, { title: "owner after" });
        const { rows: _rows, ...settings } = other.get(f.owner.id).database!;
        repo.updateSettings(f.owner.id, other.get(f.owner.id).revision, {
          ...settings, views: settings.views.map((view) => ({ ...view, name: "After view" })),
        });
        repo.patch(f.first.pageId, f.owner.id, other.get(f.first.pageId).revision, {
          title: "First after", values: { status: "完了" },
        });
        repo.create(f.owner.id, "Third", { status: "未着手" });
      }
      return page;
    });
    const read = readDatabaseSnapshot(f.store, f.owner.id);
    expect(injected).toBe(true);
    expect(read.page).toMatchObject({ title: "Tasks", revision: 0 });
    expect(read.database.revision).toBe(0);
    expect(read.database.settings.views[0].name).toBe("テーブル");
    expect(read.database.records.map((record) => record.title)).toEqual(["First", "Second"]);
    expect(read.database.records[0].values).toEqual({ status: "未着手" });
    expect(f.store.db.isTransaction).toBe(false);
    const after = readDatabaseSnapshot(f.store, f.owner.id);
    expect(after.page).toMatchObject({ title: "owner after", revision: 2 });
    expect(after.database.revision).toBe(2);
    expect(after.database.settings.views[0].name).toBe("After view");
    expect(after.database.records.map((record) => record.title)).toEqual(["First after", "Second", "Third"]);
    expect(after.database.records[0].values).toEqual({ status: "完了" });
  } finally {
    other.close();
    f.dispose();
  }
});

const ownerRejections: [string, (f: Fixture) => void][] = [
  ["an owner with an unknown page schema", (f) => rewritePage(f, f.owner.id, (page) => ({ ...page, schemaVersion: 2 }))],
  ["a trashed owner", (f) => rewritePage(f, f.owner.id, (page) => ({ ...page, deletedAt: 1 }))],
  ["an owner that still carries legacy rows", (f) => rewritePage(f, f.owner.id,
    (page) => ({ ...page, database: { ...page.database, rows: [{ id: "legacy", title: "Legacy", values: {} }] } }))],
  ["a Page owner instead of a database", (f) => rewritePage(f, f.owner.id, (page) => ({ ...page, kind: "page" }))],
  ["an owner that is not registered", (f) => {
    f.store.db.prepare("DELETE FROM record_databases WHERE database_page_id=?").run(f.owner.id);
  }],
];

it.each(ownerRejections)("rejects %s without rewriting its rows", (name, mutate) => {
  const f = fixture();
  try {
    mutate(f);
    const before = targetRaw(f);
    expect(() => readDatabaseSnapshot(f.store, f.owner.id)).toThrow(/安全に読み込めません/);
    expect(targetRaw(f)).toEqual(before);
  } finally {
    f.dispose();
  }
});

const recordRejections: [string, (f: Fixture) => void][] = [
  ["a record Page with unreadable JSON", (f) => writeRawPage(f, f.first.pageId, "{not json")],
  ["a record Page with an unknown document schema", (f) => rewritePage(f, f.first.pageId, (page) => ({ ...page, schemaVersion: 2 }))],
  ["a record Page whose JSON ID does not match its row", (f) => rewritePage(f, f.first.pageId,
    (page) => ({ ...page, id: "different-page" }))],
  ["a record membership with unreadable values", (f) => {
    f.store.db.prepare("UPDATE record_memberships SET values_json=? WHERE page_id=?").run("{invalid", f.first.pageId);
  }],
  ["a record membership with nested values", (f) => {
    f.store.db.prepare("UPDATE record_memberships SET values_json=? WHERE page_id=?").run(JSON.stringify([1, 2]), f.first.pageId);
  }],
];

it.each(recordRejections)("rejects the whole collection for %s", (name, mutate) => {
  const f = fixture();
  try {
    mutate(f);
    const before = targetRaw(f);
    expect(() => readDatabaseSnapshot(f.store, f.owner.id)).toThrow();
    expect(targetRaw(f)).toEqual(before);
  } finally {
    f.dispose();
  }
});

it("does not let damaged unrelated Pages or databases block the target", () => {
  const f = fixture();
  try {
    const noise = commitDatabaseOperation(f.store, prepareDatabaseCreation("Noise", null, f.settings)).page!;
    const noiseRecord = new RecordRepository(f.store).create(noise.id, "Noise row", { status: "未着手" });
    const plain = f.store.create(null, "page", "Unrelated");
    // A corrupted unrelated plain Page, a corrupted unrelated record and an
    // unrelated owner with an unknown schema all stay outside this read.
    writeRawPage(f, plain.id, "{broken unrelated page");
    writeRawPage(f, noiseRecord.pageId, "{broken unrelated record");
    rewritePage(f, noise.id, (page) => ({ ...page, schemaVersion: 2 }));
    const unrelatedIds = [plain.id, noise.id, noiseRecord.pageId];
    const raw = () => ({
      pages: f.store.db.prepare("SELECT id,data,body FROM pages WHERE id IN (?,?,?) ORDER BY id").all(...unrelatedIds),
      members: f.store.db.prepare("SELECT page_id,database_page_id,position,values_json FROM record_memberships WHERE database_page_id=? ORDER BY page_id").all(noise.id),
    });
    const before = raw();
    const read = readDatabaseSnapshot(f.store, f.owner.id);
    expect(read.database.records.map((record) => record.title)).toEqual(["First", "Second"]);
    expect(raw()).toEqual(before);
    // The same damage is visible to the whole-workspace read, proving the
    // fixture is damaged rather than merely ignored by both paths.
    const all = f.store.load();
    expect(all.pages.find((page) => page.id === noise.id)?.documentError).toBeTruthy();
    expect(all.records?.some((record) => record.pageId === noiseRecord.pageId)).toBe(false);
  } finally {
    f.dispose();
  }
});

it("rejects a database whose record schema is missing and leaves every Page row intact", () => {
  for (const table of ["record_memberships", "record_databases"]) {
    const f = fixture();
    try {
      f.store.db.exec(`DROP TABLE ${table}`);
      const before = f.store.db.prepare("SELECT id,data,body FROM pages ORDER BY id").all();
      expect(() => readDatabaseSnapshot(f.store, f.owner.id)).toThrow(/安全に読み込めません/);
      expect(f.store.db.prepare("SELECT id,data,body FROM pages ORDER BY id").all()).toEqual(before);
    } finally {
      f.dispose();
    }
  }
});

it("rejects an unregistered legacy v3 database through the same read path", () => {
  const root = mkdtempSync(resolve("output/database-read-snapshot-v3-")), store = new Store(join(root, "workspace.sqlite"));
  try {
    const legacy = store.create(null, "database", "Legacy");
    const before = store.db.prepare("SELECT id,data FROM pages WHERE id=?").get(legacy.id);
    expect(store.db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 3 });
    expect(() => readDatabaseSnapshot(store, legacy.id)).toThrow(/登録済みデータベースを安全に読み込めません/);
    expect(store.db.prepare("SELECT id,data FROM pages WHERE id=?").get(legacy.id)).toEqual(before);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("reuses a caller-owned transaction without committing or rolling it back", () => {
  const f = fixture();
  try {
    const db = f.store.db;
    db.exec("BEGIN IMMEDIATE");
    f.store.write({ ...f.store.get(f.owner.id), title: "caller pending" });
    const read = readDatabaseSnapshot(f.store, f.owner.id);
    expect(read.page.title).toBe("caller pending");
    expect(db.isTransaction).toBe(true);
    const exec = vi.spyOn(db, "exec");
    const failure = vi.spyOn(RecordRepository.prototype, "projectionsForDatabase")
      .mockImplementationOnce(() => { throw new Error("caller read failure"); });
    expect(() => readDatabaseSnapshot(f.store, f.owner.id)).toThrow("caller read failure");
    expect(exec).not.toHaveBeenCalled();
    expect(db.isTransaction).toBe(true);
    expect(f.store.get(f.owner.id).title).toBe("caller pending");
    failure.mockRestore();
    exec.mockRestore();
    db.exec("COMMIT");
    expect(f.store.get(f.owner.id).title).toBe("caller pending");
    expect(readDatabaseSnapshot(f.store, f.owner.id).database.records).toHaveLength(2);
  } finally {
    if (f.store.db.isTransaction) f.store.db.exec("ROLLBACK");
    f.dispose();
  }
});

it("rolls back a failed read and keeps the connection usable", () => {
  const f = fixture();
  try {
    const failure = vi.spyOn(RecordRepository.prototype, "projectionsForDatabase")
      .mockImplementationOnce(() => { throw new Error("injected mid-read failure"); });
    expect(() => readDatabaseSnapshot(f.store, f.owner.id)).toThrow("injected mid-read failure");
    expect(f.store.db.isTransaction).toBe(false);
    failure.mockRestore();
    expect(f.store.get(f.owner.id).title).toBe("Tasks");
    expect(readDatabaseSnapshot(f.store, f.owner.id).database.records).toHaveLength(2);
  } finally {
    f.dispose();
  }
});

it("refuses to report a snapshot when BEGIN fails and closes the connection", () => {
  const f = fixture(),
    db = f.store.db,
    exec = db.exec.bind(db);
  try {
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "BEGIN") throw new Error("injected BEGIN failure");
      return exec(sql);
    });
    expect(() => readDatabaseSnapshot(f.store, f.owner.id)).toThrow(/BEGIN failed/);
    expect(db.isOpen).toBe(false);
    expect(() => db.prepare("SELECT 1")).toThrow();
    expect(() => readDatabaseSnapshot(f.store, f.owner.id)).toThrow(/unusable/);
  } finally {
    f.dispose();
  }
});

it("refuses to report a snapshot when COMMIT fails and closes the connection", () => {
  const f = fixture(),
    db = f.store.db,
    exec = db.exec.bind(db);
  try {
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT") throw new Error("injected COMMIT failure");
      return exec(sql);
    });
    expect(() => readDatabaseSnapshot(f.store, f.owner.id)).toThrow(/COMMIT failed/);
    expect(db.isOpen).toBe(false);
    expect(() => db.prepare("SELECT 1")).toThrow();
    expect(() => readDatabaseSnapshot(f.store, f.owner.id)).toThrow(/unusable/);
  } finally {
    f.dispose();
  }
});

it("closes the connection when a failed read cannot be rolled back", () => {
  const f = fixture(),
    db = f.store.db,
    exec = db.exec.bind(db);
  try {
    vi.spyOn(RecordRepository.prototype, "projectionsForDatabase")
      .mockImplementationOnce(() => { throw new Error("injected read failure"); });
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "ROLLBACK") throw new Error("injected ROLLBACK failure");
      return exec(sql);
    });
    let failure: unknown;
    try {
      readDatabaseSnapshot(f.store, f.owner.id);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error: Error) => error.message))
      .toEqual(["injected read failure", "injected ROLLBACK failure"]);
    expect(db.isOpen).toBe(false);
    expect(() => readDatabaseSnapshot(f.store, f.owner.id)).toThrow(/unusable/);
  } finally {
    f.dispose();
  }
});

it("decodes only the target database when 10k unrelated Pages surround it", () => {
  const f = fixture();
  try {
    const noise = commitDatabaseOperation(f.store, prepareDatabaseCreation("Noise", null, f.settings)).page!;
    const insertPage = f.store.db.prepare("INSERT INTO pages(id,data,body) VALUES(?,?,?)");
    const insertMember = f.store.db.prepare(
      "INSERT INTO record_memberships(page_id,database_page_id,position,values_json) VALUES(?,?,?,?)",
    );
    const base = {
      schemaVersion: 1, parentId: null, icon: "📄", cover: "", doc: blankDoc(), kind: "page" as const,
      database: null, favorite: false, createdAt: 1, updatedAt: 1, revision: 0, deletedAt: null,
    };
    const startedSetup = performance.now();
    f.store.transaction(() => {
      // 999 records + 9,000 plain Pages + the second owner = 10,000 unrelated
      // Pages around the 3-Page target database.
      for (let i = 0; i < 999; i++) {
        const id = `noise-record-${i}`;
        insertPage.run(id, JSON.stringify({ ...base, id, title: `Noise record ${i}`, position: i }), `Noise record ${i}`);
        insertMember.run(id, noise.id, i, JSON.stringify({ status: `noise-${i}` }));
      }
      for (let i = 0; i < 9000; i++) {
        const id = `noise-page-${i}`;
        insertPage.run(id, JSON.stringify({ ...base, id, title: `Noise page ${i}`, position: i }), `Noise page ${i}`);
      }
    });
    const setupMs = performance.now() - startedSetup;
    const total = f.store.db.prepare("SELECT count(*) AS n FROM pages").get() as { n: number };
    expect(total.n).toBe(10_003);
    const checksum = f.store.db.prepare("SELECT count(*) AS n, total(length(data)) AS bytes FROM pages").get();
    const decode = vi.spyOn(f.store, "decode");
    const get = vi.spyOn(f.store, "get");
    const pages = vi.spyOn(f.store, "pages");
    const prepare = vi.spyOn(f.store.db, "prepare");
    const started = performance.now();
    const read = readDatabaseSnapshot(f.store, f.owner.id);
    const elapsed = performance.now() - started;
    expect(pages).not.toHaveBeenCalled();
    expect(decode).toHaveBeenCalledTimes(3);
    expect(get.mock.calls.map(([id]) => id)).toEqual([f.owner.id, f.first.pageId, f.second.pageId]);
    const statements = prepare.mock.calls.map(([sql]) => sql);
    expect(statements.filter((sql) => /FROM pages\b/.test(sql)))
      .toEqual(Array(3).fill("SELECT data FROM pages WHERE id=?"));
    expect(statements.filter((sql) => /FROM record_memberships\b/.test(sql)))
      .toEqual(["SELECT page_id,database_page_id,values_json FROM record_memberships WHERE database_page_id=? ORDER BY position,page_id"]);
    expect(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='record_memberships_database'").get())
      .toBeDefined();
    expect(JSON.stringify(f.store.db.prepare(
      "EXPLAIN QUERY PLAN SELECT page_id FROM record_memberships WHERE database_page_id=? ORDER BY position,page_id",
    ).all(f.owner.id))).toContain("record_memberships_database");
    expect(read.database.records).toHaveLength(2);
    expect(f.store.db.prepare("SELECT count(*) AS n, total(length(data)) AS bytes FROM pages").get()).toEqual(checksum);
    // Reference only: the previous implementation ran the whole-workspace
    // load and filtered it afterwards. Not an SLA and not a comparison of
    // user-visible latency.
    vi.restoreAllMocks();
    const loadStarted = performance.now();
    const full = f.store.load();
    const loadMs = performance.now() - loadStarted;
    expect(full.records?.filter((record) => record.databasePageId === f.owner.id)).toHaveLength(2);
    console.log("DATABASE_READ_SCALE " + JSON.stringify({
      unrelatedPages: 10_000, targetRecords: 2, decodedPages: 3,
      pageSelects: statements.filter((sql) => /FROM pages\b/.test(sql)).length,
      setupMs: Math.round(setupMs), readMs: Math.round(elapsed * 100) / 100,
      fullLoadMs: Math.round(loadMs * 100) / 100,
      scope: "synthetic SQLite read only; elapsed is a reference, not an SLA",
    }));
  } finally {
    vi.restoreAllMocks();
    f.dispose();
  }
}, 120000);
