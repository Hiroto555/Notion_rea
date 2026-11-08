import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { authorize } from './authz.mjs';
import { validateCommand } from './command.mjs';
import { decideLifecycle } from './lifecycle.mjs';
import { assessBudget } from './budget.mjs';
import { appendAudit, verifyAudit, MAX_AUDIT_RECORDS } from './audit.mjs';
import { applyMembershipChange } from './org.mjs';
import { canonicalJson, cloneJson, isId } from './contracts.mjs';
import { schema } from './schema.mjs';

const APPLICATION_ID = 1179406156;
const fail = code => ({ ok: false, code });
const defaults = { maxBytes: 16 * 1024 * 1024, maxPending: 1000, maxRequestBytes: 1024 * 1024 };

/** Experimental CAS journal, not the selected collaboration engine or a production server.
 * Actor identity is supplied by the trusted test harness: no authentication is implemented.
 * Only create this in a disposable directory. Existing unrelated SQLite files are refused.
 */
export class LabAuthority {
  constructor(file, { orgId, spaceId, epoch, ownerId, limits = {} }) {
    if (![orgId, spaceId, epoch, ownerId].every(isId)) throw new TypeError('invalid scope');
    this.scope = { orgId, spaceId, epoch };
    this.limits = { ...defaults, ...limits };
    const existed = existsSync(file);
    this.db = new DatabaseSync(file);
    try {
      const appId = this.db.prepare('PRAGMA application_id').get().application_id;
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      if ((existed && tables.length && appId !== APPLICATION_ID) || (appId !== 0 && appId !== APPLICATION_ID)) {
        throw new Error('UNRELATED_DATABASE');
      }
      if (appId === APPLICATION_ID) {
        const saved = JSON.parse(this.db.prepare('SELECT value FROM metadata WHERE key=?').get('scope').value);
        if (canonicalJson(saved) !== canonicalJson(this.scope)) throw new Error('SCOPE_MISMATCH');
      } else {
        this.db.exec(`BEGIN IMMEDIATE;
          PRAGMA application_id=${APPLICATION_ID};
          CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE members(user_id TEXT PRIMARY KEY,record TEXT NOT NULL);
          CREATE TABLE documents(doc_id TEXT PRIMARY KEY,record TEXT NOT NULL);
          CREATE TABLE receipts(op_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,fingerprint TEXT NOT NULL,record TEXT NOT NULL);
          CREATE TABLE events(seq INTEGER PRIMARY KEY,op_id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,bytes INTEGER NOT NULL);
          CREATE TABLE audit(seq INTEGER PRIMARY KEY,record TEXT NOT NULL);
        `);
        this.db.prepare('INSERT INTO metadata VALUES (?,?)').run('scope', canonicalJson(this.scope));
        this.db.prepare('INSERT INTO members VALUES (?,?)').run(ownerId, canonicalJson({
          userId: ownerId, orgId, role: 'owner', status: 'active', version: 1,
        }));
        this.db.exec('COMMIT');
      }
      this.db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      this.db.close();
      throw error;
    }
  }

  close() { this.db.close(); }
  members() { return this.db.prepare('SELECT record FROM members ORDER BY user_id').all().map(x => JSON.parse(x.record)); }
  auditEvents() { return this.db.prepare('SELECT record FROM audit ORDER BY seq').all().map(x => JSON.parse(x.record)); }
  auditHasCapacity() { return this.db.prepare('SELECT COUNT(*) AS count FROM audit').get().count < MAX_AUDIT_RECORDS; }

  permission(actorId, action) {
    const row = this.db.prepare('SELECT record FROM members WHERE user_id=?').get(actorId);
    const member = row && JSON.parse(row.record);
    return authorize({ membership: member && { ...member, spaceId: this.scope.spaceId },
      actorId, orgId: this.scope.orgId, spaceId: this.scope.spaceId, action });
  }

  addAudit(actorId, action, opId) {
    const next = appendAudit(this.auditEvents(), {
      actorId, ...{ orgId: this.scope.orgId, spaceId: this.scope.spaceId },
      action, opId, time: new Date().toISOString(), result: 'OK',
    });
    const last = next.at(-1);
    this.db.prepare('INSERT INTO audit VALUES (?,?)').run(last.seq, canonicalJson(last));
  }

  changeMembership(actorId, change) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = applyMembershipChange(this.members(), { ...change, actorId, orgId: this.scope.orgId });
      if (!result.ok) { this.db.exec('ROLLBACK'); return result; }
      if (!this.auditHasCapacity()) { this.db.exec('ROLLBACK'); return fail('AUDIT_LIMIT'); }
      for (const member of result.members) {
        this.db.prepare('INSERT OR REPLACE INTO members VALUES (?,?)').run(member.userId, canonicalJson(member));
      }
      this.addAudit(actorId, 'membership', randomUUID());
      this.db.exec('COMMIT');
      return result;
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }

  readDocument(actorId, docId) {
    const permission = this.permission(actorId, 'read');
    if (!permission.allowed) return fail(permission.code);
    if (!isId(docId)) return fail('INVALID');
    const row = this.db.prepare('SELECT record FROM documents WHERE doc_id=?').get(docId);
    return row ? { ok: true, document: JSON.parse(row.record) } : fail('MISSING');
  }

  lookupReceipt(actorId, opId) {
    const permission = this.permission(actorId, 'receipt');
    if (!permission.allowed) return fail(permission.code);
    if (!isId(opId)) return fail('INVALID');
    const row = this.db.prepare('SELECT actor_id,record FROM receipts WHERE op_id=?').get(opId);
    if (!row) return fail('MISSING');
    if (row.actor_id !== actorId) return fail('FORBIDDEN');
    return { ok: true, receipt: JSON.parse(row.record) };
  }

  submit(actorId, envelope, hooks = {}) {
    const validated = validateCommand(envelope, { maxBytes: this.limits.maxRequestBytes });
    if (!validated.ok) return validated;
    const { command, fingerprint } = validated;
    if (actorId !== command.actorId) return fail('ACTOR');
    if (command.orgId !== this.scope.orgId || command.spaceId !== this.scope.spaceId) return fail('SCOPE');
    this.db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const permission = this.permission(actorId, command.kind);
      if (!permission.allowed) { this.db.exec('ROLLBACK'); return fail(permission.code); }
      const prior = this.db.prepare('SELECT actor_id,fingerprint,record FROM receipts WHERE op_id=?').get(command.opId);
      if (prior) {
        this.db.exec('ROLLBACK');
        return prior.actor_id === actorId && prior.fingerprint === fingerprint
          ? { ok: true, receipt: JSON.parse(prior.record), duplicate: true } : fail('OPERATION');
      }
      if (!this.auditHasCapacity()) { this.db.exec('ROLLBACK'); return fail('AUDIT_LIMIT'); }
      const old = this.db.prepare('SELECT record FROM documents WHERE doc_id=?').get(command.docId);
      let document = old && JSON.parse(old.record);
      if (command.kind === 'create') {
        if (document || command.baseVersion !== 0) { this.db.exec('ROLLBACK'); return fail('CONFLICT'); }
        document = { docId: command.docId, incarnation: command.incarnation, version: 1, deleted: false, document: null };
      } else {
        if (!document) { this.db.exec('ROLLBACK'); return fail('MISSING'); }
        const decision = decideLifecycle({ current: document, request: { ...command, newIncarnation: command.payload.newIncarnation } });
        if (!decision.allowed) { this.db.exec('ROLLBACK'); return fail(decision.code); }
        document = { ...document, ...decision.next };
      }
      if (command.kind === 'create' || command.kind === 'edit') {
        const value = command.payload.document;
        let parsed;
        try {
          parsed = schema.nodeFromJSON(value);
          parsed.check();
          if (parsed.type !== schema.nodes.doc) throw new Error('invalid root');
        } catch {
          this.db.exec('ROLLBACK'); return fail('UNSUPPORTED_DOCUMENT');
        }
        if (canonicalJson(parsed.toJSON()) !== canonicalJson(value)) {
          this.db.exec('ROLLBACK'); return fail('UNSUPPORTED_DOCUMENT');
        }
        const ids = new Set();
        let validIds = true;
        parsed.descendants(node => {
          if ('blockId' in node.attrs) {
            if (!isId(node.attrs.blockId) || ids.has(node.attrs.blockId)) validIds = false;
            ids.add(node.attrs.blockId);
          }
        });
        if (!validIds) { this.db.exec('ROLLBACK'); return fail('INVALID_DOCUMENT_IDS'); }
        document.document = cloneJson(value);
      }
      const payload = canonicalJson(command);
      const bytes = Buffer.byteLength(payload);
      const usedBytes = this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM events').get().bytes;
      const budget = assessBudget({ usedBytes, pendingCount: 0, requestBytes: bytes, limits: this.limits });
      if (!budget.allowed) { this.db.exec('ROLLBACK'); return fail(budget.code); }
      const seq = this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM events').get().seq;
      const receipt = { opId: command.opId, actorId, orgId: command.orgId, spaceId: command.spaceId,
        docId: command.docId, incarnation: command.incarnation, fingerprint, stage: 'server', serverSeq: seq, epoch: this.scope.epoch };
      this.db.prepare('INSERT OR REPLACE INTO documents VALUES (?,?)').run(command.docId, canonicalJson(document));
      this.db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(seq, command.opId, payload, bytes);
      this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(command.opId, actorId, fingerprint, canonicalJson(receipt));
      this.addAudit(actorId, command.kind, command.opId);
      hooks.beforeCommit?.();
      this.db.exec('COMMIT');
      committed = true;
      hooks.afterCommit?.();
      return { ok: true, receipt, duplicate: false };
    } catch (error) {
      if (committed) return { ok: false, code: 'UNKNOWN', opId: command.opId };
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  inspect(actorId) {
    const permission = this.permission(actorId, 'manage');
    if (!permission.allowed) return fail(permission.code);
    return { ok: true, scope: { ...this.scope }, memberCount: this.members().length,
      eventCount: this.db.prepare('SELECT COUNT(*) AS count FROM events').get().count,
      storedPayloadBytes: this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM events').get().bytes,
      audit: verifyAudit(this.auditEvents()), writeBlockedReason: this.auditHasCapacity() ? null : 'AUDIT_LIMIT',
      authentication: 'TRUSTED_HARNESS_ONLY' };
  }
}
