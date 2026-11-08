import { writeFileSync } from "node:fs";
import r from "./runtime/bundle.cjs";
import { createHarness as B } from "./adapters/b.mjs";
import { createHarness as C } from "./adapters/c.mjs";
import { simpleDocument, richDocument } from "./fixtures/rich.mjs";
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function text(doc, id) {
  let found = "";
  const walk = (n) => {
    if (n.attrs?.id === id)
      found = n.content?.map((x) => x.text ?? "").join("") ?? "";
    else for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return found;
}
function run(create) {
  const ordinary = [];
  for (const clients of [2, 5]) {
    const h = create({ document: richDocument(), clients });
    try {
      const labels = Array.from({ length: clients }, (_, i) => `日本語😀${i}`);
      labels.forEach((x, i) => h.local(i, (s) => s.tr.insertText(x, 1)));
      h.sync();
      const docs = labels.map((_, i) => h.doc(i));
      ordinary.push({
        clients,
        converged: docs.every((d) => equal(d, docs[0])),
        valid: docs.every(r.validDocument),
        preserved: labels.every((x) => JSON.stringify(docs[0]).includes(x)),
      });
    } finally {
      h.close();
    }
  }
  const h = create({ document: simpleDocument() });
  let move;
  try {
    h.local(0, (s) => {
      const first = s.doc.firstChild;
      const tr = s.tr.delete(0, first.nodeSize);
      return tr.insert(tr.doc.content.size, first);
    });
    h.local(1, (s) => s.tr.insertText("KEEP", 2));
    h.sync();
    const docs = [h.doc(0), h.doc(1)];
    move = {
      converged: equal(...docs),
      preserved: docs.every((d) => text(d, "p1").includes("KEEP")),
      p1: docs.map((d) => text(d, "p1")),
      p2: docs.map((d) => text(d, "p2")),
      diagnostics: h.diagnostics(),
    };
  } finally {
    h.close();
  }
  const table = create({ document: richDocument() });
  let shape;
  try {
    function ref(s) {
      let at;
      s.doc.descendants((n, p) => {
        if (n.type.name === "table") at = { node: n, pos: p };
      });
      return at;
    }
    const cell = (id, type = "tableCell") =>
      r.documentSchema.nodes[type].create(
        { id },
        r.documentSchema.nodes.paragraph.create({ id: id + "-p" }),
      );
    table.local(0, (s) => {
      const t = ref(s);
      const row = r.documentSchema.nodes.tableRow.create({ id: "new-row" }, [
        cell("new-r1"),
        cell("new-r2"),
      ]);
      return s.tr.insert(t.pos + 1 + t.node.content.size, row);
    });
    table.local(1, (s) => {
      const t = ref(s),
        tr = s.tr;
      let pos = t.pos + 1;
      t.node.forEach((row, offset, index) => {
        const end = pos + 1 + row.content.size;
        tr.insert(
          tr.mapping.map(end),
          cell("new-c" + index, index === 0 ? "tableHeader" : "tableCell"),
        );
        pos += row.nodeSize;
      });
      return tr;
    });
    table.sync();
    const docs = [table.doc(0), table.doc(1)];
    shape = {
      converged: equal(...docs),
      valid: docs.map(r.validDocument),
      diagnostics: table.diagnostics(),
    };
  } finally {
    table.close();
  }
  return { ordinary, move, table: shape };
}
const results = {
  scope: "ACTUAL_SCHEMA_RESTRICTED_COMPARISON",
  mechanism:
    "B=ySync/yUndo; C=collab/history; same richStructureGuard; no random ID repair",
  schema: {
    nodes: Object.keys(r.documentSchema.nodes),
    marks: Object.keys(r.documentSchema.marks),
  },
  schedule:
    "fixed seed Y client1; replicas1000+i; C client1+i; local0,local1 before bounded sync in index order",
  B: run(B),
  C: run(C),
  decision: {
    fullAdoption: "NO_GO",
    reason: [
      "R02 move intent not retained",
      "R03 row-column merge does not converge with actual guard",
    ],
    limitedPilot: "C_TEXT_ONLY_SELECTED_RESTRICTED",
  },
  notRun: [
    "GUI",
    "native IME",
    "native clipboard",
    "physical multi-Mac",
    "production auth",
    "production network",
    "compaction",
    "power-loss durability",
  ],
};
for (const key of ["B", "C"])
  for (const item of results[key].ordinary)
    if (!item.converged || !item.valid || !item.preserved)
      throw Error("mandatory text baseline failed");
writeFileSync(
  new URL("./comparison-result.json", import.meta.url),
  JSON.stringify(results, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    B: { move: results.B.move.preserved, table: results.B.table.converged },
    C: { move: results.C.move.preserved, table: results.C.table.converged },
    decision: results.decision,
  }),
);
