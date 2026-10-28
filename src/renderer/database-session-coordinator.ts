import { reconcileDatabaseRecovery } from "./crash-recovery-resume";
import type { DatabaseSessionRecovery } from "../shared/crash-recovery";
import type { DatabaseReadSnapshot } from "../shared/database-operation";
import type { DatabaseProjection, DatabaseSettings, FilterValue, Page, RecordPagePatch } from "../shared/types";
import type { DatabaseOperation, DatabaseOperationResult } from "../shared/database-operation";
import type { EditSessionHandle, EditSessionState } from "./edit-session-coordinator";
import type { SaveTransport } from "./reliable-save";
import { sendDatabaseOperation, resolveDatabaseOperation } from "./reliable-database-operation";
import { validateOwnerPage, assertOwnerTransition } from "./settings-save-coordinator";
import { applySettingsIntent, canonicalSettings, sameSettingsValue, type SettingsIntent } from "./settings-intent";

export type DatabaseSessionView = {
  handle: EditSessionHandle;
  page: Page;
  projection: DatabaseProjection;
  state: EditSessionState;
  error?: string;
  seq: number;
  operation?: DatabaseOperation;
  /** Latest applied record creation, retained across subsequent settings ACKs. */
  lastResult?: DatabaseOperationResult;
};
type Intent = {seq: number} & (
  {kind: "page"; patch: RecordPagePatch} | {kind: "settings"; intent: SettingsIntent} |
  {kind: "createRecord"; title: string; values: Record<string, FilterValue>}
);
type Lane = {handle: EditSessionHandle; page: Page; projection: DatabaseProjection; intents: Intent[];
  seq: number; state: EditSessionState; error?: string; operation?: DatabaseOperation;
  lastResult?: DatabaseOperationResult; running?: Promise<void>};

/** App-owned: owner metadata, view intents and record creation use one revision
 * lineage. A list refresh cannot promote draft settings onto a newer owner. */
export class DatabaseSessionCoordinator {
  private lanes = new Map<string, Lane>();
  private listeners = new Set<() => void>();
  constructor(private readonly send: SaveTransport = (request) => window.folio.request(request),
    private readonly options: {timeoutMs?: number; uuid?: () => string; beforeSend?: () => Promise<void>} = {}) {}
  private uuid() {return this.options.uuid?.() ?? crypto.randomUUID();}
  subscribe(callback: () => void) {this.listeners.add(callback); return () => {this.listeners.delete(callback);};}
  private notify() {for (const callback of this.listeners) callback();}
  attach(page: Page, projection: DatabaseProjection): EditSessionHandle {
    const prior = this.lanes.get(page.id);
    if (prior) return prior.handle;
    if (page.kind !== "database" || !page.database || page.database.rows.length || page.deletedAt !== null || page.documentError ||
      projection.revision !== page.revision || projection.records.some((record) => record.databasePageId !== page.id))
      throw new Error("データベースの表示と保存前提が一致しません。");
    validateOwnerPage(page, page.id, projection.revision, canonicalSettings(projection.settings));
    const {rows: _rows, ...settings} = page.database;
    if (!sameSettingsValue(canonicalSettings(settings), canonicalSettings(projection.settings))) throw new Error("データベース設定が一致しません。");
    const handle = Object.freeze({pageId: page.id, sessionId: this.uuid()});
    this.lanes.set(page.id, {handle, page: structuredClone(page), projection: structuredClone(projection),
      seq: 0, intents: [], state: "saved"});
    this.notify();
    return handle;
  }
  exportRecovery(includeClean = false): DatabaseSessionRecovery[] {
    return [...this.lanes.values()].filter((lane) => includeClean || lane.intents.length || lane.operation).map((lane) => ({
      sessionId: lane.handle.sessionId, base: structuredClone(lane.page), projection: structuredClone(lane.projection),
      seq: lane.seq, intents: structuredClone(lane.intents), ...(lane.operation ? {operation: structuredClone(lane.operation)} : {}),
    }));
  }
  restoreRecovery(input: DatabaseSessionRecovery, current: DatabaseReadSnapshot, resolved?: DatabaseOperationResult): EditSessionHandle {
    if (this.lanes.has(input.base.id)) throw new Error("データベース編集セッションが既にあります。");
    const entry = reconcileDatabaseRecovery(input, current, resolved);
    const handle = Object.freeze({pageId: entry.base.id, sessionId: entry.sessionId});
    this.lanes.set(entry.base.id, {handle, page: entry.base, projection: entry.projection, seq: entry.seq, intents: entry.intents,
      operation: entry.operation, state: entry.operation ? resolved?.status === "rejected" ? "conflict" : "unknown" : entry.intents.length ? "pending" : "saved",
      ...(resolved?.status === "applied" && resolved.commandKind === "createRecord" ? {lastResult: structuredClone(resolved)} : {})});
    this.notify(); return handle;
  }
  private overlay(lane: Lane) {
    let settings = structuredClone(lane.projection.settings);
    let page = structuredClone(lane.page);
    for (const entry of lane.intents) {
      if (entry.kind === "page") Object.assign(page, entry.patch);
      if (entry.kind === "settings") settings = applySettingsIntent(settings, entry.intent);
    }
    page.database = {...settings, rows: []};
    return {page, projection: {...structuredClone(lane.projection), settings}};
  }
  get(id: string): DatabaseSessionView | undefined {
    const lane = this.lanes.get(id);
    if (!lane) return;
    return {...this.overlay(lane), handle: lane.handle, state: lane.state, error: lane.error, seq: lane.seq,
      operation: lane.operation ? structuredClone(lane.operation) : undefined,
      lastResult: lane.lastResult ? structuredClone(lane.lastResult) : undefined};
  }
  views() {return [...this.lanes.keys()].map((id) => this.get(id)!);}
  hasUnsaved() {return [...this.lanes.values()].some((lane) => lane.intents.length || lane.operation || lane.running);}
  private lane(handle: EditSessionHandle) {
    const lane = this.lanes.get(handle.pageId);
    if (!lane || lane.handle.sessionId !== handle.sessionId) throw new Error("古いデータベース編集セッションです。");
    return lane;
  }
  private add(lane: Lane, intent: Omit<Extract<Intent, {kind: "page"}>, "seq"> |
    Omit<Extract<Intent, {kind: "settings"}>, "seq"> | Omit<Extract<Intent, {kind: "createRecord"}>, "seq">) {
    const seq = ++lane.seq;
    lane.intents.push({...structuredClone(intent), seq} as Intent);
    if (lane.state === "saved") lane.state = "pending";
    this.notify();
    return seq;
  }
  editPage(handle: EditSessionHandle, patch: RecordPagePatch) {
    if (Object.hasOwn(patch, "database")) throw new Error("設定変更は意味付き操作で送信してください。");
    return this.add(this.lane(handle), {kind: "page", patch});
  }
  editSettings(handle: EditSessionHandle, intent: SettingsIntent) {
    const lane = this.lane(handle);
    // Validate before retaining an unrenderable draft. UI must keep invalid form
    // text itself; accepted intents are durable in memory across navigation.
    applySettingsIntent(this.overlay(lane).projection.settings, intent);
    return this.add(lane, {kind: "settings", intent});
  }
  createRecord(handle: EditSessionHandle, title: string, values: Record<string, FilterValue> = {}) {
    return this.add(this.lane(handle), {kind: "createRecord", title, values});
  }
  flush(id: string): Promise<void> {
    const lane = this.lanes.get(id);
    if (!lane || ["unknown", "conflict", "blocked"].includes(lane.state)) return Promise.resolve();
    if (lane.running) return lane.running;
    const run = async () => {
      while (lane.intents.length && !["unknown", "conflict", "blocked"].includes(lane.state)) {
        const entry = lane.intents[0];
        let command: DatabaseOperation["command"];
        try {
          command = entry.kind === "createRecord" ? {kind: "createRecord", databasePageId: id, revision: lane.page.revision,
            title: entry.title, values: entry.values} : {kind: "updateDatabase", databasePageId: id, revision: lane.page.revision,
            patch: entry.kind === "page" ? entry.patch : {},
            settings: entry.kind === "settings" ? applySettingsIntent(lane.projection.settings, entry.intent) : lane.projection.settings};
        } catch (error) {
          lane.state = "conflict"; lane.error = error instanceof Error ? error.message : String(error); this.notify(); break;
        }
        const operation: DatabaseOperation = {operationId: this.uuid(), sessionId: lane.handle.sessionId, seq: entry.seq, command: structuredClone(command)};
        lane.operation = operation; lane.state = "saving"; this.notify();
        try {await this.options.beforeSend?.(); this.accept(lane, operation, await sendDatabaseOperation(operation, this.send, this.options.timeoutMs));}
        catch (error) {lane.state = "unknown"; lane.error = error instanceof Error ? error.message : String(error);}
        this.notify();
      }
    };
    lane.running = run().finally(() => {lane.running = undefined; this.notify();});
    return lane.running;
  }
  resolve(id: string): Promise<void> {
    const lane = this.lanes.get(id);
    if (!lane || lane.state !== "unknown" || !lane.operation) return Promise.resolve();
    if (lane.running) return lane.running;
    const operation = lane.operation;
    const run = async () => {
      try {this.accept(lane, operation, await resolveDatabaseOperation(operation, this.send, this.options.timeoutMs));}
      catch (error) {lane.state = "unknown"; lane.error = error instanceof Error ? error.message : String(error);}
      this.notify();
    };
    lane.running = run().finally(() => {lane.running = undefined; this.notify();});
    return lane.running.then(() => {if (lane.state === "pending") return this.flush(id);});
  }
  private accept(lane: Lane, operation: DatabaseOperation, result: DatabaseOperationResult) {
    if (lane.operation !== operation || lane.handle.sessionId !== operation.sessionId) return;
    if (result.status === "applied" && result.database && result.page) {
      if (operation.command.kind === "updateDatabase") {
        validateOwnerPage(result.page, lane.page.id, operation.command.revision + 1, operation.command.settings);
        assertOwnerTransition(lane.page, result.page, operation.command.patch, operation.command.settings);
        lane.page = structuredClone(result.page);
      }
      lane.projection = structuredClone(result.database);
      lane.intents = lane.intents.filter((entry) => entry.seq > operation.seq);
      if (operation.command.kind === "createRecord") lane.lastResult = structuredClone(result);
      lane.operation = undefined; lane.error = undefined;
      lane.state = lane.intents.length ? "pending" : "saved";
    } else {
      lane.state = result.status === "rejected" ? "conflict" : "unknown";
      lane.error = result.message ?? "データベースの保存結果を確認できません。";
    }
  }
}
