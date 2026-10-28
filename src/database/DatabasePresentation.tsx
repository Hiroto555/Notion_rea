import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Columns3,
  Copy,
  Filter,
  LayoutGrid,
  Plus,
  RefreshCw,
  RotateCcw,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import type {
  DatabaseCallbacks,
  DatabaseData,
  DatabasePresentationProps,
  DatabaseProjection,
  DatabaseSettings,
  DatabaseView,
  DatabaseViewType,
  FilterValue,
  Property,
  RecordPatch,
  RecordProjection,
} from "../shared/types";
import {
  VIEW_TYPE_LABELS,
  addView,
  deleteView,
  duplicateView,
  filterConditions,
  monthDays,
  moveView,
  newId,
  setActiveView,
  updateView,
} from "./model";
import * as ui from "./database-ui";
import { FilterBuilder } from "./FilterBuilder";
import { PropertyField } from "./PropertyField";
import "./database.css";

const VIEW_ICONS = {
  table: Table2,
  board: Columns3,
  calendar: CalendarDays,
  gallery: LayoutGrid,
} as const;
const VIEW_TYPES: readonly DatabaseViewType[] = [
  "table",
  "board",
  "calendar",
  "gallery",
];

export type DatabasePresentationComponentProps = DatabasePresentationProps & {
  /**
   * Pending contract addition: the projection has no database identity when it
   * has no records. Core can pass the owning page id for display memory.
   */
  databasePageId?: string;
  className?: string;
  /** Render a separate non-editing surface. Keep the mode fixed for a mounted
   * instance: changing it unmounts the editable writer and its local drafts.
   * A caller must first settle and preserve any editable state. */
  readOnly?: boolean;
  /** Optional parent-owned selection for the read-only renderer. */
  controlledViewId?: string;
  hideNavigation?: boolean;
  onSelectView?: (viewId: string) => void;
};

type SettingsWriter = {
  settings: DatabaseSettings;
  pending: boolean;
  error: string | null;
  apply: (intent: SettingsIntent) => void;
  retry: () => void;
  discard: () => void;
  getSettings: () => DatabaseSettings;
};

type SettingsIntent =
  | {
      kind: "viewPatch";
      viewId: string;
      patch: Partial<Omit<DatabaseView, "id">>;
      /** Values the user saw for every patched field (compare-and-swap). */
      base: Partial<DatabaseView>;
    }
  | { kind: "activeView"; viewId: string; base: string }
  | { kind: "addView"; type: DatabaseViewType; viewId: string }
  | { kind: "duplicateView"; viewId: string; newViewId: string }
  | { kind: "deleteView"; viewId: string; base: DatabaseView }
  | {
      kind: "moveView";
      viewId: string;
      delta: number;
      baseOrder: readonly string[];
    }
  | { kind: "addProperty"; property: Property };

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function movedOrder(
  order: readonly string[],
  viewId: string,
  delta: number,
): string[] {
  const index = order.indexOf(viewId);
  if (index < 0) return [...order];
  const target = Math.max(0, Math.min(order.length - 1, index + delta));
  const next = [...order];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

/**
 * Settings changes are semantic intents, never a stale full settings snapshot.
 * Each intent is applied to the newest known canonical settings/revision. A
 * view patch carries the field values the user saw, so a same-field external
 * change is reported as a conflict instead of being silently overwritten.
 * View create/duplicate intents carry their new ids so an optimistic view and a
 * retry after failure keep the same identity for queued follow-up edits.
 */
function applySettingsIntent(
  settings: DatabaseSettings,
  intent: SettingsIntent,
): DatabaseSettings {
  const data: DatabaseData = { ...settings, rows: [] };
  switch (intent.kind) {
    case "viewPatch": {
      const current = settings.views.find((view) => view.id === intent.viewId);
      if (!current)
        throw new Error(
          "ビューが見つかりません。他の変更と競合しています。再読み込みしてください。",
        );
      for (const key of Object.keys(intent.patch)) {
        const before = (intent.base as Record<string, unknown>)[key];
        const now = (current as unknown as Record<string, unknown>)[key];
        if (!sameJson(before, now))
          throw new Error(
            "同じビュー設定が他の変更で更新されました。再読み込みしてから再試行してください。",
          );
      }
      return ui.settingsWithoutRows(
        updateView(data, intent.viewId, intent.patch),
      );
    }
    case "activeView": {
      if (settings.activeViewId !== intent.base)
        throw new Error(
          "選択中のビューが他の変更で更新されました。再読み込みしてください。",
        );
      if (!settings.views.some((view) => view.id === intent.viewId))
        throw new Error("ビューが見つかりません。");
      return ui.settingsWithoutRows(setActiveView(data, intent.viewId));
    }
    case "addView": {
      if (settings.views.some((view) => view.id === intent.viewId))
        return settings;
      const added = addView(data, intent.type, { copyActive: true });
      const created = added.views[added.views.length - 1];
      const views = added.views.map((view) =>
        view.id === created.id
          ? ui.stableCopiedView(view, intent.viewId)
          : view,
      );
      return ui.settingsWithoutRows(
        setActiveView(
          { ...added, views, activeViewId: intent.viewId },
          intent.viewId,
        ),
      );
    }
    case "duplicateView": {
      if (settings.views.some((view) => view.id === intent.newViewId))
        return settings;
      if (!settings.views.some((view) => view.id === intent.viewId))
        throw new Error(
          "複製元のビューが見つかりません。他の変更と競合しています。",
        );
      const duplicated = duplicateView(data, intent.viewId);
      const copyId = duplicated.activeViewId;
      const views = duplicated.views.map((view) =>
        view.id === copyId ? ui.stableCopiedView(view, intent.newViewId) : view,
      );
      return ui.settingsWithoutRows(
        setActiveView(
          { ...duplicated, views, activeViewId: intent.newViewId },
          intent.newViewId,
        ),
      );
    }
    case "deleteView": {
      const current = settings.views.find((view) => view.id === intent.viewId);
      // Idempotent: a retry after a lost ACK must not fail on an absent view.
      if (!current) return settings;
      if (!sameJson(current, intent.base))
        throw new Error(
          "削除対象のビューが他の変更で更新されました。再読み込みしてから再試行してください。",
        );
      return ui.settingsWithoutRows(deleteView(data, intent.viewId));
    }
    case "moveView": {
      const currentOrder = settings.views.map((view) => view.id);
      const expected = movedOrder(
        intent.baseOrder,
        intent.viewId,
        intent.delta,
      );
      // Retry after a lost ACK: the move is already reflected.
      if (sameJson(currentOrder, expected)) return settings;
      if (!sameJson(currentOrder, intent.baseOrder))
        throw new Error(
          "ビューの並び順が他の変更で更新されました。再読み込みしてください。",
        );
      return ui.settingsWithoutRows(
        moveView(data, intent.viewId, intent.delta),
      );
    }
    case "addProperty":
      if (settings.properties.some((p) => p.id === intent.property.id))
        return settings;
      return ui.settingsWithoutRows({
        ...data,
        properties: [...settings.properties, intent.property],
      });
  }
}

function applySettingsIntents(
  settings: DatabaseSettings,
  intents: readonly SettingsIntent[],
): DatabaseSettings {
  let next = settings;
  for (const intent of intents) next = applySettingsIntent(next, intent);
  return next;
}

/**
 * Single-flight writer for view/settings controls. This is not a record or
 * Editor autosave queue: records are patched through Core's callbacks with
 * their own revision. Unsent intents are rebased onto the newest canonical
 * settings before a write; failed intents stay retryable.
 */
function useSettingsWriter(
  value: DatabaseProjection,
  update: DatabaseCallbacks["updateSettings"],
): SettingsWriter {
  const [override, setOverride] = useState<DatabaseSettings | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const overrideRef = useRef<DatabaseSettings | null>(null);
  const failedRef = useRef<readonly SettingsIntent[] | null>(null);
  const queue = useRef<SettingsIntent[]>([]);
  const projectionRef = useRef(value);
  const base = useRef({
    settings: value.settings,
    revision: value.revision,
  });
  const lastAck = useRef(value.revision);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const updateRef = useRef(update);

  projectionRef.current = value;
  updateRef.current = update;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (inFlight.current) return;
    if (overrideRef.current) {
      if (
        !failedRef.current &&
        !queue.current.length &&
        value.revision >= lastAck.current
      ) {
        base.current = {
          settings: value.settings,
          revision: value.revision,
        };
        overrideRef.current = null;
        setOverride(null);
      }
      return;
    }
    if (value.revision >= base.current.revision)
      base.current = {
        settings: value.settings,
        revision: value.revision,
      };
  }, [value.revision, value.settings]);

  const drain = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    while (alive.current && queue.current.length) {
      // Another writer may have advanced the projection since the last ACK.
      // Rebase pending intents onto that canonical state instead of reusing a
      // stale settings snapshot with a locally bumped revision.
      const parent = projectionRef.current;
      if (parent.revision > base.current.revision)
        base.current = {
          settings: parent.settings,
          revision: parent.revision,
        };
      const intents = queue.current;
      queue.current = [];
      let next: DatabaseSettings;
      try {
        next = applySettingsIntents(base.current.settings, intents);
      } catch (failure) {
        if (!alive.current) return;
        const outstanding = [...intents, ...queue.current];
        queue.current = [];
        failedRef.current = outstanding;
        setError(ui.errorMessage(failure));
        inFlight.current = false;
        setPending(false);
        return;
      }
      overrideRef.current = next;
      setOverride(next);
      try {
        const ack = await updateRef.current(base.current.revision, next);
        if (!alive.current) return;
        base.current = { settings: ack.settings, revision: ack.revision };
        lastAck.current = ack.revision;
        setError(null);
        failedRef.current = null;
      } catch (failure) {
        if (!alive.current) return;
        const outstanding = [...intents, ...queue.current];
        queue.current = [];
        failedRef.current = outstanding;
        setError(ui.errorMessage(failure));
        inFlight.current = false;
        setPending(false);
        return;
      }
    }
    inFlight.current = false;
    setPending(false);
  }, []);

  const apply = useCallback(
    (intent: SettingsIntent) => {
      const current = overrideRef.current ?? projectionRef.current.settings;
      let next: DatabaseSettings;
      try {
        next = applySettingsIntent(current, intent);
      } catch (failure) {
        setError(ui.errorMessage(failure));
        return;
      }
      if (failedRef.current) {
        queue.current.push(...failedRef.current);
        failedRef.current = null;
      }
      queue.current.push(intent);
      overrideRef.current = next;
      setOverride(next);
      setError(null);
      void drain();
    },
    [drain],
  );

  const retry = useCallback(() => {
    if (!failedRef.current) return;
    queue.current = [...failedRef.current, ...queue.current];
    failedRef.current = null;
    setError(null);
    void drain();
  }, [drain]);

  const discard = useCallback(() => {
    if (inFlight.current) return;
    queue.current = [];
    failedRef.current = null;
    overrideRef.current = null;
    base.current = {
      settings: projectionRef.current.settings,
      revision: projectionRef.current.revision,
    };
    setOverride(null);
    setError(null);
  }, []);

  const getSettings = useCallback(
    () => overrideRef.current ?? projectionRef.current.settings,
    [],
  );

  return {
    settings: override ?? value.settings,
    pending,
    error,
    apply,
    retry,
    discard,
    getSettings,
  };
}

/** The read-only path never mounts the editing writer or cell/form drafts.
 * View selection and the visible month are local presentation state only. */
export function DatabasePresentation(props: DatabasePresentationComponentProps) {
  return props.readOnly ? (
    <ReadOnlyDatabasePresentation {...props} />
  ) : (
    <EditableDatabasePresentation {...props} />
  );
}

function ReadOnlyDatabasePresentation({
  value,
  callbacks,
  databasePageId,
  className = "",
  controlledViewId,
  hideNavigation = false,
  onSelectView,
}: DatabasePresentationComponentProps) {
  const [selection, setSelection] = useState<{ owner: string | undefined; viewId: string }>(() => ({
    owner: databasePageId,
    viewId: value.settings.activeViewId,
  }));
  const [month, setMonth] = useState(() =>
    new Date().toLocaleDateString("sv-SE").slice(0, 7),
  );
  const latest = useRef({ value, callbacks, databasePageId });
  latest.current = { value, callbacks, databasePageId };
  const localViewId = selection.owner === databasePageId &&
    value.settings.views.some((view) => view.id === selection.viewId)
    ? selection.viewId
    : value.settings.activeViewId;
  const selectedViewId = controlledViewId ?? localViewId;
  const base = ui.displayOf(value);
  const settings = value.settings.views.some((view) => view.id === selectedViewId)
    ? ui.settingsForActiveView(base, selectedViewId)
    : value.settings;
  const display = ui.displayOf(value, settings);
  const visible = ui.visibleRecords(display);
  const ownerIsValid = typeof databasePageId === "string" && databasePageId.length > 0;

  // Display is allowed for a mismatched projection but navigation is not.
  // Recheck at activation time so an older rendered row cannot route a Page
  // after a newer projection changed its owner or deletion state.
  const canOpen = (record: RecordProjection) => {
    if (!ownerIsValid || record.databasePageId !== databasePageId ||
        typeof record.pageId !== "string" || !record.pageId || record.deletedAt !== null)
      return false;
    return value.records.filter((item) => item.pageId === record.pageId).length === 1;
  };
  const openRecord = (record: RecordProjection) => {
    const current = latest.current;
    if (!canOpen(record) || current.databasePageId !== databasePageId) return;
    const matches = current.value.records.filter((item) => item.pageId === record.pageId);
    if (matches.length !== 1 || matches[0].databasePageId !== databasePageId ||
        matches[0].deletedAt !== null) return;
    current.callbacks.openRecord(record.pageId);
  };
  const recordButton = (record: RecordProjection) => (
    <button
      type="button"
      className="r3-card-open"
      data-record-origin={record.pageId}
      aria-label={"開く " + ui.recordTitle(record)}
      disabled={!canOpen(record)}
      onClick={() => openRecord(record)}
    >
      <span className="r3-card-icon" aria-hidden="true">{record.icon || "📄"}</span>
      <strong className="r3-card-title">{ui.recordTitle(record)}</strong>
    </button>
  );
  const chips = (record: RecordProjection) => (
    <span className="r3-card-chips">
      {display.settings.properties.map((property) => {
        const text = ui.formatValue(property, ui.recordValue(record, property.id));
        return text ? <span className="r3-chip" key={property.id}>{text}</span> : null;
      })}
    </span>
  );
  const card = (record: RecordProjection, compact = false) => (
    <article key={record.pageId} data-record-id={record.pageId}
      className={"r3-card" + (compact ? " r3-card-compact" : "")}>
      {recordButton(record)}{!compact && chips(record)}
    </article>
  );
  const table = (rows: readonly RecordProjection[]) => (
    <div className="r3-table-wrap">
      <table className="r3-table">
        <thead><tr><th scope="col">Aa 名前</th>{display.settings.properties.map((property) =>
          <th key={property.id} scope="col">{property.name}</th>)}</tr></thead>
        <tbody>{rows.map((record) => (
          <tr key={record.pageId} data-record-id={record.pageId}>
            <td className="r3-cell-title">{recordButton(record)}</td>
            {display.settings.properties.map((property) => (
              <td key={property.id}>{ui.formatValue(property, ui.recordValue(record, property.id))}</td>
            ))}
          </tr>
        ))}</tbody>
      </table>
      {!rows.length && <p className="r3-empty">条件に一致するアイテムがありません。</p>}
    </div>
  );
  const grouped = ui.groupedRecords(display);
  const tableView = display.view.groupBy ? (
    <div className="r3-groups">{grouped.map((group) => (
      <section className="r3-group" key={group.key}>
        <h4>{group.label || "グループ"} <small>{group.records.length}</small></h4>
        {table(group.records)}
      </section>
    ))}</div>
  ) : table(visible);
  const boardView = ui.boardConfig(display) ? (
    <div className="r3-board">{ui.boardGroups(display).map((group) => (
      <section className="r3-board-column" key={group.key}
        aria-label={"グループ " + (group.label || "未設定")}>
        <h4><span className="r3-status-dot" aria-hidden="true" />
          {group.label || "未設定"} <small>{group.records.length}</small></h4>
        {group.records.map((record) => card(record))}
      </section>
    ))}</div>
  ) : <p className="r3-empty">セレクト型のプロパティがありません。</p>;
  const galleryView = display.view.groupBy ? (
    <div className="r3-groups">{grouped.map((group) => (
      <section className="r3-group" key={group.key}>
        <h4>{group.label || "グループ"} <small>{group.records.length}</small></h4>
        <div className="r3-gallery">{group.records.map((record) => card(record))}</div>
      </section>
    ))}</div>
  ) : <div className="r3-gallery">{visible.map((record) => card(record))}</div>;
  const dateProperty = ui.calendarProperty(display);
  const calendarView = dateProperty ? (
    <>
      <div className="r3-month-nav">
        <button type="button" aria-label="前の月" onClick={() => {
          const date = new Date(month + "-15T12:00:00"); date.setMonth(date.getMonth() - 1);
          setMonth(date.toLocaleDateString("sv-SE").slice(0, 7));
        }}><ArrowLeft size={15} aria-hidden="true" /></button>
        <strong>{month.replace("-", "年 ")}月</strong>
        <button type="button" aria-label="次の月" onClick={() => {
          const date = new Date(month + "-15T12:00:00"); date.setMonth(date.getMonth() + 1);
          setMonth(date.toLocaleDateString("sv-SE").slice(0, 7));
        }}><ArrowRight size={15} aria-hidden="true" /></button>
      </div>
      <div className="r3-calendar">
        {["日", "月", "火", "水", "木", "金", "土"].map((day) =>
          <div className="r3-weekday" key={day}>{day}</div>)}
        {monthDays(month).map((day) => (
          <div key={day} className={"r3-day" + (!day.startsWith(month) ? " r3-day-muted" : "")}>
            <span className="r3-day-number">{Number(day.slice(-2))}</span>
            {ui.recordsForDay(display, dateProperty.id, day).map((record) => card(record, true))}
          </div>
        ))}
      </div>
      <p className="r3-db-count">日付未設定：{ui.undatedRecords(display, dateProperty.id).length}件</p>
    </>
  ) : <p className="r3-empty">日付型のプロパティがありません。</p>;
  const content = display.view.type === "table" ? tableView :
    display.view.type === "board" ? boardView :
    display.view.type === "gallery" ? galleryView : calendarView;

  return (
    <section className={"r3-db " + className} aria-label="データベース"
      data-database-id={databasePageId} data-read-only="true">
      {!hideNavigation && <>
      {controlledViewId === undefined && <p role="status">データベースは読み取り専用です。ビューの切り替えは保存されません。</p>}
      <div className="r3-db-tabs" role="tablist" aria-label="データベースのビュー">
        {display.settings.views.map((candidate) => {
          const Icon = VIEW_ICONS[candidate.type];
          const active = candidate.id === display.view.id;
          return <button key={candidate.id} type="button" role="tab" aria-selected={active}
            aria-label={"ビュー: " + (candidate.name || VIEW_TYPE_LABELS[candidate.type])}
            className={active ? "r3-tab-active" : ""}
            disabled={controlledViewId !== undefined && !onSelectView}
            onClick={() => {
              if (controlledViewId !== undefined) onSelectView?.(candidate.id);
              else setSelection({ owner: databasePageId, viewId: candidate.id });
            }}>
            {Icon && <Icon size={15} aria-hidden="true" />}
            {candidate.name || VIEW_TYPE_LABELS[candidate.type]}
          </button>;
        })}
      </div>
      </>}
      <div className="r3-db-scroll" data-view-type={display.view.type}>{content}</div>
      <p className="r3-db-count">{visible.length} / {display.activeRecords.length} アイテム</p>
    </section>
  );
}

function EditableDatabasePresentation({
  value,
  callbacks,
  databasePageId,
  className = "",
}: DatabasePresentationComponentProps) {
  const databaseId =
    databasePageId ?? value.records[0]?.databasePageId ?? "unknown-database";
  const writer = useSettingsWriter(value, callbacks.updateSettings);
  const display = useMemo(
    () => ui.displayOf(value, writer.settings),
    [value, writer.settings],
  );
  const view = display.view;
  const visible = useMemo(() => ui.visibleRecords(display), [display]);
  const grouped = useMemo(() => ui.groupedRecords(display), [display]);
  const boardGroups = useMemo(() => ui.boardGroups(display), [display]);
  const calendarProperty = useMemo(
    () => ui.calendarProperty(display),
    [display],
  );
  const calendarMonth = useMemo(
    () => new Date().toLocaleDateString("sv-SE").slice(0, 7),
    [],
  );

  const [month, setMonth] = useState(calendarMonth);
  const [filterOpen, setFilterOpen] = useState(false);
  const [propertyForm, setPropertyForm] = useState(false);
  const [propertyName, setPropertyName] = useState("");
  const [propertyType, setPropertyType] = useState<Property["type"]>("text");
  const [propertyOptions, setPropertyOptions] = useState("低,中,高");
  const [newViewType, setNewViewType] = useState<DatabaseViewType>("table");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [failedEdits, setFailedEdits] = useState<
    Record<string, ui.FailedRecordEdits>
  >({});
  const failedEditsRef = useRef<Record<string, ui.FailedRecordEdits>>({});
  // The failed patch was based on this exact cell value. A retry must not
  // overwrite a newer external edit merely because another projection arrived.
  const failedBases = useRef(new Map<string, ui.CellBaseline>());
  const cellGeneration = useRef(new Map<string, number>());
  const [cellDrafts, setCellDrafts] = useState<
    Record<string, FilterValue | null>
  >({});
  const [busyRecords, setBusyRecords] = useState<readonly string[]>([]);
  const [creating, setCreating] = useState(false);
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const cancelCellFlush = useRef<Set<string>>(new Set());
  const sentCells = useRef(new Map<string, FilterValue | null>());
  const cellBaseline = useRef(new Map<string, ui.CellBaseline>());

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  const viewIdRef = useRef(view.id);
  const lastViewId = useRef(view.id);
  const valueRef = useRef(value);
  viewIdRef.current = view.id;
  valueRef.current = value;

  const currentDisplay = () =>
    ui.displayOf(valueRef.current, writer.getSettings());

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    // UI-only scroll/focus restoration across Core's navigation.
    const saved = ui.rememberedScroll(databaseId, viewIdRef.current);
    if (scrollRef.current) scrollRef.current.scrollTop = saved;
    const pageId = ui.takeReturnFocus(databaseId);
    if (pageId) ui.focusRecordOrigin(pageId, rootRef.current);
    return () => {
      const element = scrollRef.current;
      if (element)
        ui.rememberScroll(databaseId, viewIdRef.current, element.scrollTop);
    };
  }, [databaseId]);

  useEffect(() => {
    if (lastViewId.current === view.id) return;
    ui.rememberScroll(
      databaseId,
      lastViewId.current,
      scrollRef.current?.scrollTop ?? 0,
    );
    lastViewId.current = view.id;
    if (scrollRef.current)
      scrollRef.current.scrollTop = ui.rememberedScroll(databaseId, view.id);
  }, [databaseId, view.id]);

  useEffect(() => {
    // Clear a cell draft once the acknowledged projection reflects it.
    setCellDrafts((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const key of Object.keys(previous)) {
        const separator = key.indexOf("\u0000");
        const pageId = key.slice(0, separator);
        const propertyId = key.slice(separator + 1);
        const record = value.records.find(
          (candidate) => candidate.pageId === pageId,
        );
        if (!record || record.deletedAt !== null) {
          delete next[key];
          changed = true;
          continue;
        }
        const acknowledged =
          propertyId === ui.TITLE_PROPERTY_ID
            ? record.title
            : (record.values[propertyId] ?? null);
        if (ui.sameCellValue(acknowledged, previous[key])) {
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [value.records]);

  useEffect(() => {
    const live = new Set(Object.keys(cellDrafts));
    for (const key of [...sentCells.current.keys()])
      if (!live.has(key)) sentCells.current.delete(key);
  }, [cellDrafts]);

  useEffect(() => {
    if (!pendingFocus) return;
    if (ui.focusRecordOrigin(pendingFocus, rootRef.current))
      setPendingFocus(null);
  }, [pendingFocus, value.records]);

  const markBusy = (pageId: string, busy: boolean) =>
    setBusyRecords((previous) =>
      busy
        ? previous.includes(pageId)
          ? previous
          : [...previous, pageId]
        : previous.filter((candidate) => candidate !== pageId),
    );

  const commitFailedEdits = (next: Record<string, ui.FailedRecordEdits>) => {
    failedEditsRef.current = next;
    setFailedEdits(next);
  };

  const removeFailed = (
    all: Record<string, ui.FailedRecordEdits>,
    pageId: string,
    propertyId: string,
  ) => {
    const cleared = ui.withoutFailedCell(all[pageId], propertyId);
    if (cleared) return { ...all, [pageId]: cleared };
    if (!all[pageId]) return all;
    const next = { ...all };
    delete next[pageId];
    return next;
  };

  const patchRecord = (record: RecordProjection, patch: RecordPatch) => {
    const cells = ui.patchCells(patch);
    const generations = new Map<string, number>();
    let nextFailed = failedEditsRef.current;
    for (const cell of cells) {
      const key = ui.cellKey(record.pageId, cell.propertyId);
      const generation = (cellGeneration.current.get(key) ?? 0) + 1;
      cellGeneration.current.set(key, generation);
      generations.set(key, generation);
      nextFailed = removeFailed(nextFailed, record.pageId, cell.propertyId);
      failedBases.current.delete(key);
    }
    // A newer edit supersedes a failed older edit for the same cell. Clearing
    // synchronously (before the ACK) prevents a retry from sending the old
    // value while the new value is still in flight.
    commitFailedEdits(nextFailed);
    setError(null);
    void callbacks
      .patchRecord(record.pageId, record.revision, patch)
      .then(() => {
        let current = failedEditsRef.current;
        for (const cell of cells) {
          const key = ui.cellKey(record.pageId, cell.propertyId);
          if (cellGeneration.current.get(key) !== generations.get(key))
            continue;
          current = removeFailed(current, record.pageId, cell.propertyId);
        }
        commitFailedEdits(current);
      })
      .catch((failure) => {
        const currentCells = cells.filter(
          (cell) =>
            cellGeneration.current.get(
              ui.cellKey(record.pageId, cell.propertyId),
            ) === generations.get(ui.cellKey(record.pageId, cell.propertyId)),
        );
        if (!currentCells.length) return;
        setError(ui.errorMessage(failure));
        let current = failedEditsRef.current;
        for (const cell of currentCells) {
          failedBases.current.set(
            ui.cellKey(record.pageId, cell.propertyId),
            ui.cellBaselineOf(record, cell.propertyId),
          );
          current = {
            ...current,
            [record.pageId]: ui.withFailedCell(
              current[record.pageId],
              cell.propertyId,
              cell.value,
            ),
          };
        }
        commitFailedEdits(current);
      });
  };

  const retryFailed = () => {
    const entries = Object.entries(failedEditsRef.current);
    if (!entries.length) return;
    setError(null);
    for (const [pageId, failed] of entries) {
      const patch = ui.failedRecordPatch(failed);
      if (!patch) continue;
      const record = value.records.find(
        (candidate) => candidate.pageId === pageId,
      );
      if (!record) continue;
      const conflict = ui.patchCells(patch).some((cell) => {
        const base = failedBases.current.get(
          ui.cellKey(pageId, cell.propertyId),
        );
        const current = ui.cellBaselineOf(record, cell.propertyId);
        return (
          !base ||
          base.present !== current.present ||
          (base.present && !ui.sameCellValue(base.value, current.value))
        );
      });
      if (conflict) {
        setError(
          "同じ項目が他の変更で更新されました。未保存の入力を保持しています。",
        );
        continue;
      }
      patchRecord(record, patch);
    }
  };

  const setCellDraft = (
    record: RecordProjection,
    propertyId: string,
    cell: FilterValue | null,
  ) =>
    setCellDrafts((previous) => ({
      ...previous,
      [ui.cellKey(record.pageId, propertyId)]: cell,
    }));

  const clearCellDraft = (record: RecordProjection, propertyId: string) => {
    const key = ui.cellKey(record.pageId, propertyId);
    sentCells.current.delete(key);
    cellBaseline.current.delete(key);
    setCellDrafts((previous) => {
      if (!Object.hasOwn(previous, key)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  };

  const beginCellEdit = (record: RecordProjection, propertyId: string) => {
    const key = ui.cellKey(record.pageId, propertyId);
    if (cellBaseline.current.has(key)) return;
    cellBaseline.current.set(key, ui.cellBaselineOf(record, propertyId));
  };

  const sendCellPatch = (
    record: RecordProjection,
    propertyId: string,
    cell: FilterValue | null,
  ) => {
    sentCells.current.set(ui.cellKey(record.pageId, propertyId), cell);
    patchRecord(
      record,
      propertyId === ui.TITLE_PROPERTY_ID
        ? { title: String(cell ?? "") }
        : { values: { [propertyId]: cell } },
    );
  };

  const revertCell = (record: RecordProjection, propertyId: string) => {
    const key = ui.cellKey(record.pageId, propertyId);
    cancelCellFlush.current.add(key);
    const baseline =
      cellBaseline.current.get(key) ?? ui.cellBaselineOf(record, propertyId);
    const current = ui.cellBaselineOf(record, propertyId);
    const draft = Object.hasOwn(cellDrafts, key) ? cellDrafts[key] : undefined;
    const sent = sentCells.current.has(key)
      ? sentCells.current.get(key)
      : undefined;
    const needs = ui.cellRevertNeeded(baseline, current, draft, sent);
    cellBaseline.current.delete(key);
    if (needs) {
      setCellDraft(
        record,
        propertyId,
        baseline.present ? baseline.value : null,
      );
      sendCellPatch(
        record,
        propertyId,
        baseline.present ? baseline.value : null,
      );
    } else {
      clearCellDraft(record, propertyId);
    }
  };

  const cellValue = (
    record: RecordProjection,
    propertyId: string,
  ): FilterValue | null | undefined => {
    const key = ui.cellKey(record.pageId, propertyId);
    return Object.hasOwn(cellDrafts, key)
      ? cellDrafts[key]
      : (ui.recordValue(record, propertyId) ?? null);
  };

  const titleText = (record: RecordProjection) => {
    const key = ui.cellKey(record.pageId, ui.TITLE_PROPERTY_ID);
    if (!Object.hasOwn(cellDrafts, key)) return record.title;
    const value = cellDrafts[key];
    return value === null || value === undefined ? "" : String(value);
  };

  const flushCell = (record: RecordProjection, propertyId: string) => {
    const key = ui.cellKey(record.pageId, propertyId);
    if (cancelCellFlush.current.delete(key)) return;
    // Blur always ends the local Escape baseline, even when the ACK already
    // cleared the visible draft.
    cellBaseline.current.delete(key);
    if (!Object.hasOwn(cellDrafts, key)) return;
    const draft = cellDrafts[key];
    const acknowledged =
      propertyId === ui.TITLE_PROPERTY_ID
        ? record.title
        : (record.values[propertyId] ?? null);
    if (ui.sameCellValue(acknowledged, draft)) {
      clearCellDraft(record, propertyId);
      return;
    }
    if (
      sentCells.current.has(key) &&
      ui.sameCellValue(sentCells.current.get(key), draft)
    )
      return;
    sendCellPatch(record, propertyId, draft);
  };

  const openRecord = (pageId: string) => {
    ui.rememberScroll(databaseId, view.id, scrollRef.current?.scrollTop ?? 0);
    ui.rememberReturnFocus(databaseId, pageId);
    callbacks.openRecord(pageId);
  };

  const createRecord = (values: Record<string, FilterValue> = {}) => {
    if (creating) return;
    setCreating(true);
    setError(null);
    void callbacks
      .createRecord({ title: "新しいアイテム", values })
      .then((created) => {
        setNotice("レコードを作成しました");
        ui.rememberReturnFocus(databaseId, created.pageId);
        callbacks.openRecord(created.pageId);
      })
      .catch((failure) => setError(ui.errorMessage(failure)))
      .finally(() => setCreating(false));
  };

  const trashRecord = (record: RecordProjection) => {
    markBusy(record.pageId, true);
    setError(null);
    void callbacks
      .trashRecord(record.pageId, record.revision)
      .then(() => {
        setNotice("ゴミ箱へ移動しました");
        setCellDrafts((previous) => {
          const next = { ...previous };
          const keys = [ui.cellKey(record.pageId, ui.TITLE_PROPERTY_ID)];
          for (const property of display.settings.properties)
            keys.push(ui.cellKey(record.pageId, property.id));
          for (const key of keys) {
            delete next[key];
            sentCells.current.delete(key);
            cellBaseline.current.delete(key);
          }
          return next;
        });
        commitFailedEdits(
          (() => {
            const next = { ...failedEditsRef.current };
            delete next[record.pageId];
            return next;
          })(),
        );
        const next = visible.find(
          (candidate) => candidate.pageId !== record.pageId,
        );
        if (next) setPendingFocus(next.pageId);
        else requestAnimationFrame(() => newButtonRef.current?.focus());
      })
      .catch((failure) => setError(ui.errorMessage(failure)))
      .finally(() => markBusy(record.pageId, false));
  };

  const restoreRecord = (record: RecordProjection) => {
    markBusy(record.pageId, true);
    setError(null);
    void callbacks
      .restoreRecord(record.pageId, record.revision)
      .then((restored) => {
        setNotice("復元しました");
        setPendingFocus(restored.pageId);
      })
      .catch((failure) => setError(ui.errorMessage(failure)))
      .finally(() => markBusy(record.pageId, false));
  };

  const duplicateRecord = (record: RecordProjection) => {
    markBusy(record.pageId, true);
    setError(null);
    void callbacks
      .duplicateRecord(record.pageId, record.revision)
      .then((copy) => {
        setNotice("複製しました");
        setPendingFocus(copy.pageId);
      })
      .catch((failure) => setError(ui.errorMessage(failure)))
      .finally(() => markBusy(record.pageId, false));
  };

  const applyViewPatch = (patch: Partial<Omit<DatabaseView, "id">>) => {
    const current = currentDisplay();
    writer.apply({
      kind: "viewPatch",
      viewId: current.view.id,
      patch,
      base: ui.viewBaseForPatch(current.view, patch),
    });
  };

  const switchView = (viewId: string) => {
    const current = currentDisplay();
    if (viewId === current.view.id) return;
    writer.apply({
      kind: "activeView",
      viewId,
      base: current.settings.activeViewId,
    });
  };

  const addProperty = () => {
    const name = propertyName.trim();
    if (!name) {
      setError("プロパティ名を入力してください。");
      return;
    }
    const property: Property = {
      id: newId(),
      name,
      type: propertyType,
      ...(propertyType === "select"
        ? {
            options: propertyOptions
              .split(",")
              .map((option) => option.trim())
              .filter(Boolean),
          }
        : {}),
    };
    writer.apply({ kind: "addProperty", property });
    setPropertyForm(false);
    setPropertyName("");
  };

  const filterCount = [...filterConditions(view.filter)].length;
  const failedCount = Object.values(failedEdits).reduce(
    (count, failed) => count + ui.failedRecordEditCount(failed),
    0,
  );
  const busy = (record: RecordProjection) =>
    busyRecords.includes(record.pageId);

  const mainSort = ui.mainSortValue(view);
  const sortOptions = [
    { id: "title", name: "名前" },
    ...display.settings.properties,
  ];
  const groupOptions = [
    { id: "title", name: "名前" },
    ...display.settings.properties,
  ];

  const chips = (record: RecordProjection) => (
    <span className="r3-card-chips">
      {display.settings.properties.map((property) => {
        const text = ui.formatValue(
          property,
          ui.recordValue(record, property.id),
        );
        if (!text) return null;
        return (
          <span
            className={
              "r3-chip" + (property.type === "select" ? " r3-chip-status" : "")
            }
            key={property.id}
          >
            {text}
          </span>
        );
      })}
    </span>
  );

  const card = (record: RecordProjection, compact = false) => (
    <article
      className={"r3-card" + (compact ? " r3-card-compact" : "")}
      key={record.pageId}
      data-record-id={record.pageId}
      aria-busy={busy(record)}
      draggable={!busy(record)}
      onDragStart={(event) => {
        event.dataTransfer.setData("application/x-folio-record", record.pageId);
        event.dataTransfer.effectAllowed = "move";
      }}
    >
      <button
        type="button"
        className="r3-card-open"
        data-record-origin={record.pageId}
        aria-label={"開く " + ui.recordTitle(record)}
        onClick={() => openRecord(record.pageId)}
      >
        <span className="r3-card-icon" aria-hidden="true">
          {record.icon || "📄"}
        </span>
        <strong className="r3-card-title">{ui.recordTitle(record)}</strong>
        {!compact && chips(record)}
      </button>
      {!compact && (
        <span className="r3-card-actions">
          <button
            type="button"
            aria-label={"複製 " + ui.recordTitle(record)}
            title="レコードを複製"
            disabled={busy(record)}
            onClick={() => duplicateRecord(record)}
          >
            <Copy size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={"ゴミ箱へ移動 " + ui.recordTitle(record)}
            title="ゴミ箱へ移動"
            disabled={busy(record)}
            onClick={() => trashRecord(record)}
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </span>
      )}
    </article>
  );

  const table = (rows: RecordProjection[], keyPrefix = "") => (
    <div className="r3-table-wrap">
      <table className="r3-table">
        <thead>
          <tr>
            <th scope="col">Aa 名前</th>
            {display.settings.properties.map((property) => (
              <th scope="col" key={property.id}>
                {property.name}
              </th>
            ))}
            <th scope="col" aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          {rows.map((record) => (
            <tr key={keyPrefix + record.pageId} data-record-id={record.pageId}>
              <td className="r3-cell-title">
                <input
                  aria-label={"レコード名 " + ui.recordTitle(record)}
                  className="r3-title-input"
                  maxLength={500}
                  value={titleText(record)}
                  onChange={(event) => {
                    const value = event.target.value;
                    beginCellEdit(record, ui.TITLE_PROPERTY_ID);
                    setCellDraft(record, ui.TITLE_PROPERTY_ID, value);
                    sendCellPatch(record, ui.TITLE_PROPERTY_ID, value);
                  }}
                  onBlur={() => flushCell(record, ui.TITLE_PROPERTY_ID)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      revertCell(record, ui.TITLE_PROPERTY_ID);
                      event.currentTarget.blur();
                    }
                  }}
                />
              </td>
              {display.settings.properties.map((property) => (
                <td
                  key={property.id}
                  onBlur={() => flushCell(record, property.id)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    revertCell(record, property.id);
                    (event.target as HTMLElement).blur();
                  }}
                >
                  <PropertyField
                    property={property}
                    ariaLabel={property.name + " " + ui.recordTitle(record)}
                    value={cellValue(record, property.id)}
                    onChange={(cell) => {
                      beginCellEdit(record, property.id);
                      setCellDraft(record, property.id, cell);
                      sendCellPatch(record, property.id, cell);
                    }}
                  />
                </td>
              ))}
              <td className="r3-row-actions">
                <button
                  type="button"
                  data-record-origin={record.pageId}
                  aria-label={"開く " + ui.recordTitle(record)}
                  title="レコードを開く"
                  disabled={busy(record)}
                  onClick={() => openRecord(record.pageId)}
                >
                  <ArrowRight size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={"複製 " + ui.recordTitle(record)}
                  title="レコードを複製"
                  disabled={busy(record)}
                  onClick={() => duplicateRecord(record)}
                >
                  <Copy size={13} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={"ゴミ箱へ移動 " + ui.recordTitle(record)}
                  title="ゴミ箱へ移動"
                  disabled={busy(record)}
                  onClick={() => trashRecord(record)}
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (
        <p className="r3-empty">条件に一致するアイテムがありません。</p>
      )}
    </div>
  );

  const tableBody = () => {
    if (view.groupBy) {
      const groups = grouped;
      if (!groups.length) {
        return <p className="r3-empty">アイテムがありません。</p>;
      }
      return (
        <div className="r3-groups">
          {groups.map((group) => (
            <section className="r3-group" key={group.key}>
              <h4>
                {group.label || "グループ"}{" "}
                <small>{group.records.length}</small>
              </h4>
              {table(group.records, group.key + ":")}
            </section>
          ))}
        </div>
      );
    }
    if (!visible.length)
      return <p className="r3-empty">アイテムがありません。</p>;
    return table(visible);
  };

  const board = () => {
    if (!ui.boardConfig(display))
      return (
        <p className="r3-empty">
          セレクト型のプロパティを追加すると、ボードを使えます。
        </p>
      );
    const propertyId = ui.boardConfig(display)?.propertyId;
    return (
      <div className="r3-board">
        {boardGroups.map((group) => (
          <section
            className="r3-board-column"
            key={group.key}
            aria-label={"グループ " + (group.label || "未設定")}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const pageId = event.dataTransfer.getData(
                "application/x-folio-record",
              );
              const record = visible.find(
                (candidate) => candidate.pageId === pageId,
              );
              if (!record || !propertyId) return;
              const value = ui.groupValueForCreate(
                display,
                propertyId,
                group.value,
              );
              setCellDraft(record, propertyId, value);
              patchRecord(record, { values: { [propertyId]: value } });
            }}
          >
            <h4>
              <span className="r3-status-dot" aria-hidden="true" />
              {group.label || "未設定"} <small>{group.records.length}</small>
            </h4>
            {group.records.map((record) => card(record))}
            {propertyId && (
              <button
                type="button"
                className="r3-new-row"
                aria-label={"新しいレコードを追加 " + (group.label || "未設定")}
                disabled={creating}
                onClick={() =>
                  createRecord({
                    [propertyId]: ui.groupValueForCreate(
                      display,
                      propertyId,
                      group.value,
                    ),
                  })
                }
              >
                <Plus size={13} aria-hidden="true" /> 新規
              </button>
            )}
          </section>
        ))}
      </div>
    );
  };

  const gallery = () => {
    if (view.groupBy) {
      if (!grouped.length)
        return <p className="r3-empty">アイテムがありません。</p>;
      return (
        <div className="r3-groups">
          {grouped.map((group) => (
            <section className="r3-group" key={group.key}>
              <h4>
                {group.label || "グループ"}{" "}
                <small>{group.records.length}</small>
              </h4>
              <div className="r3-gallery">
                {group.records.map((record) => card(record))}
              </div>
            </section>
          ))}
        </div>
      );
    }
    if (!visible.length)
      return <p className="r3-empty">アイテムがありません。</p>;
    return (
      <div className="r3-gallery">{visible.map((record) => card(record))}</div>
    );
  };

  const calendar = () => {
    const property = calendarProperty;
    if (!property)
      return <p className="r3-empty">日付型のプロパティを追加してください。</p>;
    return (
      <>
        <div className="r3-month-nav">
          <button
            type="button"
            aria-label="前の月"
            onClick={() => {
              const date = new Date(month + "-15T12:00:00");
              date.setMonth(date.getMonth() - 1);
              setMonth(date.toLocaleDateString("sv-SE").slice(0, 7));
            }}
          >
            <ArrowLeft size={15} aria-hidden="true" />
          </button>
          <strong>{month.replace("-", "年 ")}月</strong>
          <button
            type="button"
            aria-label="次の月"
            onClick={() => {
              const date = new Date(month + "-15T12:00:00");
              date.setMonth(date.getMonth() + 1);
              setMonth(date.toLocaleDateString("sv-SE").slice(0, 7));
            }}
          >
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="r3-calendar">
          {["日", "月", "火", "水", "木", "金", "土"].map((day) => (
            <div className="r3-weekday" key={day}>
              {day}
            </div>
          ))}
          {monthDays(month).map((day) => {
            const dayRecords = ui.recordsForDay(display, property.id, day);
            return (
              <div
                className={
                  "r3-day" + (!day.startsWith(month) ? " r3-day-muted" : "")
                }
                key={day}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  const pageId = event.dataTransfer.getData(
                    "application/x-folio-record",
                  );
                  const record = visible.find(
                    (candidate) => candidate.pageId === pageId,
                  );
                  if (!record) return;
                  setCellDraft(record, property.id, day);
                  patchRecord(record, { values: { [property.id]: day } });
                }}
              >
                <button
                  type="button"
                  className="r3-day-number"
                  aria-label={day + " にレコードを追加"}
                  onClick={() => createRecord({ [property.id]: day })}
                >
                  {Number(day.slice(-2))}
                </button>
                {dayRecords.map((record) => card(record, true))}
              </div>
            );
          })}
        </div>
        <p className="r3-db-count">
          日付未設定：
          {ui.undatedRecords(display, property.id).length}
          件（テーブルで編集できます）
        </p>
      </>
    );
  };

  const content =
    view.type === "table"
      ? tableBody()
      : view.type === "board"
        ? board()
        : view.type === "gallery"
          ? gallery()
          : calendar();

  const panelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (event.key !== "Escape") return;
    if (filterOpen) {
      event.preventDefault();
      setFilterOpen(false);
    } else if (propertyForm) {
      event.preventDefault();
      setPropertyForm(false);
    }
  };

  return (
    <section
      className={"r3-db " + className}
      aria-label="データベース"
      data-database-id={databaseId}
      ref={rootRef}
      onKeyDown={panelKeyDown}
    >
      <div
        className="r3-db-tabs"
        role="tablist"
        aria-label="データベースのビュー"
      >
        {display.settings.views.map((candidate) => {
          const Icon = VIEW_ICONS[candidate.type];
          const active = candidate.id === view.id;
          return (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={
                "ビュー: " +
                (candidate.name || VIEW_TYPE_LABELS[candidate.type])
              }
              className={active ? "r3-tab-active" : ""}
              onClick={() => switchView(candidate.id)}
            >
              <Icon size={15} aria-hidden="true" />
              {candidate.name || VIEW_TYPE_LABELS[candidate.type]}
            </button>
          );
        })}
      </div>

      <div className="r3-db-toolbar">
        <input
          aria-label="データベースを絞り込む"
          placeholder="絞り込み…"
          value={view.filterText}
          onChange={(event) =>
            applyViewPatch({ filterText: event.target.value })
          }
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
        <button
          type="button"
          aria-expanded={filterOpen}
          onClick={() => setFilterOpen((open) => !open)}
        >
          <Filter size={13} aria-hidden="true" />
          フィルター{filterCount ? ` (${filterCount})` : ""}
        </button>
        <select
          aria-label="並べ替え"
          value={mainSort}
          onChange={(event) => {
            const current = currentDisplay();
            applyViewPatch({
              sorts: ui.sortsWithPrimary(current.view, event.target.value),
            });
          }}
        >
          <option value="">並べ替え</option>
          {sortOptions.flatMap((property) => [
            <option key={property.id} value={property.id}>
              {property.name} ↑
            </option>,
            <option key={"-" + property.id} value={"-" + property.id}>
              {property.name} ↓
            </option>,
          ])}
        </select>
        <button
          type="button"
          aria-label="複数並べ替えを追加"
          title="複数並べ替えを追加"
          disabled={!display.settings.properties.length}
          onClick={() => {
            const current = currentDisplay();
            applyViewPatch({
              sorts: ui.sortsWithAdded(
                current.view,
                current.settings.properties,
              ),
            });
          }}
        >
          ＋ 並べ替え
        </button>
        <select
          aria-label="グループ化"
          value={view.groupBy?.propertyId ?? ""}
          onChange={(event) => {
            applyViewPatch({
              groupBy: event.target.value
                ? { propertyId: event.target.value, direction: "asc" }
                : null,
            });
          }}
        >
          <option value="">グループ化なし</option>
          {groupOptions.map((property) => (
            <option key={property.id} value={property.id}>
              {property.name}
            </option>
          ))}
        </select>
        <select
          aria-label="グループの並び順"
          value={view.groupBy?.direction ?? "asc"}
          disabled={!view.groupBy}
          onChange={(event) => {
            const current = currentDisplay();
            if (!current.view.groupBy) return;
            applyViewPatch({
              groupBy: {
                propertyId: current.view.groupBy.propertyId,
                direction: event.target.value as "asc" | "desc",
              },
            });
          }}
        >
          <option value="asc">昇順</option>
          <option value="desc">降順</option>
        </select>
        <span className="r3-toolbar-spacer" />
        <span className="r3-db-status" role="status" aria-live="polite">
          {writer.pending ? "ビュー設定を保存中…" : notice}
        </span>
        <button type="button" onClick={() => setPropertyForm((open) => !open)}>
          ＋ プロパティ
        </button>
        <button
          ref={newButtonRef}
          type="button"
          className="r3-primary"
          aria-label="新しいレコード"
          disabled={creating}
          onClick={() => createRecord()}
        >
          <Plus size={14} aria-hidden="true" />
          新規
        </button>
      </div>

      <div className="r3-db-viewbar">
        <input
          aria-label="ビュー名"
          placeholder="ビュー名"
          value={view.name}
          onChange={(event) => applyViewPatch({ name: event.target.value })}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
        <select
          aria-label="ビューの種類"
          value={view.type}
          onChange={(event) =>
            applyViewPatch({
              type: event.target.value as DatabaseViewType,
            })
          }
        >
          {VIEW_TYPES.map((type) => (
            <option key={type} value={type}>
              {VIEW_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label="ビューを複製"
          disabled={display.settings.views.length >= 100}
          onClick={() => {
            const current = currentDisplay();
            writer.apply({
              kind: "duplicateView",
              viewId: current.view.id,
              newViewId: newId(),
            });
          }}
        >
          複製
        </button>
        <button
          type="button"
          aria-label="ビューを削除"
          disabled={display.settings.views.length <= 1}
          onClick={() => {
            const current = currentDisplay();
            writer.apply({
              kind: "deleteView",
              viewId: current.view.id,
              base: current.view,
            });
          }}
        >
          削除
        </button>
        <button
          type="button"
          aria-label="ビューを左へ移動"
          disabled={display.settings.views[0]?.id === view.id}
          onClick={() => {
            const current = currentDisplay();
            writer.apply({
              kind: "moveView",
              viewId: current.view.id,
              delta: -1,
              baseOrder: current.settings.views.map((view) => view.id),
            });
          }}
        >
          ←
        </button>
        <button
          type="button"
          aria-label="ビューを右へ移動"
          disabled={display.settings.views.at(-1)?.id === view.id}
          onClick={() => {
            const current = currentDisplay();
            writer.apply({
              kind: "moveView",
              viewId: current.view.id,
              delta: 1,
              baseOrder: current.settings.views.map((view) => view.id),
            });
          }}
        >
          →
        </button>
        <select
          aria-label="追加するビューの種類"
          value={newViewType}
          onChange={(event) =>
            setNewViewType(event.target.value as DatabaseViewType)
          }
        >
          {VIEW_TYPES.map((type) => (
            <option key={type} value={type}>
              {VIEW_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label="ビューを追加"
          disabled={display.settings.views.length >= 100}
          onClick={() =>
            writer.apply({
              kind: "addView",
              type: newViewType,
              viewId: newId(),
            })
          }
        >
          ＋ ビュー
        </button>
      </div>

      {writer.error && (
        <div className="r3-db-alert" role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>ビュー設定を保存できませんでした: {writer.error}</span>
          <button
            type="button"
            className="r3-inline-action"
            onClick={writer.retry}
          >
            <RefreshCw size={13} aria-hidden="true" /> 再試行
          </button>
          <button
            type="button"
            className="r3-inline-action"
            onClick={writer.discard}
          >
            変更を破棄
          </button>
        </div>
      )}
      {error && (
        <div className="r3-db-alert" role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>{error}</span>
          {failedCount > 0 && (
            <button
              type="button"
              className="r3-inline-action"
              onClick={retryFailed}
            >
              <RefreshCw size={13} aria-hidden="true" /> 未保存の変更を再試行
            </button>
          )}
          <button
            type="button"
            className="r3-inline-action"
            aria-label="エラーを閉じる"
            onClick={() => setError(null)}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}
      {!error && failedCount > 0 && (
        <div className="r3-db-unsaved" role="status">
          未保存の変更が {failedCount} 件あります。
          <button
            type="button"
            className="r3-inline-action"
            onClick={retryFailed}
          >
            <RefreshCw size={13} aria-hidden="true" /> 再試行
          </button>
        </div>
      )}

      {view.sorts.length > 1 && (
        <div className="r3-db-sort-rules">
          {view.sorts.slice(1).map((sort, index) => (
            <div className="r3-sort-rule" key={sort.id}>
              <span>並べ替え {index + 2}</span>
              <select
                aria-label={`並べ替え対象 ${index + 2}`}
                value={sort.propertyId}
                onChange={(event) => {
                  const current = currentDisplay();
                  applyViewPatch({
                    sorts: ui.sortsWithUpdated(current.view, sort.id, {
                      propertyId: event.target.value,
                    }),
                  });
                }}
              >
                <option value="title">名前</option>
                {display.settings.properties.map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name}
                  </option>
                ))}
              </select>
              <select
                aria-label={`並べ替え順 ${index + 2}`}
                value={sort.direction}
                onChange={(event) => {
                  const current = currentDisplay();
                  applyViewPatch({
                    sorts: ui.sortsWithUpdated(current.view, sort.id, {
                      direction: event.target.value as "asc" | "desc",
                    }),
                  });
                }}
              >
                <option value="asc">昇順</option>
                <option value="desc">降順</option>
              </select>
              <button
                type="button"
                aria-label={`並べ替えを削除 ${index + 2}`}
                onClick={() => {
                  const current = currentDisplay();
                  applyViewPatch({
                    sorts: ui.sortsWithout(current.view, sort.id),
                  });
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {filterOpen && (
        <div className="r3-db-filter">
          <FilterBuilder
            data={display.data}
            view={view}
            onChange={(filter) => applyViewPatch({ filter })}
          />
        </div>
      )}

      {propertyForm && (
        <form
          className="r3-property-form"
          onSubmit={(event) => {
            event.preventDefault();
            addProperty();
          }}
        >
          <input
            aria-label="プロパティ名"
            placeholder="プロパティ名"
            value={propertyName}
            onChange={(event) => setPropertyName(event.target.value)}
            autoFocus
          />
          <select
            aria-label="プロパティの種類"
            value={propertyType}
            onChange={(event) =>
              setPropertyType(event.target.value as Property["type"])
            }
          >
            <option value="text">テキスト</option>
            <option value="number">数値</option>
            <option value="select">セレクト</option>
            <option value="date">日付</option>
            <option value="checkbox">チェックボックス</option>
          </select>
          {propertyType === "select" && (
            <input
              aria-label="選択肢"
              value={propertyOptions}
              onChange={(event) => setPropertyOptions(event.target.value)}
              placeholder="選択肢をカンマ区切り"
            />
          )}
          <button type="submit" className="r3-primary">
            追加
          </button>
          <button
            type="button"
            onClick={() => {
              setPropertyForm(false);
              setPropertyName("");
            }}
          >
            キャンセル
          </button>
        </form>
      )}

      <div
        className="r3-db-scroll"
        data-view-type={view.type}
        ref={scrollRef}
        onScroll={(event) =>
          ui.rememberScroll(databaseId, view.id, event.currentTarget.scrollTop)
        }
      >
        {content}
      </div>

      <p className="r3-db-count" aria-live="polite">
        {visible.length} / {display.activeRecords.length} アイテム
      </p>

      {display.deletedRecords.length > 0 && (
        <details className="r3-trash">
          <summary>
            ゴミ箱のレコード <span>{display.deletedRecords.length}</span>
          </summary>
          <ul>
            {display.deletedRecords.map((record) => (
              <li key={record.pageId}>
                <button
                  type="button"
                  className="r3-trash-name"
                  data-record-origin={record.pageId}
                  aria-label={"開く " + ui.recordTitle(record)}
                  onClick={() => openRecord(record.pageId)}
                >
                  {record.icon || "📄"} {ui.recordTitle(record)}
                </button>
                <button
                  type="button"
                  className="r3-inline-action"
                  aria-label={"復元 " + ui.recordTitle(record)}
                  disabled={busy(record)}
                  onClick={() => restoreRecord(record)}
                >
                  <RotateCcw size={13} aria-hidden="true" /> 復元
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
