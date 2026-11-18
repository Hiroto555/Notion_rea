import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LabOutbox } from '../src/outbox.mjs';
import { hashJson } from '../src/contracts.mjs';

const scope = { orgId: 'org1', spaceId: 'space1', actorId: 'actor1' };
const command = { ...scope, opId: 'op1', docId: 'doc1', incarnation: 'gen1', kind: 'edit', baseVersion: 0, payload: { text: '元の入力' } };
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'folio-outbox-integrity-'));
  const file = join(dir, 'client.sqlite');
  const queue = new LabOutbox(file, scope);
  const original = queue.enqueue(command).entry;
  t.after(() => { queue.close(); rmSync(dir, { recursive: true, force: true }); });
  return { file, queue, original, mutate(change) {
    const db = new DatabaseSync(file);
    try {
      const row = db.prepare('SELECT op_id,fingerprint,entry FROM outbox WHERE op_id=?').get('op1');
      const entry = JSON.parse(row.entry);
      change(entry, row);
      db.prepare('UPDATE outbox SET op_id=?,fingerprint=?,entry=? WHERE op_id=?').run(row.op_id, row.fingerprint, JSON.stringify(entry), 'op1');
    } finally { db.close(); }
  } };
}

test('changed command bytes with old fingerprint are held by every outbox read/write path', t => {
  const ctx = setup(t);
  ctx.mutate(entry => { entry.command.payload.text = 'ディスク上で変化した入力'; });
  const proof = { ...scope, opId: 'op1', fingerprint: ctx.original.fingerprint, serverSeq: 1, epoch: 'epoch1' };
  for (const action of [() => ctx.queue.read('op1'), () => ctx.queue.retryPlan('op1'), () => ctx.queue.listPending(),
    () => ctx.queue.enqueue(command), () => ctx.queue.markUnknown('op1'), () => ctx.queue.confirm(proof)]) {
    assert.throws(action, /CORRUPT_OUTBOX/);
  }
  const db = new DatabaseSync(ctx.file);
  try {
    const entry = JSON.parse(db.prepare('SELECT entry FROM outbox WHERE op_id=?').get('op1').entry);
    assert.equal(entry.command.payload.text, 'ディスク上で変化した入力');
    assert.equal(entry.stage, 'local');
  } finally { db.close(); }
});

test('row identity and entry identity must agree', t => {
  const ctx = setup(t);
  ctx.mutate((entry, row) => { row.op_id = 'other-operation'; });
  assert.throws(() => ctx.queue.read('other-operation'), /CORRUPT_OUTBOX/);
  assert.throws(() => ctx.queue.listPending(), /CORRUPT_OUTBOX/);
});

test('a self-consistent row for a foreign scope is not accepted into this outbox', t => {
  const ctx = setup(t);
  ctx.mutate((entry, row) => {
    entry.command.spaceId = 'other-space';
    entry.fingerprint = row.fingerprint = hashJson(entry.command);
  });
  assert.throws(() => ctx.queue.retryPlan('op1'), /CORRUPT_OUTBOX/);
});

test('an accepted stage without its durable sequence and epoch is held', t => {
  const ctx = setup(t);
  ctx.mutate(entry => { entry.stage = 'server'; });
  assert.throws(() => ctx.queue.read('op1'), /CORRUPT_OUTBOX/);
});

test('reopen refuses a missing queue table instead of recreating an empty queue', t => {
  const ctx = setup(t);
  ctx.queue.close();
  const db = new DatabaseSync(ctx.file);
  db.exec('DROP TABLE outbox'); db.close();
  assert.throws(() => new LabOutbox(ctx.file, scope), /CORRUPT_OUTBOX/);
  const check = new DatabaseSync(ctx.file);
  try { assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='outbox'").get().n, 0); }
  finally { check.close(); }
});
