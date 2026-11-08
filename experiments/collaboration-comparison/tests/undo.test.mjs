import test from "node:test";
import assert from "node:assert/strict";
import { createHarness as createHarnessB } from "../adapters/b.mjs";
import { createHarness as createHarnessC } from "../adapters/c.mjs";

const simpleDocument = {
  type: "doc",
  schemaVersion: 1,
  content: [
    {
      type: "paragraph",
      attrs: { id: "p1" },
      content: [{ type: "text", text: "abc" }],
    },
    {
      type: "paragraph",
      attrs: { id: "p2" },
      content: [{ type: "text", text: "xyz" }],
    },
  ],
};

function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.attrs?.id === id) return node;
  for (const child of node.content ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function textOf(node) {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  return (node.content ?? []).map(textOf).join("");
}

function blockText(doc, id) {
  const node = findNode(doc, id);
  assert.ok(node, `missing block ${id}`);
  return textOf(node);
}

function insertAtBlockStart(state, id, text) {
  let position = null;
  state.doc.descendants((node, pos) => {
    if (position !== null) return false;
    if (node.attrs?.id === id) {
      position = pos + 1;
      return false;
    }
    return undefined;
  });
  assert.notEqual(position, null, `missing block ${id}`);
  return state.tr.insertText(text, position);
}

function assertBlocks(h, expected) {
  for (const index of [0, 1]) {
    const doc = h.doc(index);
    for (const [id, text] of Object.entries(expected)) {
      assert.equal(blockText(doc, id), text, `client${index} ${id}`);
    }
  }
}

for (const [engine, createHarness] of [
  ["B", createHarnessB],
  ["C", createHarnessC],
]) {
  test(`${engine}: local undo/redo removes only the local insert and preserves the remote insert`, () => {
    const h = createHarness({ document: simpleDocument, clients: 2 });
    try {
      h.sync();
      assertBlocks(h, { p1: "abc", p2: "xyz" });

      h.local(0, (state) => insertAtBlockStart(state, "p1", "A"));
      h.sync();
      assertBlocks(h, { p1: "Aabc", p2: "xyz" });

      h.local(1, (state) => insertAtBlockStart(state, "p2", "B"));
      h.sync();
      assertBlocks(h, { p1: "Aabc", p2: "Bxyz" });

      assert.equal(h.undo(0), true, "undo0 should report an applied undo");
      h.sync();
      assertBlocks(h, { p1: "abc", p2: "Bxyz" });

      assert.equal(h.redo(0), true, "redo0 should report an applied redo");
      h.sync();
      assertBlocks(h, { p1: "Aabc", p2: "Bxyz" });
    } finally {
      h.close();
    }
  });
}
