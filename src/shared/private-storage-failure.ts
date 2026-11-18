import {requestSchema} from './types';

export function crashRecoveryBlockedMessageV1(): string {
  return "Crash recovery read is blocked; original failure retained";
}

export interface StorageFailureV1 {
  readonly version: 1;
  readonly kind:
    | 'PRE_DISPATCH_CAPACITY'
    | 'OUTCOME_UNKNOWN'
    | 'GENERATION_CONFLICT'
    | 'UNCLASSIFIED';
  readonly family: 'CHECKPOINT' | 'K' | 'REQUEST';
  readonly stage:
    | 'PRECONDITION'
    | 'RESERVE'
    | 'PREPARE'
    | 'COMMIT'
    | 'HEAD_CAS'
    | 'READBACK'
    | 'PRIOR_ATTEMPT'
    | 'REQUEST'
    | 'UNSPECIFIED';
  readonly failureSubject: 'CURRENT_ATTEMPT' | 'PRIOR_ATTEMPT' | 'UNIDENTIFIED';
  readonly mutationDispatch: 'NOT_DISPATCHED_PROVEN' | 'DISPATCHED' | 'UNPROVEN';
  readonly proofOrigin:
    | 'LOCAL_ADMISSION_GUARD'
    | 'VALIDATED_PRECONDITION'
    | 'DISPATCH_OBSERVED'
    | 'NONE';
  readonly requestType: string;
  readonly sourceOutcome:
    | null
    | {
        readonly source: 'RECOVERY_IO';
        readonly contractVersion: 3;
        readonly state: 'REJECTED' | 'EXISTS' | 'UNKNOWN' | 'PUBLISHED';
        readonly reason: string | null;
      }
    | {
        readonly source: 'K_EXCEPTION';
        readonly state: 'REJECTED' | 'EXISTS' | 'UNKNOWN';
        readonly reason: string;
      };
  readonly sourceCauseCodes: string[];
  readonly causeSummaryIncomplete: boolean;
  readonly attemptId: string | null;
  readonly precondition:
    | null
    | {
        readonly expectedGeneration: number;
        readonly observedActualGeneration: number | null;
        readonly mismatch: 'GENERATION' | 'HEAD_TOKEN_OR_BYTES';
      };
  readonly operationProgress: 'PARTIAL_OR_UNKNOWN';
  readonly retryAuthority: 'NONE';
  readonly preserve: true;
}

export type RequestReplyV1<T> =
  | {
      readonly tag: 'folio-request-result';
      readonly version: 1;
      readonly ok: true;
      readonly valueSlot:
        | { readonly present: false }
        | { readonly present: true; readonly value: T };
    }
  | {
      readonly tag: 'folio-request-result';
      readonly version: 1;
      readonly ok: false;
      readonly failure: StorageFailureV1;
    };


type PlainRecord = Record<string, unknown>;

function readExact(input: unknown, keys: readonly string[]): PlainRecord | null {
  if (typeof input !== 'object' || input === null) return null;

  try {
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return null;

    if (Object.getOwnPropertySymbols(input).length !== 0) return null;

    const names = Object.getOwnPropertyNames(input);
    const wanted = new Set(keys);
    if (wanted.size !== keys.length || names.length !== keys.length) return null;

    for (const name of names) {
      if (!wanted.has(name)) return null;
    }

    const out = Object.create(null) as PlainRecord;
    for (const key of keys) {
      const desc = Object.getOwnPropertyDescriptor(input, key);
      if (!desc || !desc.enumerable || !('value' in desc)) return null;
      if (desc.get !== undefined || desc.set !== undefined) return null;

      Object.defineProperty(out, key, {
        value: desc.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }

    return out;
  } catch {
    return null;
  }
}

function readCodeList(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;

  try {
    if (Object.getPrototypeOf(input) !== Array.prototype) return null;
    if (Object.getOwnPropertySymbols(input).length !== 0) return null;

    const names = Object.getOwnPropertyNames(input);
    const lengthDesc = Object.getOwnPropertyDescriptor(input, 'length');
    if (!lengthDesc || !('value' in lengthDesc)) return null;
    if (lengthDesc.get !== undefined || lengthDesc.set !== undefined) return null;

    const length = lengthDesc.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length)) return null;
    if (length < 0 || length > 8) return null;
    if (names.length !== length + 1) return null;

    const descs: Array<PropertyDescriptor | undefined> = new Array(length);
    let sawLength = false;

    for (const name of names) {
      if (name === 'length') {
        if (sawLength) return null;
        sawLength = true;
        continue;
      }

      if (!/^(0|[1-9]\d*)$/.test(name)) return null;
      const index = Number(name);
      if (String(index) !== name || index >= length) return null;
      if (descs[index] !== undefined) return null;

      const desc = Object.getOwnPropertyDescriptor(input, name);
      if (!desc || !desc.enumerable || !('value' in desc)) return null;
      if (desc.get !== undefined || desc.set !== undefined) return null;

      descs[index] = desc;
    }

    if (!sawLength) return null;

    const out: string[] = [];
    for (let i = 0; i < length; i += 1) {
      const desc = descs[i];
      if (!desc || !isCode(desc.value)) return null;
      out.push(desc.value);
    }

    return out;
  } catch {
    return null;
  }
}

function isCode(input: unknown): input is string {
  if (typeof input !== 'string' || input.length < 1 || input.length > 128) {
    return false;
  }

  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input);
}

function isSafeGeneration(input: unknown): input is number {
  return typeof input === 'number' && input >= 0 && Number.isSafeInteger(input);
}

function knownRequestType(input: unknown): input is string {
  if (typeof input !== 'string') return false;
  if (input === 'UNRECOGNIZED') return true;

  try {
    return requestSchema.options.some(
      (option) => option.shape.type.safeParse(input).success,
    );
  } catch {
    return false;
  }
}

function inSet(input: unknown, allowed: readonly string[]): boolean {
  return typeof input === 'string' && allowed.includes(input);
}

function decodeFailureShape(input: unknown): StorageFailureV1 | null {
  try {
    const requiredKeys = [
      "version",
      "kind",
      "family",
      "stage",
      "failureSubject",
      "mutationDispatch",
      "proofOrigin",
      "requestType",
      "sourceOutcome",
      "sourceCauseCodes",
      "causeSummaryIncomplete",
      "attemptId",
      "precondition",
      "operationProgress",
      "retryAuthority",
      "preserve",
    ];

    const top = readExact(input, requiredKeys);
    if (!top) return null;

    if (top.version !== 1) return null;
    if (top.preserve !== true) return null;
    if (top.operationProgress !== "PARTIAL_OR_UNKNOWN") return null;
    if (top.retryAuthority !== "NONE") return null;
    if (typeof top.causeSummaryIncomplete !== "boolean") return null;
    if (!knownRequestType(top.requestType)) return null;

    const attemptId = top.attemptId;
    if (
      attemptId !== null &&
      !(typeof attemptId === "string" && /^[0-9a-f]{32}$/.test(attemptId))
    ) {
      return null;
    }

    if (!inSet(top.kind, ["PRE_DISPATCH_CAPACITY", "OUTCOME_UNKNOWN", "GENERATION_CONFLICT", "UNCLASSIFIED"])) return null;
    if (!inSet(top.family, ["CHECKPOINT", "K", "REQUEST"])) return null;
    if (!inSet(top.stage, ["PRECONDITION", "RESERVE", "PREPARE", "COMMIT", "HEAD_CAS", "READBACK", "PRIOR_ATTEMPT", "REQUEST", "UNSPECIFIED"])) return null;
    if (!inSet(top.failureSubject, ["CURRENT_ATTEMPT", "PRIOR_ATTEMPT", "UNIDENTIFIED"])) return null;
    if (!inSet(top.mutationDispatch, ["NOT_DISPATCHED_PROVEN", "DISPATCHED", "UNPROVEN"])) return null;
    if (!inSet(top.proofOrigin, ["LOCAL_ADMISSION_GUARD", "VALIDATED_PRECONDITION", "DISPATCH_OBSERVED", "NONE"])) return null;

    const sourceCauseCodes = readCodeList(top.sourceCauseCodes);
    if (!sourceCauseCodes) return null;

    let sourceOutcome: StorageFailureV1["sourceOutcome"] = null;
    const rawOutcome = top.sourceOutcome;
    if (rawOutcome !== null) {
      const recovery = readExact(rawOutcome, ["source", "contractVersion", "state", "reason"]);
      if (recovery && recovery.source === "RECOVERY_IO") {
        if (recovery.contractVersion !== 3) return null;
        if (!inSet(recovery.state, ["REJECTED", "EXISTS", "UNKNOWN", "PUBLISHED"])) return null;
        if (recovery.reason !== null && !isCode(recovery.reason)) return null;
        sourceOutcome = {
          source: "RECOVERY_IO",
          contractVersion: 3,
          state: recovery.state,
          reason: recovery.reason,
        } as StorageFailureV1["sourceOutcome"];
      } else {
        const kException = readExact(rawOutcome, ["source", "state", "reason"]);
        if (!kException) return null;
        if (kException.source !== "K_EXCEPTION") return null;
        if (!inSet(kException.state, ["REJECTED", "EXISTS", "UNKNOWN"])) return null;
        if (!isCode(kException.reason)) return null;
        sourceOutcome = {
          source: "K_EXCEPTION",
          state: kException.state,
          reason: kException.reason,
        } as StorageFailureV1["sourceOutcome"];
      }
    }

    let precondition: StorageFailureV1["precondition"] = null;
    const rawPrecondition = top.precondition;
    if (rawPrecondition !== null) {
      const checked = readExact(rawPrecondition, [
        "expectedGeneration",
        "observedActualGeneration",
        "mismatch",
      ]);
      if (!checked) return null;
      if (!isSafeGeneration(checked.expectedGeneration)) return null;
      if (checked.observedActualGeneration !== null && !isSafeGeneration(checked.observedActualGeneration)) return null;
      if (!inSet(checked.mismatch, ["GENERATION", "HEAD_TOKEN_OR_BYTES"])) return null;
      precondition = {
        expectedGeneration: checked.expectedGeneration,
        observedActualGeneration: checked.observedActualGeneration,
        mismatch: checked.mismatch,
      } as StorageFailureV1["precondition"];
    }

    return {
      version: 1,
      kind: top.kind,
      family: top.family,
      stage: top.stage,
      failureSubject: top.failureSubject,
      mutationDispatch: top.mutationDispatch,
      proofOrigin: top.proofOrigin,
      requestType: top.requestType,
      sourceOutcome,
      sourceCauseCodes,
      causeSummaryIncomplete: top.causeSummaryIncomplete,
      attemptId,
      precondition,
      operationProgress: "PARTIAL_OR_UNKNOWN",
      retryAuthority: "NONE",
      preserve: true,
    } as StorageFailureV1;
  } catch {
    return null;
  }
}

function consistentSource(f: StorageFailureV1): boolean {
  const outcome = f.sourceOutcome;
  if (outcome !== null) {
    if (outcome.source === "RECOVERY_IO") {
      if (f.family !== "CHECKPOINT") return false;
      if (outcome.state === "PUBLISHED") {
        if (outcome.reason !== null) return false;
        if (f.kind !== "OUTCOME_UNKNOWN" || f.mutationDispatch !== "DISPATCHED" || f.proofOrigin !== "DISPATCH_OBSERVED") return false;
      } else if (outcome.reason === null) {
        return false;
      }
    } else if (f.family !== "K") {
      return false;
    }
  }
  if (f.mutationDispatch === "DISPATCHED" && f.proofOrigin !== "DISPATCH_OBSERVED") return false;
  if (f.proofOrigin === "DISPATCH_OBSERVED" && f.mutationDispatch !== "DISPATCHED") return false;
  if (f.mutationDispatch === "UNPROVEN" && f.proofOrigin !== "NONE") return false;
  if (f.mutationDispatch === "NOT_DISPATCHED_PROVEN" && f.proofOrigin !== "LOCAL_ADMISSION_GUARD" && f.proofOrigin !== "VALIDATED_PRECONDITION") return false;
  if (f.failureSubject === "PRIOR_ATTEMPT") {
    if (f.kind !== "OUTCOME_UNKNOWN" || f.stage !== "PRIOR_ATTEMPT" || f.mutationDispatch !== "UNPROVEN" || f.proofOrigin !== "NONE") return false;
  }
  if (f.stage === "PRIOR_ATTEMPT" && f.failureSubject !== "PRIOR_ATTEMPT") return false;
  if (f.kind === "GENERATION_CONFLICT") {
    if (f.precondition === null) return false;
  } else if (f.precondition !== null) {
    return false;
  }
  return true;
}

function consistentKind(f: StorageFailureV1): boolean {
  switch (f.kind) {
    case 'PRE_DISPATCH_CAPACITY':
      if (
        f.failureSubject !== 'CURRENT_ATTEMPT' ||
        f.mutationDispatch !== 'NOT_DISPATCHED_PROVEN' ||
        f.proofOrigin !== 'LOCAL_ADMISSION_GUARD' ||
        f.stage !== 'RESERVE' ||
        (f.family !== 'CHECKPOINT' && f.family !== 'K') ||
        f.requestType === 'UNRECOGNIZED' ||
        f.causeSummaryIncomplete ||
        f.sourceCauseCodes.length === 0 ||
        f.precondition !== null
      ) return false;
      if (f.sourceOutcome === null) return true;
      if (f.family === 'CHECKPOINT') {
        return f.sourceOutcome.source === 'RECOVERY_IO' &&
          f.sourceOutcome.state === 'REJECTED';
      }
      return f.sourceOutcome.source === 'K_EXCEPTION' &&
        f.sourceOutcome.state === 'UNKNOWN' &&
        f.sourceOutcome.reason === 'RESERVE';
    case 'GENERATION_CONFLICT':
      if (
        f.family !== 'CHECKPOINT' ||
        f.failureSubject !== 'CURRENT_ATTEMPT' ||
        f.mutationDispatch !== 'NOT_DISPATCHED_PROVEN' ||
        f.proofOrigin !== 'VALIDATED_PRECONDITION' ||
        f.stage !== 'PRECONDITION' ||
        f.requestType === 'UNRECOGNIZED' ||
        f.causeSummaryIncomplete ||
        f.sourceCauseCodes.length === 0 ||
        f.precondition === null
      ) return false;
      if (
        f.precondition.mismatch === 'GENERATION' &&
        f.precondition.observedActualGeneration !== null &&
        f.precondition.observedActualGeneration === f.precondition.expectedGeneration
      ) return false;
      return f.sourceOutcome === null ||
        (f.sourceOutcome.source === 'RECOVERY_IO' && f.sourceOutcome.state === 'REJECTED');
    case 'OUTCOME_UNKNOWN':
      if (f.precondition !== null) return false;
      return (
        (f.mutationDispatch === 'DISPATCHED' && f.proofOrigin === 'DISPATCH_OBSERVED') ||
        (f.mutationDispatch === 'UNPROVEN' && f.proofOrigin === 'NONE')
      );
    case 'UNCLASSIFIED':
      return f.mutationDispatch === 'UNPROVEN' &&
        f.proofOrigin === 'NONE' &&
        f.precondition === null;
    default:
      return false;
  }
}

export function decodeStorageFailureV1(
  input: unknown,
  expectedRequestType?: string,
): StorageFailureV1 | null {
  try {
    const f = decodeFailureShape(input);
    if (!f) return null;
    if (!consistentSource(f) || !consistentKind(f)) return null;

    if (expectedRequestType !== undefined) {
      if (!knownRequestType(expectedRequestType)) return null;
      if (f.requestType !== expectedRequestType) {
        const safeMismatch =
          f.requestType === 'UNRECOGNIZED' &&
          f.family === 'REQUEST' &&
          (f.kind === 'OUTCOME_UNKNOWN' || f.kind === 'UNCLASSIFIED') &&
          f.mutationDispatch === 'UNPROVEN' &&
          f.proofOrigin === 'NONE';
        if (!safeMismatch) return null;
      }
    }

    const size = new TextEncoder().encode(JSON.stringify(f)).byteLength;
    if (size > 8192) return null;

    return f;
  } catch {
    return null;
  }
}

export function decodeRequestReplyV1(
  input: unknown,
  expectedRequestType?: string,
): RequestReplyV1<unknown> | null {
  try {
    if (expectedRequestType !== undefined && !knownRequestType(expectedRequestType)) {
      return null;
    }

    const success = readExact(input, ['tag', 'version', 'ok', 'valueSlot']);
    if (success) {
      if (
        success.tag !== 'folio-request-result' ||
        success.version !== 1 ||
        typeof success.ok !== 'boolean' ||
        success.ok !== true
      ) {
        return null;
      }

      const emptySlot = readExact(success.valueSlot, ['present']);
      if (emptySlot) {
        if (emptySlot.present !== false) return null;
        return {
          tag: 'folio-request-result',
          version: 1,
          ok: true,
          valueSlot: { present: false },
        };
      }

      const fullSlot = readExact(success.valueSlot, ['present', 'value']);
      if (!fullSlot) return null;
      if (fullSlot.present !== true || fullSlot.value === undefined) return null;
      return {
        tag: 'folio-request-result',
        version: 1,
        ok: true,
        valueSlot: { present: true, value: fullSlot.value },
      };
    }

    const failure = readExact(input, ['tag', 'version', 'ok', 'failure']);
    if (!failure) return null;
    if (
      failure.tag !== 'folio-request-result' ||
      failure.version !== 1 ||
      typeof failure.ok !== 'boolean' ||
      failure.ok !== false
    ) {
      return null;
    }

    const decoded = decodeStorageFailureV1(failure.failure, expectedRequestType);
    if (!decoded) return null;
    return {
      tag: 'folio-request-result',
      version: 1,
      ok: false,
      failure: decoded,
    };
  } catch {
    return null;
  }
}
