import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/renderer/styles.css";
import { DatabasePresentation } from "../../src/database/DatabasePresentation";
import {
  RecordPage,
  type RecordReadOnlyReason,
  type RecordSaveState,
} from "../../src/database/RecordPage";
import {
  draftFromRecord,
  type RecordDraft,
} from "../../src/database/database-ui";
import { errorMessage } from "../../src/database/database-ui";
import type {
  DatabaseCallbacks,
  DatabaseProjection,
  DatabaseSettings,
  DatabaseView,
  FilterValue,
  Property,
  RecordPatch,
  RecordProjection,
} from "../../src/shared/types";
import { emptyDatabase } from "../../src/shared/types";
import imageUrl from "../fixtures/image.png";

type Call =
  | { type: "openRecord"; pageId: string }
  | {
      type: "createRecord";
      input: { title: string; values: Record<string, FilterValue> };
    }
  | {
      type: "patchRecord";
      pageId: string;
      revision: number;
      patch: RecordPatch;
    }
  | { type: "trashRecord"; pageId: string; revision: number }
  | { type: "restoreRecord"; pageId: string; revision: number }
  | { type: "duplicateRecord"; pageId: string; revision: number }
  | { type: "updateSettings"; revision: number; settings: DatabaseSettings };

type HarnessApi = {
  calls: Call[];
  projection: DatabaseProjection;
  openedPageId: string | null;
  setFilterText(text: string): void;
  setViewName(name: string): void;
  setRecordValue(pageId: string, propertyId: string, value: FilterValue): void;
  setRecordOwner(pageId: string, databasePageId: string): void;
  duplicateRecordIdentity(pageId: string): void;
  openRecord(pageId: string): void;
  setTheme(theme: "light" | "dark"): void;
  clearCalls(): void;
};

declare global {
  interface Window {
    __dbUiHarness: HarnessApi;
  }
}

const STATUS = ["未着手", "進行中", "完了"];
const properties: Property[] = [
  {
    id: "status",
    name: "ステータス",
    type: "select",
    options: STATUS,
  },
  { id: "due", name: "期日", type: "date" },
  { id: "cost", name: "費用", type: "number" },
  { id: "done", name: "完了", type: "checkbox" },
  { id: "note", name: "メモ", type: "text" },
];

const today = new Date();
const iso = (offset: number) => {
  const date = new Date(today);
  date.setDate(date.getDate() + offset);
  return date.toLocaleDateString("sv-SE");
};

function view(
  id: string,
  name: string,
  type: DatabaseView["type"],
): DatabaseView {
  return {
    id,
    name,
    type,
    filterText: "",
    filter: {
      kind: "group",
      id: "filter-" + id,
      conjunction: "and",
      conditions: [],
    },
    sorts: [],
    groupBy: null,
  };
}

const records: RecordProjection[] = [
  {
    pageId: "rec-alpha",
    databasePageId: "db-projects",
    revision: 1,
    title: "Alpha 10",
    icon: "🌿",
    values: {
      status: "進行中",
      due: iso(0),
      cost: 20,
      done: false,
      note:
        "長いテキスト " +
        "とても長いプロパティ値が狭い画面でも折り返されることを確認するための文章です。".repeat(
          3,
        ),
    },
    deletedAt: null,
  },
  {
    pageId: "rec-beta",
    databasePageId: "db-projects",
    revision: 1,
    title: "Beta 2",
    icon: "💡",
    values: {
      status: "完了",
      due: iso(2),
      cost: 50,
      done: true,
    },
    deletedAt: null,
  },
  {
    pageId: "rec-gamma",
    databasePageId: "db-projects",
    revision: 1,
    title: "Gamma",
    icon: "",
    values: {
      status: "未着手",
      due: iso(-3),
      cost: 5,
      done: false,
      note: "Gamma memo",
    },
    deletedAt: null,
  },
  {
    pageId: "rec-delta",
    databasePageId: "db-projects",
    revision: 2,
    title: "Deleted record",
    icon: "🗑️",
    values: { status: "完了", due: iso(-10), cost: 1, done: true },
    deletedAt: 1,
  },
];

for (let index = 0; index < 22; index += 1) {
  records.push({
    pageId: "rec-batch-" + String(index).padStart(2, "0"),
    databasePageId: "db-projects",
    revision: 1,
    title: "Batch " + String(index + 1).padStart(2, "0"),
    icon: index % 3 === 0 ? "📄" : "",
    values: {
      status: STATUS[index % STATUS.length],
      due: iso(index - 11),
      cost: index * 10,
      done: index % 2 === 0,
      note: "Batch memo " + index,
    },
    deletedAt: null,
  });
}

const { rows: _ignoredRows, ...baseSettings } = emptyDatabase();
void _ignoredRows;
const initialSettings: DatabaseSettings = {
  ...baseSettings,
  properties,
  views: [
    view("view-table", "テーブル", "table"),
    view("view-board", "ボード", "board"),
    view("view-calendar", "カレンダー", "calendar"),
    view("view-gallery", "ギャラリー", "gallery"),
  ],
  activeViewId: "view-table",
  view: "table",
  filter: "",
  sort: "",
};
const initialProjection: DatabaseProjection = {
  settings: initialSettings,
  records,
  revision: 20,
};

const clone = <T,>(value: T): T => structuredClone(value);
const wait = (flag: { delay: boolean }) =>
  flag.delay
    ? new Promise<void>((resolve) => setTimeout(resolve, 500))
    : Promise.resolve();

const flags = {
  failPatch: false,
  conflict: false,
  failSettings: false,
  delay: false,
};

function RecordHost({
  record,
  onBack,
  callbacks,
  readOnlyOverride,
  onDuplicate,
}: {
  record: RecordProjection;
  onBack: () => void;
  callbacks: DatabaseCallbacks;
  readOnlyOverride: RecordReadOnlyReason;
  onDuplicate: () => void;
}) {
  const [draft, setDraft] = useState<RecordDraft>(() =>
    draftFromRecord(record),
  );
  const [saveState, setSaveState] = useState<RecordSaveState>("idle");
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const lastPatch = useRef<RecordPatch | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const readOnly: RecordReadOnlyReason =
    record.deletedAt !== null ? "trashed" : readOnlyOverride;

  const send = (patch: RecordPatch) => {
    const id = ++sequence.current;
    lastPatch.current = patch;
    setSaveState("saving");
    setError("");
    callbacks
      .patchRecord(record.pageId, record.revision, patch)
      .then(() => {
        if (id !== sequence.current) return;
        setSaveState("saved");
        lastPatch.current = null;
      })
      .catch((failure) => {
        if (id !== sequence.current) return;
        setSaveState("error");
        setError(errorMessage(failure));
      });
  };

  const changeTitle = (title: string) => {
    setDraft((current) => ({ ...current, title }));
    send({ title });
  };

  const changeValue = (propertyId: string, value: FilterValue | null) => {
    setDraft((current) => ({
      ...current,
      values: { ...current.values, [propertyId]: value },
    }));
    send({ values: { [propertyId]: value } });
  };

  return (
    <RecordPage
      pageId={record.pageId}
      record={record}
      draft={draft}
      properties={properties}
      saveState={saveState}
      error={error}
      readOnly={readOnly}
      onBack={onBack}
      onTitleChange={changeTitle}
      onValueChange={changeValue}
      onRetry={() => {
        if (lastPatch.current) send(lastPatch.current);
      }}
      onDuplicate={onDuplicate}
      onTrash={() => {
        void callbacks
          .trashRecord(record.pageId, record.revision)
          .catch((failure) => {
            setSaveState("error");
            setError(errorMessage(failure));
          });
      }}
      onRestore={() => {
        void callbacks
          .restoreRecord(record.pageId, record.revision)
          .catch((failure) => {
            setSaveState("error");
            setError(errorMessage(failure));
          });
      }}
      focusBody={() => body.current?.focus()}
      body={
        <>
          <div
            className="harness-body"
            role="textbox"
            aria-label="ページ本文"
            contentEditable={readOnly === null}
            suppressContentEditableWarning
            tabIndex={0}
            ref={body}
          >
            <p>
              これはレコードの本文です。タイトル・プロパティ・本文が同じページとして編集されます。
            </p>
            <p>
              とても長い一行：
              {"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".repeat(6)}
            </p>
            <img src={imageUrl} alt="添付画像" />
          </div>
        </>
      }
    />
  );
}

function Harness() {
  const [projection, setProjectionState] = useState(initialProjection);
  const projectionRef = useRef(projection);
  const [openedPageId, setOpenedPageId] = useState<string | null>(null);
  const openedRef = useRef<string | null>(null);
  const calls = useRef<Call[]>([]).current;
  const [readOnlyOverride, setReadOnlyOverride] =
    useState<RecordReadOnlyReason>(null);
  openedRef.current = openedPageId;

  const commit = (next: DatabaseProjection) => {
    projectionRef.current = next;
    setProjectionState(next);
  };

  const applySettings = (
    settings: DatabaseSettings,
    revision: number,
  ): DatabaseProjection => {
    const next: DatabaseProjection = {
      ...projectionRef.current,
      settings,
      revision: revision + 1,
    };
    commit(next);
    return next;
  };

  const callbacks: DatabaseCallbacks = {
    openRecord(pageId) {
      calls.push({ type: "openRecord", pageId });
      setOpenedPageId(pageId);
    },
    async createRecord(input) {
      calls.push({ type: "createRecord", input: clone(input) });
      await wait(flags);
      const current = projectionRef.current;
      const created: RecordProjection = {
        pageId: "rec-created-" + (current.records.length + 1),
        databasePageId: "db-projects",
        revision: 0,
        title: input.title,
        icon: "",
        values: { ...input.values },
        deletedAt: null,
      };
      commit({
        ...current,
        records: [...current.records, created],
        revision: current.revision + 1,
      });
      return created;
    },
    async patchRecord(pageId, revision, patch) {
      calls.push({
        type: "patchRecord",
        pageId,
        revision,
        patch: clone(patch),
      });
      await wait(flags);
      if (flags.failPatch) throw new Error("保存に失敗しました（fixture）");
      if (flags.conflict)
        throw new Error("競合しました。再試行してください（fixture）");
      const current = projectionRef.current;
      const index = current.records.findIndex(
        (record) => record.pageId === pageId,
      );
      if (index < 0) throw new Error("レコードが見つかりません（fixture）");
      const previous = current.records[index];
      const values = { ...previous.values };
      if (patch.values) {
        for (const [key, value] of Object.entries(patch.values)) {
          if (value === null) delete values[key];
          else values[key] = value;
        }
      }
      const updated: RecordProjection = {
        ...previous,
        revision: previous.revision + 1,
        title: patch.title === undefined ? previous.title : patch.title,
        values,
      };
      commit({
        ...current,
        records: current.records.map((record, candidate) =>
          candidate === index ? updated : record,
        ),
        revision: current.revision + 1,
      });
      return updated;
    },
    async trashRecord(pageId, revision) {
      calls.push({ type: "trashRecord", pageId, revision });
      await wait(flags);
      const current = projectionRef.current;
      const record = current.records.find(
        (candidate) => candidate.pageId === pageId,
      );
      if (!record) throw new Error("レコードが見つかりません（fixture）");
      const updated = { ...record, deletedAt: Date.now() };
      commit({
        ...current,
        records: current.records.map((candidate) =>
          candidate.pageId === pageId ? updated : candidate,
        ),
        revision: current.revision + 1,
      });
    },
    async restoreRecord(pageId, revision) {
      calls.push({ type: "restoreRecord", pageId, revision });
      await wait(flags);
      const current = projectionRef.current;
      const record = current.records.find(
        (candidate) => candidate.pageId === pageId,
      );
      if (!record) throw new Error("レコードが見つかりません（fixture）");
      const updated = { ...record, deletedAt: null };
      commit({
        ...current,
        records: current.records.map((candidate) =>
          candidate.pageId === pageId ? updated : candidate,
        ),
        revision: current.revision + 1,
      });
      return updated;
    },
    async duplicateRecord(pageId, revision) {
      calls.push({ type: "duplicateRecord", pageId, revision });
      await wait(flags);
      const current = projectionRef.current;
      const index = current.records.findIndex(
        (candidate) => candidate.pageId === pageId,
      );
      if (index < 0) throw new Error("レコードが見つかりません（fixture）");
      const source = current.records[index];
      const copy: RecordProjection = {
        ...source,
        pageId: source.pageId + "-copy-" + (current.records.length + 1),
        revision: 0,
        title: source.title + " のコピー",
        values: { ...source.values },
        deletedAt: null,
      };
      const nextRecords = [...current.records];
      nextRecords.splice(index + 1, 0, copy);
      commit({
        ...current,
        records: nextRecords,
        revision: current.revision + 1,
      });
      return copy;
    },
    async updateSettings(revision, settings) {
      calls.push({
        type: "updateSettings",
        revision,
        settings: clone(settings),
      });
      if (Object.hasOwn(settings as object, "rows"))
        throw new Error("rows を設定として保存しようとしました（fixture）");
      await wait(flags);
      if (flags.failSettings)
        throw new Error("ビュー設定の保存に失敗しました（fixture）");
      if (revision !== projectionRef.current.revision)
        throw new Error("ビュー設定の競合です（fixture）");
      return applySettings(settings, revision);
    },
  };

  useEffect(() => {
    window.__dbUiHarness = {
      calls,
      get projection() {
        return projectionRef.current;
      },
      get openedPageId() {
        return openedRef.current;
      },
      setFilterText(text: string) {
        const current = projectionRef.current;
        const active = current.settings.views.find(
          (candidate) => candidate.id === current.settings.activeViewId,
        );
        if (!active) return;
        const views = current.settings.views.map((candidate) =>
          candidate.id === active.id
            ? { ...candidate, filterText: text }
            : candidate,
        );
        commit({
          ...current,
          settings: { ...current.settings, views, filter: text },
          revision: current.revision + 1,
        });
      },
      setViewName(name: string) {
        const current = projectionRef.current;
        const views = current.settings.views.map((view) =>
          view.id === current.settings.activeViewId ? { ...view, name } : view,
        );
        commit({
          ...current,
          settings: { ...current.settings, views },
          revision: current.revision + 1,
        });
      },
      setRecordValue(pageId: string, propertyId: string, value: FilterValue) {
        const current = projectionRef.current;
        commit({
          ...current,
          records: current.records.map((record) =>
            record.pageId === pageId
              ? {
                  ...record,
                  revision: record.revision + 1,
                  values: { ...record.values, [propertyId]: value },
                }
              : record,
          ),
        });
      },
      setRecordOwner(pageId: string, databasePageId: string) {
        const current = projectionRef.current;
        commit({ ...current, records: current.records.map((record) =>
          record.pageId === pageId ? { ...record, databasePageId } : record) });
      },
      duplicateRecordIdentity(pageId: string) {
        const current = projectionRef.current;
        const record = current.records.find((entry) => entry.pageId === pageId);
        if (record) commit({ ...current, records: [...current.records, { ...record }] });
      },
      openRecord(pageId: string) {
        callbacks.openRecord(pageId);
      },
      setTheme(theme: "light" | "dark") {
        document.documentElement.dataset.theme = theme;
      },
      clearCalls() {
        calls.length = 0;
      },
    };
  }, [calls]);

  const opened = openedPageId
    ? projection.records.find((record) => record.pageId === openedPageId)
    : undefined;

  return (
    <div className="harness-shell">
      <header className="harness-controls" aria-label="試験用コントロール">
        <strong>DB UI fixture harness（実保存には未接続）</strong>
        <label>
          <input
            type="checkbox"
            aria-label="保存を失敗させる"
            onChange={(event) => {
              flags.failPatch = event.target.checked;
            }}
          />
          保存失敗
        </label>
        <label>
          <input
            type="checkbox"
            aria-label="競合を発生させる"
            onChange={(event) => {
              flags.conflict = event.target.checked;
            }}
          />
          競合
        </label>
        <label>
          <input
            type="checkbox"
            aria-label="設定の保存を失敗させる"
            onChange={(event) => {
              flags.failSettings = event.target.checked;
            }}
          />
          設定失敗
        </label>
        <label>
          <input
            type="checkbox"
            aria-label="保存を遅延させる"
            onChange={(event) => {
              flags.delay = event.target.checked;
            }}
          />
          保存遅延
        </label>
        <label>
          読み取り専用
          <select
            aria-label="読み取り専用の理由"
            value={readOnlyOverride ?? ""}
            onChange={(event) =>
              setReadOnlyOverride(
                (event.target.value || null) as RecordReadOnlyReason,
              )
            }
          >
            <option value="">なし</option>
            <option value="database-trashed">DBがゴミ箱</option>
            <option value="document-error">本文エラー</option>
          </select>
        </label>
        <button
          type="button"
          aria-label="テーマを切り替える"
          onClick={() => {
            document.documentElement.dataset.theme =
              document.documentElement.dataset.theme === "dark"
                ? "light"
                : "dark";
          }}
        >
          テーマ切替
        </button>
        <span data-testid="opened-page" role="status">
          opened: {openedPageId ?? "none"}
        </span>
        <button
          type="button"
          aria-label="呼び出し記録を消去"
          onClick={() => {
            calls.length = 0;
          }}
        >
          記録消去
        </button>
      </header>
      {opened ? (
        <RecordHost
          key={opened.pageId}
          record={opened}
          callbacks={callbacks}
          readOnlyOverride={readOnlyOverride}
          onBack={() => setOpenedPageId(null)}
          onDuplicate={() => {
            void callbacks
              .duplicateRecord(opened.pageId, opened.revision)
              .catch(() => undefined);
          }}
        />
      ) : (
        <DatabasePresentation
          value={projection}
          callbacks={callbacks}
          databasePageId="db-projects"
          readOnly={new URLSearchParams(window.location.search).get("readOnly") === "1"}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
