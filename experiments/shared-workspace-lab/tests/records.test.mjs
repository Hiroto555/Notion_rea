import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRecordCommand } from '../src/records.mjs';

function makeState(overrides = {}) {
  return {
    databaseId: 'db1',
    schemaVersion: 1,
    properties: [
      { id: 'title', type: 'text' },
      { id: 'score', type: 'number' },
      { id: 'done', type: 'checkbox' },
    ],
    records: [],
    ...overrides,
  };
}

function makeCommand(overrides = {}) {
  return {
    databaseId: 'db1',
    schemaVersion: 1,
    recordId: 'rec1',
    expectedVersion: 0,
    action: 'create',
    ...overrides,
  };
}

function liveRecord(overrides = {}) {
  return { id: 'rec1', version: 1, deleted: false, values: { title: 'seed' }, ...overrides };
}

function record(out) {
  return out.state.records.find((entry) => entry.id === 'rec1');
}

test('create inserts a live version 1 record with default empty values', () => {
  const input = makeState();
  const out = applyRecordCommand(input, makeCommand());
  assert.equal(out.ok, true);
  assert.deepEqual(record(out), { id: 'rec1', version: 1, deleted: false, values: {} });
  assert.notEqual(out.state, input);
  assert.notEqual(out.state.records, input.records);
  assert.deepEqual(input.records, []);
});

test('create stores validated text, number and checkbox values', () => {
  const out = applyRecordCommand(
    makeState(),
    makeCommand({ values: { title: 'note', score: 42.5, done: true } }),
  );
  assert.equal(out.ok, true);
  assert.deepEqual(record(out).values, { title: 'note', score: 42.5, done: true });
  assert.equal(record(out).version, 1);
});

test('create rejects an existing record with CONFLICT', () => {
  const input = makeState({ records: [liveRecord()] });
  const before = JSON.stringify(input);
  assert.deepEqual(applyRecordCommand(input, makeCommand()), { ok: false, code: 'CONFLICT' });
  assert.equal(JSON.stringify(input), before);
});

test('create requires expectedVersion 0 even when the record is absent', () => {
  assert.deepEqual(
    applyRecordCommand(makeState(), makeCommand({ expectedVersion: 2 })),
    { ok: false, code: 'CONFLICT' },
  );
});

test('create refuses unknown properties and non-matching value types', () => {
  const values = [{ ghost: 'x' }, { score: '42' }, { done: 1 }, { title: 7 }];
  for (const candidate of values) {
    assert.deepEqual(
      applyRecordCommand(makeState(), makeCommand({ values: candidate })),
      { ok: false, code: 'INVALID' },
    );
  }
});

test('patch merges values, increments version and preserves unknown metadata', () => {
  const input = makeState({
    label: 'keep-root',
    properties: [
      { id: 'title', type: 'text', color: 'blue' },
      { id: 'score', type: 'number' },
    ],
    records: [
      { id: 'rec1', version: 2, deleted: false, values: { title: 'old', score: 1 }, origin: 'sync' },
    ],
  });
  const out = applyRecordCommand(
    input,
    makeCommand({ action: 'patch', expectedVersion: 2, values: { score: 9 } }),
  );
  assert.equal(out.ok, true);
  assert.equal(record(out).version, 3);
  assert.deepEqual(record(out).values, { title: 'old', score: 9 });
  assert.equal(record(out).origin, 'sync');
  assert.equal(out.state.label, 'keep-root');
  assert.equal(out.state.properties[0].color, 'blue');
  assert.deepEqual(input.records[0].values, { title: 'old', score: 1 });
});

test('patch accepts null as an unset value', () => {
  const input = makeState({ records: [liveRecord({ version: 1 })] });
  const out = applyRecordCommand(
    input,
    makeCommand({ action: 'patch', expectedVersion: 1, values: { title: null } }),
  );
  assert.equal(out.ok, true);
  assert.equal(record(out).values.title, null);
  assert.equal(record(out).version, 2);
});

test('patch refuses a deleted record with DELETED', () => {
  const input = makeState({ records: [liveRecord({ version: 3, deleted: true })] });
  assert.deepEqual(
    applyRecordCommand(
      input,
      makeCommand({ action: 'patch', expectedVersion: 3, values: { title: 'x' } }),
    ),
    { ok: false, code: 'DELETED' },
  );
});

test('delete preserves values and marks the record deleted with a new version', () => {
  const input = makeState({
    records: [liveRecord({ version: 2, values: { title: 'keep', done: false } })],
  });
  const out = applyRecordCommand(input, makeCommand({ action: 'delete', expectedVersion: 2 }));
  assert.equal(out.ok, true);
  assert.equal(record(out).deleted, true);
  assert.equal(record(out).version, 3);
  assert.deepEqual(record(out).values, { title: 'keep', done: false });
});

test('delete refuses an already deleted record', () => {
  const input = makeState({ records: [liveRecord({ version: 4, deleted: true })] });
  assert.deepEqual(
    applyRecordCommand(input, makeCommand({ action: 'delete', expectedVersion: 4 })),
    { ok: false, code: 'DELETED' },
  );
});

test('restore preserves values and never resets the version', () => {
  const input = makeState({
    records: [liveRecord({ version: 5, deleted: true, values: { title: 'kept' } })],
  });
  const out = applyRecordCommand(input, makeCommand({ action: 'restore', expectedVersion: 5 }));
  assert.equal(out.ok, true);
  assert.equal(record(out).deleted, false);
  assert.equal(record(out).version, 6);
  assert.deepEqual(record(out).values, { title: 'kept' });
});

test('restore refuses a live record with LIVE', () => {
  const input = makeState({ records: [liveRecord({ version: 2 })] });
  assert.deepEqual(
    applyRecordCommand(input, makeCommand({ action: 'restore', expectedVersion: 2 })),
    { ok: false, code: 'LIVE' },
  );
});

test('non-create actions reject a stale expectedVersion with CONFLICT', () => {
  const input = makeState({ records: [liveRecord({ version: 3 })] });
  assert.deepEqual(
    applyRecordCommand(
      input,
      makeCommand({ action: 'patch', expectedVersion: 2, values: { title: 'x' } }),
    ),
    { ok: false, code: 'CONFLICT' },
  );
  assert.deepEqual(
    applyRecordCommand(input, makeCommand({ action: 'delete', expectedVersion: 2 })),
    { ok: false, code: 'CONFLICT' },
  );
});

test('non-create actions on an absent record are MISSING', () => {
  for (const action of ['patch', 'delete', 'restore']) {
    const command = makeCommand({
      action,
      expectedVersion: 1,
      ...(action === 'patch' ? { values: { title: 'x' } } : {}),
    });
    assert.deepEqual(applyRecordCommand(makeState(), command), { ok: false, code: 'MISSING' });
  }
});

test('rejects wrong database as SCOPE and schema mismatch as SCHEMA', () => {
  assert.deepEqual(
    applyRecordCommand(makeState(), makeCommand({ databaseId: 'db2' })),
    { ok: false, code: 'SCOPE' },
  );
  assert.deepEqual(
    applyRecordCommand(makeState(), makeCommand({ schemaVersion: 2 })),
    { ok: false, code: 'SCHEMA' },
  );
});

test('malformed state or command and overflow are INVALID and leave input untouched', () => {
  const good = makeState({ records: [liveRecord()] });
  const before = JSON.stringify(good);
  const badStates = [
    makeState({ schemaVersion: 0 }),
    makeState({
      properties: [
        { id: 'title', type: 'text' },
        { id: 'title', type: 'number' },
      ],
    }),
    makeState({ properties: Array.from({ length: 101 }, (_, i) => ({ id: `p${i}`, type: 'text' })) }),
    makeState({ records: [liveRecord({ version: 0 })] }),
  ];
  for (const state of badStates) {
    assert.deepEqual(applyRecordCommand(state, makeCommand()), { ok: false, code: 'INVALID' });
  }
  const badCommands = [
    makeCommand({ recordId: 'bad id' }),
    makeCommand({ action: 'rename' }),
    makeCommand({ action: 'patch', expectedVersion: 1 }),
    makeCommand({ values: { title: 'x'.repeat(10001) } }),
    makeCommand({ values: { score: 2 ** 53 } }),
    makeCommand({ values: { title: Number.NaN } }),
    makeCommand({ values: { title: () => {} } }),
  ];
  for (const command of badCommands) {
    assert.deepEqual(applyRecordCommand(good, command), { ok: false, code: 'INVALID' });
  }
  assert.equal(JSON.stringify(good), before);
});
