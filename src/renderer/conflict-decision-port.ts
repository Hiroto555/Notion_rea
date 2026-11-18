import type { ConflictDecisionPort } from "../shared/app-api";
import type { Request } from "../shared/types";
import {
  StorageFailureError,
  unclassifiedRequestFailure,
} from "./private-request";

/** The transport-level bounded failure for a tag outside this bridge's
 * family. The actual received discriminant names the local E; nothing about
 * the request is inspected and no port method is invoked. */
const refused = (request: Request): Promise<never> =>
  Promise.reject(
    new StorageFailureError(unclassifiedRequestFailure(request.type)),
  );

/** Synchronous tag → purpose map for the four conflict-decision lanes, built
 * for the existing ConflictDecisionModel generic transport slot. Each tag
 * forwards to exactly one port method with the request's own fields — a
 * legitimate status, preview, confirm or cancel is always forwarded — and any
 * other family invokes zero port methods and falls back to nothing. There is
 * no await, no probe and no validation inside the bridge: response inspection
 * already ran inside the purpose adapter, and the returned promise is the
 * port call itself so the Model's inputReady → actual-invoke ordering is
 * preserved exactly. The boundary cast only re-types the validated port
 * result for the Model's generic slot; it is never offered as proof of a
 * valid response. */
export function conflictDecisionBridge(
  decision: ConflictDecisionPort,
): <T>(request: Request) => Promise<T> {
  const transport = (request: Request): Promise<unknown> =>
    request.type === "sync:conflictDecisionStatus"
      ? decision.status()
      : request.type === "sync:conflictPreview"
        ? decision.preview({
            choice: request.choice,
            operationId: request.operationId,
            expectedLocalHash: request.expectedLocalHash,
            expectedRemoteRevision: request.expectedRemoteRevision,
            expectedRemoteHash: request.expectedRemoteHash,
          })
        : request.type === "sync:conflictConfirm"
          ? decision.confirm(request.previewId)
          : request.type === "sync:conflictCancel"
            ? decision.cancel(request.decisionId)
            : refused(request);
  return transport as <T>(request: Request) => Promise<T>;
}
