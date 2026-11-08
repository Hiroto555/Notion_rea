import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRecordCommand } from '../src/records.mjs';

test('creating past the record limit cannot return a state its own validator rejects', () => {
  const state = { databaseId: 'db1', schemaVersion: 1, properties: [],
    records: Array.from({ length: 10000 }, (_, index) => ({ id: `r${index}`, version: 1, deleted: false, values: {} })) };
  const result = applyRecordCommand(state, { databaseId: 'db1', schemaVersion: 1,
    recordId: 'overflow', expectedVersion: 0, action: 'create', values: {} });
  assert.deepEqual(result, { ok: false, code: 'INVALID' });
  assert.equal(state.records.length, 10000);
});
