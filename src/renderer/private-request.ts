import {
  decodeRequestReplyV1,
  decodeStorageFailureV1,
  type RequestReplyV1,
  type StorageFailureV1,
} from "../shared/private-storage-failure";
import type { Request } from "../shared/types";

/** Fixed display text per the C03 contract §4. It is chosen by kind/family
 * alone and never inferred from a transport or source message, so a malformed
 * payload cannot steer what the user is told. */
export function storageFailureMessageV1(failure: StorageFailureV1): string {
  switch (failure.kind) {
    case "PRE_DISPATCH_CAPACITY":
      return failure.family === "K"
        ? "今回拒否された低位処理は開始していませんが、先行marker等の途中成果や以前の未確認結果が残る場合があります。"
        : "復旧用保存の容量枠が不足し、このattemptの新規公開は開始していません。入力を保持し、後続保存を停止しました。";
    case "OUTCOME_UNKNOWN":
      return "処理結果を確認できません。入力と証拠を保持しています。再送せず確認・救出を行ってください。";
    case "GENERATION_CONFLICT":
      return "復旧記録の世代が一致しません。入力を保持し、保存を停止しました。";
    default:
      return "安全に分類できないため結果は未確認として停止しました。";
  }
}

function buildUnclassified(requestType: string): StorageFailureV1 {
  return {
    version: 1,
    kind: "UNCLASSIFIED",
    family: "REQUEST",
    stage: "REQUEST",
    failureSubject: "UNIDENTIFIED",
    mutationDispatch: "UNPROVEN",
    proofOrigin: "NONE",
    requestType,
    sourceOutcome: null,
    sourceCauseCodes: [],
    causeSummaryIncomplete: true,
    attemptId: null,
    precondition: null,
    operationProgress: "PARTIAL_OR_UNKNOWN",
    retryAuthority: "NONE",
    preserve: true,
  };
}

/** The renderer-local UNCLASSIFIED diagnostic for a send whose outcome cannot
 * be proven: missing API, transport rejection, or a malformed, oversized,
 * accessor-, cycle-bearing or mismatched reply. U6/U7 create the same E by
 * expected request type through this helper instead of inventing fields. */
export function unclassifiedRequestFailure(requestType: unknown): StorageFailureV1 {
  try {
    const candidate = buildUnclassified(
      typeof requestType === "string" ? requestType : "UNRECOGNIZED",
    );
    return decodeStorageFailureV1(candidate) ?? buildUnclassified("UNRECOGNIZED");
  } catch {
    return buildUnclassified("UNRECOGNIZED");
  }
}

/** Local error for one validated bounded diagnostic. It never carries the
 * transport message, a cause chain, a request or a path; the stored failure is
 * always re-validated so callers can only ever hold the bounded DTO. */
export class StorageFailureError extends Error {
  readonly storageFailure: StorageFailureV1;
  constructor(failure: unknown) {
    let validated: StorageFailureV1 | null = null;
    try {
      validated = decodeStorageFailureV1(failure);
    } catch {
      validated = null;
    }
    const storageFailure = validated ?? unclassifiedRequestFailure("UNRECOGNIZED");
    super(storageFailureMessageV1(storageFailure));
    this.name = "StorageFailureError";
    this.storageFailure = storageFailure;
  }
}

/** Read one own data property without ever executing an accessor and without
 * letting a proxy trap escape raw. Accessor, inherited and trap-throwing reads
 * all yield undefined, so a hostile or transient carrier fails closed. */
function ownDataValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** Retrieve the validated local diagnostic carried by a thrown error or a
 * transient result field. The candidate is always an own data property read
 * without executing any accessor, and it is revalidated here against the
 * expected request type every call — a stale, mutated or mismatched DTO is
 * never trusted on instance or name alone. Returns undefined when nothing
 * bounded was attached; a foreign message, name or code is never promoted
 * into a diagnostic. */
export function requestStorageFailure(
  error: unknown,
  expectedRequestType?: string,
): StorageFailureV1 | undefined {
  const candidate = ownDataValue(error, "storageFailure");
  if (candidate === undefined) return undefined;
  try {
    return decodeStorageFailureV1(candidate, expectedRequestType) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Wrap any caught value as a diagnostic error. The carried diagnostic is
 * revalidated against the expected request type every call and is always
 * re-wrapped as a fresh local error carrying only the bounded DTO and the
 * fixed safe message — a valid matching diagnostic is preserved in content,
 * while a diagnostic for another request or a mutated, accessor- or
 * trap-bearing carrier becomes the local UNCLASSIFIED failure instead.
 * Instance, name, prototype or message are never proof of a safe error, so
 * the original object and its raw message or cause are never returned. */
export function toStorageFailureError(error: unknown, requestType: unknown): StorageFailureError {
  const expected = typeof requestType === "string" ? requestType : undefined;
  const failure = requestStorageFailure(error, expected);
  return new StorageFailureError(failure ?? unclassifiedRequestFailure(requestType));
}

/** The expected request type is read as an own data property so a request
 * accessor or proxy trap cannot escape raw outside the transport boundary;
 * an unreadable type is simply UNRECOGNIZED, matching an unparseable request. */
function sentRequestType(request: Request): string {
  const type = ownDataValue(request, "type");
  return typeof type === "string" ? type : "UNRECOGNIZED";
}

/** A nested blocked-read diagnostic, when present, must itself be a valid
 * bounded failure for recovery:read. Accessor, trap and malformed entries are
 * invalid; the value is never rewritten, so a blocked read stays blocked. */
function validNestedReadDiagnostic(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, "storageFailure");
  } catch {
    return false;
  }
  if (descriptor === undefined) return true;
  if (!("value" in descriptor)) return false;
  try {
    return decodeStorageFailureV1(descriptor.value, "recovery:read") !== null;
  } catch {
    return false;
  }
}

/** Browser-side adapter for the folio:request:diagnostic-v1 lane. A missing
 * API, a transport rejection (including a timeout) or any invalid envelope
 * becomes the local UNCLASSIFIED diagnostic — never a legacy fallback, never a
 * resend. The transport catch is deliberately separate from decode/throw so a
 * valid typed failure is never downgraded. Success values, including falsy
 * ones, ready ACKs, previews and cancellations, pass through unchanged.
 *
 * A caller may pass an optional per-call synchronous success decoder. When
 * present it runs after the envelope and nested-read checks but before the
 * value crosses the async return boundary, so the promise machinery never
 * assimilates an unchecked carrier's `then`: the decoder inspects the raw
 * success value — or undefined for an absent value slot — and its throw
 * becomes the actual request type's local UNCLASSIFIED failure. With no
 * decoder the success value stays opaque exactly as before. */
export function createDiagnosticRequest(
  invoke: unknown,
): <T>(request: Request, decodeSuccess?: (value: unknown) => T) => Promise<T> {
  const call = typeof invoke === "function" ? (invoke as (request: Request) => Promise<unknown>) : undefined;
  return async function diagnosticRequest<T>(
    request: Request,
    decodeSuccess?: (value: unknown) => T,
  ): Promise<T> {
    const expected = sentRequestType(request);
    if (call === undefined) throw new StorageFailureError(unclassifiedRequestFailure(expected));
    let reply: unknown;
    try {
      reply = await call(request);
    } catch {
      throw new StorageFailureError(unclassifiedRequestFailure(expected));
    }
    let decoded: RequestReplyV1<unknown> | null = null;
    try {
      decoded = decodeRequestReplyV1(reply, expected);
    } catch {
      decoded = null;
    }
    if (decoded === null) throw new StorageFailureError(unclassifiedRequestFailure(expected));
    if (!decoded.ok) throw new StorageFailureError(decoded.failure);
    const succeed = (value: unknown): T => {
      if (decodeSuccess === undefined) return value as T;
      try {
        return decodeSuccess(value);
      } catch (error) {
        throw toStorageFailureError(error, expected);
      }
    };
    if (decoded.valueSlot.present === false) return succeed(undefined);
    const value = decoded.valueSlot.value;
    if (expected === "recovery:read" && !validNestedReadDiagnostic(value))
      throw new StorageFailureError(unclassifiedRequestFailure(expected));
    return succeed(value);
  };
}
