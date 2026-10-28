import { matchesOperation, operationFingerprint, type SaveOperation, type SaveResult } from "../shared/save-contract";
import type { Request } from "../shared/types";

export type SaveTransport = (request: Request) => Promise<unknown>;

/** Transport rejection/timeout cannot prove that SQLite did not commit. */
async function exchange(type: "save:commit" | "save:resolve", operation: SaveOperation,
  send: SaveTransport, timeoutMs: number): Promise<SaveResult> {
  const fingerprint = await operationFingerprint(operation);
  const unknown = (message: string): SaveResult => ({status: "unknown", operationId: operation.operationId,
    sessionId: operation.sessionId, seq: operation.seq, pageId: operation.pageId, fingerprint, message});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      send({type, operation}),
      new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error("保存確認がタイムアウトしました。")), timeoutMs);}),
    ]) as SaveResult;
    if (!matchesOperation(result, operation, fingerprint) || !["applied", "rejected", "unknown"].includes(result.status))
      return unknown("保存確認が要求と一致しません。入力を保持しています。");
    if (result.status === "applied") {
      const page = result.page;
      if (!page || page.id !== operation.pageId || page.revision !== operation.revision + 1 ||
        Object.entries(operation.patch).some(([key, value]) => JSON.stringify((page as unknown as Record<string, unknown>)[key]) !== JSON.stringify(value)))
        return unknown("保存された本文と要求が一致しません。入力を保持しています。");
      if (operation.databasePageId !== null) {
        const record = result.record;
        if (!record || record.pageId !== page.id || record.databasePageId !== operation.databasePageId ||
          record.revision !== page.revision || record.title !== page.title || record.icon !== page.icon ||
          Object.entries(operation.values ?? {}).some(([key, value]) => value === null ? Object.hasOwn(record.values, key) : record.values[key] !== value))
          return unknown("レコードの保存確認が一致しません。入力を保持しています。");
      }
    }
    return result;
  } catch (error) {
    return unknown((error instanceof Error ? error.message : String(error)) + " 保存結果は不明です。入力を保持しています。");
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export function sendReliableSave(operation: SaveOperation,
  send: SaveTransport = (request) => window.folio.request(request), timeoutMs = 15_000): Promise<SaveResult> {
  return exchange("save:commit", operation, send, timeoutMs);
}
export function resolveReliableSave(operation: SaveOperation,
  send: SaveTransport = (request) => window.folio.request(request), timeoutMs = 15_000): Promise<SaveResult> {
  return exchange("save:resolve", operation, send, timeoutMs);
}
