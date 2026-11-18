import type { Page, Request } from "../shared/types";
import type { CrashRecoveryRead, CrashRecoverySnapshot } from "../shared/crash-recovery";
import type { RecoveryCopyInput } from "../persistence/crash-recovery-copy";

/**
 * Exact recovery request discriminants only. This module is a pure, synchronous
 * main-process DI seam: it performs no authorization, lifecycle, scope, IPC or
 * Store/CrashRecoveryFile ownership and exposes no generic Request callback to
 * shared/browser code.
 */
export type PrivateRecoveryReadRequest = Extract<Request, { type: "recovery:read" }>;
export type PrivateRecoveryWriteRequest = Extract<Request, { type: "recovery:write" }>;
export type PrivateRecoveryCopyRequest = Extract<Request, { type: "recovery:copy" }>;
export type PrivateRecoveryRequest =
  | PrivateRecoveryReadRequest
  | PrivateRecoveryWriteRequest
  | PrivateRecoveryCopyRequest;

/**
 * Per-request lazy thunks supplied by Main. They close over the existing
 * `context`, lexical `crashRecovery` and the single owned `store`; this module
 * never creates, clones or closes any of them.
 */
export type PrivateRecoveryDependencies = Readonly<{
  readRecovery(): CrashRecoveryRead;
  writeRecovery(
    expectedGeneration: number,
    snapshot: CrashRecoverySnapshot,
  ): CrashRecoveryRead;
  copyRecovery(recoveryId: string, input: RecoveryCopyInput): Page;
}>;

/** True only for the three exact recovery tags. `recovery:list`,
 * `recovery:status`, `recovery:export`, `recovery:restore`, unknown and every
 * other request stay with the existing dispatch and never reach these deps. */
export function isPrivateRecoveryRequest(
  req: Request,
): req is PrivateRecoveryRequest {
  return (
    req.type === "recovery:read" ||
    req.type === "recovery:write" ||
    req.type === "recovery:copy"
  );
}

/**
 * Synchronous single-step dispatch. Returns or throws the dependency's exact
 * value/error; no await, wrapper, clone or envelope classification is added
 * here. `context.readRecovery`/`writeRecovery` keep their blocked-read
 * sidecar and typed write facts, and `createRecoveryCopy` keeps its own
 * pre-transaction validation and transaction/rollback behavior.
 */
export function handlePrivateRecoveryRequest(
  req: PrivateRecoveryRequest,
  deps: PrivateRecoveryDependencies,
): CrashRecoveryRead | Page {
  switch (req.type) {
    case "recovery:read":
      return deps.readRecovery();
    case "recovery:write":
      return deps.writeRecovery(req.expectedGeneration, req.snapshot);
    case "recovery:copy":
      return deps.copyRecovery(req.recoveryId, {
        ...req.input,
        payload: req.input.payload,
      });
  }
}
