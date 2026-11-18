import test from 'node:test';
import assert from 'node:assert/strict';
import { assessBudget } from '../src/budget.mjs';

const MAX = Number.MAX_SAFE_INTEGER;

const base = () => ({
  usedBytes: 100,
  pendingCount: 2,
  requestBytes: 50,
  limits: { maxBytes: 1000, maxPending: 10, maxRequestBytes: 200 },
});

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function expectInvalid(mutate) {
  const input = base();
  mutate(input);
  const result = assessBudget(input);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'INVALID');
}

test('allows a request comfortably within every limit and reports next counters', () => {
  const result = assessBudget(base());
  assert.deepEqual(result, { allowed: true, code: 'OK', nextBytes: 150, nextPending: 3 });
});

test('accepts a request that lands exactly on maxBytes', () => {
  const input = base();
  input.usedBytes = 950;
  input.requestBytes = 50;
  const result = assessBudget(input);
  assert.equal(result.allowed, true);
  assert.equal(result.code, 'OK');
  assert.equal(result.nextBytes, 1000);
});

test('accepts a request that lands exactly on maxRequestBytes', () => {
  const input = base();
  input.requestBytes = 200;
  const result = assessBudget(input);
  assert.equal(result.allowed, true);
  assert.equal(result.nextBytes, 300);
});

test('accepts the pending count that lands exactly on maxPending', () => {
  const input = base();
  input.pendingCount = 9;
  const result = assessBudget(input);
  assert.equal(result.allowed, true);
  assert.equal(result.nextPending, 10);
});

test('allows an all-zero request against minimal positive limits', () => {
  const result = assessBudget({
    usedBytes: 0,
    pendingCount: 0,
    requestBytes: 0,
    limits: { maxBytes: 1, maxPending: 1, maxRequestBytes: 1 },
  });
  assert.deepEqual(result, { allowed: true, code: 'OK', nextBytes: 0, nextPending: 1 });
});

test('rejects with BYTE_LIMIT when used plus requested exceeds maxBytes', () => {
  const input = base();
  input.usedBytes = 951;
  const result = assessBudget(input);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'BYTE_LIMIT');
});

test('rejects with REQUEST_LIMIT when request exceeds maxRequestBytes', () => {
  const input = base();
  input.requestBytes = 201;
  const result = assessBudget(input);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'REQUEST_LIMIT');
});

test('rejects with PENDING_LIMIT when one more pending would exceed maxPending', () => {
  const input = base();
  input.pendingCount = 10;
  const result = assessBudget(input);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'PENDING_LIMIT');
});

test('rejects an enormous request against a small maxRequestBytes without overflow', () => {
  const input = base();
  input.usedBytes = 0;
  input.requestBytes = MAX;
  input.limits.maxBytes = MAX;
  input.limits.maxRequestBytes = 10;
  const result = assessBudget(input);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'REQUEST_LIMIT');
});

test('invalid: negative usedBytes', () => expectInvalid((i) => { i.usedBytes = -1; }));

test('invalid: negative pendingCount', () => expectInvalid((i) => { i.pendingCount = -1; }));

test('invalid: negative requestBytes', () => expectInvalid((i) => { i.requestBytes = -1; }));

test('invalid: zero byte limit (limits must be positive)', () => expectInvalid((i) => { i.limits.maxBytes = 0; }));

test('invalid: fractional requestBytes', () => expectInvalid((i) => { i.requestBytes = 1.5; }));

test('invalid: non-integer pendingCount', () => expectInvalid((i) => { i.pendingCount = 2.0001; }));

test('invalid: unsafe integer usedBytes', () => expectInvalid((i) => { i.usedBytes = MAX + 2; }));

test('invalid: non-finite requestBytes', () => expectInvalid((i) => { i.requestBytes = Infinity; }));

test('invalid: NaN usedBytes', () => expectInvalid((i) => { i.usedBytes = NaN; }));

test('invalid: string field', () => expectInvalid((i) => { i.usedBytes = '100'; }));

test('invalid: missing requestBytes', () => expectInvalid((i) => { delete i.requestBytes; }));

test('invalid: missing limits object', () => expectInvalid((i) => { delete i.limits; }));

test('invalid: missing maxPending limit', () => expectInvalid((i) => { delete i.limits.maxPending; }));

test('invalid: null input', () => {
  const result = assessBudget(null);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'INVALID');
});

test('invalid: usedBytes plus requestBytes would overflow safe integers', () => {
  expectInvalid((i) => {
    i.usedBytes = MAX;
    i.requestBytes = 1;
    i.limits.maxBytes = MAX;
    i.limits.maxRequestBytes = 1;
  });
});

test('invalid: pendingCount plus one would overflow safe integers', () => {
  expectInvalid((i) => {
    i.pendingCount = MAX;
    i.limits.maxPending = MAX;
  });
});

test('does not mutate the caller input, even when deeply frozen', () => {
  const input = deepFreeze(base());
  const snapshot = structuredClone(input);
  const result = assessBudget(input);
  assert.equal(result.allowed, true);
  assert.deepEqual(input, snapshot);
});

test('returns a fresh result not aliased to the input limits', () => {
  const input = base();
  const result = assessBudget(input);
  result.nextBytes = -999;
  result.nextPending = -999;
  assert.equal(input.usedBytes, 100);
  assert.equal(input.pendingCount, 2);
  assert.equal(input.limits.maxBytes, 1000);
});
