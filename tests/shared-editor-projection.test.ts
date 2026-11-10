import { getSchema } from "@tiptap/core";
import { history, undo } from "@tiptap/pm/history";
import { Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection, Transaction } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { FolioMoveStep } from "../src/collaboration/runtime/pm-move";
import { projectSharedDocument } from "../src/editor/shared-projection";
import { documentSchema, extensions } from "../src/shared/editor-schema";

function pmDoc(json: unknown): PMNode {
  const doc = documentSchema.nodeFromJSON(json);
  doc.check();
  return doc;
}

function paragraph(id: string, text: string) {
  return {
    type: "paragraph",
    attrs: { id },
    content: text.length > 0 ? [{ type: "text", text }] : [],
  };
}

function applyProjection(
  state: EditorState,
  projection: ReturnType<typeof projectSharedDocument>,
  addToHistory = false,
): EditorState {
  const transaction = state.tr;
  for (const step of projection.steps) transaction.step(step);
  if (!addToHistory) transaction.setMeta("addToHistory", false);
  return state.apply(transaction);
}

function nodePos(doc: PMNode, id: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.attrs?.id === id) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

function blockText(doc: PMNode, id: string): string {
  let text = "";
  doc.descendants((node) => {
    if (text === "" && node.attrs?.id === id) text = node.textContent;
  });
  return text;
}

function selectionInside(state: EditorState, id: string): boolean {
  let inside = false;
  state.doc.descendants((node, pos) => {
    if (
      node.attrs?.id === id &&
      state.selection.from >= pos &&
      state.selection.to <= pos + node.nodeSize
    )
      inside = true;
  });
  return inside;
}

describe("projectSharedDocument", () => {
  it("moves identified blocks with a FolioMoveStep and maps selection", () => {
    const base = pmDoc({
      type: "doc",
      content: [paragraph("a", "Alpha local"), paragraph("b", "Beta")],
    });
    const target = pmDoc({
      type: "doc",
      content: [paragraph("b", "Beta"), paragraph("a", "Alpha remote")],
    });

    let state = EditorState.create({ doc: base });
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 3)),
    );

    const projection = projectSharedDocument(state.doc, target);
    expect(projection.steps.some((step) => step instanceof FolioMoveStep)).toBe(
      true,
    );
    expect(projection.doc.eq(target)).toBe(true);

    const next = applyProjection(state, projection);
    expect(next.doc.eq(target)).toBe(true);
    expect(blockText(next.doc, "a")).toBe("Alpha remote");
    expect(next.selection.$from.parent.attrs.id).toBe("a");
  });

  it("keeps native history for own text while a remote projection sticks", () => {
    const base = pmDoc({
      type: "doc",
      content: [paragraph("a", "one"), paragraph("b", "two")],
    });
    const target = pmDoc({
      type: "doc",
      content: [paragraph("a", "one local"), paragraph("b", "two remote")],
    });

    let state = EditorState.create({ doc: base, plugins: [history()] });
    const endOfA = nodePos(state.doc, "a") + 1 + "one".length;
    state = state.apply(state.tr.insertText(" local", endOfA, endOfA));
    expect(blockText(state.doc, "a")).toBe("one local");

    const projection = projectSharedDocument(state.doc, target);
    state = applyProjection(state, projection);
    expect(state.doc.eq(target)).toBe(true);
    expect(blockText(state.doc, "b")).toBe("two remote");

    let undone = false;
    undo(state, (transaction: Transaction) => {
      state = state.apply(transaction);
      undone = true;
    });
    expect(undone).toBe(true);
    expect(blockText(state.doc, "a")).toBe("one");
    expect(blockText(state.doc, "b")).toBe("two remote");
  });

  const tableTypes = (() => {
    const names = Object.keys(documentSchema.nodes);
    const table = names.find(
      (name) => /table/i.test(name) && !/row|cell|header/i.test(name),
    );
    const row = names.find((name) => /row/i.test(name));
    const cell = names.find((name) => /cell|header/i.test(name));
    return table && row && cell ? { table, row, cell } : null;
  })();

  function cell(
    types: { cell: string },
    id: string,
    paragraphId: string,
    text: string,
  ) {
    return {
      type: types.cell,
      attrs: { id },
      content: [paragraph(paragraphId, text)],
    };
  }

  function table(
    types: { table: string; row: string; cell: string },
    id: string,
    rows: { id: string; cells: { id: string; paragraphId: string; text: string }[] }[],
  ) {
    return {
      type: types.table,
      attrs: { id },
      content: rows.map((row) => ({
        type: types.row,
        attrs: { id: row.id },
        content: row.cells.map((entry) =>
          cell(types, entry.id, entry.paragraphId, entry.text),
        ),
      })),
    };
  }

  (tableTypes ? it : it.skip)(
    "adds a table row and column without resetting an existing cell selection",
    () => {
      const types = tableTypes!;
      const base = pmDoc({
        type: "doc",
        content: [
          table(types, "t1", [
            {
              id: "r1",
              cells: [
                { id: "c11", paragraphId: "p11", text: "a" },
                { id: "c12", paragraphId: "p12", text: "b" },
              ],
            },
            {
              id: "r2",
              cells: [
                { id: "c21", paragraphId: "p21", text: "c" },
                { id: "c22", paragraphId: "p22", text: "d" },
              ],
            },
          ]),
        ],
      });
      const target = pmDoc({
        type: "doc",
        content: [
          table(types, "t1", [
            {
              id: "r1",
              cells: [
                { id: "c11", paragraphId: "p11", text: "a" },
                { id: "c12", paragraphId: "p12", text: "b" },
                { id: "c13", paragraphId: "p13", text: "e" },
              ],
            },
            {
              id: "r2",
              cells: [
                { id: "c21", paragraphId: "p21", text: "c" },
                { id: "c22", paragraphId: "p22", text: "d" },
                { id: "c23", paragraphId: "p23", text: "f" },
              ],
            },
            {
              id: "r3",
              cells: [
                { id: "c31", paragraphId: "p31", text: "g" },
                { id: "c32", paragraphId: "p32", text: "h" },
                { id: "c33", paragraphId: "p33", text: "i" },
              ],
            },
          ]),
        ],
      });

      let state = EditorState.create({ doc: base });
      const c11 = nodePos(state.doc, "c11");
      state = state.apply(
        state.tr.setSelection(TextSelection.create(state.doc, c11 + 3)),
      );

      const projection = projectSharedDocument(state.doc, target);
      expect(projection.doc.eq(target)).toBe(true);
      const next = applyProjection(state, projection);
      expect(next.doc.eq(target)).toBe(true);
      expect(selectionInside(next, "c11")).toBe(true);
      expect(selectionInside(next, "c13")).toBe(false);
      expect(selectionInside(next, "c31")).toBe(false);
    },
  );

  it("rejects cross-schema targets and lost identifiers", () => {
    const base = pmDoc({
      type: "doc",
      content: [paragraph("a", "Alpha")],
    });
    const otherSchema = getSchema(extensions());
    const other = otherSchema.nodeFromJSON({
      type: "doc",
      content: [paragraph("a", "Alpha")],
    });
    expect(() => projectSharedDocument(base, other)).toThrow(/SCHEMA/);

    const lost = pmDoc({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "" },
          content: [{ type: "text", text: "Alpha" }],
        },
      ],
    });
    expect(() => projectSharedDocument(base, lost)).toThrow(/PROJECTION_/);

    const duplicate = pmDoc({
      type: "doc",
      content: [paragraph("a", "Alpha"), paragraph("a", "Beta")],
    });
    expect(() => projectSharedDocument(base, duplicate)).toThrow(/DUPLICATE/);
  });
});
