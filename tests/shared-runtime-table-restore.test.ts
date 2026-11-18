import { describe, expect, it } from "vitest";
import {
  CollaborationError,
  type Command,
  type Cut,
  type DocumentState,
  type Receipt,
  type TableCommand,
} from "../src/collaboration/runtime/contract";
import { canonical } from "../src/collaboration/runtime/canonical";
import { initialState } from "../src/collaboration/runtime/document";
import {
  applyTable,
  seedTables,
} from "../src/collaboration/runtime/table-commands";
import { LocalHistory } from "../src/collaboration/runtime/local-history";
import type { Doc } from "../src/shared/types";

const INC = "inc-table-restore";
const TABLE = "t-restore";
const SCOPE = {
  orgId: "org",
  workspaceId: "workspace",
  documentId: "document",
  incarnationId: INC,
};

const cut = (seq: number): Cut => ({
  epoch: "epoch-1",
  seq,
  hash: `hash-${seq}`,
});

function accepted(seq: number, intentId: string): Receipt {
  return {
    v: 1,
    status: "SERVER_ACCEPTED",
    intentId,
    intentHash: "a".repeat(64),
    attemptId: `attempt-${seq}`,
    attemptHash: "b".repeat(64),
    writerId: "writer",
    scope: SCOPE,
    cut: cut(seq),
    resultHash: "c".repeat(64),
    code: null,
  };
}

function cell(
  id: string,
  text: string,
  type: "tableCell" | "tableHeader" = "tableCell",
  marked = false,
): Doc {
  return {
    type,
    attrs: { id },
    content: [
      {
        type: "paragraph",
        attrs: { id: `${id}-p` },
        content: text
          ? [
              {
                type: "text",
                text,
                ...(marked ? { marks: [{ type: "bold" as const }] } : {}),
              },
            ]
          : [],
      },
    ],
  };
}

function row(id: string, cells: Doc[]): Doc {
  return { type: "tableRow", attrs: { id }, content: cells };
}

function documentWith(rows: Doc[]): Doc {
  return {
    type: "doc",
    schemaVersion: 2,
    content: [
      {
        type: "paragraph",
        attrs: { id: "intro" },
        content: [{ type: "text", text: "intro" }],
      },
      { type: "table", attrs: { id: TABLE }, content: rows },
    ],
  };
}

function baseDoc(): Doc {
  return documentWith([
    row("r1", [
      cell("c11", "A", "tableHeader"),
      cell("c12", "B", "tableHeader"),
    ]),
    row("r2", [
      cell("c21", "C", "tableCell", true),
      cell("c22", "D", "tableCell", true),
    ]),
    row("r3", [cell("c31", "E"), cell("c32", "F")]),
  ]);
}

function find(node: Doc, id: string): Doc | undefined {
  if (node.attrs?.id === id) return node;
  for (const child of node.content ?? []) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return undefined;
}

function textOf(node: Doc): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(textOf).join("");
}

function subtreeIds(node: Doc): string[] {
  const ids: string[] = [];
  const walk = (current: Doc): void => {
    const id = current.attrs?.id;
    if (typeof id === "string") ids.push(id);
    for (const child of current.content ?? []) walk(child);
  };
  walk(node);
  return ids;
}

function seeded(document = baseDoc()): DocumentState {
  return seedTables(initialState(document), INC);
}

function tableOf(state: DocumentState): Doc {
  const table = find(state.document, TABLE);
  if (!table) throw new Error("missing table");
  return table;
}

function tableMetadataOf(state: DocumentState) {
  const metadata = state.tables.find((value) => value.tableId === TABLE);
  if (!metadata) throw new Error("missing table metadata");
  return metadata;
}

function allocator(...ids: string[]): () => string {
  let index = 0;
  return () => {
    const id = ids[index++];
    if (!id) throw new Error("unexpected allocation");
    return id;
  };
}

function codeOf(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof CollaborationError
      ? error.code
      : "NOT_COLLABORATION";
  }
}

function assertNoOldIds(state: DocumentState, ids: string[]): void {
  for (const id of ids) expect(find(state.document, id)).toBeUndefined();
}

describe("table.row.restore", () => {
  it("restores the exact deleted row with marks and fresh identities", () => {
    const base = seeded();
    const columnIds = [...tableMetadataOf(base).columnIds];
    const sourceRow = find(base.document, "r2")!;
    const oldIds = subtreeIds(sourceRow);
    const remove: TableCommand = {
      kind: "table.row.delete",
      tableId: TABLE,
      rowId: "r2",
    };
    const deleted = applyTable(base, remove, INC);
    const before = canonical(deleted.state);

    const restored = applyTable(
      deleted.state,
      {
        kind: "table.row.restore",
        tableId: TABLE,
        undoOf: "delete-intent",
        newRowId: "r2-new",
        beforeId: "r3",
        sourceRow,
        columnIds,
      },
      INC,
    );

    expect(canonical(deleted.state)).toBe(before);
    expect(tableMetadataOf(restored.state).rowIds).toEqual([
      "r1",
      "r2-new",
      "r3",
    ]);
    const restoredRow = find(restored.state.document, "r2-new")!;
    expect(restoredRow.type).toBe("tableRow");
    expect(textOf(restoredRow)).toBe("CD");
    const firstCell = restoredRow.content![0];
    expect(firstCell.content![0].content![0].marks?.[0]?.type).toBe("bold");
    expect(
      restoredRow.content![1].content![0].content![0].marks?.[0]?.type,
    ).toBe("bold");
    assertNoOldIds(restored.state, oldIds);
    for (const id of oldIds) expect(restored.state.tombstones).toContain(id);
    for (const id of subtreeIds(restoredRow))
      expect(restored.state.tombstones).not.toContain(id);
    expect(find(restored.state.document, "c12")).toBeDefined();
    expect(find(restored.state.document, "c22")).toBeUndefined();
  });

  it("keeps a concurrent inserted column and creates a deterministic empty cell", () => {
    const base = seeded();
    const sourceRow = find(base.document, "r2")!;
    const sourceColumns = [...tableMetadataOf(base).columnIds];
    const deleted = applyTable(
      base,
      { kind: "table.row.delete", tableId: TABLE, rowId: "r2" },
      INC,
    );
    const withColumn = applyTable(
      deleted.state,
      {
        kind: "table.column.insert",
        tableId: TABLE,
        columnId: "cB",
        beforeId: null,
      },
      INC,
    );

    const restored = applyTable(
      withColumn.state,
      {
        kind: "table.row.restore",
        tableId: TABLE,
        undoOf: "delete-intent",
        newRowId: "r2-new",
        beforeId: "r3",
        sourceRow,
        columnIds: sourceColumns,
      },
      INC,
    );

    expect(tableMetadataOf(restored.state).columnIds).toEqual([
      ...sourceColumns,
      "cB",
    ]);
    const restoredRow = find(restored.state.document, "r2-new")!;
    expect(restoredRow.content).toHaveLength(3);
    expect(textOf(restoredRow)).toBe("CD");
    expect(textOf(restoredRow.content![2])).toBe("");
    expect(find(restored.state.document, "cB")).toBeUndefined();
    expect(
      tableOf(restored.state).content!.every(
        (value) => value.content?.length === 3,
      ),
    ).toBe(true);
    expect(find(restored.state.document, "intro")).toBeDefined();
  });

  it("refuses to drop an authored source cell from a deleted column", () => {
    const base = seeded();
    const columnIds = [...tableMetadataOf(base).columnIds];
    const sourceRow = find(base.document, "r2")!;
    const deletedRow = applyTable(
      base,
      { kind: "table.row.delete", tableId: TABLE, rowId: "r2" },
      INC,
    );
    const deletedColumn = applyTable(
      deletedRow.state,
      {
        kind: "table.column.delete",
        tableId: TABLE,
        columnId: columnIds[1],
      },
      INC,
    );
    const before = canonical(deletedColumn.state);
    expect(
      codeOf(() =>
        applyTable(
          deletedColumn.state,
          {
            kind: "table.row.restore",
            tableId: TABLE,
            undoOf: "delete-intent",
            newRowId: "r2-new",
            beforeId: "r3",
            sourceRow,
            columnIds,
          },
          INC,
        ),
      ),
    ).toBe("HISTORY_CONFLICT");
    expect(canonical(deletedColumn.state)).toBe(before);
  });

  it("discards only a strictly empty source cell from a deleted column", () => {
    const document = documentWith([
      row("r1", [
        cell("c11", "A", "tableHeader"),
        cell("c12", "B", "tableHeader"),
      ]),
      row("r2", [cell("c21", "C"), cell("c22", "")]),
      row("r3", [cell("c31", "E"), cell("c32", "F")]),
    ]);
    const base = seeded(document);
    const columnIds = [...tableMetadataOf(base).columnIds];
    const sourceRow = find(base.document, "r2")!;
    const deletedRow = applyTable(
      base,
      { kind: "table.row.delete", tableId: TABLE, rowId: "r2" },
      INC,
    );
    const deletedColumn = applyTable(
      deletedRow.state,
      {
        kind: "table.column.delete",
        tableId: TABLE,
        columnId: columnIds[1],
      },
      INC,
    );
    const restored = applyTable(
      deletedColumn.state,
      {
        kind: "table.row.restore",
        tableId: TABLE,
        undoOf: "delete-intent",
        newRowId: "r2-new",
        beforeId: "r3",
        sourceRow,
        columnIds,
      },
      INC,
    );
    expect(tableMetadataOf(restored.state).columnIds).toEqual([columnIds[0]]);
    expect(textOf(find(restored.state.document, "r2-new")!)).toBe("C");
  });
});

describe("table.column.restore", () => {
  it("restores exact cells by row identity without reusing old identities", () => {
    const base = seeded();
    const metadata = tableMetadataOf(base);
    const sourceColumnId = metadata.columnIds[1];
    const sourceRows = tableOf(base).content!.map((sourceRow) => ({
      rowId: sourceRow.attrs!.id as string,
      cell: sourceRow.content![1],
    }));
    const oldIds = [
      sourceColumnId,
      ...sourceRows.flatMap((entry) => subtreeIds(entry.cell)),
    ];
    const deleted = applyTable(
      base,
      {
        kind: "table.column.delete",
        tableId: TABLE,
        columnId: sourceColumnId,
      },
      INC,
    );
    const before = canonical(deleted.state);

    const restored = applyTable(
      deleted.state,
      {
        kind: "table.column.restore",
        tableId: TABLE,
        undoOf: "delete-intent",
        newColumnId: "col-new",
        beforeId: null,
        sourceColumnId,
        rows: sourceRows,
      },
      INC,
    );

    expect(canonical(deleted.state)).toBe(before);
    expect(tableMetadataOf(restored.state).columnIds).toEqual([
      metadata.columnIds[0],
      "col-new",
    ]);
    const rows = tableOf(restored.state).content!;
    expect(rows.map(textOf)).toEqual(["AB", "CD", "EF"]);
    expect(rows[0].content![1].type).toBe("tableHeader");
    expect(rows[1].content![1].content![0].content![0].marks?.[0]?.type).toBe(
      "bold",
    );
    assertNoOldIds(restored.state, oldIds);
    for (const id of oldIds) expect(restored.state.tombstones).toContain(id);
    for (const rowNode of rows)
      for (const id of subtreeIds(rowNode.content![1]))
        expect(restored.state.tombstones).not.toContain(id);
  });

  it("keeps a concurrent inserted row and creates a deterministic empty cell", () => {
    const base = seeded();
    const metadata = tableMetadataOf(base);
    const sourceColumnId = metadata.columnIds[1];
    const sourceRows = tableOf(base).content!.map((sourceRow) => ({
      rowId: sourceRow.attrs!.id as string,
      cell: sourceRow.content![1],
    }));
    const deleted = applyTable(
      base,
      {
        kind: "table.column.delete",
        tableId: TABLE,
        columnId: sourceColumnId,
      },
      INC,
    );
    const withRow = applyTable(
      deleted.state,
      {
        kind: "table.row.insert",
        tableId: TABLE,
        rowId: "rA",
        beforeId: null,
      },
      INC,
    );

    const restored = applyTable(
      withRow.state,
      {
        kind: "table.column.restore",
        tableId: TABLE,
        undoOf: "delete-intent",
        newColumnId: "col-new",
        beforeId: null,
        sourceColumnId,
        rows: sourceRows,
      },
      INC,
    );

    expect(tableMetadataOf(restored.state).rowIds).toEqual([
      "r1",
      "r2",
      "r3",
      "rA",
    ]);
    const rows = tableOf(restored.state).content!;
    expect(rows.map(textOf)).toEqual(["AB", "CD", "EF", ""]);
    expect(rows[3].attrs?.id).toBe("rA");
    expect(rows[3].content).toHaveLength(2);
    expect(textOf(rows[3].content![1])).toBe("");
  });

  it("refuses to discard an authored cell from a row deleted later", () => {
    const base = seeded();
    const metadata = tableMetadataOf(base);
    const sourceColumnId = metadata.columnIds[1];
    const sourceRows = tableOf(base).content!.map((sourceRow) => ({
      rowId: sourceRow.attrs!.id as string,
      cell: sourceRow.content![1],
    }));
    const deletedColumn = applyTable(
      base,
      {
        kind: "table.column.delete",
        tableId: TABLE,
        columnId: sourceColumnId,
      },
      INC,
    );
    const deletedRow = applyTable(
      deletedColumn.state,
      { kind: "table.row.delete", tableId: TABLE, rowId: "r2" },
      INC,
    );
    const before = canonical(deletedRow.state);
    expect(
      codeOf(() =>
        applyTable(
          deletedRow.state,
          {
            kind: "table.column.restore",
            tableId: TABLE,
            undoOf: "delete-intent",
            newColumnId: "col-new",
            beforeId: null,
            sourceColumnId,
            rows: sourceRows,
          },
          INC,
        ),
      ),
    ).toBe("HISTORY_CONFLICT");
    expect(canonical(deletedRow.state)).toBe(before);
  });
});

describe("table restore validation", () => {
  it("refuses malformed sources, collisions and leaves input unchanged", () => {
    const base = seeded();
    const columnIds = [...tableMetadataOf(base).columnIds];
    const sourceRow = find(base.document, "r2")!;
    const deleted = applyTable(
      base,
      { kind: "table.row.delete", tableId: TABLE, rowId: "r2" },
      INC,
    );
    const before = canonical(deleted.state);

    expect(
      codeOf(() =>
        applyTable(
          deleted.state,
          {
            kind: "table.row.restore",
            tableId: TABLE,
            undoOf: "delete-intent",
            newRowId: "r2-new",
            beforeId: "r3",
            sourceRow: { type: "paragraph", attrs: { id: "bad" } },
            columnIds,
          },
          INC,
        ),
      ),
    ).not.toBeNull();
    expect(
      codeOf(() =>
        applyTable(
          deleted.state,
          {
            kind: "table.row.restore",
            tableId: TABLE,
            undoOf: "delete-intent",
            newRowId: "r2-new",
            beforeId: "r3",
            sourceRow,
            columnIds: columnIds.slice(0, 1),
          },
          INC,
        ),
      ),
    ).not.toBeNull();
    for (const newRowId of ["intro", columnIds[0], "r2"]) {
      expect(
        codeOf(() =>
          applyTable(
            deleted.state,
            {
              kind: "table.row.restore",
              tableId: TABLE,
              undoOf: "delete-intent",
              newRowId,
              beforeId: "r3",
              sourceRow,
              columnIds,
            },
            INC,
          ),
        ),
      ).toBe("ID_COLLISION");
    }
    expect(canonical(deleted.state)).toBe(before);
  });

  it("refuses malformed column sources, duplicate rows and collisions", () => {
    const base = seeded();
    const metadata = tableMetadataOf(base);
    const sourceColumnId = metadata.columnIds[1];
    const sourceRows = tableOf(base).content!.map((sourceRow) => ({
      rowId: sourceRow.attrs!.id as string,
      cell: sourceRow.content![1],
    }));
    const deleted = applyTable(
      base,
      {
        kind: "table.column.delete",
        tableId: TABLE,
        columnId: sourceColumnId,
      },
      INC,
    );
    const before = canonical(deleted.state);

    expect(
      codeOf(() =>
        applyTable(
          deleted.state,
          {
            kind: "table.column.restore",
            tableId: TABLE,
            undoOf: "delete-intent",
            newColumnId: "col-new",
            beforeId: null,
            sourceColumnId,
            rows: [...sourceRows, sourceRows[0]],
          },
          INC,
        ),
      ),
    ).not.toBeNull();
    expect(
      codeOf(() =>
        applyTable(
          deleted.state,
          {
            kind: "table.column.restore",
            tableId: TABLE,
            undoOf: "delete-intent",
            newColumnId: "col-new",
            beforeId: null,
            sourceColumnId,
            rows: [{ rowId: "r1", cell: { type: "paragraph" } }],
          },
          INC,
        ),
      ),
    ).not.toBeNull();
    for (const newColumnId of ["c11", metadata.columnIds[0], sourceColumnId]) {
      expect(
        codeOf(() =>
          applyTable(
            deleted.state,
            {
              kind: "table.column.restore",
              tableId: TABLE,
              undoOf: "delete-intent",
              newColumnId,
              beforeId: null,
              sourceColumnId,
              rows: sourceRows,
            },
            INC,
          ),
        ),
      ).toBe("ID_COLLISION");
    }
    expect(canonical(deleted.state)).toBe(before);
  });

  it("keeps delete undo unsupported without accepted receipt proof", () => {
    const base = seeded();
    const remove: TableCommand = {
      kind: "table.row.delete",
      tableId: TABLE,
      rowId: "r2",
    };
    const after = applyTable(base, remove, INC);
    const history = new LocalHistory();
    history.record(base, remove, after, cut(1));
    expect(codeOf(() => history.undo(after.state, [], allocator()))).toBe(
      "HISTORY_UNSUPPORTED",
    );
    expect(history.canUndo()).toBe(true);
  });
});

describe("LocalHistory table delete restore", () => {
  it("undoes a row delete with restore, confirms, redoes with delete of the fresh id", () => {
    const base = seeded();
    const sourceRow = find(base.document, "r2")!;
    const remove: TableCommand = {
      kind: "table.row.delete",
      tableId: TABLE,
      rowId: "r2",
    };
    const after = applyTable(base, remove, INC);
    const history = new LocalHistory();
    history.record(
      base,
      remove,
      after,
      cut(1),
      accepted(1, "intent-delete-r2"),
    );

    const undo = history.undo(after.state, [], allocator("fresh-r2-1"));
    const restore = undo.command as Extract<
      Command,
      { kind: "table.row.restore" }
    >;
    expect(restore).toMatchObject({
      kind: "table.row.restore",
      tableId: TABLE,
      undoOf: "intent-delete-r2",
      newRowId: "fresh-r2-1",
      beforeId: "r3",
      columnIds: tableMetadataOf(base).columnIds,
    });
    expect(restore.sourceRow).toEqual(sourceRow);

    const restored = applyTable(after.state, restore, INC);
    expect(textOf(find(restored.state.document, "fresh-r2-1")!)).toBe("CD");
    history.confirm(accepted(2, "intent-restore-r2"), restored.state);
    expect(history.canRedo()).toBe(true);

    const redo = history.redo(restored.state, [], allocator());
    expect(redo.command).toEqual({
      kind: "table.row.delete",
      tableId: TABLE,
      rowId: "fresh-r2-1",
    });
    const deletedAgain = applyTable(
      restored.state,
      redo.command as Extract<Command, { kind: "table.row.delete" }>,
      INC,
    );
    expect(find(deletedAgain.state.document, "fresh-r2-1")).toBeUndefined();
    history.confirm(accepted(3, "intent-delete-fresh-r2"), deletedAgain.state);

    const undoAgain = history.undo(
      deletedAgain.state,
      [],
      allocator("fresh-r2-2"),
    );
    expect(undoAgain.command).toMatchObject({
      kind: "table.row.restore",
      undoOf: "intent-delete-fresh-r2",
      newRowId: "fresh-r2-2",
    });
  });

  it("undoes a column delete with restore and redoes with delete of the fresh id", () => {
    const base = seeded();
    const metadata = tableMetadataOf(base);
    const sourceColumnId = metadata.columnIds[1];
    const remove: TableCommand = {
      kind: "table.column.delete",
      tableId: TABLE,
      columnId: sourceColumnId,
    };
    const after = applyTable(base, remove, INC);
    const history = new LocalHistory();
    history.record(
      base,
      remove,
      after,
      cut(1),
      accepted(1, "intent-delete-column"),
    );

    const undo = history.undo(after.state, [], allocator("fresh-column-1"));
    const restore = undo.command as Extract<
      Command,
      { kind: "table.column.restore" }
    >;
    expect(restore.kind).toBe("table.column.restore");
    expect(restore.undoOf).toBe("intent-delete-column");
    expect(restore.newColumnId).toBe("fresh-column-1");
    expect(restore.beforeId).toBeNull();
    expect(restore.sourceColumnId).toBe(sourceColumnId);
    expect(restore.rows).toHaveLength(3);
    expect(textOf(restore.rows[1].cell)).toBe("D");

    const restored = applyTable(after.state, restore, INC);
    expect(tableMetadataOf(restored.state).columnIds).toEqual([
      metadata.columnIds[0],
      "fresh-column-1",
    ]);
    history.confirm(accepted(2, "intent-restore-column"), restored.state);

    const redo = history.redo(restored.state, [], allocator());
    expect(redo.command).toEqual({
      kind: "table.column.delete",
      tableId: TABLE,
      columnId: "fresh-column-1",
    });
  });
});

describe("LocalHistory insertion undo and redo", () => {
  it("turns a confirmed insertion undo into a restore on redo", () => {
    const base = seeded();
    const insert: TableCommand = {
      kind: "table.row.insert",
      tableId: TABLE,
      rowId: "rA",
      beforeId: null,
    };
    const withRow = applyTable(base, insert, INC);
    const history = new LocalHistory();
    history.record(
      base,
      insert,
      withRow,
      cut(1),
      accepted(1, "intent-insert-row"),
    );

    const undo = history.undo(withRow.state, [], allocator());
    expect(undo.command).toEqual({
      kind: "table.row.delete",
      tableId: TABLE,
      rowId: "rA",
    });
    const deleted = applyTable(
      withRow.state,
      undo.command as Extract<Command, { kind: "table.row.delete" }>,
      INC,
    );
    history.confirm(accepted(2, "intent-delete-inserted-row"), deleted.state);

    const redo = history.redo(
      deleted.state,
      [],
      allocator("fresh-inserted-row"),
    );
    const restore = redo.command as Extract<
      Command,
      { kind: "table.row.restore" }
    >;
    expect(restore).toMatchObject({
      kind: "table.row.restore",
      tableId: TABLE,
      undoOf: "intent-delete-inserted-row",
      newRowId: "fresh-inserted-row",
      beforeId: null,
    });
    expect(restore.sourceRow.attrs?.id).toBe("rA");

    const restored = applyTable(deleted.state, restore, INC);
    expect(find(restored.state.document, "fresh-inserted-row")).toBeDefined();
    expect(find(restored.state.document, "rA")).toBeUndefined();
    history.confirm(accepted(3, "intent-restore-inserted-row"), restored.state);

    const undoRestore = history.undo(restored.state, [], allocator());
    expect(undoRestore.command).toEqual({
      kind: "table.row.delete",
      tableId: TABLE,
      rowId: "fresh-inserted-row",
    });
  });
});
