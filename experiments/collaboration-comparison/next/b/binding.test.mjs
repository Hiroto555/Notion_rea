import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./adapter.mjs";
import { richDocument as richFactory } from "../../fixtures/rich.mjs";

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function findJson(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.attrs && node.attrs.id === id) return node;
  for (const child of node.content ?? []) {
    const found = findJson(child, id);
    if (found) return found;
  }
  return null;
}

function blockText(node) {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(blockText).join("");
}

function collectIds(node) {
  const ids = [];
  const duplicates = [];
  const seen = new Set();
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (current.attrs && typeof current.attrs.id === "string") {
      if (seen.has(current.attrs.id)) duplicates.push(current.attrs.id);
      else {
        seen.add(current.attrs.id);
        ids.push(current.attrs.id);
      }
    }
    for (const child of current.content ?? []) stack.push(child);
  }
  return { ids, duplicates };
}

function converged(documents) {
  const first = stable(documents[0]);
  return documents.every((document) => stable(document) === first);
}

function hasMark(node, text, markType) {
  const found = [];
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (
      current.type === "text" &&
      current.text === text &&
      (current.marks ?? []).some((mark) => mark.type === markType)
    )
      found.push(current);
    for (const child of current.content ?? []) stack.push(child);
  }
  return found.length > 0;
}

function simpleDocument() {
  return {
    type: "doc",
    schemaVersion: 1,
    content: [
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "bc", marks: [{ type: "bold" }] },
        ],
      },
      {
        type: "paragraph",
        attrs: { id: "p2" },
        content: [{ type: "text", text: "xyz" }],
      },
    ],
  };
}

function tableDocument() {
  return {
    type: "doc",
    schemaVersion: 2,
    content: [
      {
        type: "table",
        attrs: { id: "table" },
        content: [
          {
            type: "tableRow",
            attrs: { id: "row-1" },
            content: [
              {
                type: "tableHeader",
                attrs: { id: "header-1" },
                content: [
                  {
                    type: "paragraph",
                    attrs: { id: "p-header-1" },
                    content: [{ type: "text", text: "A" }],
                  },
                ],
              },
              {
                type: "tableHeader",
                attrs: { id: "header-2" },
                content: [
                  {
                    type: "paragraph",
                    attrs: { id: "p-header-2" },
                    content: [{ type: "text", text: "B" }],
                  },
                ],
              },
            ],
          },
          {
            type: "tableRow",
            attrs: { id: "row-2" },
            content: [
              {
                type: "tableCell",
                attrs: { id: "cell-1" },
                content: [
                  {
                    type: "paragraph",
                    attrs: { id: "p-cell-1" },
                    content: [{ type: "text", text: "1" }],
                  },
                ],
              },
              {
                type: "tableCell",
                attrs: { id: "cell-2" },
                content: [
                  {
                    type: "paragraph",
                    attrs: { id: "p-cell-2" },
                    content: [{ type: "text", text: "2" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function tableShape(document) {
  const table = findJson(document, "table");
  if (!table) return null;
  const rows = table.content ?? [];
  return {
    rowCount: rows.length,
    widths: rows.map((row) => (row.content ?? []).length),
    rectangular: rows.every(
      (row) => (row.content ?? []).length === (rows[0]?.content ?? []).length,
    ),
  };
}

function statePosition(state, id) {
  let found = null;
  state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.attrs && node.attrs.id === id) {
      found = { node, pos };
      return false;
    }
    return true;
  });
  return found;
}

test("R02 move and concurrent insert preserve KEEP, marks, IDs and p2", () => {
  const harness = createHarness({ document: simpleDocument(), clients: 2 });
  try {
    harness.structure(0, {
      kind: "block.move",
      blockId: "p1",
      parentId: null,
      beforeId: null,
    });
    harness.local(1, (state) => {
      const p1 = statePosition(state, "p1");
      assert.ok(p1, "p1 must exist before the concurrent insert");
      return state.tr.insertText("KEEP", p1.pos + 1 + 1);
    });

    const report = harness.sync();
    assert.equal(report.rejected.length, 0, JSON.stringify(report.rejected));

    const documents = [harness.doc(0), harness.doc(1)];
    assert.equal(converged(documents), true);

    for (const document of documents) {
      assert.equal((document.content ?? [])[0]?.attrs?.id, "p2");
      assert.equal((document.content ?? [])[1]?.attrs?.id, "p1");
      assert.equal(blockText(findJson(document, "p1")), "aKEEPbc");
      assert.equal(blockText(findJson(document, "p2")), "xyz");
      assert.equal(hasMark(findJson(document, "p1"), "bc", "bold"), true);
      assert.deepEqual(collectIds(document).duplicates, []);
      const ids = collectIds(document).ids;
      assert.equal(ids.includes("p1"), true);
      assert.equal(ids.includes("p2"), true);
    }
  } finally {
    harness.close();
  }
});

test("R02 adversarial move onto itself is rejected without mutating either peer", () => {
  const harness = createHarness({ document: simpleDocument(), clients: 2 });
  try {
    harness.structure(0, {
      kind: "block.move",
      blockId: "p1",
      parentId: "p1",
      beforeId: null,
    });
    const report = harness.sync();
    assert.equal(report.rejected.length, 1);
    assert.equal(report.rejected[0].code, "CYCLE");
    assert.equal(report.rejected[0].command.kind, "block.move");
    assert.equal(report.rejected[0].command.blockId, "p1");

    for (const document of [harness.doc(0), harness.doc(1)]) {
      assert.equal(blockText(findJson(document, "p1")), "abc");
      assert.equal(blockText(findJson(document, "p2")), "xyz");
      assert.equal((document.content ?? [])[0]?.attrs?.id, "p1");
      assert.equal((document.content ?? [])[1]?.attrs?.id, "p2");
    }
  } finally {
    harness.close();
  }
});

test("legal block insert and delete use the semantic server and actual binding", () => {
  const harness = createHarness({ document: simpleDocument(), clients: 2 });
  try {
    harness.structure(0, {
      kind: "block.insert",
      parentId: null,
      beforeId: "p2",
      node: {
        type: "paragraph",
        attrs: { id: "p3" },
        content: [{ type: "text", text: "NEW" }],
      },
    });
    let report = harness.sync();
    assert.equal(report.rejected.length, 0, JSON.stringify(report.rejected));
    assert.equal(converged([harness.doc(0), harness.doc(1)]), true);
    for (const document of [harness.doc(0), harness.doc(1)]) {
      assert.equal(blockText(findJson(document, "p1")), "abc");
      assert.equal(blockText(findJson(document, "p3")), "NEW");
      assert.equal(blockText(findJson(document, "p2")), "xyz");
      assert.equal((document.content ?? [])[1]?.attrs?.id, "p3");
    }

    harness.structure(1, { kind: "block.delete", blockId: "p2" });
    report = harness.sync();
    assert.equal(report.rejected.length, 0, JSON.stringify(report.rejected));
    for (const document of [harness.doc(0), harness.doc(1)]) {
      assert.equal(findJson(document, "p2"), null);
      assert.equal(blockText(findJson(document, "p3")), "NEW");
    }
  } finally {
    harness.close();
  }
});

test("R03 concurrent row and column inserts both succeed as a 3x3 table", () => {
  const harness = createHarness({
    document: tableDocument(),
    clients: 2,
    incarnationId: "probe-inc",
  });
  try {
    harness.structure(0, {
      kind: "table.row.insert",
      tableId: "table",
      rowId: "new-row",
      beforeId: null,
    });
    harness.structure(1, {
      kind: "table.column.insert",
      tableId: "table",
      columnId: "new-col",
      beforeId: null,
    });

    const report = harness.sync();
    assert.equal(report.rejected.length, 0, JSON.stringify(report.rejected));
    assert.equal(report.applied.length, 2);

    const documents = [harness.doc(0), harness.doc(1), harness.serverDoc()];
    assert.equal(converged(documents), true);

    for (const document of documents) {
      const shape = tableShape(document);
      assert.ok(shape);
      assert.equal(shape.rowCount, 3);
      assert.deepEqual(shape.widths, [3, 3, 3]);
      assert.equal(shape.rectangular, true);

      const ids = collectIds(document);
      assert.deepEqual(ids.duplicates, []);
      for (const id of ["header-1", "header-2", "cell-1", "cell-2", "new-row"])
        assert.ok(ids.ids.includes(id), `missing ${id}`);

      assert.equal(blockText(findJson(document, "header-1")), "A");
      assert.equal(blockText(findJson(document, "header-2")), "B");
      assert.equal(blockText(findJson(document, "cell-1")), "1");
      assert.equal(blockText(findJson(document, "cell-2")), "2");
    }
  } finally {
    harness.close();
  }
});

test("R03 adversarial duplicate table ID is rejected without changing the table", () => {
  const harness = createHarness({
    document: tableDocument(),
    clients: 2,
    incarnationId: "probe-inc",
  });
  try {
    harness.structure(0, {
      kind: "table.column.insert",
      tableId: "table",
      columnId: "header-1",
      beforeId: null,
    });
    const report = harness.sync();
    assert.equal(report.rejected.length, 1);
    assert.equal(report.rejected[0].code, "ID_COLLISION");

    for (const document of [harness.doc(0), harness.doc(1)]) {
      const shape = tableShape(document);
      assert.ok(shape);
      assert.equal(shape.rowCount, 2);
      assert.deepEqual(shape.widths, [2, 2]);
      assert.equal(blockText(findJson(document, "cell-2")), "2");
    }
  } finally {
    harness.close();
  }
});

test("R04 each peer undo removes only its own insert and keeps the remote KEEP", () => {
  const harness = createHarness({ document: simpleDocument(), clients: 2 });
  try {
    harness.sync();
    harness.local(0, (state) => {
      const p1 = statePosition(state, "p1");
      assert.ok(p1);
      return state.tr.insertText("A", p1.pos + 1);
    });
    harness.sync();
    harness.local(1, (state) => {
      const p2 = statePosition(state, "p2");
      assert.ok(p2);
      return state.tr.insertText("B", p2.pos + 1);
    });
    harness.sync();

    assert.equal(blockText(findJson(harness.doc(0), "p1")), "Aabc");
    assert.equal(blockText(findJson(harness.doc(1), "p2")), "Bxyz");

    assert.equal(harness.undo(0), true);
    harness.sync();
    for (const document of [harness.doc(0), harness.doc(1)]) {
      assert.equal(blockText(findJson(document, "p1")), "abc");
      assert.equal(blockText(findJson(document, "p2")), "Bxyz");
    }

    assert.equal(harness.redo(0), true);
    harness.sync();
    for (const document of [harness.doc(0), harness.doc(1)]) {
      assert.equal(blockText(findJson(document, "p1")), "Aabc");
      assert.equal(blockText(findJson(document, "p2")), "Bxyz");
    }

    assert.equal(harness.undo(0), true);
    harness.sync();
    assert.equal(harness.undo(1), true);
    harness.sync();
    for (const document of [harness.doc(0), harness.doc(1)]) {
      assert.equal(blockText(findJson(document, "p1")), "abc");
      assert.equal(blockText(findJson(document, "p2")), "xyz");
    }
  } finally {
    harness.close();
  }
});

test("repeated delivery and order replay are idempotent", () => {
  const harness = createHarness({ document: simpleDocument(), clients: 2 });
  try {
    harness.local(0, (state) => {
      const p1 = statePosition(state, "p1");
      assert.ok(p1);
      return state.tr.insertText("X", p1.pos + 1);
    });
    harness.structure(1, {
      kind: "block.move",
      blockId: "p1",
      parentId: null,
      beforeId: null,
    });
    harness.sync();

    const baseline = [harness.doc(0), harness.doc(1), harness.serverDoc()];
    assert.equal(converged(baseline), true);

    harness.sync();
    harness.sync();
    const replayed = [harness.doc(0), harness.doc(1), harness.serverDoc()];
    assert.equal(converged(replayed), true);
    assert.equal(stable(replayed), stable(baseline));
  } finally {
    harness.close();
  }
});

test("pending concurrent text intents are rebased and both survive", () => {
  const harness = createHarness({ document: simpleDocument(), clients: 2 });
  try {
    harness.text(0, { blockId: "p1", from: 1, to: 1, text: "AAA" });
    harness.text(1, { blockId: "p1", from: 1, to: 1, text: "BBB" });

    const report = harness.sync();
    assert.equal(report.rejected.length, 0, JSON.stringify(report.rejected));
    assert.equal(report.applied.length, 2);

    const documents = [harness.doc(0), harness.doc(1), harness.serverDoc()];
    assert.equal(converged(documents), true);
    for (const document of documents) {
      const text = blockText(findJson(document, "p1"));
      assert.equal(text.includes("AAA"), true);
      assert.equal(text.includes("BBB"), true);
      assert.equal(text.startsWith("a"), true);
      assert.equal(text.endsWith("bc"), true);
      assert.equal(blockText(findJson(document, "p2")), "xyz");
    }
  } finally {
    harness.close();
  }
});

test("rich table fixture is a 2x2 baseline for the structure probes", () => {
  const document = richFactory();
  const harness = createHarness({
    document,
    clients: 2,
    incarnationId: "probe-inc",
  });
  try {
    const shape = tableShape(harness.doc(0));
    assert.ok(shape);
    assert.equal(shape.rowCount, 2);
    assert.deepEqual(shape.widths, [2, 2]);
    assert.equal(converged([harness.doc(0), harness.doc(1)]), true);
  } finally {
    harness.close();
  }
});
