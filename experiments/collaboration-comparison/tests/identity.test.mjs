import test from "node:test";
import assert from "node:assert/strict";
import r from "../runtime/bundle.cjs";

const BLOCK_TYPES = [...r.BLOCK_TYPES];

function text(value) {
  return { type: "text", text: value };
}

function block(type, id, content, attrs = {}) {
  const node = { type, attrs: { ...attrs, id } };
  if (content !== undefined) node.content = content;
  return node;
}

// Fixed IDs: tests must never depend on crypto.randomUUID or a repair pass.
function fixtureDocument() {
  return {
    type: "doc",
    content: [
      block("paragraph", "fix-paragraph", [text("paragraph")]),
      block("heading", "fix-heading", [text("heading")], { level: 2 }),
      block("blockquote", "fix-blockquote", [
        block("paragraph", "fix-blockquote-paragraph", [text("quote")]),
      ]),
      block("bulletList", "fix-bullet-list", [
        block("listItem", "fix-bullet-list-item", [
          block("paragraph", "fix-bullet-list-paragraph", [text("bullet")]),
        ]),
      ]),
      block(
        "orderedList",
        "fix-ordered-list",
        [
          block("listItem", "fix-ordered-list-item", [
            block("paragraph", "fix-ordered-list-paragraph", [text("ordered")]),
          ]),
        ],
        { start: 1 },
      ),
      block("taskList", "fix-task-list", [
        block(
          "taskItem",
          "fix-task-item",
          [block("paragraph", "fix-task-item-paragraph", [text("task")])],
          { checked: false },
        ),
      ]),
      block("codeBlock", "fix-code-block", [text("const value = 1;")]),
      block("horizontalRule", "fix-horizontal-rule"),
      block("image", "fix-image", undefined, {
        src: "folio-asset://fixture/image.png",
        alt: "fixture image",
      }),
      block("details", "fix-details", [
        block("detailsSummary", "fix-details-summary", [text("summary")]),
        block("detailsContent", "fix-details-content", [
          block("paragraph", "fix-details-content-paragraph", [
            text("details"),
          ]),
        ]),
      ]),
      block(
        "callout",
        "fix-callout",
        [block("paragraph", "fix-callout-paragraph", [text("callout")])],
        { tone: "note" },
      ),
      block("table", "fix-table", [
        block("tableRow", "fix-table-header-row", [
          block("tableHeader", "fix-table-header", [
            block("paragraph", "fix-table-header-paragraph", [text("header")]),
          ]),
        ]),
        block("tableRow", "fix-table-row", [
          block("tableCell", "fix-table-cell", [
            block("paragraph", "fix-table-cell-paragraph", [text("cell")]),
          ]),
        ]),
      ]),
    ],
  };
}

function blockNodes(document) {
  const parsed = r.documentSchema.nodeFromJSON(document);
  const blocks = [];
  parsed.descendants((node) => {
    if (BLOCK_TYPES.includes(node.type.name)) blocks.push(node);
  });
  return { parsed, blocks };
}

function findBlock(document, id) {
  return document.content.find((node) => node.attrs?.id === id);
}

// Test-local model of the stricter shared-seed policy. The product currently
// has no shared seed validator, so this is evidence of the needed check, not a
// claim that such an API exists.
function hasCompleteUniqueBlockIds(document) {
  const ids = new Set();
  const { blocks } = blockNodes(document);
  for (const node of blocks) {
    const id = node.attrs.id;
    if (typeof id !== "string" || id.length === 0 || ids.has(id)) return false;
    ids.add(id);
  }
  return true;
}

test("schema fixture covers every BLOCK_TYPE with deterministic unique nonempty IDs", () => {
  assert.equal(new Set(BLOCK_TYPES).size, BLOCK_TYPES.length);
  for (const type of BLOCK_TYPES)
    assert.ok(r.documentSchema.nodes[type], `schema must define ${type}`);

  const first = fixtureDocument();
  const second = fixtureDocument();
  assert.deepEqual(first, second, "fixture is deterministic");
  assert.equal(
    r.validDocument(first),
    true,
    "fixture must be an actual validDocument",
  );

  const { parsed, blocks } = blockNodes(first);
  const seenTypes = new Set();
  const seenIds = [];
  for (const node of blocks) {
    seenTypes.add(node.type.name);
    assert.equal(typeof node.attrs.id, "string", `${node.type.name} id type`);
    assert.ok(node.attrs.id.length > 0, `${node.type.name} id nonempty`);
    seenIds.push(node.attrs.id);
  }
  assert.deepEqual([...seenTypes].sort(), [...BLOCK_TYPES].sort());
  assert.equal(new Set(seenIds).size, seenIds.length, "IDs are unique");

  const { parsed: reparsed } = blockNodes(second);
  assert.deepEqual(reparsed.toJSON(), parsed.toJSON());
});

test("ProseMirror nodeFromJSON silently drops unknown attrs if accepted blindly", () => {
  const malformed = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "p1", futureAttr: "must-not-disappear" },
        content: [text("body")],
      },
    ],
  };

  assert.equal(r.validDocument(malformed), false);

  const parsed = r.documentSchema.nodeFromJSON(malformed);
  const paragraph = parsed.firstChild;
  assert.equal(paragraph.attrs.id, "p1");
  assert.equal(Object.hasOwn(paragraph.attrs, "futureAttr"), false);
  assert.equal(
    Object.hasOwn(parsed.toJSON().content[0].attrs, "futureAttr"),
    false,
  );
});

test("validDocument rejects unknown attrs instead of trusting PM's lossy parse", () => {
  const document = fixtureDocument();
  findBlock(document, "fix-paragraph").attrs.futureAttr = "unknown";
  assert.equal(r.validDocument(document), false);

  const root = fixtureDocument();
  root.futureRootField = true;
  assert.equal(r.validDocument(root), false);
});

test("validDocument rejects duplicate IDs while PM alone accepts them", () => {
  const document = fixtureDocument();
  findBlock(document, "fix-heading").attrs.id = "fix-paragraph";
  assert.equal(r.validDocument(document), false);

  const parsed = r.documentSchema.nodeFromJSON(document);
  assert.doesNotThrow(() => parsed.check());
});

test("validDocument permits a missing block ID privately, so shared seeds need a stricter check", () => {
  const document = fixtureDocument();
  delete findBlock(document, "fix-paragraph").attrs.id;

  assert.equal(r.validDocument(document), true);
  const { parsed } = blockNodes(document);
  assert.equal(parsed.firstChild.attrs.id, null);

  assert.equal(hasCompleteUniqueBlockIds(document), false);
  assert.equal(hasCompleteUniqueBlockIds(fixtureDocument()), true);
});

test("prototype-named attributes are rejected by the owning validator itself", () => {
  for (const key of ["constructor", "toString", "__proto__"]) {
    const raw = {
      type: "doc",
      content: [{ type: "paragraph", attrs: { id: "p1", [key]: "authored" } }],
    };
    assert.equal(r.validDocument(raw), false);
  }
});
