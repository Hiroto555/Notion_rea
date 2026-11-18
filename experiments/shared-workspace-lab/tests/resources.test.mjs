import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LabAuthority } from '../src/authority.mjs';
import { LabResources } from '../src/resources.mjs';
const OPTIONS = { orgId: 'org1', spaceId: 'space1', epoch: 'epoch1', ownerId: 'owner' };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const envelope = (kind, payload, opId, overrides = {}) => ({
  protocol: 'folio-resource-lab/1', opId, actorId: 'owner',
  orgId: 'org1', spaceId: 'space1', kind, payload, ...overrides,
});
const createDb = (opId = 'db-create') => envelope('databaseCreate', {
  state: { databaseId: 'db1', schemaVersion: 1, properties: [{ id: 'note', type: 'text' }], records: [] },
}, opId);
const recordChange = (opId, action = 'create', values = { note: 'value' }, expectedVersion = 0,
  actorId = 'owner', recordId = 'r1') => envelope('recordChange', {
  databaseId: 'db1', schemaVersion: 1, recordId, expectedVersion, action, values,
}, opId, { actorId });
const assetPut = (opId, bytes, hash, size) => envelope('assetPut', {
  sha256: hash, size, base64: bytes.toString('base64'),
}, opId);
async function lab(t) {
  const dir = await mkdtemp(join(tmpdir(), 'folio-resources-'));
  const file = join(dir, 'lab.sqlite');
  let authority, resources, open = false;
  const start = () => {
    authority = new LabAuthority(file, OPTIONS);
    resources = new LabResources(authority);
    open = true;
  };
  const close = () => { if (open) { authority.close(); open = false; } };
  start();
  t.after(async () => { close(); await rm(dir, { recursive: true, force: true }); });
  return {
    get authority() { return authority; },
    get resources() { return resources; },
    reopen() { close(); start(); return resources; },
  };
}

test('database create, record mutation, and reopen', async t => {
  const s = await lab(t);
  let result = s.resources.apply('owner', createDb('op-db'));
  assert.equal(result.ok, true); assert.equal(result.duplicate, false);
  assert.equal(result.receipt.kind, 'databaseCreate'); assert.equal(result.receipt.opId, 'op-db');
  result = s.resources.apply('owner', recordChange('op-record'));
  assert.equal(result.ok, true);
  const read = s.resources.readDatabase('owner', 'db1');
  assert.equal(read.ok, true);
  const record = read.state.records.find(entry => entry.id === 'r1');
  assert.ok(record); assert.equal(record.values.note, 'value');
  assert.equal(s.authority.inspect('owner').eventCount, 2);
  s.reopen();
  const reopened = s.resources.readDatabase('owner', 'db1');
  assert.equal(reopened.ok, true);
  assert.equal(reopened.state.records.find(entry => entry.id === 'r1').values.note, 'value');
  assert.equal(s.authority.inspect('owner').eventCount, 2);
});

test('identical operation retry returns duplicate with one event', async t => {
  const s = await lab(t);
  const env = createDb('op-retry');
  const first = s.resources.apply('owner', env);
  const second = s.resources.apply('owner', env);
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  assert.equal(second.duplicate, true); assert.deepEqual(second.receipt, first.receipt);
  assert.equal(s.authority.inspect('owner').eventCount, 1);
  assert.equal(s.authority.auditEvents().length, 1);
});

test('changed payload for same operation is rejected', async t => {
  const s = await lab(t);
  assert.equal(s.resources.apply('owner', createDb('op-fixed')).ok, true);
  const changed = s.resources.apply('owner', recordChange('op-fixed'));
  assert.equal(changed.ok, false); assert.equal(changed.code, 'OPERATION');
  assert.equal(s.authority.inspect('owner').eventCount, 1);
  const receipt = s.authority.lookupReceipt('owner', 'op-fixed');
  assert.equal(receipt.ok, true); assert.equal(receipt.receipt.kind, 'databaseCreate');
  assert.equal(s.resources.readDatabase('owner', 'db1').ok, true);
});

test('asset stores real bytes, reads and survives reopen', async t => {
  const s = await lab(t);
  const bytes = Buffer.from([0, 1, 2, 255, 10, 13, 65]);
  const hash = sha256(bytes);
  const result = s.resources.apply('owner', assetPut('op-asset', bytes, hash, bytes.length));
  assert.equal(result.ok, true);
  let read = s.resources.readAsset('owner', hash);
  assert.equal(read.ok, true); assert.equal(read.asset.sha256, hash);
  assert.equal(read.asset.size, bytes.length);
  assert.equal(read.asset.base64, bytes.toString('base64'));
  assert.ok(Buffer.from(read.asset.base64, 'base64').equals(bytes));
  s.reopen();
  read = s.resources.readAsset('owner', hash);
  assert.equal(read.ok, true);
  assert.ok(Buffer.from(read.asset.base64, 'base64').equals(bytes));
  assert.equal(s.authority.inspect('owner').eventCount, 1);
});

test('wrong asset hash or size is not published', async t => {
  const s = await lab(t);
  const bytes = Buffer.from('asset admission');
  const hash = sha256(bytes);
  const wrongHash = '0'.repeat(64);
  let result = s.resources.apply('owner', assetPut('op-bad-hash', bytes, wrongHash, bytes.length));
  assert.equal(result.ok, false); assert.equal(typeof result.code, 'string');
  let read = s.resources.readAsset('owner', wrongHash);
  assert.equal(read.ok, false); assert.equal(read.code, 'MISSING');
  result = s.resources.apply('owner', assetPut('op-bad-size', bytes, hash, bytes.length - 1));
  assert.equal(result.ok, false); assert.equal(typeof result.code, 'string');
  read = s.resources.readAsset('owner', hash);
  assert.equal(read.ok, false); assert.equal(read.code, 'MISSING');
  assert.equal(s.authority.inspect('owner').eventCount, 0);
  assert.equal(s.authority.auditEvents().length, 0);
});

test('precommit hook throw rolls back database, receipt, event, and audit', async t => {
  const s = await lab(t);
  const opId = 'op-precommit';
  assert.throws(
    () => s.resources.apply('owner', createDb(opId), {
      beforeCommit() { throw new Error('precommit boom'); },
    }),
    /precommit boom/,
  );
  const read = s.resources.readDatabase('owner', 'db1');
  assert.equal(read.ok, false); assert.equal(read.code, 'MISSING');
  assert.equal(s.authority.lookupReceipt('owner', opId).code, 'MISSING');
  assert.equal(s.authority.inspect('owner').eventCount, 0);
  assert.equal(s.authority.auditEvents().length, 0);
});

test('postcommit hook throw returns UNKNOWN but receipt confirms commit', async t => {
  const s = await lab(t);
  const opId = 'op-postcommit';
  const env = createDb(opId);
  const result = s.resources.apply('owner', env, {
    afterCommit() { throw new Error('postcommit boom'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNKNOWN'); assert.equal(result.opId, opId);
  const receipt = s.authority.lookupReceipt('owner', opId);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.receipt.kind, 'databaseCreate');
  assert.equal(s.resources.readDatabase('owner', 'db1').ok, true);
  assert.equal(s.authority.inspect('owner').eventCount, 1);

  const retry = s.resources.apply('owner', env);
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicate, true);
  assert.equal(s.authority.inspect('owner').eventCount, 1);
});

test('editor role works, revocation blocks, actor and scope mismatch rejected', async t => {
  const s = await lab(t);
  let membership = s.authority.changeMembership('owner', {
    targetId: 'editor', role: 'editor', action: 'invite', expectedVersion: 0,
  });
  assert.equal(membership.ok, true);
  membership = s.authority.changeMembership('owner', {
    targetId: 'editor', role: 'editor', action: 'activate', expectedVersion: 1,
  });
  assert.equal(membership.ok, true);

  assert.equal(s.resources.apply('owner', createDb('op-db')).ok, true);
  let result = s.resources.apply('editor', recordChange('op-editor', 'create', { note: 'editor' }, 0, 'editor'));
  assert.equal(result.ok, true);
  assert.equal(s.resources.readDatabase('editor', 'db1').ok, true);

  membership = s.authority.changeMembership('owner', {
    targetId: 'editor', role: 'editor', action: 'revoke', expectedVersion: 2,
  });
  assert.equal(membership.ok, true);
  result = s.resources.apply('editor', recordChange('op-editor-revoked', 'create', { note: 'blocked' }, 0, 'editor', 'r2'));
  assert.equal(result.ok, false);
  assert.equal(typeof result.code, 'string');
  assert.equal(s.authority.inspect('owner').eventCount, 2);

  const actorMismatch = s.resources.apply('editor', createDb('op-actor'));
  assert.equal(actorMismatch.ok, false);
  assert.equal(actorMismatch.code, 'ACTOR');
  const scopeMismatch = s.resources.apply('owner', { ...createDb('op-scope'), spaceId: 'space2' });
  assert.equal(scopeMismatch.ok, false);
  assert.equal(scopeMismatch.code, 'SCOPE');
});

test('record version conflict preserves committed state', async t => {
  const s = await lab(t);
  assert.equal(s.resources.apply('owner', createDb('op-db')).ok, true);
  assert.equal(s.resources.apply('owner', recordChange('op-record')).ok, true);
  const losing = s.resources.apply('owner', recordChange('op-losing', 'create', { note: 'losing' }, 0));
  assert.equal(losing.ok, false);
  assert.equal(typeof losing.code, 'string');

  const read = s.resources.readDatabase('owner', 'db1');
  assert.equal(read.ok, true);
  assert.equal(read.state.records.length, 1);
  assert.equal(read.state.records[0].values.note, 'value');
  assert.equal(s.authority.lookupReceipt('owner', 'op-losing').code, 'MISSING');
  assert.equal(s.authority.inspect('owner').eventCount, 2);
  assert.equal(s.authority.auditEvents().length, 2);
});
