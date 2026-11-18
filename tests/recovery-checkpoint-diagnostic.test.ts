import { expect, it } from "vitest";
import { RecoveryCheckpoint, type RecoveryWriteRequest } from "../src/renderer/recovery-checkpoint";
import {
  createDiagnosticRequest,
  requestStorageFailure,
  StorageFailureError,
  storageFailureMessageV1,
} from "../src/renderer/private-request";
import type { StorageFailureV1 } from "../src/shared/private-storage-failure";
import { emptyCrashRecoverySnapshot, type CrashRecoveryRead } from "../src/shared/crash-recovery";
import { EditSessionCoordinator } from "../src/renderer/edit-session-coordinator";
import { DatabaseSessionCoordinator } from "../src/renderer/database-session-coordinator";
import { saveFixture } from "./fixtures/r4-save-fixture";
import type { Request } from "../src/shared/types";

const v1 = {diagnostics: "v1" as const};
const snapshot = (value: string) => ({...emptyCrashRecoverySnapshot(), rawDrafts: [{scope: "record" as const, pageId: "page", key: "number", value}]});
const ack = (request: RecoveryWriteRequest): CrashRecoveryRead => ({status: "ready", generation: request.expectedGeneration + 1, snapshot: structuredClone(request.snapshot)});
function barrier() {let release!: () => void; const promise = new Promise<void>((resolve) => {release = resolve;}); return {release, promise};}
const envelope = (valueSlot: {present: false} | {present: true; value: unknown}) =>
  JSON.parse(JSON.stringify({tag: "folio-request-result", version: 1, ok: true, valueSlot}));
const failureReply = (failure: unknown) =>
  JSON.parse(JSON.stringify({tag: "folio-request-result", version: 1, ok: false, failure}));
const rejected = (promise: Promise<unknown>) => promise.then(() => {throw new Error("unexpected resolve");}, (error) => error);

function unclassified(overrides: Partial<StorageFailureV1> = {}): StorageFailureV1 {
  return {version: 1, kind: "UNCLASSIFIED", family: "REQUEST", stage: "REQUEST", failureSubject: "UNIDENTIFIED",
    mutationDispatch: "UNPROVEN", proofOrigin: "NONE", requestType: "recovery:write", sourceOutcome: null,
    sourceCauseCodes: [], causeSummaryIncomplete: true, attemptId: null, precondition: null,
    operationProgress: "PARTIAL_OR_UNKNOWN", retryAuthority: "NONE", preserve: true, ...overrides};
}
function capacity(): StorageFailureV1 {
  return unclassified({kind: "PRE_DISPATCH_CAPACITY", family: "CHECKPOINT", stage: "RESERVE",
    failureSubject: "CURRENT_ATTEMPT", mutationDispatch: "NOT_DISPATCHED_PROVEN", proofOrigin: "LOCAL_ADMISSION_GUARD",
    sourceOutcome: {source: "RECOVERY_IO", contractVersion: 3, state: "REJECTED", reason: "PRIVATE_IO_V3_REJECTED"},
    sourceCauseCodes: ["WINDOWS_RECOVERY_ARCHIVE_CAPACITY"], causeSummaryIncomplete: false, attemptId: "b".repeat(32)});
}
function conflict(overrides: Partial<StorageFailureV1> = {}): StorageFailureV1 {
  return unclassified({kind: "GENERATION_CONFLICT", family: "CHECKPOINT", stage: "PRECONDITION",
    failureSubject: "CURRENT_ATTEMPT", mutationDispatch: "NOT_DISPATCHED_PROVEN", proofOrigin: "VALIDATED_PRECONDITION",
    sourceCauseCodes: ["CHECKPOINT_PRECONDITION_MISMATCH"], causeSummaryIncomplete: false,
    precondition: {expectedGeneration: 0, observedActualGeneration: 1, mismatch: "GENERATION"}, ...overrides});
}
function headCas(): StorageFailureV1 {
  return unclassified({kind: "OUTCOME_UNKNOWN", family: "CHECKPOINT", stage: "HEAD_CAS",
    failureSubject: "CURRENT_ATTEMPT", mutationDispatch: "DISPATCHED", proofOrigin: "DISPATCH_OBSERVED",
    sourceOutcome: {source: "RECOVERY_IO", contractVersion: 3, state: "PUBLISHED", reason: null},
    sourceCauseCodes: ["WINDOWS_RECOVERY_ARCHIVE_CONFLICT"], causeSummaryIncomplete: false, attemptId: "a".repeat(32)});
}
function priorAttempt(): StorageFailureV1 {
  return unclassified({kind: "OUTCOME_UNKNOWN", family: "CHECKPOINT", stage: "PRIOR_ATTEMPT",
    failureSubject: "PRIOR_ATTEMPT", mutationDispatch: "UNPROVEN", proofOrigin: "NONE",
    sourceCauseCodes: ["WINDOWS_RECOVERY_PORT_PENDING"], causeSummaryIncomplete: false});
}
const localE = {kind: "UNCLASSIFIED", family: "REQUEST", stage: "REQUEST", failureSubject: "UNIDENTIFIED",
  mutationDispatch: "UNPROVEN", proofOrigin: "NONE", requestType: "recovery:write", sourceOutcome: null,
  sourceCauseCodes: [], causeSummaryIncomplete: true, attemptId: null, precondition: null,
  operationProgress: "PARTIAL_OR_UNKNOWN", retryAuthority: "NONE", preserve: true} as const;

it("keeps the normal ACK, coalescing and durable status of a healthy v1 queue", async () => {
  const held = barrier(), entered = barrier(), sent: Request[] = [], states: string[] = [];
  const send = createDiagnosticRequest(async (request: Request) => {
    sent.push(request); entered.release(); await held.promise;
    return envelope({present: true, value: ack(request as RecoveryWriteRequest)});
  });
  const queue = new RecoveryCheckpoint(send, 4, (status) => states.push(status.state), v1);
  const input = snapshot("-"); queue.offer(input); input.rawDrafts[0].value = "caller mutation";
  queue.offer(snapshot("1e"));
  const flush = queue.flush(); await entered.promise;
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({type: "recovery:write", expectedGeneration: 4, snapshot: snapshot("1e")});
  expect(queue.getStatus()).toMatchObject({state: "saving", savedSeq: 0, offeredSeq: 2, generation: 4});
  held.release(); await flush;
  expect(queue.getStatus()).toEqual({state: "saved", generation: 5, savedSeq: 2, offeredSeq: 2});
  expect(states.at(-1)).toBe("saved");
  await queue.retry();
  expect(sent).toHaveLength(1);
});

it.each([["adapter pre-dispatch capacity", capacity()], ["adapter head-CAS outcome unknown", headCas()],
  ["adapter prior-attempt outcome unknown", priorAttempt()], ["adapter generation conflict", conflict()],
  ["adapter unclassified", unclassified()]])(
  "retains a valid %s as the latched failure while retry and flush send nothing", async (_name, dto) => {
    const sent: Request[] = [];
    const send = createDiagnosticRequest(async (request: Request) => {sent.push(request); return failureReply(dto);});
    const queue = new RecoveryCheckpoint(send, 0, undefined, v1);
    queue.offer(snapshot("held"));
    const error = await rejected(queue.flush());
    expect(error).toBeInstanceOf(StorageFailureError);
    expect((error as StorageFailureError).storageFailure).toEqual(dto);
    const status = queue.getStatus();
    expect(status).toMatchObject({state: "error", generation: 0, savedSeq: 0, offeredSeq: 1});
    expect(status.storageFailure).toEqual(dto);
    expect(status.error).toBe(storageFailureMessageV1(dto));
    await expect(queue.retry()).rejects.toBeInstanceOf(StorageFailureError);
    await expect(queue.flush()).rejects.toBeInstanceOf(StorageFailureError);
    queue.offer(snapshot("later input retained"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(1);
    expect(queue.getStatus()).toMatchObject({state: "error", offeredSeq: 2, savedSeq: 0, generation: 0});
  });

it("maps a local timer, non-object and every invalid ACK shape to the same bounded local E", async () => {
  const secret = "/Users/alice/workspace-secret";
  const cases: Array<[string, (request: Request) => Promise<unknown>, {timeoutMs?: number}]> = [
    ["transport rejection", async () => {throw new Error(`raw transport ${secret}`);}, {}],
    ["non-object ACK", async () => envelope({present: true, value: "not-an-object"}), {}],
    ["not-ready ACK", async () => envelope({present: true, value: {status: "blocked", generation: 0, message: `raw ${secret}`}}), {}],
    ["wrong-generation ACK", async (request) => envelope({present: true, value:
      {...ack(request as RecoveryWriteRequest), generation: 99}}), {}],
    ["invalid snapshot ACK", async (request) => envelope({present: true, value:
      {status: "ready", generation: (request as RecoveryWriteRequest).expectedGeneration + 1, snapshot: snapshot("different")}}), {}],
    ["ACK timer", async () => new Promise<unknown>(() => {}), {timeoutMs: 5}],
  ];
  for (const [name, invoke, options] of cases) {
    const send = createDiagnosticRequest(invoke);
    const queue = new RecoveryCheckpoint(send, 0, undefined, {...v1, ...options});
    queue.offer(snapshot("local"));
    const error = await rejected(queue.flush());
    expect(error, name).toBeInstanceOf(StorageFailureError);
    const status = queue.getStatus();
    expect(status, name).toMatchObject({state: "error", generation: 0, savedSeq: 0});
    expect(status.storageFailure, name).toMatchObject(localE);
    expect(status.error, name).toBe(storageFailureMessageV1(status.storageFailure!));
    expect(JSON.stringify(status), name).not.toContain("secret");
    expect(JSON.stringify(status), name).not.toContain("timed out");
    await expect(queue.retry(), name).rejects.toBeInstanceOf(StorageFailureError);
  }
});

it("demotes a diagnostic for another request type to the local E and keeps a matching one", async () => {
  // A valid carried DTO survives only through the safe own-property carrier;
  // anything thrown across the raw transport boundary stays a local E.
  const matching = async () => {throw new StorageFailureError(conflict());};
  const foreignCarrier = async () => {throw new StorageFailureError(conflict({requestType: "recovery:read"}));};
  const rawThrow = createDiagnosticRequest(async () => {throw new StorageFailureError(conflict());});
  const foreignReply = createDiagnosticRequest(async () => failureReply({...conflict(), requestType: "recovery:read"}));
  const expected = new Map<unknown, object>([[matching, conflict()], [foreignCarrier, localE], [rawThrow, localE], [foreignReply, localE]]);
  for (const [write, failure] of expected) {
    const queue = new RecoveryCheckpoint(write as (request: RecoveryWriteRequest) => Promise<unknown>, 0, undefined, v1);
    queue.offer(snapshot("kept"));
    const error = await rejected(queue.flush());
    expect(error).toBeInstanceOf(StorageFailureError);
    expect(queue.getStatus().storageFailure).toMatchObject(failure);
  }
});

it("a late ACK after a latched timeout cannot apply, clear or resume", async () => {
  const sent: Request[] = [];
  let resolveWrite!: (value: unknown) => void;
  const send = createDiagnosticRequest(async (request: Request) => {
    sent.push(request);
    return new Promise<unknown>((resolve) => {resolveWrite = resolve;});
  });
  const queue = new RecoveryCheckpoint(send, 0, undefined, {...v1, timeoutMs: 5});
  queue.offer(snapshot("held"));
  await expect(queue.flush()).rejects.toBeInstanceOf(StorageFailureError);
  resolveWrite(envelope({present: true, value: {status: "ready", generation: 1, snapshot: snapshot("held")}}));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(queue.getStatus()).toMatchObject({state: "error", generation: 0, savedSeq: 0, offeredSeq: 1});
  await expect(queue.retry()).rejects.toBeInstanceOf(StorageFailureError);
  await expect(queue.flush()).rejects.toBeInstanceOf(StorageFailureError);
  queue.offer(snapshot("later"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sent).toHaveLength(1);
  expect(queue.getStatus()).toMatchObject({state: "error", offeredSeq: 2, savedSeq: 0});
});

it("latches a local capture failure identically to a failed write, even at seq 0", async () => {
  const sent: Request[] = [];
  const send = createDiagnosticRequest(async (request: Request) => {
    sent.push(request); return envelope({present: true, value: ack(request as RecoveryWriteRequest)});
  });
  const queue = new RecoveryCheckpoint(send, 0, undefined, v1);
  queue.captureFailure(new Error("capture broke at /Users/alice/secret"));
  const status = queue.getStatus();
  expect(status).toMatchObject({state: "error", offeredSeq: 0, savedSeq: 0, generation: 0});
  expect(status.storageFailure).toMatchObject(localE);
  expect(status.error).toBe(storageFailureMessageV1(status.storageFailure!));
  expect(status.error).not.toContain("secret");
  await expect(queue.flush()).rejects.toBeInstanceOf(StorageFailureError);
  await expect(queue.retry()).rejects.toBeInstanceOf(StorageFailureError);
  const seq = queue.offer(snapshot("retained while held"));
  expect(seq).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sent).toHaveLength(0);
  expect(queue.getStatus()).toMatchObject({state: "error", offeredSeq: 1, savedSeq: 0});
});

it("routes a failed offer capture into the same typed hold and keeps earlier state", async () => {
  const sent: Request[] = [];
  const send = createDiagnosticRequest(async (request: Request) => {
    sent.push(request); return envelope({present: true, value: ack(request as RecoveryWriteRequest)});
  });
  const queue = new RecoveryCheckpoint(send, 0, undefined, v1);
  queue.offer(snapshot("saved first"));
  await queue.flush();
  expect(queue.getStatus()).toMatchObject({state: "saved", generation: 1, savedSeq: 1});
  let caught: unknown;
  try {queue.offer({...snapshot("invalid"), schemaVersion: 2} as never);} catch (error) {caught = error;}
  // The failed offer itself latches and rethrows the bounded held failure.
  expect(caught).toBeInstanceOf(StorageFailureError);
  expect(requestStorageFailure(caught, "recovery:write")).toMatchObject(localE);
  // The App capture path may pass the same error back; it cannot reclassify.
  queue.captureFailure(caught);
  const status = queue.getStatus();
  expect(status).toMatchObject({state: "error", generation: 1, offeredSeq: 1, savedSeq: 1});
  expect(status.storageFailure).toMatchObject(localE);
  await expect(queue.flush()).rejects.toBeInstanceOf(StorageFailureError);
  await expect(queue.retry()).rejects.toBeInstanceOf(StorageFailureError);
  expect(sent).toHaveLength(1);
});

it("latches an invalid v1 offer as the held failure without advancing input", async () => {
  const sent: Request[] = [];
  const send = createDiagnosticRequest(async (request: Request) => {
    sent.push(request); return envelope({present: true, value: ack(request as RecoveryWriteRequest)});
  });
  const queue = new RecoveryCheckpoint(send, 0, undefined, v1);
  let caught: unknown;
  try {queue.offer({version: 99} as never);} catch (error) {caught = error;}
  expect(caught).toBeInstanceOf(StorageFailureError);
  expect(requestStorageFailure(caught, "recovery:write")).toMatchObject(localE);
  const status = queue.getStatus();
  expect(status).toMatchObject({state: "error", offeredSeq: 0, savedSeq: 0, generation: 0});
  expect(status.storageFailure).toMatchObject(localE);
  // The barrier rejects even at sequence zero; nothing was dispatched.
  await expect(queue.flush()).rejects.toBeInstanceOf(StorageFailureError);
  await expect(queue.retry()).rejects.toBeInstanceOf(StorageFailureError);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sent).toHaveLength(0);
});

it("holds an earlier pending offer undispatched when a later offer fails", async () => {
  const sent: Request[] = [];
  const send = createDiagnosticRequest(async (request: Request) => {
    sent.push(request); return envelope({present: true, value: ack(request as RecoveryWriteRequest)});
  });
  const queue = new RecoveryCheckpoint(send, 0, undefined, v1);
  expect(queue.offer(snapshot("valid pending"))).toBe(1);
  // The failing offer latches before the scheduled write can dispatch: the
  // retained pending input is preserved, not sent past the hold.
  expect(() => queue.offer({version: 99} as never)).toThrow(StorageFailureError);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sent).toHaveLength(0);
  const status = queue.getStatus();
  expect(status).toMatchObject({state: "error", offeredSeq: 1, savedSeq: 0, generation: 0});
  expect(status.storageFailure).toMatchObject(localE);
  await expect(queue.flush()).rejects.toBeInstanceOf(StorageFailureError);
  expect(sent).toHaveLength(0);
});

it("keeps the first held diagnostic through later capture and offer failures", async () => {
  const sent: Request[] = [];
  const send = createDiagnosticRequest(async (request: Request) => {
    sent.push(request); return failureReply(priorAttempt());
  });
  const queue = new RecoveryCheckpoint(send, 0, undefined, v1);
  queue.offer(snapshot("held failure"));
  await expect(queue.flush()).rejects.toThrow(storageFailureMessageV1(priorAttempt()));
  expect(queue.getStatus().storageFailure).toEqual(priorAttempt());
  expect(sent).toHaveLength(1);
  // A secondary local capture failure can neither clear nor reclassify it.
  queue.captureFailure(new Error("secondary capture broke at /Users/alice/secret"));
  let caught: unknown;
  try {queue.offer({version: 99} as never);} catch (error) {caught = error;}
  expect(requestStorageFailure(caught, "recovery:write")).toEqual(priorAttempt());
  const status = queue.getStatus();
  expect(status.storageFailure).toEqual(priorAttempt());
  expect(status.error).toBe(storageFailureMessageV1(priorAttempt()));
  expect(status).toMatchObject({generation: 0, offeredSeq: 1, savedSeq: 0});
  await expect(queue.retry()).rejects.toThrow(storageFailureMessageV1(priorAttempt()));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sent).toHaveLength(1);
  // Control: with no earlier diagnostic held, a capture failure latches local E.
  const fresh = new RecoveryCheckpoint(send, 0, undefined, v1);
  fresh.captureFailure(new Error("first failure"));
  expect(fresh.getStatus().storageFailure).toMatchObject(localE);
});

it("propagates the typed failure through the barrier instead of a raw string", async () => {
  const send = createDiagnosticRequest(async () => failureReply(conflict()));
  const queue = new RecoveryCheckpoint(send, 0, undefined, v1);
  queue.offer(snapshot("held"));
  await expect(queue.flush()).rejects.toThrow(storageFailureMessageV1(conflict()));
  // The App barrier throws the held status diagnostic before flush, so the
  // bounded DTO reaches beforeSend rather than a re-wrapped raw message.
  const status = queue.getStatus();
  const held = status.state === "error"
    ? (status.storageFailure ? new StorageFailureError(status.storageFailure) : new Error(status.error))
    : null;
  expect(held).toBeInstanceOf(StorageFailureError);
  expect(requestStorageFailure(held, "recovery:write")).toEqual(conflict());
  const flushed = await rejected(queue.flush());
  expect(flushed).toBeInstanceOf(StorageFailureError);
  expect(requestStorageFailure(flushed, "recovery:write")).toEqual(conflict());
});

it("fails closed on an invalid diagnostics option, generation or timeout", () => {
  const send = createDiagnosticRequest(async () => envelope({present: false}));
  // A v1 construction refusal cannot build a queue but still carries the
  // bounded recovery:write diagnostic rather than a raw validation message.
  for (const construct of [
    () => new RecoveryCheckpoint(send, -1, undefined, v1),
    () => new RecoveryCheckpoint(send, 1.5, undefined, v1),
    () => new RecoveryCheckpoint(send, 0, undefined, {diagnostics: "v1", timeoutMs: 0}),
  ]) {
    let thrown: unknown;
    try {construct();} catch (error) {thrown = error;}
    expect(thrown).toBeInstanceOf(StorageFailureError);
    expect(requestStorageFailure(thrown, "recovery:write")).toMatchObject(localE);
  }
  // An unrecognized diagnostics mode and legacy construction keep plain errors.
  expect(() => new RecoveryCheckpoint(send, 0, undefined, {diagnostics: "legacy" as never})).toThrow(/diagnostics/);
  expect(() => new RecoveryCheckpoint(send, -1)).toThrow(/generation/);
  expect(() => new RecoveryCheckpoint(send, 0, undefined, {timeoutMs: 0})).toThrow(/timeout/);
});

it("keeps legacy mode on the exact failed-snapshot write ACK recovery without diagnostics", async () => {
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
  const status = queue.getStatus();
  expect(status.state).toBe("error");
  expect(status.error).toContain("ACK lost");
  expect(status.storageFailure).toBeUndefined();
  await queue.retry();
  expect(requests).toHaveLength(3); expect(requests[2].snapshot).toEqual(snapshot("later"));
  expect(queue.getStatus()).toMatchObject({state: "saved", generation: 2, savedSeq: 2});
});

it("a latched queue holds beforeSend so record/DB sends stay zero and unknown operations are retained", async () => {
  const f = saveFixture();
  try {
    const sent: Request[] = [];
    const send = createDiagnosticRequest(async (request: Request) => {sent.push(request); return failureReply(capacity());});
    const queue = new RecoveryCheckpoint(send, 0, undefined, v1);
    queue.offer(snapshot("checkpoint"));
    await expect(queue.flush()).rejects.toBeInstanceOf(StorageFailureError);
    const appRequests: Request[] = [];
    const beforeSend = () => queue.flush();
    const transport = async (request: Request): Promise<unknown> => {appRequests.push(request); return f.store.handle(request);};
    const sessions = new EditSessionCoordinator(transport, {beforeSend});
    const databases = new DatabaseSessionCoordinator(transport, {beforeSend});
    const recordHandle = sessions.attach(f.store.get(f.record.pageId), f.record);
    sessions.edit(recordHandle, {title: "Held record"}, {note: "held value"});
    await sessions.flush(recordHandle.pageId);
    const recordView = sessions.get(recordHandle.pageId);
    expect(recordView?.state).toBe("unknown");
    expect(recordView?.operation).toBeDefined();
    expect(recordView?.error).toBe(storageFailureMessageV1(capacity()));
    const dbHandle = databases.attach(f.owner, f.repo.databaseProjection(f.owner.id));
    databases.editPage(dbHandle, {title: "Held database"});
    await databases.flush(dbHandle.pageId);
    const dbView = databases.get(dbHandle.pageId);
    expect(dbView?.state).toBe("unknown");
    expect(dbView?.operation).toBeDefined();
    expect(dbView?.error).toBe(storageFailureMessageV1(capacity()));
    expect(appRequests).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(f.store.get(f.record.pageId).title).toBe("Task");
    expect(f.store.get(f.owner.id).title).toBe("Tasks");
  } finally {f.dispose();}
});
