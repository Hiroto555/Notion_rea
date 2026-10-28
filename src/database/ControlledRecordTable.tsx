import { ArrowUpRight, RefreshCw } from "lucide-react";
import type {
  Property,
  RecordPatch,
  RecordProjection,
} from "../shared/types";
import { PropertyField } from "./PropertyField";
import "./controlled-record-table.css";

export type RecordTableState = {
  status:
    | "idle"
    | "pending"
    | "saving"
    | "saved"
    | "conflict"
    | "unknown"
    | "blocked"
    | "error";
  error?: string;
  /** False until App has attached this record's read snapshot to a session. */
  editable?: boolean;
};

export type ControlledRecordTableProps = {
  databasePageId: string;
  /** Parent overlays its retained drafts; this component never owns a copy. */
  records: readonly RecordProjection[];
  properties: readonly Property[];
  states?: Readonly<Record<string, RecordTableState>>;
  inputTexts?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  onInputTextChange?: (
    pageId: string,
    propertyId: string,
    text: string,
  ) => void;
  onPatch: (pageId: string, patch: RecordPatch) => void;
  onOpenRecord: (pageId: string) => void;
  /** Keep a focused row in place while its filter/sort/group values change. */
  onEditingChange?: (pageId: string | null) => void;
  /** Resolve an existing operation. This never means resend with a new ID. */
  onResolve?: (pageId: string) => void;
};

const saveLabels: Record<RecordTableState["status"], string> = {
  idle: "",
  pending: "保存待ち",
  saving: "保存中…",
  saved: "保存済み",
  conflict: "競合・入力保持中",
  unknown: "保存結果を確認中",
  blocked: "編集できません",
  error: "保存できません",
};
const editableTypes: readonly Property["type"][] = [
  "text",
  "number",
  "checkbox",
  "select",
  "date",
];

/** Controlled live-editing surface. Save/session identity, sequence, queue,
 * failures and navigation stay in App's coordinator. No revision is inferred
 * or returned from these controls. Local settings writers are not mounted. */
export function ControlledRecordTable({
  databasePageId,
  records,
  properties,
  states = {},
  inputTexts = {},
  onInputTextChange,
  onPatch,
  onOpenRecord,
  onEditingChange,
  onResolve,
}: ControlledRecordTableProps) {
  if (
    records.some((record) => record.databasePageId !== databasePageId) ||
    new Set(records.map((record) => record.pageId)).size !== records.length
  )
    return <p role="alert">レコードの所属を確認できないため編集できません。</p>;
  const visible = records.filter((record) => record.deletedAt === null);

  return (
    <section className="r3-db r4-record-table" aria-label="レコードを編集">
      <div className="r3-db-scroll" data-record-table-scroll>
        <table className="r3-table">
          <thead>
            <tr>
              <th scope="col">名前</th>
              {properties.map((property) => (
                <th scope="col" key={property.id}>
                  {property.name}
                </th>
              ))}
              <th scope="col">保存状態</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((record) => {
              const state = states[record.pageId];
              const status = state?.status ?? "idle";
              const locked = state?.editable !== true ||
                ["conflict", "unknown", "blocked", "error"].includes(status);
              return (
                <tr
                  key={record.pageId}
                  data-record-id={record.pageId}
                  data-save-state={status}
                  aria-busy={status === "pending" || status === "saving"}
                  onFocusCapture={() => onEditingChange?.(record.pageId)}
                  onBlurCapture={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                      onEditingChange?.(null);
                  }}
                >
                  <td>
                    <div className="r4-record-name">
                      <input
                        className="r3-title-input"
                        aria-label={`名前 ${record.title || "無題"}`}
                        maxLength={500}
                        value={record.title}
                        disabled={locked}
                        placeholder="無題"
                        onChange={(event) =>
                          onPatch(record.pageId, { title: event.target.value })
                        }
                      />
                      <button
                        type="button"
                        className="r4-record-open"
                        aria-label={`開く ${record.title || "無題"}`}
                        data-record-open-id={record.pageId}
                        onClick={() => onOpenRecord(record.pageId)}
                      >
                        <ArrowUpRight size={15} aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                  {properties.map((property) => (
                    <td key={property.id} data-property-id={property.id}>
                      <PropertyField
                        property={property}
                        value={record.values[property.id]}
                        ariaLabel={`${property.name} ${record.title || "無題"}`}
                        disabled={locked || !editableTypes.includes(property.type)}
                        inputText={inputTexts[record.pageId]?.[property.id]}
                        onInputTextChange={onInputTextChange ? (text) =>
                          onInputTextChange(record.pageId, property.id, text)
                          : undefined}
                        onChange={(value) =>
                          onPatch(record.pageId, {
                            values: { [property.id]: value },
                          })
                        }
                      />
                    </td>
                  ))}
                  <td>
                    <div className="r4-record-status">
                      <span role="status" title={state?.error}>
                        {state?.error || saveLabels[status]}
                      </span>
                      {status === "unknown" && onResolve && (
                        <button
                          type="button"
                          aria-label={`保存結果を確認 ${record.title || "無題"}`}
                          onClick={() => onResolve(record.pageId)}
                        >
                          <RefreshCw size={13} aria-hidden="true" />
                          確認
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {visible.length === 0 && <p className="r3-empty">レコードがありません。</p>}
      <p className="r3-db-count">{visible.length} 件</p>
    </section>
  );
}
