import { EditorState } from 'prosemirror-state';
import { collab, receiveTransaction, sendableSteps } from 'prosemirror-collab';
import { Step } from 'prosemirror-transform';
import { schema, assertFixtureDocument } from './schema.mjs';
import { canonicalJson, cloneJson, isId, assertUnicodeText } from './contracts.mjs';

const CLIENT_IDS = ['a', 'b'];
const MAX_OPERATIONS = 100;
const MAX_TEXT_LENGTH = 1000;

function findBlock(doc, blockId) {
  let found = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.attrs && node.attrs.blockId === blockId) {
      found = { node, pos };
      return false;
    }
    return undefined;
  });
  return found;
}

function validateInput(doc, operations) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('INVALID_DOC');
  canonicalJson(doc);
  let baseDoc;
  try {
    baseDoc = schema.nodeFromJSON(doc);
    baseDoc.check();
  } catch {
    throw new Error('INVALID_SCHEMA');
  }
  if (baseDoc.type !== schema.nodes.doc) throw new Error('INVALID_SCHEMA');
  if (!Array.isArray(operations)) throw new Error('INVALID_OPERATIONS');
  if (operations.length > MAX_OPERATIONS) throw new Error('TOO_MANY_OPERATIONS');
  canonicalJson(operations);
  for (const operation of operations) {
    if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) throw new Error('INVALID_OPERATION');
    if (!CLIENT_IDS.includes(operation.clientId)) throw new Error('INVALID_CLIENT');
    if (!isId(operation.blockId)) throw new Error('INVALID_BLOCK_ID');
    if (!Number.isSafeInteger(operation.offset) || operation.offset < 0) throw new Error('INVALID_OFFSET');
    if (typeof operation.text !== 'string' || operation.text.length < 1 || operation.text.length > MAX_TEXT_LENGTH) throw new Error('INVALID_TEXT');
    assertUnicodeText(operation.text);
    const found = findBlock(baseDoc, operation.blockId);
    if (!found) throw new Error('MISSING_BLOCK');
    if (!found.node.isTextblock) throw new Error('UNSUPPORTED_BLOCK');
  }
  return baseDoc;
}

function applyOperation(state, operation) {
  const found = findBlock(state.doc, operation.blockId);
  if (!found) throw new Error('MISSING_BLOCK');
  if (!found.node.isTextblock) throw new Error('UNSUPPORTED_BLOCK');
  if (operation.offset > found.node.content.size) throw new Error('INVALID_OFFSET');
  const position = found.pos + 1 + operation.offset;
  const next = state.apply(state.tr.insertText(operation.text, position));
  assertFixtureDocument(next.doc.toJSON());
  return next;
}

function applyServerSteps(doc, steps) {
  let next = doc;
  for (const step of steps) {
    const result = step.apply(next);
    if (result.failed) throw new Error(`SERVER_STEP_FAILED:${result.failed}`);
    next = result.doc;
  }
  return next;
}

export function runEngineScenario({ doc, operations = [] } = {}) {
  assertFixtureDocument(doc);
  for (const operation of Array.isArray(operations) ? operations : []) {
    if (!operation || Object.keys(operation).some(key => !['clientId','blockId','offset','text','type'].includes(key)) ||
      (operation.type !== undefined && operation.type !== 'insert')) throw new TypeError('unsupported operation');
  }
  validateInput(doc, operations);
  const states = {
    a: EditorState.create({ doc: schema.nodeFromJSON(cloneJson(doc)), plugins: [collab({ version: 0, clientID: 'a' })] }),
    b: EditorState.create({ doc: schema.nodeFromJSON(cloneJson(doc)), plugins: [collab({ version: 0, clientID: 'b' })] }),
  };
  const trace = [{ phase: 'start', serverVersion: 0, operationCount: operations.length }];
  for (const operation of operations) {
    states[operation.clientId] = applyOperation(states[operation.clientId], operation);
    trace.push({ phase: 'local', clientId: operation.clientId, blockId: operation.blockId, offset: operation.offset, textLength: operation.text.length });
  }
  let serverDoc = schema.nodeFromJSON(cloneJson(doc));
  let serverVersion = 0;
  for (const clientId of CLIENT_IDS) {
    const pending = sendableSteps(states[clientId]);
    if (!pending) continue;
    if (pending.version !== serverVersion) throw new Error(`VERSION_MISMATCH:${pending.version}:${serverVersion}`);
    const steps = pending.steps.map(step => Step.fromJSON(schema, step.toJSON()));
    serverDoc = applyServerSteps(serverDoc, steps);
    const clientIDs = steps.map(() => pending.clientID);
    for (const id of CLIENT_IDS) {
      states[id] = states[id].apply(receiveTransaction(states[id], steps, clientIDs));
    }
    serverVersion += steps.length;
    trace.push({ phase: 'sync', clientId, version: pending.version, stepCount: steps.length, serverVersion, stepTypes: steps.map(step => step.toJSON().stepType) });
  }
  const documents = [states.a.doc.toJSON(), states.b.doc.toJSON()];
  const converged = canonicalJson(documents[0]) === canonicalJson(documents[1]);
  return {
    engine: 'C',
    documents,
    converged,
    durability: 'NOT_MEASURED',
    scope: 'restricted-schema-text-insert',
    trace,
    serverDocument: serverDoc.toJSON(),
  };
}
