import test from 'node:test';
import assert from 'node:assert/strict';
import { transitionReceipt } from '../src/receipt.mjs';

const OP = 'op_1';
const cur = (stage, extra = {}) => ({ opId: OP, stage, ...extra });
const evt = (type, extra = {}) => ({ opId: OP, type, ...extra });

function ok(res, stage, seq) {
  assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res)}`);
  assert.equal(res.receipt.opId, OP);
  assert.equal(res.receipt.stage, stage);
  if (seq !== undefined) assert.equal(res.receipt.serverSeq, seq);
  return res.receipt;
}

function bad(res, ...codes) {
  assert.equal(res.ok, false, `expected rejection, got ${JSON.stringify(res)}`);
  if (codes.length) assert.ok(codes.includes(res.code), `expected ${codes.join('/')}, got ${res.code}`);
  return res;
}

test('null starts a draft, so localSaved becomes local but peerApplied is invalid', () => {
  ok(transitionReceipt(null, evt('localSaved')), 'local');
  bad(transitionReceipt(null, evt('peerApplied', { serverSeq: 1 })), 'ORDER');
});

test('localSaved advances draft/local and never downgrades settled stages', () => {
  ok(transitionReceipt(cur('draft'), evt('localSaved')), 'local');
  ok(transitionReceipt(cur('local'), evt('localSaved')), 'local');
  ok(transitionReceipt(cur('server', { serverSeq: 3 }), evt('localSaved')), 'server', 3);
  ok(transitionReceipt(cur('peer', { serverSeq: 3 }), evt('localSaved')), 'peer', 3);
  ok(transitionReceipt(cur('unknown'), evt('localSaved')), 'unknown');
  ok(transitionReceipt(cur('rejected'), evt('localSaved')), 'rejected');
});

test('serverAccepted records server stage and sequence', () => {
  ok(transitionReceipt(cur('draft'), evt('serverAccepted', { serverSeq: 7 })), 'server', 7);
  ok(transitionReceipt(null, evt('serverAccepted', { serverSeq: 8 })), 'server', 8);
  ok(transitionReceipt(cur('server', { serverSeq: 8 }), evt('serverAccepted', { serverSeq: 8 })), 'server', 8);
});

test('queryConfirmed is the only acceptance path for an unknown receipt', () => {
  ok(transitionReceipt(cur('draft'), evt('queryConfirmed', { serverSeq: 2 })), 'server', 2);
  ok(transitionReceipt(cur('unknown'), evt('queryConfirmed', { serverSeq: 9 })), 'server', 9);
  bad(transitionReceipt(cur('unknown'), evt('serverAccepted', { serverSeq: 9 })), 'ORDER');
});

test('peerApplied moves server/peer to peer with the same sequence', () => {
  ok(transitionReceipt(cur('server', { serverSeq: 4 }), evt('peerApplied', { serverSeq: 4 })), 'peer', 4);
  ok(transitionReceipt(cur('peer', { serverSeq: 4 }), evt('peerApplied', { serverSeq: 4 })), 'peer', 4);
});

test('peerApplied is invalid before acceptance or with a different sequence', () => {
  bad(transitionReceipt(cur('draft'), evt('peerApplied', { serverSeq: 4 })), 'ORDER');
  bad(transitionReceipt(cur('local'), evt('peerApplied', { serverSeq: 4 })), 'ORDER');
  bad(transitionReceipt(cur('server', { serverSeq: 4 }), evt('peerApplied', { serverSeq: 5 })), 'ORDER', 'CONFLICT');
});

test('ackLost marks draft/local/unknown unknown and preserves settled stages', () => {
  ok(transitionReceipt(cur('draft'), evt('ackLost')), 'unknown');
  ok(transitionReceipt(cur('local'), evt('ackLost')), 'unknown');
  ok(transitionReceipt(cur('unknown'), evt('ackLost')), 'unknown');
  ok(transitionReceipt(cur('server', { serverSeq: 3 }), evt('ackLost')), 'server', 3);
  ok(transitionReceipt(cur('peer', { serverSeq: 3 }), evt('ackLost')), 'peer', 3);
  ok(transitionReceipt(cur('rejected'), evt('ackLost')), 'rejected');
});

test('rejected marks draft/local/unknown as rejected', () => {
  ok(transitionReceipt(null, evt('rejected')), 'rejected');
  ok(transitionReceipt(cur('draft'), evt('rejected')), 'rejected');
  ok(transitionReceipt(cur('local'), evt('rejected')), 'rejected');
  ok(transitionReceipt(cur('unknown'), evt('rejected')), 'rejected');
});

test('rejected cannot overwrite accepted server or peer receipts', () => {
  bad(transitionReceipt(cur('server', { serverSeq: 5 }), evt('rejected')), 'CONFLICT');
  bad(transitionReceipt(cur('peer', { serverSeq: 5 }), evt('rejected')), 'CONFLICT');
});

test('server/query confirmations reject conflicting accepted sequences', () => {
  ok(transitionReceipt(cur('server', { serverSeq: 5 }), evt('serverAccepted', { serverSeq: 5 })), 'server', 5);
  bad(transitionReceipt(cur('server', { serverSeq: 5 }), evt('serverAccepted', { serverSeq: 6 })), 'CONFLICT');
  ok(transitionReceipt(cur('server', { serverSeq: 5 }), evt('queryConfirmed', { serverSeq: 5 })), 'server', 5);
  bad(transitionReceipt(cur('server', { serverSeq: 5 }), evt('queryConfirmed', { serverSeq: 6 })), 'CONFLICT');
});

test('opId mismatch is an operation error', () => {
  bad(transitionReceipt(cur('draft'), { opId: 'op_2', type: 'localSaved' }), 'OPERATION');
  bad(
    transitionReceipt(cur('server', { serverSeq: 3 }), { opId: 'op_2', type: 'queryConfirmed', serverSeq: 3 }),
    'OPERATION',
  );
});

test('malformed inputs are invalid', () => {
  bad(transitionReceipt(null, null), 'INVALID');
  bad(transitionReceipt(null, {}), 'INVALID');
  bad(transitionReceipt(null, evt('notAnEvent')), 'INVALID');
  bad(transitionReceipt(null, { opId: 'bad id', type: 'localSaved' }), 'INVALID');
  bad(transitionReceipt({ stage: 'draft' }, evt('localSaved')), 'INVALID');
  bad(transitionReceipt({ opId: OP, stage: 'none' }, evt('localSaved')), 'INVALID');
  bad(transitionReceipt('draft', evt('localSaved')), 'INVALID');
});

test('sequence-bearing events reject missing, invalid, or unsafe sequences', () => {
  for (const serverSeq of [undefined, 0, -1, 1.5, '5', Number.MAX_SAFE_INTEGER + 1]) {
    bad(transitionReceipt(cur('draft'), evt('serverAccepted', { serverSeq })), 'INVALID', 'ORDER');
    bad(transitionReceipt(cur('draft'), evt('queryConfirmed', { serverSeq })), 'INVALID', 'ORDER');
  }
  bad(transitionReceipt(cur('server', { serverSeq: 4 }), evt('peerApplied')), 'INVALID', 'ORDER');
  ok(
    transitionReceipt(cur('draft'), evt('serverAccepted', { serverSeq: Number.MAX_SAFE_INTEGER })),
    'server',
    Number.MAX_SAFE_INTEGER,
  );
});

test('inputs are not mutated and the returned receipt is a separate object', () => {
  const current = cur('draft');
  const event = evt('serverAccepted', { serverSeq: 9 });
  const currentCopy = structuredClone(current);
  const eventCopy = structuredClone(event);
  const receipt = ok(transitionReceipt(current, event), 'server', 9);
  assert.deepEqual(current, currentCopy);
  assert.deepEqual(event, eventCopy);
  assert.notEqual(receipt, current);
  assert.notEqual(receipt, event);
  receipt.stage = 'peer';
  assert.equal(current.stage, 'draft');
  assert.equal(event.type, 'serverAccepted');
});

test('frozen inputs are accepted without mutation attempts', () => {
  const current = Object.freeze(cur('local'));
  const event = Object.freeze(evt('serverAccepted', { serverSeq: 11 }));
  ok(transitionReceipt(current, event), 'server', 11);
});
