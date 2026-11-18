import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LabAuthority } from '../src/authority.mjs';
import { startLabTransport } from '../src/transport.mjs';
import { fixtureDoc } from '../src/schema.mjs';

test('invalid UTF-8 inside an otherwise valid command cannot silently replace authored input', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'folio-utf8-probe-'));
  const authority = new LabAuthority(join(directory, 'lab.sqlite'), { orgId: 'org1', spaceId: 'space1', epoch: 'epoch1', ownerId: 'owner' });
  const token = 'synthetic_owner_token_123456';
  const transport = await startLabTransport({ authority, credentials: new Map([[token, 'owner']]) });
  t.after(async () => { await transport.close(); authority.close(); rmSync(directory, { recursive: true, force: true }); });
  const doc = fixtureDoc(); doc.content[1].content[0].text = 'INVALID_UTF8_SENTINEL';
  const text = JSON.stringify({ opId: 'op1', actorId: 'owner', orgId: 'org1', spaceId: 'space1', docId: 'doc1',
    incarnation: 'gen1', kind: 'create', baseVersion: 0, payload: { document: doc } });
  const [prefix, suffix] = text.split('INVALID_UTF8_SENTINEL');
  const body = Buffer.concat([Buffer.from(prefix), Buffer.from([0xc3, 0x28]), Buffer.from(suffix)]);
  const response = await fetch(transport.baseUrl + '/commands', { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, code: 'INVALID_JSON' });
  assert.equal(authority.inspect('owner').eventCount, 0);
  assert.equal(authority.readDocument('owner', 'doc1').code, 'MISSING');
});
