import { randomUUID } from "node:crypto";
import { type RuntimeStoreOptions, RuntimeStore } from "./store";
import { DurableQueue, type QueueEntry } from "./durable-queue";
import { canonical } from "./canonical";
import { parseAttempt, parseCut, parseScope } from "./wire";
import {
  CollaborationError,
  demand,
  identifier,
  sameScope,
  scopeKey,
  type Attempt,
  type Cut,
  type Receipt,
  type ResourceCommand,
  type Scope,
} from "./contract";
import type { SharedProvider } from "./provider-port";

const QUEUE_NAMESPACE = "client.queue";
const ARCHIVE_NAMESPACE = "resource-client.archive";
const ROLE = "resource-client";
const RECOVER_BYTES = 128_000_000;

function corrupt(): never {
  throw new CollaborationError("CORRUPT_QUEUE");
}

/** Durable resource client. It never fabricates a document snapshot and never
 * resends an attempt: an unknown outcome stays unknown until a receipt query or
 * an explicit invalidation closes it. */
export class SharedResourceClient {
  readonly store: RuntimeStore;
  private readonly provider: SharedProvider;
  private readonly writerId: string;
  private readonly queues = new Map<string, DurableQueue>();
  private busy = false;
  private closed = false;

  constructor(
    directory: string,
    provider: SharedProvider,
    writerId: string,
    options: RuntimeStoreOptions = {},
  ) {
    this.writerId = identifier(writerId);
    this.provider = provider;
    this.store = new RuntimeStore(directory, options);
    try {
      const role = this.store.get("meta", "role");
      demand(role === null || role === ROLE, "WRONG_STORE_ROLE");
      const prepared: {
        queue: DurableQueue;
        intentId: string;
        attemptId: string;
      }[] = [];
      for (const scope of this.discoverScopes()) {
        const queue = this.queueFor(scope);
        for (const entry of queue.entries())
          for (const item of entry.attempts)
            if (item.state === "PREPARED")
              prepared.push({
                queue,
                intentId: entry.intent.intentId,
                attemptId: item.attempt.attemptId,
              });
      }
      this.store.transaction(() => {
        if (role === null) this.store.set("meta", "role", ROLE);
        for (const item of prepared)
          item.queue.markUnknown(item.intentId, item.attemptId);
      });
    } catch (error) {
      this.store.close();
      throw error;
    }
  }

  private active(): void {
    demand(!this.closed, "CLIENT_CLOSED");
  }

  private lock<T>(work: () => Promise<T>): Promise<T> {
    this.active();
    demand(!this.busy, "CLIENT_BUSY");
    this.busy = true;
    return work().finally(() => {
      this.busy = false;
    });
  }

  /** Keys are scopeKey:writerId:intentId with six identifier segments. Any
   * malformed key fails closed even when it belongs to another writer. */
  private discoverScopes(): Scope[] {
    const found = new Map<string, Scope>();
    for (const row of this.store.all(QUEUE_NAMESPACE)) {
      if (typeof row.key !== "string") corrupt();
      const parts = row.key.split(":");
      if (parts.length !== 6) corrupt();
      try {
        for (const part of parts) identifier(part);
      } catch {
        corrupt();
      }
      if (parts[4] !== this.writerId) continue;
      const scope: Scope = {
        orgId: parts[0],
        workspaceId: parts[1],
        documentId: parts[2],
        incarnationId: parts[3],
      };
      found.set(scopeKey(scope), scope);
    }
    return [...found.values()];
  }

  private queueFor(scope: Scope): DurableQueue {
    const key = scopeKey(scope);
    const existing = this.queues.get(key);
    if (existing) return existing;
    const queue = new DurableQueue(this.store, {
      scope,
      writerId: this.writerId,
    });
    this.queues.set(key, queue);
    return queue;
  }

  private archiveKey(scope: Scope, intentId: string): string {
    return `${scopeKey(scope)}:${this.writerId}:${intentId}`;
  }

  private isArchived(scope: Scope, intentId: string): boolean {
    return (
      this.store.get(ARCHIVE_NAMESPACE, this.archiveKey(scope, intentId)) !==
      null
    );
  }

  private allEntries(): QueueEntry[] {
    const entries: QueueEntry[] = [];
    for (const queue of this.queues.values()) entries.push(...queue.entries());
    entries.sort((left, right) =>
      left.intent.intentId < right.intent.intentId
        ? -1
        : left.intent.intentId > right.intent.intentId
          ? 1
          : 0,
    );
    return entries;
  }

  private pending(): QueueEntry[] {
    return this.allEntries().filter(
      (entry) =>
        entry.state !== "CLIENT_RECEIPT_DURABLE" &&
        !this.isArchived(entry.intent.scope, entry.intent.intentId),
    );
  }

  entries(): QueueEntry[] {
    this.active();
    return this.allEntries();
  }

  activeEntries(): QueueEntry[] {
    this.active();
    return this.pending();
  }

  hasPending(): boolean {
    this.active();
    return this.pending().length > 0;
  }

  async execute(
    scope: Scope,
    command: ResourceCommand,
    base: Cut,
  ): Promise<Receipt> {
    return this.lock(async () => {
      const checkedScope = parseScope(scope);
      const checkedBase = parseCut(base);
      demand(
        command !== null &&
          typeof command === "object" &&
          command.kind === "resource",
        "INVALID_COMMAND",
      );
      canonical(command, 1_000_000);
      demand(this.pending().length === 0, "PENDING_INTENT_BLOCKS_WRITE");
      const intent = {
        v: 1 as const,
        intentId: randomUUID(),
        writerId: this.writerId,
        scope: checkedScope,
        base: checkedBase,
        command,
      };
      const protocol = await this.provider.protocol?.(checkedScope) ?? 1003;
      const attemptInput: Attempt = {
        ...(protocol === 1004 ? {protocol: 1004 as const} : {}),
        v: 1,
        attemptId: randomUUID(),
        intent,
        base: checkedBase,
      };
      const attempt = parseAttempt(attemptInput);
      const queue = this.queueFor(attempt.intent.scope);
      this.store.transaction(() => {
        queue.enqueue(attempt.intent);
        queue.attempt(attempt);
        queue.markUnknown(attempt.intent.intentId, attempt.attemptId);
      });
      const receipt = await this.provider.submit(attempt);
      this.active();
      queue.confirm(receipt);
      return receipt;
    });
  }

  /** Query only. A missing receipt remains UNKNOWN; nothing is resent. */
  async reconcile(): Promise<void> {
    await this.lock(async () => {
      for (const queue of this.queues.values())
        for (const entry of queue.entries())
          for (const item of entry.attempts)
            if (item.state === "PREPARED" || item.state === "UNKNOWN") {
              const receipt = await this.provider.receipt(item.attempt);
              this.active();
              if (receipt) queue.confirm(receipt);
            }
    });
  }

  /** Explicit atomic close of one unaccepted attempt through the provider. */
  async invalidate(scope: Scope, intentId: string): Promise<Receipt> {
    return this.lock(async () => {
      const checkedScope = parseScope(scope);
      const entry = this.queueFor(checkedScope).read(identifier(intentId));
      demand(entry, "MISSING_INTENT");
      demand(
        entry.intent.scope && sameScope(entry.intent.scope, checkedScope),
        "SCOPE_MISMATCH",
      );
      const item = entry.attempts.at(-1);
      demand(
        item && (item.state === "UNKNOWN" || item.state === "PREPARED"),
        "ATTEMPT_NOT_UNKNOWN",
      );
      const receipt = await this.provider.invalidate(item.attempt);
      this.active();
      this.queueFor(checkedScope).confirm(receipt);
      return receipt;
    });
  }

  /** Only a durably proven REJECTED/INVALIDATED entry may be archived. The
   * original queue row and its raw intent are retained, never deleted. */
  archive(scope: Scope, intentId: string): void {
    this.active();
    demand(!this.busy, "CLIENT_BUSY");
    const checkedScope = parseScope(scope);
    const id = identifier(intentId);
    const entry = this.queueFor(checkedScope).read(id);
    demand(entry, "MISSING_INTENT");
    demand(
      entry.attempts.length > 0 &&
        entry.attempts.every(
          (item) =>
            (item.state === "REJECTED" || item.state === "INVALIDATED") &&
            item.receipt !== null,
        ),
      "NOT_PROVEN_UNAPPLIED",
    );
    this.store.transaction(() =>
      this.store.set(ARCHIVE_NAMESPACE, this.archiveKey(checkedScope, id), {
        raw: entry.raw,
        entry,
      }),
    );
  }

  recover(): string {
    this.active();
    return canonical(
      { writerId: this.writerId, queue: this.allEntries() },
      RECOVER_BYTES,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.provider.close();
    } finally {
      this.store.close();
    }
  }
}
