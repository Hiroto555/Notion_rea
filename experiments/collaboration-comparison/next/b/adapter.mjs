import { createRequire } from "node:module";
import { JSDOM } from "jsdom";

const require = createRequire(import.meta.url);
const r = require("../../runtime/bundle.cjs");
const semantic = require("../../runtime-semantic.cjs");

const FRAGMENT = "prosemirror";
const REMOTE_ORIGIN = "next-b-remote-exchange";
const SERVER_CLIENT_ID = 500;
const MAX_EXCHANGE_ROUNDS = 64;
const MAX_SYNC_ROUNDS = 32;

const METHOD_GLOBALS = new Set([
  "getSelection",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
]);

const GLOBAL_NAMES = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLDivElement",
  "HTMLDocument",
  "Text",
  "Comment",
  "Document",
  "DocumentFragment",
  "ShadowRoot",
  "Attr",
  "Range",
  "Selection",
  "DOMRect",
  "DOMRectReadOnly",
  "DOMParser",
  "XMLSerializer",
  "MutationObserver",
  "IntersectionObserver",
  "ResizeObserver",
  "getSelection",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
  "Event",
  "UIEvent",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "InputEvent",
  "CompositionEvent",
  "DragEvent",
  "ClipboardEvent",
  "FocusEvent",
  "WheelEvent",
  "NodeFilter",
  "NodeList",
  "HTMLCollection",
];

let realm = null;
let realmUsers = 0;
const realmGlobals = [];

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

function stripRootSchemaVersion(value) {
  const doc = clone(value);
  if (doc && Object.prototype.hasOwnProperty.call(doc, "schemaVersion"))
    delete doc.schemaVersion;
  return doc;
}

function defineGlobal(name, value, saved) {
  const hadOwn = Object.prototype.hasOwnProperty.call(globalThis, name);
  const descriptor = hadOwn
    ? Object.getOwnPropertyDescriptor(globalThis, name)
    : undefined;
  let applied = false;
  try {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: false,
      writable: true,
      value,
    });
    applied = true;
  } catch {
    applied = false;
  }
  if (!applied) {
    try {
      globalThis[name] = value;
      applied = true;
    } catch {
      applied = false;
    }
  }
  if (applied) saved.push({ name, hadOwn, descriptor });
}

function bindDomGlobals(win, saved) {
  for (const name of GLOBAL_NAMES) {
    const source = name === "window" ? win : win[name];
    if (source === undefined) continue;
    const value =
      METHOD_GLOBALS.has(name) && typeof source === "function"
        ? source.bind(win)
        : source;
    defineGlobal(name, value, saved);
  }
}

function restoreGlobals(saved) {
  for (let i = saved.length - 1; i >= 0; i -= 1) {
    const { name, hadOwn, descriptor } = saved[i];
    try {
      if (hadOwn && descriptor)
        Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    } catch {
      try {
        if (hadOwn && descriptor && "value" in descriptor)
          globalThis[name] = descriptor.value;
      } catch {
        // The host global cannot be restored further.
      }
    }
  }
  saved.length = 0;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function findNode(doc, id) {
  let found = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.attrs && node.attrs.id === id) {
      found = { node, pos };
      return false;
    }
    return true;
  });
  return found;
}

function findJsonNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.attrs && node.attrs.id === id) return node;
  for (const child of node.content ?? []) {
    const found = findJsonNode(child, id);
    if (found) return found;
  }
  return null;
}

function locateJsonNode(document, id) {
  let found = null;
  function walk(parent) {
    const content = parent.content ?? [];
    for (let index = 0; index < content.length; index += 1) {
      const node = content[index];
      if (node && node.attrs && node.attrs.id === id) {
        if (found) throw new Error("B_DUPLICATE_ID");
        found = { node, parent, index };
      }
      walk(node);
    }
  }
  walk(document);
  return found;
}

const TEXTBLOCK_TYPES = new Set(["paragraph", "heading", "codeBlock"]);

function jsonNodeText(node) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(jsonNodeText).join("");
}

function collectTextBlocks(node, out = new Map()) {
  if (!node || typeof node !== "object") return out;
  const id = node.attrs && node.attrs.id;
  if (typeof id === "string" && TEXTBLOCK_TYPES.has(node.type))
    out.set(id, jsonNodeText(node));
  for (const child of node.content ?? []) collectTextBlocks(child, out);
  return out;
}

function hasInlineContent(node) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "text") return (node.text ?? "").length > 0;
  if (node.type === "hardBreak") return false;
  return (node.content ?? []).some(hasInlineContent);
}

function safeBoundary(value, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index > value.length)
    return false;
  if (
    index > 0 &&
    index < value.length &&
    value.charCodeAt(index) >= 0xdc00 &&
    value.charCodeAt(index) <= 0xdfff &&
    value.charCodeAt(index - 1) >= 0xd800 &&
    value.charCodeAt(index - 1) <= 0xdbff
  )
    return false;
  return true;
}

function textPatchFor(blockId, before, after) {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before.charCodeAt(prefix) === after.charCodeAt(prefix)
  )
    prefix += 1;
  while (
    prefix > 0 &&
    (!safeBoundary(before, prefix) || !safeBoundary(after, prefix))
  )
    prefix -= 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before.charCodeAt(before.length - 1 - suffix) ===
      after.charCodeAt(after.length - 1 - suffix)
  )
    suffix += 1;
  while (
    suffix > 0 &&
    (!safeBoundary(before, before.length - suffix) ||
      !safeBoundary(after, after.length - suffix))
  )
    suffix -= 1;
  return {
    kind: "text",
    blockId,
    from: prefix,
    to: before.length - suffix,
    text: after.slice(prefix, after.length - suffix),
    before,
  };
}

function textCommandsBetween(beforeDocument, afterDocument) {
  const before = collectTextBlocks(beforeDocument);
  const after = collectTextBlocks(afterDocument);
  const commands = [];
  for (const [blockId, afterText] of after) {
    const beforeText = before.get(blockId);
    if (beforeText === undefined || beforeText === afterText) continue;
    commands.push(textPatchFor(blockId, beforeText, afterText));
  }
  return commands;
}

function tableMetaOf(state, tableId) {
  return (
    (state.tables ?? []).find((table) => table.tableId === tableId) ?? null
  );
}

function normalizedNodeJson(node) {
  return r.documentSchema.nodeFromJSON(clone(node)).toJSON();
}

function sameNodeJson(left, right) {
  return stable(normalizedNodeJson(left)) === stable(normalizedNodeJson(right));
}

function childIndex(node, id) {
  for (let index = 0; index < node.childCount; index += 1)
    if (node.child(index).attrs && node.child(index).attrs.id === id)
      return index;
  return -1;
}

function childPosition(hit, index) {
  let pos = hit.pos + 1;
  for (let i = 0; i < index; i += 1) pos += hit.node.child(i).nodeSize;
  return pos;
}

function insertionPosition(hit, beforeId) {
  if (beforeId === null) return hit.pos + 1 + hit.node.content.size;
  const index = childIndex(hit.node, beforeId);
  if (index < 0) throw new Error("B_INVALID_ANCHOR");
  return childPosition(hit, index);
}

function inlineText(node) {
  let text = "";
  node.forEach((child) => {
    if (child.isText) text += child.text ?? "";
    else if (child.type.name === "hardBreak") text += "\n";
    else text += child.textContent;
  });
  return text;
}

function inlinePosition(hit, offset) {
  let remaining = offset;
  let pos = hit.pos + 1;
  for (let index = 0; index < hit.node.childCount; index += 1) {
    const child = hit.node.child(index);
    if (child.isText) {
      if (remaining <= child.nodeSize) return pos + remaining;
      remaining -= child.nodeSize;
      pos += child.nodeSize;
      continue;
    }
    if (child.type.name === "hardBreak") {
      if (remaining === 0) return pos;
      remaining -= 1;
      pos += child.nodeSize;
      continue;
    }
    throw new Error("B_UNSUPPORTED_INLINE");
  }
  if (remaining !== 0) throw new Error("B_TEXT_RANGE");
  return pos;
}

export function createHarness({
  document: inputDocument,
  clients = 2,
  incarnationId = "inc1",
} = {}) {
  if (!inputDocument || typeof inputDocument !== "object")
    throw new TypeError("B_INVALID_DOCUMENT");
  if (!Number.isInteger(clients) || clients < 1 || clients > 5)
    throw new TypeError("B_INVALID_CLIENTS");
  if (
    typeof incarnationId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(incarnationId)
  )
    throw new TypeError("B_INVALID_INCARNATION");
  if (!r.inspectSharedDocument(JSON.stringify(inputDocument)).ok)
    throw new Error("B_INVALID_DOCUMENT");

  if (!realm) {
    realm = new JSDOM(
      "<!doctype html><html><head></head><body></body></html>",
      {
        url: "http://localhost/",
      },
    );
    bindDomGlobals(realm.window, realmGlobals);
  }
  const dom = realm;
  realmUsers += 1;

  const views = [];
  const ydocs = [];
  const mounts = [];
  const queues = Array.from({ length: clients }, () => []);
  const histories = Array.from({ length: clients }, () => ({
    undo: [],
    redo: [],
  }));
  const rejected = [];
  const applied = [];
  const acceptedTexts = [];
  const cleanupErrors = [];
  let serverView = null;
  let serverYdoc = null;
  let serverState = null;
  let closed = false;
  let intentCounter = 0;
  let syncCalls = 0;
  let exchangeRounds = 0;
  let exchangeUpdatesCount = 0;

  function normalizeDocument(value) {
    const json =
      value && typeof value.toJSON === "function"
        ? value.toJSON()
        : clone(value);
    const doc = r.versionDocument(clone(json));
    if (inputDocument.schemaVersion !== undefined)
      doc.schemaVersion = inputDocument.schemaVersion;
    return doc;
  }

  function comparableDocument(value) {
    const json =
      value && typeof value.toJSON === "function"
        ? value.toJSON()
        : clone(value);
    return r.documentSchema.nodeFromJSON(stripRootSchemaVersion(json)).toJSON();
  }

  function recordCleanupError(error) {
    cleanupErrors.push(String(error && error.message ? error.message : error));
  }

  function makeView(ydoc, stateDoc) {
    const fragment = ydoc.getXmlFragment(FRAGMENT);
    const state = r.EditorState.create({
      schema: r.documentSchema,
      doc: stateDoc,
      plugins: [
        r.richStructureGuardPlugin(),
        r.ySyncPlugin(fragment),
        r.yUndoPlugin(),
      ],
    });
    const mount = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(mount);
    mounts.push(mount);
    const view = new r.EditorView(mount, { state });
    views.push(view);
    return view;
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const view of views.splice(0).reverse()) {
      try {
        view.destroy();
      } catch (error) {
        recordCleanupError(error);
      }
    }
    for (const ydoc of ydocs.splice(0)) {
      try {
        ydoc.destroy();
      } catch (error) {
        recordCleanupError(error);
      }
    }
    serverYdoc = null;
    for (const mount of mounts.splice(0)) {
      try {
        mount.remove();
      } catch (error) {
        recordCleanupError(error);
      }
    }
    try {
      realmUsers -= 1;
      if (realmUsers === 0) {
        restoreGlobals(realmGlobals);
        dom.window.close();
        realm = null;
      }
    } catch (error) {
      recordCleanupError(error);
    }
  }

  try {
    const stripped = stripRootSchemaVersion(inputDocument);
    const seedNode = r.documentSchema.nodeFromJSON(stripped);
    seedNode.check();
    const seedDoc = new r.Y.Doc();
    seedDoc.clientID = 17;
    r.prosemirrorToYXmlFragment(seedNode, seedDoc.getXmlFragment(FRAGMENT));
    const seedUpdate = r.Y.encodeStateAsUpdate(seedDoc);
    try {
      seedDoc.destroy();
    } catch (error) {
      recordCleanupError(error);
    }

    serverYdoc = new r.Y.Doc();
    serverYdoc.clientID = SERVER_CLIENT_ID;
    r.Y.applyUpdate(serverYdoc, seedUpdate);
    ydocs.push(serverYdoc);
    serverView = makeView(serverYdoc, r.documentSchema.nodeFromJSON(stripped));

    for (let index = 0; index < clients; index += 1) {
      const ydoc = new r.Y.Doc();
      ydoc.clientID = 1000 + index;
      r.Y.applyUpdate(ydoc, seedUpdate);
      ydocs.push(ydoc);
      makeView(ydoc, r.documentSchema.nodeFromJSON(stripped));
    }

    serverState = semantic.seedTables(
      { document: clone(inputDocument), tables: [], tombstones: [] },
      incarnationId,
    );
  } catch (error) {
    close();
    throw error;
  }

  const clientViews = () => views.filter((view) => view !== serverView);

  function assertOpen() {
    if (closed) throw new Error("B_HARNESS_CLOSED");
  }

  function assertClient(index) {
    if (!Number.isInteger(index) || index < 0 || index >= clients)
      throw new RangeError("B_INVALID_INDEX");
    return clientViews()[index];
  }

  function exchange() {
    let rounds = 0;
    let changed = true;
    while (changed && rounds < MAX_EXCHANGE_ROUNDS) {
      rounds += 1;
      changed = false;
      const updates = ydocs.map((ydoc) => r.Y.encodeStateAsUpdate(ydoc));
      for (let source = 0; source < ydocs.length; source += 1) {
        for (let target = 0; target < ydocs.length; target += 1) {
          if (source === target) continue;
          const before = r.Y.encodeStateVector(ydocs[target]);
          r.Y.applyUpdate(ydocs[target], updates[source], REMOTE_ORIGIN);
          exchangeUpdatesCount += 1;
          const after = r.Y.encodeStateVector(ydocs[target]);
          if (!bytesEqual(before, after)) changed = true;
        }
      }
    }
    exchangeRounds += rounds;
  }

  function reconcileServerState() {
    serverState = {
      ...serverState,
      document: normalizeDocument(serverView.state.doc),
    };
  }

  function markRejected(entry, error) {
    rejected.push({
      intentId: entry.intentId,
      writerId: entry.writerId,
      kind: entry.command.kind,
      code:
        error && error.code
          ? error.code
          : String(error && error.message ? error.message : error),
      command: clone(entry.command),
    });
  }

  function markApplied(entry) {
    applied.push({
      intentId: entry.intentId,
      writerId: entry.writerId,
      kind: entry.command.kind,
    });
  }

  function removeQueueHead(index) {
    queues[index].shift();
  }

  function dequeueText() {
    for (let index = 0; index < queues.length; index += 1) {
      const entry = queues[index][0];
      if (entry && entry.command.kind === "text") return { index, entry };
    }
    return null;
  }

  function dequeueStructure() {
    for (let index = 0; index < queues.length; index += 1) {
      const entry = queues[index][0];
      if (entry && entry.command.kind !== "text") return { index, entry };
    }
    return null;
  }

  function enqueue(index, command, extra = {}) {
    assertOpen();
    assertClient(index);
    if (!command || typeof command !== "object")
      throw new TypeError("B_INVALID_INTENT");
    intentCounter += 1;
    const intentId = `b-${index}-${intentCounter}`;
    const raw = clone(command);
    const entry = {
      intentId,
      index,
      writerId: `b-writer-${index}`,
      command: raw,
      baseApplied: raw.kind === "text" ? acceptedTexts.length : null,
      baseTarget: extra.baseTarget ? clone(extra.baseTarget) : null,
      historyAction: extra.historyAction ?? null,
    };
    queues[index].push(entry);
    return intentId;
  }

  function text(index, descriptor) {
    assertOpen();
    const view = assertClient(index);
    if (!descriptor || typeof descriptor !== "object")
      throw new TypeError("B_INVALID_TEXT");
    const hit = findNode(view.state.doc, descriptor.blockId);
    if (!hit) throw new Error("B_TEXT_BLOCK_MISSING");
    return enqueue(index, {
      kind: "text",
      blockId: descriptor.blockId,
      from: descriptor.from,
      to: descriptor.to,
      text: descriptor.text,
      before: inlineText(hit.node),
    });
  }

  function structure(index, command) {
    assertOpen();
    const view = assertClient(index);
    if (!command || typeof command !== "object")
      throw new TypeError("B_INVALID_COMMAND");
    if (typeof command.kind !== "string" || !command.kind)
      throw new TypeError("B_INVALID_COMMAND");
    if (command.kind === "text") return text(index, command);
    const extra = {};
    if (
      command.kind === "block.delete" &&
      typeof command.blockId === "string"
    ) {
      const hit = findNode(view.state.doc, command.blockId);
      if (hit)
        extra.baseTarget = {
          blockId: command.blockId,
          node: hit.node.toJSON(),
        };
    }
    return enqueue(index, command, extra);
  }

  function local(index, fn) {
    assertOpen();
    const view = assertClient(index);
    if (typeof fn !== "function") throw new TypeError("B_INVALID_LOCAL");
    const before = clone(comparableDocument(view.state.doc));
    const tr = fn(view.state);
    if (
      !tr ||
      !Array.isArray(tr.steps) ||
      !tr.doc ||
      typeof tr.docChanged !== "boolean"
    )
      throw new TypeError("B_EXPECTED_TRANSACTION");
    view.dispatch(tr);
    const after = clone(comparableDocument(view.state.doc));
    if (tr.docChanged) recordNative(index, before, after);
    return true;
  }

  function recordNative(index, beforeDocument, afterDocument) {
    histories[index].undo.push({
      type: "native",
      beforeDocument: clone(beforeDocument),
      afterDocument: clone(afterDocument),
    });
    histories[index].redo.length = 0;
  }

  function applyTextPatch(index, patch) {
    const view = assertClient(index);
    const hit = findNode(view.state.doc, patch.blockId);
    if (!hit) throw new Error("B_TEXT_BLOCK_MISSING");
    const from = inlinePosition(hit, patch.from);
    const to = inlinePosition(hit, patch.to);
    view.dispatch(view.state.tr.insertText(patch.text, from, to));
  }

  function nodeFromJson(json) {
    return r.documentSchema.nodeFromJSON(json);
  }

  function buildBlockTransaction(command, afterState) {
    const state = serverView.state;
    const tr = state.tr;
    if (command.kind === "block.move") {
      const source = findNode(state.doc, command.blockId);
      if (!source) throw new Error("B_NODE_MISSING");
      const parent =
        command.parentId === null
          ? { node: state.doc, pos: -1 }
          : findNode(state.doc, command.parentId);
      if (!parent) throw new Error("B_NODE_MISSING");
      const insertAt = insertionPosition(parent, command.beforeId);
      tr.delete(source.pos, source.pos + source.node.nodeSize);
      tr.insert(tr.mapping.map(insertAt, -1), source.node);
      return tr;
    }
    if (command.kind === "block.delete") {
      const source = findNode(state.doc, command.blockId);
      if (!source) throw new Error("B_NODE_MISSING");
      tr.delete(source.pos, source.pos + source.node.nodeSize);
      return tr;
    }
    if (command.kind === "block.insert") {
      const id = command.node && command.node.attrs && command.node.attrs.id;
      const json = id ? findJsonNode(afterState.document, id) : command.node;
      if (!json) throw new Error("B_NODE_MISSING");
      const parent =
        command.parentId === null
          ? { node: state.doc, pos: -1 }
          : findNode(state.doc, command.parentId);
      if (!parent) throw new Error("B_NODE_MISSING");
      tr.insert(
        insertionPosition(parent, command.beforeId),
        nodeFromJson(json),
      );
      return tr;
    }
    if (command.kind === "block.replace") {
      const source = findNode(state.doc, command.blockId);
      if (!source) throw new Error("B_NODE_MISSING");
      const json = findJsonNode(afterState.document, command.blockId);
      if (!json) throw new Error("B_NODE_MISSING");
      tr.replaceWith(
        source.pos,
        source.pos + source.node.nodeSize,
        nodeFromJson(json),
      );
      return tr;
    }
    if (command.kind === "block.split") {
      const source = findNode(state.doc, command.blockId);
      if (!source) throw new Error("B_NODE_MISSING");
      const left = findJsonNode(afterState.document, command.blockId);
      const right = findJsonNode(afterState.document, command.newId);
      if (!left || !right) throw new Error("B_NODE_MISSING");
      tr.replaceWith(source.pos, source.pos + source.node.nodeSize, [
        nodeFromJson(left),
        nodeFromJson(right),
      ]);
      return tr;
    }
    if (command.kind === "block.join") {
      const left = findNode(state.doc, command.leftId);
      const right = findNode(state.doc, command.rightId);
      if (!left || !right) throw new Error("B_NODE_MISSING");
      const json = findJsonNode(afterState.document, command.leftId);
      if (!json) throw new Error("B_NODE_MISSING");
      tr.replaceWith(
        left.pos,
        right.pos + right.node.nodeSize,
        nodeFromJson(json),
      );
      return tr;
    }
    throw new Error("B_UNSUPPORTED_ACCEPTED_COMMAND");
  }

  function buildTableTransaction(command, beforeState, afterState) {
    const state = serverView.state;
    const tr = state.tr;
    const tableHit = findNode(state.doc, command.tableId);
    if (!tableHit) throw new Error("B_TABLE_MISSING");
    const afterMeta = (afterState.tables ?? []).find(
      (table) => table.tableId === command.tableId,
    );
    const beforeMeta = (beforeState.tables ?? []).find(
      (table) => table.tableId === command.tableId,
    );
    if (command.kind === "table.row.insert") {
      if (!afterMeta) throw new Error("B_TABLE_METADATA_MISSING");
      const index = afterMeta.rowIds.indexOf(command.rowId);
      if (index < 0) throw new Error("B_ROW_MISSING");
      const rowJson = findJsonNode(afterState.document, command.rowId);
      if (!rowJson) throw new Error("B_ROW_MISSING");
      tr.insert(childPosition(tableHit, index), nodeFromJson(rowJson));
      return tr;
    }
    if (command.kind === "table.column.insert") {
      if (!afterMeta) throw new Error("B_TABLE_METADATA_MISSING");
      const index = afterMeta.columnIds.indexOf(command.columnId);
      if (index < 0) throw new Error("B_COLUMN_MISSING");
      const afterTable = findJsonNode(afterState.document, command.tableId);
      if (!afterTable) throw new Error("B_TABLE_MISSING");
      const rows = afterTable.content ?? [];
      for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
        const rowJson = rows[rowIndex];
        const rowId = rowJson.attrs && rowJson.attrs.id;
        const cellJson = rowJson.content && rowJson.content[index];
        if (!rowId || !cellJson) throw new Error("B_COLUMN_SHAPE");
        const rowHit = findNode(tr.doc, rowId);
        if (!rowHit) throw new Error("B_ROW_MISSING");
        tr.insert(childPosition(rowHit, index), nodeFromJson(cellJson));
      }
      return tr;
    }
    if (command.kind === "table.row.delete") {
      const row = findNode(state.doc, command.rowId);
      if (!row) throw new Error("B_ROW_MISSING");
      tr.delete(row.pos, row.pos + row.node.nodeSize);
      return tr;
    }
    if (command.kind === "table.column.delete") {
      if (!beforeMeta) throw new Error("B_TABLE_METADATA_MISSING");
      const index = beforeMeta.columnIds.indexOf(command.columnId);
      if (index < 0) throw new Error("B_COLUMN_MISSING");
      for (
        let rowIndex = beforeMeta.rowIds.length - 1;
        rowIndex >= 0;
        rowIndex -= 1
      ) {
        const rowHit = findNode(tr.doc, beforeMeta.rowIds[rowIndex]);
        if (!rowHit) throw new Error("B_ROW_MISSING");
        const cell = rowHit.node.child(index);
        const pos = childPosition(rowHit, index);
        tr.delete(pos, pos + cell.nodeSize);
      }
      return tr;
    }
    throw new Error("B_UNSUPPORTED_ACCEPTED_COMMAND");
  }

  function applyAcceptedStructure(command, beforeState, afterState) {
    const tr = command.kind.startsWith("table.")
      ? buildTableTransaction(command, beforeState, afterState)
      : buildBlockTransaction(command, afterState);
    if (!tr.docChanged) throw new Error("B_ACCEPTED_NO_CHANGE");
    const actual = stable(comparableDocument(tr.doc));
    const expected = stable(comparableDocument(afterState.document));
    if (actual !== expected)
      throw new Error("B_SEMANTIC_BINDING_MISMATCH:" + command.kind);
    serverView.dispatch(tr);
  }

  function completeHistory(entry) {
    const action = entry.historyAction;
    if (!action) return;
    action.remaining -= 1;
    if (action.remaining > 0) return;
    const history = histories[entry.index];
    const target = action.target;
    if (action.direction === "undo") {
      const at = history.undo.lastIndexOf(target);
      if (at >= 0) history.undo.splice(at, 1);
      history.redo.push(target);
    } else {
      const at = history.redo.lastIndexOf(target);
      if (at >= 0) history.redo.splice(at, 1);
      history.undo.push(target);
    }
  }

  function processText(entry) {
    const before = serverState;
    const command = entry.command;
    const intervening = acceptedTexts.slice(entry.baseApplied);
    const result = semantic.applyText(serverState, command, intervening);
    if (!result || !result.appliedText) throw new Error("B_TEXT_NO_PATCH");
    applyTextPatch(entry.index, result.appliedText);
    serverState = result.state;
    acceptedTexts.push(result.appliedText);
    exchange();
    if (!entry.historyAction)
      recordNative(
        entry.index,
        clone(before.document),
        clone(result.state.document),
      );
    else completeHistory(entry);
  }

  function processStructure(entry) {
    const before = serverState;
    const command = entry.command;
    if (entry.baseTarget && command.kind === "block.delete") {
      const current = findJsonNode(before.document, entry.baseTarget.blockId);
      if (!current || !sameNodeJson(current, entry.baseTarget.node))
        throw new Error("B_STALE_DELETE_TARGET");
    }
    const result = command.kind.startsWith("table.")
      ? semantic.applyTable(before, command, incarnationId)
      : semantic.applyBlock(before, command);
    applyAcceptedStructure(command, before, result.state);
    serverState = result.state;
    exchange();
    if (!entry.historyAction) {
      histories[entry.index].undo.push({
        type: "structure",
        writerId: entry.writerId,
        command: clone(command),
        before: clone(before),
        after: clone(result.state),
      });
      histories[entry.index].redo.length = 0;
    } else completeHistory(entry);
  }

  function sync() {
    assertOpen();
    syncCalls += 1;
    exchange();
    reconcileServerState();
    const report = { applied: [], rejected: [], rounds: 0 };
    for (let round = 0; round < MAX_SYNC_ROUNDS; round += 1) {
      let progressed = false;

      let textEntry;
      while ((textEntry = dequeueText()) !== null) {
        reconcileServerState();
        try {
          processText(textEntry.entry);
          markApplied(textEntry.entry);
          report.applied.push(applied[applied.length - 1]);
        } catch (error) {
          markRejected(textEntry.entry, error);
          report.rejected.push(rejected[rejected.length - 1]);
        }
        removeQueueHead(textEntry.index);
        progressed = true;
      }

      let structureEntry;
      while ((structureEntry = dequeueStructure()) !== null) {
        reconcileServerState();
        try {
          processStructure(structureEntry.entry);
          markApplied(structureEntry.entry);
          report.applied.push(applied[applied.length - 1]);
        } catch (error) {
          markRejected(structureEntry.entry, error);
          report.rejected.push(rejected[rejected.length - 1]);
        }
        removeQueueHead(structureEntry.index);
        progressed = true;
      }

      if (!progressed) break;
      report.rounds = round + 1;
    }
    exchange();
    return report;
  }

  function inverseRowInsert(entry, current, command) {
    const afterMeta = tableMetaOf(entry.after, command.tableId);
    const nowMeta = tableMetaOf(current, command.tableId);
    if (!afterMeta || !nowMeta) throw new Error("HISTORY_CONFLICT");
    const afterIndex = afterMeta.rowIds.indexOf(command.rowId);
    const nowIndex = nowMeta.rowIds.indexOf(command.rowId);
    if (afterIndex < 0 || nowIndex < 0) throw new Error("HISTORY_CONFLICT");
    const afterTable = findJsonNode(entry.after.document, command.tableId);
    const nowTable = findJsonNode(current.document, command.tableId);
    if (!afterTable || !nowTable) throw new Error("HISTORY_CONFLICT");
    const afterRow = (afterTable.content ?? [])[afterIndex];
    const nowRow = (nowTable.content ?? [])[nowIndex];
    if (!afterRow || !nowRow) throw new Error("HISTORY_CONFLICT");
    for (let column = 0; column < nowMeta.columnIds.length; column += 1) {
      const afterColumn = afterMeta.columnIds.indexOf(
        nowMeta.columnIds[column],
      );
      const nowCell = (nowRow.content ?? [])[column];
      if (!nowCell) throw new Error("HISTORY_CONFLICT");
      if (afterColumn >= 0) {
        const postCell = (afterRow.content ?? [])[afterColumn];
        if (!postCell || !sameNodeJson(postCell, nowCell))
          throw new Error("HISTORY_CONFLICT");
      } else if (hasInlineContent(nowCell)) {
        throw new Error("HISTORY_CONFLICT");
      }
    }
    return {
      kind: "table.row.delete",
      tableId: command.tableId,
      rowId: command.rowId,
    };
  }

  function inverseColumnInsert(entry, current, command) {
    const afterMeta = tableMetaOf(entry.after, command.tableId);
    const nowMeta = tableMetaOf(current, command.tableId);
    if (!afterMeta || !nowMeta) throw new Error("HISTORY_CONFLICT");
    const postIndex = afterMeta.columnIds.indexOf(command.columnId);
    const nowIndex = nowMeta.columnIds.indexOf(command.columnId);
    if (postIndex < 0 || nowIndex < 0) throw new Error("HISTORY_CONFLICT");
    const afterTable = findJsonNode(entry.after.document, command.tableId);
    const nowTable = findJsonNode(current.document, command.tableId);
    if (!afterTable || !nowTable) throw new Error("HISTORY_CONFLICT");
    const nowRows = nowTable.content ?? [];
    for (const nowRow of nowRows) {
      const rowId = nowRow && nowRow.attrs && nowRow.attrs.id;
      if (typeof rowId !== "string") throw new Error("HISTORY_CONFLICT");
      const nowCell = (nowRow.content ?? [])[nowIndex];
      if (!nowCell) throw new Error("HISTORY_CONFLICT");
      const afterIndex = afterMeta.rowIds.indexOf(rowId);
      if (afterIndex >= 0) {
        const afterRow = (afterTable.content ?? [])[afterIndex];
        const postCell = (afterRow && afterRow.content ? afterRow.content : [])[
          postIndex
        ];
        if (!postCell || !sameNodeJson(postCell, nowCell))
          throw new Error("HISTORY_CONFLICT");
      } else if (hasInlineContent(nowCell)) {
        throw new Error("HISTORY_CONFLICT");
      }
    }
    return {
      kind: "table.column.delete",
      tableId: command.tableId,
      columnId: command.columnId,
    };
  }

  function inverseForHistory(entry, current) {
    const command = entry.command;
    switch (command.kind) {
      case "block.move": {
        const original = locateJsonNode(entry.before.document, command.blockId);
        if (!original) throw new Error("HISTORY_CONFLICT");
        locateJsonNode(current.document, command.blockId);
        const parentId =
          original.parent === entry.before.document
            ? null
            : original.parent.attrs && original.parent.attrs.id;
        if (parentId !== null && typeof parentId !== "string")
          throw new Error("HISTORY_UNSUPPORTED");
        const next = (original.parent.content ?? [])[original.index + 1];
        let beforeId = null;
        if (next) {
          const id = next.attrs && next.attrs.id;
          if (typeof id !== "string") throw new Error("HISTORY_UNSUPPORTED");
          beforeId = id;
        }
        if (parentId !== null && !locateJsonNode(current.document, parentId))
          throw new Error("HISTORY_CONFLICT");
        if (beforeId !== null && !findJsonNode(current.document, beforeId))
          throw new Error("HISTORY_CONFLICT");
        return {
          kind: "block.move",
          blockId: command.blockId,
          parentId,
          beforeId,
        };
      }
      case "block.insert": {
        const id = command.node && command.node.attrs && command.node.attrs.id;
        if (typeof id !== "string") throw new Error("HISTORY_UNSUPPORTED");
        const after = findJsonNode(entry.after.document, id);
        const now = findJsonNode(current.document, id);
        if (!after || !now || !sameNodeJson(after, now))
          throw new Error("HISTORY_CONFLICT");
        return { kind: "block.delete", blockId: id };
      }
      case "table.row.insert":
        return inverseRowInsert(entry, current, command);
      case "table.column.insert":
        return inverseColumnInsert(entry, current, command);
      default:
        throw new Error("HISTORY_UNSUPPORTED:" + command.kind);
    }
  }

  function tryNativeUndo(view) {
    const before = stable(comparableDocument(view.state.doc));
    let result = false;
    try {
      result = r.yUndo(view.state) === true;
    } catch {
      result = false;
    }
    if (!result) return false;
    return stable(comparableDocument(view.state.doc)) !== before;
  }

  function tryNativeRedo(view) {
    const before = stable(comparableDocument(view.state.doc));
    let result = false;
    try {
      result = r.yRedo(view.state) === true;
    } catch {
      result = false;
    }
    if (!result) return false;
    return stable(comparableDocument(view.state.doc)) !== before;
  }

  function undo(index) {
    assertOpen();
    const view = assertClient(index);
    const history = histories[index];
    const top = history.undo[history.undo.length - 1];
    if (!top) return false;
    if (top.type === "native") {
      if (tryNativeUndo(view)) {
        history.undo.pop();
        history.redo.push(top);
        return true;
      }
      const commands = textCommandsBetween(
        top.afterDocument,
        top.beforeDocument,
      );
      if (!commands.length) return false;
      const action = {
        direction: "undo",
        target: top,
        remaining: commands.length,
      };
      for (const command of commands)
        enqueue(index, command, { historyAction: action });
      return true;
    }
    exchange();
    reconcileServerState();
    let inverse;
    try {
      inverse = inverseForHistory(top, serverState);
    } catch {
      return false;
    }
    enqueue(index, inverse, {
      historyAction: { direction: "undo", target: top, remaining: 1 },
    });
    return true;
  }

  function redo(index) {
    assertOpen();
    const view = assertClient(index);
    const history = histories[index];
    const top = history.redo[history.redo.length - 1];
    if (!top) return false;
    if (top.type === "native") {
      if (tryNativeRedo(view)) {
        history.redo.pop();
        history.undo.push(top);
        return true;
      }
      const commands = textCommandsBetween(
        top.beforeDocument,
        top.afterDocument,
      );
      if (!commands.length) return false;
      const action = {
        direction: "redo",
        target: top,
        remaining: commands.length,
      };
      for (const command of commands)
        enqueue(index, command, { historyAction: action });
      return true;
    }
    exchange();
    reconcileServerState();
    enqueue(index, clone(top.command), {
      historyAction: { direction: "redo", target: top, remaining: 1 },
    });
    return true;
  }

  function state(index) {
    assertOpen();
    return assertClient(index).state;
  }

  function doc(index) {
    assertOpen();
    return normalizeDocument(assertClient(index).state.doc);
  }

  function serverDoc() {
    assertOpen();
    return normalizeDocument(serverView.state.doc);
  }

  function serverDocumentState() {
    assertOpen();
    return clone(serverState);
  }

  function pendingCount(index) {
    assertOpen();
    if (index === undefined)
      return queues.reduce((total, queue) => total + queue.length, 0);
    assertClient(index);
    return queues[index].length;
  }

  function diagnostics() {
    return {
      engine: "B-next",
      runtime: "y-prosemirror",
      binding: "ySyncPlugin+yUndoPlugin",
      serverBinding: "actual-EditorView",
      semantics: "runtime-semantic.cjs:applyBlock/applyTable/applyText",
      dom: "jsdom",
      gui: "none",
      browser: false,
      closed,
      clients,
      incarnationId,
      sync: {
        calls: syncCalls,
        exchangeRounds,
        exchangeUpdates: exchangeUpdatesCount,
      },
      queues: queues.map((queue) => queue.length),
      applied: clone(applied),
      rejected: clone(rejected),
      serverCut: {
        tables: serverState ? serverState.tables.length : 0,
        tombstones: serverState ? serverState.tombstones.length : 0,
      },
      cleanupErrors: cleanupErrors.slice(),
    };
  }

  return {
    state,
    doc,
    local,
    text,
    structure,
    sync,
    undo,
    redo,
    close,
    serverDoc,
    serverDocumentState,
    pendingCount,
    diagnostics,
  };
}
