import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateAsset } from '../src/asset-admission.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const payload = Buffer.from('folio-asset-admission-payload');

function assertInvalid(input) {
  const result = validateAsset(input);
  assert.deepEqual(result, { ok: false, code: 'INVALID' });
}

test('admits a valid Buffer and returns an independent snapshot', () => {
  const result = validateAsset({ bytes: payload, sha256: sha(payload), expectedSize: payload.length });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.asset).sort(), ['bytes', 'sha256', 'size']);
  assert.equal(result.asset.sha256, sha(payload));
  assert.equal(result.asset.size, payload.length);
  assert.equal(Buffer.isBuffer(result.asset.bytes), true);
  assert.notEqual(result.asset.bytes, payload);
  assert.deepEqual(result.asset.bytes, payload);
});

test('admits Uint8Array input with the same binary semantics', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
  const result = validateAsset({ bytes, sha256: sha(bytes), expectedSize: bytes.byteLength });
  assert.equal(result.ok, true);
  assert.equal(result.asset.size, 6);
  assert.equal(result.asset.sha256, sha(bytes));
  assert.deepEqual(result.asset.bytes, Buffer.from(bytes));
});

test('admits the empty payload using the real SHA-256 of empty input', () => {
  const result = validateAsset({ bytes: Buffer.alloc(0), sha256: EMPTY_SHA, expectedSize: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.asset.sha256, EMPTY_SHA);
  assert.equal(result.asset.size, 0);
  assert.deepEqual(result.asset.bytes, Buffer.alloc(0));
});

test('snapshots only the Uint8Array view, not the entire backing buffer', () => {
  const backing = new Uint8Array([9, 9, 3, 4, 9, 9]);
  const view = backing.subarray(2, 4);
  const result = validateAsset({ bytes: view, sha256: sha(view), expectedSize: 2 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.asset.bytes, Buffer.from([3, 4]));
  backing.fill(0);
  assert.deepEqual(result.asset.bytes, Buffer.from([3, 4]));
  assert.equal(result.asset.sha256, sha(Buffer.from([3, 4])));
});

test('rejects missing, non-binary, and view-like non-Uint8Array bytes as INVALID', () => {
  for (const bytes of [undefined, null, 'text', [1, 2, 3], new ArrayBuffer(3), new DataView(new ArrayBuffer(3)), 42, {}]) {
    assertInvalid({ bytes, sha256: EMPTY_SHA, expectedSize: 0 });
  }
  assertInvalid(undefined);
  assertInvalid(null);
});

test('rejects malformed sha256 digests as INVALID', () => {
  for (const value of [EMPTY_SHA.toUpperCase(), EMPTY_SHA.slice(0, 63), `${EMPTY_SHA.slice(0, 63)}g`, '', 42, null]) {
    assertInvalid({ bytes: payload, sha256: value, expectedSize: payload.length });
  }
});

test('rejects malformed expectedSize and maxBytes as INVALID', () => {
  for (const expectedSize of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '4', null]) {
    assertInvalid({ bytes: payload, sha256: sha(payload), expectedSize });
  }
  for (const maxBytes of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '8', null]) {
    assertInvalid({ bytes: payload, sha256: sha(payload), expectedSize: payload.length, maxBytes });
  }
});

test('rejects a payload whose length differs from expectedSize with SIZE', () => {
  const result = validateAsset({ bytes: payload, sha256: sha(payload), expectedSize: payload.length + 1 });
  assert.deepEqual(result, { ok: false, code: 'SIZE' });
  const smaller = validateAsset({ bytes: payload, sha256: sha(payload), expectedSize: payload.length - 1 });
  assert.deepEqual(smaller, { ok: false, code: 'SIZE' });
});

test('rejects an oversized payload with LIMIT before copying or hashing', () => {
  const result = validateAsset({ bytes: payload, sha256: '0'.repeat(64), expectedSize: 0, maxBytes: payload.length - 1 });
  assert.deepEqual(result, { ok: false, code: 'LIMIT' });
});

test('admits a payload exactly at the maxBytes boundary and rejects one byte over', () => {
  const exact = validateAsset({ bytes: payload, sha256: sha(payload), expectedSize: payload.length, maxBytes: payload.length });
  assert.equal(exact.ok, true);
  const over = validateAsset({ bytes: payload, sha256: sha(payload), expectedSize: payload.length, maxBytes: payload.length - 1 });
  assert.deepEqual(over, { ok: false, code: 'LIMIT' });
});

test('default maxBytes is 1048576 and rejects the first byte beyond it', () => {
  const bytes = Buffer.alloc(1048576 + 1, 7);
  const result = validateAsset({ bytes, sha256: sha(bytes), expectedSize: bytes.length });
  assert.deepEqual(result, { ok: false, code: 'LIMIT' });
});

test('rejects a mismatched hash with HASH using the real digest', () => {
  const result = validateAsset({ bytes: payload, sha256: sha(Buffer.from('different')), expectedSize: payload.length });
  assert.deepEqual(result, { ok: false, code: 'HASH' });
});

test('checks size before hash', () => {
  const result = validateAsset({ bytes: payload, sha256: '0'.repeat(64), expectedSize: payload.length + 2 });
  assert.deepEqual(result, { ok: false, code: 'SIZE' });
});

test('never mutates caller bytes', () => {
  const bytes = Buffer.from(payload);
  const before = Buffer.from(bytes);
  validateAsset({ bytes, sha256: sha(bytes), expectedSize: bytes.length });
  assert.deepEqual(bytes, before);
});

test('does not allocate from an adversarial expectedSize', () => {
  const bytes = Buffer.from([1]);
  const result = validateAsset({ bytes, sha256: sha(bytes), expectedSize: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(result, { ok: false, code: 'SIZE' });
});
