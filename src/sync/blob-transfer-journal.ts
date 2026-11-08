import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { syncPath } from "../persistence/durable-file";
import { canonicalJson, requireCondition, SyncError } from "./protocol";
import { SyncSqliteGuard } from "./sqlite-guard";
import { assertSqliteSidecars } from "./m3-private-root";
import type {
  BlobTransferDescriptor,
  BlobTransferLimits,
  BlobTransferRecord,
  BlobTransferScope,
} from "./blob-transfer-types";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const EMPTY = digest("");
const MAX_BYTES = 20_000_000;
const defaults = { maxEntries: 1000, maxBytes: 100 * 1024 * 1024 };
function validDescriptor(d: BlobTransferDescriptor) {
  requireCondition(
    d &&
      Object.keys(d).sort().join() === "assetId,bytes,direction,sha256" &&
      ["download", "upload"].includes(d.direction) &&
      typeof d.assetId === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(d.assetId) &&
      !d.assetId.includes("..") &&
      typeof d.sha256 === "string" &&
      HASH.test(d.sha256) &&
      Number.isSafeInteger(d.bytes) &&
      d.bytes >= 0 &&
      d.bytes <= MAX_BYTES,
    "invalid-blob-transfer-descriptor",
  );
}
function busy(error: unknown): boolean {
  return (
    /locked|SQLITE_BUSY|SQLITE_LOCKED/.test(String(error)) ||
    (error instanceof AggregateError && error.errors.some(busy))
  );
}

/** A private cache journal, independent of workspace schema and save receipts. */
export class BlobTransferJournal {
  readonly directory: string;
  private readonly scopeHash: string;
  private readonly limits: BlobTransferLimits;
  private readonly databasePath: string;
  private readonly rootPin: { dev: number; ino: number };
  private readonly databasePin: { dev: number; ino: number };
  private readonly guard: SyncSqliteGuard;
  private closed = false;

  constructor(
    directory: string,
    scope: BlobTransferScope | Readonly<{ scopeHash: string }>,
    limits: Partial<BlobTransferLimits> = {},
  ) {
    const maintenance = scope && Object.keys(scope).join() === "scopeHash";
    if (maintenance) requireCondition(HASH.test((scope as {scopeHash: string}).scopeHash), "invalid-blob-transfer-scope");
    else requireCondition(
      scope &&
        Object.keys(scope).sort().join() ===
          "baseUrlHash,bindingId,clientId,serverEpoch,workspaceId" &&
        HASH.test((scope as BlobTransferScope).baseUrlHash) &&
        [
          (scope as BlobTransferScope).workspaceId,
          (scope as BlobTransferScope).clientId,
          (scope as BlobTransferScope).bindingId,
          (scope as BlobTransferScope).serverEpoch,
        ].every((x) => typeof x === "string" && ID.test(x)),
      "invalid-blob-transfer-scope",
    );
    this.scopeHash = maintenance ? (scope as {scopeHash: string}).scopeHash : digest(canonicalJson(scope));
    this.limits = { ...defaults, ...limits };
    requireCondition(
      Number.isSafeInteger(this.limits.maxEntries) &&
        this.limits.maxEntries > 0 &&
        this.limits.maxEntries <= defaults.maxEntries &&
        Number.isSafeInteger(this.limits.maxBytes) &&
        this.limits.maxBytes >= 0 &&
        this.limits.maxBytes <= defaults.maxBytes,
      "invalid-blob-transfer-limits",
    );
    const path = resolve(directory);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    requireCondition(
      stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o022) === 0,
      "unsafe-blob-transfer-root",
      409,
    );
    this.directory = realpathSync(path);
    this.rootPin = stat;
    this.databasePath = join(this.directory, "state.sqlite");
    try {
      const fd = openSync(
        this.databasePath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_RDWR |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      syncPath(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    this.databasePin = this.checkDatabase();
    assertSqliteSidecars(this.databasePath, stat.uid);
    const db = new DatabaseSync(this.databasePath);
    this.guard = new SyncSqliteGuard(db);
    try {
      db.exec(
        "PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE;",
      );
      this.guard.transaction(() => {
        const tables = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all()
          .map((row) => row.name);
        if (tables.length === 0) {
          requireCondition(
            this.databasePin && lstatSync(this.databasePath).size === 0,
            "blob-transfer-corrupt",
            409,
          );
          db.exec(
            "CREATE TABLE transfer_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, scope_hash TEXT NOT NULL); CREATE TABLE blob_transfers (key TEXT PRIMARY KEY,data TEXT NOT NULL)",
          );
          db.prepare("INSERT INTO transfer_identity VALUES(1,1,?)").run(
            this.scopeHash,
          );
        } else
          requireCondition(
            tables.length === 2 &&
              tables.includes("transfer_identity") &&
              tables.includes("blob_transfers"),
            "blob-transfer-corrupt",
            409,
          );
        const identity = db.prepare("SELECT * FROM transfer_identity").all();
        requireCondition(
          identity.length === 1 &&
            identity[0].singleton === 1 &&
            identity[0].version === 1 &&
            identity[0].scope_hash === this.scopeHash,
          "blob-transfer-scope-mismatch",
          409,
        );
      });
      this.assertOwned();
      this.inventory();
    } catch (error) {
      try {
        this.guard.close();
      } catch {}
      if (busy(error)) throw new SyncError("blob-transfer-locked", 409);
      throw error;
    }
  }
  private checkDatabase() {
    const stat = lstatSync(this.databasePath);
    requireCondition(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.nlink === 1 &&
        (stat.mode & 0o022) === 0 &&
        stat.size <= 16 * 1024 * 1024,
      "unsafe-blob-transfer-journal",
      409,
    );
    return stat;
  }
  private assertOwned() {
    requireCondition(!this.closed, "blob-transfer-closed", 409);
    const root = lstatSync(this.directory),
      db = this.checkDatabase();
    requireCondition(
      root.isDirectory() &&
        !root.isSymbolicLink() &&
        root.dev === this.rootPin.dev &&
        root.ino === this.rootPin.ino &&
        db.dev === this.databasePin.dev &&
        db.ino === this.databasePin.ino,
      "blob-transfer-path-changed",
      409,
    );
    this.guard.assertUsable();
  }
  private parse(raw: unknown): BlobTransferRecord {
    let record: BlobTransferRecord;
    try {
      record = JSON.parse(String(raw));
    } catch {
      throw new SyncError("blob-transfer-corrupt", 409);
    }
    requireCondition(
      record &&
        Object.keys(record).sort().join() ===
          "assetId,bytes,direction,key,offset,partialName,prefixHash,reason,scopeHash,sha256,state,updatedAt",
      "blob-transfer-corrupt",
      409,
    );
    const descriptor = this.descriptor(record);
    validDescriptor(descriptor);
    requireCondition(
      record.scopeHash === this.scopeHash &&
        record.key === this.key(descriptor) &&
        record.partialName === record.key + ".part" &&
        Number.isSafeInteger(record.offset) &&
        record.offset >= 0 &&
        record.offset <= record.bytes &&
        HASH.test(record.prefixHash) &&
        (record.offset !== 0 || record.prefixHash === EMPTY) &&
        ["active", "completed", "blocked", "releasing"].includes(record.state) &&
        Number.isSafeInteger(record.updatedAt) &&
        record.updatedAt >= 0 &&
        (record.reason === null || /^[a-z0-9-]{1,100}$/.test(record.reason)) &&
        (record.state !== "completed" ||
          (record.offset === record.bytes &&
            record.prefixHash === record.sha256)),
      "blob-transfer-corrupt",
      409,
    );
    return record;
  }
  private descriptor(d: BlobTransferDescriptor): BlobTransferDescriptor {
    return {
      direction: d.direction,
      assetId: d.assetId,
      sha256: d.sha256,
      bytes: d.bytes,
    };
  }
  private key(d: BlobTransferDescriptor) {
    return digest(
      canonicalJson({ scopeHash: this.scopeHash, ...this.descriptor(d) }),
    );
  }
  inventory() {
    this.assertOwned();
    const rows = this.guard.db
      .prepare("SELECT key,data FROM blob_transfers LIMIT ?")
      .all(this.limits.maxEntries + 1);
    requireCondition(
      rows.length <= this.limits.maxEntries,
      "blob-transfer-limit",
      409,
    );
    return rows.map((row) => {
      const record = this.parse(row.data);
      requireCondition(record.key === row.key, "blob-transfer-corrupt", 409);
      return record;
    });
  }
  get(key: string) {
    this.assertOwned();
    requireCondition(HASH.test(key), "invalid-blob-transfer-key");
    const row = this.guard.db
      .prepare("SELECT data FROM blob_transfers WHERE key=?")
      .get(key);
    return row ? this.parse(row.data) : null;
  }
  begin(descriptor: BlobTransferDescriptor) {
    validDescriptor(descriptor);
    this.assertOwned();
    const key = this.key(descriptor);
    const previous = this.get(key);
    if (previous) {
      requireCondition(previous.state !== "releasing", "blob-transfer-release-pending", 409);
      requireCondition(
        previous.state !== "blocked",
        "blob-transfer-blocked",
        409,
      );
      return previous;
    }
    const rows = this.inventory();
    requireCondition(
      rows.length < this.limits.maxEntries &&
        rows
          .filter((row) => row.state !== "completed")
          .reduce((n, row) => n + row.bytes, descriptor.bytes) <=
          this.limits.maxBytes,
      "blob-transfer-limit",
      409,
    );
    const record: BlobTransferRecord = {
      ...descriptor,
      key,
      scopeHash: this.scopeHash,
      partialName: key + ".part",
      offset: 0,
      prefixHash: EMPTY,
      state: "active",
      reason: null,
      updatedAt: Date.now(),
    };
    this.guard.transaction(() =>
      this.guard.db
        .prepare("INSERT INTO blob_transfers VALUES(?,?)")
        .run(key, canonicalJson(record)),
    );
    return record;
  }
  private change(
    key: string,
    update: (record: BlobTransferRecord) => BlobTransferRecord,
  ) {
    this.assertOwned();
    let result!: BlobTransferRecord;
    this.guard.transaction(() => {
      const old = this.get(key);
      requireCondition(old, "blob-transfer-missing", 409);
      result = update(old);
      this.parse(canonicalJson(result));
      const changed = this.guard.db
        .prepare("UPDATE blob_transfers SET data=? WHERE key=? AND data=?")
        .run(canonicalJson(result), key, canonicalJson(old));
      requireCondition(changed.changes === 1, "blob-transfer-changed", 409);
    });
    return result;
  }
  checkpoint(key: string, offset: number, prefixHash: string) {
    return this.change(key, (old) => {
      requireCondition(
        old.state === "active" &&
          Number.isSafeInteger(offset) &&
          offset >= old.offset &&
          offset <= old.bytes &&
          HASH.test(prefixHash) &&
          (offset !== old.offset || prefixHash === old.prefixHash),
        "invalid-blob-transfer-checkpoint",
        409,
      );
      return { ...old, offset, prefixHash, updatedAt: Date.now() };
    });
  }
  complete(key: string) {
    return this.change(key, (old) => {
      requireCondition(old.state === "active" || old.state === "completed", "blob-transfer-blocked", 409);
      return {
        ...old,
        offset: old.bytes,
        prefixHash: old.sha256,
        state: "completed",
        updatedAt: Date.now(),
      };
    });
  }
  block(key: string, reason: string) {
    requireCondition(
      /^[a-z0-9-]{1,100}$/.test(reason),
      "invalid-blob-transfer-reason",
    );
    return this.change(key, (old) => {
      requireCondition(
        old.state === "active" || old.state === "blocked",
        "blob-transfer-completed",
        409,
      );
      return { ...old, state: "blocked", reason, updatedAt: Date.now() };
    });
  }
  compactCompleted() {
    this.assertOwned();
    this.inventory();
    let count = 0;
    this.guard.transaction(() => {
      for (const row of this.inventory())
        if (row.state === "completed")
          count += Number(
            this.guard.db
              .prepare("DELETE FROM blob_transfers WHERE key=? AND data=?")
              .run(row.key, canonicalJson(row)).changes,
          );
    });
    return count;
  }
  /** Caller owns the global cache mutex and a durable release operation. */
  markRelease(expected: BlobTransferRecord, operationId: string) {
    requireCondition(/^[a-f0-9-]{36}$/.test(operationId), "invalid-cache-release-id");
    return this.change(expected.key, old => {
      if (old.state === "releasing" && old.reason === operationId) return old;
      requireCondition(old.state !== "releasing" && canonicalJson(old) === canonicalJson(expected), "cache-release-stale", 409);
      return {...old, state: "releasing", reason: operationId, updatedAt: Date.now()};
    });
  }
  finishRelease(key: string, operationId: string): boolean {
    this.assertOwned();
    return this.guard.transaction(() => {
      const old = this.get(key);
      if (!old || old.state !== "releasing" || old.reason !== operationId) return false;
      return this.guard.db.prepare("DELETE FROM blob_transfers WHERE key=? AND data=?")
        .run(key, canonicalJson(old)).changes === 1;
    });
  }
  close() {
    if (this.closed) return;
    this.guard.close();
    this.closed = true;
  }
}
