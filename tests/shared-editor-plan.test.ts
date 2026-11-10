import { versionDocument } from "../src/shared/rich-document";
import { describe, expect, it } from "vitest";
import { lowerEditorDocument } from "../src/collaboration/runtime/editor-plan";
import type { DocumentState } from "../src/collaboration/runtime/contract";
import type { Doc } from "../src/shared/types";

function paragraph(id: string, text?: string): Doc {
  return {
    type: "paragraph",
    attrs: { id },
    ...(text === undefined
      ? {}
      : { content: [{ type: "text", text }] }),
  };
}

function doc(...content: Doc[]): Doc {
  return versionDocument({ type: "doc", content });
}

function state(
  document: Doc,
  tables: DocumentState["tables"] = [],
): DocumentState {
  return { document, tables, tombstones: [] };
}

function text(node: Doc): string {
  return (node.content ?? [])
    .map((child) =>
      child.type === "text" ? child.text ?? "" : child.type === "hardBreak" ? "\n" : text(child),
    )
    .join("");
}

function cell(id: string, paragraphId: string, value?: string): Doc {
  return {
    type: "tableCell",
    attrs: { id },
    content: [paragraph(paragraphId, value)],
  };
}

function row(id: string, ...cells: Doc[]): Doc {
  return { type: "tableRow", attrs: { id }, content: cells };
}

function table(id: string, ...rows: Doc[]): Doc {
  return { type: "table", attrs: { id }, content: rows };
}

describe("lowerEditorDocument", () => {
  it("emits one inline atom for a plain text edit", () => {
    const before = state(doc(paragraph("p1", "hello")));
    const after = doc(paragraph("p1", "world"));
    const plan = lowerEditorDocument(before, after, "inc-1");
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]).toMatchObject({ kind: "inline", blockId: "p1" });
    expect(plan.normalizedAfter).toEqual(after);
  });

  it("emits block.format then inline for type, attrs and mark changes", () => {
    const before = state(doc(paragraph("p1", "hello")));
    const after = doc({
      type: "heading",
      attrs: { id: "p1", level: 2 },
      content: [{ type: "text", text: "hello", marks: [{ type: "bold" }] }],
    });
    const plan = lowerEditorDocument(before, after, "inc-1");
    expect(plan.commands.map((command) => command.kind)).toEqual([
      "block.format",
      "inline",
    ]);
    expect(plan.normalizedAfter).toEqual(after);
  });

  it("inserts and deletes identified blocks without replacing the document", () => {
    const before = state(doc(paragraph("p1", "one"), paragraph("p3", "three")));
    const after = doc(paragraph("p1", "one"), paragraph("p2", "two"));
    const plan = lowerEditorDocument(before, after, "inc-1");
    expect(plan.commands.map((command) => command.kind)).toEqual([
      "block.insert",
      "block.delete",
    ]);
    expect(plan.commands.some((command) => command.kind === "block.replace")).toBe(
      false,
    );
    expect(plan.normalizedAfter).toEqual(after);
  });

  it("detects an identified move instead of delete plus insert", () => {
    const before = state(doc(paragraph("p1", "one"), paragraph("p2", "two")));
    const after = doc(paragraph("p2", "two"), paragraph("p1", "one"));
    const plan = lowerEditorDocument(before, after, "inc-1");
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]).toMatchObject({
      kind: "block.move",
      blockId: "p2",
      parentId: null,
      beforeId: "p1",
    });
    expect(plan.normalizedAfter).toEqual(after);
  });

  it("recognizes an exact textblock split", () => {
    const before = state(doc(paragraph("p1", "hello")));
    const after = doc(paragraph("p1", "hel"), paragraph("p2", "lo"));
    const plan = lowerEditorDocument(before, after, "inc-1");
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]).toMatchObject({
      kind: "block.split",
      blockId: "p1",
      newId: "p2",
    });
    expect(plan.normalizedAfter).toEqual(after);
    expect(text(plan.normalizedAfter.content![1])).toBe("lo");
  });

  it("recognizes an exact textblock join", () => {
    const before = state(doc(paragraph("p1", "hel"), paragraph("p2", "lo")));
    const after = doc(paragraph("p1", "hello"));
    const plan = lowerEditorDocument(before, after, "inc-1");
    expect(plan.commands[0]).toMatchObject({
      kind: "block.join",
      leftId: "p1",
      rightId: "p2",
    });
    expect(plan.commands.map((command) => command.kind)).not.toContain(
      "block.delete",
    );
    expect(plan.normalizedAfter).toEqual(after);
  });

  it("uses typed row insertion with deterministic new cell ids", () => {
    const before = state(
      doc(
        table(
          "t1",
          row("r1", cell("c11", "p11", "head")),
        ),
      ),
      [{ tableId: "t1", rowIds: ["r1"], columnIds: ["col1"] }],
    );
    const after = doc(
      table(
        "t1",
        row("r1", cell("c11", "p11", "head")),
        row("r2", cell("c21", "p21")),
      ),
    );
    const plan = lowerEditorDocument(before, after, "inc-1");
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]).toMatchObject({
      kind: "table.row.insert",
      tableId: "t1",
      rowId: "r2",
      beforeId: null,
    });
    expect(plan.idMap.c21).toBeTruthy();
    expect(plan.idMap.p21).toBeTruthy();
    expect(plan.idMap.c21).not.toBe("c21");
    const insertedRow = plan.normalizedAfter.content![0].content![1];
    expect(insertedRow.attrs!.id).toBe("r2");
    expect(insertedRow.content![0].attrs!.id).toBe(plan.idMap.c21);
    expect(insertedRow.content![0].content![0].attrs!.id).toBe(
      plan.idMap.p21,
    );
  });

  it("uses typed column insertion and remaps provisional cell ids", () => {
    const before = state(
      doc(table("t1", row("r1", cell("c11", "p11", "left")))),
      [{ tableId: "t1", rowIds: ["r1"], columnIds: ["col1"] }],
    );
    const after = doc(
      table("t1", row("r1", cell("c11", "p11", "left"), cell("c12", "p12"))),
    );
    const plan = lowerEditorDocument(before, after, "inc-1");
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]).toMatchObject({
      kind: "table.column.insert",
      tableId: "t1",
    });
    expect(plan.commands[0]).toMatchObject({ beforeId: null });
    expect(plan.idMap.c12).toBeTruthy();
    expect(plan.idMap.p12).toBeTruthy();
    const insertedCell = plan.normalizedAfter.content![0].content![0].content![1];
    expect(insertedCell.attrs!.id).toBe(plan.idMap.c12);
    expect(insertedCell.content![0].attrs!.id).toBe(plan.idMap.p12);
    expect(
      plan.normalizedAfter.content![0].content![0].content![0].attrs!.id,
    ).toBe("c11");
  });

  it("uses typed column deletion and keeps surviving cell ids", () => {
    const before = state(
      doc(
        table(
          "t1",
          row("r1", cell("c11", "p11", "keep"), cell("c12", "p12", "drop")),
        ),
      ),
      [{ tableId: "t1", rowIds: ["r1"], columnIds: ["col1", "col2"] }],
    );
    const after = doc(
      table("t1", row("r1", cell("c11", "p11", "keep"))),
    );
    const plan = lowerEditorDocument(before, after, "inc-1");
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]).toMatchObject({
      kind: "table.column.delete",
      tableId: "t1",
      columnId: "col2",
    });
    expect(plan.normalizedAfter.content![0].content![0].content![0].attrs!.id).toBe(
      "c11",
    );
    expect(
      plan.normalizedAfter.content![0].content![0].content!.length,
    ).toBe(1);
  });

  it("preserves text edits inside an existing table cell as inline atoms", () => {
    const before = state(
      doc(table("t1", row("r1", cell("c11", "p11", "before")))),
      [{ tableId: "t1", rowIds: ["r1"], columnIds: ["col1"] }],
    );
    const after = doc(
      table("t1", row("r1", cell("c11", "p11", "after"))),
    );
    const plan = lowerEditorDocument(before, after, "inc-1");
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]).toMatchObject({
      kind: "inline",
      blockId: "p11",
    });
    const paragraph = plan.normalizedAfter.content![0].content![0].content![0].content![0];
    expect(paragraph.attrs!.id).toBe("p11");
    expect(text(paragraph)).toBe("after");
  });

  it("rejects duplicate block ids in the client document", () => {
    const before = state(doc(paragraph("p1", "one")));
    const after = doc(paragraph("p1", "one"), paragraph("p1", "two"));
    expect(() => lowerEditorDocument(before, after, "inc-1")).toThrow();
  });
});
