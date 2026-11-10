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
import { COLLABORATIVE_TEXTBLOCKS } from "./textblocks";
import { versionDocument } from "../../shared/rich-document";
import { checkedState, materializedState } from "./document";

/**
 * One atomic structural frame: replace exactly one contiguous direct-sibling
 * range (`beforeIds`) under `parentId` with a new wrapper forest (`after`).
 *
 * Any node in `after` whose id appears in `retainIds` is a slot placeholder.
 * At application time it is replaced by the *current* authoritative subtree,
 * so concurrently edited text/marks/children survive the wrapping change.
 * Other ids in `after` must be fresh, except existing non-table container
 * shells inside the source span. Shells retain live type/attrs while their
 * children are reframed. Removed wrappers are tombstoned and never reused.
 */
export type BlockFrameCommand = {
  kind: "block.frame";
  parentId: string | null;
  beforeIds: string[];
  after: Doc[];
  retainIds: string[];
};

const COMMAND_KEYS = [
  "kind",
  "parentId",
  "beforeIds",
  "after",
  "retainIds",
] as const;

const TABLE_INTERNAL_TYPES = ["table", "tableRow", "tableCell", "tableHeader"];

type Entry = { node: Doc; parentId: string | null; index: number };
type RangeEntry = { node: Doc; parentId: string | null; ancestors: string[] };

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

function nodeId(node: Doc): string {
  return identifier(node.attrs?.id);
}

function idsInSubtree(node: Doc): string[] {
  const ids: string[] = [];
  const stack: Doc[] = [node];
  while (stack.length) {
    const current = stack.pop()!;
    const raw = current.attrs?.id;
    if (typeof raw === "string") ids.push(identifier(raw));
    for (const child of current.content ?? []) stack.push(child);
  }
  return ids;
}

function indexAll(root: Doc): Map<string, Entry> {
  const index = new Map<string, Entry>();
  function walk(parent: Doc, parentId: string | null): void {
    const content = parent.content ?? [];
    for (let i = 0; i < content.length; i++) {
      const node = content[i];
      const raw = node.attrs?.id;
      if (typeof raw === "string") {
        const id = identifier(raw);
        if (index.has(id)) fail("DUPLICATE_ID");
        index.set(id, { node, parentId, index: i });
        walk(node, id);
      } else {
        walk(node, parentId);
      }
    }
  }
  walk(root, null);
  return index;
}

/** Index the current source range, requiring unique block ids. */
function indexRange(nodes: readonly Doc[]): Map<string, RangeEntry> {
  const index = new Map<string, RangeEntry>();
  const visit = (node: Doc, parentId: string | null, ancestors: string[]) => {
    const raw = node.attrs?.id;
    if (typeof raw === "string") {
      const id = identifier(raw);
      if (index.has(id)) fail("DUPLICATE_ID");
      index.set(id, { node, parentId, ancestors });
      const next = [...ancestors, id];
      for (const child of node.content ?? []) visit(child, id, next);
      return;
    }
    for (const child of node.content ?? []) visit(child, parentId, ancestors);
  };
  for (const node of nodes) {
    if (typeof node.attrs?.id !== "string") fail("INVALID_BLOCK_NODE");
    visit(node, null, []);
  }
  return index;
}

function isTableNode(node: Doc): boolean {
  return TABLE_INTERNAL_TYPES.includes(node.type);
}

function columnIds(state: DocumentState): Set<string> {
  const ids = new Set<string>();
  for (const table of state.tables) {
    for (const columnId of table.columnIds) {
      if (typeof columnId === "string") ids.add(identifier(columnId));
    }
  }
  return ids;
}

/** Walks the `after` forest, stopping at retained slot placeholders. */
function scanAfter(
  roots: readonly Doc[],
  retain: ReadonlySet<string>,
  onRetain: (id: string) => void,
  onNew: (id: string) => void,
  insideRetain = false,
): void {
  for (const node of roots) {
    demand(
      typeof node === "object" && node !== null && !Array.isArray(node),
      "INVALID_BLOCK_NODE",
    );
    const raw = node.attrs?.id;
    if (typeof raw === "string") {
      const id = identifier(raw);
      if (retain.has(id)) {
        demand(!insideRetain, "FRAME_CONFLICT");
        onRetain(id);
        continue;
      }
      onNew(id);
    }
    scanAfter(node.content ?? [], retain, onRetain, onNew, insideRetain);
  }
}

function buildAfter(
  roots: readonly Doc[],
  retain: ReadonlySet<string>,
  range: ReadonlyMap<string, RangeEntry>,
  shells: ReadonlySet<string>,
): Doc[] {
  return roots.map((node) => {
    const raw = node.attrs?.id;
    if (typeof raw === "string" && retain.has(raw)) {
      const entry = range.get(raw);
      if (!entry) fail("FRAME_CONFLICT");
      return clone(entry.node);
    }
    const copy = clone(node);
    if (typeof raw === "string" && shells.has(raw)) copy.attrs = clone(range.get(raw)!.node.attrs!);
    if (copy.content)
      copy.content = buildAfter(copy.content, retain, range, shells);
    return copy;
  });
}

function withContent(node: Doc, content: Doc[]): Doc {
  if (content.length) {
    node.content = content;
    return node;
  }
  const copy = { ...node };
  delete copy.content;
  return copy;
}

/**
 * Applies one structural frame atomically against the current state, using
 * `basis` (the trusted state the command was authored against) for deletion
 * CAS and remote-child observation.
 */
export function applyBlockFrame(
  state: DocumentState,
  command: BlockFrameCommand,
  basis: DocumentState,
  _incarnationId?: string,
): SemanticResult {
  strictShape(command, COMMAND_KEYS, "INVALID_COMMAND");
  demand(command.kind === "block.frame", "INVALID_COMMAND");
  const parentId =
    command.parentId === null ? null : identifier(command.parentId);
  demand(Array.isArray(command.beforeIds), "INVALID_COMMAND");
  demand(Array.isArray(command.after), "INVALID_COMMAND");
  demand(Array.isArray(command.retainIds), "INVALID_COMMAND");
  demand(command.beforeIds.length > 0, "INVALID_COMMAND");
  demand(command.after.length > 0, "INVALID_COMMAND");

  const beforeIds = command.beforeIds.map(identifier);
  const beforeSet = new Set(beforeIds);
  demand(beforeSet.size === beforeIds.length, "DUPLICATE_ID");
  const retainIds = command.retainIds.map(identifier);
  const retainSet = new Set(retainIds);
  demand(retainSet.size === retainIds.length, "DUPLICATE_ID");

  const next = clone(state);
  const currentIndex = indexAll(next.document);
  const parentNode =
    parentId === null ? next.document : currentIndex.get(parentId)?.node;
  if (!parentNode) fail("FRAME_CONFLICT");
  if (
    parentNode.type === "table" ||
    TABLE_INTERNAL_TYPES.includes(parentNode.type)
  )
    fail("TABLE_INTERNAL");

  const siblings = parentNode.content ?? [];
  const start = siblings.findIndex(
    (candidate) => candidate.attrs?.id === beforeIds[0],
  );
  if (start < 0) fail("FRAME_CONFLICT");
  for (let i = 0; i < beforeIds.length; i++) {
    if (siblings[start + i]?.attrs?.id !== beforeIds[i])
      fail("FRAME_CONFLICT");
  }
  const rangeNodes = siblings.slice(start, start + beforeIds.length);

  const basisIndex = indexAll(basis.document);
  const basisParent =
    parentId === null ? basis.document : basisIndex.get(parentId)?.node;
  if (!basisParent) fail("FRAME_CONFLICT");
  const basisSiblings = basisParent.content ?? [];
  const basisStart = basisSiblings.findIndex(
    (candidate) => candidate.attrs?.id === beforeIds[0],
  );
  if (basisStart < 0) fail("FRAME_CONFLICT");
  for (let i = 0; i < beforeIds.length; i++) {
    if (basisSiblings[basisStart + i]?.attrs?.id !== beforeIds[i])
      fail("FRAME_CONFLICT");
  }

  const range = indexRange(rangeNodes);
  for (const id of retainIds) {
    const entry = range.get(id);
    if (!entry) fail("FRAME_CONFLICT");
    for (const ancestor of entry.ancestors) {
      if (retainSet.has(ancestor)) fail("FRAME_CONFLICT");
    }
  }

  const retainedSubtree = new Set<string>();
  for (const id of retainIds) {
    const entry = range.get(id)!;
    for (const descendant of idsInSubtree(entry.node))
      retainedSubtree.add(descendant);
  }

  const shellIds = new Set<string>();
  function collectShells(nodes: readonly Doc[]): void {
    for (const node of nodes) {
      const id = node.attrs?.id;
      if (typeof id === "string" && retainSet.has(id)) continue;
      if (typeof id === "string" && range.has(id)) {
        const live = range.get(id)!.node, observed = basisIndex.get(id)?.node;
        demand(observed && live.type === node.type && observed.type === live.type &&
          !isTableNode(live) && !COLLABORATIVE_TEXTBLOCKS.includes(live.type as typeof COLLABORATIVE_TEXTBLOCKS[number]) &&
          Array.isArray(live.content), "FRAME_CONFLICT");
        demand(canonical(node.attrs ?? {}) === canonical(observed.attrs ?? {}) ||
          canonical(node.attrs ?? {}) === canonical(live.attrs ?? {}), "FRAME_CONFLICT");
        shellIds.add(id);
      }
      collectShells(node.content ?? []);
    }
  }
  collectShells(command.after);
  const droppedIds: string[] = [];
  for (const id of range.keys())
    if (!retainedSubtree.has(id) && !shellIds.has(id)) droppedIds.push(id);

  const tombstones = new Set<string>();
  for (const raw of next.tombstones) {
    const id = identifier(raw);
    if (tombstones.has(id)) fail("DUPLICATE_TOMBSTONE");
    if (currentIndex.has(id)) fail("TOMBSTONE_DRIFT");
    tombstones.add(id);
  }

  for (const id of droppedIds) {
    const observed = basisIndex.get(id);
    if (!observed) fail("DELETE_CONFLICT");
    const current = range.get(id)!.node;
    if (observed.node.type !== current.type) fail("FRAME_CONFLICT");
    if (
      canonical(observed.node.attrs ?? {}) !==
      canonical(current.attrs ?? {})
    )
      fail("FRAME_CONFLICT");
    if (isTableNode(current)) fail("TABLE_INTERNAL");
  }

  // Compare content only where it will be removed/restructured. Retained slots
  // deliberately hide live descendant edits; shell attrs are carried live.
  function deletionShape(node: Doc): unknown {
    const id = node.attrs?.id;
    if (typeof id === "string" && retainSet.has(id)) return { retained: id };
    const value = clone(node);
    if (typeof id === "string" && shellIds.has(id)) value.attrs = {id};
    const content = value.content;
    delete value.content;
    return {node: value, content: (content ?? []).map(deletionShape)};
  }
  demand(canonical(rangeNodes.map(deletionShape)) === canonical(basisSiblings.slice(basisStart, basisStart + beforeIds.length).map(deletionShape)), "DELETE_CONFLICT");

  const occurrences = new Map<string, number>();
  const newIds: string[] = [];
  scanAfter(
    command.after,
    retainSet,
    (id) => {
      occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
    },
    (id) => {
      newIds.push(id);
    },
  );
  for (const id of retainIds) {
    if ((occurrences.get(id) ?? 0) !== 1) fail("FRAME_CONFLICT");
    if (!range.has(id)) fail("FRAME_CONFLICT");
  }

  const outsideIds = new Set(currentIndex.keys());
  for (const id of range.keys()) outsideIds.delete(id);
  const columns = columnIds(state);
  const used = new Set<string>();
  for (const id of newIds) {
    if (used.has(id)) fail("DUPLICATE_ID");
    used.add(id);
    if (outsideIds.has(id)) fail("DUPLICATE_ID");
    if (range.has(id) && !shellIds.has(id)) fail("TOMBSTONED_ID");
    if (tombstones.has(id)) fail("TOMBSTONED_ID");
    if (columns.has(id)) fail("ID_COLLISION");
  }

  function rejectNewTables(nodes: readonly Doc[]): void {
    for (const node of nodes) {
      const raw = node.attrs?.id;
      if (typeof raw === "string" && retainSet.has(raw)) continue;
      if (isTableNode(node)) fail("TABLE_INTERNAL");
      rejectNewTables(node.content ?? []);
    }
  }
  rejectNewTables(command.after);

  for (const id of droppedIds) {
    if (tombstones.has(id)) fail("TOMBSTONE_DRIFT");
    tombstones.add(id);
    next.tombstones.push(id);
  }

  const rebuilt = buildAfter(command.after, retainSet, range, shellIds);
  const content = parentNode.content ?? [];
  const replacement = [
    ...content.slice(0, start),
    ...rebuilt,
    ...content.slice(start + beforeIds.length),
  ];
  if (parentId === null) {
    next.document = withContent(next.document, replacement);
  } else if (replacement.length) {
    parentNode.content = replacement;
  } else {
    delete parentNode.content;
  }

  const finalIds = indexAll(next.document);
  const finalTombstones = new Set<string>();
  for (const raw of next.tombstones) {
    const id = identifier(raw);
    if (finalTombstones.has(id)) fail("DUPLICATE_TOMBSTONE");
    if (finalIds.has(id)) fail("TOMBSTONE_DRIFT");
    finalTombstones.add(id);
  }

  next.document = versionDocument(next.document);
  checkedState(next);
  return { state: materializedState(next), appliedText: null };
}
