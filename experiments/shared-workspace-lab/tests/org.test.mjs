import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMembershipChange } from '../src/org.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const member = (userId, orgId, role, status, version) => ({ userId, orgId, role, status, version });
const req = over => ({ actorId: 'u1', orgId: 'o1', targetId: 'u2', action: 'invite', expectedVersion: 0, ...over });

test('invite creates an invited member at version 1 and preserves input', () => {
  const members = [member('u1', 'o1', 'owner', 'active', 1), member('u2', 'o1', 'editor', 'active', 4)];
  const before = copy(members);
  const change = req({ targetId: 'u3', role: 'viewer' });
  const changeBefore = copy(change);
  const result = applyMembershipChange(members, change);
  assert.equal(result.ok, true);
  assert.notEqual(result.members, members);
  const created = result.members.find(x => x.userId === 'u3');
  assert.equal(created.userId, 'u3');
  assert.equal(created.orgId, 'o1');
  assert.equal(created.role, 'viewer');
  assert.equal(created.status, 'invited');
  assert.equal(created.version, 1);
  assert.equal(result.members.length, members.length + 1);
  assert.deepEqual(result.members.find(x => x.userId === 'u2'), before[1]);
  assert.deepEqual(members, before);
  assert.deepEqual(change, changeBefore);
});
test('invite rejects an existing target and a nonzero expectedVersion', () => {
  const members = [member('u1', 'o1', 'owner', 'active', 1), member('u2', 'o1', 'editor', 'active', 3)];
  const before = copy(members);
  const existing = applyMembershipChange(members, req({ targetId: 'u2', role: 'viewer' }));
  assert.equal(existing.ok, false);
  assert.equal(typeof existing.code, 'string');
  assert.deepEqual(members, before);
  const versioned = applyMembershipChange(members, req({ targetId: 'u9', role: 'viewer', expectedVersion: 1 }));
  assert.equal(versioned.ok, false);
  assert.deepEqual(members, before);
});
test('invite requires a valid role', () => {
  const members = [member('u1', 'o1', 'owner', 'active', 1)];
  const changes = [
    req({ targetId: 'u9' }), req({ targetId: 'u9', role: null }),
    req({ targetId: 'u9', role: 'admin' }), req({ targetId: 'u9', role: 'OWNER' })
  ];
  for (const change of changes) {
    const result = applyMembershipChange(members, change);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID');
  }
});
test('actor must be an active owner in the same org', () => {
  const members = [
    member('u1', 'o1', 'owner', 'active', 1), member('u2', 'o1', 'editor', 'active', 1),
    member('u3', 'o1', 'owner', 'invited', 1), member('u6', 'o1', 'owner', 'revoked', 2),
    member('u4', 'o2', 'owner', 'active', 1)
  ];
  const before = copy(members);
  for (const actorId of ['u2', 'u3', 'u6', 'u4', 'u9']) {
    const result = applyMembershipChange(members, req({ actorId, targetId: 'u5', role: 'viewer' }));
    assert.equal(result.ok, false, actorId);
    assert.equal(result.code, 'FORBIDDEN', actorId);
  }
  assert.deepEqual(members, before);
});
test('setRole changes a role and increments version', () => {
  const members = [member('u1', 'o1', 'owner', 'active', 1), member('u2', 'o1', 'editor', 'active', 3), member('u3', 'o1', 'viewer', 'active', 1)];
  const before = copy(members);
  const result = applyMembershipChange(members, req({ action: 'setRole', targetId: 'u2', expectedVersion: 3, role: 'viewer' }));
  assert.equal(result.ok, true);
  const updated = result.members.find(x => x.userId === 'u2');
  assert.equal(updated.role, 'viewer');
  assert.equal(updated.version, 4);
  assert.deepEqual(result.members.find(x => x.userId === 'u1'), before[0]);
  assert.deepEqual(result.members.find(x => x.userId === 'u3'), before[2]);
  assert.deepEqual(members, before);
});
test('existing-target actions report MISSING for an absent target', () => {
  const members = [member('u1', 'o1', 'owner', 'active', 1)];
  for (const action of ['setRole', 'revoke', 'activate']) {
    const change = req({ action, targetId: 'u9', expectedVersion: 1 });
    if (action === 'setRole') change.role = 'viewer';
    const result = applyMembershipChange(members, change);
    assert.equal(result.ok, false, action);
    assert.equal(result.code, 'MISSING', action);
  }
});
test('existing-target actions report CONFLICT on version mismatch', () => {
  const members = [member('u1', 'o1', 'owner', 'active', 1), member('u2', 'o1', 'viewer', 'invited', 3)];
  for (const action of ['setRole', 'revoke', 'activate']) {
    const change = req({ action, targetId: 'u2', expectedVersion: 2 });
    if (action === 'setRole') change.role = 'viewer';
    const result = applyMembershipChange(members, change);
    assert.equal(result.ok, false, action);
    assert.equal(result.code, 'CONFLICT', action);
  }
});
test('setRole rejects an invalid role', () => {
  const members = [member('u1', 'o1', 'owner', 'active', 1), member('u2', 'o1', 'editor', 'active', 3)];
  const changes = [
    req({ action: 'setRole', targetId: 'u2', expectedVersion: 3 }),
    req({ action: 'setRole', targetId: 'u2', expectedVersion: 3, role: 'admin' }),
    req({ action: 'setRole', targetId: 'u2', expectedVersion: 3, role: '' })
  ];
  for (const change of changes) {
    const result = applyMembershipChange(members, change);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID');
  }
});
test('demoting the last active owner is rejected even with non-active owners', () => {
  const members = [
    member('u1', 'o1', 'owner', 'active', 1), member('u2', 'o1', 'owner', 'invited', 1),
    member('u6', 'o1', 'owner', 'revoked', 2), member('u3', 'o1', 'editor', 'active', 1)
  ];
  const before = copy(members);
  const result = applyMembershipChange(members, req({ action: 'setRole', targetId: 'u1', expectedVersion: 1, role: 'editor' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LAST_OWNER');
  assert.deepEqual(members, before);
});
test('revoke marks an existing member revoked and increments version', () => {
  const members = [member('u1', 'o1', 'owner', 'active', 1), member('u2', 'o1', 'editor', 'active', 2)];
  const before = copy(members);
  const result = applyMembershipChange(members, req({ action: 'revoke', targetId: 'u2', expectedVersion: 2 }));
  assert.equal(result.ok, true);
  const updated = result.members.find(x => x.userId === 'u2');
  assert.equal(updated.status, 'revoked');
  assert.equal(updated.version, 3);
  assert.deepEqual(members, before);
});
test('revoking the last active owner is rejected, including self-revoke', () => {
  const members = [member('u1', 'o1', 'owner', 'active', 1), member('u2', 'o1', 'editor', 'active', 1)];
  const before = copy(members);
  const result = applyMembershipChange(members, req({ action: 'revoke', actorId: 'u1', targetId: 'u1', expectedVersion: 1 }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LAST_OWNER');
  assert.deepEqual(members, before);
});
test('activate promotes an invited member to active and increments version', () => {
  const members = [member('u1', 'o1', 'owner', 'active', 1), member('u2', 'o1', 'viewer', 'invited', 1)];
  const before = copy(members);
  const result = applyMembershipChange(members, req({ action: 'activate', targetId: 'u2', expectedVersion: 1 }));
  assert.equal(result.ok, true);
  const updated = result.members.find(x => x.userId === 'u2');
  assert.equal(updated.status, 'active');
  assert.equal(updated.version, 2);
  assert.deepEqual(members, before);
});
test('activate rejects members that are not invited', () => {
  const members = [member('u1', 'o1', 'owner', 'active', 1), member('u2', 'o1', 'editor', 'active', 5), member('u3', 'o1', 'viewer', 'revoked', 2)];
  const before = copy(members);
  for (const targetId of ['u2', 'u3']) {
    const version = before.find(x => x.userId === targetId).version;
    const result = applyMembershipChange(members, req({ action: 'activate', targetId, expectedVersion: version }));
    assert.equal(result.ok, false, targetId);
    assert.equal(result.code, 'STATE', targetId);
  }
  assert.deepEqual(members, before);
});
test('changes do not affect members of other orgs', () => {
  const members = [
    member('u1', 'o1', 'owner', 'active', 1), member('u2', 'o1', 'editor', 'active', 2),
    member('u9', 'o2', 'owner', 'active', 1), member('u10', 'o2', 'editor', 'active', 7)
  ];
  const before = copy(members);
  const result = applyMembershipChange(members, req({ action: 'revoke', targetId: 'u2', expectedVersion: 2 }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.members.filter(x => x.orgId === 'o2'), before.filter(x => x.orgId === 'o2'));
  assert.deepEqual(members, before);
});
test('malformed existing membership is rejected as INVALID', () => {
  const change = req({ targetId: 'u2' });
  const bad = [
    [member('u1', 'o1', 'admin', 'active', 1)],
    [member('u1', 'o1', 'owner', 'pending', 1)],
    [member('u1', 'o1', 'owner', 'active', 0)],
    [member('u1', 'o1', 'owner', 'active', -1)],
    [member('u1', 'o1', 'owner', 'active', 1.5)],
    [member('u1', 'o1', 'owner', 'active', Number.MAX_SAFE_INTEGER + 1)],
    [member('bad id', 'o1', 'owner', 'active', 1)],
    [member('u1', '', 'owner', 'active', 1)],
    [member('u1', 'o1', 'owner', 'active', 1), member('u1', 'o1', 'editor', 'active', 1)],
    null
  ];
  for (const members of bad) {
    const result = applyMembershipChange(members, change);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID');
  }
});
test('malformed change requests are rejected as INVALID', () => {
  const members = [member('u1', 'o1', 'owner', 'active', 1)];
  const bad = [
    null, {},
    req({ action: 'delete' }),
    req({ targetId: 'u2', expectedVersion: -1, role: 'viewer' }),
    req({ targetId: 'u2', expectedVersion: 1.5, role: 'viewer' }),
    req({ targetId: 'u2', expectedVersion: Number.MAX_SAFE_INTEGER + 1, role: 'viewer' }),
    req({ targetId: 'u2', expectedVersion: '0', role: 'viewer' }),
    req({ targetId: 'u2', actorId: 'bad id', role: 'viewer' }),
    req({ targetId: 'u2', orgId: '', role: 'viewer' }),
    req({ targetId: 'bad id', role: 'viewer' })
  ];
  for (const change of bad) {
    const result = applyMembershipChange(members, change);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INVALID');
  }
});
test('version increment overflow is rejected as INVALID', () => {
  const members = [member('u1', 'o1', 'owner', 'active', 1), member('u2', 'o1', 'editor', 'active', Number.MAX_SAFE_INTEGER)];
  const before = copy(members);
  const result = applyMembershipChange(members, req({ action: 'revoke', targetId: 'u2', expectedVersion: Number.MAX_SAFE_INTEGER }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID');
  assert.deepEqual(members, before);
});
