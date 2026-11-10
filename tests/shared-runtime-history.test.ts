import { describe, expect, it } from "vitest";
import type { Doc } from "../src/shared/types";
import {
  CollaborationError,
  type Command,
  type Cut,
  type DocumentState,
  type Receipt,
  type TextCommand,
} from "../src/collaboration/runtime/contract";
import { locate, nodeText } from "../src/collaboration/runtime/document";
import { canonical } from "../src/collaboration/runtime/canonical";
import { applyText } from "../src/collaboration/runtime/text-intent";
import { applyBlock } from "../src/collaboration/runtime/block-commands";
import {
  applyTable,
  seedTables,
} from "../src/collaboration/runtime/table-commands";
import { LocalHistory } from "../src/collaboration/runtime/local-history";

const cut = (seq: number): Cut => ({
  epoch: "epoch-1",
  seq,
  hash: `hash-${seq}`,
});

const scope = {
  orgId: "org",
  workspaceId: "workspace",
  documentId: "document",
  incarnationId: "incarnation",
};

function accepted(seq: number): Receipt {
  return {
    v: 1,
    status: "SERVER_ACCEPTED",
    intentId: `intent-${seq}`,
    intentHash: `intent-hash-${seq}`,
    attemptId: `attempt-${seq}`,
    attemptHash: `attempt-hash-${seq}`,
    writerId: "writer",
    scope,
    cut: cut(seq),
    resultHash: `result-hash-${seq}`,
    code: null,
  };
}

function reject(seq: number): Receipt {
  return { ...accepted(seq), status: "REJECTED", code: "REFUSED" };
}

function stateOf(content: Doc[]): DocumentState {
  return { document: { type: "doc", content }, tables: [], tombstones: [] };
}

function paragraph(id: string, text: string): Doc {
  return {
    type: "paragraph",
    attrs: { id },
    content: text ? [{ type: "text", text }] : [],
  };
}

function textOf(state: DocumentState, id: string): string {
  return nodeText(locate(state.document, id).node);
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

describe("LocalHistory text undo", () => {
  it("preserves remote characters when undoing an earlier local text edit", () => {
    const before = stateOf([paragraph("p1", "hello world")]);
    const command: TextCommand = {
      kind: "text",
      blockId: "p1",
      from: 6,
      to: 11,
      text: "there",
      before: "hello world",
    };
    const result = applyText(before, command, []);
    const history = new LocalHistory();
    history.record(before, command, result, cut(1));

    const remote: TextCommand = {
      kind: "text",
      blockId: "p1",
      from: 0,
      to: 0,
      text: "REMOTE ",
      before: "hello there",
    };
    const remoteResult = applyText(result.state, remote, []);
    expect(remoteResult.appliedText).not.toBeNull();

    const undo = history.undo(
      remoteResult.state,
      [remoteResult.appliedText!],
      allocator(),
    );

    expect(undo.base).toEqual(cut(1));
    expect(history.canUndo()).toBe(false);

    expect(undo.command.kind).toBe("text");
    const undone = applyText(
      remoteResult.state,
      undo.command as TextCommand,
      [],
    );
    expect(textOf(undone.state, "p1")).toBe("REMOTE hello world");

    history.confirm(accepted(2), undone.state);
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);
  });

  it("retains the undo operation when server confirmation fails", () => {
    const before = stateOf([paragraph("p1", "abc")]);
    const command: TextCommand = {
      kind: "text",
      blockId: "p1",
      from: 1,
      to: 1,
      text: "X",
      before: "abc",
    };
    const result = applyText(before, command, []);
    const history = new LocalHistory();
    history.record(before, command, result, cut(1));

    const first = history.undo(result.state, [], allocator());
    expect(history.canUndo()).toBe(false);
    expect(() => history.confirm(reject(2), result.state)).toThrow();
    expect(history.canUndo()).toBe(false);

    history.reject();
    expect(history.canUndo()).toBe(true);
    const second = history.undo(result.state, [], allocator());
    expect(second.command).toEqual(first.command);
    expect(second.base).toEqual(first.base);
  });
});

describe("LocalHistory structural undo", () => {
  it("moves the latest block content instead of restoring a stale subtree", () => {
    const before = stateOf([
      paragraph("a", "A"),
      paragraph("b", "B"),
      paragraph("c", "C"),
    ]);
    const move: Extract<Command, { kind: "block.move" }> = {
      kind: "block.move",
      blockId: "c",
      parentId: null,
      beforeId: "a",
    };
    const moved = applyBlock(before, move);
    const history = new LocalHistory();
    history.record(before, move, moved, cut(1));

    const edit: TextCommand = {
      kind: "text",
      blockId: "c",
      from: 0,
      to: 1,
      text: "C edited",
      before: "C",
    };
    const edited = applyText(moved.state, edit, []);

    const undo = history.undo(
      edited.state,
      edited.appliedText ? [edited.appliedText] : [],
      allocator(),
    );
    expect(undo.command).toEqual({
      positionBase: cut(1),
      kind: "block.move",
      blockId: "c",
      parentId: null,
      beforeId: null,
    });

    const undone = applyBlock(
      edited.state,
      undo.command as Extract<Command, { kind: "block.move" }>,
    );
    expect(textOf(undone.state, "c")).toBe("C edited");
  });

  it("refuses a move undo when the original anchor was removed remotely", () => {
    const before = stateOf([
      paragraph("a", "A"),
      paragraph("b", "B"),
      paragraph("c", "C"),
    ]);
    const move: Extract<Command, { kind: "block.move" }> = {
      kind: "block.move",
      blockId: "b",
      parentId: null,
      beforeId: "a",
    };
    const moved = applyBlock(before, move);
    const history = new LocalHistory();
    history.record(before, move, moved, cut(1));

    const remove: Extract<Command, { kind: "block.delete" }> = {
      kind: "block.delete",
      blockId: "c",
    };
    const current = applyBlock(moved.state, remove);

    expect(codeOf(() => history.undo(current.state, [], allocator()))).toBe(
      "HISTORY_CONFLICT",
    );
    expect(history.canUndo()).toBe(true);
  });

  it("restores deleted block content with fresh non-tombstoned IDs", () => {
    const before = stateOf([
      paragraph("a", "A"),
      paragraph("b", "B"),
      paragraph("c", "C"),
    ]);
    const remove: Extract<Command, { kind: "block.delete" }> = {
      kind: "block.delete",
      blockId: "b",
    };
    const result = applyBlock(before, remove);
    const history = new LocalHistory();
    history.record(before, remove, result, cut(1));

    const undo = history.undo(result.state, [], allocator("fresh-b"));
    expect(undo.command.kind).toBe("block.insert");
    const insert = undo.command as Extract<Command, { kind: "block.insert" }>;
    expect(insert.parentId).toBeNull();
    expect(insert.beforeId).toBe("c");
    expect(insert.node.attrs?.id).toBe("fresh-b");
    expect(result.state.tombstones).toContain("b");

    const undone = applyBlock(result.state, insert);
    expect(textOf(undone.state, "fresh-b")).toBe("B");
  });

  it("refuses to undo an insert whose subtree changed remotely", () => {
    const before = stateOf([paragraph("a", "A")]);
    const insert: Extract<Command, { kind: "block.insert" }> = {
      kind: "block.insert",
      parentId: null,
      beforeId: null,
      node: paragraph("x", "new"),
    };
    const result = applyBlock(before, insert);
    const history = new LocalHistory();
    history.record(before, insert, result, cut(1));

    const edit: TextCommand = {
      kind: "text",
      blockId: "x",
      from: 0,
      to: 3,
      text: "remote",
      before: "new",
    };
    const current = applyText(result.state, edit, []);

    expect(codeOf(() => history.undo(current.state, [], allocator()))).toBe(
      "HISTORY_CONFLICT",
    );
    expect(history.canUndo()).toBe(true);
  });
});

describe("LocalHistory redo", () => {
  it("emits a new command at the confirmed cut for the caller to identify", () => {
    const before = stateOf([paragraph("p1", "abc")]);
    const command: TextCommand = {
      kind: "text",
      blockId: "p1",
      from: 1,
      to: 1,
      text: "X",
      before: "abc",
    };
    const result = applyText(before, command, []);
    const history = new LocalHistory();
    history.record(before, command, result, cut(1));

    const undo = history.undo(result.state, [], allocator());
    expect(undo.command.kind).toBe("text");
    const undone = applyText(result.state, undo.command as TextCommand, []);
    expect(textOf(undone.state, "p1")).toBe("abc");
    history.confirm(accepted(2), undone.state);

    expect(history.canRedo()).toBe(true);
    const redo = history.redo(undone.state, [], allocator());
    expect(Object.keys(redo).sort()).toEqual(["base", "command"]);
    expect(redo.base).toEqual(cut(2));
    expect(redo.command.kind).toBe("text");
    const redoCommand = redo.command as TextCommand;
    expect(redoCommand).toMatchObject({
      from: 1,
      to: 1,
      text: "X",
      before: "abc",
    });

    const redone = applyText(undone.state, redoCommand, []);
    expect(textOf(redone.state, "p1")).toBe("aXbc");
    history.confirm(accepted(3), redone.state);
    expect(history.canRedo()).toBe(false);
    expect(history.canUndo()).toBe(true);
  });
});

describe("LocalHistory bounds", () => {
  it("keeps at most one hundred undo entries", () => {
    const before = stateOf([paragraph("p1", "a")]);
    const command: TextCommand = {
      kind: "text",
      blockId: "p1",
      from: 1,
      to: 1,
      text: "b",
      before: "a",
    };
    const result = applyText(before, command, []);
    const history = new LocalHistory();
    for (let seq = 0; seq < 101; seq++)
      history.record(before, command, result, cut(seq));

    let undone = 0;
    while (history.canUndo() && undone <= 200) {
      history.undo(result.state, [], allocator());
      history.confirm(accepted(1000 + undone), result.state);
      undone++;
    }
    expect(undone).toBe(100);

    history.clear();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });
});

function cell(
  tag: string,
  type: "tableCell" | "tableHeader" = "tableCell",
): Doc {
  return {
    type,
    attrs: { id: `cell-${tag}` },
    content: [{ type: "paragraph", attrs: { id: `para-${tag}` } }],
  };
}

function tableDoc(): Doc {
  return {
    type: "table",
    attrs: { id: "t1" },
    content: [
      {
        type: "tableRow",
        attrs: { id: "r1" },
        content: [cell("r1c1", "tableHeader"), cell("r1c2", "tableHeader")],
      },
      {
        type: "tableRow",
        attrs: { id: "r2" },
        content: [cell("r2c1"), cell("r2c2")],
      },
    ],
  };
}

function tableState(): DocumentState {
  return seedTables(
    {
      document: { type: "doc", content: [tableDoc()] },
      tables: [],
      tombstones: [],
    },
    "incarnation",
  );
}

function mixedState(): DocumentState {
  return seedTables(
    {
      document: {
        type: "doc",
        content: [paragraph("p1", "hello"), tableDoc()],
      },
      tables: [],
      tombstones: [],
    },
    "incarnation",
  );
}

function tableNode(state: DocumentState): Doc {
  return locate(state.document, "t1").node;
}

function tableMetadataOf(state: DocumentState) {
  const metadata = state.tables.find((value) => value.tableId === "t1");
  if (!metadata) throw new Error("missing table metadata");
  return metadata;
}

function expectRectangle(state: DocumentState): void {
  const metadata = tableMetadataOf(state);
  const rows = tableNode(state).content ?? [];
  expect(rows.length).toBe(metadata.rowIds.length);
  for (let index = 0; index < rows.length; index++) {
    expect(rows[index].attrs?.id).toBe(metadata.rowIds[index]);
    expect(rows[index].content?.length).toBe(metadata.columnIds.length);
  }
}

function paragraphIdInCell(
  state: DocumentState,
  rowId: string,
  columnId: string,
): string {
  const row = tableNode(state).content?.find(
    (node) => node.attrs?.id === rowId,
  );
  const metadata = tableMetadataOf(state);
  const index = metadata.columnIds.indexOf(columnId);
  if (!row || index < 0) throw new Error("missing cell");
  const id = row.content?.[index]?.content?.[0]?.attrs?.id;
  if (typeof id !== "string") throw new Error("missing paragraph id");
  return id;
}

describe("LocalHistory table insertion undo", () => {
  it("removes inserted row A after column B was added and keeps column B", () => {
    const base = tableState();
    const rowInsert: Extract<Command, { kind: "table.row.insert" }> = {
      kind: "table.row.insert",
      tableId: "t1",
      rowId: "rA",
      beforeId: null,
    };
    const withRow = applyTable(base, rowInsert, "incarnation");
    const history = new LocalHistory();
    history.record(base, rowInsert, withRow, cut(1));

    const columnInsert: Extract<Command, { kind: "table.column.insert" }> = {
      kind: "table.column.insert",
      tableId: "t1",
      columnId: "cB",
      beforeId: null,
    };
    const withColumn = applyTable(withRow.state, columnInsert, "incarnation");

    const undo = history.undo(withColumn.state, [], allocator());
    expect(undo.command).toEqual({
      kind: "table.row.delete",
      tableId: "t1",
      rowId: "rA",
    });

    const undone = applyTable(
      withColumn.state,
      undo.command as Extract<Command, { kind: "table.row.delete" }>,
      "incarnation",
    );
    const metadata = tableMetadataOf(undone.state);
    expect(metadata.columnIds).toContain("cB");
    expect(metadata.rowIds).not.toContain("rA");
    expect(
      tableNode(undone.state).content?.some((row) => row.attrs?.id === "rA"),
    ).toBe(false);
    expectRectangle(undone.state);

    history.confirm(accepted(2), undone.state);
    expect(history.canRedo()).toBe(true);
  });

  it("removes inserted column B after row A was added and keeps row A", () => {
    const base = tableState();
    const columnInsert: Extract<Command, { kind: "table.column.insert" }> = {
      kind: "table.column.insert",
      tableId: "t1",
      columnId: "cB",
      beforeId: null,
    };
    const withColumn = applyTable(base, columnInsert, "incarnation");
    const history = new LocalHistory();
    history.record(base, columnInsert, withColumn, cut(1));

    const rowInsert: Extract<Command, { kind: "table.row.insert" }> = {
      kind: "table.row.insert",
      tableId: "t1",
      rowId: "rA",
      beforeId: null,
    };
    const withRow = applyTable(withColumn.state, rowInsert, "incarnation");

    const undo = history.undo(withRow.state, [], allocator());
    expect(undo.command).toEqual({
      kind: "table.column.delete",
      tableId: "t1",
      columnId: "cB",
    });

    const undone = applyTable(
      withRow.state,
      undo.command as Extract<Command, { kind: "table.column.delete" }>,
      "incarnation",
    );
    const metadata = tableMetadataOf(undone.state);
    expect(metadata.columnIds).not.toContain("cB");
    expect(metadata.rowIds).toContain("rA");
    expectRectangle(undone.state);
  });

  it("refuses to remove a row when a later column intersection has content", () => {
    const base = tableState();
    const rowInsert: Extract<Command, { kind: "table.row.insert" }> = {
      kind: "table.row.insert",
      tableId: "t1",
      rowId: "rA",
      beforeId: null,
    };
    const withRow = applyTable(base, rowInsert, "incarnation");
    const history = new LocalHistory();
    history.record(base, rowInsert, withRow, cut(1));

    const columnInsert: Extract<Command, { kind: "table.column.insert" }> = {
      kind: "table.column.insert",
      tableId: "t1",
      columnId: "cB",
      beforeId: null,
    };
    const withColumn = applyTable(withRow.state, columnInsert, "incarnation");
    const paragraphId = paragraphIdInCell(withColumn.state, "rA", "cB");
    const edit: TextCommand = {
      kind: "text",
      blockId: paragraphId,
      from: 0,
      to: 0,
      text: "remote",
      before: "",
    };
    const edited = applyText(withColumn.state, edit, []);

    expect(codeOf(() => history.undo(edited.state, [], allocator()))).toBe(
      "HISTORY_CONFLICT",
    );
    expect(history.canUndo()).toBe(true);
  });

  it("refuses to remove a column when a later row intersection has content", () => {
    const base = tableState();
    const columnInsert: Extract<Command, { kind: "table.column.insert" }> = {
      kind: "table.column.insert",
      tableId: "t1",
      columnId: "cB",
      beforeId: null,
    };
    const withColumn = applyTable(base, columnInsert, "incarnation");
    const history = new LocalHistory();
    history.record(base, columnInsert, withColumn, cut(1));

    const rowInsert: Extract<Command, { kind: "table.row.insert" }> = {
      kind: "table.row.insert",
      tableId: "t1",
      rowId: "rA",
      beforeId: null,
    };
    const withRow = applyTable(withColumn.state, rowInsert, "incarnation");
    const paragraphId = paragraphIdInCell(withRow.state, "rA", "cB");
    const edit: TextCommand = {
      kind: "text",
      blockId: paragraphId,
      from: 0,
      to: 0,
      text: "remote",
      before: "",
    };
    const edited = applyText(withRow.state, edit, []);

    expect(codeOf(() => history.undo(edited.state, [], allocator()))).toBe(
      "HISTORY_CONFLICT",
    );
    expect(history.canUndo()).toBe(true);
  });

  it("refuses to remove a row whose original cells changed remotely", () => {
    const base = tableState();
    const rowInsert: Extract<Command, { kind: "table.row.insert" }> = {
      kind: "table.row.insert",
      tableId: "t1",
      rowId: "rA",
      beforeId: null,
    };
    const withRow = applyTable(base, rowInsert, "incarnation");
    const history = new LocalHistory();
    history.record(base, rowInsert, withRow, cut(1));

    const originalColumn = tableMetadataOf(base).columnIds[0];
    const paragraphId = paragraphIdInCell(withRow.state, "rA", originalColumn);
    const edit: TextCommand = {
      kind: "text",
      blockId: paragraphId,
      from: 0,
      to: 0,
      text: "remote",
      before: "",
    };
    const edited = applyText(withRow.state, edit, []);

    expect(codeOf(() => history.undo(edited.state, [], allocator()))).toBe(
      "HISTORY_CONFLICT",
    );
  });

  it("keeps the latest block content when a move undo follows a remote KEEP", () => {
    const before = stateOf([
      paragraph("a", "A"),
      paragraph("b", "B"),
      paragraph("c", "C"),
    ]);
    const move: Extract<Command, { kind: "block.move" }> = {
      kind: "block.move",
      blockId: "c",
      parentId: null,
      beforeId: "a",
    };
    const moved = applyBlock(before, move);
    const history = new LocalHistory();
    history.record(before, move, moved, cut(1));

    const remoteEdit: TextCommand = {
      kind: "text",
      blockId: "c",
      from: 0,
      to: 1,
      text: "remote C",
      before: "C",
    };
    const edited = applyText(moved.state, remoteEdit, []);
    expect(edited.appliedText).not.toBeNull();

    const undo = history.undo(
      edited.state,
      edited.appliedText ? [edited.appliedText] : [],
      allocator(),
    );
    expect(undo.command).toEqual({
      positionBase: cut(1),
      kind: "block.move",
      blockId: "c",
      parentId: null,
      beforeId: null,
    });
    const undone = applyBlock(
      edited.state,
      undo.command as Extract<Command, { kind: "block.move" }>,
    );
    expect(textOf(undone.state, "c")).toBe("remote C");
    expect(
      (undone.state.document.content ?? []).map((node) => node.attrs?.id),
    ).toEqual(["a", "b", "c"]);
    history.confirm(accepted(2), undone.state);
  });
});

describe("LocalHistory table delete undo", () => {
  it("reports HISTORY_UNSUPPORTED and preserves data for a row delete undo", () => {
    const base = tableState();
    const remove: Extract<Command, { kind: "table.row.delete" }> = {
      kind: "table.row.delete",
      tableId: "t1",
      rowId: "r2",
    };
    const after = applyTable(base, remove, "incarnation");
    const history = new LocalHistory();
    history.record(base, remove, after, cut(1));
    const snapshot = canonical(after.state);

    expect(codeOf(() => history.undo(after.state, [], allocator()))).toBe(
      "HISTORY_UNSUPPORTED",
    );
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);
    expect(canonical(after.state)).toBe(snapshot);
  });

  it("reports HISTORY_UNSUPPORTED and preserves data for a column delete undo", () => {
    const base = tableState();
    const columnId = tableMetadataOf(base).columnIds[1];
    const remove: Extract<Command, { kind: "table.column.delete" }> = {
      kind: "table.column.delete",
      tableId: "t1",
      columnId,
    };
    const after = applyTable(base, remove, "incarnation");
    const history = new LocalHistory();
    history.record(base, remove, after, cut(1));
    const snapshot = canonical(after.state);

    expect(codeOf(() => history.undo(after.state, [], allocator()))).toBe(
      "HISTORY_UNSUPPORTED",
    );
    expect(history.canUndo()).toBe(true);
    expect(canonical(after.state)).toBe(snapshot);
  });
});

describe("LocalHistory mixed operation order", () => {
  it("undoes mixed table and text edits in reverse order using current cuts", () => {
    const base = mixedState();
    const textEdit: TextCommand = {
      kind: "text",
      blockId: "p1",
      from: 5,
      to: 5,
      text: "!",
      before: "hello",
    };
    const withText = applyText(base, textEdit, []);
    const rowInsert: Extract<Command, { kind: "table.row.insert" }> = {
      kind: "table.row.insert",
      tableId: "t1",
      rowId: "rA",
      beforeId: null,
    };
    const withRow = applyTable(withText.state, rowInsert, "incarnation");
    const columnInsert: Extract<Command, { kind: "table.column.insert" }> = {
      kind: "table.column.insert",
      tableId: "t1",
      columnId: "cB",
      beforeId: null,
    };
    const withColumn = applyTable(withRow.state, columnInsert, "incarnation");

    const history = new LocalHistory();
    history.record(base, textEdit, withText, cut(1));
    history.record(withText.state, rowInsert, withRow, cut(2));
    history.record(withRow.state, columnInsert, withColumn, cut(3));

    expect(history.nextCut("undo")).toEqual(cut(3));

    const undoColumn = history.undo(withColumn.state, [], allocator());
    expect(undoColumn.base).toEqual(cut(3));
    expect(undoColumn.command.kind).toBe("table.column.delete");
    const afterColumn = applyTable(
      withColumn.state,
      undoColumn.command as Extract<Command, { kind: "table.column.delete" }>,
      "incarnation",
    );
    history.confirm(accepted(4), afterColumn.state);

    expect(history.nextCut("undo")).toEqual(cut(2));
    const undoRow = history.undo(afterColumn.state, [], allocator());
    expect(undoRow.base).toEqual(cut(4));
    expect(undoRow.command.kind).toBe("table.row.delete");
    const afterRow = applyTable(
      afterColumn.state,
      undoRow.command as Extract<Command, { kind: "table.row.delete" }>,
      "incarnation",
    );
    history.confirm(accepted(5), afterRow.state);

    expect(history.nextCut("undo")).toEqual(cut(1));
    const undoText = history.undo(afterRow.state, [], allocator());
    expect(undoText.base).toEqual(cut(5));
    expect(undoText.command.kind).toBe("text");
    const afterText = applyText(
      afterRow.state,
      undoText.command as TextCommand,
      [],
    );
    expect(textOf(afterText.state, "p1")).toBe("hello");
    history.confirm(accepted(6), afterText.state);

    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(true);
    expect(history.nextCut("redo")).toEqual(cut(6));
  });
});
