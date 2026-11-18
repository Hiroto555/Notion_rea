import { blankDoc } from "../shared/types";
import { validateRecordReadSnapshot } from "./record-save-coordinator";
import { validateOwnerPage } from "./settings-save-coordinator";
import type { DatabaseOperation, DatabaseOperationResult } from "../shared/database-operation";
import type { StorageFailureV1 } from "../shared/private-storage-failure";
import { operationFingerprint } from "../shared/save-contract";
import type { SaveTransport } from "./reliable-save";
import { requestStorageFailure, storageFailureMessageV1, unclassifiedRequestFailure } from "./private-request";
import { sameSettingsValue } from "./settings-intent";

/** Renderer-only transient metadata on a database operation result. The
 * bounded diagnostic never enters the operation, fingerprint, receipt or a
 * recovery export; the shared wire result shape stays unchanged. */
export type DiagnosticDatabaseOperationResult = DatabaseOperationResult & {storageFailure?: StorageFailureV1};

async function exchange(type: "database:commit" | "database:resolve", operation: DatabaseOperation,
  send: SaveTransport, timeoutMs: number): Promise<DiagnosticDatabaseOperationResult> {
  const fingerprint = await operationFingerprint(operation);
  const unknown = (message: string, failure?: StorageFailureV1): DiagnosticDatabaseOperationResult => ({
    status: "unknown", operationId: operation.operationId,
    sessionId: operation.sessionId, seq: operation.seq, commandKind: operation.command.kind, fingerprint,
    message, storageFailure: failure ?? unclassifiedRequestFailure(type)});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      send({type, operation}),
      new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error("保存確認がタイムアウトしました。")), timeoutMs);}),
    ]) as DiagnosticDatabaseOperationResult;
    if (!value || value.operationId !== operation.operationId || value.sessionId !== operation.sessionId ||
      value.seq !== operation.seq || value.fingerprint !== fingerprint || value.commandKind !== operation.command.kind ||
      !["applied", "rejected", "unknown"].includes(value.status)) return unknown("保存結果が要求と一致しません。入力を保持しています。");
    if (value.status === "applied" && !validApplied(operation, value)) return unknown("作成・設定の保存内容を確認できません。入力を保持しています。");
    // A carried diagnostic is metadata, never part of the receipt. Keep it only
    // when it re-validates for this exact request type; a malformed or foreign
    // carrier makes the whole ACK untrusted rather than quietly dropping it.
    if (Object.hasOwn(value, "storageFailure")) {
      const failure = requestStorageFailure(value, type);
      if (!failure) return unknown("保存結果が要求と一致しません。入力を保持しています。");
      // A terminal business ACK carrying its own failure metadata is
      // contradictory and invalid: normalize it to the bounded local E for
      // this actual request so no consumer can ACK or clear from it.
      if (value.status !== "unknown")
        return unknown("保存結果が要求と一致しません。入力を保持しています。");
      // The display is rebuilt from the validated kind alone; the carrier's
      // own message is never shown.
      return {...value, message: storageFailureMessageV1(failure), storageFailure: failure};
    }
    return value;
  } catch (error) {
    const failure = requestStorageFailure(error, type) ?? unclassifiedRequestFailure(type);
    return unknown(storageFailureMessageV1(failure), failure);
  } finally {if (timer !== undefined) clearTimeout(timer);}
}
function validApplied(operation: DatabaseOperation, result: DatabaseOperationResult) {
  const command = operation.command, page = result.page, database = result.database;
  if (!page || !database || page.deletedAt !== null || page.documentError) return false;
  if (command.kind === "createRecord") {
    const record = result.record;
    if (!record) return false;
    validateRecordReadSnapshot({page, record}, page.id, command.databasePageId);
    return !!record && record.pageId === page.id && page.kind === "page" && page.database === null &&
      sameSettingsValue(page.doc, blankDoc()) && page.revision === 0 && record.revision === 0 && record.title === command.title && page.title === command.title &&
      record.databasePageId === command.databasePageId && database.revision === command.revision &&
      sameSettingsValue(record.values, command.values) &&
      database.records.every((row) => row.databasePageId === command.databasePageId) &&
      database.records.some((row) => sameSettingsValue(row, record));
  }
  if (page.kind !== "database" || !page.database || page.database.rows.length || database.revision !== page.revision ||
    database.records.some((row) => row.databasePageId !== page.id)) return false;
  validateOwnerPage(page, command.kind === "createDatabase" ? page.id : command.databasePageId,
    command.kind === "createDatabase" ? 0 : command.revision + 1, command.settings);
  const {rows: _rows, ...settings} = page.database;
  if (!sameSettingsValue(settings, command.settings) || !sameSettingsValue(database.settings, command.settings)) return false;
  if (command.kind === "createDatabase")
    return sameSettingsValue(page.doc, blankDoc()) && page.revision === 0 && page.title === command.title && page.parentId === command.parentId && database.records.length === 0;
  return page.id === command.databasePageId && page.revision === command.revision + 1 &&
    Object.entries(command.patch).every(([key, value]) => sameSettingsValue((page as unknown as Record<string, unknown>)[key], value));
}
export function sendDatabaseOperation(operation: DatabaseOperation,
  send: SaveTransport = (request) => window.folio.request(request), timeoutMs = 15_000): Promise<DiagnosticDatabaseOperationResult> {
  return exchange("database:commit", operation, send, timeoutMs);
}
export function resolveDatabaseOperation(operation: DatabaseOperation,
  send: SaveTransport = (request) => window.folio.request(request), timeoutMs = 15_000): Promise<DiagnosticDatabaseOperationResult> {
  return exchange("database:resolve", operation, send, timeoutMs);
}
