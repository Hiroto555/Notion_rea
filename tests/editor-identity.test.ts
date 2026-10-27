import { describe, expect, it } from "vitest";
import { EditorState } from "@tiptap/pm/state";
import { history, redo, undo } from "@tiptap/pm/history";
import { Slice, Fragment } from "@tiptap/pm/model";
import { documentSchema } from "../src/shared/editor-schema";
import { validDocument } from "../src/shared/validation";
import {
  assignBlockIds,
  blockIdentityPlugin,
  freshPastedSlice,
} from "../src/editor/block-identity";
import { editBlocks, editNestedBlock } from "../src/editor/blocks";
import type { Doc } from "../src/shared/types";

function seededState() {
  const doc = documentSchema.nodeFromJSON({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Alpha" }] },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Nested" }],
              },
            ],
          },
        ],
      },
    ],
  });
  let state = EditorState.create({
    schema: documentSchema,
    doc,
    plugins: [history(), blockIdentityPlugin()],
  });
  const init = state.tr;
  expect(assignBlockIds(init)).toBe(true);
  state = state.apply(init.setMeta("addToHistory", false));
  return state;
}
function ids(doc: any) {
  const all: string[] = [];
  doc.descendants((node: any) => {
    if (node.attrs.id) all.push(node.attrs.id);
  });
  return all;
}
describe("Editor block identity", () => {
  it("accepts legacy documents and rejects duplicate, empty or oversized IDs", () => {
    expect(
      validDocument({ type: "doc", content: [{ type: "paragraph" }] }),
    ).toBe(true);
    for (const value of ["", "x".repeat(129)])
      expect(
        validDocument({
          type: "doc",
          content: [{ type: "paragraph", attrs: { id: value } }],
        }),
      ).toBe(false);
    expect(
      validDocument({
        type: "doc",
        content: [
          { type: "paragraph", attrs: { id: "same" } },
          { type: "paragraph", attrs: { id: "same" } },
        ],
      }),
    ).toBe(false);
  });
  it("assigns unique IDs recursively, retaining the first block across split and undo/redo", () => {
    let state = seededState();
    const initial = ids(state.doc),
      original = state.doc.firstChild!.attrs.id;
    expect(new Set(initial).size).toBe(initial.length);
    expect(initial).toHaveLength(4);
    state = state.applyTransaction(state.tr.split(3)).state;
    const split = ids(state.doc),
      second = state.doc.child(1).attrs.id;
    expect(state.doc.child(0).attrs.id).toBe(original);
    expect(second).not.toBe(original);
    expect(new Set(split).size).toBe(split.length);
    expect(
      undo(state, (tr) => {
        state = state.applyTransaction(tr).state;
      }),
    ).toBe(true);
    expect(state.doc.child(0).attrs.id).toBe(original);
    expect(state.doc.child(0).textContent).toBe("Alpha");
    expect(
      redo(state, (tr) => {
        state = state.applyTransaction(tr).state;
      }),
    ).toBe(true);
    expect(state.doc.child(0).attrs.id).toBe(original);
    expect(state.doc.child(1).attrs.id).toBe(second);
  });
  it("copies a dragged subtree before its original without stealing IDs", () => {
    let state = seededState();
    const original = state.doc.child(1),
      oldIds = ids(state.doc);
    const slice = new Slice(Fragment.from(original), 0, 0);
    const plugin = blockIdentityPlugin();
    const view = {
      get state() {
        return state;
      },
      posAtCoords: () => ({ pos: 0, inside: 0 }),
      dispatch: (tr: any) => {
        state = state.applyTransaction(tr).state;
      },
    };
    const event = { clientX: 0, clientY: 0 } as DragEvent;
    expect(
      plugin.props.handleDrop!.call(plugin, view as any, event, slice, false),
    ).toBe(true);
    const after = ids(state.doc);
    expect(new Set(after).size).toBe(after.length);
    for (const id of oldIds) expect(after).toContain(id);
    expect(state.doc.lastChild!.attrs.id).toBe(original.attrs.id);
  });
  it("moves, duplicates and deletes nested siblings without mutating other blocks", () => {
    const doc: Doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          attrs: { id: "list" },
          content: [
            {
              type: "listItem",
              attrs: { id: "one" },
              content: [
                {
                  type: "paragraph",
                  attrs: { id: "a" },
                  content: [
                    { type: "text", text: "A", marks: [{ type: "bold" }] },
                  ],
                },
              ],
            },
            {
              type: "listItem",
              attrs: { id: "two" },
              content: [
                {
                  type: "paragraph",
                  attrs: { id: "b" },
                  content: [{ type: "text", text: "B" }],
                },
              ],
            },
          ],
        },
        {
          type: "paragraph",
          attrs: { id: "outside" },
          content: [{ type: "text", text: "Outside" }],
        },
      ],
    };
    const original = structuredClone(doc);
    const moved = editNestedBlock(doc, "two", "up");
    expect(moved.content![0].content!.map((n) => n.attrs?.id)).toEqual([
      "two",
      "one",
    ]);
    expect(moved.content![0].content![1].content![0].content![0].marks).toEqual(
      [{ type: "bold" }],
    );
    expect(doc).toEqual(original);
    const duplicated = editNestedBlock(moved, "one", "duplicate");
    const items = duplicated.content![0].content!;
    expect(items).toHaveLength(3);
    expect(items[2].attrs?.id).not.toBe("one");
    expect(items[2].content![0].attrs?.id).not.toBe("a");
    const removed = editNestedBlock(
      duplicated,
      items[2].attrs!.id as string,
      "delete",
    );
    expect(removed).toEqual(moved);
    expect(() => editNestedBlock(doc, "one", "before", "a")).toThrow(/子孫/);
    expect(
      validDocument(editNestedBlock(doc, "two", "before", "outside")),
    ).toBe(false);
    const secondList: Doc = {
      type: "bulletList",
      attrs: { id: "list2" },
      content: [
        {
          type: "listItem",
          attrs: { id: "three" },
          content: [{ type: "paragraph", attrs: { id: "c" } }],
        },
      ],
    };
    const twoLists: Doc = {
      ...doc,
      content: [doc.content![0], secondList, doc.content![1]],
    };
    const across = editNestedBlock(twoLists, "two", "before", "three");
    expect(across.content![0].content!.map((n) => n.attrs?.id)).toEqual([
      "one",
    ]);
    expect(across.content![1].content!.map((n) => n.attrs?.id)).toEqual([
      "two",
      "three",
    ]);
    expect(validDocument(across)).toBe(true);
    expect(doc).toEqual(original);
    expect(validDocument(duplicated)).toBe(true);
  });
  it("duplicates and pasted subtrees with fresh IDs without altering source or formatting", () => {
    const state = seededState();
    const first = state.doc.child(1);
    const slice = freshPastedSlice(new Slice(Fragment.from(first), 0, 0));
    const originalIds: string[] = [],
      pastedIds: string[] = [];
    first.descendants((n) => {
      if (n.attrs.id) originalIds.push(n.attrs.id);
    });
    originalIds.push(first.attrs.id);
    slice.content.firstChild!.descendants((n) => {
      if (n.attrs.id) pastedIds.push(n.attrs.id);
    });
    pastedIds.push(slice.content.firstChild!.attrs.id);
    expect(pastedIds).toHaveLength(originalIds.length);
    expect(pastedIds.every((id) => !originalIds.includes(id))).toBe(true);
    expect(slice.content.firstChild!.textContent).toBe(first.textContent);
    const original = state.doc.toJSON().content as Doc[];
    const result = editBlocks(original, [1], "duplicate");
    expect(result[1]).toEqual(original[1]);
    expect(result[2].attrs?.id).not.toBe(original[1].attrs?.id);
    expect(result[2].content?.[0].attrs?.id).not.toBe(
      original[1].content?.[0].attrs?.id,
    );
    expect(validDocument({ type: "doc", content: result })).toBe(true);
  });
});
