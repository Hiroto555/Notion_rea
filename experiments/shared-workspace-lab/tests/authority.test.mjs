import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LabAuthority } from '../src/authority.mjs';
import { fixtureDoc } from '../src/schema.mjs';
import { hashJson } from '../src/contracts.mjs';
import { MAX_AUDIT_RECORDS } from '../src/audit.mjs';

const options = { orgId: 'org1', spaceId: 'space1', epoch: 'epoch1', ownerId: 'owner' };
function context(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'folio-shared-lab-test-'));
  const file = join(dir, 'laboratory.sqlite');
  const authority = new LabAuthority(file, { ...options, ...extra });
  let open = true;
  t.after(() => { if (open) authority.close(); rmSync(dir, { recursive: true, force: true }); });
  return { authority, file, close() { authority.close(); open = false; } };
}
function command(overrides = {}) {
  return { opId: 'op1', actorId: 'owner', orgId: 'org1', spaceId: 'space1', docId: 'doc1',
    incarnation: 'generation1', kind: 'create', baseVersion: 0, payload: { document: fixtureDoc() }, ...overrides };
}
function invite(authority, user = 'editor', role = 'editor') {
  assert.equal(authority.changeMembership('owner', { targetId: user, action: 'invite', role, expectedVersion: 0 }).ok, true);
  assert.equal(authority.changeMembership('owner', { targetId: user, action: 'activate', expectedVersion: 1 }).ok, true);
}

test('document, event, receipt, audit survive independent SQLite reopen', t => {
  const ctx = context(t);
  const result = ctx.authority.submit('owner', command());
  assert.equal(result.ok, true);
  assert.equal(result.receipt.stage, 'server');
  ctx.close();
  const reopened = new LabAuthority(ctx.file, options);
  try {
    assert.deepEqual(reopened.readDocument('owner', 'doc1').document.document, fixtureDoc());
    assert.deepEqual(reopened.lookupReceipt('owner', 'op1').receipt, result.receipt);
    assert.equal(reopened.inspect('owner').eventCount, 1);
    assert.deepEqual(reopened.inspect('owner').audit, { ok: true });
  } finally { reopened.close(); }
});

test('failure before commit rolls back document, receipt, event and audit', t => {
  const { authority } = context(t);
  assert.throws(() => authority.submit('owner', command(), { beforeCommit() { throw new Error('injected'); } }), /injected/);
  assert.equal(authority.readDocument('owner', 'doc1').code, 'MISSING');
  assert.equal(authority.lookupReceipt('owner', 'op1').code, 'MISSING');
  assert.equal(authority.inspect('owner').eventCount, 0);
  assert.equal(authority.auditEvents().length, 0);
  assert.equal(authority.submit('owner', command()).ok, true);
});

test('lost response after commit remains queryable and retry is idempotent', t => {
  const { authority } = context(t);
  const lost = authority.submit('owner', command(), { afterCommit() { throw new Error('lost response'); } });
  assert.equal(lost.code, 'UNKNOWN');
  assert.equal(authority.lookupReceipt('owner', 'op1').receipt.stage, 'server');
  const retry = authority.submit('owner', command());
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicate, true);
  assert.equal(authority.inspect('owner').eventCount, 1);
  assert.equal(authority.auditEvents().length, 1);
});

test('same operation ID with changed payload is rejected without side effect', t => {
  const { authority } = context(t);
  assert.equal(authority.submit('owner', command()).ok, true);
  const changed = fixtureDoc(); changed.content[1].content[0].text = 'different';
  assert.equal(authority.submit('owner', command({ payload: { document: changed } })).code, 'OPERATION');
  assert.deepEqual(authority.readDocument('owner', 'doc1').document.document, fixtureDoc());
  assert.equal(authority.inspect('owner').eventCount, 1);
});

test('stale base version preserves the accepted document and losing request', t => {
  const { authority } = context(t);
  authority.submit('owner', command());
  const stale = command({ opId: 'stale', kind: 'edit', baseVersion: 0 });
  const before = structuredClone(stale);
  assert.equal(authority.submit('owner', stale).code, 'CONFLICT');
  assert.deepEqual(stale, before);
  assert.equal(authority.inspect('owner').eventCount, 1);
});

test('editor can edit and viewer can read but cannot edit', t => {
  const { authority } = context(t);
  invite(authority); invite(authority, 'viewer', 'viewer');
  authority.submit('owner', command());
  assert.equal(authority.submit('editor', command({ actorId: 'editor', opId: 'edit1', kind: 'edit', baseVersion: 1 })).ok, true);
  assert.equal(authority.readDocument('viewer', 'doc1').ok, true);
  assert.equal(authority.submit('viewer', command({ actorId: 'viewer', opId: 'bad', kind: 'edit', baseVersion: 2 })).ok, false);
  assert.equal(authority.lookupReceipt('viewer', 'edit1').code, 'FORBIDDEN');
});

test('revocation applies to old receipt retries, reads and new writes', t => {
  const { authority } = context(t);
  invite(authority); authority.submit('owner', command());
  const edit = command({ actorId: 'editor', opId: 'edit1', kind: 'edit', baseVersion: 1 });
  assert.equal(authority.submit('editor', edit).ok, true);
  assert.equal(authority.changeMembership('owner', { targetId: 'editor', action: 'revoke', expectedVersion: 2 }).ok, true);
  assert.equal(authority.lookupReceipt('editor', 'edit1').ok, false);
  assert.equal(authority.submit('editor', edit).ok, false);
  assert.equal(authority.readDocument('editor', 'doc1').ok, false);
});

test('a downgraded actor can query its own old receipt without replaying a now-forbidden write', t => {
  const { authority } = context(t);
  invite(authority); authority.submit('owner', command());
  const edit = command({ actorId: 'editor', opId: 'edit1', kind: 'edit', baseVersion: 1 });
  assert.equal(authority.submit('editor', edit).ok, true);
  assert.equal(authority.changeMembership('owner', { targetId: 'editor', action: 'setRole', role: 'viewer', expectedVersion: 2 }).ok, true);
  assert.equal(authority.submit('editor', edit).code, 'ROLE');
  assert.equal(authority.lookupReceipt('editor', 'edit1').receipt.stage, 'server');
});

test('scope and actor mismatches cannot append to the journal', t => {
  const { authority } = context(t);
  assert.equal(authority.submit('owner', command({ spaceId: 'elsewhere' })).code, 'SCOPE');
  assert.equal(authority.submit('owner', command({ actorId: 'stranger' })).code, 'ACTOR');
  assert.equal(authority.inspect('owner').eventCount, 0);
});

test('deleted document restores with new generation and stale edit stays rejected', t => {
  const { authority } = context(t);
  authority.submit('owner', command());
  assert.equal(authority.submit('owner', command({ opId: 'delete1', kind: 'delete', baseVersion: 1, payload: {} })).ok, true);
  assert.equal(authority.submit('owner', command({ opId: 'restore1', kind: 'restore', baseVersion: 2,
    payload: { newIncarnation: 'generation2' } })).ok, true);
  const restored = authority.readDocument('owner', 'doc1').document;
  assert.equal(restored.incarnation, 'generation2');
  assert.equal(restored.deleted, false);
  assert.deepEqual(restored.document, fixtureDoc());
  assert.equal(authority.submit('owner', command({ opId: 'old-edit', kind: 'edit', baseVersion: 3 })).code, 'STALE_GENERATION');
});

test('payload capacity refusal leaves the prior journal unchanged', t => {
  const { authority } = context(t, { limits: { maxBytes: 10 } });
  assert.equal(authority.submit('owner', command()).code, 'BYTE_LIMIT');
  assert.equal(authority.inspect('owner').eventCount, 0);
  assert.equal(authority.auditEvents().length, 0);
});

test('last owner cannot be revoked and failed change has no audit entry', t => {
  const { authority } = context(t);
  assert.equal(authority.changeMembership('owner', { targetId: 'owner', action: 'revoke', expectedVersion: 1 }).code, 'LAST_OWNER');
  assert.equal(authority.auditEvents().length, 0);
  assert.equal(authority.inspect('owner').ok, true);
});

test('audit capacity has an explicit stop reason while existing receipt lookup/retry remains available', t => {
  const { authority } = context(t);
  assert.equal(authority.submit('owner', command()).ok, true);
  let previous = authority.auditEvents().at(-1).hash;
  authority.db.exec('BEGIN IMMEDIATE');
  for (let seq = 2; seq <= MAX_AUDIT_RECORDS; seq++) {
    const unsigned = { seq, prevHash: previous, actorId: 'owner', orgId: 'org1', spaceId: 'space1',
      action: 'history', opId: `history${seq}`, time: '2026-11-08T00:00:00.000Z', result: 'OK' };
    const record = { ...unsigned, hash: hashJson(unsigned) };
    authority.db.prepare('INSERT INTO audit VALUES (?,?)').run(seq, JSON.stringify(record));
    previous = record.hash;
  }
  authority.db.exec('COMMIT');
  const info = authority.inspect('owner');
  assert.equal(info.audit.ok, true);
  assert.equal(info.writeBlockedReason, 'AUDIT_LIMIT');
  assert.equal(authority.submit('owner', command()).duplicate, true);
  assert.equal(authority.lookupReceipt('owner', 'op1').ok, true);
  assert.equal(authority.submit('owner', command({ opId: 'next', kind: 'edit', baseVersion: 1 })).code, 'AUDIT_LIMIT');
  assert.equal(authority.changeMembership('owner', { targetId: 'new-member', action: 'invite', role: 'viewer', expectedVersion: 0 }).code, 'AUDIT_LIMIT');
  assert.equal(authority.inspect('owner').eventCount, 1);
});

test('unknown document fields refuse conversion instead of silently dropping input', t => {
  const { authority } = context(t);
  const doc = fixtureDoc(); doc.privateUnknown = { keep: '原本' };
  assert.equal(authority.submit('owner', command({ payload: { document: doc } })).code, 'UNSUPPORTED_DOCUMENT');
  assert.equal(authority.inspect('owner').eventCount, 0);
  assert.equal(doc.privateUnknown.keep, '原本');
});

test('malformed or non-document roots refuse without leaving a partial transaction', t => {
  const { authority } = context(t);
  for (const value of [null, {}, fixtureDoc().content[1]]) {
    assert.equal(authority.submit('owner', command({ payload: { document: value } })).code, 'UNSUPPORTED_DOCUMENT');
    assert.equal(authority.inspect('owner').eventCount, 0);
  }
  assert.equal(authority.submit('owner', command()).ok, true);
});

test('existing unrelated SQLite is refused without creating lab tables', t => {
  const dir = mkdtempSync(join(tmpdir(), 'folio-unrelated-sentinel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'unrelated.sqlite');
  const db = new DatabaseSync(file); db.exec('CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES (\'keep\');'); db.close();
  assert.throws(() => new LabAuthority(file, options), /UNRELATED_DATABASE/);
  const check = new DatabaseSync(file);
  try {
    assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name), ['sentinel']);
    assert.equal(check.prepare('SELECT value FROM sentinel').get().value, 'keep');
  } finally { check.close(); }
});

test('scope changes on reopen are refused rather than rewriting authority', t => {
  const ctx = context(t); ctx.close();
  assert.throws(() => new LabAuthority(ctx.file, { ...options, epoch: 'different' }), /SCOPE_MISMATCH/);
  const reopened = new LabAuthority(ctx.file, options);
  try { assert.equal(reopened.inspect('owner').scope.epoch, 'epoch1'); }
  finally { reopened.close(); }
});
