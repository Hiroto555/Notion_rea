import { describe, expect, it } from "vitest";
import type {
  DatabaseProjection,
  DatabaseSettings,
  DatabaseView,
  Property,
  RecordProjection,
} from "../src/shared/types";
import { emptyDatabase } from "../src/shared/types";
import {
  boardConfig,
  boardGroups,
  calendarProperty,
  cellBaselineOf,
  cellPatchValue,
  cellRevertNeeded,
  clearDatabaseUiMemory,
  displayOf,
  draftFromRecord,
  draftPatch,
  draftValueFor,
  errorMessage,
  failedRecordEditCount,
  failedRecordPatch,
  patchCells,
  formatValue,
  groupValueForCreate,
  groupedRecords,
  clearFailedRecordEdits,
  mergeFailedRecordEdits,
  mainSortValue,
  mergeRecordPatch,
  recordOriginSelector,
  recordsForDay,
  rememberedScroll,
  rememberReturnFocus,
  rememberScroll,
  settingsForActiveView,
  settingsForDeletedView,
  settingsForDuplicatedView,
  settingsForFilter,
  settingsForFilterText,
  settingsForGroup,
  settingsForMovedView,
  settingsForNewView,
  settingsForSorts,
  settingsForViewType,
  settingsWithProperty,
  settingsWithoutRows,
  sortsWithAdded,
  stableCopiedView,
  sortsWithPrimary,
  sortsWithUpdated,
  sortsWithout,
  takeReturnFocus,
  undatedRecords,
  viewBaseForPatch,
  visibleRecords,
  withFailedCell,
  withoutFailedCell,
} from "../src/database/database-ui";

const properties: Property[] = [
  {
    id: "status",
    name: "ステータス",
    type: "select",
    options: ["未着手", "進行中", "完了"],
  },
  { id: "due", name: "期日", type: "date" },
  { id: "cost", name: "費用", type: "number" },
  { id: "done", name: "完了", type: "checkbox" },
  { id: "note", name: "メモ", type: "text" },
];

function makeView(
  id: string,
  name: string,
  type: DatabaseView["type"],
  patch: Partial<DatabaseView> = {},
): DatabaseView {
  return {
    id,
    name,
    type,
    filterText: "",
    filter: {
      kind: "group",
      id: "filter-" + id,
      conjunction: "and",
      conditions: [],
    },
    sorts: [],
    groupBy: null,
    ...patch,
  };
}

function makeProjection(): DatabaseProjection {
  const { rows: _ignored, ...base } = emptyDatabase();
  void _ignored;
  const views = [
    makeView("view-table", "テーブル", "table"),
    makeView("view-board", "ボード", "board"),
    makeView("view-calendar", "カレンダー", "calendar"),
    makeView("view-gallery", "ギャラリー", "gallery"),
  ];
  const settings: DatabaseSettings = {
    ...base,
    properties,
    views,
    activeViewId: "view-table",
    view: "table",
    filter: "",
    sort: "",
  };
  const records: RecordProjection[] = [
    {
      pageId: "page-a",
      databasePageId: "db-1",
      revision: 1,
      title: "Alpha 10",
      icon: "📄",
      values: {
        status: "進行中",
        due: "2026-10-28",
        cost: 20,
        done: false,
        note: "long ".repeat(30),
      },
      deletedAt: null,
    },
    {
      pageId: "page-b",
      databasePageId: "db-1",
      revision: 2,
      title: "Beta 2",
      icon: "",
      values: {
        status: "完了",
        due: "2026-11-02",
        cost: 50,
        done: true,
      },
      deletedAt: null,
    },
    {
      pageId: "page-c",
      databasePageId: "db-1",
      revision: 3,
      title: "Gamma",
      icon: "💡",
      values: { status: "未着手", due: "2026-10-01", cost: 5, done: false },
      deletedAt: null,
    },
    {
      pageId: "page-d",
      databasePageId: "db-1",
      revision: 4,
      title: "Deleted",
      icon: "🗑️",
      values: { status: "完了", due: "2026-09-01", cost: 1, done: true },
      deletedAt: 123,
    },
  ];
  return { settings, records, revision: 7 };
}

function withSettings(
  projection: DatabaseProjection,
  patch: Partial<DatabaseView>,
  viewId = "view-table",
): DatabaseProjection {
  return {
    ...projection,
    settings: {
      ...projection.settings,
      views: projection.settings.views.map((view) =>
        view.id === viewId ? { ...view, ...patch } : view,
      ),
    },
  };
}

describe("database display derivation", () => {
  it("excludes deleted records from the display copy and keeps them for the trash", () => {
    const display = displayOf(makeProjection());
    expect(display.activeRecords.map((record) => record.pageId)).toEqual([
      "page-a",
      "page-b",
      "page-c",
    ]);
    expect(display.deletedRecords.map((record) => record.pageId)).toEqual([
      "page-d",
    ]);
    expect(display.data.rows.map((row) => row.id)).toEqual([
      "page-a",
      "page-b",
      "page-c",
    ]);
  });

  it("filters and searches with a local v2-shaped copy", () => {
    const base = makeProjection();
    const filtered = withSettings(base, {
      filter: {
        kind: "group",
        id: "f",
        conjunction: "and",
        conditions: [
          {
            kind: "condition",
            id: "c",
            propertyId: "status",
            operator: "equals",
            value: "進行中",
          },
        ],
      },
    });
    expect(visibleRecords(displayOf(filtered)).map((r) => r.pageId)).toEqual([
      "page-a",
    ]);
    const searched = withSettings(base, { filterText: "beta" });
    expect(visibleRecords(displayOf(searched)).map((r) => r.pageId)).toEqual([
      "page-b",
    ]);
  });

  it("groups records with the requested direction", () => {
    const base = makeProjection();
    const ascending = withSettings(base, {
      groupBy: { propertyId: "status", direction: "asc" },
    });
    const descending = withSettings(base, {
      groupBy: { propertyId: "status", direction: "desc" },
    });
    expect(
      groupedRecords(displayOf(ascending)).map((group) => group.label),
    ).toEqual(["未着手", "進行中", "完了"]);
    expect(
      groupedRecords(displayOf(descending)).map((group) => group.label),
    ).toEqual(["完了", "進行中", "未着手"]);
  });

  it("respects the saved board direction instead of forcing asc", () => {
    const base = makeProjection();
    const descending = withSettings(
      base,
      { groupBy: { propertyId: "status", direction: "desc" } },
      "view-board",
    );
    const display = displayOf({
      ...descending,
      settings: {
        ...descending.settings,
        activeViewId: "view-board",
        view: "board",
      },
    });
    expect(boardConfig(display)).toEqual({
      propertyId: "status",
      direction: "desc",
    });
    expect(boardGroups(display).map((group) => group.label)).toEqual([
      "完了",
      "進行中",
      "未着手",
      "未設定",
    ]);
  });

  it("falls back to the first select property with ascending board direction", () => {
    const display = displayOf(makeProjection());
    expect(boardConfig(display)).toEqual({
      propertyId: "status",
      direction: "asc",
    });
  });

  it("groups board columns including empty options", () => {
    const display = displayOf(makeProjection());
    const groups = boardGroups(display);
    expect(groups.map((group) => group.records.length)).toEqual([1, 1, 1, 0]);
    expect(groups.at(-1)?.label).toBe("未設定");
  });

  it("derives calendar records and the undated count", () => {
    const display = displayOf(makeProjection());
    const property = calendarProperty(display);
    expect(property?.id).toBe("due");
    expect(
      recordsForDay(display, "due", "2026-10-28").map((r) => r.pageId),
    ).toEqual(["page-a"]);
    expect(undatedRecords(display, "due")).toEqual([]);
  });
});

describe("settings transforms", () => {
  const projection = makeProjection();
  const display = displayOf(projection);
  const noRows = (settings: DatabaseSettings) => {
    expect(Object.hasOwn(settings, "rows")).toBe(false);
    expect(JSON.stringify(settings)).not.toContain('"rows"');
  };

  it("strips rows from every write", () => {
    const writes = [
      settingsWithoutRows(display.data),
      settingsForActiveView(display, "view-board"),
      settingsForViewType(display, "gallery"),
      settingsForFilterText(display, "alpha"),
      settingsForFilter(display, {
        kind: "group",
        id: "g",
        conjunction: "and",
        conditions: [],
      }),
      settingsForSorts(display, []),
      settingsForGroup(display, { propertyId: "status", direction: "desc" }),
      settingsForNewView(display, "calendar"),
      settingsForDuplicatedView(display),
      settingsForDeletedView(display),
      settingsForMovedView(display, 1),
      settingsWithProperty(display, {
        name: "新しい数値",
        type: "number",
      }),
    ];
    for (const settings of writes) noRows(settings);
  });

  it("changes the active view and keeps the view projection consistent", () => {
    const settings = settingsForActiveView(display, "view-board");
    expect(settings.activeViewId).toBe("view-board");
    expect(settings.view).toBe("board");
    expect(settings.views.find((view) => view.id === "view-board")?.type).toBe(
      "board",
    );
  });

  it("updates filter text on the active view and its legacy projection", () => {
    const settings = settingsForFilterText(display, "alpha");
    expect(settings.views[0].filterText).toBe("alpha");
    expect(settings.filter).toBe("alpha");
  });

  it("adds, duplicates, deletes and moves views", () => {
    const added = settingsForNewView(display, "gallery");
    expect(added.views).toHaveLength(5);
    expect(added.activeViewId).toBe(added.views.at(-1)?.id);
    const duplicated = settingsForDuplicatedView(display);
    expect(duplicated.views).toHaveLength(5);
    expect(duplicated.views[1].name).toContain("のコピー");
    const deleted = settingsForDeletedView(display);
    expect(deleted.views).toHaveLength(3);
    const moved = settingsForMovedView(display, 1);
    expect(moved.views[1].id).toBe("view-table");
    expect(moved.activeViewId).toBe("view-table");
  });

  it("adds a typed property without touching records", () => {
    const settings = settingsWithProperty(display, {
      name: "工数",
      type: "number",
    });
    expect(settings.properties.at(-1)?.name).toBe("工数");
    expect(settings.properties.at(-1)?.type).toBe("number");
    expect(projection.records).toHaveLength(4);
    expect(settings.views).toHaveLength(4);
  });

  it("does not mutate the supplied projection", () => {
    const before = JSON.stringify(projection.settings);
    settingsForFilterText(display, "changed");
    settingsWithProperty(display, { name: "x", type: "text" });
    expect(JSON.stringify(projection.settings)).toBe(before);
  });
});

describe("sorts and cell patches", () => {
  const view = makeProjection().settings.views[0];

  it("writes the primary sort and keeps the remaining rules", () => {
    const existing = {
      ...view,
      sorts: [
        { id: "s1", propertyId: "due", direction: "asc" as const },
        { id: "s2", propertyId: "cost", direction: "desc" as const },
      ],
    };
    expect(mainSortValue(existing)).toBe("due");
    expect(sortsWithPrimary(existing, "-status")[0]).toEqual({
      id: "s1",
      propertyId: "status",
      direction: "desc",
    });
    expect(sortsWithPrimary(existing, "").map((sort) => sort.id)).toEqual([
      "s2",
    ]);
  });

  it("adds a sort using an unused property and updates/removes it", () => {
    const added = sortsWithAdded(view, properties);
    expect(added).toHaveLength(1);
    const updated = sortsWithUpdated({ ...view, sorts: added }, added[0].id, {
      direction: "desc",
    });
    expect(updated[0].direction).toBe("desc");
    expect(sortsWithout({ ...view, sorts: updated }, added[0].id)).toEqual([]);
  });

  it("converts typed cell input to a value patch", () => {
    expect(cellPatchValue({ id: "t", name: "T", type: "text" }, "abc")).toBe(
      "abc",
    );
    expect(cellPatchValue({ id: "t", name: "T", type: "text" }, "")).toBeNull();
    expect(cellPatchValue({ id: "n", name: "N", type: "number" }, "12.5")).toBe(
      12.5,
    );
    expect(
      cellPatchValue({ id: "n", name: "N", type: "number" }, "nope"),
    ).toBeNull();
    expect(
      cellPatchValue({ id: "n", name: "N", type: "number" }, ""),
    ).toBeNull();
    expect(
      cellPatchValue({ id: "c", name: "C", type: "checkbox" }, false),
    ).toBe(false);
    expect(
      cellPatchValue({ id: "d", name: "D", type: "date" }, "2026-10-28"),
    ).toBe("2026-10-28");
  });

  it("merges failed patches per record without dropping newer keys", () => {
    const merged = mergeRecordPatch(
      { title: "old", values: { status: "進行中", cost: 1 } },
      { values: { cost: 2 }, title: "new" },
    );
    expect(merged).toEqual({
      title: "new",
      values: { status: "進行中", cost: 2 },
    });
    expect(mergeRecordPatch(undefined, { values: { done: true } })).toEqual({
      values: { done: true },
    });
  });
});

describe("record drafts and display helpers", () => {
  const record = makeProjection().records[0];

  it("prefers a draft value and keeps an explicit null deletion", () => {
    const draft = {
      ...draftFromRecord(record),
      values: { ...record.values, cost: null },
    };
    expect(draftValueFor(draft, record, "cost")).toBeNull();
    expect(draftValueFor(draft, record, "status")).toBe("進行中");
    expect(draftValueFor(draftFromRecord(record), record, "note")).toBe(
      record.values.note,
    );
  });

  it("builds a patch from the draft copy", () => {
    const draft = { ...draftFromRecord(record), title: "Changed" };
    expect(draftPatch(draft)).toEqual({
      title: "Changed",
      values: { ...record.values },
    });
    expect(record.title).toBe("Alpha 10");
  });

  it("formats chip text for each property type", () => {
    expect(formatValue(properties[2], 0)).toBe("0");
    expect(formatValue(properties[3], true)).toBe("☑");
    expect(formatValue(properties[3], false)).toBe("☐");
    expect(formatValue(properties[0], null)).toBe("");
  });

  it("uses a checkbox false value for an empty board column", () => {
    const display = displayOf(makeProjection());
    expect(groupValueForCreate(display, "done", undefined)).toBe(false);
    expect(groupValueForCreate(display, "status", undefined)).toBe("");
    expect(groupValueForCreate(display, "status", "完了")).toBe("完了");
  });

  it("normalises unknown errors to a retained-input message", () => {
    expect(errorMessage(new Error("競合しました"))).toBe("競合しました");
    expect(errorMessage("保存できません")).toBe("保存できません");
    expect(errorMessage(undefined)).toContain("保持");
  });

  it("escapes record ids for the origin selector", () => {
    expect(recordOriginSelector("page-a")).toBe(
      '[data-record-origin="page-a"]',
    );
    expect(recordOriginSelector('a"b')).toBe('[data-record-origin="a\\"b"]');
  });
});

describe("presence-aware cell baselines", () => {
  const records = makeProjection().records;
  const withNote = records.find((record) => record.pageId === "page-a")!;
  const withoutNote = records.find((record) => record.pageId === "page-b")!;

  it("distinguishes an absent key from a present false or empty value", () => {
    expect(cellBaselineOf(withoutNote, "note")).toEqual({
      present: false,
      value: null,
    });
    expect(cellBaselineOf(withNote, "done")).toEqual({
      present: true,
      value: false,
    });
    expect(cellBaselineOf(withNote, "cost")).toEqual({
      present: true,
      value: 20,
    });
    expect(cellBaselineOf(withNote, "title")).toEqual({
      present: true,
      value: "Alpha 10",
    });
  });

  it("does not write for an untouched empty cell", () => {
    const absent = cellBaselineOf(withoutNote, "note");
    expect(cellRevertNeeded(absent, absent, undefined, undefined)).toBe(false);
    expect(cellRevertNeeded(absent, absent, null, null)).toBe(false);
    expect(cellRevertNeeded(absent, absent, "", undefined)).toBe(false);
  });

  it("requires a delete when an absent cell may already have reached Core", () => {
    const absent = cellBaselineOf(withoutNote, "note");
    expect(cellRevertNeeded(absent, absent, "typed", undefined)).toBe(true);
    expect(cellRevertNeeded(absent, absent, null, "typed")).toBe(true);
    expect(cellRevertNeeded(absent, absent, null, null)).toBe(false);
  });

  it("reverts a present value even after the ACK cleared the local draft", () => {
    const baseline = cellBaselineOf(withNote, "cost");
    const acknowledged = { present: true, value: 99 } as const;
    expect(cellRevertNeeded(baseline, acknowledged, undefined, undefined)).toBe(
      true,
    );
    expect(cellRevertNeeded(baseline, baseline, undefined, undefined)).toBe(
      false,
    );
    expect(cellRevertNeeded(baseline, acknowledged, 20, 99)).toBe(false);
  });
});

describe("failed record edits", () => {
  it("merges failures per cell and clears only the successful cells", () => {
    let failed = mergeFailedRecordEdits(undefined, {
      title: "T",
      values: { status: "完了" },
    });
    failed = mergeFailedRecordEdits(failed, {
      values: { status: "進行中", cost: null },
    });
    expect(failed).toEqual({
      title: "T",
      values: { status: "進行中", cost: null },
    });

    const afterTitle = clearFailedRecordEdits(failed, { title: "T2" });
    expect(afterTitle).toEqual({
      values: { status: "進行中", cost: null },
    });
    const afterStatus = clearFailedRecordEdits(afterTitle ?? undefined, {
      values: { status: "進行中" },
    });
    expect(afterStatus).toEqual({ values: { cost: null } });
    expect(
      clearFailedRecordEdits(afterStatus ?? undefined, {
        values: { cost: 1 },
      }),
    ).toBeNull();
    expect(clearFailedRecordEdits(undefined, { title: "T" })).toBeNull();
  });

  it("builds only the outstanding patch and counts title/values edits", () => {
    const failed = {
      title: "",
      values: { status: null, done: false },
    } as const;
    expect(failedRecordEditCount(failed)).toBe(3);
    expect(failedRecordPatch(failed)).toEqual({
      title: "",
      values: { status: null, done: false },
    });
    expect(failedRecordEditCount({ values: {} })).toBe(0);
    expect(failedRecordPatch({ values: {} })).toBeNull();
  });
});

describe("view patch bases", () => {
  it("captures only the fields a patch will change", () => {
    const view = makeProjection().settings.views[0];
    const base = viewBaseForPatch(view, {
      name: "一覧",
      filterText: "alpha",
    });
    expect(base).toEqual({ name: view.name, filterText: view.filterText });
    expect(Object.hasOwn(base, "sorts")).toBe(false);
  });
});

describe("stable copied view ids", () => {
  it("keeps filter and sort ids identical across applications", () => {
    const source = makeProjection().settings.views[0];
    const view = {
      ...source,
      filter: {
        kind: "group" as const,
        id: "random-group",
        conjunction: "and" as const,
        conditions: [
          {
            kind: "condition" as const,
            id: "random-condition",
            propertyId: "status",
            operator: "equals" as const,
            value: "進行中",
          },
        ],
      },
      sorts: [
        { id: "random-sort", propertyId: "cost", direction: "asc" as const },
      ],
    };
    const first = stableCopiedView(view, "view-new");
    const second = stableCopiedView(view, "view-new");
    expect(first).toEqual(second);
    expect(first.id).toBe("view-new");
    expect(first.sorts[0].id).toBe("view-new:sort:0");
    expect(first.filter.id).toBe("view-new:filter:root");
    expect(first.filter.conditions[0].id).toBe("view-new:filter:root.0");
    expect(first.filter.conditions[0]).toMatchObject({
      propertyId: "status",
      operator: "equals",
      value: "進行中",
    });
    expect(stableCopiedView(view, "view-other").id).toBe("view-other");
  });
});

describe("generation-addressable failed cells", () => {
  it("splits a record patch into cells without losing false/null", () => {
    expect(
      patchCells({
        title: "T",
        values: { status: null, done: false, cost: 0 },
      }),
    ).toEqual([
      { propertyId: "title", value: "T" },
      { propertyId: "status", value: null },
      { propertyId: "done", value: false },
      { propertyId: "cost", value: 0 },
    ]);
    expect(patchCells({})).toEqual([]);
  });

  it("adds and removes one cell while keeping the others", () => {
    let failed = withFailedCell(undefined, "status", null);
    failed = withFailedCell(failed, "title", "T");
    failed = withFailedCell(failed, "done", false);
    expect(failed).toEqual({
      title: "T",
      values: { status: null, done: false },
    });
    expect(withoutFailedCell(failed, "status")).toEqual({
      title: "T",
      values: { done: false },
    });
    const withoutTitle = withoutFailedCell(failed, "title");
    expect(withoutTitle).toEqual({
      values: { status: null, done: false },
    });
    expect(withoutFailedCell(withoutTitle ?? undefined, "status")).toEqual({
      values: { done: false },
    });
    expect(withoutFailedCell({ values: { done: false } }, "status")).toEqual({
      values: { done: false },
    });
    expect(withoutFailedCell({ values: { done: false } }, "done")).toBeNull();
    expect(withoutFailedCell(undefined, "title")).toBeNull();
  });
});

describe("UI-only scroll/focus memory", () => {
  it("keeps scroll per database and view and consumes return focus once", () => {
    clearDatabaseUiMemory();
    rememberScroll("db-1", "view-a", 120);
    rememberScroll("db-1", "view-b", 40);
    expect(rememberedScroll("db-1", "view-a")).toBe(120);
    expect(rememberedScroll("db-1", "view-b")).toBe(40);
    expect(rememberedScroll("db-2", "view-a")).toBe(0);
    rememberReturnFocus("db-1", "page-a");
    expect(takeReturnFocus("db-1")).toBe("page-a");
    expect(takeReturnFocus("db-1")).toBeNull();
    clearDatabaseUiMemory();
    expect(rememberedScroll("db-1", "view-a")).toBe(0);
  });
});
