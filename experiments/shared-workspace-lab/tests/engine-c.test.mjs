import test from 'node:test';
import assert from 'node:assert/strict';
import { runEngineScenario } from '../src/engine-c.mjs';

const fixtureDoc = () => ({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { blockId: 'h1', level: 2 }, content: [{ type: 'text', text: '合成資料' }] },
    { type: 'paragraph', attrs: { blockId: 'p1' }, content: [{ type: 'text', text: 'abcdef', marks: [{ type: 'strong' }] }] },
    { type: 'table', attrs: { blockId: 'table1' }, content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', attrs: { blockId: 'cell1' }, content: [{ type: 'text', text: 'セル' }] }] }] }] }
  ]
});
const clone = value => JSON.parse(JSON.stringify(value));
const count = (text, part) => text.split(part).length - 1;
function walk(node, visit) {
  visit(node);
  for (const child of node.content ?? []) walk(child, visit);
}
function blocks(doc) {
  const found = new Map();
  walk(doc, node => {
    if (node.attrs?.blockId) found.set(node.attrs.blockId, node);
  });
  return found;
}
function textOf(node) {
  return (node.content ?? []).map(child => child.type === 'text' ? child.text : textOf(child)).join('');
}
function segments(node) {
  const found = [];
  walk(node, child => {
    if (child.type === 'text') found.push({ text: child.text, marks: child.marks ?? [] });
  });
  return found;
}
function overlap(node, text, check) {
  const parts = segments(node);
  const joined = parts.map(part => part.text).join('');
  const start = joined.indexOf(text);
  assert.notEqual(start, -1, `missing text ${text}`);
  let offset = 0;
  for (const part of parts) {
    const end = offset + part.text.length;
    if (end > start && offset < start + text.length) check(part);
    offset = end;
  }
}
function assertResult(result) {
  assert.equal(result.engine, 'C');
  assert.equal(result.durability, 'NOT_MEASURED');
  assert.equal(result.scope, 'restricted-schema-text-insert');
  assert.equal(result.converged, true);
  assert.ok(Array.isArray(result.documents));
  assert.equal(result.documents.length, 2);
  assert.deepEqual(result.documents[0], result.documents[1]);
  return result.documents[0];
}
function assertFixture(doc) {
  const map = blocks(doc);
  for (const id of ['h1', 'p1', 'table1', 'cell1']) assert.ok(map.has(id), id);
  assert.equal(textOf(map.get('h1')), '合成資料');
  assert.equal(textOf(map.get('p1')), 'abcdef');
  assert.equal(textOf(map.get('cell1')), 'セル');
  overlap(map.get('p1'), 'abcdef', part => assert.ok(part.marks.some(mark => mark.type === 'strong')));
  const table = map.get('table1');
  assert.deepEqual([table.type, table.content.length, table.content[0].type, table.content[0].content[0].type], ['table', 1, 'tableRow', 'tableCell']);
}
test('no operations returns two equal copies of the input document', () => {
  const doc = fixtureDoc();
  const before = clone(doc);
  const result = runEngineScenario({ doc });
  const out = assertResult(result);
  assertFixture(out);
  assert.deepEqual(doc, before);
  assert.ok(Array.isArray(result.trace));
});
test('single insertion at offset zero applies at block start and preserves marks and IDs', () => {
  const doc = fixtureDoc();
  const text = 'x'.repeat(1000);
  const result = runEngineScenario({ doc, operations: [{ clientId: 'a', blockId: 'p1', offset: 0, text }] });
  const out = assertResult(result);
  assert.ok(Array.isArray(result.trace) && result.trace.length > 0);
  const map = blocks(out);
  for (const id of ['h1', 'p1', 'table1', 'cell1']) assert.ok(map.has(id), id);
  const paragraph = map.get('p1');
  assert.equal(textOf(paragraph), text + 'abcdef');
  overlap(paragraph, 'abcdef', part => assert.ok(part.marks.some(mark => mark.type === 'strong')));
  assert.deepEqual(doc, fixtureDoc());
});
test('concurrent inserts at the same offset are both retained without a fixed order', () => {
  const doc = fixtureDoc();
  const operations = [
    { clientId: 'a', blockId: 'p1', offset: 0, text: 'AAA' },
    { clientId: 'b', blockId: 'p1', offset: 0, text: 'BBB' }
  ];
  const before = clone(operations);
  const result = runEngineScenario({ doc, operations });
  const out = assertResult(result);
  assert.ok(Array.isArray(result.trace) && result.trace.length > 0);
  const paragraph = blocks(out).get('p1');
  const text = textOf(paragraph);
  assert.equal(text.length, 12);
  assert.equal(count(text, 'AAA'), 1);
  assert.equal(count(text, 'BBB'), 1);
  assert.equal(count(text, 'abcdef'), 1);
  overlap(paragraph, 'abcdef', part => assert.ok(part.marks.some(mark => mark.type === 'strong')));
  assert.deepEqual(operations, before);
  assert.deepEqual(doc, fixtureDoc());
});
test('concurrent edits across heading and table cell preserve table structure and IDs', () => {
  const doc = fixtureDoc();
  const result = runEngineScenario({
    doc,
    operations: [
      { clientId: 'a', blockId: 'h1', offset: 4, text: 'A' },
      { clientId: 'b', blockId: 'cell1', offset: 0, text: 'B' }
    ]
  });
  const out = assertResult(result);
  const map = blocks(out);
  for (const id of ['h1', 'p1', 'table1', 'cell1']) assert.ok(map.has(id), id);
  assert.equal(textOf(map.get('h1')), '合成資料A');
  assert.equal(textOf(map.get('p1')), 'abcdef');
  assert.equal(textOf(map.get('cell1')), 'Bセル');
  const table = map.get('table1');
  assert.deepEqual([table.type, table.content.length, table.content[0].type, table.content[0].content[0].type], ['table', 1, 'tableRow', 'tableCell']);
  assert.equal(textOf(table), 'Bセル');
  assert.equal(count(textOf(table), 'B'), 1);
  assert.equal(count(textOf(table), 'セル'), 1);
});
test('preserves link mark attributes while retaining concurrent insertions', () => {
  const doc = {
    type: 'doc',
    content: [{
      type: 'paragraph',
      attrs: { blockId: 'p1' },
      content: [{
        type: 'text',
        text: 'hello',
        marks: [{ type: 'strong' }, { type: 'link', attrs: { href: 'https://example.test/a' } }]
      }]
    }]
  };
  const before = clone(doc);
  const result = runEngineScenario({
    doc,
    operations: [
      { clientId: 'a', blockId: 'p1', offset: 0, text: 'X' },
      { clientId: 'b', blockId: 'p1', offset: 5, text: 'Y' }
    ]
  });
  const out = assertResult(result);
  const paragraph = blocks(out).get('p1');
  const text = textOf(paragraph);
  assert.equal(text.length, 7);
  assert.equal(count(text, 'X'), 1);
  assert.equal(count(text, 'Y'), 1);
  assert.equal(count(text, 'hello'), 1);
  overlap(paragraph, 'hello', part => {
    assert.ok(part.marks.some(mark => mark.type === 'strong'));
    const link = part.marks.find(mark => mark.type === 'link');
    assert.ok(link);
    assert.equal(link.attrs.href, 'https://example.test/a');
  });
  assert.deepEqual(doc, before);
});
test('accepts exactly the maximum number of operations', () => {
  const operations = Array.from({ length: 100 }, () => ({ clientId: 'a', blockId: 'p1', offset: 6, text: 'z' }));
  const result = runEngineScenario({ doc: fixtureDoc(), operations });
  const out = assertResult(result);
  assert.ok(Array.isArray(result.trace) && result.trace.length > 0);
  const text = textOf(blocks(out).get('p1'));
  assert.equal(text.length, 106);
  assert.equal(count(text, 'z'), 100);
  assert.equal(count(text, 'abcdef'), 1);
});
test('rejects malformed operations before applying them', () => {
  const base = { clientId: 'a', blockId: 'p1', offset: 0, text: 'X' };
  const cases = [
    { ...base, clientId: 'c' },
    { ...base, clientId: undefined },
    { ...base, offset: -1 },
    { ...base, offset: 1.5 },
    { ...base, offset: '1' },
    { ...base, offset: undefined },
    { ...base, text: '' },
    { ...base, text: null },
    { ...base, text: 'x'.repeat(1001) },
    { ...base, blockId: undefined },
    { ...base, blockId: '' },
    { ...base, blockId: 42 },
    { ...base, blockId: 'missing' }
  ];
  for (const operation of cases) {
    assert.throws(() => runEngineScenario({ doc: fixtureDoc(), operations: [operation] }), Error);
  }
});
test('rejects invalid documents, non-array operations, and oversized batches', () => {
  const invalidDocs = [
    { type: 'doc', content: [{ type: 'unknownBlock', attrs: { blockId: 'x' } }] },
    { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: 'p1' }, content: [{ type: 'text', text: 'x', marks: [{ type: 'bogus' }] }] }] },
    { type: 'doc', content: [{ type: 'heading', attrs: { blockId: 'h1', level: Number.MAX_SAFE_INTEGER + 1 }, content: [{ type: 'text', text: 'x' }] }] },
    { type: 'doc', content: [] },
    null
  ];
  for (const doc of invalidDocs) {
    assert.throws(() => runEngineScenario({ doc }), Error);
  }
  assert.throws(() => runEngineScenario({ doc: fixtureDoc(), operations: {} }), Error);
  const oversized = Array.from({ length: 101 }, () => ({ clientId: 'a', blockId: 'p1', offset: 6, text: 'z' }));
  assert.throws(() => runEngineScenario({ doc: fixtureDoc(), operations: oversized }), Error);
});
