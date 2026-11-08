import test from 'node:test';
import assert from 'node:assert/strict';
import { decideLifecycle } from '../src/lifecycle.mjs';

const live = (overrides = {}) => ({ incarnation: 'gen1', deleted: false, version: 5, ...overrides });
const deleted = (overrides = {}) => ({ incarnation: 'gen1', deleted: true, version: 5, ...overrides });
const edit = (overrides = {}) => ({ incarnation: 'gen1', kind: 'edit', baseVersion: 5, ...overrides });
const remove = (overrides = {}) => ({ incarnation: 'gen1', kind: 'delete', baseVersion: 5, ...overrides });
const restore = (overrides = {}) => ({ incarnation: 'gen1', kind: 'restore', baseVersion: 5, newIncarnation: 'gen2', ...overrides });
const snapshot = value => structuredClone(value);

test('edit on a live document is allowed and increments version', () => {
  const result = decideLifecycle({ current: live(), request: edit() });
  assert.equal(result.allowed, true);
  assert.equal(typeof result.next, 'object');
  assert.equal(result.next.incarnation, 'gen1');
  assert.equal(result.next.deleted, false);
  assert.equal(result.next.version, 6);
});

test('delete on a live document marks it deleted and increments version', () => {
  const result = decideLifecycle({ current: live(), request: remove() });
  assert.equal(result.allowed, true);
  assert.equal(result.next.incarnation, 'gen1');
  assert.equal(result.next.deleted, true);
  assert.equal(result.next.version, 6);
});

test('restore on a deleted document becomes live under the new incarnation', () => {
  const result = decideLifecycle({ current: deleted(), request: restore() });
  assert.equal(result.allowed, true);
  assert.equal(result.next.incarnation, 'gen2');
  assert.equal(result.next.deleted, false);
  assert.equal(result.next.version, 6);
});

test('successful decisions do not mutate current or request', () => {
  const current = live();
  const request = edit();
  const currentSnapshot = snapshot(current);
  const requestSnapshot = snapshot(request);
  decideLifecycle({ current, request });
  assert.deepEqual(current, currentSnapshot);
  assert.deepEqual(request, requestSnapshot);
});

test('edit on a deleted document is rejected as DELETED', () => {
  const result = decideLifecycle({ current: deleted(), request: edit() });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'DELETED');
});

test('delete on a deleted document is rejected as DELETED', () => {
  const result = decideLifecycle({ current: deleted(), request: remove() });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'DELETED');
});

test('restore on a live document is rejected as LIVE', () => {
  const result = decideLifecycle({ current: live(), request: restore() });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'LIVE');
});

test('a stale incarnation is rejected without rebinding the request', () => {
  const current = live({ incarnation: 'gen2' });
  const request = edit({ incarnation: 'gen1' });
  const currentSnapshot = snapshot(current);
  const requestSnapshot = snapshot(request);
  const result = decideLifecycle({ current, request });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'STALE_GENERATION');
  assert.equal(result.next == null, true);
  assert.deepEqual(current, currentSnapshot);
  assert.deepEqual(request, requestSnapshot);
});

test('a baseVersion mismatch is rejected as CONFLICT', () => {
  const result = decideLifecycle({ current: live({ version: 5 }), request: edit({ baseVersion: 4 }) });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'CONFLICT');
});

test('an unknown kind is rejected as INVALID', () => {
  const result = decideLifecycle({ current: live(), request: edit({ kind: 'archive' }) });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'INVALID');
});

test('a missing kind is rejected as INVALID', () => {
  const request = { incarnation: 'gen1', baseVersion: 5 };
  const result = decideLifecycle({ current: live(), request });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'INVALID');
});

test('malformed current state is rejected as INVALID', () => {
  const cases = [
    { current: { incarnation: 'has space', deleted: false, version: 5 }, request: edit({ incarnation: 'has space' }) },
    { current: { incarnation: 'gen1', deleted: 'no', version: 5 }, request: edit() },
    { current: { incarnation: 'gen1', deleted: false, version: -1 }, request: edit({ baseVersion: -1 }) },
    { current: { incarnation: 'gen1', deleted: false, version: 1.5 }, request: edit({ baseVersion: 1.5 }) },
    { current: { incarnation: 'gen1', deleted: false, version: Number.MAX_SAFE_INTEGER + 1 }, request: edit({ baseVersion: Number.MAX_SAFE_INTEGER + 1 }) },
    { current: { incarnation: 'gen1', deleted: false, version: Number.NaN }, request: edit({ baseVersion: Number.NaN }) },
  ];
  for (const { current, request } of cases) {
    const result = decideLifecycle({ current, request });
    assert.equal(result.allowed, false, `expected rejection for ${JSON.stringify(current)}`);
    assert.equal(result.code, 'INVALID');
  }
});

test('malformed request fields are rejected as INVALID', () => {
  const cases = [
    null,
    {},
    { incarnation: 'has space', kind: 'edit', baseVersion: 5 },
    { incarnation: 'gen1', kind: 'edit', baseVersion: -1 },
    { incarnation: 'gen1', kind: 'edit', baseVersion: 1.5 },
    { incarnation: 'gen1', kind: 'edit', baseVersion: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const request of cases) {
    const result = decideLifecycle({ current: live(), request });
    assert.equal(result.allowed, false, `expected rejection for ${JSON.stringify(request)}`);
    assert.equal(result.code, 'INVALID');
  }
});

test('restore without a new incarnation is rejected as INVALID', () => {
  const request = { incarnation: 'gen1', kind: 'restore', baseVersion: 5 };
  const result = decideLifecycle({ current: deleted(), request });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'INVALID');
});

test('restore reusing the current incarnation is rejected as INVALID', () => {
  const result = decideLifecycle({ current: deleted(), request: restore({ newIncarnation: 'gen1' }) });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'INVALID');
});

test('restore with a malformed new incarnation is rejected as INVALID', () => {
  const result = decideLifecycle({ current: deleted(), request: restore({ newIncarnation: 'bad id' }) });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'INVALID');
});

test('increment overflow is rejected as INVALID', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const cases = [
    { current: live({ version: max }), request: edit({ baseVersion: max }) },
    { current: live({ version: max }), request: remove({ baseVersion: max }) },
    { current: deleted({ version: max }), request: restore({ baseVersion: max }) },
  ];
  for (const { current, request } of cases) {
    const result = decideLifecycle({ current, request });
    assert.equal(result.allowed, false);
    assert.equal(result.code, 'INVALID');
  }
});
