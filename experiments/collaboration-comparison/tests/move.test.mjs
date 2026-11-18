import test from "node:test";
import assert from "node:assert/strict";
import * as engineB from "../adapters/b.mjs";
import * as engineC from "../adapters/c.mjs";

const ORIGINAL_IDS = ["p1", "p2"];
const MAX_REPORT_CHARS = 4_000;

export function simpleDocument() {
  return {
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
}

function childrenOf(node) {
  if (!node) return [];
  if (Array.isArray(node.content)) return node.content;
  if (node.content && typeof node.content.forEach === "function") {
    const children = [];
    node.content.forEach((child) => children.push(child));
    return children;
  }
  return [];
}

function typeName(node) {
  return node?.type?.name ?? node?.type;
}

function findBlock(doc, id) {
  let found = null;
  const visit = (node, pos) => {
    if (!node || found) return;
    if (node.attrs && node.attrs.id === id) {
      found = { node, pos };
      return;
    }
    let offset = pos + 1;
    for (const child of childrenOf(node)) {
      visit(child, offset);
      if (found) return;
      offset += child.nodeSize ?? 0;
    }
  };
  visit(doc, 0);
  return found;
}

function blockText(node) {
  if (!node) return "";
  if (typeName(node) === "text") return node.text ?? "";
  let text = "";
  for (const child of childrenOf(node)) text += blockText(child);
  return text;
}

function collectIds(doc) {
  const ids = [];
  const visit = (node) => {
    if (!node) return;
    const id = node.attrs?.id;
    if (typeof id === "string") ids.push(id);
    for (const child of childrenOf(node)) visit(child);
  };
  visit(doc);
  return ids;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

function blockTexts(doc) {
  const out = {};
  const visit = (node) => {
    if (!node) return;
    const id = node.attrs?.id;
    if (typeof id === "string") out[id] = blockText(node);
    for (const child of childrenOf(node)) visit(child);
  };
  visit(doc);
  return out;
}

function bounded(value) {
  const json = JSON.stringify(value);
  return json.length <= MAX_REPORT_CHARS
    ? json
    : `${json.slice(0, MAX_REPORT_CHARS)}…`;
}

export function runMoveProbe(engine) {
  const harness = engine.createHarness({
    document: simpleDocument(),
    clients: 2,
  });
  let error = null;
  let docs = [];
  try {
    harness.local(0, (state) => {
      const first = state.doc.firstChild;
      if (!first) throw new Error("move probe: empty document");
      const nodeSize = first.nodeSize;
      const tr = state.tr.delete(0, nodeSize);
      tr.insert(tr.doc.content.size, first);
      return tr;
    });
    harness.local(1, (state) => {
      const p1 = findBlock(state.doc, "p1");
      if (!p1) throw new Error("move probe: missing p1 before edit");
      return state.tr.insertText("KEEP", p1.pos + 1 + 1);
    });
    harness.sync();
    docs = [harness.doc(0), harness.doc(1)];
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    try {
      harness.close();
    } catch {}
  }

  const converged =
    error === null &&
    docs.length === 2 &&
    canonical(docs[0]) === canonical(docs[1]);
  const keepInP1 =
    error === null &&
    docs.length === 2 &&
    docs.every((doc) => blockText(findBlock(doc, "p1")?.node).includes("KEEP"));
  const originalIdsPresent =
    error === null &&
    docs.length === 2 &&
    docs.every((doc) =>
      ORIGINAL_IDS.every((id) => findBlock(doc, id) !== null),
    );
  const idsUnique =
    error === null &&
    docs.length === 2 &&
    docs.every((doc) => {
      const ids = collectIds(doc);
      return new Set(ids).size === ids.length;
    });

  const report = {
    converged,
    preserved: keepInP1 && originalIdsPresent,
    idsUnique,
    error,
    expectedIds: ORIGINAL_IDS,
    keepInP1,
    originalIdsPresent,
    ids: docs.map(collectIds),
    texts: docs.map(blockTexts),
  };

  return {
    converged,
    preserved: report.preserved,
    idsUnique,
    report,
  };
}

const engines = [
  ["B", engineB],
  ["C", engineC],
];

for (const [label, engine] of engines) {
  test(`R02 move-vs-edit probe (${label}) reports convergence and KEEP/ID retention`, () => {
    const result = runMoveProbe(engine);
    console.log(`[move-probe:${label}] ${bounded(result)}`);

    assert.equal(typeof result.converged, "boolean");
    assert.equal(typeof result.preserved, "boolean");
    assert.equal(typeof result.idsUnique, "boolean");
    assert.equal(
      result.converged,
      true,
      `${label} did not converge: ${result.report.error ?? "replicas differ"}`,
    );
    // Deliberately NOT asserting result.preserved. A real KEEP/identity loss is
    // recorded as an adoption blocker instead of being hidden by a failing probe.
  });

  test(`baseline concurrent text inserts remain separate and converge (${label})`, () => {
    const harness = engine.createHarness({
      document: simpleDocument(),
      clients: 2,
    });
    try {
      harness.local(0, (state) => {
        const p1 = findBlock(state.doc, "p1");
        return state.tr.insertText("AAA", p1.pos + 1 + 1);
      });
      harness.local(1, (state) => {
        const p2 = findBlock(state.doc, "p2");
        return state.tr.insertText("BBB", p2.pos + 1 + 1);
      });
      harness.sync();

      const docs = [harness.doc(0), harness.doc(1)];
      console.log(
        `[move-baseline:${label}] ${bounded({ ids: docs.map(collectIds), texts: docs.map(blockTexts) })}`,
      );

      assert.equal(canonical(docs[0]), canonical(docs[1]));
      for (const doc of docs) {
        assert.match(blockText(findBlock(doc, "p1")?.node), /AAA/);
        assert.match(blockText(findBlock(doc, "p2")?.node), /BBB/);
        assert.deepEqual(collectIds(doc), ORIGINAL_IDS);
      }
    } finally {
      harness.close();
    }
  });
}
