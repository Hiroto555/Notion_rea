import test from 'node:test';
import assert from 'node:assert/strict';
import { transitionReceipt } from '../src/receipt.mjs';

test('duplicate accepted confirmations preserve already observed peer application', () => {
  for (const type of ['serverAccepted', 'queryConfirmed']) {
    const result = transitionReceipt({ opId: 'op1', stage: 'peer', serverSeq: 3 }, { opId: 'op1', type, serverSeq: 3 });
    assert.deepEqual(result, { ok: true, receipt: { opId: 'op1', stage: 'peer', serverSeq: 3 } });
  }
});

test('rejection is returned as a rejection rather than wrapped in a successful receipt', () => {
  assert.deepEqual(transitionReceipt(null, { opId: 'op1', type: 'peerApplied', serverSeq: 1 }), { ok: false, code: 'ORDER' });
  assert.deepEqual(transitionReceipt({ opId: 'op1', stage: 'unknown' }, { opId: 'op1', type: 'serverAccepted', serverSeq: 1 }), { ok: false, code: 'ORDER' });
});
