import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../src/persistence/store";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import { validateWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { openWorkspaceSync } from "../src/sync/workspace-sync";
import type { Commit } from "../src/sync/protocol";
import {
  CONFLICT_DECISION_KEY,
  cancelConflictDecision,
  consumedDecisionMatches,
  readConflictDecision,
  reserveConflictDecision,
} from "../src/sync/conflict-decision";
import { WorkspaceConflictDecisionControl } from "../src/main/workspace-conflict-decision-control";
import { runStartupWorkspaceSyncDetailed } from "../src/main/workspace-sync-startup";
import { finishWorkspaceQuit } from "../src/main/workspace-quit";
import { WorkspaceSyncIntentFile } from "../src/main/workspace-sync-intent";
import {
  emptyCrashRecoverySnapshot,
  type CrashRecoveryRead,
} from "../src/shared/crash-recovery";
import { requestSchema } from "../src/shared/types";

const roots: string[] = [];
const stores: Store[] = [];
const servers: Awaited<ReturnType<typeof startCheckpointServer>>[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) await server.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "folio-pinned-conflict-"),
  );
  roots.push(root);
  const workspaceId = randomUUID(),
    ownerId = randomUUID();
  const server = await startCheckpointServer({
    databasePath: join(root, "server.sqlite"),
    capabilities: [],
    workspaces: [{ workspaceId, ownerId }],
    validateCheckpoint: validateWorkspaceCheckpoint,
  });
  servers.push(server);
  const options = (name: string) => {
    const directory = join(root, name);
    mkdirSync(directory);
    mkdirSync(join(directory, "assets"));
    const store = new Store(join(directory, "workspace.sqlite"));
    stores.push(store);
    const clientId = randomUUID(),
      token = randomBytes(32).toString("base64url");
    server.registerDevice({ workspaceId, ownerId, clientId, token });
    return {
      store,
      workspaceId,
      clientId,
      bindingId: randomUUID(),
      token,
      baseUrl: server.url,
      canApply: () => true,
    };
  };
  const a = options("a"),
    b = options("b");
  const page = a.store.create(null, "page", "base");
  const publisher = await openWorkspaceSync({ ...a, mode: "publish" });
  await publisher.sendPending();
  let allowed = true;
  let admission: ((bytes: number, purpose: string) => void) | undefined;
  b.canApply = () => allowed;
  const receiver = await openWorkspaceSync({
    ...b,
    mode: "join",
    admitBytes: (bytes, purpose) => admission?.(bytes, purpose),
  });
  await receiver.receiveAndStage();
  await receiver.applyStaged(receiver.stagedTarget()!);
  a.store.update(page.id, a.store.get(page.id).revision, { title: "remote" });
  await publisher.sendPending(); // head 2, B still at 1
  b.store.update(page.id, b.store.get(page.id).revision, { title: "local" });
  await receiver.sendPending();
  expect(receiver.status()).toMatchObject({
    appliedRevision: 1,
    receivedCursor: 1,
    conflict: true,
  });
  return {
    a,
    b,
    page,
    publisher,
    receiver,
    setAllowed: (value: boolean) => {
      allowed = value;
    },
    setAdmission: (callback: typeof admission) => {
      admission = callback;
    },
  };
}

function decisionState(store: Store) {
  return [
    "pages",
    "workspace_sync_conflicts",
    "workspace_sync_archives",
    "workspace_sync_outbox",
    "workspace_sync_applied",
  ].map((table) =>
    store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  );
}

it("catches up without changing a pinned remote decision, then archives latest saved local content", async () => {
  const { b, page, receiver } = await fixture();
  const newer = b.store.create(null, "page", "new local content");
  const target = receiver.conflictResolutionTarget("remote");
  const result = await receiver.resolveConflictTarget(target);
  expect(result).toMatchObject({
    appliedRevision: 2,
    receivedCursor: 2,
    conflict: false,
  });
  expect(b.store.get(page.id).title).toBe("remote");
  expect(() => b.store.get(newer.id)).toThrow();
  const archives = receiver.conflictArchives();
  expect(archives.total).toBe(3);
  expect(archives.archives.map((row) => row.checkpointHash)).toEqual([
    target.latestCheckpointHash,
    target.remoteCheckpointHash,
    target.localCheckpointHash,
  ]);
});

it.each(["local", "remote"] as const)(
  "refuses a %s selection before network access if saved content changed",
  async (choice) => {
    const { b, receiver } = await fixture();
    const target = receiver.conflictResolutionTarget(choice);
    b.store.create(null, "page", "later edit");
    const before = decisionState(b.store);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(receiver.resolveConflictTarget(target)).rejects.toThrow(
      "conflict-selection-stale",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(decisionState(b.store)).toEqual(before);
  },
);

it.each(["local", "remote"] as const)(
  "rejects a %s decision when the actual remote head advanced",
  async (choice) => {
    const { a, b, page, publisher, receiver } = await fixture();
    const target = receiver.conflictResolutionTarget(choice);
    a.store.update(page.id, a.store.get(page.id).revision, {
      title: "new head",
    });
    await publisher.sendPending();
    const before = decisionState(b.store);
    await expect(receiver.resolveConflictTarget(target)).rejects.toThrow(
      "conflict-head-changed",
    );
    expect(decisionState(b.store)).toEqual(before);
    expect(receiver.status()).toMatchObject({
      appliedRevision: 1,
      receivedCursor: 1,
      conflict: true,
    });
  },
);

it.each(["local", "remote"] as const)(
  "rejects saved edits made while the %s head request is pending",
  async (choice) => {
    const { b, receiver } = await fixture();
    const target = receiver.conflictResolutionTarget(choice);
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await originalFetch(input, init);
      if (String(input).endsWith("/head"))
        b.store.create(null, "page", "input during network wait");
      return response;
    });
    await expect(receiver.resolveConflictTarget(target)).rejects.toThrow(
      "conflict-selection-stale",
    );
    expect(
      b.store
        .pages()
        .some((page) => page.title === "input during network wait"),
    ).toBe(true);
    expect(receiver.conflictArchives().total).toBe(0);
    expect(receiver.status()).toMatchObject({
      appliedRevision: 1,
      conflict: true,
    });
  },
);

it("does not retarget a decision when the caller mutates its object during an await", async () => {
  const { b, page, receiver } = await fixture();
  const callerOwned = { ...receiver.conflictResolutionTarget("remote") };
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const response = await originalFetch(input, init);
    callerOwned.choice = "local";
    callerOwned.operationId = "different-operation";
    callerOwned.remoteRevision = 999;
    return response;
  });
  await receiver.resolveConflictTarget(callerOwned);
  expect(b.store.get(page.id).title).toBe("remote");
  expect(receiver.status()).toMatchObject({
    appliedRevision: 2,
    conflict: false,
  });
});

it("keeps a new saved edit and both candidates when it arrives during catchup", async () => {
  const { b, receiver } = await fixture();
  const target = receiver.conflictResolutionTarget("remote");
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const response = await originalFetch(input, init);
    if (String(input).includes("/changes?"))
      b.store.create(null, "page", "catchup input");
    return response;
  });
  await expect(receiver.resolveConflictTarget(target)).rejects.toThrow(
    "conflict-selection-stale",
  );
  expect(b.store.pages().some((page) => page.title === "catchup input")).toBe(
    true,
  );
  expect(receiver.conflictArchives().total).toBe(0);
  expect(receiver.status()).toMatchObject({
    appliedRevision: 1,
    receivedCursor: 2,
    conflict: true,
  });
});

it("rechecks the remote head after transfer and preserves the original decision on a late advance", async () => {
  const { a, b, page, publisher, receiver } = await fixture();
  const target = receiver.conflictResolutionTarget("remote");
  const before = decisionState(b.store);
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input).includes("/changes?")) {
      a.store.update(page.id, a.store.get(page.id).revision, {
        title: "head advanced during catchup",
      });
      await publisher.sendPending();
    }
    return originalFetch(input, init);
  });
  await expect(receiver.resolveConflictTarget(target)).rejects.toThrow(
    "conflict-head-changed",
  );
  expect(decisionState(b.store)).toEqual(before);
  expect(receiver.status()).toMatchObject({
    appliedRevision: 1,
    conflict: true,
  });
});

it.each(["backup", "archive-admission"] as const)(
  "protects recovery-only input dirtied during %s",
  async (boundary) => {
    const { b, receiver, setAllowed, setAdmission } = await fixture();
    // Pre-stage so all content admissions below belong to applying/archiving.
    await receiver.receiveAndStage();
    const target = receiver.conflictResolutionTarget("remote");
    const before = decisionState(b.store);
    let contentChecks = 0;
    setAdmission((_bytes, purpose) => {
      if (purpose === "content") contentChecks++;
      if (
        (boundary === "backup" && purpose === "backup") ||
        (boundary === "archive-admission" &&
          purpose === "content" &&
          contentChecks === 2)
      )
        setAllowed(false);
    });
    await expect(receiver.resolveConflictTarget(target)).rejects.toThrow(
      "edit-session-busy",
    );
    expect(decisionState(b.store)).toEqual(before);
    expect(receiver.status().conflict).toBe(true);
  },
);

it("does not enqueue a local decision if recovery-only input dirties during archive admission", async () => {
  const { b, receiver, setAllowed, setAdmission } = await fixture();
  const target = receiver.conflictResolutionTarget("local");
  const before = decisionState(b.store);
  setAdmission((_bytes, purpose) => {
    if (purpose === "content") setAllowed(false);
  });
  await expect(receiver.resolveConflictTarget(target)).rejects.toThrow(
    "edit-session-busy",
  );
  expect(decisionState(b.store)).toEqual(before);
});

it("recovers a local choice after lost ACK on reopen without repeating the decision or losing later input", async () => {
  const { b, receiver } = await fixture();
  const target = receiver.conflictResolutionTarget("local");
  const originalFetch = globalThis.fetch;
  let commits = 0;
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const response = await originalFetch(input, init);
      if (String(input).endsWith("/commits") && init?.method === "POST") {
        commits++;
        await response.arrayBuffer(); // The real loopback server already committed.
        throw new Error("lost decision ACK");
      }
      return response;
    });
  await expect(receiver.resolveConflictTarget(target)).rejects.toThrow(
    "lost decision ACK",
  );
  expect(receiver.status()).toMatchObject({ conflict: false, pending: true });
  const pending = b.store.db
    .prepare(
      "SELECT commit_json FROM workspace_sync_outbox WHERE result_json IS NULL",
    )
    .get()!;
  const operation = JSON.parse(String(pending.commit_json)) as Commit;
  expect(operation.checkpointHash).toBe(target.latestCheckpointHash);
  const afterAck = b.store.create(null, "page", "saved after ACK loss");
  fetchSpy.mockRestore();
  b.store.close();
  stores.splice(stores.indexOf(b.store), 1);
  const reopenedStore = new Store(b.store.path);
  stores.push(reopenedStore);
  const reopened = await openWorkspaceSync({ ...b, store: reopenedStore });
  await expect(reopened.resolveConflictTarget(target)).rejects.toThrow(
    "sync-conflict-not-found",
  );
  await reopened.sendPending(); // Existing operation receipt, not a new choice.
  expect(reopened.conflictArchives().total).toBe(3);
  expect(reopened.status()).toMatchObject({ conflict: false, pending: true }); // newer saved edit is still unsent
  expect(reopenedStore.get(afterAck.id).title).toBe("saved after ACK loss");
  expect(
    reopenedStore.db
      .prepare(
        "SELECT result_json FROM workspace_sync_outbox WHERE operation_id=?",
      )
      .get(operation.operationId)!.result_json,
  ).not.toBeNull();
  expect(commits).toBe(1);
  const head = await originalFetch(
    `${b.baseUrl}/v1/workspaces/${b.workspaceId}/head`,
    { headers: { Authorization: `Bearer ${b.token}` } },
  ).then((response) => response.json());
  expect(head.head.revision).toBe(3);
});

function decisionFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  readOnly = false,
  disconnected = false,
) {
  let closed = false,
    idle = true,
    otherClear = true;
  let recovery: CrashRecoveryRead = { status: "empty", generation: 0 };
  let admission: (() => void) | undefined;
  const source = {
    preview: (choice: "local" | "remote") =>
      f.receiver.conflictResolutionPreview(choice),
    assertTarget: (
      target: Parameters<typeof f.receiver.assertConflictResolutionTarget>[0],
    ) => f.receiver.assertConflictResolutionTarget(target),
    hasConflict: () => f.receiver.status().conflict,
    idle: () => idle,
    recovery: () => recovery,
    windowsClosed: () => closed,
    normalIntentClear: () => otherClear,
  };
  const control = new WorkspaceConflictDecisionControl(
    f.b.store,
    disconnected ? undefined : source,
    readOnly,
    () => admission?.(),
  );
  const preview = (choice: "local" | "remote") => {
    const inspection = f.receiver.conflictInspection()!;
    return control.preview({
      choice,
      operationId: inspection.operationId,
      expectedLocalHash: inspection.local.checkpointHash,
      expectedRemoteRevision: inspection.remote.revision,
      expectedRemoteHash: inspection.remote.checkpointHash,
    });
  };
  return {
    control,
    source,
    preview,
    closeWindows: () => {
      closed = true;
    },
    setIdle: (value: boolean) => {
      idle = value;
    },
    setOtherClear: (value: boolean) => {
      otherClear = value;
    },
    setRecovery: (value: CrashRecoveryRead) => {
      recovery = value;
    },
    setAdmission: (value: () => void) => {
      admission = value;
    },
  };
}

function syncEnvironment(
  f: Awaited<ReturnType<typeof fixture>>,
): NodeJS.ProcessEnv {
  const { b } = f;
  return {
    FOLIO_SYNC_ENABLED: "1",
    FOLIO_DATA_DIR: dirname(b.store.path),
    FOLIO_SYNC_URL: b.baseUrl,
    FOLIO_SYNC_WORKSPACE: b.workspaceId,
    FOLIO_SYNC_CLIENT: b.clientId,
    FOLIO_SYNC_BINDING: b.bindingId,
    FOLIO_SYNC_TOKEN: b.token,
  };
}
function reopen(store: Store) {
  store.close();
  stores.splice(stores.indexOf(store), 1);
  const opened = new Store(store.path);
  stores.push(opened);
  return opened;
}

it.each(["local", "remote"] as const)(
  "connects %s preview, normal quit, reopen and exactly one windowless decision",
  async (choice) => {
    const f = await fixture(),
      d = decisionFixture(f);
    const latest = f.b.store.create(null, "page", "saved after conflict");
    const before = decisionState(f.b.store);
    const preview = d.preview(choice);
    expect(preview.target.latestCheckpointHash).not.toBe(
      preview.target.localCheckpointHash,
    );
    expect(preview.latestCheckpointJson).toContain("saved after conflict");
    expect(d.control.confirm(preview.id).result).toBe("requested");
    expect(d.control.confirm(preview.id).result).toBe("requested");
    expect(decisionState(f.b.store)).toEqual(before);
    expect(readConflictDecision(f.b.store.db)).toEqual({ status: "empty" });
    const closeStore = vi.fn();
    expect(
      finishWorkspaceQuit({
        commitRestart: () => d.control.commitAfterWindowsClosed(),
        preventQuit: vi.fn(),
        reopenWindow: vi.fn(),
        closeStore,
      }),
    ).toBe("held");
    expect(closeStore).not.toHaveBeenCalled();
    d.closeWindows();
    expect(
      finishWorkspaceQuit({
        commitRestart: () => d.control.commitAfterWindowsClosed(),
        preventQuit: vi.fn(),
        reopenWindow: vi.fn(),
        closeStore,
      }),
    ).toBe("quit");
    expect(readConflictDecision(f.b.store.db)).toMatchObject({
      status: "ready",
      record: { id: preview.id, state: "pending" },
    });
    const store = reopen(f.b.store);
    const result = await runStartupWorkspaceSyncDetailed(
      store,
      () => ({ status: "empty", generation: 0 }),
      syncEnvironment(f),
    );
    expect(result.message).toContain(
      choice === "local" ? "ローカル内容を選択済み" : "リモート版を適用済み",
    );
    expect(store.get(f.page.id).title).toBe(choice);
    if (choice === "local")
      expect(store.get(latest.id).title).toBe("saved after conflict");
    else expect(() => store.get(latest.id)).toThrow();
    const read = readConflictDecision(store.db);
    expect(read).toMatchObject({
      status: "ready",
      record: { id: preview.id, state: "consumed" },
    });
    if (read.status === "ready")
      expect(consumedDecisionMatches(store.db, read.record)).toBe(true);
    const archives = store.db
      .prepare("SELECT * FROM workspace_sync_archives ORDER BY id")
      .all();
    expect(archives).toHaveLength(3);
    const afterChoice = readConflictDecision(store.db);
    const again = await runStartupWorkspaceSyncDetailed(
      store,
      () => ({ status: "empty", generation: 0 }),
      syncEnvironment(f),
    );
    expect(again.opened).toBeDefined();
    expect(readConflictDecision(store.db)).toEqual(afterChoice);
    expect(
      store.db
        .prepare("SELECT * FROM workspace_sync_archives ORDER BY id")
        .all(),
    ).toEqual(archives);
  },
);

it("cancels a memory-only request and rejects a delayed old confirmation", async () => {
  const f = await fixture(),
    d = decisionFixture(f);
  const preview = d.preview("remote");
  d.control.confirm(preview.id);
  const before = decisionState(f.b.store);
  expect(d.control.cancel(preview.id).result).toBe("cancelled");
  expect(d.control.confirm(preview.id).result).toBe("blocked");
  d.closeWindows();
  expect(d.control.commitAfterWindowsClosed()).toBe("not-prepared");
  expect(readConflictDecision(f.b.store.db)).toEqual({ status: "empty" });
  expect(decisionState(f.b.store)).toEqual(before);
});

it("rejects a stale preview and holds quit after late saved content", async () => {
  const f = await fixture(),
    d = decisionFixture(f);
  const old = d.preview("remote"),
    current = d.preview("local");
  expect(d.control.confirm(old.id).result).toBe("blocked");
  d.control.confirm(current.id);
  f.b.store.create(null, "page", "retained late edit");
  const before = decisionState(f.b.store);
  d.closeWindows();
  expect(d.control.commitAfterWindowsClosed()).toBe("blocked");
  expect(readConflictDecision(f.b.store.db)).toEqual({ status: "empty" });
  expect(decisionState(f.b.store)).toEqual(before);
  expect(d.control.cancel(current.id).result).toBe("cancelled");
});

it("keeps a queued write, ordinary restart, recovery input and capacity failure out of quit publication", async () => {
  const f = await fixture(),
    d = decisionFixture(f);
  const preview = d.preview("remote");
  d.control.confirm(preview.id);
  d.closeWindows();
  d.setIdle(false);
  expect(d.control.commitAfterWindowsClosed()).toBe("blocked");
  d.setIdle(true);
  d.setOtherClear(false);
  expect(d.control.commitAfterWindowsClosed()).toBe("blocked");
  d.setOtherClear(true);
  const snapshot = emptyCrashRecoverySnapshot();
  snapshot.rawDrafts.push({
    scope: "record",
    pageId: f.page.id,
    key: "count",
    value: "1e",
  });
  d.setAdmission(() =>
    d.setRecovery({ status: "ready", generation: 1, snapshot }),
  );
  expect(d.control.commitAfterWindowsClosed()).toBe("blocked");
  expect(readConflictDecision(f.b.store.db)).toEqual({ status: "empty" });
  d.setRecovery({ status: "empty", generation: 0 });
  d.setAdmission(() => {
    throw new Error("capacity refused");
  });
  expect(d.control.commitAfterWindowsClosed()).toBe("blocked");
  expect(readConflictDecision(f.b.store.db)).toEqual({ status: "empty" });
});

it("offers durable cancellation after an offline restart without a transport", async () => {
  const f = await fixture(),
    d = decisionFixture(f);
  const preview = d.preview("remote");
  d.control.confirm(preview.id);
  d.closeWindows();
  expect(d.control.commitAfterWindowsClosed()).toBe("committed");
  for (const server of servers.splice(0)) await server.close();
  const store = reopen(f.b.store);
  const before = decisionState(store);
  const result = await runStartupWorkspaceSyncDetailed(
    store,
    () => ({ status: "empty", generation: 0 }),
    syncEnvironment(f),
  );
  expect(result.message).toContain("保留");
  expect(() => result.reconnect!()).toThrow("reconnect-held");
  const control = new WorkspaceConflictDecisionControl(store, undefined, false);
  expect(control.status()).toMatchObject({
    state: "pending",
    decisionId: preview.id,
    canCancel: true,
    canPreview: false,
  });
  expect(control.cancel(preview.id).result).toBe("cancelled");
  expect(control.cancel(preview.id).result).toBe("cancelled");
  expect(decisionState(store)).toEqual(before);
  expect(readConflictDecision(store.db)).toMatchObject({
    status: "ready",
    record: { state: "cancelled", id: preview.id },
  });
});

it("keeps pending cancellation available when reopened with synchronization disabled or unconfigured", async () => {
  const f = await fixture(),
    d = decisionFixture(f);
  const preview = d.preview("remote");
  d.control.confirm(preview.id);
  d.closeWindows();
  d.control.commitAfterWindowsClosed();
  const store = reopen(f.b.store),
    before = decisionState(store);
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  expect(
    await runStartupWorkspaceSyncDetailed(
      store,
      () => ({ status: "empty", generation: 0 }),
      {},
    ),
  ).toEqual({});
  expect(fetchSpy).not.toHaveBeenCalled();
  const control = new WorkspaceConflictDecisionControl(store, undefined, false);
  expect(control.status()).toMatchObject({
    state: "pending",
    decisionId: preview.id,
    canPreview: false,
    canCancel: true,
  });
  expect(control.cancel(preview.id).result).toBe("cancelled");
  expect(decisionState(store)).toEqual(before);
});

it.each(["recovery", "recover-mode", "normal-intent"] as const)(
  "does no startup transfer with pending decision and %s",
  async (condition) => {
    const f = await fixture(),
      d = decisionFixture(f);
    const preview = d.preview("remote");
    d.control.confirm(preview.id);
    d.closeWindows();
    d.control.commitAfterWindowsClosed();
    const env = syncEnvironment(f);
    const snapshot = emptyCrashRecoverySnapshot();
    snapshot.rawDrafts.push({
      scope: "record",
      pageId: f.page.id,
      key: "title",
      value: "unconfirmed",
    });
    if (condition === "recover-mode") env.FOLIO_SYNC_MODE = "recover";
    if (condition === "normal-intent")
      new WorkspaceSyncIntentFile(dirname(f.b.store.path)).create({
        workspaceId: preview.target.workspaceId,
        clientId: preview.target.clientId,
        bindingId: preview.target.bindingId,
        serverEpoch: preview.target.serverEpoch,
        revision: preview.target.remoteRevision,
        checkpointHash: preview.target.remoteCheckpointHash!,
      });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const before = decisionState(f.b.store);
    const result = await runStartupWorkspaceSyncDetailed(
      f.b.store,
      () =>
        condition === "recovery"
          ? { status: "ready", generation: 1, snapshot }
          : { status: "empty", generation: 0 },
      env,
    );
    expect(result.message).toContain("保留");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(decisionState(f.b.store)).toEqual(before);
    expect(readConflictDecision(f.b.store.db)).toMatchObject({
      status: "ready",
      record: { state: "pending" },
    });
  },
);

it.each(["local", "remote"] as const)(
  "rolls back %s choice and its marker when COMMIT fails before completion",
  async (choice) => {
    const f = await fixture(),
      d = decisionFixture(f);
    const preview = d.preview(choice);
    d.control.confirm(preview.id);
    d.closeWindows();
    d.control.commitAfterWindowsClosed();
    const before = decisionState(f.b.store);
    const originalExec = f.b.store.db.exec.bind(f.b.store.db);
    vi.spyOn(f.b.store.db, "exec").mockImplementation((sql) => {
      const read = readConflictDecision(f.b.store.db);
      if (
        sql === "COMMIT" &&
        read.status === "ready" &&
        read.record.state === "consumed"
      )
        throw new Error("decision COMMIT failed");
      return originalExec(sql);
    });
    const result = await runStartupWorkspaceSyncDetailed(
      f.b.store,
      () => ({ status: "empty", generation: 0 }),
      syncEnvironment(f),
    );
    expect(result.message).toContain("保留");
    expect(decisionState(f.b.store)).toEqual(before);
    expect(readConflictDecision(f.b.store.db)).toMatchObject({
      status: "ready",
      record: { state: "pending" },
    });
  },
);

it.each(["local", "remote"] as const)(
  "recognizes consumed %s choice after lost COMMIT acknowledgement without replay",
  async (choice) => {
    const f = await fixture(),
      d = decisionFixture(f);
    f.b.store.create(null, "page", "preserve latest around uncertain COMMIT");
    const preview = d.preview(choice);
    d.control.confirm(preview.id);
    d.closeWindows();
    d.control.commitAfterWindowsClosed();
    const originalExec = f.b.store.db.exec.bind(f.b.store.db);
    const spy = vi.spyOn(f.b.store.db, "exec").mockImplementation((sql) => {
      const read = readConflictDecision(f.b.store.db);
      const result = originalExec(sql);
      if (
        sql === "COMMIT" &&
        read.status === "ready" &&
        read.record.state === "consumed"
      )
        throw new Error("decision COMMIT ACK lost");
      return result;
    });
    const result = await runStartupWorkspaceSyncDetailed(
      f.b.store,
      () => ({ status: "empty", generation: 0 }),
      syncEnvironment(f),
    );
    expect(result.message).toContain("選択は記録済み");
    expect(readConflictDecision(f.b.store.db)).toMatchObject({
      status: "ready",
      record: { state: "consumed" },
    });
    spy.mockRestore();
    const store = reopen(f.b.store);
    await runStartupWorkspaceSyncDetailed(
      store,
      () => ({ status: "empty", generation: 0 }),
      syncEnvironment(f),
    );
    expect(
      store.db
        .prepare("SELECT count(*) AS n FROM workspace_sync_archives")
        .get()!.n,
    ).toBe(3);
    expect(store.get(f.page.id).title).toBe(choice);
  },
);

it("stops a pending decision cancelled while its startup head request yields", async () => {
  const f = await fixture(),
    d = decisionFixture(f);
  const preview = d.preview("remote");
  d.control.confirm(preview.id);
  d.closeWindows();
  d.control.commitAfterWindowsClosed();
  const before = decisionState(f.b.store);
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const response = await originalFetch(input, init);
    if (!cancelled && String(input).endsWith("/head")) {
      cancelled = true;
      f.b.store.transaction(() =>
        cancelConflictDecision(f.b.store.db, preview.id),
      );
    }
    return response;
  });
  const result = await runStartupWorkspaceSyncDetailed(
    f.b.store,
    () => ({ status: "empty", generation: 0 }),
    syncEnvironment(f),
  );
  expect(result.message).toContain("保留");
  expect(decisionState(f.b.store)).toEqual(before);
  expect(readConflictDecision(f.b.store.db)).toMatchObject({
    status: "ready",
    record: { state: "cancelled" },
  });
});

it("can cancel a published pending record after quit publication ACK is lost", async () => {
  const f = await fixture(),
    d = decisionFixture(f);
  const preview = d.preview("remote");
  d.control.confirm(preview.id);
  d.closeWindows();
  const originalExec = f.b.store.db.exec.bind(f.b.store.db);
  const spy = vi.spyOn(f.b.store.db, "exec").mockImplementation((sql) => {
    const result = originalExec(sql);
    if (sql === "COMMIT") throw new Error("publication ACK lost");
    return result;
  });
  expect(d.control.commitAfterWindowsClosed()).toBe("blocked");
  spy.mockRestore();
  expect(readConflictDecision(f.b.store.db)).toMatchObject({
    status: "ready",
    record: { state: "pending" },
  });
  expect(d.control.cancel(preview.id).result).toBe("cancelled");
  expect(readConflictDecision(f.b.store.db)).toMatchObject({
    status: "ready",
    record: { state: "cancelled" },
  });
});

it("rejects corrupt/noncanonical journal records and arbitrary renderer consent payloads", async () => {
  const f = await fixture(),
    d = decisionFixture(f);
  const preview = d.preview("remote");
  d.control.confirm(preview.id);
  d.closeWindows();
  d.control.commitAfterWindowsClosed();
  const read = readConflictDecision(f.b.store.db);
  if (read.status !== "ready") throw new Error("expected journal");
  f.b.store.db
    .prepare("UPDATE settings SET value=? WHERE key=?")
    .run(" " + read.raw, CONFLICT_DECISION_KEY);
  expect(readConflictDecision(f.b.store.db)).toEqual({ status: "blocked" });
  const before = decisionState(f.b.store),
    spy = vi.spyOn(globalThis, "fetch");
  expect(
    (
      await runStartupWorkspaceSyncDetailed(
        f.b.store,
        () => ({ status: "empty", generation: 0 }),
        syncEnvironment(f),
      )
    ).message,
  ).toContain("保留");
  expect(spy).not.toHaveBeenCalled();
  expect(decisionState(f.b.store)).toEqual(before);
  expect(
    requestSchema.safeParse({
      type: "setting",
      key: CONFLICT_DECISION_KEY,
      value: read.raw,
    }).success,
  ).toBe(false);
  expect(
    requestSchema.safeParse({
      type: "sync:conflictConfirm",
      previewId: preview.id,
      target: preview.target,
    }).success,
  ).toBe(false);
});

it("does not let read-only cancellation or stale IDs change the next reservation", async () => {
  const f = await fixture(),
    d = decisionFixture(f);
  const first = d.preview("remote");
  d.control.confirm(first.id);
  d.closeWindows();
  d.control.commitAfterWindowsClosed();
  const readonly = new WorkspaceConflictDecisionControl(
    f.b.store,
    undefined,
    true,
  );
  expect(readonly.status().canCancel).toBe(false);
  expect(readonly.cancel(first.id).result).toBe("blocked");
  const resumed = new WorkspaceConflictDecisionControl(
    f.b.store,
    d.source,
    false,
  );
  resumed.cancel(first.id);
  // A new process/window selects a new opaque ID; an old cancel cannot match.
  const second = { ...first, id: randomUUID() };
  f.b.store.transaction(() =>
    reserveConflictDecision(f.b.store.db, second.id, second.target),
  );
  const before = readConflictDecision(f.b.store.db);
  expect(resumed.cancel(first.id).result).toBe("blocked");
  expect(readConflictDecision(f.b.store.db)).toEqual(before);
});

it("keeps the consumed decision and resumes the same outbox operation after a lost network ACK", async () => {
  const f = await fixture(),
    d = decisionFixture(f);
  const preview = d.preview("local");
  d.control.confirm(preview.id);
  d.closeWindows();
  d.control.commitAfterWindowsClosed();
  const originalFetch = globalThis.fetch;
  let commits = 0;
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const response = await originalFetch(input, init);
      if (String(input).endsWith("/commits") && init?.method === "POST") {
        commits++;
        await response.arrayBuffer();
        throw new Error("network ACK lost after server commit");
      }
      return response;
    });
  const result = await runStartupWorkspaceSyncDetailed(
    f.b.store,
    () => ({ status: "empty", generation: 0 }),
    syncEnvironment(f),
  );
  expect(result.message).toContain("選択は記録済み");
  const read = readConflictDecision(f.b.store.db);
  expect(read).toMatchObject({
    status: "ready",
    record: { state: "consumed", result: { choice: "local" } },
  });
  spy.mockRestore();
  const store = reopen(f.b.store);
  await runStartupWorkspaceSyncDetailed(
    store,
    () => ({ status: "empty", generation: 0 }),
    syncEnvironment(f),
  );
  expect(commits).toBe(1);
  expect(
    store.db.prepare("SELECT count(*) AS n FROM workspace_sync_archives").get()!
      .n,
  ).toBe(3);
  expect(
    store.db
      .prepare(
        "SELECT count(*) AS n FROM workspace_sync_outbox WHERE result_json IS NULL",
      )
      .get()!.n,
  ).toBe(0);
  expect(readConflictDecision(store.db)).toEqual(read);
  const head = await originalFetch(
    `${f.b.baseUrl}/v1/workspaces/${f.b.workspaceId}/head`,
    { headers: { Authorization: `Bearer ${f.b.token}` } },
  ).then((response) => response.json());
  expect(head.head.revision).toBe(3);
});

it("holds a durable selection if the server head changed after confirmation", async () => {
  const f = await fixture(),
    d = decisionFixture(f);
  const preview = d.preview("remote");
  d.control.confirm(preview.id);
  d.closeWindows();
  d.control.commitAfterWindowsClosed();
  f.a.store.update(f.page.id, f.a.store.get(f.page.id).revision, {
    title: "later remote head",
  });
  await f.publisher.sendPending();
  const before = decisionState(f.b.store);
  expect(
    (
      await runStartupWorkspaceSyncDetailed(
        f.b.store,
        () => ({ status: "empty", generation: 0 }),
        syncEnvironment(f),
      )
    ).message,
  ).toContain("保留");
  expect(decisionState(f.b.store)).toEqual(before);
  expect(readConflictDecision(f.b.store.db)).toMatchObject({
    status: "ready",
    record: { state: "pending" },
  });
});
