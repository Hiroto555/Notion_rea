import test from 'node:test';
import assert from 'node:assert/strict';
import { appendAudit, verifyAudit } from '../src/audit.mjs';
import { hashJson } from '../src/contracts.mjs';

const ZERO_HASH = '0'.repeat(64);
const ISO_TIME = '2026-11-08T12:34:56.789Z';

function event(overrides = {}) {
  return {
    actorId: 'user1',
    orgId: 'org1',
    spaceId: 'space1',
    action: 'DOC_UPDATE',
    opId: 'op1',
    time: ISO_TIME,
    result: 'OK',
    ...overrides,
  };
}

function buildChain(raws) {
  let prevHash = ZERO_HASH;
  return raws.map((raw, index) => {
    const record = { seq: index + 1, prevHash, ...raw };
    record.hash = hashJson(record);
    prevHash = record.hash;
    return record;
  });
}

function snapshot(value) {
  return structuredClone(value);
}

function assertTamperDetected(result, index) {
  assert.equal(result.ok, false);
  assert.equal(result.index, index);
  assert.ok(result.code === 'INVALID' || result.code === 'CHAIN');
}

test('appendAudit creates the first link with the exact persisted shape', () => {
  const events = [];
  const raw = event();
  const beforeRaw = snapshot(raw);
  const next = appendAudit(events, raw);
  assert.notStrictEqual(next, events);
  assert.deepEqual(events, []);
  assert.deepEqual(next, buildChain([raw]));
  assert.deepEqual(raw, beforeRaw);
});

test('appendAudit chains later records and does not mutate the existing log', () => {
  const first = event();
  const second = event({ opId: 'op2', action: 'DOC_CREATE' });
  const chain1 = appendAudit([], first);
  const beforeChain1 = snapshot(chain1);
  const chain2 = appendAudit(chain1, second);
  assert.notStrictEqual(chain2, chain1);
  assert.deepEqual(chain1, beforeChain1);
  assert.deepEqual(chain2[0], chain1[0]);
  assert.equal(chain2[1].seq, 2);
  assert.equal(chain2[1].prevHash, chain1[0].hash);
  assert.deepEqual(chain2, buildChain([first, second]));
});

test('appendAudit accepts boundary identifier lengths and an epoch timestamp', () => {
  const id = 'a'.repeat(80);
  const raw = event({
    actorId: id,
    orgId: 'A-b_9',
    spaceId: id,
    action: 'A'.repeat(80),
    opId: id,
    result: 'R'.repeat(80),
    time: '1970-01-01T00:00:00.000Z',
  });
  assert.deepEqual(appendAudit([], raw), buildChain([raw]));
});

test('appendAudit rejects every extra raw event field', () => {
  const extras = [
    { body: { text: 'hidden' } }, { token: 'secret' }, { password: 'secret' },
    { seq: 1 }, { hash: ZERO_HASH }, { prevHash: ZERO_HASH }, { metadata: { nested: true } },
  ];
  for (const extra of extras) {
    const events = [];
    assert.throws(() => appendAudit(events, event(extra)), Error);
    assert.deepEqual(events, []);
  }
});

test('appendAudit rejects events missing any required field', () => {
  for (const key of ['actorId', 'orgId', 'spaceId', 'action', 'opId', 'time', 'result']) {
    const raw = event();
    delete raw[key];
    assert.throws(() => appendAudit([], raw), Error);
  }
});

test('appendAudit rejects invalid identifiers and non-identifier action/result', () => {
  const overridesList = [
    { actorId: '' }, { actorId: '-bad' }, { actorId: 'bad id' }, { actorId: 'a'.repeat(81) }, { actorId: 7 },
    { orgId: 'x/y' }, { spaceId: '雪' }, { opId: '_leading' },
    { action: '' }, { action: 'bad action' }, { action: 'a'.repeat(81) }, { action: '更新' },
    { result: '' }, { result: 'bad.result' }, { result: 'a'.repeat(81) }, { result: null },
  ];
  for (const overrides of overridesList) assert.throws(() => appendAudit([], event(overrides)), Error);
});

test('appendAudit accepts only strict normalized ISO timestamps', () => {
  const times = [
    '', '2026-11-08T12:34:56Z', '2026-11-08T12:34:56.789+00:00', '2026-02-30T00:00:00.000Z',
    '2026-11-08 12:34:56.789Z', '2026-13-01T00:00:00.000Z', 'not-a-time', 123, null,
  ];
  for (const time of times) assert.throws(() => appendAudit([], event({ time })), Error);
});

test('appendAudit validates the existing chain before appending', () => {
  const base = buildChain([event(), event({ opId: 'op2' })]);
  const corruptions = [
    chain => { chain[0].action = 'OTHER'; }, chain => { chain[1].seq = 3; },
    chain => { chain[1].prevHash = ZERO_HASH; }, chain => { chain[1].hash = 'f'.repeat(64); },
  ];
  for (const corrupt of corruptions) {
    const chain = snapshot(base);
    corrupt(chain);
    const before = snapshot(chain);
    assert.throws(() => appendAudit(chain, event({ opId: 'op3' })), Error);
    assert.deepEqual(chain, before);
  }
});

test('verifyAudit accepts a valid chain and leaves it untouched', () => {
  const chain = buildChain([event(), event({ opId: 'op2' }), event({ opId: 'op3', action: 'DOC_CREATE' })]);
  const before = snapshot(chain);
  assert.deepEqual(verifyAudit(chain), { ok: true });
  assert.deepEqual(chain, before);
});

test('verifyAudit accepts an empty chain', () => {
  assert.deepEqual(verifyAudit([]), { ok: true });
});

test('verifyAudit detects content tampering at the affected record', () => {
  const chain = buildChain([event(), event({ opId: 'op2' }), event({ opId: 'op3' })]);
  chain[1].action = 'DOC_CREATE';
  assertTamperDetected(verifyAudit(chain), 1);
});

test('verifyAudit detects seq tampering', () => {
  const chain = buildChain([event(), event({ opId: 'op2' }), event({ opId: 'op3' })]);
  chain[1].seq = 5;
  assertTamperDetected(verifyAudit(chain), 1);
});

test('verifyAudit detects prevHash tampering', () => {
  const chain = buildChain([event(), event({ opId: 'op2' }), event({ opId: 'op3' })]);
  chain[2].prevHash = ZERO_HASH;
  assertTamperDetected(verifyAudit(chain), 2);
});

test('verifyAudit detects direct hash tampering', () => {
  const chain = buildChain([event(), event({ opId: 'op2' }), event({ opId: 'op3' })]);
  chain[1].hash = 'f'.repeat(64);
  assertTamperDetected(verifyAudit(chain), 1);
});

test('verifyAudit rejects removed or fabricated links', () => {
  const base = buildChain([event(), event({ opId: 'op2' }), event({ opId: 'op3' })]);
  const removed = snapshot(base);
  removed.splice(1, 1);
  assertTamperDetected(verifyAudit(removed), 1);
  const fabricated = snapshot(base);
  fabricated.splice(1, 0, snapshot(base[0]));
  assertTamperDetected(verifyAudit(fabricated), 1);
});

test('verifyAudit reports malformed input as INVALID at index 0', () => {
  const invalidInputs = [
    null, undefined, {}, 'not-an-array', [null], [{}], [event()],
    [{ seq: 1, prevHash: ZERO_HASH, ...event(), hash: 'x' }],
  ];
  for (const input of invalidInputs) assert.deepEqual(verifyAudit(input), { ok: false, index: 0, code: 'INVALID' });
});

test('appendAudit rejects non-object events and non-array logs', () => {
  for (const badEvent of [null, undefined, 'x', 1, []]) {
    assert.throws(() => appendAudit([], badEvent), Error);
  }
  for (const badLog of [null, undefined, {}, 'x', 1]) {
    assert.throws(() => appendAudit(badLog, event()), Error);
  }
});

test('verifyAudit enforces the 10000-record limit', () => {
  const raws = Array.from({ length: 10001 }, (_, index) => event({ opId: `op${index}` }));
  const chain = buildChain(raws);
  assert.deepEqual(verifyAudit(chain.slice(0, 10000)), { ok: true });
  const result = verifyAudit(chain);
  assert.equal(result.ok, false);
  assert.equal(typeof result.index, 'number');
  assert.ok(result.code === 'INVALID' || result.code === 'CHAIN');
});
