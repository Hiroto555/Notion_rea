/**
 * Node-only exact-identity sidecar for pre-dispatch checkpoint capacity
 * refusals. This module is deliberately not a renderer DTO, classifier,
 * authorization, retry or write permission. Only a trusted Node guard site
 * may call recordCheckpointCapacityRefusal; the record proves only that a
 * local admission guard refused before dispatch.
 */

export type CheckpointCapacityRefusal = Readonly<{
  kind: "PRE_DISPATCH_CAPACITY";
  family: "CHECKPOINT";
  stage: "RESERVE";
  failureSubject: "CURRENT_ATTEMPT";
  mutationDispatch: "NOT_DISPATCHED_PROVEN";
  proofOrigin: "LOCAL_ADMISSION_GUARD";
  attemptId: string;
  sourceCauseCodes: readonly ["WINDOWS_RECOVERY_ARCHIVE_CAPACITY"];
}>;

export type KCapacityCauseCode =
  | "PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY"
  | "PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY";

export type KCapacityRefusal = Readonly<{
  kind: "PRE_DISPATCH_CAPACITY";
  family: "K";
  stage: "RESERVE";
  failureSubject: "CURRENT_ATTEMPT";
  mutationDispatch: "NOT_DISPATCHED_PROVEN";
  proofOrigin: "LOCAL_ADMISSION_GUARD";
  attemptId: string;
  sourceCauseCodes: readonly [KCapacityCauseCode];
}>;

/**
 * A prior-attempt pending fact issued only by a fresh source guard at the
 * exact pending error it throws. It proves only that pre-existing reserved
 * intent rows were observed for the logical path; it grants no authority,
 * retry, dispatch or capacity proof. attemptId is the single pending attempt
 * id, or null when multiple valid pending attempts are observed.
 */
export type CheckpointPriorPending = Readonly<{
  kind: "OUTCOME_UNKNOWN";
  family: "CHECKPOINT";
  stage: "PRIOR_ATTEMPT";
  failureSubject: "PRIOR_ATTEMPT";
  mutationDispatch: "UNPROVEN";
  proofOrigin: "NONE";
  attemptId: string | null;
}>;

const K_REFUSALS = new WeakMap<object, KCapacityRefusal>();

function isKCapacityCauseCode(value: unknown): value is KCapacityCauseCode {
  return value === "PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY"
    || value === "PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY";
}

/**
 * Trusted guard-site issuer only. Associates a frozen K-capacity diagnostic
 * with the exact error object and preserves the first association. Never
 * inspects the error's properties. No dispatch, auth, retry or write
 * permission is granted.
 */
export function recordKCapacityRefusal(
  error: object,
  attemptId: string,
  causeCode: KCapacityCauseCode,
): void {
  if (!isObject(error)) return;
  if (typeof attemptId !== "string" || !ATTEMPT_ID.test(attemptId)) return;
  if (!isKCapacityCauseCode(causeCode)) return;
  if (K_REFUSALS.has(error)) return;
  const sourceCauseCodes: readonly [KCapacityCauseCode] = Object.freeze([causeCode] as const);
  const diagnostic: KCapacityRefusal = Object.freeze({
    kind: "PRE_DISPATCH_CAPACITY",
    family: "K",
    stage: "RESERVE",
    failureSubject: "CURRENT_ATTEMPT",
    mutationDispatch: "NOT_DISPATCHED_PROVEN",
    proofOrigin: "LOCAL_ADMISSION_GUARD",
    attemptId,
    sourceCauseCodes,
  });
  K_REFUSALS.set(error, diagnostic);
}

/** Exact object identity only: no property, getter, cause or Aggregate walk. */
export function getKCapacityRefusal(value: unknown): KCapacityRefusal | undefined {
  if (!isObject(value)) return undefined;
  return K_REFUSALS.get(value);
}

export type KReserveFailure = Readonly<{
  attemptId: string;
  sourceOutcome: Readonly<{
    source: "K_EXCEPTION";
    state: "UNKNOWN";
    reason: "RESERVE";
  }>;
  capacityRefusal: KCapacityRefusal | undefined;
}>;

const K_RESERVE_FAILURES = new WeakMap<object, KReserveFailure>();

/**
 * Trusted K factory boundary observer only. Captures an UNKNOWN/RESERVE
 * outcome without reading the caller error, assigning dispatch, retry,
 * release or write authority. Preserves the first valid association,
 * including an absent raw capacity refusal.
 */
export function recordKReserveFailure(
  wrapper: object,
  attemptId: string,
  directCurrentReserveCause: unknown,
): void {
  if (!isObject(wrapper)) return;
  if (typeof attemptId !== "string" || !ATTEMPT_ID.test(attemptId)) return;
  if (K_RESERVE_FAILURES.has(wrapper)) return;
  const rawRefusal = getKCapacityRefusal(directCurrentReserveCause);
  const capacityRefusal = rawRefusal !== undefined && rawRefusal.attemptId === attemptId
    ? rawRefusal
    : undefined;
  const sourceOutcome: KReserveFailure["sourceOutcome"] = Object.freeze({
    source: "K_EXCEPTION",
    state: "UNKNOWN",
    reason: "RESERVE",
  });
  const failure: KReserveFailure = Object.freeze({
    attemptId,
    sourceOutcome,
    capacityRefusal,
  });
  K_RESERVE_FAILURES.set(wrapper, failure);
}

/** Exact object identity only: no property, getter, cause or Aggregate walk. */
export function getKReserveFailure(value: unknown): KReserveFailure | undefined {
  if (!isObject(value)) return undefined;
  return K_RESERVE_FAILURES.get(value);
}

declare const kReserveObservationHandleOpaqueBrand: unique symbol;
export type KReserveObservationHandle = Readonly<{ readonly [kReserveObservationHandleOpaqueBrand]: never }>;

export type KReserveObservationFacts = {
  capacityRefusal?: KCapacityRefusal;
  uncertainty?: "TRANSACTION" | "READBACK" | "ASSOCIATION";
};

export type KReserveObservationResult =
  | Readonly<{ matched: false }>
  | Readonly<{
      matched: true;
      terminal: "THREW" | "RETURNED";
      capacityRefusal?: KCapacityRefusal;
      uncertainty?: "TRANSACTION" | "READBACK" | "ASSOCIATION";
    }>;

type KReserveObservationRecord = {
  entered: boolean;
  invalid: boolean;
};

type KReserveObservationEntryState = KReserveObservationFacts & {
  entry?: PrivateMutationEntry;
};

type KReserveObservationFrame = Readonly<{
  intent: object;
  attemptId: string;
  channel: PrivateMutationChannel;
  record: KReserveObservationRecord;
  entryState: KReserveObservationEntryState;
}>;

type KReserveObservationSlot = Readonly<{
  record: KReserveObservationRecord;
  frame?: KReserveObservationFrame;
}>;

const kReserveObservationUnmatched: KReserveObservationResult = Object.freeze({ matched: false as const });
const kReserveObservationFrames = new WeakMap<object, KReserveObservationFrame | true>();
const kReserveObservationIntents = new WeakMap<object, KReserveObservationSlot>();

export function armKReserveObservation(
  intent: unknown,
  attemptId: string,
): KReserveObservationHandle | undefined {
  if (!isObject(intent)) return undefined;
  if (typeof attemptId !== "string" || !ATTEMPT_ID.test(attemptId)) return undefined;
  const previous = kReserveObservationIntents.get(intent);
  if (previous !== undefined) {
    previous.record.invalid = true;
    return undefined;
  }
  const record: KReserveObservationRecord = { entered: false, invalid: false };
  const channel = createPrivateMutationChannel();
  const frame: KReserveObservationFrame = Object.freeze({
    intent, attemptId, channel, record, entryState: {},
  });
  const handle = Object.freeze({}) as KReserveObservationHandle;
  kReserveObservationFrames.set(handle, frame);
  kReserveObservationIntents.set(intent, { record, frame });
  return handle;
}

export function observeKReserveInvocation(
  intent: unknown,
  body: (facts?: KReserveObservationFacts) => void,
): void {
  if (!isObject(intent)) {
    body();
    return;
  }
  const slot = kReserveObservationIntents.get(intent);
  if (slot === undefined) {
    const record: KReserveObservationRecord = { entered: true, invalid: true };
    kReserveObservationIntents.set(intent, { record });
    body();
    return;
  }
  const record = slot.record;
  const frame = slot.frame;
  if (frame === undefined) {
    record.invalid = true;
    body();
    return;
  }
  const eligible = !record.entered && !record.invalid;
  record.entered = true;
  let entry: PrivateMutationEntry | undefined;
  if (eligible) {
    entry = enterPrivateMutationChannel(frame.channel);
    if (entry === undefined) {
      record.invalid = true;
    } else {
      frame.entryState.entry = entry;
    }
  } else {
    record.invalid = true;
    consumePrivateMutationChannel(frame.channel, undefined, undefined);
  }
  try {
    body(entry === undefined ? undefined : frame.entryState);
    if (entry !== undefined) {
      if (record.invalid) {
        consumePrivateMutationChannel(frame.channel, undefined, undefined);
      } else {
        sealPrivateMutationChannel(frame.channel, entry, "RETURNED", undefined);
      }
    }
  } catch (error) {
    if (entry !== undefined) {
      if (record.invalid) {
        consumePrivateMutationChannel(frame.channel, undefined, undefined);
      } else {
        sealPrivateMutationChannel(frame.channel, entry, "THREW", error);
      }
    }
    throw error;
  }
}

export function consumeKReserveObservation(
  handle: unknown,
  tag: unknown,
  value: unknown,
): KReserveObservationResult {
  if (!isObject(handle)) return kReserveObservationUnmatched;
  const current = kReserveObservationFrames.get(handle);
  if (current === undefined || current === true) return kReserveObservationUnmatched;
  kReserveObservationFrames.set(handle, true);
  const frame = current;
  const record = frame.record;
  const entryState = frame.entryState;
  const expectedEntry = entryState.entry;
  if (!record.invalid && record.entered && expectedEntry !== undefined) {
    const matchedEntry = consumePrivateMutationChannel(frame.channel, tag, value);
    const capacityRefusal = entryState.capacityRefusal;
    const uncertainty = entryState.uncertainty;
    entryState.entry = undefined;
    entryState.capacityRefusal = undefined;
    entryState.uncertainty = undefined;
    if (
      matchedEntry !== undefined &&
      matchedEntry === expectedEntry &&
      (tag === "THREW" || tag === "RETURNED")
    ) {
      const slot = kReserveObservationIntents.get(frame.intent);
      if (slot !== undefined && slot.record === record && slot.frame === frame) {
        kReserveObservationIntents.set(frame.intent, { record });
      }
      const result: KReserveObservationResult = {
        matched: true,
        terminal: tag,
        ...(capacityRefusal !== undefined && capacityRefusal.attemptId === frame.attemptId
          ? { capacityRefusal } : {}),
        ...(uncertainty !== undefined ? { uncertainty } : {}),
      };
      return Object.freeze(result);
    }
  } else {
    consumePrivateMutationChannel(frame.channel, undefined, undefined);
    entryState.entry = undefined;
    entryState.capacityRefusal = undefined;
    entryState.uncertainty = undefined;
  }
  record.invalid = true;
  const slot = kReserveObservationIntents.get(frame.intent);
  if (slot !== undefined && slot.record === record && slot.frame === frame) {
    kReserveObservationIntents.set(frame.intent, { record });
  }
  return kReserveObservationUnmatched;
}

export type KMutationFailure = Readonly<{
  attemptId: string;
  sourceOutcome: Readonly<{
    source: "K_EXCEPTION";
    state: "REJECTED" | "EXISTS" | "UNKNOWN";
    reason: string;
  }>;
  mutationDispatch: "DISPATCHED" | "NOT_DISPATCHED_PROVEN";
  capacityRefusal?: KCapacityRefusal;
  uncertainty?: Readonly<{
    stage: "RESERVE" | "DISPATCH" | "CAPTURE" | "TERMINAL";
    origin:
      | "JOURNAL_TRANSACTION"
      | "JOURNAL_READBACK"
      | "JOURNAL_ASSOCIATION"
      | "NON_VOID_ACK"
      | "MUTATION_EXEC";
  }>;
}>;

const K_MUTATION_FAILURES = new WeakMap<object, KMutationFailure>();

export function recordKMutationFailure(error: object, facts: KMutationFailure): void {
  if (!isObject(error) || !isObject(facts)) return;
  if (typeof facts.attemptId !== "string" || !ATTEMPT_ID.test(facts.attemptId)) return;
  const sourceOutcome = facts.sourceOutcome;
  if (
    !isObject(sourceOutcome) ||
    sourceOutcome.source !== "K_EXCEPTION" ||
    (sourceOutcome.state !== "REJECTED" && sourceOutcome.state !== "EXISTS" && sourceOutcome.state !== "UNKNOWN") ||
    typeof sourceOutcome.reason !== "string"
  ) return;
  if (facts.mutationDispatch !== "DISPATCHED" && facts.mutationDispatch !== "NOT_DISPATCHED_PROVEN") return;
  const uncertainty = facts.uncertainty;
  if (uncertainty !== undefined) {
    if (
      !isObject(uncertainty) ||
      (uncertainty.stage !== "RESERVE" && uncertainty.stage !== "DISPATCH" &&
        uncertainty.stage !== "CAPTURE" && uncertainty.stage !== "TERMINAL") ||
      (uncertainty.origin !== "JOURNAL_TRANSACTION" && uncertainty.origin !== "JOURNAL_READBACK" &&
        uncertainty.origin !== "JOURNAL_ASSOCIATION" && uncertainty.origin !== "NON_VOID_ACK" &&
        uncertainty.origin !== "MUTATION_EXEC")
    ) return;
  }
  const capacityRefusal =
    isObject(facts.capacityRefusal) &&
    facts.capacityRefusal.attemptId === facts.attemptId &&
    uncertainty === undefined &&
    facts.mutationDispatch === "NOT_DISPATCHED_PROVEN"
      ? facts.capacityRefusal : undefined;
  if (K_MUTATION_FAILURES.has(error)) return;
  const failure: KMutationFailure = Object.freeze({
    attemptId: facts.attemptId,
    sourceOutcome: Object.freeze({
      source: "K_EXCEPTION",
      state: sourceOutcome.state,
      reason: sourceOutcome.reason,
    }),
    mutationDispatch: facts.mutationDispatch,
    ...(capacityRefusal !== undefined ? { capacityRefusal } : {}),
    ...(uncertainty !== undefined
      ? { uncertainty: Object.freeze({ stage: uncertainty.stage, origin: uncertainty.origin }) }
      : {}),
  });
  K_MUTATION_FAILURES.set(error, failure);
}

export function getKMutationFailure(value: unknown): KMutationFailure | undefined {
  if (!isObject(value)) return undefined;
  return K_MUTATION_FAILURES.get(value);
}

export type CheckpointPostPublicationUnknown = Readonly<{
  kind: "OUTCOME_UNKNOWN";
  family: "CHECKPOINT";
  stage: "HEAD_CAS" | "READBACK";
  failureSubject: "CURRENT_ATTEMPT";
  mutationDispatch: "DISPATCHED";
  proofOrigin: "DISPATCH_OBSERVED";
  attemptId: string;
  sourceOutcome: Readonly<{
    source: "RECOVERY_IO";
    contractVersion: 3;
    state: "PUBLISHED";
    reason: null;
  }>;
}>;

const POST_PUBLICATION_UNKNOWNS = new WeakMap<object, CheckpointPostPublicationUnknown>();

/**
 * Associates the trusted actual PUBLISHED-site fresh known wrapper only,
 * never a raw or reused Error. The first valid association is retained.
 * The getter exposes exact identity, never cause/getter/aggregate
 * inspection or authority.
 */
export function recordCheckpointPostPublicationUnknown(
  error: object,
  attemptId: string,
  stage: "HEAD_CAS" | "READBACK",
): void {
  if (!isObject(error)) return;
  if (typeof attemptId !== "string" || !ATTEMPT_ID.test(attemptId)) return;
  if (stage !== "HEAD_CAS" && stage !== "READBACK") return;
  if (POST_PUBLICATION_UNKNOWNS.has(error)) return;
  const sourceOutcome: CheckpointPostPublicationUnknown["sourceOutcome"] = Object.freeze({
    source: "RECOVERY_IO",
    contractVersion: 3,
    state: "PUBLISHED",
    reason: null,
  });
  const postPublication: CheckpointPostPublicationUnknown = Object.freeze({
    kind: "OUTCOME_UNKNOWN",
    family: "CHECKPOINT",
    stage,
    failureSubject: "CURRENT_ATTEMPT",
    mutationDispatch: "DISPATCHED",
    proofOrigin: "DISPATCH_OBSERVED",
    attemptId,
    sourceOutcome,
  });
  POST_PUBLICATION_UNKNOWNS.set(error, postPublication);
}

export function getCheckpointPostPublicationUnknown(
  value: unknown,
): CheckpointPostPublicationUnknown | undefined {
  if (!isObject(value)) return undefined;
  return POST_PUBLICATION_UNKNOWNS.get(value);
}

export type CheckpointGenerationConflict = Readonly<{
  kind: "GENERATION_CONFLICT";
  family: "CHECKPOINT";
  stage: "PRECONDITION";
  failureSubject: "CURRENT_ATTEMPT";
  mutationDispatch: "NOT_DISPATCHED_PROVEN";
  proofOrigin: "VALIDATED_PRECONDITION";
  attemptId: null;
  sourceCauseCodes:
    | readonly ["CHECKPOINT_PRECONDITION_MISMATCH"]
    | readonly ["WINDOWS_RECOVERY_PORT_CONFLICT"];
  precondition: Readonly<{
    expectedGeneration: number;
    observedActualGeneration: number;
    mismatch: "GENERATION" | "HEAD_TOKEN_OR_BYTES";
  }>;
}>;

type RecoveryIoFailureRecord = Readonly<{
  cause: unknown;
  refusal: CheckpointCapacityRefusal | undefined;
}>;

const ATTEMPT_ID = /^[0-9a-f]{32}$/;
const REFUSALS = new WeakMap<object, CheckpointCapacityRefusal>();
const GENERATION_CONFLICTS = new WeakMap<object, CheckpointGenerationConflict | undefined>();
const RECOVERY_IO_FAILURES = new WeakMap<object, RecoveryIoFailureRecord>();
const PRIOR_PENDING = new WeakMap<object, CheckpointPriorPending>();

function isObject(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

/**
 * Trusted guard-site issuer only. Associates a frozen diagnostic with the
 * exact error object. No auth, retry, write or dispatch permission is granted.
 * Never inspects the error's properties and preserves the first association.
 */
export function recordCheckpointCapacityRefusal(error: object, attemptId: string): void {
  if (typeof attemptId !== "string" || !ATTEMPT_ID.test(attemptId)) return;
  if (REFUSALS.has(error)) return;
  const sourceCauseCodes: readonly ["WINDOWS_RECOVERY_ARCHIVE_CAPACITY"] =
    Object.freeze(["WINDOWS_RECOVERY_ARCHIVE_CAPACITY"] as const);
  const diagnostic: CheckpointCapacityRefusal = Object.freeze({
    kind: "PRE_DISPATCH_CAPACITY",
    family: "CHECKPOINT",
    stage: "RESERVE",
    failureSubject: "CURRENT_ATTEMPT",
    mutationDispatch: "NOT_DISPATCHED_PROVEN",
    proofOrigin: "LOCAL_ADMISSION_GUARD",
    attemptId,
    sourceCauseCodes,
  });
  REFUSALS.set(error, diagnostic);
}

/** Exact object identity only: no property, getter, cause or Aggregate walk. */
export function getCheckpointCapacityRefusal(value: unknown): CheckpointCapacityRefusal | undefined {
  if (!isObject(value)) return undefined;
  return REFUSALS.get(value) ?? RECOVERY_IO_FAILURES.get(value)?.refusal;
}

type CheckpointPreconditionMismatch = "GENERATION" | "HEAD_TOKEN_OR_BYTES";
type CheckpointPreconditionCauseCode =
  | "CHECKPOINT_PRECONDITION_MISMATCH"
  | "WINDOWS_RECOVERY_PORT_CONFLICT";

function recordCheckpointPreconditionConflict(
  error: object,
  expectedGeneration: number,
  observedActualGeneration: number,
  mismatch: CheckpointPreconditionMismatch,
  sourceCauseCode: CheckpointPreconditionCauseCode,
): void {
  if (!isObject(error) ||
      !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0 ||
      expectedGeneration >= Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(observedActualGeneration) || observedActualGeneration < 0 ||
      (mismatch !== "GENERATION" && mismatch !== "HEAD_TOKEN_OR_BYTES") ||
      (mismatch === "GENERATION" && observedActualGeneration === expectedGeneration)) return;
  if (GENERATION_CONFLICTS.has(error)) return;
  const sourceCauseCodes: CheckpointGenerationConflict["sourceCauseCodes"] =
    sourceCauseCode === "WINDOWS_RECOVERY_PORT_CONFLICT"
      ? Object.freeze(["WINDOWS_RECOVERY_PORT_CONFLICT"] as const)
      : Object.freeze(["CHECKPOINT_PRECONDITION_MISMATCH"] as const);
  const precondition = Object.freeze({
    expectedGeneration,
    observedActualGeneration,
    mismatch,
  });
  const diagnostic: CheckpointGenerationConflict = Object.freeze({
    kind: "GENERATION_CONFLICT",
    family: "CHECKPOINT",
    stage: "PRECONDITION",
    failureSubject: "CURRENT_ATTEMPT",
    mutationDispatch: "NOT_DISPATCHED_PROVEN",
    proofOrigin: "VALIDATED_PRECONDITION",
    attemptId: null,
    sourceCauseCodes,
    precondition,
  });
  GENERATION_CONFLICTS.set(error, diagnostic);
}

/**
 * Trusted checkpoint-precondition issuer only. The exact error object is the
 * sole key; its properties are never inspected. The first association wins.
 */
export function recordCheckpointGenerationConflict(error: object, expectedGeneration: number, observedActualGeneration: number): void {
  recordCheckpointPreconditionConflict(
    error,
    expectedGeneration,
    observedActualGeneration,
    "GENERATION",
    "CHECKPOINT_PRECONDITION_MISMATCH",
  );
}

/**
 * Trusted port-precondition issuer only. The exact error object is the sole
 * key; its properties are never inspected. GENERATION must differ, while
 * HEAD_TOKEN_OR_BYTES may have equal counters. The first association wins.
 */
export function recordCheckpointPortPreconditionConflict(
  error: object,
  expectedGeneration: number,
  observedActualGeneration: number,
  mismatch: CheckpointPreconditionMismatch,
): void {
  recordCheckpointPreconditionConflict(
    error,
    expectedGeneration,
    observedActualGeneration,
    mismatch,
    "WINDOWS_RECOVERY_PORT_CONFLICT",
  );
}

/** Exact object identity only: no property, getter, cause or Aggregate walk. */
export function getCheckpointGenerationConflict(value: unknown): CheckpointGenerationConflict | undefined {
  if (!isObject(value)) return undefined;
  return GENERATION_CONFLICTS.get(value);
}

/**
 * Copies the exact currently recorded origin, or explicit absence, to a known
 * wrapper. Never infers from the original's properties or searches recursively.
 * The wrapper's first association is preserved.
 */
export function propagateCheckpointGenerationConflict(wrapper: object, original: unknown): void {
  if (!isObject(wrapper) || GENERATION_CONFLICTS.has(wrapper)) return;
  const captured = isObject(original) && GENERATION_CONFLICTS.has(original)
    ? GENERATION_CONFLICTS.get(original)
    : undefined;
  GENERATION_CONFLICTS.set(wrapper, captured);
}

/**
 * Retains the original error by identity even when it carries no capacity
 * origin. The result object may be frozen; it is never mutated. The first
 * association for the exact result object wins.
 */
export function rememberRecoveryIoFailure(result: object, originalError: unknown): void {
  if (RECOVERY_IO_FAILURES.has(result)) return;
  RECOVERY_IO_FAILURES.set(result, Object.freeze({
    cause: originalError,
    refusal: getCheckpointCapacityRefusal(originalError),
  }));
}

/** Retrieves only the associated original error, never a property of it. */
export function getRecoveryIoFailureCause(result: unknown): unknown {
  if (!isObject(result)) return undefined;
  return RECOVERY_IO_FAILURES.get(result)?.cause;
}

/**
 * Copies the remembered result's captured cause/origin to a known logical
 * wrapper. Never recomputes from a later-tagged original and never searches
 * recursively. The wrapper's first association is preserved.
 */
export function propagateRecoveryIoFailure(wrapper: object, result: unknown): void {
  if (!isObject(result)) return;
  const remembered = RECOVERY_IO_FAILURES.get(result);
  if (remembered === undefined) return;
  if (RECOVERY_IO_FAILURES.has(wrapper)) return;
  RECOVERY_IO_FAILURES.set(wrapper, remembered);
}

declare const privateMutationChannelOpaqueBrand: unique symbol;
declare const privateMutationEntryOpaqueBrand: unique symbol;

export type PrivateMutationChannel = { readonly [privateMutationChannelOpaqueBrand]: never };
export type PrivateMutationEntry = { readonly [privateMutationEntryOpaqueBrand]: never };

type PrivateMutationChannelState = "ARMED" | "ENTERED" | "SEALED" | "CONSUMED" | "AMBIGUOUS";

interface PrivateMutationChannelSlot {
  readonly state: PrivateMutationChannelState;
  readonly entry?: PrivateMutationEntry;
  readonly tag?: unknown;
  readonly value?: unknown;
}

const privateMutationChannels = new WeakMap<object, PrivateMutationChannelSlot>();
const privateMutationEntries = new WeakMap<object, object>();

function invalidatePrivateMutationChannel(channel: object, slot: PrivateMutationChannelSlot): void {
  privateMutationChannels.set(channel, { state: "AMBIGUOUS" });
  if (slot.entry !== undefined) privateMutationEntries.delete(slot.entry);
}

/**
 * Creates an opaque, one-shot terminal H/E identity channel.
 * Minted H/E handles are empty, frozen identities only: they prove no
 * publication, source, or authority. Values and thenables are never inspected,
 * awaited, cloned, or frozen.
 */
export function createPrivateMutationChannel(): PrivateMutationChannel {
  const channel = Object.freeze({}) as PrivateMutationChannel;
  privateMutationChannels.set(channel, { state: "ARMED" });
  return channel;
}

export function enterPrivateMutationChannel(channel: unknown): PrivateMutationEntry | undefined {
  if (!isObject(channel)) return undefined;
  const slot = privateMutationChannels.get(channel);
  if (slot === undefined) return undefined;
  if (slot.state === "ARMED") {
    const entry = Object.freeze({}) as PrivateMutationEntry;
    privateMutationEntries.set(entry, channel);
    privateMutationChannels.set(channel, { state: "ENTERED", entry });
    return entry;
  }
  if (slot.state === "ENTERED" || slot.state === "SEALED") {
    invalidatePrivateMutationChannel(channel, slot);
  }
  return undefined;
}

export function sealPrivateMutationChannel(
  channel: unknown,
  entry: unknown,
  tag: unknown,
  value: unknown,
): void {
  if (!isObject(channel)) return;
  const slot = privateMutationChannels.get(channel);
  if (slot === undefined) return;
  if (slot.state === "CONSUMED" || slot.state === "AMBIGUOUS") return;
  if (slot.state === "ARMED") {
    invalidatePrivateMutationChannel(channel, slot);
    return;
  }
  const currentEntry = slot.entry;
  if (
    !isObject(entry) ||
    currentEntry === undefined ||
    entry !== currentEntry ||
    privateMutationEntries.get(entry) !== channel
  ) {
    invalidatePrivateMutationChannel(channel, slot);
    return;
  }
  if (tag !== "THREW" && tag !== "RETURNED") {
    invalidatePrivateMutationChannel(channel, slot);
    return;
  }
  if (slot.state === "SEALED") {
    invalidatePrivateMutationChannel(channel, slot);
    return;
  }
  privateMutationChannels.set(channel, { state: "SEALED", entry: currentEntry, tag, value });
}

export function consumePrivateMutationChannel(
  channel: unknown,
  tag: unknown,
  value: unknown,
): PrivateMutationEntry | undefined {
  if (!isObject(channel)) return undefined;
  const slot = privateMutationChannels.get(channel);
  if (slot === undefined) return undefined;
  if (slot.state === "CONSUMED" || slot.state === "AMBIGUOUS") return undefined;
  if (slot.state === "ARMED" || slot.state === "ENTERED") {
    invalidatePrivateMutationChannel(channel, slot);
    return undefined;
  }
  const entry = slot.entry;
  const matched =
    (tag === "THREW" || tag === "RETURNED") &&
    slot.tag === tag &&
    Object.is(slot.value, value);
  privateMutationChannels.set(channel, { state: "CONSUMED" });
  if (entry !== undefined) privateMutationEntries.delete(entry);
  return matched ? entry : undefined;
}

/** Trusted source-guard issuer only. The list must be a nonempty array whose
 * own data entries are all 32-hex attempt ids (at most 64): exactly one id is
 * kept, more stay ambiguous. A non-array, empty, oversized, invalid, sparse,
 * accessor or throwing list issues no fact, no getter is ever invoked, and
 * the first association for an error is never replaced. */
export function recordCheckpointPriorPending(error: object, attemptIds: readonly string[]): void {
  if (!isObject(error) || PRIOR_PENDING.has(error)) return;
  const ids: string[] = [];
  try {
    if (!Array.isArray(attemptIds)) return;
    const length = Object.getOwnPropertyDescriptor(attemptIds, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 1 || length > 64) return;
    for (let index = 0; index < length; index++) {
      const entry = Object.getOwnPropertyDescriptor(attemptIds, String(index));
      if (!entry || !("value" in entry)) return;
      const id = entry.value;
      if (typeof id !== "string" || !ATTEMPT_ID.test(id)) return;
      ids.push(id);
    }
  } catch { return; }
  PRIOR_PENDING.set(error, Object.freeze({
    kind: "OUTCOME_UNKNOWN",
    family: "CHECKPOINT",
    stage: "PRIOR_ATTEMPT",
    failureSubject: "PRIOR_ATTEMPT",
    mutationDispatch: "UNPROVEN",
    proofOrigin: "NONE",
    attemptId: ids.length === 1 ? ids[0] : null,
  }));
}

/** Exact-identity lookup only; never reads properties or causes. */
export function getCheckpointPriorPending(value: unknown): CheckpointPriorPending | undefined {
  return isObject(value) ? PRIOR_PENDING.get(value) : undefined;
}

/** Copies the exact pending fact onto a known wrapper created by a trusted
 * site; never an arbitrary cause search. The first association wins. */
export function propagateCheckpointPriorPending(target: object, source: unknown): void {
  const pending = getCheckpointPriorPending(source);
  if (pending !== undefined && isObject(target) && !PRIOR_PENDING.has(target)) PRIOR_PENDING.set(target, pending);
}
