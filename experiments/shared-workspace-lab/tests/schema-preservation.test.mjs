import test from 'node:test';
import assert from 'node:assert/strict';
import { runEngineScenario as engineB } from '../src/engine-b.mjs';
import { runEngineScenario as engineC } from '../src/engine-c.mjs';
import { fixtureDoc } from '../src/schema.mjs';
import { planSharedCopy } from '../src/copy.mjs';

for (const [name, run] of [['B', engineB], ['C', engineC]]) {
  test(`${name} refuses unknown document fields without mutating the original`, () => {
    const doc = fixtureDoc(); doc.unknown = { preserve: '原本' };
    assert.throws(() => run({ doc }), /unsupported/);
    assert.equal(doc.unknown.preserve, '原本');
  });
  test(`${name} refuses unsupported node attributes and mark attributes`, () => {
    const doc = fixtureDoc(); doc.content[1].attrs.unknown = 'keep';
    assert.throws(() => run({ doc }), /unsupported/);
    const other = fixtureDoc(); other.content[1].content[0].marks[0].attrs = { unknown: 'keep' };
    assert.throws(() => run({ doc: other }), /unsupported/);
  });
  test(`${name} refuses missing/duplicate identities instead of independently repairing them`, () => {
    const doc = fixtureDoc(); delete doc.content[1].attrs.blockId;
    assert.throws(() => run({ doc }), /block ID/);
    const other = fixtureDoc(); other.content[1].attrs.blockId = other.content[0].attrs.blockId;
    assert.throws(() => run({ doc: other }), /block ID/);
  });
  test(`${name} refuses a valid paragraph used as the document root`, () => {
    assert.throws(() => run({ doc: fixtureDoc().content[1] }), /root/);
  });
  test(`${name} refuses unsupported operation kinds`, () => {
    assert.throws(() => run({ doc: fixtureDoc(), operations: [{ clientId: 'a', blockId: 'p1', offset: 0, text: 'X', type: 'delete' }] }));
  });
}

test('shared preview rejects malformed selection identities', () => {
  const pages = [{ id: 'p1', parentId: null, title: 'Title', links: [], assets: [] }];
  assert.equal(planSharedCopy({ pages, selectedIds: [42], targetSpaceId: 'space', idMap: {} }).code, 'INVALID');
});
