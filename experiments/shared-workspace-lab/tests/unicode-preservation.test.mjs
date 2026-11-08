import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureDoc } from '../src/schema.mjs';
import { runEngineScenario as engineB } from '../src/engine-b.mjs';
import { runEngineScenario as engineC } from '../src/engine-c.mjs';

for (const [name, run] of [['B', engineB], ['C', engineC]]) {
  test(`${name} refuses unpaired UTF-16 in a seed without changing the original`, () => {
    const doc = fixtureDoc(); doc.content[1].content[0].text = 'x\ud800y';
    assert.throws(() => run({ doc }), /Unicode/);
    assert.equal(doc.content[1].content[0].text, 'x\ud800y');
  });
  test(`${name} refuses an unpaired UTF-16 insertion`, () => {
    assert.throws(() => run({ doc: fixtureDoc(), operations: [{ clientId: 'a', blockId: 'p1', offset: 0, text: '\udc00' }] }), /Unicode/);
  });
  test(`${name} refuses an insertion that splits an existing surrogate pair`, () => {
    const doc = fixtureDoc(); doc.content[1].content[0].text = '📝abc';
    assert.throws(() => run({ doc, operations: [{ clientId: 'a', blockId: 'p1', offset: 1, text: 'X' }] }), /Unicode/);
  });
  test(`${name} preserves valid astral Unicode and a boundary insertion`, () => {
    const doc = fixtureDoc(); doc.content[1].content[0].text = '📝abc';
    const result = run({ doc, operations: [{ clientId: 'a', blockId: 'p1', offset: 2, text: '日本語' }] });
    assert.equal(result.converged, true);
    for (const projected of result.documents) {
      assert.equal(projected.content[1].content.map(node => node.text ?? '').join(''), '📝日本語abc');
    }
  });
}
