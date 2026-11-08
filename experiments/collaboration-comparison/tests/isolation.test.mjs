import test from "node:test";
import assert from "node:assert/strict";
import { createHarness as B } from "../adapters/b.mjs";
import { createHarness as C } from "../adapters/c.mjs";
import { simpleDocument } from "../fixtures/rich.mjs";
for (const [name, create] of [
  ["B", B],
  ["C", C],
])
  test(`${name}: separate harnesses and reopen retain no old session`, () => {
    const first = create({ document: simpleDocument() }),
      second = create({ document: simpleDocument() });
    const original = second.doc(0);
    try {
      first.local(0, (s) => s.tr.insertText("A", 1));
      first.sync();
      assert.deepEqual(second.doc(0), original);
      first.close(); // deliberately non-LIFO: B must retain the remaining DOM realm
      second.local(0, (s) => s.tr.insertText("B", 1));
      second.sync();
      assert.deepEqual(second.doc(0), second.doc(1));
    } finally {
      first.close();
      second.close();
    }
    const reopen = create({ document: simpleDocument() });
    try {
      assert.deepEqual(reopen.doc(0), original);
    } finally {
      reopen.close();
    }
  });
test("B virtual DOM globals are restored after every live harness closes", () => {
  const names = ["window", "document", "navigator"];
  const before = names.map((k) =>
    Object.getOwnPropertyDescriptor(globalThis, k),
  );
  const a = B({ document: simpleDocument() }),
    b = B({ document: simpleDocument() });
  a.close();
  b.close();
  names.forEach((k, i) =>
    assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, k), before[i]),
  );
});
