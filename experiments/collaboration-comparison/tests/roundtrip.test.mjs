import test from "node:test";
import assert from "node:assert/strict";
import r from "../runtime/bundle.cjs";
import { richDocument, simpleDocument } from "../fixtures/rich.mjs";
import { createHarness as B } from "../adapters/b.mjs";
import { createHarness as C } from "../adapters/c.mjs";
const clone = (x) => JSON.parse(JSON.stringify(x));
const normalize = (x) =>
  clone(r.versionDocument(r.documentSchema.nodeFromJSON(x).toJSON()));
function authored(input, output) {
  if (input === null || typeof input !== "object") {
    assert.equal(output, input);
    return;
  }
  if (Array.isArray(input)) {
    assert.equal(output.length, input.length);
    input.forEach((v, i) => authored(v, output[i]));
    return;
  }
  for (const [k, v] of Object.entries(input)) authored(v, output[k]);
}
test("full fixture includes every actual node and mark and retains authored fields", () => {
  const doc = richDocument(),
    nodes = new Set(),
    marks = new Set();
  const walk = (n) => {
    nodes.add(n.type);
    for (const m of n.marks ?? []) marks.add(m.type);
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  assert.deepEqual(
    [...nodes].sort(),
    Object.keys(r.documentSchema.nodes).sort(),
  );
  assert.deepEqual(
    [...marks].sort(),
    Object.keys(r.documentSchema.marks).sort(),
  );
  assert.equal(r.validDocument(doc), true);
  authored(doc, normalize(doc));
});
for (const [name, create] of [
  ["B", B],
  ["C", C],
])
  for (const [kind, factory, target] of [
    ["simple", simpleDocument, "p1"],
    ["rich", richDocument, "p-details"],
  ]) {
    test(`${name} ${kind}: one seed and text edit retain full schema and IDs`, () => {
      const doc = factory();
      const h = create({ document: doc });
      try {
        const original = normalize(doc);
        assert.deepEqual(h.doc(0), original);
        assert.deepEqual(h.doc(1), original);
        let pos;
        h.state(0).doc.descendants((n, p) => {
          if (n.attrs.id === target) pos = p + 1;
        });
        assert.equal(typeof pos, "number");
        h.local(0, (s) => s.tr.insertText("日本語😀", pos));
        h.sync();
        const expected = clone(doc);
        const change = (n) => {
          if (n.attrs?.id === target)
            n.content[0].text = "日本語😀" + n.content[0].text;
          else for (const c of n.content ?? []) change(c);
        };
        change(expected);
        for (const i of [0, 1]) {
          assert.equal(r.validDocument(h.doc(i)), true);
          assert.deepEqual(h.doc(i), normalize(expected));
        }
      } finally {
        h.close();
      }
    });
  }

for (const [name, create] of [
  ["B", B],
  ["C", C],
])
  test(`${name}: authored schemaVersion2 survives a plain document seed`, () => {
    const doc = { ...simpleDocument(), schemaVersion: 2 };
    const h = create({ document: doc });
    try {
      h.sync();
      for (const i of [0, 1]) assert.equal(h.doc(i).schemaVersion, 2);
    } finally {
      h.close();
    }
  });
