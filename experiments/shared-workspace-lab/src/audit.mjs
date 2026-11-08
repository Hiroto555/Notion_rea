import { isId, cloneJson, hashJson } from './contracts.mjs';

const ZERO_HASH = '0'.repeat(64);
export const MAX_AUDIT_RECORDS = 10000;
const MAX_RECORDS = MAX_AUDIT_RECORDS;
const RAW_FIELDS = ['actorId', 'orgId', 'spaceId', 'action', 'opId', 'time', 'result'];
const RECORD_FIELDS = ['seq', 'prevHash', 'hash', ...RAW_FIELDS];
const HASH_RE = /^[0-9a-f]{64}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(value, fields) {
  const keys = Object.keys(value);
  if (keys.length !== fields.length) return false;
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) return false;
  }
  return true;
}

function pickRaw(event) {
  const raw = {};
  for (const field of RAW_FIELDS) raw[field] = event[field];
  return raw;
}

function validateRaw(event) {
  if (!isPlainObject(event)) throw new Error('event must be a plain object');
  if (Object.getOwnPropertySymbols(event).length !== 0) throw new Error('symbol fields are not allowed');
  if (!hasExactKeys(event, RAW_FIELDS)) {
    throw new Error(`event fields must be exactly: ${RAW_FIELDS.join(', ')}`);
  }
  for (const field of ['actorId', 'orgId', 'spaceId', 'opId']) {
    if (!isId(event[field])) throw new Error(`${field} must be a valid id`);
  }
  if (!isId(event.action)) throw new Error('action must be a valid ASCII identifier (max 80)');
  if (!isId(event.result)) throw new Error('result must be a valid ASCII identifier (max 80)');
  if (typeof event.time !== 'string' || !TIME_RE.test(event.time)) {
    throw new Error('time must be a strict ISO timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)');
  }
  const date = new Date(event.time);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== event.time) {
    throw new Error('time must be a valid normalized ISO timestamp');
  }
  return pickRaw(event);
}

function verifyRecord(record, index, prevHash) {
  if (!isPlainObject(record)) return { index, code: 'INVALID' };
  if (Object.getOwnPropertySymbols(record).length !== 0) return { index, code: 'INVALID' };
  if (!hasExactKeys(record, RECORD_FIELDS)) return { index, code: 'INVALID' };

  if (!Number.isSafeInteger(record.seq)) return { index, code: 'INVALID' };
  if (record.seq !== index + 1) return { index, code: 'CHAIN' };

  if (typeof record.prevHash !== 'string' || !HASH_RE.test(record.prevHash)) {
    return { index, code: 'INVALID' };
  }
  if (record.prevHash !== prevHash) return { index, code: 'CHAIN' };

  if (typeof record.hash !== 'string' || !HASH_RE.test(record.hash)) {
    return { index, code: 'INVALID' };
  }

  const { hash, ...unsigned } = record;
  let expected;
  try {
    expected = hashJson(unsigned);
  } catch {
    return { index, code: 'INVALID' };
  }
  if (expected !== hash) return { index, code: 'CHAIN' };

  try {
    validateRaw(pickRaw(record));
  } catch {
    return { index, code: 'INVALID' };
  }
  return null;
}

export function appendAudit(events, event) {
  const checked = verifyAudit(events);
  if (!checked.ok) {
    throw new Error(`invalid audit chain at index ${checked.index} (${checked.code})`);
  }
  if (events.length >= MAX_RECORDS) throw new Error('audit chain limit reached');
  validateRaw(event);

  const prevHash = events.length === 0 ? ZERO_HASH : events[events.length - 1].hash;
  const seq = events.length + 1;
  const unsigned = { seq, prevHash, ...event };
  const record = { seq, prevHash, hash: hashJson(unsigned), ...event };

  const next = events.map((entry) => cloneJson(entry));
  next.push(record);
  return next;
}

export function verifyAudit(events) {
  if (!Array.isArray(events)) return { ok: false, index: 0, code: 'INVALID' };
  if (events.length > MAX_RECORDS) return { ok: false, index: 0, code: 'INVALID' };

  let prevHash = ZERO_HASH;
  for (let index = 0; index < events.length; index += 1) {
    const failure = verifyRecord(events[index], index, prevHash);
    if (failure) return { ok: false, ...failure };
    prevHash = events[index].hash;
  }
  return { ok: true };
}
