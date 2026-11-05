import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { markRecordStoreVersion } from "../src/persistence/record-version";

const roots: string[] = [];
const stores: Store[] = [];

function tempRoot(): string {
  const root = mkdtempSync(resolve("output/r5-schema-startup-"));
  roots.push(root);
  return root;
}

function open(path: string, options?: ConstructorParameters<typeof Store>[1]) {
  const store = new Store(path, options);
  stores.push(store);
  return store;
}

function dispose(store: Store): void {
  const index = stores.indexOf(store);
  if (index >= 0) stores.splice(index, 1);
  store.close();
}

afterEach(() => {
  for (const store of stores.splice(0))
    try {
      store.close();
    } catch {}
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readVersion(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
  } finally {
    db.close();
  }
}

function readJournalMode(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string })
      .journal_mode;
  } finally {
    db.close();
  }
}

function tableNames(path: string): string[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
  } finally {
    db.close();
  }
}

function pageJson(
  id: string,
  title = "Legacy",
  database: unknown = null,
): string {
  return JSON.stringify({
    id,
    schemaVersion: 1,
    parentId: null,
    title,
    icon: "",
    cover: "",
    position: 0,
    doc: { type: "doc", content: [{ type: "paragraph" }] },
    kind: database === null ? "page" : "database",
    database,
    favorite: false,
    createdAt: 1,
    updatedAt: 1,
    revision: 0,
    deletedAt: null,
  });
}

/** A true v1 database: no versions.database column and no assets table. */
function createV1(path: string, id = "v1-page"): string {
  const source = pageJson(id);
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "PRAGMA journal_mode=DELETE; CREATE TABLE pages(id TEXT PRIMARY KEY,data TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE versions(id INTEGER PRIMARY KEY AUTOINCREMENT,pageId TEXT NOT NULL,createdAt INTEGER NOT NULL,title TEXT NOT NULL,doc TEXT NOT NULL); PRAGMA user_version=1;",
    );
    db.prepare("INSERT INTO pages VALUES(?,?,?)").run(
      id,
      source,
      "Legacy body",
    );
    db.prepare(
      "INSERT INTO versions(pageId,createdAt,title,doc) VALUES(?,?,?,?)",
    ).run(id, 1, "Legacy history", '{"type":"doc","content":[]}');
  } finally {
    db.close();
  }
  return source;
}

const legacyDatabase = {
  properties: [{ id: "status", name: "状態", type: "select", options: ["a"] }],
  rows: [{ id: "row-a", title: "legacy row", values: { status: "a" } }],
  view: "table",
  filter: "",
  sort: "title",
};

/** A true v2 database with one Page whose database still needs v3 migration. */
function createV2(path: string): { id: string; source: string } {
  const store = new Store(path);
  let id: string;
  let source: string;
  try {
    const page = store.create(null, "database", "Legacy database");
    id = page.id;
    source = pageJson(id, "Legacy database", legacyDatabase);
    store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(source, id);
    store.db
      .prepare(
        "INSERT INTO versions(pageId,createdAt,title,doc,database) VALUES(?,?,?,?,?)",
      )
      .run(
        id,
        1,
        "Legacy version",
        '{"type":"doc","content":[]}',
        JSON.stringify(legacyDatabase),
      );
    store.db.exec("PRAGMA user_version=2");
  } finally {
    store.close();
  }
  return { id, source };
}

function preSnapshots(root: string, version: 2 | 3): string[] {
  return readdirSync(root)
    .filter(
      (name) =>
        name === `workspace.sqlite.pre-v${version}.sqlite` ||
        name.startsWith(`workspace.sqlite.pre-v${version}.sqlite.`),
    )
    .sort();
}

function assertVerifiedSnapshot(
  path: string,
  expectedVersion: number,
  expectedPageId?: string,
  expectedPageSource?: string,
): void {
  const snapshot = new DatabaseSync(path, { readOnly: true });
  try {
    expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(
      (
        snapshot.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version,
    ).toBe(expectedVersion);
    if (expectedPageId) {
      const row = snapshot
        .prepare("SELECT data FROM pages WHERE id=?")
        .get(expectedPageId) as { data: string } | undefined;
      expect(row?.data).toBe(expectedPageSource);
    }
  } finally {
    snapshot.close();
  }
}

describe("writable startup preflight", () => {
  it("calls beforeOpen with zero and only then creates a new directory and file", () => {
    const root = tempRoot(),
      directory = join(root, "new-workspace"),
      path = join(directory, "workspace.sqlite"),
      observed: number[] = [];
    const store = open(path, {
      beforeOpen(bytes) {
        observed.push(bytes);
        expect(existsSync(directory)).toBe(false);
      },
    });
    expect(observed).toEqual([0]);
    expect(store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    expect(store.load().pages).toEqual([]);
  });

  it("initializes an existing empty file in an existing empty directory", () => {
    const root = tempRoot(),
      directory = join(root, "existing-empty"),
      path = join(directory, "workspace.sqlite"),
      observed: number[] = [];
    mkdirSync(directory);
    writeFileSync(path, "");
    const store = open(path, {
      beforeOpen(bytes) {
        observed.push(bytes);
      },
    });
    expect(observed).toEqual([0]);
    expect(store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    expect(store.load().pages).toEqual([]);
  });

  it("estimates positive snapshot space for v1 and publishes a fresh pre-v2 image", () => {
    const root = tempRoot(),
      path = join(root, "workspace.sqlite"),
      source = createV1(path),
      observed: number[] = [];
    const store = open(path, {
      beforeOpen(bytes) {
        observed.push(bytes);
        expect(existsSync(path + ".pre-v2.sqlite")).toBe(false);
        expect(existsSync(path + ".pre-v3.sqlite")).toBe(false);
      },
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toBeGreaterThan(statSync(path).size);
    expect(Number.isSafeInteger(observed[0])).toBe(true);
    expect(store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    expect(store.handle({ type: "pageSource", id: "v1-page" })).toBe(source);
    assertVerifiedSnapshot(path + ".pre-v2.sqlite", 1, "v1-page", source);
    expect(existsSync(path + ".pre-v3.sqlite")).toBe(false);
  });

  it("estimates and snapshots a v2 source before rewriting it", () => {
    const root = tempRoot(),
      path = join(root, "workspace.sqlite"),
      fixture = createV2(path),
      observed: number[] = [];
    const store = open(path, {
      beforeOpen(bytes) {
        observed.push(bytes);
      },
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toBeGreaterThan(0);
    expect(observed[0]).toBeGreaterThan(statSync(path).size);
    expect(Number.isSafeInteger(observed[0])).toBe(true);
    expect(store.handle({ type: "pageSource", id: fixture.id })).not.toBe(
      fixture.source,
    );
    assertVerifiedSnapshot(
      path + ".pre-v3.sqlite",
      2,
      fixture.id,
      fixture.source,
    );
  });

  it("denies a new workspace without creating its directory", () => {
    const root = tempRoot(),
      directory = join(root, "denied"),
      path = join(directory, "workspace.sqlite"),
      observed: number[] = [];
    expect(
      () =>
        new Store(path, {
          beforeOpen(bytes) {
            observed.push(bytes);
            throw new Error("space denied");
          },
        }),
    ).toThrow("space denied");
    expect(observed).toEqual([0]);
    expect(existsSync(directory)).toBe(false);
  });

  it("denies an older workspace without touching bytes, version or journal mode", () => {
    const root = tempRoot(),
      path = join(root, "workspace.sqlite");
    createV1(path);
    const before = hash(path),
      version = readVersion(path),
      journal = readJournalMode(path);
    let estimate = -1;
    expect(
      () =>
        new Store(path, {
          beforeOpen(bytes) {
            estimate = bytes;
            throw new Error("space denied");
          },
        }),
    ).toThrow("space denied");
    expect(estimate).toBeGreaterThan(0);
    expect(hash(path)).toBe(before);
    expect(readVersion(path)).toBe(version);
    expect(readJournalMode(path)).toBe(journal);
    expect(existsSync(path + ".pre-v2.sqlite")).toBe(false);
    expect(existsSync(path + ".pre-v3.sqlite")).toBe(false);
  });

  it("refuses a future schema before callback, journal mode or schema changes", () => {
    const root = tempRoot(),
      path = join(root, "workspace.sqlite"),
      setup = new Store(path);
    setup.create(null, "page", "Future");
    setup.close();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA user_version=6");
    db.close();
    const before = hash(path),
      journal = readJournalMode(path);
    let called = false;
    expect(
      () =>
        new Store(path, {
          beforeOpen() {
            called = true;
          },
        }),
    ).toThrow(/requires a newer Folio version/);
    expect(called).toBe(false);
    expect(hash(path)).toBe(before);
    expect(readVersion(path)).toBe(6);
    expect(readJournalMode(path)).toBe(journal);
    expect(preSnapshots(root, 2)).toEqual([]);
    expect(preSnapshots(root, 3)).toEqual([]);
  });

  it("rejects a symlinked source before callback or snapshot creation", () => {
    const root = tempRoot(),
      actual = join(root, "actual.sqlite"),
      path = join(root, "workspace.sqlite");
    const setup = new Store(actual);
    setup.create(null, "page", "Linked");
    setup.close();
    symlinkSync(actual, path);
    const before = hash(actual);
    let called = false;
    expect(
      () =>
        new Store(path, {
          beforeOpen() {
            called = true;
          },
        }),
    ).toThrow(/safe regular file/);
    expect(called).toBe(false);
    expect(hash(actual)).toBe(before);
    expect(preSnapshots(root, 2)).toEqual([]);
    expect(preSnapshots(root, 3)).toEqual([]);
  });

  it("rejects a hardlinked source and unsafe or orphaned sidecars", () => {
    const root = tempRoot(),
      actual = join(root, "actual.sqlite");
    const setup = new Store(actual);
    setup.create(null, "page", "Hardlink");
    setup.close();
    const hardlink = join(root, "hardlink.sqlite");
    linkSync(actual, hardlink);
    expect(() => new Store(actual)).toThrow(/safe regular file/);
    rmSync(hardlink);

    symlinkSync(join(root, "missing-wal-target"), actual + "-wal");
    expect(() => new Store(actual)).toThrow(/sidecar -wal is unsafe/);
    rmSync(actual + "-wal");

    const orphan = join(root, "orphan.sqlite");
    writeFileSync(orphan + "-journal", "orphan");
    expect(() => new Store(orphan)).toThrow(
      /sidecars exist without the database file/,
    );
    expect(existsSync(orphan)).toBe(false);
  });
});

describe("migration snapshot reliability", () => {
  it("keeps a bogus canonical snapshot intact and migrates after a verified fallback", () => {
    const root = tempRoot(),
      path = join(root, "workspace.sqlite"),
      fixture = createV2(path),
      canonical = path + ".pre-v3.sqlite";
    writeFileSync(canonical, "not a sqlite snapshot");
    const canonicalBefore = readFileSync(canonical);
    const store = open(path);
    expect(store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    expect(readFileSync(canonical)).toEqual(canonicalBefore);
    const snapshots = preSnapshots(root, 3);
    expect(snapshots).toContain("workspace.sqlite.pre-v3.sqlite");
    expect(snapshots.length).toBe(2);
    const fallback = snapshots.find(
      (name) => name !== "workspace.sqlite.pre-v3.sqlite",
    )!;
    assertVerifiedSnapshot(join(root, fallback), 2, fixture.id, fixture.source);
    expect(readdirSync(root).some((name) => name.includes(".staging-"))).toBe(
      false,
    );
  });

  it("publishes a verified pre-v2 fallback when that canonical name is occupied", () => {
    const root = tempRoot(),
      path = join(root, "workspace.sqlite"),
      source = createV1(path),
      canonical = path + ".pre-v2.sqlite";
    writeFileSync(canonical, "partial pre-v2 bytes");
    open(path);
    expect(readFileSync(canonical, "utf8")).toBe("partial pre-v2 bytes");
    const snapshots = preSnapshots(root, 2);
    expect(snapshots.length).toBe(2);
    const fallback = snapshots.find(
      (name) => name !== "workspace.sqlite.pre-v2.sqlite",
    )!;
    assertVerifiedSnapshot(join(root, fallback), 1, "v1-page", source);
  });

  it("does not trust an existing valid-looking but stale canonical snapshot", () => {
    const root = tempRoot(),
      path = join(root, "workspace.sqlite"),
      fixture = createV2(path),
      canonical = path + ".pre-v3.sqlite",
      stale = new DatabaseSync(canonical);
    stale.exec(
      "CREATE TABLE pages(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE versions(id INTEGER PRIMARY KEY AUTOINCREMENT,pageId TEXT NOT NULL,createdAt INTEGER NOT NULL,title TEXT NOT NULL,doc TEXT NOT NULL,database TEXT); CREATE TABLE assets(id TEXT PRIMARY KEY,metadata TEXT NOT NULL); CREATE TABLE save_receipts(operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL); PRAGMA user_version=2;",
    );
    stale.close();
    const canonicalBefore = hash(canonical);
    open(path);
    expect(hash(canonical)).toBe(canonicalBefore);
    const snapshots = preSnapshots(root, 3);
    expect(snapshots.length).toBe(2);
    const fallback = snapshots.find(
      (name) => name !== "workspace.sqlite.pre-v3.sqlite",
    )!;
    assertVerifiedSnapshot(join(root, fallback), 2, fixture.id, fixture.source);
  });

  it("keeps a suspect snapshot and v2 data after a failed migration, then retries safely", () => {
    const root = tempRoot(),
      path = join(root, "workspace.sqlite"),
      fixture = createV2(path),
      canonical = path + ".pre-v3.sqlite",
      suspect = "partial canonical must survive";
    writeFileSync(canonical, suspect);
    const raw = new DatabaseSync(path);
    raw.exec(
      "CREATE TRIGGER fail_schema_migration BEFORE UPDATE ON pages BEGIN SELECT RAISE(ABORT,'injected schema failure'); END",
    );
    raw.close();

    expect(() => new Store(path)).toThrow(/injected schema failure/);
    expect(readFileSync(canonical, "utf8")).toBe(suspect);
    expect(readVersion(path)).toBe(2);
    expect(
      (
        new DatabaseSync(path, { readOnly: true })
          .prepare("SELECT data FROM pages WHERE id=?")
          .get(fixture.id) as { data: string }
      ).data,
    ).toBe(fixture.source);
    const firstFallbacks = preSnapshots(root, 3).filter(
      (name) => name !== "workspace.sqlite.pre-v3.sqlite",
    );
    expect(firstFallbacks).toHaveLength(1);
    assertVerifiedSnapshot(
      join(root, firstFallbacks[0]),
      2,
      fixture.id,
      fixture.source,
    );

    const retry = new DatabaseSync(path);
    retry.exec("DROP TRIGGER fail_schema_migration");
    retry.close();
    const store = open(path);
    expect(store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    expect(readFileSync(canonical, "utf8")).toBe(suspect);
    const allFallbacks = preSnapshots(root, 3).filter(
      (name) => name !== "workspace.sqlite.pre-v3.sqlite",
    );
    expect(allFallbacks).toHaveLength(2);
    assertVerifiedSnapshot(
      join(root, firstFallbacks[0]),
      2,
      fixture.id,
      fixture.source,
    );
    assertVerifiedSnapshot(
      join(
        root,
        allFallbacks.find((name) => name !== firstFallbacks[0])!,
      ),
      2,
      fixture.id,
      fixture.source,
    );
  });
});

describe("read-only startup", () => {
  it("loads, searches and reads page sources with query_only and no schema changes", () => {
    const root = tempRoot(),
      path = join(root, "workspace.sqlite"),
      setup = open(path);
    const page = setup.create(null, "page", "Read only page");
    setup.update(page.id, 0, {
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "searchable readonly term" }],
          },
        ],
      },
    });
    setup.handle({ type: "setting", key: "activePage", value: page.id });
    const source = setup.handle({ type: "pageSource", id: page.id }) as string;
    dispose(setup);

    const before = hash(path),
      journal = readJournalMode(path),
      tables = tableNames(path),
      callback: number[] = [];
    const store = open(path, {
      readOnly: true,
      beforeOpen(bytes) {
        callback.push(bytes);
      },
    });
    expect(callback).toEqual([]);
    expect(store.db.prepare("PRAGMA query_only").get()?.query_only).toBe(1);
    expect(readJournalMode(path)).toBe(journal);
    expect(tableNames(path)).toEqual(tables);
    const snapshot = store.load();
    expect(snapshot.pages.map((entry) => entry.id)).toEqual([page.id]);
    expect(snapshot.settings.activePage).toBe(page.id);
    expect(
      (
        store.handle({ type: "search", query: "searchable readonly" }) as {
          id: string;
        }[]
      ).map((entry) => entry.id),
    ).toEqual([page.id]);
    expect(store.handle({ type: "pageSource", id: page.id })).toBe(source);
    expect(() =>
      store.db.exec("INSERT INTO settings(key,value) VALUES('x','y')"),
    ).toThrow(/readonly|read-only/i);
    expect(() => store.create(null, "page", "Denied")).toThrow();
    expect(hash(path)).toBe(before);
    dispose(store);
    expect(hash(path)).toBe(before);
    const writable = open(path);
    expect(writable.load().pages).toHaveLength(1);
  });

  it("does not initialize a legacy v3 database and leaves journal mode alone", () => {
    const root = tempRoot(),
      path = join(root, "workspace.sqlite"),
      id = "manual-v3";
    const db = new DatabaseSync(path);
    db.exec(
      "PRAGMA journal_mode=DELETE; CREATE TABLE pages(id TEXT PRIMARY KEY,data TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE versions(id INTEGER PRIMARY KEY AUTOINCREMENT,pageId TEXT NOT NULL,createdAt INTEGER NOT NULL,title TEXT NOT NULL,doc TEXT NOT NULL,database TEXT); PRAGMA user_version=3;",
    );
    db.prepare("INSERT INTO pages VALUES(?,?,?)").run(
      id,
      pageJson(id, "Manual v3"),
      "Manual v3",
    );
    db.close();
    const tables = tableNames(path);
    expect(tables).not.toContain("save_receipts");
    expect(tables).not.toContain("assets");
    const store = open(path, { readOnly: true });
    expect(tableNames(path)).toEqual(tables);
    expect(readJournalMode(path)).toBe("delete");
    expect(store.load().pages.map((entry) => entry.title)).toEqual([
      "Manual v3",
    ]);
    expect(
      (
        store.handle({ type: "search", query: "Manual" }) as { id: string }[]
      ).map((entry) => entry.id),
    ).toEqual([id]);
    dispose(store);
    expect(tableNames(path)).toEqual(tables);
    expect(readJournalMode(path)).toBe("delete");
  });

  it("refuses old and future schemas without creating snapshots or directories", () => {
    const root = tempRoot(),
      v2Path = join(root, "v2.sqlite");
    createV2(v2Path);
    const before = hash(v2Path),
      journal = readJournalMode(v2Path);
    expect(() => new Store(v2Path, { readOnly: true })).toThrow(/too old/);
    expect(hash(v2Path)).toBe(before);
    expect(readVersion(v2Path)).toBe(2);
    expect(readJournalMode(v2Path)).toBe(journal);
    expect(preSnapshots(root, 3)).toEqual([]);

    const future = new DatabaseSync(v2Path);
    future.exec("PRAGMA user_version=6");
    future.close();
    const futureBefore = hash(v2Path);
    expect(() => new Store(v2Path, { readOnly: true })).toThrow(
      /requires a newer Folio version/,
    );
    expect(hash(v2Path)).toBe(futureBefore);
    expect(readVersion(v2Path)).toBe(6);

    const absent = join(root, "absent", "workspace.sqlite");
    expect(() => new Store(absent, { readOnly: true })).toThrow();
    expect(existsSync(join(root, "absent"))).toBe(false);
  });

  it("opens a v4 record store and still requires its complete marker schema", () => {
    const root = tempRoot(),
      path = join(root, "workspace.sqlite"),
      setup = open(path);
    const page = setup.create(null, "page", "v4 page");
    setup.transaction(() => {
      new RecordRepository(setup).createSchema();
      markRecordStoreVersion(setup.db);
    });
    const source = setup.handle({ type: "pageSource", id: page.id }) as string;
    dispose(setup);
    expect(readVersion(path)).toBe(4);

    const store = open(path, { readOnly: true });
    expect(store.load().pages.map((entry) => entry.id)).toEqual([page.id]);
    expect(store.load().records).toEqual([]);
    expect(store.handle({ type: "pageSource", id: page.id })).toBe(source);
    expect(
      (
        store.handle({ type: "search", query: "v4 page" }) as { id: string }[]
      ).map((entry) => entry.id),
    ).toEqual([page.id]);
    dispose(store);

    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE folio_record_schema");
    raw.close();
    expect(() => new Store(path, { readOnly: true })).toThrow(
      /unsupported record store/,
    );
    expect(readVersion(path)).toBe(4);
  });

  it("sees committed WAL data while a writer remains open", () => {
    const root = tempRoot(),
      path = join(root, "workspace.sqlite"),
      writer = open(path),
      page = writer.create(null, "page", "WAL visible");
    writer.update(page.id, 0, {
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "wal-only searchable" }],
          },
        ],
      },
    });
    expect(existsSync(path + "-wal")).toBe(true);
    const reader = open(path, { readOnly: true });
    expect(reader.load().pages.map((entry) => entry.id)).toEqual([page.id]);
    expect(
      (
        reader.handle({ type: "search", query: "wal-only" }) as { id: string }[]
      ).map((entry) => entry.id),
    ).toEqual([page.id]);
    dispose(reader);
    writer.handle({ type: "setting", key: "theme", value: "dark" });
    expect(writer.load().settings.theme).toBe("dark");
  });
});
