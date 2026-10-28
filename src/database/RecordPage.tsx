import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Copy,
  RefreshCw,
  RotateCcw,
  Trash2,
  Maximize2,
  PanelRight,
  X,
} from "lucide-react";
import { composing } from "../shared/keyboard";
import type { FilterValue, Property, RecordProjection } from "../shared/types";
import { draftValueFor, type RecordDraft } from "./database-ui";
import { PropertyField } from "./PropertyField";
import "./database.css";
import "./record-page.css";

export type RecordSaveState =
  "idle" | "saving" | "saved" | "error" | "conflict" | "unknown" | "blocked";
export type RecordPageMode = "side" | "full";
export type RecordReadOnlyReason =
  "trashed" | "database-trashed" | "document-error" | null;

export type RecordPageProps = {
  /** Page identity of the record (never a legacy row id). */
  pageId: string;
  /** Last acknowledged read-only projection. */
  record: RecordProjection;
  /** Unsaved title/values owned by Core's PendingEdits. */
  draft: RecordDraft;
  properties: readonly Property[];
  /** Omit for legacy all-type editing; Core advertises the supported R4 types. */
  editablePropertyTypes?: readonly Property["type"][];
  /** Raw numeric form text belongs to App, including incomplete '-' / '.'. */
  propertyInputTexts?: Readonly<Record<string, string>>;
  onPropertyInputTextChange?: (propertyId: string, text: string) => void;
  saveState?: RecordSaveState;
  error?: string;
  readOnly?: RecordReadOnlyReason;
  onBack: () => void;
  /** Omit for the legacy inline surface. Both modes preserve the same body slot. */
  mode?: RecordPageMode;
  onModeChange?: (mode: RecordPageMode) => void;
  /** Parent owns origin row, scroll and focus restoration. */
  onClose?: () => void;
  /** Core also applies this lock to the Editor passed as body. */
  editingBlocked?: boolean;
  /** Query the original operation. This is never an unconditional resend. */
  onResolve?: () => void;
  onTitleChange: (title: string) => void;
  onValueChange: (propertyId: string, value: FilterValue | null) => void;
  onRetry?: () => void;
  onDuplicate?: () => void;
  onTrash?: () => void;
  onRestore?: () => void;
  /** Focus the Editor body for Core's Enter/Tab handoff. */
  focusBody?: () => void;
  /** Core mounts the single active Editor here. */
  body: ReactNode;
  autoFocusTitle?: boolean;
};

/**
 * Controlled record surface with inline, side-peek and full-page layouts. Core owns navigation, PendingEdits,
 * the Editor, errors and recovery; this component renders the acknowledged
 * projection plus Core's unsaved draft and exposes display-only actions.
 */
export function RecordPage({
  pageId,
  record,
  draft,
  properties,
  editablePropertyTypes,
  propertyInputTexts,
  onPropertyInputTextChange,
  saveState = "idle",
  error,
  readOnly = null,
  onBack,
  mode,
  onModeChange,
  onClose,
  editingBlocked = false,
  onResolve,
  onTitleChange,
  onValueChange,
  onRetry,
  onDuplicate,
  onTrash,
  onRestore,
  focusBody,
  body,
  autoFocusTitle = true,
}: RecordPageProps) {
  const root = useRef<HTMLElement>(null);
  const title = useRef<HTMLInputElement>(null);
  const openSelect = useRef<HTMLSelectElement | null>(null);
  const locked = readOnly !== null || editingBlocked;
  const close = onClose ?? onBack;

  useEffect(() => {
    if (autoFocusTitle && !locked) title.current?.focus();
    // Focus once per opened record; later state changes must not steal focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  const focusBodyOrControl = () => {
    if (focusBody) {
      focusBody();
      return;
    }
    const editor =
      root.current?.querySelector<HTMLElement>(
        "[data-record-body] [contenteditable='true'], [data-record-body] .folio-editor",
      ) ?? null;
    if (editor) {
      editor.focus();
      return;
    }
    const first = root.current?.querySelector<HTMLElement>(
      "[data-record-field] input:not([disabled]), [data-record-field] select:not([disabled]), [data-record-field] button:not([disabled])",
    );
    (
      first ?? root.current?.querySelector<HTMLElement>("[data-record-body]")
    )?.focus();
  };

  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    if (composing(event.nativeEvent)) return;
    const target = event.target as HTMLElement;
    if (event.key === "Escape") {
      if (openSelect.current) {
        openSelect.current = null;
        return;
      }
      if (
        target.closest(
          "[role='dialog'], dialog[open], [role='menu'], [role='listbox']",
        ) ||
        root.current?.querySelector(
          ".slash-menu, .block-actions, [role='menu']",
        )
      )
        return;
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Enter" && target === title.current) {
      event.preventDefault();
      focusBodyOrControl();
    }
  };

  const notice =
    readOnly === "trashed"
      ? "このレコードはゴミ箱にあります。復元するまで本文とプロパティは編集できません。"
      : readOnly === "database-trashed"
        ? "所属しているデータベースがゴミ箱にあります。先にデータベースを復元してください。"
        : readOnly === "document-error"
          ? "本文を読み込めないため、このレコードは読み取り専用です。原本は変更していません。"
          : "";

  return (
    <article
      className={"r3-record-page" + (mode ? " r4-record-surface" : "")}
      data-record-mode={mode}
      data-editing-blocked={locked || undefined}
      aria-label="レコードページ"
      aria-busy={saveState === "saving"}
      data-record-id={pageId}
      data-read-only={readOnly ?? undefined}
      ref={root}
      onKeyDown={keyDown}
      onPointerDownCapture={(event) => {
        if (event.target instanceof HTMLSelectElement)
          openSelect.current = event.target;
      }}
      onKeyDownCapture={(event) => {
        // ProseMirror consumes even an otherwise unused Escape. Handle the
        // surface close before it, while leaving its menus and block selection
        // first refusal and ignoring composition.
        if (event.key === "Escape" && !composing(event.nativeEvent) &&
            (event.target as HTMLElement).closest(".folio-editor") &&
            !root.current?.querySelector(".slash-menu, .block-actions, [role='menu'], [role='listbox'], dialog[open], [role='dialog']")) {
          event.preventDefault();
          event.stopPropagation();
          close();
          return;
        }
        if (
          event.target instanceof HTMLSelectElement &&
          (event.key === " " ||
            event.key === "Enter" ||
            (event.key === "ArrowDown" && event.altKey))
        )
          openSelect.current = event.target;
      }}
      onChangeCapture={(event) => {
        if ((event.target as EventTarget) === openSelect.current)
          openSelect.current = null;
      }}
      onBlurCapture={(event) => {
        if ((event.target as EventTarget) === openSelect.current)
          openSelect.current = null;
      }}
    >
      <header className="r3-record-header">
        <button
          type="button"
          className="r3-record-back"
          aria-label="データベースに戻る"
          onClick={onBack}
        >
          <ArrowLeft size={15} aria-hidden="true" />
          戻る
        </button>
        <span
          className="r3-record-save"
          role="status"
          aria-live="polite"
          data-save-state={saveState}
        >
          {saveState === "saving"
            ? "保存中…"
            : saveState === "saved"
              ? "保存済み"
              : saveState === "unknown"
                ? "保存結果を確認できません"
                : saveState === "conflict"
                  ? "変更が競合しています"
                  : saveState === "blocked"
                    ? "保存を停止しています"
                    : saveState === "error"
                      ? "未保存の変更があります"
                      : ""}
        </span>
        <span className="r3-record-header-spacer" />
        {mode && onModeChange && (
          <button
            type="button"
            className="r3-record-action r4-record-mode"
            aria-label={mode === "side" ? "全画面で開く" : "サイドピークで開く"}
            title={mode === "side" ? "全画面で開く" : "サイドピークで開く"}
            onClick={() => onModeChange(mode === "side" ? "full" : "side")}
          >
            {mode === "side" ? (
              <Maximize2 size={16} aria-hidden="true" />
            ) : (
              <PanelRight size={16} aria-hidden="true" />
            )}
          </button>
        )}
        {mode && (
          <button
            type="button"
            className="r3-record-action r4-record-close"
            aria-label="レコードを閉じる"
            title="閉じる (Esc)"
            onClick={close}
          >
            <X size={17} aria-hidden="true" />
          </button>
        )}
        {onDuplicate && (
          <button
            type="button"
            className="r3-record-action"
            aria-label="レコードを複製"
            disabled={locked}
            onClick={onDuplicate}
          >
            <Copy size={14} aria-hidden="true" />
            複製
          </button>
        )}
        {onTrash && record.deletedAt === null && (
          <button
            type="button"
            className="r3-record-action r3-record-danger"
            aria-label="レコードをゴミ箱へ"
            disabled={locked}
            onClick={onTrash}
          >
            <Trash2 size={14} aria-hidden="true" />
            ゴミ箱へ
          </button>
        )}
        {onRestore && record.deletedAt !== null && (
          <button
            type="button"
            className="r3-record-action"
            aria-label="レコードを復元"
            onClick={onRestore}
          >
            <RotateCcw size={14} aria-hidden="true" />
            復元
          </button>
        )}
      </header>

      {notice && (
        <div
          className={
            "r3-record-banner" +
            (readOnly === "trashed" ? " r3-record-banner-warning" : "")
          }
          role={readOnly === "trashed" ? "status" : "alert"}
        >
          <AlertTriangle size={15} aria-hidden="true" />
          <span>{notice}</span>
        </div>
      )}

      {["error", "conflict", "unknown", "blocked"].includes(saveState) && (
        <div className="r3-record-alert" role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>
            {error ||
              (saveState === "unknown"
                ? "保存結果を確認できません。入力内容を保持して、後続の保存を停止しています。"
                : saveState === "conflict"
                  ? "別の変更と競合しました。入力内容を保持して、保存を停止しています。"
                  : saveState === "blocked"
                    ? "入力内容を保持しています。保存を再開できる状態になるまでお待ちください。"
                    : "保存に失敗しました。入力内容は保持されています。")}
          </span>
          {saveState === "unknown" && onResolve && (
            <button
              type="button"
              className="r3-record-action"
              onClick={onResolve}
            >
              <RefreshCw size={14} aria-hidden="true" />
              保存結果を確認
            </button>
          )}
          {saveState === "error" && onRetry && (
            <button
              type="button"
              className="r3-record-action"
              aria-label="保存を再試行"
              onClick={onRetry}
            >
              <RefreshCw size={14} aria-hidden="true" />
              再試行
            </button>
          )}
        </div>
      )}

      <div className="r3-record-icon" aria-hidden="true">
        {record.icon || "📄"}
      </div>
      <input
        ref={title}
        className="r3-record-title"
        aria-label="レコードのタイトル"
        placeholder="無題"
        maxLength={500}
        value={draft.title}
        disabled={locked}
        onChange={(event) => onTitleChange(event.target.value)}
      />
      <div className="r3-record-meta">
        <span className="r3-record-kind">データベースのレコード</span>
        {locked && <span className="r3-record-readonly">読み取り専用</span>}
      </div>

      <section className="r3-record-properties" aria-label="プロパティ">
        {properties.length ? (
          <dl>
            {properties.map((property) => {
              const id = "record-property-" + pageId + "-" + property.id;
              return (
                <div
                  className="r3-record-property"
                  key={property.id}
                  data-record-field
                >
                  <dt>
                    <label htmlFor={id}>{property.name}</label>
                  </dt>
                  <dd>
                    <PropertyField
                      id={id}
                      property={property}
                      value={draftValueFor(draft, record, property.id)}
                      inputText={propertyInputTexts?.[property.id]}
                      onInputTextChange={
                        onPropertyInputTextChange
                          ? (text) =>
                              onPropertyInputTextChange(property.id, text)
                          : undefined
                      }
                      disabled={
                        locked ||
                        (editablePropertyTypes !== undefined &&
                          !editablePropertyTypes.includes(property.type))
                      }
                      onChange={(value) => onValueChange(property.id, value)}
                    />
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : (
          <p className="r3-record-empty">プロパティはありません。</p>
        )}
      </section>

      <section
        className="r3-record-body"
        aria-label="本文"
        data-record-body
        tabIndex={-1}
      >
        {body}
      </section>
    </article>
  );
}
