import type { DatabaseData } from "../src/shared/types";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { convertLegacyRecordsInTransaction } from "../src/persistence/record-migration";

function fixture() {
  const root = mkdtempSync(resolve("output/record-migration-"));
  const path = join(root, "workspace.sqlite"),
    store = new Store(path);
  const collision = store.create(null, "page", "existing");
  const a = store.create(null, "database", "A");
  const initial: DatabaseData = {
    ...a.database!,
    rows: [
      { id: collision.id, title: "A row", values: { status: "a" } },
      { id: "history-only", title: "old", values: {} },
    ],
  };
  const withRows = store.update(a.id, a.revision, { database: initial });
  store.update(a.id, withRows.revision, {
    database: { ...initial, rows: initial.rows.slice(0, 1) },
  });
  const b = store.duplicate(a.id);
  store.trash(b.id);
  return { root, path, store, collision, a, b };
}

it("converts scoped IDs, duplicate and trashed databases, archives bytes, and is idempotent", () => {
  const f = fixture();
  let reopened: Store | undefined;
  try {
    const raw = (
      f.store.db.prepare("SELECT data FROM pages WHERE id=?").get(f.a.id) as {
        data: string;
      }
    ).data;
    expect(
      f.store.transaction(() => convertLegacyRecordsInTransaction(f.store)),
    ).toEqual({ databases: 2, records: 2 });
    const maps = f.store.db
      .prepare(
        "SELECT database_page_id,legacy_row_id,page_id FROM legacy_record_map ORDER BY database_page_id,legacy_row_id",
      )
      .all() as {
      database_page_id: string;
      legacy_row_id: string;
      page_id: string;
    }[];
    const current = maps.filter((x) => x.legacy_row_id === f.collision.id);
    expect(current).toHaveLength(2);
    expect(new Set(current.map((x) => x.page_id)).size).toBe(2);
    expect(current.some((x) => x.page_id === f.collision.id)).toBe(false);
    expect(
      maps.some(
        (x) =>
          x.database_page_id === f.a.id && x.legacy_row_id === "history-only",
      ),
    ).toBe(true);
    expect(f.store.get(f.collision.id).title).toBe("existing");
    expect(
      f.store.db
        .prepare(
          "SELECT data FROM legacy_database_archive WHERE database_page_id=?",
        )
        .get(f.a.id)?.data,
    ).toBe(raw);
    expect(f.store.get(f.a.id).database?.rows).toEqual([]);
    const repo = new RecordRepository(f.store);
    expect(
      repo.projection(
        current.find((x) => x.database_page_id === f.a.id)!.page_id,
      ),
    ).toMatchObject({ title: "A row", values: { status: "a" } });
    expect(
      repo.projection(
        current.find((x) => x.database_page_id === f.b.id)!.page_id,
      ).deletedAt,
    ).not.toBeNull();
    expect(() =>
      f.store.update(f.a.id, f.store.get(f.a.id).revision, {
        database: JSON.parse(raw).database,
      }),
    ).toThrow("旧形式");
    expect(
      f.store.transaction(() => convertLegacyRecordsInTransaction(f.store)),
    ).toEqual({ databases: 0, records: 0 });
    f.store.close();
    reopened = new Store(f.path);
    expect(
      reopened.transaction(() => convertLegacyRecordsInTransaction(reopened!)),
    ).toEqual({ databases: 0, records: 0 });
    expect(
      reopened.db.prepare("SELECT COUNT(*) AS n FROM legacy_record_map").get()
        ?.n,
    ).toBe(maps.length);
  } finally {
    if (reopened) reopened.close();
    else f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("rolls back conversion, archive, mappings, membership and version on interruption", () => {
  const f = fixture();
  try {
    const before = f.store.db
      .prepare("SELECT id,data FROM pages ORDER BY id")
      .all();
    expect(() =>
      f.store.transaction(() => {
        convertLegacyRecordsInTransaction(f.store, () => {
          f.store.db.exec("PRAGMA user_version=4");
          throw Error("interrupted");
        });
      }),
    ).toThrow("interrupted");
    expect(f.store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
      3,
    );
    expect(
      f.store.db.prepare("SELECT id,data FROM pages ORDER BY id").all(),
    ).toEqual(before);
    expect(
      f.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('legacy_record_map','record_memberships','legacy_database_archive')",
        )
        .get()?.n,
    ).toBe(0);
    expect(
      f.store.transaction(() => convertLegacyRecordsInTransaction(f.store))
        .records,
    ).toBe(2);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("stops on unknown history and keeps its original bytes and version", () => {
  const f = fixture();
  try {
    const raw = JSON.stringify({ schemaVersion: 99, rows: [] }, null, 2);
    f.store.db
      .prepare(
        "INSERT INTO versions(pageId,createdAt,title,doc,database) VALUES(?,?,?,?,?)",
      )
      .run(
        f.a.id,
        1,
        "future",
        JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] }),
        raw,
      );
    expect(() =>
      f.store.transaction(() => convertLegacyRecordsInTransaction(f.store)),
    ).toThrow("preflight");
    expect(
      f.store.db
        .prepare("SELECT database FROM versions WHERE title='future'")
        .get()?.database,
    ).toBe(raw);
    expect(f.store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
      3,
    );
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("restores known legacy database history, including history-only rows, without replacing later bodies or new records", () => {
  const f = fixture();
  try {
    const legacyVersion = f.store.versions(f.a.id)[0].id;
    f.store.transaction(() => convertLegacyRecordsInTransaction(f.store));
    const mapping = f.store.db
      .prepare(
        "SELECT legacy_row_id,page_id FROM legacy_record_map WHERE database_page_id=?",
      )
      .all(f.a.id) as { legacy_row_id: string; page_id: string }[];
    const currentId = mapping.find(
      (x) => x.legacy_row_id === f.collision.id,
    )!.page_id;
    const historicalId = mapping.find(
      (x) => x.legacy_row_id === "history-only",
    )!.page_id;
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "body after migration" }],
        },
      ],
    };
    const updated = f.store.updateRecordPage(currentId, f.a.id, 0, { doc });
    const repo = new RecordRepository(f.store);
    repo.patch(currentId, f.a.id, updated.revision, {
      title: "changed",
      values: { status: "changed" },
    });
    const newer = f.store.create(null, "page", "newer record");
    f.store.transaction(() =>
      repo.attachForMigration(newer.id, f.a.id, 99, { status: "new" }),
    );
    f.store.handle({
      type: "restoreVersion",
      id: f.a.id,
      versionId: legacyVersion,
      revision: f.store.get(f.a.id).revision,
    });
    expect(f.store.get(currentId).doc).toEqual(doc);
    expect(repo.projection(currentId)).toMatchObject({
      title: "A row",
      values: { status: "a" },
    });
    expect(repo.projection(historicalId)).toMatchObject({
      title: "old",
      databasePageId: f.a.id,
    });
    expect(repo.projection(newer.id)).toMatchObject({
      title: "newer record",
      values: { status: "new" },
      deletedAt: null,
    });
    expect(f.store.get(f.a.id).database?.rows).toEqual([]);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("stops legacy database history restoration on unknown data and retains current records", () => {
  const f = fixture();
  try {
    const version = f.store.versions(f.a.id)[0].id;
    f.store.transaction(() => convertLegacyRecordsInTransaction(f.store));
    const before = f.store.db
      .prepare("SELECT id,data FROM pages ORDER BY id")
      .all();
    const unknown = '{ "schemaVersion": 123, "opaque": "retain" }';
    f.store.db
      .prepare("UPDATE versions SET database=? WHERE id=?")
      .run(unknown, version);
    expect(() =>
      f.store.handle({
        type: "restoreVersion",
        id: f.a.id,
        versionId: version,
        revision: f.store.get(f.a.id).revision,
      }),
    ).toThrow();
    expect(
      f.store.db
        .prepare("SELECT database FROM versions WHERE id=?")
        .get(version)?.database,
    ).toBe(unknown);
    expect(
      f.store.db.prepare("SELECT id,data FROM pages ORDER BY id").all(),
    ).toEqual(before);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("does not allocate a new page over an existing page or a reserved historical ID", () => {
  const f = fixture();
  try {
    f.store.transaction(() => convertLegacyRecordsInTransaction(f.store));
    const reserved = (
      f.store.db
        .prepare(
          "SELECT page_id FROM legacy_record_map WHERE database_page_id=? AND legacy_row_id='history-only'",
        )
        .get(f.a.id) as { page_id: string }
    ).page_id;
    const ids = [f.collision.id, reserved, "unique-page"];
    expect(f.store.allocatePageId(() => ids.shift()!)).toBe("unique-page");
    const existing = f.store.get(f.collision.id);
    expect(() =>
      f.store.write({ ...existing, title: "must not overwrite" }, true),
    ).toThrow();
    expect(f.store.get(f.collision.id).title).toBe("existing");
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("blocks hierarchy-only lifecycle operations on migrated databases and records", () => {
  const f = fixture();
  try {
    f.store.transaction(() => convertLegacyRecordsInTransaction(f.store));
    const id = (
      f.store.db
        .prepare(
          "SELECT page_id FROM record_memberships WHERE database_page_id=?",
        )
        .get(f.a.id) as { page_id: string }
    ).page_id;
    const before = f.store.db
      .prepare("SELECT id,data FROM pages ORDER BY id")
      .all();
    expect(() => f.store.trash(f.a.id)).toThrow("未実装");
    expect(() => f.store.trash(id)).toThrow("未実装");
    expect(() => f.store.restore(f.b.id)).toThrow("未実装");
    expect(() => f.store.duplicate(f.a.id)).toThrow("未実装");
    expect(() => f.store.duplicate(id)).toThrow("未実装");
    expect(() => f.store.move(id, null, null)).toThrow("未対応");
    expect(
      f.store.db.prepare("SELECT id,data FROM pages ORDER BY id").all(),
    ).toEqual(before);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("restores a post-migration database settings version without treating empty projected rows as deletions", () => {
  const f = fixture();
  try {
    f.store.transaction(() => convertLegacyRecordsInTransaction(f.store));
    const recordId = (
      f.store.db
        .prepare(
          "SELECT page_id FROM record_memberships WHERE database_page_id=?",
        )
        .get(f.a.id) as { page_id: string }
    ).page_id;
    const owner = f.store.get(f.a.id);
    f.store.update(owner.id, owner.revision, { title: "after migration" });
    const versionId = f.store.versions(f.a.id)[0].id;
    expect(
      f.store.db
        .prepare("SELECT 1 FROM legacy_database_versions WHERE version_id=?")
        .get(versionId),
    ).toBeUndefined();
    const current = f.store.get(f.a.id);
    f.store.update(current.id, current.revision, { title: "later" });
    f.store.handle({
      type: "restoreVersion",
      id: f.a.id,
      versionId,
      revision: f.store.get(f.a.id).revision,
    });
    expect(f.store.get(f.a.id).title).toBe(owner.title);
    expect(
      new RecordRepository(f.store).projection(recordId).deletedAt,
    ).toBeNull();
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("registers migrated trashed records so the owning database can restore them as one batch", async () => {
  const { RecordLifecycle } =
    await import("../src/persistence/record-lifecycle");
  const f = fixture();
  try {
    f.store.transaction(() => convertLegacyRecordsInTransaction(f.store));
    const id = (
      f.store.db
        .prepare(
          "SELECT page_id FROM record_memberships WHERE database_page_id=?",
        )
        .get(f.b.id) as { page_id: string }
    ).page_id;
    const deleted = f.store.get(f.b.id);
    expect(f.store.get(id).deletedAt).toBe(deleted.deletedAt);
    new RecordLifecycle(f.store).restoreDatabase(f.b.id, deleted.revision);
    expect(f.store.get(f.b.id).deletedAt).toBeNull();
    expect(f.store.get(id).deletedAt).toBeNull();
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("rejects stale DB history and preserves a child when a legacy restore would remove its record", () => {
  const f = fixture();
  try {
    const emptyVersion = f.store.versions(f.a.id).at(-1)!.id;
    f.store.transaction(() => convertLegacyRecordsInTransaction(f.store));
    const id = (
      f.store.db
        .prepare(
          "SELECT page_id FROM record_memberships WHERE database_page_id=?",
        )
        .get(f.a.id) as { page_id: string }
    ).page_id;
    // Simulate a pre-existing child from an older workspace; the current
    // public create path deliberately refuses new children under records.
    const child = f.store.create(null, "page", "child");
    f.store.write({ ...child, parentId: id });
    const db = f.store.get(f.a.id);
    f.store.update(db.id, db.revision, { title: "new" });
    const current = f.store.get(db.id);
    expect(() =>
      f.store.handle({
        type: "restoreVersion",
        id: db.id,
        versionId: emptyVersion,
        revision: db.revision,
      }),
    ).toThrow("競合");
    expect(() =>
      f.store.handle({
        type: "restoreVersion",
        id: db.id,
        versionId: emptyVersion,
        revision: current.revision,
      }),
    ).toThrow("子ページ");
    expect(f.store.get(id).deletedAt).toBeNull();
    expect(f.store.get(child.id).parentId).toBe(id);
    expect(f.store.get(db.id).title).toBe("new");
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
