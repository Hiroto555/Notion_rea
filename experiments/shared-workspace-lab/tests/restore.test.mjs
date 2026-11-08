import test from 'node:test';
import assert from 'node:assert/strict';
import { planRestore } from '../src/restore.mjs';

const HASH = 'a'.repeat(64);
const FORMAT = 'folio-shared-lab-backup/1';

function make(over = {}) {
  const { backup, ...rest } = over;
  return {
    backup: { format: FORMAT, orgId: 'orgMain1', spaceId: 'spaceMain1', epoch: 'epochBackup1', sequence: 7, hash: HASH, ...backup },
    currentEpoch: 'epochCurrent1',
    expectedOrgId: 'orgMain1',
    expectedSpaceId: 'spaceMain1',
    newEpoch: 'epochNew1',
    pendingOperations: [],
    ...rest,
  };
}

function rejected(result, code = 'INVALID') {
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
}

test('plans restore metadata for valid input', () => {
  const result = planRestore(make());
  assert.equal(result.ok, true);
  const { plan } = result;
  assert.equal(plan.orgId, 'orgMain1');
  assert.equal(plan.spaceId, 'spaceMain1');
  assert.equal(plan.newEpoch, 'epochNew1');
  assert.equal(plan.backupSequence, 7);
  assert.equal(plan.serverOutcome, 'UNKNOWN');
  assert.deepEqual(plan.preservedOperationIds, []);
  assert.equal(plan.autoResend, false);
  assert.equal(plan.requiresReauthorization, true);
});

test('preserves every pending operation id exactly once', () => {
  const ops = [
    { opId: 'opAlpha1', epoch: 'epochPending1' },
    { opId: 'opBeta2', epoch: 'epochPending2' },
    { opId: 'opGamma3', epoch: 'epochPending3' },
  ];
  const result = planRestore(make({ pendingOperations: ops }));
  assert.equal(result.ok, true);
  const ids = result.plan.preservedOperationIds;
  assert.equal(ids.length, ops.length);
  assert.deepEqual([...ids].sort(), ops.map(op => op.opId).sort());
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
});

test('accepts sequence boundaries 0 and max safe integer', () => {
  for (const sequence of [0, Number.MAX_SAFE_INTEGER]) {
    const result = planRestore(make({ backup: { sequence } }));
    assert.equal(result.ok, true);
    assert.equal(result.plan.backupSequence, sequence);
  }
});

test('does not verify backup integrity or claim acknowledgement', () => {
  const result = planRestore(make({ backup: { hash: '0'.repeat(64) } }));
  assert.equal(result.ok, true);
  assert.equal(result.plan.serverOutcome, 'UNKNOWN');
  assert.equal(result.plan.autoResend, false);
  assert.equal(result.plan.requiresReauthorization, true);
});

test('preserves caller inputs and old pending epochs', () => {
  const ops = [
    { opId: 'opAlpha1', epoch: 'epochPending1' },
    { opId: 'opBeta2', epoch: 'epochPending2' },
  ];
  const input = make({ pendingOperations: ops });
  const snapshot = JSON.parse(JSON.stringify(input));
  const result = planRestore(input);
  assert.equal(result.ok, true);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(input.pendingOperations.map(op => op.epoch), ['epochPending1', 'epochPending2']);
  assert.ok(result.plan.preservedOperationIds.every(id => ops.some(op => op.opId === id)));
});

test('rejects organization scope mismatch', () => {
  rejected(planRestore(make({ expectedOrgId: 'orgOther1' })), 'SCOPE');
});

test('rejects space scope mismatch', () => {
  rejected(planRestore(make({ expectedSpaceId: 'spaceOther1' })), 'SCOPE');
});

test('rejects unsupported or missing backup format', () => {
  rejected(planRestore(make({ backup: { format: 'folio-shared-lab-backup/2' } })));
  rejected(planRestore(make({ backup: { format: undefined } })));
});

test('rejects invalid backup organization, space, or epoch ids', () => {
  for (const field of ['orgId', 'spaceId', 'epoch']) {
    for (const value of ['', '-bad', 'has space', 'x'.repeat(81)]) {
      rejected(planRestore(make({ backup: { [field]: value } })));
    }
  }
});

test('rejects malformed backup hashes', () => {
  for (const hash of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63) + 'Z']) {
    rejected(planRestore(make({ backup: { hash } })));
  }
});

test('rejects invalid backup sequences', () => {
  for (const sequence of [-1, 1.5, 2 ** 53, '7', null, Number.NaN]) {
    rejected(planRestore(make({ backup: { sequence } })));
  }
});

test('rejects invalid epoch identifiers', () => {
  for (const value of ['', '-bad', 'has space', 42, null]) {
    rejected(planRestore(make({ currentEpoch: value })));
    rejected(planRestore(make({ newEpoch: value })));
  }
});

test('rejects a new epoch equal to current or backup epoch', () => {
  rejected(planRestore(make({ newEpoch: 'epochCurrent1' })));
  rejected(planRestore(make({ newEpoch: 'epochBackup1' })));
});

test('rejects malformed pending operation collections', () => {
  for (const pendingOperations of [null, {}, 'ops', [null], ['op'], [{ opId: 'opAlpha1' }], [{ epoch: 'epochPending1' }]]) {
    rejected(planRestore(make({ pendingOperations })));
  }
});

test('rejects duplicate pending operation ids', () => {
  rejected(planRestore(make({ pendingOperations: [
    { opId: 'opAlpha1', epoch: 'epochPending1' },
    { opId: 'opAlpha1', epoch: 'epochPending2' },
  ] })));
  rejected(planRestore(make({ pendingOperations: [
    { opId: 'opAlpha1', epoch: 'epochPending1' },
    { opId: 'opAlpha1', epoch: 'epochPending1' },
  ] })));
});

test('rejects invalid pending operation identifiers', () => {
  const invalid = [
    { opId: '', epoch: 'epochPending1' },
    { opId: 'bad id', epoch: 'epochPending1' },
    { opId: 'opAlpha1', epoch: '' },
    { opId: 'opAlpha1', epoch: 'bad epoch' },
  ];
  for (const op of invalid) rejected(planRestore(make({ pendingOperations: [op] })));
});

test('accepts 10000 pending operations and rejects 10001', () => {
  const ops = Array.from({ length: 10000 }, (_, i) => ({ opId: `op${i}`, epoch: `epochPending${i}` }));
  const result = planRestore(make({ pendingOperations: ops }));
  assert.equal(result.ok, true);
  assert.equal(result.plan.preservedOperationIds.length, 10000);
  assert.equal(new Set(result.plan.preservedOperationIds).size, 10000);
  const ids = new Set(result.plan.preservedOperationIds);
  for (const op of ops) assert.ok(ids.has(op.opId));
  rejected(planRestore(make({ pendingOperations: [...ops, { opId: 'opExtra', epoch: 'epochExtra1' }] })));
});
