import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LabOutbox } from '../src/outbox.mjs';

test('a new epoch cannot silently rebind an already accepted immutable operation', t => {
  const dir = mkdtempSync(join(tmpdir(), 'folio-outbox-epoch-proof-'));
  const scope = { orgId: 'org1', spaceId: 'space1', actorId: 'editor' };
  const queue = new LabOutbox(join(dir, 'client.sqlite'), scope);
  t.after(() => { queue.close(); rmSync(dir, { recursive: true, force: true }); });
  const command = { ...scope, opId: 'op1', docId: 'doc1', incarnation: 'gen1', kind: 'edit', baseVersion: 1, payload: { text: '保全する入力' } };
  const queued = queue.enqueue(command);
  const proof = { ...scope, opId: 'op1', fingerprint: queued.entry.fingerprint, serverSeq: 1, epoch: 'epoch1' };
  assert.equal(queue.confirm(proof).ok, true);
  const before = queue.read('op1').entry;
  assert.equal(queue.confirm({ ...proof, epoch: 'epoch2' }, { fromQuery: true }).code, 'EPOCH');
  assert.deepEqual(queue.read('op1').entry, before);
  assert.equal(queue.confirm(proof, { fromQuery: true }).ok, true);
});
