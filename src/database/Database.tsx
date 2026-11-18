import { useEffect, useRef, useState } from "react";
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
  ArrowUpDown,
  Filter,
  MoreHorizontal,
  X,
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
} from "./model";
import { FilterBuilder } from "./FilterBuilder";
import { SettingsMenu } from "./settings-menu/SettingsMenu";
import { summarizeView } from "./settings-menu/summaries";
import { searchDisclosureAction } from "./DatabaseSettingsPanel";
import "./database-settings-panel.css";
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
const titleProperty: Property = { id: "title", name: "名前", type: "text" };

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
    [searchOpen, setSearchOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!searchOpen) return;
    searchInput.current?.focus();
  }, [searchOpen]);

  const view = activeView(value);
  const rows = queryRows(value);
  const summary = summarizeView(view, [titleProperty, ...value.properties]);
  const searchVisible = searchOpen || view.filterText.length > 0;
  const openSearch = () => setSearchOpen(true);
  const closeSearch = () => {
    setSearchOpen(false);
    searchToggle.current?.focus();
  };
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
    <div className="database legacy-database" data-legacy-database="true">
      <div className="db-tabs" role="tablist" aria-label="保存するビュー">
        {value.views.map((candidate) => {
          const Icon = VIEW_ICONS[candidate.type];
          return (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              aria-selected={candidate.id === view.id}
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
        <label className="r7-add-view db-add-view">
          <span className="r5-visually-hidden">新しいビュー</span>
          <select
            aria-label="ビューを追加"
            title="ビューを追加"
            value=""
            onChange={(e) => {
              const type = e.target.value as DatabaseViewType;
              if (VIEW_TYPES.includes(type))
                onChange(addView(value, type, { copyActive: true }));
            }}
          >
            <option value="" disabled>
              ＋ ビュー
            </option>
            {VIEW_TYPES.map((type) => (
              <option value={type} key={type}>
                {VIEW_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="db-command-row r7-condition-row">
        <button
          type="button"
          disabled={!undoStack.current.length}
          onClick={() => {
            const previous = undoStack.current.pop();
            if (previous) persist(previous);
          }}
        >
          DB変更を元に戻す
        </button>
        <button
          ref={searchToggle}
          type="button"
          className="r7-search-toggle"
          aria-label="検索"
          title="検索"
          aria-expanded={searchVisible}
          data-search-toggle="search"
          onClick={() => (searchOpen ? closeSearch() : openSearch())}
        >
          <span>検索</span>
        </button>
        <label
          className="r5-view-search r7-view-search"
          data-search-open={searchVisible ? "true" : "false"}
          hidden={!searchVisible}
        >
          <span className="r5-visually-hidden">検索</span>
          <input
            ref={searchInput}
            aria-label="ビュー内検索"
            value={view.filterText}
            maxLength={10_000}
            placeholder="名前・プロパティから絞り込む"
            onChange={(e) => changeView({ filterText: e.target.value })}
            onKeyDown={(e) => {
              if (searchDisclosureAction(e) === "ignore") return;
              e.preventDefault();
              e.stopPropagation();
              closeSearch();
            }}
          />
          {!view.filterText && (
            <button
              type="button"
              className="r7-search-dismiss"
              aria-label="検索を閉じる"
              title="検索を閉じる"
              onClick={closeSearch}
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </label>
        <SettingsMenu
          name="filter"
          label={
            summary.filters.length
              ? `フィルター（${summary.filters.length}件の条件）`
              : "フィルター"
          }
          panelLabel="ビューのフィルター"
          className="r7-menu--filter"
          panelClassName="r7-filter-panel"
          trigger={
            <>
              <Filter size={15} aria-hidden="true" />
              <span>フィルター</span>
              {summary.filters.length > 0 && (
                <span className="r7-menu-count" aria-hidden="true">
                  {summary.filters.length}
                </span>
              )}
            </>
          }
        >
          {(close) => (
            <>
              <div className="r7-panel-heading">
                <h4>フィルター</h4>
                <button
                  type="button"
                  className="r7-panel-close"
                  aria-label="フィルターを閉じる"
                  title="閉じる"
                  onClick={() => close(true)}
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </div>
              <FilterBuilder
                data={value}
                view={view}
                onChange={(filter) => changeView({ filter })}
              />
            </>
          )}
        </SettingsMenu>
        <SettingsMenu
          name="sort"
          label={
            summary.sorts.length
              ? `並べ替えとグループ（${summary.sorts.length}件の並べ替え${summary.group ? "・グループあり" : ""}）`
              : "並べ替えとグループ"
          }
          panelLabel="ビューの並べ替えとグループ"
          className="r7-menu--sort"
          panelClassName="r7-sort-panel"
          trigger={
            <>
              <ArrowUpDown size={15} aria-hidden="true" />
              <span>並べ替え</span>
              {summary.sorts.length > 0 && (
                <span className="r7-menu-count" aria-hidden="true">
                  {summary.sorts.length}
                </span>
              )}
              {summary.group && (
                <span className="r7-menu-group-mark" aria-hidden="true">
                  グループ
                </span>
              )}
            </>
          }
        >
          {(close) => (
            <>
              <div className="r7-panel-heading">
                <h4>並べ替えとグループ</h4>
                <button
                  type="button"
                  className="r7-panel-close"
                  aria-label="並べ替えとグループを閉じる"
                  title="閉じる"
                  onClick={() => close(true)}
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </div>
              <section aria-label="ビューの並べ替え">
                <h4>並べ替え</h4>
                {view.sorts.map((sort, at) => (
                  <div className="r5-sort-row" key={sort.id}>
                    <span>{at + 1}</span>
                    <select
                      aria-label={`並べ替え対象 ${at + 1}`}
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
                      aria-label={`並べ替え方向 ${at + 1}`}
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
                      type="button"
                      aria-label={`並べ替えを削除 ${at + 1}`}
                      onClick={() => removeSort(sort.id)}
                    >
                      削除
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  aria-label="並べ替えを追加"
                  onClick={addSort}
                >
                  ＋ 並べ替えを追加
                </button>
              </section>
              <section aria-label="ビューのグループ">
                <h4>グループ</h4>
                <div className="r5-group-row">
                  <select
                    aria-label="グループの対象"
                    value={view.groupBy?.propertyId ?? ""}
                    onChange={(e) =>
                      changeView({
                        groupBy: e.target.value
                          ? { propertyId: e.target.value, direction: "asc" }
                          : null,
                      })
                    }
                  >
                    <option value="">グループなし</option>
                    <option value="title">名前</option>
                    {value.properties.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  {view.groupBy && (
                    <select
                      aria-label="グループの順序"
                      value={view.groupBy.direction}
                      onChange={(e) =>
                        changeView({
                          groupBy: {
                            ...view.groupBy!,
                            direction: e.target.value as "asc" | "desc",
                          },
                        })
                      }
                    >
                      <option value="asc">昇順</option>
                      <option value="desc">降順</option>
                    </select>
                  )}
                </div>
              </section>
            </>
          )}
        </SettingsMenu>
        <button
          type="button"
          className="primary"
          aria-label="新規行"
          onClick={() => add()}
        >
          <Plus size={14} aria-hidden="true" />
          新規行
        </button>
        <SettingsMenu
          name="view-options"
          label="ビューのオプション"
          panelLabel="ビューのオプション"
          className="r7-view-options"
          panelClassName="r7-view-options-panel"
          trigger={
            <>
              <MoreHorizontal size={16} aria-hidden="true" />
              <span className="r7-trigger-text">オプション</span>
            </>
          }
        >
          {(close) => (
            <>
              <div className="r7-panel-heading">
                <h4>ビューのオプション</h4>
                <button
                  type="button"
                  className="r7-panel-close"
                  aria-label="ビューのオプションを閉じる"
                  title="閉じる"
                  onClick={() => close(true)}
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </div>
              <div className="r7-option-fields">
                <label className="r5-view-name">
                  ビュー名
                  <input
                    aria-label="ビュー名"
                    value={view.name}
                    maxLength={200}
                    onChange={(e) =>
                      onChange(renameView(value, view.id, e.target.value))
                    }
                  />
                </label>
                <label>
                  表示形式
                  <select
                    aria-label="ビューの表示形式"
                    value={view.type}
                    onChange={(e) =>
                      changeView({
                        type: e.target.value as DatabaseViewType,
                      })
                    }
                  >
                    {VIEW_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {VIEW_TYPE_LABELS[type]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="r7-option-actions">
                <button
                  type="button"
                  aria-label="ビューを複製"
                  disabled={value.views.length >= 100}
                  onClick={() => onChange(duplicateView(value, view.id))}
                >
                  複製
                </button>
                <button
                  type="button"
                  aria-label="ビューを左へ移動"
                  disabled={value.views[0]?.id === view.id}
                  onClick={() => onChange(moveView(value, view.id, -1))}
                >
                  左へ
                </button>
                <button
                  type="button"
                  aria-label="ビューを右へ移動"
                  disabled={value.views.at(-1)?.id === view.id}
                  onClick={() => onChange(moveView(value, view.id, 1))}
                >
                  右へ
                </button>
                <button
                  type="button"
                  aria-label="ビューを削除"
                  disabled={value.views.length <= 1}
                  onClick={() => onChange(deleteView(value, view.id))}
                >
                  削除
                </button>
              </div>
              <section className="r7-schema-section" aria-label="プロパティを編集">
                <h4>プロパティを編集</h4>
                <button
                  type="button"
                  aria-expanded={propertyForm}
                  onClick={() => setPropertyForm(!propertyForm)}
                >
                  ＋ プロパティ
                </button>
                <form
                  className="property-form"
                  hidden={!propertyForm}
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
              </section>
            </>
          )}
        </SettingsMenu>
      </div>
      {summary.activeCount > 0 && (
        <div
          className="r7-active-conditions"
          role="group"
          aria-label="適用中の表示条件"
          title={
            summary.filterExpression
              ? `フィルター: ${summary.filterExpression}`
              : undefined
          }
        >
          <span className="r7-active-label" aria-hidden="true">
            条件
          </span>
          <span className="r7-condition-count" data-condition-count="filters">
            フィルター {summary.filters.length}件
          </span>
          <span className="r7-condition-count" data-condition-count="sorts">
            並べ替え {summary.sorts.length}件
          </span>
          {summary.group && (
            <span className="r7-condition-count" data-condition-count="group">
              グループ 1件
            </span>
          )}
          <details className="r7-condition-details">
            <summary>条件を確認</summary>
            <div className="r7-condition-detail-body">
              {summary.filters.length > 0 && (
                <section aria-label="フィルター条件の全文">
                  <h4>
                    フィルター（
                    {view.filter.conjunction === "and"
                      ? "すべて (AND)"
                      : "いずれか (OR)"}
                    ）
                  </h4>
                  <p className="r7-condition-expression">
                    {summary.filterExpression}
                  </p>
                  <ol className="r7-condition-list">
                    {summary.filters.map((chip) => (
                      <li
                        className="r7-summary-chip r7-summary-chip--filter"
                        key={`filter:${chip.id}`}
                      >
                        {chip.scope && (
                          <span className="r7-summary-scope">
                            {chip.scope}
                          </span>
                        )}
                        <span className="r7-summary-text">{chip.text}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              {summary.sorts.length > 0 && (
                <section aria-label="並べ替えの全文">
                  <h4>並べ替え</h4>
                  <ol className="r7-condition-list">
                    {summary.sorts.map((chip, at) => (
                      <li
                        className="r7-summary-chip r7-summary-chip--sort"
                        key={`sort:${chip.id}`}
                      >
                        <span className="r7-summary-kind">{at + 1}.</span>
                        <span className="r7-summary-text">{chip.text}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              {summary.group && (
                <section aria-label="グループ条件の全文">
                  <h4>グループ</h4>
                  <ol className="r7-condition-list">
                    <li className="r7-summary-chip r7-summary-chip--group">
                      <span className="r7-summary-kind">1.</span>
                      <span className="r7-summary-text">
                        {summary.group.text}
                      </span>
                    </li>
                  </ol>
                </section>
              )}
            </div>
          </details>
        </div>
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
