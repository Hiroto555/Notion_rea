import { isId } from './contracts.mjs';

const ROLES = new Set(['owner', 'editor', 'viewer']);
const STATUSES = new Set(['invited', 'active', 'revoked']);
const ACTIONS = new Set(['invite', 'setRole', 'revoke', 'activate']);

const fail = code => ({ ok: false, code });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isExistingVersion = value => Number.isSafeInteger(value) && value > 0;
const isExpectedVersion = value => Number.isSafeInteger(value) && value >= 0;

function isMember(member) {
  return isObject(member) &&
    isId(member.userId) &&
    isId(member.orgId) &&
    ROLES.has(member.role) &&
    STATUSES.has(member.status) &&
    isExistingVersion(member.version);
}

export function applyMembershipChange(members, change) {
  if (!Array.isArray(members)) return fail('INVALID');

  const seen = new Set();
  for (const member of members) {
    if (!isMember(member)) return fail('INVALID');
    const key = member.orgId + '\u0000' + member.userId;
    if (seen.has(key)) return fail('INVALID');
    seen.add(key);
  }

  if (!isObject(change)) return fail('INVALID');
  const { actorId, orgId, targetId, action, expectedVersion } = change;
  if (!isId(actorId) || !isId(orgId) || !isId(targetId)) return fail('INVALID');
  if (!ACTIONS.has(action)) return fail('INVALID');
  if (!isExpectedVersion(expectedVersion)) return fail('INVALID');
  if (change.role !== undefined && !ROLES.has(change.role)) return fail('INVALID');
  if ((action === 'invite' || action === 'setRole') && !ROLES.has(change.role)) return fail('INVALID');

  const actor = members.find(m => m.orgId === orgId && m.userId === actorId);
  if (!actor || actor.role !== 'owner' || actor.status !== 'active') return fail('FORBIDDEN');

  const targetIndex = members.findIndex(m => m.orgId === orgId && m.userId === targetId);

  if (action === 'invite') {
    if (targetIndex !== -1) return fail('CONFLICT');
    if (expectedVersion !== 0) return fail('CONFLICT');
    const next = members.map(m => ({ ...m }));
    next.push({ userId: targetId, orgId, role: change.role, status: 'invited', version: 1 });
    return { ok: true, members: next };
  }

  if (targetIndex === -1) return fail('MISSING');
  const target = members[targetIndex];
  if (target.version !== expectedVersion) return fail('CONFLICT');

  if (action === 'activate' && target.status !== 'invited') return fail('STATE');
  if (target.version === Number.MAX_SAFE_INTEGER) return fail('INVALID');

  const nextRole = action === 'setRole' ? change.role : target.role;
  const removesActiveOwner = target.status === 'active' && target.role === 'owner' &&
    (action === 'revoke' || (action === 'setRole' && nextRole !== 'owner'));

  if (removesActiveOwner) {
    const activeOwners = members.filter(m =>
      m.orgId === orgId && m.role === 'owner' && m.status === 'active').length;
    if (activeOwners <= 1) return fail('LAST_OWNER');
  }

  const next = members.map(m => ({ ...m }));
  const updated = next[targetIndex];
  if (action === 'setRole') updated.role = nextRole;
  else if (action === 'revoke') updated.status = 'revoked';
  else if (action === 'activate') updated.status = 'active';
  updated.version = target.version + 1;

  return { ok: true, members: next };
}
