import test from 'node:test';
import assert from 'node:assert/strict';
import { runEngineScenario } from '../src/engine-b.mjs';
import { schema, fixtureDoc } from '../src/schema.mjs';

function walk(node, visit) {
  visit(node);
  for (const child of node?.content ?? []) walk(child, visit);
}

function findBlock(doc, blockId) {
  let found = null;
  walk(doc, node => {
    if (!found && node?.attrs?.blockId === blockId) found = node;
  });
  return found;
}

function textOf(node) {
  let text = '';
  walk(node, child => {
    if (child.type === 'text' && typeof child.text === 'string') text += child.text;
  });
  return text;
}

function blockIds(doc) {
  const ids = [];
  walk(doc, node => {
    if (node?.attrs?.blockId) ids.push(node.attrs.blockId);
  });
  return ids;
}

function marksIn(doc) {
  const marks = new Set();
  walk(doc, node => {
    for (const mark of node?.marks ?? []) marks.add(mark.type);
  });
  return marks;
}

test('empty operations project both clients to the seeded document', () => {
  const result = runEngineScenario({ doc: fixtureDoc() });
  assert.equal(result.engine, 'B');
  assert.equal(result.durability, 'NOT_MEASURED');
  assert.equal(result.scope, 'restricted-schema-text-insert');
  assert.equal(result.documents.length, 2);
  assert.equal(result.converged, true);
  assert.deepEqual(result.documents[0], result.documents[1]);
  assert.ok(Array.isArray(result.trace));
  for (const projected of result.documents) {
    assert.doesNotThrow(() => schema.nodeFromJSON(projected).check());
    assert.deepEqual(blockIds(projected).sort(), ['cell1', 'h1', 'p1', 'table1']);
    assert.equal(textOf(findBlock(projected, 'p1')), 'abcdef');
    assert.equal(textOf(findBlock(projected, 'h1')), '合成資料');
  }
});

test('boundary inserts in separate blocks converge with exact projected text', () => {
  const result = runEngineScenario({
    doc: fixtureDoc(),
    operations: [
      { clientId: 'a', blockId: 'h1', offset: 0, text: 'PRE' },
      { clientId: 'b', blockId: 'p1', offset: 6, text: 'XYZ' }
    ]
  });
  assert.equal(result.converged, true);
  assert.deepEqual(result.documents[0], result.documents[1]);
  assert.ok(result.trace.length > 0);
  for (const projected of result.documents) {
    assert.equal(textOf(findBlock(projected, 'h1')), 'PRE合成資料');
    assert.equal(textOf(findBlock(projected, 'p1')), 'abcdefXYZ');
  }
});

test('concurrent inserts into one block retain both edits without duplication', () => {
  const result = runEngineScenario({
    doc: fixtureDoc(),
    operations: [
      { clientId: 'a', blockId: 'p1', offset: 0, text: 'AAA' },
      { clientId: 'b', blockId: 'p1', offset: 0, text: 'BBB' }
    ]
  });
  assert.equal(result.converged, true);
  assert.deepEqual(result.documents[0], result.documents[1]);
  for (const projected of result.documents) {
    const text = textOf(findBlock(projected, 'p1'));
    assert.equal(text.includes('AAA'), true);
    assert.equal(text.includes('BBB'), true);
    assert.equal(text.includes('abcdef'), true);
    assert.equal(text.length, 12);
  }
});

test('preserves table structure, marks, and block IDs after edits', () => {
  const result = runEngineScenario({
    doc: fixtureDoc(),
    operations: [
      { clientId: 'a', blockId: 'cell1', offset: 2, text: 'ADD' },
      { clientId: 'b', blockId: 'p1', offset: 3, text: '-' }
    ]
  });
  assert.equal(result.converged, true);
  for (const projected of result.documents) {
    assert.deepEqual(blockIds(projected).sort(), ['cell1', 'h1', 'p1', 'table1']);
    const table = findBlock(projected, 'table1');
    assert.equal(table.type, 'table');
    assert.equal(table.content.length, 1);
    assert.equal(table.content[0].type, 'tableRow');
    assert.equal(table.content[0].content[0].type, 'tableCell');
    assert.equal(textOf(findBlock(projected, 'cell1')), 'セルADD');
    assert.equal(textOf(findBlock(projected, 'h1')), '合成資料');
    assert.equal(marksIn(projected).has('strong'), true);
  }
});

test('rejects malformed and unsupported operations', () => {
  const operations = [
    null,
    'insert',
    { blockId: 'p1', offset: 0, text: 'x' },
    { clientId: 'c', blockId: 'p1', offset: 0, text: 'x' },
    { clientId: 'a', offset: 0, text: 'x' },
    { clientId: 'a', blockId: 'p1', offset: 0 },
    { clientId: 'a', blockId: 'p1', offset: -1, text: 'x' },
    { clientId: 'a', blockId: 'p1', offset: 1.5, text: 'x' },
    { clientId: 'a', blockId: 'p1', offset: '0', text: 'x' },
    { clientId: 'a', blockId: 'p1', offset: 0, text: '' },
    { clientId: 'a', blockId: 'p1', offset: 0, text: 123 },
    { clientId: 'a', blockId: 'p1', offset: 0, text: 'x'.repeat(1001) },
    { clientId: 'a', blockId: 'ghost', offset: 0, text: 'x' }
  ];
  for (const operation of operations) {
    assert.throws(() => runEngineScenario({ doc: fixtureDoc(), operations: [operation] }), Error);
  }
});

test('accepts the documented operation limit and rejects overflow', () => {
  const maxOperations = Array.from({ length: 100 }, () => ({
    clientId: 'a',
    blockId: 'p1',
    offset: 0,
    text: 'x'
  }));
  const result = runEngineScenario({ doc: fixtureDoc(), operations: maxOperations });
  assert.equal(result.converged, true);
  assert.deepEqual(result.documents[0], result.documents[1]);
  assert.equal(textOf(findBlock(result.documents[0], 'p1')).length, 106);

  const overflow = [...maxOperations, { clientId: 'a', blockId: 'p1', offset: 0, text: 'x' }];
  assert.throws(() => runEngineScenario({ doc: fixtureDoc(), operations: overflow }), Error);
});

test('rejects malformed documents', () => {
  const badDocs = [
    undefined,
    null,
    {},
    { type: 'doc' },
    { type: 'doc', content: [] },
    { type: 'doc', content: [{ type: 'notInSchema', attrs: { blockId: 'x' } }] },
    { type: 'doc', content: [], marker: () => {} }
  ];
  for (const doc of badDocs) {
    assert.throws(() => runEngineScenario({ doc }), Error);
  }
});
