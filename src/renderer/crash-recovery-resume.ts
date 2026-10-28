import { validateEditRecovery, validateDatabaseRecovery, type EditSessionRecovery, type DatabaseSessionRecovery } from "../shared/crash-recovery";
import { canonicalOperation, type SaveResult } from "../shared/save-contract";
import type { DatabaseOperationResult, DatabaseReadSnapshot } from "../shared/database-operation";
import type { Page, RecordProjection } from "../shared/types";
import { assertOwnerTransition } from "./settings-save-coordinator";

const same = (a: unknown, b: unknown) => canonicalOperation(a ?? null) === canonicalOperation(b ?? null);
function receiptIdentity(operation: {operationId: string; sessionId: string; seq: number}, result: {operationId: string; sessionId: string; seq: number; status: string}) {
  if (operation.operationId !== result.operationId || operation.sessionId !== result.sessionId || operation.seq !== result.seq ||
    !["applied", "rejected", "unknown"].includes(result.status)) throw new Error("復旧時の保存確認が要求と一致しません。");
}

/** Pass only a result obtained from resolveReliableSave. This function never
 * writes or resends. Current must be freshly read after that receipt query. */
export function reconcileEditRecovery(input: EditSessionRecovery, current: {page: Page; record?: RecordProjection}, resolved?: SaveResult): EditSessionRecovery {
  const entry = validateEditRecovery(input), operation = entry.operation;
  if (resolved) {
    if (!operation) throw new Error("復旧対象の操作がありません。");
    receiptIdentity(operation, resolved);
    if (resolved.status === "applied") {
      if (!resolved.page || resolved.page.id !== entry.base.id || resolved.page.revision !== operation.revision + 1 ||
        Object.entries(operation.patch).some(([key, value]) => !same((resolved.page as unknown as Record<string, unknown>)[key], value))) throw new Error("復旧本文と保存確認が一致しません。");
      if (entry.record && (!resolved.record || resolved.record.databasePageId !== entry.record.databasePageId ||
        resolved.record.pageId !== entry.record.pageId || resolved.record.revision !== resolved.page.revision ||
        Object.entries(operation.values ?? {}).some(([key, value]) => value === null ? Object.hasOwn(resolved.record!.values, key) : resolved.record!.values[key] !== value)))
        throw new Error("復旧レコードの保存確認が一致しません。");
      entry.base = structuredClone(resolved.page);
      if (resolved.record) entry.record = structuredClone(resolved.record);
      entry.intents = entry.intents.filter((intent) => intent.seq > operation.seq);
      delete entry.operation;
    }
  }
  if (!same(entry.base, current.page) || !same(entry.record, current.record))
    throw new Error("保存元が復旧入力の版から変更されています。元のページを変更せず、別ページに復旧してください。");
  return validateEditRecovery(entry);
}

/** Pass only resolveDatabaseOperation's validated result and a subsequent fresh
 * database:read. Changes to unrelated record rows do not rebase owner settings. */
export function reconcileDatabaseRecovery(input: DatabaseSessionRecovery, current: DatabaseReadSnapshot, resolved?: DatabaseOperationResult): DatabaseSessionRecovery {
  const entry = validateDatabaseRecovery(input), operation = entry.operation;
  if (resolved) {
    if (!operation) throw new Error("復旧対象の操作がありません。");
    receiptIdentity(operation, resolved);
    if (resolved.commandKind !== operation.command.kind) throw new Error("復旧操作の種類が異なります。");
    if (resolved.status === "applied") {
      if (!resolved.page || !resolved.database) throw new Error("復旧用の保存確認が不足しています。");
      if (operation.command.kind === "updateDatabase") {
        if (resolved.page.revision !== entry.base.revision + 1) throw new Error("復旧版が一致しません。");
        assertOwnerTransition(entry.base, resolved.page, operation.command.patch, operation.command.settings);
        entry.base = structuredClone(resolved.page);
      } else if (operation.command.kind === "createRecord") {
        if (!resolved.record || !current.database.records.some((record) => same(record, resolved.record)))
          throw new Error("作成済みの復旧レコードが変更されています。別ページに復旧してください。");
      } else throw new Error("DB作成はセッションへ再送できません。");
      entry.projection = structuredClone(resolved.database);
      entry.intents = entry.intents.filter((intent) => intent.seq > operation.seq);
      delete entry.operation;
    }
  }
  if (!same(entry.base, current.page) || entry.projection.revision !== current.database.revision ||
    !same(entry.projection.settings, current.database.settings)) throw new Error("データベースの保存元が変更されています。別ページに復旧してください。");
  entry.projection = structuredClone(current.database);
  return validateDatabaseRecovery(entry);
}
