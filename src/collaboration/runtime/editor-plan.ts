import { COLLABORATIVE_TEXTBLOCKS } from "./textblocks";
import { BLOCK_TYPES } from "../../editor/block-identity";
import type { Doc } from "../../shared/types";
import { applyBlock } from "./block-commands";
import { canonical } from "./canonical";
import type {
  BlockCommand,
  DocumentState,
  TableCommand,
} from "./contract";
import { CollaborationError, clone, identifier } from "./contract";
import { derivedId } from "./digest";
import { checkedState, initialState, locate } from "./document";
import { applyTable } from "./table-commands";
import type { BlockFormatCommand } from "./block-format";
import type { RichInlineCommand } from "./rich-inline";
import { applyBlockFrame, type BlockFrameCommand } from "./block-frame";

export type EditorAtom =
  | BlockCommand
  | TableCommand
  | RichInlineCommand
  | BlockFormatCommand
  | BlockFrameCommand;

export type LoweredEditorDocument = {
  commands: EditorAtom[];
  normalizedAfter: Doc;
  idMap: Record<string, string>;
};

const TEXTBLOCK_TYPES = [
  "paragraph",
  "heading",
  "codeBlock",
  "detailsSummary",
];

function fail(code: string): never {
  throw new CollaborationError(code);
}

function isTextblock(node: Doc): boolean {
  return TEXTBLOCK_TYPES.includes(node.type);
}

function isContainer(node: Doc): boolean {
  return (
    BLOCK_TYPES.includes(node.type) &&
    !isTextblock(node) &&
    node.type !== "table"
  );
}

function nodeId(node: Doc): string {
  return identifier(node.attrs?.id);
}

function blockChildren(node: Doc): Doc[] {
  return (node.content ?? []).filter(
    (child) => typeof child.attrs?.id === "string",
  );
}

type BlockEntry = {
  node: Doc;
  parentId: string | null;
  index: number;
};

/** Index of identified structural blocks. Table internals are deliberately
 * opaque here; rows/cells/paragraphs inside a table are handled by table
 * commands and the residual id diff. */
function indexBlocks(root: Doc): Map<string, BlockEntry> {
  const index = new Map<string, BlockEntry>();
  function walk(parent: Doc, parentId: string | null): void {
    const content = parent.content ?? [];
    for (let i = 0; i < content.length; i++) {
      const node = content[i];
      const id = node.attrs?.id;
      if (typeof id !== "string") continue;
      index.set(id, { node, parentId, index: i });
      if (node.type === "table" || isTextblock(node)) continue;
      walk(node, id);
    }
  }
  walk(root, null);
  return index;
}

/** Full id index, including table rows, cells and cell paragraphs. */
function indexAll(root: Doc): Map<string, BlockEntry> {
  const index = new Map<string, BlockEntry>();
  function walk(parent: Doc, parentId: string | null): void {
    const content = parent.content ?? [];
    for (let i = 0; i < content.length; i++) {
      const node = content[i];
      const id = node.attrs?.id;
      if (typeof id !== "string") continue;
      index.set(id, { node, parentId, index: i });
      walk(node, id);
    }
  }
  walk(root, null);
  return index;
}

function collectTables(root: Doc): Doc[] {
  const tables: Doc[] = [];
  function walk(node: Doc): void {
    if (node.type === "table") {
      tables.push(node);
      return;
    }
    for (const child of node.content ?? []) walk(child);
  }
  walk(root);
  return tables;
}

/** Rejects duplicate / malformed block identities. The real schema supplies
 * `attrs.id` on every block node; inline text and hard breaks do not. */
function validateIdentities(root: Doc, code: string): Set<string> {
  const seen = new Set<string>();
  function walk(node: Doc): void {
    const raw = node.attrs?.id;
    if (raw !== undefined && raw !== null) {
      const id = identifier(raw);
      if (seen.has(id)) fail(code);
      seen.add(id);
    } else if (BLOCK_TYPES.includes(node.type)) {
      fail(code);
    }
    for (const child of node.content ?? []) walk(child);
  }
  walk(root);
  return seen;
}

function sameAttrsIgnoringId(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined,
): boolean {
  const a = clone(left ?? {});
  const b = clone(right ?? {});
  delete a.id;
  delete b.id;
  return canonicalEqual(a, b);
}

function canonicalEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function inlineLength(children: readonly Doc[]): number {
  let length = 0;
  for (const child of children) {
    if (child.type === "text") length += (child.text ?? "").length;
    else if (child.type === "hardBreak") length += 1;
  }
  return length;
}

function inlineText(children: readonly Doc[]): string {
  let text = "";
  for (const child of children) {
    if (child.type === "text") text += child.text ?? "";
    else if (child.type === "hardBreak") text += "\n";
  }
  return text;
}

type TableInfo = {
  tableId: string;
  rowIds: string[];
  columnIds: string[];
  /** rowId|columnId -> cell id */
  cellAt: Map<string, string>;
  /** cell id -> column id */
  cellColumns: Map<string, string>;
};

function baseTableInfos(state: DocumentState): Map<string, TableInfo> {
  const metadata = new Map(
    state.tables.map((entry) => [entry.tableId, entry] as const),
  );
  const infos = new Map<string, TableInfo>();
  for (const table of collectTables(state.document)) {
    const tableId = nodeId(table);
    const entry = metadata.get(tableId);
    if (!entry) fail("TABLE_METADATA_MISSING");
    const rows = table.content ?? [];
    if (!rows.length) fail("TABLE_SHAPE");
    if (entry.rowIds.length !== rows.length) fail("TABLE_METADATA_DRIFT");
    const width = rows[0].content?.length ?? 0;
    if (width < 1 || entry.columnIds.length !== width)
      fail("TABLE_METADATA_DRIFT");
    const cellAt = new Map<string, string>();
    const cellColumns = new Map<string, string>();
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      const rowId = nodeId(row);
      if (identifier(entry.rowIds[rowIndex]) !== rowId)
        fail("TABLE_METADATA_DRIFT");
      const cells = row.content ?? [];
      if (cells.length !== width) fail("TABLE_SHAPE");
      for (let columnIndex = 0; columnIndex < cells.length; columnIndex++) {
        const cell = cells[columnIndex];
        const cellId = nodeId(cell);
        const columnId = identifier(entry.columnIds[columnIndex]);
        cellAt.set(rowId + "|" + columnId, cellId);
        cellColumns.set(cellId, columnId);
      }
    }
    infos.set(tableId, {
      tableId,
      rowIds: [...entry.rowIds],
      columnIds: [...entry.columnIds],
      cellAt,
      cellColumns,
    });
  }
  for (const tableId of metadata.keys())
    if (!infos.has(tableId)) fail("TABLE_METADATA_DRIFT");
  return infos;
}

type ColumnSlot =
  | { kind: "existing"; columnId: string; cellId: string }
  | { kind: "new"; columnId: string; cellId: string };

type TablePlan = {
  tableId: string;
  rowDeletes: string[];
  rowInserts: { rowId: string; beforeId: string | null }[];
  columnDeletes: string[];
  columnInserts: { columnId: string; beforeId: string | null }[];
};

function remapNewCell(
  cell: Doc,
  incarnationId: string,
  tableId: string,
  rowId: string,
  columnId: string,
  used: Set<string>,
  idMap: Record<string, string>,
): Doc {
  const content = cell.content ?? [];
  if (content.length !== 1 || content[0].type !== "paragraph")
    fail("UNSUPPORTED_TABLE_CELL_CONTENT");
  const paragraph = content[0];
  const oldCellId = nodeId(cell);
  const oldParagraphId = nodeId(paragraph);
  const cellId = derivedId(
    incarnationId,
    tableId,
    rowId,
    columnId,
    "cell",
  );
  const paragraphId = derivedId(
    incarnationId,
    tableId,
    rowId,
    columnId,
    "paragraph",
  );
  if (used.has(cellId) || used.has(paragraphId)) fail("ID_COLLISION");
  used.add(cellId);
  used.add(paragraphId);
  idMap[oldCellId] = cellId;
  idMap[oldParagraphId] = paragraphId;
  const nextParagraph = clone(paragraph);
  nextParagraph.attrs = { ...(paragraph.attrs ?? {}), id: paragraphId };
  const nextCell = clone(cell);
  nextCell.attrs = { ...(cell.attrs ?? {}), id: cellId };
  nextCell.content = [nextParagraph];
  return nextCell;
}

function normalizeExistingTable(
  table: Doc,
  info: TableInfo,
  incarnationId: string,
  used: Set<string>,
  idMap: Record<string, string>,
): TablePlan {
  const tableId = info.tableId;
  const rows = table.content ?? [];
  if (!rows.length) fail("TABLE_SHAPE");
  const width = rows[0].content?.length ?? 0;
  if (width < 1) fail("TABLE_SHAPE");
  for (const row of rows) {
    if (row.type !== "tableRow" || (row.content?.length ?? 0) !== width)
      fail("TABLE_SHAPE");
    nodeId(row);
    for (const cell of row.content ?? []) nodeId(cell);
  }
  const afterRowIds = rows.map(nodeId);
  const baseRowIds = new Set(info.rowIds);
  const reference = rows.find((row) => baseRowIds.has(nodeId(row)));

  const slots: ColumnSlot[] = [];
  if (reference) {
    const usedColumns = new Set<string>();
    for (const cell of reference.content ?? []) {
      const cellId = nodeId(cell);
      const columnId = info.cellColumns.get(cellId);
      if (columnId && !usedColumns.has(columnId)) {
        usedColumns.add(columnId);
        slots.push({ kind: "existing", columnId, cellId });
      } else {
        slots.push({ kind: "new", columnId: "", cellId });
      }
    }
    const existingSequence = slots
      .filter((slot) => slot.kind === "existing")
      .map((slot) => slot.columnId);
    const targetExisting = new Set(existingSequence);
    const baseSequence = info.columnIds.filter((id) => targetExisting.has(id));
    if (!canonicalEqual(existingSequence, baseSequence))
      fail("TABLE_COLUMN_REORDER");
  } else {
    const first = rows[0];
    for (let index = 0; index < (first.content ?? []).length; index++) {
      const cell = first.content![index];
      const cellId = nodeId(cell);
      if (index < info.columnIds.length) {
        slots.push({
          kind: "existing",
          columnId: info.columnIds[index],
          cellId,
        });
      } else {
        slots.push({ kind: "new", columnId: "", cellId });
      }
    }
  }

  let anchor: string | null = null;
  let ordinal = 0;
  for (const slot of slots) {
    if (slot.kind === "existing") {
      anchor = slot.columnId;
      ordinal = 0;
      continue;
    }
    ordinal += 1;
    const columnId = derivedId(
      incarnationId,
      tableId,
      "column",
      anchor ?? "head",
      String(ordinal),
      slot.cellId,
    );
    if (used.has(columnId)) fail("ID_COLLISION");
    used.add(columnId);
    slot.columnId = columnId;
  }

  const normalizedRows = rows.map((row) => {
    const rowId = nodeId(row);
    const inserted = !baseRowIds.has(rowId);
    const cells = (row.content ?? []).map((cell, columnIndex) => {
      const slot = slots[columnIndex];
      const cellId = nodeId(cell);
      if (!inserted && slot.kind === "existing") {
        const expected = info.cellAt.get(rowId + "|" + slot.columnId);
        if (expected !== cellId) fail("TABLE_CELL_ID_MISMATCH");
        return clone(cell);
      }
      return remapNewCell(
        cell,
        incarnationId,
        tableId,
        rowId,
        slot.columnId,
        used,
        idMap,
      );
    });
    const nextRow = clone(row);
    nextRow.attrs = { ...(row.attrs ?? {}), id: rowId };
    nextRow.content = cells;
    return nextRow;
  });
  table.content = normalizedRows;

  const afterRowSet = new Set(afterRowIds);
  const rowDeletes = info.rowIds.filter((id) => !afterRowSet.has(id));
  const survivingBaseRows = new Set(
    info.rowIds.filter((id) => afterRowSet.has(id)),
  );
  const rowInserts: { rowId: string; beforeId: string | null }[] = [];
  for (let index = 0; index < afterRowIds.length; index++) {
    const rowId = afterRowIds[index];
    if (baseRowIds.has(rowId)) continue;
    let beforeId: string | null = null;
    for (let next = index + 1; next < afterRowIds.length; next++) {
      if (survivingBaseRows.has(afterRowIds[next])) {
        beforeId = afterRowIds[next];
        break;
      }
    }
    rowInserts.push({ rowId, beforeId });
  }

  const afterColumnIds = slots.map((slot) => slot.columnId);
  const afterColumnSet = new Set(afterColumnIds);
  const columnDeletes = info.columnIds.filter((id) => !afterColumnSet.has(id));
  const survivingBaseColumns = new Set(
    info.columnIds.filter((id) => afterColumnSet.has(id)),
  );
  const columnInserts: { columnId: string; beforeId: string | null }[] = [];
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index];
    if (slot.kind !== "new") continue;
    let beforeId: string | null = null;
    for (let next = index + 1; next < slots.length; next++) {
      const candidate = slots[next];
      if (survivingBaseColumns.has(candidate.columnId)) {
        beforeId = candidate.columnId;
        break;
      }
    }
    columnInserts.push({ columnId: slot.columnId, beforeId });
  }

  return {
    tableId,
    rowDeletes,
    rowInserts,
    columnDeletes,
    columnInserts,
  };
}

function normalizeTargetTables(
  target: Doc,
  base: DocumentState,
  incarnationId: string,
): { document: Doc; plans: TablePlan[]; idMap: Record<string, string> } {
  const infos = baseTableInfos(base);
  const document = clone(target);
  const used = new Set<string>();
  for (const id of validateIdentities(base.document, "DUPLICATE_ID"))
    used.add(id);
  for (const id of validateIdentities(document, "DUPLICATE_ID"))
    used.add(id);
  const baseIds = new Set<string>();
  const baseColumns = new Set<string>();
  for (const id of validateIdentities(base.document, "DUPLICATE_ID"))
    baseIds.add(id);
  for (const info of infos.values())
    for (const id of info.columnIds) baseColumns.add(id);
  const tombstones = new Set<string>();
  for (const value of base.tombstones) {
    const id = identifier(value);
    if (tombstones.has(id)) fail("DUPLICATE_TOMBSTONE");
    if (baseIds.has(id) || baseColumns.has(id)) fail("TOMBSTONE_DRIFT");
    tombstones.add(id);
    used.add(id);
  }
  for (const info of infos.values())
    for (const id of info.columnIds) used.add(id);
  const idMap: Record<string, string> = {};
  const plans: TablePlan[] = [];
  for (const table of collectTables(document)) {
    const tableId = nodeId(table);
    const info = infos.get(tableId);
    if (!info) continue;
    plans.push(normalizeExistingTable(table, info, incarnationId, used, idMap));
  }
  return { document, plans, idMap };
}

function planJoins(before: Doc, target: Doc): BlockCommand[] {
  const beforeIndex = indexBlocks(before);
  const targetIndex = indexBlocks(target);
  const targetIds = new Set(targetIndex.keys());
  const commands: BlockCommand[] = [];
  for (const [id, entry] of targetIndex) {
    if (!isTextblock(entry.node)) continue;
    const source = beforeIndex.get(id);
    if (!source || !isTextblock(source.node)) continue;
    if (source.parentId !== entry.parentId) continue;
    const parent =
      source.parentId === null
        ? before
        : beforeIndex.get(source.parentId)?.node;
    if (!parent) continue;
    const siblings = blockChildren(parent);
    const start = siblings.findIndex(
      (candidate) => candidate.attrs?.id === id,
    );
    if (start < 0) continue;
    const run: Doc[] = [];
    let combinedText = inlineText(source.node.content ?? []);
    for (let index = start + 1; index < siblings.length; index++) {
      const sibling = siblings[index];
      const siblingId = nodeId(sibling);
      if (targetIds.has(siblingId)) break;
      if (!isTextblock(sibling)) break;
      if (sibling.type !== source.node.type) break;
      if (!sameAttrsIgnoringId(sibling.attrs, source.node.attrs)) break;
      run.push(sibling);
      combinedText += inlineText(sibling.content ?? []);
    }
    if (!run.length) continue;
    if (combinedText !== inlineText(entry.node.content ?? [])) continue;
    for (const right of run)
      commands.push({
        kind: "block.join",
        leftId: id,
        rightId: nodeId(right),
      });
  }
  return commands;
}

function planSplits(
  before: Doc,
  target: Doc,
  joinLeftIds: ReadonlySet<string>,
): BlockCommand[] {
  const beforeIndex = indexBlocks(before);
  const targetIndex = indexBlocks(target);
  const beforeIds = new Set(beforeIndex.keys());
  const commands: BlockCommand[] = [];
  const parents = new Set<string | null>();
  for (const entry of targetIndex.values()) parents.add(entry.parentId);
  for (const parentId of parents) {
    const parent =
      parentId === null ? target : targetIndex.get(parentId)?.node;
    if (!parent) continue;
    const children = blockChildren(parent);
    for (let index = 0; index < children.length; index++) {
      const left = children[index];
      if (!isTextblock(left)) continue;
      const leftId = nodeId(left);
      if (!beforeIds.has(leftId) || joinLeftIds.has(leftId)) continue;
      const source = beforeIndex.get(leftId)!;
      if (source.parentId !== parentId) continue;
      const run: Doc[] = [];
      for (let next = index + 1; next < children.length; next++) {
        const candidate = children[next];
        const candidateId = nodeId(candidate);
        if (beforeIds.has(candidateId)) break;
        if (!isTextblock(candidate)) break;
        if (candidate.type !== left.type) break;
        if (!sameAttrsIgnoringId(candidate.attrs, left.attrs)) break;
        run.push(candidate);
      }
      if (!run.length) continue;
      let combinedText = inlineText(left.content ?? []);
      for (const piece of run)
        combinedText += inlineText(piece.content ?? []);
      if (combinedText !== inlineText(source.node.content ?? [])) continue;
      let current = left;
      for (const piece of run) {
        commands.push({
          kind: "block.split",
          blockId: nodeId(current),
          offset: inlineLength(current.content ?? []),
          newId: nodeId(piece),
        });
        current = piece;
      }
    }
  }
  return commands;
}

function currentChildren(state: DocumentState, parentId: string | null): Doc[] {
  if (parentId === null) return blockChildren(state.document);
  const parent = locate(state.document, parentId).node;
  return blockChildren(parent);
}

function ensureChild(
  state: DocumentState,
  targetIndex: Map<string, BlockEntry>,
  parentId: string | null,
  childId: string,
  previousId: string | null,
  commands: EditorAtom[],
): void {
  const index = indexBlocks(state.document);
  const children = currentChildren(state, parentId);
  let desired: number;
  if (previousId === null) {
    desired = 0;
  } else {
    const previous = children.findIndex(
      (candidate) => candidate.attrs?.id === previousId,
    );
    if (previous < 0) fail("PLAN_INTERNAL");
    desired = previous + 1;
  }
  const current = children.findIndex(
    (candidate) => candidate.attrs?.id === childId,
  );
  if (current === desired) return;
  const anchorNode = children[desired];
  const anchorId = anchorNode ? nodeId(anchorNode) : null;
  if (anchorId === childId) return;
  const entry = index.get(childId);
  let command: BlockCommand;
  if (entry) {
    command = {
      kind: "block.move",
      blockId: childId,
      parentId,
      beforeId: anchorId,
    };
  } else {
    command = {
      kind: "block.insert",
      parentId,
      beforeId: anchorId,
      node: clone(targetIndex.get(childId)!.node),
    };
  }
  const result = applyBlock(state, command);
  commands.push(command);
  state.document = result.state.document;
  state.tables = result.state.tables;
  state.tombstones = result.state.tombstones;
}

function reconcileStructure(
  state: DocumentState,
  target: Doc,
  commands: EditorAtom[],
): void {
  const targetIndex = indexBlocks(target);
  const visited = new Set<string | null>();
  const queue: (string | null)[] = [null];
  while (queue.length) {
    const parentId = queue.shift()!;
    if (visited.has(parentId)) continue;
    visited.add(parentId);
    const parent =
      parentId === null ? target : targetIndex.get(parentId)?.node;
    if (!parent) continue;
    const children = blockChildren(parent);
    for (let index = 0; index < children.length; index++) {
      const childId = nodeId(children[index]);
      const previousId = index === 0 ? null : nodeId(children[index - 1]);
      ensureChild(state, targetIndex, parentId, childId, previousId, commands);
      const childNode = targetIndex.get(childId)!.node;
      if (isContainer(childNode)) queue.push(childId);
    }
  }

  const targetIds = new Set(targetIndex.keys());
  const currentIndex = indexBlocks(state.document);
  const removed = new Set(
    [...currentIndex.keys()].filter((id) => !targetIds.has(id)),
  );
  const top: string[] = [];
  for (const id of removed) {
    const entry = currentIndex.get(id)!;
    if (entry.parentId === null || !removed.has(entry.parentId)) top.push(id);
  }
  for (const id of top) {
    const command: BlockCommand = { kind: "block.delete", blockId: id };
    const result = applyBlock(state, command);
    commands.push(command);
    state.document = result.state.document;
    state.tables = result.state.tables;
    state.tombstones = result.state.tombstones;
  }
}

function applyTablePlans(
  state: DocumentState,
  plans: readonly TablePlan[],
  incarnationId: string,
  commands: EditorAtom[],
): void {
  for (const plan of plans) {
    const ops: TableCommand[] = [];
    for (const rowId of plan.rowDeletes)
      ops.push({ kind: "table.row.delete", tableId: plan.tableId, rowId });
    for (const columnId of plan.columnDeletes)
      ops.push({
        kind: "table.column.delete",
        tableId: plan.tableId,
        columnId,
      });
    for (const inserted of plan.columnInserts)
      ops.push({
        kind: "table.column.insert",
        tableId: plan.tableId,
        columnId: inserted.columnId,
        beforeId: inserted.beforeId,
      });
    for (const inserted of plan.rowInserts)
      ops.push({
        kind: "table.row.insert",
        tableId: plan.tableId,
        rowId: inserted.rowId,
        beforeId: inserted.beforeId,
      });
    for (const op of ops) {
      const result = applyTable(state, op, incarnationId);
      commands.push(op);
      state.document = result.state.document;
      state.tables = result.state.tables;
      state.tombstones = result.state.tombstones;
    }
  }
}

function applyInlineCommand(
  state: DocumentState,
  command: RichInlineCommand,
): void {
  const node = locate(state.document, command.blockId).node;
  if (command.after.length) node.content = clone(command.after);
  else delete node.content;
}

function applyFormatCommand(
  state: DocumentState,
  command: BlockFormatCommand,
): void {
  const node = locate(state.document, command.blockId).node;
  node.type = command.type;
  node.attrs = clone(command.attrs);
}

function residualCommands(
  state: DocumentState,
  target: Doc,
  commands: EditorAtom[],
): void {
  const targetIndex = indexAll(target);
  const currentIndex = indexAll(state.document);
  for (const [id, entry] of targetIndex) {
    const current = currentIndex.get(id);
    if (!current) continue;
    const typeChanged = current.node.type !== entry.node.type;
    const attrsChanged = !canonicalEqual(
      current.node.attrs ?? {},
      entry.node.attrs ?? {},
    );
    if (typeChanged || attrsChanged) {
      const command: BlockFormatCommand = {
        kind: "block.format",
        blockId: id,
        beforeType: current.node.type,
        beforeAttrs: clone(current.node.attrs ?? {}),
        type: entry.node.type,
        attrs: clone(entry.node.attrs ?? {}),
      };
      applyFormatCommand(state, command);
      commands.push(command);
    }
    if (!isTextblock(entry.node)) continue;
    const before = clone(current.node.content ?? []);
    const after = clone(entry.node.content ?? []);
    if (canonicalEqual(before, after)) continue;
    const command: RichInlineCommand = {
      kind: "inline",
      blockId: id,
      before,
      after,
    };
    applyInlineCommand(state, command);
    commands.push(command);
  }
}

function idsInTree(node: Doc): string[] {
  const ids: string[] = [];
  const stack: Doc[] = [node];
  while (stack.length) {
    const current = stack.pop()!;
    const raw = current.attrs?.id;
    if (typeof raw === "string") ids.push(raw);
    for (const child of current.content ?? []) stack.push(child);
  }
  return ids;
}

function childrenOf(
  root: Doc,
  index: Map<string, BlockEntry>,
  parentId: string | null,
): Doc[] {
  if (parentId === null) return blockChildren(root);
  const parent = index.get(parentId);
  return parent ? blockChildren(parent.node) : [];
}

/** Direct child under `parentId` whose subtree contains `id`, if any. */
function directChildUnder(
  index: Map<string, BlockEntry>,
  id: string,
  parentId: string | null,
): string | null {
  let entry = index.get(id);
  if (!entry) return null;
  while (entry.parentId !== parentId) {
    if (entry.parentId === null) return null;
    const parent = index.get(entry.parentId);
    if (!parent) return null;
    entry = parent;
  }
  return nodeId(entry.node);
}

/** Structural identity only; inline/attrs are reconciled after live retention. */
function frameShape(node: Doc): unknown {
  return {id: node.attrs?.id ?? null, type: node.type,
    children: isTextblock(node) ? [] : (node.content ?? []).map(frameShape)};
}

/**
 * Selects the topmost existing ids that survive from the replaced before-range
 * into the target `after` forest. These become slot placeholders so the frame
 * carries the latest authoritative subtree rather than stale target text.
 */
function frameRetainIds(
  beforeIndex: Map<string, BlockEntry>,
  beforeIds: readonly string[],
  after: readonly Doc[],
): string[] {
  const rangeIds = new Set<string>();
  for (const id of beforeIds) {
    const entry = beforeIndex.get(id);
    if (!entry) continue;
    for (const inner of idsInTree(entry.node)) rangeIds.add(inner);
  }
  const occurrences = new Map<string, number>();
  const order: string[] = [];
  const observe = (nodes: readonly Doc[]): void => {
    for (const node of nodes) {
      const raw = node.attrs?.id;
      if (typeof raw === "string" && rangeIds.has(raw) &&
          (!isContainer(node) || canonical(frameShape(beforeIndex.get(raw)!.node)) === canonical(frameShape(node)))) {
        occurrences.set(raw, (occurrences.get(raw) ?? 0) + 1);
        if (!order.includes(raw)) order.push(raw);
        continue;
      }
      observe(node.content ?? []);
    }
  };
  observe(after);
  const candidates = order.filter((id) => occurrences.get(id) === 1);
  const candidateSet = new Set(candidates);
  const retain: string[] = [];
  for (const id of candidates) {
    const entry = beforeIndex.get(id);
    if (!entry) continue;
    let parentId = entry.parentId;
    let nested = false;
    const seen = new Set<string>();
    while (parentId !== null && !seen.has(parentId)) {
      if (candidateSet.has(parentId)) {
        nested = true;
        break;
      }
      seen.add(parentId);
      const parent = beforeIndex.get(parentId);
      if (!parent) break;
      parentId = parent.parentId;
    }
    if (!nested && !retain.includes(id)) retain.push(id);
  }
  return retain;
}

/**
 * Detects wrapping/unwrapping reframes, where a new container owns ids that
 * already exist, or a removed container leaves existing descendants behind.
 * Emits the minimal frame for each contiguous changed sibling range.
 */
function planFrames(before: Doc, target: Doc): BlockFrameCommand[] {
  const beforeIndex = indexBlocks(before);
  const targetIndex = indexBlocks(target);
  const newContainerIds = new Set<string>();
  for (const [id, entry] of targetIndex)
    if (isContainer(entry.node) && !beforeIndex.has(id))
      newContainerIds.add(id);
  const removedContainerIds = new Set<string>();
  for (const [id, entry] of beforeIndex)
    if (isContainer(entry.node) && !targetIndex.has(id))
      removedContainerIds.add(id);
  const topNew = [...newContainerIds].filter((id) => {
    const parentId = targetIndex.get(id)!.parentId;
    return parentId === null || !newContainerIds.has(parentId);
  });
  const topRemoved = [...removedContainerIds].filter((id) => {
    const parentId = beforeIndex.get(id)!.parentId;
    return parentId === null || !removedContainerIds.has(parentId);
  });

  type Group = { parentId: string | null; map: Map<string, number[]> };
  const groups = new Map<string, Group>();
  const groupFor = (parentId: string | null): Group => {
    const key = parentId === null ? "\u0000root" : parentId;
    const existing = groups.get(key);
    if (existing) return existing;
    const created: Group = { parentId, map: new Map() };
    groups.set(key, created);
    return created;
  };

  for (const wrapperId of topNew) {
    const parentId = targetIndex.get(wrapperId)!.parentId;
    const targetChildren = childrenOf(target, targetIndex, parentId);
    const targetIndexAt = targetChildren.findIndex(
      (candidate) => nodeId(candidate) === wrapperId,
    );
    if (targetIndexAt < 0) continue;
    const sources = new Set<string>();
    for (const id of idsInTree(targetIndex.get(wrapperId)!.node)) {
      if (!beforeIndex.has(id)) continue;
      const direct = directChildUnder(beforeIndex, id, parentId);
      if (direct) sources.add(direct);
    }
    if (!sources.size) continue;
    const group = groupFor(parentId);
    for (const source of sources) {
      const indices = group.map.get(source) ?? [];
      if (!indices.includes(targetIndexAt)) indices.push(targetIndexAt);
      group.map.set(source, indices);
    }
  }

  for (const wrapperId of topRemoved) {
    const parentId = beforeIndex.get(wrapperId)!.parentId;
    const targetChildren = childrenOf(target, targetIndex, parentId);
    const indices: number[] = [];
    for (const id of idsInTree(beforeIndex.get(wrapperId)!.node)) {
      if (!targetIndex.has(id)) continue;
      const direct = directChildUnder(targetIndex, id, parentId);
      if (!direct) continue;
      const at = targetChildren.findIndex(
        (candidate) => nodeId(candidate) === direct,
      );
      if (at >= 0 && !indices.includes(at)) indices.push(at);
    }
    if (!indices.length) continue;
    groupFor(parentId).map.set(wrapperId, indices);
  }

  const commands: BlockFrameCommand[] = [];
  for (const group of groups.values()) {
    const beforeChildren = childrenOf(before, beforeIndex, group.parentId);
    const targetChildren = childrenOf(target, targetIndex, group.parentId);
    let source = [...group.map.keys()].map(id => beforeChildren.findIndex(node => nodeId(node) === id)).filter(at => at >= 0);
    let destination = [...group.map.values()].flat();
    if (!source.length || !destination.length) continue;
    let low = Math.min(...source), high = Math.max(...source);
    let targetLow = Math.min(...destination), targetHigh = Math.max(...destination);
    // Close the span over every surviving subtree, including kept wrapper shells.
    for (let pass = 0; pass < beforeChildren.length + targetChildren.length + 1; pass++) {
      const old = [low, high, targetLow, targetHigh].join(":");
      for (const node of beforeChildren.slice(low, high + 1)) for (const id of idsInTree(node)) {
        const direct = directChildUnder(targetIndex, id, group.parentId);
        const at = targetChildren.findIndex(child => child.attrs?.id === direct);
        if (at >= 0) { targetLow = Math.min(targetLow, at); targetHigh = Math.max(targetHigh, at); }
      }
      for (const node of targetChildren.slice(targetLow, targetHigh + 1)) for (const id of idsInTree(node)) {
        const direct = directChildUnder(beforeIndex, id, group.parentId);
        const at = beforeChildren.findIndex(child => child.attrs?.id === direct);
        if (at >= 0) { low = Math.min(low, at); high = Math.max(high, at); }
      }
      if (old === [low, high, targetLow, targetHigh].join(":")) break;
    }
    const beforeIds = beforeChildren.slice(low, high + 1).map(nodeId);
    const after = clone(targetChildren.slice(targetLow, targetHigh + 1));
    commands.push({kind: "block.frame", parentId: group.parentId, beforeIds, after,
      retainIds: frameRetainIds(beforeIndex, beforeIds, after)});
  }
  return commands;
}

/**
 * Lowers a complete Editor JSON snapshot into atomic collaboration atoms.
 *
 * The plan is replayed against a clone of `before` using the existing
 * applyBlock/applyTable semantics, then residual inline/format changes by id.
 * The caller owns raw-draft preservation; this function never mutates either
 * input and fails closed on shapes it cannot represent.
 */
export function lowerEditorDocument(
  before: DocumentState,
  after: Doc,
  incarnationId: string,
): LoweredEditorDocument {
  const incarnation = identifier(incarnationId);
  const base = checkedState(before);
  const parsedAfter = initialState(after);
  validateIdentities(base.document, "DUPLICATE_ID");
  validateIdentities(parsedAfter.document, "DUPLICATE_ID");

  const normalized = normalizeTargetTables(
    parsedAfter.document,
    base,
    incarnation,
  );
  const target = normalized.document;
  const state: DocumentState = clone(base);
  const commands: EditorAtom[] = [];

  const frames = planFrames(base.document, target);
  for (const command of frames) {
    const currentParent = command.parentId === null ? state.document : indexBlocks(state.document).get(command.parentId)?.node;
    const targetParent = command.parentId === null ? target : indexBlocks(target).get(command.parentId)?.node;
    // An outer frame may already have installed a nested wrapper's topology.
    // Residual text/attrs are still lowered below; do not replay its old span.
    if (currentParent && targetParent && canonical(frameShape(currentParent)) === canonical(frameShape(targetParent))) continue;
    const result = applyBlockFrame(state, command, state, incarnation);
    commands.push(command);
    state.document = result.state.document;
    state.tables = result.state.tables;
    state.tombstones = result.state.tombstones;
  }
  const planBase = state.document;

  const joins = planJoins(planBase, target);
  const joinLeftIds = new Set(
    joins.map((command) =>
      command.kind === "block.join" ? command.leftId : "",
    ),
  );
  for (const command of joins) {
    const result = applyBlock(state, command);
    commands.push(command);
    state.document = result.state.document;
    state.tables = result.state.tables;
    state.tombstones = result.state.tombstones;
  }

  const splits = planSplits(planBase, target, joinLeftIds);
  for (const command of splits) {
    const result = applyBlock(state, command);
    commands.push(command);
    state.document = result.state.document;
    state.tables = result.state.tables;
    state.tombstones = result.state.tombstones;
  }

  reconcileStructure(state, target, commands);
  applyTablePlans(state, normalized.plans, incarnation, commands);
  residualCommands(state, target, commands);

  if (!canonicalEqual(state.document, target))
    fail("EDITOR_PLAN_MISMATCH");

  return {
    commands,
    normalizedAfter: clone(target),
    idMap: { ...normalized.idMap },
  };
}
