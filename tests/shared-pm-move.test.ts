import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { closeHistory, history, redo, undo } from "@tiptap/pm/history";
import { Step, Mapping, StepMap } from "@tiptap/pm/transform";
import {
  FolioMoveStep,
  applyMoveTransform,
  moveStep,
} from "../src/collaboration/runtime/pm-move";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      content: "inline*",
      group: "block",
      attrs: { id: { default: null } },
    },
    blockquote: {
      content: "block+",
      group: "block",
      attrs: { id: { default: null } },
    },
    text: { group: "inline" },
  },
});

function paragraph(id: string, text = ""): Record<string, unknown> {
  return {
    type: "paragraph",
    attrs: { id },
    ...(text ? { content: [{ type: "text", text }] } : {}),
  };
}

function blockquote(
  id: string,
  content: Record<string, unknown>[],
): Record<string, unknown> {
  return { type: "blockquote", attrs: { id }, content };
}

function document(...content: Record<string, unknown>[]): Record<string, unknown> {
  return { type: "doc", content };
}

function pmDoc(json: Record<string, unknown>) {
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

function childIds(doc: ReturnType<typeof pmDoc>): string[] {
  const ids: string[] = [];
  doc.forEach((child) => ids.push(String(child.attrs.id)));
  return ids;
}

function textOf(node: { textContent: string }): string {
  return node.textContent;
}

function find(doc: ReturnType<typeof pmDoc>, id: string) {
  let found: ReturnType<typeof pmDoc> | null = null;
  doc.descendants((node) => {
    if (node.attrs?.id === id) {
      found = node;
      return false;
    }
    return true;
  });
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

function undoOnce(state: EditorState): { state: EditorState; changed: boolean } {
  let next = state;
  let dispatched = false;
  const changed = undo(state, (tr) => {
    next = state.apply(tr);
    dispatched = true;
  });
  return { state: next, changed: Boolean(changed && dispatched) };
}

function redoOnce(state: EditorState): { state: EditorState; changed: boolean } {
  let next = state;
  let dispatched = false;
  const changed = redo(state, (tr) => {
    next = state.apply(tr);
    dispatched = true;
  });
  return { state: next, changed: Boolean(changed && dispatched) };
}

describe("FolioMoveStep", () => {
  it("moves a block before another block without delete+insert semantics", () => {
    const doc = pmDoc(
      document(paragraph("a", "A"), paragraph("b", "B"), paragraph("c", "C")),
    );
    const tr = applyMoveTransform(doc, "c", null, "a");
    expect(childIds(tr.doc)).toEqual(["c", "a", "b"]);
    expect(tr.steps).toHaveLength(1);
    expect(tr.steps[0]).toBeInstanceOf(FolioMoveStep);
    expect(tr.steps[0].toJSON().stepType).toBe("folioMove");
  });

  it("moves across parents and keeps block text", () => {
    const doc = pmDoc(
      document(
        paragraph("a", "A"),
        blockquote("q", [paragraph("b", "B"), paragraph("c", "C")]),
        paragraph("d", "D"),
      ),
    );
    const tr = applyMoveTransform(doc, "c", null, "d");
    expect(childIds(tr.doc)).toEqual(["a", "q", "c", "d"]);
    expect(textOf(find(tr.doc, "c"))).toBe("C");

    const into = applyMoveTransform(doc, "a", "q", "b");
    expect(textOf(find(into.doc, "q"))).toBe("ABC");
    expect(childIds(find(into.doc, "q"))).toEqual(["a", "b", "c"]);
  });

  it("applies the latest identified subtree instead of a stale snapshot", () => {
    const before = pmDoc(
      document(paragraph("a", "A"), paragraph("b", "B"), paragraph("c", "C")),
    );
    const step = moveStep(before, "a", null, "c");
    const later = pmDoc(
      document(
        paragraph("a", "A with concurrent text"),
        paragraph("b", "B"),
        paragraph("c", "C"),
      ),
    );
    const delta = later.child(0).nodeSize - before.child(0).nodeSize;
    expect(step.apply(later).failed).toBe("MOVE_UNMAPPED_POSITION");
    const mapped = step.map(new Mapping([new StepMap([2, 0, delta])]))!;
    const result = mapped.apply(later);
    expect(result.failed).toBeNull();
    expect(childIds(result.doc!)).toEqual(["b", "a", "c"]);
    expect(textOf(find(result.doc!, "a"))).toBe("A with concurrent text");
  });

  it("round-trips deterministic JSON through Step.fromJSON", () => {
    const doc = pmDoc(
      document(paragraph("a", "A"), paragraph("b", "B"), paragraph("c", "C")),
    );
    const step = moveStep(doc, "c", null, "a");
    const json = JSON.parse(JSON.stringify(step.toJSON()));
    const parsed = Step.fromJSON(schema, json) as FolioMoveStep;
    expect(parsed).toBeInstanceOf(FolioMoveStep);
    expect(parsed.toJSON()).toEqual(step.toJSON());
    expect(parsed.apply(doc).doc!.eq(step.apply(doc).doc!)).toBe(true);
  });

  it("maps positions inside the moved subtree without collapsing them", () => {
    const doc = pmDoc(
      document(paragraph("a", "A"), paragraph("b", "B"), paragraph("c", "C")),
    );
    const step = moveStep(doc, "c", null, "a");
    const map = step.getMap();
    expect(map.map(6)).toBe(0);
    expect(map.map(7)).toBe(1);
    expect(map.map(8)).toBe(2);
    expect(map.map(9, -1)).toBe(3);
    expect(map.map(9, 1)).toBe(9);
    expect(map.map(6, -1)).toBe(9);
    expect(map.map(0)).toBe(3);
    expect(map.map(3)).toBe(6);
    const inside = map.mapResult(7);
    expect(inside.pos).toBe(1);
    expect(inside.deletedAcross).toBe(false);
    expect(map.mapResult(3).deletedAcross).toBe(false);

    const mapped = step.map(new Mapping([new StepMap([0, 0, 1])])) as FolioMoveStep;
    expect(mapped.from).toBe(7);
    expect(mapped.to).toBe(10);
    expect(mapped.insertPos).toBe(1);
  });

  it("inverts a move for native ProseMirror history", () => {
    const doc = pmDoc(
      document(
        paragraph("a", "A"),
        paragraph("b", "B"),
        blockquote("q", [paragraph("c", "C"), paragraph("d", "D")]),
      ),
    );
    const step = moveStep(doc, "c", null, "a");
    const result = step.apply(doc);
    expect(result.failed).toBeNull();
    const inverse = step.invert(doc);
    const restored = inverse.apply(result.doc!);
    expect(restored.failed).toBeNull();
    expect(restored.doc!.eq(doc)).toBe(true);
  });

  it("undoes earlier own text after a native move undo, preserving remote text", () => {
    const doc = pmDoc(
      document(paragraph("a", "A"), paragraph("b", "B"), paragraph("c", "C")),
    );
    let state = EditorState.create({
      schema,
      doc,
      plugins: [history({ newGroupDelay: 0 })],
    });

    state = state.apply(state.tr.insertText("X", 1, 1));

    state = state.apply(
      state.tr.insertText("KEEP", 1, 1).setMeta("addToHistory", false),
    );

    const moveTr = state.tr;
    closeHistory(moveTr);
    moveTr.step(moveStep(state.doc, "c", null, "a"));
    state = state.apply(moveTr);
    expect(childIds(state.doc)).toEqual(["c", "a", "b"]);
    expect(textOf(find(state.doc, "a"))).toBe("KEEPXA");

    const first = undoOnce(state);
    expect(first.changed).toBe(true);
    state = first.state;
    expect(childIds(state.doc)).toEqual(["a", "b", "c"]);
    expect(textOf(find(state.doc, "a"))).toBe("KEEPXA");

    const second = undoOnce(state);
    expect(second.changed).toBe(true);
    state = second.state;
    expect(textOf(find(state.doc, "a"))).toBe("KEEPA");
    expect(textOf(find(state.doc, "c"))).toBe("C");

    const redone = redoOnce(state);
    expect(redone.changed).toBe(true);
    expect(textOf(find(redone.state.doc, "a"))).toBe("KEEPXA");
  });

  it("rejects cycles, invalid anchors and insertions inside the source atomically", () => {
    const doc = pmDoc(
      document(
        paragraph("a", "A"),
        blockquote("q", [paragraph("b", "B"), paragraph("c", "C")]),
      ),
    );
    const before = doc.toJSON();
    const onlyChild = pmDoc(document(paragraph("a", "A"), blockquote("q", [paragraph("b", "B")])));
    expect(() => applyMoveTransform(onlyChild, "b", null, "a")).toThrow();
    expect(() => moveStep(doc, "q", "b", null)).toThrow("MOVE_CYCLE");
    expect(() => moveStep(doc, "a", null, "missing")).toThrow(
      "MOVE_ANCHOR_MISSING",
    );
    expect(() => moveStep(doc, "missing", null, "a")).toThrow(
      "MOVE_SOURCE_MISSING",
    );
    expect(() => applyMoveTransform(doc, "a", "missing", null)).toThrow(
      "MOVE_PARENT_MISSING",
    );
    expect(doc.toJSON()).toEqual(before);
  });
});
