import { createHash, randomUUID } from "node:crypto";
import type { Store } from "./store";
import { RecordRepository } from "./record-repository";
import { markRecordStoreVersion } from "./record-version";
import { databaseOperationSchema, type DatabaseSettings, type FilterValue, type Page } from "../shared/types";
import { canonicalOperation } from "../shared/save-contract";
import type { DatabaseOperation, DatabaseOperationResult, DatabaseReadSnapshot } from "../shared/database-operation";

function result(operation: DatabaseOperation, fingerprint: string,
  status: DatabaseOperationResult["status"], message?: string): DatabaseOperationResult {
  return {status, operationId: operation.operationId, sessionId: operation.sessionId, seq: operation.seq,
    commandKind: operation.command.kind, fingerprint, ...(message ? {message} : {})};
}
function receipt(store: Store, operation: DatabaseOperation, fingerprint: string): DatabaseOperationResult | undefined {
  const row = store.db.prepare("SELECT fingerprint,result_json FROM save_receipts WHERE operation_id=?").get(operation.operationId) as {fingerprint: string; result_json: string} | undefined;
  if (!row) return undefined;
  if (row.fingerprint !== fingerprint) return result(operation, fingerprint, "rejected", "同じ操作IDに異なる要求があります。入力を保持しています。");
  return JSON.parse(row.result_json) as DatabaseOperationResult;
}
function fingerprint(operation: DatabaseOperation) {return createHash("sha256").update(canonicalOperation(operation)).digest("hex");}

/** Owner Page, settings and record list all come from Store.load's one read snapshot. */
export function readDatabaseSnapshot(store: Store, databasePageId: string): DatabaseReadSnapshot {
  const snapshot = store.load();
  const page = snapshot.pages.find((page) => page.id === databasePageId);
  if (!page || page.kind !== "database" || !page.database || page.database.rows.length || page.deletedAt !== null || page.documentError ||
    !snapshot.recordDatabaseIds?.includes(databasePageId)) throw new Error("登録済みデータベースを安全に読み込めません。");
  const {rows: _rows, ...settings} = page.database;
  return {page, database: {settings, revision: page.revision, records: (snapshot.records ?? []).filter((record) => record.databasePageId === databasePageId)}};
}

export function resolveDatabaseOperation(store: Store, input: DatabaseOperation): DatabaseOperationResult {
  const operation = databaseOperationSchema.parse(input), hash = fingerprint(operation);
  return receipt(store, operation, hash) ?? result(operation, hash, "unknown", "作成・設定の保存結果を確認できません。入力を保持しています。");
}

export function commitDatabaseOperation(store: Store, input: DatabaseOperation): DatabaseOperationResult {
  const operation = databaseOperationSchema.parse(input), hash = fingerprint(operation);
  const already = receipt(store, operation, hash);
  if (already) return already;
  // Only an explicit new registered DB request can enable the record schema.
  // This SQLite-only pre-change snapshot does not claim attachment backup or
  // exclusion of arbitrary external writers. No old database rows are rewritten.
  if (operation.command.kind === "createDatabase" && store.db.prepare("PRAGMA user_version").get()!.user_version === 3) {
    store.assertRecordWriteSchema();
    store.db.prepare("VACUUM INTO ?").run(store.path + ".pre-r5-records-" + randomUUID() + ".sqlite");
  }
  return store.transaction(() => {
    const existing = receipt(store, operation, hash);
    if (existing) return existing;
    store.db.exec("SAVEPOINT database_operation");
    let outcome: DatabaseOperationResult;
    try {
      const command = operation.command;
      const records = new RecordRepository(store);
      store.assertRecordWriteSchema();
      if (command.kind === "createDatabase") {
        records.createSchema();
        markRecordStoreVersion(store.db);
        // Store.create validates parent classification under this same write lock.
        const created = store.create(command.parentId, "database", command.title);
        const page = store.write({...created, database: {...command.settings, rows: []}});
        records.registerDatabase(page.id);
        outcome = {...result(operation, hash, "applied"), page, database: records.databaseProjection(page.id)};
      } else {
        const page = store.get(command.databasePageId);
        requireOwner(store, page, command.revision);
        if (command.kind === "createRecord") {
          validateInitialValues(page.database!.properties, command.values);
          const record = records.createInTransaction(page.id, command.title, command.values as Record<string, FilterValue>);
          outcome = {...result(operation, hash, "applied"), page: store.get(record.pageId), record,
            database: records.databaseProjection(page.id)};
        } else {
          // Owner metadata and settings share one revision lane and one history entry.
          // Schema deletion/type changes are not part of R5 view operations.
          preserveProperties(page.database!, command.settings);
          store.recordVersion(page);
          const saved = store.write({...page, ...command.patch, database: {...command.settings, rows: []},
            revision: page.revision + 1, updatedAt: Date.now()});
          outcome = {...result(operation, hash, "applied"), page: saved, database: records.databaseProjection(page.id)};
        }
      }
      store.db.exec("RELEASE SAVEPOINT database_operation");
    } catch (error) {
      store.db.exec("ROLLBACK TO SAVEPOINT database_operation");
      store.db.exec("RELEASE SAVEPOINT database_operation");
      outcome = result(operation, hash, "rejected", error instanceof Error ? error.message : String(error));
    }
    store.db.prepare("INSERT INTO save_receipts(operation_id,fingerprint,result_json) VALUES(?,?,?)")
      .run(operation.operationId, hash, JSON.stringify(outcome));
    return outcome;
  });
}

function requireOwner(store: Store, page: Page, revision: number) {
  if (page.revision !== revision) throw new Error("保存の競合を検出しました。入力を保持しています。");
  if (page.kind !== "database" || !page.database || page.database.rows.length || page.deletedAt !== null || page.documentError ||
    !store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='record_databases'").get() ||
    !store.db.prepare("SELECT 1 FROM record_databases WHERE database_page_id=?").get(page.id))
    throw new Error("所有データベースを安全に保存できません。");
}
function preserveProperties(before: DatabaseSettings, after: DatabaseSettings) {
  const next = new Map(after.properties.map((property) => [property.id, property]));
  for (const property of before.properties)
    if (canonicalOperation(next.get(property.id)) !== canonicalOperation(property))
      throw new Error("既存プロパティの削除・変更はこの保存経路ではできません。");
}
function validateInitialValues(properties: DatabaseSettings["properties"], values: Record<string, FilterValue | null>) {
  for (const [key, value] of Object.entries(values)) {
    const property = properties.find((property) => property.id === key);
    if (!property || value === null ||
      (property.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) ||
      (property.type === "checkbox" && typeof value !== "boolean") ||
      (["text", "date", "select"].includes(property.type) && typeof value !== "string") ||
      (property.type === "select" && value !== "" && !property.options?.includes(String(value))))
      throw new Error("新しい行のプロパティが現在の構成と一致しません。");
  }
}
