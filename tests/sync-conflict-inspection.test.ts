import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import { compareConflictPages } from "../src/renderer/conflict-page-comparison";
import type { WorkspaceConflictResolutionTarget } from "../src/shared/workspace-conflict-resolution";
import {
  WorkspaceSyncStore,
  type WorkspaceSyncIdentity,
} from "../src/sync/workspace-store";
import {
  fingerprintCommit,
  hashCheckpoint,
  type Change,
  type Checkpoint,
  type Commit,
  type CommitResult,
} from "../src/sync/protocol";

const roots: string[] = [];
const stores: Store[] = [];

function makeStore(): { store: Store; root: string } {
  const root = mkdtempSync(join(tmpdir(), "folio-conflict-inspection-"));
  roots.push(root);
  const store = new Store(join(root, "workspace.sqlite"));
  stores.push(store);
  return { store, root };
}

function identity(clientId = "client-a"): WorkspaceSyncIdentity {
  return {
    workspaceId: "workspace",
    clientId,
    bindingId: "binding-" + clientId,
    serverEpoch: "epoch-1",
  };
}

function asChange(commit: Commit, revision: number): Change {
  return {
    revision,
    clientId: commit.clientId,
    operationId: commit.operationId,
    fingerprint: fingerprintCommit(commit),
    checkpointHash: commit.checkpointHash,
    checkpoint: commit.checkpoint,
  };
}

function applied(
  commit: Commit,
  revision: number,
): Extract<CommitResult, { status: "applied" }> {
  return {
    protocol: 1,
    workspaceId: commit.workspaceId,
    clientId: commit.clientId,
    operationId: commit.operationId,
    serverEpoch: commit.serverEpoch,
    fingerprint: fingerprintCommit(commit),
    status: "applied",
    revision,
    checkpointHash: commit.checkpointHash,
  };
}

function conflictResult(
  commit: Commit,
  revision: number,
  checkpoint: Checkpoint | null,
): Extract<CommitResult, { status: "conflict" }> {
  return {
    protocol: 1,
    workspaceId: commit.workspaceId,
    clientId: commit.clientId,
    operationId: commit.operationId,
    serverEpoch: commit.serverEpoch,
    fingerprint: fingerprintCommit(commit),
    status: "conflict",
    head: {
      revision,
      checkpointHash: checkpoint ? hashCheckpoint(checkpoint) : null,
      checkpoint,
    },
  };
}

function changePage(
  after: number,
  headRevision: number,
  changes: Change[],
): Parameters<WorkspaceSyncStore["stageChanges"]>[0] {
  return {
    protocol: 1,
    workspaceId: "workspace",
    serverEpoch: "epoch-1",
    after,
    headRevision,
    changes,
  };
}

function bootSharedPage() {
  const a = makeStore(),
    b = makeStore(),
    syncA = new WorkspaceSyncStore(a.store, identity("client-a")),
    syncB = new WorkspaceSyncStore(b.store, identity("client-b"));
  syncA.enable("publish", () => {});
  syncB.enable("join", () => {});
  const empty = syncA.prepare()!;
  syncA.recordResult(empty, applied(empty, 1));
  const emptyChange = asChange(empty, 1);
  syncB.stageChanges(changePage(0, 1, [emptyChange]));
  syncB.applyNext(emptyChange, () => {});
  const page = a.store.create(null, "page", "Shared");
  const created = syncA.prepare()!;
  syncA.recordResult(created, applied(created, 2));
  const createdChange = asChange(created, 2);
  syncB.stageChanges(changePage(1, 2, [createdChange]));
  syncB.applyNext(createdChange, () => {});
  return { a, b, syncA, syncB, page };
}

function makeConflict(fixture: ReturnType<typeof bootSharedPage>) {
  const { a, b, syncA, syncB, page } = fixture;
  a.store.update(page.id, 0, { title: "remote" });
  const aCommit = syncA.prepare()!;
  syncA.recordResult(aCommit, applied(aCommit, 3));
  const aChange = asChange(aCommit, 3);
  b.store.update(page.id, 0, { title: "local" });
  const bCommit = syncB.prepare()!;
  syncB.stageChanges(changePage(2, 3, [aChange]));
  syncB.recordResult(bCommit, conflictResult(bCommit, 3, aCommit.checkpoint));
  return { aCommit, aChange, bCommit, revision: 3 };
}

function checkpointPageTitle(checkpointJson: string, pageId: string): string {
  const checkpoint = JSON.parse(checkpointJson) as Checkpoint;
  const rows = (
    checkpoint.payload as unknown as {
      tables: { pages: (string | number | null)[][] };
    }
  ).tables.pages;
  const row = rows.find((entry) => entry[0] === pageId)!;
  return (JSON.parse(String(row[1])) as { title: string }).title;
}

afterEach(() => {
  for (const store of stores.splice(0))
    try {
      store.close();
    } catch {}
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("conflict inspection", () => {
  it("reports both candidates with explicit revisions and hashes without writing", () => {
    const fixture = bootSharedPage();
    const { b, syncB, page } = fixture;
    const { aChange, bCommit } = makeConflict(fixture);
    const beforeStatus = syncB.status();
    const beforeConflicts = b.store.db
      .prepare("SELECT count(*) AS count FROM workspace_sync_conflicts")
      .get();
    const beforeArchives = b.store.db
      .prepare("SELECT count(*) AS count FROM workspace_sync_archives")
      .get();

    const inspection = syncB.conflictInspection()!;
    expect(inspection).toMatchObject({
      operationId: bCommit.operationId,
      local: {
        side: "local",
        revision: bCommit.baseRevision,
        checkpointHash: bCommit.checkpointHash,
        assets: 0,
      },
      remote: {
        side: "remote",
        revision: 3,
        checkpointHash: aChange.checkpointHash,
        assets: 0,
      },
    });
    expect(inspection.local.pages).toBe(1);
    expect(inspection.remote.pages).toBe(1);
    expect(inspection.local.bytes).toBeGreaterThan(0);
    expect(inspection.remote.bytes).toBeGreaterThan(0);
    expect(inspection.status).toMatchObject({
      receivedCursor: beforeStatus.receivedCursor,
      appliedRevision: beforeStatus.appliedRevision,
      pending: true,
    });
    expect(syncB.conflictArchives()).toEqual({ archives: [], total: 0 });
    expect(syncB.status()).toEqual(beforeStatus);
    expect(
      b.store.db
        .prepare("SELECT count(*) AS count FROM workspace_sync_conflicts")
        .get(),
    ).toEqual(beforeConflicts);
    expect(
      b.store.db
        .prepare("SELECT count(*) AS count FROM workspace_sync_archives")
        .get(),
    ).toEqual(beforeArchives);
    expect(b.store.get(page.id).title).toBe("local");
  });

  it("extracts an exact candidate only for the observed revision and hash", () => {
    const fixture = bootSharedPage();
    const { syncB, page } = fixture;
    const { aChange, aCommit, bCommit } = makeConflict(fixture);
    const inspection = syncB.conflictInspection()!;
    const local = syncB.conflictCandidate({
      operationId: inspection.operationId,
      side: "local",
      expectedRevision: inspection.local.revision,
      expectedCheckpointHash: inspection.local.checkpointHash,
    });
    expect(local.checkpointHash).toBe(bCommit.checkpointHash);
    expect(hashCheckpoint(JSON.parse(local.checkpointJson!))).toBe(
      bCommit.checkpointHash,
    );
    expect(checkpointPageTitle(local.checkpointJson!, page.id)).toBe("local");

    const remote = syncB.conflictCandidate({
      operationId: inspection.operationId,
      side: "remote",
      expectedRevision: inspection.remote.revision,
      expectedCheckpointHash: inspection.remote.checkpointHash,
    });
    expect(remote.checkpointHash).toBe(aChange.checkpointHash);
    expect(hashCheckpoint(JSON.parse(remote.checkpointJson!))).toBe(
      aCommit.checkpointHash,
    );
    expect(checkpointPageTitle(remote.checkpointJson!, page.id)).toBe("remote");
    expect(compareConflictPages(local.checkpointJson!, remote.checkpointJson!)).toMatchObject({
      totalChanged: 1,
      differences: [{id: page.id, local: {title: "local"}, remote: {title: "remote"}}],
    });
    expect(syncB.status().conflict).toBe(true);

    expect(() =>
      syncB.conflictCandidate({
        operationId: inspection.operationId,
        side: "local",
        expectedRevision: inspection.local.revision + 1,
        expectedCheckpointHash: inspection.local.checkpointHash,
      }),
    ).toThrow(/conflict-candidate-revision-mismatch/);
    expect(() =>
      syncB.conflictCandidate({
        operationId: inspection.operationId,
        side: "local",
        expectedRevision: inspection.local.revision,
        expectedCheckpointHash: "0".repeat(64),
      }),
    ).toThrow(/conflict-candidate-hash-mismatch/);
    expect(() =>
      syncB.conflictCandidate({
        operationId: "different-operation",
        side: "remote",
        expectedRevision: inspection.remote.revision,
        expectedCheckpointHash: inspection.remote.checkpointHash,
      }),
    ).toThrow(/sync-conflict-changed/);
    expect(syncB.conflictInspection()).toEqual(inspection);
  });

  it("rejects a tampered stored candidate instead of trusting it", () => {
    const fixture = bootSharedPage();
    const { b, syncB } = fixture;
    const { bCommit } = makeConflict(fixture);
    b.store.db
      .prepare(
        "UPDATE workspace_sync_conflicts SET local_checkpoint_json=? WHERE operation_id=?",
      )
      .run("{}", bCommit.operationId);
    expect(() => syncB.conflictInspection()).toThrow(
      /invalid-conflict-checkpoint/,
    );
    expect(() =>
      syncB.conflictCandidate({
        operationId: bCommit.operationId,
        side: "local",
        expectedRevision: bCommit.baseRevision,
        expectedCheckpointHash: bCommit.checkpointHash,
      }),
    ).toThrow(/invalid-conflict-checkpoint/);
  });

  it("does not archive or replace local content when a conflict candidate was tampered with", () => {
    const fixture = bootSharedPage();
    const {b, syncB, page} = fixture;
    const {aChange, bCommit} = makeConflict(fixture);
    b.store.db.prepare("UPDATE workspace_sync_conflicts SET local_checkpoint_json=? WHERE operation_id=?")
      .run("{}", bCommit.operationId);
    const beforeStatus = syncB.status();
    expect(() => syncB.chooseRemote(aChange, () => {})).toThrow(/invalid-conflict-checkpoint/);
    expect(b.store.get(page.id).title).toBe("local");
    expect(syncB.status()).toEqual(beforeStatus);
    expect(syncB.conflictArchives()).toEqual({archives: [], total: 0});
  });
});

// Compare durable data, including the outbox and candidates, on refusal. Cursor
// advancement is only allowed by the separate transport-level catchup tests.
function decisionState(store: Store) {
  return ["pages", "versions", "assets", "workspace_sync_state", "workspace_sync_outbox",
    "workspace_sync_conflicts", "workspace_sync_archives", "workspace_sync_applied", "workspace_sync_inbox"]
    .map((table) => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

describe("pinned conflict decisions", () => {
  it("pins latest local content separately from the conflict-time candidate without writing", () => {
    const fixture = bootSharedPage();
    const {b, syncB} = fixture;
    const {bCommit} = makeConflict(fixture);
    b.store.create(null, "page", "new saved input");
    const before = decisionState(b.store);
    const target = syncB.conflictResolutionTarget("local");
    expect(target).toMatchObject({...identity("client-b"), choice: "local", operationId: bCommit.operationId,
      localRevision: 2, localCheckpointHash: bCommit.checkpointHash, remoteRevision: 3, appliedRevision: 2});
    expect(target.latestCheckpointHash).not.toBe(target.localCheckpointHash);
    expect(Object.isFrozen(target)).toBe(true);
    expect(decisionState(b.store)).toEqual(before);

    let admitted = 0;
    const commit = syncB.chooseLocal(3, {target, admitBytes: (bytes) => {admitted = bytes;}});
    expect(commit.checkpointHash).toBe(target.latestCheckpointHash);
    const rows = b.store.db.prepare("SELECT * FROM workspace_sync_archives ORDER BY id").all() as
      {operation_id: string; kind: string; checkpoint_json: string}[];
    expect(rows.map((row) => row.kind)).toEqual(["conflict-local", "conflict-remote", "choose-local-latest"]);
    expect(rows.every((row) => row.operation_id === target.operationId)).toBe(true);
    expect(rows.map((row) => hashCheckpoint(JSON.parse(row.checkpoint_json)))).toEqual([
      target.localCheckpointHash, target.remoteCheckpointHash, target.latestCheckpointHash]);
    expect(admitted).toBeGreaterThan(Buffer.byteLength(JSON.stringify(commit)) +
      rows.reduce((sum, row) => sum + Buffer.byteLength(row.checkpoint_json), 0));
    expect(syncB.prepare()!.operationId).toBe(commit.operationId);
    expect(() => syncB.chooseLocal(3, {target})).toThrow(/sync-conflict-not-found/);
    expect(syncB.conflictArchives().total).toBe(3);
  });

  it.each(["local", "remote"] as const)("rejects %s after new saved edits without discarding them", (choice) => {
    const fixture = bootSharedPage();
    const {b, syncB} = fixture;
    const {aChange} = makeConflict(fixture);
    const target = syncB.conflictResolutionTarget(choice);
    const newest = b.store.create(null, "page", "keep this input");
    const before = decisionState(b.store);
    expect(() => choice === "local" ? syncB.chooseLocal(3, {target}) : syncB.chooseRemote(aChange, () => {}, {target}))
      .toThrow(/conflict-selection-stale/);
    expect(decisionState(b.store)).toEqual(before);
    expect(b.store.get(newest.id).title).toBe("keep this input");
  });

  it("rejects content drift even if the generation counter is unchanged", () => {
    const fixture = bootSharedPage();
    const {b, syncB, page} = fixture;
    const {aChange} = makeConflict(fixture);
    const target = syncB.conflictResolutionTarget("remote");
    // Model a valid content change whose generation trigger was suppressed.
    const data = JSON.parse(String(b.store.db.prepare("SELECT data FROM pages WHERE id=?").get(page.id)!.data));
    data.title = "unobserved saved content";
    b.store.db.exec("UPDATE workspace_sync_state SET suppress_triggers=1");
    b.store.db.prepare("UPDATE pages SET data=? WHERE id=?").run(JSON.stringify(data), page.id);
    b.store.db.exec("UPDATE workspace_sync_state SET suppress_triggers=0");
    expect(syncB.status().generation).toBe(target.generation);
    const before = decisionState(b.store);
    expect(() => syncB.chooseRemote(aChange, () => {}, {target})).toThrow(/conflict-selection-stale/);
    expect(decisionState(b.store)).toEqual(before);
  });

  it("rejects another identity, candidate or decision at the same remote revision", () => {
    const fixture = bootSharedPage();
    const {b, syncB} = fixture;
    const {aChange} = makeConflict(fixture);
    const target = syncB.conflictResolutionTarget("remote");
    const before = decisionState(b.store);
    const replacements: Partial<WorkspaceConflictResolutionTarget>[] = [
      {workspaceId: "another-workspace"}, {clientId: "another-device"}, {bindingId: "another-binding"},
      {serverEpoch: "another-epoch"}, {operationId: "another-operation"}, {localCheckpointHash: "0".repeat(64)},
      {remoteCheckpointHash: "0".repeat(64)}, {cleanGeneration: target.cleanGeneration + 1},
      {appliedRevision: target.appliedRevision + 1}, {conflictGeneration: target.conflictGeneration + 1},
      {choice: "local"},
    ];
    for (const replacement of replacements) {
      expect(() => syncB.chooseRemote(aChange, () => {}, {target: {...target, ...replacement}})).toThrow();
      expect(decisionState(b.store)).toEqual(before);
    }
    expect(() => syncB.assertConflictResolutionTarget({...target, unexpected: true} as WorkspaceConflictResolutionTarget))
      .toThrow(/conflict-selection-stale/);
  });

  it.each(["local", "remote"] as const)("refuses corrupt durable candidates before a legacy %s choice", (choice) => {
    const fixture = bootSharedPage();
    const {b, syncB} = fixture;
    const {aChange} = makeConflict(fixture);
    b.store.db.prepare("UPDATE workspace_sync_conflicts SET local_checkpoint_json='{}'").run();
    const before = decisionState(b.store);
    expect(() => choice === "local" ? syncB.chooseLocal(3) : syncB.chooseRemote(aChange, () => {}))
      .toThrow(/invalid-conflict-checkpoint/);
    expect(decisionState(b.store)).toEqual(before);
  });

  it.each(["local", "remote"] as const)("leaves the %s decision untouched on capacity refusal", (choice) => {
    const fixture = bootSharedPage();
    const {b, syncB} = fixture;
    const {aChange} = makeConflict(fixture);
    b.store.create(null, "page", "newest local");
    const target = syncB.conflictResolutionTarget(choice);
    const before = decisionState(b.store);
    const options = {target, admitBytes: (bytes: number) => {expect(bytes).toBeGreaterThan(0); throw new Error("quota refused");}};
    expect(() => choice === "local" ? syncB.chooseLocal(3, options) : syncB.chooseRemote(aChange, () => {}, options))
      .toThrow("quota refused");
    expect(decisionState(b.store)).toEqual(before);
  });

  it.each(["local", "remote"] as const)("rolls back %s when the second archive insert fails", (choice) => {
    const fixture = bootSharedPage();
    const {b, syncB} = fixture;
    const {aChange} = makeConflict(fixture);
    const target = syncB.conflictResolutionTarget(choice);
    b.store.db.exec(`CREATE TRIGGER fail_conflict_archive BEFORE INSERT ON workspace_sync_archives
      WHEN NEW.kind='conflict-remote' BEGIN SELECT RAISE(ABORT, 'archive-write-fault'); END`);
    const before = decisionState(b.store);
    expect(() => choice === "local" ? syncB.chooseLocal(3, {target}) : syncB.chooseRemote(aChange, () => {}, {target}))
      .toThrow("archive-write-fault");
    expect(decisionState(b.store)).toEqual(before);
  });

  it("preserves both candidates and the newer local checkpoint in a remote decision", () => {
    const fixture = bootSharedPage();
    const {b, syncB, page} = fixture;
    const {aChange} = makeConflict(fixture);
    const latestOnly = b.store.create(null, "page", "recover me");
    const target = syncB.conflictResolutionTarget("remote");
    let admitted = 0;
    syncB.chooseRemote(aChange, () => {}, {target, admitBytes: (bytes) => {admitted = bytes;}});
    expect(b.store.get(page.id).title).toBe("remote");
    expect(() => b.store.get(latestOnly.id)).toThrow();
    const archives = b.store.db.prepare("SELECT * FROM workspace_sync_archives ORDER BY id").all() as
      {operation_id: string; checkpoint_json: string}[];
    expect(archives).toHaveLength(3);
    expect(archives.every((row) => row.operation_id === target.operationId)).toBe(true);
    expect(archives.map((row) => hashCheckpoint(JSON.parse(row.checkpoint_json)))).toEqual([
      target.localCheckpointHash, target.remoteCheckpointHash, target.latestCheckpointHash]);
    expect(checkpointPageTitle(archives[2].checkpoint_json, latestOnly.id)).toBe("recover me");
    expect(admitted).toBeGreaterThan(archives.reduce((sum, row) => sum + Buffer.byteLength(row.checkpoint_json), 0));
    expect(syncB.status()).toMatchObject({appliedRevision: 3, conflict: false});
  });
});
