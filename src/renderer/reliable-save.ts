import { matchesOperation, operationFingerprint, type SaveOperation, type SaveResult } from "../shared/save-contract";
import type { StorageFailureV1 } from "../shared/private-storage-failure";
import type { Request } from "../shared/types";
import { requestStorageFailure, storageFailureMessageV1, unclassifiedRequestFailure } from "./private-request";

export type SaveTransport = (request: Request) => Promise<unknown>;

/** Renderer-only transient metadata on a save result. The bounded diagnostic
 * is never serialized into the operation, the receipt, the fingerprint or a
 * recovery export; the shared SaveResult wire shape stays unchanged. */
export type DiagnosticSaveResult = SaveResult & {storageFailure?: StorageFailureV1};

/** Transport rejection/timeout cannot prove that SQLite did not commit. */
async function exchange(type: "save:commit" | "save:resolve", operation: SaveOperation,
  send: SaveTransport, timeoutMs: number): Promise<DiagnosticSaveResult> {
  const fingerprint = await operationFingerprint(operation);
  const unknown = (message: string, failure?: StorageFailureV1): DiagnosticSaveResult => ({
    status: "unknown", operationId: operation.operationId,
    sessionId: operation.sessionId, seq: operation.seq, pageId: operation.pageId, fingerprint,
    message, storageFailure: failure ?? unclassifiedRequestFailure(type)});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      send({type, operation}),
      new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error("保存確認がタイムアウトしました。")), timeoutMs);}),
    ]) as DiagnosticSaveResult;
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
    // A carried diagnostic is metadata, never part of the receipt. Keep it only
    // when it re-validates for this exact request type; a malformed or foreign
    // carrier makes the whole ACK untrusted rather than quietly dropping it.
    if (Object.hasOwn(result, "storageFailure")) {
      const failure = requestStorageFailure(result, type);
      if (!failure) return unknown("保存確認が要求と一致しません。入力を保持しています。");
      // A terminal business ACK carrying its own failure metadata is
      // contradictory and invalid: normalize it to the bounded local E for
      // this actual request so no consumer can ACK or clear from it.
      if (result.status !== "unknown")
        return unknown("保存確認が要求と一致しません。入力を保持しています。");
      // The display is rebuilt from the validated kind alone; the carrier's
      // own message is never shown.
      return {...result, message: storageFailureMessageV1(failure), storageFailure: failure};
    }
    return result;
  } catch (error) {
    // Preserve the bounded diagnostic the error actually carries; a raw
    // rejection, timer or hostile carrier becomes the safe local E of the
    // request type that was really sent. Message, cause and code are never
    // inferred or concatenated into the diagnostic.
    const failure = requestStorageFailure(error, type) ?? unclassifiedRequestFailure(type);
    return unknown(storageFailureMessageV1(failure), failure);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export function sendReliableSave(operation: SaveOperation,
  send: SaveTransport = (request) => window.folio.request(request), timeoutMs = 15_000): Promise<DiagnosticSaveResult> {
  return exchange("save:commit", operation, send, timeoutMs);
}
export function resolveReliableSave(operation: SaveOperation,
  send: SaveTransport = (request) => window.folio.request(request), timeoutMs = 15_000): Promise<DiagnosticSaveResult> {
  return exchange("save:resolve", operation, send, timeoutMs);
}

/** Explicit retry of an immutable, already checkpointed request is read-only:
 * it only resolves the exact retained operation. An unknown outcome is never
 * resent as a commit, including on the legacy/default transport. */
export function retryReliableSave(operation: SaveOperation,
  send: SaveTransport = (request) => window.folio.request(request), timeoutMs = 15_000): Promise<DiagnosticSaveResult> {
  return resolveReliableSave(operation, send, timeoutMs);
}
