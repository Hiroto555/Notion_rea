import { isId } from './contracts.mjs';

const VIEWER_ACTIONS = new Set(['read', 'subscribe', 'receipt', 'assetRead']);
const EDITOR_ACTIONS = new Set([...VIEWER_ACTIONS, 'edit', 'create', 'delete', 'assetWrite']);
const OWNER_ACTIONS = new Set([...EDITOR_ACTIONS, 'restore', 'invite', 'manage', 'backup']);
const ROLE_ACTIONS = { viewer: VIEWER_ACTIONS, editor: EDITOR_ACTIONS, owner: OWNER_ACTIONS };

const deny = code => ({ allowed: false, code });

export function authorize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return deny('INVALID');
  const membership = input.membership;
  if (!membership || typeof membership !== 'object' || Array.isArray(membership)) return deny('INVALID');

  const { userId, orgId, spaceId, role, status, version } = membership;
  const { actorId, orgId: actorOrgId, spaceId: actorSpaceId, action } = input;

  if (
    !isId(userId) || !isId(orgId) || !isId(spaceId) ||
    !isId(actorId) || !isId(actorOrgId) || !isId(actorSpaceId)
  ) return deny('INVALID');
  if (!Object.hasOwn(ROLE_ACTIONS, role)) return deny('INVALID');
  if (typeof status !== 'string') return deny('INVALID');
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version <= 0) return deny('INVALID');
  if (typeof action !== 'string') return deny('INVALID');

  if (status !== 'active') return deny('REVOKED');
  if (userId !== actorId || orgId !== actorOrgId || spaceId !== actorSpaceId) return deny('SCOPE');
  if (!OWNER_ACTIONS.has(action)) return deny('ACTION');
  if (!ROLE_ACTIONS[role].has(action)) return deny('ROLE');
  return { allowed: true, code: 'OK' };
}
