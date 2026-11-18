import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, cloneJson, hashJson } from '../src/contracts.mjs';
import { validateCommand } from '../src/command.mjs';

test('canonical JSON preserves unknown nested JSON and distinguishes request changes', () => {
  const value = { unknown: { Japanese: '日本語', values: [null, true, 1.5] }, a: 1 };
  assert.deepEqual(cloneJson(value), value);
  assert.equal(hashJson(value), hashJson({ a: 1, unknown: value.unknown }));
  assert.notEqual(hashJson(value), hashJson({ ...value, a: 2 }));
});

test('sparse arrays and non-JSON array properties cannot silently disappear', () => {
  assert.throws(() => canonicalJson(new Array(2)), /sparse/);
  const value = [1]; value.unknown = 'preserve-or-refuse';
  assert.throws(() => canonicalJson(value), /array property/);
});

test('symbol and non-enumerable fields are refused instead of omitted from fingerprints', () => {
  const symbol = { ordinary: true, [Symbol('hidden')]: 'private' };
  assert.throws(() => canonicalJson(symbol), /symbol/);
  const hidden = { ordinary: true }; Object.defineProperty(hidden, 'hidden', { value: 'private' });
  assert.throws(() => canonicalJson(hidden), /property/);
});

test('accessor properties are refused without invoking their getters', () => {
  let invoked = false;
  const value = { get secret() { invoked = true; return 'do not read'; } };
  assert.throws(() => canonicalJson(value), /property/);
  assert.equal(invoked, false);
});

test('unsupported nested payload returns invalid rather than throwing from a later clone', () => {
  const value = { opId: 'op1', actorId: 'owner', orgId: 'org1', spaceId: 'space1',
    docId: 'doc1', incarnation: 'gen1', kind: 'edit', baseVersion: 0, payload: { unknown: new Array(1) } };
  assert.deepEqual(validateCommand(value), { ok: false, code: 'INVALID' });
});
