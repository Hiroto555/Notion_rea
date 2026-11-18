import {decodeStorageFailureV1, crashRecoveryBlockedMessageV1, type RequestReplyV1, type StorageFailureV1} from "../shared/private-storage-failure";
import {startupHasRetainedNativeLease} from "../persistence/startup-connection-owner";
import {getCheckpointCapacityRefusal, getKCapacityRefusal, getKMutationFailure, type CheckpointPriorPending} from "../platform/private-mutation-diagnostic";
import type {CrashRecoveryRead} from "../shared/crash-recovery";
import type {RecoveryWriteObservation} from "../persistence/crash-recovery-file";
import type {WorkspaceOpenTerminal} from "./workspace-backup-service";

const ATTEMPT_ID = /^[0-9a-f]{32}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ARCHIVE_CODES = [
  "WINDOWS_RECOVERY_ARCHIVE_CONFLICT",
  "WINDOWS_RECOVERY_ARCHIVE_PENDING",
  "WINDOWS_RECOVERY_ARCHIVE_WORKSPACE",
  "WINDOWS_RECOVERY_ARCHIVE_METADATA",
  "WINDOWS_RECOVERY_ARCHIVE_ORIGINAL",
  "WINDOWS_RECOVERY_ARCHIVE_EXPECTED",
  "WINDOWS_RECOVERY_ARCHIVE_GENERATION",
  "WINDOWS_RECOVERY_ARCHIVE_INTENT",
  "WINDOWS_RECOVERY_ARCHIVE_BUDGET",
  "WINDOWS_RECOVERY_ARCHIVE_CAPACITY",
  "WINDOWS_RECOVERY_ARCHIVE_TARGET",
  "WINDOWS_RECOVERY_ARCHIVE_ATTEMPT",
  "WINDOWS_RECOVERY_ARCHIVE_LOGICAL_PATH",
  "WINDOWS_RECOVERY_ARCHIVE_STORED",
  "WINDOWS_RECOVERY_ARCHIVE_BINDING",
  "WINDOWS_RECOVERY_ARCHIVE_SCHEMA",
  "WINDOWS_RECOVERY_ARCHIVE_CLOSED",
  "WINDOWS_RECOVERY_ARCHIVE_DISPATCH",
] as const;
const KNOWN_CODES = new Set<string>([
  ...ARCHIVE_CODES,
  "CHECKPOINT_PRECONDITION_MISMATCH",
  "PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY",
  "PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY",
  "PRIVATE_IO_V3_REJECTED",
  "PRIVATE_IO_V3_UNKNOWN",
  "PRIVATE_IO_V3_EXISTS",
  "PRIVATE_IO_V3_UNCONFIRMED",
  "WINDOWS_RECOVERY_PORT_CONFLICT",
  "WINDOWS_RECOVERY_PORT_PENDING",
  "UNAUTHORIZED_IPC_SENDER",
  "unauthorized",
  "K_EXCEPTION",
  "RESERVE",
  "DISPATCH",
  "CAPTURE",
  "TERMINAL",
  "MUTATION_EXEC",
  "PRIVATE_FILE_PUBLICATION_UNKNOWN",
]);

type CauseSummary = Readonly<{
  codes: string[];
  incomplete: boolean;
  omitted: boolean;
  omittedNodes: readonly object[];
  primitiveOmitted: boolean;
}>;

export type PrivateRequestBlockedRead = Readonly<{
  value: CrashRecoveryRead;
  error: unknown;
  priorPending: CheckpointPriorPending | undefined;
}>;

export type PrivateRequestFailureFacts = Readonly<{
  original: unknown;
  requestType: string;
  retainedFailure?: unknown;
  write?: RecoveryWriteObservation;
  read?: PrivateRequestBlockedRead;
  launch?: WorkspaceOpenTerminal;
}>;

type OwnData =
  | Readonly<{kind: "missing"}>
  | Readonly<{kind: "accessor"}>
  | Readonly<{kind: "trap"}>
  | Readonly<{kind: "data"; value: unknown}>;

function ownData(value: object, key: string): OwnData {
  let descriptor: PropertyDescriptor | undefined;
  try { descriptor = Object.getOwnPropertyDescriptor(value, key); }
  catch { return {kind: "trap"}; }
  if (descriptor === undefined) return {kind: "missing"};
  if (!("value" in descriptor)) return {kind: "accessor"};
  return {kind: "data", value: descriptor.value};
}

function isAggregateError(value: object): boolean {
  try { return value instanceof AggregateError; }
  catch { return false; }
}

/** Bounded own-data cause/code walk. No getter, message, stack, path or wire
 * property is evaluated. Missing detail is recoverable only when an exact
 * trusted current fact supplies its own bounded origin codes; accessors,
 * traps, cycles, sparse branches, unknown codes and arbitrary aggregates stay
 * incomplete regardless of that fallback. */
function causeSummary(root: unknown): CauseSummary {
  const queue: unknown[] = [root];
  const seen = new Set<object>();
  const codes: string[] = [];
  let incomplete = false;
  let omitted = false;
  let primitiveOmitted = false;
  const omittedNodes: object[] = [];
  const add = (value: unknown): void => {
    if (typeof value === "string" && CODE.test(value) && KNOWN_CODES.has(value) && !codes.includes(value) && codes.length < 8)
      codes.push(value);
  };
  while (queue.length !== 0) {
    const value = queue.pop();
    if (typeof value !== "object" || value === null) {
      omitted = true;
      primitiveOmitted = true;
      continue;
    }
    if (seen.has(value)) { incomplete = true; continue; }
    if (seen.size >= 64) { incomplete = true; continue; }
    seen.add(value);

    let inspected = false;
    const code = ownData(value, "code");
    if (code.kind === "accessor" || code.kind === "trap") incomplete = true;
    else if (code.kind === "data") {
      inspected = true;
      if (typeof code.value === "string" && CODE.test(code.value) && KNOWN_CODES.has(code.value)) add(code.value);
      else incomplete = true;
    }

    const errors = ownData(value, "errors");
    if (errors.kind === "accessor" || errors.kind === "trap") incomplete = true;
    else if (errors.kind === "data") {
      inspected = true;
      if (!Array.isArray(errors.value) || !isAggregateError(value)) incomplete = true;
      else {
        if (isAggregateError(value)) incomplete = true;
        const length = ownData(errors.value, "length");
        if (length.kind !== "data" || typeof length.value !== "number" ||
            !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 128) {
          incomplete = true;
        } else {
          if (length.value > 8) incomplete = true;
          const count = Math.min(8, length.value);
          for (let index = 0; index < count; index++) {
            const entry = ownData(errors.value, String(index));
            if (entry.kind === "data") queue.push(entry.value);
            else incomplete = true;
          }
        }
      }
    }

    const cause = ownData(value, "cause");
    if (cause.kind === "accessor" || cause.kind === "trap") incomplete = true;
    else if (cause.kind === "data") {
      inspected = true;
      queue.push(cause.value);
    }

    if (!inspected && code.kind === "missing" && errors.kind === "missing" && cause.kind === "missing") {
      omitted = true;
      omittedNodes.push(value);
    }
  }
  if (codes.length >= 8) incomplete = true;
  return Object.freeze({codes, incomplete, omitted, omittedNodes, primitiveOmitted});
}

function mergeCodes(
  base: CauseSummary,
  seeds: readonly unknown[],
  exemptOmitted: (node: object) => boolean = () => false,
): CauseSummary {
  const codes: string[] = [];
  let incomplete = base.incomplete || base.primitiveOmitted || base.omittedNodes.some((node) => {
    try { return !exemptOmitted(node); }
    catch { return true; }
  });
  for (const seed of seeds) {
    if (typeof seed !== "string" || !CODE.test(seed) || !KNOWN_CODES.has(seed)) {
      if (seed !== undefined) incomplete = true;
      continue;
    }
    if (!codes.includes(seed) && codes.length < 8) codes.push(seed);
  }
  for (const code of base.codes) {
    if (!codes.includes(code) && codes.length < 8) codes.push(code);
  }
  if (codes.length >= 8) incomplete = true;
  return Object.freeze({codes, incomplete, omitted: false, omittedNodes: [], primitiveOmitted: false});
}

function attemptId(value: unknown): string | null {
  return typeof value === "string" && ATTEMPT_ID.test(value) ? value : null;
}

function recoverySourceOutcome(value: unknown): StorageFailureV1["sourceOutcome"] {
  if (typeof value !== "object" || value === null) return null;
  const outcome = value as {source?: unknown; contractVersion?: unknown; state?: unknown; reason?: unknown};
  if (outcome.source !== "RECOVERY_IO" || outcome.contractVersion !== 3 ||
      (outcome.state !== "REJECTED" && outcome.state !== "EXISTS" &&
       outcome.state !== "UNKNOWN" && outcome.state !== "PUBLISHED") ||
      (outcome.state === "PUBLISHED" ? outcome.reason !== null :
       typeof outcome.reason !== "string" || !CODE.test(outcome.reason)))
    return null;
  return Object.freeze({
    source: "RECOVERY_IO",
    contractVersion: 3,
    state: outcome.state,
    reason: outcome.reason,
  }) as StorageFailureV1["sourceOutcome"];
}

function kSourceOutcome(value: unknown): StorageFailureV1["sourceOutcome"] {
  if (typeof value !== "object" || value === null) return null;
  const outcome = value as {source?: unknown; state?: unknown; reason?: unknown};
  if (outcome.source !== "K_EXCEPTION" ||
      (outcome.state !== "REJECTED" && outcome.state !== "EXISTS" && outcome.state !== "UNKNOWN") ||
      typeof outcome.reason !== "string" || !CODE.test(outcome.reason))
    return null;
  return Object.freeze({source: "K_EXCEPTION", state: outcome.state, reason: outcome.reason}) as StorageFailureV1["sourceOutcome"];
}

function failure(input: {
  kind: StorageFailureV1["kind"];
  family: StorageFailureV1["family"];
  stage: StorageFailureV1["stage"];
  failureSubject: StorageFailureV1["failureSubject"];
  mutationDispatch: StorageFailureV1["mutationDispatch"];
  proofOrigin: StorageFailureV1["proofOrigin"];
  requestType: string;
  sourceOutcome?: StorageFailureV1["sourceOutcome"];
  sourceCauseCodes?: string[];
  causeSummaryIncomplete?: boolean;
  attemptId?: string | null;
  precondition?: StorageFailureV1["precondition"];
}): StorageFailureV1 {
  return {
    version: 1,
    kind: input.kind,
    family: input.family,
    stage: input.stage,
    failureSubject: input.failureSubject,
    mutationDispatch: input.mutationDispatch,
    proofOrigin: input.proofOrigin,
    requestType: input.requestType,
    sourceOutcome: input.sourceOutcome ?? null,
    sourceCauseCodes: input.sourceCauseCodes ?? [],
    causeSummaryIncomplete: input.causeSummaryIncomplete ?? false,
    attemptId: input.attemptId ?? null,
    precondition: input.precondition ?? null,
    operationProgress: "PARTIAL_OR_UNKNOWN",
    retryAuthority: "NONE",
    preserve: true,
  };
}

function unclassified(requestType: string, summary: CauseSummary): StorageFailureV1 {
  const candidate = failure({
    kind: "UNCLASSIFIED",
    family: "REQUEST",
    stage: "REQUEST",
    failureSubject: "UNIDENTIFIED",
    mutationDispatch: "UNPROVEN",
    proofOrigin: "NONE",
    requestType,
    sourceCauseCodes: summary.codes,
    causeSummaryIncomplete: summary.incomplete || summary.omitted,
  });
  return decodeStorageFailureV1(candidate) ?? failure({
    kind: "UNCLASSIFIED",
    family: "REQUEST",
    stage: "REQUEST",
    failureSubject: "UNIDENTIFIED",
    mutationDispatch: "UNPROVEN",
    proofOrigin: "NONE",
    requestType: "UNRECOGNIZED",
    causeSummaryIncomplete: true,
  });
}

function retainedLease(value: unknown): boolean {
  try { return startupHasRetainedNativeLease(value); }
  catch { return false; }
}

function classify(facts: PrivateRequestFailureFacts, summary: CauseSummary): StorageFailureV1 | null {
  const requestType = typeof facts.requestType === "string" ? facts.requestType : "UNRECOGNIZED";
  if (retainedLease(facts.original) || retainedLease(facts.retainedFailure)) {
    return failure({
      kind: "OUTCOME_UNKNOWN",
      family: "REQUEST",
      stage: "REQUEST",
      failureSubject: "UNIDENTIFIED",
      mutationDispatch: "UNPROVEN",
      proofOrigin: "NONE",
      requestType,
      sourceCauseCodes: summary.codes,
      causeSummaryIncomplete: summary.incomplete || summary.omitted,
    });
  }

  const write = facts.write?.terminal === "THREW" && Object.is(facts.write.value, facts.original)
    ? facts.write
    : undefined;
  const postPublication = write?.postPublication;
  if (postPublication !== undefined) {
    const id = attemptId(postPublication.attemptId);
    if (id !== null) {
      const merged = mergeCodes(summary, []);
      return failure({
        kind: "OUTCOME_UNKNOWN",
        family: "CHECKPOINT",
        stage: postPublication.stage,
        failureSubject: "CURRENT_ATTEMPT",
        mutationDispatch: "DISPATCHED",
        proofOrigin: "DISPATCH_OBSERVED",
        requestType,
        sourceOutcome: recoverySourceOutcome(postPublication.sourceOutcome),
        sourceCauseCodes: merged.codes,
        causeSummaryIncomplete: merged.incomplete,
        attemptId: id,
      });
    }
  }

  const ioFailure = write?.recoveryIoFailure;
  if (ioFailure !== undefined) {
    let unclassifiedSummary: CauseSummary | undefined;
    const id = attemptId(ioFailure.attemptId);
    const dispatch = id !== null && ioFailure.dispatch !== undefined &&
      ioFailure.dispatch.attemptId === id
      ? ioFailure.dispatch
      : undefined;
    if (id !== null && dispatch !== undefined) {
      const outcome = recoverySourceOutcome(ioFailure.sourceOutcome);
      const merged = mergeCodes(summary, outcome !== null && outcome.reason !== null ? [outcome.reason] : []);
      return failure({
        kind: "OUTCOME_UNKNOWN",
        family: "CHECKPOINT",
        stage: dispatch.stage,
        failureSubject: "CURRENT_ATTEMPT",
        mutationDispatch: "DISPATCHED",
        proofOrigin: "DISPATCH_OBSERVED",
        requestType,
        sourceOutcome: outcome,
        sourceCauseCodes: merged.codes,
        causeSummaryIncomplete: merged.incomplete,
        attemptId: id,
      });
    }
    const refusal = ioFailure.capacityRefusal;
    const outcome = recoverySourceOutcome(ioFailure.sourceOutcome);
    if (id !== null && refusal !== undefined && refusal.attemptId === id &&
        ioFailure.dispatch === undefined && outcome !== null && outcome.state === "REJECTED") {
      const merged = mergeCodes(
        summary,
        refusal.sourceCauseCodes,
        (node) => getCheckpointCapacityRefusal(node) === refusal,
      );
      if (!merged.incomplete) {
        return failure({
          kind: "PRE_DISPATCH_CAPACITY",
          family: "CHECKPOINT",
          stage: "RESERVE",
          failureSubject: "CURRENT_ATTEMPT",
          mutationDispatch: "NOT_DISPATCHED_PROVEN",
          proofOrigin: "LOCAL_ADMISSION_GUARD",
          requestType,
          sourceOutcome: outcome,
          sourceCauseCodes: merged.codes,
          causeSummaryIncomplete: false,
          attemptId: id,
        });
      }
      unclassifiedSummary = merged;
    }
    if (id !== null) {
      const outcome = recoverySourceOutcome(ioFailure.sourceOutcome);
      if (outcome !== null && outcome.state !== "PUBLISHED" && outcome.reason !== null) {
        const merged = unclassifiedSummary ?? mergeCodes(summary, [outcome.reason]);
        return failure({
          kind: "UNCLASSIFIED",
          family: "CHECKPOINT",
          stage: "UNSPECIFIED",
          failureSubject: "CURRENT_ATTEMPT",
          mutationDispatch: "UNPROVEN",
          proofOrigin: "NONE",
          requestType,
          sourceOutcome: outcome,
          sourceCauseCodes: merged.codes,
          causeSummaryIncomplete: merged.incomplete,
          attemptId: id,
        });
      }
    }
  }

  const generationConflict = write?.generationConflict;
  if (generationConflict !== undefined && generationConflict.precondition !== undefined) {
    const precondition = generationConflict.precondition;
    const merged = mergeCodes(
      summary,
      generationConflict.sourceCauseCodes,
      (node) => node === facts.original,
    );
    if (!merged.incomplete) {
      return failure({
        kind: "GENERATION_CONFLICT",
        family: "CHECKPOINT",
        stage: "PRECONDITION",
        failureSubject: "CURRENT_ATTEMPT",
        mutationDispatch: "NOT_DISPATCHED_PROVEN",
        proofOrigin: "VALIDATED_PRECONDITION",
        requestType,
        sourceCauseCodes: merged.codes,
        causeSummaryIncomplete: false,
        precondition: {
          expectedGeneration: precondition.expectedGeneration,
          observedActualGeneration: precondition.observedActualGeneration,
          mismatch: precondition.mismatch,
        },
      });
    }
    return failure({
      kind: "UNCLASSIFIED",
      family: "CHECKPOINT",
      stage: "UNSPECIFIED",
      failureSubject: "CURRENT_ATTEMPT",
      mutationDispatch: "UNPROVEN",
      proofOrigin: "NONE",
      requestType,
      sourceCauseCodes: merged.codes,
      causeSummaryIncomplete: true,
    });
  }

  const writePriorPending = write?.priorPending;
  if (writePriorPending !== undefined) {
    const merged = mergeCodes(summary, []);
    return failure({
      kind: "OUTCOME_UNKNOWN",
      family: "CHECKPOINT",
      stage: "PRIOR_ATTEMPT",
      failureSubject: "PRIOR_ATTEMPT",
      mutationDispatch: "UNPROVEN",
      proofOrigin: "NONE",
      requestType,
      sourceCauseCodes: merged.codes,
      causeSummaryIncomplete: merged.incomplete,
      attemptId: attemptId(writePriorPending.attemptId),
    });
  }

  const readPriorPending = facts.read !== undefined && Object.is(facts.read.error, facts.original)
    ? facts.read.priorPending
    : undefined;
  if (readPriorPending !== undefined) {
    const merged = mergeCodes(summary, []);
    return failure({
      kind: "OUTCOME_UNKNOWN",
      family: "CHECKPOINT",
      stage: "READBACK",
      failureSubject: "UNIDENTIFIED",
      mutationDispatch: "UNPROVEN",
      proofOrigin: "NONE",
      requestType,
      sourceCauseCodes: merged.codes,
      causeSummaryIncomplete: merged.incomplete,
      attemptId: null,
    });
  }

  const kFailure = getKMutationFailure(facts.original);
  if (kFailure !== undefined) {
    let unclassifiedSummary: CauseSummary | undefined;
    const id = attemptId(kFailure.attemptId);
    const outcome = kSourceOutcome(kFailure.sourceOutcome);
    if (id !== null && kFailure.mutationDispatch === "DISPATCHED") {
      const stage = kFailure.uncertainty === undefined ? "UNSPECIFIED" :
        kFailure.uncertainty.stage === "RESERVE" ? "RESERVE" :
        kFailure.uncertainty.stage === "DISPATCH" ? "PREPARE" :
        kFailure.uncertainty.stage === "CAPTURE" ? "READBACK" : "COMMIT";
      const merged = mergeCodes(summary, outcome !== null ? [outcome.reason] : []);
      return failure({
        kind: "OUTCOME_UNKNOWN",
        family: "K",
        stage,
        failureSubject: "CURRENT_ATTEMPT",
        mutationDispatch: "DISPATCHED",
        proofOrigin: "DISPATCH_OBSERVED",
        requestType,
        sourceOutcome: outcome,
        sourceCauseCodes: merged.codes,
        causeSummaryIncomplete: merged.incomplete,
        attemptId: id,
      });
    }
    const capacity = kFailure.capacityRefusal;
    if (id !== null && capacity !== undefined && capacity.attemptId === id &&
        kFailure.uncertainty === undefined && kFailure.mutationDispatch === "NOT_DISPATCHED_PROVEN" &&
        outcome !== null && outcome.state === "UNKNOWN" && outcome.reason === "RESERVE") {
      const merged = mergeCodes(
        summary,
        capacity.sourceCauseCodes,
        (node) => getKMutationFailure(node)?.capacityRefusal === capacity ||
            getKCapacityRefusal(node) === capacity,
      );
      if (!merged.incomplete) {
        return failure({
          kind: "PRE_DISPATCH_CAPACITY",
          family: "K",
          stage: "RESERVE",
          failureSubject: "CURRENT_ATTEMPT",
          mutationDispatch: "NOT_DISPATCHED_PROVEN",
          proofOrigin: "LOCAL_ADMISSION_GUARD",
          requestType,
          sourceOutcome: outcome,
          sourceCauseCodes: merged.codes,
          causeSummaryIncomplete: false,
          attemptId: id,
        });
      }
      unclassifiedSummary = merged;
    }
    if (id !== null && kFailure.uncertainty !== undefined &&
        kFailure.mutationDispatch === "NOT_DISPATCHED_PROVEN") {
      const stage = kFailure.uncertainty.stage === "RESERVE" ? "RESERVE" :
        kFailure.uncertainty.stage === "DISPATCH" ? "PREPARE" :
        kFailure.uncertainty.stage === "CAPTURE" ? "READBACK" : "COMMIT";
      const merged = mergeCodes(summary, outcome !== null ? [outcome.reason] : []);
      return failure({
        kind: "OUTCOME_UNKNOWN",
        family: "K",
        stage,
        failureSubject: "CURRENT_ATTEMPT",
        mutationDispatch: "UNPROVEN",
        proofOrigin: "NONE",
        requestType,
        sourceOutcome: outcome,
        sourceCauseCodes: merged.codes,
        causeSummaryIncomplete: merged.incomplete,
        attemptId: id,
      });
    }
    if (id !== null && outcome !== null && outcome.reason !== null) {
      const merged = unclassifiedSummary ?? mergeCodes(summary, [outcome.reason]);
      return failure({
        kind: "UNCLASSIFIED",
        family: "K",
        stage: "UNSPECIFIED",
        failureSubject: "CURRENT_ATTEMPT",
        mutationDispatch: "UNPROVEN",
        proofOrigin: "NONE",
        requestType,
        sourceOutcome: outcome,
        sourceCauseCodes: merged.codes,
        causeSummaryIncomplete: merged.incomplete,
        attemptId: id,
      });
    }
  }

  const launch = facts.launch?.terminal === "THREW" && Object.is(facts.launch.value, facts.original)
    ? facts.launch
    : undefined;
  if (launch?.terminal === "THREW" && launch.launchStarted === true) {
    const merged = mergeCodes(summary, []);
    return failure({
      kind: "OUTCOME_UNKNOWN",
      family: "REQUEST",
      stage: "REQUEST",
      failureSubject: "CURRENT_ATTEMPT",
      mutationDispatch: "DISPATCHED",
      proofOrigin: "DISPATCH_OBSERVED",
      requestType,
      sourceCauseCodes: merged.codes,
      causeSummaryIncomplete: merged.incomplete,
    });
  }

  return null;
}

/** Never throws and never trusts renderer-provided failure fields. */
export function privateRequestStorageFailure(facts: PrivateRequestFailureFacts): StorageFailureV1 {
  const requestType = typeof facts.requestType === "string" ? facts.requestType : "UNRECOGNIZED";
  let summary: CauseSummary;
  try { summary = causeSummary(facts.original); }
  catch {
    summary = Object.freeze({
      codes: [],
      incomplete: true,
      omitted: false,
      omittedNodes: [],
      primitiveOmitted: false,
    });
  }
  try {
    const candidate = classify(facts, summary);
    if (candidate !== null) {
      const decoded = decodeStorageFailureV1(candidate);
      if (decoded !== null) return decoded;
    }
  } catch { /* fail closed below */ }
  return unclassified(requestType, summary);
}

/** Success envelope: undefined is an absent slot; every other falsy value is
 * present exactly. An exact blocked recovery result is replaced by the fixed
 * safe blocked value and its bounded v1 diagnostic. */
export function privateRequestSuccessReply(input: {
  value: unknown;
  requestType: string;
  retainedFailure?: unknown;
  read?: PrivateRequestBlockedRead;
}): RequestReplyV1<unknown> {
  const read = input.read;
  if (read !== undefined && input.value === read.value) {
    const diagnostic = privateRequestStorageFailure({
      original: read.error,
      retainedFailure: input.retainedFailure,
      requestType: input.requestType,
      read,
    });
    return {
      tag: "folio-request-result",
      version: 1,
      ok: true,
      valueSlot: {
        present: true,
        value: {
          status: "blocked",
          generation: 0,
          message: crashRecoveryBlockedMessageV1(),
          storageFailure: diagnostic,
        },
      },
    };
  }
  if (input.value === undefined) {
    return {
      tag: "folio-request-result",
      version: 1,
      ok: true,
      valueSlot: {present: false},
    };
  }
  return {
    tag: "folio-request-result",
    version: 1,
    ok: true,
    valueSlot: {present: true, value: input.value},
  };
}

export function privateRequestFailureReply(facts: PrivateRequestFailureFacts): RequestReplyV1<unknown> {
  return {
    tag: "folio-request-result",
    version: 1,
    ok: false,
    failure: privateRequestStorageFailure(facts),
  };
}
