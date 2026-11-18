import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { canonicalJson, cloneJson, isId } from './contracts.mjs';
import { validateCommand } from './command.mjs';
import { transitionReceipt } from './receipt.mjs';

const APPLICATION_ID = 1179406157;

const failed = code => ({ ok: false, code: code || 'INVALID' });

function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}

function parseEntry(row, scope) {
  try {
    const entry = cloneJson(JSON.parse(row.entry));
    const validated = validateCommand(entry.command);
    if (!validated.ok || entry.opId !== row.op_id || entry.opId !== validated.command.opId ||
        entry.fingerprint !== row.fingerprint || entry.fingerprint !== validated.fingerprint ||
        !['draft', 'local', 'unknown', 'server', 'peer', 'rejected'].includes(entry.stage) ||
        ['orgId', 'spaceId', 'actorId'].some(key => validated.command[key] !== scope[key])) throw new Error();
    if (entry.serverSeq !== undefined && (!Number.isSafeInteger(entry.serverSeq) || entry.serverSeq <= 0)) throw new Error();
    if (entry.epoch !== undefined && !isId(entry.epoch)) throw new Error();
    if (['server', 'peer'].includes(entry.stage) && (entry.serverSeq === undefined || entry.epoch === undefined)) throw new Error();
    return entry;
  } catch {
    throw new Error('CORRUPT_OUTBOX');
  }
}

function applicationId(db) {
  const row = db.prepare('PRAGMA application_id').get();
  return row ? Number(Object.values(row)[0]) : 0;
}

function validReceipt(receipt) {
  return receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt) && isId(receipt.opId) &&
    typeof receipt.fingerprint === 'string' && receipt.fingerprint.length > 0 &&
    isId(receipt.orgId) && isId(receipt.spaceId) && isId(receipt.actorId) &&
    Number.isSafeInteger(receipt.serverSeq) && receipt.serverSeq > 0 && isId(receipt.epoch);
}

export class LabOutbox {
  #orgId;
  #spaceId;
  #actorId;
  #maxOperations;
  #maxBytes;
  #db = null;
  #closed = true;

  constructor(file, options = {}) {
    const { orgId, spaceId, actorId, maxOperations = 10000, maxBytes = 8388608 } = options ?? {};
    if (typeof file !== 'string' || file.length === 0) throw new TypeError('file must be a path');
    if (!isId(orgId) || !isId(spaceId) || !isId(actorId)) throw new TypeError('invalid scope');
    if (!Number.isSafeInteger(maxOperations) || maxOperations <= 0) throw new TypeError('invalid maxOperations');
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('invalid maxBytes');

    this.#orgId = orgId;
    this.#spaceId = spaceId;
    this.#actorId = actorId;
    this.#maxOperations = maxOperations;
    this.#maxBytes = maxBytes;

    let db = null;
    try {
      const existed = existsSync(file);
      db = new DatabaseSync(file);
      db.exec('PRAGMA synchronous = FULL');
      const existingTables = existed
        ? db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(row => String(row.name))
        : [];
      const storedApplicationId = applicationId(db);
      if (storedApplicationId !== 0 && storedApplicationId !== APPLICATION_ID) {
        throw new Error('unrelated database application_id');
      }
      if (storedApplicationId === 0 && existingTables.length > 0) {
        throw new Error('unrelated existing database');
      }

      const reopen = storedApplicationId === APPLICATION_ID;
      if (reopen && (!existingTables.includes('outbox_meta') || !existingTables.includes('outbox'))) {
        throw new Error('CORRUPT_OUTBOX');
      }
      const scope = canonicalJson({ orgId, spaceId, actorId });
      transaction(db, () => {
        if (!reopen) db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
        db.exec('CREATE TABLE IF NOT EXISTS outbox_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        db.exec('CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, entry TEXT NOT NULL, bytes INTEGER NOT NULL)');
        const row = db.prepare("SELECT value FROM outbox_meta WHERE key = 'scope'").get();
        if (row) {
          if (canonicalJson(JSON.parse(row.value)) !== scope) throw new Error('outbox scope mismatch');
        } else if (reopen) {
          throw new Error('outbox scope missing');
        } else {
          db.prepare("INSERT INTO outbox_meta (key, value) VALUES ('scope', ?)").run(scope);
        }
      });

      this.#db = db;
      this.#closed = false;
    } catch (error) {
      if (db) {
        try {
          db.close();
        } catch {}
      }
      this.#db = null;
      this.#closed = true;
      throw error;
    }
  }

  #connection() {
    if (this.#closed || !this.#db) throw new Error('outbox is closed');
    return this.#db;
  }

  #entry(row) {
    return parseEntry(row, { orgId: this.#orgId, spaceId: this.#spaceId, actorId: this.#actorId });
  }

  close() {
    const db = this.#db;
    this.#db = null;
    this.#closed = true;
    if (db) db.close();
  }

  enqueue(command) {
    const db = this.#connection();
    const validation = validateCommand(command);
    if (!validation.ok) return validation;
    const { command: storedCommand, fingerprint } = validation;
    if (storedCommand.orgId !== this.#orgId || storedCommand.spaceId !== this.#spaceId || storedCommand.actorId !== this.#actorId) {
      return failed('SCOPE');
    }
    const opId = storedCommand.opId;
    const bytes = Buffer.byteLength(canonicalJson(storedCommand), 'utf8');

    return transaction(db, () => {
      const existing = db.prepare('SELECT op_id, fingerprint, entry FROM outbox WHERE op_id = ?').get(opId);
      if (existing) {
        if (existing.fingerprint === fingerprint) {
          return { ok: true, entry: this.#entry(existing), duplicate: true };
        }
        return failed('OPERATION');
      }
      const totals = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS total FROM outbox').get();
      if (Number(totals.count) >= this.#maxOperations) return failed('LIMIT');
      if (Number(totals.total) + bytes > this.#maxBytes) return failed('LIMIT');

      const entry = { opId, command: storedCommand, fingerprint, stage: 'local' };
      db.prepare('INSERT INTO outbox (op_id, fingerprint, entry, bytes) VALUES (?, ?, ?, ?)')
        .run(opId, fingerprint, canonicalJson(entry), bytes);
      return { ok: true, entry: cloneJson(entry), duplicate: false };
    });
  }

  read(opId) {
    const db = this.#connection();
    if (!isId(opId)) return failed('INVALID');
    const row = db.prepare('SELECT op_id, fingerprint, entry FROM outbox WHERE op_id = ?').get(opId);
    if (!row) return failed('MISSING');
    return { ok: true, entry: this.#entry(row) };
  }

  markUnknown(opId) {
    const db = this.#connection();
    if (!isId(opId)) return failed('INVALID');
    return transaction(db, () => {
      const row = db.prepare('SELECT op_id, fingerprint, entry FROM outbox WHERE op_id = ?').get(opId);
      if (!row) return failed('MISSING');
      const current = this.#entry(row);
      const result = transitionReceipt(cloneJson(current), { type: 'ackLost', opId });
      if (!result.ok) return result;
      const next = cloneJson(current);
      next.stage = result.receipt.stage;
      if (result.receipt.serverSeq !== undefined) next.serverSeq = result.receipt.serverSeq;
      db.prepare('UPDATE outbox SET entry = ? WHERE op_id = ?').run(canonicalJson(next), opId);
      return { ok: true, entry: cloneJson(next) };
    });
  }

  confirm(receipt, options = {}) {
    const db = this.#connection();
    if (!validReceipt(receipt)) return failed('INVALID');
    if (receipt.orgId !== this.#orgId || receipt.spaceId !== this.#spaceId || receipt.actorId !== this.#actorId) {
      return failed('SCOPE');
    }
    const fromQuery = options?.fromQuery === true;

    return transaction(db, () => {
      const row = db.prepare('SELECT op_id, fingerprint, entry FROM outbox WHERE op_id = ?').get(receipt.opId);
      if (!row) return failed('MISSING');
      if (row.fingerprint !== receipt.fingerprint) return failed('OPERATION');
      const current = this.#entry(row);
      if (current.epoch !== undefined && current.epoch !== receipt.epoch) return failed('EPOCH');
      if (current.stage === 'unknown' && !fromQuery) return failed('ORDER');

      const event = {
        opId: receipt.opId,
        type: fromQuery ? 'queryConfirmed' : 'serverAccepted',
        serverSeq: receipt.serverSeq
      };
      const result = transitionReceipt(cloneJson(current), event);
      if (!result.ok) return result;

      const next = cloneJson(current);
      next.stage = result.receipt.stage;
      next.serverSeq = result.receipt.serverSeq ?? receipt.serverSeq;
      next.epoch = receipt.epoch;
      db.prepare('UPDATE outbox SET entry = ? WHERE op_id = ?').run(canonicalJson(next), receipt.opId);
      return { ok: true, entry: cloneJson(next) };
    });
  }

  retryPlan(opId) {
    const db = this.#connection();
    if (!isId(opId)) return failed('INVALID');
    const row = db.prepare('SELECT op_id, fingerprint, entry FROM outbox WHERE op_id = ?').get(opId);
    if (!row) return failed('MISSING');
    const { stage } = this.#entry(row);
    if (stage === 'unknown') return { ok: true, action: 'QUERY_FIRST' };
    if (stage === 'local') return { ok: true, action: 'SEND' };
    if (stage === 'draft' || stage === 'server' || stage === 'peer' || stage === 'rejected') return { ok: true, action: 'NONE' };
    return failed('INVALID');
  }

  listPending() {
    const db = this.#connection();
    const rows = db.prepare('SELECT op_id, fingerprint, entry FROM outbox ORDER BY seq ASC').all();
    return rows.map(row => this.#entry(row)).filter(entry => entry.stage === 'local' || entry.stage === 'unknown');
  }
}
