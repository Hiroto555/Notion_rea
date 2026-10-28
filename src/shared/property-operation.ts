import { z } from "zod";
import type { DatabaseProjection, FilterValue, Page, Property, RecordProjection } from "./types";

const id = z.string().min(1).max(500);
const revision = z.number().int().nonnegative().safe().max(Number.MAX_SAFE_INTEGER - 1);
export const propertyTypeSchema = z.enum(["text", "number", "checkbox", "date", "select"]);
const options = z.array(z.string().min(1).max(200)).max(1000)
  .refine((items) => new Set(items).size === items.length, "選択肢が重複しています。");
const shape = {type: propertyTypeSchema, options: options.optional()};
const validOptions = (value: {type: Property["type"]; options?: string[]}) =>
  value.type === "select" ? !!value.options?.length : value.options === undefined;
export const propertyChangeSchema = z.discriminatedUnion("kind", [
  z.object({kind: z.literal("add"), property: z.object({id, name: z.string().min(1).max(200), ...shape}).strict()}).strict(),
  z.object({kind: z.literal("rename"), propertyId: id, name: z.string().min(1).max(200)}).strict(),
  z.object({kind: z.literal("changeType"), propertyId: id, ...shape}).strict(),
]).refine((change) => change.kind === "rename" || validOptions(change.kind === "add" ? change.property : change),
  "セレクト型には重複のない選択肢が必要です。他の型に選択肢は指定できません。");
export type PropertyChange = z.infer<typeof propertyChangeSchema>;
export const propertyPreviewRequestSchema = z.object({type: z.literal("property:preview"),
  databasePageId: id, revision, change: propertyChangeSchema}).strict();
export type PropertyPreviewRequest = z.infer<typeof propertyPreviewRequestSchema>;
export const propertyCommandSchema = propertyPreviewRequestSchema.omit({type: true}).extend({
  recordRevisions: z.array(z.object({pageId: id, revision: z.number().int().nonnegative().safe()}).strict()).max(100_000),
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type PropertyCommand = z.infer<typeof propertyCommandSchema>;
export const propertyOperationSchema = z.object({operationId: z.string().min(1).max(100),
  sessionId: z.string().min(1).max(100), seq: z.number().int().positive().safe(), command: propertyCommandSchema}).strict();
export type PropertyOperation = z.infer<typeof propertyOperationSchema>;
export const propertyCommitRequestSchema = z.object({type: z.literal("property:commit"), operation: propertyOperationSchema}).strict();
export const propertyResolveRequestSchema = z.object({type: z.literal("property:resolve"), operation: propertyOperationSchema}).strict();
export type PropertyIssue = {pageId?: string; title?: string; viewId?: string; message: string};
export type PropertyValueChange = {pageId: string; title: string; deleted: boolean;
  before?: FilterValue; after?: FilterValue; changed: boolean};
export type PropertyPreviewResult = {ok: boolean; command?: PropertyCommand;
  property?: Property; changes: PropertyValueChange[]; issues: PropertyIssue[];
  warnings: PropertyIssue[]; recordCount: number; changedCount: number; requiresBackup: boolean};
export type PropertyBackup = {path: string; sha256: string; verified: true};
export type PropertyOperationResult = {status: "applied" | "rejected" | "unknown";
  operationId: string; sessionId: string; seq: number; fingerprint: string;
  commandKind: PropertyChange["kind"]; databasePageId: string;
  page?: Page; database?: DatabaseProjection; records?: {page: Page; record: RecordProjection}[];
  backup?: PropertyBackup; message?: string};

/** A completed preview is the immutable input. Never regenerate this operation
 * after an ambiguous send; resolve the same identity instead. */
export function preparePropertyOperation(command: PropertyCommand): PropertyOperation {
  return {operationId: crypto.randomUUID(), sessionId: crypto.randomUUID(), seq: 1,
    command: structuredClone(command)};
}

export function isStrictDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** No whitespace trimming, rounding, truthiness coercion or invalid-value deletion. */
export function convertPropertyValue(value: FilterValue, source: Property, target: Property):
  {ok: true; value: FilterValue} | {ok: false; message: string} {
  const fail = (message: string) => ({ok: false as const, message});
  const validSource = source.type === "number" ? typeof value === "number" && Number.isFinite(value)
    : source.type === "checkbox" ? typeof value === "boolean"
    : source.type === "date" ? typeof value === "string" && (value === "" || isStrictDate(value))
    : source.type === "select" ? typeof value === "string" && (value === "" || !!source.options?.includes(value))
    : typeof value === "string";
  if (!validSource) return fail("既存の値が現在の列型と一致しません。原値を保持します。");
  if (target.type === "text") return {ok: true, value: String(value)};
  if (target.type === "select") return typeof value === "string" && (value === "" || !!target.options?.includes(value))
    ? {ok: true, value} : fail("値が指定された選択肢にありません。原値を保持します。");
  if (target.type === "date") return typeof value === "string" && (value === "" || isStrictDate(value))
    ? {ok: true, value} : fail("実在するYYYY-MM-DD形式の日付ではありません。原値を保持します。");
  if (target.type === "number") {
    if (typeof value === "number") return {ok: true, value};
    if (typeof value === "boolean") return {ok: true, value: value ? 1 : 0};
    const number = Number(value);
    return value !== "" && Number.isFinite(number) && String(number) === value
      ? {ok: true, value: number} : fail("表記を失わず数値に変換できません（空白・先頭ゼロ等）。原値を保持します。");
  }
  if (typeof value === "boolean") return {ok: true, value};
  if (value === 0 || value === "false") return {ok: true, value: false};
  if (value === 1 || value === "true") return {ok: true, value: true};
  return fail("チェックボックスへはtrue/falseまたは数値0/1だけを変換できます。原値を保持します。");
}
