import {
  CollaborationError,
  clone,
  identifier,
  type DocumentState,
  type SemanticResult,
  type TableCommand,
  type TableMetadata,
} from "./contract";
import { derivedId } from "./digest";
import { checkedState } from "./document";
import { MAX_TABLE_COLUMNS, MAX_TABLE_ROWS } from "../../shared/rich-document";
import type { Doc } from "../../shared/types";

type Layout = {
  table: Doc;
  rows: Doc[];
  rowIds: string[];
  columnIds: string[];
  metadataIndex: number;
};

type Prepared = {
  state: DocumentState;
  layouts: Map<string, Layout>;
  docIds: Set<string>;
  columnIds: Set<string>;
  tombstones: Set<string>;
};

function fail(code: string): never {
  throw new CollaborationError(code);
}

function requireId(value: unknown): string {
  return identifier(value);
}

function nodeId(node: Doc): string {
  return requireId(node.attrs?.id);
}

function findTables(node: Doc): Doc[] {
  const found: Doc[] = [];
  function walk(current: Doc): void {
    if (current.type === "table") {
      found.push(current);
      return;
    }
    for (const child of current.content ?? []) walk(child);
  }
  walk(node);
  return found;
}

function checkedCell(cell: Doc): void {
  if (cell.type !== "tableCell" && cell.type !== "tableHeader")
    fail("TABLE_SHAPE");
  nodeId(cell);
  if (!Array.isArray(cell.content) || cell.content.length < 1)
    fail("TABLE_SHAPE");
  for (const child of cell.content) {
    if (child.type !== "paragraph") fail("TABLE_SHAPE");
    nodeId(child);
  }
}

function checkedRow(row: Doc, width: number | null): Doc[] {
  if (row.type !== "tableRow" || !Array.isArray(row.content))
    fail("TABLE_SHAPE");
  if (width !== null && row.content.length !== width) fail("TABLE_SHAPE");
  if (row.content.length < 1) fail("TABLE_SHAPE");
  if (row.content.length > MAX_TABLE_COLUMNS) fail("TABLE_COLUMN_LIMIT");
  nodeId(row);
  for (const cell of row.content) checkedCell(cell);
  return row.content;
}

function tableRows(table: Doc): Doc[] {
  if (!Array.isArray(table.content) || table.content.length < 1)
    fail("TABLE_SHAPE");
  if (table.content.length > MAX_TABLE_ROWS) fail("TABLE_ROW_LIMIT");
  const width = table.content[0].content?.length ?? 0;
  if (width < 1) fail("TABLE_SHAPE");
  if (width > MAX_TABLE_COLUMNS) fail("TABLE_COLUMN_LIMIT");
  for (const row of table.content) checkedRow(row, width);
  return table.content;
}

function collectDocumentIds(document: Doc): Set<string> {
  const ids = new Set<string>();
  function walk(node: Doc): void {
    if (node.attrs?.id !== undefined && node.attrs?.id !== null) {
      const id = nodeId(node);
      if (ids.has(id)) fail("DUPLICATE_ID");
      ids.add(id);
    }
    for (const child of node.content ?? []) walk(child);
  }
  walk(document);
  return ids;
}

function collectSubtreeIds(node: Doc): string[] {
  const ids: string[] = [];
  function walk(current: Doc): void {
    if (current.attrs?.id !== undefined && current.attrs?.id !== null)
      ids.push(nodeId(current));
    for (const child of current.content ?? []) walk(child);
  }
  walk(node);
  return ids;
}

function readTombstones(
  values: string[],
  live: Set<string>,
  columns: Set<string>,
): Set<string> {
  if (!Array.isArray(values)) fail("TOMBSTONE_DRIFT");
  const tombstones = new Set<string>();
  for (const value of values) {
    const id = requireId(value);
    if (tombstones.has(id)) fail("DUPLICATE_TOMBSTONE");
    if (live.has(id) || columns.has(id)) fail("TOMBSTONE_DRIFT");
    tombstones.add(id);
  }
  return tombstones;
}

function prepare(state: DocumentState): Prepared {
  const base = checkedState(state);
  if (!Array.isArray(base.tables) || !Array.isArray(base.tombstones))
    fail("TABLE_METADATA_DRIFT");
  const docIds = collectDocumentIds(base.document);
  const docTables = findTables(base.document);
  const metadata = new Map<string, { value: TableMetadata; index: number }>();
  for (let index = 0; index < base.tables.length; index++) {
    const value = base.tables[index];
    if (
      !value ||
      typeof value !== "object" ||
      !Array.isArray(value.rowIds) ||
      !Array.isArray(value.columnIds)
    )
      fail("TABLE_METADATA_DRIFT");
    const tableId = requireId(value.tableId);
    if (metadata.has(tableId)) fail("DUPLICATE_TABLE_METADATA");
    metadata.set(tableId, { value, index });
  }
  if (docTables.length !== base.tables.length) fail("TABLE_METADATA_DRIFT");
  const layouts = new Map<string, Layout>();
  const columnIds = new Set<string>();
  for (const table of docTables) {
    const tableId = nodeId(table);
    const entry = metadata.get(tableId);
    if (!entry) fail("TABLE_METADATA_MISSING");
    const rows = tableRows(table);
    const rowIds = rows.map((row) => nodeId(row));
    if (entry.value.rowIds.length !== rowIds.length)
      fail("TABLE_METADATA_DRIFT");
    for (let index = 0; index < rowIds.length; index++) {
      if (requireId(entry.value.rowIds[index]) !== rowIds[index])
        fail("TABLE_METADATA_DRIFT");
    }
    const width = rows[0].content?.length ?? 0;
    if (entry.value.columnIds.length !== width) fail("TABLE_METADATA_DRIFT");
    for (const value of entry.value.columnIds) {
      const columnId = requireId(value);
      if (columnIds.has(columnId) || docIds.has(columnId)) fail("ID_COLLISION");
      columnIds.add(columnId);
    }
    layouts.set(tableId, {
      table,
      rows,
      rowIds: [...rowIds],
      columnIds: [...entry.value.columnIds],
      metadataIndex: entry.index,
    });
  }
  if (layouts.size !== base.tables.length) fail("TABLE_METADATA_DRIFT");
  const tombstones = readTombstones(base.tombstones, docIds, columnIds);
  return { state: base, layouts, docIds, columnIds, tombstones };
}

function withMetadata(
  prepared: Prepared,
  tableId: string,
  rowIds: string[],
  columnIds: string[],
  tombstones: string[],
): DocumentState {
  const layout = prepared.layouts.get(tableId);
  if (!layout) fail("TABLE_MISSING");
  const tables = prepared.state.tables.map((value, index) =>
    index === layout.metadataIndex ? { tableId, rowIds, columnIds } : value,
  );
  return {
    document: prepared.state.document,
    tables,
    tombstones,
  };
}

function newCell(
  incarnationId: string,
  tableId: string,
  rowId: string,
  columnId: string,
  type: "tableCell" | "tableHeader",
): Doc {
  const cellId = derivedId(incarnationId, tableId, rowId, columnId, "cell");
  const paragraphId = derivedId(
    incarnationId,
    tableId,
    rowId,
    columnId,
    "paragraph",
  );
  return {
    type,
    attrs: { id: cellId },
    content: [{ type: "paragraph", attrs: { id: paragraphId } }],
  };
}

function insertRow(
  prepared: Prepared,
  command: Extract<TableCommand, { kind: "table.row.insert" }>,
  incarnationId: string,
): DocumentState {
  const tableId = requireId(command.tableId);
  const rowId = requireId(command.rowId);
  const beforeId =
    command.beforeId === null ? null : requireId(command.beforeId);
  const layout = prepared.layouts.get(tableId);
  if (!layout) fail("TABLE_MISSING");
  if (layout.rowIds.length >= MAX_TABLE_ROWS) fail("TABLE_ROW_LIMIT");
  const index =
    beforeId === null ? layout.rowIds.length : layout.rowIds.indexOf(beforeId);
  if (index < 0) fail("ROW_MISSING");
  const used = new Set<string>([
    ...prepared.docIds,
    ...prepared.columnIds,
    ...prepared.tombstones,
  ]);
  if (used.has(rowId)) fail("ID_COLLISION");
  used.add(rowId);
  const cells: Doc[] = [];
  for (const columnId of layout.columnIds) {
    const cell = newCell(incarnationId, tableId, rowId, columnId, "tableCell");
    for (const id of collectSubtreeIds(cell)) {
      if (used.has(id)) fail("ID_COLLISION");
      used.add(id);
    }
    cells.push(cell);
  }
  const row: Doc = {
    type: "tableRow",
    attrs: { id: rowId },
    content: cells,
  };
  layout.table.content!.splice(index, 0, row);
  const rowIds = [
    ...layout.rowIds.slice(0, index),
    rowId,
    ...layout.rowIds.slice(index),
  ];
  return withMetadata(
    prepared,
    tableId,
    rowIds,
    [...layout.columnIds],
    [...prepared.state.tombstones],
  );
}

function insertColumn(
  prepared: Prepared,
  command: Extract<TableCommand, { kind: "table.column.insert" }>,
  incarnationId: string,
): DocumentState {
  const tableId = requireId(command.tableId);
  const columnId = requireId(command.columnId);
  const beforeId =
    command.beforeId === null ? null : requireId(command.beforeId);
  const layout = prepared.layouts.get(tableId);
  if (!layout) fail("TABLE_MISSING");
  if (layout.columnIds.length >= MAX_TABLE_COLUMNS) fail("TABLE_COLUMN_LIMIT");
  const index =
    beforeId === null
      ? layout.columnIds.length
      : layout.columnIds.indexOf(beforeId);
  if (index < 0) fail("COLUMN_MISSING");
  const used = new Set<string>([
    ...prepared.docIds,
    ...prepared.columnIds,
    ...prepared.tombstones,
  ]);
  if (used.has(columnId)) fail("ID_COLLISION");
  used.add(columnId);
  for (let rowIndex = 0; rowIndex < layout.rows.length; rowIndex++) {
    const row = layout.rows[rowIndex];
    const rowId = layout.rowIds[rowIndex];
    const type =
      row.content?.[0]?.type === "tableHeader" ? "tableHeader" : "tableCell";
    const cell = newCell(incarnationId, tableId, rowId, columnId, type);
    for (const id of collectSubtreeIds(cell)) {
      if (used.has(id)) fail("ID_COLLISION");
      used.add(id);
    }
    row.content!.splice(index, 0, cell);
  }
  const columnIds = [
    ...layout.columnIds.slice(0, index),
    columnId,
    ...layout.columnIds.slice(index),
  ];
  return withMetadata(prepared, tableId, [...layout.rowIds], columnIds, [
    ...prepared.state.tombstones,
  ]);
}

function deleteRow(
  prepared: Prepared,
  command: Extract<TableCommand, { kind: "table.row.delete" }>,
): DocumentState {
  const tableId = requireId(command.tableId);
  const rowId = requireId(command.rowId);
  const layout = prepared.layouts.get(tableId);
  if (!layout) fail("TABLE_MISSING");
  const index = layout.rowIds.indexOf(rowId);
  if (index < 0) fail("ROW_MISSING");
  if (layout.rowIds.length === 1) fail("TABLE_ROW_MIN");
  const [row] = layout.table.content!.splice(index, 1);
  const removed = collectSubtreeIds(row);
  const tombstones = [...prepared.state.tombstones];
  for (const id of removed) {
    if (prepared.tombstones.has(id)) fail("TOMBSTONE_DRIFT");
    prepared.tombstones.add(id);
    tombstones.push(id);
  }
  const rowIds = [
    ...layout.rowIds.slice(0, index),
    ...layout.rowIds.slice(index + 1),
  ];
  return withMetadata(
    prepared,
    tableId,
    rowIds,
    [...layout.columnIds],
    tombstones,
  );
}

function deleteColumn(
  prepared: Prepared,
  command: Extract<TableCommand, { kind: "table.column.delete" }>,
): DocumentState {
  const tableId = requireId(command.tableId);
  const columnId = requireId(command.columnId);
  const layout = prepared.layouts.get(tableId);
  if (!layout) fail("TABLE_MISSING");
  const index = layout.columnIds.indexOf(columnId);
  if (index < 0) fail("COLUMN_MISSING");
  if (layout.columnIds.length === 1) fail("TABLE_COLUMN_MIN");
  const removed: string[] = [columnId];
  for (const row of layout.rows) {
    const [cell] = row.content!.splice(index, 1);
    removed.push(...collectSubtreeIds(cell));
  }
  const tombstones = [...prepared.state.tombstones];
  for (const id of removed) {
    if (prepared.tombstones.has(id)) fail("TOMBSTONE_DRIFT");
    prepared.tombstones.add(id);
    tombstones.push(id);
  }
  const columnIds = [
    ...layout.columnIds.slice(0, index),
    ...layout.columnIds.slice(index + 1),
  ];
  return withMetadata(
    prepared,
    tableId,
    [...layout.rowIds],
    columnIds,
    tombstones,
  );
}

/** True only when a deleted node carries no authored content or styling.
 * Structural identity and ProseMirror's simple-table defaults are ignored. */
export function strictlyEmpty(node: Doc): boolean {
  if (node.type === "text")
    return (node.text ?? "") === "" && (node.marks?.length ?? 0) === 0;
  if (node.type === "hardBreak") return false;
  if (node.marks !== undefined && node.marks.length > 0) return false;
  for (const [key, value] of Object.entries(node.attrs ?? {})) {
    if (key === "id") continue;
    if (key === "colspan" && value === 1) continue;
    if (key === "rowspan" && value === 1) continue;
    if (key === "colwidth" && value === null) continue;
    if (value !== null && value !== undefined && value !== false) return false;
  }
  for (const child of node.content ?? [])
    if (!strictlyEmpty(child)) return false;
  return true;
}

function restoreKind(node: Doc): string {
  return node.type === "tableCell" || node.type === "tableHeader"
    ? "cell"
    : node.type;
}

function remapRestoreIds(
  node: Doc,
  incarnationId: string,
  tableId: string,
  rowSlot: string,
  columnSlot: string,
  path: string,
  used: Set<string>,
): void {
  if (node.attrs?.id !== undefined && node.attrs?.id !== null) {
    const fresh = requireId(
      derivedId(
        incarnationId,
        tableId,
        rowSlot,
        columnSlot,
        restoreKind(node),
        path,
      ),
    );
    if (used.has(fresh)) fail("ID_COLLISION");
    used.add(fresh);
    node.attrs = { ...(node.attrs ?? {}), id: fresh };
  }
  const content = node.content ?? [];
  for (let index = 0; index < content.length; index++)
    remapRestoreIds(
      content[index],
      incarnationId,
      tableId,
      rowSlot,
      columnSlot,
      `${path}.${index}`,
      used,
    );
}

function restoreEmptyCell(
  type: "tableCell" | "tableHeader",
  incarnationId: string,
  tableId: string,
  rowSlot: string,
  columnSlot: string,
  used: Set<string>,
): Doc {
  const cell: Doc = {
    type,
    attrs: { id: "" },
    content: [{ type: "paragraph", attrs: { id: "" } }],
  };
  remapRestoreIds(cell, incarnationId, tableId, rowSlot, columnSlot, "0", used);
  return cell;
}

function restoreRow(
  prepared: Prepared,
  command: Extract<TableCommand, { kind: "table.row.restore" }>,
  incarnationId: string,
): DocumentState {
  const tableId = requireId(command.tableId);
  const newRowId = requireId(command.newRowId);
  const beforeId =
    command.beforeId === null ? null : requireId(command.beforeId);
  if (!command.sourceRow || typeof command.sourceRow !== "object")
    fail("TABLE_SHAPE");
  if (!Array.isArray(command.columnIds)) fail("TABLE_SHAPE");
  if (command.columnIds.length < 1) fail("TABLE_SHAPE");
  if (command.columnIds.length > MAX_TABLE_COLUMNS) fail("TABLE_COLUMN_LIMIT");
  const layout = prepared.layouts.get(tableId);
  if (!layout) fail("TABLE_MISSING");
  if (layout.rowIds.length >= MAX_TABLE_ROWS) fail("TABLE_ROW_LIMIT");
  const index =
    beforeId === null ? layout.rowIds.length : layout.rowIds.indexOf(beforeId);
  if (index < 0) fail("ROW_MISSING");
  const sourceCells = checkedRow(command.sourceRow, command.columnIds.length);
  const sourceRowId = requireId(command.sourceRow.attrs?.id);
  if (sourceRowId === newRowId) fail("ID_COLLISION");
  const sourceByColumn = new Map<string, Doc>();
  for (
    let columnIndex = 0;
    columnIndex < command.columnIds.length;
    columnIndex++
  ) {
    const columnId = requireId(command.columnIds[columnIndex]);
    if (sourceByColumn.has(columnId)) fail("TABLE_SHAPE");
    sourceByColumn.set(columnId, sourceCells[columnIndex]);
  }
  const currentColumns = new Set(layout.columnIds);
  for (const [columnId, sourceCell] of sourceByColumn) {
    if (currentColumns.has(columnId)) continue;
    if (!prepared.tombstones.has(columnId)) fail("HISTORY_CONFLICT");
    if (!strictlyEmpty(sourceCell)) fail("HISTORY_CONFLICT");
  }
  const used = new Set<string>([
    ...prepared.docIds,
    ...prepared.columnIds,
    ...prepared.tombstones,
  ]);
  for (const id of collectSubtreeIds(command.sourceRow)) used.add(id);
  for (const columnId of sourceByColumn.keys()) used.add(columnId);
  if (used.has(newRowId)) fail("ID_COLLISION");
  used.add(newRowId);
  const emptyType =
    sourceCells[0]?.type === "tableHeader" ? "tableHeader" : "tableCell";
  const cells: Doc[] = [];
  for (const columnId of layout.columnIds) {
    const source = sourceByColumn.get(columnId);
    if (source) {
      const cell = clone(source);
      remapRestoreIds(
        cell,
        incarnationId,
        tableId,
        newRowId,
        columnId,
        "0",
        used,
      );
      cells.push(cell);
    } else {
      cells.push(
        restoreEmptyCell(
          emptyType,
          incarnationId,
          tableId,
          newRowId,
          columnId,
          used,
        ),
      );
    }
  }
  const row: Doc = {
    type: "tableRow",
    attrs: { id: newRowId },
    content: cells,
  };
  layout.table.content!.splice(index, 0, row);
  const rowIds = [
    ...layout.rowIds.slice(0, index),
    newRowId,
    ...layout.rowIds.slice(index),
  ];
  return withMetadata(
    prepared,
    tableId,
    rowIds,
    [...layout.columnIds],
    [...prepared.state.tombstones],
  );
}

function restoreColumn(
  prepared: Prepared,
  command: Extract<TableCommand, { kind: "table.column.restore" }>,
  incarnationId: string,
): DocumentState {
  const tableId = requireId(command.tableId);
  const newColumnId = requireId(command.newColumnId);
  const beforeId =
    command.beforeId === null ? null : requireId(command.beforeId);
  const sourceColumnId = requireId(command.sourceColumnId);
  if (sourceColumnId === newColumnId) fail("ID_COLLISION");
  if (!Array.isArray(command.rows)) fail("TABLE_SHAPE");
  if (command.rows.length > MAX_TABLE_ROWS) fail("TABLE_ROW_LIMIT");
  const layout = prepared.layouts.get(tableId);
  if (!layout) fail("TABLE_MISSING");
  if (layout.columnIds.length >= MAX_TABLE_COLUMNS) fail("TABLE_COLUMN_LIMIT");
  const index =
    beforeId === null
      ? layout.columnIds.length
      : layout.columnIds.indexOf(beforeId);
  if (index < 0) fail("COLUMN_MISSING");
  const sourceByRow = new Map<string, Doc>();
  for (const entry of command.rows) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      fail("TABLE_SHAPE");
    const rowId = requireId(entry.rowId);
    if (sourceByRow.has(rowId)) fail("TABLE_SHAPE");
    const sourceCell = entry.cell;
    if (
      !sourceCell ||
      typeof sourceCell !== "object" ||
      Array.isArray(sourceCell)
    )
      fail("TABLE_SHAPE");
    checkedCell(sourceCell);
    sourceByRow.set(rowId, sourceCell);
  }
  const currentRows = new Set(layout.rowIds);
  for (const [rowId, sourceCell] of sourceByRow) {
    if (currentRows.has(rowId)) continue;
    if (!prepared.tombstones.has(rowId)) fail("HISTORY_CONFLICT");
    if (!strictlyEmpty(sourceCell)) fail("HISTORY_CONFLICT");
  }
  const used = new Set<string>([
    ...prepared.docIds,
    ...prepared.columnIds,
    ...prepared.tombstones,
  ]);
  used.add(sourceColumnId);
  for (const [rowId, sourceCell] of sourceByRow) {
    used.add(rowId);
    for (const id of collectSubtreeIds(sourceCell)) used.add(id);
  }
  if (used.has(newColumnId)) fail("ID_COLLISION");
  used.add(newColumnId);
  for (let rowIndex = 0; rowIndex < layout.rows.length; rowIndex++) {
    const row = layout.rows[rowIndex];
    const rowId = layout.rowIds[rowIndex];
    const source = sourceByRow.get(rowId);
    let cell: Doc;
    if (source) {
      cell = clone(source);
      remapRestoreIds(
        cell,
        incarnationId,
        tableId,
        rowId,
        newColumnId,
        "0",
        used,
      );
    } else {
      const type =
        row.content?.[0]?.type === "tableHeader" ? "tableHeader" : "tableCell";
      cell = restoreEmptyCell(
        type,
        incarnationId,
        tableId,
        rowId,
        newColumnId,
        used,
      );
    }
    row.content!.splice(index, 0, cell);
  }
  const columnIds = [
    ...layout.columnIds.slice(0, index),
    newColumnId,
    ...layout.columnIds.slice(index),
  ];
  return withMetadata(prepared, tableId, [...layout.rowIds], columnIds, [
    ...prepared.state.tombstones,
  ]);
}

export function applyTable(
  state: DocumentState,
  command: TableCommand,
  incarnationId: string,
): SemanticResult {
  if (!command || typeof command !== "object")
    fail("UNSUPPORTED_TABLE_COMMAND");
  const incarnation = requireId(incarnationId);
  const prepared = prepare(state);
  let next: DocumentState;
  switch (command.kind) {
    case "table.row.insert":
      next = insertRow(prepared, command, incarnation);
      break;
    case "table.column.insert":
      next = insertColumn(prepared, command, incarnation);
      break;
    case "table.row.delete":
      next = deleteRow(prepared, command);
      break;
    case "table.column.delete":
      next = deleteColumn(prepared, command);
      break;
    case "table.row.restore":
      next = restoreRow(prepared, command, incarnation);
      break;
    case "table.column.restore":
      next = restoreColumn(prepared, command, incarnation);
      break;
    default:
      fail("UNSUPPORTED_TABLE_COMMAND");
  }
  return { state: checkedState(next), appliedText: null };
}

function seedColumnIds(
  incarnation: string,
  tableId: string,
  rows: Doc[],
  used: Set<string>,
): string[] {
  const columnIds: string[] = [];
  for (let index = 0; index < rows[0].content!.length; index++) {
    const columnId = requireId(
      derivedId(incarnation, tableId, "column", String(index)),
    );
    if (used.has(columnId)) fail("ID_COLLISION");
    used.add(columnId);
    columnIds.push(columnId);
  }
  return columnIds;
}

/** Seeds metadata only for tables that do not have it yet. Existing tables keep
 * their stable column identities and are never reseeded. */
export function seedNewTables(
  state: DocumentState,
  incarnationId: string,
  tableIds: readonly string[],
): DocumentState {
  const incarnation = requireId(incarnationId);
  const base = checkedState(state);
  if (!Array.isArray(base.tables) || !Array.isArray(base.tombstones))
    fail("TABLE_METADATA_DRIFT");
  const docIds = collectDocumentIds(base.document);
  const byId = new Map<string, Doc>();
  for (const table of findTables(base.document)) {
    const tableId = nodeId(table);
    if (byId.has(tableId)) fail("DUPLICATE_ID");
    byId.set(tableId, table);
  }
  const used = new Set<string>(docIds);
  const known = new Set<string>();
  for (const entry of base.tables) {
    if (!entry || typeof entry !== "object") fail("TABLE_METADATA_DRIFT");
    const tableId = requireId(entry.tableId);
    if (known.has(tableId)) fail("DUPLICATE_TABLE_METADATA");
    known.add(tableId);
    if (!Array.isArray(entry.rowIds) || !Array.isArray(entry.columnIds))
      fail("TABLE_METADATA_DRIFT");
    for (const value of entry.columnIds) used.add(requireId(value));
  }
  for (const value of base.tombstones) used.add(requireId(value));
  const tables: TableMetadata[] = [...base.tables];
  for (const rawId of tableIds) {
    const tableId = requireId(rawId);
    if (known.has(tableId)) continue;
    const table = byId.get(tableId);
    if (!table) fail("TABLE_MISSING");
    const rows = tableRows(table);
    const rowIds = rows.map((row) => nodeId(row));
    const columnIds = seedColumnIds(incarnation, tableId, rows, used);
    tables.push({ tableId, rowIds, columnIds });
    known.add(tableId);
  }
  return checkedState({
    document: base.document,
    tables,
    tombstones: [...base.tombstones],
  });
}

/** Removes metadata for tables that left the document and tombstones their
 * externally allocated column identities so they can never be reused. */
export function removeTableMetadata(
  state: DocumentState,
  tableIds: readonly string[],
): DocumentState {
  const base = checkedState(state);
  if (!Array.isArray(base.tables) || !Array.isArray(base.tombstones))
    fail("TABLE_METADATA_DRIFT");
  const remove = new Set<string>();
  for (const value of tableIds) remove.add(requireId(value));
  const tombstones = [...base.tombstones];
  const known = new Set<string>();
  for (const value of tombstones) {
    const id = requireId(value);
    if (known.has(id)) fail("DUPLICATE_TOMBSTONE");
    known.add(id);
  }
  const tables: TableMetadata[] = [];
  for (const entry of base.tables) {
    if (!entry || typeof entry !== "object") fail("TABLE_METADATA_DRIFT");
    const tableId = requireId(entry.tableId);
    if (!remove.has(tableId)) {
      tables.push(entry);
      continue;
    }
    if (!Array.isArray(entry.columnIds)) fail("TABLE_METADATA_DRIFT");
    for (const value of entry.columnIds) {
      const columnId = requireId(value);
      if (known.has(columnId)) fail("TOMBSTONE_DRIFT");
      known.add(columnId);
      tombstones.push(columnId);
    }
  }
  return checkedState({ document: base.document, tables, tombstones });
}

export function seedTables(
  state: DocumentState,
  incarnationId: string,
): DocumentState {
  const incarnation = requireId(incarnationId);
  const base = checkedState(state);
  if (!Array.isArray(base.tombstones)) fail("TOMBSTONE_DRIFT");
  const docIds = collectDocumentIds(base.document);
  const initialTombstones = readTombstones(
    base.tombstones,
    docIds,
    new Set<string>(),
  );
  const used = new Set<string>([...docIds, ...initialTombstones]);
  const tables: TableMetadata[] = [];
  for (const table of findTables(base.document)) {
    const tableId = nodeId(table);
    const rows = tableRows(table);
    const rowIds = rows.map((row) => nodeId(row));
    const columnIds = seedColumnIds(incarnation, tableId, rows, used);
    tables.push({ tableId, rowIds, columnIds });
  }
  return checkedState({
    document: base.document,
    tables,
    tombstones: [...base.tombstones],
  });
}
