import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { Store } from "../src/persistence/store";
import {
  CrashRecoveryFile,
  crashRecoveryWorkspaceId,
} from "../src/persistence/crash-recovery-file";
import { WorkspaceStoragePressure } from "../src/main/storage-pressure";
import {
  assertRequestStorage,
  storageActionForRequest,
} from "../src/main/storage-write-policy";
import {
  DEFAULT_STORAGE_RESERVE_BYTES,
  type StoragePressureSnapshot,
} from "../src/shared/storage-pressure";
import { PageOperationCoordinator } from "../src/renderer/page-operation-coordinator";
import { retryUnconfirmedPageOperations } from "../src/renderer/page-operation-recovery";
import { RecoveryCheckpoint } from "../src/renderer/recovery-checkpoint";
import type { SaveTransport } from "../src/renderer/reliable-save";
import { emptyCrashRecoverySnapshot } from "../src/shared/crash-recovery";
import { preparePageCreation } from "../src/shared/page-operation";
import type { Doc, Page, Request, Snapshot } from "../src/shared/types";

/**
 * Round 3 C: independent acceptance test for the storage-pressure guard.
 *
 * The A/B modules are contract-only imports. This test must be run after Codex
 * integrates them. It uses a real Store, the real renderer
 * PageOperationCoordinator/RecoveryCheckpoint and a temporary
 * CrashRecoveryFile. Disk capacity is injected through the documented probe;
 * no real disk is filled.
 *
 * The local dispatch below mirrors "assertRequestStorage before store.handle".
 * It does NOT import or exercise src/main/index.ts, IPC, preload, renderer UI
 * or WorkspaceBackupService wiring. Those remain Codex integration checks.
 */
const BLOCK = 4096n;
const RESERVE = 1_000_000;
const NOW = () => new Date("2026-11-05T00:00:00.000Z");
const doc = (text: string): Doc => ({
  type: "doc",
  schemaVersion: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

/** Request plus the Codex-owned storage:pressure IPC variant. */
type GuardedRequest = Request | { type: "storage:pressure" };

function fixture() {
  const root = mkdtempSync(resolve("output/dsh-r3-acceptance-"));
  const store = new Store(join(root, "workspace.sqlite"));
  return {
    root,
    store,
    receipts: () =>
      (
        store.db
          .prepare("SELECT COUNT(*) AS count FROM save_receipts")
          .get() as { count: number }
      ).count,
    receiptRaw: (operationId: string) =>
      (
        store.db
          .prepare(
            "SELECT result_json FROM save_receipts WHERE operation_id=?",
          )
          .get(operationId) as { result_json: string } | undefined
      )?.result_json,
    dispose() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function pressureFor(root: string, blocks: () => bigint) {
  return new WorkspaceStoragePressure(root, {
    reserveBytes: RESERVE,
    probe: () => ({ bsize: BLOCK, bavail: blocks() }),
    now: NOW,
  });
}

function makeDispatch(
  store: Store,
  pressure: WorkspaceStoragePressure,
  crash: CrashRecoveryFile,
) {
  return (request: GuardedRequest): unknown => {
    // Test-local guard placement. The production main handler must make the
    // same call before any Store mutation; this test does not prove it does.
    assertRequestStorage(request as Request, pressure);
    if (request.type === "storage:pressure") return pressure.inspect();
    if (request.type === "recovery:read") return crash.read();
    if (request.type === "recovery:write")
      return crash.write(request.expectedGeneration, request.snapshot);
    return store.handle(request as Request);
  };
}

it("blocks a Page commit before SQLite under pressure while retaining input, reads and checkpoint rescue", async () => {
  const f = fixture();
  try {
    const baseline = f.store.create(null, "page", "既存の読み取り対象");
    let blocks = 2n;
    const pressure = pressureFor(f.root, () => blocks);
    const crash = new CrashRecoveryFile(
      join(f.root, "crash-recovery.json"),
      crashRecoveryWorkspaceId(f.store),
    );
    const dispatch = makeDispatch(f.store, pressure, crash);
    const send: SaveTransport = async (request) => dispatch(request);
    let coordinator!: PageOperationCoordinator;
    const checkpoint = new RecoveryCheckpoint(
      async (request) => dispatch(request),
      0,
    );
    coordinator = new PageOperationCoordinator(send, {
      persist: async () => {
        checkpoint.offer({
          ...emptyCrashRecoverySnapshot(),
          pageOperations: coordinator.unresolvedOperations(),
        });
        await checkpoint.flush();
      },
    });

    expect(pressure.inspect()).toMatchObject({
      state: "blocked",
      availableBytes: 8192,
      reserveBytes: RESERVE,
    });
    expect(() => pressure.assertWritable()).toThrow(/capacity-exceeded/);

    const handle = vi.spyOn(f.store, "handle");
    await expect(
      coordinator.create(null, "容量不足の作成", doc("保持する入力")),
    ).rejects.toThrow(/capacity-exceeded/);
    expect(handle).not.toHaveBeenCalled();
    handle.mockRestore();

    expect(
      f.store.pages().filter((page) => page.title === "容量不足の作成"),
    ).toHaveLength(0);
    expect(f.store.pages().map((page) => page.title)).toEqual([
      "既存の読み取り対象",
    ]);
    expect(f.receipts()).toBe(0);

    const entry = coordinator.firstUnknown();
    expect(entry?.state).toBe("unknown");
    expect(entry?.message).toMatch(/不明/);
    expect(entry?.message).toMatch(/保持/);
    expect(coordinator.firstRejected()).toBeUndefined();
    expect(coordinator.unresolvedOperations()).toHaveLength(1);
    const retained = coordinator.unresolvedOperations()[0];
    expect(retained.command.kind).toBe("createPage");
    if (retained.command.kind === "createPage")
      expect(retained.command.doc).toEqual(doc("保持する入力"));

    const saved = crash.read();
    expect(saved).toMatchObject({ status: "ready", generation: 1 });
    expect(
      saved.snapshot?.pageOperations?.map(
        (operation) => operation.operationId,
      ),
    ).toEqual([retained.operationId]);
    const savedOperation = saved.snapshot?.pageOperations?.[0];
    if (savedOperation && savedOperation.command.kind === "createPage")
      expect(savedOperation.command.doc).toEqual(doc("保持する入力"));

    expect(
      (dispatch({ type: "load" }) as Snapshot).pages.map(
        (page) => page.id,
      ),
    ).toContain(baseline.id);
    expect(
      (dispatch({ type: "search", query: "既存" }) as Page[]).map(
        (page) => page.id,
      ),
    ).toEqual([baseline.id]);
    expect(dispatch({ type: "versions", id: baseline.id })).toEqual([]);
    expect(
      JSON.parse(dispatch({ type: "pageSource", id: baseline.id }) as string)
        .title,
    ).toBe("既存の読み取り対象");
    expect(dispatch({ type: "recovery:read" })).toMatchObject({
      status: "ready",
      generation: 1,
    });
    expect(dispatch({ type: "storage:pressure" })).toMatchObject({
      state: "blocked",
    });
    expect(
      dispatch({ type: "page:resolve", operation: retained }),
    ).toMatchObject({ status: "unknown" });
    expect(coordinator.firstUnknown()?.operation.operationId).toBe(
      retained.operationId,
    );
    expect(coordinator.firstRejected()).toBeUndefined();
    expect(f.receipts()).toBe(0);
  } finally {
    f.dispose();
  }
});

it("retries the same retained operation once after space recovers and preserves existing receipts", async () => {
  const f = fixture();
  try {
    const existing = preparePageCreation("既存の確定ページ", null);
    expect(f.store.commitPageOperation(existing)).toMatchObject({
      status: "applied",
    });
    const existingRaw = f.receiptRaw(existing.operationId);
    expect(existingRaw).toBeTruthy();
    expect(f.receipts()).toBe(1);

    let blocks = 2n;
    const pressure = pressureFor(f.root, () => blocks);
    const crash = new CrashRecoveryFile(
      join(f.root, "crash-recovery.json"),
      crashRecoveryWorkspaceId(f.store),
    );
    const dispatch = makeDispatch(f.store, pressure, crash);
    const send: SaveTransport = async (request) => dispatch(request);
    let coordinator!: PageOperationCoordinator;
    const checkpoint = new RecoveryCheckpoint(
      async (request) => dispatch(request),
      0,
    );
    coordinator = new PageOperationCoordinator(send, {
      persist: async () => {
        checkpoint.offer({
          ...emptyCrashRecoverySnapshot(),
          pageOperations: coordinator.unresolvedOperations(),
        });
        await checkpoint.flush();
      },
    });

    const handle = vi.spyOn(f.store, "handle");
    await expect(
      coordinator.create(null, "空き回復後の作成", doc("再試行でも同じ入力")),
    ).rejects.toThrow(/capacity-exceeded/);
    expect(handle).not.toHaveBeenCalled();
    handle.mockRestore();
    const retained = coordinator.unresolvedOperations()[0];
    expect(f.store.pages()).toHaveLength(1);
    expect(f.receipts()).toBe(1);
    expect(f.receiptRaw(existing.operationId)).toBe(existingRaw);

    expect(await coordinator.resolveNext()).toMatchObject({
      status: "unknown",
    });
    expect(coordinator.firstUnknown()?.operation.operationId).toBe(
      retained.operationId,
    );
    expect(coordinator.firstRejected()).toBeUndefined();
    expect(f.store.pages()).toHaveLength(1);
    expect(f.receipts()).toBe(1);

    blocks = 10_000n;
    expect(pressure.inspect().state).toBe("ready");
    const saved = crash.read();
    expect(saved).toMatchObject({ status: "ready", generation: 1 });
    const snapshot = saved.snapshot!;
    const report = await retryUnconfirmedPageOperations(snapshot, send);
    expect(report).toEqual({
      resolvedApplied: 0,
      committed: 1,
      retainedUnknown: 0,
      rejected: 0,
    });

    const pages = f.store.pages();
    expect(pages).toHaveLength(2);
    const created = pages.find((page) => page.title === "空き回復後の作成");
    expect(created).toBeDefined();
    expect(created?.parentId).toBeNull();
    if (retained.command.kind === "createPage")
      expect(created?.doc).toEqual(retained.command.doc);
    expect(f.receipts()).toBe(2);
    const createdRaw = f.receiptRaw(retained.operationId);
    expect(createdRaw).toBeTruthy();
    const createdReceipt = JSON.parse(createdRaw!);
    expect(createdReceipt).toMatchObject({
      status: "applied",
      operationId: retained.operationId,
      page: { id: created!.id },
    });
    expect(f.receiptRaw(existing.operationId)).toBe(existingRaw);

    const again = await retryUnconfirmedPageOperations(snapshot, send);
    expect(again).toEqual({
      resolvedApplied: 1,
      committed: 0,
      retainedUnknown: 0,
      rejected: 0,
    });
    expect(f.store.pages()).toHaveLength(2);
    expect(f.receipts()).toBe(2);
    expect(f.receiptRaw(retained.operationId)).toBe(createdRaw);
    expect(f.receiptRaw(existing.operationId)).toBe(existingRaw);
    expect(f.store.commitPageOperation(retained)).toMatchObject({
      status: "applied",
      operationId: retained.operationId,
    });
    expect(f.store.pages()).toHaveLength(2);
  } finally {
    f.dispose();
  }
});

it("classifies every request and enforces the read/checkpoint/write guard before Store writes", () => {
  const expected: Record<
    Request["type"] | "storage:pressure",
    "read" | "checkpoint" | "write" | "maintenance"
  > = {
    "recovery:read": "read",
    "recovery:write": "checkpoint",
    "recovery:copy": "write",
    "migration:preview": "read",
    "pageOrder:preview": "read",
    "pageOrder:apply": "write",
    "migration:commit": "write",
    "migration:resolve": "read",
    "property:preview": "read",
    "property:commit": "write",
    "property:resolve": "read",
    "database:commit": "write",
    "database:resolve": "read",
    "page:commit": "write",
    "page:resolve": "read",
    "database:read": "read",
    "save:commit": "write",
    "save:resolve": "read",
    "load": "read",
    "record:get": "read",
    "record:read": "read",
    "record:pageUpdate": "write",
    "database:load": "read",
    "database:settings": "write",
    "record:create": "write",
    "record:trash": "write",
    "record:restore": "write",
    "record:duplicate": "write",
    "record:patch": "write",
    "create": "write",
    "update": "write",
    "move": "write",
    "duplicate": "write",
    "trash": "write",
    "restore": "write",
    "setting": "write",
    "search": "read",
    "versions": "read",
    "pageSource": "read",
    "recover": "write",
    "exportRecovery": "read",
    "exportPendingJournal": "read",
    "restoreVersion": "write",
    "backup": "write",
    "workspaceBackup:create": "write",
    "workspaceBackup:choose": "read",
    "workspaceBackup:restore": "read",
    "workspaceBackup:open": "read",
    "attach": "write",
    "downloadAttachment": "read",
    "openExternal": "read",
    "export": "read",
    "import": "read",
    "startup:status": "read",
    "sync:status": "read",
    "sync:run": "write",
    "sync:restartStatus": "read",
    "sync:restartRequest": "checkpoint",
    "sync:restartCancel": "checkpoint",
    "sync:conflict": "read",
    "sync:conflictDecisionStatus": "read",
    "sync:conflictPreview": "checkpoint",
    "sync:conflictConfirm": "checkpoint",
    "sync:conflictCancel": "checkpoint",
    "sync:conflictCandidate": "read",
    "sync:conflictExport": "read",
  "storage:pressure": "read",
    "storage:readLimits": "read",
    "storage:applyLimits": "write",
    "storage:overview": "read",
    "storage:archivePlan": "read",
    "storage:archiveMove": "maintenance",
    "storage:orphanPlan": "read",
    "storage:orphanMove": "maintenance",
    "storage:rawSalvage": "read",
    "workspaceBackup:release": "read",
  };
  for (const type of Object.keys(expected) as (Request["type"] | "storage:pressure")[])
    expect(storageActionForRequest(type), type).toBe(expected[type]);

  // An unknown type must fail closed, not silently become a read or checkpoint.
  const unknownAction = (() => {
    try {
      return storageActionForRequest("future:unknown" as never);
    } catch {
      return "throw";
    }
  })();
  expect(["write", "throw"]).toContain(unknownAction);

  const f = fixture();
  try {
    const baseline = f.store.create(null, "page", "読み取り対象");
    let blocks = 2n;
    const pressure = pressureFor(f.root, () => blocks);
    const crash = new CrashRecoveryFile(
      join(f.root, "crash-recovery.json"),
      crashRecoveryWorkspaceId(f.store),
    );
    const dispatch = makeDispatch(f.store, pressure, crash);
    const readOperation = preparePageCreation("読み取りだけ", null);
    const reads: GuardedRequest[] = [
      { type: "load" },
      { type: "search", query: "読み取り" },
      { type: "versions", id: baseline.id },
      { type: "pageSource", id: baseline.id },
      { type: "page:resolve", operation: readOperation },
      { type: "recovery:read" },
      { type: "storage:pressure" },
    ];
    for (const request of reads)
      expect(() => dispatch(request), request.type).not.toThrow();
    expect(f.store.pages()).toHaveLength(1);
    expect(f.receipts()).toBe(0);

    const handle = vi.spyOn(f.store, "handle");
    expect(() =>
      dispatch({
        type: "create",
        parentId: null,
        kind: "page",
        title: "容量不足で拒否",
      }),
    ).toThrow(/capacity-exceeded/);
    expect(() =>
      dispatch({
        type: "page:commit",
        operation: preparePageCreation("容量不足で拒否2", null),
      }),
    ).toThrow(/capacity-exceeded/);
    expect(() =>
      dispatch({
        type: "recovery:copy",
        recoveryId: "checkpoint:1",
        input: { title: "容量不足の救出コピー", payload: {} },
      }),
    ).toThrow(/capacity-exceeded/);
    expect(handle).not.toHaveBeenCalled();
    handle.mockRestore();
    expect(f.store.pages()).toHaveLength(1);
    expect(f.receipts()).toBe(0);

    const snapshot = emptyCrashRecoverySnapshot();
    expect(
      dispatch({
        type: "recovery:write",
        expectedGeneration: 0,
        snapshot,
      }),
    ).toMatchObject({ status: "ready", generation: 1 });
    expect(dispatch({ type: "recovery:read" })).toMatchObject({
      status: "ready",
      generation: 1,
    });
    expect(f.store.pages()).toHaveLength(1);

    const calls: string[] = [];
    const guard = {
      assertWritable: () => {
        calls.push("write");
        throw new Error("capacity-exceeded guard");
      },
    };
    const readRequest: Request = { type: "load" };
    const before = structuredClone(readRequest);
    expect(() => assertRequestStorage(readRequest, guard)).not.toThrow();
    expect(readRequest).toEqual(before);
    expect(() =>
      assertRequestStorage(
        { type: "recovery:write", expectedGeneration: 1, snapshot },
        guard,
      ),
    ).not.toThrow();
    expect(calls).toEqual([]);
    expect(() =>
      assertRequestStorage(
        {
          type: "page:commit",
          operation: preparePageCreation("guard", null),
        },
        guard,
      ),
    ).toThrow(/capacity-exceeded/);
    expect(calls).toEqual(["write"]);
    expect(() =>
      assertRequestStorage(
        { type: "future:unknown" } as unknown as Request,
        guard,
      ),
    ).toThrow();
  } finally {
    f.dispose();
  }
});

it("fails closed when free space is unknown or overflows and rejects invalid options", () => {
  const root = mkdtempSync(resolve("output/dsh-r3-unknown-"));
  try {
    expect(DEFAULT_STORAGE_RESERVE_BYTES).toBe(256 * 1024 * 1024);
    const failing = new WorkspaceStoragePressure(root, {
      probe: () => {
        throw new Error("statfs unavailable");
      },
    });
    const unknownSnapshot: StoragePressureSnapshot = failing.inspect(4096);
    expect(unknownSnapshot).toMatchObject({
      state: "unknown",
      availableBytes: null,
      additionalBytes: 4096,
    });
    if (unknownSnapshot.reason !== undefined)
      expect(typeof unknownSnapshot.reason).toBe("string");
    expect(() => failing.assertWritable(4096)).toThrow(/capacity-unknown/);
    expect(() => failing.assertWritable(4096)).toThrow(/入力/);
    expect(() => failing.assertWritable(4096)).toThrow(/保存/);

    const overflow = new WorkspaceStoragePressure(root, {
      probe: () => ({ bsize: 2n ** 62n, bavail: 4n }),
    });
    expect(overflow.inspect().state).toBe("unknown");
    expect(() => overflow.assertWritable()).toThrow(/capacity-unknown/);

    expect(
      () => new WorkspaceStoragePressure(root, { reserveBytes: -1 }),
    ).toThrow();
    expect(
      () => new WorkspaceStoragePressure(root, { reserveBytes: 1.5 }),
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
