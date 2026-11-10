import {compactInline} from "./compact-inline";
import { randomUUID } from "node:crypto";
import { type RuntimeStoreOptions, RuntimeStore } from "./store";
import { DurableQueue, type QueueEntry } from "./durable-queue";
import { LocalHistory } from "./local-history";
import { canonical } from "./canonical";
import { checkedState } from "./document";
import { parseCut, parseScope } from "./wire";
import {
  clone,
  CollaborationError,
  type RuntimeEvent,
  demand,
  identifier,
  sameScope,
  scopeKey,
  type Scope,
  type Snapshot,
  type Command,
  type Attempt,
  type Receipt,
} from "./contract";
import type { SharedProvider } from "./provider-port";

/** Main-owned durable client. No optimistic acknowledgement or automatic resend. */
export class SharedRuntimeClient {
  readonly store: RuntimeStore;
  readonly queue: DurableQueue;
  readonly history: LocalHistory;
  private current: Snapshot | null = null;
  private textChanges: {seq: number; change: NonNullable<RuntimeEvent["appliedText"]>}[] = [];
  private busy = false;
  private historyResetPending = false;
  private closed = false;
  private pendingHistory: {intentId: string; command: Command; before: Snapshot; operation: boolean} | null = null;
  constructor(
    directory: string,
    readonly provider: SharedProvider,
    readonly scope: Scope,
    readonly writerId: string,
    options: RuntimeStoreOptions = {},
  ) {
    parseScope(scope);
    this.history = new LocalHistory(scope.incarnationId);
    identifier(writerId);
    this.store = new RuntimeStore(directory, options);
    try {
      const role = this.store.get("meta", "role");
      demand(role === null || role === "client", "WRONG_STORE_ROLE");
      if (role === null)
        this.store.transaction(() => this.store.set("meta", "role", "client"));
      this.queue = new DurableQueue(this.store, { scope, writerId });
      for (const entry of this.queue.entries())
        for (const attempt of entry.attempts)
          if (attempt.state === "PREPARED")
            this.queue.markUnknown(
              entry.intent.intentId,
              attempt.attempt.attemptId,
            );
    } catch (error) {
      this.store.close();
      throw error;
    }
  }
  private active() {
    demand(!this.closed, "CLIENT_CLOSED");
  }
  private async lock<T>(work: () => Promise<T>): Promise<T> {
    this.active();
    demand(!this.busy, "CLIENT_BUSY");
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }
  entries(): QueueEntry[] {
    this.active();
    return this.queue.entries();
  }
  snapshot(): Snapshot {
    this.active();
    demand(this.current, "NOT_OPEN");
    return clone(this.current);
  }
  private async refresh(): Promise<Snapshot> {
    this.active();
    const previous = this.current ?? this.store.get("client.snapshots", scopeKey(this.scope)) as Snapshot | null;
    let resetHistory = false;
    let next: Snapshot;
    try {
      next = previous ? await this.provider.snapshot(this.scope, previous.cut.seq) :
        await (this.provider.state?.(this.scope) ?? this.provider.snapshot(this.scope));
    } catch (error) {
      if (!(error instanceof CollaborationError) || error.code !== "RESPONSE_TOO_LARGE" || !this.provider.state) throw error;
      next = await this.provider.state(this.scope);
      resetHistory = true;
    }
    this.active();
    demand(sameScope(next.scope, this.scope), "SCOPE_MISMATCH");
    parseCut(next.cut);
    checkedState(next.state);
    if (previous) {
      demand(
        previous.cut.epoch === next.cut.epoch &&
          previous.cut.seq <= next.cut.seq,
        "SERVER_ROLLBACK_OR_EPOCH",
      );
      const proof = await this.provider.proof(this.scope, previous.cut.seq);
      this.active();
      demand(
        proof && canonical(proof) === canonical(previous.cut),
        "PREFIX_UNKNOWN_OR_ROLLBACK",
      );
    }
    if (resetHistory) {
      if (this.pendingHistory?.operation) this.historyResetPending = true; else this.history.clear();
      this.textChanges = [];
    }
    for (const event of next.events) {
      if (event.appliedText && !this.textChanges.some(item => item.seq === event.seq))
        this.textChanges.push({seq: event.seq, change: event.appliedText});
    }
    if (this.textChanges.length > 4096) {
      if (this.pendingHistory?.operation) this.historyResetPending = true; else this.history.clear();
      this.textChanges = [];
    }
    const events = new Map<number, RuntimeEvent>();
    if (!resetHistory) for (const event of previous?.events ?? []) events.set(event.seq, event);
    for (const event of next.events) events.set(event.seq, event);
    const recent: RuntimeEvent[] = []; let bytes = 0;
    for (const event of [...events.values()].sort((a,b) => b.seq-a.seq)) {
      const size = Buffer.byteLength(canonical(event, 8_000_000));
      if (bytes + size > 4_000_000 || recent.length >= 128) break;
      recent.push(event); bytes += size;
    }
    next = {...next, events: recent.reverse()};
    this.store.transaction(() =>
      this.store.set("client.snapshots", scopeKey(this.scope), next),
    );
    this.current = clone(next);
    return clone(next);
  }
  open(): Promise<Snapshot> {
    return this.lock(() => this.refresh());
  }
  activeEntries(): QueueEntry[] {
    return this.entries().filter(
      (e) =>
        e.state !== "CLIENT_RECEIPT_DURABLE" &&
        this.store.get(
          "client.archived",
          scopeKey(this.scope) + ":" + this.writerId + ":" + e.intent.intentId,
        ) === null,
    );
  }
  writerPendingEntries(): QueueEntry[] {
    return this.store
      .all("client.queue")
      .map((row) => row.value as QueueEntry)
      .filter((entry) => {
        demand(
          entry && entry.intent && typeof entry.intent.writerId === "string",
          "CORRUPT_QUEUE",
        );
        return (
          entry.intent.writerId === this.writerId &&
          entry.state !== "CLIENT_RECEIPT_DURABLE" &&
          this.store.get(
            "client.archived",
            scopeKey(entry.intent.scope) +
              ":" +
              this.writerId +
              ":" +
              entry.intent.intentId,
          ) === null
        );
      });
  }
  hasPendingWriterIntents(): boolean {
    return this.writerPendingEntries().length > 0;
  }
  canWrite(): boolean {
    return (
      !this.closed &&
      !this.busy &&
      this.current !== null &&
      !this.hasPendingWriterIntents() && !this.pendingHistory
    );
  }
  async submit(
    command: Command,
    historyOperation = false,
    intentBase?: import("./contract").Cut,
  ): Promise<{ receipt: Receipt; snapshot: Snapshot }> {
    return this.lock(async () => {
      demand(this.current, "NOT_OPEN");
      demand(!this.hasPendingWriterIntents(), "PENDING_INTENT_BLOCKS_WRITE");
      demand(!this.pendingHistory, "HISTORY_RECONCILIATION_REQUIRED");
      const before = clone(this.current);
      // Compact only newly created commands; persisted attempts stay byte-for-byte immutable.
      if (command.kind === "inline") command = compactInline(command);
      else if (command.kind === "batch") command = {...command, commands: command.commands.map(atom => atom.kind === "inline" ? compactInline(atom) : atom)};
      const intent = {
        v: 1 as const,
        intentId: randomUUID(),
        writerId: this.writerId,
        scope: this.scope,
        base: intentBase ?? before.cut,
        command: clone(command),
      };
      const protocol = await this.provider.protocol?.(this.scope) ?? 1003;
      this.active();
      this.queue.enqueue(intent);
      const attempt: Attempt = {
        ...(protocol === 1004 ? {protocol: 1004 as const} : {}),
        v: 1,
        attemptId: randomUUID(),
        intent,
        base: before.cut,
      };
      this.queue.attempt(attempt);
      // Fence before leaving this process: crash/timeout never licenses a new attempt.
      this.queue.markUnknown(intent.intentId, attempt.attemptId);
      this.pendingHistory = {intentId: intent.intentId, command: clone(command), before, operation: historyOperation};
      const receipt = await this.provider.submit(attempt);
      this.active();
      this.queue.confirm(receipt);
      const snapshot = await this.refresh();
      await this.finishHistory(receipt, snapshot);
      return { receipt, snapshot };
    });
  }
  private async finishHistory(receipt: Receipt, snapshot: Snapshot): Promise<void> {
    const pending = this.pendingHistory;
    if (!pending || pending.intentId !== receipt.intentId) return;
    if (receipt.status === "SERVER_ACCEPTED") {
      const event = snapshot.events.find(event => event.attemptId === receipt.attemptId) ?? await this.provider.acceptedEvent?.(this.scope, receipt.attemptId);
      demand(event && event.writerId === this.writerId && canonical(event.receipt) === canonical(receipt), "ACCEPTED_EVENT_MISSING");
      if (pending.operation) this.history.confirm(receipt, event.state ?? snapshot.state, event.appliedText, event.appliedBefore);
      else this.history.record(event.appliedBefore ?? pending.before.state, pending.command, {state: event.state ?? snapshot.state, appliedText: event.appliedText}, receipt.cut, receipt);
    } else if (pending.operation) this.history.reject();
    this.pendingHistory = null;
    if (this.historyResetPending) { this.history.clear(); this.historyResetPending = false; }
  }
  async historyStep(direction: "undo" | "redo") {
    demand(!this.pendingHistory, "HISTORY_RECONCILIATION_REQUIRED");
    await this.open();
    const snapshot = this.snapshot();
    const cut = this.history.nextCut(direction);
    demand(cut, "HISTORY_EMPTY");
    const changes = this.textChanges.filter(item => item.seq > cut.seq).map(item => item.change);
    const next = this.history[direction](snapshot.state, changes, randomUUID);
    try {
      return await this.submit(next.command, true, next.command.kind === "batch" || next.command.kind === "inline" || next.command.kind === "inline.patch" || next.command.kind === "inline.mark" || next.command.kind === "block.frame" || next.command.kind === "block.format" ? next.base : snapshot.cut);
    } catch (error) {
      if (!this.pendingHistory && this.activeEntries().length === 0) this.history.reject();
      throw error;
    }
  }
  /** Query only. A missing receipt remains UNKNOWN. */
  reconcile(): Promise<QueueEntry[]> {
    return this.lock(async () => {
      for (const entry of this.activeEntries())
        for (const item of entry.attempts)
          if (item.state === "UNKNOWN" || item.state === "PREPARED") {
            const receipt = await this.provider.receipt(item.attempt);
            this.active();
            if (receipt) this.queue.confirm(receipt);
          }
      const snapshot = await this.refresh();
      if (this.pendingHistory) {
        const entry = this.queue.read(this.pendingHistory.intentId);
        const receipt = entry?.attempts.at(-1)?.receipt;
        if (receipt) await this.finishHistory(receipt, snapshot);
      }
      return this.entries();
    });
  }
  /** Explicit atomic close of one unknown attempt, never a blind retry. */
  invalidate(intentId: string): Promise<Receipt> {
    return this.lock(async () => {
      const entry = this.queue.read(identifier(intentId));
      demand(entry, "MISSING_INTENT");
      const item = entry.attempts.at(-1);
      demand(
        item && (item.state === "UNKNOWN" || item.state === "PREPARED"),
        "ATTEMPT_NOT_UNKNOWN",
      );
      const receipt = await this.provider.invalidate(item.attempt);
      this.active();
      this.queue.confirm(receipt);
      const snapshot = await this.refresh();
      await this.finishHistory(receipt, snapshot);
      return receipt;
    });
  }
  archive(intentId: string): void {
    this.active();
    demand(!this.busy, "CLIENT_BUSY");
    const entry = this.queue.read(identifier(intentId));
    demand(
      entry &&
        entry.attempts.length > 0 &&
        entry.attempts.every(
          (a) => a.state === "REJECTED" || a.state === "INVALIDATED",
        ),
      "NOT_PROVEN_UNAPPLIED",
    );
    this.store.transaction(() =>
      this.store.set(
        "client.archived",
        scopeKey(this.scope) + ":" + this.writerId + ":" + intentId,
        { raw: entry.raw, entry },
      ),
    );
  }
  retainEditingRaw(raw: string): void {
    this.active();
    demand(
      typeof raw === "string" &&
        new TextEncoder().encode(raw).length <= 2_000_000,
      "DRAFT_CAPACITY",
    );
    this.store.transaction(() =>
      this.store.set(
        "client.editing",
        scopeKey(this.scope) + ":" + this.writerId,
        { raw, cut: this.current?.cut ?? null },
      ),
    );
  }
  clearEditingRaw(): void {
    this.store.transaction(() =>
      this.store.set(
        "client.editing",
        scopeKey(this.scope) + ":" + this.writerId,
        null,
      ),
    );
  }
  recover(): string {
    this.active();
    return canonical(
      {
        scope: this.scope,
        writerId: this.writerId,
        queue: this.entries(),
        editing: this.store.all("client.editing"),
        drafts: this.store
          .all("client.drafts")
          .filter((r) => r.key.startsWith(scopeKey(this.scope) + ":")),
      },
      48_000_000,
    );
  }
  retainDraft(document: unknown): void {
    this.active();
    const bytes = new TextEncoder().encode(
      canonical(document, 2_000_000),
    ).length;
    const used = this.store
      .all("client.drafts")
      .reduce(
        (sum, row) =>
          sum + new TextEncoder().encode(canonical(row.value)).length,
        0,
      );
    demand(used + bytes + 1024 <= 8_000_000, "DRAFT_CAPACITY");
    this.store.transaction(() =>
      this.store.set(
        "client.drafts",
        scopeKey(this.scope) + ":" + randomUUID(),
        { document, cut: this.current?.cut ?? null },
      ),
    );
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.history.clear();
    this.provider.close();
    this.store.close();
  }
}
