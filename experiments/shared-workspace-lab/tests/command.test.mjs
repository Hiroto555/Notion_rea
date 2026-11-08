import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommand } from '../src/command.mjs';
import { canonicalJson, hashJson } from '../src/contracts.mjs';

const base = () => ({
  opId: 'op-1',
  actorId: 'actor-1',
  orgId: 'org-1',
  spaceId: 'space-1',
  docId: 'doc-1',
  incarnation: 'inc-1',
  kind: 'edit',
  baseVersion: 0,
  payload: { type: 'paragraph', text: 'hello' }
});

const cmd = (overrides = {}) => ({ ...base(), ...overrides });
const expectInvalid = value => assert.deepEqual(validateCommand(value), { ok: false, code: 'INVALID' });

test('accepts a valid envelope, returns a deep clone, and hashes the original', () => {
  const input = cmd({ unknownTop: { a: [1, 2] }, payload: { type: 'paragraph', text: 'hello', meta: { n: 1 } } });
  const out = validateCommand(input);
  assert.equal(out.ok, true);
  assert.deepEqual(out.command, input);
  assert.notEqual(out.command, input);
  assert.notEqual(out.command.payload, input.payload);
  assert.equal(out.fingerprint, hashJson(input));
});

test('preserves unknown fields in the clone without mutating the original', () => {
  const input = cmd({ custom: { nested: [{ v: 1 }] }, payload: { items: [{ id: 'a' }], keep: true } });
  const snapshot = canonicalJson(input);
  const out = validateCommand(input);
  assert.equal(canonicalJson(input), snapshot);
  out.command.custom.nested[0].v = 99;
  out.command.payload.items[0].id = 'b';
  assert.equal(input.custom.nested[0].v, 1);
  assert.equal(input.payload.items[0].id, 'a');
});

test('accepts every documented kind', () => {
  for(const kind of ['edit', 'create', 'delete', 'restore']) {
    const out = validateCommand(cmd({ kind }));
    assert.equal(out.ok, true);
    assert.equal(out.command.kind, kind);
  }
});

test('rejects unknown or non-string kinds', () => {
  for(const kind of ['move', '', null, 3]) expectInvalid(cmd({ kind }));
});

test('validates all six required IDs and their length boundary', () => {
  for(const field of ['opId', 'actorId', 'orgId', 'spaceId', 'docId', 'incarnation']) {
    const missing = cmd();
    delete missing[field];
    expectInvalid(missing);
    for(const bad of ['', 'bad id', '-leading', 7, null]) expectInvalid(cmd({ [field]: bad }));
  }
  assert.equal(validateCommand(cmd({ opId: 'a'.repeat(80) })).ok, true);
  expectInvalid(cmd({ opId: 'a'.repeat(81) }));
});

test('accepts nonnegative safe integer base versions', () => {
  for(const baseVersion of [0, 1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(validateCommand(cmd({ baseVersion })).ok, true);
  }
});

test('rejects invalid base versions', () => {
  for(const baseVersion of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '0', null, undefined]) {
    expectInvalid(cmd({ baseVersion }));
  }
  const missing = cmd();
  delete missing.baseVersion;
  expectInvalid(missing);
});

test('accepts object and array payloads', () => {
  for(const payload of [{ a: 1 }, [1, 'two', null, { x: [] }]]) {
    const out = validateCommand(cmd({ payload }));
    assert.equal(out.ok, true);
    assert.deepEqual(out.command.payload, payload);
  }
});

test('rejects payloads that are not non-null objects or arrays', () => {
  for(const payload of [null, 'text', 5, true, undefined]) expectInvalid(cmd({ payload }));
  const missing = cmd();
  delete missing.payload;
  expectInvalid(missing);
});

test('rejects non-JSON values anywhere in the envelope', () => {
  const cycle = {};
  cycle.self = cycle;
  const cases = [
    cmd({ payload: { n: undefined } }),
    cmd({ payload: { n: 1n } }),
    cmd({ payload: { n: Number.MAX_SAFE_INTEGER + 1 } }),
    cmd({ unknownTop: { n: Number.MAX_SAFE_INTEGER + 1 } }),
    cmd({ payload: { when: new Date(0) } }),
    cmd({ payload: { fn: () => {} } }),
    cmd({ payload: cycle }),
    cmd({ unknownTop: { s: new Set() } })
  ];
  for(const value of cases) expectInvalid(value);
});

test('rejects top-level values that are not envelopes', () => {
  for(const value of [null, undefined, 'cmd', 42, true, []]) expectInvalid(value);
});

test('fingerprint is stable across envelope key order', () => {
  const a = cmd({ payload: { z: 1, a: 2 }, unknownTop: { b: 1 } });
  const b = Object.fromEntries(Object.entries(a).reverse());
  assert.deepEqual(a, b);
  assert.equal(validateCommand(a).fingerprint, validateCommand(b).fingerprint);
});

test('fingerprint changes with actor, scope, payload, generation, and extra fields', () => {
  const fingerprint = validateCommand(cmd()).fingerprint;
  const variants = [
    cmd({ opId: 'op-2' }),
    cmd({ actorId: 'actor-2' }),
    cmd({ orgId: 'org-2' }),
    cmd({ spaceId: 'space-2' }),
    cmd({ docId: 'doc-2' }),
    cmd({ incarnation: 'inc-2' }),
    cmd({ baseVersion: 1 }),
    cmd({ payload: { type: 'paragraph', text: 'changed' } }),
    cmd({ unknownTop: true })
  ];
  for(const variant of variants) assert.notEqual(validateCommand(variant).fingerprint, fingerprint);
});

test('compares canonical UTF-8 byte length with maxBytes at the boundary', () => {
  const input = cmd({ payload: { text: 'é'.repeat(20) } });
  const bytes = Buffer.byteLength(canonicalJson(input), 'utf8');
  assert.equal(validateCommand(input, { maxBytes: bytes }).ok, true);
  assert.deepEqual(validateCommand(input, { maxBytes: bytes - 1 }), { ok: false, code: 'TOO_LARGE' });
});

test('rejects invalid maxBytes values', () => {
  for(const maxBytes of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10', null]) {
    const out = validateCommand(cmd(), { maxBytes });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'INVALID');
  }
});
