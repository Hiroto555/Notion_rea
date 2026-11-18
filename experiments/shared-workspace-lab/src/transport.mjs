import { createServer } from 'node:http';
import { isId } from './contracts.mjs';

const TOKEN = /^[A-Za-z0-9_-]{16,}$/;
const BEARER = /^Bearer ([A-Za-z0-9_-]+)$/;
const ROUTE = /^\/(documents|receipts|databases|assets)\/([^/]+)$/;
const DEFAULT_MAX_BODY = 1048576;
const REQUEST_TIMEOUT = 30000;
const HEADERS_TIMEOUT = 10000;
const KEEP_ALIVE_TIMEOUT = 5000;

function send(res, status, payload, close = false) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', data.length);
  res.setHeader('cache-control', 'no-store');
  if (close) res.setHeader('connection', 'close');
  res.end(data);
}

const fail = (res, status, code) => send(res, status, { ok: false, code });

function failAndClose(req, res, status, code) {
  if (!req.destroyed && !req.readableEnded) req.resume();
  send(res, status, { ok: false, code }, true);
}

function reject(req, res, status, code) {
  const pending = !req.readableEnded &&
    (req.headers['transfer-encoding'] !== undefined || req.headers['content-length'] !== undefined);
  return pending ? failAndClose(req, res, status, code) : fail(res, status, code);
}

function authenticate(req, tokens) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = BEARER.exec(header);
  if (!match || !TOKEN.test(match[1])) return null;
  const actorId = tokens.get(match[1]);
  return typeof actorId === 'string' ? actorId : null;
}

function routeOf(method, pathname) {
  if (method === 'POST' && pathname === '/commands') return { kind: 'commands' };
  if (method === 'POST' && pathname === '/memberships') return { kind: 'memberships' };
  if (method === 'POST' && pathname === '/resources') return { kind: 'resources' };
  if (method === 'GET' && pathname === '/inspect') return { kind: 'inspect' };
  if (method !== 'GET') return null;
  const match = ROUTE.exec(pathname);
  if (!match) return null;
  let id;
  try { id = decodeURIComponent(match[2]); } catch { return null; }
  if (match[1] === 'assets' ? !/^[0-9a-f]{64}$/.test(id) : !isId(id)) return null;
  const kind = { documents: 'document', receipts: 'receipt', databases: 'database', assets: 'asset' }[match[1]];
  return { kind, id };
}

function declaredTooLarge(req, max) {
  const raw = req.headers['content-length'];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return false;
  try { return BigInt(raw) > BigInt(max); } catch { return false; }
}

function isJson(req) {
  const value = req.headers['content-type'];
  if (typeof value !== 'string') return false;
  return value.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onData = chunk => {
      if (settled) return;
      total += chunk.length;
      if (total > max) {
        chunks.length = 0;
        finish(resolve, { tooLarge: true });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(resolve, { tooLarge: false, body: Buffer.concat(chunks, total) });
    const onError = error => finish(reject, error);
    const onAborted = () => finish(reject, new Error('ABORTED'));
    const onClose = () => { if (!req.readableEnded) finish(reject, new Error('CLOSED')); };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
  });
}

function outcome(res, result) {
  if (result && result.ok === true) return send(res, 200, result);
  const code = result && typeof result.code === 'string' ? result.code : 'UNKNOWN';
  return send(res, 409, { ok: false, code });
}

function validate({ authority, credentials, maxBodyBytes }) {
  if (!authority || typeof authority !== 'object') throw new TypeError('authority');
  if (!(credentials instanceof Map) || credentials.size === 0) throw new TypeError('credentials');
  const tokens = new Map();
  for (const [token, actorId] of credentials) {
    if (typeof token !== 'string' || !TOKEN.test(token) || !isId(actorId)) {
      throw new TypeError('credentials');
    }
    tokens.set(token, actorId);
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) throw new TypeError('maxBodyBytes');
  return tokens;
}

export async function startLabTransport({ authority, credentials, resources, maxBodyBytes = DEFAULT_MAX_BODY } = {}) {
  const tokens = validate({ authority, credentials, maxBodyBytes });
  if (resources && (resources.authority !== authority || typeof resources.apply !== 'function')) throw new TypeError('resources');
  const server = createServer((req, res) => {
    // An aborted/oversized request can emit a late stream error after body cleanup.
    req.on('error', () => {});
    res.on('error', () => {});
    handle(req, res).catch(() => fail(res, 500, 'INTERNAL'));
  });
  server.requestTimeout = REQUEST_TIMEOUT;
  server.headersTimeout = HEADERS_TIMEOUT;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT;
  server.maxRequestsPerSocket = 1000;
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  async function handle(req, res) {
    const actorId = authenticate(req, tokens);
    if (!actorId) return reject(req, res, 401, 'UNAUTHORIZED');
    let pathname;
    try { pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname; } catch {
      return reject(req, res, 404, 'NOT_FOUND');
    }
    const route = routeOf(req.method, pathname);
    if (!route) return reject(req, res, 404, 'NOT_FOUND');
    if (['resources', 'database', 'asset'].includes(route.kind) && !resources) return reject(req, res, 404, 'NOT_FOUND');

    if (req.method === 'POST') {
      if (declaredTooLarge(req, maxBodyBytes)) return failAndClose(req, res, 413, 'BODY_LIMIT');
      if (!isJson(req)) return reject(req, res, 415, 'CONTENT_TYPE');
      let read;
      try { read = await readBody(req, maxBodyBytes); } catch {
        return fail(res, 400, 'INVALID_JSON');
      }
      if (read.tooLarge) return failAndClose(req, res, 413, 'BODY_LIMIT');
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.body)); } catch {
        return fail(res, 400, 'INVALID_JSON');
      }
      return outcome(res, route.kind === 'commands'
        ? authority.submit(actorId, body)
        : route.kind === 'memberships' ? authority.changeMembership(actorId, body) : resources.apply(actorId, body));
    }

    const result = route.kind === 'inspect' ? authority.inspect(actorId)
      : route.kind === 'document' ? authority.readDocument(actorId, route.id)
        : route.kind === 'receipt' ? authority.lookupReceipt(actorId, route.id)
          : route.kind === 'database' ? resources.readDatabase(actorId, route.id) : resources.readAsset(actorId, route.id);
    return outcome(res, result);
  }

  try {
    await new Promise((resolve, rejectListen) => {
      const onError = error => { cleanup(); rejectListen(error); };
      const onListening = () => { cleanup(); resolve(); };
      const cleanup = () => {
        server.off('error', onError);
        server.off('listening', onListening);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: '127.0.0.1', port: 0 });
    });
  } catch (error) {
    try { server.close(); } catch {}
    throw error;
  }

  const address = server.address();
  if (!address || typeof address !== 'object' || address.address !== '127.0.0.1') {
    try { server.closeAllConnections?.(); server.close(); } catch {}
    throw new Error('INVALID_LISTEN_ADDRESS');
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await new Promise(resolve => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
  }

  return { baseUrl: `http://127.0.0.1:${address.port}`, close };
}
