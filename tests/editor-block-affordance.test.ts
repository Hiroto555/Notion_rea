import { describe, expect, it } from "vitest";
import {
  EditorState,
  NodeSelection,
  TextSelection,
} from "@tiptap/pm/state";
import { history, undo, undoDepth } from "@tiptap/pm/history";
import type { Node as PMNode } from "@tiptap/pm/model";
import { documentSchema } from "../src/shared/editor-schema";
import { blockIdentityPlugin } from "../src/editor/block-identity";
import {
  blockHandleClass,
  caretCueVisible,
  caretTargetAt,
  handleTargetAt,
  nestedHandleEligible,
  resolveElementHit,
} from "../src/editor/block-affordance";

const schema = documentSchema;

function fixture(): PMNode {
  return schema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "first" },
        content: [{ type: "text", text: "Alpha" }],
      },
      { type: "paragraph", attrs: { id: "blank" } },
      {
        type: "bulletList",
        attrs: { id: "list" },
        content: [
          {
            type: "listItem",
            attrs: { id: "itemA" },
            content: [
              {
                type: "paragraph",
                attrs: { id: "a1" },
                content: [{ type: "text", text: "A1" }],
              },
              {
                type: "paragraph",
                attrs: { id: "a2" },
                content: [{ type: "text", text: "A2" }],
              },
            ],
          },
          {
            type: "listItem",
            attrs: { id: "itemB" },
            content: [
              {
                type: "paragraph",
                attrs: { id: "b1" },
                content: [{ type: "text", text: "B1" }],
              },
            ],
          },
        ],
      },
      {
        type: "table",
        attrs: { id: "table" },
        content: [
          {
            type: "tableRow",
            attrs: { id: "row" },
            content: [
              {
                type: "tableCell",
                attrs: { id: "cell" },
                content: [
                  {
                    type: "paragraph",
                    attrs: { id: "cellText" },
                    content: [{ type: "text", text: "C" }],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "paragraph",
        attrs: { id: "last" },
        content: [{ type: "text", text: "Tail" }],
      },
    ],
  });
}

function posOf(doc: PMNode, id: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (node.attrs.id === id) {
      found = pos;
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error("missing block " + id);
  return found;
}

const inside = (doc: PMNode, id: string) => posOf(doc, id) + 1;

function seeded(doc: PMNode): EditorState {
  return EditorState.create({
    schema,
    doc,
    plugins: [history(), blockIdentityPlugin()],
  });
}

function located(
  doc: PMNode,
  id: string,
): { node: PMNode; parent: PMNode | null; index: number } {
  let hit: { node: PMNode; parent: PMNode | null; index: number } | null = null;
  doc.descendants((node, _pos, parent, index) => {
    if (node.attrs.id === id) {
      hit = { node, parent: parent ?? null, index };
      return false;
    }
    return true;
  });
  if (!hit) throw new Error("missing block " + id);
  return hit;
}

describe("block handle targeting", () => {
  it("targets one top-level block per position, including empty paragraphs", () => {
    const doc = fixture();
    expect(handleTargetAt(doc, inside(doc, "first"))).toEqual({
      id: "first",
      nested: false,
    });
    expect(handleTargetAt(doc, inside(doc, "blank"))).toEqual({
      id: "blank",
      nested: false,
    });
    expect(handleTargetAt(doc, inside(doc, "last"))).toEqual({
      id: "last",
      nested: false,
    });
    // A boundary position directly before a block still resolves to it.
    expect(handleTargetAt(doc, posOf(doc, "blank"))).toEqual({
      id: "blank",
      nested: false,
    });
  });

  it("resolves nested targets through the existing eligibility rules", () => {
    const doc = fixture();
    // A list item's first paragraph is excluded: the item handle owns the line.
    expect(handleTargetAt(doc, inside(doc, "a1"))).toEqual({
      id: "itemA",
      nested: true,
    });
    // Later sibling paragraphs keep their own handle.
    expect(handleTargetAt(doc, inside(doc, "a2"))).toEqual({
      id: "a2",
      nested: true,
    });
    expect(handleTargetAt(doc, inside(doc, "b1"))).toEqual({
      id: "itemB",
      nested: true,
    });
    // Table cell contents have dedicated controls: the top-level table wins.
    expect(handleTargetAt(doc, inside(doc, "cellText"))).toEqual({
      id: "table",
      nested: false,
    });
    for (const [id, expected] of [
      ["a1", false],
      ["a2", true],
      ["itemA", true],
      ["cellText", false],
      ["cell", false],
      ["list", false],
    ] as const) {
      const { node, parent, index } = located(doc, id);
      expect(
        nestedHandleEligible(node, parent, index),
        `eligibility of ${id}`,
      ).toBe(expected);
    }
  });

  it("follows the caret into the same block the keyboard cue marks", () => {
    const doc = fixture();
    const base = seeded(doc);
    const state = base.apply(
      base.tr.setSelection(TextSelection.create(doc, inside(doc, "a2"))),
    );
    expect(caretTargetAt(state.doc, state.selection)).toEqual({
      id: "a2",
      nested: true,
    });
    // A reversed or extended selection cues the block holding the head,
    // not the anchor side of the range.
    const reversed = state.apply(
      state.tr.setSelection(
        TextSelection.create(doc, inside(doc, "last"), inside(doc, "a2")),
      ),
    );
    expect(reversed.selection.head).toBe(inside(doc, "a2"));
    expect(caretTargetAt(doc, reversed.selection)!.id).toBe("a2");
  });

  it("cues the actual selected node for node selections", () => {
    const doc = fixture();
    const nodeSel = (target: PMNode, id: string) =>
      NodeSelection.create(target, posOf(target, id));
    // A node selection's head sits after the node: a non-terminal top-level
    // atom still cues its own handle, not the following paragraph.
    const atoms = schema.nodeFromJSON({
      type: "doc",
      content: [
        { type: "image", attrs: { id: "img", src: "a.png" } },
        { type: "horizontalRule", attrs: { id: "hr" } },
        {
          type: "paragraph",
          attrs: { id: "p" },
          content: [{ type: "text", text: "x" }],
        },
      ],
    });
    expect(caretTargetAt(atoms, nodeSel(atoms, "img"))!.id).toBe("img");
    expect(caretTargetAt(atoms, nodeSel(atoms, "hr"))!.id).toBe("hr");
    expect(nodeSel(atoms, "hr").head).toBeGreaterThan(posOf(atoms, "hr"));
    // Middle of adjacent eligible nested siblings keeps its own id.
    expect(caretTargetAt(doc, nodeSel(doc, "itemB"))).toEqual({
      id: "itemB",
      nested: true,
    });
    // An excluded selected node ascends real ancestors: a list item's first
    // paragraph cues the item, table internals cue the top-level table.
    expect(caretTargetAt(doc, nodeSel(doc, "a1"))).toEqual({
      id: "itemA",
      nested: true,
    });
    expect(caretTargetAt(doc, nodeSel(doc, "cellText"))).toEqual({
      id: "table",
      nested: false,
    });
  });

  it("keeps the same block target through a hard break", () => {
    let state = seeded(fixture());
    const pos = inside(state.doc, "first");
    state = state.applyTransaction(
      state.tr
        .setSelection(TextSelection.create(state.doc, pos))
        .replaceSelectionWith(schema.nodes.hardBreak.create()),
    ).state;
    // Shift+Enter adds an inline break: the block, its ID and the handle
    // target are unchanged.
    expect(state.doc.childCount).toBe(5);
    expect(state.doc.child(0).attrs.id).toBe("first");
    expect(handleTargetAt(state.doc, pos)).toEqual({
      id: "first",
      nested: false,
    });
  });

  it("reassigns fresh targets on split and drops removed blocks", () => {
    let state = seeded(fixture());
    const splitPos = posOf(state.doc, "first") + 3;
    state = state.applyTransaction(state.tr.split(splitPos)).state;
    const [kept, added] = [state.doc.child(0), state.doc.child(1)];
    expect(kept.attrs.id).toBe("first");
    expect(added.attrs.id).not.toBe("first");
    // Each half resolves to its own current identity.
    expect(handleTargetAt(state.doc, inside(state.doc, "first"))!.id).toBe(
      "first",
    );
    const addedPos = inside(state.doc, added.attrs.id);
    expect(handleTargetAt(state.doc, addedPos)!.id).toBe(added.attrs.id);
    // Splitting the empty paragraph also produces a fresh, resolvable id.
    state = state.applyTransaction(
      state.tr.split(inside(state.doc, "blank")),
    ).state;
    const blankNext = state.doc.child(3);
    expect(state.doc.child(2).attrs.id).toBe("blank");
    expect(blankNext.attrs.id).not.toBe("blank");
    expect(handleTargetAt(state.doc, posOf(state.doc, blankNext.attrs.id) + 1)!.id).toBe(blankNext.attrs.id);
    // Deleting a block never leaves its id as a live target.
    const gone = added.attrs.id;
    const goneNode = state.doc.child(1);
    state = state.applyTransaction(
      state.tr.delete(
        posOf(state.doc, gone),
        posOf(state.doc, gone) + goneNode.nodeSize,
      ),
    ).state;
    let exists = false;
    state.doc.descendants((node) => {
      if (node.attrs.id === gone) exists = true;
      return true;
    });
    expect(exists).toBe(false);
    const retargeted = handleTargetAt(state.doc, 0);
    expect(retargeted).not.toBeNull();
    expect(retargeted!.id).not.toBe(gone);
    // Undo restores the deleted block and its identity untouched.
    let undone = state;
    expect(
      undo(state, (tr) => {
        undone = state.apply(tr);
      }),
    ).toBe(true);
    expect(handleTargetAt(undone.doc, inside(undone.doc, gone))!.id).toBe(
      gone,
    );
  });

  it("leaves body, IDs and history untouched by visibility resolution", () => {
    const state = seeded(fixture());
    const body = state.doc.toJSON();
    const depth = undoDepth(state);
    for (const id of ["first", "blank", "a1", "a2", "b1", "cellText", "last"])
      handleTargetAt(state.doc, inside(state.doc, id));
    handleTargetAt(state.doc, state.selection.from);
    expect(state.doc.toJSON()).toEqual(body);
    expect(undoDepth(state)).toBe(depth);
  });
});

// Minimal Element stand-ins: resolveElementHit only needs contains(),
// closest(), getAttribute() and parentElement, so a small fake tree exercises
// the real ancestor traversal without a browser.
class FakeEl {
  private parent: FakeEl | null;
  private readonly classes: ReadonlySet<string>;
  private readonly attrs: ReadonlyMap<string, string>;
  constructor(
    parent: FakeEl | null,
    classes: string[] = [],
    attrs: Record<string, string> = {},
  ) {
    this.parent = parent;
    this.classes = new Set(classes);
    this.attrs = new Map(Object.entries(attrs));
  }
  get parentElement(): FakeEl | null {
    return this.parent;
  }
  contains(other: FakeEl | null): boolean {
    for (let n = other; n; n = n.parent) if (n === this) return true;
    return false;
  }
  closest(selector: string): FakeEl | null {
    const cls = selector.startsWith(".") ? selector.slice(1) : selector;
    for (let n: FakeEl | null = this; n; n = n.parent)
      if (n.classes.has(cls)) return n;
    return null;
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
}

const asElement = (el: FakeEl): Element => el as unknown as Element;

describe("direct DOM hit resolution", () => {
  const root = new FakeEl(null);
  const body = new FakeEl(root); // the editable view.dom inside the host
  const hit = (
    el: FakeEl,
    index: ReadonlyMap<Element, string>,
    live: ReadonlySet<string>,
  ) =>
    resolveElementHit({
      hit: asElement(el),
      root: asElement(root),
      index,
      live,
    });

  it("resolves the innermost indexed element, including adjacent atoms and NodeView descendants", () => {
    // [paragraph A, hr B] with a shared-image NodeView after them: each has
    // its own indexed element so the second sibling can never resolve to A.
    const a = new FakeEl(body);
    const b = new FakeEl(body);
    const imageWrap = new FakeEl(body); // span[data-shared-image] NodeView
    const img = new FakeEl(imageWrap); // inner element carries no block id
    const index = new Map<Element, string>([
      [asElement(a), "A"],
      [asElement(b), "B"],
      [asElement(imageWrap), "img"],
    ]);
    const live = new Set(["A", "B", "img"]);
    expect(hit(a, index, live)).toBe("A");
    expect(hit(b, index, live)).toBe("B");
    // A hit deep inside a custom NodeView still finds its owning block.
    expect(hit(img, index, live)).toBe("img");
  });

  it("climbs excluded children and unidentified wrappers to the owning block", () => {
    const list = new FakeEl(body);
    const item = new FakeEl(list);
    const firstP = new FakeEl(item); // excluded list first paragraph
    const secondP = new FakeEl(item); // eligible sibling paragraph
    const table = new FakeEl(body);
    const cellP = new FakeEl(new FakeEl(new FakeEl(table))); // cell paragraph
    const index = new Map<Element, string>([
      [asElement(list), "list"],
      [asElement(item), "itemA"],
      [asElement(secondP), "a2"],
      [asElement(table), "table"],
    ]);
    const live = new Set(["list", "itemA", "a2", "table"]);
    // Excluded children resolve through the nearest indexed ancestor.
    expect(hit(firstP, index, live)).toBe("itemA");
    expect(hit(secondP, index, live)).toBe("a2");
    // Table cell internals fall through to the top-level table handle.
    expect(hit(cellP, index, live)).toBe("table");
  });

  it("prefers own live grips and clears stale, foreign and empty hits", () => {
    const index = new Map<Element, string>();
    const live = new Set(["A", "B"]);
    const grip = new FakeEl(root, ["block-handle"], { "data-block-id": "B" });
    const icon = new FakeEl(grip);
    // The gutter grip and anything inside it resolve to its own live id.
    expect(hit(grip, index, live)).toBe("B");
    expect(hit(icon, index, live)).toBe("B");
    // A pre-commit grip whose id is no longer live must clear, not guess.
    const stale = new FakeEl(root, ["block-handle"], {
      "data-block-id": "gone",
    });
    expect(hit(stale, index, live)).toBeNull();
    // A foreign editor's grip is outside this root entirely.
    const foreign = new FakeEl(new FakeEl(null), ["block-handle"], {
      "data-block-id": "A",
    });
    expect(hit(foreign, index, live)).toBeNull();
    // Chrome, the body margin and empty space below the content carry no
    // indexed element: the hover clears instead of guessing a block.
    expect(hit(new FakeEl(root), index, live)).toBeNull();
    expect(hit(body, index, live)).toBeNull();
  });

  it("resolves the committed element after a same-height reorder", () => {
    const a = new FakeEl(body);
    const b = new FakeEl(body);
    // Before the layout commits, the coords hold A's old geometry; after it,
    // the index is rebuilt from the moved DOM and the same spot is B.
    const committed = new Map<Element, string>([
      [asElement(a), "A"],
      [asElement(b), "B"],
    ]);
    const live = new Set(["A", "B"]);
    expect(hit(b, committed, live)).toBe("B");
    // A's grip is still live, but a hit on B's element can never return A.
    expect(hit(b, committed, live)).not.toBe("A");
  });
});

describe("caret cue ownership", () => {
  const cue = (input: {
    keyboard?: boolean;
    windowFocused?: boolean;
    ownsBody?: boolean;
  }) =>
    caretCueVisible({
      keyboard: input.keyboard ?? false,
      windowFocused: input.windowFocused ?? true,
      ownsBody: input.ownsBody ?? false,
    });

  it("lights only for this editor's keyboard-focused body", () => {
    // Tab into this editor's body.
    expect(cue({ keyboard: true, ownsBody: true })).toBe(true);
    // Pointer modality in the same body never lights the cue.
    expect(cue({ ownsBody: true })).toBe(false);
    // Tab-held modality but focus moved to another editor or the sidebar.
    expect(cue({ keyboard: true, ownsBody: false })).toBe(false);
    // A deactivated window clears ownership even with the body still marked.
    expect(cue({ keyboard: true, windowFocused: false, ownsBody: true })).toBe(
      false,
    );
    // No focus anywhere: nothing shown.
    expect(cue({ keyboard: true })).toBe(false);
  });
});

describe("block handle visibility classes", () => {
  const allIds = (doc: PMNode): string[] => {
    const ids: string[] = [];
    doc.forEach((node) => {
      if (typeof node.attrs.id === "string") ids.push(node.attrs.id);
    });
    doc.descendants((node, _pos, parent, index) => {
      if (node.attrs.id && nestedHandleEligible(node, parent, index))
        ids.push(node.attrs.id);
      return true;
    });
    return ids;
  };

  it("marks exactly one nearby handle across the whole handle set", () => {
    const ids = allIds(fixture());
    const classes = ids.map((id) =>
      blockHandleClass({ id, nearby: "blank", caret: "first", selected: [] }),
    );
    expect(ids.length).toBeGreaterThan(2);
    expect(classes.filter((c) => c.includes("nearby"))).toHaveLength(1);
    expect(
      classes[ids.indexOf("blank")],
    ).toBe("block-handle nearby");
    expect(classes.filter((c) => c.includes("caret"))).toHaveLength(1);
    expect(classes[ids.indexOf("first")]).toBe("block-handle caret");
  });

  it("shows every explicitly selected block and the caret cue independently", () => {
    const cls = (id: string) =>
      blockHandleClass({
        id,
        nearby: "last",
        caret: "a2",
        selected: ["first", "table"],
      });
    expect(cls("first")).toContain("selected");
    expect(cls("table")).toContain("selected");
    // Explicit selection and pointer hover are independent affordances.
    expect(cls("last")).toBe("block-handle nearby");
    expect(cls("a2")).toBe("block-handle caret");
    // A keyboard caret mark may sit on a selected block without dropping it.
    expect(
      blockHandleClass({
        id: "first",
        nearby: null,
        caret: "first",
        selected: ["first"],
      }),
    ).toBe("block-handle selected caret");
    expect(cls("blank")).toBe("block-handle");
  });
});
