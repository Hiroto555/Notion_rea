import type { Request } from "../shared/types";

/** A read-only startup uses a separate renderer without edit/checkpoint flows.
 * Enforce the same boundary in main even if a caller constructs another request. */
export function assertReadOnlyRequest(request: Request): void {
  switch (request.type) {
    case "startup:status":
    case "sync:status":
    case "sync:restartStatus":
    case "sync:conflict":
    case "sync:conflictDecisionStatus":
    case "sync:conflictCandidate":
    case "sync:conflictExport":
    case "load":
    case "search":
    case "pageSource":
    case "versions":
    case "export":
    case "exportRecovery":
    case "exportPendingJournal":
    case "downloadAttachment":
    case "storage:pressure":
    case "storage:overview":
    case "storage:rawSalvage":
    case "workspaceBackup:choose":
    case "record:get":
    case "record:read":
    case "database:load":
    case "database:read":
    case "page:resolve":
    case "save:resolve":
    case "database:resolve":
    case "property:resolve":
    case "migration:resolve":
    case "pageOrder:preview":
      return;
    default:
      throw new Error(
        "読み取り専用で開いています。保存容量を確保して再起動してください。",
      );
  }
}
