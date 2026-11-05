import {
  matchesPageOperation,
  pageOperationSchema,
  preparePageCreation,
  preparePageDuplication,
  validAppliedPage,
  type PageOperation,
  type PageOperationResult,
} from "../shared/page-operation";
import { operationFingerprint } from "../shared/save-contract";
import type { Doc, Page, Request } from "../shared/types";
import type { SaveTransport } from "./reliable-save";

export type PageOperationEntry = {
  operation: PageOperation;
  state: "saving" | "unknown" | "rejected" | "uncheckpointed";
  message: string;
  error?: string;
};

type ExchangeType = "page:commit" | "page:resolve";

/**
 * A transport rejection or timeout cannot prove SQLite did not commit. Every
 * such outcome becomes `unknown`, and the exact operation stays available for
 * a later resolve instead of a retry with a fresh operation ID.
 */
export async function exchangePageOperation(
  type: ExchangeType,
  operation: PageOperation,
  send: SaveTransport,
  timeoutMs: number,
): Promise<PageOperationResult> {
  const fingerprint = await operationFingerprint(operation);
  const unknown = (message: string): PageOperationResult => ({
    status: "unknown",
    operationId: operation.operationId,
    sessionId: operation.sessionId,
    seq: operation.seq,
    commandKind: operation.command.kind,
    fingerprint,
    message,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = (await Promise.race([
      send({ type, operation }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("作成結果の確認がタイムアウトしました。")),
          timeoutMs,
        );
      }),
    ])) as PageOperationResult;
    if (!matchesPageOperation(value, operation, fingerprint))
      return unknown("作成結果が要求と一致しません。入力を保持しています。");
    if (value.status === "applied" && !validAppliedPage(operation, value.page))
      return unknown("作成されたページを要求と照合できません。入力を保持しています。");
    return value;
  } catch (error) {
    return unknown(
      (error instanceof Error ? error.message : String(error)) +
        " 作成結果は不明です。入力を保持しています。",
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function sendPageOperation(
  operation: PageOperation,
  send: SaveTransport = (request) => window.folio.request(request),
  timeoutMs = 15_000,
): Promise<PageOperationResult> {
  return exchangePageOperation("page:commit", operation, send, timeoutMs);
}

export function resolvePageOperation(
  operation: PageOperation,
  send: SaveTransport = (request) => window.folio.request(request),
  timeoutMs = 15_000,
): Promise<PageOperationResult> {
  return exchangePageOperation("page:resolve", operation, send, timeoutMs);
}

/**
 * Explicit retry of the exact retained operation. Callers must resolve first
 * and may use this only for an unknown outcome; it never creates a new
 * operationId, sessionId, seq or fingerprint.
 */
export function retryPageOperation(
  operation: PageOperation,
  send: SaveTransport = (request) => window.folio.request(request),
  timeoutMs = 15_000,
): Promise<PageOperationResult> {
  return exchangePageOperation("page:commit", operation, send, timeoutMs);
}

export type PageOperationCoordinatorOptions = {
  /** Durably record the unresolved operation before its first send. */
  persist?: () => Promise<void>;
  timeoutMs?: number;
  onChange?: (entries: readonly PageOperationEntry[]) => void;
};

/**
 * Renderer owner of ordinary Page create/duplicate commands. An operation ID is
 * generated only for a new explicit user action; unknown outcomes retain the
 * same operation until `resolveNext` proves the durable result.
 */
export class PageOperationCoordinator {
  private readonly pending = new Map<string, PageOperationEntry>();

  constructor(
    private readonly send: SaveTransport,
    private readonly options: PageOperationCoordinatorOptions = {},
  ) {
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    )
      throw new Error("Invalid page operation timeout");
  }

  entries(): PageOperationEntry[] {
    return [...this.pending.values()];
  }

  unresolvedOperations(): PageOperation[] {
    return [...this.pending.values()].map((entry) => entry.operation);
  }

  /** Saving or unknown outcomes need attention; a rejected input is retained
   * but no longer blocks a new explicit user action. */
  hasUnresolved(): boolean {
    return [...this.pending.values()].some((entry) => entry.state !== "rejected");
  }

  /** Any retained input, including a rejected operation awaiting preservation. */
  hasRetained(): boolean {
    return this.pending.size > 0;
  }

  firstUnknown(): PageOperationEntry | undefined {
    return [...this.pending.values()].find((entry) => entry.state === "unknown");
  }

  firstRejected(): PageOperationEntry | undefined {
    return [...this.pending.values()].find((entry) => entry.state === "rejected");
  }

  firstUncheckpointed(): PageOperationEntry | undefined {
    return [...this.pending.values()].find((entry) => entry.state === "uncheckpointed");
  }

  /** Retry only an operation that never reached the transport. Persist the
   * same input again before sending; repeated clicks cannot send it twice. */
  async retryUncheckpointed(): Promise<Page | undefined> {
    const entry = this.firstUncheckpointed();
    if (!entry) return undefined;
    entry.state = "saving";
    entry.error = undefined;
    this.notify();
    return this.persistAndSend(entry);
  }

  /** Explicit user action after preserving the rejected input elsewhere. */
  discard(operationId: string): boolean {
    const removed = this.pending.delete(operationId);
    if (removed) this.notify();
    return removed;
  }

  async create(
    parentId: string | null,
    title: string,
    doc?: Doc,
  ): Promise<Page> {
    return this.run(
      preparePageCreation(title, parentId, doc),
      `「${title}」を作成`,
    );
  }

  async duplicate(
    pageId: string,
    revision: number,
    label = "ページを複製",
  ): Promise<Page> {
    return this.run(preparePageDuplication(pageId, revision), label);
  }

  /** Query the retained operation exactly as sent. Never generates a new ID. */
  async resolveNext(): Promise<PageOperationResult | undefined> {
    const entry =
      [...this.pending.values()].find((item) => item.state === "unknown") ??
      this.firstRejected();
    if (!entry) return undefined;
    const result = await resolvePageOperation(
      entry.operation,
      this.send,
      this.options.timeoutMs,
    );
    return this.recordResult(entry, result);
  }

  /** User-triggered recovery after a transient refusal (for example low disk).
   * Keep the original command, checkpoint again, and resolve before resending. */
  async retryUnknown(): Promise<PageOperationResult | undefined> {
    const entry = this.firstUnknown();
    if (!entry) return undefined;
    entry.state = "saving";
    this.notify();
    try {
      await this.options.persist?.();
      let result = await resolvePageOperation(entry.operation, this.send, this.options.timeoutMs);
      if (result.status === "unknown")
        result = await retryPageOperation(entry.operation, this.send, this.options.timeoutMs);
      return this.recordResult(entry, result);
    } catch (error) {
      entry.state = "unknown";
      entry.message = "再試行前の復旧記録を保存できません。入力と操作を保持しています。";
      entry.error = entry.message;
      this.notify();
      throw error;
    }
  }

  private recordResult(entry: PageOperationEntry, result: PageOperationResult): PageOperationResult {
    const current = this.pending.get(entry.operation.operationId);
    if (!current || current.operation !== entry.operation) return result;
    if (result.status === "unknown") {
      current.state = "unknown";
      current.message = result.message || "作成結果を確認できません。入力を保持しています。";
      current.error = current.message;
      this.notify();
    } else if (result.status === "rejected") {
      // A terminal rejection is not a success and is not dropped. Keep the
      // exact input available for the recovery-copy exit until the user
      // explicitly preserves or discards it.
      current.state = "rejected";
      current.message = result.message || "ページ操作は拒否されました。";
      current.error = current.message;
      this.notify();
    } else {
      this.pending.delete(entry.operation.operationId);
      this.notify();
    }
    return result;
  }

  private async run(input: PageOperation, label: string): Promise<Page> {
    let operation: PageOperation;
    // Refuse an unrepresentable request before it reaches the journal. A
    // persisted operation that can never pass the IPC schema would otherwise
    // stay unknown forever and block recovery.
    try {
      operation = structuredClone(pageOperationSchema.parse(input));
    } catch {
      throw new Error(
        "ページ操作の内容が上限または形式を外れています。入力を保持しています。",
      );
    }
    if ([...this.pending.values()].some((entry) => entry.state !== "rejected")) {
      throw new Error(
        "作成結果を確認中のページ操作があります。先に結果を確認してください。",
      );
    }
    const entry: PageOperationEntry = {
      operation,
      state: "saving",
      message: `${label}しています…`,
    };
    this.pending.set(operation.operationId, entry);
    this.notify();
    return this.persistAndSend(entry);
  }

  private async persistAndSend(entry: PageOperationEntry): Promise<Page> {
    const operation = entry.operation;
    try {
      // The recovery journal must contain the operation before any request can
      // reach the workspace. A failed journal write therefore sends nothing.
      await this.options.persist?.();
    } catch (error) {
      entry.state = "uncheckpointed";
      entry.message =
        "作成前の復旧記録を保存できません。ページは作成していません。" +
        "入力をこの画面に保持しています。アプリを閉じずに再試行してください。" +
        (error instanceof Error ? ` ${error.message}` : "");
      entry.error = entry.message;
      this.notify();
      throw new Error(entry.message);
    }
    const result = await sendPageOperation(
      operation,
      this.send,
      this.options.timeoutMs,
    );
    if (result.status === "applied") {
      this.pending.delete(operation.operationId);
      this.notify();
      return result.page!;
    }
    if (result.status === "rejected") {
      // Keep the exact input and explain the reason. A later explicit
      // recovery-copy action can preserve it; it is never treated as applied.
      entry.state = "rejected";
      entry.message = result.message || "ページ操作は拒否されました。";
      entry.error = entry.message;
      this.notify();
      throw new Error(entry.message + " 入力を保持しています。");
    }
    entry.state = "unknown";
    entry.message =
      result.message || "作成結果を確認できません。入力を保持しています。";
    entry.error = entry.message;
    this.notify();
    throw new Error(entry.message + " 結果を確認してください。");
  }

  private notify() {
    try {
      this.options.onChange?.(this.entries());
    } catch {
      // Display observers must not break the operation.
    }
  }
}
