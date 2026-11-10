import { lowerEditorDocument } from "./editor-plan";
import type { Doc } from "../../shared/types";
import { canonical } from "./canonical";
import {
  CollaborationError,
  clone,
  identifier,
  wellFormed,
  type AppliedText,
  type Command,
  type Cut,
  type DocumentState,
  type Receipt,
  type SemanticResult,
  type TableMetadata,
  type TextCommand,
} from "./contract";
import { locate, type LocatedNode } from "./document";
import { rebaseText } from "./text-intent";
import { strictlyEmpty } from "./table-commands";

type Entry = {
  readonly original: Command;
  readonly before: DocumentState;
  readonly after: DocumentState;
  readonly appliedText: AppliedText | null;
  readonly cut: Cut;
  readonly acceptedIntentId: string | null;
};

type Pending = {
  readonly direction: "undo" | "redo";
  readonly entry: Entry;
  readonly before: DocumentState;
  readonly command: Command;
  readonly appliedText: AppliedText | null;
  readonly base: Cut;
};

const HISTORY_LIMIT = 100;

function fail(code: string): never {
  throw new CollaborationError(code);
}

function locateNode(state: DocumentState, id: string): LocatedNode {
  try {
    return locate(state.document, id);
  } catch (error) {
    if (error instanceof CollaborationError && error.code === "NODE_MISSING")
      fail("HISTORY_CONFLICT");
    throw error;
  }
}

function findNode(state: DocumentState, id: string): Doc | null {
  try {
    return locate(state.document, id).node;
  } catch (error) {
    if (error instanceof CollaborationError && error.code === "NODE_MISSING")
      return null;
    throw error;
  }
}

function parentIdOf(state: DocumentState, located: LocatedNode): string | null {
  if (located.parent === state.document) return null;
  const id = located.parent.attrs?.id;
  if (typeof id !== "string") fail("HISTORY_UNSUPPORTED");
  return identifier(id);
}

function nextSiblingId(located: LocatedNode): string | null {
  const next = located.parent.content?.[located.index + 1];
  if (!next) return null;
  const id = next.attrs?.id;
  if (typeof id !== "string") fail("HISTORY_UNSUPPORTED");
  return identifier(id);
}

function assertAnchor(
  state: DocumentState,
  parentId: string | null,
  beforeId: string | null,
): void {
  const parent =
    parentId === null ? state.document : locateNode(state, parentId).node;
  if (
    beforeId !== null &&
    !(parent.content ?? []).some((node) => node.attrs?.id === beforeId)
  )
    fail("HISTORY_CONFLICT");
}

function documentIds(document: Doc): Set<string> {
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

function usedIds(state: DocumentState): Set<string> {
  const used = documentIds(state.document);
  for (const id of state.tombstones) used.add(identifier(id));
  return used;
}

function remapIds(
  node: Doc,
  shouldRemap: (id: string) => boolean,
  allocateId: () => string,
  used: Set<string>,
): void {
  const id = node.attrs?.id;
  if (typeof id === "string" && shouldRemap(id)) {
    const fresh = identifier(allocateId());
    if (used.has(fresh)) fail("ID_ALLOCATION");
    used.add(fresh);
    node.attrs = { ...(node.attrs ?? {}), id: fresh };
  }
  for (const child of node.content ?? [])
    remapIds(child, shouldRemap, allocateId, used);
}

function allocateFresh(state: DocumentState, allocateId: () => string): string {
  const used = usedIds(state);
  const fresh = identifier(allocateId());
  if (used.has(fresh)) fail("ID_ALLOCATION");
  return fresh;
}

function inlineText(node: Doc): string {
  let text = "";
  for (const child of node.content ?? []) {
    if (child.type === "text") text += child.text ?? "";
    else if (child.type === "hardBreak") text += "\n";
    else fail("HISTORY_CONFLICT");
  }
  return text;
}

function inlineLength(node: Doc): number {
  let length = 0;
  for (const child of node.content ?? []) {
    if (child.type === "text") length += (child.text ?? "").length;
    else if (child.type === "hardBreak") length += 1;
  }
  return length;
}

function blockText(state: DocumentState, blockId: string): string {
  return inlineText(locateNode(state, blockId).node);
}

function table(state: DocumentState, tableId: string): Doc {
  const node = locateNode(state, tableId).node;
  if (node.type !== "table") fail("HISTORY_CONFLICT");
  return node;
}

function tableMetadata(state: DocumentState, tableId: string): TableMetadata {
  const metadata = state.tables.find((value) => value.tableId === tableId);
  if (!metadata) fail("HISTORY_CONFLICT");
  return metadata;
}

function tableRow(tableNode: Doc, rowId: string): Doc {
  const row = (tableNode.content ?? []).find(
    (node) => node.attrs?.id === rowId,
  );
  if (!row) fail("HISTORY_CONFLICT");
  return row;
}

function cellAt(row: Doc, index: number): Doc {
  const cell = row.content?.[index];
  if (!cell) fail("HISTORY_CONFLICT");
  return cell;
}

function textInverse(
  entry: Entry,
  current: DocumentState,
  intervening: AppliedText[],
  command: TextCommand,
): TextCommand {
  const applied = entry.appliedText;
  if (
    !applied ||
    applied.kind !== "text" ||
    applied.blockId !== command.blockId
  )
    fail("HISTORY_UNSUPPORTED");
  if (
    !Number.isSafeInteger(applied.from) ||
    !Number.isSafeInteger(applied.to) ||
    applied.from < 0 ||
    applied.to < applied.from
  )
    fail("HISTORY_CONFLICT");
  const beforeText = blockText(entry.before, command.blockId);
  const afterText = blockText(entry.after, command.blockId);
  const currentText = blockText(current, command.blockId);
  if (command.to > command.before.length) fail("HISTORY_CONFLICT");
  if (
    !wellFormed(applied.text) ||
    !wellFormed(beforeText) ||
    !wellFormed(afterText)
  )
    fail("HISTORY_UNSUPPORTED");
  const removed = command.before.slice(command.from, command.to);
  if (removed.length) {
    const source = locate(entry.before.document, command.blockId).node;
    let offset = 0;
    for (const node of source.content ?? []) {
      const length = node.type === "text" ? (node.text?.length ?? 0) : 0;
      if (
        node.marks?.length &&
        offset < command.to &&
        offset + length > command.from
      )
        fail("HISTORY_UNSUPPORTED");
      offset += length;
    }
  }
  const insertedLength = applied.text.length;
  const from = applied.from;
  const to = from + insertedLength;
  if (to > afterText.length || afterText.slice(from, to) !== applied.text)
    fail("HISTORY_CONFLICT");
  const inverse: TextCommand = {
    kind: "text",
    blockId: command.blockId,
    from,
    to,
    text: removed,
    before: afterText,
  };
  const rebased = rebaseText(inverse, intervening);
  if (rebased.before !== currentText) fail("HISTORY_CONFLICT");
  return rebased;
}

function moveInverse(
  entry: Entry,
  current: DocumentState,
  command: Extract<Command, { kind: "block.move" }>,
): Command {
  const original = locateNode(entry.before, command.blockId);
  const parentId = parentIdOf(entry.before, original);
  const beforeId = nextSiblingId(original);
  locateNode(current, command.blockId);
  assertAnchor(current, parentId, beforeId);
  return {
    kind: "block.move",
    positionBase: clone(entry.cut),
    blockId: command.blockId,
    parentId,
    beforeId,
  };
}

function blockDeleteInverse(
  entry: Entry,
  current: DocumentState,
  allocateId: () => string,
  command: Extract<Command, { kind: "block.delete" }>,
): Command {
  const original = locateNode(entry.before, command.blockId);
  const parentId = parentIdOf(entry.before, original);
  const beforeId = nextSiblingId(original);
  assertAnchor(current, parentId, beforeId);
  const restored = clone(original.node);
  remapIds(restored, () => true, allocateId, usedIds(current));
  return {
    kind: "block.insert",
    parentId,
    beforeId,
    node: restored,
  };
}

function blockInsertInverse(
  entry: Entry,
  current: DocumentState,
  command: Extract<Command, { kind: "block.insert" }>,
): Command {
  const id = command.node.attrs?.id;
  if (typeof id !== "string") fail("HISTORY_UNSUPPORTED");
  const post = locateNode(entry.after, id).node;
  const now = locateNode(current, id).node;
  if (canonical(post) !== canonical(now)) fail("HISTORY_CONFLICT");
  return { kind: "block.delete", blockId: identifier(id) };
}

function blockReplaceInverse(
  entry: Entry,
  current: DocumentState,
  allocateId: () => string,
  command: Extract<Command, { kind: "block.replace" }>,
): Command {
  const before = locateNode(entry.before, command.blockId).node;
  const after = locateNode(entry.after, command.blockId).node;
  const now = locateNode(current, command.blockId).node;
  if (canonical(after) !== canonical(now)) fail("HISTORY_CONFLICT");
  const restored = clone(before);
  restored.attrs = { ...(restored.attrs ?? {}), id: command.blockId };
  const tombstones = new Set(current.tombstones);
  remapIds(
    restored,
    (id) => id !== command.blockId && tombstones.has(id),
    allocateId,
    usedIds(current),
  );
  return {
    kind: "block.replace",
    blockId: command.blockId,
    before: clone(after),
    node: restored,
  };
}

function blockSplitInverse(
  entry: Entry,
  current: DocumentState,
  command: Extract<Command, { kind: "block.split" }>,
): Command {
  const left = locateNode(current, command.blockId);
  const right = locateNode(current, command.newId);
  const postLeft = locateNode(entry.after, command.blockId).node;
  const postRight = locateNode(entry.after, command.newId).node;
  if (
    canonical(left.node) !== canonical(postLeft) ||
    canonical(right.node) !== canonical(postRight)
  )
    fail("HISTORY_CONFLICT");
  if (left.parent !== right.parent || right.index !== left.index + 1)
    fail("HISTORY_CONFLICT");
  return {
    kind: "block.join",
    leftId: command.blockId,
    rightId: command.newId,
  };
}

function blockJoinInverse(
  entry: Entry,
  current: DocumentState,
  allocateId: () => string,
  command: Extract<Command, { kind: "block.join" }>,
): Command {
  const beforeLeft = locateNode(entry.before, command.leftId).node;
  const afterLeft = locateNode(entry.after, command.leftId).node;
  const nowLeft = locateNode(current, command.leftId).node;
  if (canonical(afterLeft) !== canonical(nowLeft)) fail("HISTORY_CONFLICT");
  if (findNode(current, command.rightId)) fail("HISTORY_CONFLICT");
  return {
    kind: "block.split",
    blockId: command.leftId,
    offset: inlineLength(beforeLeft),
    newId: allocateFresh(current, allocateId),
  };
}

/** Undoing a row insertion removes our row while preserving columns that were
 * added afterwards. That is legal only when every original cell is unchanged
 * and each new row/column intersection is strictly empty; otherwise removing
 * the row would discard remote content, so we keep the row and refuse. */
function tableRowInsertInverse(
  entry: Entry,
  current: DocumentState,
  command: Extract<Command, { kind: "table.row.insert" }>,
): Command {
  const postMetadata = tableMetadata(entry.after, command.tableId);
  const nowMetadata = tableMetadata(current, command.tableId);
  if (
    !postMetadata.rowIds.includes(command.rowId) ||
    !nowMetadata.rowIds.includes(command.rowId)
  )
    fail("HISTORY_CONFLICT");
  const postRow = tableRow(table(entry.after, command.tableId), command.rowId);
  const nowRow = tableRow(table(current, command.tableId), command.rowId);
  if (
    (postRow.content?.length ?? -1) !== postMetadata.columnIds.length ||
    (nowRow.content?.length ?? -1) !== nowMetadata.columnIds.length
  )
    fail("HISTORY_CONFLICT");
  for (const columnId of postMetadata.columnIds) {
    const postIndex = postMetadata.columnIds.indexOf(columnId);
    const nowIndex = nowMetadata.columnIds.indexOf(columnId);
    if (nowIndex < 0) fail("HISTORY_CONFLICT");
    if (
      canonical(cellAt(postRow, postIndex)) !==
      canonical(cellAt(nowRow, nowIndex))
    )
      fail("HISTORY_CONFLICT");
  }
  const original = new Set(postMetadata.columnIds);
  for (let index = 0; index < nowMetadata.columnIds.length; index++) {
    if (original.has(nowMetadata.columnIds[index])) continue;
    if (!strictlyEmpty(cellAt(nowRow, index))) fail("HISTORY_CONFLICT");
  }
  return {
    kind: "table.row.delete",
    tableId: command.tableId,
    rowId: command.rowId,
  };
}

/** Symmetric column undo: other rows added later are preserved as long as our
 * original column cells are unchanged and each new row/column intersection is
 * strictly empty. */
function tableColumnInsertInverse(
  entry: Entry,
  current: DocumentState,
  command: Extract<Command, { kind: "table.column.insert" }>,
): Command {
  const postMetadata = tableMetadata(entry.after, command.tableId);
  const nowMetadata = tableMetadata(current, command.tableId);
  const postIndex = postMetadata.columnIds.indexOf(command.columnId);
  const nowIndex = nowMetadata.columnIds.indexOf(command.columnId);
  if (postIndex < 0 || nowIndex < 0) fail("HISTORY_CONFLICT");
  const postRows = table(entry.after, command.tableId).content ?? [];
  const nowRows = table(current, command.tableId).content ?? [];
  if (
    postRows.length !== postMetadata.rowIds.length ||
    nowRows.length !== nowMetadata.rowIds.length
  )
    fail("HISTORY_CONFLICT");
  for (let index = 0; index < postMetadata.rowIds.length; index++) {
    const rowId = postMetadata.rowIds[index];
    const nowRowIndex = nowMetadata.rowIds.indexOf(rowId);
    if (nowRowIndex < 0) fail("HISTORY_CONFLICT");
    const postRow = postRows[index];
    const nowRow = nowRows[nowRowIndex];
    if (postRow.attrs?.id !== rowId || nowRow.attrs?.id !== rowId)
      fail("HISTORY_CONFLICT");
    if (
      (postRow.content?.length ?? -1) !== postMetadata.columnIds.length ||
      (nowRow.content?.length ?? -1) !== nowMetadata.columnIds.length
    )
      fail("HISTORY_CONFLICT");
    if (
      canonical(cellAt(postRow, postIndex)) !==
      canonical(cellAt(nowRow, nowIndex))
    )
      fail("HISTORY_CONFLICT");
  }
  const original = new Set(postMetadata.rowIds);
  for (let index = 0; index < nowMetadata.rowIds.length; index++) {
    const rowId = nowMetadata.rowIds[index];
    if (original.has(rowId)) continue;
    const row = nowRows[index];
    if (row.attrs?.id !== rowId) fail("HISTORY_CONFLICT");
    if (!strictlyEmpty(cellAt(row, nowIndex))) fail("HISTORY_CONFLICT");
  }
  return {
    kind: "table.column.delete",
    tableId: command.tableId,
    columnId: command.columnId,
  };
}

function tableRowDeleteInverse(
  entry: Entry,
  current: DocumentState,
  allocateId: () => string,
  command: Extract<Command, { kind: "table.row.delete" }>,
): Command {
  if (!entry.acceptedIntentId) fail("HISTORY_UNSUPPORTED");
  const metadata = tableMetadata(entry.before, command.tableId);
  const tableNode = table(entry.before, command.tableId);
  const rowId = identifier(command.rowId);
  const index = metadata.rowIds.indexOf(rowId);
  if (index < 0) fail("HISTORY_CONFLICT");
  const sourceRow = tableRow(tableNode, rowId);
  const beforeId =
    index + 1 < metadata.rowIds.length ? metadata.rowIds[index + 1] : null;
  if (beforeId !== null) {
    const nowMetadata = tableMetadata(current, command.tableId);
    if (!nowMetadata.rowIds.includes(beforeId)) fail("HISTORY_CONFLICT");
  }
  return {
    kind: "table.row.restore",
    tableId: command.tableId,
    undoOf: entry.acceptedIntentId,
    newRowId: allocateFresh(current, allocateId),
    beforeId,
    sourceRow: clone(sourceRow),
    columnIds: [...metadata.columnIds],
  };
}

function tableColumnDeleteInverse(
  entry: Entry,
  current: DocumentState,
  allocateId: () => string,
  command: Extract<Command, { kind: "table.column.delete" }>,
): Command {
  if (!entry.acceptedIntentId) fail("HISTORY_UNSUPPORTED");
  const metadata = tableMetadata(entry.before, command.tableId);
  const tableNode = table(entry.before, command.tableId);
  const columnId = identifier(command.columnId);
  const index = metadata.columnIds.indexOf(columnId);
  if (index < 0) fail("HISTORY_CONFLICT");
  const beforeId =
    index + 1 < metadata.columnIds.length
      ? metadata.columnIds[index + 1]
      : null;
  if (beforeId !== null) {
    const nowMetadata = tableMetadata(current, command.tableId);
    if (!nowMetadata.columnIds.includes(beforeId)) fail("HISTORY_CONFLICT");
  }
  const rows = metadata.rowIds.map((rowId) => {
    const row = tableRow(tableNode, rowId);
    const cell = cellAt(row, index);
    return { rowId: identifier(rowId), cell: clone(cell) };
  });
  return {
    kind: "table.column.restore",
    tableId: command.tableId,
    undoOf: entry.acceptedIntentId,
    newColumnId: allocateFresh(current, allocateId),
    beforeId,
    sourceColumnId: columnId,
    rows,
  };
}

function inverseOf(
  entry: Entry,
  current: DocumentState,
  intervening: AppliedText[],
  allocateId: () => string,
  incarnationId: string,
): Command {
  const command = entry.original;
  switch (command.kind) {
    case "inline.patch":
    case "inline.mark":
    case "inline": {
      return {kind: "inline", blockId: command.blockId,
        before: clone(locateNode(entry.after, command.blockId).node.content ?? []),
        after: clone(locateNode(entry.before, command.blockId).node.content ?? [])};
    }
    case "block.format": {
      const before = locateNode(entry.before, command.blockId).node;
      const after = locateNode(entry.after, command.blockId).node;
      return {kind: "block.format", blockId: command.blockId,
        beforeType: after.type, beforeAttrs: clone(after.attrs ?? {}),
        type: before.type, attrs: clone(before.attrs ?? {})};
    }
    case "block.frame":
    case "batch": {
      const target = clone(entry.before.document);
      const afterIds = documentIds(entry.after.document);
      const removedByThisEntry = new Set([...documentIds(target)].filter(id => !afterIds.has(id)));
      const used = usedIds(current);
      remapIds(target, id => removedByThisEntry.has(id), allocateId, used);
      const plan = lowerEditorDocument(entry.after, target, incarnationId);
      if (!plan.commands.length) fail("HISTORY_EMPTY");
      return {kind: "batch", commands: plan.commands};
    }
    case "text":
      return textInverse(entry, current, intervening, command);
    case "block.move":
      return moveInverse(entry, current, command);
    case "block.delete":
      return blockDeleteInverse(entry, current, allocateId, command);
    case "block.insert":
      return blockInsertInverse(entry, current, command);
    case "block.replace":
      return blockReplaceInverse(entry, current, allocateId, command);
    case "block.split":
      return blockSplitInverse(entry, current, command);
    case "block.join":
      return blockJoinInverse(entry, current, allocateId, command);
    case "table.row.insert":
      return tableRowInsertInverse(entry, current, command);
    case "table.column.insert":
      return tableColumnInsertInverse(entry, current, command);
    case "table.row.delete":
      return tableRowDeleteInverse(entry, current, allocateId, command);
    case "table.column.delete":
      return tableColumnDeleteInverse(entry, current, allocateId, command);
    case "table.row.restore":
      return {
        kind: "table.row.delete",
        tableId: identifier(command.tableId),
        rowId: identifier(command.newRowId),
      };
    case "table.column.restore":
      return {
        kind: "table.column.delete",
        tableId: identifier(command.tableId),
        columnId: identifier(command.newColumnId),
      };
    case "resource":
      fail("HISTORY_UNSUPPORTED");
    default:
      fail("HISTORY_UNSUPPORTED");
  }
}

function appliedTextOf(command: Command): AppliedText | null {
  if (command.kind !== "text") return null;
  return {
    kind: "text",
    blockId: command.blockId,
    from: command.from,
    to: command.to,
    text: command.text,
  };
}

function pushBounded(stack: Entry[], entry: Entry): void {
  stack.push(entry);
  if (stack.length > HISTORY_LIMIT) stack.shift();
}

export class LocalHistory {
  constructor(private readonly incarnationId = "history") {}
  private readonly undoStack: Entry[] = [];
  private readonly redoStack: Entry[] = [];
  private pending: Pending | null = null;
  private currentCut: Cut | null = null;

  record(
    before: DocumentState,
    command: Command,
    result: SemanticResult,
    cut: Cut,
    receipt?: Receipt,
  ): void {
    if (this.pending) fail("HISTORY_PENDING");
    if (!command || typeof command !== "object") fail("INVALID_COMMAND");
    if (!result || typeof result !== "object" || !result.state)
      fail("INVALID_RESULT");
    let acceptedIntentId: string | null = null;
    if (receipt !== undefined) {
      if (!receipt || receipt.v !== 1) fail("INVALID_RECEIPT");
      if (receipt.status !== "SERVER_ACCEPTED") fail("HISTORY_NOT_ACCEPTED");
      acceptedIntentId = identifier(receipt.intentId);
    }
    const entry: Entry = {
      original: clone(command),
      before: clone(before),
      after: clone(result.state),
      appliedText: result.appliedText ? clone(result.appliedText) : null,
      cut: clone(cut),
      acceptedIntentId,
    };
    this.currentCut = clone(cut);
    pushBounded(this.undoStack, entry);
    this.redoStack.length = 0;
  }

  undo(
    current: DocumentState,
    intervening: AppliedText[],
    allocateId: () => string,
  ): { command: Command; base: Cut } {
    if (this.pending) fail("HISTORY_PENDING");
    const entry = this.undoStack[this.undoStack.length - 1];
    if (!entry) fail("HISTORY_EMPTY");
    if (typeof allocateId !== "function") fail("INVALID_HISTORY");
    const command = inverseOf(entry, current, intervening, allocateId, this.incarnationId);
    const base = ["inline", "inline.patch", "inline.mark", "block.format", "block.frame", "batch"].includes(entry.original.kind) ? clone(entry.cut) : this.baseCut();
    const pending: Pending = {
      direction: "undo",
      entry,
      before: clone(current),
      command: clone(command),
      appliedText: appliedTextOf(command),
      base,
    };
    this.pending = pending;
    return { command: clone(command), base: clone(base) };
  }

  redo(
    current: DocumentState,
    intervening: AppliedText[],
    allocateId: () => string,
  ): { command: Command; base: Cut } {
    if (this.pending) fail("HISTORY_PENDING");
    const entry = this.redoStack[this.redoStack.length - 1];
    if (!entry) fail("HISTORY_EMPTY");
    if (typeof allocateId !== "function") fail("INVALID_HISTORY");
    const command = inverseOf(entry, current, intervening, allocateId, this.incarnationId);
    const base = ["inline", "inline.patch", "inline.mark", "block.format", "block.frame", "batch"].includes(entry.original.kind) ? clone(entry.cut) : this.baseCut();
    const pending: Pending = {
      direction: "redo",
      entry,
      before: clone(current),
      command: clone(command),
      appliedText: appliedTextOf(command),
      base,
    };
    this.pending = pending;
    return { command: clone(command), base: clone(base) };
  }

  confirm(
    receipt: Receipt,
    after: DocumentState,
    appliedTextOverride?: AppliedText | null,
    beforeOverride?: DocumentState,
  ): void {
    if (!this.pending) fail("HISTORY_NO_PENDING");
    if (!receipt || receipt.v !== 1) fail("INVALID_RECEIPT");
    if (receipt.status !== "SERVER_ACCEPTED") fail("HISTORY_NOT_ACCEPTED");
    const next: Entry = {
      original: clone(this.pending.command),
      before: clone(beforeOverride ?? this.pending.before),
      after: clone(after),
      appliedText:
        appliedTextOverride === undefined
          ? this.pending.appliedText
            ? clone(this.pending.appliedText)
            : null
          : clone(appliedTextOverride),
      cut: clone(receipt.cut),
      acceptedIntentId: identifier(receipt.intentId),
    };
    if (this.pending.direction === "undo") {
      if (this.undoStack[this.undoStack.length - 1] !== this.pending.entry)
        fail("HISTORY_CONFLICT");
      this.undoStack.pop();
      pushBounded(this.redoStack, next);
    } else {
      if (this.redoStack[this.redoStack.length - 1] !== this.pending.entry)
        fail("HISTORY_CONFLICT");
      this.redoStack.pop();
      pushBounded(this.undoStack, next);
    }
    this.currentCut = clone(receipt.cut);
    this.pending = null;
  }

  reject(): void {
    if (!this.pending) fail("HISTORY_NO_PENDING");
    this.pending = null;
  }

  nextCut(direction: "undo" | "redo"): Cut | null {
    const entry = (direction === "undo" ? this.undoStack : this.redoStack).at(
      -1,
    );
    return entry ? clone(entry.cut) : null;
  }
  canUndo(): boolean {
    return this.pending === null && this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.pending === null && this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.pending = null;
    this.currentCut = null;
  }

  private baseCut(): Cut {
    if (this.currentCut) return clone(this.currentCut);
    const top =
      this.undoStack[this.undoStack.length - 1] ??
      this.redoStack[this.redoStack.length - 1];
    if (top) return clone(top.cut);
    fail("HISTORY_NO_BASE");
  }
}
