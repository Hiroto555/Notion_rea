import type { SaveOperation } from "../shared/save-contract";
import type { Page } from "../shared/types";
import type { StorageFailureV1 } from "../shared/private-storage-failure";
import { requestStorageFailure, unclassifiedRequestFailure } from "./private-request";
import type { DiagnosticSaveResult } from "./reliable-save";

/** Application-lifetime ordinary-Page save state. Diagnostics are keyed by
 * operationId and exist only while the matching pending operation does; there
 * is no failure history and the maps are the single source of truth for both
 * the pending request and its bounded diagnostic. */
export type OrdinaryPageSaveState = {
  operations: Map<string, SaveOperation>;
  storageFailures: Map<string, StorageFailureV1>;
};

/** The live page session the ACK must still match. */
export type OrdinaryPageSession = {sessionId: string; page: Page};

export type OrdinaryPageSettlement =
  | {kind: "stale"}
  | {kind: "retained"; outcome: "unknown" | "mismatch"; message?: string; storageFailure?: StorageFailureV1}
  | {kind: "business-rejected"; message?: string}
  | {kind: "applied"; page: Page};

/** A failed checkpoint or dispatch for the operation that is still pending
 * latches its own bounded diagnostic. A stale callback touches nothing and the
 * first diagnostic always wins: a later unknown or unclassified failure can
 * neither clear nor reclassify an earlier valid one. */
export function retainOrdinaryPageFailure(state: OrdinaryPageSaveState,
  operation: SaveOperation, error: unknown): StorageFailureV1 | undefined {
  if (state.operations.get(operation.pageId) !== operation) return undefined;
  const existing = state.storageFailures.get(operation.operationId);
  if (existing) return existing;
  const failure = requestStorageFailure(error) ?? unclassifiedRequestFailure("save:commit");
  state.storageFailures.set(operation.operationId, failure);
  return failure;
}

/** Identity-first settle: nothing happens for an operation that is not the
 * pending one. Unknown, invalid ACKs and typed failures keep the operation and
 * its first diagnostic; only a verified applied ACK or a verified business
 * rejection under the original clear conditions removes both. A terminal ACK
 * that reaches this helper still carrying its own failure metadata is
 * contradictory and can never clear either. An unknown outcome is never a
 * reason to send anything again. */
export function settleOrdinaryPageSave(state: OrdinaryPageSaveState,
  operation: SaveOperation, result: DiagnosticSaveResult,
  session: OrdinaryPageSession | undefined): OrdinaryPageSettlement {
  if (state.operations.get(operation.pageId) !== operation) return {kind: "stale"};
  const carriesDiagnostic = Object.hasOwn(result, "storageFailure");
  if (result.status === "rejected" && !carriesDiagnostic) {
    state.operations.delete(operation.pageId);
    state.storageFailures.delete(operation.operationId);
    return {kind: "business-rejected", message: result.message};
  }
  if (result.status !== "applied" || !result.page || carriesDiagnostic)
    return {kind: "retained", outcome: "unknown", message: result.message,
      storageFailure: latch(state, operation, requestStorageFailure(result))};
  if (!session || session.sessionId !== operation.sessionId ||
      result.operationId !== operation.operationId || result.sessionId !== operation.sessionId ||
      result.seq !== operation.seq || result.pageId !== operation.pageId ||
      result.page.id !== operation.pageId || result.page.revision !== operation.revision + 1 ||
      session.page.revision !== operation.revision ||
      Object.entries(operation.patch).some(([key, value]) => JSON.stringify((result.page as unknown as Record<string, unknown>)[key]) !== JSON.stringify(value)))
    return {kind: "retained", outcome: "mismatch",
      storageFailure: latch(state, operation, requestStorageFailure(result))};
  state.operations.delete(operation.pageId);
  state.storageFailures.delete(operation.operationId);
  return {kind: "applied", page: result.page};
}

/** Keep the first valid diagnostic; a diagnostic-less result preserves the
 * existing latch instead of clearing it. */
function latch(state: OrdinaryPageSaveState, operation: SaveOperation,
  failure: StorageFailureV1 | undefined): StorageFailureV1 | undefined {
  const existing = state.storageFailures.get(operation.operationId);
  if (existing) return existing;
  if (failure) state.storageFailures.set(operation.operationId, failure);
  return failure;
}
