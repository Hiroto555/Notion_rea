import { z } from "zod";
import { canonicalOperation, type SaveOperation } from "./save-contract";
import type { DatabaseOperation } from "./database-operation";
import { databaseOperationSchema, databaseSettingsSchema, isDocument, saveOperationSchema,
  type DatabaseProjection, type FilterValue, type Page, type PagePatch, type RecordPagePatch, type RecordProjection } from "./types";
import { applySettingsIntent, type SettingsIntent } from "../renderer/settings-intent";

export const CRASH_RECOVERY_MAX_BYTES = 32 * 1024 * 1024;
export type RecoveryEditIntent = {seq: number; patch: PagePatch; values?: Record<string, FilterValue | null>};
export type EditSessionRecovery = {sessionId: string; base: Page; record?: RecordProjection; seq: number;
  intents: RecoveryEditIntent[]; operation?: SaveOperation};
export type RecoveryDatabaseIntent = {seq: number} & (
  {kind: "page"; patch: RecordPagePatch} | {kind: "settings"; intent: SettingsIntent} |
  {kind: "createRecord"; title: string; values: Record<string, FilterValue>});
export type DatabaseSessionRecovery = {sessionId: string; base: Page; projection: DatabaseProjection; seq: number;
  intents: RecoveryDatabaseIntent[]; operation?: DatabaseOperation};
export type CrashRecoverySnapshot = {schemaVersion: 1; pages: EditSessionRecovery[]; records: EditSessionRecovery[];
  databases: DatabaseSessionRecovery[]; creations: DatabaseOperation[];
  rawDrafts: {scope: "record" | "database"; pageId: string; key: string; value: string}[];
  /** Provenance was not established. Retain the complete input for copy-only
   * recovery; startup must not turn it into an acknowledged editor session. */
  unverifiedInputs?: {reason: string; input: unknown}[];
  /** Retained as bounded JSON only. A caller MUST apply the family's request schema before resolving it. */
  externalOperations: {family: "property" | "migration"; operation: Record<string, unknown>}[]};
export type CrashRecoveryRead = {status: "empty" | "ready" | "blocked"; generation: number;
  snapshot?: CrashRecoverySnapshot; message?: string};

export function emptyCrashRecoverySnapshot(): CrashRecoverySnapshot {
  return {schemaVersion: 1, pages: [], records: [], databases: [], creations: [], rawDrafts: [], externalOperations: []};
}
export function hasCrashRecoveryInput(snapshot: CrashRecoverySnapshot): boolean {
  return snapshot.pages.length + snapshot.records.length + snapshot.databases.length + snapshot.creations.length +
    snapshot.rawDrafts.length + snapshot.externalOperations.length + (snapshot.unverifiedInputs?.length ?? 0) > 0;
}

const id = z.string().min(1).max(500), sessionId = z.string().min(1).max(100);
const count = z.number().int().nonnegative().safe(), seq = count.min(1);
const recordSchema = z.object({pageId: id, databasePageId: id, revision: count, title: z.string(), icon: z.string(),
  values: z.record(z.union([z.string(), z.boolean(), z.number().finite()])), deletedAt: z.number().nullable()}).strict();
const pageSchema = z.object({id, schemaVersion: count.optional(), parentId: id.nullable(), title: z.string(),
  icon: z.string(), cover: z.string(), position: z.number().finite(), doc: z.custom((value) => isDocument(value)),
  kind: z.enum(["page", "database"]), database: z.unknown(), favorite: z.boolean(), createdAt: z.number().finite(),
  updatedAt: z.number().finite(), revision: count, deletedAt: z.number().finite().nullable(),
  documentError: z.string().optional(), recoveredFrom: z.object({pageId: id, recoveredAt: z.number().finite()}).strict().optional()}).strict();
const editSchema = z.lazy(() => z.object({sessionId, base: pageSchema, record: recordSchema.optional(), seq: count,
  intents: z.array(z.object({seq, patch: z.record(z.unknown()), values: z.record(z.unknown()).optional()}).strict()).max(10000),
  operation: saveOperationSchema.optional()}).strict());
const databaseSchema = z.lazy(() => z.object({sessionId, base: pageSchema,
  projection: z.object({revision: count, settings: databaseSettingsSchema, records: z.array(recordSchema).max(100000)}).strict(),
  seq: count, intents: z.array(z.record(z.unknown())).max(10000), operation: databaseOperationSchema.optional()}).strict());
const snapshotSchema = z.lazy(() => z.object({schemaVersion: z.literal(1), pages: z.array(editSchema).max(1000), records: z.array(editSchema).max(1000),
  databases: z.array(databaseSchema).max(1000), creations: z.array(databaseOperationSchema).max(1000),
  rawDrafts: z.array(z.object({scope: z.enum(["record", "database"]), pageId: id, key: z.string().min(1).max(2000),
    value: z.string().max(100000)}).strict()).max(10000),
  unverifiedInputs: z.array(z.object({reason: z.string().min(1).max(2000),
    input: z.unknown().refine((value) => value !== undefined, "Missing unverified input")}).strict()).max(1000).optional(),
  externalOperations: z.array(z.object({family: z.enum(["property", "migration"]), operation: z.record(z.unknown())}).strict()).max(1000)}).strict());

/** Reject unsupported JSON rather than letting stringify erase pending input. */
export function assertRecoveryJson(root: unknown): void {
  const seen = new Set<object>(), stack: {value: unknown; depth: number; leaving?: boolean}[] = [{value: root, depth: 0}]; let nodes = 0;
  while (stack.length) {
    const {value, depth, leaving} = stack.pop()!;
    if (leaving) {seen.delete(value as object); continue;}
    if (++nodes > 500000 || depth > 120) throw new Error("Recovery structure exceeds limits");
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    // Match the application's finite-number domain. JSON canonicalizes -0 to
    // 0; safe-integer limits belong to the seq/revision/generation schemas.
    if (typeof value === "number" && Number.isFinite(value)) continue;
    if (!value || typeof value !== "object" || seen.has(value)) throw new Error("Recovery contains unsupported JSON");
    seen.add(value);
    stack.push({value, depth, leaving: true});
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Invalid recovery object");
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value) && keys.length !== value.length + 1) throw new Error("Sparse recovery array");
    for (const key of keys) {
      if (Array.isArray(value) && key === "length") continue;
      const field = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== "string" || key === "__proto__" || !field.enumerable || !("value" in field)) throw new Error("Unsafe recovery field");
      stack.push({value: field.value, depth: depth + 1});
    }
  }
}
function ordered(intents: {seq: number}[], through: number) {
  let previous = 0;
  for (const intent of intents) {
    if (!Number.isSafeInteger(intent.seq) || intent.seq <= previous || intent.seq > through) throw new Error("Invalid recovery input generation");
    previous = intent.seq;
  }
}
function identity(entry: {sessionId: string; seq: number; base: Page}, operation: {sessionId: string; seq: number}) {
  if (operation.sessionId !== entry.sessionId || operation.seq > entry.seq) throw new Error("Recovery operation session differs");
}
export function validateEditRecovery(input: unknown): EditSessionRecovery {
  assertRecoveryJson(input); editSchema.parse(input); const entry = input as EditSessionRecovery;
  if (entry.base.documentError || entry.base.deletedAt !== null) throw new Error("Recovery base is not editable");
  if (entry.record && (entry.record.pageId !== entry.base.id || entry.record.revision !== entry.base.revision ||
    entry.record.title !== entry.base.title || entry.record.icon !== entry.base.icon || entry.record.deletedAt !== null ||
    entry.base.kind !== "page" || entry.base.database !== null)) throw new Error("Recovery record ownership differs");
  ordered(entry.intents, entry.seq);
  for (const intent of entry.intents) saveOperationSchema.parse({operationId: "validate", sessionId: entry.sessionId,
    pageId: entry.base.id, databasePageId: entry.record?.databasePageId ?? null, revision: entry.base.revision, ...intent});
  if (entry.operation) {
    identity(entry, entry.operation);
    if (entry.operation.pageId !== entry.base.id || entry.operation.revision !== entry.base.revision ||
      entry.operation.databasePageId !== (entry.record?.databasePageId ?? null)) throw new Error("Recovery operation base differs");
    const patch: PagePatch = {}, values: Record<string, FilterValue | null> = {};
    const sent = entry.intents.filter((intent) => intent.seq <= entry.operation!.seq);
    for (const intent of sent) {Object.assign(patch, intent.patch); Object.assign(values, intent.values);}
    if (sent.at(-1)?.seq !== entry.operation.seq || canonicalOperation(patch) !== canonicalOperation(entry.operation.patch) ||
      canonicalOperation(values) !== canonicalOperation(entry.operation.values ?? {})) throw new Error("Recovery request does not match captured input");
  }
  return structuredClone(entry);
}
export function validateDatabaseRecovery(input: unknown): DatabaseSessionRecovery {
  assertRecoveryJson(input); databaseSchema.parse(input); const entry = input as DatabaseSessionRecovery;
  if (entry.base.kind !== "database" || !entry.base.database || entry.base.database.rows.length || entry.base.deletedAt !== null || entry.base.documentError ||
    entry.projection.revision !== entry.base.revision || entry.projection.records.some((record) => record.databasePageId !== entry.base.id)) throw new Error("Recovery database base differs");
  const {rows: _rows, ...baseSettings} = entry.base.database;
  if (canonicalOperation(baseSettings) !== canonicalOperation(entry.projection.settings)) throw new Error("Recovery owner settings differ");
  ordered(entry.intents, entry.seq); let settings = entry.projection.settings;
  for (const intent of entry.intents) {
    const command = intent.kind === "createRecord" ? {kind: intent.kind, databasePageId: entry.base.id, revision: entry.base.revision, title: intent.title, values: intent.values} :
      {kind: "updateDatabase", databasePageId: entry.base.id, revision: entry.base.revision, patch: intent.kind === "page" ? intent.patch : {},
        settings: intent.kind === "settings" ? applySettingsIntent(settings, intent.intent) : settings};
    const expectedKeys = intent.kind === "createRecord" ? ["kind", "seq", "title", "values"] : intent.kind === "page" ? ["kind", "patch", "seq"] : intent.kind === "settings" ? ["intent", "kind", "seq"] : [];
    if (Object.keys(intent).sort().join() !== expectedKeys.join()) throw new Error("Invalid recovery database intent");
    databaseOperationSchema.parse({operationId: "validate", sessionId: entry.sessionId, seq: intent.seq, command});
    if (intent === entry.intents[0] && entry.operation && canonicalOperation(command) !== canonicalOperation(entry.operation.command)) throw new Error("Recovery database request differs from first intent");
    if (intent.kind === "settings") settings = applySettingsIntent(settings, intent.intent);
  }
  if (entry.operation) {
    identity(entry, entry.operation);
    if (entry.operation.command.kind === "createDatabase" || entry.operation.command.databasePageId !== entry.base.id ||
      entry.operation.command.revision !== entry.base.revision || entry.intents[0]?.seq !== entry.operation.seq) throw new Error("Recovery database request base differs");
  }
  return structuredClone(entry);
}
export function validateCrashRecoverySnapshot(input: unknown): CrashRecoverySnapshot {
  assertRecoveryJson(input); snapshotSchema.parse(input); const snapshot = input as CrashRecoverySnapshot;
  const lanes = new Set<string>(), operations = new Set<string>();
  for (const entry of [...snapshot.pages, ...snapshot.records, ...snapshot.databases]) {
    if (lanes.has(entry.base.id)) throw new Error("Duplicate recovery lane"); lanes.add(entry.base.id);
  }
  for (const entry of snapshot.pages) {validateEditRecovery(entry); if (entry.record) throw new Error("Unexpected record in Page recovery");}
  for (const entry of snapshot.records) {validateEditRecovery(entry); if (!entry.record) throw new Error("Missing record ownership");}
  for (const entry of snapshot.databases) validateDatabaseRecovery(entry);
  const allOperations: {operationId?: unknown; sessionId?: unknown; seq?: unknown}[] = [
    ...[...snapshot.pages, ...snapshot.records, ...snapshot.databases].flatMap((entry) => entry.operation ? [entry.operation] : []),
    ...snapshot.creations, ...snapshot.externalOperations.map((entry) => entry.operation),
  ];
  for (const operation of allOperations) {
    const op = operation as {operationId: string; sessionId: string; seq: number};
    sessionId.parse(op.operationId); sessionId.parse(op.sessionId); seq.parse(op.seq);
    if (operations.has(op.operationId)) throw new Error("Duplicate recovery operation"); operations.add(op.operationId);
  }
  if (snapshot.creations.some((operation) => operation.command.kind !== "createDatabase")) throw new Error("Invalid database creation recovery");
  const rawKeys = new Set<string>();
  for (const draft of snapshot.rawDrafts) {
    const key = JSON.stringify([draft.scope, draft.pageId, draft.key]);
    if (rawKeys.has(key)) throw new Error("Duplicate raw recovery input");
    rawKeys.add(key);
  }
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > CRASH_RECOVERY_MAX_BYTES) throw new Error("Recovery exceeds byte limit");
  return structuredClone(snapshot);
}

/** Lazy validation keeps requestSchema -> recovery -> requestSchema imports safe. */
export const crashRecoverySnapshotSchema = z.custom<CrashRecoverySnapshot>((input) => {
  try {validateCrashRecoverySnapshot(input); return true;} catch {return false;}
}, "Invalid crash recovery snapshot");
