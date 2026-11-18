import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { LabAuthority } from '../src/authority.mjs';
import { fixtureDoc } from '../src/schema.mjs';

const OPTIONS = { orgId: 'org1', spaceId: 'space1', epoch: 'epoch1', ownerId: 'owner' };
const AUTHORITY_URL = new URL('../src/authority.mjs', import.meta.url).href;
const SCHEMA_URL = new URL('../src/schema.mjs', import.meta.url).href;
const CAPTURE_LIMIT = 16 * 1024;
const CHILD_TIMEOUT_MS = 7000;

const CRASH_SOURCE = `
import { writeSync } from 'node:fs';
const authorityUrl = process.argv[1];
const schemaUrl = process.argv[2];
const dbPath = process.argv[3];
const mode = process.argv[4];
const { LabAuthority } = await import(authorityUrl);
const { fixtureDoc } = await import(schemaUrl);
const options = { orgId: 'org1', spaceId: 'space1', epoch: 'epoch1', ownerId: 'owner' };
const command = {
  opId: 'op1', actorId: 'owner', orgId: 'org1', spaceId: 'space1',
  docId: 'doc1', incarnation: 'gen1', kind: 'create', baseVersion: 0,
  payload: { document: fixtureDoc() },
};
const authority = new LabAuthority(dbPath, options);
const hook = () => {
  writeSync(1, 'READY\\n');
  const gate = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(gate, 0, 0);
};
authority.submit('owner', command, { [mode]: hook });
writeSync(1, 'NO_HOOK\\n');
`;

const makeCommand = (opId, docId, overrides = {}) => ({
  opId, actorId: 'owner', orgId: 'org1', spaceId: 'space1', docId,
  incarnation: 'gen1', kind: 'create', baseVersion: 0,
  payload: { document: fixtureDoc() }, ...overrides,
});

function tempFile(t) {
  const directory = mkdtempSync(join(tmpdir(), 'authority-faults-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'lab.sqlite');
}

function open(t, file) {
  const authority = new LabAuthority(file, OPTIONS);
  t.after(() => { try { authority.close(); } catch {} });
  return authority;
}

function direct(file, work) {
  const db = new DatabaseSync(file);
  try { return work(db); } finally { db.close(); }
}

const appendCapped = (current, chunk) =>
  current.length >= CAPTURE_LIMIT ? current : (current + chunk).slice(0, CAPTURE_LIMIT);

function runCrash(t, file, mode) {
  const child = spawn(process.execPath, [
    '--input-type=module', '--eval', CRASH_SOURCE,
    AUTHORITY_URL, SCHEMA_URL, file, mode,
  ], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let stdout = '';
  let stderr = '';
  let killed = false;
  let timedOut = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    try { child.kill('SIGKILL'); } catch {}
  };
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  child.stdout.on('data', chunk => {
    stdout = appendCapped(stdout, chunk.toString());
    if (stdout.includes('READY')) kill();
  });
  child.stderr.on('data', chunk => { stderr = appendCapped(stderr, chunk.toString()); });
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { timedOut = true; kill(); }, CHILD_TIMEOUT_MS);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`child timed out; stderr=${stderr}`));
      if (!killed) return reject(new Error(`child exited before READY (code=${code}, signal=${signal}); stderr=${stderr}`));
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

test('beforeCommit crash leaves no document, receipt, event, or audit', async t => {
  const file = tempFile(t);
  const crashed = await runCrash(t, file, 'beforeCommit');
  assert.match(crashed.stdout, /READY/);
  assert.equal(crashed.signal, 'SIGKILL');
  const authority = open(t, file);
  assert.deepEqual(authority.readDocument('owner', 'doc1'), { ok: false, code: 'MISSING' });
  assert.deepEqual(authority.lookupReceipt('owner', 'op1'), { ok: false, code: 'MISSING' });
  assert.equal(authority.inspect('owner').eventCount, 0);
  assert.deepEqual(authority.auditEvents(), []);
});

test('afterCommit crash retains doc, receipt, audit, and event; replay is duplicate', async t => {
  const file = tempFile(t);
  const crashed = await runCrash(t, file, 'afterCommit');
  assert.match(crashed.stdout, /READY/);
  assert.equal(crashed.signal, 'SIGKILL');
  const authority = open(t, file);
  const document = authority.readDocument('owner', 'doc1');
  assert.equal(document.ok, true);
  assert.equal(document.document.version, 1);
  const receipt = authority.lookupReceipt('owner', 'op1');
  assert.equal(receipt.ok, true);
  assert.equal(receipt.receipt.opId, 'op1');
  assert.equal(authority.inspect('owner').eventCount, 1);
  assert.equal(authority.auditEvents().length, 1);
  const replay = authority.submit('owner', makeCommand('op1', 'doc1'));
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(authority.inspect('owner').eventCount, 1);
  assert.equal(authority.auditEvents().length, 1);
  assert.equal(authority.readDocument('owner', 'doc1').document.version, 1);
});

test('two independently opened authorities with stale versions: one wins, one conflicts', async t => {
  const file = tempFile(t);
  const first = open(t, file);
  const second = open(t, file);
  assert.equal(first.submit('owner', makeCommand('opA', 'doc1')).ok, true);
  const conflict = second.submit('owner', makeCommand('opB', 'doc1'));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'CONFLICT');
  const check = open(t, file);
  assert.equal(check.inspect('owner').eventCount, 1);
  assert.equal(check.auditEvents().length, 1);
  assert.equal(check.lookupReceipt('owner', 'opA').ok, true);
  assert.equal(check.lookupReceipt('owner', 'opB').ok, false);
  assert.equal(check.readDocument('owner', 'doc1').document.version, 1);
});

test('revoked user receipt and command retry are denied after reopen', async t => {
  const file = tempFile(t);
  const seed = open(t, file);
  assert.equal(seed.submit('owner', makeCommand('op1', 'doc1')).ok, true);
  seed.close();
  direct(file, db => {
    const member = JSON.parse(db.prepare('SELECT record FROM members WHERE user_id=?').get('owner').record);
    member.status = 'revoked';
    db.prepare('UPDATE members SET record=? WHERE user_id=?').run(JSON.stringify(member), 'owner');
  });
  const reopened = open(t, file);
  assert.equal(reopened.lookupReceipt('owner', 'op1').ok, false);
  const retry = reopened.submit('owner', makeCommand('op1', 'doc1'));
  assert.equal(retry.ok, false);
  assert.notEqual(retry.duplicate, true);
  const state = direct(file, db => ({
    events: db.prepare('SELECT COUNT(*) AS n FROM events').get().n,
    receipts: db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n,
    documents: db.prepare('SELECT COUNT(*) AS n FROM documents').get().n,
    audit: db.prepare('SELECT COUNT(*) AS n FROM audit').get().n,
    version: JSON.parse(db.prepare('SELECT record FROM documents WHERE doc_id=?').get('doc1').record).version,
  }));
  assert.deepEqual(state, { events: 1, receipts: 1, documents: 1, audit: 1, version: 1 });
});

test('corrupted local audit blocks write without applying new effects', async t => {
  const file = tempFile(t);
  const seed = open(t, file);
  assert.equal(seed.submit('owner', makeCommand('op1', 'doc1')).ok, true);
  seed.close();
  direct(file, db => db.prepare('UPDATE audit SET record=? WHERE seq=1').run('NOT_JSON'));
  const authority = open(t, file);
  assert.throws(() => authority.submit('owner', makeCommand('op2', 'doc2')));
  assert.equal(authority.readDocument('owner', 'doc1').ok, true);
  assert.deepEqual(authority.readDocument('owner', 'doc2'), { ok: false, code: 'MISSING' });
  assert.equal(authority.lookupReceipt('owner', 'op1').ok, true);
  assert.deepEqual(authority.lookupReceipt('owner', 'op2'), { ok: false, code: 'MISSING' });
  const state = direct(file, db => ({
    audit: db.prepare('SELECT record FROM audit WHERE seq=1').get().record,
    events: db.prepare('SELECT COUNT(*) AS n FROM events').get().n,
    receipts: db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n,
    documents: db.prepare('SELECT COUNT(*) AS n FROM documents').get().n,
    doc2: db.prepare('SELECT COUNT(*) AS n FROM documents WHERE doc_id=?').get('doc2').n,
  }));
  assert.deepEqual(state, { audit: 'NOT_JSON', events: 1, receipts: 1, documents: 1, doc2: 0 });
});
