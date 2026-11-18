import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Transform } from "@tiptap/pm/transform";
import { describe, expect, it } from "vitest";
import { documentSchema } from "../src/shared/editor-schema";
import { FolioFrameStep } from "../src/editor/shared-frame-step";
import { projectSharedDocument } from "../src/editor/shared-projection";

const schema = documentSchema;

type Json = Record<string, unknown>;

function text(value: string): Json {
  return { type: "text", text: value };
}

function paragraph(id: string, value: string): Json {
  return {
    type: "paragraph",
    attrs: { id },
    content: value ? [text(value)] : [],
  };
}

function listItem(id: string, ...content: Json[]): Json {
  return { type: "listItem", attrs: { id }, content };
}

function bulletList(id: string, ...content: Json[]): Json {
  return { type: "bulletList", attrs: { id }, content };
}

function blockquote(id: string, ...content: Json[]): Json {
  return { type: "blockquote", attrs: { id }, content };
}

function doc(...content: Json[]): PMNode {
  return schema.nodeFromJSON({ type: "doc", content });
}

function find(node: PMNode, id: string): { node: PMNode; pos: number } {
  let found: { node: PMNode; pos: number } | null = null;
  node.descendants((child, pos) => {
    if (child.attrs?.id === id) {
      found = { node: child, pos };
      return false;
    }
    return true;
  });
  if (!found) throw new Error(`TEST_NODE_MISSING:${id}`);
  return found;
}

function textOf(node: PMNode, id: string): string {
  return find(node, id).node.textContent;
}

function applyTransform(
  state: EditorState,
  transform: Transform,
  addToHistory = true,
): EditorState {
  const tr: Transaction = state.tr;
  for (const step of transform.steps) tr.step(step);
  tr.setMeta("addToHistory", addToHistory);
  return state.apply(tr);
}

describe("identified frame projection", () => {
  it("wraps a paragraph into a bullet list and preserves the same id", () => {
    const current = doc(paragraph("X", "hello"));
    const target = doc(
      bulletList("L", listItem("I", paragraph("X", "hello"))),
    );

    const tr = projectSharedDocument(current, target);

    expect(tr.doc.eq(target)).toBe(true);
    expect(textOf(tr.doc, "X")).toBe("hello");
    expect(tr.steps).toHaveLength(1);
    expect(tr.steps[0]).toBeInstanceOf(FolioFrameStep);

    const step = tr.steps[0] as FolioFrameStep;
    expect(FolioFrameStep.fromJSON(schema, step.toJSON()).toJSON()).toEqual(
      step.toJSON(),
    );
    const inverse = step.apply(current).doc ? step.invert(current) : null;
    expect(inverse).not.toBeNull();
    expect(inverse!.apply(target).doc?.eq(current)).toBe(true);
  });

  it("unwraps the same paragraph back to the exact original target", () => {
    const wrapped = doc(
      bulletList("L", listItem("I", paragraph("X", "hello"))),
    );
    const target = doc(paragraph("X", "hello"));

    const tr = projectSharedDocument(wrapped, target);

    expect(tr.doc.eq(target)).toBe(true);
    expect(find(tr.doc, "X").node.type.name).toBe("paragraph");
    expect(tr.steps[0]).toBeInstanceOf(FolioFrameStep);
  });

  it("maps a selection inside the retained subtree across wrap and unwrap", () => {
    const current = doc(paragraph("X", "hello"));
    const target = doc(
      bulletList("L", listItem("I", paragraph("X", "hello"))),
    );
    const x = find(current, "X");
    const inside = x.pos + 1 + 2;
    const selection = TextSelection.create(current, inside);
    const state0 = EditorState.create({ doc: current, schema });
    const state = state0.apply(state0.tr.setSelection(selection));

    const tr = projectSharedDocument(state.doc, target);
    const mapped = tr.mapping.map(inside);

    expect(mapped).toBe(find(tr.doc, "X").pos + 1 + 2);
    const applied = applyTransform(state, tr);
    expect(applied.selection.from).toBe(mapped);
    expect(applied.selection.empty).toBe(true);
  });

  it("applies a wrapper plus an intentional retained text change exactly", () => {
    const current = doc(paragraph("A", "one"), paragraph("B", "two"));
    const target = doc(
      blockquote("Q", paragraph("A", "one changed")),
      paragraph("B", "two"),
    );

    const tr = projectSharedDocument(current, target);

    expect(tr.doc.eq(target)).toBe(true);
    expect(textOf(tr.doc, "A")).toBe("one changed");
    expect(find(tr.doc, "A").node.type.name).toBe("paragraph");
  });

  it("keeps remote text after a remote wrap and still undoes own native text", () => {
    const base = doc(paragraph("X", "own"));
    const x = find(base, "X");
    const state0 = EditorState.create({
      doc: base,
      schema,
      plugins: [history()],
    });
    const typed = state0.apply(
      state0.tr.insertText("!", x.pos + 1 + 3),
    );
    expect(textOf(typed.doc, "X")).toBe("own!");

    const target = doc(
      bulletList("L", listItem("I", paragraph("X", "KEEPown!"))),
      paragraph("R", "RemoteKEEP"),
    );
    const remote = projectSharedDocument(typed.doc, target);
    const remoteState = applyTransform(typed, remote, false);

    expect(textOf(remoteState.doc, "R")).toBe("RemoteKEEP");
    expect(find(remoteState.doc, "X").node.type.name).toBe("paragraph");

    let undone = remoteState;
    expect(undo(remoteState, transaction => {undone = remoteState.apply(transaction);})).toBe(true);

    expect(textOf(undone.doc, "X")).toBe("KEEPown");
    expect(textOf(undone.doc, "R")).toBe("RemoteKEEP");
    expect(find(undone.doc, "L").node.type.name).toBe("bulletList");
  });

  it("rejects an invalid wrapper template atomically", () => {
    const current = doc(paragraph("X", "keep"));
    const missingRetained = FolioFrameStep.create(current, {
      parentId: null,
      spanIds: ["X"],
      retainedIds: ["X"],
      template: [
        {
          type: "bulletList",
          attrs: { id: "L" },
          content: [
            {
              type: "listItem",
              attrs: { id: "I" },
              content: [paragraph("OTHER", "replacement")],
            },
          ],
        },
      ],
    });

    const failed = missingRetained.apply(current);

    expect(failed.failed).toMatch(/^FRAME_TEMPLATE_MISSING_RETAINED/);

    const withSibling = doc(paragraph("X", "keep"), paragraph("B", "other"));
    const collision = FolioFrameStep.create(withSibling, {
      parentId: null,
      spanIds: ["X"],
      retainedIds: ["X"],
      template: [
        {
          type: "bulletList",
          attrs: { id: "B" },
          content: [
            {
              type: "listItem",
              attrs: { id: "I" },
              content: [paragraph("X", "keep")],
            },
          ],
        },
      ],
    });
    const collided = collision.apply(withSibling);
    expect(collided.failed).toMatch(/^FRAME_ID_COLLISION/);
  });
});
