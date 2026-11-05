/**
 * Read-only storage usage contract for G7 (capacity and retention).
 *
 * This module is deliberately pure: it defines the report shape, bounded
 * arithmetic, state merging and limit evaluation. It never reads SQLite, the
 * filesystem, receipts or user content. The persistence implementation fills
 * the report; callers must treat `state !== "complete"` as "not measured",
 * never as "safe to write".
 */

export const STORAGE_USAGE_FORMAT = "folio-storage-usage" as const;
export const STORAGE_USAGE_VERSION = 1 as const;

/** Upper bounds on work performed by one report. They bound latency and the
 * number of filesystem entries visited, not correctness: reaching a bound is
 * reported as `partial`/`unknown`, never silently folded into a byte total. */
export type StorageScanLimits = {
  /** Directory entries visited across the explicit workspace targets. */
  maxEntries: number;
  /** Directory nesting depth below an explicit target root. */
  maxDepth: number;
  /** Receipt rows inspected for status/corruption classification. */
  maxReceiptClassificationRows: number;
  /** Unrecognised SQLite table names listed in the report. */
  maxUnrecognizedTables: number;
};

export const DEFAULT_STORAGE_SCAN_LIMITS: StorageScanLimits = {
  maxEntries: 20_000,
  maxDepth: 8,
  maxReceiptClassificationRows: 50_000,
  maxUnrecognizedTables: 50,
};

export type UsageState = "complete" | "partial" | "unknown";

export type UsageScope = "database" | "assets" | "backups" | "workspace";

/** Issue codes are fixed identifiers. They never carry page titles, receipt
 * bodies, file names or free-form error messages. `errorCode` is limited to a
 * short system error code such as ENOENT or EACCES. */
export type UsageIssueCode =
  | "database-read-failed"
  | "required-table-missing"
  | "table-read-failed"
  | "unrecognized-table"
  | "receipt-classification-unavailable"
  | "receipt-classification-truncated"
  | "counter-overflow"
  | "scan-truncated"
  | "depth-limit"
  | "symlink-skipped"
  | "path-escape"
  | "entry-vanished"
  | "permission-denied"
  | "stat-failed"
  | "read-failed"
  | "unsupported-entry"
  | "root-missing"
  | "root-unsafe"
  | "backup-marker-unsafe"
  | "backup-manifest-unsafe"
  | "backup-manifest-invalid"
  | "backup-manifest-missing"
  | "backup-declared-size-mismatch"
  | "backup-database-missing"
  | "backup-entry-unsupported"
  | "issues-truncated";

export type UsageIssue = {
  code: UsageIssueCode;
  scope: UsageScope;
  /** Bounded label: a fixed slot name, table name or generated backup
   * directory name. Never a user file name or document content. */
  target?: string;
  /** Node/system error code only, never `error.message`. */
  errorCode?: string;
};

/** A measured byte subtotal plus the reasons it may be incomplete. */
export type ByteSummary = {
  state: UsageState;
  /** Total only when every visited regular file was measured; otherwise null. */
  bytes: number | null;
  /** Sum of the regular files that were actually measured. */
  measuredBytes: number;
  measuredFiles: number;
  /** Files whose size could not be determined (race, permission, unsupported). */
  unknownFiles: number;
  /** Entries not visited because a work limit was reached. */
  unscannedEntries: number;
  overflow: boolean;
};

export type TreeUsage = ByteSummary & {
  root: "present" | "missing" | "unknown";
  directories: number;
  symlinks: number;
  otherEntries: number;
  truncated: boolean;
};

export type StorageSlot =
  | "database"
  | "wal"
  | "shm"
  | "journal"
  | "pre-v2"
  | "pre-v3"
  | "recovery"
  | "recovery-staging"
  | "incomplete-marker";

export type SlotUsage = {
  slot: StorageSlot;
  state: "measured" | "missing" | "unknown";
  /** 0 for `missing`; null for `unknown`. */
  bytes: number | null;
  errorCode?: string;
};

export type TableRole = "required" | "optional";

export type TableUsage = {
  name: string;
  role: TableRole;
  state: "present" | "missing" | "unknown";
  rows: number | null;
  storedBytes: number | null;
  textColumns: number;
  errorCode?: string;
};

export type ReceiptStatusCounts = {
  applied: number;
  rejected: number;
  unknown: number;
  other: number;
};

/** Receipt accounting never includes `result_json` or any body text. */
export type ReceiptUsage = {
  state: UsageState;
  rows: number | null;
  storedBytes: number | null;
  fingerprintBytes: number | null;
  largestResultBytes: number | null;
  /** Rows whose `result_json` is not valid JSON. */
  corruptRows: number | null;
  /** Rows inspected for status/corruption; equals `rows` when complete. */
  inspectedRows: number | null;
  byStatus: ReceiptStatusCounts | null;
  overflow: boolean;
};

export type DatabaseSnapshotUsage = {
  /** Whether an already-open caller transaction was reused as-is. The report
   * never commits or rolls back a caller-owned transaction. */
  callerOwnedTransaction: boolean | null;
  state: UsageState;
};

export type DatabaseUsage = {
  state: UsageState;
  storeVersion: number | null;
  snapshot: DatabaseSnapshotUsage;
  tables: TableUsage[];
  unrecognizedTables: string[];
  receipts: ReceiptUsage;
  slots: SlotUsage[];
  /** Main database plus WAL/SHM/journal file bytes. */
  fileBytes: number | null;
  unknownFiles: number;
  /** UTF-8 bytes stored in recognised TEXT/BLOB columns. */
  storedTextBytes: number | null;
  overflow: boolean;
};

export type BackupKind = "workspace" | "legacy" | "migration" | "unknown";
export type BackupManifestState = "valid" | "missing" | "invalid" | "unknown";

export type BackupEntryUsage = {
  /** Generated backup directory name; never an absolute path. */
  name: string;
  state: "complete" | "incomplete" | "unknown";
  kind: BackupKind;
  marker: "present" | "missing" | "unknown";
  manifest: BackupManifestState;
  createdAt: string | null;
  declaredDatabaseBytes: number | null;
  declaredAssetBytes: number | null;
  declaredAssets: number | null;
  bytes: ByteSummary;
  issueCodes: UsageIssueCode[];
};

export type BackupsUsage = {
  state: UsageState;
  root: "present" | "missing" | "unknown";
  entries: BackupEntryUsage[];
  complete: number;
  incomplete: number;
  unknown: number;
  bytes: ByteSummary;
  truncated: boolean;
};

export type WorkspaceUsage = {
  state: UsageState;
  assets: TreeUsage;
  backups: BackupsUsage;
  slots: SlotUsage[];
  /** Pre-migration snapshots, crash-recovery checkpoint and marker files. */
  otherFileBytes: number | null;
  overflow: boolean;
};

export type StorageUsageTotals = {
  state: UsageState;
  databaseFileBytes: number | null;
  assetFileBytes: number | null;
  backupFileBytes: number | null;
  otherWorkspaceFileBytes: number | null;
  totalFileBytes: number | null;
  storedTextBytes: number | null;
  unknownFileCount: number;
  overflow: boolean;
};

export type StorageUsageReport = {
  format: typeof STORAGE_USAGE_FORMAT;
  version: typeof STORAGE_USAGE_VERSION;
  generatedAt: string;
  state: UsageState;
  limits: StorageScanLimits;
  database: DatabaseUsage;
  workspace: WorkspaceUsage;
  totals: StorageUsageTotals;
  issues: UsageIssue[];
};

/* ------------------------------------------------------------------------- */
/* Bounded arithmetic                                                         */
/* ------------------------------------------------------------------------- */

export type CountResult = { value: number; overflow: boolean };

/** Add two non-negative safe integers without silently wrapping past
 * `Number.MAX_SAFE_INTEGER`. An invalid operand is treated as overflow. */
export function addCounts(current: number, next: number): CountResult {
  if (
    !Number.isSafeInteger(current) ||
    !Number.isSafeInteger(next) ||
    current < 0 ||
    next < 0
  )
    return { value: 0, overflow: true };
  const sum = current + next;
  return Number.isSafeInteger(sum)
    ? { value: sum, overflow: false }
    : { value: 0, overflow: true };
}

export function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Fold a list of optional subtotals. Missing/unknown entries make the total
 * null; overflow is surfaced rather than hidden. */
export function sumNullable(values: readonly (number | null)[]): {
  value: number | null;
  overflow: boolean;
} {
  let total = 0;
  for (const value of values) {
    if (value === null) return { value: null, overflow: false };
    const next = addCounts(total, value);
    if (next.overflow) return { value: null, overflow: true };
    total = next.value;
  }
  return { value: total, overflow: false };
}

export function mergeUsageStates(states: readonly UsageState[]): UsageState {
  if (states.includes("unknown")) return "unknown";
  if (states.includes("partial")) return "partial";
  return "complete";
}

/* ------------------------------------------------------------------------- */
/* Capacity limit evaluation                                                  */
/* ------------------------------------------------------------------------- */

/** Configured limits are opt-in. No default limit is applied: wiring a hard
 * limit into the write path is a separate, reviewed change. */
export type StorageCapacityLimits = {
  maxDatabaseFileBytes?: number;
  maxAssetFileBytes?: number;
  maxBackupFileBytes?: number;
  maxTotalFileBytes?: number;
  maxReceiptRows?: number;
  maxReceiptStoredBytes?: number;
};

export type StorageCapacityViolation = {
  limit: keyof StorageCapacityLimits;
  actual: number;
  maximum: number;
};

export type StorageCapacityAssessment =
  | { status: "not-configured" }
  | { status: "within"; limits: StorageCapacityLimits }
  | {
      status: "exceeded";
      limits: StorageCapacityLimits;
      violations: StorageCapacityViolation[];
    }
  | {
      status: "unknown";
      limits: StorageCapacityLimits;
      unknownLimits: (keyof StorageCapacityLimits)[];
    };

const LIMIT_KEYS: (keyof StorageCapacityLimits)[] = [
  "maxDatabaseFileBytes",
  "maxAssetFileBytes",
  "maxBackupFileBytes",
  "maxTotalFileBytes",
  "maxReceiptRows",
  "maxReceiptStoredBytes",
];

function limitActual(
  report: StorageUsageReport,
  limit: keyof StorageCapacityLimits,
): number | null {
  switch (limit) {
    case "maxDatabaseFileBytes":
      return report.totals.databaseFileBytes;
    case "maxAssetFileBytes":
      return report.totals.assetFileBytes;
    case "maxBackupFileBytes":
      return report.totals.backupFileBytes;
    case "maxTotalFileBytes":
      return report.totals.totalFileBytes;
    case "maxReceiptRows":
      return report.database.receipts.rows;
    case "maxReceiptStoredBytes":
      return report.database.receipts.storedBytes;
  }
}

/**
 * Evaluate configured limits against a report. The function is intentionally
 * conservative:
 * - a configured limit whose source is unknown yields `unknown`, never
 *   `within`;
 * - `exceeded` wins when at least one measured source is already over;
 * - no configured limit yields `not-configured`, not an implicit "safe".
 */
export function evaluateStorageCapacity(
  report: StorageUsageReport,
  limits: StorageCapacityLimits,
): StorageCapacityAssessment {
  if (
    !report ||
    report.format !== STORAGE_USAGE_FORMAT ||
    report.version !== STORAGE_USAGE_VERSION
  )
    throw new TypeError("Invalid storage usage report");
  if (!limits || typeof limits !== "object" || Array.isArray(limits))
    throw new TypeError("Storage limits must be an object");
  for (const key of Object.keys(limits)) {
    if (!LIMIT_KEYS.includes(key as keyof StorageCapacityLimits))
      throw new TypeError(`Unknown storage limit: ${key}`);
  }
  const configured = LIMIT_KEYS.filter(
    (key) => limits[key] !== undefined,
  ) as (keyof StorageCapacityLimits)[];
  if (!configured.length) return { status: "not-configured" };
  for (const key of configured) {
    const maximum = limits[key];
    if (!isSafeNonNegativeInteger(maximum))
      throw new TypeError(`Invalid storage limit: ${key}`);
  }
  const violations: StorageCapacityViolation[] = [];
  const unknownLimits: (keyof StorageCapacityLimits)[] = [];
  for (const key of configured) {
    const actual = limitActual(report, key);
    const maximum = limits[key] as number;
    if (actual === null || !isSafeNonNegativeInteger(actual)) {
      unknownLimits.push(key);
      continue;
    }
    if (actual > maximum)
      violations.push({ limit: key, actual, maximum });
    else if (report.state !== "complete")
      // Any incomplete report can hide bytes relevant to a limit. A measured
      // value below its bound is therefore not evidence that writing is safe.
      unknownLimits.push(key);
  }
  if (violations.length)
    return { status: "exceeded", limits, violations };
  if (unknownLimits.length)
    return { status: "unknown", limits, unknownLimits };
  return { status: "within", limits };
}
