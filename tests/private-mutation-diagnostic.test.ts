import { describe, expect, it } from "vitest";
import {
  armKReserveObservation,
  consumeKReserveObservation,
  consumePrivateMutationChannel,
  createPrivateMutationChannel,
  enterPrivateMutationChannel,
  sealPrivateMutationChannel,
  getCheckpointCapacityRefusal,
  getCheckpointGenerationConflict,
  getCheckpointPostPublicationUnknown,
  getKCapacityRefusal,
  getKMutationFailure,
  getKReserveFailure,
  getRecoveryIoFailureCause,
  observeKReserveInvocation,
  propagateCheckpointGenerationConflict,
  propagateRecoveryIoFailure,
  recordCheckpointCapacityRefusal,
  recordCheckpointGenerationConflict,
  recordCheckpointPortPreconditionConflict,
  recordCheckpointPostPublicationUnknown,
  recordKCapacityRefusal,
  recordKMutationFailure,
  recordKReserveFailure,
  rememberRecoveryIoFailure,
  type KMutationFailure,
  type KReserveObservationFacts,
} from "../src/platform/private-mutation-diagnostic";

const ID = "a".repeat(32);

describe("private mutation terminal-only contracts", () => {
  function entered() {
    const channel = createPrivateMutationChannel();
    const entry = enterPrivateMutationChannel(channel);
    if (entry === undefined) throw new Error("expected entry");
    return { channel, entry };
  }

  it("matches exact terminal tags and values once", () => {
    const returnedUndefined = entered();
    sealPrivateMutationChannel(returnedUndefined.channel, returnedUndefined.entry, "RETURNED", undefined);
    expect(consumePrivateMutationChannel(returnedUndefined.channel, "RETURNED", undefined)).toBe(returnedUndefined.entry);
    expect(consumePrivateMutationChannel(returnedUndefined.channel, "RETURNED", undefined)).toBeUndefined();
    expect(enterPrivateMutationChannel(returnedUndefined.channel)).toBeUndefined();
    sealPrivateMutationChannel(returnedUndefined.channel, returnedUndefined.entry, "RETURNED", "late");
    expect(consumePrivateMutationChannel(returnedUndefined.channel, "RETURNED", "late")).toBeUndefined();
    expect(Object.isFrozen(returnedUndefined.entry)).toBe(true);

    const threwUndefined = entered();
    sealPrivateMutationChannel(threwUndefined.channel, threwUndefined.entry, "THREW", undefined);
    expect(consumePrivateMutationChannel(threwUndefined.channel, "THREW", undefined)).toBe(threwUndefined.entry);

    const tagMismatch = entered();
    sealPrivateMutationChannel(tagMismatch.channel, tagMismatch.entry, "RETURNED", undefined);
    expect(consumePrivateMutationChannel(tagMismatch.channel, "THREW", undefined)).toBeUndefined();
    expect(consumePrivateMutationChannel(tagMismatch.channel, "RETURNED", undefined)).toBeUndefined();

    const unsealed = entered();
    expect(consumePrivateMutationChannel(unsealed.channel, "RETURNED", undefined)).toBeUndefined();
    expect(enterPrivateMutationChannel(unsealed.channel)).toBeUndefined();

    const nan = entered();
    sealPrivateMutationChannel(nan.channel, nan.entry, "RETURNED", Number.NaN);
    expect(consumePrivateMutationChannel(nan.channel, "RETURNED", Number.NaN)).toBe(nan.entry);

    const negativeZero = entered();
    sealPrivateMutationChannel(negativeZero.channel, negativeZero.entry, "RETURNED", -0);
    expect(consumePrivateMutationChannel(negativeZero.channel, "RETURNED", 0)).toBeUndefined();

    const sameObject = {};
    const identity = entered();
    sealPrivateMutationChannel(identity.channel, identity.entry, "RETURNED", sameObject);
    expect(consumePrivateMutationChannel(identity.channel, "RETURNED", sameObject)).toBe(identity.entry);

    const clone = entered();
    sealPrivateMutationChannel(clone.channel, clone.entry, "RETURNED", sameObject);
    expect(consumePrivateMutationChannel(clone.channel, "RETURNED", { ...sameObject })).toBeUndefined();
  });

  it("mints distinct empty frozen opaque handles", () => {
    const first = entered();
    const second = entered();
    for (const handle of [first.channel, first.entry, second.channel, second.entry]) {
      expect(Object.isFrozen(handle)).toBe(true);
      expect(Object.keys(handle)).toEqual([]);
      expect(Reflect.ownKeys(handle)).toEqual([]);
      expect(getCheckpointPostPublicationUnknown(handle)).toBeUndefined();
      expect(getCheckpointGenerationConflict(handle)).toBeUndefined();
    }
    expect(first.channel).not.toBe(first.entry);
    expect(first.entry).not.toBe(second.entry);
    expect(enterPrivateMutationChannel(first.entry)).toBeUndefined();
  });

  it("permanently fails closed across one-shot transitions", () => {
    type PoisonCase = {
      readonly name: string;
      readonly make: () => { readonly channel: unknown; readonly entry: unknown };
      readonly poison: (channel: unknown, entry: unknown) => void;
    };
    const armed = (): { channel: unknown; entry: unknown } => ({ channel: createPrivateMutationChannel(), entry: undefined });
    const cases: readonly PoisonCase[] = [
      { name: "armed seal", make: armed, poison: (channel, entry) => sealPrivateMutationChannel(channel, entry, "RETURNED", 1) },
      { name: "armed consume", make: armed, poison: (channel) => consumePrivateMutationChannel(channel, "RETURNED", 1) },
      { name: "entered early consume", make: entered, poison: (channel) => consumePrivateMutationChannel(channel, "RETURNED", "early") },
      { name: "active reenter", make: entered, poison: (channel) => enterPrivateMutationChannel(channel) },
      { name: "sealed reenter", make: entered, poison: (channel, entry) => { sealPrivateMutationChannel(channel, entry, "RETURNED", 1); enterPrivateMutationChannel(channel); } },
      { name: "duplicate seal", make: entered, poison: (channel, entry) => { sealPrivateMutationChannel(channel, entry, "RETURNED", 1); sealPrivateMutationChannel(channel, entry, "RETURNED", 1); } },
      { name: "wrong entry seal", make: entered, poison: (channel) => sealPrivateMutationChannel(channel, {}, "RETURNED", 1) },
      { name: "invalid tag seal", make: entered, poison: (channel, entry) => sealPrivateMutationChannel(channel, entry, "OTHER", 1) },
      { name: "invalid tag consume", make: entered, poison: (channel, entry) => { sealPrivateMutationChannel(channel, entry, "RETURNED", 1); consumePrivateMutationChannel(channel, "OTHER", 1); } },
      { name: "mismatched tag consume", make: entered, poison: (channel, entry) => { sealPrivateMutationChannel(channel, entry, "RETURNED", 1); consumePrivateMutationChannel(channel, "THREW", 1); } },
      { name: "mismatched value consume", make: entered, poison: (channel, entry) => { sealPrivateMutationChannel(channel, entry, "RETURNED", 1); consumePrivateMutationChannel(channel, "RETURNED", 2); } },
    ];
    for (const testCase of cases) {
      const directOriginal = testCase.make();
      testCase.poison(directOriginal.channel, directOriginal.entry);
      expect(consumePrivateMutationChannel(directOriginal.channel, "RETURNED", 1), `${testCase.name} direct original terminal`).toBeUndefined();
      expect(enterPrivateMutationChannel(directOriginal.channel), `${testCase.name} direct late enter`).toBeUndefined();
      sealPrivateMutationChannel(directOriginal.channel, directOriginal.entry, "RETURNED", "late");
      expect(consumePrivateMutationChannel(directOriginal.channel, "RETURNED", "late"), `${testCase.name} direct late consume`).toBeUndefined();

      const enteredRecovery = testCase.make();
      testCase.poison(enteredRecovery.channel, enteredRecovery.entry);
      sealPrivateMutationChannel(enteredRecovery.channel, enteredRecovery.entry, "RETURNED", 1);
      expect(consumePrivateMutationChannel(enteredRecovery.channel, "RETURNED", 1), `${testCase.name} entered recovery`).toBeUndefined();
      expect(enterPrivateMutationChannel(enteredRecovery.channel), `${testCase.name} entered recovery late enter`).toBeUndefined();

      const armedProbe = testCase.make();
      testCase.poison(armedProbe.channel, armedProbe.entry);
      expect(enterPrivateMutationChannel(armedProbe.channel), `${testCase.name} armed probe`).toBeUndefined();
      sealPrivateMutationChannel(armedProbe.channel, armedProbe.entry, "RETURNED", "late");
      expect(consumePrivateMutationChannel(armedProbe.channel, "RETURNED", "late"), `${testCase.name} armed probe late consume`).toBeUndefined();
    }
  });

  it("keeps channels independent across foreign and nested entries", () => {
    const first = entered();
    const second = entered();
    sealPrivateMutationChannel(first.channel, second.entry, "RETURNED", 1);
    expect(enterPrivateMutationChannel(first.channel)).toBeUndefined();
    expect(consumePrivateMutationChannel(first.channel, "RETURNED", 1)).toBeUndefined();
    sealPrivateMutationChannel(second.channel, second.entry, "RETURNED", 2);
    expect(consumePrivateMutationChannel(second.channel, "RETURNED", 2)).toBe(second.entry);

    const nestedOne = entered();
    const nestedTwo = entered();
    sealPrivateMutationChannel(nestedOne.channel, nestedOne.entry, "THREW", nestedOne.entry);
    sealPrivateMutationChannel(nestedTwo.channel, nestedTwo.entry, "RETURNED", nestedTwo.channel);
    expect(consumePrivateMutationChannel(nestedOne.channel, "THREW", nestedOne.entry)).toBe(nestedOne.entry);
    expect(consumePrivateMutationChannel(nestedTwo.channel, "RETURNED", nestedTwo.channel)).toBe(nestedTwo.entry);
  });

  it("rejects forged, primitive, clone and proxy handles without side effects", () => {
    const actualH = createPrivateMutationChannel();
    let traps = 0;
    const hostileProxy = new Proxy(actualH, {
      get() { traps += 1; throw new Error("unexpected get"); },
      has() { traps += 1; throw new Error("unexpected has"); },
      ownKeys() { traps += 1; throw new Error("unexpected ownKeys"); },
    });
    const cloneSource = createPrivateMutationChannel();
    const invalidChannels: readonly unknown[] = [null, undefined, 0, "channel", {}, { ...cloneSource }, hostileProxy];
    for (const invalid of invalidChannels) {
      expect(enterPrivateMutationChannel(invalid)).toBeUndefined();
    }
    expect(traps).toBe(0);

    const target = entered();
    expect(enterPrivateMutationChannel(target.entry)).toBeUndefined();
    sealPrivateMutationChannel(target.channel, target.channel, "RETURNED", 1);
    expect(enterPrivateMutationChannel(target.channel)).toBeUndefined();
    expect(consumePrivateMutationChannel(target.channel, "RETURNED", 1)).toBeUndefined();

    const unaffected = entered();
    for (const invalid of invalidChannels) {
      sealPrivateMutationChannel(invalid, unaffected.entry, "RETURNED", 1);
      expect(consumePrivateMutationChannel(invalid, "RETURNED", 1)).toBeUndefined();
    }
    expect(traps).toBe(0);
    sealPrivateMutationChannel(unaffected.channel, unaffected.entry, "RETURNED", 1);
    expect(consumePrivateMutationChannel(unaffected.channel, "RETURNED", 1)).toBe(unaffected.entry);

    const actualEntry = enterPrivateMutationChannel(actualH);
    if (actualEntry === undefined) throw new Error("expected entry");
    sealPrivateMutationChannel(actualH, actualEntry, "RETURNED", "late");
    expect(consumePrivateMutationChannel(actualH, "RETURNED", "late")).toBe(actualEntry);
  });

  it("passes hostile thenable values through without touching them", () => {
    let accesses = 0;
    const thenable = {
      get then() { accesses += 1; throw new Error("then getter"); },
      get cause() { accesses += 1; throw new Error("cause getter"); },
      get errors() { accesses += 1; throw new Error("errors getter"); },
      get toJSON() { accesses += 1; throw new Error("toJSON getter"); },
      [Symbol.toPrimitive]() { accesses += 1; throw new Error("coercion"); },
    };
    const { channel, entry } = entered();
    sealPrivateMutationChannel(channel, entry, "RETURNED", thenable);
    expect(consumePrivateMutationChannel(channel, "RETURNED", thenable)).toBe(entry);
    expect(accesses).toBe(0);
    expect(Object.isFrozen(thenable)).toBe(false);
    expect(Object.isExtensible(thenable)).toBe(true);
  });
});

describe("checkpoint post-publication exact-identity sidecar", () => {
  it("records both stages with the exact fixed shape and deep freeze", () => {
    for (const stage of ["HEAD_CAS", "READBACK"] as const) {
      const error = {};
      recordCheckpointPostPublicationUnknown(error, ID, stage);
      const postPublication = getCheckpointPostPublicationUnknown(error)!;
      expect(postPublication).toEqual({
        kind: "OUTCOME_UNKNOWN",
        family: "CHECKPOINT",
        stage,
        failureSubject: "CURRENT_ATTEMPT",
        mutationDispatch: "DISPATCHED",
        proofOrigin: "DISPATCH_OBSERVED",
        attemptId: ID,
        sourceOutcome: {
          source: "RECOVERY_IO",
          contractVersion: 3,
          state: "PUBLISHED",
          reason: null,
        },
      });
      expect(Object.isFrozen(postPublication)).toBe(true);
      expect(Object.isFrozen(postPublication.sourceOutcome)).toBe(true);
    }
  });

  it("preserves the first valid association and rejects invalid inputs", () => {
    const error = {};
    recordCheckpointPostPublicationUnknown(error, ID, "HEAD_CAS");
    recordCheckpointPostPublicationUnknown(error, "b".repeat(32), "READBACK");
    expect(getCheckpointPostPublicationUnknown(error)).toMatchObject({
      attemptId: ID,
      stage: "HEAD_CAS",
    });

    for (const invalid of ["A".repeat(32), "a".repeat(31), "g".repeat(32), ""]) {
      const other = {};
      recordCheckpointPostPublicationUnknown(other, invalid, "READBACK");
      expect(getCheckpointPostPublicationUnknown(other)).toBeUndefined();
    }

    const badStage = {};
    recordCheckpointPostPublicationUnknown(badStage, ID, "OTHER" as unknown as "HEAD_CAS");
    expect(getCheckpointPostPublicationUnknown(badStage)).toBeUndefined();

    const invalidObject = "POST_PUBLISHED" as unknown as object;
    expect(() => recordCheckpointPostPublicationUnknown(invalidObject, ID, "HEAD_CAS")).not.toThrow();
    expect(getCheckpointPostPublicationUnknown(invalidObject)).toBeUndefined();
  });

  it("cannot be forged by clones, JSON, proxies, causes, aggregates or primitives", () => {
    const tagged = {};
    recordCheckpointPostPublicationUnknown(tagged, ID, "READBACK");
    const postPublication = getCheckpointPostPublicationUnknown(tagged)!;
    expect(getCheckpointPostPublicationUnknown({ ...postPublication })).toBeUndefined();
    expect(getCheckpointPostPublicationUnknown(JSON.parse(JSON.stringify(postPublication)))).toBeUndefined();
    expect(getCheckpointPostPublicationUnknown(new Proxy(tagged, {}))).toBeUndefined();
    expect(getCheckpointPostPublicationUnknown(new Error("PUBLISHED", { cause: tagged }))).toBeUndefined();
    expect(getCheckpointPostPublicationUnknown(new AggregateError([tagged], "PUBLISHED"))).toBeUndefined();
    expect(getCheckpointPostPublicationUnknown(null)).toBeUndefined();
    expect(getCheckpointPostPublicationUnknown("POST_PUBLISHED")).toBeUndefined();
  });

  it("never reads hostile error getters and leaves unrelated getters undefined", () => {
    const hostile = Object.defineProperties({}, {
      code: { get() { throw new Error("code getter"); } },
      message: { get() { throw new Error("message getter"); } },
      cause: { get() { throw new Error("cause getter"); } },
      errors: { get() { throw new Error("errors getter"); } },
    });
    expect(() => recordCheckpointPostPublicationUnknown(hostile, ID, "HEAD_CAS")).not.toThrow();
    expect(getCheckpointPostPublicationUnknown(hostile)).toMatchObject({
      attemptId: ID,
      stage: "HEAD_CAS",
    });
    expect(getCheckpointCapacityRefusal(hostile)).toBeUndefined();
    expect(getCheckpointGenerationConflict(hostile)).toBeUndefined();
  });
});

describe("checkpoint capacity exact-identity sidecar", () => {
  it("records a frozen diagnostic and frozen cause array without inspecting the error", () => {
    const error = {};
    recordCheckpointCapacityRefusal(error, ID);
    const refusal = getCheckpointCapacityRefusal(error)!;
    expect(refusal).toMatchObject({
      kind: "PRE_DISPATCH_CAPACITY", family: "CHECKPOINT", stage: "RESERVE",
      failureSubject: "CURRENT_ATTEMPT", mutationDispatch: "NOT_DISPATCHED_PROVEN",
      proofOrigin: "LOCAL_ADMISSION_GUARD", attemptId: ID,
      sourceCauseCodes: ["WINDOWS_RECOVERY_ARCHIVE_CAPACITY"],
    });
    expect(Object.isFrozen(refusal)).toBe(true);
    expect(Object.isFrozen(refusal.sourceCauseCodes)).toBe(true);
    const hostile = Object.defineProperty({}, "message", {
      get() { throw new Error("getter must not run"); },
    });
    expect(() => recordCheckpointCapacityRefusal(hostile, ID)).not.toThrow();
  });

  it("preserves the first association and ignores invalid ids", () => {
    const error = {};
    recordCheckpointCapacityRefusal(error, ID);
    recordCheckpointCapacityRefusal(error, "b".repeat(32));
    expect(getCheckpointCapacityRefusal(error)!.attemptId).toBe(ID);
    for (const invalid of ["A".repeat(32), "a".repeat(31), "g".repeat(32), ""]) {
      const other = {};
      recordCheckpointCapacityRefusal(other, invalid);
      expect(getCheckpointCapacityRefusal(other)).toBeUndefined();
    }
  });

  it("cannot be forged by primitives, clones, JSON, plain errors, aggregates or proxies", () => {
    const tagged = {};
    recordCheckpointCapacityRefusal(tagged, ID);
    const refusal = getCheckpointCapacityRefusal(tagged)!;
    expect(getCheckpointCapacityRefusal({ ...refusal })).toBeUndefined();
    expect(getCheckpointCapacityRefusal(JSON.parse(JSON.stringify(refusal)))).toBeUndefined();
    expect(getCheckpointCapacityRefusal(new Error("WINDOWS_RECOVERY_ARCHIVE_CAPACITY"))).toBeUndefined();
    expect(getCheckpointCapacityRefusal(new AggregateError([tagged], "WINDOWS_RECOVERY_ARCHIVE_CAPACITY"))).toBeUndefined();
    expect(getCheckpointCapacityRefusal(new Proxy(tagged, {}))).toBeUndefined();
    expect(getCheckpointCapacityRefusal(new Error("WINDOWS_RECOVERY_ARCHIVE_CAPACITY", { cause: tagged }))).toBeUndefined();
    expect(getCheckpointCapacityRefusal(null)).toBeUndefined();
    expect(getCheckpointCapacityRefusal("checkpoint")).toBeUndefined();
  });

  it("never invokes getters while retrieving", () => {
    const hostile = Object.defineProperties({}, {
      code: { get() { throw new Error("code getter"); } },
      message: { get() { throw new Error("message getter"); } },
      cause: { get() { throw new Error("cause getter"); } },
      errors: { get() { throw new Error("errors getter"); } },
    });
    expect(getCheckpointCapacityRefusal(hostile)).toBeUndefined();
    expect(getRecoveryIoFailureCause(hostile)).toBeUndefined();
  });
});

describe("checkpoint generation conflict exact-identity sidecar", () => {
  it("records a frozen precondition diagnostic without inspecting the error", () => {
    const error = {};
    recordCheckpointGenerationConflict(error, 7, 4);
    const conflict = getCheckpointGenerationConflict(error)!;
    expect(conflict).toMatchObject({
      kind: "GENERATION_CONFLICT", family: "CHECKPOINT", stage: "PRECONDITION",
      failureSubject: "CURRENT_ATTEMPT", mutationDispatch: "NOT_DISPATCHED_PROVEN",
      proofOrigin: "VALIDATED_PRECONDITION", attemptId: null,
      sourceCauseCodes: ["CHECKPOINT_PRECONDITION_MISMATCH"],
      precondition: {
        expectedGeneration: 7,
        observedActualGeneration: 4,
        mismatch: "GENERATION",
      },
    });
    expect(Object.isFrozen(conflict)).toBe(true);
    expect(Object.isFrozen(conflict.sourceCauseCodes)).toBe(true);
    expect(Object.isFrozen(conflict.precondition)).toBe(true);
    const hostile = Object.defineProperties({}, {
      message: { get() { throw new Error("message getter must not run"); } },
      code: { get() { throw new Error("code getter must not run"); } },
      cause: { get() { throw new Error("cause getter must not run"); } },
      errors: { get() { throw new Error("errors getter must not run"); } },
    });
    expect(() => recordCheckpointGenerationConflict(hostile, 1, 0)).not.toThrow();
    expect(getCheckpointGenerationConflict(hostile)).toBeDefined();
  });

  it("preserves the first association and validates both counters", () => {
    const error = {};
    recordCheckpointGenerationConflict(error, 1, 2);
    recordCheckpointGenerationConflict(error, 3, 4);
    expect(getCheckpointGenerationConflict(error)!.precondition).toEqual({
      expectedGeneration: 1,
      observedActualGeneration: 2,
      mismatch: "GENERATION",
    });
    for (const [expected, observed] of [
      [-1, 1], [1, -1], [1.5, 2], [1, 1], [Number.MAX_SAFE_INTEGER, 0],
      [Number.NaN, 1], [0, Number.POSITIVE_INFINITY],
    ] as const) {
      const other = {};
      recordCheckpointGenerationConflict(other, expected, observed);
      expect(getCheckpointGenerationConflict(other)).toBeUndefined();
    }
  });

  it("does not propagate through clones, plain errors, causes, aggregates or proxies", () => {
    const tagged = {};
    recordCheckpointGenerationConflict(tagged, 3, 0);
    const conflict = getCheckpointGenerationConflict(tagged)!;
    expect(getCheckpointGenerationConflict({ ...conflict })).toBeUndefined();
    expect(getCheckpointGenerationConflict(JSON.parse(JSON.stringify(conflict)))).toBeUndefined();
    expect(getCheckpointGenerationConflict(new Error("CHECKPOINT_PRECONDITION_MISMATCH"))).toBeUndefined();
    expect(getCheckpointGenerationConflict(new AggregateError([tagged], "CHECKPOINT_PRECONDITION_MISMATCH"))).toBeUndefined();
    expect(getCheckpointGenerationConflict(new Proxy(tagged, {}))).toBeUndefined();
    expect(getCheckpointGenerationConflict(new Error("CHECKPOINT_PRECONDITION_MISMATCH", { cause: tagged }))).toBeUndefined();
    expect(getCheckpointGenerationConflict(null)).toBeUndefined();
    expect(getCheckpointGenerationConflict("GENERATION_CONFLICT")).toBeUndefined();
    expect(getCheckpointGenerationConflict(undefined)).toBeUndefined();
  });

  it("keeps capacity and generation origins separate", () => {
    const capacity = {};
    const generation = {};
    recordCheckpointCapacityRefusal(capacity, ID);
    recordCheckpointGenerationConflict(generation, 0, 1);
    expect(getCheckpointGenerationConflict(capacity)).toBeUndefined();
    expect(getCheckpointCapacityRefusal(generation)).toBeUndefined();
    expect(getCheckpointCapacityRefusal(capacity)).toBeDefined();
    expect(getCheckpointGenerationConflict(generation)).toBeDefined();
  });

  it("accepts equal-generation head/token port conflicts with frozen port details", () => {
    const error = {};
    recordCheckpointPortPreconditionConflict(error, 5, 5, "HEAD_TOKEN_OR_BYTES");
    const conflict = getCheckpointGenerationConflict(error)!;
    expect(conflict).toMatchObject({
      sourceCauseCodes: ["WINDOWS_RECOVERY_PORT_CONFLICT"],
      precondition: {
        expectedGeneration: 5,
        observedActualGeneration: 5,
        mismatch: "HEAD_TOKEN_OR_BYTES",
      },
    });
    expect(Object.isFrozen(conflict)).toBe(true);
    expect(Object.isFrozen(conflict.sourceCauseCodes)).toBe(true);
    expect(Object.isFrozen(conflict.precondition)).toBe(true);
  });

  it("rejects equal generation, invalid port counters and invalid mismatch", () => {
    const equal = {};
    recordCheckpointPortPreconditionConflict(equal, 2, 2, "GENERATION");
    expect(getCheckpointGenerationConflict(equal)).toBeUndefined();
    for (const [expected, observed] of [
      [-1, 0], [0, -1], [1.5, 2], [0, 1.5], [Number.MAX_SAFE_INTEGER, 0],
      [Number.NaN, 1], [0, Number.POSITIVE_INFINITY],
    ] as const) {
      const other = {};
      recordCheckpointPortPreconditionConflict(other, expected, observed, "HEAD_TOKEN_OR_BYTES");
      expect(getCheckpointGenerationConflict(other)).toBeUndefined();
    }
    const invalid = {};
    recordCheckpointPortPreconditionConflict(invalid, 0, 1, "SIZE" as never);
    expect(getCheckpointGenerationConflict(invalid)).toBeUndefined();
  });

  it("keeps the first generation or port issuer for an error", () => {
    const generationFirst = {};
    recordCheckpointGenerationConflict(generationFirst, 0, 1);
    recordCheckpointPortPreconditionConflict(generationFirst, 2, 2, "HEAD_TOKEN_OR_BYTES");
    expect(getCheckpointGenerationConflict(generationFirst)!.precondition).toEqual({
      expectedGeneration: 0,
      observedActualGeneration: 1,
      mismatch: "GENERATION",
    });
    expect(getCheckpointGenerationConflict(generationFirst)!.sourceCauseCodes)
      .toEqual(["CHECKPOINT_PRECONDITION_MISMATCH"]);

    const portFirst = {};
    recordCheckpointPortPreconditionConflict(portFirst, 2, 2, "HEAD_TOKEN_OR_BYTES");
    recordCheckpointGenerationConflict(portFirst, 0, 1);
    expect(getCheckpointGenerationConflict(portFirst)!.precondition).toEqual({
      expectedGeneration: 2,
      observedActualGeneration: 2,
      mismatch: "HEAD_TOKEN_OR_BYTES",
    });
    expect(getCheckpointGenerationConflict(portFirst)!.sourceCauseCodes)
      .toEqual(["WINDOWS_RECOVERY_PORT_CONFLICT"]);
  });

  it("propagates an exact origin to a known wrapper only", () => {
    const original = {};
    recordCheckpointPortPreconditionConflict(original, 3, 3, "HEAD_TOKEN_OR_BYTES");
    const record = getCheckpointGenerationConflict(original);
    const wrapper = {};
    propagateCheckpointGenerationConflict(wrapper, original);
    expect(getCheckpointGenerationConflict(wrapper)).toBe(record);

    const taggedWrapper = {};
    recordCheckpointGenerationConflict(taggedWrapper, 9, 8);
    propagateCheckpointGenerationConflict(taggedWrapper, original);
    expect(getCheckpointGenerationConflict(taggedWrapper)!.precondition).toEqual({
      expectedGeneration: 9,
      observedActualGeneration: 8,
      mismatch: "GENERATION",
    });
  });

  it("captures absence once despite later tagging, repeat propagation or direct issuance", () => {
    const original = {};
    const wrapper = {};
    propagateCheckpointGenerationConflict(wrapper, original);
    expect(getCheckpointGenerationConflict(wrapper)).toBeUndefined();
    recordCheckpointGenerationConflict(original, 0, 1);
    expect(getCheckpointGenerationConflict(wrapper)).toBeUndefined();
    propagateCheckpointGenerationConflict(wrapper, original);
    expect(getCheckpointGenerationConflict(wrapper)).toBeUndefined();
    recordCheckpointPortPreconditionConflict(wrapper, 4, 4, "HEAD_TOKEN_OR_BYTES");
    expect(getCheckpointGenerationConflict(wrapper)).toBeUndefined();
  });

  it("keeps port origins exact-identity only and never reads hostile fields", () => {
    const hostile = Object.defineProperties({}, {
      expectedGeneration: { get() { throw new Error("expectedGeneration getter must not run"); } },
      observedActualGeneration: { get() { throw new Error("observedActualGeneration getter must not run"); } },
      mismatch: { get() { throw new Error("mismatch getter must not run"); } },
      cause: { get() { throw new Error("cause getter must not run"); } },
      errors: { get() { throw new Error("errors getter must not run"); } },
    });
    expect(() => recordCheckpointPortPreconditionConflict(hostile, 0, 1, "GENERATION")).not.toThrow();
    const conflict = getCheckpointGenerationConflict(hostile)!;
    expect(conflict.precondition.expectedGeneration).toBe(0);
    expect(getCheckpointGenerationConflict({ ...conflict })).toBeUndefined();
    expect(getCheckpointGenerationConflict(JSON.parse(JSON.stringify(conflict)))).toBeUndefined();
    expect(getCheckpointGenerationConflict(new AggregateError([hostile], "WINDOWS_RECOVERY_PORT_CONFLICT"))).toBeUndefined();
    expect(getCheckpointGenerationConflict(new Proxy(hostile, {}))).toBeUndefined();
    expect(getCheckpointGenerationConflict(new Error("WINDOWS_RECOVERY_PORT_CONFLICT", { cause: hostile }))).toBeUndefined();
  });
});

describe("K capacity exact-identity sidecar", () => {
  it("records frozen diagnostics for both fixed cause codes without changing the original object", () => {
    const causes = [
      "PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY",
      "PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY",
    ] as const;
    for (const cause of causes) {
      const error = Object.freeze({ code: cause, message: "original" });
      recordKCapacityRefusal(error, ID, cause);
      const refusal = getKCapacityRefusal(error)!;
      expect(refusal).toMatchObject({
        kind: "PRE_DISPATCH_CAPACITY", family: "K", stage: "RESERVE",
        failureSubject: "CURRENT_ATTEMPT", mutationDispatch: "NOT_DISPATCHED_PROVEN",
        proofOrigin: "LOCAL_ADMISSION_GUARD", attemptId: ID,
        sourceCauseCodes: [cause],
      });
      expect(refusal.sourceCauseCodes).toHaveLength(1);
      expect(Object.isFrozen(refusal)).toBe(true);
      expect(Object.isFrozen(refusal.sourceCauseCodes)).toBe(true);
      expect(Object.isFrozen(error)).toBe(true);
      expect(error).toEqual({ code: cause, message: "original" });
      expect(Object.keys(error)).toEqual(["code", "message"]);
    }
  });

  it("preserves the first association and rejects invalid ids, causes and nonobject errors", () => {
    const error = {};
    recordKCapacityRefusal(error, ID, "PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY");
    recordKCapacityRefusal(error, "b".repeat(32), "PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY");
    expect(getKCapacityRefusal(error)).toMatchObject({
      attemptId: ID,
      sourceCauseCodes: ["PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY"],
    });

    for (const invalid of ["A".repeat(32), "a".repeat(31), "g".repeat(32), ""]) {
      const other = {};
      recordKCapacityRefusal(other, invalid, "PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY");
      expect(getKCapacityRefusal(other)).toBeUndefined();
    }

    for (const invalidCause of ["CHECKPOINT_PRECONDITION_MISMATCH", "WINDOWS_RECOVERY_ARCHIVE_CAPACITY", ""]) {
      const other = {};
      recordKCapacityRefusal(other, ID, invalidCause as Parameters<typeof recordKCapacityRefusal>[2]);
      expect(getKCapacityRefusal(other)).toBeUndefined();
    }

    for (const target of [null, undefined, 1, "K", true, Symbol("K"), 1n]) {
      expect(() => recordKCapacityRefusal(
        target as unknown as object,
        ID,
        "PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY",
      )).not.toThrow();
      expect(getKCapacityRefusal(target)).toBeUndefined();
    }
  });

  it("cannot be forged by primitives, clones, plain errors, aggregates, causes or proxies", () => {
    const tagged = {};
    recordKCapacityRefusal(tagged, ID, "PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY");
    const refusal = getKCapacityRefusal(tagged)!;
    expect(getKCapacityRefusal({ ...refusal })).toBeUndefined();
    expect(getKCapacityRefusal(JSON.parse(JSON.stringify(refusal)))).toBeUndefined();
    expect(getKCapacityRefusal(new Error("PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY"))).toBeUndefined();
    expect(getKCapacityRefusal(new AggregateError([tagged], "PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY"))).toBeUndefined();
    expect(getKCapacityRefusal(new Proxy(tagged, {}))).toBeUndefined();
    expect(getKCapacityRefusal(new Error("PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY", { cause: tagged }))).toBeUndefined();
    expect(getKCapacityRefusal(null)).toBeUndefined();
    expect(getKCapacityRefusal("K")).toBeUndefined();
    expect(getKCapacityRefusal(tagged)).toBe(refusal);
  });

  it("never invokes hostile getters while recording or retrieving", () => {
    const hostile = Object.defineProperties({}, {
      code: { get() { throw new Error("code getter"); } },
      message: { get() { throw new Error("message getter"); } },
      cause: { get() { throw new Error("cause getter"); } },
      errors: { get() { throw new Error("errors getter"); } },
    });
    expect(getKCapacityRefusal(hostile)).toBeUndefined();
    expect(() => recordKCapacityRefusal(hostile, ID, "PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY")).not.toThrow();
    expect(getKCapacityRefusal(hostile)!.attemptId).toBe(ID);
  });

  it("keeps K and checkpoint origins independent", () => {
    const error = {};
    recordCheckpointCapacityRefusal(error, ID);
    expect(getKCapacityRefusal(error)).toBeUndefined();
    recordKCapacityRefusal(error, "b".repeat(32), "PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY");
    expect(getCheckpointCapacityRefusal(error)!.attemptId).toBe(ID);
    expect(getKCapacityRefusal(error)!.attemptId).toBe("b".repeat(32));
    expect(getCheckpointCapacityRefusal(error)!.sourceCauseCodes).toEqual(["WINDOWS_RECOVERY_ARCHIVE_CAPACITY"]);
    expect(getKCapacityRefusal(error)!.sourceCauseCodes).toEqual(["PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY"]);

    const kOnly = {};
    recordKCapacityRefusal(kOnly, ID, "PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY");
    expect(getCheckpointCapacityRefusal(kOnly)).toBeUndefined();
    expect(getKCapacityRefusal(kOnly)!.family).toBe("K");
  });
});

describe("K reserve failure exact-identity sidecar", () => {
  it("records a frozen reserve outcome backed by the same-attempt raw refusal", () => {
    const raw = Object.freeze({});
    recordKCapacityRefusal(raw, ID, "PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY");
    const wrapper = Object.freeze({ untouched: true });
    recordKReserveFailure(wrapper, ID, raw);
    const failure = getKReserveFailure(wrapper)!;
    expect(failure).toEqual({
      attemptId: ID,
      sourceOutcome: { source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" },
      capacityRefusal: getKCapacityRefusal(raw),
    });
    expect(failure.capacityRefusal).toBe(getKCapacityRefusal(raw));
    expect(Object.keys(failure).sort()).toEqual(["attemptId", "capacityRefusal", "sourceOutcome"]);
    expect(Object.isFrozen(failure)).toBe(true);
    expect(Object.isFrozen(failure.sourceOutcome)).toBe(true);
    expect(wrapper).toEqual({ untouched: true });
    expect(Object.keys(wrapper)).toEqual(["untouched"]);
  });

  it("preserves absence and cannot be upgraded by attempt mismatch or later raw tagging", () => {
    const absent = {};
    recordKReserveFailure(absent, ID, {});
    expect(getKReserveFailure(absent)!.capacityRefusal).toBeUndefined();

    const raw = {};
    recordKCapacityRefusal(raw, ID, "PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY");
    recordKReserveFailure(absent, ID, raw);
    expect(getKReserveFailure(absent)!.capacityRefusal).toBeUndefined();

    const otherId = "b".repeat(32);
    const otherRaw = {};
    recordKCapacityRefusal(otherRaw, otherId, "PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY");
    const mismatched = {};
    recordKReserveFailure(mismatched, ID, otherRaw);
    expect(getKReserveFailure(mismatched)!.capacityRefusal).toBeUndefined();

    const lateRaw = {};
    const late = {};
    recordKReserveFailure(late, ID, lateRaw);
    recordKCapacityRefusal(lateRaw, ID, "PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY");
    expect(getKReserveFailure(late)!.capacityRefusal).toBeUndefined();
    recordKReserveFailure(late, ID, lateRaw);
    expect(getKReserveFailure(late)!.capacityRefusal).toBeUndefined();

    const fixed = {};
    recordKReserveFailure(fixed, ID, raw);
    const replacement = {};
    recordKCapacityRefusal(replacement, ID, "PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY");
    recordKReserveFailure(fixed, ID, replacement);
    expect(getKReserveFailure(fixed)!.capacityRefusal).toBe(getKCapacityRefusal(raw));
  });

  it("ignores invalid ids and targets without forging from clones, UNKNOWN shapes, aggregates or causes", () => {
    const raw = {};
    recordKCapacityRefusal(raw, ID, "PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY");
    for (const invalidId of ["A".repeat(32), "a".repeat(31), "a".repeat(33), "g".repeat(32), "", `${ID}\n`]) {
      const target = {};
      recordKReserveFailure(target, invalidId, raw);
      expect(getKReserveFailure(target)).toBeUndefined();
    }
    for (const target of [null, undefined, 1, "K", true, Symbol("K"), 1n]) {
      expect(() => recordKReserveFailure(
        target as unknown as object,
        ID,
        raw,
      )).not.toThrow();
      expect(getKReserveFailure(target)).toBeUndefined();
    }

    const tagged = {};
    recordKReserveFailure(tagged, ID, raw);
    const failure = getKReserveFailure(tagged)!;
    expect(getKReserveFailure({ ...failure })).toBeUndefined();
    expect(getKReserveFailure(JSON.parse(JSON.stringify(failure)))).toBeUndefined();
    expect(getKReserveFailure({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" })).toBeUndefined();
    expect(getKReserveFailure(new Error("K_EXCEPTION"))).toBeUndefined();
    expect(getKReserveFailure(new AggregateError([tagged], "K_EXCEPTION"))).toBeUndefined();
    expect(getKReserveFailure(new Proxy(tagged, {}))).toBeUndefined();
    expect(getKReserveFailure(new Error("K_EXCEPTION", { cause: tagged }))).toBeUndefined();
    expect(getKReserveFailure(tagged)).toBe(failure);
  });

  it("never invokes hostile getters while recording the reserve boundary", () => {
    const hostileCause = Object.defineProperties({}, {
      code: { get() { throw new Error("code getter"); } },
      message: { get() { throw new Error("message getter"); } },
      cause: { get() { throw new Error("cause getter"); } },
      errors: { get() { throw new Error("errors getter"); } },
    });
    const wrapper = Object.defineProperties({}, {
      attemptId: { get() { throw new Error("attemptId getter"); } },
      sourceOutcome: { get() { throw new Error("sourceOutcome getter"); } },
      capacityRefusal: { get() { throw new Error("capacityRefusal getter"); } },
    });
    expect(() => recordKReserveFailure(wrapper, ID, hostileCause)).not.toThrow();
    const failure = getKReserveFailure(wrapper)!;
    expect(failure.attemptId).toBe(ID);
    expect(failure.sourceOutcome.reason).toBe("RESERVE");
    expect(failure.capacityRefusal).toBeUndefined();
  });

  it("keeps reserve, raw K and checkpoint maps independent", () => {
    const target = {};
    recordCheckpointCapacityRefusal(target, ID);
    recordKCapacityRefusal(target, ID, "PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY");
    recordKReserveFailure(target, ID, target);
    expect(getKReserveFailure(target)!.capacityRefusal).toBe(getKCapacityRefusal(target));
    expect(getKReserveFailure(target)!.capacityRefusal).not.toBe(getCheckpointCapacityRefusal(target));
    expect(getKCapacityRefusal(target)!.attemptId).toBe(ID);
    expect(getCheckpointCapacityRefusal(target)!.attemptId).toBe(ID);

    const reserveOnly = {};
    recordKReserveFailure(reserveOnly, ID, target);
    expect(getKReserveFailure(reserveOnly)!.capacityRefusal).toBe(getKCapacityRefusal(target));
    expect(getKCapacityRefusal(reserveOnly)).toBeUndefined();
    expect(getCheckpointCapacityRefusal(reserveOnly)).toBeUndefined();
  });
});

describe("K reserve observation request-scoped channel", () => {
  const refusalOf = (attemptId: string) => {
    const raw = {};
    recordKCapacityRefusal(raw, attemptId, "PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY");
    return getKCapacityRefusal(raw)!;
  };

  it("matches an armed exact intent once and returns frozen current facts", () => {
    const intent = { attemptId: ID };
    const handle = armKReserveObservation(intent, ID)!;
    expect(handle).toBeDefined();
    expect(Object.isFrozen(handle)).toBe(true);
    const refusal = refusalOf(ID);
    let supplied: KReserveObservationFacts | undefined;
    observeKReserveInvocation(intent, (facts) => {
      supplied = facts;
      facts!.capacityRefusal = refusal;
      facts!.uncertainty = "TRANSACTION";
    });
    expect(supplied).toBeDefined();
    const matched = consumeKReserveObservation(handle, "RETURNED", undefined);
    expect(matched.matched).toBe(true);
    if (!matched.matched) throw new Error("expected match");
    expect(matched.terminal).toBe("RETURNED");
    expect(matched.capacityRefusal).toBe(refusal);
    expect(matched.uncertainty).toBe("TRANSACTION");
    expect(Object.isFrozen(matched)).toBe(true);
    expect(consumeKReserveObservation(handle, "RETURNED", undefined).matched).toBe(false);
  });

  it("matches an exact primitive thrown value", () => {
    const intent = { attemptId: ID };
    const handle = armKReserveObservation(intent, ID)!;
    let thrown: unknown = "not thrown";
    try {
      observeKReserveInvocation(intent, () => { throw undefined; });
    } catch (error) { thrown = error; }
    expect(thrown).toBeUndefined();
    const matched = consumeKReserveObservation(handle, "THREW", thrown);
    expect(matched.matched).toBe(true);
    if (!matched.matched) throw new Error("expected match");
    expect(matched.terminal).toBe("THREW");
    expect("capacityRefusal" in matched).toBe(false);
    expect("uncertainty" in matched).toBe(false);
  });

  it("exposes only a same-attempt capacity refusal", () => {
    const intent = { attemptId: ID };
    const handle = armKReserveObservation(intent, ID)!;
    const stale = refusalOf("b".repeat(32));
    observeKReserveInvocation(intent, (facts) => {
      facts!.capacityRefusal = stale;
      facts!.uncertainty = "READBACK";
    });
    const matched = consumeKReserveObservation(handle, "RETURNED", undefined);
    expect(matched.matched).toBe(true);
    if (!matched.matched) throw new Error("expected match");
    expect(matched.capacityRefusal).toBeUndefined();
    expect("capacityRefusal" in matched).toBe(false);
    expect(matched.uncertainty).toBe("READBACK");
  });

  it("gives no facts to an unarmed, cloned or replayed invocation", () => {
    const armed = { attemptId: ID };
    const handle = armKReserveObservation(armed, ID)!;

    let cloneFacts: KReserveObservationFacts | undefined | "not-called" = "not-called";
    observeKReserveInvocation({ ...armed }, (facts) => { cloneFacts = facts; });
    expect(cloneFacts).toBeUndefined();

    let replayed: KReserveObservationFacts | undefined | "not-called" = "not-called";
    observeKReserveInvocation(armed, (facts) => { replayed = facts; });
    expect(replayed).toBeDefined();
    const first = consumeKReserveObservation(handle, "RETURNED", undefined);
    expect(first.matched).toBe(true);

    let second: KReserveObservationFacts | undefined | "not-called" = "not-called";
    observeKReserveInvocation(armed, (facts) => { second = facts; });
    expect(second).toBeUndefined();
    expect(armKReserveObservation(armed, ID)).toBeUndefined();

    const fresh = { attemptId: ID };
    let unarmed: KReserveObservationFacts | undefined | "not-called" = "not-called";
    observeKReserveInvocation(fresh, (facts) => { unarmed = facts; });
    expect(unarmed).toBeUndefined();
    expect(armKReserveObservation(fresh, ID)).toBeUndefined();
  });

  it("invalidates a replayed same-request invocation before consume", () => {
    const intent = { attemptId: ID };
    const handle = armKReserveObservation(intent, ID)!;
    const fault = new Error("replayed journal fault");
    let firstFacts: KReserveObservationFacts | undefined;
    let caught: unknown;
    try {
      observeKReserveInvocation(intent, facts => { firstFacts = facts; throw fault; });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(fault);
    expect(firstFacts).toBeDefined();
    let replayFacts: KReserveObservationFacts | undefined | "not-called" = "not-called";
    let replayCaught: unknown;
    try {
      observeKReserveInvocation(intent, facts => { replayFacts = facts; throw fault; });
    } catch (error) {
      replayCaught = error;
    }
    expect(replayCaught).toBe(fault);
    expect(replayFacts).toBeUndefined();
    expect(consumeKReserveObservation(handle, "THREW", fault).matched).toBe(false);
    expect(consumeKReserveObservation(handle, "THREW", fault).matched).toBe(false);
  });

  it("invalidates a nested reentry and clears the mutable fact slots", () => {
    const intent = { attemptId: ID };
    const handle = armKReserveObservation(intent, ID)!;
    const refusal = refusalOf(ID);
    let outerFacts: (KReserveObservationFacts & { entry?: unknown }) | undefined;
    let innerFacts: KReserveObservationFacts | undefined | "not-called" = "not-called";
    observeKReserveInvocation(intent, facts => {
      outerFacts = facts as KReserveObservationFacts & { entry?: unknown };
      facts!.capacityRefusal = refusal;
      facts!.uncertainty = "TRANSACTION";
      observeKReserveInvocation(intent, nested => { innerFacts = nested; });
    });
    expect(outerFacts).toBeDefined();
    expect(innerFacts).toBeUndefined();
    expect(consumeKReserveObservation(handle, "RETURNED", undefined).matched).toBe(false);
    expect(outerFacts!.entry).toBeUndefined();
    expect(outerFacts!.capacityRefusal).toBeUndefined();
    expect(outerFacts!.uncertainty).toBeUndefined();
  });

  it("invalidates both arms of a repeated arm before invocation", () => {
    const intent = { attemptId: ID };
    const first = armKReserveObservation(intent, ID)!;
    expect(armKReserveObservation(intent, ID)).toBeUndefined();
    let seen: KReserveObservationFacts | undefined | "not-called" = "not-called";
    observeKReserveInvocation(intent, facts => { seen = facts; });
    expect(seen).toBeUndefined();
    expect(consumeKReserveObservation(first, "RETURNED", undefined).matched).toBe(false);
    expect(armKReserveObservation(intent, ID)).toBeUndefined();
  });

  it("clears mutable fact slots after a mismatched consume", () => {
    const intent = { attemptId: ID };
    const handle = armKReserveObservation(intent, ID)!;
    const fault = new Error("sealed journal fault");
    let facts: (KReserveObservationFacts & { entry?: unknown }) | undefined;
    try {
      observeKReserveInvocation(intent, supplied => {
        facts = supplied as KReserveObservationFacts & { entry?: unknown };
        supplied!.capacityRefusal = refusalOf(ID);
        supplied!.uncertainty = "READBACK";
        throw fault;
      });
    } catch (error) {
      expect(error).toBe(fault);
    }
    expect(consumeKReserveObservation(handle, "THREW", new Error("other")).matched).toBe(false);
    expect(facts!.entry).toBeUndefined();
    expect(facts!.capacityRefusal).toBeUndefined();
    expect(facts!.uncertainty).toBeUndefined();
    expect(consumeKReserveObservation(handle, "THREW", fault).matched).toBe(false);
  });

  it("issues no facts on a clone-first invocation but keeps a real fresh request eligible", () => {
    const clone = { attemptId: ID };
    let cloneFacts: KReserveObservationFacts | undefined | "not-called" = "not-called";
    observeKReserveInvocation(clone, facts => { cloneFacts = facts; });
    expect(cloneFacts).toBeUndefined();
    expect(armKReserveObservation(clone, ID)).toBeUndefined();

    const intent = { attemptId: ID };
    const handle = armKReserveObservation(intent, ID)!;
    let freshFacts: KReserveObservationFacts | undefined;
    observeKReserveInvocation(intent, facts => { freshFacts = facts; });
    expect(freshFacts).toBeDefined();
    expect(consumeKReserveObservation(handle, "RETURNED", undefined).matched).toBe(true);
  });

  it("rejects invalid inputs and forged handles without side effects", () => {
    expect(armKReserveObservation(undefined, ID)).toBeUndefined();
    expect(armKReserveObservation(null, ID)).toBeUndefined();
    expect(armKReserveObservation("intent", ID)).toBeUndefined();
    for (const invalid of ["A".repeat(32), "a".repeat(31), "g".repeat(32), ""]) {
      expect(armKReserveObservation({ attemptId: invalid }, invalid)).toBeUndefined();
    }
    const intent = { attemptId: ID };
    const handle = armKReserveObservation(intent, ID)!;
    let traps = 0;
    const proxy = new Proxy(handle, {
      get() { traps += 1; throw new Error("get trap"); },
    });
    expect(consumeKReserveObservation(proxy, "RETURNED", undefined).matched).toBe(false);
    expect(traps).toBe(0);
    expect(consumeKReserveObservation({}, "RETURNED", undefined).matched).toBe(false);
    expect(consumeKReserveObservation(null, "RETURNED", undefined).matched).toBe(false);
    expect(consumeKReserveObservation("handle", "RETURNED", undefined).matched).toBe(false);
    const thrown = new Error("journal fault");
    let caught: unknown;
    try {
      observeKReserveInvocation(intent, () => { throw thrown; });
    } catch (error) { caught = error; }
    expect(caught).toBe(thrown);
    const mismatched = consumeKReserveObservation(handle, "THREW", new Error("other"));
    expect(mismatched.matched).toBe(false);
    expect(consumeKReserveObservation(handle, "THREW", thrown).matched).toBe(false);
  });
});

describe("K mutation failure exact-identity sidecar", () => {
  const refusalOf = (attemptId: string) => {
    const raw = {};
    recordKCapacityRefusal(raw, attemptId, "PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY");
    return getKCapacityRefusal(raw)!;
  };
  const facts = (overrides: Partial<KMutationFailure> = {}): KMutationFailure => ({
    attemptId: ID,
    sourceOutcome: { source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" },
    mutationDispatch: "NOT_DISPATCHED_PROVEN",
    ...overrides,
  });

  it("records a frozen fact set without mutating the error", () => {
    const error = {};
    const refusal = refusalOf(ID);
    recordKMutationFailure(error, facts({ capacityRefusal: refusal }));
    const failure = getKMutationFailure(error)!;
    expect(failure).toEqual({
      attemptId: ID,
      sourceOutcome: { source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" },
      mutationDispatch: "NOT_DISPATCHED_PROVEN",
      capacityRefusal: refusal,
    });
    expect(Object.isFrozen(failure)).toBe(true);
    expect(Object.isFrozen(failure.sourceOutcome)).toBe(true);
    expect(Object.isFrozen(error)).toBe(false);

    const uncertain = {};
    recordKMutationFailure(uncertain, facts({
      uncertainty: { stage: "RESERVE", origin: "NON_VOID_ACK" },
    }));
    const recorded = getKMutationFailure(uncertain)!;
    expect(recorded.uncertainty).toEqual({ stage: "RESERVE", origin: "NON_VOID_ACK" });
    expect(recorded.capacityRefusal).toBeUndefined();
    expect(Object.isFrozen(recorded.uncertainty)).toBe(true);
  });

  it("drops capacity when dispatch or uncertainty contradicts a clean admission refusal", () => {
    const dispatched = {};
    recordKMutationFailure(dispatched, facts({
      mutationDispatch: "DISPATCHED",
      capacityRefusal: refusalOf(ID),
    }));
    expect(getKMutationFailure(dispatched)!.mutationDispatch).toBe("DISPATCHED");
    expect(getKMutationFailure(dispatched)!.capacityRefusal).toBeUndefined();

    const uncertain = {};
    recordKMutationFailure(uncertain, facts({
      capacityRefusal: refusalOf(ID),
      uncertainty: { stage: "DISPATCH", origin: "MUTATION_EXEC" },
    }));
    expect(getKMutationFailure(uncertain)!.capacityRefusal).toBeUndefined();
    expect(getKMutationFailure(uncertain)!.uncertainty).toEqual({ stage: "DISPATCH", origin: "MUTATION_EXEC" });
  });

  it("drops a mismatched-attempt capacity refusal while keeping the frozen source facts", () => {
    const error = {};
    recordKMutationFailure(error, facts({ capacityRefusal: refusalOf("b".repeat(32)) }));
    const failure = getKMutationFailure(error)!;
    expect(failure.attemptId).toBe(ID);
    expect(failure.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" });
    expect(failure.mutationDispatch).toBe("NOT_DISPATCHED_PROVEN");
    expect(failure.capacityRefusal).toBeUndefined();
    expect(Object.isFrozen(failure)).toBe(true);
  });

  it("keeps the first association and rejects invalid facts or targets", () => {
    const error = {};
    recordKMutationFailure(error, facts());
    recordKMutationFailure(error, facts({ attemptId: "b".repeat(32) }));
    expect(getKMutationFailure(error)!.attemptId).toBe(ID);

    for (const invalid of ["A".repeat(32), "a".repeat(31), "g".repeat(32), "", ID + "0"]) {
      const target = {};
      recordKMutationFailure(target, facts({ attemptId: invalid }));
      expect(getKMutationFailure(target)).toBeUndefined();
    }
    for (const target of [null, undefined, 1, "K", true, Symbol("K"), 1n]) {
      expect(() => recordKMutationFailure(target as unknown as object, facts())).not.toThrow();
      expect(getKMutationFailure(target)).toBeUndefined();
    }
    const badState = {};
    recordKMutationFailure(badState, facts({
      sourceOutcome: { source: "K_EXCEPTION", state: "PUBLISHED" as unknown as "UNKNOWN", reason: "X" },
    }));
    expect(getKMutationFailure(badState)).toBeUndefined();
  });

  it("cannot be forged by clones, aggregates, causes, proxies or primitives and never reads hostile getters", () => {
    const tagged = {};
    recordKMutationFailure(tagged, facts());
    const failure = getKMutationFailure(tagged)!;
    expect(getKMutationFailure({ ...failure })).toBeUndefined();
    expect(getKMutationFailure(JSON.parse(JSON.stringify(failure)))).toBeUndefined();
    expect(getKMutationFailure(new Error("K_EXCEPTION"))).toBeUndefined();
    expect(getKMutationFailure(new AggregateError([tagged], "K_EXCEPTION"))).toBeUndefined();
    expect(getKMutationFailure(new Proxy(tagged, {}))).toBeUndefined();
    expect(getKMutationFailure(new Error("K_EXCEPTION", { cause: tagged }))).toBeUndefined();
    expect(getKMutationFailure(null)).toBeUndefined();
    expect(getKMutationFailure(tagged)).toBe(failure);

    const hostile = Object.defineProperties({}, {
      message: { get() { throw new Error("message getter"); } },
      cause: { get() { throw new Error("cause getter"); } },
      errors: { get() { throw new Error("errors getter"); } },
    });
    expect(() => recordKMutationFailure(hostile, facts())).not.toThrow();
    expect(getKMutationFailure(hostile)).toBeDefined();
  });
});

describe("recovery IO failure sidecar", () => {
  it("associates the original error with a frozen result, preserves keys and first association", () => {
    const first = new Error("first"), second = new Error("second");
    const result = Object.freeze({ state: "REJECTED", reason: "PRIVATE_IO_V3_REJECTED" });
    const keys = Object.keys(result);
    rememberRecoveryIoFailure(result, first);
    rememberRecoveryIoFailure(result, second);
    expect(getRecoveryIoFailureCause(result)).toBe(first);
    expect(Object.keys(result)).toEqual(keys);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("retains an undefined original error as the first association", () => {
    const result = {};
    rememberRecoveryIoFailure(result, undefined);
    rememberRecoveryIoFailure(result, new Error("later"));
    expect(getRecoveryIoFailureCause(result)).toBeUndefined();
  });

  it("propagates the remembered captured origin to a known wrapper only", () => {
    const error = new CollaborationCapacityFixture();
    recordCheckpointCapacityRefusal(error, ID);
    const result = Object.freeze({ state: "REJECTED" });
    rememberRecoveryIoFailure(result, error);
    const wrapper = new Error("wrapper");
    propagateRecoveryIoFailure(wrapper, result);
    expect(getRecoveryIoFailureCause(wrapper)).toBe(error);
    expect(getCheckpointCapacityRefusal(wrapper)).toBe(getCheckpointCapacityRefusal(error));
    expect(getCheckpointCapacityRefusal(result)).toBe(getCheckpointCapacityRefusal(error));
    expect(getCheckpointCapacityRefusal(getRecoveryIoFailureCause(wrapper))).toBeDefined();
    const second = new Error("second");
    propagateRecoveryIoFailure(wrapper, { cause: second });
    expect(getRecoveryIoFailureCause(wrapper)).toBe(error);
  });

  it("does not create associations from getters or untagged originals", () => {
    const wrapper = {}, result = {};
    expect(getRecoveryIoFailureCause(wrapper)).toBeUndefined();
    propagateRecoveryIoFailure(wrapper, result);
    expect(getRecoveryIoFailureCause(wrapper)).toBeUndefined();
    const original = new Error("WINDOWS_RECOVERY_ARCHIVE_CAPACITY");
    rememberRecoveryIoFailure(result, original);
    expect(getRecoveryIoFailureCause(result)).toBe(original);
    expect(getCheckpointCapacityRefusal(result)).toBeUndefined();
    expect(getCheckpointCapacityRefusal(original)).toBeUndefined();
  });

  it("copies the origin captured at remember time, not a later tag", () => {
    const original = new Error("late tag");
    const result = {};
    rememberRecoveryIoFailure(result, original);
    recordCheckpointCapacityRefusal(original, ID);
    const wrapper = {};
    propagateRecoveryIoFailure(wrapper, result);
    expect(getRecoveryIoFailureCause(wrapper)).toBe(original);
    expect(getCheckpointCapacityRefusal(original)).toBeDefined();
    expect(getCheckpointCapacityRefusal(result)).toBeUndefined();
    expect(getCheckpointCapacityRefusal(wrapper)).toBeUndefined();
  });
});

class CollaborationCapacityFixture extends Error {
  constructor() {
    super("WINDOWS_RECOVERY_ARCHIVE_CAPACITY");
    this.name = "CollaborationCapacityFixture";
  }
}
