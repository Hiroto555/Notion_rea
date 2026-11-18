import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/persistence/store";
import {
  WorkspaceSyncStore,
  type WorkspaceSyncIdentity,
} from "../src/sync/workspace-store";
import {
  CLIENT_RETENTION_LIMITS,
  inspectSyncRetention,
} from "../src/sync/sync-retention";
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

function makeStore(): { store: Store; path: string } {
  const root = mkdtempSync(join(tmpdir(), "folio-retention-admission-"));
  roots.push(root);
  const path = join(root, "workspace.sqlite");
  const store = new Store(path);
  stores.push(store);
  return { store, path };
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
  workspaceId: string,
  serverEpoch: string,
  after: number,
  headRevision: number,
  changes: Change[],
): Parameters<WorkspaceSyncStore["stageChanges"]>[0] {
  return {
    protocol: 1,
    workspaceId,
    serverEpoch,
    after,
    headRevision,
    changes,
  };
}

function clientRows(store: Store): number {
  return inspectSyncRetention(store.db, "client").rows;
}

function fillArchiveRows(store: Store): void {
  const needed = CLIENT_RETENTION_LIMITS.maxRows - clientRows(store);
  const statement = store.db.prepare(
    "INSERT INTO workspace_sync_archives(operation_id,kind,checkpoint_json,created_at) VALUES(?,?,?,?)",
  );
  for (let index = 0; index < needed; index++)
    statement.run("filler-" + index, "filler", "{}", index);
}

function fillArchiveBytes(store: Store): void {
  const current = inspectSyncRetention(store.db, "client").bytes;
  if (current === CLIENT_RETENTION_LIMITS.maxBytes) return;
  expect(current).toBeLessThan(CLIENT_RETENTION_LIMITS.maxBytes);
  store.db
    .prepare(
      "INSERT INTO workspace_sync_archives(operation_id,kind,checkpoint_json,created_at) VALUES(?,?,?,?)",
    )
    .run(
      "filler-bytes",
      "filler",
      "x".repeat(CLIENT_RETENTION_LIMITS.maxBytes - current),
      0,
    );
}

function outboxCount(store: Store): number {
  return (
    store.db
      .prepare("SELECT count(*) AS count FROM workspace_sync_outbox")
      .get() as { count: number }
  ).count;
}

function archiveCount(store: Store): number {
  return (
    store.db
      .prepare("SELECT count(*) AS count FROM workspace_sync_archives")
      .get() as { count: number }
  ).count;
}

function inboxCount(store: Store): number {
  return (
    store.db
      .prepare("SELECT count(*) AS count FROM workspace_sync_inbox")
      .get() as { count: number }
  ).count;
}

function published(clientId = "client-a") {
  const fixture = makeStore(),
    sync = new WorkspaceSyncStore(fixture.store, identity(clientId));
  sync.enable("publish", () => {});
  return { ...fixture, sync };
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
  syncB.stageChanges(changePage("workspace", "epoch-1", 0, 1, [emptyChange]));
  syncB.applyNext(emptyChange, () => {});
  const page = a.store.create(null, "page", "Shared");
  const created = syncA.prepare()!;
  syncA.recordResult(created, applied(created, 2));
  const createdChange = asChange(created, 2);
  syncB.stageChanges(changePage("workspace", "epoch-1", 1, 2, [createdChange]));
  syncB.applyNext(createdChange, () => {});
  return { a, b, syncA, syncB, page };
}

function makeConflict(fixture: ReturnType<typeof bootSharedPage>): {
  aChange: Change;
  bCommit: Commit;
} {
  const { a, b, syncA, syncB, page } = fixture;
  a.store.update(page.id, 0, { title: "remote" });
  const aCommit = syncA.prepare()!;
  syncA.recordResult(aCommit, applied(aCommit, 3));
  const aChange = asChange(aCommit, 3);
  b.store.update(page.id, 0, { title: "local" });
  const bCommit = syncB.prepare()!;
  syncB.stageChanges(changePage("workspace", "epoch-1", 2, 3, [aChange]));
  const conflict = conflictResult(bCommit, 3, aCommit.checkpoint);
  conflict.fingerprint = fingerprintCommit(bCommit);
  syncB.recordResult(bCommit, conflict);
  return { aChange, bCommit };
}

afterEach(() => {
  for (const store of stores.splice(0))
    try {
      store.close();
    } catch {}
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("client retention admission in WorkspaceSyncStore", () => {
  it("rolls back a new outbox prepare at the row cap without deleting retained rows", () => {
    const { store, sync } = published();
    const page = store.create(null, "page", "retained");
    fillArchiveRows(store);
    const beforeRows = clientRows(store);

    expect(() => sync.prepare()).toThrow(/sync-retention-held/);
    expect(outboxCount(store)).toBe(0);
    expect(clientRows(store)).toBe(beforeRows);
    expect(store.get(page.id).title).toBe("retained");
  });

  it("rejects a new outbox when retained bytes already fill the cap", () => {
    const { store, sync } = published();
    fillArchiveBytes(store);

    expect(() => sync.prepare()).toThrow(/sync-retention-held/);
    expect(outboxCount(store)).toBe(0);
  });

  it("keeps an existing pending prepare usable at the row cap without growing", () => {
    const { store, sync } = published();
    const pending = sync.prepare()!;
    fillArchiveRows(store);
    const rowsAtCap = clientRows(store),
      rows = outboxCount(store);

    expect(rowsAtCap).toBe(CLIENT_RETENTION_LIMITS.maxRows);
    expect(sync.prepare()!.operationId).toBe(pending.operationId);
    expect(clientRows(store)).toBe(rowsAtCap);
    expect(outboxCount(store)).toBe(rows);
  });

  it("keeps an already recorded result usable at the cap without extra growth", () => {
    const { store, sync } = published();
    const needed = CLIENT_RETENTION_LIMITS.maxRows - 2 - clientRows(store);
    const statement = store.db.prepare(
      "INSERT INTO workspace_sync_archives(operation_id,kind,checkpoint_json,created_at) VALUES(?,?,?,?)",
    );
    for (let index = 0; index < needed; index++)
      statement.run("pre-filler-" + index, "filler", "{}", index);
    const commit = sync.prepare()!;
    const result = applied(commit, 1);
    sync.recordResult(commit, result);
    fillArchiveRows(store);
    const rowsAtCap = clientRows(store),
      archives = archiveCount(store);

    expect(rowsAtCap).toBe(CLIENT_RETENTION_LIMITS.maxRows);
    expect(() => sync.recordResult(commit, result)).not.toThrow();
    expect(clientRows(store)).toBe(rowsAtCap);
    expect(archiveCount(store)).toBe(archives);
  });

  it("rolls back a new inbox row at the row cap", () => {
    const donor = published("client-b"),
      empty = donor.sync.prepare()!;
    donor.sync.recordResult(empty, applied(empty, 1));
    const change = asChange(empty, 1);
    const target = makeStore(),
      sync = new WorkspaceSyncStore(target.store, identity("client-a"));
    sync.enable("join", () => {});
    fillArchiveRows(target.store);
    const rowsAtCap = clientRows(target.store);

    expect(() =>
      sync.stageChanges(changePage("workspace", "epoch-1", 0, 1, [change])),
    ).toThrow(/sync-retention-held/);
    expect(inboxCount(target.store)).toBe(0);
    expect(clientRows(target.store)).toBe(rowsAtCap);
    expect(sync.status().receivedCursor).toBe(0);
  });

  it("reserves the ACK budget so a pending inbox attempt cannot consume it", () => {
    const { store, sync } = published();
    const needed = CLIENT_RETENTION_LIMITS.maxRows - 2 - clientRows(store);
    const statement = store.db.prepare(
      "INSERT INTO workspace_sync_archives(operation_id,kind,checkpoint_json,created_at) VALUES(?,?,?,?)",
    );
    for (let index = 0; index < needed; index++)
      statement.run("pre-filler-" + index, "filler", "{}", index);
    const commit = sync.prepare()!;
    const pendingRows = clientRows(store);
    expect(pendingRows).toBe(CLIENT_RETENTION_LIMITS.maxRows - 1);

    expect(() =>
      sync.stageChanges(
        changePage("workspace", "epoch-1", 0, 1, [asChange(commit, 1)]),
      ),
    ).toThrow(/sync-retention-held/);
    expect(inboxCount(store)).toBe(0);
    expect(sync.status().receivedCursor).toBe(0);

    expect(() => sync.recordResult(commit, applied(commit, 1))).not.toThrow();
    expect(sync.status()).toMatchObject({
      appliedRevision: 1,
      pending: false,
    });
    expect(clientRows(store)).toBe(pendingRows);
  });

  it("rolls back chooseLocal at the cap and preserves the unresolved conflict", () => {
    const fixture = bootSharedPage(),
      { b, syncB } = fixture;
    const { bCommit } = makeConflict(fixture);
    fillArchiveRows(b.store);
    const rowsAtCap = clientRows(b.store),
      archives = archiveCount(b.store),
      outbox = outboxCount(b.store);

    expect(() => syncB.chooseLocal(3)).toThrow(/sync-retention-held/);
    expect(clientRows(b.store)).toBe(rowsAtCap);
    expect(archiveCount(b.store)).toBe(archives);
    expect(outboxCount(b.store)).toBe(outbox);
    expect(syncB.conflict()!.operation.operationId).toBe(bCommit.operationId);
    expect(
      b.store.db
        .prepare(
          "SELECT chosen FROM workspace_sync_conflicts WHERE operation_id=?",
        )
        .get(bCommit.operationId),
    ).toEqual({ chosen: null });
  });

  it("rolls back chooseRemote at the cap and preserves local content", () => {
    const fixture = bootSharedPage(),
      { b, syncB, page } = fixture;
    const { aChange } = makeConflict(fixture);
    fillArchiveRows(b.store);
    const rowsAtCap = clientRows(b.store),
      archives = archiveCount(b.store);

    expect(() => syncB.chooseRemote(aChange, () => {})).toThrow(
      /sync-retention-held/,
    );
    expect(clientRows(b.store)).toBe(rowsAtCap);
    expect(archiveCount(b.store)).toBe(archives);
    expect(syncB.conflict()).not.toBeNull();
    expect(b.store.get(page.id).title).toBe("local");
  });
});
