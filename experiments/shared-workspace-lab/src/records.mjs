import { canonicalJson, cloneJson, isId, invalid } from './contracts.mjs';

const ACTIONS = new Set(['create', 'patch', 'delete', 'restore']);
const TYPES = new Set(['text', 'number', 'checkbox']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPositiveInt = value => Number.isSafeInteger(value) && value > 0;

function isValidValue(type, value) {
 if (value === null) return true;
 if (type === 'text') return typeof value === 'string' && value.length <= 10000;
 if (type === 'number') return typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
 return typeof value === 'boolean';
}

function validateValues(values, types) {
 if (!isObject(values)) return false;
 for (const key of Object.keys(values)) {
  if (!types.has(key) || !isValidValue(types.get(key), values[key])) return false;
 }
 return true;
}

export function validateRecordState(state) {
 if (!isObject(state)) return false;
 try { canonicalJson(state); } catch { return false; }
 if (!isId(state.databaseId) || !isPositiveInt(state.schemaVersion)) return false;
 if (!Array.isArray(state.properties) || state.properties.length > 100) return false;
 if (!Array.isArray(state.records) || state.records.length > 10000) return false;
 const types = new Map();
 for (const property of state.properties) {
  if (!isObject(property) || !isId(property.id) || !TYPES.has(property.type) || types.has(property.id)) return false;
  types.set(property.id, property.type);
 }
 const ids = new Set();
 for (const record of state.records) {
  if (!isObject(record) || !isId(record.id) || ids.has(record.id)) return false;
  ids.add(record.id);
  if (!isPositiveInt(record.version) || typeof record.deleted !== 'boolean') return false;
  if (!validateValues(record.values, types)) return false;
 }
 return true;
}

function validateCommand(command) {
 if (!isObject(command)) return false;
 if (!isId(command.databaseId) || !isId(command.recordId)) return false;
 if (!isPositiveInt(command.schemaVersion)) return false;
 if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0) return false;
 if (!ACTIONS.has(command.action)) return false;
 if (command.values !== undefined) {
  if (!isObject(command.values)) return false;
  try { canonicalJson(command.values); } catch { return false; }
 }
 return true;
}

export function applyRecordCommand(state, command) {
 if (!validateRecordState(state) || !validateCommand(command)) return invalid('INVALID');
 if (command.databaseId !== state.databaseId) return invalid('SCOPE');
 if (command.schemaVersion !== state.schemaVersion) return invalid('SCHEMA');

 const types = new Map(state.properties.map(property => [property.id, property.type]));
 let values;
 if (command.action === 'create') {
  values = command.values === undefined ? {} : command.values;
  if (!validateValues(values, types)) return invalid('INVALID');
 } else if (command.action === 'patch') {
  if (!isObject(command.values) || !validateValues(command.values, types)) return invalid('INVALID');
 } else if (command.values !== undefined && !validateValues(command.values, types)) {
  return invalid('INVALID');
 }

 const next = cloneJson(state);
 const index = next.records.findIndex(record => record.id === command.recordId);

 if (command.action === 'create') {
  if (index !== -1 || command.expectedVersion !== 0) return invalid('CONFLICT');
  if (next.records.length >= 10000) return invalid('INVALID');
  next.records.push({ id: command.recordId, version: 1, deleted: false, values: cloneJson(values) });
  return { ok: true, state: next };
 }

 if (index === -1) return invalid('MISSING');
 const record = next.records[index];
 if (command.expectedVersion !== record.version) return invalid('CONFLICT');
 if (command.action === 'patch' || command.action === 'delete') {
  if (record.deleted) return invalid('DELETED');
 } else if (!record.deleted) {
  return invalid('LIVE');
 }
 if (record.version === Number.MAX_SAFE_INTEGER) return invalid('INVALID');

 if (command.action === 'patch') {
  record.values = { ...record.values, ...cloneJson(command.values) };
 } else if (command.action === 'delete') {
  record.deleted = true;
 } else {
  record.deleted = false;
 }
 record.version += 1;
 return { ok: true, state: next };
}
