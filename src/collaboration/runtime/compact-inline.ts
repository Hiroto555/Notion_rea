import { Fragment, type Mark, type Node as PMNode } from "@tiptap/pm/model";
import { documentSchema } from "../../shared/editor-schema";
import type { Doc } from "../../shared/types";
import { inspectSharedDocument } from "../document-input";
import { canonical } from "./canonical";
import { demand, identifier, type DocumentState } from "./contract";
import { locate } from "./document";
import { digest } from "./digest";
import type { RichInlineCommand } from "./rich-inline";
import { COLLABORATIVE_TEXTBLOCKS } from "./textblocks";

type MarkJSON = { type: string; attrs?: Record<string, unknown> };
export type InlinePatchCommand = {
  kind: "inline.patch";
  blockId: string;
  sourceHash: string;
  from: number;
  to: number;
  content: Doc[];
};
export type InlineMarkCommand = {
  kind: "inline.mark";
  blockId: string;
  sourceHash: string;
  from: number;
  to: number;
  markType: string;
  mark: MarkJSON | null;
};

/** Validate before PM parsing: unknown fields must never disappear in a patch. */
function fragment(children: Doc[]): Fragment {
  demand(Array.isArray(children), "INVALID_COMMAND");
  const inspected = inspectSharedDocument(canonical({
    type: "doc", content: [{type: "paragraph", attrs: {id: "inline-patch-validation"}, ...(children.length ? {content: children} : {})}],
  }));
  demand(inspected.ok, "UNSUPPORTED_INLINE");
  const nodes = inspected.document.content?.[0]?.content ?? [];
  return Fragment.fromArray(nodes.map(node => documentSchema.nodeFromJSON(node)));
}
function json(value: Fragment): Doc[] {
  return (value.toJSON() ?? []) as Doc[];
}
function boundary(value: Fragment, offset: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.size) return false;
  let valid = true;
  value.forEach((node, pos) => {
    if (offset <= pos || offset >= pos + node.nodeSize) return;
    if (!node.isText) { valid = false; return; }
    const text = node.text!, at = offset - pos;
    const previous = text.charCodeAt(at - 1), next = text.charCodeAt(at);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) valid = false;
  });
  return valid;
}
function assertRange(value: Fragment, from: number, to: number): void {
  demand(boundary(value, from) && boundary(value, to) && from <= to, "INLINE_PATCH_RANGE");
}
function splice(value: Fragment, from: number, to: number, content: Fragment): Fragment {
  assertRange(value, from, to);
  return value.cut(0, from).append(content).append(value.cut(to));
}
function checkedMark(type: string, value: MarkJSON | null): Mark | null {
  demand(typeof type === "string" && !!documentSchema.marks[type], "UNSUPPORTED_MARK");
  if (value === null) return null;
  demand(value.type === type, "UNSUPPORTED_MARK");
  const validated = fragment([{type: "text", text: "x", marks: [value]}]);
  const mark = validated.firstChild?.marks.find(mark => mark.type.name === type);
  demand(mark, "UNSUPPORTED_MARK");
  return mark;
}
function applyMark(value: Fragment, from: number, to: number, type: string, mark: Mark | null): Fragment {
  assertRange(value, from, to);
  const kind = documentSchema.marks[type];
  demand(kind, "UNSUPPORTED_MARK");
  const nodes: PMNode[] = [];
  value.forEach((node, pos) => {
    const start = Math.max(from, pos), end = Math.min(to, pos + node.nodeSize);
    if (start >= end) { nodes.push(node); return; }
    const lo = start - pos, hi = end - pos;
    if (lo) nodes.push(node.cut(0, lo));
    const middle = lo || hi !== node.nodeSize ? node.cut(lo, hi) : node;
    const without = kind.removeFromSet(middle.marks);
    nodes.push(middle.mark(mark ? mark.addToSet(without) : without));
    if (hi !== node.nodeSize) nodes.push(node.cut(hi));
  });
  return Fragment.fromArray(nodes);
}
function markAt(node: PMNode, type: string): Mark | null {
  return node.marks.find(mark => mark.type.name === type) ?? null;
}
function sameMark(a: Mark | null, b: Mark | null): boolean { return a === b || !!a && !!b && a.eq(b); }

/** Detect one uniform mark operation without allocating one item per character. */
function markDelta(before: Fragment, after: Fragment): {from: number; to: number; type: string; mark: Mark | null} | null {
  const left: PMNode[] = [], right: PMNode[] = [];
  before.forEach(node => left.push(node)); after.forEach(node => right.push(node));
  if (!Fragment.fromArray(left.map(node => node.mark([]))).eq(Fragment.fromArray(right.map(node => node.mark([]))))) return null;
  let i = 0, j = 0, a = 0, b = 0, pos = 0, from = -1, to = -1;
  let changedType: string | null = null, desired: Mark | null = null;
  while (i < left.length && j < right.length) {
    const l = left[i], r = right[j], width = Math.min(l.nodeSize - a, r.nodeSize - b);
    const types = new Set([...l.marks, ...r.marks].map(mark => mark.type.name));
    for (const type of types) {
      const old = markAt(l, type), next = markAt(r, type);
      if (sameMark(old, next)) continue;
      if (changedType !== null && (type !== changedType || !sameMark(desired, next))) return null;
      changedType = type; desired = next;
      if (from < 0) from = pos;
      to = pos + width;
    }
    pos += width; a += width; b += width;
    if (a === l.nodeSize) {i++; a = 0;}
    if (b === r.nodeSize) {j++; b = 0;}
  }
  if (changedType === null || from < 0 || !boundary(before, from) || !boundary(before, to)) return null;
  if (!applyMark(before, from, to, changedType, desired).eq(after)) return null;
  return {from, to, type: changedType, mark: desired};
}

/** A bounded wire delta, anchored to the complete trusted inline source. */
export function compactInline(command: RichInlineCommand): RichInlineCommand | InlinePatchCommand | InlineMarkCommand {
  demand(command.kind === "inline", "INVALID_COMMAND");
  identifier(command.blockId);
  const before = fragment(command.before), after = fragment(command.after);
  const start = before.findDiffStart(after);
  if (start === null) return command;
  const sourceHash = digest(json(before));
  const mark = markDelta(before, after);
  if (mark) return {
    kind: "inline.mark", blockId: command.blockId, sourceHash,
    from: mark.from, to: mark.to, markType: mark.type,
    mark: mark.mark ? mark.mark.toJSON() as MarkJSON : null,
  };
  const end = before.findDiffEnd(after)!;
  let from = start, to = end.a, afterTo = end.b;
  const overlap = from - Math.min(to, afterTo);
  if (overlap > 0) { to += overlap; afterTo += overlap; }
  while (from > 0 && (!boundary(before, from) || !boundary(after, from))) from--;
  while (!boundary(before, to) || !boundary(after, afterTo)) { to++; afterTo++; }
  assertRange(before, from, to); assertRange(after, from, afterTo);
  const replacement = after.cut(from, afterTo);
  demand(splice(before, from, to, replacement).eq(after), "INLINE_PATCH_MISMATCH");
  return {kind: "inline.patch", blockId: command.blockId, sourceHash, from, to, content: json(replacement)};
}

/** Expand only against the rooted base. Current-state merging remains applyInline's job. */
export function expandInlinePatch(basis: DocumentState, command: InlinePatchCommand | InlineMarkCommand): RichInlineCommand {
  demand(command.kind === "inline.patch" || command.kind === "inline.mark", "INVALID_COMMAND");
  const blockId = identifier(command.blockId), block = locate(basis.document, blockId).node;
  demand((COLLABORATIVE_TEXTBLOCKS as readonly string[]).includes(block.type), "NOT_TEXTBLOCK");
  const before = fragment(block.content ?? []);
  demand(typeof command.sourceHash === "string" && /^[a-f0-9]{64}$/.test(command.sourceHash) && digest(json(before)) === command.sourceHash, "EDITOR_SOURCE_MISMATCH");
  const after = command.kind === "inline.patch"
    ? splice(before, command.from, command.to, fragment(command.content))
    : applyMark(before, command.from, command.to, command.markType, checkedMark(command.markType, command.mark));
  // Validate the resulting size/schema as a complete inline fragment as well.
  const validated = fragment(json(after));
  demand(validated.eq(after), "INLINE_PATCH_MISMATCH");
  return {kind: "inline", blockId, before: json(before), after: json(after)};
}
