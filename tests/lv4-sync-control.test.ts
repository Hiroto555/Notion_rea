import { expect, it, vi } from "vitest";
import { WorkspaceSyncControl } from "../src/main/workspace-sync-control";
import { WorkspaceSyncGate } from "../src/main/workspace-sync-gate";
import { WorkspaceSyncService } from "../src/main/workspace-sync-service";
import { assertReadOnlyRequest } from "../src/main/read-only-workspace";
import { requestSchema } from "../src/shared/types";
const status = () => ({receivedCursor: 0, appliedRevision: 0, generation: 0, cleanGeneration: 0, pending: false, conflict: false});
it("offers status and a gated transfer without an apply operation", async () => {
  let finish!: () => void; const wait = new Promise<void>((resolve) => {finish = resolve;});
  const transport = {status, sendPending: vi.fn(async () => wait), receiveAndStage: vi.fn(async () => {}), applyStaged: vi.fn()};
  const gate = new WorkspaceSyncGate(), service = new WorkspaceSyncService(transport);
  const control = new WorkspaceSyncControl(service, gate, false);
  const transfer = control.transfer(); const save = vi.fn(); const queued = gate.write(save);
  await Promise.resolve(); await Promise.resolve();
  expect(save).not.toHaveBeenCalled(); finish();
  expect((await transfer).available).toBe(true); await queued;
  expect(save).toHaveBeenCalledTimes(1); expect(transport.applyStaged).not.toHaveBeenCalled();
});
it("does not run transfers in read-only or disconnected mode", async () => {
  const transport = {status, sendPending: vi.fn(async () => {}), receiveAndStage: vi.fn(async () => {})};
  const service = new WorkspaceSyncService(transport), gate = new WorkspaceSyncGate();
  expect(await new WorkspaceSyncControl(service, gate, true).transfer()).toEqual({available: false, reason: "read-only"});
  expect(await new WorkspaceSyncControl(undefined, gate, false).transfer()).toEqual({available: false, reason: "not-connected"});
  expect(transport.sendPending).not.toHaveBeenCalled();
  expect(() => assertReadOnlyRequest({type: "sync:status"})).not.toThrow();
  expect(() => assertReadOnlyRequest({type: "sync:run"})).toThrow();
});
it("rechecks the requester after waiting for an in-flight write", async () => {
  let release!: () => void; const wait = new Promise<void>((resolve) => {release = resolve;});
  const gate = new WorkspaceSyncGate(), writing = gate.write(() => wait);
  const transport = {status, sendPending: vi.fn(async () => {}), receiveAndStage: vi.fn(async () => {})};
  const control = new WorkspaceSyncControl(new WorkspaceSyncService(transport), gate, false);
  let authorized = true;
  const transfer = control.transfer(() => {if (!authorized) throw new Error("Unauthorized IPC sender");});
  authorized = false; release(); await writing;
  await expect(transfer).rejects.toThrow("Unauthorized IPC sender");
  expect(transport.sendPending).not.toHaveBeenCalled();
  expect(await gate.write(() => "released")).toBe("released");
});
it("exposes bounded conflict inspection only through a connected readable service", () => {
  const target = {operationId: "operation", side: "local" as const, expectedRevision: 1,
    expectedCheckpointHash: "a".repeat(64)};
  const candidate = {operationId: target.operationId, side: target.side, revision: 1,
    checkpointHash: target.expectedCheckpointHash, checkpointJson: "{}", bytes: 2};
  const transport = {status, sendPending: async () => {}, receiveAndStage: async () => {},
    conflictInspection: () => null, conflictArchives: () => ({archives: [], total: 0}),
    conflictCandidate: vi.fn(() => candidate)};
  const gate = new WorkspaceSyncGate();
  const control = new WorkspaceSyncControl(new WorkspaceSyncService(transport), gate, false);
  expect(control.conflict()).toEqual({available: true, conflict: null, archives: [], archiveCount: 0});
  expect(control.conflictCandidate(target)).toEqual(candidate);
  expect(transport.conflictCandidate).toHaveBeenCalledWith(target);
  expect(new WorkspaceSyncControl(undefined, gate, false).conflict()).toEqual({available: false, reason: "not-connected"});
  expect(() => new WorkspaceSyncControl(new WorkspaceSyncService(transport), gate, true).conflictCandidate(target)).toThrow("read-only");
  expect(requestSchema.safeParse({type: "sync:conflictCandidate", ...target}).success).toBe(true);
  expect(requestSchema.safeParse({type: "sync:conflictCandidate", ...target, unexpected: "x"}).success).toBe(false);
  expect(requestSchema.safeParse({type: "sync:conflictExport", ...target}).success).toBe(true);
  expect(requestSchema.safeParse({type: "sync:conflictExport", ...target, path: "/tmp/out"}).success).toBe(false);
});
it("waits for an in-flight workspace write before opening a reconnect", async () => {
  let release!: () => void; const wait = new Promise<void>((resolve) => {release = resolve;});
  const gate = new WorkspaceSyncGate(), writing = gate.write(() => wait);
  const transport = {status, sendPending: vi.fn(async () => {}), receiveAndStage: vi.fn(async () => {})};
  const connector = vi.fn(async () => transport);
  const control = new WorkspaceSyncControl(
    WorkspaceSyncService.reconnect<ReturnType<typeof status>>(connector), gate, false);
  const transfer = control.transfer();
  await Promise.resolve(); await Promise.resolve();
  expect(connector).not.toHaveBeenCalled();
  release(); await writing;
  expect(await transfer).toMatchObject({available: true, connection: "connected"});
  expect(connector).toHaveBeenCalledTimes(1);
});
it("reports a disconnected reconnect and checks authorization before opening", async () => {
  const transport = {status, sendPending: vi.fn(async () => {}), receiveAndStage: vi.fn(async () => {})};
  const connector = vi.fn(async () => transport);
  const service = WorkspaceSyncService.reconnect<ReturnType<typeof status>>(connector);
  const control = new WorkspaceSyncControl(service, new WorkspaceSyncGate(), false);
  expect(control.status()).toMatchObject({available: true, connection: "disconnected", workspace: null});
  await expect(control.transfer(() => {throw new Error("Unauthorized IPC sender");}))
    .rejects.toThrow("Unauthorized IPC sender");
  expect(connector).not.toHaveBeenCalled();
  expect(await control.transfer()).toMatchObject({available: true, connection: "connected",
    running: false, lastError: null});
  expect(connector).toHaveBeenCalledTimes(1);
  expect(transport.sendPending).toHaveBeenCalledTimes(1);
});
