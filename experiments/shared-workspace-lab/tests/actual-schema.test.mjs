import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Schema } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { collab, receiveTransaction, sendableSteps } from 'prosemirror-collab';
import * as Y from 'yjs';
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror';
import { canonicalJson } from '../src/contracts.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/actual-folio-schema.json', import.meta.url), 'utf8'));
const schema = new Schema(fixture.specs);
const equalJSON = (actual, expected) => assert.equal(canonicalJson(actual), canonicalJson(expected));
function normalizedProjection(value) {
  const parsed = schema.nodeFromJSON(value);
  parsed.check();
  return parsed.toJSON();
}

// This reflects JSON grammar/defaults only. It deliberately does not run Folio editor plugins.
test('reflected Folio JSON schema retains the actual candidate and table/mark identities', () => {
  assert.equal(fixture.sourceCandidate, '0305999fe6ee346f3e7c11a6760d70e193b413aa');
  assert.equal(Object.keys(fixture.specs.nodes).length, 22);
  const doc = schema.nodeFromJSON(fixture.doc); doc.check();
  equalJSON(doc.toJSON(), fixture.doc);
  assert.equal(doc.child(1).attrs.id, 'real-paragraph');
  assert.equal(doc.child(1).firstChild.marks[0].type.name, 'bold');
  assert.equal(doc.child(2).attrs.id, 'real-table');
});

test('Y binding projection roundtrips through the reflected schema with its known defaults', () => {
  const doc = prosemirrorJSONToYDoc(schema, fixture.doc);
  try {
    const raw = yDocToProsemirrorJSON(doc);
    // The binding omits null attrs and emits empty attrs for marks. These are NOT raw byte preservation.
    equalJSON(normalizedProjection(raw), fixture.doc);
    assert.equal(raw.content[2].content[0].content[0].attrs.colwidth, undefined);
    assert.equal(normalizedProjection(raw).content[2].content[0].content[0].attrs.colwidth, null);
  }
  finally { doc.destroy(); }
});

function textFor(doc, id) {
  let found;
  doc.descendants((node, pos) => { if (node.attrs.id === id) found = { node, pos }; });
  return found;
}
function findXml(element, id) {
  if (element instanceof Y.XmlElement && element.getAttribute('id') === id) return element;
  for (const child of element.toArray?.() ?? []) { const found = findXml(child, id); if (found) return found; }
  return null;
}

test('Y clones from one real-schema seed retain both edits under reverse duplicate delivery', () => {
  const seed = prosemirrorJSONToYDoc(schema, fixture.doc);
  const a = new Y.Doc(), b = new Y.Doc();
  try {
    const initial = Y.encodeStateAsUpdate(seed);
    Y.applyUpdate(a, initial); Y.applyUpdate(b, initial);
    findXml(a.getXmlFragment('prosemirror'), 'real-paragraph').get(0).insert(2, 'A');
    findXml(b.getXmlFragment('prosemirror'), 'real-paragraph').get(0).insert(2, 'B');
    const ua = Y.encodeStateAsUpdate(a), ub = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(a, ub); Y.applyUpdate(b, ua); Y.applyUpdate(a, ub); Y.applyUpdate(b, ua);
    const ja = yDocToProsemirrorJSON(a), jb = yDocToProsemirrorJSON(b);
    assert.deepEqual(ja, jb);
    const parsed = schema.nodeFromJSON(ja); parsed.check();
    const text = textFor(parsed, 'real-paragraph').node.textContent;
    assert.equal(text.replace(/[AB]/g, ''), '共同編集abcdef');
    assert.equal((text.match(/A/g) ?? []).length, 1);
    assert.equal((text.match(/B/g) ?? []).length, 1);
    equalJSON(normalizedProjection(ja).content[2], fixture.doc.content[2]);
  } finally { seed.destroy(); a.destroy(); b.destroy(); }
});

test('PM collab rebases concurrent text in the real reflected schema without replacing the table', () => {
  const states = Object.fromEntries(['a', 'b'].map(id => [id, EditorState.create({
    doc: schema.nodeFromJSON(fixture.doc), plugins: [collab({ version: 0, clientID: id })],
  })]));
  for (const id of ['a', 'b']) {
    const target = textFor(states[id].doc, 'real-paragraph');
    states[id] = states[id].apply(states[id].tr.insertText(id.toUpperCase(), target.pos + 3));
  }
  let version = 0;
  for (const id of ['a', 'b']) {
    const pending = sendableSteps(states[id]);
    assert.equal(pending.version, version);
    for (const peer of ['a', 'b']) states[peer] = states[peer].apply(receiveTransaction(states[peer], pending.steps, pending.steps.map(() => pending.clientID)));
    version += pending.steps.length;
  }
  assert.deepEqual(states.a.doc.toJSON(), states.b.doc.toJSON());
  const text = textFor(states.a.doc, 'real-paragraph').node.textContent;
  assert.equal(text.replace(/[AB]/g, ''), '共同編集abcdef');
  assert.equal((text.match(/A/g) ?? []).length, 1);
  assert.equal((text.match(/B/g) ?? []).length, 1);
  equalJSON(states.a.doc.toJSON().content[2], fixture.doc.content[2]);
});
