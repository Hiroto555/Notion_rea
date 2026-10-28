/**
 * Display-only helpers for the Round 3 database surface.
 *
 * The canonical source is the read-only `DatabaseProjection` supplied by Core.
 * `derivedDatabase` / `DatabaseDisplay.data` are local v2-shaped copies used
 * only for filtering, sorting and grouping. They are never accepted by a save
 * callback and `settingsWithoutRows` strips rows before every `updateSettings`.
 */
import {
  activeView,
  addView,
  deleteView,
  duplicateView,
  groupRows,
  legacySortValue,
  moveView,
  newId,
  propertyType,
  queryRows,
  setActiveView,
  updateView,
} from "./model";
import type {
  DatabaseData,
  DatabaseProjection,
  DatabaseSettings,
  DatabaseView,
  DatabaseViewType,
  FilterGroup,
  FilterNode,
  FilterValue,
  GroupRule,
  Property,
  RecordPatch,
  RecordProjection,
  SortRule,
} from "../shared/types";

export const TITLE_PROPERTY_ID = "title";
export const TITLE_PROPERTY: Property = {
  id: TITLE_PROPERTY_ID,
  name: "名前",
  type: "text",
};

export type RecordDraft = Readonly<{
  title: string;
  /** `null` means "delete this value key" in a RecordPatch. */
  values: Readonly<Record<string, FilterValue | null>>;
}>;

export type RecordGroupView = {
  key: string;
  label: string;
  propertyId: string;
  value: FilterValue | undefined;
  records: RecordProjection[];
};

export type DatabaseDisplay = Readonly<{
  settings: DatabaseSettings;
  /** Filter/sort-only copy; never a save input. */
  data: DatabaseData;
  view: DatabaseView;
  activeRecords: readonly RecordProjection[];
  deletedRecords: readonly RecordProjection[];
}>;

/** Build the display copy from an already validated projection. */
export function displayOf(
  value: DatabaseProjection,
  settings: DatabaseSettings = value.settings,
): DatabaseDisplay {
  const activeRecords = value.records.filter(
    (record) => record.deletedAt === null,
  );
  const deletedRecords = value.records.filter(
    (record) => record.deletedAt !== null,
  );
  const data: DatabaseData = {
    ...settings,
    rows: activeRecords.map((record) => ({
      id: record.pageId,
      title: record.title,
      values: { ...record.values },
    })),
  };
  return {
    settings,
    data,
    view: activeView(data),
    activeRecords,
    deletedRecords,
  };
}

/** Strip `rows` before every settings write. A rows payload is a hard error. */
export function settingsWithoutRows(data: DatabaseData): DatabaseSettings {
  const { rows: _rows, ...settings } = data;
  void _rows;
  return settings;
}

export function visibleRecords(display: DatabaseDisplay): RecordProjection[] {
  const byId = new Map(
    display.activeRecords.map((record) => [record.pageId, record]),
  );
  return queryRows(display.data).flatMap((row) => {
    const record = byId.get(row.id);
    return record ? [record] : [];
  });
}

export function recordIsVisible(
  display: DatabaseDisplay,
  pageId: string,
): boolean {
  return visibleRecords(display).some((record) => record.pageId === pageId);
}

export function groupedRecords(
  display: DatabaseDisplay,
  options: { includeEmpty?: boolean } = {},
): RecordGroupView[] {
  const rows = queryRows(display.data);
  const byId = new Map(
    display.activeRecords.map((record) => [record.pageId, record]),
  );
  return groupRows(display.data, display.view, rows, options).map((group) => ({
    key: group.key,
    label: group.label,
    propertyId: group.propertyId,
    value: group.value,
    records: group.rows.flatMap((row) => {
      const record = byId.get(row.id);
      return record ? [record] : [];
    }),
  }));
}

/**
 * Board grouping. The legacy screen forced `direction: "asc"` even when the
 * saved view requested descending; this preserves the saved direction so the
 * UI and model agree.
 */
export function boardConfig(
  display: DatabaseDisplay,
): { propertyId: string; direction: "asc" | "desc" } | null {
  const view = display.view;
  const propertyId =
    view.groupBy?.propertyId ??
    display.settings.properties.find((property) => property.type === "select")
      ?.id;
  if (!propertyId) return null;
  const direction =
    view.groupBy?.propertyId === propertyId ? view.groupBy.direction : "asc";
  return { propertyId, direction };
}

export function boardGroups(display: DatabaseDisplay): RecordGroupView[] {
  const config = boardConfig(display);
  if (!config) return [];
  const grouped: DatabaseView = {
    ...display.view,
    groupBy: { propertyId: config.propertyId, direction: config.direction },
  };
  const rows = queryRows(display.data);
  const byId = new Map(
    display.activeRecords.map((record) => [record.pageId, record]),
  );
  return groupRows(display.data, grouped, rows, { includeEmpty: true }).map(
    (group) => ({
      key: group.key,
      label: group.label,
      propertyId: group.propertyId,
      value: group.value,
      records: group.rows.flatMap((row) => {
        const record = byId.get(row.id);
        return record ? [record] : [];
      }),
    }),
  );
}

/** The date property the calendar edits: a grouped date first, else the first date. */
export function calendarProperty(display: DatabaseDisplay): Property | null {
  const grouped = display.view.groupBy
    ? display.settings.properties.find(
        (property) => property.id === display.view.groupBy?.propertyId,
      )
    : undefined;
  if (grouped?.type === "date") return grouped;
  return (
    display.settings.properties.find((property) => property.type === "date") ??
    null
  );
}

export function recordsForDay(
  display: DatabaseDisplay,
  propertyId: string,
  day: string,
): RecordProjection[] {
  return visibleRecords(display).filter(
    (record) => String(record.values[propertyId] ?? "") === day,
  );
}

export function undatedRecords(
  display: DatabaseDisplay,
  propertyId: string,
): RecordProjection[] {
  return visibleRecords(display).filter((record) => !record.values[propertyId]);
}

export function settingsForActiveView(
  display: DatabaseDisplay,
  viewId: string,
): DatabaseSettings {
  return settingsWithoutRows(setActiveView(display.data, viewId));
}

export function settingsForView(
  display: DatabaseDisplay,
  viewId: string,
  patch: Partial<Omit<DatabaseView, "id">>,
): DatabaseSettings {
  return settingsWithoutRows(updateView(display.data, viewId, patch));
}

export function settingsForViewType(
  display: DatabaseDisplay,
  type: DatabaseViewType,
): DatabaseSettings {
  return settingsForView(display, display.view.id, { type });
}

export function settingsForFilterText(
  display: DatabaseDisplay,
  filterText: string,
): DatabaseSettings {
  return settingsForView(display, display.view.id, { filterText });
}

export function settingsForFilter(
  display: DatabaseDisplay,
  filter: FilterGroup,
): DatabaseSettings {
  return settingsForView(display, display.view.id, { filter });
}

export function settingsForSorts(
  display: DatabaseDisplay,
  sorts: SortRule[],
): DatabaseSettings {
  return settingsForView(display, display.view.id, { sorts });
}

export function settingsForGroup(
  display: DatabaseDisplay,
  groupBy: GroupRule | null,
): DatabaseSettings {
  return settingsForView(display, display.view.id, { groupBy });
}

/**
 * A copied view must keep stable filter/sort ids across optimistic application
 * and a retry. The model's clone helpers generate fresh ids each time; remap
 * them from the deterministic view id so later filter/sort patches do not
 * compare against different ids and report a false conflict.
 */
function stableFilterIds(
  node: FilterNode,
  seed: string,
  path: string,
): FilterNode {
  if (node.kind === "condition")
    return { ...node, id: `${seed}:filter:${path}` };
  return {
    ...node,
    id: `${seed}:filter:${path}`,
    conditions: node.conditions.map((child, index) =>
      stableFilterIds(child, seed, `${path}.${index}`),
    ),
  };
}

export function stableCopiedView(
  view: DatabaseView,
  viewId: string,
): DatabaseView {
  return {
    ...view,
    id: viewId,
    filter: stableFilterIds(view.filter, viewId, "root") as FilterGroup,
    sorts: view.sorts.map((sort, index) => ({
      ...sort,
      id: `${viewId}:sort:${index}`,
    })),
  };
}

export function settingsForNewView(
  display: DatabaseDisplay,
  type: DatabaseViewType,
): DatabaseSettings {
  return settingsWithoutRows(addView(display.data, type, { copyActive: true }));
}

export function settingsForDuplicatedView(
  display: DatabaseDisplay,
): DatabaseSettings {
  return settingsWithoutRows(duplicateView(display.data, display.view.id));
}

export function settingsForDeletedView(
  display: DatabaseDisplay,
): DatabaseSettings {
  return settingsWithoutRows(deleteView(display.data, display.view.id));
}

export function settingsForMovedView(
  display: DatabaseDisplay,
  delta: number,
): DatabaseSettings {
  return settingsWithoutRows(moveView(display.data, display.view.id, delta));
}

export type PropertyInput = {
  name: string;
  type: Property["type"];
  options?: string[];
};

export function settingsWithProperty(
  display: DatabaseDisplay,
  input: PropertyInput,
): DatabaseSettings {
  const property: Property = {
    id: newId(),
    name: input.name,
    type: input.type,
    ...(input.type === "select" ? { options: input.options ?? [] } : {}),
  };
  return settingsWithoutRows({
    ...display.data,
    properties: [...display.settings.properties, property],
  });
}

export function mainSortValue(view: DatabaseView): string {
  return legacySortValue(view.sorts[0]);
}

export function sortsWithPrimary(view: DatabaseView, text: string): SortRule[] {
  if (!text) return view.sorts.slice(1);
  const descending = text.startsWith("-");
  const propertyId = descending ? text.slice(1) : text;
  const first: SortRule = {
    id: view.sorts[0]?.id ?? newId(),
    propertyId,
    direction: descending ? "desc" : "asc",
  };
  return [first, ...view.sorts.slice(1)];
}

export function sortsWithAdded(
  view: DatabaseView,
  properties: readonly Property[],
): SortRule[] {
  const used = new Set(view.sorts.map((sort) => sort.propertyId));
  const property =
    properties.find((candidate) => !used.has(candidate.id)) ?? properties[0];
  if (!property) return view.sorts;
  return [
    ...view.sorts,
    { id: newId(), propertyId: property.id, direction: "asc" },
  ];
}

export function sortsWithUpdated(
  view: DatabaseView,
  id: string,
  patch: Partial<Omit<SortRule, "id">>,
): SortRule[] {
  return view.sorts.map((sort) =>
    sort.id === id ? { ...sort, ...patch } : sort,
  );
}

export function sortsWithout(view: DatabaseView, id: string): SortRule[] {
  return view.sorts.filter((sort) => sort.id !== id);
}

/**
 * Typed cell edit. Empty text and invalid numbers delete the value key
 * (RecordPatch uses `null` for deletion); checkboxes always write a boolean.
 */
export function cellPatchValue(
  property: Property,
  raw: string | boolean,
): FilterValue | null {
  if (property.type === "checkbox") return Boolean(raw);
  if (property.type === "number") {
    const text = String(raw).trim();
    if (text === "") return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }
  const text = String(raw);
  return text === "" ? null : text;
}

export function recordValue(
  record: RecordProjection,
  propertyId: string,
): FilterValue | undefined {
  return record.values[propertyId];
}

export function draftValueFor(
  draft: RecordDraft,
  record: RecordProjection,
  propertyId: string,
): FilterValue | null | undefined {
  return Object.hasOwn(draft.values, propertyId)
    ? draft.values[propertyId]
    : record.values[propertyId];
}

export function draftFromRecord(record: RecordProjection): RecordDraft {
  return { title: record.title, values: { ...record.values } };
}

export function draftPatch(draft: RecordDraft): RecordPatch {
  return { title: draft.title, values: { ...draft.values } };
}

export type CellBaseline = Readonly<{
  /** False means the property key was absent, not merely empty. */
  present: boolean;
  value: FilterValue | null;
}>;

export function cellBaselineOf(
  record: RecordProjection,
  propertyId: string,
): CellBaseline {
  if (propertyId === TITLE_PROPERTY_ID)
    return { present: true, value: record.title };
  if (Object.hasOwn(record.values, propertyId))
    return { present: true, value: record.values[propertyId] };
  return { present: false, value: null };
}

/**
 * Decide whether Escape must send a revert patch. An absent key is distinct
 * from an empty value; an untouched empty cell must not produce a delete
 * patch, while a value that may already have reached Core must be deleted.
 */
export function cellRevertNeeded(
  baseline: CellBaseline,
  current: CellBaseline,
  draft: FilterValue | null | undefined,
  sent: FilterValue | null | undefined,
): boolean {
  const effective: CellBaseline =
    draft !== undefined
      ? {
          present: draft !== null && draft !== "",
          value: draft,
        }
      : current;
  if (baseline.present) {
    if (!effective.present) return true;
    return !sameCellValue(baseline.value, effective.value);
  }
  if (effective.present) return true;
  return sent !== undefined && sent !== null && sent !== "";
}

export function viewBaseForPatch(
  view: DatabaseView,
  patch: Partial<Omit<DatabaseView, "id">>,
): Partial<DatabaseView> {
  const base: Record<string, unknown> = {};
  for (const key of Object.keys(patch))
    base[key] = (view as unknown as Record<string, unknown>)[key];
  return base as Partial<DatabaseView>;
}

export function recordTitle(record: RecordProjection): string {
  return record.title || "無題";
}

export function formatValue(
  property: Property,
  value: FilterValue | null | undefined,
): string {
  if (value === undefined || value === null || value === "") return "";
  if (property.type === "checkbox") return value ? "☑" : "☐";
  return String(value);
}

export function cellKey(pageId: string, propertyId: string): string {
  return pageId + "\u0000" + propertyId;
}

export function mergeRecordPatch(
  previous: RecordPatch | undefined,
  next: RecordPatch,
): RecordPatch {
  const merged: RecordPatch = {};
  const title = Object.hasOwn(next, "title") ? next.title : previous?.title;
  if (title !== undefined) merged.title = title;
  if (next.values || previous?.values)
    merged.values = { ...previous?.values, ...next?.values };
  return merged;
}

export type FailedRecordEdits = Readonly<{
  title?: string;
  values: Readonly<Record<string, FilterValue | null>>;
}>;

export type PatchCell = Readonly<{
  propertyId: string;
  value: FilterValue | null;
}>;

export function patchCells(patch: RecordPatch): PatchCell[] {
  const cells: PatchCell[] = [];
  if (patch.title !== undefined)
    cells.push({ propertyId: TITLE_PROPERTY_ID, value: patch.title });
  if (patch.values)
    for (const [propertyId, value] of Object.entries(patch.values))
      cells.push({ propertyId, value });
  return cells;
}

export function withFailedCell(
  failed: FailedRecordEdits | undefined,
  propertyId: string,
  value: FilterValue | null,
): FailedRecordEdits {
  const next: { title?: string; values: Record<string, FilterValue | null> } = {
    values: { ...(failed?.values ?? {}) },
  };
  if (failed?.title !== undefined) next.title = failed.title;
  if (propertyId === TITLE_PROPERTY_ID) next.title = String(value ?? "");
  else next.values[propertyId] = value;
  return next;
}

export function withoutFailedCell(
  failed: FailedRecordEdits | undefined,
  propertyId: string,
): FailedRecordEdits | null {
  if (!failed) return null;
  if (propertyId === TITLE_PROPERTY_ID) {
    if (failed.title === undefined) return failed;
    if (Object.keys(failed.values).length === 0) return null;
    return { values: { ...failed.values } };
  }
  if (!Object.hasOwn(failed.values, propertyId)) return failed;
  const values = { ...failed.values };
  delete values[propertyId];
  if (failed.title === undefined && Object.keys(values).length === 0)
    return null;
  return {
    ...(failed.title !== undefined ? { title: failed.title } : {}),
    values,
  };
}

export function mergeFailedRecordEdits(
  previous: FailedRecordEdits | undefined,
  patch: RecordPatch,
): FailedRecordEdits {
  const next: { title?: string; values: Record<string, FilterValue | null> } = {
    values: { ...(previous?.values ?? {}) },
  };
  if (previous?.title !== undefined) next.title = previous.title;
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.values)
    for (const [key, value] of Object.entries(patch.values))
      next.values[key] = value;
  return next;
}

/** Clear only the cells covered by a successful patch; other failures stay. */
export function clearFailedRecordEdits(
  previous: FailedRecordEdits | undefined,
  patch: RecordPatch,
): FailedRecordEdits | null {
  if (!previous) return null;
  const next: { title?: string; values: Record<string, FilterValue | null> } = {
    values: { ...previous.values },
  };
  if (patch.title === undefined && previous.title !== undefined)
    next.title = previous.title;
  if (patch.values)
    for (const key of Object.keys(patch.values)) delete next.values[key];
  if (next.title === undefined && Object.keys(next.values).length === 0)
    return null;
  return next;
}

export function failedRecordPatch(
  failed: FailedRecordEdits,
): RecordPatch | null {
  const patch: RecordPatch = {};
  if (failed.title !== undefined) patch.title = failed.title;
  if (Object.keys(failed.values).length) patch.values = { ...failed.values };
  return patch.title === undefined && !patch.values ? null : patch;
}

export function failedRecordEditCount(failed: FailedRecordEdits): number {
  return (
    (failed.title !== undefined ? 1 : 0) + Object.keys(failed.values).length
  );
}

export function sameCellValue(
  left: FilterValue | null | undefined,
  right: FilterValue | null | undefined,
): boolean {
  return (
    (left === undefined ? null : left) === (right === undefined ? null : right)
  );
}

export function groupValueForCreate(
  display: DatabaseDisplay,
  propertyId: string,
  value: FilterValue | undefined,
): FilterValue {
  if (value !== undefined) return value;
  return propertyType(display.data, propertyId) === "checkbox" ? false : "";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "保存に失敗しました。入力内容は保持されています。";
}

/** UI-only scroll/focus memory; never persisted into the workspace. */
const scrollMemory = new Map<string, number>();
const returnFocus = new Map<string, string>();
const scrollKey = (databasePageId: string, viewId: string) =>
  databasePageId + "\u0000" + viewId;

export function rememberScroll(
  databasePageId: string,
  viewId: string,
  top: number,
): void {
  scrollMemory.set(scrollKey(databasePageId, viewId), Math.max(0, top));
}

export function rememberedScroll(
  databasePageId: string,
  viewId: string,
): number {
  return scrollMemory.get(scrollKey(databasePageId, viewId)) ?? 0;
}

export function rememberReturnFocus(
  databasePageId: string,
  pageId: string,
): void {
  returnFocus.set(databasePageId, pageId);
}

export function takeReturnFocus(databasePageId: string): string | null {
  const pageId = returnFocus.get(databasePageId) ?? null;
  returnFocus.delete(databasePageId);
  return pageId;
}

/** Tests only. */
export function clearDatabaseUiMemory(): void {
  scrollMemory.clear();
  returnFocus.clear();
}

export function recordOriginSelector(pageId: string): string {
  const escaped = pageId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[data-record-origin="${escaped}"]`;
}

/**
 * Focus the row/card that opened a record. Core may call this after navigation
 * returns; the mounted DatabasePresentation also consumes the same UI memory.
 */
export function focusRecordOrigin(
  pageId: string,
  root: ParentNode | null = typeof document === "undefined" ? null : document,
): boolean {
  if (!root) return false;
  const element = root.querySelector<HTMLElement>(recordOriginSelector(pageId));
  if (!element) return false;
  element.focus({ preventScroll: true });
  element.scrollIntoView?.({ block: "nearest" });
  return true;
}
