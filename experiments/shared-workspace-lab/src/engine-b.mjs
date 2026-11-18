import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror';
import { schema, assertFixtureDocument } from './schema.mjs';
import { isId, canonicalJson, cloneJson, assertUnicodeText } from './contracts.mjs';

const MAX_OPERATIONS = 100;
const MAX_TEXT_LENGTH = 1000;
const XML_FRAGMENT = 'prosemirror';
const OPERATION_KEYS = new Set(['clientId', 'blockId', 'offset', 'text', 'type']);

function fail(code, detail) {
  throw new Error(detail === undefined ? code : `${code}: ${detail}`);
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateDoc(doc) {
  assertFixtureDocument(doc);
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    fail('INVALID_DOC', 'doc must be an object');
  }
  try {
    canonicalJson(doc);
  } catch (error) {
    fail('INVALID_DOC', error.message);
  }
  let node;
  try {
    node = schema.nodeFromJSON(doc);
    node.check();
  } catch (error) {
    fail('INVALID_DOC', error.message);
  }
  if (node.type !== schema.nodes.doc) fail('INVALID_DOC', 'root must be a doc node');
  return node;
}

function validateOperations(operations) {
  if (!Array.isArray(operations)) fail('INVALID_OPERATIONS', 'operations must be an array');
  if (operations.length > MAX_OPERATIONS) fail('INVALID_OPERATIONS', 'too many operations');
  return Array.from(operations, (operation, index) => {
    if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) {
      fail('INVALID_OPERATION', `#${index}`);
    }
    try {
      canonicalJson(operation);
    } catch (error) {
      fail('INVALID_OPERATION', `#${index} ${error.message}`);
    }
    for (const key of Object.keys(operation)) {
      if (!OPERATION_KEYS.has(key)) fail('UNSUPPORTED_OPERATION', `#${index} key ${key}`);
    }
    if ('type' in operation && operation.type !== 'insert') {
      fail('UNSUPPORTED_OPERATION', `#${index} type ${operation.type}`);
    }
    if (operation.clientId !== 'a' && operation.clientId !== 'b') {
      fail('INVALID_CLIENT', `#${index}`);
    }
    if (!isId(operation.blockId)) fail('INVALID_BLOCK', `#${index}`);
    if (!Number.isInteger(operation.offset) || operation.offset < 0) {
      fail('INVALID_OFFSET', `#${index}`);
    }
    if (typeof operation.text !== 'string' || operation.text.length === 0) {
      fail('INVALID_TEXT', `#${index}`);
    }
    if (operation.text.length > MAX_TEXT_LENGTH) fail('INVALID_TEXT', `#${index} too long`);
    assertUnicodeText(operation.text);
    return {
      clientId: operation.clientId,
      blockId: operation.blockId,
      offset: operation.offset,
      text: operation.text
    };
  });
}

function buildBlockMap(doc) {
  const map = new Map();
  const visit = (value) => {
    if (!(value instanceof Y.XmlElement)) return;
    const blockId = value.getAttribute('blockId');
    if (typeof blockId === 'string' && (value.nodeName === 'paragraph' || value.nodeName === 'heading')) {
      if (!map.has(blockId)) map.set(blockId, value);
    }
    for (const child of value.toArray()) visit(child);
  };
  for (const child of doc.getXmlFragment(XML_FRAGMENT).toArray()) visit(child);
  return map;
}

function insertIntoBlock(block, offset, text) {
  if (!(block instanceof Y.XmlElement)) fail('INVALID_BLOCK');
  const textNodes = block.toArray().filter((child) => child instanceof Y.XmlText);
  if (textNodes.length === 0) {
    if (offset !== 0) fail('INVALID_OFFSET', 'offset beyond block text');
    const xmlText = new Y.XmlText();
    block.insert(0, [xmlText]);
    xmlText.insert(0, text);
    return;
  }
  let remaining = offset;
  for (const xmlText of textNodes) {
    if (remaining <= xmlText.length) {
      const original = xmlText.toDelta().map(part => {
        if (typeof part.insert !== 'string') fail('UNSUPPORTED_TEXT');
        return part.insert;
      }).join('');
      assertUnicodeText(original.slice(0, remaining));
      assertUnicodeText(original.slice(remaining));
      xmlText.insert(remaining, text);
      return;
    }
    remaining -= xmlText.length;
  }
  fail('INVALID_OFFSET', 'offset beyond block text');
}

export function runEngineScenario({ doc, operations = [] } = {}) {
  validateDoc(doc);
  const validatedOperations = validateOperations(operations);
  const docs = [];
  try {
    const seed = prosemirrorJSONToYDoc(schema, cloneJson(doc), XML_FRAGMENT);
    docs.push(seed);
    const seedBlocks = buildBlockMap(seed);
    for (const operation of validatedOperations) {
      if (!seedBlocks.has(operation.blockId)) fail('INVALID_BLOCK', operation.blockId);
    }
    const initial = Y.encodeStateAsUpdate(seed);
    const docA = new Y.Doc();
    docs.push(docA);
    const docB = new Y.Doc();
    docs.push(docB);
    Y.applyUpdate(docA, initial);
    Y.applyUpdate(docB, initial);
    const blocksA = buildBlockMap(docA);
    const blocksB = buildBlockMap(docB);
    const trace = [
      {
        phase: 'seed',
        fragment: XML_FRAGMENT,
        bytes: initial.byteLength,
        hash: hashBytes(initial)
      },
      { phase: 'clone', clientId: 'a', bytes: initial.byteLength, hash: hashBytes(initial) },
      { phase: 'clone', clientId: 'b', bytes: initial.byteLength, hash: hashBytes(initial) }
    ];
    const updates = [];
    validatedOperations.forEach((operation, index) => {
      const clientDoc = operation.clientId === 'a' ? docA : docB;
      const clientBlocks = operation.clientId === 'a' ? blocksA : blocksB;
      const block = clientBlocks.get(operation.blockId);
      if (!block) fail('INVALID_BLOCK', operation.blockId);
      const before = Y.encodeStateVector(clientDoc);
      insertIntoBlock(block, operation.offset, operation.text);
      assertFixtureDocument(yDocToProsemirrorJSON(clientDoc, XML_FRAGMENT));
      const update = Y.encodeStateAsUpdate(clientDoc, before);
      updates.push({ clientId: operation.clientId, index, update });
      trace.push({
        phase: 'local-insert',
        clientId: operation.clientId,
        blockId: operation.blockId,
        offset: operation.offset,
        textLength: operation.text.length,
        updateBytes: update.byteLength,
        updateHash: hashBytes(update),
        operationIndex: index
      });
    });
    const deliveries = updates.slice().reverse();
    for (const item of deliveries) {
      const from = item.clientId;
      const to = from === 'a' ? 'b' : 'a';
      const targetDoc = to === 'a' ? docA : docB;
      for (let copy = 0; copy < 2; copy += 1) {
        Y.applyUpdate(targetDoc, item.update, 'remote');
        trace.push({
          phase: 'delivery',
          from,
          to,
          operationIndex: item.index,
          duplicate: copy === 1,
          updateHash: hashBytes(item.update)
        });
      }
    }
    const docAJSON = yDocToProsemirrorJSON(docA, XML_FRAGMENT);
    const docBJSON = yDocToProsemirrorJSON(docB, XML_FRAGMENT);
    const converged = canonicalJson(docAJSON) === canonicalJson(docBJSON);
    trace.push({ phase: 'projection', clientId: 'a', converged });
    trace.push({ phase: 'projection', clientId: 'b', converged });
    return {
      engine: 'B',
      documents: [docAJSON, docBJSON],
      converged,
      durability: 'NOT_MEASURED',
      scope: 'restricted-schema-text-insert',
      trace
    };
  } finally {
    for (const item of docs) {
      try {
        item.destroy();
      } catch {}
    }
  }
}
