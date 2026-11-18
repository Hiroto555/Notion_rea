import { describe, expect, it, vi } from "vitest";
import { WorkspaceSyncService, type WorkspaceSyncTransport } from "../src/main/workspace-sync-service";
import type { WorkspaceSyncStatus } from "../src/sync/workspace-store";

const status = (): WorkspaceSyncStatus => ({ receivedCursor: 0, appliedRevision: 0, generation: 0,
  cleanGeneration: 0, pending: false, conflict: false });

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createTransport(overrides: Partial<WorkspaceSyncTransport<WorkspaceSyncStatus>> = {}) {
  return {
    status: vi.fn(status),
    sendPending: vi.fn(async () => {}),
    receiveAndStage: vi.fn(async () => {}),
    ...overrides,
  } as WorkspaceSyncTransport<WorkspaceSyncStatus>;
}

describe("WorkspaceSyncService suspension", () => {
  it("blocks an already suspended service before opening a connector", async () => {
    const transport = createTransport();
    const connector = vi.fn(async () => transport);
    const service = WorkspaceSyncService.reconnect<WorkspaceSyncStatus>(connector);
    service.suspend();
    expect(service.status()).toMatchObject({ workspace: null, connection: "disconnected",
      running: false, lastError: "sync-disabled" });

    expect(await service.sync()).toMatchObject({ connection: "disconnected", running: false,
      lastError: "sync-disabled" });
    expect(connector).not.toHaveBeenCalled();
    expect(transport.sendPending).not.toHaveBeenCalled();
    expect(transport.receiveAndStage).not.toHaveBeenCalled();
  });

  it("suspension during reconnect prevents the first send and a later pass", async () => {
    const transport = createTransport();
    const opened = deferred<WorkspaceSyncTransport<WorkspaceSyncStatus>>();
    const connector = vi.fn(() => opened.promise);
    const service = WorkspaceSyncService.reconnect<WorkspaceSyncStatus>(connector);
    const pass = service.sync();
    expect(service.status()).toMatchObject({ connection: "connecting", running: true });
    await Promise.resolve();
    expect(connector).toHaveBeenCalledTimes(1);

    service.suspend();
    expect(service.status()).toMatchObject({ connection: "disconnected", running: true,
      lastError: "sync-disabled" });
    opened.resolve(transport);
    expect(await pass).toMatchObject({ connection: "disconnected", running: false,
      lastError: "sync-disabled" });
    expect(transport.sendPending).not.toHaveBeenCalled();
    expect(transport.receiveAndStage).not.toHaveBeenCalled();

    expect((await service.sync()).lastError).toBe("sync-disabled");
    expect(connector).toHaveBeenCalledTimes(1);
    expect(transport.sendPending).not.toHaveBeenCalled();
  });

  it("suspension during an in-flight send waits for its settlement without receive, success, or a new pass", async () => {
    const ack = deferred();
    const recordLastSuccess = vi.fn();
    const transport = createTransport({
      sendPending: vi.fn(() => ack.promise),
      readLastSuccess: () => "2026-01-01T00:00:00.000Z",
      recordLastSuccess,
      shouldRecordSuccess: () => true,
    });
    const service = new WorkspaceSyncService(transport, () => new Date("2026-02-01T00:00:00Z"));
    const first = service.sync();
    const second = service.sync();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(transport.sendPending).toHaveBeenCalledTimes(1));

    service.suspend();
    expect(service.isSuspended()).toBe(true);
    expect(service.status()).toMatchObject({ connection: "disconnected", running: true,
      lastSuccessAt: "2026-01-01T00:00:00.000Z", lastError: "sync-disabled" });

    ack.resolve();
    expect(await first).toMatchObject({ connection: "disconnected", running: false,
      lastSuccessAt: "2026-01-01T00:00:00.000Z", lastError: "sync-disabled" });
    expect(transport.receiveAndStage).not.toHaveBeenCalled();
    expect(recordLastSuccess).not.toHaveBeenCalled();

    const sends = vi.mocked(transport.sendPending).mock.calls.length;
    expect((await service.sync()).lastError).toBe("sync-disabled");
    expect(transport.sendPending).toHaveBeenCalledTimes(sends);
    expect(transport.receiveAndStage).not.toHaveBeenCalled();
    expect(recordLastSuccess).not.toHaveBeenCalled();
  });

  it("suspension during receive after a settled send skips success history and apply", async () => {
    const receiving = deferred();
    const recordLastSuccess = vi.fn();
    const applyStaged = vi.fn();
    const transport = Object.assign(createTransport({
      sendPending: vi.fn(async () => {}),
      receiveAndStage: vi.fn(() => receiving.promise),
      recordLastSuccess,
    }), { applyStaged });
    const service = new WorkspaceSyncService(transport, () => new Date("2026-02-01T00:00:00Z"));
    const pass = service.sync();
    await vi.waitFor(() => expect(transport.receiveAndStage).toHaveBeenCalledTimes(1));

    service.suspend();
    expect(service.status()).toMatchObject({ connection: "disconnected", running: true,
      lastError: "sync-disabled" });
    receiving.resolve();
    expect(await pass).toMatchObject({ connection: "disconnected", running: false,
      lastSuccessAt: null, lastError: "sync-disabled" });
    expect(transport.sendPending).toHaveBeenCalledTimes(1);
    expect(recordLastSuccess).not.toHaveBeenCalled();
    expect(applyStaged).not.toHaveBeenCalled();
  });

  it("a suspended service exposes no restart target, staged change, or conflict resolution", () => {
    const restartTarget = vi.fn(() => ({ workspaceId: "w", clientId: "c", bindingId: "b",
      serverEpoch: "e", revision: 1, checkpointHash: "a".repeat(64) }));
    const stagedChange = vi.fn(() => null);
    const conflictResolutionPreview = vi.fn(() => {throw new Error("preview must not be reached");});
    const assertConflictResolutionTarget = vi.fn();
    const transport = createTransport({ restartTarget, stagedChange, conflictResolutionPreview,
      assertConflictResolutionTarget });
    const service = new WorkspaceSyncService(transport);
    service.suspend();

    expect(service.restartTarget()).toBeNull();
    expect(service.stagedChange()).toBeNull();
    expect(() => service.conflictResolutionPreview("local")).toThrow("sync-disabled");
    expect(() => service.assertConflictResolutionTarget({version: 1, choice: "local", workspaceId: "w", clientId: "c", bindingId: "b", serverEpoch: "e",
      operationId: "operation", localRevision: 0, localCheckpointHash: "a".repeat(64), remoteRevision: 1, remoteCheckpointHash: "b".repeat(64),
      conflictGeneration: 1, generation: 1, cleanGeneration: 0, appliedRevision: 0, receivedCursor: 1, latestCheckpointHash: "a".repeat(64)})).toThrow("sync-disabled");
    expect(restartTarget).not.toHaveBeenCalled();
    expect(stagedChange).not.toHaveBeenCalled();
    expect(conflictResolutionPreview).not.toHaveBeenCalled();
    expect(assertConflictResolutionTarget).not.toHaveBeenCalled();
  });
});
