import { canonicalJson, cloneJson, hashJson, isId } from './contracts.mjs';
import { applyRecordCommand, validateRecordState } from './records.mjs';
import { validateAsset } from './asset-admission.mjs';
import { assessBudget } from './budget.mjs';

const fail = code => ({ ok: false, code });
const HASH = /^[0-9a-f]{64}$/;
const MAX_ASSET_TOTAL = 8 * 1024 * 1024;

/** Lab-only DB/blob resources. Shares the authority's SQLite transaction and event order.
 * Assets are published to this space on explicit upload, not through private-copy import.
 */
export class LabResources {
  constructor(authority) {
    this.authority = authority;
    authority.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS resource_databases(id TEXT PRIMARY KEY,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resource_assets(sha256 TEXT PRIMARY KEY,size INTEGER NOT NULL,bytes BLOB NOT NULL);
      COMMIT;`);
  }

  apply(actorId, input, hooks = {}) {
    const authority = this.authority, db = authority.db;
    let request, payloadText;
    try { request = cloneJson(input); payloadText = canonicalJson(request); } catch { return fail('INVALID'); }
    if (!request || request.protocol !== 'folio-resource-lab/1' ||
        !['opId','actorId','orgId','spaceId'].every(key => isId(request[key])) ||
        !request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload) ||
        !['databaseCreate','recordChange','assetPut'].includes(request.kind)) return fail('INVALID');
    if (request.actorId !== actorId) return fail('ACTOR');
    if (request.orgId !== authority.scope.orgId || request.spaceId !== authority.scope.spaceId) return fail('SCOPE');
    const bytes = Buffer.byteLength(payloadText);
    if (bytes > authority.limits.maxRequestBytes) return fail('REQUEST_LIMIT');
    const fingerprint = hashJson(request);
    const action = request.kind === 'databaseCreate' ? 'manage' : request.kind === 'assetPut' ? 'assetWrite'
      : request.payload.action === 'restore' ? 'restore' : 'edit';
    db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const permission = authority.permission(actorId, action);
      if (!permission.allowed) { db.exec('ROLLBACK'); return fail(permission.code); }
      const prior = db.prepare('SELECT actor_id,fingerprint,record FROM receipts WHERE op_id=?').get(request.opId);
      if (prior) {
        db.exec('ROLLBACK');
        return prior.actor_id === actorId && prior.fingerprint === fingerprint
          ? { ok: true, receipt: JSON.parse(prior.record), duplicate: true } : fail('OPERATION');
      }
      if (!authority.auditHasCapacity()) { db.exec('ROLLBACK'); return fail('AUDIT_LIMIT'); }
      const usedBytes = db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM events').get().bytes;
      const budget = assessBudget({ usedBytes, pendingCount: 0, requestBytes: bytes, limits: authority.limits });
      if (!budget.allowed) { db.exec('ROLLBACK'); return fail(budget.code); }
      const changed = this.applyPayload(request);
      if (!changed.ok) { db.exec('ROLLBACK'); return changed; }
      const seq = db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM events').get().seq;
      const receipt = { opId: request.opId, actorId, orgId: request.orgId, spaceId: request.spaceId,
        fingerprint, stage: 'server', serverSeq: seq, epoch: authority.scope.epoch, kind: request.kind };
      db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(seq, request.opId, payloadText, bytes);
      db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(request.opId, actorId, fingerprint, canonicalJson(receipt));
      authority.addAudit(actorId, request.kind, request.opId);
      hooks.beforeCommit?.();
      db.exec('COMMIT'); committed = true;
      hooks.afterCommit?.();
      return { ok: true, receipt, duplicate: false };
    } catch (error) {
      if (committed) return { ok: false, code: 'UNKNOWN', opId: request.opId };
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  applyPayload({ kind, payload }) {
    const db = this.authority.db;
    if (kind === 'databaseCreate') {
      const state = payload.state;
      if (!validateRecordState(state) || state.records.length !== 0) return fail('INVALID');
      if (db.prepare('SELECT id FROM resource_databases WHERE id=?').get(state.databaseId)) return fail('CONFLICT');
      db.prepare('INSERT INTO resource_databases VALUES (?,?)').run(state.databaseId, canonicalJson(state));
      return { ok: true };
    }
    if (kind === 'recordChange') {
      if (!isId(payload.databaseId)) return fail('INVALID');
      const row = db.prepare('SELECT state FROM resource_databases WHERE id=?').get(payload.databaseId);
      if (!row) return fail('MISSING');
      const state = JSON.parse(row.state);
      if (!validateRecordState(state) || state.databaseId !== payload.databaseId) return fail('INTEGRITY');
      const result = applyRecordCommand(state, payload);
      if (!result.ok) return result;
      db.prepare('UPDATE resource_databases SET state=? WHERE id=?').run(canonicalJson(result.state), payload.databaseId);
      return { ok: true };
    }
    if (typeof payload.base64 !== 'string' || payload.base64.length > Math.ceil(this.authority.limits.maxRequestBytes / 3) * 4) return fail('INVALID');
    const bytes = Buffer.from(payload.base64, 'base64');
    if (bytes.toString('base64') !== payload.base64) return fail('INVALID');
    const checked = validateAsset({ bytes, sha256: payload.sha256, expectedSize: payload.size, maxBytes: this.authority.limits.maxRequestBytes });
    if (!checked.ok) return checked;
    const existing = db.prepare('SELECT size,bytes FROM resource_assets WHERE sha256=?').get(payload.sha256);
    if (existing) {
      const old = validateAsset({ bytes: existing.bytes, sha256: payload.sha256, expectedSize: existing.size, maxBytes: this.authority.limits.maxRequestBytes });
      return old.ok && existing.size === checked.asset.size ? { ok: true } : fail('INTEGRITY');
    }
    const stored = db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM resource_assets').get().bytes;
    if (stored + checked.asset.size > MAX_ASSET_TOTAL) return fail('ASSET_LIMIT');
    db.prepare('INSERT INTO resource_assets VALUES (?,?,?)').run(payload.sha256, checked.asset.size, checked.asset.bytes);
    return { ok: true };
  }

  readDatabase(actorId, databaseId) {
    const permission = this.authority.permission(actorId, 'read');
    if (!permission.allowed) return fail(permission.code);
    if (!isId(databaseId)) return fail('INVALID');
    const row = this.authority.db.prepare('SELECT state FROM resource_databases WHERE id=?').get(databaseId);
    if (!row) return fail('MISSING');
    try {
      const state = JSON.parse(row.state);
      return validateRecordState(state) && state.databaseId === databaseId ? { ok: true, state: cloneJson(state) } : fail('INTEGRITY');
    } catch { return fail('INTEGRITY'); }
  }

  readAsset(actorId, sha256) {
    const permission = this.authority.permission(actorId, 'assetRead');
    if (!permission.allowed) return fail(permission.code);
    if (typeof sha256 !== 'string' || !HASH.test(sha256)) return fail('INVALID');
    const row = this.authority.db.prepare('SELECT size,bytes FROM resource_assets WHERE sha256=?').get(sha256);
    if (!row) return fail('MISSING');
    const checked = validateAsset({ bytes: row.bytes, sha256, expectedSize: row.size, maxBytes: this.authority.limits.maxRequestBytes });
    return checked.ok ? { ok: true, asset: { sha256, size: row.size, base64: checked.asset.bytes.toString('base64') } } : fail('INTEGRITY');
  }
}
