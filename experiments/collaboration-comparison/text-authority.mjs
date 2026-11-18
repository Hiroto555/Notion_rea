import { DatabaseSync } from "node:sqlite";
import { openSync, readSync, closeSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  canonicalJson,
  clone,
  fingerprint,
  id,
  scope,
  document,
  envelope,
  applyTextSteps,
  keys,
} from "./text-protocol.mjs";
const APP = 0x464c5450,
  VERSION = 1002;
const SCHEMA = [
  "CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)",
  "CREATE TABLE head (id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL, version INTEGER NOT NULL)",
  "CREATE TABLE steps (seq INTEGER PRIMARY KEY, data TEXT NOT NULL, client_id TEXT NOT NULL)",
  "CREATE TABLE operations (operation_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, fingerprint TEXT NOT NULL, envelope TEXT NOT NULL, receipt TEXT NOT NULL)",
];
function safe(path) {
  let main;
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    let s;
    try {
      s = lstatSync(path + suffix);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (s && (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1))
      throw Error("UNSAFE_PATH");
    if (!suffix) main = s;
    else if (s && !main) throw Error("ORPHAN_SIDECAR");
  }
  return main;
}
function header(path) {
  const fd = openSync(path, "r");
  try {
    const b = Buffer.alloc(100);
    if (
      readSync(fd, b, 0, 100, 0) !== 100 ||
      b.subarray(0, 16).toString("binary") !== "SQLite format 3\0" ||
      b.readUInt32BE(60) !== VERSION ||
      b.readUInt32BE(68) !== APP
    )
      throw Error("FOREIGN_FORMAT");
  } finally {
    closeSync(fd);
  }
}
/** Trusted fixture identity, one server-ordered rich-document text lane. */
export class TextAuthority {
  constructor(file, options) {
    this.file = file;
    this.closed = false;
    this.scope = scope(options.scope);
    id(options.epoch);
    this.epoch = options.epoch;
    if (
      !Array.isArray(options.actors) ||
      !options.actors.length ||
      options.actors.length > 5
    )
      throw Error("INVALID_ACTORS");
    options.actors.forEach(id);
    this.actors = [...new Set(options.actors)].sort();
    this.seed = clone(document(options.document));
    this.meta = canonicalJson({
      scope: this.scope,
      epoch: this.epoch,
      seed: this.seed,
      actors: this.actors,
    });
    const existing = safe(file);
    if (existing) {
      header(file);
      const probe = new DatabaseSync(file, { readOnly: true });
      try {
        this.validate(probe);
      } finally {
        probe.close();
      }
    }
    mkdirSync(dirname(file), { recursive: true });
    if (!existing) {
      const fd = openSync(file, "wx", 0o600);
      closeSync(fd);
    }
    this.db = new DatabaseSync(file);
    try {
      if (!existing) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          for (const sql of SCHEMA) this.db.exec(sql);
          this.db.exec(
            `PRAGMA application_id=${APP}; PRAGMA user_version=${VERSION}`,
          );
          this.db.prepare("INSERT INTO meta VALUES(1,?)").run(this.meta);
          this.db
            .prepare("INSERT INTO head VALUES(1,?,0)")
            .run(canonicalJson(this.seed));
          this.db.exec("COMMIT");
        } catch (e) {
          if (this.db.isTransaction) this.db.exec("ROLLBACK");
          throw e;
        }
      }
      this.validate(this.db);
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000",
      );
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  check(actor) {
    if (this.closed) throw Error("CLOSED");
    if (!this.actors.includes(actor)) throw Error("FORBIDDEN");
  }
  validate(db) {
    if (
      db.prepare("PRAGMA application_id").get().application_id !== APP ||
      db.prepare("PRAGMA user_version").get().user_version !== VERSION
    )
      throw Error("FOREIGN_FORMAT");
    const sql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((x) => x.sql)
      .sort();
    if (
      canonicalJson(sql) !== canonicalJson([...SCHEMA].sort()) ||
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('trigger','view')",
        )
        .all().length
    )
      throw Error("CORRUPT_SCHEMA");
    if (
      db.prepare("SELECT data FROM meta WHERE id=1").get()?.data !== this.meta
    )
      throw Error("SCOPE_MISMATCH");
    const rows = db.prepare("SELECT * FROM steps ORDER BY seq").all(),
      head = db.prepare("SELECT * FROM head WHERE id=1").get();
    const operations = db.prepare("SELECT * FROM operations").all();
    if (
      rows.length > 256 ||
      operations.length > 256 ||
      Buffer.byteLength(canonicalJson({ rows, head, operations })) > 8_000_000
    )
      throw Error("LIMIT");
    if (
      !head ||
      head.version !== rows.length ||
      rows.some((row, i) => row.seq !== i + 1)
    )
      throw Error("CORRUPT_LOG");
    let projected = this.seed;
    if (rows.length)
      projected = applyTextSteps(
        this.seed,
        rows.map((x) => JSON.parse(x.data)),
      );
    if (canonicalJson(projected) !== head.document) throw Error("CORRUPT_HEAD");
    const covered = new Set();
    for (const row of operations) {
      let env, receipt;
      try {
        env = envelope(JSON.parse(row.envelope));
        receipt = JSON.parse(row.receipt);
        keys(receipt, [
          "status",
          "operationId",
          "fingerprint",
          "epoch",
          "scope",
          "version",
          "steps",
          "clientID",
        ]);
      } catch {
        throw Error("CORRUPT_RECEIPT");
      }
      if (row.receipt !== canonicalJson(receipt))
        throw Error("CORRUPT_RECEIPT");
      if (
        row.operation_id !== env.operationId ||
        !this.actors.includes(row.actor_id) ||
        row.fingerprint !== fingerprint(row.actor_id, env) ||
        row.envelope !== canonicalJson(env) ||
        receipt.fingerprint !== row.fingerprint ||
        receipt.status !== "SERVER_ACCEPTED" ||
        receipt.clientID !== env.deviceId ||
        receipt.operationId !== env.operationId ||
        receipt.epoch !== env.epoch ||
        canonicalJson(receipt.scope) !== canonicalJson(env.scope) ||
        receipt.version !== env.baseVersion + env.steps.length ||
        canonicalJson(receipt.steps) !== canonicalJson(env.steps)
      )
        throw Error("CORRUPT_RECEIPT");
      for (let index = env.baseVersion; index < receipt.version; index++) {
        if (covered.has(index)) throw Error("CORRUPT_RECEIPT");
        covered.add(index);
      }
      if (
        env.epoch !== this.epoch ||
        canonicalJson(env.scope) !== canonicalJson(this.scope) ||
        receipt.version > rows.length ||
        canonicalJson(
          rows
            .slice(env.baseVersion, receipt.version)
            .map((x) => JSON.parse(x.data)),
        ) !== canonicalJson(env.steps) ||
        rows
          .slice(env.baseVersion, receipt.version)
          .some((x) => x.client_id !== env.deviceId)
      )
        throw Error("CORRUPT_RECEIPT");
    }
    if (covered.size !== rows.length) throw Error("CORRUPT_RECEIPT");
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
      throw Error("CORRUPT_LOG");
  }
  snapshot(actor) {
    this.check(actor);
    this.db.exec("BEGIN");
    try {
      this.validate(this.db);
      const h = this.db.prepare("SELECT * FROM head WHERE id=1").get();
      const rows = this.db.prepare("SELECT * FROM steps ORDER BY seq").all();
      const result = clone({
        scope: this.scope,
        epoch: this.epoch,
        seed: this.seed,
        document: JSON.parse(h.document),
        version: h.version,
        steps: rows.map((x) => JSON.parse(x.data)),
        clientIDs: rows.map((x) => x.client_id),
      });
      if (Buffer.byteLength(canonicalJson(result)) > 8_000_000)
        throw Error("LIMIT");
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
  }
  receipt(actor, operationId) {
    this.check(actor);
    this.db.exec("BEGIN");
    try {
      this.validate(this.db);
      const row = this.db
        .prepare("SELECT * FROM operations WHERE operation_id=? AND actor_id=?")
        .get(operationId, actor);
      const result = row ? JSON.parse(row.receipt) : undefined;
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
  }
  submit(actor, input, hooks = {}) {
    this.check(actor);
    const env = envelope(input),
      fp = fingerprint(actor, env);
    if (canonicalJson(env.scope) !== canonicalJson(this.scope))
      throw Error("SCOPE_MISMATCH");
    if (env.epoch !== this.epoch) throw Error("EPOCH_MISMATCH");
    let receipt;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.validate(this.db);
      const previous = this.db
        .prepare("SELECT * FROM operations WHERE operation_id=?")
        .get(env.operationId);
      if (previous) {
        if (previous.actor_id !== actor || previous.fingerprint !== fp)
          throw Error("ID_REUSE");
        this.db.exec("COMMIT");
        return JSON.parse(previous.receipt);
      }
      const h = this.db.prepare("SELECT * FROM head WHERE id=1").get();
      if (h.version !== env.baseVersion) throw Error("STALE_VERSION");
      const projected = applyTextSteps(JSON.parse(h.document), env.steps);
      if (h.version + env.steps.length > 256) throw Error("LIMIT");
      receipt = {
        status: "SERVER_ACCEPTED",
        operationId: env.operationId,
        fingerprint: fp,
        epoch: this.epoch,
        scope: this.scope,
        version: h.version + env.steps.length,
        steps: env.steps,
        clientID: env.deviceId,
      };
      env.steps.forEach((step, i) =>
        this.db
          .prepare("INSERT INTO steps VALUES(?,?,?)")
          .run(h.version + i + 1, canonicalJson(step), env.deviceId),
      );
      this.db
        .prepare("UPDATE head SET document=?,version=? WHERE id=1")
        .run(canonicalJson(projected), receipt.version);
      this.db
        .prepare("INSERT INTO operations VALUES(?,?,?,?,?)")
        .run(
          env.operationId,
          actor,
          fp,
          canonicalJson(env),
          canonicalJson(receipt),
        );
      this.validate(this.db);
      hooks.beforeCommit?.();
      this.db.exec("COMMIT");
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
    try {
      hooks.afterCommit?.();
    } catch (cause) {
      throw new Error("UNKNOWN", { cause });
    }
    return clone(receipt);
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
