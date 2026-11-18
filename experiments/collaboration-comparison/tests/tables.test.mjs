import test from "node:test";
import assert from "node:assert/strict";
import r from "../runtime/bundle.cjs";
import { createHarness as createHarnessB } from "../adapters/b.mjs";
import { createHarness as createHarnessC } from "../adapters/c.mjs";
import { richDocument as richFactory } from "../fixtures/rich.mjs";

const richDocument = richFactory();

if (!richDocument || typeof richDocument !== "object") {
  throw new TypeError("richDocument fixture is unavailable");
}

const ENGINES = [
  { name: "B", createHarness: createHarnessB },
  { name: "C", createHarness: createHarnessC },
];

const TEXT_MARKERS = ["[A]", "[B]"];

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

function findTable(doc) {
  let found = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === "table") {
      found = { node, pos };
      return false;
    }
    return true;
  });
  return found;
}

function tableRows(table) {
  const rows = [];
  table.forEach((row, rowIndex) => {
    const cells = [];
    row.forEach((cell, cellIndex) => {
      cells.push({
        rowIndex,
        cellIndex,
        id: cell.attrs.id,
        type: cell.type.name,
        text: cell.textContent,
        node: cell,
      });
    });
    rows.push({ id: row.attrs.id, node: row, cells });
  });
  return rows;
}

function tableDescription(doc) {
  const found = findTable(doc);
  if (!found) return null;
  const rows = tableRows(found.node);
  return {
    pos: found.pos,
    node: found.node,
    rows,
    rowCount: rows.length,
    columnCount: rows[0]?.cells.length ?? 0,
    cells: rows.flatMap((row) => row.cells),
  };
}

function cellRef(doc, id) {
  let ref = null;
  doc.descendants((node, pos) => {
    if (ref) return false;
    if (
      (node.type.name === "tableCell" || node.type.name === "tableHeader") &&
      node.attrs.id === id
    ) {
      const paragraph = node.firstChild;
      if (!paragraph) return false;
      ref = {
        id,
        pos,
        node,
        text: node.textContent,
        textEnd: pos + node.content.size,
      };
      return false;
    }
    return true;
  });
  return ref;
}

function collectIds(value) {
  const ids = new Set();
  const duplicates = new Set();
  const stack = [value];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (
      node.attrs &&
      typeof node.attrs === "object" &&
      typeof node.attrs.id === "string"
    ) {
      if (ids.has(node.attrs.id)) duplicates.add(node.attrs.id);
      else ids.add(node.attrs.id);
    }
    for (const child of Object.values(node)) {
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return { ids, duplicates: [...duplicates] };
}

function makeIdGenerator(prefix, usedIds) {
  let counter = 0;
  return (kind) => {
    let id;
    do {
      id = `folio-probe-${prefix}-${kind}-${counter}`;
      counter += 1;
    } while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };
}

function makeCell(schema, type, nextId) {
  const paragraph = schema.nodes.paragraph.create({ id: nextId("paragraph") });
  return schema.nodes[type].create({ id: nextId("cell") }, paragraph);
}

function appendRowTransaction(state, nextId) {
  const table = findTable(state.doc);
  if (!table) throw new Error("fixture has no table");
  const width = table.node.firstChild?.childCount ?? 0;
  if (!width) throw new Error("fixture table has no columns");
  const cells = [];
  for (let column = 0; column < width; column += 1) {
    cells.push(makeCell(state.doc.type.schema, "tableCell", nextId));
  }
  const row = state.doc.type.schema.nodes.tableRow.create(
    { id: nextId("row") },
    cells,
  );
  return state.tr.insert(table.pos + 1 + table.node.content.size, row);
}

function appendColumnTransaction(state, nextId) {
  const table = findTable(state.doc);
  if (!table) throw new Error("fixture has no table");
  const rows = [];
  table.node.forEach((row) => rows.push(row));
  const tr = state.tr;
  const mapFrom = tr.mapping.maps.length;
  const insertions = [];
  let rowPosition = table.pos + 1;
  rows.forEach((row, rowIndex) => {
    const type = rowIndex === 0 ? "tableHeader" : "tableCell";
    insertions.push({
      position: rowPosition + 1 + row.content.size,
      cell: makeCell(state.doc.type.schema, type, nextId),
    });
    rowPosition += row.nodeSize;
  });
  for (const insertion of insertions) {
    tr.insert(
      tr.mapping.slice(mapFrom).map(insertion.position),
      insertion.cell,
    );
  }
  return tr;
}

function summarizeDocuments(documents) {
  const canonical = documents.map(stable);
  return canonical[0] === canonical[1];
}

function idsPreserved(initialIds, document) {
  const present = collectIds(document).ids;
  return [...initialIds].every((id) => present.has(id));
}

function originalCellsPreserved(initialCells, document) {
  let pmDoc;
  try {
    pmDoc = r.documentSchema.nodeFromJSON(document);
  } catch {
    return false;
  }
  return initialCells.every((cell) => {
    if (!cell.id) return false;
    const ref = cellRef(pmDoc, cell.id);
    return ref !== null && ref.text === cell.text;
  });
}

export function runTextEditProbe(engine) {
  const harness = engine.createHarness({
    document: clone(richDocument),
    clients: 2,
  });
  try {
    const description = tableDescription(harness.state(0).doc);
    if (!description || description.cells.length < 2) {
      throw new Error("richDocument fixture needs a table with two cells");
    }
    const targets = [
      description.cells[0],
      description.cells[description.cells.length - 1],
    ];
    if (!targets[0].id || !targets[1].id || targets[0].id === targets[1].id) {
      throw new Error("fixture table cells need distinct deterministic ids");
    }
    const initialIds = collectIds(richDocument).ids;
    const initialCells = description.cells.map((cell) => ({
      id: cell.id,
      text: cell.text,
    }));
    const targetIds = new Set(targets.map((target) => target.id));

    targets.forEach((target, clientIndex) => {
      harness.local(clientIndex, (state) => {
        const ref = cellRef(state.doc, target.id);
        if (!ref) throw new Error(`missing target cell ${target.id}`);
        return state.tr.insertText(TEXT_MARKERS[clientIndex], ref.textEnd);
      });
    });
    harness.sync();

    const documents = [harness.doc(0), harness.doc(1)];
    const server =
      typeof harness.serverDoc === "function" ? harness.serverDoc() : null;
    const convergence = summarizeDocuments(documents);
    const validity = documents.map((document) => r.validDocument(document));
    const validDocument = validity.every(Boolean);
    const idsPerDocument = documents.map(collectIds);
    const idsUnique = idsPerDocument.every(
      (result) => result.duplicates.length === 0,
    );
    const preservedIds = documents.every((document) =>
      idsPreserved(initialIds, document),
    );
    const contentChecks = documents.map((document) => {
      const pmDoc = r.documentSchema.nodeFromJSON(document);
      const edited = targets.map((target, clientIndex) => {
        const ref = cellRef(pmDoc, target.id);
        const marker = TEXT_MARKERS[clientIndex];
        const original = target.text;
        return (
          ref !== null &&
          ref.text.length === original.length + marker.length &&
          ref.text.startsWith(original) &&
          ref.text.endsWith(marker)
        );
      });
      const untouched = initialCells
        .filter((cell) => !targetIds.has(cell.id))
        .every((cell) => {
          const ref = cellRef(pmDoc, cell.id);
          return ref !== null && ref.text === cell.text;
        });
      return edited.every(Boolean) && untouched;
    });
    const contentPreservation = contentChecks.every(Boolean);
    const serverValidity =
      server === null || server === undefined ? null : r.validDocument(server);

    return {
      engine: engine.name,
      kind: "text-edit",
      mandatory: true,
      convergence,
      validDocument,
      validity,
      idsUnique,
      idsPreserved: preservedIds,
      contentPreservation,
      contentChecks,
      serverValidity,
      documents,
    };
  } finally {
    harness.close();
  }
}

export function runTableStructureProbe(engine) {
  const harness = engine.createHarness({
    document: clone(richDocument),
    clients: 2,
  });
  try {
    const description = tableDescription(harness.state(0).doc);
    if (!description) throw new Error("richDocument fixture has no table");
    const initialIds = collectIds(richDocument).ids;
    const initialCells = description.cells.map((cell) => ({
      id: cell.id,
      text: cell.text,
    }));
    const rowIds = new Set(initialIds);
    const columnIds = new Set(initialIds);

    harness.local(0, (state) =>
      appendRowTransaction(state, makeIdGenerator("row-client", rowIds)),
    );
    harness.local(1, (state) =>
      appendColumnTransaction(
        state,
        makeIdGenerator("column-client", columnIds),
      ),
    );
    harness.sync();

    const documents = [harness.doc(0), harness.doc(1)];
    const convergence = summarizeDocuments(documents);
    const validity = documents.map((document) => r.validDocument(document));
    const validDocument = validity.every(Boolean);
    const idsPerDocument = documents.map(collectIds);
    const idsUnique = idsPerDocument.every(
      (result) => result.duplicates.length === 0,
    );
    const preservedIds = documents.every((document) =>
      idsPreserved(initialIds, document),
    );
    const contentPreservation = documents.every((document) =>
      originalCellsPreserved(initialCells, document),
    );
    const shapes = documents.map((document) => {
      try {
        const pmDoc = r.documentSchema.nodeFromJSON(document);
        const table = tableDescription(pmDoc);
        return table
          ? {
              rowCount: table.rowCount,
              columnCount: table.columnCount,
            }
          : null;
      } catch {
        return null;
      }
    });
    const expectedShape = shapes.every(
      (shape) =>
        shape !== null &&
        shape.rowCount === description.rowCount + 1 &&
        shape.columnCount === description.columnCount + 1,
    );

    return {
      engine: engine.name,
      kind: "structure",
      mandatory: false,
      convergence,
      validDocument,
      validity,
      idsUnique,
      idsPreserved: preservedIds,
      contentPreservation,
      expectedShape,
      shapes,
      documents,
    };
  } finally {
    harness.close();
  }
}

export function tableProbe() {
  return {
    text: ENGINES.map(runTextEditProbe),
    structure: ENGINES.map(runTableStructureProbe),
  };
}

test("concurrent rich table cell text edits are mandatory and converge", () => {
  for (const engine of ENGINES) {
    const result = runTextEditProbe(engine);
    assert.equal(
      result.convergence,
      true,
      `${result.engine}: concurrent cell text edits did not converge`,
    );
    assert.equal(
      result.validDocument,
      true,
      `${result.engine}: text edits produced an invalid document`,
    );
    assert.equal(
      result.idsUnique,
      true,
      `${result.engine}: text edits duplicated block ids`,
    );
    assert.equal(
      result.idsPreserved,
      true,
      `${result.engine}: text edits lost an existing block id`,
    );
    assert.equal(
      result.contentPreservation,
      true,
      `${result.engine}: text edits lost authored cell content`,
    );
  }
});

test("concurrent table row and column edits are structural diagnostics", (t) => {
  for (const engine of ENGINES) {
    const result = runTableStructureProbe(engine);
    assert.equal(result.kind, "structure");
    assert.equal(result.mandatory, false);
    assert.equal(result.documents.length, 2);
    assert.equal(typeof result.convergence, "boolean");
    assert.equal(typeof result.validDocument, "boolean");
    assert.equal(typeof result.idsUnique, "boolean");
    assert.equal(typeof result.contentPreservation, "boolean");
    if (typeof t.diagnostic === "function") {
      t.diagnostic(
        `${result.engine} structure: convergence=${result.convergence} ` +
          `validDocument=${result.validDocument} idsUnique=${result.idsUnique} ` +
          `expectedShape=${result.expectedShape}`,
      );
    }
  }
});
