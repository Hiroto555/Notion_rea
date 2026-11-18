import { describe, expect, it } from "vitest";
import type { Doc } from "../src/shared/types";
import { applyBlock } from "../src/collaboration/runtime/block-commands";
import { canonical } from "../src/collaboration/runtime/canonical";
import {
  CollaborationError,
  type BlockCommand,
  type DocumentState,
} from "../src/collaboration/runtime/contract";
import { locate, nodeText } from "../src/collaboration/runtime/document";

function text(value: string, marks?: Doc["marks"]): Doc {
  return marks
    ? { type: "text", text: value, marks }
    : { type: "text", text: value };
}

function paragraph(id: string, content?: Doc[]): Doc {
  return content
    ? { type: "paragraph", attrs: { id }, content }
    : { type: "paragraph", attrs: { id } };
}

function heading(id: string, content?: Doc[], level = 2): Doc {
  return {
    type: "heading",
    attrs: { id, level },
    ...(content ? { content } : {}),
  };
}

function blockquote(id: string, content: Doc[]): Doc {
  return { type: "blockquote", attrs: { id }, content };
}

function table(id: string, rowId: string, cellId: string, inner: Doc[]): Doc {
  return {
    type: "table",
    attrs: { id },
    content: [
      {
        type: "tableRow",
        attrs: { id: rowId },
        content: [{ type: "tableCell", attrs: { id: cellId }, content: inner }],
      },
    ],
  };
}

function stateOf(content: Doc[], tombstones: string[] = []): DocumentState {
  return { document: { type: "doc", content }, tables: [], tombstones };
}

function ids(state: DocumentState): (string | undefined)[] {
  return (state.document.content ?? []).map((node) =>
    typeof node.attrs?.id === "string" ? node.attrs.id : undefined,
  );
}

function nodeById(state: DocumentState, id: string): Doc {
  return locate(state.document, id).node;
}

function textById(state: DocumentState, id: string): string {
  return nodeText(nodeById(state, id));
}

function rejectCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationError);
    return (error as CollaborationError).code;
  }
  throw new Error("expected refusal");
}

describe("applyBlock move", () => {
  it("moves the current logical p1 content to the end instead of a stale snapshot", () => {
    const state = stateOf([
      paragraph("p1", [text("aKEEPbc")]),
      paragraph("p2", [text("second")]),
    ]);
    const before = canonical(state);
    const result = applyBlock(state, {
      kind: "block.move",
      blockId: "p1",
      parentId: null,
      beforeId: null,
    });
    expect(result.appliedText).toBeNull();
    expect(ids(result.state)).toEqual(["p2", "p1"]);
    expect(textById(result.state, "p1")).toBe("aKEEPbc");
    expect(canonical(state)).toBe(before);
    expect(ids(state)).toEqual(["p1", "p2"]);
  });

  it("carries marks and descendant IDs with the moved node", () => {
    const state = stateOf([
      blockquote("b1", [
        paragraph("p1", [text("keep", [{ type: "bold" }])]),
        paragraph("p2", [text("tail")]),
      ]),
      paragraph("p3", [text("last")]),
    ]);
    const result = applyBlock(state, {
      kind: "block.move",
      blockId: "b1",
      parentId: null,
      beforeId: "p3",
    });
    expect(ids(result.state)).toEqual(["b1", "p3"]);
    expect(textById(result.state, "p1")).toBe("keep");
    expect(nodeById(result.state, "p1").content?.[0].marks?.[0].type).toBe(
      "bold",
    );
    expect(textById(result.state, "p2")).toBe("tail");
  });

  it("refuses a move into its own descendant", () => {
    const state = stateOf([
      blockquote("b1", [blockquote("b2", [paragraph("p1")])]),
    ]);
    expect(
      rejectCode(() =>
        applyBlock(state, {
          kind: "block.move",
          blockId: "b1",
          parentId: "b2",
          beforeId: null,
        }),
      ),
    ).toBe("CYCLE");
  });

  it("refuses missing targets and invalid anchors", () => {
    const state = stateOf([paragraph("p1"), paragraph("p2")]);
    expect(
      rejectCode(() =>
        applyBlock(state, {
          kind: "block.move",
          blockId: "missing",
          parentId: null,
          beforeId: null,
        }),
      ),
    ).toBe("NODE_MISSING");
    expect(
      rejectCode(() =>
        applyBlock(state, {
          kind: "block.move",
          blockId: "p1",
          parentId: null,
          beforeId: "missing",
        }),
      ),
    ).toBe("INVALID_ANCHOR");
    expect(
      rejectCode(() =>
        applyBlock(state, {
          kind: "block.move",
          blockId: "p1",
          parentId: null,
          beforeId: "p1",
        }),
      ),
    ).toBe("INVALID_ANCHOR");
  });

  it("refuses table internals and leaves the input untouched", () => {
    const state = stateOf([
      table("t1", "r1", "c1", [paragraph("p1", [text("cell")])]),
      paragraph("p2"),
    ]);
    const before = canonical(state);
    expect(
      rejectCode(() =>
        applyBlock(state, {
          kind: "block.move",
          blockId: "p1",
          parentId: null,
          beforeId: "p2",
        }),
      ),
    ).toBe("TABLE_INTERNAL");
    expect(canonical(state)).toBe(before);
  });
});

describe("applyBlock delete", () => {
  it("tombstones every removed descendant ID", () => {
    const state = stateOf(
      [blockquote("b1", [paragraph("p1"), paragraph("p2")]), paragraph("p3")],
      ["old"],
    );
    const result = applyBlock(state, { kind: "block.delete", blockId: "b1" });
    expect(ids(result.state)).toEqual(["p3"]);
    expect(result.state.tombstones).toEqual(
      expect.arrayContaining(["old", "b1", "p1", "p2"]),
    );
    expect(result.state.tombstones).toHaveLength(4);
    expect(state.tombstones).toEqual(["old"]);
    expect(ids(state)).toEqual(["b1", "p3"]);
  });

  it("refuses deleting a table cell directly", () => {
    const state = stateOf([table("t1", "r1", "c1", [paragraph("p1")])]);
    expect(
      rejectCode(() =>
        applyBlock(state, { kind: "block.delete", blockId: "c1" }),
      ),
    ).toBe("TABLE_INTERNAL");
  });
});

describe("applyBlock insert", () => {
  it("inserts a wholly new subtree at an ID anchor", () => {
    const state = stateOf([paragraph("p1", [text("one")])]);
    const node = blockquote("b9", [paragraph("p9", [text("new")])]);
    const result = applyBlock(state, {
      kind: "block.insert",
      parentId: null,
      beforeId: "p1",
      node,
    });
    expect(ids(result.state)).toEqual(["b9", "p1"]);
    expect(textById(result.state, "p9")).toBe("new");
    expect(ids(state)).toEqual(["p1"]);
  });

  it("refuses duplicate, tombstoned and malformed node identities", () => {
    const state = stateOf([paragraph("p1")], ["p9"]);
    expect(
      rejectCode(() =>
        applyBlock(state, {
          kind: "block.insert",
          parentId: null,
          beforeId: null,
          node: paragraph("p1"),
        }),
      ),
    ).toBe("DUPLICATE_ID");
    expect(
      rejectCode(() =>
        applyBlock(state, {
          kind: "block.insert",
          parentId: null,
          beforeId: null,
          node: paragraph("p9"),
        }),
      ),
    ).toBe("TOMBSTONED_ID");
    expect(
      rejectCode(() =>
        applyBlock(state, {
          kind: "block.insert",
          parentId: null,
          beforeId: null,
          node: { type: "doc", content: [] },
        }),
      ),
    ).toBe("INVALID_BLOCK_NODE");
    expect(
      rejectCode(() =>
        applyBlock(state, {
          kind: "block.insert",
          parentId: null,
          beforeId: null,
          node: paragraph("bad id", [text("ok")]),
        }),
      ),
    ).toBe("INVALID_ID");
  });

  it("refuses duplicate IDs inside the inserted subtree", () => {
    const state = stateOf([paragraph("p1")]);
    expect(
      rejectCode(() =>
        applyBlock(state, {
          kind: "block.insert",
          parentId: null,
          beforeId: null,
          node: blockquote("b9", [paragraph("p2"), paragraph("p2")]),
        }),
      ),
    ).toBe("DUPLICATE_ID");
  });
});

describe("applyBlock replace", () => {
  it("applies a same-ID replacement when the canonical before matches", () => {
    const state = stateOf([paragraph("p1", [text("old")])]);
    const before = nodeById(state, "p1");
    const result = applyBlock(state, {
      kind: "block.replace",
      blockId: "p1",
      before,
      node: paragraph("p1", [text("new")]),
    });
    expect(textById(result.state, "p1")).toBe("new");
    expect(ids(result.state)).toEqual(["p1"]);
  });

  it("refuses a stale canonical before without mutating the input", () => {
    const state = stateOf([paragraph("p1", [text("current")])]);
    const snapshot = canonical(state);
    expect(
      rejectCode(() =>
        applyBlock(state, {
          kind: "block.replace",
          blockId: "p1",
          before: paragraph("p1", [text("stale")]),
          node: paragraph("p1", [text("new")]),
        }),
      ),
    ).toBe("STALE_REPLACE");
    expect(canonical(state)).toBe(snapshot);
  });

  it("refuses a replacement that changes the logical ID", () => {
    const state = stateOf([paragraph("p1", [text("old")])]);
    expect(
      rejectCode(() =>
        applyBlock(state, {
          kind: "block.replace",
          blockId: "p1",
          before: paragraph("p1", [text("old")]),
          node: paragraph("p2", [text("new")]),
        }),
      ),
    ).toBe("REPLACE_ID_MISMATCH");
  });
});

describe("applyBlock split", () => {
  it("splits marked text keeping the old left ID and the new right ID", () => {
    const state = stateOf([
      paragraph("p1", [
        text("ab", [{ type: "bold" }]),
        text("cd", [{ type: "italic" }]),
      ]),
      paragraph("p3", [text("after")]),
    ]);
    const result = applyBlock(state, {
      kind: "block.split",
      blockId: "p1",
      offset: 3,
      newId: "p2",
    });
    expect(ids(result.state)).toEqual(["p1", "p2", "p3"]);
    expect(textById(result.state, "p1")).toBe("abc");
    expect(textById(result.state, "p2")).toBe("d");
    const left = nodeById(result.state, "p1").content ?? [];
    const right = nodeById(result.state, "p2").content ?? [];
    expect(left.map((n) => [n.text, n.marks?.[0]?.type])).toEqual([
      ["ab", "bold"],
      ["c", "italic"],
    ]);
    expect(right.map((n) => [n.text, n.marks?.[0]?.type])).toEqual([
      ["d", "italic"],
    ]);
    expect(textById(state, "p1")).toBe("abcd");
  });

  it("refuses non-textblocks, bad offsets and surrogate splits", () => {
    const quote = stateOf([blockquote("b1", [paragraph("p1", [text("x")])])]);
    expect(
      rejectCode(() =>
        applyBlock(quote, {
          kind: "block.split",
          blockId: "b1",
          offset: 0,
          newId: "b2",
        }),
      ),
    ).toBe("NOT_TEXTBLOCK");

    const empty = stateOf([paragraph("p1", [text("abc")])]);
    expect(
      rejectCode(() =>
        applyBlock(empty, {
          kind: "block.split",
          blockId: "p1",
          offset: 4,
          newId: "p2",
        }),
      ),
    ).toBe("INVALID_OFFSET");

    const emoji = stateOf([paragraph("p1", [text("\u{1F600}x")])]);
    expect(
      rejectCode(() =>
        applyBlock(emoji, {
          kind: "block.split",
          blockId: "p1",
          offset: 1,
          newId: "p2",
        }),
      ),
    ).toBe("SPLIT_UNICODE");
  });

  it("refuses a new ID that already exists or is tombstoned", () => {
    const state = stateOf(
      [paragraph("p1", [text("a")]), paragraph("p2")],
      ["p3"],
    );
    expect(
      rejectCode(() =>
        applyBlock(state, {
          kind: "block.split",
          blockId: "p1",
          offset: 1,
          newId: "p2",
        }),
      ),
    ).toBe("DUPLICATE_ID");
    expect(
      rejectCode(() =>
        applyBlock(state, {
          kind: "block.split",
          blockId: "p1",
          offset: 1,
          newId: "p3",
        }),
      ),
    ).toBe("TOMBSTONED_ID");
  });
});

describe("applyBlock join", () => {
  it("joins adjacent compatible marked textblocks and tombstones the right", () => {
    const state = stateOf([
      paragraph("p1", [text("ab", [{ type: "bold" }])]),
      paragraph("p2", [text("cd", [{ type: "italic" }])]),
      paragraph("p3", [text("tail")]),
    ]);
    const result = applyBlock(state, {
      kind: "block.join",
      leftId: "p1",
      rightId: "p2",
    });
    expect(ids(result.state)).toEqual(["p1", "p3"]);
    expect(textById(result.state, "p1")).toBe("abcd");
    const content = nodeById(result.state, "p1").content ?? [];
    expect(content.map((n) => [n.text, n.marks?.[0]?.type])).toEqual([
      ["ab", "bold"],
      ["cd", "italic"],
    ]);
    expect(result.state.tombstones).toContain("p2");
    expect(ids(state)).toEqual(["p1", "p2", "p3"]);
  });

  it("refuses non-adjacent and incompatible textblocks", () => {
    const state = stateOf([
      paragraph("p1", [text("a")]),
      paragraph("p2", [text("b")]),
      paragraph("p3", [text("c")]),
    ]);
    expect(
      rejectCode(() =>
        applyBlock(state, {
          kind: "block.join",
          leftId: "p1",
          rightId: "p3",
        }),
      ),
    ).toBe("NOT_ADJACENT");
    const mixed = stateOf([
      paragraph("p1", [text("a")]),
      heading("p2", [text("b")]),
    ]);
    expect(
      rejectCode(() =>
        applyBlock(mixed, {
          kind: "block.join",
          leftId: "p1",
          rightId: "p2",
        }),
      ),
    ).toBe("INCOMPATIBLE_JOIN");
  });
});

describe("applyBlock validation", () => {
  it("refuses unknown command kinds defensively", () => {
    const state = stateOf([paragraph("p1")]);
    expect(
      rejectCode(() =>
        applyBlock(state, { kind: "block.nope" } as unknown as BlockCommand),
      ),
    ).toBe("UNSUPPORTED_BLOCK_COMMAND");
  });

  it("refuses a result the shared document validator rejects", () => {
    const state = stateOf([paragraph("p1")]);
    expect(
      rejectCode(() =>
        applyBlock(state, {
          kind: "block.insert",
          parentId: null,
          beforeId: null,
          node: paragraph("p2", [paragraph("p3")]),
        }),
      ),
    ).toMatch(/^UNSUPPORTED_DOCUMENT/);
  });
});
