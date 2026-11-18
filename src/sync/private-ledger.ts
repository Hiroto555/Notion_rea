import {lstatSync} from "node:fs";
import {preflightExistingJournal} from "./journal-preflight";
import { SqliteConnectionOwner, closeSqlitePlatform } from "./sqlite-connection-owner";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SyncSqliteGuard } from "./sqlite-guard";
import { requireCondition } from "./protocol";
import {
  defaultPrivatePlatform,
  isValidPrivateLedgerName,
  synchronousPrivatePlatform,
  type PrivatePlatform,
} from "./private-platform";


function validateLedgerIdentity(db: DatabaseSync, role: string): void {
  const schema = db.prepare("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
  requireCondition(schema.length === 2 && schema.every(row => row.type === "table" && ["m3_private_identity", "m3_private_records"].includes(String(row.name))), "private-ledger-invalid", 409);
  const identity = db.prepare("SELECT * FROM m3_private_identity").all();
  requireCondition(identity.length === 1 && identity[0].singleton === 1 && identity[0].role === role && identity[0].version === 1, "private-ledger-invalid", 409);
}

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 4096;
/** Small main-owned metadata. Credential callers persist ciphertext only. */
export class PrivateLedger {
  private readonly platform!: PrivatePlatform;
  private readonly path!: string;
  private readonly guard!: SyncSqliteGuard;
  private readonly owner: SqliteConnectionOwner;
  private closed = false;
  private closing = false;
  /**
   * The optional platform is the final argument so existing POSIX callers keep
   * their default. On win32 the default fails closed unless an explicit native
   * port is supplied.
   */
  constructor(
    directory: string,
    name: string,
    role: string,
    forbiddenRoots: readonly string[] = [],
    platform?: PrivatePlatform,
  ) {
    requireCondition(
      isValidPrivateLedgerName(name) && /^[a-z0-9-]{1,64}$/.test(role),
      "private-ledger-invalid",
    );
    const supplied =
      platform ?? defaultPrivatePlatform(process.platform, forbiddenRoots);
    let facade: PrivatePlatform | undefined;
    this.owner = new SqliteConnectionOwner(() =>
      closeSqlitePlatform(facade ?? supplied),
    );
    try {
      facade = synchronousPrivatePlatform(supplied);
      this.platform = facade;
      const root = this.platform.bind(directory);
      this.path = join(root, name);
      this.platform.createExclusive(this.path);
      this.platform.assertFile(this.path);
      this.platform.assertSidecars(this.path);
      if (lstatSync(this.path).size > 0) preflightExistingJournal(this.path, () => {
        this.platform.assertRoot(); this.platform.assertFile(this.path); this.platform.assertSidecars(this.path);
      }, candidate => validateLedgerIdentity(candidate, role), this.platform, this.owner);
      const db = new DatabaseSync(this.path);
      this.owner.opened(db);
      this.guard = this.owner.guarded(db);
      {
        db.exec(
          "PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;",
        );
        this.guard.transaction(() => {
          const schema = db
            .prepare(
              "SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
            )
            .all();
          if (schema.length === 0) {
            this.platform.assertEmptyFile(this.path);
            db.exec(
              "CREATE TABLE m3_private_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),role TEXT NOT NULL,version INTEGER NOT NULL); CREATE TABLE m3_private_records(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
            );
            db.prepare("INSERT INTO m3_private_identity VALUES(1,?,1)").run(
              role,
            );
          } else
            requireCondition(
              schema.length === 2 &&
                schema.every(
                  (row) =>
                    row.type === "table" &&
                    ["m3_private_identity", "m3_private_records"].includes(
                      String(row.name),
                    ),
                ),
              "private-ledger-invalid",
              409,
            );
          const identity = db
            .prepare("SELECT * FROM m3_private_identity")
            .all();
          requireCondition(
            identity.length === 1 &&
              identity[0].singleton === 1 &&
              identity[0].role === role &&
              identity[0].version === 1,
            "private-ledger-invalid",
            409,
          );
          this.assertOwned();
        });
      }
    } catch (e) {
      this.owner.fail(e);
    }
  }
  assertOwned() {
    requireCondition(!this.closed, "private-ledger-closed", 409);
    requireCondition(!this.closing, "private-ledger-closing", 409);
    this.platform.assertRoot();
    this.platform.assertFile(this.path);
    // Sidecars are re-proven at every boundary because SQLite recreates the
    // journal/WAL per transaction; a pinned-then-replaced sidecar must fail.
    this.platform.assertSidecars(this.path);
    this.guard.assertUsable();
  }
  private key(key: string) {
    requireCondition(/^[a-z0-9:-]{1,200}$/.test(key), "private-ledger-key");
  }
  read(key: string): string | null {
    this.key(key);
    this.assertOwned();
    const row = this.guard.db
      .prepare("SELECT value FROM m3_private_records WHERE key=?")
      .get(key);
    this.assertOwned();
    if (!row) return null;
    requireCondition(
      typeof row.value === "string" &&
        Buffer.byteLength(row.value) <= 64 * 1024,
      "private-ledger-invalid",
      409,
    );
    return row.value;
  }
  entries(prefix: string, limit = 1000): { key: string; value: string }[] {
    this.key(prefix);
    this.assertOwned();
    requireCondition(
      Number.isInteger(limit) && limit > 0 && limit <= MAX_ROWS,
      "private-ledger-limit",
      409,
    );
    const rows = this.guard.db
      .prepare(
        "SELECT key,value FROM m3_private_records WHERE substr(key,1,?)=? ORDER BY key LIMIT ?",
      )
      .all(prefix.length, prefix, limit + 1);
    this.assertOwned();
    requireCondition(rows.length <= limit, "private-ledger-limit", 409);
    return rows.map((row) => {
      const key = String(row.key);
      this.key(key);
      requireCondition(
        typeof row.value === "string" &&
          Buffer.byteLength(row.value) <= 64 * 1024,
        "private-ledger-invalid",
        409,
      );
      return { key, value: row.value };
    });
  }
  transaction<T>(work: () => T): T {
    this.assertOwned();
    const result = this.guard.transaction(() => {
      this.assertOwned();
      const value = work();
      this.assertOwned();
      return value;
    });
    // The guard returns only after COMMIT. A sidecar/root failure here must be
    // surfaced, never reported as a successful transaction.
    this.assertOwned();
    return result;
  }
  /** Only inside this ledger's transaction; callers compare complete old values. */
  write(key: string, value: string | null) {
    this.key(key);
    this.assertOwned();
    requireCondition(
      this.guard.db.isTransaction,
      "private-ledger-transaction-required",
      409,
    );
    if (value === null) {
      this.guard.db
        .prepare("DELETE FROM m3_private_records WHERE key=?")
        .run(key);
      return;
    }
    requireCondition(
      typeof value === "string" &&
        Buffer.byteLength(value) > 0 &&
        Buffer.byteLength(value) <= 64 * 1024,
      "private-ledger-invalid",
    );
    const stats = this.guard.db
      .prepare(
        "SELECT COUNT(*) AS rows,COALESCE(SUM(length(CAST(value AS BLOB))),0) AS bytes FROM m3_private_records WHERE key<>?",
      )
      .get(key)!;
    requireCondition(
      Number(stats.rows) < MAX_ROWS &&
        Number(stats.bytes) + Buffer.byteLength(value) <= MAX_BYTES,
      "private-ledger-limit",
      409,
    );
    this.guard.db
      .prepare(
        "INSERT INTO m3_private_records VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  capacity(): Readonly<{rows: number; bytes: number; maxRows: number; maxBytes: number}> {
    this.assertOwned();
    const row = this.guard.db.prepare("SELECT count(*) AS rows,coalesce(sum(length(CAST(value AS BLOB))),0) AS bytes FROM m3_private_records").get()!;
    return {rows: Number(row.rows), bytes: Number(row.bytes), maxRows: MAX_ROWS, maxBytes: MAX_BYTES};
  }
  close() {
    if (this.closed) return;
    // Once an owned close is attempted, reads/mutations stay blocked even if
    // some handle could not be confirmed closed.
    this.closing = true;
    this.owner.close();
    this.closed = true;
  }
}
