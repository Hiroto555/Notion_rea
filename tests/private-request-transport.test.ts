import { expect, it } from "vitest";
import { createPrivateRequestPreload } from "../src/preload/private-request";
import {
  createDiagnosticRequest,
  requestStorageFailure,
  StorageFailureError,
  storageFailureMessageV1,
  toStorageFailureError,
  unclassifiedRequestFailure,
} from "../src/renderer/private-request";
import {
  crashRecoveryBlockedMessageV1,
  type StorageFailureV1,
} from "../src/shared/private-storage-failure";
import { emptyCrashRecoverySnapshot, type CrashRecoveryRead } from "../src/shared/crash-recovery";
import type { Request } from "../src/shared/types";

type Invoke = (request: Request) => Promise<unknown>;
type Send = <T>(request: Request) => Promise<T>;

const roundtrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const okReply = (valueSlot: { present: false } | { present: true; value: unknown }): unknown =>
  roundtrip({ tag: "folio-request-result", version: 1, ok: true, valueSlot });
const failureReply = (failure: unknown): unknown =>
  roundtrip({ tag: "folio-request-result", version: 1, ok: false, failure });

function unclassified(overrides: Partial<StorageFailureV1> = {}): StorageFailureV1 {
  return {
    version: 1,
    kind: "UNCLASSIFIED",
    family: "REQUEST",
    stage: "REQUEST",
    failureSubject: "UNIDENTIFIED",
    mutationDispatch: "UNPROVEN",
    proofOrigin: "NONE",
    requestType: "recovery:write",
    sourceOutcome: null,
    sourceCauseCodes: [],
    causeSummaryIncomplete: true,
    attemptId: null,
    precondition: null,
    operationProgress: "PARTIAL_OR_UNKNOWN",
    retryAuthority: "NONE",
    preserve: true,
    ...overrides,
  };
}
function capacity(overrides: Partial<StorageFailureV1> = {}): StorageFailureV1 {
  return unclassified({
    kind: "PRE_DISPATCH_CAPACITY",
    family: "CHECKPOINT",
    stage: "RESERVE",
    failureSubject: "CURRENT_ATTEMPT",
    mutationDispatch: "NOT_DISPATCHED_PROVEN",
    proofOrigin: "LOCAL_ADMISSION_GUARD",
    sourceOutcome: { source: "RECOVERY_IO", contractVersion: 3, state: "REJECTED", reason: "PRIVATE_IO_V3_REJECTED" },
    sourceCauseCodes: ["WINDOWS_RECOVERY_ARCHIVE_CAPACITY"],
    causeSummaryIncomplete: false,
    attemptId: "b".repeat(32),
    ...overrides,
  });
}
function conflict(overrides: Partial<StorageFailureV1> = {}): StorageFailureV1 {
  return unclassified({
    kind: "GENERATION_CONFLICT",
    family: "CHECKPOINT",
    stage: "PRECONDITION",
    failureSubject: "CURRENT_ATTEMPT",
    mutationDispatch: "NOT_DISPATCHED_PROVEN",
    proofOrigin: "VALIDATED_PRECONDITION",
    sourceCauseCodes: ["CHECKPOINT_PRECONDITION_MISMATCH"],
    causeSummaryIncomplete: false,
    precondition: { expectedGeneration: 64, observedActualGeneration: 65, mismatch: "GENERATION" },
    ...overrides,
  });
}
function headCas(overrides: Partial<StorageFailureV1> = {}): StorageFailureV1 {
  return unclassified({
    kind: "OUTCOME_UNKNOWN",
    family: "CHECKPOINT",
    stage: "HEAD_CAS",
    failureSubject: "CURRENT_ATTEMPT",
    mutationDispatch: "DISPATCHED",
    proofOrigin: "DISPATCH_OBSERVED",
    sourceOutcome: { source: "RECOVERY_IO", contractVersion: 3, state: "PUBLISHED", reason: null },
    sourceCauseCodes: ["WINDOWS_RECOVERY_ARCHIVE_CONFLICT"],
    causeSummaryIncomplete: false,
    attemptId: "a".repeat(32),
    ...overrides,
  });
}
function priorAttempt(overrides: Partial<StorageFailureV1> = {}): StorageFailureV1 {
  return unclassified({
    kind: "OUTCOME_UNKNOWN",
    family: "CHECKPOINT",
    stage: "PRIOR_ATTEMPT",
    failureSubject: "PRIOR_ATTEMPT",
    mutationDispatch: "UNPROVEN",
    proofOrigin: "NONE",
    sourceCauseCodes: ["WINDOWS_RECOVERY_PORT_PENDING"],
    causeSummaryIncomplete: false,
    ...overrides,
  });
}

const writeRequest = (): Request => ({
  type: "recovery:write",
  expectedGeneration: 64,
  snapshot: emptyCrashRecoverySnapshot(),
});
const readRequest: Request = { type: "recovery:read" };

/** Production preload creator plus renderer adapter joined by a fake invoke;
 * a fake legacy channel counts calls so a fallback would be observed. */
function transport(invoke: Invoke) {
  let legacyCalls = 0;
  const sent: Request[] = [];
  const preload = createPrivateRequestPreload(async (request) => {
    sent.push(request);
    return invoke(request);
  });
  const folio = {
    request: async (request: Request): Promise<unknown> => {
      legacyCalls += 1;
      return request;
    },
    requestDiagnostic: preload.requestDiagnostic,
  };
  const send = createDiagnosticRequest((request: Request) => folio.requestDiagnostic(request));
  return { send, sent, folio, legacyCalls: () => legacyCalls };
}
const thrown = async (send: Send, request: Request): Promise<unknown> =>
  send(request).then(
    () => {
      throw new Error("unexpected success");
    },
    (error: unknown) => error,
  );

it("passes the request and reply envelope through the preload untouched", async () => {
  const envelope = { tag: "folio-request-result", version: 1, ok: true, valueSlot: { present: false } };
  const request = writeRequest();
  const preload = createPrivateRequestPreload(async (input) => {
    expect(input).toBe(request);
    return envelope;
  });
  expect(await preload.requestDiagnostic(request)).toBe(envelope);
});

it("unwraps falsy, void, ready, preview and cancellation successes unchanged", async () => {
  const request = writeRequest();
  {
    const { send, sent, legacyCalls } = transport(async () => okReply({ present: false }));
    expect(await send(request)).toBeUndefined();
    expect(sent).toEqual([request]);
    expect(legacyCalls()).toBe(0);
  }
  for (const value of [null, false, 0, ""] as const) {
    const { send } = transport(async () => okReply({ present: true, value }));
    expect(await send(request)).toBe(value);
  }
  const ready: CrashRecoveryRead = {
    status: "ready",
    generation: 65,
    snapshot: emptyCrashRecoverySnapshot(),
  };
  const preview = { directory: "/tmp/folio-backup-preview", entries: ["manifest.json"], bytes: 42 };
  for (const [req, value] of [
    [writeRequest(), ready],
    [{ type: "workspaceBackup:choose" } as Request, preview],
    [{ type: "workspaceBackup:choose" } as Request, null],
    [readRequest, { status: "empty", generation: 0 }],
  ] as const) {
    const { send } = transport(async () => okReply({ present: true, value }));
    expect(await send(req)).toEqual(value);
  }
});

it("surfaces A/C/D/E replies as StorageFailureError without downgrading them", async () => {
  const cases: Array<[string, StorageFailureV1]> = [
    ["pre-dispatch capacity", capacity()],
    ["dispatched outcome unknown", headCas()],
    ["prior attempt outcome unknown", priorAttempt()],
    ["generation conflict", conflict()],
    ["unclassified", unclassified()],
  ];
  for (const [name, dto] of cases) {
    const { send, sent, legacyCalls } = transport(async () => failureReply(dto));
    const error = await thrown(send, writeRequest());
    expect(error, name).toBeInstanceOf(StorageFailureError);
    const storageFailure = (error as StorageFailureError).storageFailure;
    expect(storageFailure, name).toEqual(dto);
    expect((error as Error).message, name).toBe(storageFailureMessageV1(storageFailure));
    expect("cause" in (error as object), name).toBe(false);
    expect(sent).toHaveLength(1);
    expect(legacyCalls()).toBe(0);
  }
});

it("keeps a safe UNRECOGNIZED failure from Main instead of rewriting it", async () => {
  const dto = unclassified({ requestType: "UNRECOGNIZED" });
  const { send } = transport(async () => failureReply(dto));
  const error = await thrown(send, writeRequest());
  expect(error).toBeInstanceOf(StorageFailureError);
  expect((error as StorageFailureError).storageFailure).toEqual(dto);
});

it("turns message-only, timeout and arbitrary transport rejections into a local E", async () => {
  const secret = "/Users/alice/secret/workspace/path";
  const rejections: unknown[] = [
    new Error(`CAPACITY exceeded while writing ${secret}`),
    Object.assign(new Error("Recovery write ACK timed out"), {
      cause: { code: "CAPACITY", path: secret },
    }),
    new Error("An object could not be cloned"),
    "plain string rejection",
  ];
  for (const reason of rejections) {
    const { send, sent, legacyCalls } = transport(async () => {
      throw reason;
    });
    const error = await thrown(send, writeRequest());
    expect(error).toBeInstanceOf(StorageFailureError);
    const storageFailure = (error as StorageFailureError).storageFailure;
    expect(storageFailure).toMatchObject({
      kind: "UNCLASSIFIED",
      family: "REQUEST",
      stage: "REQUEST",
      failureSubject: "UNIDENTIFIED",
      mutationDispatch: "UNPROVEN",
      proofOrigin: "NONE",
      requestType: "recovery:write",
      causeSummaryIncomplete: true,
      precondition: null,
      operationProgress: "PARTIAL_OR_UNKNOWN",
      retryAuthority: "NONE",
      preserve: true,
    });
    expect(JSON.stringify(storageFailure)).not.toContain("CAPACITY");
    expect(JSON.stringify(storageFailure)).not.toContain("secret");
    expect((error as Error).message).not.toContain("CAPACITY");
    expect((error as Error).message).not.toContain("secret");
    expect("cause" in (error as object)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(legacyCalls()).toBe(0);
  }
});

it("fails closed on a missing API or an old Main without any legacy call", async () => {
  for (const invoke of [
    undefined,
    async () => {
      throw new Error("no handler registered for folio:request:diagnostic-v1");
    },
  ]) {
    const { legacyCalls } = transport(async () => okReply({ present: false }));
    const request = writeRequest();
    const direct = createDiagnosticRequest(invoke);
    const error = await thrown(direct, request);
    expect(error).toBeInstanceOf(StorageFailureError);
    expect((error as StorageFailureError).storageFailure.kind).toBe("UNCLASSIFIED");
    expect(legacyCalls()).toBe(0);
  }
});

it("fails closed when the exposed object lacks the new API", async () => {
  let legacyCalls = 0;
  const folio = {
    request: async (request: Request): Promise<unknown> => {
      legacyCalls += 1;
      return request;
    },
  };
  const send = createDiagnosticRequest(
    (request: Request) =>
      (folio as { requestDiagnostic?: (input: Request) => Promise<unknown> }).requestDiagnostic?.(request),
  );
  const error = await thrown(send, writeRequest());
  expect(error).toBeInstanceOf(StorageFailureError);
  const storageFailure = (error as StorageFailureError).storageFailure;
  expect(storageFailure).toMatchObject({ kind: "UNCLASSIFIED", mutationDispatch: "UNPROVEN", proofOrigin: "NONE" });
  expect(legacyCalls).toBe(0);
});

it("rejects invalid versions, fields, mismatches, accessors and cycles as a local E", async () => {
  let getterCalls = 0;
  const cyclic: Record<string, unknown> = { ...unclassified() };
  cyclic.self = cyclic;
  const cyclicReply = { tag: "folio-request-result", version: 1, ok: false, failure: cyclic };
  const accessorReply: Record<string, unknown> = {
    tag: "folio-request-result",
    version: 1,
    valueSlot: { present: false },
  };
  Object.defineProperty(accessorReply, "ok", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return true;
    },
  });
  const accessorFailure: Record<string, unknown> = { ...unclassified() };
  Object.defineProperty(accessorFailure, "kind", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "UNCLASSIFIED";
    },
  });
  const accessorFailureReply = { tag: "folio-request-result", version: 1, ok: false, failure: accessorFailure };
  const badReplies: unknown[] = [
    { tag: "folio-request-result", version: 2, ok: true, valueSlot: { present: false } },
    { tag: "other", version: 1, ok: true, valueSlot: { present: false } },
    failureReply({ ...unclassified(), extra: 1 }),
    failureReply({ ...unclassified(), version: 2 }),
    failureReply({ ...unclassified(), kind: "NOT_A_KIND" }),
    failureReply(conflict({ requestType: "sync:run" })),
    cyclicReply,
    accessorFailureReply,
    accessorReply,
    { tag: "folio-request-result", version: 1, ok: true, valueSlot: { present: true } },
    { tag: "folio-request-result", version: 1, ok: true, valueSlot: { present: true, value: undefined } },
    undefined,
    null,
    "raw string",
  ];
  for (const reply of badReplies) {
    const { send, sent, legacyCalls } = transport(async () => reply);
    const error = await thrown(send, writeRequest());
    expect(error).toBeInstanceOf(StorageFailureError);
    expect((error as StorageFailureError).storageFailure).toMatchObject({
      kind: "UNCLASSIFIED",
      family: "REQUEST",
      mutationDispatch: "UNPROVEN",
      proofOrigin: "NONE",
      retryAuthority: "NONE",
      preserve: true,
    });
    expect(sent).toHaveLength(1);
    expect(legacyCalls()).toBe(0);
  }
  expect(getterCalls).toBe(0);
});

it("passes a valid nested blocked-read diagnostic and never remakes the result", async () => {
  const diagnostic = headCas({ requestType: "recovery:read" });
  const blocked: CrashRecoveryRead = {
    status: "blocked",
    generation: 0,
    message: crashRecoveryBlockedMessageV1(),
    storageFailure: diagnostic,
  };
  const { send } = transport(async () => okReply({ present: true, value: blocked }));
  const result = await send<CrashRecoveryRead>(readRequest);
  expect(result.status).toBe("blocked");
  expect(result.generation).toBe(0);
  expect(result.message).toBe(crashRecoveryBlockedMessageV1());
  expect(result.storageFailure).toEqual(diagnostic);
  expect(result.snapshot).toBeUndefined();
});

it("passes a blocked read without a diagnostic but rejects an invalid nested one", async () => {
  const without: CrashRecoveryRead = {
    status: "blocked",
    generation: 0,
    message: crashRecoveryBlockedMessageV1(),
  };
  {
    const { send } = transport(async () => okReply({ present: true, value: without }));
    const result = await send<CrashRecoveryRead>(readRequest);
    expect(result.status).toBe("blocked");
    expect(result.generation).toBe(0);
  }
  const mismatched = { ...without, storageFailure: conflict({ requestType: "recovery:write" }) };
  const malformed = { ...without, storageFailure: { kind: "UNCLASSIFIED" } };
  for (const value of [mismatched, malformed]) {
    const { send, legacyCalls } = transport(async () => okReply({ present: true, value }));
    const error = await thrown(send, readRequest);
    expect(error).toBeInstanceOf(StorageFailureError);
    expect((error as StorageFailureError).storageFailure).toMatchObject({
      kind: "UNCLASSIFIED",
      requestType: "recovery:read",
    });
    expect(legacyCalls()).toBe(0);
  }
  const accessor: Record<string, unknown> = { ...without };
  let calls = 0;
  Object.defineProperty(accessor, "storageFailure", {
    enumerable: true,
    get() {
      calls += 1;
      return conflict({ requestType: "recovery:read" });
    },
  });
  {
    // The accessor must be rejected without being executed, so it is handed to
    // the adapter inside a literal envelope rather than the JSON-roundtripped
    // helper, whose own serialization would run the getter first.
    const envelope = { tag: "folio-request-result", version: 1, ok: true, valueSlot: { present: true, value: accessor } };
    const { send, legacyCalls } = transport(async () => envelope);
    const error = await thrown(send, readRequest);
    expect(error).toBeInstanceOf(StorageFailureError);
    expect((error as StorageFailureError).storageFailure).toMatchObject({
      kind: "UNCLASSIFIED",
      requestType: "recovery:read",
    });
    expect(legacyCalls()).toBe(0);
  }
  expect(calls).toBe(0);
});

it("exposes validated diagnostics and local E builders for later units", async () => {
  const dto = capacity();
  const error = new StorageFailureError(dto);
  expect(error.storageFailure).toEqual(dto);
  expect(error.storageFailure).not.toBe(dto);
  expect(requestStorageFailure(error)).toEqual(dto);
  expect(requestStorageFailure(error, "recovery:write")).toEqual(dto);
  expect(requestStorageFailure(error, "recovery:read")).toBeUndefined();
  expect(requestStorageFailure(new Error("plain transport"))).toBeUndefined();
  expect(requestStorageFailure({ storageFailure: dto })).toEqual(dto);
  expect(requestStorageFailure({ storageFailure: { broken: true } })).toBeUndefined();
  const local = unclassifiedRequestFailure("recovery:write");
  expect(local).toMatchObject({
    kind: "UNCLASSIFIED",
    family: "REQUEST",
    mutationDispatch: "UNPROVEN",
    proofOrigin: "NONE",
    requestType: "recovery:write",
    preserve: true,
  });
  expect(unclassifiedRequestFailure("not:a-request").requestType).toBe("UNRECOGNIZED");
  const wrapped = toStorageFailureError(new Error("raw /Users/alice/secret cause"), "recovery:write");
  expect(wrapped).toBeInstanceOf(StorageFailureError);
  expect(wrapped.storageFailure.kind).toBe("UNCLASSIFIED");
  expect(wrapped.message).not.toContain("secret");
  const rewrapped = toStorageFailureError(error, "recovery:write");
  expect(rewrapped).toBeInstanceOf(StorageFailureError);
  expect(rewrapped).not.toBe(error);
  expect(rewrapped.storageFailure).toEqual(dto);
  expect(rewrapped.message).toBe(storageFailureMessageV1(dto));
});

it("fails closed on trap- and accessor-bearing carriers without executing them", () => {
  const secret = "/Users/alice/secret";
  const hostile = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error(`getPrototypeOf trap ${secret}`);
      },
      getOwnPropertyDescriptor() {
        throw new Error(`descriptor trap ${secret}`);
      },
      get() {
        throw new Error(`get trap ${secret}`);
      },
    },
  );
  expect(requestStorageFailure(hostile)).toBeUndefined();
  const wrapped = toStorageFailureError(hostile, "recovery:write");
  expect(wrapped).toBeInstanceOf(StorageFailureError);
  expect(wrapped.storageFailure).toMatchObject({
    kind: "UNCLASSIFIED",
    family: "REQUEST",
    mutationDispatch: "UNPROVEN",
    proofOrigin: "NONE",
    requestType: "recovery:write",
  });
  expect(wrapped.message).not.toContain("secret");
  expect(wrapped.message).not.toContain("trap");
  expect("cause" in wrapped).toBe(false);

  let getterCalls = 0;
  const accessorCarrier = new StorageFailureError(capacity());
  Object.defineProperty(accessorCarrier, "storageFailure", {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      throw new Error(`storageFailure getter ${secret}`);
    },
  });
  expect(requestStorageFailure(accessorCarrier)).toBeUndefined();
  expect(getterCalls).toBe(0);
  const accessorSafe = toStorageFailureError(accessorCarrier, "recovery:read");
  expect(accessorSafe).toBeInstanceOf(StorageFailureError);
  expect(accessorSafe).not.toBe(accessorCarrier);
  expect(accessorSafe.storageFailure).toMatchObject({
    kind: "UNCLASSIFIED",
    requestType: "recovery:read",
  });
  expect(getterCalls).toBe(0);

  const carried = capacity();
  const trapCarrier = new Proxy(
    {},
    {
      getOwnPropertyDescriptor(_target, property) {
        if (property === "storageFailure") {
          return { value: carried, enumerable: true, writable: true, configurable: true };
        }
        return undefined;
      },
      get() {
        getterCalls += 1;
        throw new Error(`get trap ${secret}`);
      },
    },
  );
  expect(requestStorageFailure(trapCarrier, "recovery:write")).toEqual(carried);
  expect(getterCalls).toBe(0);
});

it("revalidates carried diagnostics against the expected request type every call", () => {
  const foreign = new StorageFailureError(capacity({ requestType: "recovery:read" }));
  expect(requestStorageFailure(foreign, "recovery:write")).toBeUndefined();
  expect(requestStorageFailure(foreign, "recovery:read")).toEqual(capacity({ requestType: "recovery:read" }));
  const demoted = toStorageFailureError(foreign, "recovery:write");
  expect(demoted).toBeInstanceOf(StorageFailureError);
  expect(demoted).not.toBe(foreign);
  expect(demoted.storageFailure).toMatchObject({
    kind: "UNCLASSIFIED",
    family: "REQUEST",
    mutationDispatch: "UNPROVEN",
    proofOrigin: "NONE",
    requestType: "recovery:write",
  });

  expect(
    requestStorageFailure({ storageFailure: conflict({ requestType: "recovery:read" }) }, "recovery:write"),
  ).toBeUndefined();
  const transientSafe = toStorageFailureError(
    { storageFailure: headCas({ requestType: "recovery:read" }) },
    "recovery:write",
  );
  expect(transientSafe.storageFailure).toMatchObject({ kind: "UNCLASSIFIED", requestType: "recovery:write" });

  const mutated = new StorageFailureError(conflict());
  (mutated as { storageFailure: unknown }).storageFailure = { kind: "GENERATION_CONFLICT" };
  const mutatedSafe = toStorageFailureError(mutated, "recovery:write");
  expect(mutatedSafe).not.toBe(mutated);
  expect(mutatedSafe.storageFailure).toMatchObject({ kind: "UNCLASSIFIED", requestType: "recovery:write" });
  const swapped = new StorageFailureError(capacity());
  (swapped as { storageFailure: unknown }).storageFailure = conflict({ requestType: "recovery:read" });
  expect(toStorageFailureError(swapped, "recovery:write").storageFailure).toMatchObject({
    kind: "UNCLASSIFIED",
    requestType: "recovery:write",
  });

  const matching = new StorageFailureError(conflict());
  const matchingWrapped = toStorageFailureError(matching, "recovery:write");
  expect(matchingWrapped).not.toBe(matching);
  expect(matchingWrapped.storageFailure).toEqual(conflict());
  expect(matchingWrapped.message).toBe(storageFailureMessageV1(conflict()));
  const carried = toStorageFailureError({ storageFailure: headCas() }, "recovery:write");
  expect(carried.storageFailure).toEqual(headCas());
  const unrecognized = unclassified({ requestType: "UNRECOGNIZED" });
  expect(toStorageFailureError({ storageFailure: unrecognized }, "recovery:write").storageFailure).toEqual(
    unrecognized,
  );
});

it("rewraps a validated diagnostic as a fresh safe error, never raw message or identity", () => {
  const secret = "/Users/alice/secret";
  // A local error whose DTO still validates but whose message was replaced by
  // raw transport text is re-wrapped, not returned.
  const mutatedMessage = new StorageFailureError(capacity());
  mutatedMessage.message = `raw transport ${secret}`;
  const rewrapped = toStorageFailureError(mutatedMessage, "recovery:write");
  expect(rewrapped).toBeInstanceOf(StorageFailureError);
  expect(rewrapped).not.toBe(mutatedMessage);
  expect(rewrapped.storageFailure).toEqual(capacity());
  expect(rewrapped.message).toBe(storageFailureMessageV1(capacity()));
  expect(rewrapped.message).not.toContain("secret");
  expect("cause" in rewrapped).toBe(false);

  // A message accessor on the carrier is never executed or propagated. The
  // zero count is asserted before the carrier reaches expect formatting,
  // which itself may read .message off an Error-shaped argument.
  let getterCalls = 0;
  const getterCarrier = new StorageFailureError(conflict());
  Object.defineProperty(getterCarrier, "message", {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return `getter message ${secret}`;
    },
  });
  expect(requestStorageFailure(getterCarrier, "recovery:write")).toEqual(conflict());
  const getterSafe = toStorageFailureError(getterCarrier, "recovery:write");
  expect(getterCalls).toBe(0);
  expect(getterSafe).not.toBe(getterCarrier);
  expect(getterSafe.storageFailure).toEqual(conflict());
  expect(getterSafe.message).toBe(storageFailureMessageV1(conflict()));
  expect(getterSafe.message).not.toContain("secret");

  // A foreign object spoofing the class prototype plus a valid own DTO, a raw
  // message and a cause is re-wrapped into a safe error, never trusted by
  // identity.
  const spoof = Object.create(StorageFailureError.prototype) as StorageFailureError;
  Object.defineProperty(spoof, "storageFailure", {
    value: headCas(),
    enumerable: true,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(spoof, "message", {
    value: `spoofed message ${secret}`,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(spoof, "cause", {
    value: { path: secret },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const spoofSafe = toStorageFailureError(spoof, "recovery:write");
  expect(spoofSafe).toBeInstanceOf(StorageFailureError);
  expect(spoofSafe).not.toBe(spoof);
  expect(spoofSafe.storageFailure).toEqual(headCas());
  expect(spoofSafe.message).toBe(storageFailureMessageV1(headCas()));
  expect(spoofSafe.message).not.toContain("secret");
  expect("cause" in spoofSafe).toBe(false);
});

it("reads the expected request type without executing request accessors or traps", async () => {
  let getterCalls = 0;
  const getterRequest = {} as Request;
  Object.defineProperty(getterRequest, "type", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("type getter");
    },
  });
  {
    const { send, sent, legacyCalls } = transport(async () => okReply({ present: false }));
    expect(await send(getterRequest)).toBeUndefined();
    expect(sent).toEqual([getterRequest]);
    expect(legacyCalls()).toBe(0);
    expect(getterCalls).toBe(0);
  }
  const proxyRequest = new Proxy(
    { type: "recovery:write" },
    {
      getPrototypeOf() {
        throw new Error("proto trap");
      },
      getOwnPropertyDescriptor() {
        throw new Error("descriptor trap");
      },
      get() {
        throw new Error("get trap");
      },
    },
  ) as Request;
  const { send, sent, legacyCalls } = transport(async () => failureReply(capacity()));
  const error = await thrown(send, proxyRequest);
  expect(error).toBeInstanceOf(StorageFailureError);
  expect((error as StorageFailureError).storageFailure).toMatchObject({
    kind: "UNCLASSIFIED",
    requestType: "UNRECOGNIZED",
  });
  expect(sent).toHaveLength(1);
  expect(legacyCalls()).toBe(0);
});

it("runs an optional success decoder before the value crosses the async return", async () => {
  const rawEnvelope = (value: unknown): unknown =>
    ({
      tag: "folio-request-result",
      version: 1,
      ok: true,
      valueSlot: { present: true, value },
    }) as const;
  // An own `then` accessor on the success value is handed to the decoder as
  // raw data: it never reaches promise assimilation.
  let getterCalls = 0;
  const getterValue: Record<string, unknown> = { payload: 1 };
  Object.defineProperty(getterValue, "then", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return undefined;
    },
  });
  {
    const { send, sent, legacyCalls } = transport(async () => rawEnvelope(getterValue));
    const decoded = await send<{ ok: boolean }>(writeRequest(), (value) => {
      expect(value).toBe(getterValue);
      return { ok: true };
    });
    expect(decoded).toEqual({ ok: true });
    expect(getterCalls).toBe(0);
    expect(sent).toHaveLength(1);
    expect(legacyCalls()).toBe(0);
  }
  // An own `then` function that never settles would assimilate and pend at
  // the bare async return; the decoder replaces it before that boundary.
  let thenCalls = 0;
  const neverValue = {
    payload: 2,
    then() {
      thenCalls += 1;
    },
  };
  {
    const { send, sent, legacyCalls } = transport(async () => rawEnvelope(neverValue));
    const decoded = await send<string>(writeRequest(), () => "decoded");
    expect(decoded).toBe("decoded");
    expect(thenCalls).toBe(0);
    expect(sent).toHaveLength(1);
    expect(legacyCalls()).toBe(0);
  }
});

it("hands an absent value slot to the decoder as undefined and keeps falsy decoding explicit", async () => {
  {
    const { send, sent, legacyCalls } = transport(async () => okReply({ present: false }));
    let observed: unknown = "unset";
    const decoded = await send<string>(writeRequest(), (value) => {
      observed = value;
      return "decoded-absent";
    });
    expect(observed).toBeUndefined();
    expect(decoded).toBe("decoded-absent");
    expect(sent).toHaveLength(1);
    expect(legacyCalls()).toBe(0);
  }
  {
    const { send } = transport(async () => okReply({ present: true, value: null }));
    let observed: unknown = "unset";
    const decoded = await send<string>(writeRequest(), (value) => {
      observed = value;
      return "decoded-null";
    });
    expect(observed).toBeNull();
    expect(decoded).toBe("decoded-null");
  }
});

it("closes a decoder throw to the actual request type and preserves a matching diagnostic", async () => {
  {
    const { send, sent, legacyCalls } = transport(async () =>
      okReply({ present: true, value: { bad: true } }),
    );
    let calls = 0;
    const error = await send(writeRequest(), () => {
      calls += 1;
      throw new Error("raw decoder /Users/alice/secret");
    }).then(
      () => {
        throw new Error("unexpected success");
      },
      (error: unknown) => error,
    );
    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(StorageFailureError);
    const failure = (error as StorageFailureError).storageFailure;
    expect(failure).toMatchObject({
      kind: "UNCLASSIFIED",
      requestType: "recovery:write",
      retryAuthority: "NONE",
      preserve: true,
    });
    expect((error as Error).message).not.toContain("secret");
    expect(sent).toHaveLength(1);
    expect(legacyCalls()).toBe(0);
  }
  {
    // A decoder diagnostic for another request type is demoted, while one
    // for the actual request type is preserved in content.
    const { send } = transport(async () => okReply({ present: true, value: 1 }));
    const foreign = await send(writeRequest(), () => {
      throw new StorageFailureError(capacity({ requestType: "recovery:read" }));
    }).then(
      () => {
        throw new Error("unexpected success");
      },
      (error: unknown) => error,
    );
    expect(foreign).toBeInstanceOf(StorageFailureError);
    expect((foreign as StorageFailureError).storageFailure).toMatchObject({
      kind: "UNCLASSIFIED",
      requestType: "recovery:write",
    });
    const { send: matching } = transport(async () =>
      okReply({ present: true, value: 1 }),
    );
    const matchingError = await matching(writeRequest(), () => {
      throw new StorageFailureError(conflict());
    }).then(
      () => {
        throw new Error("unexpected success");
      },
      (error: unknown) => error,
    );
    expect(matchingError).toBeInstanceOf(StorageFailureError);
    expect((matchingError as StorageFailureError).storageFailure).toEqual(conflict());
  }
});

it("never runs the success decoder on a typed failure reply and keeps the no-decoder default opaque", async () => {
  const dto = capacity();
  {
    const { send, sent, legacyCalls } = transport(async () => failureReply(dto));
    let calls = 0;
    const error = await send(writeRequest(), () => {
      calls += 1;
      return "unreachable";
    }).then(
      () => {
        throw new Error("unexpected success");
      },
      (error: unknown) => error,
    );
    expect(calls).toBe(0);
    expect(error).toBeInstanceOf(StorageFailureError);
    expect((error as StorageFailureError).storageFailure).toEqual(dto);
    expect(sent).toHaveLength(1);
    expect(legacyCalls()).toBe(0);
  }
  // With no decoder the success value stays opaque exactly as before: falsy
  // and void values pass through, and an unchecked callable `then` is still
  // assimilated by the promise machinery — the decoder is an opt-in
  // boundary, not a new default.
  for (const value of [null, false, 0, ""] as const) {
    const { send } = transport(async () => okReply({ present: true, value }));
    expect(await send(writeRequest())).toBe(value);
  }
  {
    const { send } = transport(async () => okReply({ present: false }));
    expect(await send(writeRequest())).toBeUndefined();
  }
  let thenCalls = 0;
  const thenable = {
    then() {
      thenCalls += 1;
    },
  };
  {
    const { send } = transport(
      async () =>
        ({
          tag: "folio-request-result",
          version: 1,
          ok: true,
          valueSlot: { present: true, value: thenable },
        }) as const,
    );
    const outcome = await Promise.race([
      send(writeRequest()),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    expect(outcome).toBe("pending");
    expect(thenCalls).toBe(1);
  }
});
