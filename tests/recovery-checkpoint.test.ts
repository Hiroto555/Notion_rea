import { expect, it } from "vitest";
import { RecoveryCheckpoint, type RecoveryWriteRequest } from "../src/renderer/recovery-checkpoint";
import { emptyCrashRecoverySnapshot, type CrashRecoveryRead } from "../src/shared/crash-recovery";

const snapshot = (value: string) => ({...emptyCrashRecoverySnapshot(), rawDrafts: [{scope: "record" as const, pageId: "page", key: "number", value}]});
const ack = (request: RecoveryWriteRequest): CrashRecoveryRead => ({status: "ready", generation: request.expectedGeneration + 1, snapshot: structuredClone(request.snapshot)});
function barrier() {let release!: () => void; const promise = new Promise<void>((resolve) => {release = resolve;}); return {release, promise};}

it("captures input immediately, coalesces unsent snapshots and exposes durable status only after ACK", async () => {
  const held = barrier(), entered = barrier(), requests: RecoveryWriteRequest[] = [], states: string[] = [];
  const queue = new RecoveryCheckpoint(async (request) => {requests.push(request); entered.release(); await held.promise; return ack(request);}, 4, (status) => states.push(status.state));
  const input = snapshot("-"); queue.offer(input); input.rawDrafts[0].value = "caller mutation";
  queue.offer(snapshot("1e"));
  const flush = queue.flush(); await entered.promise;
  expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({expectedGeneration: 4, snapshot: snapshot("1e")});
  expect(queue.getStatus()).toMatchObject({state: "saving", savedSeq: 0, offeredSeq: 2, generation: 4});
  held.release(); await flush;
  expect(queue.getStatus()).toEqual({state: "saved", generation: 5, savedSeq: 2, offeredSeq: 2});
  expect(states.at(-1)).toBe("saved");
});

it("keeps later input behind an in-flight checkpoint and flush waits for its own captured generation", async () => {
  const first = barrier(), entered = barrier(), second = barrier(), secondEntered = barrier();
  const requests: RecoveryWriteRequest[] = [];
  const queue = new RecoveryCheckpoint(async (request) => {
    requests.push(request);
    if (requests.length === 1) {entered.release(); await first.promise;} else {secondEntered.release(); await second.promise;}
    return ack(request);
  }, 0);
  queue.offer(snapshot("old")); const flushFirst = queue.flush(); await entered.promise;
  queue.offer(snapshot("new")); const flushSecond = queue.flush();
  first.release(); await flushFirst; await secondEntered.promise;
  expect(queue.getStatus()).toMatchObject({state: "saving", generation: 1, savedSeq: 1});
  expect(requests[1]).toMatchObject({expectedGeneration: 1, snapshot: snapshot("new")});
  second.release(); await flushSecond;
  expect(queue.getStatus()).toMatchObject({state: "saved", generation: 2, savedSeq: 2});
});

it("retries a lost ACK with the same CAS and same snapshot before writing later inputs", async () => {
  const requests: RecoveryWriteRequest[] = []; let generation = 0;
  const queue = new RecoveryCheckpoint(async (request) => {
    requests.push(request);
    if (requests.length === 1) {generation = 1; throw new Error("ACK lost after publication");}
    if (requests.length === 2) {expect(request).toEqual(requests[0]); return {...ack(request), generation};}
    expect(request.expectedGeneration).toBe(generation); generation++; return ack(request);
  }, 0);
  queue.offer(snapshot("first")); await expect(queue.flush()).rejects.toThrow(/ACK lost/);
  queue.offer(snapshot("later")); await expect(queue.flush()).rejects.toThrow(/ACK lost/);
  expect(requests).toHaveLength(1);
  await queue.retry();
  expect(requests).toHaveLength(3); expect(requests[2].snapshot).toEqual(snapshot("later"));
  expect(queue.getStatus()).toMatchObject({state: "saved", generation: 2, savedSeq: 2});
});

it("does not accept an unrelated CAS generation or overwrite it with a new expected generation", async () => {
  const requests: RecoveryWriteRequest[] = [];
  const queue = new RecoveryCheckpoint(async (request) => {requests.push(request); return {...ack(request), generation: 99};}, 3);
  queue.offer(snapshot("retained")); await expect(queue.flush()).rejects.toThrow(/differs/);
  await expect(queue.retry()).rejects.toThrow(/differs/);
  expect(requests.map((request) => request.expectedGeneration)).toEqual([3, 3]);
  expect(queue.getStatus()).toMatchObject({state: "error", generation: 3, savedSeq: 0});
});

it("blocks on corrupt/foreign journal responses and rejects a mismatched snapshot ACK", async () => {
  let blocked = true;
  const queue = new RecoveryCheckpoint(async (request) => blocked ? {status: "blocked", generation: 0, message: "foreign checkpoint"} :
    {...ack(request), snapshot: snapshot("different content")}, 1);
  queue.offer(snapshot("keep")); await expect(queue.flush()).rejects.toThrow(/foreign/);
  blocked = false; await expect(queue.retry()).rejects.toThrow(/differs/);
  expect(queue.getStatus()).toMatchObject({generation: 1, savedSeq: 0, state: "error"});
});

it("retains an immutable captured snapshot when caller and transport mutate their copies", async () => {
  let attempt = 0;
  const queue = new RecoveryCheckpoint(async (request) => {
    if (++attempt === 1) {request.snapshot.rawDrafts[0].value = "transport mutation"; throw new Error("failed");}
    expect(request.snapshot.rawDrafts[0].value).toBe("captured"); return ack(request);
  }, 0);
  const input = snapshot("captured"); queue.offer(input); input.rawDrafts[0].value = "later caller mutation";
  await expect(queue.flush()).rejects.toThrow(/failed/); await queue.retry();
  expect(queue.getStatus().state).toBe("saved");
});

it("turns an ACK timeout into retained error and isolates observer exceptions", async () => {
  let attempt = 0;
  const queue = new RecoveryCheckpoint(async (request) => ++attempt === 1 ? new Promise(() => {}) : ack(request), 0,
    () => {throw new Error("display failed");}, {timeoutMs: 5});
  queue.offer(snapshot("held")); await expect(queue.flush()).rejects.toThrow(/timed out/);
  await queue.retry(); expect(queue.getStatus().state).toBe("saved");
});

it("rejects invalid snapshots synchronously without advancing or replacing a valid pending capture", async () => {
  const writes: RecoveryWriteRequest[] = [], queue = new RecoveryCheckpoint(async (request) => {writes.push(request); return ack(request);}, 0);
  queue.offer(snapshot("valid"));
  expect(() => queue.offer({...snapshot("invalid"), schemaVersion: 2} as any)).toThrow();
  await queue.flush();
  expect(writes[0].snapshot).toEqual(snapshot("valid"));
  expect(queue.getStatus().offeredSeq).toBe(1);
});

it("deduplicates identical pending and saved snapshots without notification or another write", async () => {
  const writes: RecoveryWriteRequest[] = [], states: string[] = [];
  const queue = new RecoveryCheckpoint(async (request) => {writes.push(request); return ack(request);}, 0, (status) => states.push(status.state));
  const first = queue.offer(snapshot("same"));
  expect(queue.offer(snapshot("same"))).toBe(first);
  expect(states).toEqual(["saving"]);
  await queue.flush();
  expect(queue.offer(snapshot("same"))).toBe(first); await queue.flush();
  expect(writes).toHaveLength(1); expect(states).toEqual(["saving", "saved"]);
});
