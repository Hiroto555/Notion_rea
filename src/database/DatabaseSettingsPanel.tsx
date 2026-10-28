import { ArrowLeft, ArrowRight, Copy, RefreshCw, Trash2 } from "lucide-react";
import type { KeyboardEvent } from "react";
import type {
  DatabaseSettings,
  DatabaseView,
  DatabaseViewType,
  Property,
} from "../shared/types";
import type { SettingsIntent } from "../renderer/settings-intent";
import { composing } from "../shared/keyboard";
import { FilterBuilder } from "./FilterBuilder";
import { VIEW_TYPES, VIEW_TYPE_LABELS, newId } from "./model";
import {
  createViewIntent,
  duplicateViewIntent,
  viewPatchIntent,
} from "./settings-panel-intents";
import "./database-settings-panel.css";

export type DatabaseSettingsStatus =
  | "idle"
  | "pending"
  | "saving"
  | "saved"
  | "conflict"
  | "unknown"
  | "blocked"
  | "error"
  | "loading";
export type DatabaseSettingsPanelProps = {
  settings: DatabaseSettings;
  onIntent: (intent: SettingsIntent) => void;
  status?: DatabaseSettingsStatus;
  error?: string;
  onResolve?: () => void;
  /** Parent owns these raw numeric values across navigation and view changes. */
  filterInputTexts?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  onFilterInputTextChange?: (
    viewId: string,
    filterId: string,
    text: string,
  ) => void;
};

const statusLabels: Record<DatabaseSettingsStatus, string> = {
  idle: "",
  pending: "設定の保存待ち",
  saving: "設定を保存中…",
  saved: "設定を保存済み",
  conflict: "設定が競合しています。入力を保持しています。",
  unknown: "設定の保存結果が不明です。入力を保持しています。",
  blocked: "設定を編集できません。",
  error: "設定を保存できません。入力を保持しています。",
  loading: "設定を読み込み中…",
};
const titleProperty: Property = { id: "title", name: "名前", type: "text" };

/** Every value is rendered from the parent's current overlay. There are no
 * component-owned setting drafts, revisions, queues, retries or blur commits. */
export function DatabaseSettingsPanel({
  settings,
  onIntent,
  status = "idle",
  error,
  onResolve,
  filterInputTexts,
  onFilterInputTextChange,
}: DatabaseSettingsPanelProps) {
  const view = settings.views.find(
    (candidate) => candidate.id === settings.activeViewId,
  );
  if (!view) return <p role="alert">表示するビューを確認できません。</p>;
  const locked = [
    "loading",
    "conflict",
    "unknown",
    "blocked",
    "error",
  ].includes(status);
  const properties = [titleProperty, ...settings.properties];
  const data = { ...settings, rows: [] };
  const patch = (values: Partial<Omit<DatabaseView, "id">>) => {
    if (!locked) onIntent(viewPatchIntent(view, values));
  };
  const activate = (viewId: string) => {
    if (!locked && viewId !== settings.activeViewId)
      onIntent({ kind: "activeView", base: settings.activeViewId, viewId });
  };
  const index = settings.views.findIndex(
    (candidate) => candidate.id === view.id,
  );
  const move = (delta: -1 | 1) => {
    if (!locked)
      onIntent({
        kind: "moveView",
        viewId: view.id,
        delta,
        baseOrder: settings.views.map((candidate) => candidate.id),
        baseActive: settings.activeViewId,
      });
  };
  const tabKey = (event: KeyboardEvent<HTMLButtonElement>, at: number) => {
    if (composing(event.nativeEvent) || locked) return;
    const size = settings.views.length;
    const next =
      event.key === "ArrowRight"
        ? (at + 1) % size
        : event.key === "ArrowLeft"
          ? (at + size - 1) % size
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? size - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    activate(settings.views[next].id);
    const tabs =
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
        '[role="tab"]',
      );
    tabs?.[next]?.focus();
  };
  const nextSort = properties.find(
    (property) => !view.sorts.some((sort) => sort.propertyId === property.id),
  );
  const updateSort = (
    id: string,
    values: { propertyId?: string; direction?: "asc" | "desc" },
  ) =>
    patch({
      sorts: view.sorts.map((sort) =>
        sort.id === id ? { ...sort, ...values } : sort,
      ),
    });

  return (
    <section
      className="r5-settings"
      aria-label="データベースの表示設定"
      data-settings-state={status}
      aria-busy={status === "pending" || status === "saving"}
    >
      <div className="r5-settings-status">
        <span
          role={
            error || ["conflict", "unknown", "error"].includes(status)
              ? "alert"
              : "status"
          }
        >
          {error || statusLabels[status]}
        </span>
        {status === "unknown" && onResolve && (
          <button
            type="button"
            onClick={onResolve}
            aria-label="設定の保存結果を確認"
          >
            <RefreshCw size={14} aria-hidden="true" /> 保存結果を確認
          </button>
        )}
      </div>
      <fieldset disabled={locked} className="r5-settings-controls">
        <legend className="r5-visually-hidden">ビューと表示条件</legend>
        <div
          className="r5-view-tabs"
          role="tablist"
          aria-label="保存するビュー"
        >
          {settings.views.map((candidate, at) => (
            <button
              type="button"
              role="tab"
              key={candidate.id}
              aria-label={`ビュー: ${candidate.name || VIEW_TYPE_LABELS[candidate.type]}`}
              aria-selected={candidate.id === view.id}
              tabIndex={candidate.id === view.id ? 0 : -1}
              data-view-id={candidate.id}
              onClick={() => activate(candidate.id)}
              onKeyDown={(event) => tabKey(event, at)}
            >
              {candidate.name || VIEW_TYPE_LABELS[candidate.type]}
            </button>
          ))}
        </div>
        <div className="r5-view-toolbar">
          <label className="r5-view-name">
            ビュー名
            <input
              aria-label="ビュー名"
              value={view.name}
              maxLength={200}
              onChange={(event) => patch({ name: event.target.value })}
            />
          </label>
          <label>
            表示形式
            <select
              aria-label="ビューの表示形式"
              value={view.type}
              onChange={(event) =>
                patch({ type: event.target.value as DatabaseViewType })
              }
            >
              {VIEW_TYPES.map((type) => (
                <option value={type} key={type}>
                  {VIEW_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>
          <label>
            新しいビュー
            <select
              aria-label="ビューを追加"
              value=""
              onChange={(event) => {
                if (VIEW_TYPES.includes(event.target.value as DatabaseViewType))
                  onIntent(
                    createViewIntent(
                      settings,
                      event.target.value as DatabaseViewType,
                    ),
                  );
              }}
            >
              <option value="" disabled>
                ＋ ビューを追加
              </option>
              {VIEW_TYPES.map((type) => (
                <option value={type} key={type}>
                  {VIEW_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>
          <div className="r5-view-actions">
            <button
              type="button"
              aria-label="ビューを複製"
              title="ビューを複製"
              onClick={() => onIntent(duplicateViewIntent(settings, view.id))}
            >
              <Copy size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="ビューを左へ移動"
              title="ビューを左へ移動"
              disabled={index === 0}
              onClick={() => move(-1)}
            >
              <ArrowLeft size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="ビューを右へ移動"
              title="ビューを右へ移動"
              disabled={index === settings.views.length - 1}
              onClick={() => move(1)}
            >
              <ArrowRight size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="ビューを削除"
              title={
                settings.views.length <= 1
                  ? "最後のビューは削除できません"
                  : "ビューを削除"
              }
              disabled={settings.views.length <= 1}
              onClick={() =>
                onIntent({ kind: "deleteView", base: structuredClone(view) })
              }
            >
              <Trash2 size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
        <label className="r5-view-search">
          検索
          <input
            aria-label="ビュー内検索"
            value={view.filterText}
            maxLength={10_000}
            placeholder="名前・プロパティから絞り込む"
            onChange={(event) => patch({ filterText: event.target.value })}
          />
        </label>
        <details className="r5-display-options">
          <summary>フィルター・並べ替え・グループ</summary>
          <section aria-label="ビューのフィルター">
            <h3>フィルター</h3>
            <FilterBuilder
              data={data}
              view={view}
              onChange={(filter) => patch({ filter })}
              inputTexts={filterInputTexts?.[view.id]}
              onInputTextChange={
                onFilterInputTextChange
                  ? (filterId, text) =>
                      onFilterInputTextChange(view.id, filterId, text)
                  : undefined
              }
            />
          </section>
          <section aria-label="ビューの並べ替え">
            <h3>並べ替え</h3>
            {view.sorts.map((sort, at) => (
              <div className="r5-sort-row" key={sort.id}>
                <span>{at + 1}</span>
                <select
                  aria-label={`並べ替え対象 ${at + 1}`}
                  value={sort.propertyId}
                  onChange={(event) =>
                    updateSort(sort.id, { propertyId: event.target.value })
                  }
                >
                  {properties.map((property) => (
                    <option key={property.id} value={property.id}>
                      {property.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`並べ替え方向 ${at + 1}`}
                  value={sort.direction}
                  onChange={(event) =>
                    updateSort(sort.id, {
                      direction: event.target.value as "asc" | "desc",
                    })
                  }
                >
                  <option value="asc">昇順</option>
                  <option value="desc">降順</option>
                </select>
                <button
                  type="button"
                  aria-label={`並べ替えを削除 ${at + 1}`}
                  onClick={() =>
                    patch({
                      sorts: view.sorts.filter(
                        (candidate) => candidate.id !== sort.id,
                      ),
                    })
                  }
                >
                  削除
                </button>
              </div>
            ))}
            <button
              type="button"
              disabled={!nextSort}
              aria-label="並べ替えを追加"
              onClick={() => {
                if (nextSort)
                  patch({
                    sorts: [
                      ...view.sorts,
                      {
                        id: newId(),
                        propertyId: nextSort.id,
                        direction: "asc",
                      },
                    ],
                  });
              }}
            >
              ＋ 並べ替えを追加
            </button>
          </section>
          <section aria-label="ビューのグループ">
            <h3>グループ</h3>
            <div className="r5-group-row">
              <select
                aria-label="グループの対象"
                value={view.groupBy?.propertyId ?? ""}
                onChange={(event) =>
                  patch({
                    groupBy: event.target.value
                      ? {
                          propertyId: event.target.value,
                          direction: view.groupBy?.direction ?? "asc",
                        }
                      : null,
                  })
                }
              >
                <option value="">グループなし</option>
                {properties.map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name}
                  </option>
                ))}
              </select>
              {view.groupBy && (
                <select
                  aria-label="グループの順序"
                  value={view.groupBy.direction}
                  onChange={(event) =>
                    patch({
                      groupBy: {
                        ...view.groupBy!,
                        direction: event.target.value as "asc" | "desc",
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
        </details>
      </fieldset>
    </section>
  );
}
