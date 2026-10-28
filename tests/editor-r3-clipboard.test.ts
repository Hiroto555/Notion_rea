import { expect, it } from "vitest";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { history, undo, redo, closeHistory } from "@tiptap/pm/history";
import { documentSchema } from "../src/shared/editor-schema";
import { BlockClipboard } from "../src/editor/block-clipboard";
import { blockIdentityPlugin } from "../src/editor/block-identity";
import { resolveTopSelection } from "../src/editor/blocks";

function setup() {
  const doc = documentSchema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "a" },
        content: [{ type: "text", text: "Alpha", marks: [{ type: "bold" }] }],
      },
      {
        type: "paragraph",
        attrs: { id: "b" },
        content: [{ type: "text", text: "Beta" }],
      },
      {
        type: "paragraph",
        attrs: { id: "c" },
        content: [{ type: "text", text: "Tail" }],
      },
    ],
  });
  return EditorState.create({
    schema: documentSchema,
    doc,
    plugins: [history(), blockIdentityPlugin()],
  });
}
function cut(state: EditorState, clipboard: BlockClipboard) {
  const nodes = [state.doc.child(0), state.doc.child(1)];
  const raw = clipboard.serialize(nodes, "cut");
  state = state.applyTransaction(
    closeHistory(state.tr).delete(0, nodes[0].nodeSize + nodes[1].nodeSize),
  ).state;
  clipboard.confirmCut(raw, 1000);
  return { state, raw };
}
function cursorEnd(state: EditorState) {
  return state.apply(
    state.tr.setSelection(
      TextSelection.near(state.doc.resolve(state.doc.content.size - 1)),
    ),
  );
}
function allIds(state: EditorState) {
  const ids: string[] = [];
  state.doc.descendants((n) => {
    if (n.attrs.id) ids.push(n.attrs.id);
  });
  return ids;
}
it("resolves selection by stable IDs and refuses missing or non-contiguous nodes", () => {
  const content = setup().doc.toJSON().content;
  expect(resolveTopSelection(content, ["a", "b"])).toEqual([0, 1]);
  expect(
    resolveTopSelection([content[2], ...content.slice(0, 2)], ["a", "b"]),
  ).toEqual([1, 2]);
  expect(resolveTopSelection([content[0], content[2]], ["a", "b"])).toEqual([]);
  expect(resolveTopSelection(content, ["a", "c"])).toEqual([]);
});
it("same-document cut preserves identities once, then pastes with fresh IDs", () => {
  const clipboard = new BlockClipboard("page-a");
  let { state, raw } = cut(setup(), clipboard);
  state = cursorEnd(state);
  const first = clipboard.preparePaste(state, raw, 1001);
  expect(first.preserved).toBe(true);
  state = state.applyTransaction(first.tr).state;
  first.consume();
  expect(allIds(state)).toEqual(expect.arrayContaining(["a", "b", "c"]));
  const second = clipboard.preparePaste(cursorEnd(state), raw, 1002);
  expect(second.preserved).toBe(false);
  state = state.applyTransaction(second.tr).state;
  expect(new Set(allIds(state)).size).toBe(allIds(state).length);
  expect(state.doc.textContent).toContain("AlphaBeta");
});
it("undo of cut or an expired or different-editor token never reuses IDs", () => {
  const clipboard = new BlockClipboard("page-a");
  let { state, raw } = cut(setup(), clipboard);
  expect(
    undo(state, (tr) => {
      state = state.applyTransaction(tr).state;
    }),
  ).toBe(true);
  const afterUndo = clipboard.preparePaste(cursorEnd(state), raw, 1001);
  expect(afterUndo.preserved).toBe(false);
  state = state.applyTransaction(afterUndo.tr).state;
  expect(new Set(allIds(state)).size).toBe(allIds(state).length);
  const again = cut(setup(), new BlockClipboard("unused"));
  expect(
    clipboard.preparePaste(cursorEnd(again.state), raw, 400_000).preserved,
  ).toBe(false);
  expect(() =>
    new BlockClipboard("page-b").preparePaste(
      cursorEnd(again.state),
      raw,
      1001,
    ),
  ).toThrow(/ページ間/);
});
it("rejects malformed payload and keeps an unconsumed cut token for a valid retry", () => {
  const clipboard = new BlockClipboard("page-a");
  let { state, raw } = cut(setup(), clipboard);
  const untrusted = new BlockClipboard("page-a");
  expect(() => untrusted.preparePaste(state, '{"bad":1}', 1001)).toThrow();
  const invalid = JSON.parse(raw);
  invalid.nodes[0].unexpected = true;
  expect(() =>
    untrusted.preparePaste(state, JSON.stringify(invalid), 1001),
  ).toThrow();
  const insertionFailure = state.tr;
  insertionFailure.replaceSelection = () => {
    throw new Error("simulated insertion failure");
  };
  const failingState = Object.create(state) as EditorState;
  Object.defineProperty(failingState, "tr", { value: insertionFailure });
  expect(() => clipboard.preparePaste(failingState, raw, 1001)).toThrow(
    /貼り付けられません/,
  );
  const valid = clipboard.preparePaste(cursorEnd(state), raw, 1001);
  expect(valid.preserved).toBe(true);
  state = state.applyTransaction(valid.tr).state;
  valid.consume();
  expect(
    undo(state, (tr) => {
      state = state.applyTransaction(tr).state;
    }),
  ).toBe(true);
  expect(
    redo(state, (tr) => {
      state = state.applyTransaction(tr).state;
    }),
  ).toBe(true);
  expect(new Set(allIds(state)).size).toBe(allIds(state).length);
});

it("copies and cuts nested sibling list items without losing their descendants", () => {
  const item = (id: string) => ({
    type: "listItem",
    attrs: { id },
    content: [
      {
        type: "paragraph",
        attrs: { id: id + "-p" },
        content: [{ type: "text", text: id }],
      },
    ],
  });
  const doc = documentSchema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "bulletList",
        attrs: { id: "list" },
        content: [item("one"), item("two"), item("three")],
      },
      { type: "paragraph", attrs: { id: "tail" } },
    ],
  });
  let state = EditorState.create({
    schema: documentSchema,
    doc,
    plugins: [history(), blockIdentityPlugin()],
  });
  const clipboard = new BlockClipboard("page-a");
  const first = state.doc.child(0).child(0),
    second = state.doc.child(0).child(1);
  const raw = clipboard.serialize([first, second], "cut", "bulletList");
  state = state.applyTransaction(
    closeHistory(state.tr).delete(1, 1 + first.nodeSize + second.nodeSize),
  ).state;
  clipboard.confirmCut(raw, 1000);
  const paste = clipboard.preparePaste(cursorEnd(state), raw, 1001);
  expect(paste.preserved).toBe(true);
  state = state.applyTransaction(paste.tr).state;
  paste.consume();
  expect(allIds(state)).toEqual(
    expect.arrayContaining([
      "one",
      "one-p",
      "two",
      "two-p",
      "three",
      "three-p",
    ]),
  );
  expect(new Set(allIds(state)).size).toBe(allIds(state).length);
});

it("allows cross-page copy with fresh IDs while rejecting cross-page cut", () => {
  const source = setup();
  const from = new BlockClipboard("page-a");
  const copy = from.serialize(
    [source.doc.child(0), source.doc.child(1)],
    "copy",
  );
  const into = new BlockClipboard("page-b");
  const result = into.preparePaste(cursorEnd(source), copy);
  expect(result.preserved).toBe(false);
  const state = source.applyTransaction(result.tr).state;
  expect(new Set(allIds(state)).size).toBe(allIds(state).length);
  expect(state.doc.textContent.match(/Alpha/g)).toHaveLength(2);
});

it("preserves an image, internal page link and formatting across a copied block slice", () => {
  const source = documentSchema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "linked" },
        content: [
          {
            type: "text",
            text: "reference",
            marks: [
              { type: "bold" },
              {
                type: "link",
                attrs: {
                  href: "folio-page://12345678-1234-1234-1234-123456789abc",
                },
              },
            ],
          },
        ],
      },
      {
        type: "image",
        attrs: {
          id: "image",
          src: "folio-asset://12345678-1234-1234-1234-123456789abc.png",
          alt: "diagram",
        },
      },
      {
        type: "paragraph",
        attrs: { id: "tail" },
        content: [{ type: "text", text: "end" }],
      },
    ],
  });
  let state = EditorState.create({
    schema: documentSchema,
    doc: source,
    plugins: [history(), blockIdentityPlugin()],
  });
  const clipboard = new BlockClipboard("page-a");
  const raw = clipboard.serialize([source.child(0), source.child(1)], "copy");
  const paste = clipboard.preparePaste(cursorEnd(state), raw);
  state = state.applyTransaction(paste.tr).state;
  const json = JSON.stringify(state.doc.toJSON());
  expect(
    json.match(/folio-asset:\/\/12345678-1234-1234-1234-123456789abc.png/g),
  ).toHaveLength(2);
  expect(
    json.match(/folio-page:\/\/12345678-1234-1234-1234-123456789abc/g),
  ).toHaveLength(2);
  expect(json.match(/"type":"bold"/g)).toHaveLength(2);
  expect(new Set(allIds(state)).size).toBe(allIds(state).length);
});

it("consumes a cut token after the first successful fresh-ID paste following cut undo", () => {
  const clipboard = new BlockClipboard("page-a");
  let { state, raw } = cut(setup(), clipboard);
  expect(
    undo(state, (tr) => {
      state = state.applyTransaction(tr).state;
    }),
  ).toBe(true);
  const first = clipboard.preparePaste(cursorEnd(state), raw, 1001);
  expect(first.preserved).toBe(false);
  state = state.applyTransaction(first.tr).state;
  first.consume();
  const ranges: { from: number; to: number }[] = [];
  state.doc.forEach((node, pos) => {
    if (["a", "b"].includes(node.attrs.id))
      ranges.push({ from: pos, to: pos + node.nodeSize });
  });
  expect(ranges).toHaveLength(2);
  const tr = state.tr;
  for (const range of ranges.reverse()) tr.delete(range.from, range.to);
  state = state.applyTransaction(tr).state;
  expect(allIds(state)).not.toContain("a");
  expect(allIds(state)).not.toContain("b");
  expect(clipboard.preparePaste(cursorEnd(state), raw, 1002).preserved).toBe(
    false,
  );
});

it("invalidates the cut token when a different internal clipboard payload is observed", () => {
  const clipboard = new BlockClipboard("page-a");
  const { state, raw } = cut(setup(), clipboard);
  const replacement = clipboard.serialize([setup().doc.child(2)], "copy");
  expect(
    clipboard.preparePaste(cursorEnd(state), replacement, 1001).preserved,
  ).toBe(false);
  expect(clipboard.preparePaste(cursorEnd(state), raw, 1002).preserved).toBe(
    false,
  );
});
