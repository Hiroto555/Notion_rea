import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Store } from "./store";
import { RecordRepository } from "./record-repository";
import { requestSchema, type DatabaseSettings, type FilterNode, type Page, type Property } from "../shared/types";
import { canonicalOperation } from "../shared/save-contract";
import { fileFits } from "../shared/limits";
import { convertPropertyValue, propertyChangeRequiresBackup, propertyOperationSchema,
  propertyPreviewRequestSchema,
  type PropertyBackup, type PropertyChange, type PropertyCommand, type PropertyIssue,
  type PropertyOperation, type PropertyOperationResult, type PropertyPreviewRequest,
  type PropertyPreviewResult } from "../shared/property-operation";

const hash = (value: unknown) => createHash("sha256").update(canonicalOperation(value)).digest("hex");
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Compare the actual source bytes as well as revisions. This catches membership
 * changes (row creation does not bump its owner) and external invalid writers. */
function sourceScope(db: DatabaseSync, owner: string) {
  return {
    owner: db.prepare("SELECT data FROM pages WHERE id=?").get(owner),
    registered: db.prepare("SELECT database_page_id FROM record_databases WHERE database_page_id=?").get(owner),
    members: db.prepare("SELECT m.page_id,m.database_page_id,m.position,m.values_json,p.data FROM record_memberships m LEFT JOIN pages p ON p.id=m.page_id WHERE m.database_page_id=? ORDER BY m.page_id").all(owner),
  };
}
function readState(store: Store, owner: string) {
  store.assertRecordWriteSchema();
  const page = store.get(owner);
  if (page.id !== owner || page.kind !== "database" || !page.database || page.database.rows.length ||
      page.deletedAt !== null || page.documentError ||
      !store.db.prepare("SELECT 1 FROM record_databases WHERE database_page_id=?").get(owner))
    throw new Error("登録済みデータベースを安全に読み込めません。");
  const repository = new RecordRepository(store), database = repository.databaseProjection(owner);
  const records = database.records.map((record) => {
    const recordPage = store.get(record.pageId);
    if (recordPage.id !== record.pageId || recordPage.kind !== "page" || recordPage.database !== null ||
        recordPage.documentError || recordPage.revision !== record.revision || record.databasePageId !== owner)
      throw new Error("所属レコードの原本を安全に読み込めません。");
    return {page: recordPage, record};
  }).sort((a, b) => a.page.id.localeCompare(b.page.id));
  return {page, database, records, sourceHash: hash(sourceScope(store.db, owner))};
}
type State = ReturnType<typeof readState>;

function targetProperty(settings: DatabaseSettings, change: Exclude<PropertyChange, {kind: "reorder"}>): Property {
  if (change.kind === "add") {
    if (change.property.id === "title" || settings.properties.some((p) => p.id === change.property.id))
      throw new Error("列IDが既存の列または名前列と重複しています。");
    if (settings.properties.length >= 1000) throw new Error("列数の上限に達しています。");
    return structuredClone(change.property);
  }
  const before = settings.properties.find((p) => p.id === change.propertyId);
  if (!before) throw new Error("変更対象の列がありません。");
  if (change.kind === "rename") return {...before, name: change.name};
  if (change.kind === "remove") return before;
  return {id: before.id, name: before.name, type: change.type,
    ...(change.type === "select" ? {options: [...change.options!]} : {})};
}
function references(node: FilterNode, propertyId: string): boolean {
  return node.kind === "condition" ? node.propertyId === propertyId
    : node.conditions.some((child) => references(child, propertyId));
}
function viewImpacts(settings: DatabaseSettings, before: Property, after: Property) {
  const issues: PropertyIssue[] = [], warnings: PropertyIssue[] = [];
  for (const view of settings.views) {
    if (references(view.filter, before.id)) issues.push({viewId: view.id,
      message: `ビュー「${view.name}」のフィルターがこの列を使用しています。条件を変更または削除してから型を変更してください。`});
    if (view.sorts.some((sort) => sort.propertyId === before.id) || view.groupBy?.propertyId === before.id)
      warnings.push({viewId: view.id, message: `ビュー「${view.name}」の並べ替え・グループ条件は保持します。新しい型で順序やグループが変わることがあります。`});
    const grouped = settings.properties.find((p) => p.id === view.groupBy?.propertyId && p.type === "date");
    const calendar = grouped ?? settings.properties.find((p) => p.type === "date");
    if (view.type === "calendar" && calendar?.id === before.id && after.type !== "date")
      issues.push({viewId: view.id, message: `カレンダービュー「${view.name}」がこの日付列を使用しています。表示形式を変更してから型を変更してください。`});
    if (view.type === "board" && !view.groupBy && settings.properties.find((p) => p.type === "select")?.id === before.id && after.type !== "select")
      issues.push({viewId: view.id, message: `ボードビュー「${view.name}」がこの列を自動グループに使用しています。別のグループ列を指定してから型を変更してください。`});
  }
  return {issues, warnings};
}
/** Removing a column would leave the view conditions that consume it dangling,
 * so every reference is a blocking issue instead of a warning. */
function removalImpacts(settings: DatabaseSettings, property: Property) {
  const issues: PropertyIssue[] = [];
  for (const view of settings.views) {
    if (references(view.filter, property.id)) issues.push({viewId: view.id,
      message: `ビュー「${view.name}」のフィルターがこの列を使用しています。条件を削除してから列を削除してください。`});
    if (view.sorts.some((sort) => sort.propertyId === property.id) || view.groupBy?.propertyId === property.id)
      issues.push({viewId: view.id, message: `ビュー「${view.name}」の並べ替え・グループ条件がこの列を使用しています。条件を外してから列を削除してください。`});
    const grouped = settings.properties.find((p) => p.id === view.groupBy?.propertyId && p.type === "date");
    const calendar = grouped ?? settings.properties.find((p) => p.type === "date");
    if (view.type === "calendar" && calendar?.id === property.id)
      issues.push({viewId: view.id, message: `カレンダービュー「${view.name}」がこの日付列を使用しています。表示形式を変更してから列を削除してください。`});
    if (view.type === "board" && !view.groupBy && settings.properties.find((p) => p.type === "select")?.id === property.id)
      issues.push({viewId: view.id, message: `ボードビュー「${view.name}」がこの列を自動グループに使用しています。別のグループ列を指定してから列を削除してください。`});
  }
  return issues;
}
function plan(state: State, input: Omit<PropertyPreviewRequest, "type">): PropertyPreviewResult {
  const {change} = input, issues: PropertyIssue[] = [], warnings: PropertyIssue[] = [];
  if (state.page.revision !== input.revision) throw new Error("所有データベースが更新されています。プレビューを取り直してください。");
  if (!Number.isSafeInteger(state.page.revision + 1)) throw new Error("所有データベースのrevision上限です。");
  const property = change.kind === "reorder" ? undefined : targetProperty(state.database.settings, change);
  if (change.kind === "add" && state.records.some(({record}) => Object.hasOwn(record.values, property!.id)))
    throw new Error("追加する列IDに既存の未分類値があります。別の列IDを使用してください。");
  const changes: PropertyPreviewResult["changes"] = [];
  if (change.kind === "remove") {
    issues.push(...removalImpacts(state.database.settings, property!));
    for (const {page, record} of state.records) {
      if (!Number.isSafeInteger(page.revision + 1)) issues.push({pageId: page.id, title: page.title, message: "レコードのrevision上限です。"});
      const has = Object.hasOwn(record.values, change.propertyId);
      changes.push({pageId: page.id, title: page.title, deleted: page.deletedAt !== null,
        ...(has ? {before: record.values[change.propertyId]} : {}), changed: has});
    }
  }
  if (change.kind === "reorder") {
    const ids = state.database.settings.properties.map((p) => p.id);
    if (change.propertyIds.length !== ids.length || new Set(change.propertyIds).size !== change.propertyIds.length ||
        change.propertyIds.some((id) => !ids.includes(id)))
      throw new Error("列の並び順が現在の列と一致しません。プレビューを取り直してください。");
    if (change.propertyIds.every((id, i) => id === ids[i]))
      throw new Error("列の並び順に変更がありません。");
  }
  if (change.kind === "changeType") {
    const before = state.database.settings.properties.find((p) => p.id === change.propertyId)!;
    if (hash(before) === hash(property)) throw new Error("列の型・選択肢に変更がありません。");
    const impacts = viewImpacts(state.database.settings, before, property!);
    issues.push(...impacts.issues); warnings.push(...impacts.warnings);
    for (const {page, record} of state.records) {
      if (!Number.isSafeInteger(page.revision + 1)) issues.push({pageId: page.id, title: page.title, message: "レコードのrevision上限です。"});
      if (!Object.hasOwn(record.values, before.id)) {
        changes.push({pageId: page.id, title: page.title, deleted: page.deletedAt !== null, changed: false});
        continue;
      }
      const value = record.values[before.id], converted = convertPropertyValue(value, before, property!);
      if (!converted.ok) {
        issues.push({pageId: page.id, title: page.title, message: converted.message});
        changes.push({pageId: page.id, title: page.title, deleted: page.deletedAt !== null, before: value, changed: false});
      } else changes.push({pageId: page.id, title: page.title, deleted: page.deletedAt !== null,
        before: value, after: converted.value, changed: !Object.is(value, converted.value)});
    }
  }
  const command: PropertyCommand = {...structuredClone(input),
    recordRevisions: state.records.map(({page}) => ({pageId: page.id, revision: page.revision})),
    previewHash: hash({sourceHash: state.sourceHash, change})};
  return {ok: issues.length === 0, ...(issues.length ? {} : {command}), ...(property ? {property} : {}),
    changes, issues, warnings,
    recordCount: state.records.length, changedCount: changes.filter((entry) => entry.changed).length,
    requiresBackup: propertyChangeRequiresBackup(change.kind)};
}
export function previewPropertyOperation(store: Store, input: PropertyPreviewRequest): PropertyPreviewResult {
  const parsed = propertyPreviewRequestSchema.parse(input);
  if (store.db.isTransaction) throw new Error("未確定のトランザクションではプレビューできません。");
  try {return store.transaction(() => plan(readState(store, parsed.databasePageId), {
    databasePageId: parsed.databasePageId, revision: parsed.revision, change: parsed.change,
  }));}
  catch (error) {return {ok: false, changes: [], issues: [{message: message(error)}], warnings: [],
    recordCount: 0, changedCount: 0, requiresBackup: propertyChangeRequiresBackup(parsed.change.kind)};}
}
function response(operation: PropertyOperation, status: PropertyOperationResult["status"], text?: string): PropertyOperationResult {
  return {status, operationId: operation.operationId, sessionId: operation.sessionId, seq: operation.seq,
    fingerprint: hash(operation), commandKind: operation.command.change.kind, databasePageId: operation.command.databasePageId,
    ...(text ? {message: text} : {})};
}
function receipt(store: Store, operation: PropertyOperation) {
  const row = store.db.prepare("SELECT fingerprint,result_json FROM save_receipts WHERE operation_id=?").get(operation.operationId) as
    {fingerprint: string; result_json: string} | undefined;
  if (!row) return;
  return row.fingerprint === hash(operation) ? JSON.parse(row.result_json) as PropertyOperationResult
    : response(operation, "rejected", "同じ操作IDに異なる要求があります。原本を保持しています。");
}
function checkedPlan(store: Store, command: PropertyCommand) {
  const state = readState(store, command.databasePageId);
  const preview = plan(state, {databasePageId: command.databasePageId, revision: command.revision, change: command.change});
  if (!preview.ok || !preview.command) throw new Error(preview.issues.map((item) => item.message).join("\n"));
  if (hash(preview.command) !== hash(command)) throw new Error("プレビュー後に列・レコード・所属が変わりました。適用せず原本を保持しています。");
  return {state, preview};
}
function verifiedBackup(store: Store, owner: string, sourceHash: string): PropertyBackup {
  const path = store.path + ".pre-r6-property-" + randomUUID() + ".sqlite";
  store.db.prepare("VACUUM INTO ?").run(path);
  const copy = new DatabaseSync(path, {readOnly: true});
  try {
    const integrity = copy.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok" ||
        hash(sourceScope(copy, owner)) !== sourceHash)
      throw new Error("構造変更前バックアップの検証に失敗しました。原本は変更していません。");
  } finally {copy.close();}
  const descriptor = openSync(path, "r");
  try {fsyncSync(descriptor);} finally {closeSync(descriptor);}
  return {path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), verified: true};
}
export function resolvePropertyOperation(store: Store, input: PropertyOperation): PropertyOperationResult {
  const operation = propertyOperationSchema.parse(input);
  if (store.db.isTransaction) throw new Error("未確定のトランザクションでは結果を照会できません。");
  return receipt(store, operation) ?? response(operation, "unknown", "列変更の保存結果を確認できません。同じ操作の照会を続けてください。");
}
export function commitPropertyOperation(store: Store, input: PropertyOperation): PropertyOperationResult {
  const operation = propertyOperationSchema.parse(input);
  if (store.db.isTransaction) throw new Error("未確定のトランザクションでは列を変更できません。");
  const existing = receipt(store, operation);
  if (existing) return existing;
  let backup: PropertyBackup | undefined, preparationError: unknown;
  try {
    const {state, preview} = store.transaction(() => checkedPlan(store, operation.command));
    if (preview.requiresBackup) backup = verifiedBackup(store, operation.command.databasePageId, state.sourceHash);
  } catch (error) {preparationError = error;}
  return store.transaction(() => {
    const already = receipt(store, operation);
    if (already) return already;
    store.db.exec("SAVEPOINT property_operation");
    let outcome: PropertyOperationResult;
    try {
      if (preparationError) throw preparationError;
      // Recheck after backup and under the write lock. The backup must cover
      // exactly this source, including trashed rows and missing-value records.
      const {state, preview} = checkedPlan(store, operation.command), change = operation.command.change;
      if (preview.requiresBackup && !backup) throw new Error("検証済みバックアップがありません。");
      if (change.kind === "remove") {
        for (const {page, record} of state.records) {
          const values = {...record.values};
          delete values[change.propertyId];
          store.recordVersion(page, {force: true});
          store.db.prepare("UPDATE record_memberships SET values_json=? WHERE page_id=? AND database_page_id=?")
            .run(JSON.stringify(values), page.id, state.page.id);
          store.write({...page, revision: page.revision + 1, updatedAt: Date.now()});
        }
      }
      if (change.kind === "changeType") {
        const byId = new Map(preview.changes.map((entry) => [entry.pageId, entry]));
        for (const {page, record} of state.records) {
          const converted = byId.get(page.id)!;
          const values = {...record.values};
          if (Object.hasOwn(converted, "after")) values[change.propertyId] = converted.after!;
          if (!fileFits(JSON.stringify(values))) throw new Error("変換後の値が保存上限を超えます。");
          store.recordVersion(page, {force: true});
          store.db.prepare("UPDATE record_memberships SET values_json=? WHERE page_id=? AND database_page_id=?")
            .run(JSON.stringify(values), page.id, state.page.id);
          store.write({...page, revision: page.revision + 1, updatedAt: Date.now()});
        }
      }
      const properties = change.kind === "add" ? [...state.database.settings.properties, preview.property!]
        : change.kind === "remove" ? state.database.settings.properties.filter((p) => p.id !== change.propertyId)
        : change.kind === "reorder" ? change.propertyIds.map((id) => state.database.settings.properties.find((p) => p.id === id)!)
        : state.database.settings.properties.map((p) => p.id === preview.property!.id ? preview.property! : p);
      const settings = {...state.database.settings, properties};
      requestSchema.parse({type: "database:settings", databasePageId: state.page.id, revision: state.page.revision, settings});
      store.recordVersion(state.page, {force: true});
      const page = store.write({...state.page, database: {...settings, rows: []}, revision: state.page.revision + 1, updatedAt: Date.now()});
      const database = new RecordRepository(store).databaseProjection(page.id);
      const records = database.records.map((record) => ({page: store.get(record.pageId), record}));
      outcome = {...response(operation, "applied"), page, database, records, ...(backup ? {backup} : {})};
      store.db.exec("RELEASE SAVEPOINT property_operation");
    } catch (error) {
      store.db.exec("ROLLBACK TO SAVEPOINT property_operation");
      store.db.exec("RELEASE SAVEPOINT property_operation");
      outcome = response(operation, "rejected", message(error));
    }
    store.db.prepare("INSERT INTO save_receipts(operation_id,fingerprint,result_json) VALUES(?,?,?)")
      .run(operation.operationId, hash(operation), JSON.stringify(outcome));
    return outcome;
  });
}
