import { useRef, useState } from "react";
import { Modal } from "../renderer/Modal";
import {
  Table2,
  Columns3,
  CalendarDays,
  LayoutGrid,
  Plus,
  Trash2,
  ArrowLeft,
  ArrowRight,
} from "lucide-react";
import type {
  DatabaseData,
  DatabaseView,
  DatabaseViewType,
  Property,
  RecordRow,
  SortRule,
} from "../shared/types";
import {
  VIEW_TYPE_LABELS,
  activeView,
  addView,
  deleteView,
  duplicateView,
  filterConditions,
  groupRows,
  monthDays,
  moveView,
  newId,
  propertyById,
  propertyType as propertyKind,
  queryRows,
  renameView,
  setActiveView,
  updateView,
  legacySortValue,
} from "./model";
import { FilterBuilder } from "./FilterBuilder";
// Round 3 entry points. App.tsx still imports `Database` (legacy props) until
// Core connects DatabasePresentationProps, so the new contract surface is
// exported alongside it rather than silently changing App's props.
export { DatabasePresentation } from "./DatabasePresentation";
export type { DatabasePresentationComponentProps } from "./DatabasePresentation";
export { RecordPage } from "./RecordPage";
export type {
  RecordPageProps,
  RecordSaveState,
  RecordReadOnlyReason,
} from "./RecordPage";
export { PropertyField } from "./PropertyField";

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

/**
 * @deprecated Legacy v2 whole-database editor, still mounted by App.tsx until
 * Core connects DatabasePresentationProps. New code uses DatabasePresentation;
 * this component's onChange is the old whole-rows write path and must not be
 * used for migrated records.
 */
export function Database({
  value,
  onChange: persist,
}: {
  value: DatabaseData;
  onChange: (d: DatabaseData) => void;
}) {
  const undoStack = useRef<DatabaseData[]>([]);
  const onChange = (next: DatabaseData) => {
    undoStack.current.push(structuredClone(value));
    if (undoStack.current.length > 100) undoStack.current.shift();
    persist(next);
  };
  const [propertyForm, setPropertyForm] = useState(false),
    [propertyName, setPropertyName] = useState(""),
    [propertyType, setPropertyType] = useState<Property["type"]>("text"),
    [options, setOptions] = useState("低,中,高"),
    [month, setMonth] = useState(() =>
      new Date().toLocaleDateString("sv-SE").slice(0, 7),
    ),
    [editing, setEditing] = useState<string | null>(null),
    [filterOpen, setFilterOpen] = useState(false),
    [newViewType, setNewViewType] = useState<DatabaseViewType>("table");

  const view = activeView(value);
  const rows = queryRows(value);
  const status = value.properties.find((p) => p.type === "select"),
    date = value.properties.find((p) => p.type === "date");
  const boardPropertyId = view.groupBy?.propertyId ?? status?.id ?? null;
  const boardView: DatabaseView | null = boardPropertyId
    ? {
        ...view,
        groupBy: {
          propertyId: boardPropertyId,
          direction: view.groupBy?.direction ?? "asc",
        },
      }
    : null;
  const boardGroups = boardView
    ? groupRows(value, boardView, rows, { includeEmpty: true })
    : [];
  const calendarProperty =
    view.groupBy && propertyKind(value, view.groupBy.propertyId) === "date"
      ? propertyById(value, view.groupBy.propertyId)
      : date;
  const groupedRows = view.groupBy
    ? groupRows(value, view, rows)
    : [{ key: "", label: "", propertyId: "", value: undefined, rows }];
  const filterCount = [...filterConditions(view.filter)].length;
  const changeView = (patch: Partial<Omit<DatabaseView, "id">>) =>
    onChange(updateView(value, view.id, patch));
  const update = (id: string, patch: Partial<RecordRow>) =>
    onChange({
      ...value,
      rows: value.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });
  const setRowValue = (
    row: RecordRow,
    propertyId: string,
    cell: string | number | boolean,
  ) => {
    if (propertyId === "title") update(row.id, { title: String(cell) });
    else update(row.id, { values: { ...row.values, [propertyId]: cell } });
  };
  const cell = (row: RecordRow, p: Property) => {
    const v = row.values[p.id] ?? "";
    const change = (val: string | number | boolean) => setRowValue(row, p.id, val);
    if (p.type === "select")
      return (
        <select
          aria-label={p.name + " " + row.title}
          value={String(v)}
          onChange={(e) => change(e.target.value)}
        >
          <option value="">—</option>
          {p.options?.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      );
    if (p.type === "checkbox")
      return (
        <input
          aria-label={p.name + " " + row.title}
          type="checkbox"
          checked={!!v}
          onChange={(e) => change(e.target.checked)}
        />
      );
    return (
      <input
        aria-label={p.name + " " + row.title}
        type={
          p.type === "date" ? "date" : p.type === "number" ? "number" : "text"
        }
        value={String(v)}
        onChange={(e) =>
          change(
            p.type === "number" && e.target.value !== ""
              ? Number(e.target.value)
              : e.target.value,
          )
        }
      />
    );
  };
  const add = (values: RecordRow["values"] = {}, title = "新しいアイテム") => {
    const id = crypto.randomUUID();
    onChange({
      ...value,
      rows: [...value.rows, { id, title, values }],
    });
    setEditing(id);
  };
  const card = (r: RecordRow) => (
    <button
      className="db-card"
      key={r.id}
      draggable
      onDragStart={(e) =>
        e.dataTransfer.setData("application/x-folio-row", r.id)
      }
      onClick={() => setEditing(r.id)}
    >
      <span className="card-document">▤</span>
      <strong>{r.title || "無題"}</strong>
      <div>
        {value.properties.map(
          (p) =>
            r.values[p.id] !== undefined && (
              <span
                className={
                  "property-chip " + (p.type === "select" ? "status" : "")
                }
                key={p.id}
              >
                {p.type === "checkbox"
                  ? r.values[p.id]
                    ? "☑"
                    : "☐"
                  : String(r.values[p.id])}
              </span>
            ),
        )}
      </div>
    </button>
  );
  const active = value.rows.find((r) => r.id === editing);
  const switchType = (type: DatabaseViewType) => {
    if (view.type === type) return;
    const existing = value.views.find((candidate) => candidate.type === type);
    onChange(
      existing
        ? setActiveView(value, existing.id)
        : addView(value, type, { copyActive: true }),
    );
  };
  const mainSort = legacySortValue(view.sorts[0]);
  const setMainSort = (text: string) => {
    if (!text) {
      changeView({ sorts: view.sorts.slice(1) });
      return;
    }
    const desc = text.startsWith("-");
    const propertyId = desc ? text.slice(1) : text;
    const first: SortRule = {
      id: view.sorts[0]?.id ?? newId(),
      propertyId,
      direction: desc ? "desc" : "asc",
    };
    changeView({ sorts: [first, ...view.sorts.slice(1)] });
  };
  const addSort = () => {
    const used = new Set(view.sorts.map((sort) => sort.propertyId));
    const property =
      value.properties.find((candidate) => !used.has(candidate.id)) ??
      value.properties[0];
    changeView({
      sorts: [
        ...view.sorts,
        {
          id: newId(),
          propertyId: property?.id ?? "title",
          direction: "asc",
        },
      ],
    });
  };
  const updateSort = (id: string, patch: Partial<Omit<SortRule, "id">>) =>
    changeView({
      sorts: view.sorts.map((sort) =>
        sort.id === id ? { ...sort, ...patch } : sort,
      ),
    });
  const removeSort = (id: string) =>
    changeView({ sorts: view.sorts.filter((sort) => sort.id !== id) });

  const table = (tableRows: RecordRow[]) => (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Aa 名前</th>
            {value.properties.map((p) => (
              <th key={p.id}>{p.name}</th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {tableRows.map((r) => (
            <tr key={r.id}>
              <td>
                <input
                  aria-label="アイテム名"
                  value={r.title}
                  onChange={(e) => update(r.id, { title: e.target.value })}
                />
              </td>
              {value.properties.map((p) => (
                <td key={p.id}>{cell(r, p)}</td>
              ))}
              <td>
                <button
                  aria-label={"削除 " + r.title}
                  onClick={() =>
                    onChange({
                      ...value,
                      rows: value.rows.filter((x) => x.id !== r.id),
                    })
                  }
                >
                  <Trash2 size={14} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="new-row" onClick={() => add()}>
        ＋ 新しいアイテム
      </button>
    </div>
  );

  return (
    <div className="database">
      <div className="db-tabs">
        {value.views.map((candidate) => {
          const Icon = VIEW_ICONS[candidate.type];
          return (
            <button
              key={candidate.id}
              aria-label={
                "ビュー: " + (candidate.name || VIEW_TYPE_LABELS[candidate.type])
              }
              className={candidate.id === view.id ? "active" : ""}
              onClick={() => onChange(setActiveView(value, candidate.id))}
            >
              <Icon size={15} />
              {candidate.name || VIEW_TYPE_LABELS[candidate.type]}
            </button>
          );
        })}
        {VIEW_TYPES.map((type) => {
          const Icon = VIEW_ICONS[type];
          return (
            <button
              key={type}
              className={view.type === type ? "active" : ""}
              onClick={() => switchType(type)}
            >
              <Icon size={15} />
              {VIEW_TYPE_LABELS[type]}
            </button>
          );
        })}
      </div>
      <div className="db-toolbar">
        <button
          disabled={!undoStack.current.length}
          onClick={() => {
            const previous = undoStack.current.pop();
            if (previous) persist(previous);
          }}
        >
          DB変更を元に戻す
        </button>
        <input
          aria-label="データベースを絞り込む"
          placeholder="絞り込み…"
          value={view.filterText}
          onChange={(e) => changeView({ filterText: e.target.value })}
        />
        <select
          aria-label="並べ替え"
          value={mainSort}
          onChange={(e) => setMainSort(e.target.value)}
        >
          <option value="">並べ替え</option>
          {[{ id: "title", name: "名前" }, ...value.properties].flatMap((p) => [
            <option key={p.id} value={p.id}>
              {p.name} ↑
            </option>,
            <option key={"-" + p.id} value={"-" + p.id}>
              {p.name} ↓
            </option>,
          ])}
        </select>
        <button
          aria-label="複数並べ替えを追加"
          onClick={addSort}
          title="複数並べ替えを追加"
        >
          ＋ 並べ替え
        </button>
        <button
          aria-expanded={filterOpen}
          onClick={() => setFilterOpen((open) => !open)}
        >
          フィルター{filterCount ? ` (${filterCount})` : ""}
        </button>
        <select
          aria-label="グループ化"
          value={view.groupBy?.propertyId ?? ""}
          onChange={(e) =>
            changeView({
              groupBy: e.target.value
                ? { propertyId: e.target.value, direction: "asc" }
                : null,
            })
          }
        >
          <option value="">グループ化なし</option>
          <option value="title">名前</option>
          {value.properties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="spacer" />
        <button onClick={() => setPropertyForm(!propertyForm)}>
          ＋ プロパティ
        </button>
        <button className="primary" onClick={() => add()}>
          <Plus size={14} />
          新規
        </button>
      </div>
      <div className="db-toolbar">
        <input
          aria-label="ビュー名"
          value={view.name}
          onChange={(e) => onChange(renameView(value, view.id, e.target.value))}
          placeholder="ビュー名"
        />
        <select
          aria-label="ビューの種類"
          value={view.type}
          onChange={(e) =>
            changeView({ type: e.target.value as DatabaseViewType })
          }
        >
          {VIEW_TYPES.map((type) => (
            <option key={type} value={type}>
              {VIEW_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
        <button
          aria-label="ビューを複製"
          disabled={value.views.length >= 100}
          onClick={() => onChange(duplicateView(value, view.id))}
        >
          複製
        </button>
        <button
          aria-label="ビューを削除"
          disabled={value.views.length <= 1}
          onClick={() => onChange(deleteView(value, view.id))}
        >
          削除
        </button>
        <button
          aria-label="ビューを左へ移動"
          disabled={value.views[0]?.id === view.id}
          onClick={() => onChange(moveView(value, view.id, -1))}
        >
          ←
        </button>
        <button
          aria-label="ビューを右へ移動"
          disabled={value.views.at(-1)?.id === view.id}
          onClick={() => onChange(moveView(value, view.id, 1))}
        >
          →
        </button>
        <select
          aria-label="追加するビューの種類"
          value={newViewType}
          onChange={(e) => setNewViewType(e.target.value as DatabaseViewType)}
        >
          {VIEW_TYPES.map((type) => (
            <option key={type} value={type}>
              {VIEW_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
        <button
          aria-label="ビューを追加"
          onClick={() =>
            onChange(addView(value, newViewType, { copyActive: true }))
          }
        >
          ＋ ビュー
        </button>
      </div>
      {view.sorts.length > 1 && (
        <div className="db-sort-rules" style={{ padding: "0 16px" }}>
          {view.sorts.slice(1).map((sort, index) => (
            <div
              key={sort.id}
              style={{ display: "flex", gap: 6, alignItems: "center" }}
            >
              <span>並べ替え {index + 2}</span>
              <select
                aria-label={`並べ替え対象 ${index + 2}`}
                value={sort.propertyId}
                onChange={(e) =>
                  updateSort(sort.id, { propertyId: e.target.value })
                }
              >
                <option value="title">名前</option>
                {value.properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select
                aria-label={`並べ替え順 ${index + 2}`}
                value={sort.direction}
                onChange={(e) =>
                  updateSort(sort.id, {
                    direction: e.target.value as "asc" | "desc",
                  })
                }
              >
                <option value="asc">昇順</option>
                <option value="desc">降順</option>
              </select>
              <button
                aria-label={`並べ替えを削除 ${index + 2}`}
                onClick={() => removeSort(sort.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {filterOpen && (
        <div
          className="db-filter-panel"
          style={{
            padding: "8px 16px",
            borderTop: "1px solid rgba(128,128,128,.2)",
          }}
        >
          <FilterBuilder
            data={value}
            view={view}
            onChange={(filter) => changeView({ filter })}
          />
        </div>
      )}
      {propertyForm && (
        <form
          className="property-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!propertyName.trim()) return;
            onChange({
              ...value,
              properties: [
                ...value.properties,
                {
                  id: crypto.randomUUID(),
                  name: propertyName.trim(),
                  type: propertyType,
                  ...(propertyType === "select"
                    ? {
                        options: options
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      }
                    : {}),
                },
              ],
            });
            setPropertyForm(false);
            setPropertyName("");
          }}
        >
          <input
            aria-label="プロパティ名"
            placeholder="プロパティ名"
            value={propertyName}
            onChange={(e) => setPropertyName(e.target.value)}
            autoFocus
          />
          <select
            aria-label="プロパティの種類"
            value={propertyType}
            onChange={(e) =>
              setPropertyType(e.target.value as Property["type"])
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
              value={options}
              onChange={(e) => setOptions(e.target.value)}
              placeholder="選択肢をカンマ区切り"
            />
          )}
          <button type="submit" className="primary">
            追加
          </button>
        </form>
      )}
      {view.type === "table" &&
        (view.groupBy ? (
          <div className="db-groups">
            {groupedRows.map((group) => (
              <section
                key={group.key}
                className="db-group"
                style={{ marginTop: 10 }}
              >
                <h4 style={{ margin: "4px 16px" }}>
                  {group.label || "グループ"}{" "}
                  <small>{group.rows.length}</small>
                </h4>
                {table(group.rows)}
              </section>
            ))}
          </div>
        ) : (
          table(rows)
        ))}
      {view.type === "board" &&
        (boardPropertyId ? (
          <div className="board">
            {boardGroups.map((group) => (
              <section
                key={group.key}
                className="board-column"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  const row = value.rows.find(
                    (r) =>
                      r.id ===
                      e.dataTransfer.getData("application/x-folio-row"),
                  );
                  if (row)
                    setRowValue(
                      row,
                      boardPropertyId,
                      group.value === undefined
                        ? propertyKind(value, boardPropertyId) === "checkbox"
                          ? false
                          : ""
                        : group.value,
                    );
                }}
              >
                <h4>
                  <span className="status-dot" />
                  {group.label || "未設定"}{" "}
                  <small>{group.rows.length}</small>
                </h4>
                {group.rows.map(card)}
                {boardPropertyId !== "title" && (
                  <button
                    className="new-row"
                    onClick={() =>
                      add({
                        [boardPropertyId]:
                          group.value === undefined
                            ? propertyKind(value, boardPropertyId) ===
                              "checkbox"
                              ? false
                              : ""
                            : group.value,
                      })
                    }
                  >
                    ＋ 新規
                  </button>
                )}
              </section>
            ))}
          </div>
        ) : (
          <p className="empty">
            セレクト型のプロパティを追加すると、ボードを使えます。
          </p>
        ))}
      {view.type === "gallery" &&
        (view.groupBy ? (
          <div className="db-groups">
            {groupedRows.map((group) => (
              <section key={group.key} className="db-group">
                <h4 style={{ margin: "4px 16px" }}>
                  {group.label || "グループ"}{" "}
                  <small>{group.rows.length}</small>
                </h4>
                <div className="gallery">{group.rows.map(card)}</div>
              </section>
            ))}
          </div>
        ) : (
          <div className="gallery">{rows.map(card)}</div>
        ))}
      {view.type === "calendar" &&
        (calendarProperty ? (
          <>
            <div className="month-nav">
              <button
                aria-label="前の月"
                onClick={() => {
                  const d = new Date(month + "-15T12:00:00");
                  d.setMonth(d.getMonth() - 1);
                  setMonth(d.toLocaleDateString("sv-SE").slice(0, 7));
                }}
              >
                <ArrowLeft size={15} />
              </button>
              <strong>{month.replace("-", "年 ")}月</strong>
              <button
                aria-label="次の月"
                onClick={() => {
                  const d = new Date(month + "-15T12:00:00");
                  d.setMonth(d.getMonth() + 1);
                  setMonth(d.toLocaleDateString("sv-SE").slice(0, 7));
                }}
              >
                <ArrowRight size={15} />
              </button>
            </div>
            <div className="calendar">
              {["日", "月", "火", "水", "木", "金", "土"].map((d) => (
                <div className="weekday" key={d}>
                  {d}
                </div>
              ))}
              {monthDays(month).map((day) => (
                <div
                  className={"day " + (!day.startsWith(month) ? "muted" : "")}
                  key={day}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    const r = value.rows.find(
                      (r) =>
                        r.id ===
                        e.dataTransfer.getData("application/x-folio-row"),
                    );
                    if (r) setRowValue(r, calendarProperty.id, day);
                  }}
                >
                  <button
                    className="day-number"
                    onClick={() => add({ [calendarProperty.id]: day })}
                  >
                    {Number(day.slice(-2))}
                  </button>
                  {rows
                    .filter(
                      (r) =>
                        String(r.values[calendarProperty.id] ?? "") === day,
                    )
                    .map(card)}
                </div>
              ))}
            </div>
            <p className="db-count">
              日付未設定：
              {rows.filter((r) => !r.values[calendarProperty.id]).length}{" "}
              件（テーブルで編集できます）
            </p>
          </>
        ) : (
          <p className="empty">日付型のプロパティを追加してください。</p>
        ))}
      <p className="db-count">
        {rows.length} / {value.rows.length} アイテム
      </p>
      {active && (
        <Modal
          name="アイテムを編集"
          className="record-modal"
          onClose={() => setEditing(null)}
        >
          <div className="modal-header">
            <span>アイテム</span>
            <button aria-label="閉じる" onClick={() => setEditing(null)}>
              完了
            </button>
          </div>
          <input
            className="record-title"
            data-initial-focus
            aria-label="アイテムのタイトル"
            value={active.title}
            onChange={(e) => update(active.id, { title: e.target.value })}
          />
          {value.properties.map((p) => (
            <label className="record-field" key={p.id}>
              <span>{p.name}</span>
              {cell(active, p)}
            </label>
          ))}
        </Modal>
      )}
    </div>
  );
}
