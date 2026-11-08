import { closeSync, constants, fsyncSync, lstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { syncPath } from "../persistence/durable-file";
import { SyncSqliteGuard } from "./sqlite-guard";
import { requireCondition, SyncError } from "./protocol";
import { assertPrivateRoot, pinPrivateRoot, type PrivateRootPin } from "./m3-private-root";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 4096;
/** Small main-owned metadata. Credential callers persist ciphertext only. */
export class PrivateLedger {
  private readonly root: PrivateRootPin;
  private readonly path: string;
  private readonly pin: {dev: number; ino: number};
  private readonly guard: SyncSqliteGuard;
  private closed = false;
  constructor(directory: string, name: string, role: string, forbiddenRoots: readonly string[] = []) {
    requireCondition(/^[a-z][a-z0-9-]{0,60}\.sqlite$/.test(name) && /^[a-z0-9-]{1,64}$/.test(role), "private-ledger-invalid");
    this.root = pinPrivateRoot(directory, forbiddenRoots);
    this.path = join(this.root.path, name);
    try {
      const fd = openSync(this.path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      syncPath(this.root.path);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new SyncError("private-ledger-unavailable", 503); }
    this.pin = this.fileState();
    const db = new DatabaseSync(this.path);
    this.guard = new SyncSqliteGuard(db);
    try {
      db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;");
      this.guard.transaction(() => {
        const schema = db.prepare("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
        if (schema.length === 0) {
          requireCondition(lstatSync(this.path).size === 0, "private-ledger-invalid", 409);
          db.exec("CREATE TABLE m3_private_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),role TEXT NOT NULL,version INTEGER NOT NULL); CREATE TABLE m3_private_records(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
          db.prepare("INSERT INTO m3_private_identity VALUES(1,?,1)").run(role);
        } else requireCondition(schema.length === 2 && schema.every(row => row.type === "table" &&
          ["m3_private_identity", "m3_private_records"].includes(String(row.name))), "private-ledger-invalid", 409);
        const identity = db.prepare("SELECT * FROM m3_private_identity").all();
        requireCondition(identity.length === 1 && identity[0].singleton === 1 && identity[0].role === role && identity[0].version === 1, "private-ledger-invalid", 409);
        this.assertOwned();
      });
    } catch (e) { try {this.guard.close();} catch {} throw e; }
  }
  private fileState() {
    const stat = lstatSync(this.path);
    requireCondition(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === this.root.uid &&
      (stat.mode & 0o777) === 0o600 && stat.size <= 16 * 1024 * 1024, "private-ledger-unsafe", 409);
    return stat;
  }
  assertOwned() {
    requireCondition(!this.closed, "private-ledger-closed", 409);
    assertPrivateRoot(this.root);
    const stat = this.fileState();
    requireCondition(stat.dev === this.pin.dev && stat.ino === this.pin.ino, "private-ledger-changed", 409);
    this.guard.assertUsable();
  }
  private key(key: string) { requireCondition(/^[a-z0-9:-]{1,200}$/.test(key), "private-ledger-key"); }
  read(key: string): string | null {
    this.key(key); this.assertOwned();
    const row = this.guard.db.prepare("SELECT value FROM m3_private_records WHERE key=?").get(key);
    if (!row) return null;
    requireCondition(typeof row.value === "string" && Buffer.byteLength(row.value) <= 64 * 1024, "private-ledger-invalid", 409);
    return row.value;
  }
  entries(prefix: string, limit = 1000): {key: string; value: string}[] {
    this.key(prefix); this.assertOwned();
    requireCondition(Number.isInteger(limit) && limit > 0 && limit <= MAX_ROWS, "private-ledger-limit", 409);
    const rows = this.guard.db.prepare("SELECT key,value FROM m3_private_records WHERE substr(key,1,?)=? ORDER BY key LIMIT ?").all(prefix.length, prefix, limit + 1);
    requireCondition(rows.length <= limit, "private-ledger-limit", 409);
    return rows.map(row => {
      const key = String(row.key); this.key(key);
      requireCondition(typeof row.value === "string" && Buffer.byteLength(row.value) <= 64 * 1024, "private-ledger-invalid", 409);
      return {key, value: row.value};
    });
  }
  transaction<T>(work: () => T): T {
    this.assertOwned();
    return this.guard.transaction(() => {this.assertOwned(); const result = work(); this.assertOwned(); return result;});
  }
  /** Only inside this ledger's transaction; callers compare complete old values. */
  write(key: string, value: string | null) {
    this.key(key); this.assertOwned();
    requireCondition(this.guard.db.isTransaction, "private-ledger-transaction-required", 409);
    if (value === null) {this.guard.db.prepare("DELETE FROM m3_private_records WHERE key=?").run(key); return;}
    requireCondition(typeof value === "string" && Buffer.byteLength(value) > 0 && Buffer.byteLength(value) <= 64 * 1024, "private-ledger-invalid");
    const stats = this.guard.db.prepare("SELECT COUNT(*) AS rows,COALESCE(SUM(length(CAST(value AS BLOB))),0) AS bytes FROM m3_private_records WHERE key<>?").get(key)!;
    requireCondition(Number(stats.rows) < MAX_ROWS && Number(stats.bytes) + Buffer.byteLength(value) <= MAX_BYTES, "private-ledger-limit", 409);
    this.guard.db.prepare("INSERT INTO m3_private_records VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  close() { if (this.closed) return; this.guard.close(); this.closed = true; }
}
