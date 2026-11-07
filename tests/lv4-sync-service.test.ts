import { describe, expect, it, vi } from "vitest";
import { WorkspaceSyncService } from "../src/main/workspace-sync-service";
import { SyncError } from "../src/sync/protocol";

describe("WorkspaceSyncService", () => {
  it("restores local success history and keeps a successful transfer successful if history cannot be saved", async () => {
    const transport = {status: () => ({}), sendPending: async () => {}, receiveAndStage: async () => {},
      readLastSuccess: () => "2026-01-01T00:00:00.000Z",
      recordLastSuccess: () => {throw new Error("disk unavailable");}};
    const service = new WorkspaceSyncService(transport, () => new Date("2026-02-01T00:00:00.000Z"));
    expect(service.status().lastSuccessAt).toBe("2026-01-01T00:00:00.000Z");
    expect(await service.sync()).toMatchObject({lastSuccessAt: "2026-02-01T00:00:00.000Z", lastError: null});
  });
  it("does not advance success history when a pass leaves unresolved local work", async () => {
    const recordLastSuccess = vi.fn();
    const service = new WorkspaceSyncService({status: () => ({pending: true, conflict: true}),
      sendPending: async () => {}, receiveAndStage: async () => {}, shouldRecordSuccess: () => false,
      readLastSuccess: () => "2026-01-01T00:00:00.000Z", recordLastSuccess},
      () => new Date("2026-02-01T00:00:00.000Z"));
    expect((await service.sync()).lastSuccessAt).toBe("2026-01-01T00:00:00.000Z");
    expect(recordLastSuccess).not.toHaveBeenCalled();
  });
  it("shares a single transfer pass and never applies workspace data", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const transport = {
      status: () => ({ receivedCursor: 1, appliedRevision: 0 }),
      sendPending: vi.fn(async () => gate),
      receiveAndStage: vi.fn(async () => {}),
      applyStaged: vi.fn(),
    };
    const service = new WorkspaceSyncService(transport, () => new Date("2026-01-01T00:00:00Z"));
    const first = service.sync();
    const second = service.sync();
    expect(first).toBe(second);
    expect(service.status().running).toBe(true);
    await vi.waitFor(() => expect(transport.sendPending).toHaveBeenCalledTimes(1));
    release();
    expect(await first).toMatchObject({ running: false, lastSuccessAt: "2026-01-01T00:00:00.000Z", lastError: null });
    expect(transport.receiveAndStage).toHaveBeenCalledTimes(1);
    expect(transport.applyStaged).not.toHaveBeenCalled();
  });

  it("retains retryability and does not expose exception text", async () => {
    const transport = {
      status: () => ({ pending: true }),
      sendPending: vi.fn().mockRejectedValueOnce(new Error("secret-url-token")).mockResolvedValue(undefined),
      receiveAndStage: vi.fn().mockRejectedValueOnce(new SyncError("server-head-regressed", 409)).mockResolvedValue(undefined),
    };
    const service = new WorkspaceSyncService(transport);
    expect((await service.sync()).lastError).toBe("local-or-network-error");
    expect(transport.receiveAndStage).not.toHaveBeenCalled();
    expect((await service.sync()).lastError).toBe("server-head-regressed");
    expect((await service.sync()).lastError).toBeNull();
  });

  it("does not expose an arbitrary server-supplied protocol code", async () => {
    const service = new WorkspaceSyncService({
      status: () => ({}),
      sendPending: async () => {throw new SyncError("secret-token-from-server", 400);},
      receiveAndStage: async () => {},
    });
    expect((await service.sync()).lastError).toBe("local-or-network-error");
  });
  it("reports a fixed capacity reason without exposing exception text", async () => {
    const service = new WorkspaceSyncService({status: () => ({}),
      sendPending: async () => {throw new Error("(capacity-exceeded) secret details");}, receiveAndStage: async () => {}});
    expect((await service.sync()).lastError).toBe("capacity-exceeded");
  });
  it("reports a bounded failure when no connection or connector exists", async () => {
    const service = new WorkspaceSyncService<{pending: boolean}>(undefined);
    expect(service.status()).toMatchObject({connection: "disconnected", running: false,
      workspace: null, lastError: null});
    expect(await service.sync()).toMatchObject({connection: "disconnected", running: false,
      workspace: null, lastError: "sync-not-connected"});
  });
  it("opens a missing connection once for concurrent requests and reuses it", async () => {
    const transport = {
      status: vi.fn(() => ({pending: false})),
      sendPending: vi.fn(async () => {}),
      receiveAndStage: vi.fn(async () => {}),
    };
    let release!: (value: typeof transport) => void;
    const opened = new Promise<typeof transport>((resolve) => {release = resolve;});
    const connector = vi.fn(() => opened);
    const service = WorkspaceSyncService.reconnect<{pending: boolean}>(connector,
      () => new Date("2026-02-03T04:05:06Z"));
    const first = service.sync();
    const second = service.sync();
    expect(first).toBe(second);
    expect(service.status()).toMatchObject({connection: "connecting", running: true,
      workspace: null, lastError: null});
    await Promise.resolve();
    expect(connector).toHaveBeenCalledTimes(1);
    release(transport);
    expect(await first).toMatchObject({connection: "connected", running: false,
      workspace: {pending: false}, lastSuccessAt: "2026-02-03T04:05:06.000Z", lastError: null});
    await service.sync();
    expect(connector).toHaveBeenCalledTimes(1);
    expect(transport.sendPending).toHaveBeenCalledTimes(2);
    expect(transport.receiveAndStage).toHaveBeenCalledTimes(2);
  });
  it("keeps a failed reconnect retryable and never exposes the raw error", async () => {
    const transport = {
      status: () => ({pending: false}),
      sendPending: vi.fn(async () => {}),
      receiveAndStage: vi.fn(async () => {}),
    };
    let attempt = 0;
    const connector = vi.fn(async () => {
      if (++attempt === 1)
        throw new Error("http://127.0.0.1:9/?token=secret-token-value");
      return transport;
    });
    const service = WorkspaceSyncService.reconnect<{pending: boolean}>(connector);
    const failed = await service.sync();
    expect(failed).toMatchObject({connection: "disconnected", running: false,
      workspace: null, lastSuccessAt: null, lastError: "local-or-network-error"});
    expect(JSON.stringify(failed)).not.toContain("secret-token-value");
    expect(transport.sendPending).not.toHaveBeenCalled();
    const recovered = await service.sync();
    expect(recovered).toMatchObject({connection: "connected", lastError: null,
      workspace: {pending: false}});
    expect(connector).toHaveBeenCalledTimes(2);
    expect(transport.sendPending).toHaveBeenCalledTimes(1);
    expect(transport.receiveAndStage).toHaveBeenCalledTimes(1);
  });
});
