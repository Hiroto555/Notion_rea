import { reconcileEditRecovery } from "./crash-recovery-resume";
import type { EditSessionRecovery } from "../shared/crash-recovery";
import type { FilterValue, Page, PagePatch, RecordProjection } from "../shared/types";
import type { SaveOperation, SaveResult } from "../shared/save-contract";
import { validateRecordReadSnapshot } from "./record-save-coordinator";
import { resolveReliableSave, sendReliableSave, type SaveTransport } from "./reliable-save";

export type EditSessionHandle = Readonly<{pageId: string; sessionId: string}>;
export type EditSessionState = "saved" | "saving" | "pending" | "conflict" | "unknown" | "blocked";
export type EditSessionView = {
  handle: EditSessionHandle;
  page: Page;
  record?: RecordProjection;
  state: EditSessionState;
  error?: string;
  seq: number;
  baseRevision: number;
  operation?: SaveOperation;
};
type Intent = {seq: number; patch: PagePatch; values?: Record<string, FilterValue | null>};
type Lane = {
  handle: EditSessionHandle;
  base: Page;
  record?: RecordProjection;
  seq: number;
  intents: Intent[];
  state: EditSessionState;
  error?: string;
  operation?: SaveOperation;
  running?: Promise<void>;
};

/** Owned by App, never by a mounted peek/table. Refresh cannot rebase an
 * installed document; only this exact session's validated ACK advances base. */
export class EditSessionCoordinator {
  private lanes = new Map<string, Lane>();
  private listeners = new Set<() => void>();
  constructor(private readonly send: SaveTransport = (request) => window.folio.request(request),
    private readonly options: {timeoutMs?: number; uuid?: () => string; beforeSend?: () => Promise<void>} = {}) {}

  private uuid() {return this.options.uuid?.() ?? crypto.randomUUID();}
  subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
  private notify() { for (const listener of this.listeners) listener(); }
  attach(page: Page, record?: RecordProjection): EditSessionHandle {
    const existing = this.lanes.get(page.id);
    if (existing) return existing.handle;
    if (record) validateRecordReadSnapshot({page, record}, page.id, record.databasePageId);
    if (page.documentError || page.deletedAt !== null || !Number.isSafeInteger(page.revision))
      throw new Error("編集する本文の版を確認できません。");
    const handle = Object.freeze({pageId: page.id, sessionId: this.uuid()});
    this.lanes.set(page.id, {handle, base: structuredClone(page), record: record ? structuredClone(record) : undefined,
      seq: 0, intents: [], state: "saved"});
    this.notify();
    return handle;
  }
  exportRecovery(includeClean = false): EditSessionRecovery[] {
    return [...this.lanes.values()].filter((lane) => includeClean || lane.intents.length || lane.operation).map((lane) => ({
      sessionId: lane.handle.sessionId, base: structuredClone(lane.base), seq: lane.seq, intents: structuredClone(lane.intents),
      ...(lane.record ? {record: structuredClone(lane.record)} : {}), ...(lane.operation ? {operation: structuredClone(lane.operation)} : {}),
    }));
  }
  /** Explicit startup action only. Never replaces an already attached lane. */
  restoreRecovery(input: EditSessionRecovery, current: {page: Page; record?: RecordProjection}, resolved?: SaveResult): EditSessionHandle {
    if (this.lanes.has(input.base.id)) throw new Error("編集セッションが既にあります。復旧を停止しました。");
    const entry = reconcileEditRecovery(input, current, resolved);
    const handle = Object.freeze({pageId: entry.base.id, sessionId: entry.sessionId});
    this.lanes.set(entry.base.id, {handle, base: entry.base, record: entry.record, seq: entry.seq, intents: entry.intents,
      operation: entry.operation, state: entry.operation ? resolved?.status === "rejected" ? "conflict" : "unknown" : entry.intents.length ? "pending" : "saved"});
    this.notify(); return handle;
  }
  get(pageId: string): EditSessionView | undefined {
    const lane = this.lanes.get(pageId);
    if (!lane) return undefined;
    const patch: PagePatch = {}, values = {...lane.record?.values};
    for (const intent of lane.intents) {
      Object.assign(patch, intent.patch);
      for (const [key, value] of Object.entries(intent.values ?? {})) {
        if (value === null) delete values[key]; else values[key] = value;
      }
    }
    // Consumers receive a snapshot, never references that can mutate the
    // retained base/draft or the immutable request awaiting resolution.
    const page = structuredClone({...lane.base, ...patch});
    return {handle: lane.handle, page, record: lane.record ? {...lane.record, title: page.title, icon: page.icon, values} : undefined,
      state: lane.state, error: lane.error, seq: lane.seq, baseRevision: lane.base.revision,
      operation: lane.operation ? structuredClone(lane.operation) : undefined};
  }
  views(): EditSessionView[] {return [...this.lanes.keys()].map((id) => this.get(id)!);}
  hasUnsaved(): boolean {return [...this.lanes.values()].some((lane) => lane.intents.length > 0 || !!lane.operation || !!lane.running);}
  edit(handle: EditSessionHandle, patch: PagePatch, values?: Record<string, FilterValue | null>): number {
    const lane = this.lanes.get(handle.pageId);
    if (!lane || lane.handle.sessionId !== handle.sessionId) throw new Error("古い編集セッションです。保存を停止しました。");
    if (values && !lane.record) throw new Error("プロパティの所属を確認できません。");
    if (lane.record && patch.database !== undefined) throw new Error("レコードからDB構成を変更できません。");
    const seq = ++lane.seq;
    lane.intents.push({seq, patch: structuredClone(patch), ...(values ? {values: structuredClone(values)} : {})});
    if (lane.state === "saved") lane.state = "pending";
    this.notify();
    return seq;
  }
  flush(pageId: string): Promise<void> {
    const lane = this.lanes.get(pageId);
    if (!lane || ["conflict", "unknown", "blocked"].includes(lane.state)) return Promise.resolve();
    if (lane.running) return lane.running;
    const run = async () => {
      while (lane.intents.length && !["conflict", "unknown", "blocked"].includes(lane.state)) {
        const through = lane.intents.at(-1)!.seq;
        const patch: PagePatch = {}, values: Record<string, FilterValue | null> = {};
        for (const intent of lane.intents) {Object.assign(patch, intent.patch); Object.assign(values, intent.values);}
        const operation: SaveOperation = {operationId: this.uuid(), sessionId: lane.handle.sessionId, seq: through,
          pageId, databasePageId: lane.record?.databasePageId ?? null, revision: lane.base.revision,
          patch: structuredClone(patch), ...(Object.keys(values).length ? {values} : {})};
        lane.operation = operation;
        lane.state = "saving";
        this.notify();
        try { await this.options.beforeSend?.(); this.accept(lane, operation, await sendReliableSave(operation, this.send, this.options.timeoutMs)); }
        catch (error) {lane.state = "unknown"; lane.error = error instanceof Error ? error.message : String(error);}
        this.notify();
      }
    };
    lane.running = run().finally(() => {lane.running = undefined; this.notify();});
    return lane.running;
  }
  resolve(pageId: string): Promise<void> {
    const lane = this.lanes.get(pageId);
    if (!lane || lane.state !== "unknown" || !lane.operation) return Promise.resolve();
    if (lane.running) return lane.running;
    const operation = lane.operation;
    const run = async () => {
      try { this.accept(lane, operation, await resolveReliableSave(operation, this.send, this.options.timeoutMs)); }
      catch (error) {lane.state = "unknown"; lane.error = error instanceof Error ? error.message : String(error);}
      this.notify();
    };
    lane.running = run().finally(() => {lane.running = undefined; this.notify();});
    return lane.running.then(() => {if (lane.state === "pending") return this.flush(pageId);});
  }
  private accept(lane: Lane, operation: SaveOperation, result: SaveResult) {
    if (lane.operation !== operation || lane.handle.sessionId !== operation.sessionId) return;
    if (result.status === "applied" && result.page) {
      lane.base = structuredClone(result.page);
      if (result.record) lane.record = structuredClone(result.record);
      lane.intents = lane.intents.filter((intent) => intent.seq > operation.seq);
      lane.operation = undefined;
      lane.error = undefined;
      lane.state = lane.intents.length ? "pending" : "saved";
    } else {
      lane.state = result.status === "rejected" ? "conflict" : "unknown";
      lane.error = result.message ?? "保存結果を確認できません。入力を保持しています。";
    }
  }
}
