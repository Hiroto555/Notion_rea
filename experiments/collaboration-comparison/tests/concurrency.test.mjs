import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness as createEngineB } from "../adapters/b.mjs";
import { createHarness as createEngineC } from "../adapters/c.mjs";

const simpleDocument = {
  type: "doc",
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

const CLIENT_TEXTS = [
  "日本語😀",
  "ひらがな🌊",
  "カタカナ🎌",
  "漢字🀄",
  "全角ＡＢＣ🌟",
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function findBlock(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.attrs?.id === id) return node;
  for (const child of node.content ?? []) {
    const found = findBlock(child, id);
    if (found) return found;
  }
  return null;
}

function nodeText(node) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(nodeText).join("");
}

function blockText(document, id) {
  const block = findBlock(document, id);
  assert.ok(block, `missing block ${id}`);
  return nodeText(block);
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function collectIds(node, ids = []) {
  if (node?.attrs && typeof node.attrs.id === "string") ids.push(node.attrs.id);
  for (const child of node.content ?? []) collectIds(child, ids);
  return ids;
}

function assertStableIds(document) {
  const ids = collectIds(document);
  assert.equal(
    new Set(ids).size,
    ids.length,
    "block ids must not be duplicated",
  );
  assert.deepEqual(ids.slice().sort(), ["p1", "p2"]);
}

function assertConverged(harness, clients, texts) {
  const documents = Array.from({ length: clients }, (_, index) =>
    harness.doc(index),
  );
  for (let index = 1; index < documents.length; index += 1) {
    assert.deepEqual(
      documents[index],
      documents[0],
      `client ${index} did not converge`,
    );
  }

  const server = harness.serverDoc();
  assert.deepEqual(server, documents[0], "server projection did not converge");

  for (const document of documents) {
    assertStableIds(document);
    assert.equal(blockText(document, "p2"), "xyz", "p2 text must be preserved");

    const firstParagraph = blockText(document, "p1");
    for (const text of texts) {
      assert.equal(
        countOccurrences(firstParagraph, text),
        1,
        `accepted text ${JSON.stringify(text)} must appear exactly once`,
      );
    }
    assert.equal(
      countOccurrences(firstParagraph, "abc"),
      1,
      "original p1 text must be preserved exactly once",
    );
  }

  return documents;
}

const ENGINES = [
  ["B", createEngineB],
  ["C", createEngineC],
];

for (const [engine, createHarness] of ENGINES) {
  for (const clients of [2, 5]) {
    test(`${engine}: ${clients} clients concurrent Japanese/emoji inserts converge once with stable ids`, () => {
      const harness = createHarness({
        document: clone(simpleDocument),
        clients,
      });
      try {
        for (let index = 0; index < clients; index += 1) {
          const text = CLIENT_TEXTS[index];
          harness.local(index, (state) => state.tr.insertText(text, 1));
        }

        harness.sync();
        const texts = CLIENT_TEXTS.slice(0, clients);
        const documents = assertConverged(harness, clients, texts);

        const snapshots = documents.map(clone);
        const serverSnapshot = clone(harness.serverDoc());
        for (let pass = 0; pass < 3; pass += 1) {
          harness.sync();
          for (let index = 0; index < clients; index += 1) {
            assert.deepEqual(
              harness.doc(index),
              snapshots[index],
              `repeated sync ${pass + 1} changed client ${index}`,
            );
          }
          assert.deepEqual(
            harness.serverDoc(),
            serverSnapshot,
            `repeated sync ${pass + 1} changed the server projection`,
          );
        }

        assertConverged(harness, clients, texts);
      } finally {
        harness.close();
      }
    });
  }
}
