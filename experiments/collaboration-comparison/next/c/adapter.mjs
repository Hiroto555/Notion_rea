import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const r = require("../../runtime/bundle.cjs");
const semantic = require("../runtime-semantic.cjs");

const REQUIRED_SEMANTIC_EXPORTS = [
  "applyBlock",
  "applyMoveTransform",
  "applyTable",
  "applyText",
  "initialState",
  "moveStep",
  "seedTables",
  "wellFormed",
];
for (const name of REQUIRED_SEMANTIC_EXPORTS) {
  if (typeof semantic[name] !== "function") {
    throw new Error(`runtime-semantic.cjs must export function ${name}`);
  }
}

const MAX_SYNC_ROUNDS = 10000;
const MAX_REJECTION_RECORDS = 200;
const DEFAULT_INCARNATION = "inc-c-next";
const SERVER_CLIENT_ID = 900719;
const TEXTBLOCK_TYPES = new Set(["paragraph", "heading", "codeBlock"]);

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isSurrogateHigh(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isSurrogateLow(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

function safeBoundary(value, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index > value.length)
    return false;
  if (
    index > 0 &&
    index < value.length &&
    isSurrogateLow(value.charCodeAt(index)) &&
    isSurrogateHigh(value.charCodeAt(index - 1))
  )
    return false;
  return true;
}

function nodeText(value) {
  if (value === null || value === undefined) return "";
  if (value.isText) return value.text ?? "";
  if (value.type === "text") return value.text ?? "";
  const name = typeof value.type === "string" ? value.type : value.type?.name;
  if (name === "hardBreak") return "\n";
  if (value.isLeaf) return "";
  let text = "";
  if (Array.isArray(value.content)) {
    for (const child of value.content) text += nodeText(child);
    return text;
  }
  if (value.content && typeof value.content.forEach === "function") {
    value.content.forEach((child) => {
      text += nodeText(child);
    });
  }
  return text;
}

function collectBlockTexts(value, out = {}) {
  if (!value || typeof value !== "object") return out;
  const name = typeof value.type === "string" ? value.type : value.type?.name;
  const id = value.attrs?.id;
  if (typeof id === "string" && TEXTBLOCK_TYPES.has(name)) {
    out[id] = nodeText(value);
  }
  if (Array.isArray(value.content)) {
    for (const child of value.content) collectBlockTexts(child, out);
  } else if (value.content && typeof value.content.forEach === "function") {
    value.content.forEach((child) => collectBlockTexts(child, out));
  }
  return out;
}

function textPatch(blockId, before, after) {
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before.charCodeAt(prefix) === after.charCodeAt(prefix)
  ) {
    prefix += 1;
  }
  while (
    prefix > 0 &&
    (!safeBoundary(before, prefix) || !safeBoundary(after, prefix))
  ) {
    prefix -= 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before.charCodeAt(before.length - 1 - suffix) ===
      after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  while (
    suffix > 0 &&
    (!safeBoundary(before, before.length - suffix) ||
      !safeBoundary(after, after.length - suffix))
  ) {
    suffix -= 1;
  }
  return {
    kind: "text",
    blockId,
    from: prefix,
    to: before.length - suffix,
    text: after.slice(prefix, after.length - suffix),
    before,
  };
}

function sameMarkup(left, right) {
  if (left.type !== right.type) return false;
  if (typeof left.sameMarkup === "function") return left.sameMarkup(right);
  return (
    JSON.stringify(left.attrs ?? {}) === JSON.stringify(right.attrs ?? {}) &&
    JSON.stringify(left.marks ?? []) === JSON.stringify(right.marks ?? [])
  );
}

function childKey(node) {
  const id = node.attrs?.id;
  if (typeof id === "string") return `i:${id}`;
  const name = typeof node.type === "string" ? node.type : node.type?.name;
  if (name === "text") return `t:${node.text ?? ""}`;
  return `n:${name}:${JSON.stringify(node.attrs ?? {})}`;
}

function alignChildren(left, right) {
  const n = left.length;
  const m = right.length;
  const lk = left.map(childKey);
  const rk = right.map(childKey);
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        lk[i] === rk[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matches = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (lk[i] === rk[j] && dp[i][j] === dp[i + 1][j + 1] + 1) {
      matches.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return matches;
}

function collectOperations(oldNode, newNode, position, operations) {
  if (!sameMarkup(oldNode, newNode)) {
    operations.push({
      from: position,
      to: position + oldNode.nodeSize,
      nodes: [newNode],
    });
    return;
  }
  if (oldNode.isText) {
    if (oldNode.text !== newNode.text) {
      operations.push({
        from: position,
        to: position + oldNode.nodeSize,
        nodes: [newNode],
      });
    }
    return;
  }
  const oldChildren = [];
  const newChildren = [];
  oldNode.forEach((child) => oldChildren.push(child));
  newNode.forEach((child) => newChildren.push(child));
  if (oldChildren.length === 0 && newChildren.length === 0) return;

  const starts = [];
  const name =
    typeof oldNode.type === "string" ? oldNode.type : oldNode.type.name;
  let offset = name === "doc" ? position : position + 1;
  for (const child of oldChildren) {
    starts.push(offset);
    offset += child.nodeSize;
  }

  const matches = alignChildren(oldChildren, newChildren);
  const sentinel = [oldChildren.length, newChildren.length];
  let oldIndex = 0;
  let newIndex = 0;
  for (const [matchOld, matchNew] of [...matches, sentinel]) {
    if (oldIndex < matchOld || newIndex < matchNew) {
      const from =
        oldIndex < matchOld
          ? starts[oldIndex]
          : matchOld < oldChildren.length
            ? starts[matchOld]
            : offset;
      const to =
        oldIndex < matchOld
          ? starts[matchOld - 1] + oldChildren[matchOld - 1].nodeSize
          : from;
      operations.push({
        from,
        to,
        nodes: newChildren.slice(newIndex, matchNew),
      });
    }
    if (matchOld < oldChildren.length) {
      collectOperations(
        oldChildren[matchOld],
        newChildren[matchNew],
        starts[matchOld],
        operations,
      );
    }
    oldIndex = matchOld + 1;
    newIndex = matchNew + 1;
  }
}

function transformBetween(oldDoc, newDoc) {
  const tr = new r.Transform(oldDoc);
  const operations = [];
  collectOperations(oldDoc, newDoc, 0, operations);
  operations.sort(
    (left, right) => right.from - left.from || right.to - left.to,
  );
  for (const operation of operations) {
    const content =
      operation.nodes.length > 0 ? r.Fragment.fromArray(operation.nodes) : null;
    if (operation.from === operation.to) {
      if (content) tr.insert(operation.from, content);
    } else if (!content) {
      tr.delete(operation.from, operation.to);
    } else {
      tr.replaceWith(operation.from, operation.to, content);
    }
  }
  return tr;
}

function skeleton(node, out = []) {
  const id = node.attrs?.id;
  if (typeof id === "string") out.push(`${node.type.name}:${id}`);
  node.forEach((child) => skeleton(child, out));
  return out;
}

function sameSkeleton(left, right) {
  const a = skeleton(left);
  const b = skeleton(right);
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function locateJson(node, id, parent = null, index = -1) {
  if (!node || typeof node !== "object") return null;
  if (node.attrs?.id === id) return { node, parent, index };
  const content = Array.isArray(node.content) ? node.content : [];
  for (let childIndex = 0; childIndex < content.length; childIndex += 1) {
    const found = locateJson(content[childIndex], id, node, childIndex);
    if (found) return found;
  }
  return null;
}

function parentIdOfNode(document, located) {
  if (located.parent === null || located.parent === document) return null;
  const parentId = located.parent.attrs?.id;
  if (typeof parentId !== "string") throw new Error("HISTORY_UNSUPPORTED");
  return parentId;
}

function nextSiblingIdOf(located) {
  const content = located.parent?.content ?? [];
  const next = content[located.index + 1];
  if (!next) return null;
  const id = next.attrs?.id;
  if (typeof id !== "string") throw new Error("HISTORY_UNSUPPORTED");
  return id;
}

function tableEntryOf(state, tableId) {
  return (
    (state.tables ?? []).find((entry) => entry.tableId === tableId) ?? null
  );
}

function childById(node, id) {
  return (node?.content ?? []).find((child) => child.attrs?.id === id) ?? null;
}

function inlineIsEmpty(node) {
  let empty = true;
  const walk = (current) => {
    if (!current || typeof current !== "object" || !empty) return;
    if (current.type === "text" && (current.text ?? "").length > 0)
      empty = false;
    if (current.type === "hardBreak") empty = false;
    if (Array.isArray(current.content)) current.content.forEach(walk);
  };
  walk(node);
  return empty;
}

export function createHarness({
  document,
  clients = 2,
  incarnationId = DEFAULT_INCARNATION,
} = {}) {
  if (!document || typeof document !== "object" || Array.isArray(document))
    throw new TypeError("document must be a Folio document object");
  if (!Number.isInteger(clients) || clients < 1 || clients > 5)
    throw new RangeError("clients must be a positive integer up to 5");
  if (typeof incarnationId !== "string" || incarnationId.length === 0)
    throw new TypeError("incarnationId must be a non-empty string");
  if (!r.inspectSharedDocument(JSON.stringify(document)).ok)
    throw new Error("INVALID_DOCUMENT");

  let serverState;
  try {
    serverState = semantic.seedTables(
      semantic.initialState(jsonClone(document)),
      incarnationId,
    );
  } catch (error) {
    throw new Error(
      `INVALID_DOCUMENT:${error && error.code ? error.code : String(error)}`,
    );
  }

  const seedNode = r.documentSchema.nodeFromJSON(serverState.document);
  seedNode.check();

  const clientIDs = Array.from({ length: clients }, (_, index) => index + 1);
  let states = clientIDs.map((clientID) =>
    r.EditorState.create({
      doc: seedNode,
      plugins: [
        r.richStructureGuardPlugin(),
        r.history(),
        r.collab({ version: 0, clientID }),
      ],
    }),
  );

  let serverDoc = seedNode;
  let serverVersion = 0;
  const serverSteps = [];
  const serverStepClientIDs = [];
  const queues = clientIDs.map(() => ({ text: [], structure: [] }));
  const rejections = [];
  const appliedTextLog = [];
  const textOrder = clientIDs.map(() => []);
  const textRedoOrder = clientIDs.map(() => []);
  const structureHistory = clientIDs.map(() => []);
  const pendingStructureUndo = clientIDs.map(() => null);
  let sequence = 0;
  let closed = false;
  let syncCalls = 0;
  let syncRounds = 0;
  let acceptedSteps = 0;

  const diagnosticsBase = {
    engine: "C",
    mechanism: "prosemirror-collab+history+semantic-structure",
    clients,
    clientIDs: clientIDs.slice(),
    incarnationId,
  };

  function assertOpen() {
    if (closed) throw new Error("HARNESS_CLOSED");
  }

  function assertIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index >= states.length)
      throw new RangeError(`client index out of range: ${index}`);
  }

  function reject(clientIndex, reason, detail = {}) {
    if (rejections.length >= MAX_REJECTION_RECORDS) return;
    rejections.push({
      clientIndex,
      reason,
      atServerVersion: serverVersion,
      ...detail,
    });
  }

  function normalized(value) {
    const out = jsonClone(r.versionDocument(value));
    if (document.schemaVersion !== undefined)
      out.schemaVersion = document.schemaVersion;
    return out;
  }

  function serverJSON() {
    return normalized(serverDoc.toJSON());
  }

  function findBlockPosition(doc, blockId) {
    let found = null;
    doc.descendants((node, position) => {
      if (found) return false;
      if (node.attrs?.id === blockId) {
        found = { node, position };
        return false;
      }
      return true;
    });
    return found;
  }

  function recordTextOperation(index) {
    sequence += 1;
    textOrder[index].push(sequence);
    textRedoOrder[index].length = 0;
  }

  function captureDeleteBase(index, blockId) {
    const found = locateJson(states[index].doc.toJSON(), blockId);
    if (!found) return null;
    return {
      ownerClientIndex: index,
      signature: stableJson(found.node),
    };
  }

  function rowUndoSafe(entry, current, command) {
    const afterTable = locateJson(entry.after.document, command.tableId)?.node;
    const currentTable = locateJson(current.document, command.tableId)?.node;
    const afterMeta = tableEntryOf(entry.after, command.tableId);
    const currentMeta = tableEntryOf(current, command.tableId);
    if (!afterTable || !currentTable || !afterMeta || !currentMeta)
      throw new Error("HISTORY_CONFLICT");
    const afterRow = childById(afterTable, command.rowId);
    const currentRow = childById(currentTable, command.rowId);
    if (!afterRow || !currentRow) throw new Error("HISTORY_CONFLICT");
    for (let index = 0; index < afterMeta.columnIds.length; index += 1) {
      const columnId = afterMeta.columnIds[index];
      const currentIndex = currentMeta.columnIds.indexOf(columnId);
      if (currentIndex < 0) throw new Error("HISTORY_CONFLICT");
      const afterCell = afterRow.content?.[index];
      const currentCell = currentRow.content?.[currentIndex];
      if (!afterCell || !currentCell) throw new Error("HISTORY_CONFLICT");
      if (stableJson(afterCell) !== stableJson(currentCell))
        throw new Error("HISTORY_CONFLICT");
    }
    return true;
  }

  function columnUndoSafe(entry, current, command) {
    const afterTable = locateJson(entry.after.document, command.tableId)?.node;
    const currentTable = locateJson(current.document, command.tableId)?.node;
    const afterMeta = tableEntryOf(entry.after, command.tableId);
    const currentMeta = tableEntryOf(current, command.tableId);
    if (!afterTable || !currentTable || !afterMeta || !currentMeta)
      throw new Error("HISTORY_CONFLICT");
    const afterIndex = afterMeta.columnIds.indexOf(command.columnId);
    const currentIndex = currentMeta.columnIds.indexOf(command.columnId);
    if (afterIndex < 0 || currentIndex < 0) throw new Error("HISTORY_CONFLICT");
    for (const currentRow of currentTable.content ?? []) {
      const rowId = currentRow.attrs?.id;
      if (typeof rowId !== "string") throw new Error("HISTORY_CONFLICT");
      const currentCell = currentRow.content?.[currentIndex];
      if (!currentCell) throw new Error("HISTORY_CONFLICT");
      const afterRow = childById(afterTable, rowId);
      if (afterRow) {
        const afterCell = afterRow.content?.[afterIndex];
        if (!afterCell || stableJson(afterCell) !== stableJson(currentCell))
          throw new Error("HISTORY_CONFLICT");
      } else if (!inlineIsEmpty(currentCell)) {
        throw new Error("HISTORY_CONFLICT");
      }
    }
    return true;
  }

  function inverseOfStructure(entry, current) {
    const command = entry.command;
    switch (command.kind) {
      case "block.move": {
        const original = locateJson(entry.before.document, command.blockId);
        if (!original) throw new Error("HISTORY_CONFLICT");
        const parentId = parentIdOfNode(entry.before.document, original);
        const beforeId = nextSiblingIdOf(original);
        const target = locateJson(current.document, command.blockId);
        if (!target) throw new Error("HISTORY_CONFLICT");
        const parent =
          parentId === null
            ? current.document
            : locateJson(current.document, parentId)?.node;
        if (!parent) throw new Error("HISTORY_CONFLICT");
        if (beforeId !== null && !childById(parent, beforeId))
          throw new Error("HISTORY_CONFLICT");
        return {
          kind: "block.move",
          blockId: command.blockId,
          parentId,
          beforeId,
        };
      }
      case "block.insert": {
        const id = command.node?.attrs?.id;
        if (typeof id !== "string") throw new Error("HISTORY_UNSUPPORTED");
        const post = locateJson(entry.after.document, id);
        const now = locateJson(current.document, id);
        if (!post || !now) throw new Error("HISTORY_CONFLICT");
        if (stableJson(post.node) !== stableJson(now.node))
          throw new Error("HISTORY_CONFLICT");
        return { kind: "block.delete", blockId: id };
      }
      case "block.replace": {
        const blockId = command.blockId;
        const before = locateJson(entry.before.document, blockId)?.node;
        const after = locateJson(entry.after.document, blockId)?.node;
        const now = locateJson(current.document, blockId)?.node;
        if (!before || !after || !now) throw new Error("HISTORY_CONFLICT");
        if (stableJson(after) !== stableJson(now))
          throw new Error("HISTORY_CONFLICT");
        return {
          kind: "block.replace",
          blockId,
          before: jsonClone(now),
          node: jsonClone(before),
        };
      }
      case "table.row.insert":
        rowUndoSafe(entry, current, command);
        return {
          kind: "table.row.delete",
          tableId: command.tableId,
          rowId: command.rowId,
        };
      case "table.column.insert":
        columnUndoSafe(entry, current, command);
        return {
          kind: "table.column.delete",
          tableId: command.tableId,
          columnId: command.columnId,
        };
      case "block.delete":
      case "table.row.delete":
      case "table.column.delete":
        throw new Error("HISTORY_UNSUPPORTED");
      default:
        throw new Error("HISTORY_UNSUPPORTED");
    }
  }

  function latestStructure(index) {
    const history = structureHistory[index];
    return history.length > 0 ? history[history.length - 1] : null;
  }

  function latestText(index) {
    const order = textOrder[index];
    return order.length > 0 ? order[order.length - 1] : null;
  }

  function insertText(index, blockId, offset, text) {
    assertOpen();
    assertIndex(index);
    if (typeof blockId !== "string" || blockId.length === 0)
      throw new TypeError("blockId must be a non-empty string");
    if (typeof text !== "string" || !semantic.wellFormed(text))
      throw new TypeError("text must be a well-formed string");
    const state = states[index];
    const found = findBlockPosition(state.doc, blockId);
    if (!found) throw new RangeError(`NODE_MISSING:${blockId}`);
    const current = nodeText(found.node);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > current.length)
      throw new RangeError("text offset out of range");
    if (!safeBoundary(current, offset))
      throw new RangeError("text offset splits a surrogate pair");
    const position = found.position + 1 + offset;
    const tr = state.tr.insertText(text, position, position);
    const next = state.apply(tr);
    queues[index].text.push({
      kind: "text",
      blockId,
      from: offset,
      to: offset,
      text,
      before: current,
    });
    states[index] = next;
    recordTextOperation(index);
    return next;
  }

  function deleteText(index, blockId, from, to, replacement = "") {
    assertOpen();
    assertIndex(index);
    if (typeof blockId !== "string" || blockId.length === 0)
      throw new TypeError("blockId must be a non-empty string");
    if (typeof replacement !== "string" || !semantic.wellFormed(replacement))
      throw new TypeError("replacement must be a well-formed string");
    const state = states[index];
    const found = findBlockPosition(state.doc, blockId);
    if (!found) throw new RangeError(`NODE_MISSING:${blockId}`);
    const current = nodeText(found.node);
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      to < from ||
      to > current.length
    )
      throw new RangeError("text range out of bounds");
    if (!safeBoundary(current, from) || !safeBoundary(current, to))
      throw new RangeError("text range splits a surrogate pair");
    const start = found.position + 1 + from;
    const end = found.position + 1 + to;
    const tr = state.tr.delete(start, end);
    if (replacement.length > 0) tr.insertText(replacement, start, start);
    const next = state.apply(tr);
    queues[index].text.push({
      kind: "text",
      blockId,
      from,
      to,
      text: replacement,
      before: current,
    });
    states[index] = next;
    recordTextOperation(index);
    return next;
  }

  function enqueueStructure(index, command, kind, options = {}) {
    assertOpen();
    assertIndex(index);
    if (!command || typeof command !== "object" || Array.isArray(command))
      throw new TypeError("structure command must be an object");
    if (command.kind !== kind) throw new TypeError(`expected ${kind} command`);
    const copy = jsonClone(command);
    sequence += 1;
    queues[index].structure.push({
      command: copy,
      seq: sequence,
      base: options.base ?? null,
      undoOf: options.undoOf ?? null,
    });
    return copy;
  }

  function moveBlock(index, blockId, options = {}) {
    if (typeof blockId !== "string") throw new TypeError("blockId is required");
    const parentId = options.parentId ?? null;
    const beforeId = options.beforeId ?? null;
    if (parentId !== null && typeof parentId !== "string")
      throw new TypeError("parentId must be a string or null");
    if (beforeId !== null && typeof beforeId !== "string")
      throw new TypeError("beforeId must be a string or null");
    return enqueueStructure(
      index,
      { kind: "block.move", blockId, parentId, beforeId },
      "block.move",
    );
  }

  function deleteBlock(index, blockId) {
    if (typeof blockId !== "string") throw new TypeError("blockId is required");
    return enqueueStructure(
      index,
      { kind: "block.delete", blockId },
      "block.delete",
      { base: captureDeleteBase(index, blockId) },
    );
  }

  function insertBlock(index, command) {
    return enqueueStructure(index, command, "block.insert");
  }

  function replaceBlock(index, command) {
    return enqueueStructure(index, command, "block.replace");
  }

  function insertTableRow(index, tableId, rowId, beforeId = null) {
    return enqueueStructure(
      index,
      { kind: "table.row.insert", tableId, rowId, beforeId },
      "table.row.insert",
    );
  }

  function insertTableColumn(index, tableId, columnId, beforeId = null) {
    return enqueueStructure(
      index,
      { kind: "table.column.insert", tableId, columnId, beforeId },
      "table.column.insert",
    );
  }

  function deleteTableRow(index, tableId, rowId) {
    return enqueueStructure(
      index,
      { kind: "table.row.delete", tableId, rowId },
      "table.row.delete",
    );
  }

  function deleteTableColumn(index, tableId, columnId) {
    return enqueueStructure(
      index,
      { kind: "table.column.delete", tableId, columnId },
      "table.column.delete",
    );
  }

  function local(index, fn) {
    assertOpen();
    assertIndex(index);
    if (typeof fn !== "function")
      throw new TypeError("local(index, fn) requires a transaction factory");
    const tr = fn(states[index]);
    if (!tr || !Array.isArray(tr.steps) || !tr.doc)
      throw new TypeError("transaction factory must return a Transaction");
    if (!sameSkeleton(states[index].doc, tr.doc)) {
      throw new Error(
        "RAW_STRUCTURE_UNSUPPORTED: use moveBlock/insertBlock/deleteBlock or table helpers",
      );
    }
    states[index] = states[index].apply(tr);
    if (tr.steps.length > 0) recordTextOperation(index);
    return states[index];
  }

  function catchUp() {
    let progressed = false;
    for (let index = 0; index < states.length; index += 1) {
      const version = r.getVersion(states[index]);
      if (version > serverVersion) {
        reject(index, "CLIENT_AHEAD_OF_SERVER", { clientVersion: version });
        continue;
      }
      if (version === serverVersion) continue;
      const steps = serverSteps.slice(version);
      const ids = serverStepClientIDs.slice(version);
      try {
        states[index] = states[index].apply(
          r.receiveTransaction(states[index], steps, ids),
        );
        progressed = true;
      } catch (error) {
        reject(index, "RECEIVE_FAILED", {
          message: String(error && error.message ? error.message : error),
        });
      }
    }
    return progressed;
  }

  function broadcast(steps, ids) {
    for (let target = 0; target < states.length; target += 1) {
      try {
        states[target] = states[target].apply(
          r.receiveTransaction(states[target], steps, ids),
        );
      } catch (error) {
        reject(target, "BROADCAST_FAILED", {
          message: String(error && error.message ? error.message : error),
        });
      }
    }
  }

  function acceptTextBatch(clientIndex, pending) {
    const steps = pending.steps;
    let nextDoc = serverDoc;
    for (let index = 0; index < steps.length; index += 1) {
      const applied = steps[index].apply(nextDoc);
      if (applied.failed)
        throw new Error(`STEP_FAILED:${applied.failed}:${index}`);
      nextDoc = applied.doc;
    }

    const beforeTexts = collectBlockTexts(serverState.document);
    const afterTexts = collectBlockTexts(nextDoc.toJSON());
    const commands = [];
    for (const blockId of Object.keys(beforeTexts)) {
      const after = afterTexts[blockId];
      if (after === undefined)
        throw new Error(`TEXT_STEP_CHANGED_STRUCTURE:${blockId}`);
      if (after !== beforeTexts[blockId])
        commands.push(textPatch(blockId, beforeTexts[blockId], after));
    }
    for (const blockId of Object.keys(afterTexts)) {
      if (beforeTexts[blockId] === undefined)
        throw new Error(`TEXT_STEP_ADDED_BLOCK:${blockId}`);
    }

    let candidate = jsonClone(serverState);
    const applied = [];
    for (const command of commands) {
      const result = semantic.applyText(candidate, command, []);
      candidate = result.state;
      if (result.appliedText) applied.push(result.appliedText);
    }

    const ids = steps.map(() => pending.clientID);
    serverDoc = nextDoc;
    serverState = candidate;
    serverVersion += steps.length;
    for (let index = 0; index < steps.length; index += 1) {
      serverSteps.push(steps[index]);
      serverStepClientIDs.push(ids[index]);
    }
    acceptedSteps += steps.length;
    for (const text of applied) appliedTextLog.push(text);
    queues[clientIndex].text.length = 0;
    broadcast(steps, ids);
  }

  function acceptStructure(clientIndex) {
    const queued = queues[clientIndex].structure[0];
    const command = queued.command;
    const clearUndoPending = () => {
      if (queued.undoOf) pendingStructureUndo[clientIndex] = null;
    };

    if (queued.undoOf) {
      try {
        const expected = inverseOfStructure(queued.undoOf, serverState);
        if (stableJson(expected) !== stableJson(command))
          throw new Error("HISTORY_CONFLICT");
      } catch (error) {
        queues[clientIndex].structure.shift();
        clearUndoPending();
        reject(clientIndex, "STRUCTURE_UNDO_CONFLICT", {
          command: jsonClone(command),
          message: String(error && error.message ? error.message : error),
        });
        return false;
      }
    }

    if (command.kind === "block.delete" && queued.base) {
      const currentTarget = locateJson(serverState.document, command.blockId);
      if (
        !currentTarget ||
        stableJson(currentTarget.node) !== queued.base.signature
      ) {
        queues[clientIndex].structure.shift();
        clearUndoPending();
        reject(clientIndex, "STALE_TARGET", {
          command: jsonClone(command),
          ownerClientIndex: queued.base.ownerClientIndex,
        });
        return false;
      }
    }

    const beforeState = jsonClone(serverState);
    const isTable =
      typeof command.kind === "string" && command.kind.startsWith("table.");
    let result;
    try {
      result = isTable
        ? semantic.applyTable(serverState, command, incarnationId)
        : semantic.applyBlock(serverState, command);
    } catch (error) {
      queues[clientIndex].structure.shift();
      clearUndoPending();
      reject(
        clientIndex,
        error && error.code ? error.code : "SEMANTIC_REJECTED",
        {
          command: jsonClone(command),
          message: String(error && error.message ? error.message : error),
        },
      );
      return false;
    }

    let nextDoc;
    let tr;
    try {
      nextDoc = r.documentSchema.nodeFromJSON(result.state.document);
      tr =
        command.kind === "block.move"
          ? semantic.applyMoveTransform(
              serverDoc,
              command.blockId,
              command.parentId,
              command.beforeId,
            )
          : transformBetween(serverDoc, nextDoc);
      if (!tr.doc.eq(nextDoc)) throw new Error("STRUCTURE_STEP_MISMATCH");
    } catch (error) {
      queues[clientIndex].structure.shift();
      clearUndoPending();
      reject(clientIndex, "STRUCTURE_STEP_MISMATCH", {
        command: jsonClone(command),
        message: String(error && error.message ? error.message : error),
      });
      return false;
    }

    const steps = tr.steps;
    const ids = steps.map(() => SERVER_CLIENT_ID);
    serverState = result.state;
    serverDoc = tr.doc;
    serverVersion += steps.length;
    for (let index = 0; index < steps.length; index += 1) {
      serverSteps.push(steps[index]);
      serverStepClientIDs.push(ids[index]);
    }
    acceptedSteps += steps.length;
    queues[clientIndex].structure.shift();
    if (queued.undoOf) {
      const history = structureHistory[clientIndex];
      const position = history.indexOf(queued.undoOf);
      if (position >= 0) history.splice(position, 1);
      clearUndoPending();
    } else {
      structureHistory[clientIndex].push({
        seq: queued.seq,
        clientIndex,
        writerClientID: clientIDs[clientIndex],
        command: jsonClone(command),
        before: beforeState,
        after: jsonClone(result.state),
      });
    }
    broadcast(steps, ids);
    return true;
  }

  function sync() {
    assertOpen();
    syncCalls += 1;
    let rounds = 0;
    const blockedText = new Set();
    while (rounds < MAX_SYNC_ROUNDS) {
      rounds += 1;
      syncRounds += 1;
      const caughtUp = catchUp();
      if (caughtUp) continue;

      let textAccepted = false;
      for (let index = 0; index < states.length; index += 1) {
        if (blockedText.has(index)) continue;
        const pending = r.sendableSteps(states[index]);
        if (!pending || pending.steps.length === 0) continue;
        if (pending.version !== serverVersion) {
          blockedText.add(index);
          reject(index, "PENDING_BASE_MISMATCH", {
            pendingVersion: pending.version,
          });
          continue;
        }
        try {
          acceptTextBatch(index, pending);
          textAccepted = true;
        } catch (error) {
          blockedText.add(index);
          reject(index, "TEXT_APPLY_FAILED", {
            message: String(error && error.message ? error.message : error),
          });
        }
        break;
      }
      if (textAccepted) continue;

      let structureHandled = false;
      for (let index = 0; index < states.length; index += 1) {
        if (queues[index].structure.length === 0) continue;
        if (acceptStructure(index)) {
          structureHandled = true;
          break;
        }
        structureHandled = true;
        break;
      }
      if (structureHandled) continue;
      break;
    }
    if (rounds >= MAX_SYNC_ROUNDS) reject(-1, "SYNC_LIMIT");
  }

  function undo(index) {
    assertOpen();
    assertIndex(index);
    if (pendingStructureUndo[index]) return false;

    const structure = latestStructure(index);
    const text = latestText(index);
    if (structure && (text === null || structure.seq > text)) {
      let inverse;
      try {
        inverse = inverseOfStructure(structure, serverState);
      } catch (error) {
        reject(
          index,
          error && error.code ? error.code : "STRUCTURE_UNDO_UNSUPPORTED",
          {
            command: jsonClone(structure.command),
            message: String(error && error.message ? error.message : error),
          },
        );
        return false;
      }
      pendingStructureUndo[index] = structure;
      const options = { undoOf: structure };
      if (inverse.kind === "block.delete") {
        const target = locateJson(serverState.document, inverse.blockId);
        if (target) {
          options.base = {
            ownerClientIndex: index,
            signature: stableJson(target.node),
          };
        }
      }
      try {
        enqueueStructure(index, inverse, inverse.kind, options);
      } catch (error) {
        pendingStructureUndo[index] = null;
        reject(index, "STRUCTURE_UNDO_UNSUPPORTED", {
          command: jsonClone(structure.command),
          message: String(error && error.message ? error.message : error),
        });
        return false;
      }
      return true;
    }

    let dispatched = false;
    const changed = r.undo(states[index], (tr) => {
      states[index] = states[index].apply(tr);
      dispatched = true;
    });
    if (changed && dispatched && textOrder[index].length > 0)
      textRedoOrder[index].push(textOrder[index].pop());
    return Boolean(changed && dispatched);
  }

  function redo(index) {
    assertOpen();
    assertIndex(index);
    if (pendingStructureUndo[index]) return false;
    let dispatched = false;
    const changed = r.redo(states[index], (tr) => {
      states[index] = states[index].apply(tr);
      dispatched = true;
    });
    if (changed && dispatched && textRedoOrder[index].length > 0)
      textOrder[index].push(textRedoOrder[index].pop());
    return Boolean(changed && dispatched);
  }

  function diagnostics() {
    const docs = states.map((state) =>
      JSON.stringify(normalized(state.doc.toJSON())),
    );
    const server = JSON.stringify(serverJSON());
    return jsonClone({
      ...diagnosticsBase,
      syncCalls,
      syncRounds,
      acceptedSteps,
      serverVersion,
      serverStepCount: serverSteps.length,
      rejections: rejections.slice(),
      appliedTextCount: appliedTextLog.length,
      closed,
      converged: docs.every((value) => value === server),
      pending: states.map((state, index) => {
        const pending = r.sendableSteps(state);
        return {
          index,
          version: r.getVersion(state),
          steps: pending ? pending.steps.length : 0,
          rawTextIntents: queues[index].text.length,
          structureIntents: queues[index].structure.length,
        };
      }),
    });
  }

  return {
    state(index) {
      assertOpen();
      assertIndex(index);
      return states[index];
    },
    doc(index) {
      assertOpen();
      assertIndex(index);
      return normalized(states[index].doc.toJSON());
    },
    local,
    insertText,
    deleteText,
    moveBlock,
    insertBlock,
    replaceBlock,
    deleteBlock,
    insertTableRow,
    insertTableColumn,
    deleteTableRow,
    deleteTableColumn,
    sync,
    undo,
    redo,
    close() {
      closed = true;
    },
    serverDoc() {
      assertOpen();
      return serverJSON();
    },
    serverState() {
      assertOpen();
      return jsonClone(serverState);
    },
    diagnostics,
  };
}
