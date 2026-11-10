import test from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./adapter.mjs";

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

function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.attrs?.id === id) return node;
  for (const child of node.content ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function nodeText(node) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(nodeText).join("");
}

function blockText(doc, id) {
  const node = findNode(doc, id);
  assert.ok(node, `missing block ${id}`);
  return nodeText(node);
}

function collectIds(node, ids = []) {
  if (node?.attrs && typeof node.attrs.id === "string") ids.push(node.attrs.id);
  for (const child of node?.content ?? []) collectIds(child, ids);
  return ids;
}

function findTable(doc) {
  let found = null;
  const visit = (node) => {
    if (!node || found) return;
    if (node.type === "table") {
      found = node;
      return;
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(doc);
  return found;
}

function tableShape(doc) {
  const table = findTable(doc);
  assert.ok(table, "missing table");
  const widths = (table.content ?? []).map((row) => (row.content ?? []).length);
  return {
    rows: widths.length,
    columns: widths[0] ?? 0,
    widths,
    rectangular: widths.every((width) => width === widths[0]),
  };
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

function markedText(doc, id, text) {
  const block = findNode(doc, id);
  assert.ok(block, `missing block ${id}`);
  const found = [];
  const visit = (node) => {
    if (node?.type === "text" && node.text === text) found.push(node);
    for (const child of node?.content ?? []) visit(child);
  };
  visit(block);
  return found;
}

function simpleDocument() {
  return {
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
}

function markedMoveDocument() {
  return {
    type: "doc",
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
  const paragraph = (id, text) => ({
    type: "paragraph",
    attrs: { id },
    content: text === undefined ? undefined : [{ type: "text", text }],
  });
  return {
    type: "doc",
    content: [
      {
        type: "table",
        attrs: { id: "t1" },
        content: [
          {
            type: "tableRow",
            attrs: { id: "row-1" },
            content: [
              {
                type: "tableHeader",
                attrs: { id: "h1" },
                content: [paragraph("p-h1", "A")],
              },
              {
                type: "tableHeader",
                attrs: { id: "h2" },
                content: [paragraph("p-h2", "B")],
              },
            ],
          },
          {
            type: "tableRow",
            attrs: { id: "row-2" },
            content: [
              {
                type: "tableCell",
                attrs: { id: "c1" },
                content: [paragraph("p-c1", "1")],
              },
              {
                type: "tableCell",
                attrs: { id: "c2" },
                content: [paragraph("p-c2", "2")],
              },
            ],
          },
        ],
      },
    ],
  };
}

function assertConverged(h, clients = 2) {
  const server = h.serverDoc();
  for (let index = 0; index < clients; index += 1) {
    assert.deepEqual(
      h.doc(index),
      server,
      `client ${index} differs from server`,
    );
  }
  assert.equal(h.diagnostics().converged, true);
}

test("R02 move after p2 with concurrent pending KEEP keeps text, marks and IDs", () => {
  const h = createHarness({ document: markedMoveDocument(), clients: 2 });
  try {
    h.moveBlock(0, "p1", { beforeId: null });
    h.insertText(1, "p1", 1, "KEEP");
    h.sync();
    assertConverged(h);
    for (const index of [0, 1]) {
      const doc = h.doc(index);
      assert.deepEqual(
        (doc.content ?? []).map((node) => node.attrs?.id),
        ["p2", "p1"],
      );
      assert.equal(blockText(doc, "p1"), "aKEEPbc");
      assert.equal(blockText(doc, "p2"), "xyz");
      const bold = markedText(doc, "p1", "bc");
      assert.equal(bold.length, 1, "bold bc text node must be preserved");
      assert.ok(
        (bold[0].marks ?? []).some((mark) => mark.type === "bold"),
        "bold mark must survive the move",
      );
      const ids = collectIds(doc);
      assert.equal(new Set(ids).size, ids.length);
    }
  } finally {
    h.close();
  }
});

test("R02 replay: move delivered before the pending KEEP still converges", () => {
  const h = createHarness({ document: markedMoveDocument(), clients: 2 });
  try {
    h.moveBlock(0, "p1", { beforeId: null });
    h.sync();
    assert.deepEqual(
      (h.doc(0).content ?? []).map((node) => node.attrs?.id),
      ["p2", "p1"],
    );
    h.insertText(1, "p1", 1, "KEEP");
    h.sync();
    assertConverged(h);
    for (const index of [0, 1]) {
      assert.equal(blockText(h.doc(index), "p1"), "aKEEPbc");
      assert.equal(blockText(h.doc(index), "p2"), "xyz");
    }
  } finally {
    h.close();
  }
});

function assertTableUpgrade(h) {
  assertConverged(h);
  for (const index of [0, 1]) {
    const doc = h.doc(index);
    const shape = tableShape(doc);
    assert.equal(shape.rows, 3);
    assert.equal(shape.columns, 3);
    assert.equal(shape.rectangular, true);
    assert.deepEqual(shape.widths, [3, 3, 3]);
    for (const [id, text] of [
      ["h1", "A"],
      ["h2", "B"],
      ["c1", "1"],
      ["c2", "2"],
    ]) {
      const node = findNode(doc, id);
      assert.ok(node, `old cell ${id} is missing`);
      assert.equal(nodeText(node), text, `old cell ${id} changed`);
    }
    const ids = collectIds(doc);
    assert.equal(new Set(ids).size, ids.length, "document ids must be unique");
    const metadata = h
      .serverState()
      .tables.find((item) => item.tableId === "t1");
    assert.ok(metadata, "table metadata missing");
    assert.equal(metadata.rowIds.length, 3);
    assert.equal(metadata.columnIds.length, 3);
    assert.ok(metadata.rowIds.includes("rowB"));
    assert.ok(metadata.columnIds.includes("colB"));
    const allIds = [...ids, ...metadata.columnIds];
    assert.equal(new Set(allIds).size, allIds.length);
  }
}

test("R03 row and column inserts both succeed and preserve old 2x2 cells", () => {
  const h = createHarness({ document: tableDocument(), clients: 2 });
  try {
    h.insertTableRow(0, "t1", "rowB");
    h.insertTableColumn(1, "t1", "colB");
    h.sync();
    assertTableUpgrade(h);
  } finally {
    h.close();
  }
});

test("R03 replay with column intent first also produces the same 3x3 table", () => {
  const h = createHarness({ document: tableDocument(), clients: 2 });
  try {
    h.insertTableColumn(0, "t1", "colB");
    h.insertTableRow(1, "t1", "rowB");
    h.sync();
    assertTableUpgrade(h);
  } finally {
    h.close();
  }
});

test("R04 local undo removes only the local insert and preserves remote KEEP", () => {
  const h = createHarness({ document: simpleDocument(), clients: 2 });
  try {
    h.insertText(0, "p1", 0, "A");
    h.sync();
    assert.equal(blockText(h.doc(0), "p1"), "Aabc");

    h.insertText(1, "p1", 4, "KEEP");
    h.sync();
    assert.equal(blockText(h.doc(0), "p1"), "AabcKEEP");
    assert.equal(blockText(h.doc(1), "p1"), "AabcKEEP");

    assert.equal(h.undo(0), true);
    h.sync();
    assertConverged(h);
    assert.equal(blockText(h.doc(0), "p1"), "abcKEEP");
    assert.equal(blockText(h.doc(1), "p1"), "abcKEEP");

    assert.equal(h.redo(0), true);
    h.sync();
    assertConverged(h);
    assert.equal(blockText(h.doc(0), "p1"), "AabcKEEP");
    assert.equal(blockText(h.doc(1), "p1"), "AabcKEEP");

    assert.equal(h.undo(1), true);
    h.sync();
    assertConverged(h);
    assert.equal(blockText(h.doc(0), "p1"), "Aabc");

    assert.equal(h.undo(0), true);
    h.sync();
    assertConverged(h);
    assert.equal(blockText(h.doc(0), "p1"), "abc");
    assert.equal(blockText(h.doc(0), "p2"), "xyz");
  } finally {
    h.close();
  }
});

test("pending concurrent text inserts converge once, then repeated sync is inert", () => {
  const h = createHarness({ document: simpleDocument(), clients: 2 });
  try {
    h.insertText(0, "p1", 0, "AAA");
    h.insertText(1, "p1", 0, "BBB");
    h.sync();
    assertConverged(h);
    for (const index of [0, 1]) {
      const text = blockText(h.doc(index), "p1");
      assert.equal(countOccurrences(text, "AAA"), 1);
      assert.equal(countOccurrences(text, "BBB"), 1);
      assert.equal(countOccurrences(text, "abc"), 1);
    }

    const snapshot = [h.doc(0), h.doc(1), h.serverDoc()];
    const before = h.diagnostics();
    for (let pass = 0; pass < 3; pass += 1) h.sync();
    const after = h.diagnostics();
    assert.deepEqual(h.doc(0), snapshot[0]);
    assert.deepEqual(h.doc(1), snapshot[1]);
    assert.deepEqual(h.serverDoc(), snapshot[2]);
    assert.equal(after.serverVersion, before.serverVersion);
    assert.equal(after.serverStepCount, before.serverStepCount);
    assert.equal(after.acceptedSteps, before.acceptedSteps);
  } finally {
    h.close();
  }
});

test("replayed edits in opposite client order reach the same document", () => {
  const first = createHarness({ document: simpleDocument(), clients: 2 });
  const second = createHarness({ document: simpleDocument(), clients: 2 });
  try {
    first.insertText(0, "p1", 0, "A");
    first.insertText(1, "p2", 0, "B");
    first.sync();

    second.insertText(0, "p2", 0, "B");
    second.insertText(1, "p1", 0, "A");
    second.sync();

    assert.equal(stable(first.doc(0)), stable(second.doc(0)));
    assert.equal(stable(first.serverDoc()), stable(second.serverDoc()));
    assert.equal(blockText(first.doc(0), "p1"), "Aabc");
    assert.equal(blockText(first.doc(0), "p2"), "Bxyz");
  } finally {
    first.close();
    second.close();
  }
});

test("rejected structure intent retains the original input and does not corrupt state", () => {
  const h = createHarness({ document: simpleDocument(), clients: 2 });
  try {
    const command = h.moveBlock(0, "missing", { beforeId: null });
    h.sync();
    assertConverged(h);
    const rejection = h
      .diagnostics()
      .rejections.find((item) => item.reason === "NODE_MISSING");
    assert.ok(rejection, "missing block must be rejected");
    assert.equal(rejection.command.blockId, "missing");
    assert.equal(rejection.command.kind, "block.move");
    assert.equal(command.blockId, "missing");
    assert.equal(blockText(h.doc(0), "p1"), "abc");

    h.insertText(0, "p1", 0, "X");
    h.sync();
    assertConverged(h);
    assert.equal(blockText(h.doc(0), "p1"), "Xabc");
  } finally {
    h.close();
  }
});

test("duplicate table row id is rejected while a later legal column insert succeeds", () => {
  const h = createHarness({ document: tableDocument(), clients: 2 });
  try {
    h.insertTableRow(0, "t1", "row-1");
    h.sync();
    assertConverged(h);
    assert.ok(
      h.diagnostics().rejections.some((item) => item.reason === "ID_COLLISION"),
    );
    assert.equal(tableShape(h.doc(0)).rows, 2);
    assert.equal(tableShape(h.doc(0)).columns, 2);

    h.insertTableColumn(1, "t1", "col-ok");
    h.sync();
    assertConverged(h);
    const shape = tableShape(h.doc(0));
    assert.equal(shape.rows, 2);
    assert.equal(shape.columns, 3);
    assert.equal(shape.rectangular, true);
    assert.equal(blockText(h.doc(0), "c1"), "1");
    const metadata = h
      .serverState()
      .tables.find((item) => item.tableId === "t1");
    assert.ok(metadata.columnIds.includes("col-ok"));
  } finally {
    h.close();
  }
});

test("invalid text ranges and raw structural transactions fail without mutation", () => {
  const h = createHarness({ document: simpleDocument(), clients: 2 });
  try {
    assert.throws(() => h.insertText(0, "p1", 99, "X"), /offset out of range/);
    assert.throws(() => h.insertText(0, "p1", 0, "\ud800"), /well-formed/);
    assert.equal(blockText(h.doc(0), "p1"), "abc");
    assert.equal(h.diagnostics().pending[0].steps, 0);

    assert.throws(
      () =>
        h.local(0, (state) => {
          const first = state.doc.firstChild;
          const tr = state.tr.delete(0, first.nodeSize);
          tr.insert(tr.doc.content.size, first);
          return tr;
        }),
      /RAW_STRUCTURE_UNSUPPORTED/,
    );
    assert.equal(blockText(h.doc(0), "p1"), "abc");
    assert.deepEqual(
      (h.doc(0).content ?? []).map((node) => node.attrs?.id),
      ["p1", "p2"],
    );
    assert.equal(h.diagnostics().pending[0].steps, 0);
  } finally {
    h.close();
  }
});

test("text-only local() transactions remain supported", () => {
  const h = createHarness({ document: simpleDocument(), clients: 2 });
  try {
    h.local(0, (state) =>
      state.tr.insertText("Q", state.doc.firstChild.nodeSize - 1),
    );
    h.sync();
    assertConverged(h);
    assert.equal(blockText(h.doc(0), "p1"), "abcQ");
  } finally {
    h.close();
  }
});
