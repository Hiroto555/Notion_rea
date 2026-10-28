import { z } from "zod";
import type { PendingEdits } from "../renderer/pending-edits";
import { fileFits } from "./limits";
import { requestSchema, type PagePatch, type RecordPatch, type DatabaseSettings, type FilterValue } from "./types";

/** A manual inspection record, not a backup or an automatically replayable file.
 * It contains only captured pending operations; source Pages, referenced assets,
 * links, history and owner membership are deliberately not claimed to be here. */
const FORMAT = "folio-pending-journal" as const;
const VERSION = 1 as const;
const id = z.string().min(1).max(500);
const generation = z.number().int().positive().safe();
const revision = z.number().int().nonnegative().safe();
const viewType = z.enum(["table", "board", "calendar", "gallery"]);
const direction = z.enum(["asc", "desc"]);
const value = z.union([z.string(), z.boolean(), z.number().finite()]);
const operators = z.enum([
  "contains", "not_contains", "equals", "not_equals", "starts_with", "ends_with",
  "is_empty", "is_not_empty", "greater_than", "greater_than_or_equal", "less_than",
  "less_than_or_equal", "before", "after", "on_or_before", "on_or_after", "is_checked", "is_not_checked",
]);
const condition = z.object({ kind: z.literal("condition"), id, propertyId: id, operator: operators, value: value.optional() }).strict();
const filterNode: z.ZodTypeAny = z.lazy(() => z.union([
  condition,
  z.object({ kind: z.literal("group"), id, conjunction: z.enum(["and", "or"]), conditions: z.array(filterNode).max(200) }).strict(),
]));
const filter = z.object({ kind: z.literal("group"), id, conjunction: z.enum(["and", "or"]), conditions: z.array(filterNode).max(200) }).strict().superRefine((root, ctx) => {
  const stack: { node: any; depth: number }[] = [{ node: root, depth: 0 }];
  const ids = new Set<string>(); let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++count > 200 || depth > 8 || ids.has(node.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid filter depth or identity" }); return;
    }
    ids.add(node.id);
    if (node.kind === "group") for (const child of node.conditions) stack.push({ node: child, depth: depth + 1 });
  }
});
const sort = z.object({ id, propertyId: id, direction }).strict();
const groupBy = z.object({ propertyId: id, direction }).strict().nullable();
const viewFields = {
  name: z.string().max(200), type: viewType, filterText: z.string().max(10_000),
  filter, sorts: z.array(sort).max(50), groupBy,
};
const view = z.object({ id, ...viewFields }).strict();
const partialView = z.object(viewFields).partial().strict();
const property = z.object({ id, name: z.string(), type: z.enum(["text", "number", "select", "date", "checkbox"]), options: z.array(z.string()).max(1000).optional() }).strict();
const ids = z.array(id).max(1000).refine((xs) => new Set(xs).size === xs.length, "Duplicate identifiers");
const settingsIntent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("viewPatch"), viewId: id, base: partialView, patch: partialView }).strict(),
  z.object({ kind: z.literal("activeView"), base: id, viewId: id }).strict(),
  z.object({ kind: z.literal("createView"), view, baseOrder: ids, baseActive: id, afterViewId: id.nullable(), source: view.optional() }).strict(),
  z.object({ kind: z.literal("deleteView"), base: view }).strict(),
  z.object({ kind: z.literal("moveView"), viewId: id, baseOrder: ids, baseActive: id, delta: z.union([z.literal(-1), z.literal(1)]) }).strict(),
  z.object({ kind: z.literal("addProperty"), property, basePropertyIds: ids }).strict(),
]).superRefine((intent, ctx) => {
  if (intent.kind === "viewPatch") {
    const before = Object.keys(intent.base).sort(), after = Object.keys(intent.patch).sort();
    if (!before.length || JSON.stringify(before) !== JSON.stringify(after))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid view patch base" });
  }
});
const nonempty = (item: unknown) => !!item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length > 0;
const validPagePatch = (patch: unknown) => nonempty(patch) && requestSchema.safeParse({ type: "update", id: "journal-validation", revision: 0, patch }).success;
const validRecordPatch = (patch: unknown) => nonempty(patch) && requestSchema.safeParse({ type: "record:patch", pageId: "journal-validation", databasePageId: "journal-owner", revision: 0, patch }).success && !(typeof patch === "object" && patch !== null && "values" in patch && !nonempty((patch as any).values));
const pageEntry = z.object({ kind: z.literal("page"), seq: generation, id, patch: z.custom<PagePatch>(validPagePatch), observedRevision: revision.optional(), observedKnown: z.boolean().optional(), expectedOwnerId: id.optional(), recoveryKind: z.enum(["record", "database"]).optional() }).strict().superRefine((entry, ctx) => {
  if ((entry.observedRevision === undefined) !== (entry.observedKnown === undefined) ||
      ((entry.expectedOwnerId !== undefined || entry.recoveryKind !== undefined) && entry.observedRevision === undefined))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Incomplete Page provenance" });
});
const valuesEntry = z.object({ kind: z.literal("values"), seq: generation, id, values: z.custom<Record<string, FilterValue | null>>((v) => validRecordPatch({ values: v })) }).strict();
const recordEntry = z.object({ kind: z.literal("record"), seq: generation, id, observedRevision: revision, observedKnown: z.boolean(), expectedOwnerId: id.optional(), patch: z.custom<RecordPatch>(validRecordPatch) }).strict();
const settingsEntry = z.object({ kind: z.literal("settings"), seq: generation, id, baseRevision: revision, settings: z.custom<DatabaseSettings>((settings) => requestSchema.safeParse({ type: "database:settings", databasePageId: "journal-validation", revision: 0, settings }).success) }).strict();
const intentEntry = z.object({ kind: z.literal("settingsIntent"), seq: generation, id, observedRevision: revision, observedKnown: z.boolean(), intent: settingsIntent }).strict();
// These entries can be interleaved. Never coalesce them: every input generation
// must survive exactly as captured, including unknown provenance.
const entry = z.union([pageEntry, valuesEntry, recordEntry, settingsEntry, intentEntry]);
const journalSchema = z.object({ format: z.literal(FORMAT), schemaVersion: z.literal(VERSION), use: z.literal("manual-inspection-only"), capturedThrough: revision, failedIds: ids, entries: z.array(entry).min(1).max(10000) }).strict().superRefine((journal, ctx) => {
  let previous = 0;
  for (const item of journal.entries) {
    if (item.seq <= previous || item.seq > journal.capturedThrough) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate, unordered, or future generation" }); return;
    }
    previous = item.seq;
  }
});
export type PendingJournal = z.infer<typeof journalSchema>;
export type PendingJournalSource = Pick<PendingEdits, "sequence" | "size" | "failed" | "snapshotPages" | "snapshotValues" | "snapshotRecords" | "snapshotSettings" | "snapshotSettingsIntents">;

/** Refuse anything JSON would silently alter, including undefined, non-finite
 * numbers, holes, accessors, non-plain objects, and cyclic/shared references. */
function assertLosslessJson(root: unknown): void {
  const seen = new Set<object>();
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const { value: item, depth } = stack.pop()!;
    if (++nodes > 500_000 || depth > 120) throw new Error("Pending journal structure exceeds limits");
    if (item === null || typeof item === "string" || typeof item === "boolean") continue;
    if (typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0) && (!Number.isInteger(item) || Number.isSafeInteger(item))) continue;
    if (!item || typeof item !== "object" || seen.has(item)) throw new Error("Pending journal contains non-JSON or cyclic data");
    seen.add(item);
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error("Pending journal contains non-plain data");
    const keys = Reflect.ownKeys(item);
    if (keys.some((key) => typeof key !== "string")) throw new Error("Pending journal contains non-JSON keys");
    if (Array.isArray(item) && (keys.length !== item.length + 1 || !keys.includes("length"))) throw new Error("Pending journal contains sparse arrays");
    for (const key of keys) {
      if (Array.isArray(item) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!descriptor.enumerable || !("value" in descriptor) || key === "__proto__") throw new Error("Pending journal contains unsafe fields");
      stack.push({ value: descriptor.value, depth: depth + 1 });
    }
  }
}
function validate(input: unknown): PendingJournal {
  assertLosslessJson(input);
  // Never use transformed output from request schemas: the captured raw values
  // are retained exactly, and no operation is applied to a workspace here.
  journalSchema.parse(input);
  return structuredClone(input) as PendingJournal;
}
/** Synchronically freeze every kind. Abort rather than silently omit input if
 * the source changes during capture. No ACK or discard is ever performed. */
export function capturePendingJournal(source: PendingJournalSource): PendingJournal {
  const through = source.sequence;
  const entries = [
    ...source.snapshotPages().map((item) => ({ kind: "page" as const, ...item })),
    ...source.snapshotValues().map((item) => ({ kind: "values" as const, ...item })),
    ...source.snapshotRecords().map((item) => ({ kind: "record" as const, ...item })),
    ...source.snapshotSettings().map((item) => ({ kind: "settings" as const, ...item })),
    ...source.snapshotSettingsIntents().map((item) => ({ kind: "settingsIntent" as const, ...item })),
  ].sort((a, b) => a.seq - b.seq);
  const failedIds = [...source.failed].sort();
  if (source.sequence !== through || source.size !== entries.length) throw new Error("Pending inputs changed during capture; retained in memory");
  return validate({ format: FORMAT, schemaVersion: VERSION, use: "manual-inspection-only", capturedThrough: through, failedIds, entries });
}
export function serializePendingJournal(input: PendingJournal): string {
  const content = JSON.stringify(validate(input));
  if (!fileFits(content)) throw new Error("Pending journal exceeds the UTF-8 byte limit; drafts retained");
  return content;
}
export function parsePendingJournal(content: string): PendingJournal {
  if (typeof content !== "string" || !fileFits(content)) throw new Error("Invalid or oversized pending journal");
  let input: unknown;
  try { input = JSON.parse(content); } catch { throw new Error("Invalid pending journal JSON"); }
  // Generated journals are canonical. This also rejects duplicate JSON keys,
  // alternate numeric spellings and other potentially lossy representations.
  if (JSON.stringify(input) !== content) throw new Error("Non-canonical pending journal");
  return validate(input);
}
