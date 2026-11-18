import { describe, expect, it } from "vitest";
import {
  CollaborationError,
  type DocumentState,
} from "../src/collaboration/runtime/contract";
import { initialState } from "../src/collaboration/runtime/document";
import { derivedId } from "../src/collaboration/runtime/digest";
import {
  applyTable,
  seedTables,
} from "../src/collaboration/runtime/table-commands";
import { MAX_TABLE_COLUMNS, MAX_TABLE_ROWS } from "../src/shared/rich-document";
import type { Doc } from "../src/shared/types";

const INC = "inc-1";
const TABLE = "table-a";
const COL0 = derivedId(INC, TABLE, "column", "0");
const COL1 = derivedId(INC, TABLE, "column", "1");

function cell(
  id: string,
  text: string,
  type: "tableCell" | "tableHeader" = "tableCell",
): Doc {
  return {
    type,
    attrs: { id },
    content: [
      {
        type: "paragraph",
        attrs: { id: `${id}-p` },
        content: text ? [{ type: "text", text }] : [],
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
    row("r2", [cell("c21", "C"), cell("c22", "D")]),
  ]);
}

function threeRowDoc(): Doc {
  return documentWith([
    row("r1", [
      cell("c11", "A", "tableHeader"),
      cell("c12", "B", "tableHeader"),
    ]),
    row("r2", [cell("c21", "C"), cell("c22", "D")]),
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

function seeded(document = baseDoc()): DocumentState {
  return seedTables(initialState(document), INC);
}

function tableOf(state: DocumentState): Doc {
  const table = find(state.document, TABLE);
  expect(table).toBeDefined();
  return table!;
}

function rowIds(state: DocumentState): string[] {
  return state.tables[0].rowIds;
}

describe("seedTables", () => {
  it("derives column identities and keeps existing cells and paragraphs", () => {
    const initial = initialState(baseDoc());
    const state = seedTables(initial, INC);
    expect(state.tables).toEqual([
      { tableId: TABLE, rowIds: ["r1", "r2"], columnIds: [COL0, COL1] },
    ]);
    expect(find(state.document, "c22")).toEqual(find(initial.document, "c22"));
    expect(find(state.document, "c22-p")).toEqual(
      find(initial.document, "c22-p"),
    );
    expect(textOf(find(state.document, "c22")!)).toBe("D");
    expect(state.tombstones).toEqual([]);
  });

  it("is repeatable for an unchanged seeded state", () => {
    const once = seeded();
    const twice = seedTables(once, INC);
    expect(twice).toEqual(once);
  });

  it("refuses duplicate document identities without mutating input", () => {
    const document = baseDoc();
    document.content![0].attrs = { id: "c11" };
    const state: DocumentState = { document, tables: [], tombstones: [] };
    const before = JSON.stringify(state);
    expect(() => seedTables(state, INC)).toThrow(CollaborationError);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("refuses a column identity that collides with a live node", () => {
    const document = baseDoc();
    const seededState = seedTables(initialState(document), INC);
    const doomed = {
      ...seededState,
      tables: [
        {
          tableId: TABLE,
          rowIds: ["r1", "r2"],
          columnIds: ["c11", COL1],
        },
      ],
    };
    expect(() =>
      applyTable(
        doomed,
        {
          kind: "table.row.insert",
          tableId: TABLE,
          rowId: "r9",
          beforeId: null,
        },
        INC,
      ),
    ).toThrow(CollaborationError);
  });
});

describe("table insertions", () => {
  it("appends a row with derived cell and paragraph identities", () => {
    const state = seeded();
    const before = JSON.stringify(state);
    const result = applyTable(
      state,
      {
        kind: "table.row.insert",
        tableId: TABLE,
        rowId: "r3",
        beforeId: null,
      },
      INC,
    );
    expect(result.appliedText).toBeNull();
    expect(rowIds(result.state)).toEqual(["r1", "r2", "r3"]);
    const table = tableOf(result.state);
    expect(table.content).toHaveLength(3);
    const inserted = table.content![2];
    expect(inserted.attrs?.id).toBe("r3");
    expect(inserted.content!.map((value) => value.attrs?.id)).toEqual([
      derivedId(INC, TABLE, "r3", COL0, "cell"),
      derivedId(INC, TABLE, "r3", COL1, "cell"),
    ]);
    expect(inserted.content![0].content![0].attrs?.id).toBe(
      derivedId(INC, TABLE, "r3", COL0, "paragraph"),
    );
    expect(textOf(inserted)).toBe("");
    expect(JSON.stringify(state)).toBe(before);
  });

  it("inserts a row before a logical row identity", () => {
    const state = seeded();
    const result = applyTable(
      state,
      {
        kind: "table.row.insert",
        tableId: TABLE,
        rowId: "r3",
        beforeId: "r2",
      },
      INC,
    );
    expect(rowIds(result.state)).toEqual(["r1", "r3", "r2"]);
    expect(
      tableOf(result.state).content!.map((value) => value.attrs?.id),
    ).toEqual(["r1", "r3", "r2"]);
    expect(textOf(find(result.state.document, "c22")!)).toBe("D");
  });

  it("inserts a column without changing existing cell ownership", () => {
    const state = seeded();
    const result = applyTable(
      state,
      {
        kind: "table.column.insert",
        tableId: TABLE,
        columnId: "c3",
        beforeId: COL1,
      },
      INC,
    );
    expect(result.appliedText).toBeNull();
    expect(result.state.tables[0].columnIds).toEqual([COL0, "c3", COL1]);
    const table = tableOf(result.state);
    for (const [index, rowId] of ["r1", "r2"].entries()) {
      const target = table.content![index];
      expect(target.content).toHaveLength(3);
      const inserted = target.content![1];
      expect(inserted.attrs?.id).toBe(
        derivedId(INC, TABLE, rowId, "c3", "cell"),
      );
      expect(inserted.type).toBe(index === 0 ? "tableHeader" : "tableCell");
    }
    expect(textOf(find(result.state.document, "c12")!)).toBe("B");
    expect(textOf(find(result.state.document, "c22")!)).toBe("D");
  });

  it("retains an existing marked cell through both insertions", () => {
    const document = baseDoc();
    const marked = find(document, "c22")!;
    marked.content![0].content = [
      { type: "text", text: "marked", marks: [{ type: "bold" }] },
    ];
    const state = seeded(document);
    const afterRow = applyTable(
      state,
      {
        kind: "table.row.insert",
        tableId: TABLE,
        rowId: "r3",
        beforeId: null,
      },
      INC,
    ).state;
    const afterColumn = applyTable(
      afterRow,
      {
        kind: "table.column.insert",
        tableId: TABLE,
        columnId: "c3",
        beforeId: null,
      },
      INC,
    ).state;
    const retained = find(afterColumn.document, "c22")!;
    expect(retained.attrs?.id).toBe("c22");
    const markedText = retained.content![0].content![0];
    expect(markedText.text).toBe("marked");
    expect(markedText.marks?.[0]?.type).toBe("bold");
  });

  it("produces the same state for row then column and column then row", () => {
    const state = seeded();
    const rowCommand = {
      kind: "table.row.insert" as const,
      tableId: TABLE,
      rowId: "r3",
      beforeId: null,
    };
    const columnCommand = {
      kind: "table.column.insert" as const,
      tableId: TABLE,
      columnId: "c3",
      beforeId: null,
    };
    const rowThenColumn = applyTable(
      applyTable(state, rowCommand, INC).state,
      columnCommand,
      INC,
    ).state;
    const columnThenRow = applyTable(
      applyTable(state, columnCommand, INC).state,
      rowCommand,
      INC,
    ).state;
    expect(JSON.stringify(rowThenColumn.document)).toBe(
      JSON.stringify(columnThenRow.document),
    );
    expect(rowThenColumn.tables).toEqual(columnThenRow.tables);
    expect(rowThenColumn.tombstones).toEqual(columnThenRow.tombstones);

    const table = tableOf(rowThenColumn);
    const insertedRow = table.content![2];
    expect(insertedRow.attrs?.id).toBe("r3");
    const intersection = insertedRow.content!.find(
      (value) => value.attrs?.id === derivedId(INC, TABLE, "r3", "c3", "cell"),
    );
    expect(intersection).toBeDefined();
    expect(intersection!.content![0].attrs?.id).toBe(
      derivedId(INC, TABLE, "r3", "c3", "paragraph"),
    );
    expect(textOf(intersection!)).toBe("");
    expect(textOf(find(rowThenColumn.document, "c22")!)).toBe("D");
  });

  it("inserts before a column in both operation orders", () => {
    const state = seeded();
    const rowCommand = {
      kind: "table.row.insert" as const,
      tableId: TABLE,
      rowId: "r3",
      beforeId: "r2",
    };
    const columnCommand = {
      kind: "table.column.insert" as const,
      tableId: TABLE,
      columnId: "c3",
      beforeId: COL0,
    };
    const a = applyTable(
      applyTable(state, rowCommand, INC).state,
      columnCommand,
      INC,
    ).state;
    const b = applyTable(
      applyTable(state, columnCommand, INC).state,
      rowCommand,
      INC,
    ).state;
    expect(a.tables).toEqual(b.tables);
    expect(JSON.stringify(a.document)).toBe(JSON.stringify(b.document));
    expect(a.tables[0].columnIds).toEqual(["c3", COL0, COL1]);
    expect(a.tables[0].rowIds).toEqual(["r1", "r3", "r2"]);
  });
});

describe("table deletions", () => {
  it("tombstones every removed row identity and refuses reuse", () => {
    const state = seeded(threeRowDoc());
    const result = applyTable(
      state,
      { kind: "table.row.delete", tableId: TABLE, rowId: "r2" },
      INC,
    );
    expect(result.appliedText).toBeNull();
    expect(rowIds(result.state)).toEqual(["r1", "r3"]);
    expect(find(result.state.document, "r2")).toBeUndefined();
    expect(find(result.state.document, "c21")).toBeUndefined();
    expect(result.state.tombstones).toEqual(
      expect.arrayContaining(["r2", "c21", "c21-p", "c22", "c22-p"]),
    );
    expect(() =>
      applyTable(
        result.state,
        {
          kind: "table.row.insert",
          tableId: TABLE,
          rowId: "r2",
          beforeId: null,
        },
        INC,
      ),
    ).toThrow(CollaborationError);
  });

  it("tombstones every removed column identity and refuses reuse", () => {
    const state = seeded();
    const result = applyTable(
      state,
      { kind: "table.column.delete", tableId: TABLE, columnId: COL0 },
      INC,
    );
    expect(result.state.tables[0].columnIds).toEqual([COL1]);
    const survivingCells = tableOf(result.state).content!.map(
      (rowNode) => rowNode.content![0].attrs?.id,
    );
    expect(survivingCells).toEqual(["c12", "c22"]);
    expect(result.state.tombstones).toEqual(
      expect.arrayContaining([COL0, "c11", "c11-p", "c21", "c21-p"]),
    );
    expect(textOf(find(result.state.document, "c12")!)).toBe("B");
    expect(() =>
      applyTable(
        result.state,
        {
          kind: "table.column.insert",
          tableId: TABLE,
          columnId: COL0,
          beforeId: null,
        },
        INC,
      ),
    ).toThrow(CollaborationError);
  });

  it("refuses to delete the final row or column without change", () => {
    const state = seeded(documentWith([row("only", [cell("only-c", "x")])]));
    const before = JSON.stringify(state);
    expect(() =>
      applyTable(
        state,
        { kind: "table.row.delete", tableId: TABLE, rowId: "only" },
        INC,
      ),
    ).toThrow(CollaborationError);
    expect(() =>
      applyTable(
        state,
        { kind: "table.column.delete", tableId: TABLE, columnId: COL0 },
        INC,
      ),
    ).toThrow(CollaborationError);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("refuses a repeated delete and leaves the state unchanged", () => {
    const state = seeded(threeRowDoc());
    const once = applyTable(
      state,
      { kind: "table.row.delete", tableId: TABLE, rowId: "r2" },
      INC,
    ).state;
    const before = JSON.stringify(once);
    expect(() =>
      applyTable(
        once,
        { kind: "table.row.delete", tableId: TABLE, rowId: "r2" },
        INC,
      ),
    ).toThrow(CollaborationError);
    expect(JSON.stringify(once)).toBe(before);
  });
});

describe("table validation", () => {
  it("refuses missing targets", () => {
    const state = seeded();
    expect(() =>
      applyTable(
        state,
        { kind: "table.row.delete", tableId: "missing", rowId: "r1" },
        INC,
      ),
    ).toThrow(CollaborationError);
    expect(() =>
      applyTable(
        state,
        {
          kind: "table.row.insert",
          tableId: TABLE,
          rowId: "r9",
          beforeId: "missing",
        },
        INC,
      ),
    ).toThrow(CollaborationError);
    expect(() =>
      applyTable(
        state,
        {
          kind: "table.column.insert",
          tableId: TABLE,
          columnId: "c9",
          beforeId: "missing",
        },
        INC,
      ),
    ).toThrow(CollaborationError);
    expect(() =>
      applyTable(
        state,
        { kind: "table.column.delete", tableId: TABLE, columnId: "missing" },
        INC,
      ),
    ).toThrow(CollaborationError);
  });

  it("refuses duplicate and missing metadata", () => {
    const state = seeded();
    const drifted = {
      ...state,
      tables: [{ ...state.tables[0], rowIds: ["r2", "r1"] }],
    };
    expect(() =>
      applyTable(
        drifted,
        {
          kind: "table.row.insert",
          tableId: TABLE,
          rowId: "r9",
          beforeId: null,
        },
        INC,
      ),
    ).toThrow(CollaborationError);

    const short = {
      ...state,
      tables: [{ ...state.tables[0], columnIds: [COL0] }],
    };
    expect(() =>
      applyTable(
        short,
        {
          kind: "table.column.insert",
          tableId: TABLE,
          columnId: "c9",
          beforeId: null,
        },
        INC,
      ),
    ).toThrow(CollaborationError);

    const unseeded = { ...state, tables: [] };
    expect(() =>
      applyTable(
        unseeded,
        {
          kind: "table.row.insert",
          tableId: TABLE,
          rowId: "r9",
          beforeId: null,
        },
        INC,
      ),
    ).toThrow(CollaborationError);

    const duplicate = {
      ...state,
      tables: [state.tables[0], state.tables[0]],
    };
    expect(() =>
      applyTable(
        duplicate,
        {
          kind: "table.row.insert",
          tableId: TABLE,
          rowId: "r9",
          beforeId: null,
        },
        INC,
      ),
    ).toThrow(CollaborationError);
  });

  it("refuses global identity collisions", () => {
    const state = seeded();
    for (const rowId of ["c11", "r1", COL0]) {
      expect(() =>
        applyTable(
          state,
          {
            kind: "table.row.insert",
            tableId: TABLE,
            rowId,
            beforeId: null,
          },
          INC,
        ),
      ).toThrow(CollaborationError);
    }
    for (const columnId of ["c11", "r1", COL1]) {
      expect(() =>
        applyTable(
          state,
          {
            kind: "table.column.insert",
            tableId: TABLE,
            columnId,
            beforeId: null,
          },
          INC,
        ),
      ).toThrow(CollaborationError);
    }
  });

  it("refuses live identities already tombstoned and duplicate tombstones", () => {
    const state = seeded();
    const reused = { ...state, tombstones: ["c11"] };
    expect(() =>
      applyTable(
        reused,
        {
          kind: "table.row.insert",
          tableId: TABLE,
          rowId: "r9",
          beforeId: null,
        },
        INC,
      ),
    ).toThrow(CollaborationError);

    const duplicated = { ...state, tombstones: ["gone", "gone"] };
    expect(() =>
      applyTable(
        duplicated,
        {
          kind: "table.row.insert",
          tableId: TABLE,
          rowId: "r9",
          beforeId: null,
        },
        INC,
      ),
    ).toThrow(CollaborationError);
  });

  it("refuses invalid identifiers", () => {
    const state = seeded();
    for (const rowId of ["", "x".repeat(129)]) {
      expect(() =>
        applyTable(
          state,
          {
            kind: "table.row.insert",
            tableId: TABLE,
            rowId,
            beforeId: null,
          },
          INC,
        ),
      ).toThrow(CollaborationError);
    }
    expect(() =>
      applyTable(
        state,
        {
          kind: "table.row.insert",
          tableId: TABLE,
          rowId: "r9",
          beforeId: null,
        },
        "",
      ),
    ).toThrow(CollaborationError);
  });

  it("enforces the row and column limits", () => {
    const rows = Array.from({ length: MAX_TABLE_ROWS }, (_, index) =>
      row(`r${index}`, [cell(`c${index}`, "")]),
    );
    const tall = seeded(documentWith(rows));
    const tallBefore = JSON.stringify(tall);
    expect(() =>
      applyTable(
        tall,
        {
          kind: "table.row.insert",
          tableId: TABLE,
          rowId: "overflow",
          beforeId: null,
        },
        INC,
      ),
    ).toThrow(CollaborationError);
    expect(JSON.stringify(tall)).toBe(tallBefore);

    const wideCells = Array.from({ length: MAX_TABLE_COLUMNS }, (_, index) =>
      cell(`k${index}`, ""),
    );
    const wide = seeded(documentWith([row("wide", wideCells)]));
    const wideBefore = JSON.stringify(wide);
    expect(() =>
      applyTable(
        wide,
        {
          kind: "table.column.insert",
          tableId: TABLE,
          columnId: "overflow",
          beforeId: null,
        },
        INC,
      ),
    ).toThrow(CollaborationError);
    expect(JSON.stringify(wide)).toBe(wideBefore);
  });

  it("does not mutate the supplied state on a failed insertion", () => {
    const state = seeded();
    const before = JSON.stringify(state);
    expect(() =>
      applyTable(
        state,
        {
          kind: "table.column.insert",
          tableId: TABLE,
          columnId: "c11",
          beforeId: null,
        },
        INC,
      ),
    ).toThrow(CollaborationError);
    expect(JSON.stringify(state)).toBe(before);
  });
});
