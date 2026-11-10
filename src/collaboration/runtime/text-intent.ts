import type { Doc } from "../../shared/types";
import {
  CollaborationError,
  clone,
  demand,
  identifier,
  wellFormed,
  type AppliedText,
  type DocumentState,
  type SemanticResult,
  type TextCommand,
} from "./contract";
import { checkedState, materializedState, locate } from "./document";

type Piece = { node: Doc; start: number; end: number };
type CheckedAppliedText = {
  blockId: string;
  from: number;
  to: number;
  text: string;
};

const TEXT_COMMAND_KEYS = [
  "kind",
  "blockId",
  "from",
  "to",
  "text",
  "before",
] as const;
const APPLIED_TEXT_KEYS = ["kind", "blockId", "from", "to", "text"] as const;

function strictShape(
  value: unknown,
  allowed: readonly string[],
  code: string,
): void {
  demand(
    typeof value === "object" && value !== null && !Array.isArray(value),
    code,
  );
  for (const key of Object.getOwnPropertyNames(value))
    demand(allowed.includes(key), code);
}

function checkedAppliedText(patch: unknown): CheckedAppliedText {
  strictShape(patch, APPLIED_TEXT_KEYS, "INVALID_HISTORY");
  const value = patch as Record<string, unknown>;
  if (value.kind !== "text") throw new CollaborationError("INVALID_HISTORY");
  const blockId = value.blockId;
  if (typeof blockId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(blockId))
    throw new CollaborationError("INVALID_HISTORY");
  const text = value.text;
  if (typeof text !== "string") throw new CollaborationError("INVALID_HISTORY");
  if (!wellFormed(text)) throw new CollaborationError("UNICODE");
  const from = value.from;
  const to = value.to;
  if (typeof from !== "number" || !Number.isSafeInteger(from) || from < 0)
    throw new CollaborationError("INVALID_HISTORY");
  if (typeof to !== "number" || !Number.isSafeInteger(to) || to < from)
    throw new CollaborationError("INVALID_HISTORY");
  return { blockId, from, to, text };
}

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function boundary(value: string, position: number, code: string): void {
  if (
    !Number.isSafeInteger(position) ||
    position < 0 ||
    position > value.length
  )
    throw new CollaborationError(code);
  if (
    position > 0 &&
    position < value.length &&
    isLow(value.charCodeAt(position)) &&
    isHigh(value.charCodeAt(position - 1))
  )
    throw new CollaborationError("UNICODE_SPLIT");
}

function range(
  value: string,
  from: number,
  to: number,
): { from: number; to: number } {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to < from ||
    to > value.length
  )
    throw new CollaborationError("TEXT_RANGE");
  boundary(value, from, "TEXT_RANGE");
  boundary(value, to, "TEXT_RANGE");
  return { from, to };
}

function textCommand(command: TextCommand): {
  blockId: string;
  current: string;
  from: number;
  to: number;
  text: string;
} {
  strictShape(command, TEXT_COMMAND_KEYS, "INVALID_COMMAND");
  demand(command.kind === "text", "INVALID_COMMAND");
  const blockId = identifier(command.blockId);
  demand(
    typeof command.before === "string" && wellFormed(command.before),
    "UNICODE",
  );
  demand(
    typeof command.text === "string" && wellFormed(command.text),
    "UNICODE",
  );
  const { from, to } = range(command.before, command.from, command.to);
  return { blockId, current: command.before, from, to, text: command.text };
}

function mapAcross(
  patch: { from: number; to: number; text: string },
  from: number,
  to: number,
): { from: number; to: number } {
  if (patch.from < patch.to) {
    if (from === to) {
      if (patch.from < from && from < patch.to)
        throw new CollaborationError("TEXT_CONFLICT");
    } else if (Math.max(patch.from, from) < Math.min(patch.to, to))
      throw new CollaborationError("TEXT_CONFLICT");
    const delta = patch.text.length - (patch.to - patch.from);
    const map = (position: number): number => {
      if (position <= patch.from) return position;
      if (position >= patch.to) return position + delta;
      throw new CollaborationError("TEXT_CONFLICT");
    };
    return { from: map(from), to: map(to) };
  }
  if (from < patch.from && patch.from < to)
    throw new CollaborationError("TEXT_CONFLICT");
  const insertion = patch.from;
  const length = patch.text.length;
  const mapStart = (position: number): number =>
    position < insertion
      ? position
      : position > insertion
        ? position + length
        : insertion + length;
  const mapEnd = (position: number): number =>
    position < insertion
      ? position
      : position > insertion
        ? position + length
        : position;
  if (from === to) {
    const mapped = mapStart(from);
    return { from: mapped, to: mapped };
  }
  return { from: mapStart(from), to: mapEnd(to) };
}

export function rebaseText(
  command: TextCommand,
  intervening: AppliedText[],
): TextCommand {
  demand(Array.isArray(intervening), "INVALID_HISTORY");
  const base = textCommand(command);
  let current = base.current;
  let from = base.from;
  let to = base.to;
  for (const patch of intervening) {
    const parsed = checkedAppliedText(patch);
    if (parsed.blockId !== base.blockId) continue;
    const applied = range(current, parsed.from, parsed.to);
    const mapped = mapAcross(
      { from: applied.from, to: applied.to, text: parsed.text },
      from,
      to,
    );
    current =
      current.slice(0, applied.from) + parsed.text + current.slice(applied.to);
    const checked = range(current, mapped.from, mapped.to);
    from = checked.from;
    to = checked.to;
  }
  return {
    kind: "text",
    blockId: base.blockId,
    from,
    to,
    text: base.text,
    before: current,
  };
}

function inline(block: Doc): { text: string; pieces: Piece[] } {
  const pieces: Piece[] = [];
  let text = "";
  for (const node of block.content ?? []) {
    if (node.type === "text") {
      const value = node.text;
      demand(
        typeof value === "string" && wellFormed(value),
        "UNSUPPORTED_TEXT",
      );
      const start = text.length;
      text += value;
      pieces.push({ node, start, end: text.length });
    } else if (node.type === "hardBreak") {
      const start = text.length;
      text += "\n";
      pieces.push({ node, start, end: text.length });
    } else {
      throw new CollaborationError("UNSUPPORTED_INLINE");
    }
  }
  return { text, pieces };
}

export function applyText(
  state: DocumentState,
  command: TextCommand,
  intervening: AppliedText[],
): SemanticResult {
  const rebased = rebaseText(command, intervening);
  const next = clone(state);
  const located = locate(next.document, rebased.blockId);
  const block = located.node;
  const { text: actual, pieces } = inline(block);
  demand(actual === rebased.before, "TEXT_BASE_MISMATCH");
  const { from, to } = range(actual, rebased.from, rebased.to);
  for (const piece of pieces) {
    if (
      piece.node.type === "hardBreak" &&
      Math.max(from, piece.start) < Math.min(to, piece.end)
    )
      throw new CollaborationError("UNSUPPORTED_HARD_BREAK");
  }
  const left: Doc[] = [];
  const right: Doc[] = [];
  for (const piece of pieces) {
    if (piece.end <= from) {
      left.push(piece.node);
      continue;
    }
    if (piece.start >= to) {
      right.push(piece.node);
      continue;
    }
    if (piece.node.type !== "text")
      throw new CollaborationError("UNSUPPORTED_HARD_BREAK");
    const value = piece.node.text ?? "";
    const keepLeft = Math.min(Math.max(from - piece.start, 0), value.length);
    if (keepLeft > 0)
      left.push({ ...piece.node, text: value.slice(0, keepLeft) });
    const keepRight = Math.max(to - piece.start, 0);
    if (keepRight < value.length)
      right.push({ ...piece.node, text: value.slice(keepRight) });
  }
  const middle: Doc[] = rebased.text.length
    ? [{ type: "text", text: rebased.text }]
    : [];
  const content = [...left, ...middle, ...right];
  const updated: Doc = { ...block };
  if (content.length === 0) delete updated.content;
  else updated.content = content;
  const parentContent = located.parent.content;
  demand(parentContent, "NODE_MISSING");
  parentContent[located.index] = updated;
  return {
    state: materializedState(next),
    appliedText: {
      kind: "text",
      blockId: rebased.blockId,
      from,
      to,
      text: rebased.text,
    },
  };
}
