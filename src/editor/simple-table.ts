import {
  Node,
  mergeAttributes,
  type JSONContent,
  type MarkdownParseHelpers,
  type MarkdownToken,
} from "@tiptap/core";
import { renderRichBlockHTML } from "../document-io/rich-block-html";
import {
  Fragment,
  type Node as ProseMirrorNode,
  type NodeType,
  type Schema,
} from "@tiptap/pm/model";
import {
  Selection,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state";
import {
  TableMap,
  goToNextCell,
  isInTable,
  removeColumn,
  selectedRect,
  tableEditing,
  type TableRect,
} from "@tiptap/pm/tables";

export const MIN_TABLE_ROWS = 1;
export const MAX_TABLE_ROWS = 100;
export const MIN_TABLE_COLUMNS = 1;
export const MAX_TABLE_COLUMNS = 20;

function cellSpan(value: string | null): number {
  return value === null || value === "" ? 1 : Number(value);
}

function cellColwidth(value: string | null): number[] | null {
  if (!value || !/^\d+(,\d+)*$/.test(value)) return null;
  return value.split(",").map(Number);
}

function tableCellAttributes() {
  return {
    colspan: {
      default: 1,
      parseHTML: (element: HTMLElement) =>
        cellSpan(element.getAttribute("colspan")),
      renderHTML: (attrs: Record<string, unknown>) =>
        attrs.colspan === 1 ? {} : { colspan: attrs.colspan },
    },
    rowspan: {
      default: 1,
      parseHTML: (element: HTMLElement) =>
        cellSpan(element.getAttribute("rowspan")),
      renderHTML: (attrs: Record<string, unknown>) =>
        attrs.rowspan === 1 ? {} : { rowspan: attrs.rowspan },
    },
    colwidth: {
      default: null,
      parseHTML: (element: HTMLElement) =>
        cellColwidth(element.getAttribute("data-colwidth")),
      renderHTML: (attrs: Record<string, unknown>) =>
        Array.isArray(attrs.colwidth) && attrs.colwidth.length
          ? { "data-colwidth": attrs.colwidth.join(",") }
          : {},
    },
  };
}

/**
 * Simple tables intentionally keep ProseMirror's native table cell attrs.
 * External merged cells therefore remain merged in the parsed document; the
 * parent-owned validator rejects them before the editor accepts the document.
 */
export const SimpleTable = Node.create({
  name: "table",
  group: "block",
  content: "tableRow+",
  isolating: true,

  extendNodeSchema(extension: { name: string }) {
    return extension.name === "table" ? { tableRole: "table" } : {};
  },

  parseHTML() {
    return [{ tag: "table" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const columns = node.firstChild?.childCount ?? 1;
    return [
      "div",
      { class: "tableWrapper", style: "overflow-x:auto;max-width:100%" },
      [
        "table",
        mergeAttributes(HTMLAttributes, {
          style: `min-width:${columns * 96}px`,
        }),
        ["tbody", 0],
      ],
    ];
  },

  addProseMirrorPlugins() {
    // This supplies native cell selection, arrow-key navigation between cells,
    // and the standard table structure checks. Mod-Enter below is the explicit
    // way out of a table; ArrowDown at the end of the last cell also exits via
    // this plugin's vertical motion.
    //
    // tableEditing repairs malformed grids only after a transaction. The
    // parent-owned validator must therefore reject merged/out-of-bounds tables
    // before a document is mounted here; that validation is not duplicated as a
    // mutation inside the editor.
    return [tableEditing()];
  },

  addCommands() {
    return {
      insertSimpleTable:
        (rows = 3, columns = 3) =>
        ({ tr, dispatch, editor }) => {
          if (!editor.isEditable) return false;
          if (
            !Number.isInteger(rows) ||
            rows < MIN_TABLE_ROWS ||
            rows > MAX_TABLE_ROWS ||
            !Number.isInteger(columns) ||
            columns < MIN_TABLE_COLUMNS ||
            columns > MAX_TABLE_COLUMNS
          )
            return false;

          const table = createTableNode(editor.schema, rows, columns);
          if (!table) return false;
          const range = insertionRange(tr, table);
          if (!range) return false;

          if (dispatch) {
            tr.replaceWith(range.from, range.to, table);
            selectFirstCell(tr, range.from);
            dispatch(tr.scrollIntoView());
          }
          return true;
        },

      addSimpleRow:
        () =>
        ({ tr, dispatch, editor }) => {
          if (!editor.isEditable) return false;
          const rect = tableRect(tr);
          if (!rect || rect.map.height >= MAX_TABLE_ROWS) return false;
          if (dispatch) {
            if (!insertRowAfter(tr, rect, rect.bottom)) return false;
            dispatch(tr.scrollIntoView());
          }
          return true;
        },

      deleteSimpleRow:
        () =>
        ({ tr, dispatch, editor }) => {
          if (!editor.isEditable) return false;
          const rect = tableRect(tr);
          if (!rect) return false;
          if (rect.top === 0 && rect.bottom === rect.map.height) {
            if (dispatch) {
              if (!removeTable(tr, rect.tableStart, rect.table)) return false;
              dispatch(tr.scrollIntoView());
            }
            return true;
          }
          if (dispatch) {
            if (!removeRows(tr, rect, rect.top, rect.bottom)) return false;
            dispatch(tr.scrollIntoView());
          }
          return true;
        },

      addSimpleColumn:
        () =>
        ({ tr, dispatch, editor }) => {
          if (!editor.isEditable) return false;
          const rect = tableRect(tr);
          if (!rect || rect.map.width >= MAX_TABLE_COLUMNS) return false;
          if (dispatch) {
            if (!insertColumnAfter(tr, rect, rect.right)) return false;
            dispatch(tr.scrollIntoView());
          }
          return true;
        },

      deleteSimpleColumn:
        () =>
        ({ tr, dispatch, editor }) => {
          if (!editor.isEditable) return false;
          const rect = tableRect(tr);
          if (!rect) return false;
          if (rect.left === 0 && rect.right === rect.map.width) {
            if (dispatch) {
              if (!removeTable(tr, rect.tableStart, rect.table)) return false;
              dispatch(tr.scrollIntoView());
            }
            return true;
          }
          if (dispatch) {
            if (!removeColumns(tr, rect, rect.left, rect.right)) return false;
            dispatch(tr.scrollIntoView());
          }
          return true;
        },

      toggleSimpleHeader:
        () =>
        ({ tr, dispatch, editor }) => {
          if (!editor.isEditable) return false;
          const rect = tableRect(tr);
          if (!rect) return false;
          if (dispatch) {
            if (!toggleFirstRowHeader(tr, rect)) return false;
            dispatch(tr.scrollIntoView());
          }
          return true;
        },

      deleteSimpleTable:
        () =>
        ({ tr, dispatch, editor }) => {
          if (!editor.isEditable) return false;
          const rect = tableRect(tr);
          if (!rect) return false;
          if (dispatch) {
            if (!removeTable(tr, rect.tableStart, rect.table)) return false;
            dispatch(tr.scrollIntoView());
          }
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => {
        const editor = this.editor;
        if (!editor.isEditable || editor.view.composing) return false;
        const state = editor.state;
        if (!isInTable(state)) return false;
        if (goToNextCell(1)(state, (tr) => editor.view.dispatch(tr)))
          return true;

        const rect = tableRect(state.tr);
        if (!rect) return false;
        const tr = state.tr;
        if (rect.map.height < MAX_TABLE_ROWS) {
          if (!insertRowAfter(tr, rect, rect.map.height)) return false;
          editor.view.dispatch(tr.scrollIntoView());
          return true;
        }
        if (!exitTable(tr, rect, 1)) return false;
        editor.view.dispatch(tr.scrollIntoView());
        return true;
      },

      "Shift-Tab": () => {
        const editor = this.editor;
        if (!editor.isEditable || editor.view.composing) return false;
        const state = editor.state;
        if (!isInTable(state)) return false;
        if (goToNextCell(-1)(state, (tr) => editor.view.dispatch(tr)))
          return true;

        const rect = tableRect(state.tr);
        if (!rect) return false;
        const tr = state.tr;
        if (!exitTable(tr, rect, -1)) return false;
        editor.view.dispatch(tr.scrollIntoView());
        return true;
      },

      "Mod-Enter": () => {
        const editor = this.editor;
        if (!editor.isEditable || editor.view.composing) return false;
        const rect = tableRect(editor.state.tr);
        if (!rect) return false;
        const tr = editor.state.tr;
        if (!exitTable(tr, rect, 1)) return false;
        editor.view.dispatch(tr.scrollIntoView());
        return true;
      },
    };
  },

  markdownTokenName: "table",

  parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers) {
    const header = Array.isArray(token.header) ? token.header : [];
    const rows: MarkdownToken[][] = Array.isArray(token.rows) ? token.rows : [];
    let columns = header.length;
    for (const row of rows) columns = Math.max(columns, row.length);
    if (!columns || (!header.length && !rows.length)) return [];

    const rowNode = (cells: MarkdownToken[], headerRow: boolean) =>
      helpers.createNode(
        "tableRow",
        {},
        Array.from({ length: columns }, (_, index) =>
          tableCellNode(cells[index], headerRow, helpers),
        ),
      );

    return helpers.createNode("table", {}, [
      rowNode(header, true),
      ...rows.map((row) => rowNode(row, false)),
    ]);
  },

  renderMarkdown(node: JSONContent) {
    return renderRichBlockHTML(node);
  },
});

export const SimpleTableRow = Node.create({
  name: "tableRow",
  content: "(tableCell | tableHeader)+",

  extendNodeSchema(extension: { name: string }) {
    return extension.name === "tableRow" ? { tableRole: "row" } : {};
  },

  parseHTML() {
    return [{ tag: "tr" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["tr", mergeAttributes(HTMLAttributes), 0];
  },
});

export const SimpleTableCell = Node.create({
  name: "tableCell",
  content: "paragraph+",
  isolating: true,

  extendNodeSchema(extension: { name: string }) {
    return extension.name === "tableCell" ? { tableRole: "cell" } : {};
  },

  addAttributes: tableCellAttributes,

  parseHTML() {
    return [{ tag: "td" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["td", mergeAttributes(HTMLAttributes), 0];
  },
});

export const SimpleTableHeader = Node.create({
  name: "tableHeader",
  content: "paragraph+",
  isolating: true,

  extendNodeSchema(extension: { name: string }) {
    return extension.name === "tableHeader" ? { tableRole: "header_cell" } : {};
  },

  addAttributes: tableCellAttributes,

  parseHTML() {
    return [{ tag: "th" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["th", mergeAttributes(HTMLAttributes), 0];
  },
});

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    simpleTable: {
      insertSimpleTable: (rows?: number, columns?: number) => ReturnType;
      addSimpleRow: () => ReturnType;
      deleteSimpleRow: () => ReturnType;
      addSimpleColumn: () => ReturnType;
      deleteSimpleColumn: () => ReturnType;
      toggleSimpleHeader: () => ReturnType;
      deleteSimpleTable: () => ReturnType;
    };
  }
}

function createCell(type: NodeType): ProseMirrorNode | null {
  return type.createAndFill();
}

function createRow(
  schema: Schema,
  width: number,
  cellType: NodeType,
): ProseMirrorNode | null {
  const rowType = schema.nodes.tableRow;
  if (!rowType) return null;
  const cells: ProseMirrorNode[] = [];
  for (let column = 0; column < width; column++) {
    const cell = createCell(cellType);
    if (!cell) return null;
    cells.push(cell);
  }
  return rowType.create(null, cells);
}

function createTableNode(
  schema: Schema,
  rows: number,
  columns: number,
): ProseMirrorNode | null {
  const tableType = schema.nodes.table;
  const rowType = schema.nodes.tableRow;
  const cellType = schema.nodes.tableCell;
  const headerType = schema.nodes.tableHeader;
  if (!tableType || !rowType || !cellType || !headerType) return null;
  const children: ProseMirrorNode[] = [];
  for (let row = 0; row < rows; row++) {
    const node = createRow(schema, columns, row === 0 ? headerType : cellType);
    if (!node) return null;
    children.push(node);
  }
  return tableType.create(null, children);
}

function insertionRange(
  tr: Transaction,
  table: ProseMirrorNode,
): { from: number; to: number } | null {
  if (!tr.selection.empty) return null;
  const { $from } = tr.selection;
  if (!$from.parent.isTextblock || $from.depth === 0) return null;

  const parent = $from.node($from.depth - 1);
  const index = $from.index($from.depth - 1);
  const fragment = Fragment.from(table);
  const blockFrom = $from.before($from.depth);
  const blockTo = $from.after($from.depth);

  if (
    $from.parent.childCount === 0 &&
    parent.canReplace(index, index + 1, fragment)
  )
    return { from: blockFrom, to: blockTo };
  if (parent.canReplace(index + 1, index + 1, fragment))
    return { from: blockTo, to: blockTo };
  return null;
}

function selectFirstCell(tr: Transaction, tablePos: number) {
  const position = tablePos + 4;
  if (position <= tr.doc.content.size)
    tr.setSelection(TextSelection.create(tr.doc, position));
}

function tableRect(tr: Transaction): TableRect | null {
  const state = { selection: tr.selection } as EditorState;
  if (!isInTable(state)) return null;
  try {
    return selectedRect(state);
  } catch {
    return null;
  }
}

function insertRowAfter(
  tr: Transaction,
  rect: TableRect,
  rowIndex: number,
): boolean {
  const cell = tr.doc.type.schema.nodes.tableCell;
  if (!cell) return false;
  const row = createRow(tr.doc.type.schema, rect.map.width, cell);
  if (!row) return false;
  let position = rect.tableStart;
  for (let row = 0; row < rowIndex; row++)
    position += rect.table.child(row).nodeSize;
  tr.insert(position, row);
  tr.setSelection(TextSelection.create(tr.doc, position + 3));
  return true;
}

function insertColumnAfter(
  tr: Transaction,
  rect: TableRect,
  columnIndex: number,
): boolean {
  const schema = tr.doc.type.schema;
  const cell = schema.nodes.tableCell;
  const header = schema.nodes.tableHeader;
  if (!cell || !header) return false;
  const mapFrom = tr.mapping.maps.length;
  for (let row = 0; row < rect.map.height; row++) {
    const firstCell = rect.table.nodeAt(rect.map.map[row * rect.map.width]);
    const node = createCell(firstCell?.type === header ? header : cell);
    if (!node) return false;
    const position =
      rect.tableStart + rect.map.positionAt(row, columnIndex, rect.table);
    tr.insert(tr.mapping.slice(mapFrom).map(position), node);
  }
  return true;
}

function selectRemainingCell(
  tr: Transaction,
  tableStart: number,
  row: number,
  column: number,
) {
  const table = tr.doc.nodeAt(tableStart - 1);
  if (!table) return;
  const map = TableMap.get(table);
  const r = Math.max(0, Math.min(row, map.height - 1));
  const c = Math.max(0, Math.min(column, map.width - 1));
  tr.setSelection(
    TextSelection.create(tr.doc, tableStart + map.map[r * map.width + c] + 2),
  );
}

function removeRows(
  tr: Transaction,
  rect: TableRect,
  from: number,
  to: number,
): boolean {
  for (let row = to - 1; row >= from; row--) {
    const table = tr.doc.nodeAt(rect.tableStart - 1);
    if (!table || row >= table.childCount) return false;
    let position = rect.tableStart;
    for (let index = 0; index < row; index++)
      position += table.child(index).nodeSize;
    tr.delete(position, position + table.child(row).nodeSize);
  }
  selectRemainingCell(tr, rect.tableStart, from, rect.left);
  return true;
}

function removeColumns(
  tr: Transaction,
  rect: TableRect,
  from: number,
  to: number,
): boolean {
  let current = rect;
  for (let column = to - 1; column >= from; column--) {
    removeColumn(tr, current, column);
    const table = tr.doc.nodeAt(current.tableStart - 1);
    if (!table) return false;
    current = { ...current, table, map: TableMap.get(table) };
  }
  selectRemainingCell(tr, rect.tableStart, rect.top, from);
  return true;
}

function toggleFirstRowHeader(tr: Transaction, rect: TableRect): boolean {
  const schema = tr.doc.type.schema;
  const cell = schema.nodes.tableCell;
  const header = schema.nodes.tableHeader;
  if (!cell || !header) return false;
  const positions = rect.map.cellsInRect({
    left: 0,
    top: 0,
    right: rect.map.width,
    bottom: 1,
  });
  if (!positions.length) return false;
  const allHeader = positions.every(
    (position) => rect.table.nodeAt(position)?.type === header,
  );
  const target = allHeader ? cell : header;
  for (const position of positions) {
    const absolute = rect.tableStart + position;
    const node = tr.doc.nodeAt(absolute);
    if (node && node.type !== target)
      tr.setNodeMarkup(absolute, target, { ...node.attrs });
  }
  return true;
}

/**
 * Removes one table. Replacing the sole child of a block container with a
 * paragraph keeps the document schema-valid and leaves a usable cursor target.
 */
function removeTable(
  tr: Transaction,
  tableStart: number,
  table: ProseMirrorNode,
): boolean {
  const position = tableStart - 1;
  const $position = tr.doc.resolve(position);
  const parent = $position.parent;
  if (parent.childCount === 1) {
    const paragraph = tr.doc.type.schema.nodes.paragraph;
    const replacement = paragraph?.createAndFill();
    if (!replacement) return false;
    tr.replaceWith(position, position + table.nodeSize, replacement);
    tr.setSelection(TextSelection.create(tr.doc, position + 1));
    return true;
  }
  tr.delete(position, position + table.nodeSize);
  tr.setSelection(
    Selection.near(tr.doc.resolve(Math.min(position, tr.doc.content.size)), 1),
  );
  return true;
}

function exitTable(
  tr: Transaction,
  rect: TableRect,
  direction: -1 | 1,
): boolean {
  const tablePosition = rect.tableStart - 1;
  const $table = tr.doc.resolve(tablePosition);
  const parent = $table.parent;
  const index = $table.index();
  if (direction > 0) {
    const after = tablePosition + rect.table.nodeSize;
    if (index + 1 < parent.childCount) {
      tr.setSelection(Selection.near(tr.doc.resolve(after), 1));
      return true;
    }
    const paragraph = tr.doc.type.schema.nodes.paragraph;
    const replacement = paragraph?.createAndFill();
    if (
      replacement &&
      parent.canReplace(index + 1, index + 1, Fragment.from(replacement))
    ) {
      tr.insert(after, replacement);
      tr.setSelection(TextSelection.create(tr.doc, after + 1));
      return true;
    }
    tr.setSelection(Selection.near(tr.doc.resolve(after), -1));
    return true;
  }

  const before = tablePosition;
  if (index > 0) {
    tr.setSelection(Selection.near(tr.doc.resolve(before), -1));
    return true;
  }
  const paragraph = tr.doc.type.schema.nodes.paragraph;
  const replacement = paragraph?.createAndFill();
  if (replacement && parent.canReplace(0, 0, Fragment.from(replacement))) {
    tr.insert(before, replacement);
    tr.setSelection(TextSelection.create(tr.doc, before + 1));
    return true;
  }
  tr.setSelection(Selection.near(tr.doc.resolve(before), 1));
  return true;
}

function tableCellNode(
  cell: MarkdownToken | undefined,
  header: boolean,
  helpers: MarkdownParseHelpers,
): JSONContent {
  const tokens = Array.isArray(cell?.tokens) ? cell.tokens : [];
  const inline = tokens.length
    ? helpers.parseInline(tokens)
    : cell?.text
      ? [helpers.createTextNode(cell.text)]
      : [];
  return helpers.createNode(header ? "tableHeader" : "tableCell", {}, [
    helpers.createNode("paragraph", {}, inline),
  ]);
}
