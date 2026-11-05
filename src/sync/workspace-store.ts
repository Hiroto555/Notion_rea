import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Store } from "../persistence/store";
import type { Page } from "../shared/types";
import { RecordRepository } from "../persistence/record-repository";
import {
  markRecordStoreVersion,
  validateRecordStoreVersion,
} from "../persistence/record-version";
import { createLegacyRecordMap } from "../persistence/legacy-record-map";
import {
  canonicalJson,
  fingerprintCommit,
  hashCheckpoint,
  identifier,
  requireCondition,
  type Change,
  type ChangePage,
  type Checkpoint,
  type Commit,
  type CommitResult,
} from "./protocol";
import {
  buildWorkspaceCheckpoint,
  installWorkspaceSyncTriggers,
  pageSearchBody,
  validateWorkspaceCheckpoint,
  validateWorkspaceSyncSchema,
  WORKSPACE_CONTENT_TABLES,
  WORKSPACE_SYNC_SCHEMA_VERSION,
  type WorkspaceContentTable,
} from "./workspace-checkpoint";

export { validateWorkspaceCheckpoint, validateWorkspaceSyncSchema };

export type WorkspaceSyncIdentity = {
  workspaceId: string;
  clientId: string;
  bindingId: string;
  serverEpoch: string;
};

export type WorkspaceSyncStatus = {
  receivedCursor: number;
  appliedRevision: number;
  generation: number;
  cleanGeneration: number;
  pending: boolean;
  conflict: boolean;
};

type StateRow = {
  singleton: number;
  schema_version: number;
  workspace_id: string;
  client_id: string;
  binding_id: string;
  server_epoch: string;
  generation: number;
  clean_generation: number;
  applied_revision: number;
  received_cursor: number;
  suppress_triggers: number;
};

type OutboxRow = {
  operation_id: string;
  fingerprint: string;
  generation: number;
  commit_json: string;
  result_json: string | null;
};

type InboxRow = {
  revision: number;
  change_json: string;
  skip_apply: number;
};

type ConflictRow = {
  id: number;
  operation_id: string;
  local_commit_json: string;
  remote_result_json: string;
  local_generation: number;
  local_checkpoint_json: string;
  chosen: string | null;
  chosen_at: number | null;
};

type CheckpointRow = (string | number | null)[];

type CheckpointTables = Record<WorkspaceContentTable, CheckpointRow[]>;

const LIFECYCLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS record_database_trash_batches (
    database_page_id TEXT PRIMARY KEY REFERENCES record_databases(database_page_id),
    deleted_revision INTEGER NOT NULL,
    deleted_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS record_database_trash_members (
    database_page_id TEXT NOT NULL REFERENCES record_database_trash_batches(database_page_id) ON DELETE CASCADE,
    page_id TEXT NOT NULL REFERENCES pages(id),
    deleted_revision INTEGER NOT NULL,
    PRIMARY KEY(database_page_id,page_id)
  );
  CREATE TABLE IF NOT EXISTS legacy_database_archive(database_page_id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS legacy_database_versions(version_id INTEGER PRIMARY KEY REFERENCES versions(id) ON DELETE CASCADE, database_page_id TEXT NOT NULL);
`;

const SYNC_SCHEMA = `
  CREATE TABLE IF NOT EXISTS workspace_sync_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    schema_version INTEGER NOT NULL,
    workspace_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    server_epoch TEXT NOT NULL,
    generation INTEGER NOT NULL,
    clean_generation INTEGER NOT NULL,
    applied_revision INTEGER NOT NULL,
    received_cursor INTEGER NOT NULL,
    suppress_triggers INTEGER NOT NULL CHECK(suppress_triggers IN (0,1))
  );
  CREATE TABLE IF NOT EXISTS workspace_sync_outbox (
    operation_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    generation INTEGER NOT NULL,
    commit_json TEXT NOT NULL,
    result_json TEXT
  );
  CREATE TABLE IF NOT EXISTS workspace_sync_inbox (
    revision INTEGER PRIMARY KEY,
    change_json TEXT NOT NULL,
    skip_apply INTEGER NOT NULL CHECK(skip_apply IN (0,1))
  );
  CREATE TABLE IF NOT EXISTS workspace_sync_conflicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE,
    local_commit_json TEXT NOT NULL,
    remote_result_json TEXT NOT NULL,
    local_generation INTEGER NOT NULL,
    local_checkpoint_json TEXT NOT NULL,
    chosen TEXT CHECK(chosen IS NULL OR chosen IN ('local','remote')),
    chosen_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS workspace_sync_archives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    checkpoint_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspace_sync_applied (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    revision INTEGER NOT NULL,
    checkpoint_json TEXT NOT NULL
  );
`;

const CONTENT_DELETE_ORDER = [
  "legacy_record_map",
  "record_database_trash_members",
  "record_database_trash_batches",
  "record_value_versions",
  "record_memberships",
  "record_databases",
  "legacy_database_versions",
  "legacy_database_archive",
  "assets",
  "versions",
  "pages",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort(),
    expected = [...keys].sort();
  requireCondition(
    actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]),
    `unexpected-${label}-fields`,
  );
}

function hash(value: unknown): string {
  requireCondition(
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    "invalid-hash",
  );
  return value;
}

function counter(value: unknown, minimum = 0): number {
  requireCondition(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= minimum,
    "invalid-revision",
  );
  return value;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function userVersion(db: DatabaseSync): number {
  const value = (
    db.prepare("PRAGMA user_version").get() as
      | {
          user_version?: unknown;
        }
      | undefined
  )?.user_version;
  requireCondition(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    "invalid-user-version",
  );
  return value;
}

/**
 * A version-5 workspace is opt-in. The host must hold exclusive ownership of
 * the workspace (no second app process and no inherited Store writer) from the
 * verified backup through enable(). SQLite serialises statements, but it cannot
 * revoke a write handle another process opened before promotion; the user
 * version bump to 5 makes an old Store binary refuse to reopen it.
 */
export class WorkspaceSyncStore {
  readonly identity: Readonly<WorkspaceSyncIdentity>;

  constructor(
    private readonly store: Store,
    identity: WorkspaceSyncIdentity,
  ) {
    this.identity = Object.freeze({
      workspaceId: identifier(identity.workspaceId),
      clientId: identifier(identity.clientId),
      bindingId: identifier(identity.bindingId),
      serverEpoch: identifier(identity.serverEpoch),
    });
  }

  enable(mode: "publish" | "join", beforeEnable: () => void): void {
    requireCondition(
      mode === "publish" || mode === "join",
      "invalid-sync-mode",
    );
    const existing = this.readStateOrNull();
    if (existing) {
      this.assertIdentity(existing);
      requireCondition(userVersion(this.store.db) === 5, "not-a-v5-workspace");
      validateRecordStoreVersion(this.store.db);
      validateWorkspaceSyncSchema(this.store.db);
      return;
    }
    if (mode === "join") this.assertEmptyContent();
    // The host's verified backup happens before the write transaction. A
    // callback failure therefore leaves user_version and every table untouched.
    beforeEnable();
    this.store.transaction(() => {
      const raced = this.readStateOrNull();
      if (raced) {
        this.assertIdentity(raced);
        validateWorkspaceSyncSchema(this.store.db);
        return;
      }
      if (mode === "join") this.assertEmptyContent();
      const checkpoint = buildWorkspaceCheckpoint(this.store.db);
      hashCheckpoint(checkpoint);
      requireCondition(
        validateWorkspaceCheckpoint(checkpoint),
        "invalid-local-workspace-checkpoint",
      );
      new RecordRepository(this.store).createSchema();
      markRecordStoreVersion(this.store.db);
      this.store.db.exec(LIFECYCLE_SCHEMA);
      createLegacyRecordMap(this.store.db);
      this.store.db.exec(SYNC_SCHEMA);
      const generation = mode === "publish" ? 1 : 0;
      this.store.db
        .prepare(
          "INSERT INTO workspace_sync_state(singleton,schema_version,workspace_id,client_id,binding_id,server_epoch,generation,clean_generation,applied_revision,received_cursor,suppress_triggers) VALUES(1,?,?,?,?,?,?,?,0,0,0)",
        )
        .run(
          WORKSPACE_SYNC_SCHEMA_VERSION,
          this.identity.workspaceId,
          this.identity.clientId,
          this.identity.bindingId,
          this.identity.serverEpoch,
          generation,
          0,
        );
      installWorkspaceSyncTriggers(this.store.db);
      // This is the durable old-writer barrier. It must be the final schema
      // write so a partially promoted workspace can never be mistaken for v5.
      this.store.db.exec("PRAGMA user_version=5");
      validateWorkspaceSyncSchema(this.store.db);
    });
  }

  /** The host verifies a backup of the previous queue and binds a fresh
   * device before resetting anything. The restored content becomes a new
   * candidate at revision zero, so it cannot overwrite a remote head. */
  rebindRestored(beforeRebind: () => void): void {
    const prior = this.readStateOrNull();
    requireCondition(
      prior && userVersion(this.store.db) === 5,
      "rebind-requires-v5-workspace",
    );
    const { workspaceId, clientId, bindingId, serverEpoch } = this.identity;
    requireCondition(
      prior.workspace_id === workspaceId,
      "workspace-sync-identity-mismatch",
    );
    if (
      prior.client_id === clientId &&
      prior.binding_id === bindingId &&
      prior.server_epoch === serverEpoch
    )
      return;
    requireCondition(
      prior.client_id !== clientId && prior.binding_id !== bindingId,
      "new-sync-device-required",
      409,
    );
    beforeRebind();
    this.store.transaction(() => {
      requireCondition(
        canonicalJson(this.readStateOrNull()) === canonicalJson(prior),
        "workspace-changed-during-rebind",
        409,
      );
      const db = this.store.db;
      db.exec(`
        DELETE FROM workspace_sync_conflicts;
        DELETE FROM workspace_sync_archives;
        DELETE FROM workspace_sync_outbox;
        DELETE FROM workspace_sync_inbox;
        DELETE FROM workspace_sync_applied;
      `);
      db.prepare(
        `UPDATE workspace_sync_state SET
        client_id=?, binding_id=?, server_epoch=?, generation=1, clean_generation=0,
        applied_revision=0, received_cursor=0 WHERE singleton=1`,
      ).run(clientId, bindingId, serverEpoch);
    });
  }

  status(): WorkspaceSyncStatus {
    const state = this.readState(),
      conflict = this.hasUnresolvedConflict(),
      pending =
        conflict ||
        state.generation !== state.clean_generation ||
        !!this.store.db
          .prepare(
            "SELECT 1 FROM workspace_sync_outbox WHERE result_json IS NULL",
          )
          .get();
    return {
      receivedCursor: state.received_cursor,
      appliedRevision: state.applied_revision,
      generation: state.generation,
      cleanGeneration: state.clean_generation,
      pending,
      conflict,
    };
  }

  prepare(): Commit | null {
    return this.store.transaction(() => {
      const state = this.readState();
      if (this.hasUnresolvedConflict()) return null;
      const pending = this.pendingOutbox();
      if (pending) return this.parseStoredCommit(pending.commit_json);
      if (state.generation === state.clean_generation) return null;
      const checkpoint = buildWorkspaceCheckpoint(this.store.db);
      const previous = this.appliedCheckpoint();
      requireCondition(
        validateWorkspaceCheckpoint(checkpoint, previous),
        "invalid-local-workspace-checkpoint",
      );
      const commit: Commit = {
        protocol: 1,
        workspaceId: this.identity.workspaceId,
        clientId: this.identity.clientId,
        operationId: randomUUID(),
        serverEpoch: this.identity.serverEpoch,
        baseRevision: state.applied_revision,
        checkpointHash: hashCheckpoint(checkpoint),
        checkpoint,
      };
      const fingerprint = fingerprintCommit(commit);
      this.store.db
        .prepare(
          "INSERT INTO workspace_sync_outbox(operation_id,fingerprint,generation,commit_json,result_json) VALUES(?,?,?,?,NULL)",
        )
        .run(
          commit.operationId,
          fingerprint,
          state.generation,
          canonicalJson(commit),
        );
      return commit;
    });
  }

  recordResult(operation: Commit, result: CommitResult): void {
    this.store.transaction(() => {
      const state = this.readState();
      this.assertCommitIdentity(operation);
      const row = this.store.db
        .prepare("SELECT * FROM workspace_sync_outbox WHERE operation_id=?")
        .get(operation.operationId) as OutboxRow | undefined;
      requireCondition(!!row, "unknown-sync-operation");
      const fingerprint = fingerprintCommit(operation);
      requireCondition(
        row!.fingerprint === fingerprint &&
          row!.commit_json === canonicalJson(operation) &&
          row!.generation <= state.generation,
        "sync-operation-changed",
      );
      this.assertResultIdentity(result);
      requireCondition(
        result.operationId === operation.operationId &&
          result.fingerprint === fingerprint,
        "sync-result-mismatch",
      );
      const encoded = canonicalJson(result);
      if (row!.result_json !== null) {
        requireCondition(row!.result_json === encoded, "sync-result-changed");
        return;
      }
      if (result.status === "applied") {
        requireCondition(
          result.revision === operation.baseRevision + 1 &&
            operation.baseRevision >= state.applied_revision &&
            result.checkpointHash === operation.checkpointHash,
          "invalid-applied-result",
        );
        requireCondition(
          validateWorkspaceCheckpoint(
            operation.checkpoint,
            this.checkpointAtRevision(state.applied_revision),
          ),
          "invalid-applied-checkpoint",
        );
        this.store.db
          .prepare(
            "UPDATE workspace_sync_outbox SET result_json=? WHERE operation_id=?",
          )
          .run(encoded, operation.operationId);
        this.store.db
          .prepare(
            "UPDATE workspace_sync_state SET applied_revision=?,clean_generation=? WHERE singleton=1",
          )
          .run(result.revision, row!.generation);
        this.writeApplied(result.revision, operation.checkpoint);
        return;
      }
      requireCondition(
        result.head.revision !== operation.baseRevision &&
          result.head.revision >= state.applied_revision,
        "invalid-conflict-result",
      );
      requireCondition(
        !this.hasUnresolvedConflict(),
        "sync-conflict-already-open",
      );
      this.store.db
        .prepare(
          "UPDATE workspace_sync_outbox SET result_json=? WHERE operation_id=?",
        )
        .run(encoded, operation.operationId);
      this.store.db
        .prepare(
          "INSERT INTO workspace_sync_conflicts(operation_id,local_commit_json,remote_result_json,local_generation,local_checkpoint_json,chosen,chosen_at) VALUES(?,?,?,?,?,NULL,NULL) ON CONFLICT(operation_id) DO NOTHING",
        )
        .run(
          operation.operationId,
          canonicalJson(operation),
          encoded,
          row!.generation,
          canonicalJson(operation.checkpoint),
        );
    });
  }

  stageChanges(page: ChangePage): void {
    this.store.transaction(() => {
      const state = this.readState();
      this.assertChangePage(page, state);
      const changes = page.changes as Change[];
      requireCondition(
        page.after <= state.received_cursor &&
          page.headRevision >= state.received_cursor,
        "cursor-gap",
      );
      const pageChanges = new Map(
        changes.map((change) => [change.revision, change]),
      );
      for (const change of changes)
        this.validateStagedCheckpoint(change, state, pageChanges);
      let cursor = state.received_cursor;
      for (const change of changes) {
        const encoded = canonicalJson(change),
          existing = this.store.db
            .prepare(
              "SELECT change_json FROM workspace_sync_inbox WHERE revision=?",
            )
            .get(change.revision) as { change_json: string } | undefined;
        if (existing) {
          requireCondition(
            existing.change_json === encoded,
            "mismatched-change-replay",
          );
          continue;
        }
        requireCondition(change.revision === cursor + 1, "cursor-gap");
        let skipApply = false;
        if (change.clientId === this.identity.clientId) {
          const outbox = this.store.db
            .prepare("SELECT * FROM workspace_sync_outbox WHERE operation_id=?")
            .get(change.operationId) as OutboxRow | undefined;
          requireCondition(
            outbox && outbox.fingerprint === change.fingerprint,
            "unknown-own-sync-change",
          );
          const operation = this.parseStoredCommit(outbox.commit_json);
          requireCondition(
            operation.baseRevision + 1 === change.revision &&
              operation.checkpointHash === change.checkpointHash,
            "sync-result-mismatch",
          );
          skipApply = true;
        }
        this.store.db
          .prepare(
            "INSERT INTO workspace_sync_inbox(revision,change_json,skip_apply) VALUES(?,?,?)",
          )
          .run(change.revision, encoded, skipApply ? 1 : 0);
        cursor = change.revision;
      }
      if (changes.length === 0)
        requireCondition(
          page.after === state.received_cursor &&
            page.headRevision === state.received_cursor,
          "cursor-gap",
        );
      this.store.db
        .prepare(
          "UPDATE workspace_sync_state SET received_cursor=? WHERE singleton=1",
        )
        .run(cursor);
    });
  }

  nextIncoming(): Change | null {
    return this.store.transaction(() => {
      let state = this.readState();
      for (;;) {
        const revision = state.applied_revision + 1,
          row = this.store.db
            .prepare("SELECT * FROM workspace_sync_inbox WHERE revision=?")
            .get(revision) as InboxRow | undefined;
        if (!row) return null;
        const change = JSON.parse(row.change_json) as Change;
        if (row.skip_apply === 0) return change;
        // An exact echo can reconcile a missing ACK without replacing newer local edits.
        const outbox = this.pendingOutbox();
        requireCondition(
          outbox &&
            outbox.operation_id === change.operationId &&
            outbox.fingerprint === change.fingerprint,
          "unknown-own-sync-change",
        );
        const operation = this.parseStoredCommit(outbox.commit_json);
        requireCondition(
          operation.baseRevision + 1 === revision &&
            operation.checkpointHash === change.checkpointHash,
          "sync-result-mismatch",
        );
        const result: CommitResult = {
          protocol: 1,
          workspaceId: this.identity.workspaceId,
          clientId: this.identity.clientId,
          operationId: change.operationId,
          serverEpoch: this.identity.serverEpoch,
          fingerprint: change.fingerprint,
          status: "applied",
          revision,
          checkpointHash: change.checkpointHash,
        };
        this.store.db
          .prepare(
            "UPDATE workspace_sync_outbox SET result_json=? WHERE operation_id=?",
          )
          .run(canonicalJson(result), change.operationId);
        this.store.db
          .prepare(
            "UPDATE workspace_sync_state SET applied_revision=?,clean_generation=? WHERE singleton=1",
          )
          .run(revision, outbox.generation);
        this.writeApplied(revision, change.checkpoint);
        state = this.readState();
      }
    });
  }

  incoming(revision: number): Change | null {
    this.readState();
    requireCondition(
      Number.isSafeInteger(revision) && revision >= 1,
      "invalid-revision",
    );
    const row = this.store.db
      .prepare("SELECT change_json FROM workspace_sync_inbox WHERE revision=?")
      .get(revision) as { change_json: string } | undefined;
    return row ? (JSON.parse(row.change_json) as Change) : null;
  }

  applyNext(
    expected: Change,
    assertAssets: (assets: Checkpoint["assets"]) => void,
  ): void {
    this.store.transaction(() => {
      const state = this.readState();
      requireCondition(!this.hasUnresolvedConflict(), "sync-conflict-open");
      requireCondition(
        state.generation === state.clean_generation,
        "local-changes-pending",
      );
      requireCondition(!this.pendingOutbox(), "sync-outbox-pending");
      const revision = state.applied_revision + 1;
      requireCondition(expected.revision === revision, "cursor-gap");
      const row = this.store.db
        .prepare("SELECT * FROM workspace_sync_inbox WHERE revision=?")
        .get(revision) as InboxRow | undefined;
      requireCondition(!!row, "change-not-staged");
      requireCondition(
        row!.change_json === canonicalJson(expected),
        "staged-change-mismatch",
      );
      requireCondition(row!.skip_apply === 0, "own-change-not-applicable");
      const previous = this.checkpointAtRevision(state.applied_revision);
      requireCondition(
        validateWorkspaceCheckpoint(expected.checkpoint, previous),
        "invalid-remote-workspace-checkpoint",
      );
      assertAssets(expected.checkpoint.assets);
      this.replaceContent(expected.checkpoint);
      this.store.db
        .prepare(
          "UPDATE workspace_sync_state SET applied_revision=?,clean_generation=? WHERE singleton=1",
        )
        .run(revision, state.generation);
      this.writeApplied(revision, expected.checkpoint);
    });
  }

  conflict(): {
    operation: Commit;
    result: Extract<CommitResult, { status: "conflict" }>;
  } | null {
    this.readState();
    const row = this.unresolvedConflict();
    if (!row) return null;
    return {
      operation: JSON.parse(row.local_commit_json) as Commit,
      result: JSON.parse(row.remote_result_json) as Extract<
        CommitResult,
        { status: "conflict" }
      >,
    };
  }

  chooseLocal(expectedRevision: number): Commit {
    return this.store.transaction(() => {
      const state = this.readState(),
        row = this.unresolvedConflict();
      requireCondition(!!row, "sync-conflict-not-found");
      const result = JSON.parse(row!.remote_result_json) as Extract<
        CommitResult,
        { status: "conflict" }
      >;
      requireCondition(
        expectedRevision === result.head.revision &&
          expectedRevision >= state.applied_revision,
        "sync-head-changed",
      );
      requireCondition(!this.pendingOutbox(), "sync-outbox-pending");
      const checkpoint = buildWorkspaceCheckpoint(this.store.db);
      // A local choice must preserve every Page/asset present in the observed
      // remote head. Dropping remote additions is never implicit.
      requireCondition(
        validateWorkspaceCheckpoint(checkpoint, result.head.checkpoint),
        "local-checkpoint-drops-remote-data",
      );
      const commit: Commit = {
        protocol: 1,
        workspaceId: this.identity.workspaceId,
        clientId: this.identity.clientId,
        operationId: randomUUID(),
        serverEpoch: this.identity.serverEpoch,
        baseRevision: expectedRevision,
        checkpointHash: hashCheckpoint(checkpoint),
        checkpoint,
      };
      const fingerprint = fingerprintCommit(commit),
        now = Date.now();
      this.store.db
        .prepare(
          "INSERT INTO workspace_sync_outbox(operation_id,fingerprint,generation,commit_json,result_json) VALUES(?,?,?,?,NULL)",
        )
        .run(
          commit.operationId,
          fingerprint,
          state.generation,
          canonicalJson(commit),
        );
      this.store.db
        .prepare(
          "INSERT INTO workspace_sync_archives(operation_id,kind,checkpoint_json,created_at) VALUES(?,?,?,?)",
        )
        .run(
          commit.operationId,
          "choose-local-latest",
          canonicalJson(checkpoint),
          now,
        );
      this.store.db
        .prepare(
          "UPDATE workspace_sync_conflicts SET chosen='local',chosen_at=? WHERE id=?",
        )
        .run(now, row!.id);
      return commit;
    });
  }

  chooseRemote(
    expected: Change,
    assertAssets: (assets: Checkpoint["assets"]) => void,
  ): void {
    this.store.transaction(() => {
      const state = this.readState(),
        row = this.unresolvedConflict();
      requireCondition(!!row, "sync-conflict-not-found");
      const result = JSON.parse(row!.remote_result_json) as Extract<
        CommitResult,
        { status: "conflict" }
      >;
      requireCondition(
        expected.revision === result.head.revision &&
          expected.revision >= state.applied_revision &&
          expected.checkpointHash === result.head.checkpointHash,
        "sync-head-changed",
      );
      const staged = this.store.db
        .prepare("SELECT * FROM workspace_sync_inbox WHERE revision=?")
        .get(expected.revision) as InboxRow | undefined;
      requireCondition(
        !!staged && staged.change_json === canonicalJson(expected),
        "conflict-head-not-staged",
      );
      const previous = this.checkpointAtRevision(expected.revision - 1);
      requireCondition(
        validateWorkspaceCheckpoint(expected.checkpoint, previous),
        "invalid-remote-workspace-checkpoint",
      );
      assertAssets(expected.checkpoint.assets);
      const now = Date.now(),
        localCheckpoint = JSON.parse(row!.local_checkpoint_json) as Checkpoint;
      this.store.db
        .prepare(
          "INSERT INTO workspace_sync_archives(operation_id,kind,checkpoint_json,created_at) VALUES(?,?,?,?)",
        )
        .run(
          expected.operationId,
          "conflict-local",
          canonicalJson(localCheckpoint),
          now,
        );
      this.store.db
        .prepare(
          "INSERT INTO workspace_sync_archives(operation_id,kind,checkpoint_json,created_at) VALUES(?,?,?,?)",
        )
        .run(
          expected.operationId,
          "conflict-remote",
          canonicalJson(expected.checkpoint),
          now,
        );
      if (state.generation !== row!.local_generation) {
        const latest = buildWorkspaceCheckpoint(this.store.db);
        requireCondition(
          validateWorkspaceCheckpoint(
            latest,
            this.checkpointAtRevision(state.applied_revision),
          ),
          "invalid-local-workspace-checkpoint",
        );
        this.store.db
          .prepare(
            "INSERT INTO workspace_sync_archives(operation_id,kind,checkpoint_json,created_at) VALUES(?,?,?,?)",
          )
          .run(
            expected.operationId,
            "choose-remote-latest",
            canonicalJson(latest),
            now,
          );
      }
      this.replaceContent(expected.checkpoint);
      this.store.db
        .prepare(
          "UPDATE workspace_sync_state SET applied_revision=?,clean_generation=? WHERE singleton=1",
        )
        .run(expected.revision, state.generation);
      this.writeApplied(expected.revision, expected.checkpoint);
      this.store.db
        .prepare(
          "UPDATE workspace_sync_conflicts SET chosen='remote',chosen_at=? WHERE id=?",
        )
        .run(now, row!.id);
    });
  }

  /* ------------------------------ internals ------------------------------ */

  private assertEmptyContent(): void {
    for (const table of WORKSPACE_CONTENT_TABLES) {
      if (!hasTable(this.store.db, table)) continue;
      const row = this.store.db
        .prepare(`SELECT count(*) AS count FROM "${table}"`)
        .get() as { count: number };
      requireCondition(row.count === 0, "join-requires-an-empty-workspace");
    }
  }

  private readStateOrNull(): StateRow | null {
    if (!hasTable(this.store.db, "workspace_sync_state")) return null;
    const row = this.store.db
      .prepare("SELECT * FROM workspace_sync_state WHERE singleton=1")
      .get() as StateRow | undefined;
    return row ?? null;
  }

  private readState(): StateRow {
    const row = this.readStateOrNull();
    requireCondition(!!row, "workspace-sync-not-enabled");
    this.assertIdentity(row!);
    requireCondition(
      row!.schema_version === WORKSPACE_SYNC_SCHEMA_VERSION,
      "unsupported-sync-schema",
    );
    return row!;
  }

  private assertIdentity(row: StateRow): void {
    requireCondition(
      row.workspace_id === this.identity.workspaceId &&
        row.client_id === this.identity.clientId &&
        row.binding_id === this.identity.bindingId &&
        row.server_epoch === this.identity.serverEpoch,
      "workspace-sync-identity-mismatch",
    );
  }

  private assertCommitIdentity(commit: Commit): void {
    requireCondition(
      commit.protocol === 1 &&
        commit.workspaceId === this.identity.workspaceId &&
        commit.clientId === this.identity.clientId &&
        commit.serverEpoch === this.identity.serverEpoch,
      "workspace-sync-identity-mismatch",
    );
    identifier(commit.operationId);
    counter(commit.baseRevision);
    hash(commit.checkpointHash);
    requireCondition(
      commit.checkpointHash === hashCheckpoint(commit.checkpoint),
      "checkpoint-hash-mismatch",
    );
  }

  private assertResultIdentity(result: CommitResult): void {
    requireCondition(isPlainObject(result), "invalid-sync-result");
    const value = result as unknown as Record<string, unknown>;
    requireCondition(
      value.protocol === 1 &&
        value.workspaceId === this.identity.workspaceId &&
        value.clientId === this.identity.clientId &&
        value.serverEpoch === this.identity.serverEpoch,
      "workspace-sync-identity-mismatch",
    );
    identifier(value.operationId);
    hash(value.fingerprint);
    requireCondition(
      value.status === "applied" || value.status === "conflict",
      "invalid-sync-result",
    );
    if (value.status === "applied") {
      exactKeys(
        value,
        [
          "protocol",
          "workspaceId",
          "clientId",
          "operationId",
          "serverEpoch",
          "fingerprint",
          "status",
          "revision",
          "checkpointHash",
        ],
        "result",
      );
      counter(value.revision, 1);
      hash(value.checkpointHash);
      return;
    }
    exactKeys(
      value,
      [
        "protocol",
        "workspaceId",
        "clientId",
        "operationId",
        "serverEpoch",
        "fingerprint",
        "status",
        "head",
      ],
      "result",
    );
    requireCondition(isPlainObject(value.head), "invalid-conflict-head");
    const head = value.head;
    exactKeys(
      head,
      ["revision", "checkpointHash", "checkpoint"],
      "conflict-head",
    );
    const revision = counter(head.revision);
    if (revision === 0)
      requireCondition(
        head.checkpointHash === null && head.checkpoint === null,
        "invalid-empty-head",
      );
    else {
      hash(head.checkpointHash);
      requireCondition(
        validateWorkspaceCheckpoint(head.checkpoint as Checkpoint) &&
          head.checkpointHash === hashCheckpoint(head.checkpoint as Checkpoint),
        "invalid-conflict-checkpoint",
      );
    }
  }

  private assertChangePage(page: unknown, state: StateRow): void {
    requireCondition(isPlainObject(page), "invalid-change-page");
    exactKeys(
      page,
      [
        "protocol",
        "workspaceId",
        "serverEpoch",
        "after",
        "headRevision",
        "changes",
      ],
      "change-page",
    );
    requireCondition(
      page.protocol === 1 &&
        page.workspaceId === this.identity.workspaceId &&
        page.serverEpoch === this.identity.serverEpoch,
      "workspace-sync-identity-mismatch",
    );
    const after = counter(page.after),
      headRevision = counter(page.headRevision);
    requireCondition(after <= headRevision, "cursor-ahead");
    requireCondition(Array.isArray(page.changes), "invalid-changes");
    const changes = page.changes as unknown[];
    if (changes.length === 0)
      requireCondition(after === headRevision, "cursor-gap");
    changes.forEach((entry, index) => {
      requireCondition(isPlainObject(entry), "invalid-change");
      exactKeys(
        entry,
        [
          "revision",
          "clientId",
          "operationId",
          "fingerprint",
          "checkpointHash",
          "checkpoint",
        ],
        "change",
      );
      requireCondition(
        counter(entry.revision, 1) === after + index + 1 &&
          Number(entry.revision) <= headRevision,
        "cursor-gap",
      );
      identifier(entry.clientId);
      identifier(entry.operationId);
      hash(entry.fingerprint);
      requireCondition(
        entry.checkpointHash === hashCheckpoint(entry.checkpoint as Checkpoint),
        "checkpoint-hash-mismatch",
      );
      requireCondition(
        validateWorkspaceCheckpoint(entry.checkpoint as Checkpoint),
        "invalid-remote-workspace-checkpoint",
      );
    });
    requireCondition(
      headRevision >= Math.max(state.received_cursor, state.applied_revision),
      "cursor-ahead",
    );
  }

  private validateStagedCheckpoint(
    change: Change,
    state: StateRow,
    pageChanges: Map<number, Change>,
  ): void {
    if (change.revision <= 1) return;
    const predecessorRevision = change.revision - 1;
    let predecessor: Checkpoint | null = null;
    const staged = this.store.db
      .prepare("SELECT change_json FROM workspace_sync_inbox WHERE revision=?")
      .get(predecessorRevision) as { change_json: string } | undefined;
    if (staged)
      predecessor = (JSON.parse(staged.change_json) as Change).checkpoint;
    else if (pageChanges.has(predecessorRevision))
      predecessor = pageChanges.get(predecessorRevision)!.checkpoint;
    else if (predecessorRevision === state.applied_revision)
      predecessor = this.appliedCheckpoint();
    requireCondition(!!predecessor, "cursor-gap");
    requireCondition(
      validateWorkspaceCheckpoint(change.checkpoint, predecessor),
      "invalid-remote-workspace-checkpoint",
    );
  }

  private pendingOutbox(): OutboxRow | null {
    return (
      (this.store.db
        .prepare(
          "SELECT * FROM workspace_sync_outbox WHERE result_json IS NULL ORDER BY rowid LIMIT 1",
        )
        .get() as OutboxRow | undefined) ?? null
    );
  }

  private parseStoredCommit(value: string): Commit {
    const commit = JSON.parse(value) as Commit;
    this.assertCommitIdentity(commit);
    return commit;
  }

  private hasUnresolvedConflict(): boolean {
    return !!this.store.db
      .prepare(
        "SELECT 1 FROM workspace_sync_conflicts WHERE chosen IS NULL LIMIT 1",
      )
      .get();
  }

  private unresolvedConflict(): ConflictRow | null {
    return (
      (this.store.db
        .prepare(
          "SELECT * FROM workspace_sync_conflicts WHERE chosen IS NULL ORDER BY id LIMIT 1",
        )
        .get() as ConflictRow | undefined) ?? null
    );
  }

  private appliedCheckpoint(): Checkpoint | null {
    const row = this.store.db
      .prepare(
        "SELECT revision,checkpoint_json FROM workspace_sync_applied WHERE singleton=1",
      )
      .get() as { revision: number; checkpoint_json: string } | undefined;
    if (!row) return null;
    const checkpoint = JSON.parse(row.checkpoint_json) as Checkpoint;
    requireCondition(
      validateWorkspaceCheckpoint(checkpoint),
      "invalid-applied-checkpoint",
    );
    return checkpoint;
  }

  private checkpointAtRevision(revision: number): Checkpoint | null {
    if (revision === 0) return null;
    const applied = this.store.db
      .prepare(
        "SELECT revision,checkpoint_json FROM workspace_sync_applied WHERE singleton=1",
      )
      .get() as { revision: number; checkpoint_json: string } | undefined;
    if (applied && applied.revision === revision)
      return JSON.parse(applied.checkpoint_json) as Checkpoint;
    const staged = this.store.db
      .prepare("SELECT change_json FROM workspace_sync_inbox WHERE revision=?")
      .get(revision) as { change_json: string } | undefined;
    if (staged) return (JSON.parse(staged.change_json) as Change).checkpoint;
    throw new Error("sync-history-unavailable: " + revision);
  }

  private writeApplied(revision: number, checkpoint: Checkpoint | null): void {
    if (revision === 0) {
      requireCondition(checkpoint === null, "invalid-applied-checkpoint");
      this.store.db
        .prepare("DELETE FROM workspace_sync_applied WHERE singleton=1")
        .run();
      return;
    }
    requireCondition(checkpoint !== null, "invalid-applied-checkpoint");
    this.store.db
      .prepare(
        "INSERT INTO workspace_sync_applied(singleton,revision,checkpoint_json) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,checkpoint_json=excluded.checkpoint_json",
      )
      .run(revision, canonicalJson(checkpoint!));
  }

  private replaceContent(checkpoint: Checkpoint): void {
    const state = this.readState(),
      generation = state.generation,
      tables = (checkpoint.payload as unknown as { tables: CheckpointTables })
        .tables,
      db = this.store.db;
    db.prepare(
      "UPDATE workspace_sync_state SET suppress_triggers=1 WHERE singleton=1",
    ).run();
    for (const table of CONTENT_DELETE_ORDER) db.exec(`DELETE FROM "${table}"`);
    const insert = (sql: string, rows: CheckpointRow[]) => {
      const statement = db.prepare(sql);
      for (const row of rows)
        statement.run(...(row as (string | number | null)[]));
    };
    const pageStatement = db.prepare(
      "INSERT INTO pages(id,data,body) VALUES(?,?,?)",
    );
    for (const row of tables.pages) {
      const id = row[0] as string,
        data = row[1] as string;
      pageStatement.run(id, data, pageSearchBody(JSON.parse(data) as Page));
    }
    insert(
      "INSERT INTO versions(id,pageId,createdAt,title,doc,database) VALUES(?,?,?,?,?,?)",
      tables.versions,
    );
    insert("INSERT INTO assets(id,metadata) VALUES(?,?)", tables.assets);
    insert(
      "INSERT INTO record_databases(database_page_id) VALUES(?)",
      tables.record_databases,
    );
    insert(
      "INSERT INTO record_memberships(page_id,database_page_id,position,values_json) VALUES(?,?,?,?)",
      tables.record_memberships,
    );
    insert(
      "INSERT INTO record_value_versions(version_id,values_json) VALUES(?,?)",
      tables.record_value_versions,
    );
    insert(
      "INSERT INTO record_database_trash_batches(database_page_id,deleted_revision,deleted_at) VALUES(?,?,?)",
      tables.record_database_trash_batches,
    );
    insert(
      "INSERT INTO record_database_trash_members(database_page_id,page_id,deleted_revision) VALUES(?,?,?)",
      tables.record_database_trash_members,
    );
    insert(
      "INSERT INTO legacy_database_archive(database_page_id,data) VALUES(?,?)",
      tables.legacy_database_archive,
    );
    insert(
      "INSERT INTO legacy_database_versions(version_id,database_page_id) VALUES(?,?)",
      tables.legacy_database_versions,
    );
    insert(
      "INSERT INTO legacy_record_map(database_page_id,legacy_row_id,page_id) VALUES(?,?,?)",
      tables.legacy_record_map,
    );
    requireCondition(
      this.readState().generation === generation,
      "sync-generation-changed-during-apply",
    );
    db.prepare(
      "UPDATE workspace_sync_state SET suppress_triggers=0 WHERE singleton=1",
    ).run();
  }
}
