import type { DatabaseSync } from "node:sqlite";
import { SyncError, MAX_WIRE_BYTES, MAX_CHECKPOINT_BYTES } from "./protocol";

export type SyncRetentionLimits = {
  maxRows: number;
  maxBytes: number;
};

export const SERVER_RETENTION_LIMITS: SyncRetentionLimits = Object.freeze({
  maxRows: 1024,
  maxBytes: 64 * 1024 * 1024,
});

export const CLIENT_RETENTION_LIMITS: SyncRetentionLimits = Object.freeze({
  maxRows: 512,
  maxBytes: 64 * 1024 * 1024,
});

type RetentionKind = "server" | "client";

type RetentionTable = {
  table: string;
  columns: readonly string[];
};

const SERVER_TABLES: readonly RetentionTable[] = [
  { table: "checkpoint_changes", columns: ["change_json"] },
  {
    table: "checkpoint_operations",
    columns: ["commit_json", "result_json"],
  },
];

const CLIENT_TABLES: readonly RetentionTable[] = [
  {
    table: "workspace_sync_outbox",
    columns: ["commit_json", "result_json"],
  },
  { table: "workspace_sync_inbox", columns: ["change_json"] },
  {
    table: "workspace_sync_conflicts",
    columns: [
      "local_commit_json",
      "remote_result_json",
      "local_checkpoint_json",
    ],
  },
  { table: "workspace_sync_archives", columns: ["checkpoint_json"] },
];

type RetentionInspection = {
  rows: number;
  bytes: number;
  maxRows: number;
  maxBytes: number;
  held: boolean;
};

type RetentionAdditional = {
  rows: number;
  bytes: number;
};

type Row = Record<string, unknown>;

function unknown(): never {
  throw new SyncError("sync-retention-unknown", 409);
}

function isSafeAmount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isPositiveLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function checkedNumber(value: unknown): number {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) unknown();
    return Number(value);
  }
  if (!isSafeAmount(value)) unknown();
  return value;
}

function addSafe(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) unknown();
  return total;
}

function defaultsFor(kind: unknown): SyncRetentionLimits {
  if (kind === "server") return SERVER_RETENTION_LIMITS;
  if (kind === "client") return CLIENT_RETENTION_LIMITS;
  unknown();
}

function resolveLimits(
  kind: unknown,
  limits: SyncRetentionLimits | undefined,
): SyncRetentionLimits {
  const defaults = defaultsFor(kind);
  if (limits === undefined) return { ...defaults };
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) {
    unknown();
  }
  const maxRows = (limits as unknown as Row).maxRows;
  const maxBytes = (limits as unknown as Row).maxBytes;
  if (!isPositiveLimit(maxRows) || !isPositiveLimit(maxBytes)) unknown();
  if (maxRows > defaults.maxRows || maxBytes > defaults.maxBytes) unknown();
  return { maxRows, maxBytes };
}

function resolveAdditional(additional: unknown): RetentionAdditional {
  if (
    additional === null ||
    typeof additional !== "object" ||
    Array.isArray(additional)
  ) {
    unknown();
  }
  const rows = (additional as unknown as Row).rows;
  const bytes = (additional as unknown as Row).bytes;
  if (!isSafeAmount(rows) || !isSafeAmount(bytes)) unknown();
  return { rows, bytes };
}

function tableNames(db: DatabaseSync): Set<string> {
  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Row[];
    const names = new Set<string>();
    for (const row of rows) {
      if (typeof row.name === "string") names.add(row.name);
    }
    return names;
  } catch {
    unknown();
  }
}

function measureTable(
  db: DatabaseSync,
  spec: RetentionTable,
): RetentionAdditional {
  const bytesExpression = spec.columns
    .map((column) => `COALESCE(length(CAST("${column}" AS BLOB)),0)`)
    .join(" + ");
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS "rows", COALESCE(SUM(${bytesExpression}),0) AS "bytes" FROM "${spec.table}"`,
      )
      .get() as Row | undefined;
    if (!row) unknown();
    return {
      rows: checkedNumber(row.rows),
      bytes: checkedNumber(row.bytes),
    };
  } catch (error) {
    if (error instanceof SyncError) throw error;
    unknown();
  }
}

function inspect(db: DatabaseSync, kind: RetentionKind): RetentionInspection {
  const specs = kind === "server" ? SERVER_TABLES : CLIENT_TABLES;
  const limits = resolveLimits(kind, undefined);
  const names = tableNames(db);
  let rows = 0;
  let bytes = 0;
  for (const spec of specs) {
    if (!names.has(spec.table)) unknown();
    const measured = measureTable(db, spec);
    rows = addSafe(rows, measured.rows);
    bytes = addSafe(bytes, measured.bytes);
  }
  return {
    rows,
    bytes,
    maxRows: limits.maxRows,
    maxBytes: limits.maxBytes,
    held: rows > limits.maxRows || bytes > limits.maxBytes,
  };
}

export function inspectSyncRetention(
  db: DatabaseSync,
  kind: "server" | "client",
  limits?: SyncRetentionLimits,
): RetentionInspection {
  const resolved = resolveLimits(kind, limits);
  const measured = inspect(db, kind);
  return {
    rows: measured.rows,
    bytes: measured.bytes,
    maxRows: resolved.maxRows,
    maxBytes: resolved.maxBytes,
    held:
      measured.rows > resolved.maxRows || measured.bytes > resolved.maxBytes,
  };
}

export function assertSyncRetentionAdmission(
  db: DatabaseSync,
  kind: "server" | "client",
  additional: RetentionAdditional,
  limits?: SyncRetentionLimits,
): void {
  const addition = resolveAdditional(additional);
  const inspection = inspectSyncRetention(db, kind, limits);
  const projectedRows = addSafe(inspection.rows, addition.rows);
  const projectedBytes = addSafe(inspection.bytes, addition.bytes);
  if (projectedRows > inspection.maxRows || projectedBytes > inspection.maxBytes) {
    throw new SyncError("sync-retention-held", 409);
  }
}

/** Reserve the largest bounded ACK/conflict evidence before sending a new
 * operation. Inbox/archive growth cannot consume this reservation. There is
 * at most one pending outbox operation in WorkspaceSyncStore. */
export function assertClientSyncGrowth(db: DatabaseSync, additional: RetentionAdditional,
  pendingAfter?: boolean, limits?: SyncRetentionLimits): void {
  let pending: boolean;
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM workspace_sync_outbox WHERE result_json IS NULL").get()!;
    const count = checkedNumber(row.n);
    if (count > 1) unknown();
    pending = pendingAfter ?? count === 1;
  } catch (error) {if (error instanceof SyncError) throw error; return unknown();}
  const addition = resolveAdditional(additional);
  assertSyncRetentionAdmission(db, "client", {rows: addition.rows + (pending ? 1 : 0),
    bytes: addition.bytes + (pending ? 3 * MAX_WIRE_BYTES + MAX_CHECKPOINT_BYTES : 0)}, limits);
}
