import { COLLABORATIVE_TEXTBLOCKS } from "./textblocks";
import { inspectSharedDocument } from "../document-input";
import { documentSchema } from "../../shared/editor-schema";
import type { Doc } from "../../shared/types";
import { canonical } from "./canonical";
import {
  CollaborationError,
  clone,
  demand,
  identifier,
  type DocumentState,
} from "./contract";
import { locate, materializedState } from "./document";

/**
 * Rich inline merge for full Editor lowering. The command carries the inline
 * fragment the local editor saw (before) and the fragment it produced (after).
 * The parent separately verifies `before` against the authoritative base; the
 * current state may already contain concurrent edits, so this module merges.
 */
export type RichInlineCommand = {
  kind: "inline";
  blockId: string;
  before: Doc[];
  after: Doc[];
};

export type RichInlineApplied = {
  blockId: string;
  before: Doc[];
  after: Doc[];
};

export type RichInlineResult = {
  state: DocumentState;
  applied: RichInlineApplied;
};

const TEXTBLOCK_TYPES: readonly string[] = COLLABORATIVE_TEXTBLOCKS;
const COMMAND_KEYS = ["kind", "blockId", "before", "after"] as const;

/** Bounded edit distance. Not an n*m table; hard cases fail with raw retention. */
export const EDITOR_DIFF_LIMIT = 2048;

type Mark = { type: string; attrs?: Record<string, unknown> };

type Atom =
  | { kind: "char"; ch: string; marks: Mark[] }
  | { kind: "break"; marks: Mark[] }
  | { kind: "opaque"; node: Doc; key: string; marks: Mark[] };

type Op =
  | { type: "keep"; a: number; b: number }
  | { type: "delete"; a: number }
  | { type: "insert"; b: number };

type Diff = {
  kept: Map<number, number>;
  deleted: Set<number>;
  inserts: Map<number, Atom[]>;
};

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

function markList(node: Doc): Mark[] {
  const marks = node.marks;
  if (marks === undefined) return [];
  demand(Array.isArray(marks), "UNSUPPORTED_MARK");
  const out: Mark[] = [];
  for (const mark of marks) {
    demand(
      mark && typeof mark === "object" && typeof mark.type === "string",
      "UNSUPPORTED_MARK",
    );
    for (const key of Object.getOwnPropertyNames(mark))
      demand(key === "type" || key === "attrs", "UNSUPPORTED_MARK");
    demand(!!documentSchema.marks[mark.type], "UNSUPPORTED_MARK");
    if (mark.attrs !== undefined) {
      demand(
        mark.attrs !== null &&
          typeof mark.attrs === "object" &&
          !Array.isArray(mark.attrs),
        "UNSUPPORTED_MARK",
      );
    }
    out.push(
      mark.attrs === undefined
        ? { type: mark.type }
        : { type: mark.type, attrs: clone(mark.attrs) },
    );
  }
  return out;
}

function validateInline(children: unknown, code: string): Doc[] {
  demand(Array.isArray(children), code);
  for (const node of children) {
    demand(node && typeof node === "object" && !Array.isArray(node), code);
    for (const key of Object.getOwnPropertyNames(node))
      demand(
        ["type", "attrs", "marks", "text", "content"].includes(key),
        "UNSUPPORTED_INLINE",
      );
    demand(typeof (node as Doc).type === "string", code);
    const type = (node as Doc).type;
    const spec = documentSchema.nodes[type];
    demand(!!spec && spec.isInline, "UNSUPPORTED_INLINE");
    if (type === "text")
      demand(
        typeof (node as Doc).text === "string",
        "UNSUPPORTED_INLINE",
      );
    markList(node as Doc);
  }
  canonical(children);
  const proof = inspectSharedDocument(canonical({type: "doc", content: [{type: "paragraph", attrs: {id: "inline-validation"}, ...(children.length ? {content: children} : {})}]}));
  demand(proof.ok, "UNSUPPORTED_INLINE");
  return clone(children as Doc[]);
}

function markKey(marks: Mark[]): string {
  const normalized = marks
    .map((mark) => ({
      type: mark.type,
      attrs: mark.attrs === undefined ? null : mark.attrs,
    }))
    .sort((left, right) => {
      if (left.type !== right.type)
        return left.type < right.type ? -1 : 1;
      const leftAttrs = canonical(left.attrs);
      const rightAttrs = canonical(right.attrs);
      return leftAttrs === rightAttrs ? 0 : leftAttrs < rightAttrs ? -1 : 1;
    });
  return canonical(normalized);
}

function markMap(marks: Mark[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const mark of marks)
    map.set(mark.type, canonical(mark.attrs === undefined ? null : mark.attrs));
  return map;
}

function marksFromMap(map: Map<string, string>): Mark[] {
  const out: Mark[] = [];
  for (const [type, value] of [...map.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (value === "null") out.push({ type });
    else out.push({ type, attrs: JSON.parse(value) as Record<string, unknown> });
  }
  return out;
}

function atomize(children: readonly Doc[]): Atom[] {
  const atoms: Atom[] = [];
  for (const node of children) {
    const spec = documentSchema.nodes[node.type];
    demand(!!spec && spec.isInline, "UNSUPPORTED_INLINE");
    const marks = markList(node);
    if (node.type === "text") {
      const text = node.text;
      demand(typeof text === "string", "UNSUPPORTED_INLINE");
      demand(isWellFormed(text), "UNICODE");
      for (const ch of text) atoms.push({ kind: "char", ch, marks });
      continue;
    }
    if (node.type === "hardBreak") {
      atoms.push({ kind: "break", marks });
      continue;
    }
    const bare: Doc = { ...clone(node) };
    delete bare.marks;
    atoms.push({
      kind: "opaque",
      node: clone(node),
      key: canonical(bare),
      marks,
    });
  }
  return atoms;
}

function isWellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function atomEq(left: Atom, right: Atom): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "char") return left.ch === (right as typeof left).ch;
  if (left.kind === "break") return true;
  return left.key === (right as typeof left).key;
}

/** Trace-bounded Myers. Prefix/suffix trimming keeps ordinary paste cheap. */
function myers(left: Atom[], right: Atom[]): Op[] {
  if (left.length === 0)
    return right.map((_, index) => ({ type: "insert", b: index }));
  if (right.length === 0)
    return left.map((_, index) => ({ type: "delete", a: index }));
  demand(
    left.length + right.length <= 200_000,
    "EDITOR_DIFF_LIMIT",
  );
  const max = left.length + right.length;
  const limit = Math.min(max, EDITOR_DIFF_LIMIT);
  const offset = limit + 1;
  const size = 2 * limit + 3;
  const v = new Int32Array(size).fill(-1);
  v[offset + 1] = 0;
  const trace: Int32Array[] = [];
  for (let distance = 0; distance <= limit; distance++) {
    trace.push(v.slice());
    for (let k = -distance; k <= distance; k += 2) {
      let x: number;
      if (
        k === -distance ||
        (k !== distance &&
          v[offset + k - 1] < v[offset + k + 1])
      )
        x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (
        x < left.length &&
        y < right.length &&
        x >= 0 &&
        y >= 0 &&
        atomEq(left[x], right[y])
      ) {
        x++;
        y++;
      }
      if (x >= 0 && y >= 0) v[offset + k] = x;
      if (x >= left.length && y >= right.length)
        return backtrack(trace, left, right, offset);
    }
  }
  fail("EDITOR_DIFF_LIMIT");
}

function backtrack(
  trace: Int32Array[],
  left: Atom[],
  right: Atom[],
  offset: number,
): Op[] {
  let x = left.length;
  let y = right.length;
  const ops: Op[] = [];
  for (let distance = trace.length - 1; distance >= 1; distance--) {
    const v = trace[distance];
    const k = x - y;
    let previousK: number;
    if (
      k === -distance ||
      (k !== distance && v[offset + k - 1] < v[offset + k + 1])
    )
      previousK = k + 1;
    else previousK = k - 1;
    const previousX = v[offset + previousK];
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      ops.push({ type: "keep", a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (x === previousX) {
      ops.push({ type: "insert", b: y - 1 });
      y--;
    } else {
      ops.push({ type: "delete", a: x - 1 });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ type: "keep", a: x - 1, b: y - 1 });
    x--;
    y--;
  }
  return ops.reverse();
}

function diffAtoms(left: Atom[], right: Atom[]): Diff {
  let start = 0;
  const shortest = Math.min(left.length, right.length);
  while (start < shortest && atomEq(left[start], right[start])) start++;
  let endLeft = left.length;
  let endRight = right.length;
  while (
    endLeft > start &&
    endRight > start &&
    atomEq(left[endLeft - 1], right[endRight - 1])
  ) {
    endLeft--;
    endRight--;
  }
  const middle = myers(
    left.slice(start, endLeft),
    right.slice(start, endRight),
  );
  const ops: Op[] = [];
  for (let index = 0; index < start; index++)
    ops.push({ type: "keep", a: index, b: index });
  for (const op of middle) {
    if (op.type === "keep")
      ops.push({ type: "keep", a: op.a + start, b: op.b + start });
    else if (op.type === "delete") ops.push({ type: "delete", a: op.a + start });
    else ops.push({ type: "insert", b: op.b + start });
  }
  for (let index = 0; index < left.length - endLeft; index++)
    ops.push({
      type: "keep",
      a: endLeft + index,
      b: endRight + index,
    });

  const kept = new Map<number, number>();
  const deleted = new Set<number>();
  const inserts = new Map<number, Atom[]>();
  let beforePos = 0;
  for (const op of ops) {
    if (op.type === "keep") {
      kept.set(op.a, op.b);
      beforePos++;
    } else if (op.type === "delete") {
      deleted.add(op.a);
      beforePos++;
    } else {
      const bucket = inserts.get(beforePos);
      if (bucket) bucket.push(right[op.b]);
      else inserts.set(beforePos, [right[op.b]]);
    }
  }
  return { kept, deleted, inserts };
}

function mergeMarkMaps(
  base: Map<string, string>,
  local: Map<string, string>,
  current: Map<string, string>,
): Map<string, string> {
  const merged = new Map(current);
  const types = new Set<string>([...base.keys(), ...local.keys()]);
  for (const type of types) {
    const baseValue = base.get(type);
    const localValue = local.get(type);
    if (baseValue === localValue) continue;
    const currentValue = current.get(type);
    if (currentValue === baseValue) {
      if (localValue === undefined) merged.delete(type);
      else merged.set(type, localValue);
    } else if (currentValue !== localValue) {
      fail("INLINE_MARK_CONFLICT");
    }
  }
  return merged;
}

function cloneAtom(atom: Atom): Atom {
  if (atom.kind === "opaque")
    return { ...atom, node: clone(atom.node), marks: clone(atom.marks) };
  return { ...atom, marks: clone(atom.marks) };
}

function deleteRanges(deleted: Set<number>): { from: number; to: number }[] {
  const sorted = [...deleted].sort((a, b) => a - b);
  const ranges: { from: number; to: number }[] = [];
  for (const index of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && last.to === index) last.to = index + 1;
    else ranges.push({ from: index, to: index + 1 });
  }
  return ranges;
}

function buildChildren(atoms: readonly Atom[]): Doc[] {
  const children: Doc[] = [];
  let run: { text: string; marks: Mark[] } | null = null;
  const flushRun = () => {
    if (!run) return;
    const marks = marksFromMap(markMap(run.marks));
    children.push(
      marks.length
        ? { type: "text", text: run.text, marks }
        : { type: "text", text: run.text },
    );
    run = null;
  };
  for (const atom of atoms) {
    if (atom.kind === "char") {
      const marks = marksFromMap(markMap(atom.marks));
      const key = markKey(marks);
      if (run && markKey(run.marks) === key) run.text += atom.ch;
      else {
        flushRun();
        run = { text: atom.ch, marks };
      }
      continue;
    }
    flushRun();
    if (atom.kind === "break") {
      const marks = marksFromMap(markMap(atom.marks));
      children.push(
        marks.length ? { type: "hardBreak", marks } : { type: "hardBreak" },
      );
      continue;
    }
    const node = clone(atom.node);
    const marks = marksFromMap(markMap(atom.marks));
    if (marks.length) node.marks = marks;
    else delete node.marks;
    children.push(node);
  }
  flushRun();
  return children;
}

function assertTextblock(node: Doc): void {
  demand(TEXTBLOCK_TYPES.includes(node.type), "NOT_TEXTBLOCK");
}

/** PM width of one atom in the same UTF-16 text units block.split uses. */
function atomUnitSize(atom: Atom): number {
  if (atom.kind === "char") return atom.ch.length;
  if (atom.kind === "break") return 1;
  return documentSchema.nodeFromJSON(atom.node).nodeSize;
}

/** Resolve a code-unit offset to the atom boundary it addresses. */
function baseBoundary(atoms: readonly Atom[], offset: number): number {
  let consumed = 0;
  for (let index = 0; index <= atoms.length; index++) {
    if (consumed === offset) return index;
    if (index === atoms.length) break;
    const size = atomUnitSize(atoms[index]);
    if (offset < consumed + size) {
      if (atoms[index].kind === "char") fail("INLINE_ANCHOR_UNICODE");
      fail("INLINE_ANCHOR_CONFLICT");
    }
    consumed += size;
  }
  fail("INLINE_ANCHOR_INVALID");
}

/**
 * Rebase a block.split text offset through concurrent inline edits using the
 * same bounded atom diff as applyInline. `before` is the fragment the split was
 * computed against; `current` is the authoritative fragment now. Marks-only
 * edits keep the offset. Insertions exactly at the split point follow
 * remote-first: assoc 1 (default) keeps them on the left, assoc -1 on the right.
 * A split boundary strictly inside a remotely deleted run is ambiguous and
 * fails INLINE_ANCHOR_CONFLICT so the caller retains its raw split.
 */
export function mapInlinePosition(
  before: Doc[],
  current: Doc[],
  offset: number,
  assoc: -1 | 1 = 1,
): number {
  demand(Array.isArray(before), "INLINE_ANCHOR_INVALID");
  demand(Array.isArray(current), "INLINE_ANCHOR_INVALID");
  demand(assoc === -1 || assoc === 1, "INLINE_ANCHOR_INVALID");
  demand(
    Number.isSafeInteger(offset) && offset >= 0,
    "INLINE_ANCHOR_INVALID",
  );
  const baseAtoms = atomize(validateInline(before, "INLINE_ANCHOR_INVALID"));
  const currentAtoms = atomize(
    validateInline(current, "INLINE_ANCHOR_INVALID"),
  );
  const boundary = baseBoundary(baseAtoms, offset);
  const remote = diffAtoms(baseAtoms, currentAtoms);

  for (const range of deleteRanges(remote.deleted))
    if (range.from < boundary && boundary < range.to)
      fail("INLINE_ANCHOR_CONFLICT");

  const keptPrefix = new Int32Array(baseAtoms.length + 1);
  for (let index = 0; index < baseAtoms.length; index++)
    keptPrefix[index + 1] =
      keptPrefix[index] + (remote.kept.has(index) ? 1 : 0);

  const insertCounts = new Int32Array(baseAtoms.length + 1);
  for (const [position, atoms] of remote.inserts)
    insertCounts[position] += atoms.length;

  let insertedBefore = 0;
  for (let position = 0; position < boundary; position++)
    insertedBefore += insertCounts[position];
  const atBoundary = assoc === 1 ? insertCounts[boundary] : 0;
  return keptPrefix[boundary] + insertedBefore + atBoundary;
}

export function applyInline(
  state: DocumentState,
  command: RichInlineCommand,
): RichInlineResult {
  strictShape(command, COMMAND_KEYS, "INVALID_COMMAND");
  demand(command.kind === "inline", "INVALID_COMMAND");
  const blockId = identifier(command.blockId);
  demand(Array.isArray(command.before), "INVALID_COMMAND");
  demand(Array.isArray(command.after), "INVALID_COMMAND");
  const beforeFragment = validateInline(command.before, "INVALID_COMMAND");
  const afterFragment = validateInline(command.after, "INVALID_COMMAND");
  const beforeCanonical = canonical(beforeFragment);

  const next = clone(state);
  const located = locate(next.document, blockId);
  const block = located.node;
  assertTextblock(block);
  const currentChildren = block.content ?? [];
  const currentCanonical = canonical(currentChildren);

  let merged: Doc[];
  if (currentCanonical === beforeCanonical) {
    merged = clone(afterFragment);
  } else {
    const baseAtoms = atomize(beforeFragment);
    const localAtoms = atomize(afterFragment);
    const currentAtoms = atomize(currentChildren);
    const localDiff = diffAtoms(baseAtoms, localAtoms);
    const remoteDiff = diffAtoms(baseAtoms, currentAtoms);

    for (const [position] of remoteDiff.inserts)
      for (const range of deleteRanges(localDiff.deleted))
        if (range.from < position && position < range.to)
          fail("INLINE_CONFLICT");

    const output: Atom[] = [];
    const appendInserts = (
      boundary: number,
      map: Map<number, Atom[]>,
    ) => {
      const bucket = map.get(boundary);
      if (bucket) for (const atom of bucket) output.push(cloneAtom(atom));
    };

    for (let index = 0; index <= baseAtoms.length; index++) {
      appendInserts(index, remoteDiff.inserts);
      appendInserts(index, localDiff.inserts);
      if (index === baseAtoms.length) break;
      const currentIndex = remoteDiff.kept.get(index);
      if (currentIndex === undefined) continue;
      if (localDiff.deleted.has(index)) continue;
      const currentAtom = currentAtoms[currentIndex];
      let atom = cloneAtom(currentAtom);
      const localIndex = localDiff.kept.get(index);
      if (localIndex !== undefined) {
        const mergedMarks = mergeMarkMaps(
          markMap(baseAtoms[index].marks),
          markMap(localAtoms[localIndex].marks),
          markMap(currentAtom.marks),
        );
        atom = {
          ...atom,
          marks: marksFromMap(mergedMarks),
        } as Atom;
      }
      output.push(atom);
    }
    merged = buildChildren(output);
  }

  const updated: Doc = { ...block };
  if (merged.length === 0) delete updated.content;
  else updated.content = merged;
  const parentContent = located.parent.content;
  demand(parentContent, "NODE_MISSING");
  parentContent[located.index] = updated;

  const finalState = materializedState(next);
  const finalBlock = locate(finalState.document, blockId).node;
  return {
    state: finalState,
    applied: {
      blockId,
      before: clone(currentChildren),
      after: clone(finalBlock.content ?? []),
    },
  };
}
