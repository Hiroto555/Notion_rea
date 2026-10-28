import { validateCrashRecoverySnapshot, type CrashRecoverySnapshot } from "../shared/crash-recovery";
import type { Request, Snapshot, Page, RecordProjection } from "../shared/types";
import type { DatabaseReadSnapshot } from "../shared/database-operation";
import { legacyMigrationOperationSchema } from "../shared/legacy-migration-operation";
import { propertyOperationSchema } from "../shared/property-operation";
import { resolveReliableSave } from "./reliable-save";
import { resolveDatabaseOperation } from "./reliable-database-operation";
import { reconcileEditRecovery, reconcileDatabaseRecovery } from "./crash-recovery-resume";
import { exchangeStructural, type StructuralOperation } from "./structural-operation";

/** Explicit startup recovery only. Query the exact retained request. An absent or unknown receipt
 * keeps the journal for another query or an explicit recovery copy. Validate every fresh source before installing any editor session. */
export async function prepareCrashRecovery(input: CrashRecoverySnapshot,
  api: <T>(request: Request) => Promise<T>): Promise<CrashRecoverySnapshot> {
  const snapshot = validateCrashRecoverySnapshot(input);
  if (snapshot.unverifiedInputs?.length) throw new Error("入力元の編集画面を確認できません。別ページに復旧してください。");
  for (const operation of snapshot.creations) {
    const result = await resolveDatabaseOperation(operation, api);
    if (result.status !== "applied") throw new Error(result.message || "DB作成結果を確認できません。");
  }
  for (const entry of snapshot.externalOperations) {
    const operation: StructuralOperation = entry.family === "migration" ?
      {family: "migration", operation: legacyMigrationOperationSchema.parse(entry.operation)} :
      {family: "property", operation: propertyOperationSchema.parse(entry.operation)};
    const result = await exchangeStructural(operation, true);
    if (result.status !== "applied") throw new Error(result.message || "構成変更の結果を確認できません。");
  }
  const edits = [...snapshot.pages, ...snapshot.records];
  const editResults = new Map();
  for (const entry of edits) {
    if (!entry.operation) continue;
    const result = await resolveReliableSave(entry.operation, api);
    if (result.status !== "applied") throw new Error(result.message || "保存結果を確認できません。");
    editResults.set(entry.base.id, result);
  }
  const databaseResults = new Map();
  for (const entry of snapshot.databases) {
    if (!entry.operation) continue;
    const result = await resolveDatabaseOperation(entry.operation, api);
    if (result.status !== "applied") throw new Error(result.message || "DB保存結果を確認できません。");
    databaseResults.set(entry.base.id, result);
  }
  const state = await api<Snapshot>({type: "load"});
  snapshot.pages = snapshot.pages.map((entry) => {
    const page = state.pages.find((page) => page.id === entry.base.id);
    if (!page || state.records?.some((record) => record.pageId === page.id) || state.recordDatabaseIds?.includes(page.id))
      throw new Error("復旧元ページの所属が変わりました。別ページに復旧してください。");
    return reconcileEditRecovery(entry, {page}, editResults.get(entry.base.id));
  });
  snapshot.records = await Promise.all(snapshot.records.map(async (entry) => {
    const current = await api<{page: Page; record: RecordProjection}>({type: "record:read", pageId: entry.base.id});
    return reconcileEditRecovery(entry, current, editResults.get(entry.base.id));
  }));
  snapshot.databases = await Promise.all(snapshot.databases.map(async (entry) => {
    const current = await api<DatabaseReadSnapshot>({type: "database:read", databasePageId: entry.base.id});
    return reconcileDatabaseRecovery(entry, current, databaseResults.get(entry.base.id));
  }));
  for (const draft of snapshot.rawDrafts) {
    if (draft.scope === "database") {
      const keys = JSON.parse(draft.key);
      if (!Array.isArray(keys) || keys.length !== 2 || keys.some((key) => typeof key !== "string" || !key))
        throw new Error("フィルター入力の復旧先を確認できません。");
    }
    const source = draft.scope === "record" ? snapshot.records : snapshot.databases;
    if (!source.some((entry) => entry.base.id === draft.pageId)) throw new Error("入力中の値の保存元を確認できません。");
  }
  snapshot.creations = []; snapshot.externalOperations = [];
  return validateCrashRecoverySnapshot(snapshot);
}
