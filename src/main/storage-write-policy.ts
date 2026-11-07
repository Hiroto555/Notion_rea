import type { Request } from "../shared/types";

type RequestType = Request["type"] | "storage:pressure";
type StorageAction = "read" | "checkpoint" | "write" | "maintenance";

/**
 * Capacity policy for the request boundary. Reads, external exports, external
 * restore entry points and rescue checkpoints stay available when the
 * workspace is over its reserve; only local persistent changes are gated.
 *
 * This is a Record so adding a Request type without classifying it fails the
 * type check instead of silently inheriting an unsafe default.
 */
const REQUEST_STORAGE_ACTIONS = {
  "recovery:list":"read", "recovery:status":"read", "recovery:export":"read", "recovery:restore":"read",
  load: "read",
  search: "read",
  versions: "read",
  pageSource: "read",
  "record:get": "read",
  "record:read": "read",
  "database:load": "read",
  "database:read": "read",
  "database:resolve": "read",
  "page:resolve": "read",
  "save:resolve": "read",
  "property:resolve": "read",
  "migration:resolve": "read",
  "property:preview": "read",
  "migration:preview": "read",
  "pageOrder:preview": "read",
  "pageOrder:apply": "write",
  "recovery:read": "read",
  import: "read",
  export: "read",
  exportRecovery: "read",
  exportPendingJournal: "read",
  downloadAttachment: "read",
  openExternal: "read",
  "workspaceBackup:choose": "read",
  "workspaceBackup:restore": "read",
  "workspaceBackup:open": "read",
  "startup:status": "read",
  "sync:status": "read",
  "sync:run": "write",
  "sync:restartStatus": "read",
  "sync:restartRequest": "checkpoint",
  "sync:restartCancel": "checkpoint",
  "sync:conflict": "read",
  "sync:conflictDecisionStatus": "read",
  "sync:conflictPreview": "checkpoint",
  "sync:conflictConfirm": "checkpoint",
  "sync:conflictCancel": "checkpoint",
  "sync:conflictCandidate": "read",
  "sync:conflictExport": "read",
  "storage:pressure": "read",
  "storage:readLimits": "read",
  "storage:applyLimits": "write",
  "storage:overview": "read",
  "storage:archivePlan": "read",
  "storage:archiveMove": "maintenance",
  "storage:orphanPlan": "read",
  "storage:orphanMove": "maintenance",
  "storage:rawSalvage": "read",
  "workspaceBackup:release": "read",

  // Rescue checkpoint: keep the existing size limits, but do not claim the
  // unsaved input was persisted.
  "recovery:write": "checkpoint",

  create: "write",
  update: "write",
  move: "write",
  duplicate: "write",
  trash: "write",
  restore: "write",
  setting: "write",
  "save:commit": "write",
  "page:commit": "write",
  "database:commit": "write",
  "property:commit": "write",
  "migration:commit": "write",
  "record:create": "write",
  "record:patch": "write",
  "record:pageUpdate": "write",
  "record:trash": "write",
  "record:restore": "write",
  "record:duplicate": "write",
  "database:settings": "write",
  "recovery:copy": "write",
  attach: "write",
  recover: "write",
  restoreVersion: "write",
  backup: "write",
  "workspaceBackup:create": "write",
} as const satisfies Record<RequestType, StorageAction>;

function unknownRequestType(type: unknown): Error {
  const label = typeof type === "string" ? type : typeof type;
  return new Error(`Unknown request type for storage policy: ${label}`);
}

/** Classify a request type. Unknown types fail closed instead of defaulting to read. */
export function storageActionForRequest(type: RequestType): StorageAction {
  if (!Object.hasOwn(REQUEST_STORAGE_ACTIONS, type))
    throw unknownRequestType(type);
  return REQUEST_STORAGE_ACTIONS[type];
}

/**
 * Gate a request before its handler runs. Only mutations that can grow local
 * storage consult the pressure probe; reads and rescue paths are untouched.
 */
export function assertRequestStorage(
  request: Request,
  pressure: { assertWritable(): void },
): void {
  const input: unknown = request;
  const type =
    typeof input === "object" && input !== null
      ? (input as { type?: unknown }).type
      : undefined;
  if (typeof type !== "string") throw unknownRequestType(type);
  const action = storageActionForRequest(type as RequestType);
  if (action === "write") pressure.assertWritable();
}
