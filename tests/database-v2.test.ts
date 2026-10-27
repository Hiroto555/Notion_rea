import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import {
  activeView,
  addView,
  addFilterCondition,
  addFilterGroup,
  defaultDatabaseView,
  deleteView,
  duplicateView,
  groupRows,
  moveView,
  normalizeDatabaseData,
  queryRows,
  removeFilterNode,
  renameView,
  setActiveView,
  updateView,
} from "../src/database/model";
import { Store } from "../src/persistence/store";
import {
  DATABASE_SCHEMA_VERSION,
  emptyDatabase,
  requestSchema,
  type DatabaseData,
  type FilterGroup,
  type Property,
  type RecordRow,
} from "../src/shared/types";

const roots: string[] = [],
  stores: Store[] = [];
function make() {
  const root = mkdtempSync(resolve("output/database-v2-"));
  roots.push(root);
  const s = new Store(join(root, "workspace.sqlite"));
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0))
    try {
      s.close();
    } catch {}
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

const properties: Property[] = [
  {
    id: "status",
    name: "ステータス",
    type: "select",
    options: ["未着手", "進行中", "完了"],
  },
  { id: "cost", name: "費用", type: "number" },
  { id: "due", name: "期日", type: "date" },
  { id: "done", name: "完了", type: "checkbox" },
];
const rows: RecordRow[] = [
  {
    id: "a",
    title: "Alpha 10",
    values: { status: "進行中", cost: 20, due: "2026-10-28", done: false },
  },
  {
    id: "b",
    title: "Beta 2",
    values: { status: "完了", cost: 50, due: "2026-11-02", done: true },
  },
  {
    id: "c",
    title: "Gamma",
    values: { status: "完了", cost: 5, due: "2026-10-01", done: true },
  },
  {
    id: "d",
    title: "Delta",
    values: { status: "進行中", cost: 5, done: false },
  },
];
function database(): DatabaseData {
  return { ...emptyDatabase(), properties, rows };
}
function group(
  conjunction: "and" | "or",
  conditions: FilterGroup["conditions"],
  id = "filter-root",
): FilterGroup {
  return { kind: "group", id, conjunction, conditions };
}
function ids(result: RecordRow[]) {
  return result.map((row) => row.id);
}

describe("filter evaluation", () => {
  it("evaluates nested AND/OR groups with typed operators", () => {
    let data = database();
    const view = activeView(data);
    const nested = group(
      "and",
      [
        {
          kind: "condition",
          id: "c2",
          propertyId: "cost",
          operator: "greater_than",
          value: 10,
        },
        {
          kind: "condition",
          id: "c3",
          propertyId: "done",
          operator: "is_checked",
        },
      ],
      "nested",
    );
    const filter = group("or", [
      {
        kind: "condition",
        id: "c1",
        propertyId: "status",
        operator: "equals",
        value: "進行中",
      },
      nested,
    ]);
    data = updateView(data, view.id, { filter });
    expect(ids(queryRows(data))).toEqual(["a", "b", "d"]);
    expect(
      ids(
        queryRows(
          updateView(data, view.id, {
            filter: group("and", [
              {
                kind: "condition",
                id: "c4",
                propertyId: "title",
                operator: "contains",
                value: "beta",
              },
              nested,
            ]),
          }),
        ),
      ),
    ).toEqual(["b"]);
  });
  it("supports text, empty, numeric, date, checkbox and title conditions", () => {
    let data = database();
    const view = activeView(data);
    const check = (filter: FilterGroup) =>
      ids(queryRows(updateView(data, view.id, { filter })));
    expect(
      check(
        group("and", [
          {
            kind: "condition",
            id: "x",
            propertyId: "title",
            operator: "contains",
            value: "alpha",
          },
        ]),
      ),
    ).toEqual(["a"]);
    expect(
      check(
        group("and", [
          {
            kind: "condition",
            id: "x",
            propertyId: "due",
            operator: "is_empty",
          },
        ]),
      ),
    ).toEqual(["d"]);
    expect(
      check(
        group("and", [
          {
            kind: "condition",
            id: "x",
            propertyId: "due",
            operator: "before",
            value: "2026-10-28",
          },
        ]),
      ),
    ).toEqual(["c"]);
    expect(
      check(
        group("and", [
          {
            kind: "condition",
            id: "x",
            propertyId: "cost",
            operator: "less_than_or_equal",
            value: 5,
          },
          {
            kind: "condition",
            id: "y",
            propertyId: "done",
            operator: "is_not_checked",
          },
        ]),
      ),
    ).toEqual(["d"]);
    expect(
      check(
        group("and", [
          {
            kind: "condition",
            id: "x",
            propertyId: "status",
            operator: "not_equals",
            value: "完了",
          },
        ]),
      ),
    ).toEqual(["a", "d"]);
  });
  it("treats an empty group as matching everything and keeps text search", () => {
    let data = database();
    const view = activeView(data);
    data = updateView(data, view.id, {
      filter: group("and", []),
      filterText: "進行中",
    });
    expect(ids(queryRows(data))).toEqual(["a", "d"]);
    data = updateView(data, view.id, { filterText: "" });
    expect(ids(queryRows(data))).toEqual(["a", "b", "c", "d"]);
  });
  it("evaluates edits, removals and nested groups in existing trees", () => {
    let tree = group("and", [
      {
        kind: "condition",
        id: "keep",
        propertyId: "title",
        operator: "contains",
        value: "a",
      },
    ]);
    tree = addFilterGroup(tree, tree.id, "or");
    const nested = tree.conditions[1];
    expect(nested.kind).toBe("group");
    tree = addFilterCondition(tree, (nested as FilterGroup).id, {
      kind: "condition",
      id: "nested-condition",
      propertyId: "status",
      operator: "equals",
      value: "完了",
    });
    expect(JSON.stringify(tree)).toContain("nested-condition");
    tree = removeFilterNode(tree, "nested-condition");
    expect(JSON.stringify(tree)).not.toContain("nested-condition");
  });
});

describe("sorting and grouping", () => {
  it("sorts by multiple stable keys and puts empty values last", () => {
    let data = database();
    const view = activeView(data);
    data = {
      ...data,
      rows: [
        ...data.rows,
        { id: "e", title: "No cost", values: { status: "未着手" } },
      ],
    };
    data = updateView(data, view.id, {
      sorts: [
        { id: "s1", propertyId: "cost", direction: "asc" },
        { id: "s2", propertyId: "title", direction: "desc" },
      ],
    });
    const result = queryRows(data);
    expect(ids(result)).toEqual(["c", "d", "a", "b", "e"]);
    expect(result.at(-1)?.title).toBe("No cost");
    data = updateView(data, view.id, {
      sorts: [
        { id: "s1", propertyId: "cost", direction: "desc" },
        { id: "s2", propertyId: "title", direction: "asc" },
      ],
    });
    expect(ids(queryRows(data))).toEqual(["b", "a", "d", "c", "e"]);
  });
  it("groups select values in option order and keeps unset last", () => {
    const data = database();
    const view = activeView(data);
    const boardView = {
      ...view,
      groupBy: { propertyId: "status", direction: "asc" as const },
    };
    const all = groupRows(data, boardView, queryRows(data), {
      includeEmpty: true,
    });
    expect(all.map((entry) => entry.label)).toEqual([
      "未着手",
      "進行中",
      "完了",
      "未設定",
    ]);
    expect(all.map((entry) => entry.rows.length)).toEqual([0, 2, 2, 0]);
    const present = groupRows(data, boardView, queryRows(data));
    expect(present.map((entry) => entry.label)).toEqual(["進行中", "完了"]);
    const descending = groupRows(
      data,
      {
        ...boardView,
        groupBy: { propertyId: "status", direction: "desc" },
      },
      queryRows(data),
      { includeEmpty: true },
    );
    expect(descending.map((entry) => entry.label)).toEqual([
      "完了",
      "進行中",
      "未着手",
      "未設定",
    ]);
  });
  it("groups checkbox, text and no grouping without mutating rows", () => {
    const data = database();
    const view = activeView(data);
    const checkbox = groupRows(
      data,
      { ...view, groupBy: { propertyId: "done", direction: "asc" } },
      queryRows(data),
      { includeEmpty: true },
    );
    expect(checkbox.map((entry) => [entry.label, entry.rows.length])).toEqual([
      ["未チェック", 2],
      ["チェック済み", 2],
      ["未設定", 0],
    ]);
    const title = groupRows(
      data,
      { ...view, groupBy: { propertyId: "title", direction: "desc" } },
      queryRows(data),
    );
    expect(title.map((entry) => entry.value)).toEqual([
      "Gamma",
      "Delta",
      "Beta 2",
      "Alpha 10",
    ]);
    const none = groupRows(data, view, queryRows(data));
    expect(none).toHaveLength(1);
    expect(none[0].rows).toHaveLength(4);
    expect(ids(data.rows)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("view management and independence", () => {
  it("creates, renames, reorders, duplicates and deletes independent views", () => {
    let data = database();
    const table = activeView(data);
    const tableSnapshot = structuredClone(data.views);
    data = addView(data, "board");
    let board = activeView(data);
    expect(data.views).toHaveLength(2);
    expect(board.type).toBe("board");
    data = updateView(data, board.id, {
      filterText: "進行中",
      sorts: [{ id: "bs", propertyId: "cost", direction: "desc" }],
      groupBy: { propertyId: "status", direction: "asc" },
    });
    expect(data.views[0]).toEqual(tableSnapshot[0]);
    const tableAgain = setActiveView(data, table.id);
    expect(tableAgain.views.find((view) => view.id === board.id)).not.toEqual(
      data.views[0],
    );
    expect(tableAgain.activeViewId).toBe(table.id);
    expect(tableAgain.view).toBe("table");
    data = setActiveView(data, board.id);
    data = renameView(data, board.id, "かんばん");
    expect(activeView(data).name).toBe("かんばん");
    data = duplicateView(data, board.id);
    const copy = activeView(data);
    expect(copy.id).not.toBe(board.id);
    expect(copy.filter).not.toBe(activeView({ ...data, activeViewId: board.id }).filter);
    expect(copy.sorts[0].id).not.toBe(
      activeView({ ...data, activeViewId: board.id }).sorts[0].id,
    );
    const beforeCopyEdit = data.views.find((view) => view.id === board.id)!;
    data = updateView(data, copy.id, { filterText: "完了" });
    expect(data.views.find((view) => view.id === board.id)).toEqual(
      beforeCopyEdit,
    );
    data = moveView(data, copy.id, -1);
    expect(data.views[1].id).toBe(copy.id);
    data = deleteView(data, copy.id);
    expect(data.views).toHaveLength(2);
    expect(() => deleteView(data, board.id)).not.toThrow();
    expect(() => deleteView({ ...data, views: [data.views[0]] }, data.views[0].id)).toThrow(
      /最後/,
    );
  });
  it("keeps legacy projections synchronized with only the active view", () => {
    let data = database();
    const table = activeView(data);
    data = updateView(data, table.id, {
      filterText: "Alpha",
      sorts: [{ id: "s", propertyId: "cost", direction: "desc" }],
      type: "gallery",
    });
    expect([data.view, data.filter, data.sort]).toEqual([
      "gallery",
      "Alpha",
      "-cost",
    ]);
    data = addView(data, "table", { copyActive: true });
    const added = activeView(data);
    expect(data.views).toHaveLength(2);
    expect(added.id).not.toBe(table.id);
    expect(added.filter).not.toBe(data.views[0].filter);
    expect([data.view, data.filter, data.sort]).toEqual([
      "table",
      "Alpha",
      "-cost",
    ]);
  });
  it("uses the active view filter even when legacy top-level values differ", () => {
    let data = database();
    const view = activeView(data);
    data = updateView(data, view.id, {
      filterText: "Alpha",
      filter: group("and", [
        {
          kind: "condition",
          id: "only-a",
          propertyId: "title",
          operator: "contains",
          value: "alpha",
        },
      ]),
    });
    data = { ...data, filter: "Gamma" };
    expect(ids(queryRows(data))).toEqual(["a"]);
  });
});

describe("normalization and schema", () => {
  it("normalizes legacy single-view data without changing rows, IDs or order", () => {
    const legacy = {
      properties,
      rows,
      view: "board",
      filter: "進行中",
      sort: "-cost",
    };
    const result = normalizeDatabaseData(legacy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migrated).toBe(true);
    expect(result.data.schemaVersion).toBe(DATABASE_SCHEMA_VERSION);
    expect(result.data.activeViewId).toBe("view-default");
    expect(result.data.views[0]).toMatchObject({
      type: "board",
      filterText: "進行中",
      sorts: [{ propertyId: "cost", direction: "desc" }],
    });
    expect(result.data.rows).toEqual(rows);
    expect(result.data.rows.map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
    expect(result.data.properties).toEqual(properties);
    const again = normalizeDatabaseData(result.data);
    expect(again.ok && again.migrated).toBe(false);
  });
  it("rejects unknown versions, malformed structures and duplicate IDs", () => {
    expect(normalizeDatabaseData({ ...database(), schemaVersion: 99 }).ok).toBe(
      false,
    );
    expect(normalizeDatabaseData({ ...database(), rows: "nope" }).ok).toBe(
      false,
    );
    expect(
      normalizeDatabaseData({
        ...database(),
        rows: [...rows, { id: "a", title: "dup", values: {} }],
      }).ok,
    ).toBe(false);
    const duplicateViews = {
      ...database(),
      views: [
        { ...defaultDatabaseView(), id: "same" },
        { ...defaultDatabaseView(), id: "same" },
      ],
      activeViewId: "missing",
    } as DatabaseData;
    expect(normalizeDatabaseData(duplicateViews).ok).toBe(false);
    expect(
      requestSchema.safeParse({
        type: "update",
        id: "x",
        revision: 0,
        patch: { database: { ...database(), schemaVersion: 3 } },
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        type: "update",
        id: "x",
        revision: 0,
        patch: {
          database: {
            ...database(),
            views: [
              {
                ...activeView(database()),
                filter: group("and", [
                  {
                    kind: "condition",
                    id: "bad",
                    propertyId: "title",
                    operator: "wat",
                  } as unknown as FilterGroup["conditions"][number],
                ]),
              },
            ],
          },
        },
      }).success,
    ).toBe(false);
  });
  it("accepts legacy data through request schema and emits normalized v2", () => {
    const parsed = requestSchema.parse({
      type: "update",
      id: "x",
      revision: 1,
      patch: {
        database: {
          properties,
          rows,
          view: "board",
          filter: "進行中",
          sort: "-cost",
        },
      },
    });
    expect(parsed.type).toBe("update");
    if (parsed.type !== "update") return;
    expect(parsed.patch.database).toMatchObject({
      schemaVersion: 2,
      view: "board",
      filter: "進行中",
      sort: "-cost",
    });
  });
});

describe("SQLite persistence and migration", () => {
  function rawPage(s: Store, id: string, databaseValue: unknown) {
    const p = s.get(id);
    const page = { ...p, database: databaseValue };
    const json = JSON.stringify(page);
    s.db
      .prepare("UPDATE pages SET data=? WHERE id=?")
      .run(json, id);
    return json;
  }
  it("persists multiple views, filters, sorts and active view across reopen", () => {
    const s = make(),
      p = s.create(null, "database", "Views");
    let data = {
      ...p.database!,
      properties,
      rows,
    };
    data = addView(data, "board");
    const board = activeView(data);
    data = updateView(data, board.id, {
      name: "Kanban",
      filterText: "進行中",
      filter: group("and", [
        {
          kind: "condition",
          id: "persisted-condition",
          propertyId: "cost",
          operator: "greater_than",
          value: 10,
        },
      ]),
      sorts: [{ id: "persisted-sort", propertyId: "cost", direction: "desc" }],
      groupBy: { propertyId: "status", direction: "asc" },
    });
    const saved = s.update(p.id, 0, { database: data });
    expect(saved.revision).toBe(1);
    s.close();
    const reopened = new Store(s.path);
    stores.push(reopened);
    const loaded = reopened.get(p.id).database!;
    expect(loaded).toEqual(data);
    expect(activeView(loaded).name).toBe("Kanban");
    expect(loaded.views).toHaveLength(2);
    expect(ids(queryRows(loaded))).toEqual(["a"]);
  });
  it("migrates a v2 workspace in one transaction with a pre-v3 snapshot", () => {
    const s = make(),
      p = s.create(null, "database", "Legacy");
    const legacy = {
      properties,
      rows,
      view: "board",
      filter: "進行中",
      sort: "-cost",
    };
    const original = rawPage(s, p.id, legacy);
    const revision = s.get(p.id).revision;
    s.db
      .prepare(
        "INSERT INTO versions(pageId,createdAt,title,doc,database) VALUES(?,?,?,?,?)",
      )
      .run(
        p.id,
        Date.now(),
        "legacy version",
        JSON.stringify(p.doc),
        JSON.stringify(legacy),
      );
    s.db.exec("PRAGMA user_version=2");
    s.close();
    const reopened = new Store(s.path);
    stores.push(reopened);
    const loaded = reopened.get(p.id);
    expect(loaded.revision).toBe(revision);
    expect(loaded.database?.schemaVersion).toBe(2);
    expect(loaded.database?.rows).toEqual(rows);
    expect(loaded.database?.properties).toEqual(properties);
    expect(loaded.database?.views[0]).toMatchObject({
      id: "view-default",
      type: "board",
      filterText: "進行中",
      sorts: [{ propertyId: "cost", direction: "desc" }],
    });
    expect(
      reopened.db.prepare("PRAGMA user_version").get()?.user_version,
    ).toBe(3);
    const migratedVersion = reopened.db
      .prepare(
        "SELECT database FROM versions WHERE pageId=? AND title='legacy version'",
      )
      .get(p.id) as { database: string };
    expect(JSON.parse(migratedVersion.database).schemaVersion).toBe(2);
    expect(existsSync(s.path + ".pre-v3.sqlite")).toBe(true);
    const backup = new DatabaseSync(s.path + ".pre-v3.sqlite", {
      readOnly: true,
    });
    const backed = backup
      .prepare("SELECT data FROM pages WHERE id=?")
      .get(p.id) as { data: string };
    expect(backed.data).toBe(original);
    expect(backup.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
    backup.close();
    // A second open is a no-op and leaves the already migrated bytes intact.
    const before = reopened.handle({ type: "pageSource", id: p.id });
    reopened.close();
    const third = new Store(s.path);
    stores.push(third);
    expect(third.handle({ type: "pageSource", id: p.id })).toBe(before);
  });
  it("rolls back a failed v3 migration, keeps v2 data and can retry", () => {
    const s = make(),
      p = s.create(null, "database", "Rollback");
    const legacy = {
      properties,
      rows,
      view: "table",
      filter: "",
      sort: "title",
    };
    const original = rawPage(s, p.id, legacy);
    s.db.exec("PRAGMA user_version=2");
    s.db.exec(
      "CREATE TRIGGER fail_database_migration BEFORE UPDATE ON pages BEGIN SELECT RAISE(ABORT,'injected migration failure'); END;",
    );
    s.close();
    expect(() => new Store(s.path)).toThrow(/injected migration failure/);
    const raw = new DatabaseSync(s.path);
    expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
    const stored = raw
      .prepare("SELECT data FROM pages WHERE id=?")
      .get(p.id) as { data: string };
    expect(stored.data).toBe(original);
    raw.exec("DROP TRIGGER fail_database_migration; PRAGMA user_version=2;");
    raw.close();
    const reopened = new Store(s.path);
    stores.push(reopened);
    expect(reopened.get(p.id).database?.views).toHaveLength(1);
  });
  it("preserves unknown database versions byte-for-byte and stops editing", () => {
    const s = make(),
      p = s.create(null, "database", "Unknown");
    const unknown = { ...p.database!, rows, schemaVersion: 99 };
    const original = rawPage(s, p.id, unknown);
    s.db.exec("PRAGMA user_version=2");
    s.close();
    const reopened = new Store(s.path);
    stores.push(reopened);
    const loaded = reopened.get(p.id);
    expect(loaded.documentError).toMatch(/未対応/);
    expect(loaded.database).toBe(null);
    expect(reopened.handle({ type: "pageSource", id: p.id })).toBe(original);
    expect(() =>
      reopened.update(p.id, loaded.revision, { title: "overwrite" }),
    ).toThrow(/未対応/);
    expect(reopened.handle({ type: "pageSource", id: p.id })).toBe(original);
    expect(
      reopened.db.prepare("PRAGMA user_version").get()?.user_version,
    ).toBe(3);
  });
  it("normalizes legacy database history and restores it with data preserved", () => {
    const s = make(),
      p = s.create(null, "database", "History");
    s.update(p.id, 0, { database: { ...p.database!, properties, rows } });
    const database = s.get(p.id).database!;
    s.db
      .prepare(
        "INSERT INTO versions(pageId,createdAt,title,doc,database) VALUES(?,?,?,?,?)",
      )
      .run(
        p.id,
        Date.now(),
        "old",
        JSON.stringify(p.doc),
        JSON.stringify({
          properties,
          rows,
          view: "gallery",
          filter: "",
          sort: "",
        }),
      );
    const versions = s.versions(p.id);
    expect(versions[0].database?.schemaVersion).toBe(2);
    expect(versions[0].database?.views[0].type).toBe("gallery");
    s.handle({
      type: "restoreVersion",
      id: p.id,
      versionId: versions[0].id,
    });
    expect(s.get(p.id).database?.rows).toEqual(rows);
    expect(s.get(p.id).database).not.toEqual(database);
  });
});

describe("legacy query compatibility", () => {
  it("keeps the old top-level filter/sort behavior used by existing tests", () => {
    const db = {
      ...emptyDatabase(),
      rows: [
        { id: "a", title: "日本語 10", values: { cost: 10, status: "進行中" } },
        { id: "b", title: "English 2", values: { cost: 2, status: "進行中" } },
        { id: "c", title: "Other", values: { cost: 100, status: "完了" } },
      ],
      filter: "進行中",
      sort: "cost",
    };
    expect(ids(queryRows(db))).toEqual(["b", "a"]);
    expect(ids(queryRows({ ...db, sort: "-cost" }))).toEqual(["a", "b"]);
  });
});
