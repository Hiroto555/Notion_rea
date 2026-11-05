import { DatabaseSync } from "node:sqlite";
import { SyncSqliteGuard } from "./sqlite-guard";
import {
  canonicalJson,
  fingerprintCommit,
  identifier,
  parseChangePage,
  parseCommit,
  parseResult,
  requireCondition,
  type Change,
  type ChangePage,
  type Commit,
  type CommitResult,
} from "./protocol";

export type JournalOptions = {
  path: string;
  workspaceId: string;
  clientId: string;
  /** Instance configuration outside backups; a copied DB must not silently reuse identity. */
  bindingId: string;
};
export type TransportStatus = {
  workspaceId: string;
  clientId: string;
  serverEpoch: string | null;
  receivedCursor: number;
  pending: number;
  conflicts: number;
  staged: number;
  application: "not-connected";
};

/** A separate transport database. It does NOT atomically capture Folio Store writes. */
export class SyncTransportJournal {
  private readonly storage: SyncSqliteGuard;
  private get db(): DatabaseSync {
    return this.storage.db;
  }
  readonly workspaceId: string;
  readonly clientId: string;

  constructor(options: JournalOptions) {
    this.workspaceId = identifier(options.workspaceId);
    this.clientId = identifier(options.clientId);
    identifier(options.bindingId);
    this.storage = new SyncSqliteGuard(new DatabaseSync(options.path));
    try {
      const tables = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all();
      requireCondition(
        tables.length === 0 ||
          tables.some((row) => row.name === "transport_identity"),
        "not-a-transport-journal",
      );
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
      );
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS transport_identity (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL,
            workspace_id TEXT NOT NULL, client_id TEXT NOT NULL, binding_id TEXT NOT NULL,
            server_epoch TEXT, received_cursor INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS transport_outbox (
            operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
            commit_json TEXT NOT NULL, result_json TEXT
          );
          CREATE TABLE IF NOT EXISTS transport_inbox (
            revision INTEGER PRIMARY KEY, change_json TEXT NOT NULL
          );
        `);
        const identity = this.db
          .prepare("SELECT * FROM transport_identity WHERE singleton=1")
          .get();
        if (!identity) {
          requireCondition(tables.length === 0, "missing-journal-identity");
          this.db
            .prepare(
              "INSERT INTO transport_identity(singleton,version,workspace_id,client_id,binding_id) VALUES(1,1,?,?,?)",
            )
            .run(this.workspaceId, this.clientId, options.bindingId);
        } else {
          requireCondition(
            identity.version === 1,
            "unsupported-journal-version",
          );
          requireCondition(
            identity.workspace_id === this.workspaceId &&
              identity.client_id === this.clientId &&
              identity.binding_id === options.bindingId,
            "journal-binding-mismatch",
          );
        }
      });
    } catch (error) {
      try {
        this.storage.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "Journal initialization and close failed",
        );
      }
      throw error;
    }
  }

  private transaction<T>(work: () => T): T {
    return this.storage.transaction(work);
  }

  bindServer(epoch: string): void {
    this.storage.assertUsable();
    identifier(epoch);
    this.transaction(() => {
      const current = this.status().serverEpoch;
      requireCondition(
        current === null || current === epoch,
        "server-epoch-mismatch",
      );
      if (current === null)
        this.db
          .prepare(
            "UPDATE transport_identity SET server_epoch=? WHERE singleton=1",
          )
          .run(epoch);
    });
  }

  enqueue(input: Commit): void {
    this.storage.assertUsable();
    const commit = parseCommit(input);
    const fingerprint = fingerprintCommit(commit);
    this.transaction(() => {
      const status = this.status();
      requireCondition(
        commit.workspaceId === this.workspaceId &&
          commit.clientId === this.clientId,
        "journal-identity-mismatch",
      );
      requireCondition(
        commit.serverEpoch === status.serverEpoch,
        "server-epoch-mismatch",
      );
      const previous = this.db
        .prepare(
          "SELECT fingerprint FROM transport_outbox WHERE operation_id=?",
        )
        .get(commit.operationId);
      if (previous) {
        requireCondition(
          previous.fingerprint === fingerprint,
          "operation-id-reused",
          409,
        );
        return;
      }
      requireCondition(
        status.pending === 0 && status.conflicts === 0,
        "outbox-blocked",
        409,
      );
      this.db
        .prepare(
          "INSERT INTO transport_outbox(operation_id,fingerprint,commit_json) VALUES(?,?,?)",
        )
        .run(commit.operationId, fingerprint, canonicalJson(commit));
    });
  }

  pending(): Commit[] {
    return this.db
      .prepare(
        "SELECT commit_json FROM transport_outbox WHERE result_json IS NULL ORDER BY rowid",
      )
      .all()
      .map((row) => parseCommit(JSON.parse(String(row.commit_json))));
  }

  recordResult(input: CommitResult): void {
    this.storage.assertUsable();
    const result = parseResult(input);
    this.transaction(() => {
      requireCondition(
        result.workspaceId === this.workspaceId &&
          result.clientId === this.clientId,
        "journal-identity-mismatch",
      );
      requireCondition(
        result.serverEpoch === this.status().serverEpoch,
        "server-epoch-mismatch",
      );
      const row = this.db
        .prepare("SELECT * FROM transport_outbox WHERE operation_id=?")
        .get(result.operationId);
      requireCondition(
        row && row.fingerprint === result.fingerprint,
        "receipt-mismatch",
      );
      const commit = parseCommit(JSON.parse(String(row.commit_json)));
      if (result.status === "applied") {
        requireCondition(
          result.revision === commit.baseRevision + 1 &&
            result.checkpointHash === commit.checkpointHash,
          "receipt-mismatch",
        );
      } else {
        requireCondition(
          result.head.revision !== commit.baseRevision,
          "invalid-conflict-receipt",
        );
      }
      const encoded = canonicalJson(result);
      requireCondition(
        row.result_json === null || row.result_json === encoded,
        "receipt-changed",
      );
      this.db
        .prepare(
          "UPDATE transport_outbox SET result_json=? WHERE operation_id=?",
        )
        .run(encoded, result.operationId);
    });
  }

  stageChanges(input: ChangePage): void {
    this.storage.assertUsable();
    const page = parseChangePage(input);
    this.transaction(() => {
      const status = this.status();
      requireCondition(
        page.workspaceId === this.workspaceId,
        "journal-identity-mismatch",
      );
      requireCondition(
        page.serverEpoch === status.serverEpoch,
        "server-epoch-mismatch",
      );
      requireCondition(
        page.after <= status.receivedCursor &&
          page.headRevision >= status.receivedCursor,
        "cursor-gap",
      );
      let cursor = status.receivedCursor;
      for (const change of page.changes) {
        const encoded = canonicalJson(change);
        const existing = this.db
          .prepare("SELECT change_json FROM transport_inbox WHERE revision=?")
          .get(change.revision);
        if (existing) {
          requireCondition(
            existing.change_json === encoded,
            "change-rewritten",
          );
          continue;
        }
        requireCondition(change.revision === cursor + 1, "cursor-gap");
        this.db
          .prepare(
            "INSERT INTO transport_inbox(revision,change_json) VALUES(?,?)",
          )
          .run(change.revision, encoded);
        cursor = change.revision;
      }
      this.db
        .prepare(
          "UPDATE transport_identity SET received_cursor=? WHERE singleton=1",
        )
        .run(cursor);
    });
  }

  /** Deliberately no apply/ackApplied API: no host/session barrier exists yet. */
  pendingInbox(): Change[] {
    return this.db
      .prepare("SELECT change_json FROM transport_inbox ORDER BY revision")
      .all()
      .map((row) => JSON.parse(String(row.change_json)) as Change);
  }

  conflicts(): Array<{
    local: Commit;
    remote: Extract<CommitResult, { status: "conflict" }>;
  }> {
    return this.db
      .prepare(
        "SELECT commit_json,result_json FROM transport_outbox WHERE result_json IS NOT NULL",
      )
      .all()
      .flatMap((row) => {
        const result = parseResult(JSON.parse(String(row.result_json)));
        return result.status === "conflict"
          ? [
              {
                local: parseCommit(JSON.parse(String(row.commit_json))),
                remote: result,
              },
            ]
          : [];
      });
  }

  status(): TransportStatus {
    const row = this.db
      .prepare("SELECT * FROM transport_identity WHERE singleton=1")
      .get()!;
    const results = this.db
      .prepare("SELECT result_json FROM transport_outbox")
      .all();
    return {
      workspaceId: this.workspaceId,
      clientId: this.clientId,
      serverEpoch: row.server_epoch === null ? null : String(row.server_epoch),
      receivedCursor: Number(row.received_cursor),
      pending: results.filter((result) => result.result_json === null).length,
      conflicts: results.filter(
        (result) =>
          result.result_json !== null &&
          parseResult(JSON.parse(String(result.result_json))).status ===
            "conflict",
      ).length,
      staged: Number(
        this.db.prepare("SELECT count(*) AS count FROM transport_inbox").get()!
          .count,
      ),
      application: "not-connected",
    };
  }

  close(): void {
    this.storage.close();
  }
}
