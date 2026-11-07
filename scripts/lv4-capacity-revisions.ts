/**
 * Lv4 T02 revision-history measurement (lane: lv4-capacity).
 *
 * Complements scripts/lv4-capacity.ts (checkpoint bytes for page/body/version
 * scenarios) with the durable sync queue: per-revision outbox/applied/inbox
 * growth, wire envelope bytes and prepare/ACK/stage/apply timings, all through
 * the real WorkspaceSyncStore on a synthetic Store.
 *
 * No network peer is involved:
 * - The applied ACK is built with the exact CommitResult shape the checkpoint
 *   server returns and passes through WorkspaceSyncStore.recordResult, so the
 *   outbox/applied write path and every validation it runs are the production
 *   code path.
 * - The receive path is driven by WorkspaceSyncStore.stageChanges +
 *   applyNext. A synthetic remote change is built from the real current
 *   checkpoint plus one added page; the own-echo row (skip_apply) is staged
 *   exactly like the production receive() reconcile.
 *
 * Boundedness: every scenario is a fixed small grid; every SQLite file lives
 * in one mkdtemp directory removed in finally; the growing-history scenario
 * stops at the first payload-too-large rejection or a fixed iteration cap.
 * No user data, no GUI, no network.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { Store } from "../src/persistence/store";
import {
  buildWorkspaceCheckpoint,
  validateWorkspaceSyncSchema,
} from "../src/sync/workspace-checkpoint";
import {
  canonicalJson,
  fingerprintCommit,
  hashCheckpoint,
  sha256,
  MAX_CHECKPOINT_BYTES,
  MAX_WIRE_BYTES,
  SyncError,
  type Change,
  type ChangePage,
  type Checkpoint,
  type Commit,
  type CommitResult,
} from "../src/sync/protocol";
import { WorkspaceSyncStore } from "../src/sync/workspace-store";

const IDENTITY = {
  workspaceId: "ws-capacity",
  clientId: "client-capacity-a",
  bindingId: "binding-capacity-a",
  serverEpoch: "epoch-capacity",
} as const;
const REMOTE_CLIENT_ID = "client-capacity-b";

const textDoc = (bytes: number) => ({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "x".repeat(bytes) }] },
  ],
});

const fileBytes = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

/** Logical bytes of one TEXT column, summed across rows. Table and column
 * names are fixed literals in this file. */
const columnBytes = (db: DatabaseSync, table: string, column: string): number =>
  Number(
    (
      db
        .prepare(
          `SELECT coalesce(sum(length(CAST(${column} AS BLOB))),0) AS bytes FROM ${table}`,
        )
        .get() as { bytes: number }
    ).bytes,
  );

const versionsCount = (db: DatabaseSync): number =>
  Number(
    (db.prepare("SELECT count(*) AS count FROM versions").get() as {
      count: number;
    }).count,
  );

const pagesCount = (db: DatabaseSync): number =>
  Number(
    (db.prepare("SELECT count(*) AS count FROM pages").get() as {
      count: number;
    }).count,
  );

/** The exact applied-ACK shape the checkpoint server returns. */
function appliedResult(commit: Commit): CommitResult {
  return {
    protocol: 1,
    workspaceId: commit.workspaceId,
    clientId: commit.clientId,
    operationId: commit.operationId,
    serverEpoch: commit.serverEpoch,
    fingerprint: fingerprintCommit(commit),
    status: "applied",
    revision: commit.baseRevision + 1,
    checkpointHash: commit.checkpointHash,
  };
}

/** One synthetic remote change: the real current checkpoint plus one added
 * page. Re-sort by primary key, including after two-digit revision numbers. */
function remoteChangeFor(db: DatabaseSync, revision: number): Change {
  const checkpoint = buildWorkspaceCheckpoint(db);
  const tables = (
    checkpoint.payload as unknown as {
      tables: Record<string, (string | number | null)[][]>;
    }
  ).tables;
  const now = Date.now();
  const page = {
    id: `remote-page-${revision}`,
    schemaVersion: 1,
    parentId: null,
    title: `Remote page ${revision}`,
    icon: "",
    cover: "",
    position: revision,
    doc: textDoc(512),
    kind: "page",
    database: null,
    favorite: false,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    deletedAt: null,
  };
  tables.pages.push([page.id, JSON.stringify(page)]);
  tables.pages.sort((a, b) => String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);
  const checkpointHash = hashCheckpoint(checkpoint);
  return {
    revision,
    clientId: REMOTE_CLIENT_ID,
    operationId: randomUUID(),
    fingerprint: sha256(`capacity-remote-${revision}`),
    checkpointHash,
    checkpoint,
  };
}

/** Stage the local commit as its own server echo, exactly like the production
 * receive() reconcile: skip_apply=1, cursor advances without an apply. Must
 * run while applied_revision === 1 (the first cycle only). */
function stageOwnEcho(
  sync: WorkspaceSyncStore,
  commit: Commit,
): { echoWireBytes: number; stageMs: number } {
  const echo: Change = {
    revision: 1,
    clientId: IDENTITY.clientId,
    operationId: commit.operationId,
    fingerprint: fingerprintCommit(commit),
    checkpointHash: commit.checkpointHash,
    checkpoint: commit.checkpoint,
  };
  const changePage: ChangePage = {
    protocol: 1,
    workspaceId: IDENTITY.workspaceId,
    serverEpoch: IDENTITY.serverEpoch,
    after: 0,
    headRevision: 1,
    changes: [echo],
  };
  const start = performance.now();
  sync.stageChanges(changePage);
  return {
    echoWireBytes: Buffer.byteLength(canonicalJson(changePage, MAX_WIRE_BYTES)),
    stageMs: performance.now() - start,
  };
}

type RevisionSample = {
  revision: number;
  checkpointBytes: number;
  commitWireBytes: number;
  wireMarginBytes: number;
  versions: number;
  prepareMs: number;
  recordMs: number;
  outboxBytes: number;
  appliedBytes: number;
  inboxBytes: number;
  status: {
    generation: number;
    cleanGeneration: number;
    appliedRevision: number;
    receivedCursor: number;
    pending: boolean;
    conflict: boolean;
  };
};

type Rejection = {
  at: "enable" | "prepare";
  revision: number | null;
  errorCode: string;
  message: string;
  checkpointBytes: number;
  ms: number;
};

type Scenario = {
  name: string;
  pages: number;
  bodyBytes: number;
  /** prepare/ACK cycles with title-only edits (constant checkpoint bytes). */
  edits: number;
  remoteRounds: number;
  /** Growing-doc edits until the first prepare rejection or `cap`. */
  growing?: { base: number; step: number; cap: number };
  expectEnableRejection?: boolean;
};

const scenarios: Scenario[] = [
  { name: "revisions-1", pages: 2, bodyBytes: 256, edits: 1, remoteRounds: 0 },
  { name: "revisions-5", pages: 2, bodyBytes: 256, edits: 5, remoteRounds: 0 },
  { name: "revisions-20", pages: 2, bodyBytes: 256, edits: 20, remoteRounds: 0 },
  { name: "remote-rounds-5", pages: 2, bodyBytes: 256, edits: 1, remoteRounds: 5 },
  { name: "remote-rounds-20", pages: 2, bodyBytes: 256, edits: 1, remoteRounds: 20 },
  { name: "revisions-body-8k-x10", pages: 1, bodyBytes: 8192, edits: 10, remoteRounds: 0 },
  {
    name: "history-over-limit",
    pages: 1,
    bodyBytes: 8192,
    edits: 0,
    remoteRounds: 0,
    growing: { base: 50_000, step: 5_000, cap: 20 },
  },
  {
    name: "over-limit-at-enable",
    pages: 130,
    bodyBytes: 8192,
    edits: 0,
    remoteRounds: 0,
    expectEnableRejection: true,
  },
];

const rows: Record<string, unknown>[] = [];
for (const scenario of scenarios) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-lv4-revisions-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  mkdirSync(join(workspace, "assets"));
  const store = new Store(join(workspace, "workspace.sqlite"));
  const row: Record<string, unknown> = { name: scenario.name };
  try {
    let selected = store.create(null, "page", "page 0");
    for (let i = 1; i < scenario.pages; i++) {
      store.create(null, "page", `page ${i}`);
    }
    for (const page of store.pages()) {
      store.update(page.id, page.revision, { doc: textDoc(scenario.bodyBytes) });
    }
    selected = store.get(selected.id);
    const sync = new WorkspaceSyncStore(store, IDENTITY);
    const revisionSamples: RevisionSample[] = [];
    let rejection: Rejection | null = null;

    const enableStart = performance.now();
    let enabled = false;
    try {
      sync.enable("publish", () => {
        // The production before-enable backup is measured by
        // scripts/lv4-capacity.ts; a no-op keeps this measurement pure.
      });
      enabled = true;
      row.enable = { ok: true, ms: performance.now() - enableStart };
    } catch (error) {
      row.enable = {
        ok: false,
        ms: performance.now() - enableStart,
        errorCode: error instanceof SyncError ? error.code : undefined,
        message: error instanceof Error ? error.message : String(error),
      };
      rejection = {
        at: "enable",
        revision: null,
        errorCode: error instanceof SyncError ? error.code : "non-sync-error",
        message: error instanceof Error ? error.message : String(error),
        checkpointBytes: Buffer.byteLength(
          canonicalJson(buildWorkspaceCheckpoint(store.db), MAX_WIRE_BYTES),
        ),
        ms: performance.now() - enableStart,
      };
    }

    const cycle = (
      revision: number,
      edit: () => void,
    ): { sample?: RevisionSample; rejected?: Rejection } => {
      edit();
      const prepareStart = performance.now();
      let commit: Commit | null;
      try {
        commit = sync.prepare();
      } catch (error) {
        const prepareMs = performance.now() - prepareStart;
        return {
          rejected: {
            at: "prepare",
            revision,
            errorCode:
              error instanceof SyncError ? error.code : "non-sync-error",
            message: error instanceof Error ? error.message : String(error),
            checkpointBytes: Buffer.byteLength(
              canonicalJson(buildWorkspaceCheckpoint(store.db), MAX_WIRE_BYTES),
            ),
            ms: prepareMs,
          },
        };
      }
      const prepareMs = performance.now() - prepareStart;
      if (!commit) throw new Error("prepare returned null without rejection");
      const recordStart = performance.now();
      sync.recordResult(commit, appliedResult(commit));
      const recordMs = performance.now() - recordStart;
      const status = sync.status();
      return {
        sample: {
          revision,
          checkpointBytes: Buffer.byteLength(
            canonicalJson(commit.checkpoint, MAX_WIRE_BYTES),
          ),
          commitWireBytes: Buffer.byteLength(
            canonicalJson(commit, MAX_WIRE_BYTES),
          ),
          wireMarginBytes:
            MAX_WIRE_BYTES -
            Buffer.byteLength(canonicalJson(commit, MAX_WIRE_BYTES)),
          versions: versionsCount(store.db),
          prepareMs,
          recordMs,
          outboxBytes:
            columnBytes(store.db, "workspace_sync_outbox", "commit_json") +
            columnBytes(store.db, "workspace_sync_outbox", "result_json"),
          appliedBytes: columnBytes(
            store.db,
            "workspace_sync_applied",
            "checkpoint_json",
          ),
          inboxBytes: columnBytes(
            store.db,
            "workspace_sync_inbox",
            "change_json",
          ),
          status: { ...status },
        },
      };
    };

    if (enabled) {
      if (scenario.growing) {
        for (let i = 0; i < scenario.growing.cap && !rejection; i++) {
          const outcome = cycle(i + 1, () => {
            const page = store.get(selected.id);
            store.update(page.id, page.revision, {
              doc: textDoc(scenario.growing!.base + i * scenario.growing!.step),
            });
          });
          if (outcome.rejected) rejection = outcome.rejected;
          else revisionSamples.push(outcome.sample!);
        }
      } else {
        for (let i = 0; i < scenario.edits && !rejection; i++) {
          const outcome = cycle(i + 1, () => {
            const page = store.get(selected.id);
            store.update(page.id, page.revision, { title: `edit ${i}` });
          });
          if (outcome.rejected) rejection = outcome.rejected;
          else revisionSamples.push(outcome.sample!);
        }
      }

      const remoteSamples: Record<string, unknown>[] = [];
      let echo: { echoWireBytes: number; stageMs: number } | null = null;
      if (scenario.remoteRounds > 0) {
        if (scenario.edits !== 1 || rejection) {
          throw new Error(
            "remoteRounds scenarios require exactly one clean first cycle",
          );
        }
        const applied = store.db
          .prepare(
            "SELECT operation_id, fingerprint, commit_json FROM workspace_sync_outbox WHERE result_json IS NOT NULL ORDER BY rowid LIMIT 1",
          )
          .get() as
          | { operation_id: string; fingerprint: string; commit_json: string }
          | undefined;
        if (!applied) throw new Error("applied outbox row is missing");
        const operation = JSON.parse(applied.commit_json) as Commit;
        echo = stageOwnEcho(sync, operation);
        for (let round = 0; round < scenario.remoteRounds; round++) {
          const base = sync.status().receivedCursor;
          const change = remoteChangeFor(store.db, base + 1);
          const changePage: ChangePage = {
            protocol: 1,
            workspaceId: IDENTITY.workspaceId,
            serverEpoch: IDENTITY.serverEpoch,
            after: base,
            headRevision: base + 1,
            changes: [change],
          };
          const stageStart = performance.now();
          sync.stageChanges(changePage);
          const stageMs = performance.now() - stageStart;
          const applyStart = performance.now();
          sync.applyNext(change, (assets) => {
            if (assets.length) {
              throw new Error("capacity-revisions fixture declares no assets");
            }
          });
          const applyMs = performance.now() - applyStart;
          remoteSamples.push({
            revision: base + 1,
            changePageWireBytes: Buffer.byteLength(
              canonicalJson(changePage, MAX_WIRE_BYTES),
            ),
            stageMs,
            applyMs,
            inboxBytes: columnBytes(
              store.db,
              "workspace_sync_inbox",
              "change_json",
            ),
            appliedBytes: columnBytes(
              store.db,
              "workspace_sync_applied",
              "checkpoint_json",
            ),
            pageCountAfter: pagesCount(store.db),
          });
        }
      }
      row.revisions = revisionSamples;
      row.remoteRounds = remoteSamples;
      if (echo) row.echo = echo;
      try {
        validateWorkspaceSyncSchema(store.db);
        row.schemaOk = true;
      } catch (error) {
        row.schemaOk = false;
        row.schemaError = error instanceof Error ? error.message : String(error);
      }
    } else {
      row.schemaOk = null;
    }
    if (rejection) row.rejection = rejection;
    row.dbBytes = fileBytes(store.path);
    row.walBytes = fileBytes(store.path + "-wal");
    rows.push(row);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      checkpointLimitBytes: MAX_CHECKPOINT_BYTES,
      wireLimitBytes: MAX_WIRE_BYTES,
      methodology:
        "synthetic Store + real WorkspaceSyncStore; applied ACK shape passed through recordResult; remote changes through stageChanges/applyNext; own echo staged with skip_apply; one run per case; no network; no user data",
      scenarios: rows,
    },
    null,
    2,
  ),
);
