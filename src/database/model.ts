import type {
  DatabaseData,
  DatabaseView,
  DatabaseViewType,
  FilterCondition,
  FilterGroup,
  FilterNode,
  FilterOperator,
  FilterValue,
  GroupRule,
  Property,
  RecordRow,
  SortDirection,
  SortRule,
} from "../shared/types";

// Kept in sync with DATABASE_SCHEMA_VERSION in shared/types.ts. It is repeated
// here so this pure module does not import a runtime value from the module that
// imports normalization (avoiding a runtime cycle).
const DATABASE_VERSION = 2 as const;

export const VIEW_TYPES: readonly DatabaseViewType[] = [
  "table",
  "board",
  "calendar",
  "gallery",
];
export const VIEW_TYPE_LABELS: Record<DatabaseViewType, string> = {
  table: "テーブル",
  board: "ボード",
  calendar: "カレンダー",
  gallery: "ギャラリー",
};
const PROPERTY_TYPES: readonly Property["type"][] = [
  "text",
  "number",
  "select",
  "date",
  "checkbox",
];
export const FILTER_OPERATORS: readonly FilterOperator[] = [
  "contains",
  "not_contains",
  "equals",
  "not_equals",
  "starts_with",
  "ends_with",
  "is_empty",
  "is_not_empty",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
  "before",
  "after",
  "on_or_before",
  "on_or_after",
  "is_checked",
  "is_not_checked",
];
export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  contains: "含む",
  not_contains: "含まない",
  equals: "等しい",
  not_equals: "等しくない",
  starts_with: "で始まる",
  ends_with: "で終わる",
  is_empty: "空である",
  is_not_empty: "空でない",
  greater_than: "より大きい",
  greater_than_or_equal: "以上",
  less_than: "より小さい",
  less_than_or_equal: "以下",
  before: "より前",
  after: "より後",
  on_or_before: "以前",
  on_or_after: "以後",
  is_checked: "チェック済み",
  is_not_checked: "未チェック",
};
const MAX_PROPERTIES = 1000;
const MAX_ROWS = 100_000;
const MAX_VIEWS = 100;
const MAX_FILTER_NODES = 200;
const MAX_FILTER_DEPTH = 8;
const MAX_SORTS = 50;
const MAX_TEXT = 10_000;
const TITLE_PROPERTY = "title";

export type NormalizeResult =
  | { ok: true; data: DatabaseData; migrated: boolean }
  | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isIdentifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 500;
const isFilterValue = (value: unknown): value is FilterValue =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

function readProperties(value: unknown): Property[] | string {
  if (!Array.isArray(value) || value.length > MAX_PROPERTIES)
    return "プロパティの形式が不正です。";
  const ids = new Set<string>();
  const properties: Property[] = [];
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      !isIdentifier(raw.id) ||
      typeof raw.name !== "string" ||
      !PROPERTY_TYPES.includes(raw.type as Property["type"])
    )
      return "プロパティの形式が不正です。";
    if (ids.has(raw.id)) return "プロパティIDが重複しています。";
    if (
      raw.options !== undefined &&
      (!Array.isArray(raw.options) ||
        raw.options.some((option) => typeof option !== "string"))
    )
      return "選択肢の形式が不正です。";
    ids.add(raw.id);
    properties.push({
      id: raw.id,
      name: raw.name,
      type: raw.type as Property["type"],
      ...(raw.options === undefined
        ? {}
        : { options: [...(raw.options as string[])] }),
    });
  }
  return properties;
}

function readRows(value: unknown): RecordRow[] | string {
  if (!Array.isArray(value) || value.length > MAX_ROWS)
    return "行データの形式が不正です。";
  const ids = new Set<string>();
  const rows: RecordRow[] = [];
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      !isIdentifier(raw.id) ||
      typeof raw.title !== "string" ||
      !isRecord(raw.values)
    )
      return "行データの形式が不正です。";
    if (ids.has(raw.id)) return "行IDが重複しています。";
    const values: RecordRow["values"] = {};
    for (const [key, cell] of Object.entries(raw.values)) {
      if (!isIdentifier(key) || !isFilterValue(cell))
        return "セル値の形式が不正です。";
      values[key] = cell;
    }
    ids.add(raw.id);
    rows.push({ id: raw.id, title: raw.title, values });
  }
  return rows;
}

function readFilter(value: unknown): FilterGroup | string {
  if (!isRecord(value) || value.kind !== "group")
    return "フィルターの形式が不正です。";
  const stack: { node: unknown; depth: number }[] = [
    { node: value, depth: 0 },
  ];
  const ids = new Set<string>();
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (!isRecord(node) || ++count > MAX_FILTER_NODES || depth > MAX_FILTER_DEPTH)
      return "フィルターの形式が不正です。";
    if (!isIdentifier(node.id) || ids.has(node.id))
      return "フィルターIDが不正または重複しています。";
    ids.add(node.id);
    if (node.kind === "condition") {
      if (
        !isIdentifier(node.propertyId) ||
        !FILTER_OPERATORS.includes(node.operator as FilterOperator) ||
        (node.value !== undefined && !isFilterValue(node.value))
      )
        return "フィルター条件の形式が不正です。";
    } else if (node.kind === "group") {
      if (
        (node.conjunction !== "and" && node.conjunction !== "or") ||
        !Array.isArray(node.conditions)
      )
        return "フィルターグループの形式が不正です。";
      for (const child of node.conditions)
        stack.push({ node: child, depth: depth + 1 });
    } else return "フィルターの種類が不正です。";
  }
  return structuredClone(value) as FilterGroup;
}

function readSorts(value: unknown): SortRule[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SORTS)
    return "並べ替えの数が多すぎるか形式が不正です。";
  const ids = new Set<string>();
  const sorts: SortRule[] = [];
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      !isIdentifier(raw.id) ||
      !isIdentifier(raw.propertyId) ||
      (raw.direction !== "asc" && raw.direction !== "desc")
    )
      return "並べ替えの形式が不正です。";
    if (ids.has(raw.id)) return "並べ替えIDが重複しています。";
    ids.add(raw.id);
    sorts.push({
      id: raw.id,
      propertyId: raw.propertyId,
      direction: raw.direction,
    });
  }
  return sorts;
}

function readGroupBy(value: unknown): GroupRule | null | string {
  if (value === undefined || value === null) return null;
  if (
    !isRecord(value) ||
    !isIdentifier(value.propertyId) ||
    (value.direction !== undefined &&
      value.direction !== "asc" &&
      value.direction !== "desc")
  )
    return "グループ化の形式が不正です。";
  return {
    propertyId: value.propertyId,
    direction: value.direction === "desc" ? "desc" : "asc",
  };
}

function readView(raw: unknown): DatabaseView | string {
  if (!isRecord(raw)) return "ビューの形式が不正です。";
  if (
    !isIdentifier(raw.id) ||
    typeof raw.name !== "string" ||
    raw.name.length > 200 ||
    !VIEW_TYPES.includes(raw.type as DatabaseViewType) ||
    typeof raw.filterText !== "string" ||
    raw.filterText.length > MAX_TEXT
  )
    return "ビューの形式が不正です。";
  const filter = readFilter(raw.filter);
  if (typeof filter === "string") return filter;
  const sorts = readSorts(raw.sorts);
  if (typeof sorts === "string") return sorts;
  const groupBy = readGroupBy(raw.groupBy);
  if (typeof groupBy === "string") return groupBy;
  return {
    id: raw.id,
    name: raw.name,
    type: raw.type as DatabaseViewType,
    filterText: raw.filterText,
    filter,
    sorts,
    groupBy,
  };
}

export function legacySortValue(rule: SortRule | undefined): string {
  if (!rule) return "";
  return (rule.direction === "desc" ? "-" : "") + rule.propertyId;
}

function parseLegacySort(value: string): SortRule[] {
  const text = value.trim();
  if (!text || text === "-") return [];
  const desc = text.startsWith("-");
  const propertyId = desc ? text.slice(1) : text;
  if (!propertyId) return [];
  return [
    {
      id: "sort-legacy",
      propertyId,
      direction: desc ? "desc" : "asc",
    },
  ];
}

function emptyFilter(id: string): FilterGroup {
  return { kind: "group", id, conjunction: "and", conditions: [] };
}

function typeLabel(type: DatabaseViewType): string {
  return VIEW_TYPE_LABELS[type];
}

export function emptyFilterGroup(id = newId()): FilterGroup {
  return emptyFilter(id);
}

export function newId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}

export function defaultDatabaseView(
  type: DatabaseViewType = "table",
  name = typeLabel(type),
): DatabaseView {
  return {
    id: newId(),
    name,
    type,
    filterText: "",
    filter: emptyFilterGroup(),
    sorts: [],
    groupBy: null,
  };
}

/**
 * v1 (single view, free-text filter, one sort) and v2 (multiple views) are both
 * accepted. The original object is never modified. Unknown versions and
 * structurally broken values fail instead of being silently repaired, which
 * lets the store keep the original bytes and stop editing.
 */
export function normalizeDatabaseData(input: unknown): NormalizeResult {
  if (!isRecord(input))
    return {
      ok: false,
      error: "データベースの構造が不正です。原本を保全しています。",
    };
  const version = input.schemaVersion;
  if (version !== undefined && version !== 1 && version !== 2)
    return {
      ok: false,
      error:
        "未対応のデータベースversionです。原本を保全し、編集を停止しています。",
    };
  const properties = readProperties(input.properties);
  if (typeof properties === "string") return { ok: false, error: properties };
  const rows = readRows(input.rows);
  if (typeof rows === "string") return { ok: false, error: rows };

  const legacyShape = !Array.isArray(input.views);
  if (legacyShape) {
    const type = VIEW_TYPES.includes(input.view as DatabaseViewType)
      ? (input.view as DatabaseViewType)
      : "table";
    const filterText =
      typeof input.filter === "string" && input.filter.length <= MAX_TEXT
        ? input.filter
        : "";
    const sortText =
      typeof input.sort === "string" && input.sort.length <= MAX_TEXT
        ? input.sort
        : "";
    const view: DatabaseView = {
      id: "view-default",
      name: typeLabel(type),
      type,
      filterText,
      filter: emptyFilter("filter-legacy"),
      sorts: parseLegacySort(sortText),
      groupBy: null,
    };
    return {
      ok: true,
      migrated: true,
      data: {
        schemaVersion: DATABASE_VERSION,
        properties,
        rows,
        views: [view],
        activeViewId: view.id,
        view: type,
        filter: filterText,
        sort: sortText,
      },
    };
  }

  const viewsInput = input.views as unknown[];
  if (viewsInput.length === 0 || viewsInput.length > MAX_VIEWS)
    return { ok: false, error: "ビューが1件もないか、数が多すぎます。" };
  const views: DatabaseView[] = [];
  const ids = new Set<string>();
  for (const raw of viewsInput) {
    const view = readView(raw);
    if (typeof view === "string") return { ok: false, error: view };
    if (ids.has(view.id)) return { ok: false, error: "ビューIDが重複しています。" };
    ids.add(view.id);
    views.push(view);
  }
  let changed =
    version !== DATABASE_VERSION || !Object.hasOwn(input, "activeViewId");
  const requested = isIdentifier(input.activeViewId)
    ? input.activeViewId
    : "";
  const active = views.find((view) => view.id === requested) ?? views[0];
  if (active.id !== requested) changed = true;
  const viewProjection = VIEW_TYPES.includes(input.view as DatabaseViewType)
    ? (input.view as DatabaseViewType)
    : active.type;
  if (viewProjection !== input.view) changed = true;
  const filterProjection =
    typeof input.filter === "string" && input.filter.length <= MAX_TEXT
      ? input.filter
      : active.filterText;
  if (filterProjection !== input.filter) changed = true;
  const sortProjection =
    typeof input.sort === "string" && input.sort.length <= MAX_TEXT
      ? input.sort
      : legacySortValue(active.sorts[0]);
  if (sortProjection !== input.sort) changed = true;
  return {
    ok: true,
    migrated: changed,
    data: {
      schemaVersion: DATABASE_VERSION,
      properties,
      rows,
      views,
      activeViewId: active.id,
      view: viewProjection,
      filter: filterProjection,
      sort: sortProjection,
    },
  };
}

/** Used by query helpers that may be handed a legacy object at runtime. */
export function ensureDatabaseData(input: DatabaseData): DatabaseData {
  if (
    Array.isArray(input?.views) &&
    input.views.length > 0 &&
    input.schemaVersion === DATABASE_VERSION
  )
    return input;
  const result = normalizeDatabaseData(input);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

export function activeView(data: DatabaseData): DatabaseView {
  const db = ensureDatabaseData(data);
  return (
    db.views.find((view) => view.id === db.activeViewId) ??
    db.views[0] ??
    defaultDatabaseView()
  );
}

export function propertyById(
  data: DatabaseData,
  propertyId: string,
): Property | undefined {
  return data.properties.find((property) => property.id === propertyId);
}

export function propertyType(
  data: DatabaseData,
  propertyId: string,
): Property["type"] {
  if (propertyId === TITLE_PROPERTY) return "text";
  return propertyById(data, propertyId)?.type ?? "text";
}

export function valueFor(
  row: RecordRow,
  propertyId: string,
): FilterValue | undefined {
  if (propertyId === TITLE_PROPERTY) return row.title;
  return row.values[propertyId];
}

const isEmptyValue = (
  value: unknown,
): value is null | undefined | "" =>
  value === undefined || value === null || value === "";

const textValue = (value: FilterValue): string =>
  String(value).toLocaleLowerCase();

function equalsValue(actual: FilterValue | undefined, expected: FilterValue) {
  if (typeof expected === "boolean") return actual === expected;
  if (typeof expected === "number") {
    if (typeof actual === "number") return actual === expected;
    if (typeof actual === "string" && actual.trim() !== "")
      return Number(actual) === expected;
    return false;
  }
  if (actual === undefined || actual === null) return false;
  return textValue(actual) === textValue(expected);
}

function orderedComparison(
  actual: FilterValue | undefined,
  expected: FilterValue,
): number | null {
  if (isEmptyValue(actual) || isEmptyValue(expected)) return null;
  if (typeof actual === "number" && typeof expected === "number")
    return actual - expected;
  const a = String(actual);
  const b = String(expected);
  return a.localeCompare(b, "ja", { numeric: true, sensitivity: "base" });
}

export function matchesFilterOperator(
  actual: FilterValue | undefined,
  operator: FilterOperator,
  expected: FilterValue | undefined,
): boolean {
  switch (operator) {
    case "is_empty":
      return isEmptyValue(actual);
    case "is_not_empty":
      return !isEmptyValue(actual);
    case "is_checked":
      return actual === true;
    case "is_not_checked":
      return actual !== true;
    case "contains":
      return (
        !isEmptyValue(actual) &&
        expected !== undefined &&
        textValue(actual).includes(textValue(expected))
      );
    case "not_contains":
      return (
        !isEmptyValue(actual) &&
        expected !== undefined &&
        !textValue(actual).includes(textValue(expected))
      );
    case "starts_with":
      return (
        !isEmptyValue(actual) &&
        expected !== undefined &&
        textValue(actual).startsWith(textValue(expected))
      );
    case "ends_with":
      return (
        !isEmptyValue(actual) &&
        expected !== undefined &&
        textValue(actual).endsWith(textValue(expected))
      );
    case "equals":
      return expected !== undefined && equalsValue(actual, expected);
    case "not_equals":
      return expected !== undefined && !equalsValue(actual, expected);
    case "greater_than":
    case "greater_than_or_equal":
    case "less_than":
    case "less_than_or_equal": {
      if (expected === undefined) return false;
      const compared = orderedComparison(actual, expected);
      if (compared === null) return false;
      return operator === "greater_than"
        ? compared > 0
        : operator === "greater_than_or_equal"
          ? compared >= 0
          : operator === "less_than"
            ? compared < 0
            : compared <= 0;
    }
    case "before":
    case "after":
    case "on_or_before":
    case "on_or_after": {
      if (isEmptyValue(actual) || expected === undefined || isEmptyValue(expected))
        return false;
      const compared = String(actual).localeCompare(String(expected));
      return operator === "before"
        ? compared < 0
        : operator === "after"
          ? compared > 0
          : operator === "on_or_before"
            ? compared <= 0
            : compared >= 0;
    }
  }
}

export function evaluateFilterNode(
  data: DatabaseData,
  node: FilterNode,
  row: RecordRow,
): boolean {
  if (node.kind === "condition")
    return matchesFilterOperator(
      valueFor(row, node.propertyId),
      node.operator,
      node.value,
    );
  if (node.conditions.length === 0) return true;
  return node.conjunction === "and"
    ? node.conditions.every((child) => evaluateFilterNode(data, child, row))
    : node.conditions.some((child) => evaluateFilterNode(data, child, row));
}

export function matchesSearch(row: RecordRow, search: string): boolean {
  if (!search.trim()) return true;
  return [row.title, ...Object.values(row.values)]
    .join(" ")
    .toLocaleLowerCase()
    .includes(search.trim().toLocaleLowerCase());
}

function compareNonEmpty(a: FilterValue, b: FilterValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean")
    return Number(a) - Number(b);
  return String(a).localeCompare(String(b), "ja", {
    numeric: true,
    sensitivity: "base",
  });
}

function compareValues(
  a: FilterValue | undefined,
  b: FilterValue | undefined,
): number {
  const aEmpty = isEmptyValue(a);
  const bEmpty = isEmptyValue(b);
  if (aEmpty || bEmpty) return aEmpty && bEmpty ? 0 : aEmpty ? 1 : -1;
  return compareNonEmpty(a, b);
}

export function compareRows(
  a: RecordRow,
  b: RecordRow,
  sorts: SortRule[],
): number {
  for (const sort of sorts) {
    const left = valueFor(a, sort.propertyId);
    const right = valueFor(b, sort.propertyId);
    const leftEmpty = isEmptyValue(left);
    const rightEmpty = isEmptyValue(right);
    // Missing values stay at the end in both directions.
    if (leftEmpty || rightEmpty) {
      if (leftEmpty && rightEmpty) continue;
      return leftEmpty ? 1 : -1;
    }
    const compared = compareNonEmpty(left, right);
    if (compared !== 0) return sort.direction === "desc" ? -compared : compared;
  }
  return 0;
}

export type RowGroup = {
  key: string;
  label: string;
  propertyId: string;
  value: FilterValue | undefined;
  rows: RecordRow[];
};

export type GroupOptions = { includeEmpty?: boolean };

function groupValueKey(value: FilterValue | undefined): string {
  return value === undefined ? "missing" : `${typeof value}:${String(value)}`;
}

function groupLabel(
  value: FilterValue | undefined,
  type: Property["type"] | "text",
): string {
  if (isEmptyValue(value)) return "未設定";
  if (type === "checkbox") return value === true ? "チェック済み" : "未チェック";
  return String(value);
}

export function groupRows(
  data: DatabaseData,
  view: DatabaseView,
  rows: RecordRow[],
  options: GroupOptions = {},
): RowGroup[] {
  if (!view.groupBy)
    return [
      { key: "", label: "", propertyId: "", value: undefined, rows },
    ];
  const propertyId = view.groupBy.propertyId;
  const type = propertyType(data, propertyId);
  const buckets = new Map<
    string,
    { value: FilterValue | undefined; rows: RecordRow[] }
  >();
  for (const row of rows) {
    const value = valueFor(row, propertyId);
    const missing = isEmptyValue(value);
    const key = missing ? "missing" : groupValueKey(value);
    const bucket = buckets.get(key);
    if (bucket) bucket.rows.push(row);
    else buckets.set(key, { value: missing ? undefined : value, rows: [row] });
  }
  const used = new Set<string>();
  const groups: RowGroup[] = [];
  const push = (key: string, value: FilterValue | undefined) => {
    const bucket = buckets.get(key);
    if (!bucket && !options.includeEmpty) return;
    used.add(key);
    groups.push({
      key,
      label: groupLabel(value, type),
      propertyId,
      value,
      rows: bucket?.rows ?? [],
    });
  };
  const descending = view.groupBy.direction === "desc";
  if (type === "select") {
    const property = propertyById(data, propertyId);
    const optionsList = [...(property?.options ?? [])];
    if (descending) optionsList.reverse();
    for (const option of optionsList) push(groupValueKey(option), option);
    const extras = [...buckets.entries()]
      .filter(([key]) => key !== "missing" && !used.has(key))
      .sort(([, a], [, b]) => {
        const compared = compareValues(a.value, b.value);
        return descending ? -compared : compared;
      });
    for (const [key, bucket] of extras) push(key, bucket.value);
    if (options.includeEmpty || buckets.has("missing")) push("missing", undefined);
    return groups;
  }
  if (type === "checkbox") {
    const checkedValues = descending ? [true, false] : [false, true];
    for (const value of checkedValues) {
      const key = groupValueKey(value);
      if (options.includeEmpty || buckets.has(key)) push(key, value);
    }
    if (options.includeEmpty || buckets.has("missing")) push("missing", undefined);
    return groups;
  }
  const ordered = [...buckets.entries()]
    .filter(([key]) => key !== "missing")
    .sort(([, a], [, b]) => {
      const compared = compareValues(a.value, b.value);
      return view.groupBy?.direction === "desc" ? -compared : compared;
    });
  for (const [key, bucket] of ordered) push(key, bucket.value);
  if (buckets.has("missing")) push("missing", undefined);
  return groups;
}

export function queryRows(input: DatabaseData): RecordRow[] {
  const data = ensureDatabaseData(input);
  const view = activeView(data);
  const search = view.filterText || data.filter;
  const sorts =
    view.sorts.length > 0 ? view.sorts : parseLegacySort(data.sort);
  return data.rows
    .filter(
      (row) =>
        matchesSearch(row, search) &&
        evaluateFilterNode(data, view.filter, row),
    )
    .sort((a, b) => compareRows(a, b, sorts));
}

function withActiveProjection(
  data: DatabaseData,
  active: DatabaseView,
): DatabaseData {
  return {
    ...data,
    activeViewId: active.id,
    view: active.type,
    filter: active.filterText,
    sort: legacySortValue(active.sorts[0]),
  };
}

export function setActiveView(
  input: DatabaseData,
  viewId: string,
): DatabaseData {
  const data = ensureDatabaseData(input);
  const view = data.views.find((candidate) => candidate.id === viewId);
  if (!view) throw new Error("ビューが見つかりません");
  return withActiveProjection(data, view);
}

export function updateView(
  input: DatabaseData,
  viewId: string,
  patch: Partial<Omit<DatabaseView, "id">>,
): DatabaseData {
  const data = ensureDatabaseData(input);
  if (!data.views.some((view) => view.id === viewId))
    throw new Error("ビューが見つかりません");
  const views = data.views.map((view) =>
    view.id === viewId ? { ...view, ...patch, id: view.id } : view,
  );
  const active = views.find((view) => view.id === data.activeViewId);
  if (!active) throw new Error("ビューが見つかりません");
  return withActiveProjection({ ...data, views }, active);
}

function uniqueViewName(data: DatabaseData, base: string): string {
  const names = new Set(data.views.map((view) => view.name));
  if (!names.has(base)) return base;
  for (let index = 2; index < 1000; index++) {
    const candidate = `${base} ${index}`;
    if (!names.has(candidate)) return candidate;
  }
  return `${base} ${newId().slice(0, 4)}`;
}

function cloneFilter(node: FilterNode): FilterNode {
  return node.kind === "condition"
    ? { ...node, id: newId() }
    : {
        ...node,
        id: newId(),
        conditions: node.conditions.map(cloneFilter),
      };
}

function cloneView(view: DatabaseView, name: string): DatabaseView {
  return {
    ...view,
    id: newId(),
    name,
    filter: cloneFilter(view.filter) as FilterGroup,
    sorts: view.sorts.map((sort) => ({ ...sort, id: newId() })),
    groupBy: view.groupBy ? { ...view.groupBy } : null,
  };
}

export function addView(
  input: DatabaseData,
  type: DatabaseViewType,
  options: { name?: string; copyActive?: boolean } = {},
): DatabaseData {
  const data = ensureDatabaseData(input);
  const current = activeView(data);
  const base = options.copyActive
    ? cloneView(current, options.name ?? uniqueViewName(data, typeLabel(type)))
    : defaultDatabaseView(type, options.name ?? typeLabel(type));
  const view: DatabaseView = {
    ...base,
    type,
    name: options.name ?? uniqueViewName(data, base.name),
  };
  const views = [...data.views, view];
  return withActiveProjection({ ...data, views }, view);
}

export function duplicateView(input: DatabaseData, viewId: string): DatabaseData {
  const data = ensureDatabaseData(input);
  const index = data.views.findIndex((view) => view.id === viewId);
  if (index < 0) throw new Error("ビューが見つかりません");
  const source = data.views[index];
  const copy = cloneView(
    source,
    uniqueViewName(data, `${source.name || typeLabel(source.type)} のコピー`),
  );
  const views = [...data.views];
  views.splice(index + 1, 0, copy);
  return withActiveProjection({ ...data, views }, copy);
}

export function renameView(
  input: DatabaseData,
  viewId: string,
  name: string,
): DatabaseData {
  return updateView(input, viewId, { name });
}

export function moveView(
  input: DatabaseData,
  viewId: string,
  delta: number,
): DatabaseData {
  const data = ensureDatabaseData(input);
  const index = data.views.findIndex((view) => view.id === viewId);
  if (index < 0) throw new Error("ビューが見つかりません");
  const target = Math.max(0, Math.min(data.views.length - 1, index + delta));
  if (target === index) return data;
  const views = [...data.views];
  const [view] = views.splice(index, 1);
  views.splice(target, 0, view);
  return withActiveProjection({ ...data, views }, view);
}

export function deleteView(input: DatabaseData, viewId: string): DatabaseData {
  const data = ensureDatabaseData(input);
  if (data.views.length <= 1)
    throw new Error("最後のビューは削除できません");
  const index = data.views.findIndex((view) => view.id === viewId);
  if (index < 0) throw new Error("ビューが見つかりません");
  const views = data.views.filter((view) => view.id !== viewId);
  const active =
    data.activeViewId === viewId
      ? views[Math.max(0, index - 1)]
      : views.find((view) => view.id === data.activeViewId) ?? views[0];
  return withActiveProjection({ ...data, views }, active);
}

export function filterOperatorsFor(
  type: Property["type"],
): readonly FilterOperator[] {
  if (type === "checkbox") return ["is_checked", "is_not_checked"];
  if (type === "number")
    return [
      "equals",
      "not_equals",
      "greater_than",
      "greater_than_or_equal",
      "less_than",
      "less_than_or_equal",
      "is_empty",
      "is_not_empty",
    ];
  if (type === "date")
    return [
      "equals",
      "not_equals",
      "before",
      "after",
      "on_or_before",
      "on_or_after",
      "is_empty",
      "is_not_empty",
    ];
  return [
    "contains",
    "not_contains",
    "equals",
    "not_equals",
    "starts_with",
    "ends_with",
    "is_empty",
    "is_not_empty",
  ];
}

export function operatorNeedsValue(operator: FilterOperator): boolean {
  return ![
    "is_empty",
    "is_not_empty",
    "is_checked",
    "is_not_checked",
  ].includes(operator);
}

export function defaultFilterOperator(
  type: Property["type"],
): FilterOperator {
  return type === "checkbox"
    ? "is_checked"
    : type === "number" || type === "date"
      ? "equals"
      : "contains";
}

export function newFilterCondition(
  propertyId = TITLE_PROPERTY,
  type: Property["type"] = "text",
): FilterCondition {
  const operator = defaultFilterOperator(type);
  return {
    kind: "condition",
    id: newId(),
    propertyId,
    operator,
    ...(type === "checkbox" || !operatorNeedsValue(operator)
      ? {}
      : { value: "" }),
  };
}

function alterGroup(
  group: FilterGroup,
  groupId: string,
  change: (group: FilterGroup) => FilterGroup,
): FilterGroup {
  if (group.id === groupId) return change(group);
  return {
    ...group,
    conditions: group.conditions.map((node) =>
      node.kind === "group" ? alterGroup(node, groupId, change) : node,
    ),
  };
}

export function addFilterCondition(
  group: FilterGroup,
  groupId: string,
  condition: FilterCondition,
): FilterGroup {
  return alterGroup(group, groupId, (current) => ({
    ...current,
    conditions: [...current.conditions, condition],
  }));
}

export function addFilterGroup(
  group: FilterGroup,
  groupId: string,
  conjunction: "and" | "or" = "and",
): FilterGroup {
  return alterGroup(group, groupId, (current) => ({
    ...current,
    conditions: [
      ...current.conditions,
      { kind: "group", id: newId(), conjunction, conditions: [] },
    ],
  }));
}

export function updateFilterCondition(
  group: FilterGroup,
  conditionId: string,
  patch: Partial<Omit<FilterCondition, "id" | "kind">>,
): FilterGroup {
  return {
    ...group,
    conditions: group.conditions.map((node) => {
      if (node.kind === "group")
        return updateFilterCondition(node, conditionId, patch);
      return node.id === conditionId
        ? { ...node, ...patch, id: node.id, kind: "condition" }
        : node;
    }),
  };
}

export function setFilterConjunction(
  group: FilterGroup,
  groupId: string,
  conjunction: "and" | "or",
): FilterGroup {
  return alterGroup(group, groupId, (current) => ({
    ...current,
    conjunction,
  }));
}

export function removeFilterNode(
  group: FilterGroup,
  nodeId: string,
): FilterGroup {
  if (group.id === nodeId) return group;
  return {
    ...group,
    conditions: group.conditions
      .filter((node) => node.id !== nodeId)
      .map((node) =>
        node.kind === "group" ? removeFilterNode(node, nodeId) : node,
      ),
  };
}

export function *filterConditions(
  group: FilterGroup,
): Generator<FilterCondition> {
  for (const node of group.conditions) {
    if (node.kind === "condition") yield node;
    else yield *filterConditions(node);
  }
}

export function monthDays(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const start = new Date(y, m - 1, 1, 12);
  start.setDate(start.getDate() - start.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
}
