import { blankDoc } from "../shared/types";
import { validateRecordReadSnapshot } from "./record-save-coordinator";
import { validateOwnerPage } from "./settings-save-coordinator";
import type { DatabaseOperation, DatabaseOperationResult } from "../shared/database-operation";
import { operationFingerprint } from "../shared/save-contract";
import type { SaveTransport } from "./reliable-save";
import { sameSettingsValue } from "./settings-intent";

async function exchange(type: "database:commit" | "database:resolve", operation: DatabaseOperation,
  send: SaveTransport, timeoutMs: number): Promise<DatabaseOperationResult> {
  const fingerprint = await operationFingerprint(operation);
  const unknown = (message: string): DatabaseOperationResult => ({status: "unknown", operationId: operation.operationId,
    sessionId: operation.sessionId, seq: operation.seq, commandKind: operation.command.kind, fingerprint, message});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      send({type, operation}),
      new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error("保存確認がタイムアウトしました。")), timeoutMs);}),
    ]) as DatabaseOperationResult;
    if (!value || value.operationId !== operation.operationId || value.sessionId !== operation.sessionId ||
      value.seq !== operation.seq || value.fingerprint !== fingerprint || value.commandKind !== operation.command.kind ||
      !["applied", "rejected", "unknown"].includes(value.status)) return unknown("保存結果が要求と一致しません。入力を保持しています。");
    if (value.status === "applied" && !validApplied(operation, value)) return unknown("作成・設定の保存内容を確認できません。入力を保持しています。");
    return value;
  } catch (error) {
    return unknown((error instanceof Error ? error.message : String(error)) + " 保存結果は不明です。入力を保持しています。");
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
  send: SaveTransport = (request) => window.folio.request(request), timeoutMs = 15_000) {
  return exchange("database:commit", operation, send, timeoutMs);
}
export function resolveDatabaseOperation(operation: DatabaseOperation,
  send: SaveTransport = (request) => window.folio.request(request), timeoutMs = 15_000) {
  return exchange("database:resolve", operation, send, timeoutMs);
}
