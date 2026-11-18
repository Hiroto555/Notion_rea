import { describe, expect, it } from "vitest";
import type { Doc } from "../src/shared/types";
import type { DocumentState } from "../src/collaboration/runtime/contract";
import {
  applyBlockFrame,
  type BlockFrameCommand,
} from "../src/collaboration/runtime/block-frame";
import { lowerEditorDocument } from "../src/collaboration/runtime/editor-plan";
import { initialState } from "../src/collaboration/runtime/document";

function text(value: string): Doc {
  return { type: "text", text: value };
}

function paragraph(id: string, value = ""): Doc {
  const node: Doc = { type: "paragraph", attrs: { id } };
  if (value) node.content = [text(value)];
  return node;
}

function doc(...content: Doc[]): Doc {
  return { type: "doc", content };
}

function state(document: Doc, tombstones: string[] = []): DocumentState {
  return { document, tables: [], tombstones };
}

function listItem(id: string, child: Doc): Doc {
  return { type: "listItem", attrs: { id }, content: [child] };
}

function bulletList(id: string, items: Doc[]): Doc {
  return { type: "bulletList", attrs: { id }, content: items };
}

function frame(command: Omit<BlockFrameCommand, "kind">): BlockFrameCommand {
  return { kind: "block.frame", ...command };
}

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : "UNKNOWN";
  }
}

function firstBlock(document: Doc, type: string): Doc {
  const found = (document.content ?? []).find((node) => node.type === type);
  expect(found).toBeDefined();
  return found!;
}

describe("applyBlockFrame", () => {
  it("wraps paragraphs into a list while carrying the latest remote rich text", () => {
    const basis = state(doc(paragraph("p1", "old"), paragraph("p2", "two")));
    const current: DocumentState = state(
      doc(
        {
          type: "paragraph",
          attrs: { id: "p1" },
          content: [
            { type: "text", text: "remote ", marks: [{ type: "bold" }] },
            { type: "text", text: "hello" },
            { type: "hardBreak" },
            { type: "text", text: "again" },
          ],
        },
        paragraph("p2", "two"),
      ),
    );
    const command = frame({
      parentId: null,
      beforeIds: ["p1", "p2"],
      retainIds: ["p1", "p2"],
      after: [
        bulletList("list1", [
          listItem("item1", paragraph("p1", "stale")),
          listItem("item2", paragraph("p2", "stale")),
        ]),
      ],
    });

    const result = applyBlockFrame(current, command, basis);
    const list = firstBlock(result.state.document, "bulletList");
    expect(list.attrs?.id).toBe("list1");
    expect(list.content?.[0].content?.[0].attrs?.id).toBe("p1");
    expect(list.content?.[0].content?.[0].content).toEqual([
      { type: "text", text: "remote ", marks: [{ type: "bold" }] },
      { type: "text", text: "hello" },
      { type: "hardBreak" },
      { type: "text", text: "again" },
    ]);
    expect(result.state.tombstones).toEqual([]);
  });

  it("unwraps a list and tombstones every dropped wrapper id", () => {
    const before = state(
      doc(
        bulletList("list1", [
          listItem("item1", paragraph("p1", "one")),
          listItem("item2", paragraph("p2", "two")),
        ]),
      ),
    );
    const current = state(
      doc(
        bulletList("list1", [
          listItem("item1", paragraph("p1", "remote one")),
          listItem("item2", paragraph("p2", "two")),
        ]),
      ),
    );
    const command = frame({
      parentId: null,
      beforeIds: ["list1"],
      retainIds: ["p1", "p2"],
      after: [paragraph("p1", "stale"), paragraph("p2", "stale")],
    });

    const result = applyBlockFrame(current, command, before);
    expect(result.state.document.content?.map((node) => node.attrs?.id)).toEqual(
      ["p1", "p2"],
    );
    expect(result.state.document.content?.[0].content).toEqual([
      { type: "text", text: "remote one" },
    ]);
    expect([...result.state.tombstones].sort()).toEqual(
      ["item1", "item2", "list1"].sort(),
    );
  });

  it("rejects a concurrent insertion inside the replaced interval", () => {
    const basis = state(doc(paragraph("p1", "one"), paragraph("p2", "two")));
    const current = state(
      doc(paragraph("p1", "one"), paragraph("px", "intruder"), paragraph("p2", "two")),
    );
    const command = frame({
      parentId: null,
      beforeIds: ["p1", "p2"],
      retainIds: ["p1", "p2"],
      after: [
        bulletList("list1", [
          listItem("item1", paragraph("p1", "one")),
          listItem("item2", paragraph("p2", "two")),
        ]),
      ],
    });

    expect(codeOf(() => applyBlockFrame(current, command, basis))).toBe(
      "FRAME_CONFLICT",
    );
  });

  it("refuses to discard an unobserved remote child (DELETE_CONFLICT)", () => {
    const basis = state(
      doc(
        bulletList("list1", [
          listItem("item1", paragraph("p1", "one")),
          listItem("item2", paragraph("p2", "two")),
        ]),
      ),
    );
    const current = state(
      doc(
        bulletList("list1", [
          listItem("item1", paragraph("p1", "one")),
          listItem("item2", paragraph("p2", "two")),
          listItem("item3", paragraph("p3", "remote")),
        ]),
      ),
    );
    const command = frame({
      parentId: null,
      beforeIds: ["list1"],
      retainIds: ["p1", "p2"],
      after: [paragraph("p1", "one"), paragraph("p2", "two")],
    });

    expect(codeOf(() => applyBlockFrame(current, command, basis))).toBe(
      "DELETE_CONFLICT",
    );
  });

  it("CASes removed wrapper attrs against the trusted basis (FRAME_CONFLICT)", () => {
    const basis = state(
      doc(
        {
          type: "bulletList",
          attrs: { id: "list1", marker: "old" },
          content: [listItem("item1", paragraph("p1", "one"))],
        },
      ),
    );
    const current = state(
      doc(
        {
          type: "bulletList",
          attrs: { id: "list1", marker: "remote" },
          content: [listItem("item1", paragraph("p1", "one"))],
        },
      ),
    );
    const command = frame({
      parentId: null,
      beforeIds: ["list1"],
      retainIds: ["p1"],
      after: [paragraph("p1", "one")],
    });

    expect(codeOf(() => applyBlockFrame(current, command, basis))).toBe(
      "FRAME_CONFLICT",
    );
  });

  it("rejects reused tombstones and duplicate retain ids", () => {
    const basis = state(doc(paragraph("p1", "one")));
    const current = state(doc(paragraph("p1", "one")), ["list1"]);
    const reused = frame({
      parentId: null,
      beforeIds: ["p1"],
      retainIds: ["p1"],
      after: [bulletList("list1", [listItem("item1", paragraph("p1", "one"))])],
    });
    expect(codeOf(() => applyBlockFrame(current, reused, basis))).toBe(
      "TOMBSTONED_ID",
    );

    const duplicate = frame({
      parentId: null,
      beforeIds: ["p1"],
      retainIds: ["p1", "p1"],
      after: [bulletList("list1", [listItem("item1", paragraph("p1", "one"))])],
    });
    expect(codeOf(() => applyBlockFrame(current, duplicate, basis))).toBe(
      "DUPLICATE_ID",
    );
  });

  it("refuses table introduction so table metadata cannot be bypassed", () => {
    const basis = state(doc(paragraph("p1", "one")));
    const current = state(doc(paragraph("p1", "one")));
    const command = frame({
      parentId: null,
      beforeIds: ["p1"],
      retainIds: ["p1"],
      after: [
        {
          type: "callout",
          attrs: { id: "callout1" },
          content: [{ type: "table", attrs: { id: "table1" }, content: [{type: "tableRow", attrs: {id: "row1"}, content: [{type: "tableCell", attrs: {id: "cell1"}, content: [paragraph("p1", "one")]}]}] }],
        },
      ],
    });

    expect(codeOf(() => applyBlockFrame(current, command, basis))).toBe(
      "TABLE_INTERNAL",
    );
  });

  it("refuses dropping an existing table through a frame", () => {
    const table: Doc = { type: "table", attrs: { id: "table1" } };
    const basis = state(doc(table));
    const current = state(doc({ type: "table", attrs: { id: "table1" } }));
    const command = frame({
      parentId: null,
      beforeIds: ["table1"],
      retainIds: [],
      after: [paragraph("p1", "replacement")],
    });

    expect(codeOf(() => applyBlockFrame(current, command, basis))).toBe(
      "TABLE_INTERNAL",
    );
  });
});

describe("lowerEditorDocument reframe lowering", () => {
  it("wraps paragraphs into a list, then unwraps on undo, without reseeding", () => {
    const before = state(doc(paragraph("p1", "one"), paragraph("p2", "two")));
    const target = doc(
      bulletList("list1", [
        listItem("item1", paragraph("p1", "one")),
        listItem("item2", paragraph("p2", "two")),
      ]),
    );
    const lowered = lowerEditorDocument(before, target, "inc1");
    expect(lowered.normalizedAfter).toEqual(initialState(target).document);
    const kinds = lowered.commands.map((command) => command.kind);
    expect(kinds).toContain("block.frame");
    expect(kinds).not.toContain("block.replace");
    expect(
      lowered.commands.some((command) => command.kind === "block.frame"),
    ).toBe(true);

    const undo = lowerEditorDocument(
      { document: lowered.normalizedAfter, tables: [], tombstones: [] },
      doc(paragraph("p1", "one"), paragraph("p2", "two")),
      "inc1",
    );
    expect(undo.normalizedAfter).toEqual(
      initialState(doc(paragraph("p1", "one"), paragraph("p2", "two")))
        .document,
    );
    expect(undo.commands.some((command) => command.kind === "block.frame")).toBe(
      true,
    );
  });

  it("wraps an existing paragraph in a blockquote and applies authored text", () => {
    const before = state(doc(paragraph("p1", "base")));
    const target = doc({
      type: "blockquote",
      attrs: { id: "quote1" },
      content: [paragraph("p1", "changed")],
    });
    const lowered = lowerEditorDocument(before, target, "inc1");
    expect(lowered.normalizedAfter).toEqual(initialState(target).document);
    expect(lowered.commands[0].kind).toBe("block.frame");
    expect(lowered.commands.some((command) => command.kind === "inline")).toBe(
      true,
    );
  });

  it("wraps an existing paragraph in details with fresh container ids", () => {
    const before = state(doc(paragraph("p1", "hello")));
    const target = doc({
      type: "details",
      attrs: { id: "details1" },
      content: [
        {
          type: "detailsSummary",
          attrs: { id: "summary1" },
          content: [text("Summary")],
        },
        {
          type: "detailsContent",
          attrs: { id: "content1" },
          content: [paragraph("p1", "hello")],
        },
      ],
    });
    const lowered = lowerEditorDocument(before, target, "inc1");
    expect(lowered.normalizedAfter).toEqual(initialState(target).document);
    const frames = lowered.commands.filter(
      (command) => command.kind === "block.frame",
    );
    expect(frames).toHaveLength(1);
    const command = frames[0] as BlockFrameCommand;
    expect(command.retainIds).toEqual(["p1"]);
    expect(command.beforeIds).toEqual(["p1"]);
  });
});
