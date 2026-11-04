import {
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  Copy,
  Filter,
  MoreHorizontal,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
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
import { SettingsMenu } from "./settings-menu/SettingsMenu";
import { summarizeView } from "./settings-menu/summaries";
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
  /** Parent-owned new-row/schema controls can sit next to the view controls. */
  toolbarActions?: ReactNode;
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

function PanelHeading({
  title,
  closeLabel,
  onClose,
}: {
  title: string;
  closeLabel: string;
  onClose: (restoreFocus?: boolean) => void;
}) {
  return (
    <div className="r7-panel-heading">
      <h3>{title}</h3>
      <button
        type="button"
        className="r7-panel-close"
        aria-label={closeLabel}
        title="閉じる"
        onClick={() => onClose(true)}
      >
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

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
  toolbarActions,
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
  const summary = summarizeView(view, properties);
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
      className="r5-settings r7-settings"
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
        <div className="r7-settings-main">
          <div className="r7-view-row">
            <div
              className="r5-view-tabs r7-view-tabs"
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
            <div className="r7-view-row-actions">
              <label className="r7-add-view">
                <span className="r5-visually-hidden">新しいビュー</span>
                <select
                  aria-label="ビューを追加"
                  title="ビューを追加"
                  value=""
                  onChange={(event) => {
                    if (
                      VIEW_TYPES.includes(
                        event.target.value as DatabaseViewType,
                      )
                    )
                      onIntent(
                        createViewIntent(
                          settings,
                          event.target.value as DatabaseViewType,
                        ),
                      );
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
                    <PanelHeading
                      title="ビューのオプション"
                      closeLabel="ビューのオプションを閉じる"
                      onClose={close}
                    />
                    <div className="r7-option-fields">
                      <label className="r5-view-name">
                        ビュー名
                        <input
                          aria-label="ビュー名"
                          value={view.name}
                          maxLength={200}
                          onChange={(event) =>
                            patch({ name: event.target.value })
                          }
                        />
                      </label>
                      <label>
                        表示形式
                        <select
                          aria-label="ビューの表示形式"
                          value={view.type}
                          onChange={(event) =>
                            patch({
                              type: event.target.value as DatabaseViewType,
                            })
                          }
                        >
                          {VIEW_TYPES.map((type) => (
                            <option value={type} key={type}>
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
                        title="ビューを複製"
                        onClick={() => {
                          onIntent(duplicateViewIntent(settings, view.id));
                          close(true);
                        }}
                      >
                        <Copy size={15} aria-hidden="true" /> 複製
                      </button>
                      <button
                        type="button"
                        aria-label="ビューを左へ移動"
                        title="ビューを左へ移動"
                        disabled={index === 0}
                        onClick={() => {
                          move(-1);
                          close(true);
                        }}
                      >
                        <ArrowLeft size={15} aria-hidden="true" /> 左へ
                      </button>
                      <button
                        type="button"
                        aria-label="ビューを右へ移動"
                        title="ビューを右へ移動"
                        disabled={index === settings.views.length - 1}
                        onClick={() => {
                          move(1);
                          close(true);
                        }}
                      >
                        <ArrowRight size={15} aria-hidden="true" /> 右へ
                      </button>
                      <button
                        type="button"
                        className="r7-danger-action"
                        aria-label="ビューを削除"
                        title={
                          settings.views.length <= 1
                            ? "最後のビューは削除できません"
                            : "ビューを削除"
                        }
                        disabled={settings.views.length <= 1}
                        onClick={() => {
                          onIntent({
                            kind: "deleteView",
                            base: structuredClone(view),
                          });
                          close(true);
                        }}
                      >
                        <Trash2 size={15} aria-hidden="true" /> 削除
                      </button>
                    </div>
                  </>
                )}
              </SettingsMenu>
            </div>
          </div>

          <div className="r7-condition-row">
            <label className="r5-view-search r7-view-search">
              <Search size={15} aria-hidden="true" />
              <span className="r5-visually-hidden">検索</span>
              <input
                aria-label="ビュー内検索"
                value={view.filterText}
                maxLength={10_000}
                placeholder="名前・プロパティから絞り込む"
                onChange={(event) =>
                  patch({ filterText: event.target.value })
                }
              />
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
                  <PanelHeading
                    title="フィルター"
                    closeLabel="フィルターを閉じる"
                    onClose={close}
                  />
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
                  <PanelHeading
                    title="並べ替えとグループ"
                    closeLabel="並べ替えとグループを閉じる"
                    onClose={close}
                  />
                  <section aria-label="ビューの並べ替え">
                    <h4>並べ替え</h4>
                    {view.sorts.map((sort, at) => (
                      <div className="r5-sort-row" key={sort.id}>
                        <span>{at + 1}</span>
                        <select
                          aria-label={`並べ替え対象 ${at + 1}`}
                          value={sort.propertyId}
                          onChange={(event) =>
                            updateSort(sort.id, {
                              propertyId: event.target.value,
                            })
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
                    <h4>グループ</h4>
                    <div className="r5-group-row">
                      <select
                        aria-label="グループの対象"
                        value={view.groupBy?.propertyId ?? ""}
                        onChange={(event) =>
                          patch({
                            groupBy: event.target.value
                              ? {
                                  propertyId: event.target.value,
                                  direction:
                                    view.groupBy?.direction ?? "asc",
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
                                direction: event.target.value as
                                  | "asc"
                                  | "desc",
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
            {toolbarActions ? (
              <div className="r7-toolbar-actions">{toolbarActions}</div>
            ) : null}
          </div>

          {summary.activeCount > 0 && (
            <div
              className="r7-active-conditions"
              role="group"
              aria-label="適用中の表示条件"
              title={summary.filterExpression ? `フィルター: ${summary.filterExpression}` : undefined}
            >
              <span className="r7-active-label" aria-hidden="true">
                適用中
              </span>
              <ul>
                {summary.filters.length > 0 && <li className="r7-summary-chip">
                  フィルター: {view.filter.conjunction === "and" ? "すべて (AND)" : "いずれか (OR)"}
                </li>}
                {summary.filters.map((chip) => (
                  <li
                    className="r7-summary-chip r7-summary-chip--filter"
                    key={`filter:${chip.id}`}
                  >
                    {chip.scope && (
                      <span className="r7-summary-scope">{chip.scope}</span>
                    )}
                    {chip.text}
                  </li>
                ))}
                {summary.sorts.map((chip) => (
                  <li
                    className="r7-summary-chip r7-summary-chip--sort"
                    key={`sort:${chip.id}`}
                  >
                    <span className="r7-summary-kind">並べ替え</span>
                    {chip.text}
                  </li>
                ))}
                {summary.group && (
                  <li className="r7-summary-chip r7-summary-chip--group">
                    <span className="r7-summary-kind">グループ</span>
                    {summary.group.text}
                  </li>
                )}
              </ul>
            </div>
          )}
        </div>
      </fieldset>
    </section>
  );
}
