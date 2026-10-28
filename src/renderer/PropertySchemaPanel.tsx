import type { DatabaseSettings, FilterValue, Property } from "../shared/types";
import type { PropertyChange, PropertyPreviewResult } from "../shared/property-operation";
import { canonicalOperation } from "../shared/save-contract";
import { editPropertyDraft, newPropertyDraft, propertyChangeFromDraft, type PropertySchemaDraft } from "./property-schema-draft";
import "./property-schema-panel.css";

export type PropertySchemaStatus = "idle" | "previewing" | "ready" | "saving" | "unknown" | "rejected" | "applied";
export type PropertySchemaPanelProps = {
  settings: DatabaseSettings;
  draft: PropertySchemaDraft | null;
  preview?: PropertyPreviewResult;
  status: PropertySchemaStatus;
  error?: string;
  onDraftChange: (draft: PropertySchemaDraft | null) => void;
  onPreview: (change: PropertyChange) => void;
  onApply: () => void;
  onResolve: () => void;
};
const labels: Record<Property["type"], string> = {text: "テキスト", number: "数値", checkbox: "チェックボックス", date: "日付", select: "セレクト"};
const statuses: Record<PropertySchemaStatus, string> = {idle: "", previewing: "変更内容を確認中…", ready: "変更内容を確認してください。",
  saving: "列の変更を保存中…", unknown: "保存結果を確認できません。同じ操作の結果を照会してください。",
  rejected: "列は変更されていません。内容を見直してください。", applied: "列の変更を保存しました。"};
const shown = (value: FilterValue | undefined) => value === undefined ? "未設定" : JSON.stringify(value);

/** Form text, preview and operation identity are all owned by App. */
export function PropertySchemaPanel({settings, draft, preview, status, error, onDraftChange, onPreview, onApply, onResolve}: PropertySchemaPanelProps) {
  const locked = ["previewing", "saving", "unknown", "applied"].includes(status);
  let change: PropertyChange | undefined;
  if (draft) {try {change = propertyChangeFromDraft(draft);} catch { /* Keep raw form text visible. */ }}
  const currentPreview = !!change && !!preview?.command && canonicalOperation(change) === canonicalOperation(preview.command.change);
  const canApply = !locked && preview?.ok && currentPreview;
  const patch = (values: Partial<PropertySchemaDraft>) => {if (draft) onDraftChange({...draft, ...values});};
  return <section className="r6-schema" aria-label="列の設定" data-property-state={status}>
    <p role={error || status === "unknown" || status === "rejected" ? "alert" : "status"}>{error || statuses[status]}</p>
    {status === "unknown" && <button type="button" onClick={onResolve}>列変更の保存結果を確認</button>}
    <fieldset disabled={locked}>
      <legend>列を選択</legend>
      <ul className="r6-property-list">{settings.properties.map((property) => <li key={property.id} data-property-id={property.id}>
        <span>{property.name}<small>{labels[property.type]}</small></span>
        <button type="button" aria-label={`列名を変更 ${property.name}`} onClick={() => onDraftChange(editPropertyDraft(property, "rename"))}>名前を変更</button>
        <button type="button" aria-label={`列の型を変更 ${property.name}`} onClick={() => onDraftChange(editPropertyDraft(property, "changeType"))}>型・選択肢を変更</button>
      </li>)}</ul>
      <button type="button" onClick={() => onDraftChange(newPropertyDraft())}>列を追加</button>
    </fieldset>
    {draft && <fieldset disabled={locked} className="r6-property-form">
      <legend>{draft.kind === "add" ? "列を追加" : draft.kind === "rename" ? "列名を変更" : "型・選択肢を変更"}</legend>
      <label>列名<input aria-label="列名" value={draft.name} maxLength={200} disabled={draft.kind === "changeType"}
        onChange={(event) => patch({name: event.target.value})} /></label>
      <label>型<select aria-label="列の型" value={draft.type} disabled={draft.kind === "rename"}
        onChange={(event) => patch({type: event.target.value as Property["type"]})}>
        {(Object.keys(labels) as Property["type"][]).map((type) => <option key={type} value={type}>{labels[type]}</option>)}
      </select></label>
      {draft.type === "select" && draft.kind !== "rename" && <label>選択肢（1行に1つ）
        <textarea aria-label="列の選択肢" value={draft.optionsText} onChange={(event) => patch({optionsText: event.target.value})} />
        <small>空行・重複は使えません。表記は入力どおりに保存します。</small>
      </label>}
      {draft.kind === "changeType" && <p>すべての所属行を確認します。変換できない値は削除せず、変更全体を中止します。</p>}
      <div className="r6-schema-actions">
        <button type="button" disabled={!change} onClick={() => {if (change) onPreview(change);}}>変更をプレビュー</button>
        <button type="button" onClick={() => onDraftChange(null)}>編集を取り消す</button>
      </div>
    </fieldset>}
    {preview && <section className="r6-schema-preview" aria-label="列変更のプレビュー">
      <h3>{preview.ok ? "適用する変更" : "変更できない理由"}</h3>
      <p>{preview.recordCount} 行を確認、値の変換 {preview.changedCount} 件。</p>
      {preview.requiresBackup && <p>適用時にSQLiteバックアップを作成・検証します。未設定・ゴミ箱内も含む所属行の版を更新します。</p>}
      {!!preview.issues.length && <div role="alert"><ul>{preview.issues.slice(0, 100).map((item, i) => <li key={i}>
        {item.title ? `${item.title}: ` : ""}{item.message}</li>)}</ul>
        {preview.issues.length > 100 && <p>ほか {preview.issues.length - 100} 件の問題があります。</p>}</div>}
      {!!preview.warnings.length && <ul>{preview.warnings.map((item, i) => <li key={i}>{item.message}</li>)}</ul>}
      {!!preview.changes.length && <div className="r6-conversion-scroll"><table>
        <thead><tr><th>ページ</th><th>現在の値</th><th>変換後</th></tr></thead>
        <tbody>{preview.changes.slice(0, 100).map((entry) => <tr key={entry.pageId}>
          <td>{entry.title || "無題"}{entry.deleted ? "（ゴミ箱）" : ""}</td><td>{shown(entry.before)}</td>
          <td>{Object.hasOwn(entry, "after") ? shown(entry.after) : entry.before === undefined ? "未設定を保持" : "変換不可"}</td>
        </tr>)}</tbody></table>
        {preview.changes.length > 100 && <p>先頭100行を表示しています。全 {preview.changes.length} 行を検査済みです。</p>}
      </div>}
      <button type="button" className="primary" disabled={!canApply} onClick={onApply}>この変更を適用</button>
      {preview.ok && !currentPreview && <p>入力が変わりました。もう一度プレビューしてください。</p>}
    </section>}
  </section>;
}
