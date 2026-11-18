import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { LabAuthority } from '../src/authority.mjs';
import { startLabTransport } from '../src/transport.mjs';
import { fixtureDoc } from '../src/schema.mjs';

const ORG = 'org1', SPACE = 'space1', EPOCH = 'epoch1', OWNER = 'owner1', EDITOR = 'editor1', VIEWER = 'viewer1';
const TOKENS = { owner: 'owner-token-0123456789', editor: 'editor-token-0123456789', viewer: 'viewer-token-0123456789' };
let seq = 0;

function makeCommand(overrides = {}) {
  const n = ++seq;
  return { protocol: 'folio-shared-lab/1', opId: `op${n}`, actorId: OWNER, orgId: ORG, spaceId: SPACE,
    docId: `doc${n}`, incarnation: `inc${n}`, kind: 'create', baseVersion: 0,
    payload: { document: fixtureDoc() }, ...overrides };
}

function addMember(authority, userId, role) {
  const record = { userId, orgId: ORG, role, status: 'active', version: 1 };
  authority.db.prepare('INSERT OR REPLACE INTO members VALUES (?,?)').run(userId, JSON.stringify(record));
}

function seedDocument(authority, docId) {
  const record = { docId, incarnation: `inc-${docId}`, version: 1, deleted: false, document: fixtureDoc() };
  authority.db.prepare('INSERT OR REPLACE INTO documents VALUES (?,?)').run(docId, JSON.stringify(record));
}

async function setup(t, { maxBodyBytes, wrap } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'folio-transport-'));
  const authority = new LabAuthority(join(dir, 'lab.sqlite'), { orgId: ORG, spaceId: SPACE, epoch: EPOCH, ownerId: OWNER });
  addMember(authority, EDITOR, 'editor'); addMember(authority, VIEWER, 'viewer');
  const credentials = new Map([[TOKENS.owner, OWNER], [TOKENS.editor, EDITOR], [TOKENS.viewer, VIEWER]]);
  let transport;
  try {
    transport = await startLabTransport({ authority: wrap ? wrap(authority) : authority, credentials,
      ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}) });
  } catch (error) {
    authority.close(); await rm(dir, { recursive: true, force: true }); throw error;
  }
  t.after(async () => {
    try { await transport.close(); }
    finally { try { authority.close(); } finally { await rm(dir, { recursive: true, force: true }); } }
  });
  return { authority, baseUrl: transport.baseUrl.replace(/\/$/, '') };
}

async function call(baseUrl, path, { token, method = 'GET', body, headers = {}, contentType } = {}) {
  const h = { accept: 'application/json', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    if (contentType !== null) h['content-type'] = contentType ?? 'application/json';
  }
  const res = await fetch(baseUrl + path, { method, headers: h, body: payload });
  const text = await res.text(); let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, text, headers: res.headers };
}

function raw(baseUrl, { path = '/commands', method = 'POST', headers = {}, body } = {}) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: url.hostname, port: url.port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('owner can submit, read, fetch receipt, and inspect', async t => {
  const { baseUrl } = await setup(t); const cmd = makeCommand();
  const created = await call(baseUrl, '/commands', { token: TOKENS.owner, method: 'POST', body: cmd });
  assert.equal(created.status, 200); assert.equal(created.json.ok, true); assert.equal(created.json.receipt.opId, cmd.opId);
  assert.match(created.headers.get('content-type'), /^application\/json/); assert.equal(created.headers.get('cache-control'), 'no-store');
  const doc = await call(baseUrl, `/documents/${cmd.docId}`, { token: TOKENS.owner });
  assert.equal(doc.status, 200); assert.deepEqual(doc.json.document.document, fixtureDoc());
  const receipt = await call(baseUrl, `/receipts/${cmd.opId}`, { token: TOKENS.owner });
  assert.equal(receipt.status, 200); assert.equal(receipt.json.receipt.opId, cmd.opId);
  const inspect = await call(baseUrl, '/inspect', { token: TOKENS.owner });
  assert.equal(inspect.status, 200); assert.equal(inspect.json.scope.orgId, ORG);
});

test('viewer can read but cannot submit or inspect', async t => {
  const { authority, baseUrl } = await setup(t); seedDocument(authority, 'doc-view');
  const read = await call(baseUrl, '/documents/doc-view', { token: TOKENS.viewer });
  assert.equal(read.status, 200); assert.deepEqual(read.json.document.document, fixtureDoc());
  const submit = await call(baseUrl, '/commands', { token: TOKENS.viewer, method: 'POST', body: makeCommand({ actorId: VIEWER }) });
  assert.equal(submit.status, 409); assert.equal(submit.json.ok, false); assert.equal(submit.json.receipt, undefined);
  const inspect = await call(baseUrl, '/inspect', { token: TOKENS.viewer });
  assert.equal(inspect.status, 409); assert.equal(inspect.json.ok, false);
});

test('editor can submit but cannot manage memberships or inspect', async t => {
  const { baseUrl } = await setup(t);
  const submit = await call(baseUrl, '/commands', { token: TOKENS.editor, method: 'POST', body: makeCommand({ actorId: EDITOR }) });
  assert.equal(submit.status, 200); assert.equal(submit.json.ok, true);
  const membership = await call(baseUrl, '/memberships', { token: TOKENS.editor, method: 'POST', body: {} });
  assert.equal(membership.status, 409); assert.equal(membership.json.ok, false);
  const inspect = await call(baseUrl, '/inspect', { token: TOKENS.editor });
  assert.equal(inspect.status, 409);
});

test('missing, malformed, and unknown bearer tokens are unauthorized', async t => {
  const { baseUrl } = await setup(t);
  const missing = await call(baseUrl, '/inspect');
  assert.equal(missing.status, 401); assert.equal(missing.json.code, 'UNAUTHORIZED'); assert.equal(missing.headers.get('cache-control'), 'no-store');
  const unknown = await call(baseUrl, '/inspect', { token: 'not-a-valid-token-000' });
  assert.equal(unknown.status, 401); assert.equal(unknown.json.code, 'UNAUTHORIZED');
  const scheme = await call(baseUrl, '/inspect', { headers: { authorization: 'Basic abc' } });
  assert.equal(scheme.status, 401); assert.equal(scheme.json.code, 'UNAUTHORIZED');
});

test('spoofed actor is refused and no data is returned', async t => {
  const { baseUrl } = await setup(t); const cmd = makeCommand({ actorId: EDITOR });
  const res = await call(baseUrl, '/commands', { token: TOKENS.owner, method: 'POST', body: cmd });
  assert.equal(res.status, 409); assert.equal(res.json.ok, false); assert.equal(res.json.code, 'ACTOR');
  assert.equal(res.json.receipt, undefined); assert.equal(res.json.document, undefined);
});

test('malformed and empty JSON bodies are rejected', async t => {
  const { baseUrl } = await setup(t);
  const malformed = await call(baseUrl, '/commands', { token: TOKENS.owner, method: 'POST', body: '{"oops"' });
  assert.equal(malformed.status, 400); assert.equal(malformed.json.code, 'INVALID_JSON');
  const empty = await call(baseUrl, '/commands', { token: TOKENS.owner, method: 'POST', body: '' });
  assert.equal(empty.status, 400); assert.equal(empty.json.code, 'INVALID_JSON');
});

test('POST requires a JSON content type, parameters allowed', async t => {
  const { baseUrl } = await setup(t);
  const absent = await call(baseUrl, '/commands', { token: TOKENS.owner, method: 'POST', body: Buffer.from(JSON.stringify(makeCommand())), contentType: null });
  assert.equal(absent.status, 415); assert.equal(absent.json.code, 'CONTENT_TYPE');
  const plain = await call(baseUrl, '/commands', { token: TOKENS.owner, method: 'POST', body: JSON.stringify(makeCommand()), contentType: 'text/plain' });
  assert.equal(plain.status, 415); assert.equal(plain.json.code, 'CONTENT_TYPE');
  const parameterized = await call(baseUrl, '/commands', { token: TOKENS.owner, method: 'POST', body: makeCommand(), contentType: 'application/json; charset=utf-8' });
  assert.equal(parameterized.status, 200);
});

test('rejects an oversized Content-Length before buffering the body', async t => {
  const { baseUrl } = await setup(t, { maxBodyBytes: 256 });
  const res = await raw(baseUrl, { headers: { authorization: `Bearer ${TOKENS.owner}`,
    'content-type': 'application/json', 'content-length': '1048576', connection: 'close' } });
  assert.equal(res.status, 413); assert.equal(res.json.code, 'BODY_LIMIT');
});

test('rejects an oversized streamed body with no Content-Length', async t => {
  const { baseUrl } = await setup(t, { maxBodyBytes: 256 });
  const res = await raw(baseUrl, { headers: { authorization: `Bearer ${TOKENS.owner}`,
    'content-type': 'application/json' }, body: Buffer.alloc(1024, 0x61) });
  assert.equal(res.status, 413); assert.equal(res.json.code, 'BODY_LIMIT');
});

test('authority failures return 500 without leaking secrets or tokens', async t => {
  const leak = `SECRET ${TOKENS.owner} internal-stack`;
  const { baseUrl } = await setup(t, { wrap: authority => new Proxy(authority, {
    get(target, prop, receiver) {
      if (prop === 'submit') return () => { throw new Error(leak); };
      return Reflect.get(target, prop, receiver);
    },
  }) });
  const res = await call(baseUrl, '/commands', { token: TOKENS.owner, method: 'POST', body: makeCommand() });
  assert.equal(res.status, 500); assert.equal(res.json.ok, false); assert.equal(res.json.code, 'INTERNAL');
  assert.equal(res.text.includes(leak), false); assert.equal(res.text.includes(TOKENS.owner), false);
});

test('unknown routes and unsupported methods return NOT_FOUND', async t => {
  const { baseUrl } = await setup(t);
  const route = await call(baseUrl, '/not-a-route', { token: TOKENS.owner });
  assert.equal(route.status, 404); assert.equal(route.json.code, 'NOT_FOUND');
  const method = await call(baseUrl, '/inspect', { token: TOKENS.owner, method: 'DELETE' });
  assert.equal(method.status, 404); assert.equal(method.json.code, 'NOT_FOUND');
});

test('role revocation applies to an existing token on the next request', async t => {
  const { authority, baseUrl } = await setup(t);
  const first = await call(baseUrl, '/commands', { token: TOKENS.editor, method: 'POST', body: makeCommand({ actorId: EDITOR }) });
  assert.equal(first.status, 200);
  const member = JSON.parse(authority.db.prepare('SELECT record FROM members WHERE user_id=?').get(EDITOR).record);
  authority.db.prepare('UPDATE members SET record=? WHERE user_id=?').run(JSON.stringify({ ...member, role: 'viewer' }), EDITOR);
  const after = await call(baseUrl, '/commands', { token: TOKENS.editor, method: 'POST', body: makeCommand({ actorId: EDITOR }) });
  assert.equal(after.status, 409); assert.equal(after.json.ok, false); assert.equal(after.json.receipt, undefined);
});

test('duplicate command ID after a lost response is idempotent', async t => {
  let first = true;
  const { authority, baseUrl } = await setup(t, { wrap: authority => new Proxy(authority, {
    get(target, prop, receiver) {
      if (prop === 'submit') return (actorId, body) => {
        if (!first) return target.submit(actorId, body);
        first = false;
        return target.submit(actorId, body, { afterCommit() { throw new Error('simulated response loss'); } });
      };
      return Reflect.get(target, prop, receiver);
    },
  }) });
  const cmd = makeCommand();
  const lost = await call(baseUrl, '/commands', { token: TOKENS.owner, method: 'POST', body: cmd });
  assert.equal(lost.status, 409); assert.equal(lost.json.ok, false);
  const retry = await call(baseUrl, '/commands', { token: TOKENS.owner, method: 'POST', body: cmd });
  assert.equal(retry.status, 200); assert.equal(retry.json.duplicate, true); assert.equal(retry.json.receipt.opId, cmd.opId);
  assert.equal(authority.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
});
