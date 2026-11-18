import { isId, canonicalJson, cloneJson, hashJson, invalid } from './contracts.mjs';

const KINDS = new Set(['edit', 'create', 'delete', 'restore']);
const ID_FIELDS = ['opId', 'actorId', 'orgId', 'spaceId', 'docId', 'incarnation'];

const isPlainObject = value =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export function validateCommand(value, { maxBytes = 1048576 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return invalid('INVALID');

  let canonical;
  try {
    canonical = canonicalJson(value);
  } catch {
    return invalid('INVALID');
  }

  if (Buffer.byteLength(canonical, 'utf8') > maxBytes) return invalid('TOO_LARGE');

  if (!isPlainObject(value)) return invalid('INVALID');
  for (const field of ID_FIELDS) if (!isId(value[field])) return invalid('INVALID');
  if (!KINDS.has(value.kind)) return invalid('INVALID');
  if (!Number.isSafeInteger(value.baseVersion) || value.baseVersion < 0) return invalid('INVALID');
  if (!Array.isArray(value.payload) && !isPlainObject(value.payload)) return invalid('INVALID');

  return {
    ok: true,
    command: cloneJson(value),
    fingerprint: hashJson(value)
  };
}
