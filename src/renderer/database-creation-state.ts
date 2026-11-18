import type { DatabaseOperation } from "../shared/database-operation";
import type { DatabaseProjection, Page, RecordProjection } from "../shared/types";
import type { StorageFailureV1 } from "../shared/private-storage-failure";
import { requestStorageFailure, storageFailureMessageV1, unclassifiedRequestFailure } from "./private-request";
import type { DiagnosticDatabaseOperationResult } from "./reliable-database-operation";

/** The single standalone database-creation slot owned by App. The transient
 * diagnostic rides on the slot and dies with it; it is never written into the
 * operation or the crash-recovery `creations` list, and no second operation is
 * ever generated from this state. */
export type DatabaseCreationPending = {
  operation: DatabaseOperation;
  state: "saving" | "unknown" | "rejected";
  error?: string;
  storageFailure?: StorageFailureV1;
};

export type DatabaseCreationSettlement =
  | {kind: "stale"}
  | {kind: "retained"; storageFailure?: StorageFailureV1}
  | {kind: "business-rejected"}
  | {kind: "applied"; page: Page; database: DatabaseProjection; record?: RecordProjection};

/** A failed checkpoint before the create dispatch keeps the same operation
 * pending, marks it unknown and latches its bounded diagnostic. A stale slot
 * touches nothing. */
export function retainDatabaseCreationFailure(pending: DatabaseCreationPending | undefined,
  operation: DatabaseOperation, error: unknown): StorageFailureV1 | undefined {
  if (!pending || pending.operation !== operation) return undefined;
  if (pending.storageFailure === undefined)
    pending.storageFailure = requestStorageFailure(error) ?? unclassifiedRequestFailure("recovery:write");
  pending.state = "unknown";
  pending.error = storageFailureMessageV1(pending.storageFailure);
  return pending.storageFailure;
}

/** A create receipt settles only for the pending operation. Unknown keeps the
 * operation and the first valid diagnostic even when a later resolve carries
 * none; verified applied hands the payload back so the caller can complete the
 * existing applied flow and clear the slot; verified business rejection keeps
 * its original meaning. A terminal receipt still carrying its own failure
 * metadata is contradictory and can never settle the slot. */
export function settleDatabaseCreation(pending: DatabaseCreationPending | undefined,
  result: DiagnosticDatabaseOperationResult): DatabaseCreationSettlement {
  if (!pending || result.operationId !== pending.operation.operationId) return {kind: "stale"};
  const carriesDiagnostic = Object.hasOwn(result, "storageFailure");
  if (result.status === "applied" && result.page && result.database && !carriesDiagnostic)
    return {kind: "applied", page: result.page, database: result.database,
      ...(result.record ? {record: result.record} : {})};
  if (result.status === "rejected" && !carriesDiagnostic) {
    pending.state = "rejected";
    pending.error = result.message || "作成結果を確認できません。入力を保持しています。";
    return {kind: "business-rejected"};
  }
  pending.state = "unknown";
  const failure = requestStorageFailure(result);
  if (failure && pending.storageFailure === undefined) pending.storageFailure = failure;
  // The display comes from the validated latched kind or a fixed safe line;
  // a carrier's own message is never shown.
  pending.error = pending.storageFailure ? storageFailureMessageV1(pending.storageFailure)
    : "作成結果を確認できません。画面内に未保存入力を保持しています。新しい保存は確認できていません。";
  return {kind: "retained", storageFailure: pending.storageFailure};
}
