import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize } from '../src/authz.mjs';

const VIEWER = ['read', 'subscribe', 'receipt', 'assetRead'];
const EDITOR = ['edit', 'create', 'delete', 'assetWrite'];
const OWNER = ['restore', 'invite', 'manage', 'backup'];
const ALL = [...VIEWER, ...EDITOR, ...OWNER];

function input(overrides = {}) {
  const base = {
    membership: { userId: 'u1', orgId: 'o1', spaceId: 's1', role: 'viewer', status: 'active', version: 1 },
    actorId: 'u1',
    orgId: 'o1',
    spaceId: 's1',
    action: 'read'
  };
  return {
    ...base,
    ...overrides,
    membership: { ...base.membership, ...(overrides.membership || {}) }
  };
}

function expectCode(result, code) {
  assert.equal(typeof result.allowed, 'boolean', 'allowed must be a boolean');
  assert.equal(typeof result.code, 'string', 'code must be a string');
  assert.equal(result.code, code, `expected code ${code}, got ${result.code}`);
  assert.equal(result.allowed, code === 'OK', `allowed must be ${code === 'OK'} for code ${code}`);
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test('viewer is allowed every viewer action', () => {
  for (const action of VIEWER) expectCode(authorize(input({ action })), 'OK');
});

test('viewer is denied editor and owner actions', () => {
  for (const action of [...EDITOR, ...OWNER]) expectCode(authorize(input({ action })), 'ROLE');
});

test('editor inherits viewer actions and is allowed every editor action', () => {
  for (const action of [...VIEWER, ...EDITOR]) {
    expectCode(authorize(input({ action, membership: { role: 'editor' } })), 'OK');
  }
});

test('editor is denied owner-only actions', () => {
  for (const action of OWNER) {
    expectCode(authorize(input({ action, membership: { role: 'editor' } })), 'ROLE');
  }
});

test('owner is allowed every documented action', () => {
  for (const action of ALL) {
    expectCode(authorize(input({ action, membership: { role: 'owner' } })), 'OK');
  }
});

test('unknown action yields ACTION even for an owner', () => {
  for (const action of ['publish', 'destroy', 'Admin']) {
    expectCode(authorize(input({ action, membership: { role: 'owner' } })), 'ACTION');
  }
});

test('missing input or membership is INVALID', () => {
  expectCode(authorize(), 'INVALID');
  expectCode(authorize(null), 'INVALID');
  expectCode(authorize({}), 'INVALID');
  expectCode(authorize({ ...input(), membership: null }), 'INVALID');
});

test('missing required fields are INVALID', () => {
  const actor = input();
  delete actor.actorId;
  delete actor.membership.userId;

  const org = input();
  delete org.orgId;
  delete org.membership.orgId;

  const space = input();
  delete space.spaceId;
  delete space.membership.spaceId;

  const action = input();
  delete action.action;

  const role = input();
  delete role.membership.role;

  const status = input();
  delete status.membership.status;

  const version = input();
  delete version.membership.version;

  for (const value of [actor, org, space, action, role, status, version]) {
    expectCode(authorize(value), 'INVALID');
  }
});

test('malformed identifiers are INVALID', () => {
  for (const bad of ['', ' ', '-x', 'a b', 123, null, 'x'.repeat(81)]) {
    for (const [top, member] of [['actorId', 'userId'], ['orgId', 'orgId'], ['spaceId', 'spaceId']]) {
      const overrides = { [top]: bad, membership: { [member]: bad } };
      expectCode(authorize(input(overrides)), 'INVALID');
    }
  }
});

test('malformed version is INVALID', () => {
  for (const version of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    expectCode(authorize(input({ membership: { version } })), 'INVALID');
  }
});

test('invalid role is INVALID', () => {
  for (const role of ['admin', 'Owner', '', 'owner ', null, 42]) {
    expectCode(authorize(input({ membership: { role } })), 'INVALID');
  }
});

test('inactive membership is REVOKED regardless of role or action', () => {
  expectCode(authorize(input({ membership: { status: 'inactive' } })), 'REVOKED');
  expectCode(authorize(input({ action: 'manage', membership: { role: 'owner', status: 'inactive' } })), 'REVOKED');
});

test('actor mismatch is SCOPE', () => {
  expectCode(authorize(input({ actorId: 'u2' })), 'SCOPE');
});

test('org mismatch is SCOPE on either side of the comparison', () => {
  expectCode(authorize(input({ orgId: 'o2' })), 'SCOPE');
  expectCode(authorize(input({ membership: { orgId: 'o2' } })), 'SCOPE');
});

test('space mismatch is SCOPE on either side of the comparison', () => {
  expectCode(authorize(input({ spaceId: 's2' })), 'SCOPE');
  expectCode(authorize(input({ membership: { spaceId: 's2' } })), 'SCOPE');
});

test('online or login flags cannot bypass role checks', () => {
  expectCode(authorize(input({ action: 'edit', online: true, loggedIn: true, session: 'live' })), 'ROLE');
  expectCode(authorize(input({ action: 'manage', online: true, loggedIn: true })), 'ROLE');
});

test('does not mutate the supplied input', () => {
  const value = input({ action: 'manage', membership: { role: 'owner' } });
  const snapshot = structuredClone(value);
  expectCode(authorize(value), 'OK');
  assert.deepEqual(value, snapshot, 'input was mutated');

  const frozen = deepFreeze(input({ action: 'read' }));
  expectCode(authorize(frozen), 'OK');
});
