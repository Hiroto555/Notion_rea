import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { LabAuthority } from './src/authority.mjs';
import { LabOutbox } from './src/outbox.mjs';
import { LabResources } from './src/resources.mjs';
import { startLabTransport } from './src/transport.mjs';
import { fixtureDoc } from './src/schema.mjs';
import { planSharedCopy } from './src/copy.mjs';
import { planRestore } from './src/restore.mjs';
import { applyRecordCommand } from './src/records.mjs';
import { validateAsset } from './src/asset-admission.mjs';
import { projectWorkspaceState } from './src/ui-state.mjs';
import { hashJson } from './src/contracts.mjs';

/** Executes synthetic data only and removes its own directory and loopback listener. */
export async function runDemo() {
  const directory = mkdtempSync(join(tmpdir(), 'folio-shared-lab-demo-'));
  const scope = { orgId: 'org1', spaceId: 'space1', epoch: 'epoch1', ownerId: 'owner' };
  const clientScope = { orgId: 'org1', spaceId: 'space1', actorId: 'editor' };
  let authority, outbox, transport;
  try {
    authority = new LabAuthority(join(directory, 'server.sqlite'), scope);
    let resources = new LabResources(authority);
    outbox = new LabOutbox(join(directory, 'client.sqlite'), clientScope);
    const ownerToken = randomBytes(24).toString('base64url');
    const editorToken = randomBytes(24).toString('base64url');
    transport = await startLabTransport({ authority, resources, credentials: new Map([[ownerToken, 'owner'], [editorToken, 'editor']]) });
    async function request(actor, path, body) {
      const response = await fetch(transport.baseUrl + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${actor === 'owner' ? ownerToken : editorToken}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, value: await response.json() };
    }
    assert.equal((await request('owner', '/memberships', { targetId: 'editor', role: 'editor', action: 'invite', expectedVersion: 0 })).value.ok, true);
    assert.equal((await request('owner', '/memberships', { targetId: 'editor', action: 'activate', expectedVersion: 1 })).value.ok, true);
    const preview = planSharedCopy({ pages: [{ id: 'private-page', parentId: null, title: '合成ページ',
      links: [{ targetId: 'unselected-private-page', label: '送らない合成ラベル' }], assets: [] }],
      selectedIds: ['private-page'], targetSpaceId: 'space1', idMap: { 'private-page': 'shared-page' } });
    assert.equal(preview.ok, true);
    assert.equal(JSON.stringify(preview).includes('unselected-private-page'), false);
    const base = { actorId: 'owner', orgId: 'org1', spaceId: 'space1', docId: 'shared-page', incarnation: 'gen1' };
    const create = { ...base, opId: 'create1', kind: 'create', baseVersion: 0, payload: { document: fixtureDoc() } };
    assert.equal((await request('owner', '/commands', create)).value.ok, true);

    const document = fixtureDoc(); document.content[1].content[0].text = '合成の編集内容';
    const edit = { ...base, actorId: 'editor', opId: 'edit1', kind: 'edit', baseVersion: 1, payload: { document } };
    assert.equal(outbox.enqueue(edit).ok, true);
    const accepted = await request('editor', '/commands', edit);
    assert.equal(accepted.value.ok, true);
    // Deliberately discard the received ACK to exercise client-side uncertainty.
    assert.equal(outbox.markUnknown('edit1').ok, true);
    assert.equal(outbox.retryPlan('edit1').action, 'QUERY_FIRST');
    const queried = await request('editor', '/receipts/edit1');
    assert.equal(queried.value.ok, true);
    assert.equal(outbox.confirm(queried.value.receipt, { fromQuery: true }).ok, true);
    const duplicate = await request('editor', '/commands', edit);
    assert.equal(duplicate.value.duplicate, true);

    const seed = { databaseId: 'db1', schemaVersion: 1, properties: [{ id: 'note', type: 'text' }], records: [] };
    const record = applyRecordCommand(seed, { databaseId: 'db1', schemaVersion: 1, recordId: 'r1', expectedVersion: 0, action: 'create', values: { note: '合成レコード' } });
    assert.equal(record.ok, true);
    const patched = applyRecordCommand(record.state, { databaseId: 'db1', schemaVersion: 1, recordId: 'r1', expectedVersion: 1, action: 'patch', values: { note: '更新済み' } });
    assert.equal(patched.ok, true);
    const resource = (actorId, opId, kind, payload) => ({ protocol: 'folio-resource-lab/1',
      orgId: 'org1', spaceId: 'space1', actorId, opId, kind, payload });
    assert.equal((await request('owner', '/resources', resource('owner', 'db-create', 'databaseCreate', { state: seed }))).value.ok, true);
    const recordRequest = resource('editor', 'record-create', 'recordChange', { databaseId: 'db1', schemaVersion: 1,
      recordId: 'r1', expectedVersion: 0, action: 'create', values: { note: 'HTTP経由の合成レコード' } });
    assert.equal((await request('editor', '/resources', recordRequest)).value.ok, true);
    assert.equal((await request('editor', '/resources', recordRequest)).value.duplicate, true);
    const bytes = Buffer.from('合成添付');
    const asset = validateAsset({ bytes, sha256: createHash('sha256').update(bytes).digest('hex'), expectedSize: bytes.length });
    assert.equal(asset.ok, true);
    bytes.fill(0);
    assert.equal(asset.asset.bytes.toString(), '合成添付');
    const assetRequest = resource('editor', 'asset-put', 'assetPut', { sha256: asset.asset.sha256,
      size: asset.asset.size, base64: asset.asset.bytes.toString('base64') });
    assert.equal((await request('editor', '/resources', assetRequest)).value.ok, true);
    assert.equal((await request('editor', `/assets/${asset.asset.sha256}`)).value.asset.base64, assetRequest.payload.base64);
    assert.equal((await request('editor', '/databases/db1')).value.state.records[0].values.note, 'HTTP経由の合成レコード');

    assert.equal((await request('owner', '/commands', { ...base, opId: 'delete1', kind: 'delete', baseVersion: 2, payload: {} })).value.ok, true);
    assert.equal((await request('owner', '/commands', { ...base, opId: 'restore1', kind: 'restore', baseVersion: 3, payload: { newIncarnation: 'gen2' } })).value.ok, true);
    const stale = await request('editor', '/commands', { ...edit, opId: 'stale1', baseVersion: 4 });
    assert.equal(stale.value.code, 'STALE_GENERATION');
    assert.equal((await request('owner', '/memberships', { targetId: 'editor', action: 'revoke', expectedVersion: 2 })).value.ok, true);
    assert.equal((await request('editor', '/receipts/edit1')).value.ok, false);
    assert.equal((await request('editor', '/documents/shared-page')).value.ok, false);
    assert.equal((await request('editor', `/assets/${asset.asset.sha256}`)).value.ok, false);
    assert.equal((await request('editor', '/databases/db1')).value.ok, false);
    const restorePlan = planRestore({ backup: { format: 'folio-shared-lab-backup/1', orgId: 'org1', spaceId: 'space1',
      epoch: 'epoch1', sequence: 4, hash: hashJson(document) }, currentEpoch: 'epoch1', newEpoch: 'epoch2',
      expectedOrgId: 'org1', expectedSpaceId: 'space1', pendingOperations: [{ opId: 'stale1', epoch: 'epoch1' }] });
    assert.equal(restorePlan.ok, true);
    assert.equal(restorePlan.plan.autoResend, false);

    await transport.close(); transport = undefined;
    authority.close(); authority = undefined;
    outbox.close(); outbox = undefined;
    authority = new LabAuthority(join(directory, 'server.sqlite'), scope);
    resources = new LabResources(authority);
    outbox = new LabOutbox(join(directory, 'client.sqlite'), clientScope);
    assert.equal(authority.readDocument('owner', 'shared-page').document.incarnation, 'gen2');
    assert.equal(outbox.read('edit1').entry.stage, 'server');
    assert.equal(authority.inspect('owner').audit.ok, true);
    assert.equal(resources.readDatabase('owner', 'db1').state.records[0].values.note, 'HTTP経由の合成レコード');
    assert.equal(resources.readAsset('owner', asset.asset.sha256).asset.base64, assetRequest.payload.base64);
    const view = projectWorkspaceState({ scope: 'shared', stage: outbox.read('edit1').entry.stage,
      connection: 'offline', role: 'revoked', conflict: false, pendingCount: 0 });
    assert.equal(view.ok, true);
    assert.equal(view.view.canEdit, false);
    return { result: 'PASS_IN_LAB_SCOPE', actual: ['loopback HTTP', 'SQLite server journal and client outbox reopen',
      'role revocation', 'CAS delete/restore', 'audit chain consistency'],
      simulations: ['received ACK deliberately discarded on client'],
      memoryOnly: [], persistedResources: ['typed DB record mutation', 'hashed asset bytes'], metadataOnly: ['shared copy preview', 'backup restore plan'],
      server: authority.inspect('owner'), clientStage: outbox.read('edit1').entry.stage,
      engineAdoption: 'UNDECIDED', productAcceptance: 'NOT_RUN', gui: 'NOT_RUN', physicalDevices: 'NOT_RUN' };
  } finally {
    try { await transport?.close(); } finally {
      try { outbox?.close(); } finally {
        try { authority?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runDemo(), null, 2));
}
