import { z } from "zod";
import { canonical } from "./canonical";
import {
  demand,
  wellFormed,
  type Attempt,
  type Scope,
  type Cut,
  type Json,
} from "./contract";
import type { Doc } from "../../shared/types";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const text = z.string().max(2_000_000).refine(wellFormed);
const counter = z.number().int().safe().nonnegative();
export const scopeSchema = z
  .object({ orgId: id, workspaceId: id, documentId: id, incarnationId: id })
  .strict();
export const cutSchema = z
  .object({ epoch: id, seq: counter, hash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
const node = z.custom<Doc>(
  (v) =>
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    typeof (v as Doc).type === "string",
);
const legacyCommands = [
  z
    .object({
      kind: z.literal("text"),
      blockId: id,
      from: counter,
      to: counter,
      text,
      before: text,
    })
    .strict(),
  z
    .object({
      kind: z.literal("block.move"),
      positionBase: cutSchema.optional(),
      blockId: id,
      parentId: id.nullable(),
      beforeId: id.nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("block.delete"), blockId: id }).strict(),
  z
    .object({
      kind: z.literal("block.insert"),
      parentId: id.nullable(),
      beforeId: id.nullable(),
      node,
    })
    .strict(),
  z
    .object({
      kind: z.literal("block.replace"),
      blockId: id,
      before: node,
      node,
    })
    .strict(),
  z
    .object({
      kind: z.literal("block.split"),
      blockId: id,
      offset: counter,
      newId: id,
    })
    .strict(),
  z.object({ kind: z.literal("block.join"), leftId: id, rightId: id }).strict(),
  z
    .object({
      kind: z.literal("table.row.insert"),
      tableId: id,
      rowId: id,
      beforeId: id.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("table.column.insert"),
      tableId: id,
      columnId: id,
      beforeId: id.nullable(),
    })
    .strict(),
  z
    .object({ kind: z.literal("table.row.delete"), tableId: id, rowId: id })
    .strict(),
  z
    .object({
      kind: z.literal("table.column.delete"),
      tableId: id,
      columnId: id,
    })
    .strict(),
  z
    .object({
      kind: z.literal("table.row.restore"),
      tableId: id,
      undoOf: id,
      newRowId: id,
      beforeId: id.nullable(),
      sourceRow: node,
      columnIds: z.array(id).max(20),
    })
    .strict(),
  z
    .object({
      kind: z.literal("table.column.restore"),
      tableId: id,
      undoOf: id,
      newColumnId: id,
      beforeId: id.nullable(),
      sourceColumnId: id,
      rows: z.array(z.object({ rowId: id, cell: node }).strict()).max(100),
    })
    .strict(),
] as const;
const richCommands = [
  z.object({kind: z.literal("inline.patch"), blockId: id, sourceHash: z.string().regex(/^[a-f0-9]{64}$/), from: counter, to: counter, content: z.array(node)}).strict(),
  z.object({kind: z.literal("inline.mark"), blockId: id, sourceHash: z.string().regex(/^[a-f0-9]{64}$/), from: counter, to: counter, markType: id, mark: z.object({type: id, attrs: z.record(z.unknown()).optional()}).strict().nullable()}).strict(),
  z.object({kind: z.literal("block.frame"), parentId: id.nullable(), beforeIds: z.array(id).min(1).max(1000), after: z.array(node).min(1).max(1000), retainIds: z.array(id).min(1).max(1000)}).strict(),
  z.object({ kind: z.literal("inline"), blockId: id, before: z.array(node), after: z.array(node) }).strict(),
  z.object({ kind: z.literal("block.format"), blockId: id, beforeType: id, beforeAttrs: z.record(z.unknown()), type: id, attrs: z.record(z.unknown()) }).strict(),
] as const;
const [textCommand, ...structuralCommands] = legacyCommands;
export const editorAtomSchema = z.discriminatedUnion("kind", [...structuralCommands, ...richCommands]);
// Explicit variants keep Zod's discriminator exhaustive without nested batches.
export const commandSchema = z.discriminatedUnion("kind", [
  ...legacyCommands,
  ...richCommands,
  z.object({ kind: z.literal("batch"), commands: z.array(editorAtomSchema).min(1).max(64) }).strict(),
  z.object({kind: z.literal("resource"), action: z.string().regex(/^[a-z][a-z.]{0,63}$/), payload: z.custom<Json>(value => value !== undefined)}).strict(),
]);

const intentSchema = z
  .object({
    v: z.literal(1),
    intentId: id,
    writerId: id,
    scope: scopeSchema,
    base: cutSchema,
    command: commandSchema,
  })
  .strict();
const attemptSchema = z
  .object({
    protocol: z.literal(1004).optional(),
    v: z.literal(1),
    attemptId: id,
    intent: intentSchema,
    base: cutSchema,
  })
  .strict();
export function parseAttempt(input: unknown): Attempt {
  canonical(input, 1_000_000);
  const parsed = attemptSchema.safeParse(input);
  demand(parsed.success, "INVALID_ATTEMPT");
  return parsed.data as Attempt;
}
export function parseScope(input: unknown): Scope {
  canonical(input);
  return scopeSchema.parse(input);
}
export function parseCut(input: unknown): Cut {
  canonical(input);
  return cutSchema.parse(input);
}
/** Our wire is canonical JSON. This detects duplicate keys/precision coercion,
 * including decimal lexemes that do not survive parsing, before accepting it. */
export function parseCanonicalWire(raw: string, maxBytes = 1_000_000): unknown {
  demand(
    typeof raw === "string" && new TextEncoder().encode(raw).length <= maxBytes,
    "WIRE_LIMIT",
  );
  const value: unknown = JSON.parse(raw);
  demand(canonical(value, maxBytes) === raw, "NON_CANONICAL_WIRE");
  return value;
}
