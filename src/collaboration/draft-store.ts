import { sqliteHeader } from "../persistence/sqlite-header";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, openSync, closeSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import {
  sameScope,
  sharedEnvelopeSchema,
  type SharedEnvelope,
  type SharedSession,
} from "./contract";
import { inspectSharedDocument } from "./document-input";

// Staging/quarantine format only. It is not an adopted shared document log.
export const SHARED_DRAFT_APPLICATION_ID = 0x464c4452;
export const SHARED_DRAFT_VERSION = 1001; // existing private Store (max5) refuses before writes
const CREATE = `CREATE TABLE drafts (operation_id TEXT PRIMARY KEY, envelope TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('STAGED','UNKNOWN')), validation_code TEXT NOT NULL)`;
const MAX_ENVELOPE_BYTES = 12_100_000; // raw's 2M code units can expand sixfold when escaped
function safeFiles(path: string) {
  const stat = (file: string) => {
    try {
      return lstatSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  };
  const main = stat(path),
    sides = ["-wal", "-shm", "-journal"].map((s) => stat(path + s));
  for (const entry of [main, ...sides])
    if (
      entry &&
      (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)
    )
      throw new Error("UNSAFE_SHARED_DRAFT_PATH");
  if (!main && sides.some(Boolean))
    throw new Error("ORPHAN_SHARED_DRAFT_SIDECAR");
  return main;
}
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export type SharedDraft = {
  envelope: SharedEnvelope;
  state: "STAGED" | "UNKNOWN";
  validationCode: string;
};

export class SharedDraftStore {
  readonly path: string;
  private db: DatabaseSync;
  constructor(directory: string) {
    this.path = join(directory, "shared-drafts.sqlite");
    const original = safeFiles(this.path);
    const existed = !!original;
    if (existed) {
      const header = sqliteHeader(this.path);
      if (
        !header ||
        header.version !== SHARED_DRAFT_VERSION ||
        header.applicationId !== SHARED_DRAFT_APPLICATION_ID
      )
        throw new Error("NOT_SHARED_DRAFT_FORMAT");
      const probe = new DatabaseSync(this.path, { readOnly: true });
      try {
        this.validate(probe);
      } finally {
        probe.close();
      }
    }
    mkdirSync(directory, { recursive: true });
    if (!existed) {
      const fd = openSync(this.path, "wx", 0o600);
      closeSync(fd);
    }
    const pinned = safeFiles(this.path)!;
    if (
      original &&
      (original.dev !== pinned.dev || original.ino !== pinned.ino)
    )
      throw new Error("SHARED_DRAFT_PATH_CHANGED");
    this.db = new DatabaseSync(this.path);
    try {
      const opened = safeFiles(this.path)!;
      if (opened.dev !== pinned.dev || opened.ino !== pinned.ino)
        throw new Error("SHARED_DRAFT_PATH_CHANGED");
      // Caller owns the directory exclusively; hostile same-UID path swapping is outside this preparation service.
      // Recheck on the writable handle before changing journal mode.
      const tables = this.db.prepare("SELECT name FROM sqlite_master").all();
      if (!existed && !tables.length) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.exec(CREATE);
          this.db.exec(
            `PRAGMA application_id=${SHARED_DRAFT_APPLICATION_ID}; PRAGMA user_version=${SHARED_DRAFT_VERSION}`,
          );
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
      if (!existed) {
        const fd = openSync(directory, "r");
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  private decode(row: Record<string, unknown>): SharedDraft {
    if (
      typeof row.envelope !== "string" ||
      Buffer.byteLength(row.envelope) > MAX_ENVELOPE_BYTES
    )
      throw new Error("CORRUPT_SHARED_DRAFT");
    let envelope: SharedEnvelope;
    try {
      envelope = sharedEnvelopeSchema.parse(JSON.parse(row.envelope));
    } catch {
      throw new Error("CORRUPT_SHARED_DRAFT");
    }
    const canonical = JSON.stringify(envelope);
    const validationCode = row.validation_code;
    if (
      typeof validationCode !== "string" ||
      !/^[A-Z_]{1,64}$/.test(validationCode)
    )
      throw new Error("CORRUPT_SHARED_DRAFT");
    if (
      row.operation_id !== envelope.operationId ||
      row.envelope !== canonical ||
      row.fingerprint !== digest(canonical + "\0" + validationCode) ||
      !["STAGED", "UNKNOWN"].includes(row.state as string)
    )
      throw new Error("CORRUPT_SHARED_DRAFT");
    return {
      envelope,
      state: row.state as SharedDraft["state"],
      validationCode,
    };
  }
  private validate(db: DatabaseSync): void {
    if (
      db.prepare("PRAGMA application_id").get()?.application_id !==
        SHARED_DRAFT_APPLICATION_ID ||
      db.prepare("PRAGMA user_version").get()?.user_version !==
        SHARED_DRAFT_VERSION
    )
      throw new Error("NOT_SHARED_DRAFT_FORMAT");
    const tables = db
      .prepare("SELECT name,sql FROM sqlite_master WHERE type='table'")
      .all();
    if (
      tables.length !== 1 ||
      tables[0].name !== "drafts" ||
      tables[0].sql !== CREATE
    )
      throw new Error("CORRUPT_SHARED_DRAFT_SCHEMA");
    const other = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('view','trigger')",
      )
      .all();
    if (other.length) throw new Error("CORRUPT_SHARED_DRAFT_SCHEMA");
    const total = db
      .prepare(
        "SELECT count(*) AS n, coalesce(sum(length(CAST(envelope AS BLOB))),0) AS bytes FROM drafts",
      )
      .get()!;
    if (Number(total.n) > 1000 || Number(total.bytes) > 20_000_000)
      throw new Error("SHARED_DRAFT_LIMIT");
    const allocation =
      Number(db.prepare("PRAGMA page_count").get()?.page_count) *
      Number(db.prepare("PRAGMA page_size").get()?.page_size);
    if (!Number.isSafeInteger(allocation) || allocation > 32_000_000)
      throw new Error("SHARED_DRAFT_LIMIT");
    if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
      throw new Error("CORRUPT_SHARED_DRAFT_SCHEMA");
    for (const row of db.prepare("SELECT * FROM drafts").all())
      this.decode(row);
  }
  stage(input: SharedEnvelope): SharedDraft {
    const envelope = sharedEnvelopeSchema.parse(input);
    const inspected = inspectSharedDocument(envelope.raw);
    const validationCode = inspected.ok ? "SUPPORTED" : inspected.code;
    const canonical = JSON.stringify(envelope);
    if (Buffer.byteLength(canonical) > MAX_ENVELOPE_BYTES)
      throw new Error("SHARED_DRAFT_LIMIT");
    const fingerprint = digest(canonical + "\0" + validationCode);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db
        .prepare("SELECT * FROM drafts WHERE operation_id=?")
        .get(envelope.operationId);
      if (previous) {
        const draft = this.decode(previous);
        if (previous.envelope !== canonical) throw new Error("DRAFT_ID_REUSE");
        this.db.exec("COMMIT");
        return draft;
      }
      const total = this.db
        .prepare(
          "SELECT count(*) AS n, coalesce(sum(length(CAST(envelope AS BLOB))),0) AS bytes FROM drafts",
        )
        .get()!;
      if (
        Number(total.n) >= 1000 ||
        Number(total.bytes) + Buffer.byteLength(canonical) > 20_000_000
      )
        throw new Error("SHARED_DRAFT_LIMIT");
      this.db
        .prepare("INSERT INTO drafts VALUES (?,?,?,'STAGED',?)")
        .run(envelope.operationId, canonical, fingerprint, validationCode);
      this.db.exec("COMMIT");
      return { envelope, state: "STAGED", validationCode };
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
  }
  get(operationId: string): SharedDraft | undefined {
    const row = this.db
      .prepare("SELECT * FROM drafts WHERE operation_id=?")
      .get(operationId);
    return row ? this.decode(row) : undefined;
  }
  listFor(session: SharedSession): SharedDraft[] {
    return this.db
      .prepare("SELECT * FROM drafts ORDER BY operation_id")
      .all()
      .map((row) => this.decode(row))
      .filter(
        (draft) =>
          sameScope(draft.envelope.session.scope, session.scope) &&
          draft.envelope.session.actorId === session.actorId &&
          draft.envelope.session.deviceId === session.deviceId,
      );
  }
  markUnknown(operationId: string): void {
    // Unknown is terminal here: no retry/receipt claim without an adopted provider.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.get(operationId)) throw new Error("MISSING_SHARED_DRAFT");
      const changed = this.db
        .prepare("UPDATE drafts SET state='UNKNOWN' WHERE operation_id=?")
        .run(operationId);
      if (Number(changed.changes) !== 1)
        throw new Error("MISSING_SHARED_DRAFT");
      this.db.exec("COMMIT");
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close(): void {
    this.db.close();
  }
}
