import { expect, it, vi } from "vitest";
import { WorkspaceSyncGate } from "../src/main/workspace-sync-gate";
const deferred = () => {let release!: () => void; const promise = new Promise<void>((resolve) => {release = resolve;}); return {promise, release};};
it("waits for ongoing writes, coalesces sync requests, and resumes queued writes", async () => {
  const gate = new WorkspaceSyncGate(), oldWrite = deferred(), transfer = deferred();
  const order: string[] = [];
  const first = gate.write(async () => {order.push("write-start"); await oldWrite.promise; order.push("write-end");});
  const doSync = vi.fn(async () => {order.push("sync-start"); await transfer.promise; order.push("sync-end");});
  const sync = gate.sync(doSync), same = gate.sync(doSync);
  expect(sync).toBe(same);
  const later = gate.write(() => {order.push("later-write");});
  await Promise.resolve(); expect(order).toEqual(["write-start"]);
  oldWrite.release(); await first; await Promise.resolve(); expect(order).toEqual(["write-start", "write-end", "sync-start"]);
  transfer.release(); await Promise.all([sync, later]);
  expect(order).toEqual(["write-start", "write-end", "sync-start", "sync-end", "later-write"]);
  expect(doSync).toHaveBeenCalledTimes(1);
});
it("releases waiting writes after a failed sync", async () => {
  const gate = new WorkspaceSyncGate(), barrier = deferred();
  const sync = gate.sync(async () => {await barrier.promise; throw new Error("failed");});
  const after = gate.write(() => "saved"); barrier.release();
  await expect(sync).rejects.toThrow("failed"); expect(await after).toBe("saved");
});
it("allows a new transfer after a synchronous failure", async () => {
  const gate = new WorkspaceSyncGate();
  await expect(gate.sync(() => {throw new Error("immediate");})).rejects.toThrow("immediate");
  await expect(gate.sync(async () => "retried")).resolves.toBe("retried");
});
it("reports non-idle through active writes, a waiting transfer and queued writes", async () => {
  const gate = new WorkspaceSyncGate(), oldWrite = deferred(), transfer = deferred(), newWrite = deferred();
  expect(gate.isIdle()).toBe(true);
  const first = gate.write(() => oldWrite.promise);
  expect(gate.isIdle()).toBe(false);
  const syncing = gate.sync(() => transfer.promise);
  const queued = gate.write(() => newWrite.promise);
  oldWrite.release();
  await first;
  expect(gate.isIdle()).toBe(false);
  transfer.release();
  await syncing;
  expect(gate.isIdle()).toBe(false);
  newWrite.release();
  await queued;
  expect(gate.isIdle()).toBe(true);
});
