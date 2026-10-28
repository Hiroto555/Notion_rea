import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Editor as TiptapEditor } from "@tiptap/react";
import {
  Search,
  Plus,
  ChevronRight,
  ChevronDown,
  PanelLeft,
  PanelRight,
  ArrowLeft,
  ArrowRight,
  MoreHorizontal,
  Star,
  Trash2,
  Copy,
  FolderInput,
  Moon,
  Sun,
  Download,
  Upload,
  Paperclip,
  History,
  Check,
  BookOpen,
  Command,
  Settings2,
  Link2,
  Database as DatabaseIcon,
  X,
} from "lucide-react";
import { Editor } from "../editor/Editor";
import { DialogFrame } from "./Modal";
import { recoveryContent } from "../shared/recovery";
import { capturePendingJournal, serializePendingJournal } from "../shared/pending-journal";
import { PendingEdits } from "./pending-edits";
import { LiveRecordDatabase } from "./LiveRecordDatabase";
import { DatabaseSessionCoordinator } from "./database-session-coordinator";
import { prepareDatabaseCreation, type DatabaseOperation, type DatabaseOperationResult } from "../shared/database-operation";
import { sendDatabaseOperation, resolveDatabaseOperation } from "./reliable-database-operation";
import { NewDatabaseDialog } from "./NewDatabaseDialog";
import { StructuralDatabaseDialog } from "./StructuralDatabaseDialog";
import type { StructuralOperation } from "./structural-operation";
import { CrashRecoveryDialog } from "./CrashRecoveryDialog";
import { RecoveryCheckpoint, type RecoveryCheckpointStatus } from "./recovery-checkpoint";
import { prepareCrashRecovery } from "./prepare-crash-recovery";
import { emptyCrashRecoverySnapshot, hasCrashRecoveryInput, type CrashRecoveryRead, type CrashRecoverySnapshot } from "../shared/crash-recovery";
import { filterConditions, operatorNeedsValue } from "../database/model";
import { RecordPage } from "../database/RecordPage";
import { parsePropertyNumberInput } from "../database/property-number-input";
import { EditSessionCoordinator } from "./edit-session-coordinator";
import { sendReliableSave, resolveReliableSave } from "./reliable-save";
import type { SaveOperation, SaveResult } from "../shared/save-contract";
import { validateRecordReadSnapshot } from "./record-save-coordinator";
import { composing } from "../shared/keyboard";
import { findText } from "../editor/text-search";
import { Database } from "../database/Database";
import {
  textOf,
  emptyDatabase,
  type Page,
  type PagePatch,
  type Snapshot,
  type Version,
  type Doc,
  type Request,
  type RecordProjection,
} from "../shared/types";
const api = <T,>(r: Request) => window.folio.request<T>(r);
const icons = [
  "📄",
  "✳️",
  "💡",
  "📚",
  "📝",
  "🌿",
  "🎯",
  "🗂️",
  "☕",
  "◈",
  "🏡",
  "🔬",
];
type Dialog =
  "search" | "templates" | "trash" | "move" | "history" | "link" | null;
export function App() {
  const [pages, setPages] = useState<Page[]>([]),
    [recordIds, setRecordIds] = useState<Set<string>>(new Set()),
    [activeId, setActiveId] = useState(""),
    [theme, setTheme] = useState("light"),
    [expanded, setExpanded] = useState<Set<string>>(new Set()),
    [sidebar, setSidebar] = useState(true),
    [inspector, setInspector] = useState(true),
    [dialog, setDialog] = useState<Dialog>(null),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<Page[]>([]),
    [searchIndex, setSearchIndex] = useState(0),
    [menu, setMenu] = useState(false),
    [iconMenu, setIconMenu] = useState(false),
    [versions, setVersions] = useState<Version[]>([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [pending, setPending] = useState(0),
    [ready, setReady] = useState(false),
    [pageFind, setPageFind] = useState(""),
    [findOpen, setFindOpen] = useState(false),
    [creatingPage, setCreatingPage] = useState(false),
    [newDatabaseOpen, setNewDatabaseOpen] = useState(false),
    [newDatabaseTitle, setNewDatabaseTitle] = useState("新しいデータベース"),
    [databaseEpoch, setDatabaseEpoch] = useState(0),
    [recordView, setRecordView] = useState<{ id: string; owner: string; mode: "side" | "full" } | null>(null),
    [structural, setStructural] = useState<{family: "migration" | "property"; owner: Page} | null>(null),
    [, redrawSessions] = useState(0),
    [restoringIds, setRestoringIds] = useState<Set<string>>(new Set());
  const [startupRecovery, setStartupRecovery] = useState<CrashRecoveryRead | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryCheckpointStatus | null>(null);
  const recoveryQueue = useRef<RecoveryCheckpoint | null>(null);
  const recoveryEnabled = useRef(false);
  const captureError = useRef("");
  const installedRecovery = useRef<CrashRecoverySnapshot | null>(null);
  const checkpointRef = useRef<() => void>(() => {});
  const recoveryBarrierRef = useRef<() => Promise<void>>(async () => {});
  const structuralOperation = useRef<StructuralOperation | undefined>(undefined);
  const sessions = useRef(new EditSessionCoordinator(api, {beforeSend: () => recoveryBarrierRef.current()}));
  const databases = useRef(new DatabaseSessionCoordinator(api, {beforeSend: () => recoveryBarrierRef.current()}));
  const databaseCreation = useRef<{operation: DatabaseOperation; state: "saving" | "unknown" | "rejected"; selection: number; error?: string} | undefined>(undefined);
  const databaseCreating = useRef(false);
  const creatingRows = useRef(new Set<string>());
  const filterDrafts = useRef<Record<string, Record<string, Record<string, string>>>>({});
  function hasFilterDrafts() {
    return databases.current.views().some(({page, projection}) => projection.settings.views.some((view) =>
      [...filterConditions(view.filter)].some((node) => operatorNeedsValue(node.operator) &&
        projection.settings.properties.some((property) => property.id === node.propertyId && property.type === "number") &&
        filterDrafts.current[page.id]?.[view.id]?.[node.id] !== undefined &&
        parsePropertyNumberInput(filterDrafts.current[page.id][view.id][node.id]).kind === "incomplete")));
  }
  function hasDatabasePending() {
    return databases.current.hasUnsaved() || databaseCreating.current ||
      !!databaseCreation.current && databaseCreation.current.state !== "rejected" || hasFilterDrafts();
  }
  function setFilterDraft(owner: string, viewId: string, filterId: string, text: string) {
    const prior = filterDrafts.current[owner] ?? {};
    filterDrafts.current = {...filterDrafts.current, [owner]: {...prior, [viewId]: {...prior[viewId], [filterId]: text}}};
    checkpointRef.current();
    redrawSessions((n) => n + 1);
  }
  const pageSessions = useRef(new Map<string, { sessionId: string; page: Page }>());
  const pageOperations = useRef(new Map<string, SaveOperation>());
  const restoring = useRef(new Set<string>());
  const recordOrigin = useRef<{ element: HTMLElement | null; scroll: number } | null>(null);
  const recordViewRef = useRef(recordView);
  recordViewRef.current = recordView;
  const numberDrafts = useRef<Record<string, Record<string, string>>>({});
  function hasNumberDrafts() {
    return Object.values(numberDrafts.current).some((fields) => Object.values(fields).some((text) =>
      parsePropertyNumberInput(text).kind === "incomplete"));
  }
  function setNumberDraft(id: string, propertyId: string, text: string) {
    numberDrafts.current = { ...numberDrafts.current, [id]: { ...numberDrafts.current[id], [propertyId]: text } };
    checkpointRef.current();
    redrawSessions((n) => n + 1);
  }
  useEffect(() => sessions.current.subscribe(() => {checkpointRef.current(); redrawSessions((n) => n + 1);}), []);
  function pageSession(page: Page) {
    let session = pageSessions.current.get(page.id);
    if (!session) {
      session = { sessionId: crypto.randomUUID(), page: structuredClone(page) };
      pageSessions.current.set(page.id, session);
    }
    return session;
  }
  const pageRef = useRef<Page[]>([]),
    recordIdsRef = useRef<Set<string>>(new Set()),
    // Record Editors retain the revision of the document they installed.
    // A refresh must never silently pair an older Editor doc with a newer rev.
    recordWriteRevisions = useRef(new Map<string, number>()),
    recordDatabaseIdsRef = useRef<Set<string>>(new Set()),
    activeRef = useRef(""),
    selectionVersion = useRef(0),
    recordOpenTicket = useRef(0),
    refreshEpoch = useRef(0),
    creatingCount = useRef(0),
    queue = useRef(Promise.resolve()),
    pendingRef = useRef(0),
    edits = useRef(new PendingEdits()),
    composition = useRef(false),
    dialogRef = useRef<Dialog>(null),
    editor = useRef<TiptapEditor | null>(null),
    editorId = useRef(""),
    history = useRef<string[]>([]),
    historyIndex = useRef(-1),
    querySeq = useRef(0);
  const linkTarget = useRef<{
    id: string;
    editor: TiptapEditor;
    selection: TiptapEditor["state"]["selection"];
    doc: TiptapEditor["state"]["doc"];
  } | null>(null);
  const dialogOriginPage = useRef("");
  const historyOrigin = useRef<{ id: string; revision: number } | null>(null);
  dialogRef.current = dialog;
  const commit = (next: Page[]) => {
    pageRef.current = next;
    setPages(next);
  };
  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));
  useEffect(() => databases.current.subscribe(() => {
    const views = databases.current.views();
    const next = pageRef.current.map((page) => {
      const database = views.find((view) => view.page.id === page.id);
      return database ? {...page, title: database.page.title, doc: database.page.doc,
        database: database.page.database, revision: database.page.revision, updatedAt: database.page.updatedAt} : page;
    });
    for (const view of views) {
      const created = view.lastResult;
      if (created?.record && created.page) {
        sessions.current.attach(created.page, created.record);
        recordIdsRef.current = new Set(recordIdsRef.current).add(created.page.id);
        if (!next.some((page) => page.id === created.page!.id)) next.push(created.page);
      }
    }
    setRecordIds(recordIdsRef.current);
    commit(next);
    checkpointRef.current();
    redrawSessions((n) => n + 1);
  }), []);
  function captureCrashRecovery(): CrashRecoverySnapshot {
    const snapshot = emptyCrashRecoverySnapshot();
    for (const [pageId, fields] of Object.entries(numberDrafts.current))
      for (const [key, value] of Object.entries(fields)) if (parsePropertyNumberInput(value).kind === "incomplete")
        snapshot.rawDrafts.push({scope: "record", pageId, key, value});
    for (const {page, projection} of databases.current.views()) for (const view of projection.settings.views)
      for (const node of filterConditions(view.filter)) {
        const value = filterDrafts.current[page.id]?.[view.id]?.[node.id];
        if (value !== undefined && operatorNeedsValue(node.operator) &&
          projection.settings.properties.some((property) => property.id === node.propertyId && property.type === "number") &&
          parsePropertyNumberInput(value).kind === "incomplete")
          snapshot.rawDrafts.push({scope: "database", pageId: page.id, key: JSON.stringify([view.id, node.id]), value});
      }
    snapshot.records = sessions.current.exportRecovery(true).filter((entry) => entry.intents.length || entry.operation ||
      snapshot.rawDrafts.some((draft) => draft.scope === "record" && draft.pageId === entry.base.id));
    snapshot.databases = databases.current.exportRecovery(true).filter((entry) => entry.intents.length || entry.operation ||
      snapshot.rawDrafts.some((draft) => draft.scope === "database" && draft.pageId === entry.base.id));
    const pageInputs = edits.current.snapshotPages();
    const unverified = new Set(pageInputs.filter((entry) => !entry.observedKnown || !pageSessions.current.has(entry.id) || entry.recoveryKind || entry.expectedOwnerId).map((entry) => entry.id));
    if (unverified.size) snapshot.unverifiedInputs = [...unverified].map((id) => ({
      reason: "入力元の編集画面・版・所属を確認できません。別ページに復旧してください。",
      input: {entries: pageInputs.filter((entry) => entry.id === id),
        ...(pageSessions.current.has(id) ? {session: pageSessions.current.get(id)!} : {}),
        ...(pageOperations.current.has(id) ? {operation: pageOperations.current.get(id)!} : {})}}));
    for (const [id, session] of pageSessions.current) {
      if (unverified.has(id)) continue;
      const intents = pageInputs.filter((entry) => entry.id === id).map(({seq, patch}) => ({seq, patch}));
      const operation = pageOperations.current.get(id);
      if (intents.length || operation) snapshot.pages.push({sessionId: session.sessionId, base: session.page,
        seq: edits.current.sequenceFor(id), intents, ...(operation ? {operation} : {})});
    }
    if (databaseCreation.current && databaseCreation.current.state !== "rejected") snapshot.creations.push(databaseCreation.current.operation);
    if (structuralOperation.current) snapshot.externalOperations.push(structuralOperation.current as CrashRecoverySnapshot["externalOperations"][number]);
    return snapshot;
  }
  checkpointRef.current = () => {
    if (!recoveryEnabled.current || !recoveryQueue.current) return;
    try {recoveryQueue.current.offer(captureCrashRecovery()); captureError.current = "";}
    catch (error) {captureError.current = String(error); setRecoveryError(String(error));}
  };
  recoveryBarrierRef.current = async () => {
    if (!recoveryEnabled.current || !recoveryQueue.current) throw new Error("復旧用保存の準備ができていません。");
    checkpointRef.current();
    if (captureError.current) throw new Error(captureError.current);
    await recoveryQueue.current.flush();
  };
  function enableRecovery(generation: number) {
    recoveryQueue.current = new RecoveryCheckpoint(api, generation, setRecoveryStatus);
    setRecoveryStatus(recoveryQueue.current.getStatus());
    recoveryEnabled.current = true;
  }
  async function resumeCrashRecovery(copy = false) {
    if (recoveryBusy || !startupRecovery?.snapshot || startupRecovery.status !== "ready") return;
    setRecoveryBusy(true); setRecoveryError("");
    try {
      if (copy) {
        const snapshot = startupRecovery.snapshot;
        const first = snapshot.pages[0] ?? snapshot.records[0] ?? snapshot.databases[0];
        const body = first ? Object.assign({}, first.base, ...first.intents.map((intent) => "patch" in intent ? intent.patch : {})).doc : undefined;
        await api<Page>({type: "recovery:copy", recoveryId: `checkpoint:${startupRecovery.generation}`,
          input: {title: "復旧した入力", payload: snapshot, ...(body ? {doc: body} : {}), ...(first ? {sourcePageId: first.base.id} : {})}});
        if (!recoveryQueue.current) enableRecovery(startupRecovery.generation);
        await recoveryQueue.current!.retry();
        recoveryQueue.current!.offer(emptyCrashRecoverySnapshot());
        await recoveryQueue.current!.flush();
        window.location.reload(); return;
      }
      const restored = installedRecovery.current ?? await prepareCrashRecovery(startupRecovery.snapshot, api);
      if (!installedRecovery.current) {
      // Validation of all lanes finishes before any editor session is installed.
      for (const entry of restored.records) sessions.current.restoreRecovery(entry, {page: entry.base, record: entry.record});
      for (const entry of restored.databases) databases.current.restoreRecovery(entry, {page: entry.base, database: entry.projection});
      for (const entry of restored.pages) {
        pageSessions.current.set(entry.base.id, {sessionId: entry.sessionId, page: entry.base});
        edits.current.restorePage(entry);
      }
      for (const draft of restored.rawDrafts) {
        if (draft.scope === "record") numberDrafts.current[draft.pageId] = {...numberDrafts.current[draft.pageId], [draft.key]: draft.value};
        else {
          const [viewId, filterId] = JSON.parse(draft.key) as [string, string];
          const prior = filterDrafts.current[draft.pageId] ?? {};
          filterDrafts.current[draft.pageId] = {...prior, [viewId]: {...prior[viewId], [filterId]: draft.value}};
        }
      }
      installedRecovery.current = restored;
      enableRecovery(startupRecovery.generation);
      }
      if (recoveryQueue.current?.getStatus().state === "error") await recoveryQueue.current.retry();
      await recoveryBarrierRef.current();
      await refresh();
      setStartupRecovery(null); setReady(true);
      for (const entry of restored.pages) if (entry.intents.length) update(entry.base.id, edits.current.patch(entry.base.id));
      for (const entry of restored.records) void sessions.current.flush(entry.base.id).catch(fail);
      for (const entry of restored.databases) void databases.current.flush(entry.base.id).catch(fail);
      if (recordIdsRef.current.has(activeRef.current)) void openRecord(activeRef.current, undefined, "full");
      setNotice("保存結果を照合し、残っていた入力を復元しました。");
    } catch (error) {setRecoveryError(error instanceof Error ? error.message : String(error));}
    finally {setRecoveryBusy(false);}
  }
  const refresh = async () => {
    const epoch = ++refreshEpoch.current;
    const state = await api<Snapshot>({ type: "load" });
    if (epoch !== refreshEpoch.current)
      throw new Error("古い読み込み結果を破棄しました。表示と未保存変更は保持しています。");
    const merged = edits.current.merge(state.pages.map((page) => {
      const database = databases.current.get(page.id);
      if (database) return {...page, title: database.page.title, doc: database.page.doc, database: database.page.database,
        revision: database.page.revision, updatedAt: database.page.updatedAt};
      const installed = pageSessions.current.get(page.id);
      if (installed && page.id !== activeRef.current && !edits.current.hasAny(page.id) && !pageOperations.current.has(page.id)) {
        pageSessions.current.delete(page.id);
        return page;
      }
      return installed ? { ...page, doc: installed.page.doc, title: installed.page.title, revision: installed.page.revision } : page;
    }));
    // A stale/partial subsequent load must never reclassify a known record as
    // an ordinary editable Page within this App session.
    recordIdsRef.current = new Set([
      ...recordIdsRef.current,
      ...(state.records ?? []).map((record) => record.pageId),
    ]);
    recordDatabaseIdsRef.current = new Set([
      ...recordDatabaseIdsRef.current,
      ...(state.recordDatabaseIds ?? []),
    ]);
    setRecordIds(recordIdsRef.current);
    commit(merged);
    return { ...state, pages: merged };
  };
  useEffect(() => {
    if (!window.folio) {
      setError("Electronで起動してください。npm run dev または npm start");
      return;
    }
    void refresh()
      .then(async (s) => {
        const recovery = await api<CrashRecoveryRead>({type: "recovery:read"});
        setTheme(s.settings.theme || "light");
        if (s.settings.expanded)
          try {
            setExpanded(new Set(JSON.parse(s.settings.expanded) as string[]));
          } catch {}
        const id =
          s.pages.find((p) => p.id === s.settings.activePage && !p.deletedAt)
            ?.id ||
          s.pages.find(
            (p) =>
              !p.deletedAt &&
              !(s.records ?? []).some((record) => record.pageId === p.id),
          )?.id ||
          "";
        activeRef.current = id;
        setActiveId(id);
        history.current = [id];
        historyIndex.current = 0;
        if (recovery.status === "blocked" || recovery.snapshot && hasCrashRecoveryInput(recovery.snapshot)) {
          setStartupRecovery(recovery); return;
        }
        enableRecovery(recovery.generation);
        setReady(true);
        if (recordIdsRef.current.has(id)) void openRecord(id, undefined, "full");
      })
      .catch(fail);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  // Dismiss transient menus on the next interaction outside their anchor.
  // This only changes menu visibility; page actions still run through the
  // same handlers as before.
  useEffect(() => {
    if (!menu && !iconMenu) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.(".menu-anchor")) return;
      setMenu(false);
      setIconMenu(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [menu, iconMenu]);
  const saveSetting = (
    key: "activePage" | "theme" | "sidebar" | "expanded",
    value: string,
  ) => {
    void api({ type: "setting", key, value }).catch(fail);
  };
  function select(id: string, push = true) {
    if (recordIdsRef.current.has(id)) { void openRecord(id, undefined, "full"); return; }
    setRecordView(null);
    selectionVersion.current++;
    recordOpenTicket.current++;
    const changed = activeRef.current !== id;
    activeRef.current = id;
    setActiveId(id);
    if (changed) {
      editor.current = null;
      editorId.current = "";
    }
    setMenu(false);
    setDialog(null);
    setFindOpen(false);
    saveSetting("activePage", id);
    if (push && changed) {
      history.current = history.current.slice(0, historyIndex.current + 1);
      history.current.push(id);
      historyIndex.current++;
    }
  }
  function back(delta: number) {
    const next = historyIndex.current + delta;
    if (next >= 0 && next < history.current.length) {
      historyIndex.current = next;
      select(history.current[next], false);
    }
  }
  function enqueue<T>(action: () => Promise<T>): Promise<T> {
    pendingRef.current++;
    setPending(pendingRef.current);
    const operation = queue.current.then(action).finally(() => {
      pendingRef.current--;
      setPending(pendingRef.current);
    });
    queue.current = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  function assertNoFailed() {
    if (edits.current.failed.size || sessions.current.hasUnsaved() || hasNumberDrafts() || hasDatabasePending() || restoring.current.size)
      throw new Error(
        "未保存の変更があります。保存の再試行または退避を先に実行してください。",
      );
  }
  async function ensureSaved() {
    let current;
    do {
      current = queue.current;
      await current;
    } while (current !== queue.current);
    if (edits.current.size || sessions.current.hasUnsaved() || hasNumberDrafts() || hasDatabasePending() || restoring.current.size)
      throw new Error(
        "未保存の変更があります。保存の再試行または退避を先に実行してください。",
      );
  }
  async function openStructural(family: "migration" | "property", id: string) {
    if (composition.current || structuralOperation.current) return;
    try {
      await ensureSaved();
      const owner = pageRef.current.find((page) => page.id === id);
      if (!owner || owner.kind !== "database" || owner.documentError) throw new Error("データベースを確認できません。");
      setMenu(false); setDialog(null);
      setStructural({family, owner: structuredClone(owner)});
    } catch (error) {fail(error);}
  }
  async function retainStructural(operation: StructuralOperation | null) {
    if (operation && !structuralOperation.current) await ensureSaved();
    structuralOperation.current = operation ?? undefined;
    if (recoveryQueue.current?.getStatus().state === "error") await recoveryQueue.current.retry();
    checkpointRef.current();
    await recoveryBarrierRef.current();
    redrawSessions((n) => n + 1);
  }
  function mutate<T>(action: () => Promise<T>, allowDuringCreate = false) {
    if (creatingCount.current && !allowDuringCreate)
      return Promise.reject(
        new Error("ページを作成中です。完了後に操作してください。"),
      );
    return enqueue(async () => {
      assertNoFailed();
      return action();
    });
  }
  function update(id: string, patch: PagePatch, sessionId?: string) {
    if (sessionId && pageSessions.current.get(id)?.sessionId !== sessionId) {
      edits.current.addObservedPage(id, 0, patch, false);
      edits.current.failed.add(id);
      checkpointRef.current();
      fail("古い編集画面からの入力を保持し、送信を停止しました。");
      return;
    }
    if (restoring.current.has(id)) { fail("履歴を復元中です。完了まで編集を待ってください。"); return; }
    const page = pageRef.current.find((p) => p.id === id);
    if (page?.documentError) {
      // A late Editor callback must remain inspectable even if a subsequent
      // refresh found an unsupported document. Never send or overlay it.
      edits.current.add(id, patch);
      edits.current.failed.add(id);
      checkpointRef.current();
      fail(page.documentError + " 未保存の変更を保持しています。");
      return;
    }
    if (recordDatabaseIdsRef.current.has(id) && patch.database === undefined) {
      try {
        const database = databases.current.get(id);
        if (!database) throw new Error("データベースを読み込み中です。");
        databases.current.editPage(database.handle, patch);
        void databases.current.flush(id);
      } catch (error) { fail(error); }
      return;
    }
    if (recordIdsRef.current.has(id) || recordDatabaseIdsRef.current.has(id)) {
      // A late callback from a formerly editable surface is captured before
      // switching to read-only. Its unverified base must not use Page-only
      // recovery or generic update.
      edits.current.addObservedPage(
        id,
        page && Number.isSafeInteger(page.revision) && page.revision >= 0 ? page.revision : 0,
        patch,
        false,
        undefined,
        recordIdsRef.current.has(id) ? "record" : "database",
      );
      edits.current.failed.add(id);
      commit(edits.current.merge(pageRef.current));
      checkpointRef.current();
      fail("レコードまたはデータベースの編集は準備中です。未保存変更を保持しています。");
      return;
    }
    if (!page) return;
    const session = pageSession(page);
    const seq = edits.current.addObservedPage(id, session.page.revision, patch, true);
    commit(edits.current.merge(pageRef.current));
    checkpointRef.current();
    void enqueue(async () => {
      if (!edits.current.has(id, seq)) return;
      try {
        if (edits.current.failed.has(id) || pageOperations.current.has(id))
          throw new Error("先行する保存で競合または結果不明が発生しました。後続の変更を送信せず保持しています。");
        if (pageSessions.current.get(id) !== session)
          throw new Error("編集セッションが変わりました。未保存変更を保持しています。");
        const operation: SaveOperation = {
          operationId: crypto.randomUUID(), sessionId: session.sessionId, seq,
          pageId: id, databasePageId: null, revision: session.page.revision,
          patch: edits.current.patch(id, seq),
        };
        pageOperations.current.set(id, operation);
        await recoveryBarrierRef.current();
        const result = await sendReliableSave(operation, api);
        acknowledgePage(operation, result);
      } catch (e) { edits.current.failed.add(id); throw e; }
    }).catch(fail);
  }
  function acknowledgePage(operation: SaveOperation, result: SaveResult, resume = false) {
    if (pageOperations.current.get(operation.pageId) !== operation) return;
    const session = pageSessions.current.get(operation.pageId);
    if (result.status !== "applied" || !result.page) {
      if (result.status === "rejected") pageOperations.current.delete(operation.pageId);
      throw new Error((result.message || (result.status === "unknown" ? "保存結果が不明です。結果を確認してください。" : "保存が競合しました。")) + " 未保存変更を保持しています。");
    }
    if (!session || session.sessionId !== operation.sessionId ||
        result.operationId !== operation.operationId || result.sessionId !== operation.sessionId ||
        result.seq !== operation.seq || result.pageId !== operation.pageId ||
        result.page.id !== operation.pageId || result.page.revision !== operation.revision + 1 ||
        session.page.revision !== operation.revision ||
        Object.entries(operation.patch).some(([key, value]) => JSON.stringify((result.page as unknown as Record<string, unknown>)[key]) !== JSON.stringify(value)))
      throw new Error("保存結果の照合に失敗しました。未保存変更を保持しています。");
    session.page = result.page;
    pageOperations.current.delete(operation.pageId);
    edits.current.ack(operation.pageId, operation.seq);
    edits.current.failed.delete(operation.pageId);
    commit(edits.current.merge(pageRef.current.map((page) => page.id === operation.pageId ? result.page! : page)));
    checkpointRef.current();
    if (!edits.current.failed.size) setError("");
    // Later input was intentionally held while this operation was unknown.
    // Its next save can now advance only from this confirmed causal ACK.
    if (resume && edits.current.hasAny(operation.pageId)) {
      const patch = edits.current.patch(operation.pageId);
      queueMicrotask(() => update(operation.pageId, patch));
    }
  }
  async function resolvePageSaves() {
    await enqueue(async () => {
      for (const operation of [...pageOperations.current.values()]) {
        const result = await resolveReliableSave(operation, api);
        acknowledgePage(operation, result, true);
      }
    });
  }

  async function openRecord(pageId: string, expectedOwner?: string, mode: "side" | "full" = "side") {
    if (creatingCount.current || composition.current) return;
    const originId = activeRef.current;
    const selection = ++selectionVersion.current;
    const ticket = ++recordOpenTicket.current;
    const origin = { element: document.activeElement as HTMLElement | null,
      scroll: document.querySelector(".document-scroll")?.scrollTop ?? 0 };
    try {
      const read = await api<{ page: Page; record: RecordProjection }>({ type: "record:read", pageId });
      if (ticket !== recordOpenTicket.current || selection !== selectionVersion.current || creatingCount.current) return;
      const pair = validateRecordReadSnapshot(read, pageId, expectedOwner ?? read.record.databasePageId);
      sessions.current.attach(pair.page, pair.record);
      recordIdsRef.current = new Set(recordIdsRef.current).add(pageId);
      setRecordIds(recordIdsRef.current);
      const owner = pair.record.databasePageId;
      if (!pageRef.current.some((page) => page.id === owner)) throw new Error("所属するデータベースが見つかりません。");
      recordOrigin.current = origin;
      // The database stays mounted beneath the peek. The session is App-owned.
      activeRef.current = owner;
      setActiveId(owner);
      setRecordView({ id: pageId, owner, mode });
      setDialog(null);
      setMenu(false);
      editor.current = null;
      editorId.current = "";
      saveSetting("activePage", pageId);
    } catch (error) {
      if (ticket === recordOpenTicket.current && selection === selectionVersion.current && activeRef.current === originId) fail(error);
    }
  }
  function closeRecord() {
    if (composition.current) return;
    selectionVersion.current++;
    recordOpenTicket.current++;
    const current = recordViewRef.current;
    setRecordView(null);
    editor.current = null;
    editorId.current = "";
    if (current) saveSetting("activePage", current.owner);
    const origin = recordOrigin.current;
    requestAnimationFrame(() => {
      const scroll = document.querySelector(".document-scroll");
      if (scroll && origin) scroll.scrollTop = origin.scroll;
      if (origin?.element?.isConnected) origin.element.focus({ preventScroll: true });
      else if (current) document.querySelector<HTMLElement>(`[data-record-open-id="${CSS.escape(current.id)}"]`)?.focus({ preventScroll: true });
    });
  }
  function editRecord(id: string, patch: PagePatch, values?: Record<string, string | number | boolean | null>) {
    try {
      const session = sessions.current.get(id);
      if (!session) throw new Error("レコードを読み込み中です。");
      sessions.current.edit(session.handle, patch, values);
      void sessions.current.flush(id);
    } catch (error) { fail(error); }
  }
  async function addRecord(ownerId: string) {
    if (creatingRows.current.has(ownerId) || composition.current) return;
    const database = databases.current.get(ownerId);
    if (!database || ["unknown", "conflict", "blocked"].includes(database.state)) return;
    creatingRows.current.add(ownerId);
    redrawSessions((n) => n + 1);
    try {
      databases.current.createRecord(database.handle, "無題", {});
      await databases.current.flush(ownerId);
    } catch (error) {fail(error);}
    finally {creatingRows.current.delete(ownerId); redrawSessions((n) => n + 1);}
  }
  function acceptDatabaseCreation(result: DatabaseOperationResult) {
    const pending = databaseCreation.current;
    if (!pending || result.operationId !== pending.operation.operationId) return;
    if (result.status !== "applied" || !result.page || !result.database) {
      pending.state = result.status === "rejected" ? "rejected" : "unknown";
      pending.error = result.message || "作成結果を確認できません。入力を保持しています。";
      redrawSessions((n) => n + 1);
      return;
    }
    const created = result.page;
    recordDatabaseIdsRef.current = new Set(recordDatabaseIdsRef.current).add(created.id);
    if (!pageRef.current.some((page) => page.id === created.id)) commit([...pageRef.current, created]);
    databases.current.attach(created, result.database);
    databaseCreation.current = undefined;
    checkpointRef.current();
    setNewDatabaseOpen(false);
    setNewDatabaseTitle("新しいデータベース");
    if (selectionVersion.current === pending.selection) select(created.id);
    else setNotice("データベースを作成しました。サイドバーから開けます。");
  }
  async function createRegisteredDatabase() {
    if (databaseCreating.current || composition.current || !newDatabaseTitle.trim() ||
        databaseCreation.current && databaseCreation.current.state !== "rejected") return;
    databaseCreating.current = true;
    redrawSessions((n) => n + 1);
    const selected = selectionVersion.current;
    recordOpenTicket.current++;
    try {
      // Finish earlier ordinary Page writes before a schema introduction.
      await queue.current;
      if (edits.current.size || sessions.current.hasUnsaved() || databases.current.hasUnsaved() || hasNumberDrafts() || hasFilterDrafts())
        throw new Error("未保存の変更を保存してから作成してください。");
      const {rows: _rows, ...settings} = emptyDatabase();
      settings.properties = [{id: "note", name: "メモ", type: "text"}, {id: "estimate", name: "見積", type: "number"}, {id: "done", name: "完了", type: "checkbox"}];
      const operation = prepareDatabaseCreation(newDatabaseTitle.trim(), null, settings);
      databaseCreation.current = {operation, selection: selected, state: "saving"};
      redrawSessions((n) => n + 1);
      await recoveryBarrierRef.current();
      acceptDatabaseCreation(await sendDatabaseOperation(operation, api));
    } catch (error) {fail(error);}
    finally {databaseCreating.current = false; redrawSessions((n) => n + 1);}
  }
  async function resolveDatabaseCreation() {
    const pending = databaseCreation.current;
    if (!pending || pending.state !== "unknown" || databaseCreating.current) return;
    databaseCreating.current = true;
    redrawSessions((n) => n + 1);
    try {acceptDatabaseCreation(await resolveDatabaseOperation(pending.operation, api));}
    catch (error) {fail(error);}
    finally {databaseCreating.current = false; redrawSessions((n) => n + 1);}
  }
  const create = (
    parentId: string | null = null,
    kind: Page["kind"] = "page",
    title?: string,
    doc?: Doc,
  ) => {
    if (parentId && (recordIdsRef.current.has(parentId) || recordDatabaseIdsRef.current.has(parentId)))
      return Promise.reject(new Error("読み取り専用のレコードやデータベースには子ページを追加できません。"));
    if (creatingCount.current)
      return Promise.reject(
        new Error("ページを作成中です。完了後にもう一度お試しください。"),
      );
    if (composition.current)
      return Promise.reject(
        new Error("文字の変換を確定してからページを作成してください。"),
      );
    // A delayed record read must not invalidate the refresh that follows a
    // committed database creation or cause the user to retry that creation.
    recordOpenTicket.current++;
    const selectionAtStart = selectionVersion.current;
    creatingCount.current++;
    // Close the old input surface in the same event that requested creation.
    // Keep the Editor mounted so its pending state and composition survive.
    flushSync(() => setCreatingPage(true));
    return mutate(async () => {
      const p = await api<Page>({ type: "create", parentId, kind, title });
      if (kind === "database") {
        // Determine v4 membership before selecting the page: the legacy
        // whole-row editor must never appear for a registered database.
        await refresh();
      } else {
        commit([...pageRef.current, p]);
      }
      if (parentId) {
        const next = new Set(expanded).add(parentId);
        setExpanded(next);
        saveSetting("expanded", JSON.stringify([...next]));
      }
      if (selectionVersion.current === selectionAtStart) select(p.id);
      if (doc) update(p.id, { doc });
      return p;
    }, true).finally(() => {
      creatingCount.current--;
      if (creatingCount.current === 0) setCreatingPage(false);
    });
  };
  const safe = (fn: () => Promise<unknown>) => {
    void fn().catch(fail);
  };
  const page = pages.find((p) => p.id === activeId && !p.deletedAt),
    live = pages.filter((p) => !p.deletedAt),
    children = live
      .filter((p) => p.parentId === activeId && !recordIds.has(p.id))
      .sort((a, b) => a.position - b.position);
  if (page && !recordIds.has(page.id) && !recordDatabaseIdsRef.current.has(page.id)) pageSession(page);
  const displayedSession = page && !recordIds.has(page.id) && !recordDatabaseIdsRef.current.has(page.id) ? pageSession(page) : undefined;
  const openedRecord = recordView ? sessions.current.get(recordView.id) : undefined;
  const activeDatabase = page ? databases.current.get(page.id) : undefined;
  function toggleTheme() {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    saveSetting("theme", next);
  }
  function openSearch() {
    dialogOriginPage.current = activeRef.current;
    setQuery("");
    setResults([]);
    setDialog("search");
    setSearchIndex(0);
  }
  useEffect(() => {
    if (dialog !== "search" && dialog !== "link") return;
    const seq = ++querySeq.current;
    void api<Page[]>({ type: "search", query })
      .then((r) => {
        if (seq === querySeq.current) {
          setResults(r);
          setSearchIndex(0);
        }
      })
      .catch(fail);
  }, [query, dialog, pages.length]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || composing(e, composition.current)) return;
      if (
        document.querySelector("dialog[open]") ||
        ((e.target as HTMLElement)?.closest?.('[role="dialog"]') &&
          !dialogRef.current)
      )
        return;
      if (e.key === "Escape") {
        if (dialogRef.current) setDialog(null);
        else if (menu) setMenu(false);
        else if (findOpen) setFindOpen(false);
        else if (recordViewRef.current) closeRecord();
        e.preventDefault();
        return;
      }
      if (dialogRef.current) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (
        k === "k" &&
        (e.target as HTMLElement)?.closest?.("input,textarea,select")
      )
        return;
      if (k === "k" || k === "p") {
        e.preventDefault();
        if (
          k === "k" &&
          editor.current?.isFocused &&
          !editor.current.state.selection.empty
        ) {
          openLink();
        } else openSearch();
      } else if (k === "n") {
        e.preventDefault();
        safe(() => create());
      } else if (k === "l" && e.shiftKey) {
        e.preventDefault();
        toggleTheme();
      } else if (k === "\\") {
        e.preventDefault();
        setSidebar((v) => !v);
      } else if (k === "[") {
        e.preventDefault();
        back(-1);
      } else if (k === "]") {
        e.preventDefault();
        back(1);
      } else if (k === "f") {
        e.preventDefault();
        setFindOpen((v) => !v);
      } else if (k === "s") {
        e.preventDefault();
        setNotice("変更は自動保存されます");
      }
    };
    const unload = (e: BeforeUnloadEvent) => {
      if (pendingRef.current > 0 || edits.current.size > 0 || sessions.current.hasUnsaved() || hasNumberDrafts() || hasDatabasePending() || restoring.current.size > 0 || structuralOperation.current || recoveryQueue.current?.getStatus().state !== "saved" || captureError.current) {
        e.preventDefault();
        e.returnValue = "保存中です";
      }
    };
    const start = () => {
      composition.current = true;
    };
    const end = () => {
      composition.current = false;
    };
    window.addEventListener("compositionstart", start);
    window.addEventListener("compositionend", end);
    window.addEventListener("keydown", key);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("compositionstart", start);
      window.removeEventListener("compositionend", end);
      window.removeEventListener("keydown", key);
      window.removeEventListener("beforeunload", unload);
    };
  }, [theme, expanded, menu, findOpen]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(t);
  }, [notice]);
  const duplicate = () =>
    safe(() =>
      mutate(async () => {
        if (!page) return;
        const copy = await api<Page>({ type: "duplicate", id: page.id });
        await refresh();
        select(copy.id);
      }),
    );
  const trash = () =>
    safe(() =>
      mutate(async () => {
        if (!page) return;
        await api({ type: "trash", id: page.id });
        const s = await refresh();
        select(s.pages.find((p) => !p.deletedAt)?.id || "");
        setMenu(false);
      }),
    );
  const move = (
    id: string,
    parentId: string | null,
    beforeId: string | null = null,
  ) =>
    mutate(async () => {
      if ([id, parentId, beforeId].some((value) => value !== null &&
          (recordIdsRef.current.has(value) || recordDatabaseIdsRef.current.has(value))))
        throw new Error("読み取り専用のレコードやデータベースは移動できません。");
      const binding = pageSessions.current.get(id);
      const moved = await api<Page>({ type: "move", id, parentId, beforeId });
      if (binding && binding === pageSessions.current.get(id) && moved.id === id &&
          moved.revision === binding.page.revision + 1 && moved.title === binding.page.title &&
          JSON.stringify(moved.doc) === JSON.stringify(binding.page.doc)) binding.page = moved;
      // The move is committed. Allow editing while the hierarchy refreshes;
      // refresh overlays any subsequent local edits through PendingEdits.
      setDialog((current) => (current === "move" ? null : current));
      await refresh();
      if (parentId) setExpanded((prev) => new Set(prev).add(parentId));
    });
  const openHistory = () =>
    safe(() =>
      mutate(async () => {
        if (!page) return;
        const current = pageRef.current.find(
          (candidate) => candidate.id === page.id,
        );
        if (!current) throw new Error("ページが見つかりません。");
        const revision = current.revision;
        const entries = await api<Version[]>({ type: "versions", id: page.id });
        historyOrigin.current = { id: page.id, revision };
        setVersions(entries);
        setDialog("history");
      }),
    );
  async function restorePageVersion(targetId: string, versionId: number, revision: number) {
    if (composition.current || edits.current.hasAny(targetId) || pageOperations.current.has(targetId) || restoring.current.has(targetId))
      throw new Error("未保存の変更または復元処理があります。内容を確認してください。");
    if (recordIdsRef.current.has(targetId) || recordDatabaseIdsRef.current.has(targetId))
      throw new Error("レコードの履歴復元は準備中です。");
    restoring.current.add(targetId);
    if (editorId.current === targetId) editor.current?.setEditable(false, false);
    flushSync(() => setRestoringIds(new Set(restoring.current)));
    let installed = false;
    try {
      await enqueue(async () => {
        const origin = historyOrigin.current;
        if (!origin || origin.id !== targetId || origin.revision !== revision)
          throw new Error("履歴の対象が変わりました。");
        const saved = await api<Page>({ type: "restoreVersion", id: targetId, versionId, revision });
        if (saved.id !== targetId || saved.revision !== revision + 1)
          throw new Error("履歴復元の結果を確認できません。");
        // A delayed reload cannot reopen the old editor even if the modal closes.
        // A successful restore response is sufficient to install its exact snapshot.
        try { await refresh(); } catch (error) { fail(error); }
        pageSessions.current.set(targetId, { sessionId: crypto.randomUUID(), page: structuredClone(saved) });
        commit(pageRef.current.map((page) => page.id === targetId ? saved : page));
        setDatabaseEpoch((value) => value + 1);
        installed = true;
      });
      if (historyOrigin.current?.id === targetId) setDialog(null);
      setNotice("履歴を復元しました");
    } finally {
      if (installed) {
        restoring.current.delete(targetId);
        setRestoringIds(new Set(restoring.current));
      }
    }
  }
  function currentEditor() {
    return creatingCount.current === 0 &&
      editorId.current === (recordViewRef.current?.id ?? activeRef.current) &&
      editor.current &&
      !editor.current.isDestroyed
      ? editor.current
      : null;
  }
  function openLink() {
    const e = currentEditor();
    if (!e) return;
    linkTarget.current = {
      id: activeRef.current,
      editor: e,
      selection: e.state.selection,
      doc: e.state.doc,
    };
    dialogOriginPage.current = activeRef.current;
    setQuery("");
    setResults([]);
    setDialog("link");
  }
  function restoreDialogFocus() {
    const target = linkTarget.current;
    linkTarget.current = null;
    if (activeRef.current !== dialogOriginPage.current) {
      document
        .querySelector<HTMLElement>(".page-title")
        ?.focus({ preventScroll: true });
      return true;
    }
    if (target && currentEditor() === target.editor) {
      if (target.doc.eq(target.editor.state.doc))
        target.editor.view.dispatch(
          target.editor.state.tr.setSelection(
            target.selection.getBookmark().resolve(target.editor.state.doc),
          ),
        );
      target.editor.view.focus();
      return true;
    }
    return false;
  }
  function applyPageLink(p: Page) {
    const target = linkTarget.current,
      e = currentEditor();
    if (
      !target ||
      !e ||
      e !== target.editor ||
      activeRef.current !== target.id ||
      !target.doc.eq(e.state.doc)
    ) {
      fail(
        "リンク対象のページまたは本文が変わりました。元のページで選択し直してください。",
      );
      setDialog(null);
      return;
    }
    e.view.dispatch(
      e.state.tr.setSelection(
        target.selection.getBookmark().resolve(e.state.doc),
      ),
    );
    if (!target.selection.empty)
      e.chain()
        .setLink({ href: "folio-page://" + p.id })
        .run();
    else
      e.chain()
        .insertContent({
          type: "text",
          text: p.title,
          marks: [{ type: "link", attrs: { href: "folio-page://" + p.id } }],
        })
        .run();
    setDialog(null);
  }
  const exportPage = (format: "md" | "html" | "json") =>
    safe(async () => {
      if (!page) return;
      const e = currentEditor();
      if (page.kind === "page" && format !== "json" && !e)
        throw new Error("本文を取得できないため書き出しを停止しました");
      const content =
        format === "json"
          ? JSON.stringify(page, null, 2)
          : format === "md"
            ? "# " +
              page.title +
              "\n\n" +
              (e?.getMarkdown() ?? JSON.stringify(page.database, null, 2))
            : '<!doctype html><html lang="ja"><meta charset="utf-8"><title>' +
              page.title.replace(/[<>&"]/g, "") +
              "</title><body>" +
              (e?.getHTML() ??
                "<pre>" +
                  JSON.stringify(page.database, null, 2)
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;") +
                  "</pre>") +
              "</body></html>";
      const path = await api<string | null>({
        type: "export",
        name: page.title,
        format,
        content,
      });
      if (path) setNotice("書き出しました：" + path);
      setMenu(false);
    });
  const importPage = () =>
    safe(async () => {
      const file = await api<{
        name: string;
        format: string;
        content: string;
      } | null>({ type: "import" });
      if (!file) return;
      const { Editor: CoreEditor } = await import("@tiptap/core");
      const { extensions } = await import("../editor/Editor");
      const parser = new CoreEditor({
        extensions: extensions(),
        content: file.content,
        contentType: [".md", ".markdown"].includes(file.format)
          ? "markdown"
          : "html",
      });
      const doc = parser.getJSON() as Doc;
      parser.destroy();
      await create(null, "page", file.name, doc);
    });
  const attach = () =>
    safe(async () => {
      const e = currentEditor(),
        id = activeRef.current;
      if (!page || !e) return;
      const file = await api<{
        name: string;
        url: string;
        image: boolean;
      } | null>({ type: "attach" });
      if (!file) return;
      if (currentEditor() !== e || activeRef.current !== id)
        throw new Error(
          "添付の選択中にページが変わりました。元のページでやり直してください。",
        );
      if (file.image)
        e.chain().focus().setImage({ src: file.url, alt: file.name }).run();
      else
        e.chain()
          .focus()
          .insertContent({
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "📎 " + file.name,
                marks: [{ type: "link", attrs: { href: file.url } }],
              },
            ],
          })
          .run();
    });
  function tree(parentId: string | null, depth = 0): React.ReactNode {
    return live
      .filter((p) => p.parentId === parentId && !recordIds.has(p.id))
      .sort((a, b) => a.position - b.position)
      .map((p) => {
        const has = live.some(
          (c) => c.parentId === p.id && !recordIds.has(c.id),
        );
        return (
          <div className="page-tree-node" data-depth={depth} key={p.id}>
            <div
              className={"page-tree-row " + (p.id === activeId ? "active" : "")}
              draggable={!recordDatabaseIdsRef.current.has(p.id)}
              onDragStart={(e) => {
                if (recordDatabaseIdsRef.current.has(p.id)) { e.preventDefault(); return; }
                e.dataTransfer.setData("application/x-folio-page", p.id);
              }}
              onDragOver={(e) => {
                if (!recordDatabaseIdsRef.current.has(p.id) && e.dataTransfer.types.includes("application/x-folio-page"))
                  e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const id = e.dataTransfer.getData("application/x-folio-page");
                if (!id || recordDatabaseIdsRef.current.has(id) || recordDatabaseIdsRef.current.has(p.id)) return;
                const rect = e.currentTarget.getBoundingClientRect(),
                  before = e.clientY < rect.top + rect.height * 0.28;
                safe(() =>
                  move(id, before ? p.parentId : p.id, before ? p.id : null),
                );
              }}
            >
              <button
                className={"tree-toggle " + (!has ? "invisible" : "")}
                aria-label={p.title + " を展開"}
                aria-expanded={has ? expanded.has(p.id) : undefined}
                onClick={() => {
                  const next = new Set(expanded);
                  if (next.has(p.id)) next.delete(p.id);
                  else next.add(p.id);
                  setExpanded(next);
                  saveSetting("expanded", JSON.stringify([...next]));
                }}
              >
                {expanded.has(p.id) ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronRight size={13} />
                )}
              </button>
              <button
                className="page-tree-label"
                title={p.title || "無題"}
                aria-current={p.id === activeId ? "page" : undefined}
                onClick={() => select(p.id)}
              >
                <span className="page-emoji">{p.icon}</span>
                <span className="page-tree-title">{p.title || "無題"}</span>
              </button>
              <button
                className="tree-add"
                disabled={recordDatabaseIdsRef.current.has(p.id)}
                aria-label={p.title + " に子ページを作成"}
                onClick={() => safe(() => create(p.id))}
              >
                <Plus size={13} />
              </button>
            </div>
            {expanded.has(p.id) && (
              <div className="page-tree-children">{tree(p.id, depth + 1)}</div>
            )}
          </div>
        );
      });
  }
  const ancestors: Page[] = [];
  let parent = page?.parentId;
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const p = pages.find((x) => x.id === parent);
    if (!p) break;
    ancestors.unshift(p);
    parent = p.parentId;
  }
  const linked = (doc: Doc, target: string): boolean =>
    !!doc.marks?.some(
      (m) => m.type === "link" && m.attrs?.href === "folio-page://" + target,
    ) || !!doc.content?.some((n) => linked(n, target));
  const backlinks = page
    ? live.filter(
        (p) => !p.documentError && p.id !== page.id && linked(p.doc, page.id),
      )
    : [];
  const headings: Doc[] = page?.documentError
    ? []
    : (page?.doc?.content?.filter((n) => n.type === "heading") ?? []);
  const templates = [
    {
      title: "ミーティングノート",
      icon: "📝",
      doc: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "アジェンダ" }],
          },
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "今日、話し合うこと" }],
                  },
                ],
              },
            ],
          },
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "決まったこと" }],
          },
          { type: "paragraph" },
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "次のアクション" }],
          },
          {
            type: "taskList",
            content: [
              {
                type: "taskItem",
                attrs: { checked: false },
                content: [{ type: "paragraph" }],
              },
            ],
          },
        ],
      } as Doc,
    },
    {
      title: "デイリーノート",
      icon: "☕",
      doc: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "今日のフォーカス" }],
          },
          { type: "paragraph" },
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "気づき・ふりかえり" }],
          },
          { type: "paragraph" },
        ],
      } as Doc,
    },
  ];
  if (startupRecovery) return <CrashRecoveryDialog read={startupRecovery} busy={recoveryBusy} error={recoveryError} onResume={() => void resumeCrashRecovery()} onCopy={() => void resumeCrashRecovery(true)} />;
  if (!ready)
    return (
      <main className="loading">
        <div className="brand-mark">f</div>
        <h2>Folio</h2>
        <p>{error || "ワークスペースを開いています…"}</p>
        {error && (
          <button
            onClick={() =>
              safe(async () => {
                const path = await api<string>({ type: "backup" });
                setError("バックアップ保存先: " + path);
              })
            }
          >
            原本のバックアップを保存
          </button>
        )}
      </main>
    );
  return (
    <div className="app-shell">
      <div className="r6-recovery-status" role="status" data-recovery-state={recoveryError ? "error" : recoveryStatus?.state ?? "saved"}>
        {recoveryError || recoveryStatus?.state === "error" ? <><span>復旧用保存に失敗: {recoveryError || recoveryStatus?.error}</span><button onClick={() => void recoveryQueue.current?.retry().then(() => {setRecoveryError(""); checkpointRef.current();}).catch((error) => setRecoveryError(String(error)))}>復旧用保存を再試行</button></> :
          recoveryStatus?.state === "saving" ? "復旧用保存中" : "復旧用保存済み"}
      </div>
      {sidebar && (
        <aside className="sidebar" aria-label="サイドバー">
          <div className="mac-drag" />
          <div className="workspace">
            <div className="brand-mark">f</div>
            <span>
              My workspace<small>自分だけの、考える場所</small>
            </span>
            <ChevronDown size={14} />
          </div>
          <nav className="sidebar-nav" aria-label="ワークスペース操作">
            <button onClick={openSearch}>
              <Search size={17} />
              <span>検索</span>
              <kbd>⌘ K</kbd>
            </button>
            <button onClick={() => safe(() => create())}>
              <Plus size={17} />
              <span>新しいページ</span>
              <kbd>⌘ N</kbd>
            </button>
            <button onClick={() => {if (!composition.current) {setDialog(null); setNewDatabaseOpen(true);}}}>
              <DatabaseIcon size={17} /><span>新しいデータベース</span>
            </button>
          </nav>
          <div className="sidebar-scroll">
            {live.some((p) => p.favorite) && (
              <div className="sidebar-section">
                <div className="section-label">
                  <span>お気に入り</span>
                </div>
                <div className="favorites">
                  {live
                    .filter((p) => p.favorite)
                    .map((p) => (
                      <button
                        key={p.id}
                        className="favorite-row"
                        title={p.title || "無題"}
                        aria-current={p.id === activeId ? "page" : undefined}
                        onClick={() => select(p.id)}
                      >
                        <span className="page-emoji">{p.icon}</span>
                        <span className="page-tree-title">
                          {p.title || "無題"}
                        </span>
                      </button>
                    ))}
                </div>
              </div>
            )}
            <div className="sidebar-section">
              <div className="section-label">
                <span>プライベート</span>
                <span className="section-meta">
                  <span className="section-count">{live.length}</span>
                  <button
                    aria-label="ページを追加"
                    onClick={() => safe(() => create())}
                  >
                    <Plus size={14} />
                  </button>
                </span>
              </div>
              {live.length ? (
                <div className="page-tree">{tree(null)}</div>
              ) : (
                <p className="sidebar-empty">
                  ページがまだありません。⌘N で作りはじめましょう。
                </p>
              )}
              <button
                className="new-root"
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes("application/x-folio-page"))
                    e.preventDefault();
                }}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData("application/x-folio-page");
                  if (id) safe(() => move(id, null));
                }}
                onClick={() => safe(() => create())}
              >
                <Plus size={15} />
                ページを追加
              </button>
            </div>
          </div>
          <div className="sidebar-footer">
            <div className="sidebar-footer-actions">
              <button
                title="ページテンプレートから作成"
                onClick={() => setDialog("templates")}
              >
                <BookOpen size={16} />
                テンプレート
              </button>
              <button title="Markdown / HTML を読み込む" onClick={importPage}>
                <Upload size={16} />
                インポート
              </button>
              <button
                title="削除したページを復元"
                onClick={() => setDialog("trash")}
              >
                <Trash2 size={16} />
                ゴミ箱{" "}
                <small>{pages.filter((p) => p.deletedAt).length || ""}</small>
              </button>
            </div>
            <div className="sidebar-bottom">
              <span>
                <i aria-hidden="true" />
                ローカルワークスペース
              </span>
              <button
                aria-label="テーマを切り替え"
                aria-pressed={theme === "dark"}
                title="⌘⇧L"
                onClick={toggleTheme}
              >
                {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
              </button>
            </div>
          </div>
        </aside>
      )}
      <main className="main-pane">
        <header className="topbar">
          <div className="topbar-group topbar-nav">
            <button
              aria-label="サイドバーを切り替え"
              aria-pressed={sidebar}
              title="サイドバー (⌘\\)"
              onClick={() => setSidebar((v) => !v)}
            >
              <PanelLeft size={17} />
            </button>
            <span className="topbar-divider" aria-hidden="true" />
            <button
              aria-label="前のページ"
              title="前のページ (⌘[)"
              onClick={() => back(-1)}
              disabled={historyIndex.current <= 0}
            >
              <ArrowLeft size={16} />
            </button>
            <button
              aria-label="次のページ"
              title="次のページ (⌘])"
              onClick={() => back(1)}
              disabled={historyIndex.current >= history.current.length - 1}
            >
              <ArrowRight size={16} />
            </button>
          </div>
          <nav className="breadcrumbs" aria-label="ページの階層">
            {ancestors.map((p) => (
              <span className="crumb" key={p.id}>
                <button title={p.title} onClick={() => select(p.id)}>
                  {p.icon} {p.title}
                </button>
                <span className="crumb-separator" aria-hidden="true">
                  /
                </span>
              </span>
            ))}
            <span className="crumb crumb-current" aria-current="page">
              {page?.icon} {page?.title || "ワークスペース"}
            </span>
          </nav>
          <div className="spacer" />
          <div
            className="topbar-group topbar-actions"
            inert={creatingPage || !!recordView || undefined}
          >
            <span
              className={"save-state " + (error ? "error" : "")}
              data-state={error ? "error" : pending || edits.current.size || sessions.current.hasUnsaved() || hasNumberDrafts() || hasDatabasePending() || recoveryStatus?.state !== "saved" || recoveryError ? "pending" : "saved"}
              aria-live="polite"
            >
              {error ? (
                "保存エラー"
              ) : pending || edits.current.size || sessions.current.hasUnsaved() || hasNumberDrafts() || hasDatabasePending() || recoveryStatus?.state !== "saved" || recoveryError ? (
                "保存中…"
              ) : (
                <>
                  <Check size={12} />
                  保存済み
                </>
              )}
            </span>
            {page && (
              <button
                aria-label="お気に入り"
                aria-pressed={!!page.favorite}
                title="お気に入りに追加"
                className={page.favorite ? "starred" : ""}
                disabled={recordIds.has(page.id) || recordDatabaseIdsRef.current.has(page.id)}
                onClick={() => update(page.id, { favorite: !page.favorite })}
              >
                <Star
                  size={17}
                  fill={page.favorite ? "currentColor" : "none"}
                />
              </button>
            )}
            <button
              aria-label="ページ情報"
              aria-pressed={inspector}
              title="ページ情報"
              onClick={() => setInspector((v) => !v)}
            >
              <PanelRight size={17} />
            </button>
            <div className="menu-anchor">
              <button
                aria-label="ページメニュー"
                aria-expanded={menu}
                title="ページメニュー"
                onClick={() => setMenu((v) => !v)}
              >
                <MoreHorizontal size={20} />
              </button>
              {menu && page && (
                <div className="dropdown">
                  <div className="menu-section-label">ページ</div>
                  <button onClick={duplicate} disabled={recordIds.has(page.id) || recordDatabaseIdsRef.current.has(page.id)}>
                    <Copy size={15} />
                    複製
                  </button>
                  <button
                    disabled={recordIds.has(page.id) || recordDatabaseIdsRef.current.has(page.id)}
                    onClick={() => {
                      setDialog("move");
                      setMenu(false);
                    }}
                  >
                    <FolderInput size={15} />
                    移動する
                  </button>
                  <button disabled={recordIds.has(page.id) || recordDatabaseIdsRef.current.has(page.id)} onClick={() => safe(() => create(page.id))}>
                    <Plus size={15} />
                    子ページを追加
                  </button>
                  <button onClick={openHistory} disabled={recordIds.has(page.id) || recordDatabaseIdsRef.current.has(page.id)}>
                    <History size={15} />
                    変更履歴
                  </button>
                  <hr />
                  <div className="menu-section-label">書き出し・復旧</div>
                  <button
                    onClick={() =>
                      safe(() =>
                        mutate(async () => {
                          const copies = await api<Page[] | null>({
                            type: "recover",
                          });
                          if (copies?.length) {
                            await refresh();
                            select(copies[0].id);
                            setNotice(
                              "退避内容を新しいページとして復旧しました。元のページも保持しています。",
                            );
                          }
                        }),
                      )
                    }
                  >
                    退避JSONから復旧
                  </button>
                  <button onClick={() => exportPage("md")}>
                    <Download size={15} />
                    Markdownを書き出す
                  </button>
                  <button onClick={() => exportPage("html")}>
                    <Download size={15} />
                    HTMLを書き出す
                  </button>
                  <button onClick={() => exportPage("json")}>
                    <Download size={15} />
                    JSONを書き出す
                  </button>
                  <button
                    onClick={() =>
                      safe(async () => {
                        await ensureSaved();
                        const path = await api<string>({ type: "backup" });
                        setNotice("バックアップを保存しました：" + path);
                        setMenu(false);
                      })
                    }
                  >
                    <Copy size={15} />
                    ワークスペースをバックアップ
                  </button>
                  <hr />
                  <button className="danger" onClick={trash} disabled={recordIds.has(page.id) || recordDatabaseIdsRef.current.has(page.id)}>
                    <Trash2 size={15} />
                    ゴミ箱に移動
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            {edits.current.size ? (
              <div>
                {pageOperations.current.size > 0 && <button onClick={() => safe(resolvePageSaves)}>保存結果を確認</button>}
                <button
                  onClick={() => {
                    // Existing Page drafts do not reliably retain their input
                    // revision. Replaying them against a refreshed Page could
                    // silently overwrite a newer external edit.
                    fail("保存の競合を安全に再試行できません。未保存の変更を記録してから内容を確認してください。");
                  }}
                >
                  保存を再試行
                </button>
                <button
                  onClick={() =>
                    safe(async () => {
                      // IME text may not yet have reached the pending queue.
                      if (composition.current)
                        throw new Error("文字の変換を確定してから未保存の変更を記録してください。変更は保持しています。");
                      // Capture synchronously. Saving the journal never ACKs or
                      // discards any edit, including input made during the dialog.
                      const journal = capturePendingJournal(edits.current);
                      const content = serializePendingJournal(journal);
                      pendingRef.current++;
                      setPending(pendingRef.current);
                      try {
                        const path = await api<string | null>({
                          type: "exportPendingJournal",
                          content,
                        });
                        if (path) {
                          const later = edits.current.sequence !== journal.capturedThrough;
                          setNotice(
                            "記録開始時点の未保存変更を保存しました。添付・履歴は含まれず、自動復元はできません。" +
                            (later ? "記録開始後の入力は含まれていません。" : "") +
                            "この記録の作成では未保存の変更を消去していません。",
                          );
                        }
                      } finally {
                        pendingRef.current--;
                        setPending(pendingRef.current);
                      }
                    })
                  }
                >
                  未保存の変更を別ファイルに記録
                </button>
                <button
                  onClick={() =>
                    safe(async () => {
                      await enqueue(async () => {
                        if (pageOperations.current.size || sessions.current.hasUnsaved() || hasNumberDrafts() || hasDatabasePending())
                          throw new Error("保存結果不明または未保存レコードがあります。結果を確認するまで退避・再読込できません。");
                        const through = edits.current.sequence;
                        const recoverySelection = selectionVersion.current;
                        const recoveryEditor = currentEditor();
                        if (composition.current)
                          throw new Error("文字の変換を確定してから退避してください。未保存変更を保持しています。");
                        // Re-read authoritative membership before writing a
                        // Page-only recovery file. A newly created v4 database
                        // may not yet be present in the last rendered snapshot.
                        // If load fails, leave every pending entry untouched.
                        const membershipEpoch = refreshEpoch.current;
                        const membership = await api<Snapshot>({
                          type: "load",
                        });
                        if (membershipEpoch !== refreshEpoch.current)
                          throw new Error("所属の確認中に表示が変わりました。未保存変更を保持しています。");
                        if ((recordIdsRef.current.size || recordDatabaseIdsRef.current.size) &&
                            (!membership.records || !membership.recordDatabaseIds))
                          throw new Error("レコードの所属を確認できません。未保存変更を保持しています。");
                        refreshEpoch.current++;
                        recordIdsRef.current = new Set([
                          ...recordIdsRef.current,
                          ...(membership.records ?? []).map((record) => record.pageId),
                        ]);
                        recordDatabaseIdsRef.current = new Set([
                          ...recordDatabaseIdsRef.current,
                          ...(membership.recordDatabaseIds ?? []),
                        ]);
                        setRecordIds(recordIdsRef.current);
                        if (
                          edits.current
                            .snapshotValues()
                            .some((entry) => entry.seq <= through) ||
                          edits.current
                            .snapshotSettings()
                            .some((entry) => entry.seq <= through) ||
                          edits.current
                            .snapshot()
                            .some(
                              (entry) =>
                                entry.seq <= through &&
                                (recordIdsRef.current.has(entry.id) ||
                                  recordDatabaseIdsRef.current.has(entry.id)),
                            )
                        )
                          throw new Error(
                            "レコードとそのデータベースの退避には所属・値・添付を含む新しい復旧形式が必要です。未保存変更を保持しています。",
                          );
                        const content = recoveryContent(
                          pageRef.current,
                          edits.current.snapshot(),
                        );
                        const path = await api<string | null>({
                          type: "exportRecovery",
                          content,
                        });
                        if (!path) return;
                        // Do not discard pending edits if the post-write reload fails.
                        const persisted = await api<Snapshot>({ type: "load" });
                        if (selectionVersion.current !== recoverySelection ||
                            refreshEpoch.current !== membershipEpoch + 1 ||
                            currentEditor() !== recoveryEditor || composition.current ||
                            edits.current.sequence !== through)
                          throw new Error("退避後に表示や入力が変わりました。ファイルは保存されていますが未保存変更は保持しています。");
                        edits.current.discardThrough(through);
                        pageSessions.current.clear();
                        // The verified legacy export has taken ownership of these
                        // inputs. Retire the crash checkpoint before a restart.
                        await recoveryBarrierRef.current();
                        const state = {
                          ...persisted,
                          pages: edits.current.merge(persisted.pages),
                        };
                        commit(state.pages);
                        const current = state.pages.find(
                          (p) => p.id === activeRef.current,
                        );
                        if (current && !current.documentError)
                          currentEditor()?.commands.setContent(current.doc, {
                            emitUpdate: false,
                          });
                        setError("");
                        setNotice(
                          "未保存の内容をJSONに退避し、保存済みデータを読み直しました",
                        );
                      });
                    })
                  }
                >
                  退避して再読込
                </button>
              </div>
            ) : (
              <button onClick={() => setError("")}>閉じる</button>
            )}
          </div>
        )}
        {databaseCreation.current?.state === "unknown" && !newDatabaseOpen && <div className="r5-database-operation" role="status">
          <span>データベースの作成結果を確認できません。名前と操作を保持しています。</span>
          <button disabled={databaseCreating.current} onClick={() => void resolveDatabaseCreation()}>作成結果を確認</button>
        </div>}
        <div className="document-layout" style={{ position: "relative" }}>
          <div
            className="document-scroll"
            onClick={(e) => {
              const a = (e.target as HTMLElement).closest("a");
              if (a) {
                e.preventDefault();
                if (a.href.startsWith("folio-page://")) {
                  const id = a.href
                    .slice("folio-page://".length)
                    .replace(/\/$/, "");
                  if (live.some((p) => p.id === id)) select(id);
                  else setNotice("リンク先のページが見つかりません");
                } else if (a.href.startsWith("folio-asset://"))
                  safe(async () => {
                    const saved = await api<string | null>({
                      type: "downloadAttachment",
                      url: a.href,
                    });
                    if (saved) setNotice("添付を保存しました");
                  });
                else if (/^https?:\/\//.test(a.href))
                  safe(() => api({ type: "openExternal", url: a.href }));
              }
            }}
          >
            {creatingPage && <p role="status">ページを作成中です…</p>}
            {page ? (
              <article
                className={
                  "document " + (page.kind === "database" ? "wide" : "")
                }
                key={page.id}
                hidden={creatingPage}
                inert={restoringIds.has(page.id) || undefined}
                data-kind={page.kind}
                data-document-error={page.documentError ? "true" : undefined}
              >
                {page.cover && (
                  <div
                    className={
                      "cover " +
                      (page.cover.startsWith("folio-asset:")
                        ? "image-cover"
                        : page.cover)
                    }
                    style={
                      page.cover.startsWith("folio-asset:")
                        ? { backgroundImage: `url("${page.cover}")` }
                        : undefined
                    }
                  >
                    <div className="cover-landscape" />
                    <button
                      title="カバーの色・画像を切り替え"
                      disabled={recordIds.has(page.id) || recordDatabaseIdsRef.current.has(page.id)}
                      onClick={() =>
                        update(page.id, {
                          cover:
                            page.cover === "sage"
                              ? "sand"
                              : page.cover === "sand"
                                ? "dusk"
                                : page.cover === "dusk"
                                  ? ""
                                  : "sage",
                        })
                      }
                    >
                      カバーを変更
                    </button>
                  </div>
                )}
                <div className="document-content">
                  <div className="page-decoration">
                    {page.recoveredFrom && (
                      <span
                        className="recovered-badge"
                        title="退避JSONから別ページに復旧しました"
                      >
                        復旧ページ
                      </span>
                    )}
                    <div className="menu-anchor">
                      <button
                        className="page-icon"
                        aria-label="ページアイコン"
                        aria-expanded={iconMenu}
                        title="アイコンを変更"
                        disabled={recordIds.has(page.id) || recordDatabaseIdsRef.current.has(page.id)}
                        onClick={() => setIconMenu((v) => !v)}
                      >
                        {page.icon}
                      </button>
                      {iconMenu && (
                        <div
                          className="icon-picker"
                          role="group"
                          aria-label="アイコンを選択"
                        >
                          {icons.map((i) => (
                            <button
                              key={i}
                              aria-label={"アイコン " + i}
                              onClick={() => {
                                update(page.id, { icon: i });
                                setIconMenu(false);
                              }}
                            >
                              {i}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="page-tools" hidden={recordIds.has(page.id) || recordDatabaseIdsRef.current.has(page.id)}>
                      {!page.cover && (
                        <button
                          title="このページにカバーを追加"
                          onClick={() => update(page.id, { cover: "sage" })}
                        >
                          カバーを追加
                        </button>
                      )}
                      <button title="ファイルを添付" onClick={attach}>
                        <Paperclip size={12} />
                        添付
                      </button>
                      <button
                        title="画像をカバーに設定"
                        onClick={() =>
                          safe(async () => {
                            const f = await api<{
                              url: string;
                              image: boolean;
                            } | null>({ type: "attach" });
                            if (f?.image) update(page.id, { cover: f.url });
                            else if (f)
                              setNotice("カバーには画像を選択してください");
                          })
                        }
                      >
                        画像カバー
                      </button>
                    </div>
                  </div>
                  <input
                    className="page-title"
                    aria-label="ページタイトル"
                    placeholder="無題"
                    value={page.title}
                    disabled={!!page.documentError || restoringIds.has(page.id) || recordIds.has(page.id) ||
                      (recordDatabaseIdsRef.current.has(page.id) && (!activeDatabase || ["unknown", "conflict", "blocked"].includes(activeDatabase.state)))}
                    onChange={(e) => update(page.id, { title: e.target.value }, displayedSession?.sessionId)}
                  />
                  <div className="page-subtitle">
                    <span className="page-kind">
                      {page.kind === "database"
                        ? "データベース"
                        : "プライベートページ"}
                    </span>
                    <span className="meta-dot" aria-hidden="true">
                      ·
                    </span>
                    <span className="page-updated">
                      {new Date(page.updatedAt).toLocaleDateString("ja-JP", {
                        month: "long",
                        day: "numeric",
                      })}{" "}
                      更新
                    </span>
                  </div>
                  {findOpen && !page.documentError && (
                    <div className="page-find">
                      <Search size={14} />
                      <input
                        autoFocus
                        aria-label="ページ内検索"
                        placeholder="ページ内を検索"
                        value={pageFind}
                        onChange={(e) => setPageFind(e.target.value)}
                      />
                      <span>
                        {pageFind
                          ? textOf(page.doc)
                              .toLocaleLowerCase()
                              .split(pageFind.toLocaleLowerCase()).length - 1
                          : 0}{" "}
                        件
                      </span>
                      <button
                        onClick={() => {
                          if (
                            pageFind &&
                            document.querySelector(".folio-editor")
                          ) {
                            const e = currentEditor();
                            if (e) {
                              const match = findText(e.state.doc, pageFind)[0];
                              if (match)
                                e.chain()
                                  .focus()
                                  .setTextSelection(match)
                                  .scrollIntoView()
                                  .run();
                            }
                          }
                        }}
                      >
                        表示
                      </button>
                    </div>
                  )}
                  {page.kind === "database" && page.database && !page.documentError && <div className="r6-database-tools">
                    {recordDatabaseIdsRef.current.has(page.id)
                      ? <button type="button" onClick={() => void openStructural("property", page.id)}>列の設定</button>
                      : <button type="button" onClick={() => void openStructural("migration", page.id)}>旧DBをページ形式へ移行</button>}
                  </div>}
                  {page.documentError ? (
                    <div role="alert">
                      <p>{page.documentError}</p>
                      <button
                        onClick={() =>
                          safe(async () => {
                            const content = await api<string>({
                              type: "pageSource",
                              id: page.id,
                            });
                            await api({
                              type: "export",
                              name: page.title + "-original",
                              format: "json",
                              content,
                            });
                          })
                        }
                      >
                        原本JSONを保存
                      </button>
                    </div>
                  ) : recordIds.has(page.id) ? (
                    <section aria-label="レコード本文" className="record-body-preview">
                      <p role="status">レコード本文は読み取り専用です。</p>
                      <div style={{ whiteSpace: "pre-wrap" }}>{textOf(page.doc)}</div>
                    </section>
                  ) : page.kind === "page" ? (
                    <Editor
                      key={pageSession(page).sessionId}
                      documentId={page.id}
                      doc={page.doc}
                      editable={!restoringIds.has(page.id)}
                      onChange={(doc) => update(page.id, { doc }, displayedSession?.sessionId)}
                      onError={fail}
                      onReady={(e) => {
                        if (pageSessions.current.get(page.id)?.sessionId !== displayedSession?.sessionId || activeRef.current !== page.id) return;
                        editor.current = e;
                        editorId.current = page.id;
                        if (
                          recordIdsRef.current.has(page.id) &&
                          !recordWriteRevisions.current.has(page.id)
                        )
                          recordWriteRevisions.current.set(
                            page.id,
                            page.revision,
                          );
                      }}
                      onLink={openLink}
                    />
                  ) : recordDatabaseIdsRef.current.has(page.id) ? (
                    <LiveRecordDatabase
                      key={page.id}
                      databasePageId={page.id}
                      sessions={sessions.current}
                      databases={databases.current}
                      creatingRecord={creatingRows.current.has(page.id)}
                      onCreateRecord={() => void addRecord(page.id)}
                      filterInputTexts={filterDrafts.current[page.id] ?? {}}
                      onFilterInputTextChange={(viewId, filterId, text) => setFilterDraft(page.id, viewId, filterId, text)}
                      numberDrafts={numberDrafts.current}
                      onNumberDraft={setNumberDraft}
                      onOpenRecord={(id) => void openRecord(id, page.id)}
                      onError={fail}
                    />
                  ) : (
                    page.database && (
                      <Database
                        key={page.id + ":" + databaseEpoch}
                        value={page.database}
                        onChange={(database) => update(page.id, { database })}
                      />
                    )
                  )}
                  {children.length > 0 && (
                    <section className="child-pages" aria-label="子ページ">
                      <div className="child-pages-heading">
                        <span>子ページ</span>
                        <small>{children.length}</small>
                      </div>
                      {children.map((child) => (
                        <button
                          key={child.id}
                          title={child.title}
                          onClick={() => select(child.id)}
                        >
                          <span className="page-emoji">{child.icon}</span>
                          <strong>{child.title}</strong>
                          <ChevronRight size={15} aria-hidden="true" />
                        </button>
                      ))}
                    </section>
                  )}
                  <div className="document-end">
                    <span>✧</span>
                    <span>考えを、少しずつ。</span>
                  </div>
                </div>
              </article>
            ) : (
              <div className="empty-workspace">
                <BookOpen size={40} />
                <h1>新しいページから、はじめよう。</h1>
                <button
                  className="primary"
                  onClick={() => safe(() => create())}
                >
                  ページを作成
                </button>
              </div>
            )}
          </div>
          {recordView && openedRecord?.record && (
            <RecordPage
              key={openedRecord.handle.sessionId}
              pageId={recordView.id}
              record={openedRecord.record}
              draft={{ title: openedRecord.record.title, values: openedRecord.record.values }}
              properties={pageRef.current.find((p) => p.id === recordView.owner)?.database?.properties ?? []}
              editablePropertyTypes={["text", "number", "checkbox", "select", "date"]}
              propertyInputTexts={numberDrafts.current[recordView.id]}
              onPropertyInputTextChange={(propertyId, text) => setNumberDraft(recordView.id, propertyId, text)}
              mode={recordView.mode}
              onModeChange={(mode) => setRecordView((view) => view && { ...view, mode })}
              onClose={closeRecord}
              onBack={closeRecord}
              saveState={openedRecord.state === "pending" ? "saving" : openedRecord.state}
              error={openedRecord.error}
              onResolve={() => void sessions.current.resolve(recordView.id)}
              onTitleChange={(title) => editRecord(recordView.id, { title })}
              onValueChange={(propertyId, value) => editRecord(recordView.id, {}, { [propertyId]: value })}
              focusBody={() => editor.current?.commands.focus()}
              body={<Editor
                key={openedRecord.handle.sessionId}
                documentId={recordView.id}
                doc={openedRecord.page.doc}
                onChange={(doc) => editRecord(recordView.id, { doc })}
                onReady={(instance) => { editor.current = instance; editorId.current = recordView.id; }}
                onError={fail}
                onLink={openLink}
              />}
            />
          )}
          {inspector && page && (
            <aside
              className="inspector"
              aria-label="ページの情報"
              inert={creatingPage || !!recordView || undefined}
            >
              <h2 className="inspector-heading">
                <span>ページの情報</span>
                <span className="inspector-heading-actions">
                  <Settings2 size={14} aria-hidden="true" />
                  <button
                    className="inspector-close"
                    aria-label="情報パネルを閉じる"
                    title="情報パネルを閉じる"
                    onClick={() => setInspector(false)}
                  >
                    <X size={14} />
                  </button>
                </span>
              </h2>
              <section className="inspector-section">
                <h3 className="inspector-label">このページ</h3>
                <p className="inspector-page">
                  {page.icon} {page.title}
                </p>
                <dl>
                  <dt>作成日</dt>
                  <dd>
                    {new Date(page.createdAt).toLocaleDateString("ja-JP")}
                  </dd>
                  <dt>文字数</dt>
                  <dd>
                    {page.documentError
                      ? "—"
                      : textOf(page.doc).length.toLocaleString()}
                  </dd>
                  <dt>保存先</dt>
                  <dd>このMac</dd>
                </dl>
              </section>
              <section className="inspector-section">
                <h3 className="inspector-label">アウトライン</h3>
                {headings.length ? (
                  headings.map((h, i) => (
                    <button
                      className="outline-item"
                      key={i}
                      style={{
                        paddingLeft: ((h.attrs?.level as number) || 2) * 7 - 7,
                      }}
                      title={textOf(h)}
                      onClick={() =>
                        document
                          .querySelectorAll(
                            ".folio-editor h1,.folio-editor h2,.folio-editor h3",
                          )
                          [i]?.scrollIntoView({
                            behavior: "smooth",
                            block: "center",
                          })
                      }
                    >
                      {textOf(h)}
                    </button>
                  ))
                ) : (
                  <p className="subtle">見出しを追加すると表示されます</p>
                )}
              </section>
              <section className="inspector-section">
                <h3 className="inspector-label">
                  バックリンク <small>{backlinks.length}</small>
                </h3>
                {backlinks.map((p) => (
                  <button
                    className="outline-item"
                    key={p.id}
                    title={p.title}
                    onClick={() => select(p.id)}
                  >
                    {p.icon} {p.title}
                  </button>
                ))}
                {!backlinks.length && (
                  <p className="subtle">
                    他のページからのリンクが
                    <br />
                    ここに集まります。
                  </p>
                )}
              </section>
              <button className="history-link" onClick={openHistory} disabled={!!page && (recordIds.has(page.id) || recordDatabaseIdsRef.current.has(page.id))}>
                <History size={14} aria-hidden="true" />
                変更履歴を見る
              </button>
              <div className="inspector-tip">
                <Command size={17} aria-hidden="true" />
                <p>
                  <kbd>⌘ K</kbd> で、すぐに移動。
                  <br />
                  アイデアの流れを止めずに。
                </p>
              </div>
            </aside>
          )}
        </div>
      </main>
      {notice && (
        <div className="toast" role="status">
          <Check size={15} />
          {notice}
        </div>
      )}
      {newDatabaseOpen && <NewDatabaseDialog title={newDatabaseTitle} onTitle={setNewDatabaseTitle}
        state={databaseCreating.current ? "saving" : databaseCreation.current?.state ?? "idle"}
        error={databaseCreation.current?.error} onSubmit={() => void createRegisteredDatabase()}
        onResolve={() => void resolveDatabaseCreation()} onClose={() => setNewDatabaseOpen(false)} />}
      {dialog && (
        <DialogFrame
          modal={["search", "link"].includes(dialog)}
          className={
            "modal " +
            (["search", "link"].includes(dialog) ? "search-modal" : "")
          }
          name={
            dialog === "search"
              ? "ワークスペース検索"
              : dialog === "link"
                ? "ページリンク"
                : dialog === "move"
                  ? "ページを移動"
                  : dialog === "history"
                    ? "変更履歴"
                    : dialog === "trash"
                      ? "ゴミ箱"
                      : "テンプレート"
          }
          onClose={() => setDialog(null)}
          restoreFocus={restoreDialogFocus}
        >
          {["search", "link"].includes(dialog) ? (
            <>
              <div className="search-input">
                <Search size={20} />
                <input
                  data-initial-focus
                  aria-label="検索キーワード"
                  placeholder={
                    dialog === "link"
                      ? "リンクするページを検索…"
                      : "ページや本文を検索…"
                  }
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setResults([]);
                    setSearchIndex(0);
                  }}
                  onKeyDown={(e) => {
                    if (
                      e.defaultPrevented ||
                      composing(e.nativeEvent, composition.current)
                    )
                      return;
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setSearchIndex((i) =>
                        Math.min(i + 1, results.length - 1),
                      );
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setSearchIndex((i) => Math.max(0, i - 1));
                    }
                    if (e.key === "Enter" && results[searchIndex]) {
                      e.preventDefault();
                      if (dialog === "link") {
                        applyPageLink(results[searchIndex]);
                      } else select(results[searchIndex].id);
                    }
                  }}
                />
                <button aria-label="閉じる" onClick={() => setDialog(null)}>
                  閉じる
                </button>
              </div>
              <div className="menu-caption">
                {query ? "検索結果" : "すべてのページ"}
              </div>
              <div
                className="search-results"
                role="group"
                aria-label={query ? "検索結果" : "すべてのページ"}
              >
                {results.length ? (
                  results.map((p, i) => (
                    <button
                      key={p.id}
                      className={i === searchIndex ? "active" : ""}
                      aria-current={i === searchIndex ? "true" : undefined}
                      title={p.title || "無題"}
                      onClick={() => {
                        if (dialog === "link") {
                          applyPageLink(p);
                        } else select(p.id);
                      }}
                    >
                      <span className="result-icon">{p.icon}</span>
                      <span className="result-text">
                        <strong>{p.title || "無題"}</strong>
                        <small>
                          {p.documentError
                            ? "未対応の文書（原本を保全）"
                            : textOf(p.doc).slice(0, 85) || "空のページ"}
                        </small>
                      </span>
                      <ChevronRight size={15} aria-hidden="true" />
                    </button>
                  ))
                ) : (
                  <p className="empty">見つかりませんでした</p>
                )}
              </div>
              {dialog === "search" && (
                <div className="palette-actions">
                  <button
                    title="新しいページ (⌘N)"
                    onClick={() => safe(() => create())}
                  >
                    <Plus size={14} />
                    ページを作成
                  </button>
                  <button
                    title="新しいデータベース"
                    onClick={() =>
                      safe(() => create(null, "database", "新しいデータベース"))
                    }
                  >
                    <DatabaseIcon size={14} />
                    データベース
                  </button>
                  <button title="テーマを切り替え (⌘⇧L)" onClick={toggleTheme}>
                    {theme === "light" ? <Moon size={14} /> : <Sun size={14} />}
                    テーマ
                  </button>
                </div>
              )}
              <footer className="search-footer">
                <span className="search-hint">
                  <kbd>↑</kbd>
                  <kbd>↓</kbd> 選択
                </span>
                <span className="search-hint">
                  <kbd>↵</kbd> 開く
                </span>
                <span className="search-hint search-hint-end">
                  タイトルと本文を検索
                </span>
              </footer>
            </>
          ) : (
            <>
              <div className="modal-header">
                <h3>
                  {dialog === "move"
                    ? "ページを移動"
                    : dialog === "history"
                      ? "変更履歴"
                      : dialog === "trash"
                        ? "ゴミ箱"
                        : "新しいページのはじまり"}
                </h3>
                <button
                  className="modal-close"
                  data-initial-focus={dialog === "history" ? true : undefined}
                  onClick={() => setDialog(null)}
                >
                  閉じる
                </button>
              </div>
              {dialog === "templates" && (
                <div className="templates">
                  <button
                    className="template-card"
                    title="空のページを作成"
                    onClick={() => safe(() => create())}
                  >
                    <span>📄</span>
                    <strong>空のページ</strong>
                    <small>自由に書きはじめる</small>
                  </button>
                  {templates.map((t) => (
                    <button
                      className="template-card"
                      key={t.title}
                      title={t.title + "を作成"}
                      onClick={() =>
                        safe(async () => {
                          const p = await create(null, "page", t.title, t.doc);
                          update(p.id, { icon: t.icon });
                        })
                      }
                    >
                      <span>{t.icon}</span>
                      <strong>{t.title}</strong>
                      <small>考えるための、ひとつの型</small>
                    </button>
                  ))}
                  <button
                    onClick={() =>
                      safe(() => create(null, "database", "新しいデータベース"))
                    }
                  >
                    <span>▦</span>
                    <strong>データベース</strong>
                    <small>テーブル・ボード・カレンダー</small>
                  </button>
                </div>
              )}
              {dialog === "move" && (
                <div className="dialog-list">
                  <button onClick={() => safe(() => move(activeId, null))}>
                    ⌂ ワークスペースの最上位
                  </button>
                  {live
                    .filter((p) => p.id !== activeId)
                    .map((p) => (
                      <button
                        key={p.id}
                        onClick={() => safe(() => move(activeId, p.id))}
                      >
                        {p.icon} {p.title}
                      </button>
                    ))}
                </div>
              )}
              {dialog === "trash" && (
                <div className="dialog-list">
                  {pages.filter((p) => p.deletedAt).length ? (
                    pages
                      .filter((p) => p.deletedAt)
                      .map((p) => (
                        <div key={p.id}>
                          <span>
                            {p.icon} {p.title}
                          </span>
                          <button
                            disabled={recordIds.has(p.id) || recordDatabaseIdsRef.current.has(p.id)}
                            onClick={() =>
                              safe(async () => {
                                await mutate(async () => {
                                  await api({ type: "restore", id: p.id });
                                  await refresh();
                                });
                                setNotice("ページを復元しました");
                              })
                            }
                          >
                            復元
                          </button>
                        </div>
                      ))
                  ) : (
                    <p className="empty">ゴミ箱は空です</p>
                  )}
                </div>
              )}
              {dialog === "history" && (
                <div className="dialog-list">
                  {versions.length ? (
                    versions.map((v) => (
                      <div key={v.id}>
                        <span>
                          <strong>
                            {new Date(v.createdAt).toLocaleString("ja-JP")}
                          </strong>
                          <small>
                            {v.title} ·{" "}
                            {v.database
                              ? `${v.database.rows.length} 行: ${v.database.rows.map((r) => r.title).join(", ")} / ${v.database.properties.map((p) => p.name).join(", ")}`
                              : textOf(v.doc).slice(0, 80)}
                          </small>
                        </span>
                        <button
                          onClick={() =>
                            safe(async () => {
                              const origin = historyOrigin.current;
                              if (!origin || origin.id !== activeId) throw new Error("履歴の対象が変わりました。");
                              await restorePageVersion(origin.id, v.id, origin.revision);
                            })
                          }
                        >
                          復元
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="empty">
                      本文・タイトル・DBを編集すると履歴が保存されます
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </DialogFrame>
      )}
      {structural && <StructuralDatabaseDialog family={structural.family} owner={structural.owner}
        onClose={() => setStructural(null)} retain={retainStructural}
        onApplied={async () => {await ensureSaved(); await retainStructural(null); window.location.reload();}} />}
    </div>
  );
}
