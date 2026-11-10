import { COLLABORATIVE_TEXTBLOCKS } from "./textblocks";
import { BLOCK_TYPES } from "../../editor/block-identity";
import type { Doc } from "../../shared/types";
import { canonical } from "./canonical";
import {
  CollaborationError,
  clone,
  demand,
  identifier,
  wellFormed,
  type BlockCommand,
  type DocumentState,
  type SemanticResult,
} from "./contract";
import { checkedState, materializedState, locate } from "./document";
import { removeTableMetadata, seedNewTables } from "./table-commands";

const TEXTBLOCK_TYPES: readonly string[] = COLLABORATIVE_TEXTBLOCKS;
const TABLE_INTERNAL_TYPES = ["tableRow", "tableCell", "tableHeader"];

function fail(code: string): never {
  throw new CollaborationError(code);
}

function isBlockType(value: unknown): boolean {
  return typeof value === "string" && BLOCK_TYPES.includes(value);
}

function isTextblock(node: Doc): boolean {
  return TEXTBLOCK_TYPES.includes(node.type);
}

function idsInSubtree(node: Doc): string[] {
  const ids: string[] = [];
  const stack: Doc[] = [node];
  while (stack.length) {
    const current = stack.pop()!;
    const id = current.attrs?.id;
    if (typeof id === "string") ids.push(id);
    for (const child of current.content ?? []) stack.push(child);
  }
  return ids;
}

function existingIds(document: Doc): Set<string> {
  const ids = new Set<string>();
  const stack: Doc[] = [document];
  while (stack.length) {
    const node = stack.pop()!;
    const id = node.attrs?.id;
    if (typeof id === "string") ids.add(id);
    for (const child of node.content ?? []) stack.push(child);
  }
  return ids;
}

function columnIds(state: DocumentState): Set<string> {
  const ids = new Set<string>();
  for (const table of state.tables) {
    for (const columnId of table.columnIds) {
      if (typeof columnId === "string") ids.add(columnId);
    }
  }
  return ids;
}

function tablesInSubtree(node: Doc): Doc[] {
  const found: Doc[] = [];
  const stack: Doc[] = [node];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.type === "table") {
      found.push(current);
      continue;
    }
    for (const child of current.content ?? []) stack.push(child);
  }
  return found;
}

function tableIdsInSubtree(node: Doc): string[] {
  const ids: string[] = [];
  for (const table of tablesInSubtree(node)) {
    const id = table.attrs?.id;
    if (typeof id !== "string") fail("INVALID_BLOCK_NODE");
    ids.push(id);
  }
  return ids;
}

function tableInternalIds(document: Doc): Set<string> {
  const ids = new Set<string>();
  const stack: { node: Doc; insideTable: boolean }[] = [
    { node: document, insideTable: false },
  ];
  while (stack.length) {
    const { node, insideTable } = stack.pop()!;
    for (const child of node.content ?? []) {
      const childInside = insideTable || node.type === "table";
      const id = child.attrs?.id;
      if (childInside && typeof id === "string") ids.add(id);
      stack.push({ node: child, insideTable: childInside });
    }
  }
  return ids;
}

function rejectTableInternal(
  document: Doc,
  id: string | undefined,
  node: Doc,
  targetParent: Doc | null,
): void {
  if (TABLE_INTERNAL_TYPES.includes(node.type)) fail("TABLE_INTERNAL");
  if (id !== undefined && tableInternalIds(document).has(id))
    fail("TABLE_INTERNAL");
  if (
    targetParent &&
    (targetParent.type === "table" ||
      TABLE_INTERNAL_TYPES.includes(targetParent.type))
  )
    fail("TABLE_INTERNAL");
}

function assertNewIds(
  node: Doc,
  document: Doc,
  tombstones: readonly string[],
  columns: Set<string>,
): void {
  const present = existingIds(document);
  const tombstoned = new Set(tombstones);
  const local = new Set<string>();
  for (const id of idsInSubtree(node)) {
    identifier(id);
    if (local.has(id)) fail("DUPLICATE_ID");
    local.add(id);
    if (columns.has(id)) fail("ID_COLLISION");
    if (present.has(id)) fail("DUPLICATE_ID");
    if (tombstoned.has(id)) fail("TOMBSTONED_ID");
  }
}

function withContent(node: Doc, content: Doc[]): Doc {
  if (content.length) return { ...node, content };
  const copy = { ...node };
  delete copy.content;
  return copy;
}

function inlineLength(children: readonly Doc[]): number {
  let length = 0;
  for (const child of children) {
    if (child.type === "text") length += (child.text ?? "").length;
    else if (child.type === "hardBreak") length += 1;
  }
  return length;
}

function splitInline(
  children: readonly Doc[],
  offset: number,
): { left: Doc[]; right: Doc[] } {
  let remaining = offset;
  const left: Doc[] = [];
  const right: Doc[] = [];
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (remaining === 0) {
      right.push(child);
      continue;
    }
    if (child.type === "text") {
      const text = child.text ?? "";
      if (remaining < text.length) {
        const leftText = text.slice(0, remaining);
        const rightText = text.slice(remaining);
        if (!wellFormed(leftText) || !wellFormed(rightText))
          fail("SPLIT_UNICODE");
        left.push({ ...child, text: leftText });
        right.push({ ...child, text: rightText });
        remaining = 0;
        for (let rest = index + 1; rest < children.length; rest++)
          right.push(children[rest]);
        return { left, right };
      }
      left.push(child);
      remaining -= text.length;
      continue;
    }
    if (child.type === "hardBreak") {
      left.push(child);
      remaining -= 1;
      continue;
    }
    left.push(child);
  }
  return { left, right };
}

function childIndexById(parent: Doc, id: string): number {
  const content = parent.content ?? [];
  for (let index = 0; index < content.length; index++)
    if (content[index].attrs?.id === id) return index;
  return -1;
}

function insertAt(parent: Doc, beforeId: string | null, node: Doc): void {
  const content = parent.content ?? [];
  if (beforeId === null) content.push(node);
  else {
    const index = childIndexById(parent, beforeId);
    if (index < 0) fail("INVALID_ANCHOR");
    content.splice(index, 0, node);
  }
  parent.content = content;
}

function removeAt(parent: Doc, index: number): Doc {
  const content = parent.content;
  if (!content || index < 0 || index >= content.length) fail("NODE_MISSING");
  return content.splice(index, 1)[0];
}

function addTombstones(state: DocumentState, ids: readonly string[]): void {
  const known = new Set(state.tombstones);
  for (const id of ids)
    if (!known.has(id)) {
      known.add(id);
      state.tombstones.push(id);
    }
}

function move(
  state: DocumentState,
  command: Extract<BlockCommand, { kind: "block.move" }>,
): void {
  const blockId = identifier(command.blockId);
  const parentId =
    command.parentId === null ? null : identifier(command.parentId);
  const beforeId =
    command.beforeId === null ? null : identifier(command.beforeId);
  const document = state.document;
  const source = locate(document, blockId);
  const targetParent =
    parentId === null ? document : locate(document, parentId).node;
  rejectTableInternal(document, blockId, source.node, targetParent);
  const subtree = new Set(idsInSubtree(source.node));
  if (parentId !== null && subtree.has(parentId)) fail("CYCLE");
  if (beforeId !== null && (subtree.has(beforeId) || beforeId === blockId))
    fail("INVALID_ANCHOR");
  if (parentId === blockId) fail("CYCLE");
  if (beforeId !== null && childIndexById(targetParent, beforeId) < 0)
    fail("INVALID_ANCHOR");
  const node = removeAt(source.parent, source.index);
  insertAt(targetParent, beforeId, node);
}

function deleteBlock(
  state: DocumentState,
  command: Extract<BlockCommand, { kind: "block.delete" }>,
): void {
  const blockId = identifier(command.blockId);
  const document = state.document;
  const located = locate(document, blockId);
  rejectTableInternal(document, blockId, located.node, null);
  const removed = removeAt(located.parent, located.index);
  const removedTableIds = tableIdsInSubtree(removed);
  addTombstones(state, idsInSubtree(removed));
  if (removedTableIds.length) {
    const cleaned = removeTableMetadata(state, removedTableIds);
    state.document = cleaned.document;
    state.tables = cleaned.tables;
    state.tombstones = cleaned.tombstones;
  }
}

function insertBlock(
  state: DocumentState,
  command: Extract<BlockCommand, { kind: "block.insert" }>,
  incarnationId: string,
): void {
  const parentId =
    command.parentId === null ? null : identifier(command.parentId);
  const beforeId =
    command.beforeId === null ? null : identifier(command.beforeId);
  if (!command.node || typeof command.node !== "object")
    fail("INVALID_BLOCK_NODE");
  const node = clone(command.node);
  demand(
    node && typeof node === "object" && isBlockType(node.type),
    "INVALID_BLOCK_NODE",
  );
  const document = state.document;
  const targetParent =
    parentId === null ? document : locate(document, parentId).node;
  const nodeId = node.attrs?.id;
  rejectTableInternal(
    document,
    typeof nodeId === "string" ? nodeId : undefined,
    node,
    targetParent,
  );
  if (beforeId !== null && childIndexById(targetParent, beforeId) < 0)
    fail("INVALID_ANCHOR");
  assertNewIds(node, document, state.tombstones, columnIds(state));
  const introducedTableIds = tableIdsInSubtree(node);
  insertAt(targetParent, beforeId, node);
  if (introducedTableIds.length) {
    const seeded = seedNewTables(state, incarnationId, introducedTableIds);
    state.document = seeded.document;
    state.tables = seeded.tables;
    state.tombstones = seeded.tombstones;
  }
}

function replaceBlock(
  state: DocumentState,
  command: Extract<BlockCommand, { kind: "block.replace" }>,
  incarnationId: string,
): void {
  const blockId = identifier(command.blockId);
  const document = state.document;
  const located = locate(document, blockId);
  rejectTableInternal(document, blockId, located.node, null);
  if (canonical(located.node) !== canonical(command.before))
    fail("STALE_REPLACE");
  if (!command.node || typeof command.node !== "object")
    fail("INVALID_BLOCK_NODE");
  const node = clone(command.node);
  demand(
    node && typeof node === "object" && isBlockType(node.type),
    "INVALID_BLOCK_NODE",
  );
  if (node.attrs?.id !== blockId) fail("REPLACE_ID_MISMATCH");
  const oldTableIds = tableIdsInSubtree(located.node);
  const newTableIds = tableIdsInSubtree(node);
  const oldTableSet = new Set(oldTableIds);
  const newTableSet = new Set(newTableIds);
  const oldTables = new Map<string, Doc>(
    tablesInSubtree(located.node).map(
      (table) => [table.attrs?.id as string, table] as [string, Doc],
    ),
  );
  for (const table of tablesInSubtree(node)) {
    const id = table.attrs?.id as string;
    const before = oldTables.get(id);
    if (before && canonical(before) !== canonical(table))
      fail("TABLE_STRUCTURE");
  }
  const tombstoned = new Set(state.tombstones);
  const columns = columnIds(state);
  const outside = existingIds(document);
  for (const id of idsInSubtree(located.node)) outside.delete(id);
  const local = new Set<string>();
  for (const id of idsInSubtree(node)) {
    identifier(id);
    if (local.has(id)) fail("DUPLICATE_ID");
    local.add(id);
    if (columns.has(id)) fail("ID_COLLISION");
    if (outside.has(id)) fail("DUPLICATE_ID");
    if (tombstoned.has(id)) fail("TOMBSTONED_ID");
  }
  const content = located.parent.content;
  if (!content) fail("NODE_MISSING");
  const retainedIds = new Set(idsInSubtree(node));
  addTombstones(
    state,
    idsInSubtree(located.node).filter((id) => !retainedIds.has(id)),
  );
  content[located.index] = node;
  const removedTableIds = oldTableIds.filter((id) => !newTableSet.has(id));
  if (removedTableIds.length) {
    const cleaned = removeTableMetadata(state, removedTableIds);
    state.document = cleaned.document;
    state.tables = cleaned.tables;
    state.tombstones = cleaned.tombstones;
  }
  const introducedTableIds = newTableIds.filter((id) => !oldTableSet.has(id));
  if (introducedTableIds.length) {
    const seeded = seedNewTables(state, incarnationId, introducedTableIds);
    state.document = seeded.document;
    state.tables = seeded.tables;
    state.tombstones = seeded.tombstones;
  }
}

function splitBlock(
  state: DocumentState,
  command: Extract<BlockCommand, { kind: "block.split" }>,
): void {
  const blockId = identifier(command.blockId);
  const newId = identifier(command.newId);
  const document = state.document;
  const located = locate(document, blockId);
  rejectTableInternal(document, blockId, located.node, located.parent);
  if (!isTextblock(located.node)) fail("NOT_TEXTBLOCK");
  if (!Number.isSafeInteger(command.offset) || command.offset < 0)
    fail("INVALID_OFFSET");
  const children = located.node.content ?? [];
  const length = inlineLength(children);
  if (command.offset > length) fail("INVALID_OFFSET");
  const present = existingIds(document);
  const columns = columnIds(state);
  if (columns.has(newId)) fail("ID_COLLISION");
  if (present.has(newId)) fail("DUPLICATE_ID");
  if (state.tombstones.includes(newId)) fail("TOMBSTONED_ID");
  const { left, right } = splitInline(children, command.offset);
  const leftNode = withContent(located.node, left);
  const rightNode = withContent(
    { ...located.node, attrs: { ...(located.node.attrs ?? {}), id: newId } },
    right,
  );
  const content = located.parent.content;
  if (!content) fail("NODE_MISSING");
  content[located.index] = leftNode;
  content.splice(located.index + 1, 0, rightNode);
}

function joinBlocks(
  state: DocumentState,
  command: Extract<BlockCommand, { kind: "block.join" }>,
): void {
  const leftId = identifier(command.leftId);
  const rightId = identifier(command.rightId);
  const document = state.document;
  const left = locate(document, leftId);
  const right = locate(document, rightId);
  rejectTableInternal(document, leftId, left.node, left.parent);
  rejectTableInternal(document, rightId, right.node, right.parent);
  if (!isTextblock(left.node) || !isTextblock(right.node))
    fail("NOT_TEXTBLOCK");
  if (left.parent !== right.parent || right.index !== left.index + 1)
    fail("NOT_ADJACENT");
  if (left.node.type !== right.node.type) fail("INCOMPATIBLE_JOIN");
  const leftAttrs = { ...(left.node.attrs ?? {}) };
  const rightAttrs = { ...(right.node.attrs ?? {}) };
  delete leftAttrs.id;
  delete rightAttrs.id;
  if (canonical(leftAttrs) !== canonical(rightAttrs)) fail("INCOMPATIBLE_JOIN");
  const combined = [
    ...(left.node.content ?? []),
    ...(right.node.content ?? []),
  ];
  const content = left.parent.content;
  if (!content) fail("NODE_MISSING");
  content[left.index] = withContent(left.node, combined);
  const removed = removeAt(left.parent, right.index);
  addTombstones(state, idsInSubtree(removed));
}

/** Applies one block command to a clone and validates the result before publishing.
 * The optional incarnation scopes deterministic column IDs for newly introduced
 * tables. Production callers must pass the scope incarnation; the default only
 * keeps direct unit tests concise. */
export function applyBlock(
  state: DocumentState,
  command: BlockCommand,
  incarnationId: string = "direct",
): SemanticResult {
  const next = clone(state);
  if (!command || typeof command !== "object")
    fail("UNSUPPORTED_BLOCK_COMMAND");
  switch (command.kind) {
    case "block.move":
      move(next, command);
      break;
    case "block.delete":
      deleteBlock(next, command);
      break;
    case "block.insert":
      insertBlock(next, command, incarnationId);
      break;
    case "block.replace":
      replaceBlock(next, command, incarnationId);
      break;
    case "block.split":
      splitBlock(next, command);
      break;
    case "block.join":
      joinBlocks(next, command);
      break;
    default:
      fail("UNSUPPORTED_BLOCK_COMMAND");
  }
  return { state: materializedState(next), appliedText: null };
}
