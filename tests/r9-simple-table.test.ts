import { describe, expect, it } from "vitest";
import {
  Extension,
  getSchema,
  type AnyExtension,
  type Editor,
  type JSONContent,
} from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { TableMap } from "@tiptap/pm/tables";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import {
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  SimpleTable,
  SimpleTableCell,
  SimpleTableHeader,
  SimpleTableRow,
} from "../src/editor/simple-table";

const TestTableIds = Extension.create({
  name: "testTableIds",
  addGlobalAttributes() {
    return [
      {
        types: ["table", "tableRow", "tableCell", "tableHeader"],
        attributes: {
          id: {
            default: null,
            parseHTML: (element: HTMLElement) =>
              element.getAttribute("data-folio-block-id"),
            renderHTML: (attributes: Record<string, unknown>) =>
              attributes.id ? { "data-folio-block-id": attributes.id } : {},
          },
        },
      },
    ];
  },
});

const extensions: AnyExtension[] = [
  StarterKit,
  SimpleTableRow,
  SimpleTableCell,
  SimpleTableHeader,
  SimpleTable,
  TestTableIds,
];
const schema = getSchema(extensions);
const markdown = new MarkdownManager({ extensions });

function fakeEditor(editable = true): Editor {
  return { schema, isEditable: editable } as unknown as Editor;
}

function commandSet() {
  return (SimpleTable.config.addCommands as any).call({
    editor: fakeEditor(true),
    type: schema.nodes.table,
    name: SimpleTable.name,
    options: SimpleTable.options,
    storage: SimpleTable.storage,
  });
}

const commands = commandSet();

function emptyState(): EditorState {
  const doc = schema.nodeFromJSON({
    type: "doc",
    content: [{ type: "paragraph" }],
  });
  return EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, 1),
  });
}

function execute(
  name: string,
  state: EditorState,
  options: { args?: unknown[]; dispatch?: boolean; editable?: boolean } = {},
) {
  const editor = fakeEditor(options.editable ?? true);
  let next = state;
  const tr = state.tr;
  const props = {
    state,
    tr,
    dispatch:
      options.dispatch === false
        ? undefined
        : (transaction?: Transaction) => {
            next = state.apply(transaction ?? tr);
          },
    editor,
  };
  const result = commands[name](...(options.args ?? []))(props);
  return { result, state: next, tr };
}

function insertTable(rows = 3, columns = 3): EditorState {
  const result = execute("insertSimpleTable", emptyState(), {
    args: [rows, columns],
  });
  expect(result.result).toBe(true);
  return result.state;
}

function tableOf(state: EditorState): ProseMirrorNode {
  const table = state.doc.firstChild;
  expect(table?.type.name).toBe("table");
  return table as ProseMirrorNode;
}

function selectCell(
  state: EditorState,
  row: number,
  column: number,
): EditorState {
  const table = tableOf(state);
  const map = TableMap.get(table);
  const cellPosition = 1 + map.positionAt(row, column, table);
  return state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, cellPosition + 2)),
  );
}

function cellRect(state: EditorState) {
  const table = tableOf(state);
  const $from = state.selection.$from;
  const map = TableMap.get(table);
  return map.findCell($from.before(3) - 1);
}

function rowTypes(row: ProseMirrorNode): string[] {
  return Array.from(
    { length: row.childCount },
    (_, index) => row.child(index).type.name,
  );
}

function rowCells(state: EditorState, row: number): ProseMirrorNode[] {
  const node = tableOf(state).child(row);
  return Array.from({ length: node.childCount }, (_, index) =>
    node.child(index),
  );
}

function assignTestIds(state: EditorState): EditorState {
  const tr = state.tr;
  state.doc.descendants((node, position) => {
    if (
      ["table", "tableRow", "tableCell", "tableHeader"].includes(node.type.name)
    )
      tr.setNodeMarkup(position, undefined, {
        ...node.attrs,
        id: `id-${position}`,
      });
  });
  return state.apply(tr);
}

function keyboardEditor(
  state: EditorState,
  options: { editable?: boolean; composing?: boolean } = {},
) {
  let current = state;
  const editor = {
    get state() {
      return current;
    },
    isEditable: options.editable ?? true,
    view: {
      composing: options.composing ?? false,
      dispatch: (transaction: Transaction) => {
        current = current.apply(transaction);
      },
    },
  };
  return {
    editor,
    get state() {
      return current;
    },
  };
}

function keyboardShortcuts(editor: any) {
  return (SimpleTable.config.addKeyboardShortcuts as any).call({ editor });
}

describe("simple table schema", () => {
  it("renders semantic table, row, td and th elements with a tbody", () => {
    const tableHTML = (SimpleTable.config.renderHTML as any).call(
      { editor: fakeEditor() },
      { node: { attrs: {} }, HTMLAttributes: {} },
    );
    const rowHTML = (SimpleTableRow.config.renderHTML as any).call(
      { editor: fakeEditor() },
      { node: { attrs: {} }, HTMLAttributes: {} },
    );
    expect(tableHTML[0]).toBe("div");
    expect(tableHTML[2][0]).toBe("table");
    expect(tableHTML[2]).toContainEqual(["tbody", 0]);
    expect(rowHTML[0]).toBe("tr");
    expect(
      (SimpleTableCell.config.renderHTML as any).call(
        { editor: fakeEditor() },
        { node: { attrs: {} }, HTMLAttributes: {} },
      )[0],
    ).toBe("td");
    expect(
      (SimpleTableHeader.config.renderHTML as any).call(
        { editor: fakeEditor() },
        { node: { attrs: {} }, HTMLAttributes: {} },
      )[0],
    ).toBe("th");
  });

  it("retains external colspan and rowspan instead of normalising merged cells", () => {
    const cellRule = schema.nodes.tableCell.spec.parseDOM?.find(
      (rule) => rule.tag === "td",
    );
    const headerRule = schema.nodes.tableHeader.spec.parseDOM?.find(
      (rule) => rule.tag === "th",
    );
    const element = (attributes: Record<string, string | null>) =>
      ({
        getAttribute: (name: string) => attributes[name] ?? null,
      }) as unknown as HTMLElement;

    expect(cellRule?.getAttrs).toBeTypeOf("function");
    expect(headerRule?.getAttrs).toBeTypeOf("function");
    expect(
      cellRule!.getAttrs!(
        element({ colspan: "2", rowspan: "3", "data-colwidth": "80,120" }),
      ),
    ).toMatchObject({ colspan: 2, rowspan: 3, colwidth: [80, 120] });
    expect(headerRule!.getAttrs!(element({ rowspan: "2" }))).toMatchObject({
      colspan: 1,
      rowspan: 2,
    });
  });

  it("uses table roles required by prosemirror-tables", () => {
    expect(schema.nodes.table.spec.tableRole).toBe("table");
    expect(schema.nodes.tableRow.spec.tableRole).toBe("row");
    expect(schema.nodes.tableCell.spec.tableRole).toBe("cell");
    expect(schema.nodes.tableHeader.spec.tableRole).toBe("header_cell");
  });
});

describe("simple table commands", () => {
  it("inserts a default 3x3 table with a header first row and selects the first cell", () => {
    const state = insertTable();
    const table = tableOf(state);
    expect(table.childCount).toBe(3);
    for (let row = 0; row < 3; row++)
      expect(table.child(row).childCount).toBe(3);
    expect(rowTypes(table.child(0))).toEqual([
      "tableHeader",
      "tableHeader",
      "tableHeader",
    ]);
    for (const row of [1, 2])
      expect(rowTypes(table.child(row))).toEqual([
        "tableCell",
        "tableCell",
        "tableCell",
      ]);
    for (let row = 0; row < 3; row++)
      for (const cell of rowCells(state, row))
        expect(cell.attrs).toMatchObject({
          colspan: 1,
          rowspan: 1,
          colwidth: null,
        });
    expect(state.selection.$from.node(3).type.name).toBe("tableHeader");
  });

  it("dry-runs insertion without mutation and rejects out-of-bounds dimensions", () => {
    const original = emptyState();
    const dry = execute("insertSimpleTable", original, {
      args: [3, 3],
      dispatch: false,
    });
    expect(dry.result).toBe(true);
    expect(dry.state).toBe(original);
    expect(dry.tr.docChanged).toBe(false);

    for (const args of [
      [0, 3],
      [MAX_TABLE_ROWS + 1, 3],
      [3, 0],
      [3, MAX_TABLE_COLUMNS + 1],
      [1.5, 3],
    ]) {
      const rejected = execute("insertSimpleTable", original, { args });
      expect(rejected.result).toBe(false);
      expect(rejected.state).toBe(original);
    }
  });

  it("adds and deletes rows at the cursor while retaining a header first row", () => {
    let state = selectCell(insertTable(), 1, 1);
    const added = execute("addSimpleRow", state);
    expect(added.result).toBe(true);
    state = added.state;
    expect(tableOf(state).childCount).toBe(4);
    expect(rowTypes(tableOf(state).child(2))).toEqual([
      "tableCell",
      "tableCell",
      "tableCell",
    ]);
    expect(state.selection.$from.node(3).type.name).toBe("tableCell");

    state = selectCell(state, 1, 1);
    const deleted = execute("deleteSimpleRow", state);
    expect(deleted.result).toBe(true);
    expect(tableOf(deleted.state).childCount).toBe(3);
    expect(rowTypes(tableOf(deleted.state).child(0))).toEqual([
      "tableHeader",
      "tableHeader",
      "tableHeader",
    ]);
  });

  it("keeps the caret in a surviving cell when the last row or column is removed", () => {
    const row = execute("deleteSimpleRow", selectCell(insertTable(3, 3), 2, 2));
    expect(row.state.selection.$from.node(1).type.name).toBe("table");
    expect(row.state.selection.$from.parent.type.name).toBe("paragraph");
    const column = execute(
      "deleteSimpleColumn",
      selectCell(insertTable(3, 3), 2, 2),
    );
    expect(column.state.selection.$from.node(1).type.name).toBe("table");
    expect(column.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("removes the table when the final row is deleted and leaves a paragraph", () => {
    let state = insertTable(1, 2);
    state = selectCell(state, 0, 0);
    const result = execute("deleteSimpleRow", state);
    expect(result.result).toBe(true);
    expect(result.state.doc.childCount).toBe(1);
    expect(result.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(result.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("adds and deletes columns, keeping every row rectangular", () => {
    let state = selectCell(insertTable(), 1, 1);
    const added = execute("addSimpleColumn", state);
    expect(added.result).toBe(true);
    state = added.state;
    for (let row = 0; row < 3; row++)
      expect(tableOf(state).child(row).childCount).toBe(4);
    expect(rowTypes(tableOf(state).child(0))).toEqual([
      "tableHeader",
      "tableHeader",
      "tableHeader",
      "tableHeader",
    ]);

    state = selectCell(state, 1, 1);
    const deleted = execute("deleteSimpleColumn", state);
    expect(deleted.result).toBe(true);
    for (let row = 0; row < 3; row++)
      expect(tableOf(deleted.state).child(row).childCount).toBe(3);
  });

  it("removes the table when the final column is deleted and leaves a paragraph", () => {
    let state = insertTable(2, 1);
    state = selectCell(state, 0, 0);
    const result = execute("deleteSimpleColumn", state);
    expect(result.result).toBe(true);
    expect(result.state.doc.firstChild?.type.name).toBe("paragraph");
  });

  it("enforces row and column limits without mutating", () => {
    let state = selectCell(
      insertTable(MAX_TABLE_ROWS, 1),
      MAX_TABLE_ROWS - 1,
      0,
    );
    const tooManyRows = execute("addSimpleRow", state);
    expect(tooManyRows.result).toBe(false);
    expect(tooManyRows.state).toBe(state);

    state = selectCell(insertTable(1, MAX_TABLE_COLUMNS), 0, 0);
    const tooManyColumns = execute("addSimpleColumn", state);
    expect(tooManyColumns.result).toBe(false);
    expect(tooManyColumns.state).toBe(state);
  });

  it("toggles only the first row between th and normal cell types", () => {
    let state = insertTable();
    const off = execute("toggleSimpleHeader", selectCell(state, 2, 2));
    expect(off.result).toBe(true);
    expect(rowTypes(tableOf(off.state).child(0))).toEqual([
      "tableCell",
      "tableCell",
      "tableCell",
    ]);
    expect(rowTypes(tableOf(off.state).child(1))).toEqual([
      "tableCell",
      "tableCell",
      "tableCell",
    ]);

    state = off.state;
    const on = execute("toggleSimpleHeader", selectCell(state, 1, 1));
    expect(on.result).toBe(true);
    expect(rowTypes(tableOf(on.state).child(0))).toEqual([
      "tableHeader",
      "tableHeader",
      "tableHeader",
    ]);
  });

  it("preserves existing table identities through row, column and header edits", () => {
    let state = assignTestIds(insertTable());
    const tableId = tableOf(state).attrs.id;
    const firstRowId = tableOf(state).child(0).attrs.id;
    const firstCellId = tableOf(state).child(0).child(0).attrs.id;
    expect(tableId).toBeTruthy();

    state = execute("addSimpleRow", selectCell(state, 0, 0)).state;
    state = execute("addSimpleColumn", selectCell(state, 1, 1)).state;
    state = execute("toggleSimpleHeader", selectCell(state, 1, 1)).state;

    expect(tableOf(state).attrs.id).toBe(tableId);
    expect(tableOf(state).child(0).attrs.id).toBe(firstRowId);
    expect(tableOf(state).child(0).child(0).attrs.id).toBe(firstCellId);
    for (const row of Array.from(
      { length: tableOf(state).childCount },
      (_, i) => tableOf(state).child(i),
    ))
      for (let index = 0; index < row.childCount; index++) {
        const id = row.child(index).attrs.id;
        expect(typeof id === "string" || id === null || id === undefined).toBe(
          true,
        );
      }
  });

  it("deletes the whole table and guarantees a usable paragraph", () => {
    const state = insertTable();
    const result = execute("deleteSimpleTable", state);
    expect(result.result).toBe(true);
    expect(result.state.doc.childCount).toBe(1);
    expect(result.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(result.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(execute("deleteSimpleTable", result.state).result).toBe(false);
  });

  it("returns false without mutation in read-only editors", () => {
    const state = insertTable();
    const selected = selectCell(state, 1, 1);
    for (const name of [
      "addSimpleRow",
      "deleteSimpleRow",
      "addSimpleColumn",
      "deleteSimpleColumn",
      "toggleSimpleHeader",
      "deleteSimpleTable",
    ]) {
      const result = execute(name, selected, { editable: false });
      expect(result.result).toBe(false);
      expect(result.state).toBe(selected);
    }
    const insertion = execute("insertSimpleTable", emptyState(), {
      args: [3, 3],
      editable: false,
    });
    expect(insertion.result).toBe(false);
    expect(insertion.state.doc.firstChild?.type.name).toBe("paragraph");
  });
});

describe("simple table keyboard behaviour", () => {
  it("moves between cells with Tab and Shift-Tab", () => {
    const editor = keyboardEditor(selectCell(insertTable(), 0, 0));
    const shortcuts = keyboardShortcuts(editor.editor);
    expect(shortcuts.Tab()).toBe(true);
    expect(cellRect(editor.state)).toMatchObject({ top: 0, bottom: 1 });
    expect(
      TableMap.get(tableOf(editor.state)).colCount(
        editor.state.selection.$from.before(3) - 1,
      ),
    ).toBe(1);

    expect(shortcuts["Shift-Tab"]()).toBe(true);
    expect(
      TableMap.get(tableOf(editor.state)).colCount(
        editor.state.selection.$from.before(3) - 1,
      ),
    ).toBe(0);
  });

  it("adds a row when Tab leaves the final cell below the row limit", () => {
    const editor = keyboardEditor(selectCell(insertTable(1, 1), 0, 0));
    const shortcuts = keyboardShortcuts(editor.editor);
    expect(shortcuts.Tab()).toBe(true);
    expect(tableOf(editor.state).childCount).toBe(2);
    expect(
      TableMap.get(tableOf(editor.state)).findCell(
        editor.state.selection.$from.before(3) - 1,
      ),
    ).toMatchObject({ top: 1, bottom: 2, left: 0, right: 1 });
  });

  it("exits instead of growing past the row limit", () => {
    const editor = keyboardEditor(
      selectCell(insertTable(MAX_TABLE_ROWS, 1), MAX_TABLE_ROWS - 1, 0),
    );
    const shortcuts = keyboardShortcuts(editor.editor);
    expect(shortcuts.Tab()).toBe(true);
    expect(tableOf(editor.state).childCount).toBe(MAX_TABLE_ROWS);
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(1).type.name).toBe("paragraph");
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("exits after the table with Mod-Enter", () => {
    const editor = keyboardEditor(selectCell(insertTable(), 1, 1));
    const shortcuts = keyboardShortcuts(editor.editor);
    expect(shortcuts["Mod-Enter"]()).toBe(true);
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(1).type.name).toBe("paragraph");
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("does not act during composition or when read-only", () => {
    const composing = keyboardEditor(selectCell(insertTable(), 0, 0), {
      composing: true,
    });
    const composingState = composing.state;
    const composingShortcuts = keyboardShortcuts(composing.editor);
    expect(composingShortcuts.Tab()).toBe(false);
    expect(composingShortcuts["Mod-Enter"]()).toBe(false);
    expect(composing.state).toBe(composingState);

    const readOnly = keyboardEditor(selectCell(insertTable(), 0, 0), {
      editable: false,
    });
    const readOnlyShortcuts = keyboardShortcuts(readOnly.editor);
    expect(readOnlyShortcuts.Tab()).toBe(false);
    expect(readOnlyShortcuts["Mod-Enter"]()).toBe(false);
  });
});

describe("simple table Markdown", () => {
  it("parses a GFM table with inline bold and links", () => {
    const doc = markdown.parse(
      "| Name | Link |\n| --- | --- |\n| **Bold** | [site](https://example.com) |\n",
    );
    const table = doc.content?.[0] as JSONContent;
    expect(table.type).toBe("table");
    expect(table.content?.[0].content?.map((cell) => cell.type)).toEqual([
      "tableHeader",
      "tableHeader",
    ]);
    expect(table.content?.[1].content?.[0].type).toBe("tableCell");

    const bold = table.content?.[1].content?.[0].content?.[0].content?.[0];
    expect(bold?.text).toBe("Bold");
    expect(bold?.marks?.[0]?.type).toBe("bold");

    const link = table.content?.[1].content?.[1].content?.[0].content?.[0];
    expect(link?.text).toBe("site");
    expect(
      link?.marks?.find((mark) => mark.type === "link")?.attrs,
    ).toMatchObject({ href: "https://example.com" });
  });

  it("renders standard HTML without a hidden JSON duplicate", () => {
    const doc = markdown.parse(
      "| A | B |\n| --- | --- |\n| first | [second](https://example.com) |\n",
    );
    const rendered = markdown.serialize(doc);
    expect(rendered).toContain("<table");
    expect(rendered).toContain("<tbody>");
    expect(rendered).toContain("<th");
    expect(rendered).toContain("<td");
    expect(rendered).toContain("first");
    expect(rendered).toContain("second");
    expect(rendered).toContain("https://example.com");
    expect(rendered).not.toContain('"content"');
    expect(rendered).not.toContain('"type":"table"');
  });

  it("keeps paragraph breaks in non-header cells in rendered HTML", () => {
    const rendered = markdown.serialize({
      type: "doc",
      content: [
        {
          type: "table",
          attrs: { id: "table-id" },
          content: [
            {
              type: "tableRow",
              attrs: { id: "row-id" },
              content: [
                {
                  type: "tableHeader",
                  attrs: { id: "header-id" },
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Header" }],
                    },
                  ],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  attrs: {
                    id: "cell-id",
                    colspan: 1,
                    rowspan: 1,
                    colwidth: null,
                  },
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "one" }],
                    },
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "two" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(rendered).toContain("<table");
    expect(rendered).toContain("<tbody>");
    expect(rendered).toContain("Header");
    expect(rendered).toContain("one");
    expect(rendered).toContain("two");
    expect(rendered).toContain("<td>");
  });
});
