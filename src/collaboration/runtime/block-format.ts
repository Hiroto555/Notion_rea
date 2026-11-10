import { BLOCK_TYPES } from "../../editor/block-identity";
import type { Doc } from "../../shared/types";
import { canonical } from "./canonical";
import {
  CollaborationError,
  clone,
  demand,
  identifier,
  type DocumentState,
  type SemanticResult,
} from "./contract";
import { versionDocument } from "../../shared/rich-document";
import { locate, checkedState, materializedState } from "./document";

/**
 * Pure block type/attribute formatting for full Editor lowering. Only the
 * fields the local editor actually changed are CAS'd; unrelated attribute
 * fields keep the latest remote value and children/text/marks are untouched.
 */
export type BlockFormatCommand = {
  kind: "block.format";
  blockId: string;
  beforeType: string;
  beforeAttrs: Record<string, unknown>;
  type: string;
  attrs: Record<string, unknown>;
};

const COMMAND_KEYS = [
  "kind",
  "blockId",
  "beforeType",
  "beforeAttrs",
  "type",
  "attrs",
] as const;
const STRUCTURAL_TYPES = ["table", "tableRow", "tableCell", "tableHeader"];

function fail(code: string): never {
  throw new CollaborationError(code);
}

function strictShape(
  value: unknown,
  allowed: readonly string[],
  code: string,
): asserts value is Record<string, unknown> {
  demand(
    typeof value === "object" && value !== null && !Array.isArray(value),
    code,
  );
  for (const key of Object.getOwnPropertyNames(value))
    demand(allowed.includes(key), code);
}

function record(value: unknown, code: string): Record<string, unknown> {
  demand(
    typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null),
    code,
  );
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    demand(descriptor && "value" in descriptor && descriptor.enumerable, code);
  }
  canonical(value);
  return value as Record<string, unknown>;
}

function isBlockType(value: string): boolean {
  return (BLOCK_TYPES as readonly string[]).includes(value);
}

function structural(value: string): boolean {
  return STRUCTURAL_TYPES.includes(value);
}

function has(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function equal(left: unknown, right: unknown): boolean {
  return canonical(left ?? null) === canonical(right ?? null);
}

export function applyBlockFormat(
  state: DocumentState,
  command: BlockFormatCommand,
  _incarnationId?: string,
): SemanticResult {
  strictShape(command, COMMAND_KEYS, "INVALID_COMMAND");
  demand(command.kind === "block.format", "INVALID_COMMAND");
  const blockId = identifier(command.blockId);
  demand(typeof command.beforeType === "string", "INVALID_COMMAND");
  demand(typeof command.type === "string", "INVALID_COMMAND");
  demand(isBlockType(command.beforeType), "UNSUPPORTED_BLOCK_TYPE");
  demand(isBlockType(command.type), "UNSUPPORTED_BLOCK_TYPE");
  const beforeAttrs = record(command.beforeAttrs, "INVALID_COMMAND");
  const targetAttrs = record(command.attrs, "INVALID_COMMAND");

  if (has(beforeAttrs, "id") && beforeAttrs.id !== blockId)
    fail("INVALID_COMMAND");
  if (has(targetAttrs, "id") && targetAttrs.id !== blockId)
    fail("INVALID_COMMAND");
  if (structural(command.beforeType) || structural(command.type)) {
    const cell = (type: string) => type === "tableCell" || type === "tableHeader";
    demand(command.beforeType === command.type || (cell(command.beforeType) && cell(command.type)), "TABLE_STRUCTURAL");
  }

  const next = clone(state);
  const located = locate(next.document, blockId);
  const node = located.node;
  demand(isBlockType(node.type), "NOT_BLOCK");


  const currentType = node.type;
  const currentAttrs = { ...(node.attrs ?? {}) };
  if (has(currentAttrs, "id") && currentAttrs.id !== blockId)
    fail("NODE_MISSING");

  let resultType = currentType;
  if (command.type !== command.beforeType) {
    if (currentType !== command.beforeType) fail("BLOCK_FORMAT_CONFLICT");
    resultType = command.type;
  }

  const merged = clone(currentAttrs);
  const keys = new Set<string>([
    ...Object.keys(beforeAttrs),
    ...Object.keys(targetAttrs),
  ]);
  for (const key of keys) {
    if (key === "id") continue;
    const hadBefore = has(beforeAttrs, key);
    const hasAfter = has(targetAttrs, key);
    const changed =
      hadBefore !== hasAfter ||
      (hadBefore && !equal(beforeAttrs[key], targetAttrs[key]));
    if (!changed) continue;
    const currentHas = has(currentAttrs, key);
    const matchesBefore =
      currentHas === hadBefore &&
      (!hadBefore || equal(currentAttrs[key], beforeAttrs[key]));
    if (!matchesBefore) fail("BLOCK_FORMAT_CONFLICT");
    if (hasAfter) merged[key] = clone(targetAttrs[key]);
    else delete merged[key];
  }

  const updated: Doc = { ...node, type: resultType };
  if (Object.keys(merged).length) updated.attrs = merged;
  else delete updated.attrs;
  const parentContent = located.parent.content;
  demand(parentContent, "NODE_MISSING");
  parentContent[located.index] = updated;

  next.document = versionDocument(next.document);
  checkedState(next);
  return { state: materializedState(next), appliedText: null };
}
