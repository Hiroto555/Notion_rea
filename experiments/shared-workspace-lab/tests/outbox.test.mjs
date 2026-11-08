import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LabOutbox } from '../src/outbox.mjs';
import { canonicalJson } from '../src/contracts.mjs';
const APP_ID = 1179406157;
const SCOPE = { orgId: 'org-a', spaceId: 'space-a', actorId: 'actor-a' };
const bytes = value => Buffer.byteLength(canonicalJson(value), 'utf8');
const command = (opId = 'op1', overrides = {}) => ({
  opId,
  orgId: 'org-a',
  spaceId: 'space-a',
  actorId: 'actor-a',
  docId: 'doc1',
  incarnation: 'gen1',
  kind: 'edit',
  baseVersion: 0,
  payload: { value: 'v' },
  ...overrides,
});
const receipt = (entry, overrides = {}) => ({
  opId: entry.opId,
  fingerprint: entry.fingerprint,
  orgId: 'org-a',
  spaceId: 'space-a',
  actorId: 'actor-a',
  serverSeq: 1,
  epoch: 'epoch1',
  ...overrides,
});
function tempFile(t) { const dir = mkdtempSync(join(tmpdir(), 'folio-outbox-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return join(dir, 'queue.db'); }
function open(t, file, options = {}) {
  const ob = new LabOutbox(file, { ...SCOPE, ...options });
  t.after(() => { try { ob.close(); } catch {} });
  return ob;
}
test('constructor creates a FULL, distinctly tagged outbox database', t => {
  const file = tempFile(t);
  const ob = open(t, file);
  ob.close();
  assert.ok(existsSync(file));
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  assert.equal(Number(db.prepare('PRAGMA application_id').get().application_id), APP_ID);
  assert.equal(Number(db.prepare('PRAGMA synchronous').get().synchronous), 2);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  assert.ok(tables.some(name => /outbox/i.test(name)), `missing outbox table in ${tables.join(',')}`);
});
test('reopen requires the exact scope and preserves a pending command unchanged', t => {
  const file = tempFile(t);
  const first = open(t, file);
  const cmd = command('op-reopen');
  assert.equal(first.enqueue(cmd).ok, true);
  first.close();
  assert.throws(() => new LabOutbox(file, { ...SCOPE, actorId: 'actor-b' }));
  const second = open(t, file);
  const read = second.read('op-reopen');
  assert.equal(read.ok, true);
  assert.deepEqual(read.entry.command, cmd);
  assert.equal(read.entry.stage, 'local');
  assert.equal(second.retryPlan('op-reopen').action, 'SEND');
});
test('refuses an unrelated existing database before writing schema', t => {
  const file = tempFile(t);
  const sentinel = new DatabaseSync(file);
  sentinel.exec("PRAGMA application_id = 424242; CREATE TABLE sentinel (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO sentinel(note) VALUES ('untouched');");
  sentinel.close();
  assert.throws(() => new LabOutbox(file, SCOPE));
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT note FROM sentinel WHERE id = 1').get().note, 'untouched');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  assert.ok(!tables.some(name => /outbox/i.test(name)));
  assert.equal(Number(db.prepare('PRAGMA application_id').get().application_id), 424242);
});
test('enqueue persists a local entry and returns an unchanged duplicate', t => {
  const ob = open(t, tempFile(t));
  const cmd = command('op-dup');
  const first = ob.enqueue(cmd);
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.deepEqual(first.entry.command, cmd);
  assert.equal(first.entry.stage, 'local');
  const again = ob.enqueue(cmd);
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  assert.deepEqual(again.entry, first.entry);
});
test('maxOperations counts every retained row and never evicts', t => {
  const ob = open(t, tempFile(t), { maxOperations: 1 });
  assert.equal(ob.enqueue(command('op-cap-1')).ok, true);
  const rejected = ob.enqueue(command('op-cap-2'));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'LIMIT');
  assert.equal(ob.read('op-cap-1').ok, true);
  assert.equal(ob.read('op-cap-2').code, 'MISSING');
  assert.equal(ob.enqueue(command('op-cap-1')).duplicate, true);
});
test('maxBytes admits an exact canonical command and rejects the next one', t => {
  const one = command('op-byte-1');
  const two = command('op-byte-2');
  const ob = open(t, tempFile(t), { maxBytes: bytes(one) });
  assert.equal(ob.enqueue(one).ok, true);
  const rejected = ob.enqueue(two);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'LIMIT');
  assert.deepEqual(ob.read('op-byte-1').entry.command, one);
});
test('same opId with a different fingerprint is OPERATION and leaves the original intact', t => {
  const ob = open(t, tempFile(t));
  const first = ob.enqueue(command('op-same'));
  const rejected = ob.enqueue(command('op-same', { payload: { value: 'changed' } }));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'OPERATION');
  assert.deepEqual(ob.read('op-same').entry, first.entry);
});
test('enqueue rejects a command from another scope without retaining it', t => {
  const ob = open(t, tempFile(t));
  const rejected = ob.enqueue(command('op-scope', { orgId: 'org-b' }));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'SCOPE');
  assert.equal(ob.read('op-scope').code, 'MISSING');
  assert.deepEqual(ob.listPending(), []);
});
test('read returns clones and distinguishes missing from invalid ids', t => {
  const ob = open(t, tempFile(t));
  const cmd = command('op-read');
  assert.equal(ob.enqueue(cmd).ok, true);
  const read = ob.read('op-read');
  assert.deepEqual(read.entry.command, cmd);
  read.entry.command = { tampered: true };
  read.entry.stage = 'tampered';
  const again = ob.read('op-read');
  assert.deepEqual(again.entry.command, cmd);
  assert.equal(again.entry.stage, 'local');
  assert.equal(ob.read('missing-op').code, 'MISSING');
  assert.equal(ob.read('bad id!').code, 'INVALID');
  assert.equal(ob.read(42).code, 'INVALID');
});
test('markUnknown keeps command and fingerprint and forces query-first', t => {
  const ob = open(t, tempFile(t));
  const original = ob.enqueue(command('op-unknown')).entry;
  assert.equal(ob.markUnknown('op-unknown').ok, true);
  const entry = ob.read('op-unknown').entry;
  assert.equal(entry.stage, 'unknown');
  assert.deepEqual(entry.command, original.command);
  assert.equal(entry.fingerprint, original.fingerprint);
  const plan = ob.retryPlan('op-unknown');
  assert.equal(plan.ok, true);
  assert.equal(plan.action, 'QUERY_FIRST');
});
test('UNKNOWN requires queryConfirmed and promotes only to server', t => {
  const ob = open(t, tempFile(t));
  const entry = ob.enqueue(command('op-no-query')).entry;
  assert.equal(ob.markUnknown('op-no-query').ok, true);
  const ordered = ob.confirm(receipt(entry));
  assert.equal(ordered.ok, false);
  assert.equal(ordered.code, 'ORDER');
  assert.equal(ob.read('op-no-query').entry.stage, 'unknown');
  assert.equal(ob.confirm(receipt(entry), { fromQuery: true }).ok, true);
  const promoted = ob.read('op-no-query').entry;
  assert.equal(promoted.stage, 'server');
  assert.equal(promoted.serverSeq, 1);
  assert.deepEqual(promoted.command, entry.command);
  assert.equal(ob.retryPlan('op-no-query').action, 'NONE');
});
test('confirm promotes a local entry to server and preserves identity', t => {
  const ob = open(t, tempFile(t));
  const entry = ob.enqueue(command('op-confirm-server')).entry;
  assert.equal(ob.confirm(receipt(entry)).ok, true);
  const stored = ob.read('op-confirm-server').entry;
  assert.equal(stored.stage, 'server');
  assert.equal(stored.serverSeq, 1);
  assert.deepEqual(stored.command, entry.command);
  assert.equal(stored.fingerprint, entry.fingerprint);
  assert.equal(stored.command.orgId, 'org-a');
  assert.equal(stored.command.spaceId, 'space-a');
  assert.equal(stored.command.actorId, 'actor-a');
  assert.equal(ob.retryPlan('op-confirm-server').action, 'NONE');
});
test('confirm distinguishes malformed, scope, fingerprint, and missing receipts', t => {
  const ob = open(t, tempFile(t));
  const entry = ob.enqueue(command('op-confirm')).entry;
  assert.equal(ob.confirm(receipt(entry, { serverSeq: 0 })).code, 'INVALID');
  assert.equal(ob.confirm(receipt(entry, { epoch: 1 })).code, 'INVALID');
  assert.equal(ob.confirm(receipt(entry, { orgId: 'org-b' })).code, 'SCOPE');
  assert.equal(ob.confirm(receipt(entry, { fingerprint: 'f'.repeat(64) })).code, 'OPERATION');
  assert.equal(ob.confirm(receipt(entry, { opId: 'op-missing' })).code, 'MISSING');
  assert.equal(ob.read('op-confirm').entry.stage, 'local');
});
test('listPending returns an array of local and unknown entries only', t => {
  const ob = open(t, tempFile(t));
  const first = ob.enqueue(command('op-pending-1')).entry;
  assert.equal(ob.enqueue(command('op-pending-2')).ok, true);
  assert.equal(ob.markUnknown('op-pending-2').ok, true);
  let pending = ob.listPending();
  assert.ok(Array.isArray(pending));
  assert.deepEqual(pending.map(entry => entry.opId).sort(), ['op-pending-1', 'op-pending-2']);
  assert.equal(ob.confirm(receipt(first)).ok, true);
  pending = ob.listPending();
  assert.ok(Array.isArray(pending));
  assert.deepEqual(pending.map(entry => entry.opId), ['op-pending-2']);
});
