import type { Request } from "../../shared/types";
import type { StorageFailureV1 } from "../../shared/private-storage-failure";
import {
  requestStorageFailure,
  storageFailureMessageV1,
  unclassifiedRequestFailure,
  StorageFailureError,
} from "../private-request";

/** C04 §6.3/T13: one latched first-failure hold per bound workspace/renderer
 * session, owned by the App root — never by the dialog, never by a module
 * global shared across App instances. There is deliberately no clear/reset
 * API, no persistent queue and no history: once latched, close,
 * unmount/reopen, a choose success or failure, an old or new preview,
 * another destination, another request's success or a new controller
 * instance can never release or reclassify it. */
export type BackupWriteHoldView = {
  held(): boolean;
  failure(): StorageFailureV1 | null;
};

export type BackupWriteHold = BackupWriteHoldView & {
  latch(error: unknown, requestType: string): StorageFailureV1;
};

export function createBackupWriteHold(): BackupWriteHold {
  let latched: StorageFailureV1 | null = null;
  return {
    held: () => latched !== null,
    failure: () => latched,
    latch(error, requestType) {
      if (latched !== null) return latched;
      // A carried bounded diagnostic keeps its own requestType — a
      // prepare-stage recovery:write failure stays recovery:write and is
      // never recast to the backup request. Only a carrier-less or invalid
      // failure becomes the bounded local E of the actual backup request.
      latched =
        requestStorageFailure(error) ?? unclassifiedRequestFailure(requestType);
      return latched;
    },
  };
}

/** App-owned known-local-refusal brand. It is created only through
 * backupLocalRefusal below and checked only inside this module, so a
 * transport value, a message look-alike or a forged error.code can never
 * mark a thrown failure "known local". The brand is a module-private symbol
 * stored as an own data property; it is never executed as an accessor. */
const localRefusalBrand = Symbol("folio-backup-write-local-refusal");

/** Marks an App-local precondition refusal (composing/creating/structural
 * input, unsaved changes, checkpoint save not confirmed, recovery not
 * ready). These refuse the current attempt before any backup request exists
 * and are never proof of an unknown dispatched write, so they refuse this
 * attempt with send 0 but do not latch the hold. */
export function backupLocalRefusal(message: string): Error {
  const error = new Error(message);
  Object.defineProperty(error, localRefusalBrand, {value: true});
  return error;
}

function isLocalRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, localRefusalBrand);
    return (
      descriptor !== undefined &&
      "value" in descriptor &&
      descriptor.value === true
    );
  } catch {
    return false;
  }
}

export type BackupWriteSend = <T>(request: Request) => Promise<T>;

/** Dependencies are injected and may be replaced per render or per rebuilt
 * controller; the hold is not — it belongs to the App root for the session.
 * prepare is the backup-owned write-flow prepare only (the App's backup
 * dialog prepare call site): shared prepare callers elsewhere keep their
 * own flow and never latch through this entry. prepareFailure is consulted
 * only after a prepare failure and returns the production queue's currently
 * latched error (the App's latched recovery error) or null. Only an actual
 * validated bounded diagnostic found there takes priority over a known
 * local refusal — a missing or unbounded value can neither reclassify a
 * thrown failure into a hold nor hide it as a refusal. */
export type BackupWriteEntryDeps = {
  send: BackupWriteSend;
  prepare: () => Promise<void>;
  prepareFailure?: () => unknown;
};

export type BackupWriteEntry = {
  held(): boolean;
  heldFailure(): StorageFailureV1 | null;
  /** create wraps the whole write-flow prepare: an entry guard, the prepare,
   * a second guard after the await (another flow may have latched
   * meanwhile), then the actual backup request. */
  create<T>(request: Request): Promise<T>;
  /** restore/open keep their original Main-side preparation and
   * authorization; the renderer only guards the hold at the entry and at
   * the actual send boundary. */
  write<T>(request: Request): Promise<T>;
  /** A pure read-only choose/preview: its failure or cancellation alone can
   * never create a hold, and it can never clear an existing one. */
  query<T>(request: Request): Promise<T>;
};

function requestTypeOf(request: Request): string {
  try {
    const type = (request as {type?: unknown}).type;
    return typeof type === "string" ? type : "UNRECOGNIZED";
  } catch {
    return "UNRECOGNIZED";
  }
}

export function createBackupWriteEntry(
  hold: BackupWriteHold,
  deps: BackupWriteEntryDeps,
): BackupWriteEntry {
  const heldError = () =>
    new StorageFailureError(
      hold.failure() ?? unclassifiedRequestFailure("UNRECOGNIZED"),
    );
  const guard = () => {
    if (hold.held()) throw heldError();
  };
  const latch = (error: unknown, requestType: string): never => {
    throw new StorageFailureError(hold.latch(error, requestType));
  };
  /** Read the injected queue/prepare diagnostic once. A throwing getter is
   * itself an unknown and fails closed through latch rather than letting a
   * raw evaluation error bypass the bounded stop. */
  const readPrepareDiagnostic = (
    requestType: string,
  ): StorageFailureV1 | undefined => {
    let candidate: unknown;
    try {
      candidate = deps.prepareFailure?.();
    } catch (error) {
      latch(error, requestType);
    }
    return requestStorageFailure(candidate);
  };
  /** A validated current diagnostic latches the first hold — preserving its
   * own requestType/family/subject — and throws the safe bounded error. */
  const checkDiagnostic = (requestType: string): void => {
    const diagnosed = readPrepareDiagnostic(requestType);
    if (diagnosed) latch(new StorageFailureError(diagnosed), requestType);
  };
  return {
    held: () => hold.held(),
    heldFailure: () => hold.failure(),
    async create<T>(request: Request): Promise<T> {
      const requestType = requestTypeOf(request);
      // The create write flow checks the root hold and the current validated
      // queue/prepare diagnostic at both boundaries: before prepare, and
      // synchronously at the actual send with no new await between
      // evaluation and dispatch.
      guard();
      checkDiagnostic(requestType);
      try {
        await deps.prepare();
      } catch (error) {
        // A concurrent or post-await checkpoint failure can leave a validated
        // diagnostic latched in the production queue even when the prepare
        // refusal itself is local. The bounded diagnostic — from the thrown
        // failure first, then the queue's own latched error — always takes
        // priority and keeps its original requestType. A tagged local
        // refusal with no diagnostic stays a refusal; anything else fails
        // closed as the bounded E of the actual backup request.
        const diagnosed =
          requestStorageFailure(error) ?? readPrepareDiagnostic(requestType);
        if (diagnosed) {
          return latch(new StorageFailureError(diagnosed), requestType);
        }
        if (isLocalRefusal(error)) throw error;
        return latch(error, requestType);
      }
      guard();
      checkDiagnostic(requestType);
      try {
        return await deps.send<T>(request);
      } catch (error) {
        return latch(error, requestType);
      }
    },
    async write<T>(request: Request): Promise<T> {
      const requestType = requestTypeOf(request);
      guard();
      try {
        return await deps.send<T>(request);
      } catch (error) {
        return latch(error, requestType);
      }
    },
    query<T>(request: Request): Promise<T> {
      return deps.send<T>(request);
    },
  };
}

/** The held-close contract: while held, closing the dialog may only unmount
 * the dialog — no release/cleanup request may be dispatched. A healthy
 * close keeps the original release-then-close contract. */
export function backupCloseReleaseAllowed(
  hold: BackupWriteHoldView | null | undefined,
): boolean {
  return hold?.held() !== true;
}

/** Fixed stop text for a held backup write. It names only the bounded kind
 * through the existing fixed-message table, states PARTIAL_OR_UNKNOWN
 * progress, no-resend/no-new-destination guidance, and that on-screen unACK
 * input is retained while a new save is not confirmed. No raw cause, path
 * or wire text is ever included. */
export function backupWriteHoldMessage(
  failure: StorageFailureV1 | null,
): string {
  const lead = failure
    ? storageFailureMessageV1(failure)
    : "安全に分類できないため結果は未確認として停止しました。";
  return `${lead} バックアップの結果は未確認で、途中成果が残る場合があります。再送や別の宛先での作り直しは行わず、確認・救出を行ってください。画面内の未確認の入力は保持しています。新しい保存が確認できたわけではありません。`;
}
