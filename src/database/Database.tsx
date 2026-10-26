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
import type { DatabaseData, Property, RecordRow } from "../shared/types";
import { queryRows, monthDays } from "./model";
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
    [editing, setEditing] = useState<string | null>(null);
  const rows = queryRows(value),
    status = value.properties.find((p) => p.type === "select"),
    date = value.properties.find((p) => p.type === "date");
  const update = (id: string, patch: Partial<RecordRow>) =>
    onChange({
      ...value,
      rows: value.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });
  const cell = (row: RecordRow, p: Property) => {
    const v = row.values[p.id] ?? "";
    const change = (val: string | number | boolean) =>
      update(row.id, { values: { ...row.values, [p.id]: val } });
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
  const add = (values: RecordRow["values"] = {}) => {
    const id = crypto.randomUUID();
    onChange({
      ...value,
      rows: [...value.rows, { id, title: "新しいアイテム", values }],
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
  return (
    <div className="database">
      <div className="db-tabs">
        {(
          [
            { id: "table", label: "テーブル", Icon: Table2 },
            { id: "board", label: "ボード", Icon: Columns3 },
            { id: "calendar", label: "カレンダー", Icon: CalendarDays },
            { id: "gallery", label: "ギャラリー", Icon: LayoutGrid },
          ] as const
        ).map(({ id, label, Icon }) => (
          <button
            key={id}
            className={value.view === id ? "active" : ""}
            onClick={() => onChange({ ...value, view: id })}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
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
          value={value.filter}
          onChange={(e) => onChange({ ...value, filter: e.target.value })}
        />
        <select
          aria-label="並べ替え"
          value={value.sort}
          onChange={(e) => onChange({ ...value, sort: e.target.value })}
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
        <div className="spacer" />
        <button onClick={() => setPropertyForm(!propertyForm)}>
          ＋ プロパティ
        </button>
        <button className="primary" onClick={() => add()}>
          <Plus size={14} />
          新規
        </button>
      </div>
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
      {value.view === "table" && (
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
              {rows.map((r) => (
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
      )}
      {value.view === "board" &&
        (status ? (
          <div className="board">
            {["", ...(status.options ?? [])].map((group) => (
              <section
                key={group}
                className="board-column"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  const row = value.rows.find(
                    (r) =>
                      r.id ===
                      e.dataTransfer.getData("application/x-folio-row"),
                  );
                  if (row)
                    update(row.id, {
                      values: { ...row.values, [status.id]: group },
                    });
                }}
              >
                <h4>
                  <span className="status-dot" />
                  {group || "未設定"}{" "}
                  <small>
                    {
                      rows.filter(
                        (r) => String(r.values[status.id] ?? "") === group,
                      ).length
                    }
                  </small>
                </h4>
                {rows
                  .filter((r) => String(r.values[status.id] ?? "") === group)
                  .map(card)}
                <button
                  className="new-row"
                  onClick={() => add({ [status.id]: group })}
                >
                  ＋ 新規
                </button>
              </section>
            ))}
          </div>
        ) : (
          <p className="empty">
            セレクト型のプロパティを追加すると、ボードを使えます。
          </p>
        ))}
      {value.view === "gallery" && (
        <div className="gallery">{rows.map(card)}</div>
      )}
      {value.view === "calendar" &&
        (date ? (
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
                    if (r)
                      update(r.id, { values: { ...r.values, [date.id]: day } });
                  }}
                >
                  <button
                    className="day-number"
                    onClick={() => add({ [date.id]: day })}
                  >
                    {Number(day.slice(-2))}
                  </button>
                  {rows.filter((r) => r.values[date.id] === day).map(card)}
                </div>
              ))}
            </div>
            <p className="db-count">
              日付未設定：{rows.filter((r) => !r.values[date.id]).length}{" "}
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
