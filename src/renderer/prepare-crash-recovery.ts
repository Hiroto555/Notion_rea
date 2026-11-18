import { validateCrashRecoverySnapshot, type CrashRecoverySnapshot } from "../shared/crash-recovery";
import type { Request, Snapshot, Page, RecordProjection } from "../shared/types";
import type { DatabaseReadSnapshot } from "../shared/database-operation";
import type { RecordReadSnapshot } from "../shared/app-api";
import { legacyMigrationOperationSchema } from "../shared/legacy-migration-operation";
import { propertyOperationSchema } from "../shared/property-operation";
import { resolveReliableSave, type SaveTransport } from "./reliable-save";
import { resolvePageOperation } from "./page-operation-coordinator";
import { resolveDatabaseOperation } from "./reliable-database-operation";
import { reconcileEditRecovery, reconcileDatabaseRecovery } from "./crash-recovery-resume";
import { exchangeStructural, type StructuralOperation, type StructuralTransport } from "./structural-operation";

export type CrashRecoveryPorts = {
  recordSend: SaveTransport;
  databaseSend: SaveTransport;
  structuralSend: StructuralTransport;
  readRecord(pageId: string): Promise<RecordReadSnapshot>;
  readDatabase(databasePageId: string): Promise<DatabaseReadSnapshot>;
};

const portFields = ["recordSend", "databaseSend", "structuralSend", "readRecord", "readDatabase"] as const;
function requireCrashRecoveryPorts(ports: unknown): CrashRecoveryPorts {
  if (typeof ports !== "object" || ports === null) throw new Error("復旧用の保存経路を確認できません。");
  const candidate = ports as Record<string, unknown>;
  for (const field of portFields) if (typeof candidate[field] !== "function") throw new Error("復旧用の保存経路を確認できません。");
  return ports as CrashRecoveryPorts;
}

/** Explicit startup recovery only. Query the exact retained request. An absent or unknown receipt
 * keeps the journal for another query or an explicit recovery copy. Validate every fresh source before installing any editor session. */
export async function prepareCrashRecovery(input: CrashRecoverySnapshot,
  api: <T>(request: Request) => Promise<T>, ports?: CrashRecoveryPorts): Promise<CrashRecoverySnapshot> {
  const snapshot = validateCrashRecoverySnapshot(input);
  if (snapshot.unverifiedInputs?.length) throw new Error("入力元の編集画面を確認できません。別ページに復旧してください。");
  const recoveryPorts = ports === undefined ? undefined : requireCrashRecoveryPorts(ports);
  const databaseSend: SaveTransport = recoveryPorts ? recoveryPorts.databaseSend : api;
  for (const operation of snapshot.creations) {
    const result = await resolveDatabaseOperation(operation, databaseSend);
    if (result.status !== "applied") throw new Error(result.message || "DB作成結果を確認できません。");
  }
  for (const operation of snapshot.pageOperations ?? []) {
    const result = await resolvePageOperation(operation, api);
    if (result.status !== "applied") throw new Error(result.message || "ページ作成結果を確認できません。");
  }
  for (const entry of snapshot.externalOperations) {
    const operation: StructuralOperation = entry.family === "migration" ?
      {family: "migration", operation: legacyMigrationOperationSchema.parse(entry.operation)} :
      {family: "property", operation: propertyOperationSchema.parse(entry.operation)};
    const result = recoveryPorts ? await exchangeStructural(operation, true, undefined, recoveryPorts.structuralSend) : await exchangeStructural(operation, true);
    if (result.status !== "applied") throw new Error(result.message || "構成変更の結果を確認できません。");
  }
  const edits = [
    ...snapshot.pages.map((entry) => ({entry, record: false})),
    ...snapshot.records.map((entry) => ({entry, record: true})),
  ];
  const editResults = new Map();
  for (const {entry, record} of edits) {
    if (!entry.operation) continue;
    const send: SaveTransport = record && recoveryPorts ? recoveryPorts.recordSend : api;
    const result = await resolveReliableSave(entry.operation, send);
    if (result.status !== "applied") throw new Error(result.message || "保存結果を確認できません。");
    editResults.set(entry.base.id, result);
  }
  const databaseResults = new Map();
  for (const entry of snapshot.databases) {
    if (!entry.operation) continue;
    const result = await resolveDatabaseOperation(entry.operation, databaseSend);
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
    const current = recoveryPorts ? await recoveryPorts.readRecord(entry.base.id) :
      await api<{page: Page; record: RecordProjection}>({type: "record:read", pageId: entry.base.id});
    return reconcileEditRecovery(entry, current, editResults.get(entry.base.id));
  }));
  snapshot.databases = await Promise.all(snapshot.databases.map(async (entry) => {
    const current = recoveryPorts ? await recoveryPorts.readDatabase(entry.base.id) :
      await api<DatabaseReadSnapshot>({type: "database:read", databasePageId: entry.base.id});
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
  if (snapshot.pageOperations) snapshot.pageOperations = [];
  return validateCrashRecoverySnapshot(snapshot);
}
