import { isId } from './contracts.mjs';

const KINDS = new Set(['edit', 'delete', 'restore']);
const isVersion = value => Number.isSafeInteger(value) && value >= 0;
const fail = code => ({ allowed: false, code });

function validCurrent(current) {
 return current !== null && typeof current === 'object' &&
  isId(current.incarnation) &&
  typeof current.deleted === 'boolean' &&
  isVersion(current.version);
}

function validRequest(request) {
 if(request === null || typeof request !== 'object') return false;
 if(!isId(request.incarnation)) return false;
 if(!KINDS.has(request.kind)) return false;
 if(!isVersion(request.baseVersion)) return false;
 if(request.newIncarnation !== undefined && !isId(request.newIncarnation)) return false;
 return true;
}

function nextState(incarnation, deleted, version) {
 const nextVersion = version + 1;
 if(!isVersion(nextVersion)) return fail('INVALID');
 return { allowed: true, code: 'OK', next: { incarnation, deleted, version: nextVersion } };
}

export function decideLifecycle(input) {
 if(input === null || typeof input !== 'object') return fail('INVALID');
 const { current, request } = input;
 if(!validCurrent(current) || !validRequest(request)) return fail('INVALID');
 if(request.incarnation !== current.incarnation) return fail('STALE_GENERATION');
 if(request.baseVersion !== current.version) return fail('CONFLICT');

 if(request.kind === 'edit') {
  if(current.deleted) return fail('DELETED');
  return nextState(current.incarnation, false, current.version);
 }

 if(request.kind === 'delete') {
  if(current.deleted) return fail('DELETED');
  return nextState(current.incarnation, true, current.version);
 }

 if(!current.deleted) return fail('LIVE');
 if(!isId(request.newIncarnation) || request.newIncarnation === current.incarnation) return fail('INVALID');
 return nextState(request.newIncarnation, false, current.version);
}
