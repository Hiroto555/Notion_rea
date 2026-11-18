import { describe, expect, it } from "vitest";
import type { Doc } from "../src/shared/types";
import { canonical } from "../src/collaboration/runtime/canonical";
import {
  CollaborationError,
  type DocumentState,
  type SemanticResult,
  type TableCommand,
} from "../src/collaboration/runtime/contract";
import { initialState } from "../src/collaboration/runtime/document";
import { applyBlock } from "../src/collaboration/runtime/block-commands";
import {
  applyTable,
  seedTables,
} from "../src/collaboration/runtime/table-commands";

type Mark = { type: string; attrs?: Record<string, unknown> };

const text = (value: string, marks?: Mark[]): Doc => ({
  type: "text",
  text: value,
  ...(marks ? { marks } : {}),
});

const paragraph = (id: string, content: Doc[] = []): Doc => ({
  type: "paragraph",
  attrs: { id },
  ...(content.length ? { content } : {}),
});

const heading = (id: string, level: number, value: string): Doc => ({
  type: "heading",
  attrs: { id, level },
  content: [text(value)],
});

const blockquote = (id: string, content: Doc[]): Doc => ({
  type: "blockquote",
  attrs: { id },
  content,
});

const cell = (
  type: "tableCell" | "tableHeader",
  id: string,
  paragraphId: string,
  value = "",
): Doc => ({
  type,
  attrs: { id },
  content: [paragraph(paragraphId, value ? [text(value)] : [])],
});

const row = (id: string, cells: Doc[]): Doc => ({
  type: "tableRow",
  attrs: { id },
  content: cells,
});

const tableNode = (id: string, rows: Doc[]): Doc => ({
  type: "table",
  attrs: { id },
  content: rows,
});

const plainDoc = (): Doc => ({
  type: "doc",
  schemaVersion: 2,
  content: [paragraph("p1", [text("hello")])],
});

const focusDoc = (): Doc => ({
  type: "doc",
  schemaVersion: 2,
  content: [
    paragraph("p1", [
      text("AB", [{ type: "bold" }]),
      text("CD", [{ type: "italic" }]),
    ]),
    paragraph("p2", [text("tail")]),
    paragraph("p3", [text("more")]),
  ],
});

const tableDoc = (): Doc => ({
  type: "doc",
  schemaVersion: 2,
  content: [
    paragraph("intro", [text("intro")]),
    tableNode("t1", [
      row("r1", [
        cell("tableHeader", "h11", "h11p", "A"),
        cell("tableHeader", "h12", "h12p", "B"),
      ]),
      row("r2", [
        cell("tableCell", "c21", "c21p", "C"),
        cell("tableCell", "c22", "c22p", "D"),
      ]),
    ]),
  ],
});

const tableAndQuoteDoc = (): Doc => ({
  type: "doc",
  schemaVersion: 2,
  content: [
    tableNode("t1", [
      row("r1", [cell("tableHeader", "h11", "h11p", "A")]),
      row("r2", [cell("tableCell", "c21", "c21p", "B")]),
    ]),
    blockquote("b1", [paragraph("bp1", [text("quote")])]),
  ],
});

const seeded = (doc: Doc = tableDoc()): DocumentState =>
  seedTables(initialState(doc), "inc");

const snapshot = (state: DocumentState): string => JSON.stringify(state);

function thrownCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof CollaborationError) return error.code;
    throw error;
  }
  throw new Error("EXPECTED_REFUSAL");
}

function findNode(node: Doc, id: string): Doc | undefined {
  if (node.attrs?.id === id) return node;
  for (const child of node.content ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

function docTables(node: Doc): Doc[] {
  const found: Doc[] = [];
  const stack: Doc[] = [node];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.type === "table") found.push(current);
    stack.push(...(current.content ?? []));
  }
  return found;
}

function liveIds(node: Doc): Set<string> {
  const found = new Set<string>();
  const stack: Doc[] = [node];
  while (stack.length) {
    const current = stack.pop()!;
    if (typeof current.attrs?.id === "string") found.add(current.attrs.id);
    stack.push(...(current.content ?? []));
  }
  return found;
}

function tableMetadata(state: DocumentState, tableId: string) {
  return state.tables.find((value) => value.tableId === tableId);
}

function assertMetadataConsistent(state: DocumentState): void {
  const tables = docTables(state.document);
  expect(state.tables.map((value) => value.tableId).sort()).toEqual(
    tables.map((value) => value.attrs!.id).sort(),
  );
  const live = liveIds(state.document);
  const columns = new Set(state.tables.flatMap((value) => value.columnIds));
  for (const table of tables) {
    const id = table.attrs!.id as string;
    const metadata = tableMetadata(state, id);
    expect(metadata).toBeDefined();
    expect(live.has(id)).toBe(true);
    expect(metadata!.rowIds).toEqual(
      (table.content ?? []).map((child) => child.attrs!.id),
    );
    for (const rowId of metadata!.rowIds) expect(live.has(rowId)).toBe(true);
    expect(metadata!.columnIds.length).toBe(
      (table.content ?? [])[0]?.content?.length ?? 0,
    );
    for (const columnId of metadata!.columnIds) {
      expect(columns.has(columnId)).toBe(true);
      expect(live.has(columnId)).toBe(false);
      expect(state.tombstones).not.toContain(columnId);
    }
  }
  for (const tombstone of state.tombstones) {
    expect(live.has(tombstone)).toBe(false);
    expect(columns.has(tombstone)).toBe(false);
  }
}

function inlineSegments(node: Doc): { text: string; marks: string[] }[] {
  const merged: { text: string; marks: string[] }[] = [];
  for (const child of node.content ?? []) {
    if (child.type !== "text") continue;
    const segment = {
      text: child.text ?? "",
      marks: (child.marks ?? []).map((mark) => mark.type).sort(),
    };
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.marks.length === segment.marks.length &&
      previous.marks.every((mark, index) => mark === segment.marks[index])
    )
      previous.text += segment.text;
    else merged.push(segment);
  }
  return merged;
}

describe("canonical", () => {
  it("sorts object keys deterministically and preserves raw Unicode", () => {
    expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonical("日本語")).toBe('"日本語"');
    expect(canonical("😀")).toBe('"😀"');
    expect(canonical({ 名: "前" })).toBe('{"名":"前"}');
  });

  it("rejects lone surrogates with UNICODE", () => {
    expect(thrownCode(() => canonical("a\uD800b"))).toBe("UNICODE");
    expect(thrownCode(() => canonical("\uDC00"))).toBe("UNICODE");
    expect(thrownCode(() => canonical({ ["\uD800"]: 1 }))).toBe(
      "INVALID_ACCESSOR",
    );
  });

  it("rejects accessors instead of invoking them", () => {
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "x", {
      enumerable: true,
      get: () => 1,
    });
    expect(thrownCode(() => canonical(accessor))).toBe("INVALID_ACCESSOR");

    const array: unknown[] = [];
    Object.defineProperty(array, "0", { enumerable: true, get: () => 1 });
    array.length = 1;
    expect(thrownCode(() => canonical(array))).toBe("INVALID_ARRAY");
  });

  it("rejects hidden keys, symbols, unsafe numbers and cycles", () => {
    const hidden: Record<string, unknown> = {};
    Object.defineProperty(hidden, "x", { enumerable: false, value: 1 });
    expect(thrownCode(() => canonical(hidden))).toBe("INVALID_OBJECT");
    expect(thrownCode(() => canonical({ [Symbol("s")]: 1 }))).toBe(
      "INVALID_JSON",
    );
    expect(thrownCode(() => canonical(-0))).toBe("UNSAFE_NUMBER");
    expect(thrownCode(() => canonical(Number.NaN))).toBe("UNSAFE_NUMBER");
    expect(thrownCode(() => canonical(Number.MAX_SAFE_INTEGER + 1))).toBe(
      "UNSAFE_NUMBER",
    );
    expect(thrownCode(() => canonical(1n))).toBe("INVALID_JSON");
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(thrownCode(() => canonical(cycle))).toBe("INVALID_JSON");
    expect(thrownCode(() => canonical(new Date(0)))).toBe("INVALID_OBJECT");
    const sparse: unknown[] = [];
    sparse.length = 3;
    sparse[0] = "x";
    sparse[2] = "z";
    expect(thrownCode(() => canonical(sparse))).toBe("INVALID_ARRAY");
    expect(thrownCode(() => canonical({ a: 1 }, 2))).toBe("JSON_LIMIT");
  });

  it("allows repeated shared references that are not cycles", () => {
    const shared = { a: 1 };
    expect(canonical({ left: shared, right: shared })).toBe(
      '{"left":{"a":1},"right":{"a":1}}',
    );
  });
});

describe("block structure", () => {
  it("inserts, moves and deletes blocks without changing the caller input", () => {
    const state = initialState(focusDoc());
    const before = snapshot(state);
    const inserted = applyBlock(state, {
      kind: "block.insert",
      parentId: null,
      beforeId: "p2",
      node: paragraph("p0", [text("new")]),
    });
    expect(
      inserted.state.document.content!.map((node) => node.attrs!.id),
    ).toEqual(["p1", "p0", "p2", "p3"]);

    const moved = applyBlock(inserted.state, {
      kind: "block.move",
      blockId: "p3",
      parentId: null,
      beforeId: "p1",
    });
    expect(moved.state.document.content!.map((node) => node.attrs!.id)).toEqual(
      ["p3", "p1", "p0", "p2"],
    );

    const deleted = applyBlock(moved.state, {
      kind: "block.delete",
      blockId: "p0",
    });
    expect(
      deleted.state.document.content!.map((node) => node.attrs!.id),
    ).toEqual(["p3", "p1", "p2"]);
    expect(deleted.state.tombstones).toContain("p0");
    expect(snapshot(state)).toBe(before);
  });

  it("refuses duplicate, tombstoned and missing insert identities", () => {
    const state = initialState(focusDoc());
    expect(
      thrownCode(() =>
        applyBlock(state, {
          kind: "block.insert",
          parentId: null,
          beforeId: null,
          node: paragraph("p1"),
        }),
      ),
    ).toBe("DUPLICATE_ID");

    const deleted = applyBlock(state, { kind: "block.delete", blockId: "p2" });
    expect(
      thrownCode(() =>
        applyBlock(deleted.state, {
          kind: "block.insert",
          parentId: null,
          beforeId: null,
          node: paragraph("p2"),
        }),
      ),
    ).toBe("TOMBSTONED_ID");
    expect(
      thrownCode(() =>
        applyBlock(state, {
          kind: "block.insert",
          parentId: null,
          beforeId: "missing",
          node: paragraph("p9"),
        }),
      ),
    ).toBe("INVALID_ANCHOR");
    expect(
      thrownCode(() =>
        applyBlock(state, {
          kind: "block.insert",
          parentId: null,
          beforeId: null,
          node: { type: "text", text: "no" },
        }),
      ),
    ).toBe("INVALID_BLOCK_NODE");
  });

  it("refuses cycles and moving a block into a table cell", () => {
    const doc: Doc = {
      type: "doc",
      content: [
        blockquote("b1", [blockquote("b2", [paragraph("p1", [text("x")])])]),
      ],
    };
    const state = initialState(doc);
    expect(
      thrownCode(() =>
        applyBlock(state, {
          kind: "block.move",
          blockId: "b1",
          parentId: "b2",
          beforeId: null,
        }),
      ),
    ).toBe("CYCLE");

    const tableState = seeded();
    expect(
      thrownCode(() =>
        applyBlock(tableState, {
          kind: "block.move",
          blockId: "intro",
          parentId: "h11",
          beforeId: null,
        }),
      ),
    ).toBe("TABLE_INTERNAL");
    expect(
      thrownCode(() =>
        applyBlock(tableState, {
          kind: "block.delete",
          blockId: "h11p",
        }),
      ),
    ).toBe("TABLE_INTERNAL");
  });

  it("rejects stale replaces, id mismatches and tombstoned replacement ids", () => {
    const state = initialState(focusDoc());
    const before = findNode(state.document, "p1")!;
    expect(
      thrownCode(() =>
        applyBlock(state, {
          kind: "block.replace",
          blockId: "p1",
          before: paragraph("p1", [text("wrong")]),
          node: paragraph("p1", [text("ok")]),
        }),
      ),
    ).toBe("STALE_REPLACE");
    expect(
      thrownCode(() =>
        applyBlock(state, {
          kind: "block.replace",
          blockId: "p1",
          before,
          node: paragraph("pX", [text("ok")]),
        }),
      ),
    ).toBe("REPLACE_ID_MISMATCH");

    const deleted = applyBlock(state, { kind: "block.delete", blockId: "p2" });
    expect(
      thrownCode(() =>
        applyBlock(deleted.state, {
          kind: "block.replace",
          blockId: "p1",
          before: findNode(deleted.state.document, "p1")!,
          node: blockquote("p1", [paragraph("p2")]),
        }),
      ),
    ).toBe("TOMBSTONED_ID");
  });

  it("tombstones descendants that disappear during replace and refuses their reuse", () => {
    const doc: Doc = {
      type: "doc",
      content: [
        blockquote("b1", [
          paragraph("p1", [text("one")]),
          paragraph("p2", [text("two")]),
        ]),
      ],
    };
    const state = initialState(doc);
    const replaced = applyBlock(state, {
      kind: "block.replace",
      blockId: "b1",
      before: findNode(state.document, "b1")!,
      node: blockquote("b1", [paragraph("p1", [text("one")])]),
    });
    expect(findNode(replaced.state.document, "p2")).toBeUndefined();
    expect(replaced.state.tombstones).toContain("p2");
    expect(
      thrownCode(() =>
        applyBlock(replaced.state, {
          kind: "block.insert",
          parentId: null,
          beforeId: null,
          node: paragraph("p2", [text("again")]),
        }),
      ),
    ).toBe("TOMBSTONED_ID");
    expect(
      thrownCode(() =>
        applyBlock(replaced.state, {
          kind: "block.split",
          blockId: "p1",
          offset: 0,
          newId: "p2",
        }),
      ),
    ).toBe("TOMBSTONED_ID");
  });

  it("splits on Unicode boundaries and preserves marks on both halves", () => {
    const state = initialState(focusDoc());
    const split = applyBlock(state, {
      kind: "block.split",
      blockId: "p1",
      offset: 1,
      newId: "p1b",
    });
    expect(split.state.document.content!.map((node) => node.attrs!.id)).toEqual(
      ["p1", "p1b", "p2", "p3"],
    );
    expect(inlineSegments(findNode(split.state.document, "p1")!)).toEqual([
      { text: "A", marks: ["bold"] },
    ]);
    expect(inlineSegments(findNode(split.state.document, "p1b")!)).toEqual([
      { text: "B", marks: ["bold"] },
      { text: "CD", marks: ["italic"] },
    ]);

    const joined = applyBlock(split.state, {
      kind: "block.join",
      leftId: "p1",
      rightId: "p1b",
    });
    expect(inlineSegments(findNode(joined.state.document, "p1")!)).toEqual(
      inlineSegments(findNode(state.document, "p1")!),
    );
    expect(joined.state.tombstones).toContain("p1b");
  });

  it("refuses surrogate splits and invalid split offsets", () => {
    const doc: Doc = {
      type: "doc",
      content: [paragraph("p1", [text("A😀B")])],
    };
    const state = initialState(doc);
    expect(
      thrownCode(() =>
        applyBlock(state, {
          kind: "block.split",
          blockId: "p1",
          offset: 2,
          newId: "p2",
        }),
      ),
    ).toBe("SPLIT_UNICODE");
    expect(
      thrownCode(() =>
        applyBlock(state, {
          kind: "block.split",
          blockId: "p1",
          offset: 99,
          newId: "p2",
        }),
      ),
    ).toBe("INVALID_OFFSET");
    expect(
      thrownCode(() =>
        applyBlock(state, {
          kind: "block.split",
          blockId: "p1",
          offset: -1,
          newId: "p2",
        }),
      ),
    ).toBe("INVALID_OFFSET");

    const ok = applyBlock(state, {
      kind: "block.split",
      blockId: "p1",
      offset: 3,
      newId: "p2",
    });
    expect(inlineSegments(findNode(ok.state.document, "p1")!)).toEqual([
      { text: "A😀", marks: [] },
    ]);
    expect(inlineSegments(findNode(ok.state.document, "p2")!)).toEqual([
      { text: "B", marks: [] },
    ]);
  });

  it("requires adjacency and compatible attributes for join", () => {
    const state = initialState(focusDoc());
    expect(
      thrownCode(() =>
        applyBlock(state, {
          kind: "block.join",
          leftId: "p1",
          rightId: "p3",
        }),
      ),
    ).toBe("NOT_ADJACENT");

    const headings: Doc = {
      type: "doc",
      content: [heading("h1", 1, "a"), heading("h2", 2, "b")],
    };
    expect(
      thrownCode(() =>
        applyBlock(initialState(headings), {
          kind: "block.join",
          leftId: "h1",
          rightId: "h2",
        }),
      ),
    ).toBe("INCOMPATIBLE_JOIN");
  });

  it("refuses inserting a nested table inside a table cell", () => {
    const state = seeded();
    const before = snapshot(state);
    expect(
      thrownCode(() =>
        applyBlock(state, {
          kind: "block.insert",
          parentId: "h11",
          beforeId: null,
          node: tableNode("nested", [
            row("nrow", [cell("tableCell", "ncell", "np")]),
          ]),
        }),
      ),
    ).toBe("TABLE_INTERNAL");
    expect(snapshot(state)).toBe(before);
  });

  it("allows moving a whole table and keeps metadata usable", () => {
    const state = seeded();
    const moved = applyBlock(state, {
      kind: "block.move",
      blockId: "t1",
      parentId: null,
      beforeId: "intro",
    });
    expect(moved.state.document.content!.map((node) => node.attrs!.id)).toEqual(
      ["t1", "intro"],
    );
    assertMetadataConsistent(moved.state);
    expect(() =>
      applyTable(
        moved.state,
        {
          kind: "table.row.insert",
          tableId: "t1",
          rowId: "r3",
          beforeId: null,
        },
        "inc",
      ),
    ).not.toThrow();
  });
});

describe("table structure", () => {
  it("seeds metadata in document row and column order", () => {
    const state = seeded();
    const metadata = tableMetadata(state, "t1")!;
    expect(metadata.rowIds).toEqual(["r1", "r2"]);
    expect(metadata.columnIds).toHaveLength(2);
    expect(new Set(metadata.columnIds).size).toBe(2);
    assertMetadataConsistent(state);
  });

  it("inserts rows before the requested row and keeps document order aligned", () => {
    const state = seeded();
    const inserted = applyTable(
      state,
      {
        kind: "table.row.insert",
        tableId: "t1",
        rowId: "r15",
        beforeId: "r2",
      },
      "inc",
    );
    const metadata = tableMetadata(inserted.state, "t1")!;
    expect(metadata.rowIds).toEqual(["r1", "r15", "r2"]);
    const table = findNode(inserted.state.document, "t1")!;
    expect(table.content!.map((node) => node.attrs!.id)).toEqual([
      "r1",
      "r15",
      "r2",
    ]);
    const newRow = findNode(inserted.state.document, "r15")!;
    expect(newRow.content).toHaveLength(2);
    for (const newCell of newRow.content!) {
      expect(newCell.type).toBe("tableCell");
      expect(
        findNode(inserted.state.document, newCell.attrs!.id as string),
      ).toBe(newCell);
    }
    assertMetadataConsistent(inserted.state);
    expect(() =>
      applyTable(
        inserted.state,
        { kind: "table.row.delete", tableId: "t1", rowId: "r15" },
        "inc",
      ),
    ).not.toThrow();
  });

  it("inserts columns before the requested column and aligns every row", () => {
    const state = seeded();
    const columns = tableMetadata(state, "t1")!.columnIds;
    const inserted = applyTable(
      state,
      {
        kind: "table.column.insert",
        tableId: "t1",
        columnId: "cx",
        beforeId: columns[1],
      },
      "inc",
    );
    const metadata = tableMetadata(inserted.state, "t1")!;
    expect(metadata.columnIds).toEqual([columns[0], "cx", columns[1]]);
    const table = findNode(inserted.state.document, "t1")!;
    const header = table.content![0];
    const body = table.content![1];
    expect(header.content).toHaveLength(3);
    expect(body.content).toHaveLength(3);
    expect(header.content![0].attrs!.id).toBe("h11");
    expect(header.content![2].attrs!.id).toBe("h12");
    expect(body.content![0].attrs!.id).toBe("c21");
    expect(body.content![2].attrs!.id).toBe("c22");
    expect(header.content![1].type).toBe("tableHeader");
    expect(body.content![1].type).toBe("tableCell");
    expect(header.content![1].attrs!.id).not.toBe(header.content![0].attrs!.id);
    expect(body.content![1].attrs!.id).not.toBe(body.content![0].attrs!.id);
    assertMetadataConsistent(inserted.state);
  });

  it("deletes rows with tombstones and leaves the other columns intact", () => {
    const state = seeded();
    const columnsBefore = [...tableMetadata(state, "t1")!.columnIds];
    const deleted = applyTable(
      state,
      { kind: "table.row.delete", tableId: "t1", rowId: "r2" },
      "inc",
    );
    expect(tableMetadata(deleted.state, "t1")!.rowIds).toEqual(["r1"]);
    expect(tableMetadata(deleted.state, "t1")!.columnIds).toEqual(
      columnsBefore,
    );
    expect(deleted.state.tombstones).toEqual(
      expect.arrayContaining(["r2", "c21", "c22", "c21p", "c22p"]),
    );
    expect(findNode(deleted.state.document, "c21")).toBeUndefined();
    assertMetadataConsistent(deleted.state);
  });

  it("deletes columns with tombstones and shifts remaining cells", () => {
    const state = seeded();
    const columns = tableMetadata(state, "t1")!.columnIds;
    const deleted = applyTable(
      state,
      { kind: "table.column.delete", tableId: "t1", columnId: columns[0] },
      "inc",
    );
    expect(tableMetadata(deleted.state, "t1")!.columnIds).toEqual([columns[1]]);
    expect(deleted.state.tombstones).toEqual(
      expect.arrayContaining([columns[0], "h11", "h11p", "c21", "c21p"]),
    );
    const table = findNode(deleted.state.document, "t1")!;
    expect(table.content![0].content!.map((node) => node.attrs!.id)).toEqual([
      "h12",
    ]);
    expect(table.content![1].content!.map((node) => node.attrs!.id)).toEqual([
      "c22",
    ]);
    assertMetadataConsistent(deleted.state);
  });

  it("refuses deleting the final row or column", () => {
    const oneByOne: Doc = {
      type: "doc",
      schemaVersion: 2,
      content: [
        tableNode("solo", [
          row("onlyRow", [cell("tableHeader", "onlyCell", "onlyP")]),
        ]),
      ],
    };
    const state = seeded(oneByOne);
    expect(
      thrownCode(() =>
        applyTable(
          state,
          { kind: "table.row.delete", tableId: "solo", rowId: "onlyRow" },
          "inc",
        ),
      ),
    ).toBe("TABLE_ROW_MIN");
    expect(
      thrownCode(() =>
        applyTable(
          state,
          {
            kind: "table.column.delete",
            tableId: "solo",
            columnId: tableMetadata(state, "solo")!.columnIds[0],
          },
          "inc",
        ),
      ),
    ).toBe("TABLE_COLUMN_MIN");
  });

  it("refuses IDs that collide with live document or metadata identities", () => {
    const state = seeded();
    expect(
      thrownCode(() =>
        applyTable(
          state,
          {
            kind: "table.row.insert",
            tableId: "t1",
            rowId: "r1",
            beforeId: null,
          },
          "inc",
        ),
      ),
    ).toBe("ID_COLLISION");
    expect(
      thrownCode(() =>
        applyTable(
          state,
          {
            kind: "table.row.insert",
            tableId: "t1",
            rowId: "h11",
            beforeId: null,
          },
          "inc",
        ),
      ),
    ).toBe("ID_COLLISION");
    expect(
      thrownCode(() =>
        applyTable(
          state,
          {
            kind: "table.column.insert",
            tableId: "t1",
            columnId: tableMetadata(state, "t1")!.columnIds[0],
            beforeId: null,
          },
          "inc",
        ),
      ),
    ).toBe("ID_COLLISION");
    expect(
      thrownCode(() =>
        applyTable(
          state,
          {
            kind: "table.column.insert",
            tableId: "t1",
            columnId: "c21",
            beforeId: null,
          },
          "inc",
        ),
      ),
    ).toBe("ID_COLLISION");
  });

  it("refuses reusing tombstones after deleting a row or column", () => {
    const state = seeded();
    const rowDeleted = applyTable(
      state,
      { kind: "table.row.delete", tableId: "t1", rowId: "r2" },
      "inc",
    );
    expect(
      thrownCode(() =>
        applyTable(
          rowDeleted.state,
          {
            kind: "table.row.insert",
            tableId: "t1",
            rowId: "r2",
            beforeId: null,
          },
          "inc",
        ),
      ),
    ).toBe("ID_COLLISION");
  });

  it("detects metadata drift, metadata order drift and tombstone collisions", () => {
    const state = seeded();
    expect(
      thrownCode(() =>
        applyTable(
          initialState(tableDoc()),
          {
            kind: "table.row.insert",
            tableId: "t1",
            rowId: "r9",
            beforeId: null,
          },
          "inc",
        ),
      ),
    ).toBe("TABLE_METADATA_DRIFT");

    const reordered: DocumentState = {
      ...state,
      tables: [{ ...tableMetadata(state, "t1")!, rowIds: ["r2", "r1"] }],
    };
    expect(
      thrownCode(() =>
        applyTable(
          reordered,
          { kind: "table.row.delete", tableId: "t1", rowId: "r2" },
          "inc",
        ),
      ),
    ).toBe("TABLE_METADATA_DRIFT");

    const liveCollision: DocumentState = { ...state, tombstones: ["r2"] };
    expect(
      thrownCode(() =>
        applyTable(
          liveCollision,
          { kind: "table.row.delete", tableId: "t1", rowId: "r2" },
          "inc",
        ),
      ),
    ).toBe("TOMBSTONE_DRIFT");

    const columnCollision: DocumentState = {
      ...state,
      tombstones: [tableMetadata(state, "t1")!.columnIds[0]],
    };
    expect(
      thrownCode(() =>
        applyTable(
          columnCollision,
          { kind: "table.row.delete", tableId: "t1", rowId: "r2" },
          "inc",
        ),
      ),
    ).toBe("TOMBSTONE_DRIFT");

    const duplicateTombstone: DocumentState = {
      ...state,
      tombstones: ["dead", "dead"],
    };
    expect(
      thrownCode(() =>
        applyTable(
          duplicateTombstone,
          { kind: "table.row.delete", tableId: "t1", rowId: "r2" },
          "inc",
        ),
      ),
    ).toBe("DUPLICATE_TOMBSTONE");

    const duplicateMetadata: DocumentState = {
      ...state,
      tables: [tableMetadata(state, "t1")!, tableMetadata(state, "t1")!],
    };
    expect(
      thrownCode(() =>
        applyTable(
          duplicateMetadata,
          { kind: "table.row.delete", tableId: "t1", rowId: "r2" },
          "inc",
        ),
      ),
    ).toBe("DUPLICATE_TABLE_METADATA");
  });

  it("requires explicit seeding before table commands are usable", () => {
    expect(
      thrownCode(() =>
        applyTable(
          initialState(tableDoc()),
          {
            kind: "table.row.insert",
            tableId: "t1",
            rowId: "r9",
            beforeId: null,
          },
          "inc",
        ),
      ),
    ).toBe("TABLE_METADATA_DRIFT");
  });

  it("finds tables nested in ordinary container blocks", () => {
    const doc: Doc = {
      type: "doc",
      schemaVersion: 2,
      content: [
        {
          type: "callout",
          attrs: { id: "co1", tone: "note" },
          content: [
            tableNode("t1", [row("r1", [cell("tableHeader", "h11", "h11p")])]),
          ],
        },
      ],
    };
    const state = seeded(doc);
    expect(tableMetadata(state, "t1")!.rowIds).toEqual(["r1"]);
    assertMetadataConsistent(state);
  });

  it("refuses a table nested inside a table cell", () => {
    const nested: Doc = {
      type: "doc",
      schemaVersion: 2,
      content: [
        tableNode("outer", [
          row("orow", [
            {
              type: "tableCell",
              attrs: { id: "ocell" },
              content: [
                paragraph("ocellp"),
                tableNode("inner", [
                  row("irow", [cell("tableCell", "icell", "icellp")]),
                ]),
              ],
            },
          ]),
        ]),
      ],
    };
    expect(() => initialState(nested)).toThrow(CollaborationError);
  });
});

describe("expected failures / confirmed holes", () => {
  const expectRefusalOrConsistent = (
    state: DocumentState,
    run: () => SemanticResult,
  ): void => {
    const before = snapshot(state);
    try {
      const result: SemanticResult = run();
      assertMetadataConsistent(result.state);
    } catch (error) {
      if (!(error instanceof CollaborationError)) throw error;
      expect(snapshot(state)).toBe(before);
      expect(error.code.length).toBeGreaterThan(0);
    }
  };

  it("EXPECTED FAIL: block.insert of a table keeps structural metadata consistent", () => {
    const state = initialState(plainDoc());
    const inserted = tableNode("t2", [
      row("tr1", [cell("tableHeader", "tc11", "tp11")]),
    ]);
    expectRefusalOrConsistent(state, () =>
      applyBlock(state, {
        kind: "block.insert",
        parentId: null,
        beforeId: null,
        node: inserted,
      }),
    );
  });

  it("EXPECTED FAIL: block.delete of a table removes its metadata", () => {
    const state = seeded();
    const deleted = applyBlock(state, {
      kind: "block.delete",
      blockId: "t1",
    });
    assertMetadataConsistent(deleted.state);
  });

  it("EXPECTED FAIL: block.replace introducing a table keeps metadata consistent", () => {
    const state = initialState(plainDoc());
    const table: Doc = tableNode("p1", [
      row("tr1", [cell("tableHeader", "tc11", "tp11")]),
    ]);
    expectRefusalOrConsistent(state, () =>
      applyBlock(state, {
        kind: "block.replace",
        blockId: "p1",
        before: findNode(state.document, "p1")!,
        node: table,
      }),
    );
  });

  it("EXPECTED FAIL: block.replace removing a table clears its metadata", () => {
    const state = seeded();
    const replaced = applyBlock(state, {
      kind: "block.replace",
      blockId: "t1",
      before: findNode(state.document, "t1")!,
      node: paragraph("t1", [text("replacement")]),
    });
    assertMetadataConsistent(replaced.state);
  });

  it("EXPECTED FAIL: block.insert refuses an ID owned by table column metadata", () => {
    const state = seeded();
    const columnId = tableMetadata(state, "t1")!.columnIds[0];
    expect(
      thrownCode(() =>
        applyBlock(state, {
          kind: "block.insert",
          parentId: null,
          beforeId: null,
          node: paragraph(columnId, [text("collision")]),
        }),
      ),
    ).toBe("ID_COLLISION");
  });

  it("EXPECTED FAIL: block.split refuses a new ID owned by table column metadata", () => {
    const state = seeded();
    const columnId = tableMetadata(state, "t1")!.columnIds[0];
    expect(
      thrownCode(() =>
        applyBlock(state, {
          kind: "block.split",
          blockId: "intro",
          offset: 2,
          newId: columnId,
        }),
      ),
    ).toBe("ID_COLLISION");
  });

  it("EXPECTED FAIL: block.replace refuses descendant IDs owned by table column metadata", () => {
    const state = seeded(tableAndQuoteDoc());
    const columnId = tableMetadata(state, "t1")!.columnIds[0];
    expect(
      thrownCode(() =>
        applyBlock(state, {
          kind: "block.replace",
          blockId: "b1",
          before: findNode(state.document, "b1")!,
          node: blockquote("b1", [paragraph(columnId, [text("collision")])]),
        }),
      ),
    ).toBe("ID_COLLISION");
  });

  it("EXPECTED FAIL: applyTable refuses a non-object command with CollaborationError", () => {
    const state = seeded();
    expect(
      thrownCode(() =>
        applyTable(state, null as unknown as TableCommand, "inc"),
      ),
    ).toBe("UNSUPPORTED_TABLE_COMMAND");
  });

  it("EXPECTED FAIL: table commands reject IDs outside the shared identifier grammar", () => {
    const state = seeded();
    expect(
      thrownCode(() =>
        applyTable(
          state,
          {
            kind: "table.row.insert",
            tableId: "t1",
            rowId: "row id",
            beforeId: null,
          },
          "inc",
        ),
      ),
    ).toBe("INVALID_ID");
    expect(
      thrownCode(() =>
        applyTable(
          state,
          {
            kind: "table.row.insert",
            tableId: "t1",
            rowId: "行1",
            beforeId: null,
          },
          "inc",
        ),
      ),
    ).toBe("INVALID_ID");
  });
});
