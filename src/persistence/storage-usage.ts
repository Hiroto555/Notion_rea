import * as fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  addCounts,
  DEFAULT_STORAGE_SCAN_LIMITS,
  isSafeNonNegativeInteger,
  mergeUsageStates,
  STORAGE_USAGE_FORMAT,
  STORAGE_USAGE_VERSION,
  sumNullable,
  type BackupEntryUsage,
  type BackupKind,
  type BackupManifestState,
  type BackupsUsage,
  type ByteSummary,
  type DatabaseUsage,
  type ReceiptUsage,
  type SlotUsage,
  type StorageScanLimits,
  type StorageSlot,
  type StorageUsageReport,
  type TableRole,
  type TableUsage,
  type TreeUsage,
  type UsageIssue,
  type UsageIssueCode,
  type UsageState,
  type WorkspaceUsage,
} from "../shared/storage-usage";
import type { Store } from "./store";

/** Test seam. Production callers use the native fs; tests inject a virtual
 * tree to exercise races, permission failures, depth/entry limits and
 * counter overflow without touching real user data. */
export type StorageScanOperations = Pick<
  typeof fs,
  "lstatSync" | "readdirSync" | "realpathSync" | "readFileSync"
>;

export type StorageUsageOptions = {
  now?: () => Date;
  scanLimits?: Partial<StorageScanLimits>;
  operations?: Partial<StorageScanOperations>;
};

const REQUIRED_TABLES = [
  "pages",
  "settings",
  "versions",
  "save_receipts",
  "assets",
] as const;

const OPTIONAL_TABLES = [
  "record_databases",
  "record_memberships",
  "record_value_versions",
  "record_database_trash_batches",
  "record_database_trash_members",
  "legacy_record_map",
  "legacy_database_archive",
  "legacy_database_versions",
  "crash_recovery_copies",
  "folio_record_schema",
] as const;

const KNOWN_TABLES = new Set<string>([
  ...REQUIRED_TABLES,
  ...OPTIONAL_TABLES,
]);

const MAX_REPORT_ISSUES = 200;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

/* ------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* ------------------------------------------------------------------------- */

function systemErrorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)
    ? code
    : undefined;
}

function errorIsMissing(error: unknown): boolean {
  return systemErrorCode(error) === "ENOENT";
}

function pushIssue(issues: UsageIssue[], issue: UsageIssue): void {
  if (issues.length < MAX_REPORT_ISSUES) {
    issues.push(issue);
    return;
  }
  if (!issues.some((entry) => entry.code === "issues-truncated"))
    issues.push({ code: "issues-truncated", scope: "workspace" });
}

function issue(
  issues: UsageIssue[],
  code: UsageIssueCode,
  scope: UsageIssue["scope"],
  target?: string,
  error?: unknown,
): void {
  const errorCode = systemErrorCode(error);
  pushIssue(issues, {
    code,
    scope,
    ...(target === undefined ? {} : { target: boundedTarget(target) }),
    ...(errorCode === undefined ? {} : { errorCode }),
  });
}

function boundedTarget(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "?");
  return clean.length > 120 ? clean.slice(0, 120) + "…" : clean;
}

function safeChildName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 255 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\u0000")
  );
}

function inside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return (
    relation === "" ||
    (!relation.startsWith(".." + sep) &&
      relation !== ".." &&
      !isAbsolute(relation))
  );
}

function quoteIdentifier(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

function emptyBytes(state: UsageState = "complete"): ByteSummary {
  return {
    state,
    bytes: state === "complete" ? 0 : null,
    measuredBytes: 0,
    measuredFiles: 0,
    unknownFiles: 0,
    unscannedEntries: 0,
    overflow: false,
  };
}

function emptyTree(state: UsageState = "complete"): TreeUsage {
  return {
    ...emptyBytes(state),
    root: "missing",
    directories: 0,
    symlinks: 0,
    otherEntries: 0,
    truncated: false,
  };
}

function unknownReceipts(): ReceiptUsage {
  return {
    state: "unknown",
    rows: null,
    storedBytes: null,
    fingerprintBytes: null,
    largestResultBytes: null,
    corruptRows: null,
    inspectedRows: null,
    byStatus: null,
    overflow: false,
  };
}

function unknownDatabase(
  callerOwnedTransaction: boolean | null,
): DatabaseUsage {
  return {
    state: "unknown",
    storeVersion: null,
    snapshot: { callerOwnedTransaction, state: "unknown" },
    tables: [],
    unrecognizedTables: [],
    receipts: unknownReceipts(),
    slots: [],
    fileBytes: null,
    unknownFiles: 0,
    storedTextBytes: null,
    overflow: false,
  };
}

function unknownBackups(root: "unknown" | "missing"): BackupsUsage {
  return {
    state: root === "missing" ? "complete" : "unknown",
    root,
    entries: [],
    complete: 0,
    incomplete: 0,
    unknown: 0,
    bytes: emptyBytes(root === "missing" ? "complete" : "unknown"),
    truncated: false,
  };
}

function resolveLimits(
  input: Partial<StorageScanLimits> | undefined,
): StorageScanLimits {
  const limits = { ...DEFAULT_STORAGE_SCAN_LIMITS, ...input };
  for (const key of Object.keys(limits) as (keyof StorageScanLimits)[]) {
    const value = limits[key];
    if (!isSafeNonNegativeInteger(value) || value < 1)
      throw new RangeError(`Invalid storage scan limit: ${key}`);
  }
  return limits;
}

/* ------------------------------------------------------------------------- */
/* SQLite accounting                                                          */
/* ------------------------------------------------------------------------- */

type TableInfoRow = { name: string; type: string };

function tableNames(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as unknown as { name: string }[];
  return new Set(rows.map((row) => String(row.name)));
}

function readUserVersion(db: DatabaseSync): number | null {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version?: unknown }
    | undefined;
  const value = row?.user_version;
  return isSafeNonNegativeInteger(value) ? value : null;
}

function textColumn(column: TableInfoRow): boolean {
  const type = typeof column.type === "string" ? column.type : "";
  return type === "" || /TEXT|CHAR|CLOB|BLOB/i.test(type);
}

function readTableUsage(
  db: DatabaseSync,
  name: string,
  role: TableRole,
  issues: UsageIssue[],
): TableUsage {
  const base: TableUsage = {
    name,
    role,
    state: "present",
    rows: null,
    storedBytes: null,
    textColumns: 0,
  };
  try {
    const countRow = db
      .prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`)
      .get() as { count?: unknown } | undefined;
    const rows = countRow?.count;
    if (!isSafeNonNegativeInteger(rows))
      throw new Error("unsafe row count");
    const columns = db
      .prepare(`PRAGMA table_xinfo(${quoteIdentifier(name)})`)
      .all() as unknown as TableInfoRow[];
    const measuredColumns = columns.filter(textColumn);
    let stored = 0;
    for (const column of measuredColumns) {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(length(CAST(${quoteIdentifier(column.name)} AS BLOB))),0) AS bytes FROM ${quoteIdentifier(name)}`,
        )
        .get() as { bytes?: unknown } | undefined;
      const bytes = row?.bytes ?? 0;
      if (!isSafeNonNegativeInteger(bytes)) throw new Error("unsafe byte sum");
      const next = addCounts(stored, bytes);
      if (next.overflow) {
        issue(issues, "counter-overflow", "database", name);
        return { ...base, state: "unknown", textColumns: measuredColumns.length };
      }
      stored = next.value;
    }
    return {
      ...base,
      rows,
      storedBytes: stored,
      textColumns: measuredColumns.length,
    };
  } catch {
    issue(issues, "table-read-failed", "database", name);
    return { ...base, state: "unknown", errorCode: "SQLITE" };
  }
}

function readReceiptUsage(
  db: DatabaseSync,
  limits: StorageScanLimits,
  issues: UsageIssue[],
): ReceiptUsage {
  let aggregate: { rows?: unknown; stored?: unknown; fingerprints?: unknown; largest?: unknown };
  try {
    aggregate = db
      .prepare(
        `SELECT COUNT(*) AS rows,
                COALESCE(SUM(length(CAST(result_json AS BLOB))),0) AS stored,
                COALESCE(SUM(length(CAST(fingerprint AS BLOB))),0) AS fingerprints,
                COALESCE(MAX(length(CAST(result_json AS BLOB))),0) AS largest
         FROM save_receipts`,
      )
      .get() as typeof aggregate;
  } catch {
    issue(issues, "table-read-failed", "database", "save_receipts");
    return unknownReceipts();
  }
  const rows = aggregate.rows,
    stored = aggregate.stored,
    fingerprints = aggregate.fingerprints,
    largest = aggregate.largest;
  if (
    !isSafeNonNegativeInteger(rows) ||
    !isSafeNonNegativeInteger(stored) ||
    !isSafeNonNegativeInteger(fingerprints) ||
    !isSafeNonNegativeInteger(largest)
  ) {
    issue(issues, "counter-overflow", "database", "save_receipts");
    return { ...unknownReceipts(), overflow: true };
  }
  if (rows === 0)
    return {
      state: "complete",
      rows: 0,
      storedBytes: stored,
      fingerprintBytes: fingerprints,
      largestResultBytes: largest,
      corruptRows: 0,
      inspectedRows: 0,
      byStatus: { applied: 0, rejected: 0, unknown: 0, other: 0 },
      overflow: false,
    };
  const inspected = Math.min(rows, limits.maxReceiptClassificationRows);
  try {
    const classified = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN json_valid(result_json)=0 THEN 1 ELSE 0 END),0) AS malformed,
           COALESCE(SUM(CASE WHEN json_valid(result_json)=1 AND
             json_extract(CASE WHEN json_valid(result_json)=1 THEN result_json ELSE '{}' END,'$.status')='applied'
             THEN 1 ELSE 0 END),0) AS applied,
           COALESCE(SUM(CASE WHEN json_valid(result_json)=1 AND
             json_extract(CASE WHEN json_valid(result_json)=1 THEN result_json ELSE '{}' END,'$.status')='rejected'
             THEN 1 ELSE 0 END),0) AS rejected,
           COALESCE(SUM(CASE WHEN json_valid(result_json)=1 AND
             json_extract(CASE WHEN json_valid(result_json)=1 THEN result_json ELSE '{}' END,'$.status')='unknown'
             THEN 1 ELSE 0 END),0) AS unknown
         FROM (SELECT result_json FROM save_receipts ORDER BY rowid LIMIT ?)`,
      )
      .get(inspected) as
      | {
          malformed?: unknown;
          applied?: unknown;
          rejected?: unknown;
          unknown?: unknown;
        }
      | undefined;
    const malformed = classified?.malformed,
      applied = classified?.applied,
      rejected = classified?.rejected,
      unknown = classified?.unknown;
    if (
      !isSafeNonNegativeInteger(malformed) ||
      !isSafeNonNegativeInteger(applied) ||
      !isSafeNonNegativeInteger(rejected) ||
      !isSafeNonNegativeInteger(unknown)
    ) {
      issue(issues, "counter-overflow", "database", "save_receipts");
      return {
        state: "unknown",
        rows,
        storedBytes: stored,
        fingerprintBytes: fingerprints,
        largestResultBytes: largest,
        corruptRows: null,
        inspectedRows: null,
        byStatus: null,
        overflow: true,
      };
    }
    const partial = inspected < rows;
    if (partial)
      issue(issues, "receipt-classification-truncated", "database", "save_receipts");
    return {
      state: partial ? "partial" : "complete",
      rows,
      storedBytes: stored,
      fingerprintBytes: fingerprints,
      largestResultBytes: largest,
      corruptRows: malformed,
      inspectedRows: inspected,
      byStatus: {
        applied,
        rejected,
        unknown,
        other: inspected - applied - rejected - unknown - malformed,
      },
      overflow: false,
    };
  } catch {
    // JSON functions may be unavailable in an unusual SQLite build. Rows and
    // bytes are still measured; classification is explicitly not.
    issue(issues, "receipt-classification-unavailable", "database", "save_receipts");
    return {
      state: "partial",
      rows,
      storedBytes: stored,
      fingerprintBytes: fingerprints,
      largestResultBytes: largest,
      corruptRows: null,
      inspectedRows: 0,
      byStatus: null,
      overflow: false,
    };
  }
}

type DatabaseRead = Omit<
  DatabaseUsage,
  "slots" | "fileBytes" | "unknownFiles"
>;

function collectDatabaseUsage(
  db: DatabaseSync,
  limits: StorageScanLimits,
  callerOwnedTransaction: boolean,
  issues: UsageIssue[],
): DatabaseRead {
  const version = readUserVersion(db);
  if (version === null)
    issue(issues, "database-read-failed", "database", "user_version");
  const present = tableNames(db);
  const tables: TableUsage[] = [];
  for (const name of REQUIRED_TABLES) {
    if (!present.has(name)) {
      issue(issues, "required-table-missing", "database", name);
      tables.push({
        name,
        role: "required",
        state: "missing",
        rows: null,
        storedBytes: null,
        textColumns: 0,
      });
    } else {
      tables.push(readTableUsage(db, name, "required", issues));
    }
  }
  for (const name of OPTIONAL_TABLES) {
    if (!present.has(name)) {
      // Absent optional tables are reported as `missing`, never as 0 rows.
      tables.push({
        name,
        role: "optional",
        state: "missing",
        rows: null,
        storedBytes: null,
        textColumns: 0,
      });
    } else {
      tables.push(readTableUsage(db, name, "optional", issues));
    }
  }
  const unrecognized = [...present]
    .filter((name) => !KNOWN_TABLES.has(name))
    .sort();
  if (unrecognized.length)
    issue(issues, "unrecognized-table", "database", "sqlite_master");
  const receipts = readReceiptUsage(db, limits, issues);

  let storedTextBytes = 0;
  let textUnknown = false;
  let overflow = false;
  for (const table of tables) {
    if (table.state === "missing" && table.role === "optional") continue;
    if (table.state !== "present" || table.storedBytes === null) {
      textUnknown = true;
      continue;
    }
    const next = addCounts(storedTextBytes, table.storedBytes);
    if (next.overflow) {
      overflow = true;
      break;
    }
    storedTextBytes = next.value;
  }
  if (overflow) {
    issue(issues, "counter-overflow", "database", "stored-text");
    storedTextBytes = 0;
  }

  const requiredMissing = tables.some(
    (table) => table.role === "required" && table.state !== "present",
  );
  const tableUnknown = tables.some(
    (table) => table.state === "unknown",
  );
  const state = mergeUsageStates([
    version === null || requiredMissing || tableUnknown || overflow
      ? "unknown"
      : "complete",
    unrecognized.length ? "partial" : "complete",
    receipts.state,
  ]);

  return {
    state,
    storeVersion: version,
    snapshot: {
      callerOwnedTransaction,
      state: state === "unknown" ? "unknown" : "complete",
    },
    tables,
    unrecognizedTables: unrecognized.slice(
      0,
      limits.maxUnrecognizedTables,
    ),
    receipts,
    storedTextBytes: textUnknown || overflow ? null : storedTextBytes,
    overflow,
  };
}

/* ------------------------------------------------------------------------- */
/* Bounded filesystem scan                                                    */
/* ------------------------------------------------------------------------- */

type ScanBudget = {
  entriesLeft: number;
  maxDepth: number;
  truncated: boolean;
};

type ScanAccumulator = {
  measuredBytes: number;
  measuredFiles: number;
  unknownFiles: number;
  unscannedEntries: number;
  directories: number;
  symlinks: number;
  otherEntries: number;
  overflow: boolean;
  truncated: boolean;
};

function newAccumulator(): ScanAccumulator {
  return {
    measuredBytes: 0,
    measuredFiles: 0,
    unknownFiles: 0,
    unscannedEntries: 0,
    directories: 0,
    symlinks: 0,
    otherEntries: 0,
    overflow: false,
    truncated: false,
  };
}

function scanState(
  acc: ScanAccumulator,
  root: TreeUsage["root"],
): UsageState {
  if (
    root === "unknown" ||
    acc.unknownFiles > 0 ||
    acc.overflow ||
    acc.truncated
  )
    return "unknown";
  if (acc.symlinks > 0 || acc.otherEntries > 0) return "partial";
  return "complete";
}

function toTree(
  acc: ScanAccumulator,
  root: TreeUsage["root"],
): TreeUsage {
  const state = scanState(acc, root);
  const bytes =
    state === "unknown"
      ? null
      : acc.overflow
        ? null
        : acc.measuredBytes;
  return {
    state,
    bytes,
    measuredBytes: acc.measuredBytes,
    measuredFiles: acc.measuredFiles,
    unknownFiles: acc.unknownFiles,
    unscannedEntries: acc.unscannedEntries,
    overflow: acc.overflow,
    root,
    directories: acc.directories,
    symlinks: acc.symlinks,
    otherEntries: acc.otherEntries,
    truncated: acc.truncated,
  };
}

function walkTree(
  rootReal: string,
  dir: string,
  depth: number,
  budget: ScanBudget,
  acc: ScanAccumulator,
  ops: StorageScanOperations,
  issues: UsageIssue[],
  scope: UsageIssue["scope"],
): void {
  let names: string[];
  try {
    names = (ops.readdirSync(dir) as unknown as string[])
      .map((name) => String(name))
      .sort();
  } catch (error) {
    acc.unknownFiles++;
    acc.unscannedEntries++;
    const code = systemErrorCode(error);
    issue(
      issues,
      code === "EACCES" || code === "EPERM"
        ? "permission-denied"
        : errorIsMissing(error)
          ? "entry-vanished"
          : "read-failed",
      scope,
      undefined,
      error,
    );
    return;
  }
  for (const name of names) {
    if (budget.entriesLeft <= 0) {
      budget.truncated = true;
      acc.truncated = true;
      acc.unscannedEntries += names.length - names.indexOf(name);
      issue(issues, "scan-truncated", scope);
      return;
    }
    budget.entriesLeft--;
    if (!safeChildName(name)) {
      acc.unknownFiles++;
      issue(issues, "path-escape", scope);
      continue;
    }
    const child = join(dir, name);
    if (!inside(rootReal, child)) {
      acc.unknownFiles++;
      issue(issues, "path-escape", scope);
      continue;
    }
    let info: fs.Stats;
    try {
      info = ops.lstatSync(child);
    } catch (error) {
      acc.unknownFiles++;
      const code = systemErrorCode(error);
      issue(
        issues,
        code === "EACCES" || code === "EPERM"
          ? "permission-denied"
          : errorIsMissing(error)
            ? "entry-vanished"
            : "stat-failed",
        scope,
        undefined,
        error,
      );
      continue;
    }
    if (info.isSymbolicLink()) {
      // Never follow a link, not even to measure its target.
      acc.symlinks++;
      issue(issues, "symlink-skipped", scope);
      continue;
    }
    if (info.isDirectory()) {
      if (depth >= budget.maxDepth) {
        acc.truncated = true;
        acc.unscannedEntries++;
        budget.truncated = true;
        issue(issues, "depth-limit", scope);
        continue;
      }
      acc.directories++;
      walkTree(rootReal, child, depth + 1, budget, acc, ops, issues, scope);
      continue;
    }
    if (info.isFile()) {
      if (!isSafeNonNegativeInteger(info.size)) {
        acc.unknownFiles++;
        acc.overflow = true;
        issue(issues, "counter-overflow", scope);
        continue;
      }
      const next = addCounts(acc.measuredBytes, info.size);
      if (next.overflow) {
        acc.overflow = true;
        acc.unknownFiles++;
        issue(issues, "counter-overflow", scope);
        continue;
      }
      acc.measuredBytes = next.value;
      acc.measuredFiles++;
      continue;
    }
    acc.otherEntries++;
    acc.unknownFiles++;
    issue(issues, "unsupported-entry", scope);
  }
}

function scanTree(
  root: string,
  budget: ScanBudget,
  ops: StorageScanOperations,
  issues: UsageIssue[],
  scope: UsageIssue["scope"],
): TreeUsage {
  const absolute = resolve(root);
  let info: fs.Stats;
  try {
    info = ops.lstatSync(absolute);
  } catch (error) {
    if (errorIsMissing(error)) return emptyTree("complete");
    issue(
      issues,
      systemErrorCode(error) === "EACCES" ||
        systemErrorCode(error) === "EPERM"
        ? "permission-denied"
        : "stat-failed",
      scope,
      undefined,
      error,
    );
    return { ...emptyTree("unknown"), root: "unknown", bytes: null };
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    issue(issues, "root-unsafe", scope);
    return { ...emptyTree("unknown"), root: "unknown", bytes: null };
  }
  let rootReal: string;
  try {
    rootReal = ops.realpathSync(absolute);
  } catch (error) {
    issue(issues, "read-failed", scope, undefined, error);
    return { ...emptyTree("unknown"), root: "unknown", bytes: null };
  }
  const acc = newAccumulator();
  walkTree(rootReal, rootReal, 1, budget, acc, ops, issues, scope);
  const tree = toTree(acc, "present");
  tree.truncated = tree.truncated || budget.truncated;
  if (budget.truncated && tree.state !== "unknown") {
    tree.state = "partial";
    tree.bytes = null;
  }
  return tree;
}

/**
 * Scan one explicit directory target without following symbolic links.
 * Exported for focused tests; `readStorageUsage` shares a single work budget
 * across the assets and backups targets.
 */
export function scanDirectoryTree(
  root: string,
  options: {
    scanLimits?: Partial<StorageScanLimits>;
    operations?: Partial<StorageScanOperations>;
  } = {},
): { usage: TreeUsage; issues: UsageIssue[] } {
  const limits = resolveLimits(options.scanLimits);
  const ops: StorageScanOperations = { ...fs, ...options.operations };
  const issues: UsageIssue[] = [];
  const budget: ScanBudget = {
    entriesLeft: limits.maxEntries,
    maxDepth: limits.maxDepth,
    truncated: false,
  };
  const usage = scanTree(root, budget, ops, issues, "assets");
  return { usage, issues };
}

/* ------------------------------------------------------------------------- */
/* Backups                                                                    */
/* ------------------------------------------------------------------------- */

type ManifestInfo = {
  state: BackupManifestState;
  kind: BackupKind;
  createdAt: string | null;
  declaredDatabaseBytes: number | null;
  declaredAssetBytes: number | null;
  declaredAssets: number | null;
};

function invalidManifest(state: BackupManifestState = "invalid"): ManifestInfo {
  return {
    state,
    kind: "unknown",
    createdAt: null,
    declaredDatabaseBytes: null,
    declaredAssetBytes: null,
    declaredAssets: null,
  };
}

function validCreatedAt(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function readManifest(
  directory: string,
  ops: StorageScanOperations,
  issues: UsageIssue[],
  name: string,
): ManifestInfo {
  const path = join(directory, "manifest.json");
  let info: fs.Stats;
  try {
    info = ops.lstatSync(path);
  } catch (error) {
    if (errorIsMissing(error)) {
      issue(issues, "backup-manifest-missing", "backups", name);
      return invalidManifest("missing");
    }
    issue(issues, "stat-failed", "backups", name, error);
    return invalidManifest("unknown");
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_MANIFEST_BYTES) {
    issue(issues, "backup-manifest-unsafe", "backups", name);
    return invalidManifest("invalid");
  }
  let parsed: unknown;
  try {
    const content = ops.readFileSync(path, "utf8");
    parsed = JSON.parse(String(content));
  } catch {
    issue(issues, "backup-manifest-invalid", "backups", name);
    return invalidManifest("invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    issue(issues, "backup-manifest-invalid", "backups", name);
    return invalidManifest("invalid");
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.format === "folio-workspace-backup" &&
    value.version === 1 &&
    validCreatedAt(value.createdAt) &&
    value.database &&
    typeof value.database === "object" &&
    isSafeNonNegativeInteger(
      (value.database as Record<string, unknown>).bytes,
    ) &&
    Array.isArray(value.assets) &&
    value.assets.length <= 100_000
  ) {
    let declaredAssets = 0;
    let overflow = false;
    for (const asset of value.assets) {
      if (
        !asset ||
        typeof asset !== "object" ||
        !isSafeNonNegativeInteger(
          (asset as Record<string, unknown>).bytes,
        )
      ) {
        issue(issues, "backup-manifest-invalid", "backups", name);
        return invalidManifest("invalid");
      }
      const next = addCounts(
        declaredAssets,
        (asset as Record<string, unknown>).bytes as number,
      );
      if (next.overflow) {
        overflow = true;
        break;
      }
      declaredAssets = next.value;
    }
    if (overflow) issue(issues, "counter-overflow", "backups", name);
    return {
      state: "valid",
      kind: "workspace",
      createdAt: value.createdAt,
      declaredDatabaseBytes: (value.database as Record<string, unknown>)
        .bytes as number,
      declaredAssetBytes: overflow ? null : declaredAssets,
      declaredAssets: value.assets.length,
    };
  }
  if (
    value.format === "folio-pre-migration-snapshot" &&
    value.schemaVersion === 1
  ) {
    return {
      state: "valid",
      kind: "migration",
      createdAt: validCreatedAt(value.createdAt) ? value.createdAt : null,
      declaredDatabaseBytes: null,
      declaredAssetBytes: null,
      declaredAssets: null,
    };
  }
  if (
    value.app === "Folio" &&
    value.schema === 1 &&
    validCreatedAt(value.createdAt)
  ) {
    return {
      state: "valid",
      kind: "legacy",
      createdAt: value.createdAt,
      declaredDatabaseBytes: null,
      declaredAssetBytes: null,
      declaredAssets: null,
    };
  }
  issue(issues, "backup-manifest-invalid", "backups", name);
  return invalidManifest("invalid");
}

function readMarker(
  directory: string,
  ops: StorageScanOperations,
  issues: UsageIssue[],
  name: string,
): "present" | "missing" | "unknown" {
  const path = join(directory, "FOLIO-RECOVERY-INCOMPLETE");
  try {
    const info = ops.lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      issue(issues, "backup-marker-unsafe", "backups", name);
      return "unknown";
    }
    return "present";
  } catch (error) {
    if (errorIsMissing(error)) return "missing";
    issue(issues, "stat-failed", "backups", name, error);
    return "unknown";
  }
}

function readBackupDatabase(
  directory: string,
  ops: StorageScanOperations,
  issues: UsageIssue[],
  name: string,
): { bytes: number | null; state: "file" | "missing" | "unsafe" } {
  try {
    const info = ops.lstatSync(join(directory, "workspace.sqlite"));
    if (info.isSymbolicLink() || !info.isFile()) {
      issue(issues, "backup-entry-unsupported", "backups", name);
      return { bytes: null, state: "unsafe" };
    }
    if (!isSafeNonNegativeInteger(info.size)) {
      issue(issues, "counter-overflow", "backups", name);
      return { bytes: null, state: "unsafe" };
    }
    return { bytes: info.size, state: "file" };
  } catch (error) {
    if (errorIsMissing(error)) {
      issue(issues, "backup-database-missing", "backups", name);
      return { bytes: null, state: "missing" };
    }
    issue(issues, "stat-failed", "backups", name, error);
    return { bytes: null, state: "unsafe" };
  }
}

function backupEntry(
  root: string,
  name: string,
  budget: ScanBudget,
  ops: StorageScanOperations,
  issues: UsageIssue[],
): BackupEntryUsage {
  const directory = join(root, name);
  const before = issues.length;
  const tree = scanTree(directory, budget, ops, issues, "backups");
  const manifest = readManifest(directory, ops, issues, name);
  const marker = readMarker(directory, ops, issues, name);
  let state: BackupEntryUsage["state"];
  if (marker === "unknown" || manifest.state === "unknown") {
    state = "unknown";
  } else if (
    marker === "present" ||
    manifest.state === "missing" ||
    manifest.state === "invalid"
  ) {
    state = "incomplete";
  } else {
    state = "complete";
  }
  if (manifest.state === "valid") {
    const database = readBackupDatabase(directory, ops, issues, name);
    if (database.state !== "file") state = "incomplete";
    else if (
      manifest.kind === "workspace" &&
      manifest.declaredDatabaseBytes !== null &&
      database.bytes !== manifest.declaredDatabaseBytes
    ) {
      issue(issues, "backup-declared-size-mismatch", "backups", name);
      state = "incomplete";
    }
  }
  if (tree.state !== "complete" && state === "complete") state = "unknown";
  const issueCodes = [...new Set(issues.slice(before).map((entry) => entry.code))];
  return {
    name,
    state,
    kind: manifest.kind,
    marker,
    manifest: manifest.state,
    createdAt: manifest.createdAt,
    declaredDatabaseBytes: manifest.declaredDatabaseBytes,
    declaredAssetBytes: manifest.declaredAssetBytes,
    declaredAssets: manifest.declaredAssets,
    bytes: {
      state: tree.state,
      bytes: tree.bytes,
      measuredBytes: tree.measuredBytes,
      measuredFiles: tree.measuredFiles,
      unknownFiles: tree.unknownFiles,
      unscannedEntries: tree.unscannedEntries,
      overflow: tree.overflow,
    },
    issueCodes,
  };
}

function scanBackups(
  root: string,
  budget: ScanBudget,
  ops: StorageScanOperations,
  issues: UsageIssue[],
): BackupsUsage {
  const absolute = resolve(root);
  let info: fs.Stats;
  try {
    info = ops.lstatSync(absolute);
  } catch (error) {
    if (errorIsMissing(error)) return unknownBackups("missing");
    issue(issues, "stat-failed", "backups", undefined, error);
    return unknownBackups("unknown");
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    issue(issues, "root-unsafe", "backups");
    return unknownBackups("unknown");
  }
  let rootReal: string;
  let names: string[];
  try {
    rootReal = ops.realpathSync(absolute);
    names = (ops.readdirSync(rootReal) as unknown as string[])
      .map((name) => String(name))
      .sort();
  } catch (error) {
    issue(
      issues,
      systemErrorCode(error) === "EACCES" ||
        systemErrorCode(error) === "EPERM"
        ? "permission-denied"
        : "read-failed",
      "backups",
      undefined,
      error,
    );
    return unknownBackups("unknown");
  }
  const entries: BackupEntryUsage[] = [];
  const entryStates: UsageState[] = [];
  let measuredBytes = 0,
    measuredFiles = 0,
    unknownFiles = 0,
    unscannedEntries = 0,
    overflow = false,
    truncated = false;
  for (const name of names) {
    if (budget.entriesLeft <= 0) {
      budget.truncated = true;
      truncated = true;
      unscannedEntries++;
      issue(issues, "scan-truncated", "backups");
      continue;
    }
    budget.entriesLeft--;
    if (!safeChildName(name) || !inside(rootReal, join(rootReal, name))) {
      unknownFiles++;
      issue(issues, "path-escape", "backups");
      continue;
    }
    let entryInfo: fs.Stats;
    try {
      entryInfo = ops.lstatSync(join(rootReal, name));
    } catch (error) {
      unknownFiles++;
      issue(
        issues,
        systemErrorCode(error) === "EACCES" ||
          systemErrorCode(error) === "EPERM"
          ? "permission-denied"
          : errorIsMissing(error)
            ? "entry-vanished"
            : "stat-failed",
        "backups",
        undefined,
        error,
      );
      continue;
    }
    if (entryInfo.isSymbolicLink()) {
      unknownFiles++;
      issue(issues, "symlink-skipped", "backups");
      continue;
    }
    if (!entryInfo.isDirectory()) {
      unknownFiles++;
      issue(issues, "backup-entry-unsupported", "backups", name);
      continue;
    }
    const entry = backupEntry(rootReal, name, budget, ops, issues);
    entries.push(entry);
    entryStates.push(entry.bytes.state);
    const nextBytes = addCounts(measuredBytes, entry.bytes.measuredBytes);
    if (nextBytes.overflow) overflow = true;
    else measuredBytes = nextBytes.value;
    const nextFiles = addCounts(measuredFiles, entry.bytes.measuredFiles);
    if (nextFiles.overflow) overflow = true;
    else measuredFiles = nextFiles.value;
    const nextUnknown = addCounts(unknownFiles, entry.bytes.unknownFiles);
    if (nextUnknown.overflow) overflow = true;
    else unknownFiles = nextUnknown.value;
    const nextUnscanned = addCounts(
      unscannedEntries,
      entry.bytes.unscannedEntries,
    );
    if (nextUnscanned.overflow) overflow = true;
    else unscannedEntries = nextUnscanned.value;
    if (entry.bytes.overflow) overflow = true;
    if (entry.bytes.unscannedEntries > 0) truncated = true;
  }
  const incomplete = entries.filter((entry) => entry.state === "incomplete")
    .length;
  const unknown = entries.filter((entry) => entry.state === "unknown").length;
  const complete = entries.length - incomplete - unknown;
  const bytes: ByteSummary = {
    state: "complete",
    bytes: measuredBytes,
    measuredBytes,
    measuredFiles,
    unknownFiles,
    unscannedEntries,
    overflow,
  };
  let bytesState = mergeUsageStates(
    entryStates.length ? entryStates : ["complete"],
  );
  if (overflow) bytesState = "unknown";
  if (unknownFiles > 0 || unknown > 0 || truncated) bytesState = "unknown";
  bytes.state = bytesState;
  bytes.bytes = bytesState === "unknown" ? null : measuredBytes;
  const state = mergeUsageStates([
    bytesState,
    unknown > 0 ? "unknown" : "complete",
    truncated ? "partial" : "complete",
  ]);
  return {
    state,
    root: "present",
    entries,
    complete,
    incomplete,
    unknown,
    bytes,
    truncated,
  };
}

/* ------------------------------------------------------------------------- */
/* Workspace slots and report assembly                                        */
/* ------------------------------------------------------------------------- */

function readSlot(
  ops: StorageScanOperations,
  path: string,
  slot: StorageSlot,
  issues: UsageIssue[],
  required = false,
): SlotUsage {
  let info: fs.Stats;
  try {
    info = ops.lstatSync(path);
  } catch (error) {
    if (errorIsMissing(error)) {
      if (required) {
        issue(issues, "entry-vanished", "workspace", slot, error);
        return { slot, state: "unknown", bytes: null, errorCode: "ENOENT" };
      }
      return { slot, state: "missing", bytes: 0 };
    }
    issue(issues, "stat-failed", "workspace", slot, error);
    return {
      slot,
      state: "unknown",
      bytes: null,
      errorCode: systemErrorCode(error) ?? "UNKNOWN",
    };
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    issue(issues, "symlink-skipped", "workspace", slot);
    return { slot, state: "unknown", bytes: null, errorCode: "UNSAFE" };
  }
  if (!isSafeNonNegativeInteger(info.size)) {
    issue(issues, "counter-overflow", "workspace", slot);
    return { slot, state: "unknown", bytes: null, errorCode: "OVERFLOW" };
  }
  return { slot, state: "measured", bytes: info.size };
}

function slotBytes(slots: readonly SlotUsage[]): {
  bytes: number | null;
  unknown: number;
  overflow: boolean;
} {
  let total = 0,
    unknown = 0;
  for (const slot of slots) {
    if (slot.state === "unknown") {
      unknown++;
      continue;
    }
    const next = addCounts(total, slot.bytes ?? 0);
    if (next.overflow) return { bytes: null, unknown, overflow: true };
    total = next.value;
  }
  return {
    bytes: unknown ? null : total,
    unknown,
    overflow: false,
  };
}

const RECOVERY_STAGING = /^crash-recovery\.json\.stage-[A-Za-z0-9-]{1,64}$/;
const MAX_RECOVERY_STAGING_FILES = 100;

/** Staging files are leftovers of an interrupted checkpoint write. They may
 * contain unsaved input, so only their size is measured; content is never
 * opened and no file is removed. */
function readRecoveryStagingSlots(
  ops: StorageScanOperations,
  root: string,
  issues: UsageIssue[],
): { slots: SlotUsage[]; state: UsageState } {
  let names: string[];
  try {
    names = (ops.readdirSync(root) as unknown as string[])
      .map((name) => String(name))
      .sort();
  } catch (error) {
    issue(issues, "read-failed", "workspace", "recovery-staging", error);
    return { slots: [], state: "unknown" };
  }
  const slots: SlotUsage[] = [];
  for (const name of names) {
    if (!RECOVERY_STAGING.test(name)) continue;
    if (slots.length >= MAX_RECOVERY_STAGING_FILES) {
      issue(issues, "scan-truncated", "workspace", "recovery-staging");
      return { slots, state: "partial" };
    }
    slots.push(
      readSlot(ops, join(root, name), "recovery-staging", issues),
    );
  }
  return { slots, state: "complete" };
}

/**
 * Read-only usage report for one open workspace.
 *
 * SQLite row/byte accounting runs inside the existing `Store.readSnapshot`
 * transaction. When the caller already owns a transaction, it is reused and
 * never committed or rolled back here. Filesystem accounting runs after the
 * snapshot and is explicitly a separate observation (no cross-domain atomicity
 * is claimed).
 */
export function readStorageUsage(
  store: Pick<Store, "db" | "path" | "readSnapshot">,
  options: StorageUsageOptions = {},
): StorageUsageReport {
  const limits = resolveLimits(options.scanLimits);
  const ops: StorageScanOperations = { ...fs, ...options.operations };
  const now = (options.now ?? (() => new Date()))();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new TypeError("Invalid storage usage clock");
  const issues: UsageIssue[] = [];
  const workspaceRoot = dirname(resolve(store.path));

  let callerOwnedTransaction: boolean | null = null;
  let database: DatabaseUsage;
  try {
    const active = store.db.isTransaction;
    if (typeof active !== "boolean")
      throw new Error("SQLite transaction state is unavailable");
    callerOwnedTransaction = active;
    const read = store.readSnapshot(() =>
      collectDatabaseUsage(store.db, limits, active, issues),
    );
    database = {
      ...read,
      slots: [],
      fileBytes: null,
      unknownFiles: 0,
    };
  } catch {
    issue(issues, "database-read-failed", "database");
    database = unknownDatabase(callerOwnedTransaction);
  }

  const databaseSlots = [
    readSlot(ops, resolve(store.path), "database", issues, true),
    readSlot(ops, resolve(store.path) + "-wal", "wal", issues),
    readSlot(ops, resolve(store.path) + "-shm", "shm", issues),
    readSlot(ops, resolve(store.path) + "-journal", "journal", issues),
  ];
  const staging = readRecoveryStagingSlots(ops, workspaceRoot, issues);
  const otherSlots = [
    readSlot(ops, resolve(store.path) + ".pre-v2.sqlite", "pre-v2", issues),
    readSlot(ops, resolve(store.path) + ".pre-v3.sqlite", "pre-v3", issues),
    readSlot(
      ops,
      join(workspaceRoot, "crash-recovery.json"),
      "recovery",
      issues,
    ),
    readSlot(
      ops,
      join(workspaceRoot, "FOLIO-RECOVERY-INCOMPLETE"),
      "incomplete-marker",
      issues,
    ),
    ...staging.slots,
  ];
  const databaseFile = slotBytes(databaseSlots);
  const otherFile = slotBytes(otherSlots);
  database = {
    ...database,
    slots: databaseSlots,
    fileBytes: databaseFile.bytes,
    unknownFiles: databaseFile.unknown,
  };

  const budget: ScanBudget = {
    entriesLeft: limits.maxEntries,
    maxDepth: limits.maxDepth,
    truncated: false,
  };
  const assets = scanTree(
    join(workspaceRoot, "assets"),
    budget,
    ops,
    issues,
    "assets",
  );
  const backups = scanBackups(
    join(workspaceRoot, "backups"),
    budget,
    ops,
    issues,
  );

  const workspace: WorkspaceUsage = {
    state: mergeUsageStates([
      assets.state,
      backups.state,
      staging.state,
      databaseFile.unknown > 0 ? "unknown" : "complete",
      otherFile.unknown > 0 ? "unknown" : "complete",
      otherFile.overflow || databaseFile.overflow ? "unknown" : "complete",
    ]),
    assets,
    backups,
    slots: otherSlots,
    otherFileBytes: otherFile.bytes,
    overflow: otherFile.overflow || databaseFile.overflow,
  };

  const total = sumNullable([
    databaseFile.bytes,
    assets.bytes,
    backups.bytes.bytes,
    otherFile.bytes,
  ]);
  const totalFileBytes = total.overflow ? null : total.value;
  let unknownFileCount = 0;
  let unknownCountOverflow = false;
  for (const count of [
    database.unknownFiles,
    assets.unknownFiles,
    backups.bytes.unknownFiles,
    otherFile.unknown,
  ]) {
    const next = addCounts(unknownFileCount, count);
    if (next.overflow) {
      unknownCountOverflow = true;
      break;
    }
    unknownFileCount = next.value;
  }
  if (unknownCountOverflow)
    issue(issues, "counter-overflow", "workspace", "unknown-file-count");
  const totals: StorageUsageTotalsLike = {
    state: mergeUsageStates([
      database.state,
      workspace.state,
      totalFileBytes === null ? "unknown" : "complete",
      database.overflow ||
      total.overflow ||
      unknownCountOverflow
        ? "unknown"
        : "complete",
    ]),
    databaseFileBytes: databaseFile.bytes,
    assetFileBytes: assets.bytes,
    backupFileBytes: backups.bytes.bytes,
    otherWorkspaceFileBytes: otherFile.bytes,
    totalFileBytes,
    storedTextBytes: database.storedTextBytes,
    unknownFileCount: unknownCountOverflow ? 0 : unknownFileCount,
    overflow: database.overflow || total.overflow || unknownCountOverflow,
  };

  const state = totals.state;
  return {
    format: STORAGE_USAGE_FORMAT,
    version: STORAGE_USAGE_VERSION,
    generatedAt: now.toISOString(),
    state,
    limits,
    database,
    workspace,
    totals,
    issues,
  };
}

type StorageUsageTotalsLike = StorageUsageReport["totals"];
