import test from "node:test";
import assert from "node:assert/strict";
import { createHarness as createHarnessB } from "./b/adapter.mjs";
import { createHarness as createHarnessC } from "./c/adapter.mjs";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

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

function children(node) {
  return Array.isArray(node?.content) ? node.content : [];
}

function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.attrs?.id === id) return node;
  for (const child of children(node)) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function nodeText(node) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return children(node).map(nodeText).join("");
}

function blockText(doc, id) {
  const node = findNode(doc, id);
  assert.ok(node, `missing block ${id}`);
  return nodeText(node);
}

function collectIds(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (typeof node.attrs?.id === "string") out.push(node.attrs.id);
  for (const child of children(node)) collectIds(child, out);
  return out;
}

function uniqueIds(doc) {
  const ids = collectIds(doc);
  assert.equal(new Set(ids).size, ids.length, "block ids must be unique");
  return ids;
}

function hasMarkedText(doc, blockId, text, markType) {
  let found = false;
  const walk = (node) => {
    if (!node || typeof node !== "object" || found) return;
    if (
      node.type === "text" &&
      node.text === text &&
      (node.marks ?? []).some((mark) => mark.type === markType)
    ) {
      found = true;
      return;
    }
    for (const child of children(node)) walk(child);
  };
  const block = findNode(doc, blockId);
  assert.ok(block, `missing block ${blockId}`);
  walk(block);
  return found;
}

function markedTexts(doc) {
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "text" && (node.marks ?? []).length > 0) {
      found.push({
        text: node.text ?? "",
        marks: node.marks.map((mark) => mark.type).sort(),
      });
    }
    for (const child of children(node)) walk(child);
  };
  walk(doc);
  return found;
}

function findTable(doc) {
  let found = null;
  const walk = (node) => {
    if (!node || found) return;
    if (node.type === "table") {
      found = node;
      return;
    }
    for (const child of children(node)) walk(child);
  };
  walk(doc);
  return found;
}

function tableShape(doc) {
  const table = findTable(doc);
  assert.ok(table, "missing table");
  const widths = children(table).map((row) => children(row).length);
  return {
    rows: widths.length,
    widths,
    rectangular: widths.every((width) => width === widths[0]),
  };
}

function findPosition(state, id) {
  let found = null;
  state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.attrs?.id === id) {
      found = { node, pos };
      return false;
    }
    return true;
  });
  return found;
}

function insertTextInBlock(state, id, offset, text) {
  const hit = findPosition(state, id);
  assert.ok(hit, `missing block ${id}`);
  return state.tr.insertText(text, hit.pos + 1 + offset);
}

function assertConverged(h, clients = 2) {
  const server = h.serverDoc();
  for (let index = 0; index < clients; index += 1)
    assert.deepEqual(
      h.doc(index),
      server,
      `client ${index} differs from server`,
    );
}

function serverTables(h) {
  const state =
    typeof h.serverState === "function"
      ? h.serverState()
      : h.serverDocumentState();
  return clone(state.tables);
}

function normalizeRejection(item) {
  return {
    code: item.code ?? item.reason,
    command: item.command === undefined ? null : clone(item.command),
    raw: clone(item),
  };
}

function enqueueB(h, index, command) {
  return h.structure(index, command);
}

function enqueueC(h, index, command) {
  switch (command.kind) {
    case "block.insert":
      return h.insertBlock(index, command);
    case "block.move":
      return h.moveBlock(index, command.blockId, {
        parentId: command.parentId,
        beforeId: command.beforeId,
      });
    case "block.delete":
      return h.deleteBlock(index, command.blockId);
    case "block.replace":
      return h.replaceBlock(index, command);
    case "table.row.insert":
      return h.insertTableRow(
        index,
        command.tableId,
        command.rowId,
        command.beforeId,
      );
    case "table.column.insert":
      return h.insertTableColumn(
        index,
        command.tableId,
        command.columnId,
        command.beforeId,
      );
    default:
      throw new Error(`gate facade does not route ${command.kind}`);
  }
}

const ENGINES = [
  {
    name: "B",
    create: createHarnessB,
    enqueue: enqueueB,
    rejections(h) {
      return (h.diagnostics().rejected ?? []).map(normalizeRejection);
    },
  },
  {
    name: "C",
    create: createHarnessC,
    enqueue: enqueueC,
    rejections(h) {
      return (h.diagnostics().rejections ?? []).map(normalizeRejection);
    },
  },
];

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

function markedDocument() {
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
                content: [
                  {
                    type: "paragraph",
                    attrs: { id: "p-h1" },
                    content: [{ type: "text", text: "A" }],
                  },
                ],
              },
              {
                type: "tableHeader",
                attrs: { id: "h2" },
                content: [
                  {
                    type: "paragraph",
                    attrs: { id: "p-h2" },
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
                attrs: { id: "c1" },
                content: [
                  {
                    type: "paragraph",
                    attrs: { id: "p-c1" },
                    content: [{ type: "text", text: "1" }],
                  },
                ],
              },
              {
                type: "tableCell",
                attrs: { id: "c2" },
                content: [
                  {
                    type: "paragraph",
                    attrs: { id: "p-c2" },
                    content: [
                      { type: "text", text: "2", marks: [{ type: "bold" }] },
                    ],
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

function runTableUpgrade(engine, first) {
  const h = engine.create({
    document: tableDocument(),
    clients: 2,
    incarnationId: "gate-inc",
  });
  const row = {
    kind: "table.row.insert",
    tableId: "t1",
    rowId: "rowB",
    beforeId: null,
  };
  const column = {
    kind: "table.column.insert",
    tableId: "t1",
    columnId: "colB",
    beforeId: null,
  };
  try {
    if (first === "row") {
      engine.enqueue(h, 0, row);
      engine.enqueue(h, 1, column);
    } else {
      engine.enqueue(h, 0, column);
      engine.enqueue(h, 1, row);
    }
    h.sync();
    assertConverged(h);
    assert.equal(engine.rejections(h).length, 0);
    return {
      docs: [h.doc(0), h.doc(1), h.serverDoc()],
      tables: serverTables(h),
    };
  } finally {
    h.close();
  }
}

for (const engine of ENGINES) {
  test(`R01 ${engine.name}: duplicate concurrent block identity is allocated once and the rejected intent keeps its raw command`, () => {
    const h = engine.create({ document: simpleDocument(), clients: 2 });
    try {
      const first = {
        kind: "block.insert",
        parentId: null,
        beforeId: null,
        node: {
          type: "paragraph",
          attrs: { id: "dup" },
          content: [{ type: "text", text: "one" }],
        },
      };
      const second = {
        kind: "block.insert",
        parentId: null,
        beforeId: null,
        node: {
          type: "paragraph",
          attrs: { id: "dup" },
          content: [{ type: "text", text: "two" }],
        },
      };
      engine.enqueue(h, 0, first);
      engine.enqueue(h, 1, second);
      h.sync();
      assertConverged(h);

      for (const document of [h.doc(0), h.doc(1)]) {
        const ids = uniqueIds(document);
        assert.equal(ids.filter((id) => id === "dup").length, 1);
        assert.deepEqual(ids.slice().sort(), ["dup", "p1", "p2"]);
      }

      const rejected = engine.rejections(h);
      assert.equal(rejected.length, 1);
      assert.ok(
        rejected[0].code === "DUPLICATE_ID" ||
          rejected[0].code === "ID_COLLISION",
        `unexpected rejection code ${rejected[0].code}`,
      );
      const raw = rejected[0].command;
      assert.ok(raw, "rejection must retain the raw command");
      assert.equal(raw.kind, "block.insert");
      const firstLost = stable(raw) === stable(first);
      const secondLost = stable(raw) === stable(second);
      assert.equal(
        firstLost || secondLost,
        true,
        "raw command must match an input",
      );
      assert.equal(blockText(h.doc(0), "dup"), firstLost ? "two" : "one");

      const snapshot = [h.doc(0), h.doc(1), h.serverDoc()];
      for (let pass = 0; pass < 3; pass += 1) h.sync();
      assert.deepEqual([h.doc(0), h.doc(1), h.serverDoc()], snapshot);
    } finally {
      h.close();
    }
  });

  test(`R02 ${engine.name}: move alongside unsynced marked KEEP keeps the original block text, ID and marks`, () => {
    const h = engine.create({ document: markedDocument(), clients: 2 });
    try {
      engine.enqueue(h, 0, {
        kind: "block.move",
        blockId: "p1",
        parentId: null,
        beforeId: null,
      });
      h.local(1, (state) => insertTextInBlock(state, "p1", 1, "KEEP"));
      h.sync();
      assertConverged(h);
      assert.equal(engine.rejections(h).length, 0);

      for (const document of [h.doc(0), h.doc(1), h.serverDoc()]) {
        assert.deepEqual(
          children(document).map((node) => node.attrs?.id),
          ["p2", "p1"],
        );
        assert.equal(blockText(document, "p1"), "aKEEPbc");
        assert.equal(blockText(document, "p2"), "xyz");
        assert.equal(hasMarkedText(document, "p1", "bc", "bold"), true);
        uniqueIds(document);
      }
    } finally {
      h.close();
    }
  });

  test(`R02 ${engine.name}: delete of a block with unsynced KEEP is refused with the raw delete intent retained`, () => {
    const h = engine.create({ document: markedDocument(), clients: 2 });
    try {
      const command = { kind: "block.delete", blockId: "p1" };
      engine.enqueue(h, 0, command);
      h.local(1, (state) => insertTextInBlock(state, "p1", 1, "KEEP"));
      h.sync();
      assertConverged(h);

      const rejected = engine.rejections(h);
      assert.equal(
        rejected.length,
        1,
        "deleting a block with unsynced text must not silently discard that text",
      );
      assert.deepEqual(rejected[0].command, command);

      for (const document of [h.doc(0), h.doc(1), h.serverDoc()]) {
        assert.equal(blockText(document, "p1"), "aKEEPbc");
        assert.equal(hasMarkedText(document, "p1", "bc", "bold"), true);
        assert.equal(blockText(document, "p2"), "xyz");
        assert.ok(uniqueIds(document).includes("p1"));
      }

      engine.enqueue(h, 1, { kind: "block.delete", blockId: "p2" });
      h.sync();
      assertConverged(h);
      for (const document of [h.doc(0), h.doc(1), h.serverDoc()]) {
        assert.equal(findNode(document, "p2"), null);
        assert.equal(blockText(document, "p1"), "aKEEPbc");
      }
    } finally {
      h.close();
    }
  });

  test(`R03 ${engine.name}: row/column insert orders yield identical final IDs, content and marks`, () => {
    const rowFirst = runTableUpgrade(engine, "row");
    const columnFirst = runTableUpgrade(engine, "column");
    const required = ["t1", "row-1", "row-2", "h1", "h2", "c1", "c2", "rowB"];

    for (const run of [rowFirst, columnFirst]) {
      for (const document of run.docs) {
        const shape = tableShape(document);
        assert.equal(shape.rows, 3);
        assert.deepEqual(shape.widths, [3, 3, 3]);
        assert.equal(shape.rectangular, true);
        const ids = uniqueIds(document);
        for (const id of required) assert.ok(ids.includes(id), `missing ${id}`);
        for (const [id, text] of [
          ["h1", "A"],
          ["h2", "B"],
          ["c1", "1"],
          ["c2", "2"],
        ])
          assert.equal(blockText(document, id), text, `${id} content changed`);
        assert.equal(hasMarkedText(document, "c2", "2", "bold"), true);
      }
    }

    assert.deepEqual(stable(rowFirst.docs), stable(columnFirst.docs));
    assert.deepEqual(
      uniqueIds(rowFirst.docs[0]).slice().sort(),
      uniqueIds(columnFirst.docs[0]).slice().sort(),
    );
    assert.deepEqual(
      markedTexts(rowFirst.docs[0]),
      markedTexts(columnFirst.docs[0]),
    );
    assert.deepEqual(rowFirst.tables, columnFirst.tables);
    assert.ok(
      rowFirst.tables.some((t) => t.columnIds.includes("colB")),
      "colB must be retained in atomic table metadata",
    );
  });

  test(`R04 ${engine.name}: structural move undo restores order and keeps the remote KEEP`, () => {
    const h = engine.create({ document: markedDocument(), clients: 2 });
    try {
      engine.enqueue(h, 0, {
        kind: "block.move",
        blockId: "p1",
        parentId: null,
        beforeId: null,
      });
      h.local(1, (state) => insertTextInBlock(state, "p1", 1, "KEEP"));
      h.sync();
      assertConverged(h);
      assert.deepEqual(
        children(h.doc(0)).map((node) => node.attrs?.id),
        ["p2", "p1"],
      );

      assert.equal(
        h.undo(0),
        true,
        "the author of a structure intent must be able to undo that structure",
      );
      h.sync();
      assertConverged(h);
      for (const document of [h.doc(0), h.doc(1), h.serverDoc()]) {
        assert.deepEqual(
          children(document).map((node) => node.attrs?.id),
          ["p1", "p2"],
        );
        assert.equal(blockText(document, "p1"), "aKEEPbc");
        assert.equal(blockText(document, "p2"), "xyz");
        assert.equal(hasMarkedText(document, "p1", "bc", "bold"), true);
      }
    } finally {
      h.close();
    }
  });

  test(`R04 ${engine.name}: per-user table insertion undo removes only its dimension`, () => {
    const h = engine.create({
      document: tableDocument(),
      clients: 2,
      incarnationId: "gate-inc",
    });
    try {
      engine.enqueue(h, 0, {
        kind: "table.row.insert",
        tableId: "t1",
        rowId: "rowB",
        beforeId: null,
      });
      engine.enqueue(h, 1, {
        kind: "table.column.insert",
        tableId: "t1",
        columnId: "colB",
        beforeId: null,
      });
      h.sync();
      assertConverged(h);
      assert.equal(tableShape(h.doc(0)).rows, 3);
      assert.deepEqual(tableShape(h.doc(0)).widths, [3, 3, 3]);

      assert.equal(
        h.undo(0),
        true,
        "the row author must be able to undo its own table row insert",
      );
      h.sync();
      assertConverged(h);
      for (const document of [h.doc(0), h.doc(1), h.serverDoc()]) {
        const shape = tableShape(document);
        assert.equal(shape.rows, 2);
        assert.deepEqual(shape.widths, [3, 3]);
        assert.equal(shape.rectangular, true);
        assert.equal(blockText(document, "c1"), "1");
        assert.equal(blockText(document, "c2"), "2");
        assert.equal(hasMarkedText(document, "c2", "2", "bold"), true);
        uniqueIds(document);
      }
      const afterRowUndo = serverTables(h).find(
        (entry) => entry.tableId === "t1",
      );
      assert.ok(afterRowUndo);
      assert.equal(afterRowUndo.rowIds.includes("rowB"), false);
      assert.equal(afterRowUndo.columnIds.includes("colB"), true);

      assert.equal(
        h.undo(1),
        true,
        "the column author must be able to undo its own table column insert",
      );
      h.sync();
      assertConverged(h);
      const finalShape = tableShape(h.doc(0));
      assert.equal(finalShape.rows, 2);
      assert.deepEqual(finalShape.widths, [2, 2]);
      const finalTables = serverTables(h).find(
        (entry) => entry.tableId === "t1",
      );
      assert.ok(finalTables);
      assert.equal(finalTables.columnIds.includes("colB"), false);
    } finally {
      h.close();
    }
  });

  test(`R04 ${engine.name}: mixed text and structure undo follows the author's reverse operation order`, () => {
    const h = engine.create({ document: simpleDocument(), clients: 2 });
    try {
      h.local(0, (state) => insertTextInBlock(state, "p1", 0, "A"));
      h.sync();
      assert.equal(blockText(h.doc(0), "p1"), "Aabc");

      engine.enqueue(h, 0, {
        kind: "block.move",
        blockId: "p1",
        parentId: null,
        beforeId: null,
      });
      h.sync();
      assert.deepEqual(
        children(h.doc(0)).map((node) => node.attrs?.id),
        ["p2", "p1"],
      );

      h.local(1, (state) => insertTextInBlock(state, "p2", 0, "KEEP"));
      h.sync();
      assert.equal(blockText(h.doc(0), "p2"), "KEEPxyz");

      assert.equal(
        h.undo(0),
        true,
        "undo must first resolve the author's last operation, the move",
      );
      h.sync();
      assertConverged(h);
      for (const document of [h.doc(0), h.doc(1), h.serverDoc()]) {
        assert.deepEqual(
          children(document).map((node) => node.attrs?.id),
          ["p1", "p2"],
        );
        assert.equal(blockText(document, "p1"), "Aabc");
        assert.equal(blockText(document, "p2"), "KEEPxyz");
      }

      assert.equal(
        h.undo(0),
        true,
        "a second undo must remove the author's text insertion and keep remote text",
      );
      h.sync();
      assertConverged(h);
      for (const document of [h.doc(0), h.doc(1), h.serverDoc()]) {
        assert.deepEqual(
          children(document).map((node) => node.attrs?.id),
          ["p1", "p2"],
        );
        assert.equal(blockText(document, "p1"), "abc");
        assert.equal(blockText(document, "p2"), "KEEPxyz");
      }
    } finally {
      h.close();
    }
  });

  test(`R05 ${engine.name}: repeat and reorder transport delivery cannot be proven by the in-memory adapter`, (t) => {
    const h = engine.create({ document: simpleDocument(), clients: 2 });
    try {
      const surface = Object.keys(h);
      assert.equal(typeof h.sync, "function");
      assert.equal(h.sync.length, 0);
      assert.deepEqual(
        surface.filter((key) =>
          /repeat|reorder|redeliver|deliver|retry|transport|inject/i.test(key),
        ),
        [],
      );
      const diagnostics = stable(h.diagnostics());
      assert.equal(
        /repeat|reorder|redeliver|deliver|retry|transport|inject/i.test(
          diagnostics,
        ),
        false,
      );
      t.diagnostic(
        `${engine.name}: sync() is an in-process fixed-point drain with no delivery-order or retry hook, ` +
          "so repeated and reordered transport delivery, missing receipts and redelivery are not provable here.",
      );
    } finally {
      h.close();
    }
  });
}
