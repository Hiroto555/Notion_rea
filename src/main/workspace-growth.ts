import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sqliteAllocatedBytes } from "../persistence/sqlite-allocation";
import { scanDirectoryTree } from "../persistence/storage-usage";

import type { ManagedGrowthLimits } from "../shared/storage-overview";

export type GrowthLimits = ManagedGrowthLimits;

const ENV_LIMITS = [
  ["FOLIO_MAX_DATABASE_BYTES", "maxDatabaseBytes"],
  ["FOLIO_MAX_ASSET_BYTES", "maxAssetBytes"],
  ["FOLIO_MAX_BACKUP_BYTES", "maxBackupBytes"],
  ["FOLIO_MAX_RECEIPT_ROWS", "maxReceiptRows"],
] as const;

type LimitKey = (typeof ENV_LIMITS)[number][1];

const EXCEEDED_MESSAGE =
  "保存を停止しました (workspace-limit-exceeded)。保存領域の上限に達しています。" +
  "使用量と上限を確認してから、保持した入力を同じ操作で再試行してください。";
const UNKNOWN_MESSAGE =
  "保存を停止しました (workspace-limit-unknown)。保存領域の使用量を確認できません。" +
  "入力は保持されています。保存先の状態を確認してから、同じ操作を再試行してください。";

function isSafeByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function configError(detail: string): TypeError {
  return new TypeError(
    `保存領域の上限設定が不正です (workspace-limit-unknown): ${detail}`,
  );
}

function refusal(limit: "exceeded" | "unknown", scope?: string): Error {
  const message = limit === "exceeded" ? EXCEEDED_MESSAGE : UNKNOWN_MESSAGE;
  return new Error(scope ? scope + "の上限: " + message : message);
}

function isLimitKey(key: string): key is LimitKey {
  return ENV_LIMITS.some(([, known]) => known === key);
}

/** Opt-in limits only. A set variable must be a canonical non-negative safe
 * integer string; an invalid value is a configuration error, never "unset". */
export function growthLimitsFromEnv(
  env: Record<string, string | undefined>,
): GrowthLimits {
  if (env === null || typeof env !== "object" || Array.isArray(env))
    throw configError("env");
  const limits: GrowthLimits = {};
  for (const [name, key] of ENV_LIMITS) {
    const raw = env[name];
    if (raw === undefined) continue;
    if (typeof raw !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(raw))
      throw configError(name);
    const value = Number(raw);
    if (!isSafeByteCount(value)) throw configError(name);
    limits[key] = value;
  }
  return limits;
}

function validateLimits(limits: GrowthLimits): GrowthLimits {
  if (limits === null || typeof limits !== "object" || Array.isArray(limits))
    throw configError("limits");
  const normalized: GrowthLimits = {};
  for (const key of Object.keys(limits)) {
    const value = (limits as Record<string, unknown>)[key];
    if (!isLimitKey(key)) throw configError(key);
    if (value === undefined) continue;
    if (!isSafeByteCount(value)) throw configError(key);
    normalized[key] = value;
  }
  return normalized;
}

/** Pre-write managed-growth checks for the workspace database, assets and
 * backups. The database uses SQLite's logical page count; the copy targets are
 * measured from the managed directory tree immediately before the copy.
 * Nothing here writes, loads or rewrites settings or database rows. */
export class WorkspaceGrowth {
  private readonly directory: string;
  private readonly db: DatabaseSync;
  private readonly limits: GrowthLimits;

  constructor(directory: string, db: DatabaseSync, limits: GrowthLimits) {
    if (typeof directory !== "string" || directory.length === 0)
      throw configError("directory");
    this.directory = directory;
    this.db = db;
    this.limits = validateLimits(limits);
  }

  /** Refuse once the existing logical database is at the configured high-water
   * mark. A single transaction may pass the limit; the next save observes it. */
  assertDatabaseWritable(): void {
    const maximum = this.limits.maxDatabaseBytes;
    if (maximum === undefined) return;
    if (this.databaseBytes() >= maximum) throw refusal("exceeded", "DB容量");
  }

  /** Only commands that can insert a receipt use this cap. An existing ID
   * must still reach the normal identity/fingerprint checks and resolution. */
  assertReceiptWritable(operationId: string): void {
    const maximum = this.limits.maxReceiptRows;
    if (maximum === undefined) return;
    let rows: unknown;
    try {
      if (this.db.prepare("SELECT 1 FROM save_receipts WHERE operation_id=?").get(operationId)) return;
      rows = this.db.prepare("SELECT count(*) AS n FROM save_receipts").get()?.n;
    } catch { throw refusal("unknown"); }
    if (!isSafeByteCount(rows)) throw refusal("unknown");
    if (rows >= maximum) throw refusal("exceeded", "保存記録の件数");
  }

  assertAssetGrowth(additionalBytes: number): void {
    if (!isSafeByteCount(additionalBytes)) throw refusal("unknown");
    const maximum = this.limits.maxAssetBytes;
    if (maximum === undefined) return;
    // Staged downloads remain on disk until separately collected. Count them
    // together with active assets, including while publishing a fresh copy.
    const current = this.directoryBytes("assets") + this.directoryBytes(".folio-sync-assets-staging");
    const projected = current + additionalBytes;
    if (!isSafeByteCount(current) || !isSafeByteCount(projected)) throw refusal("unknown");
    if (projected > maximum) throw refusal("exceeded", "添付容量");
  }

  assertBackupGrowth(additionalBytes: number): void {
    this.assertDirectoryGrowth(
      "backups",
      this.limits.maxBackupBytes,
      additionalBytes,
    );
  }

  private databaseBytes(): number {
    try { return sqliteAllocatedBytes(this.db); }
    catch { throw refusal("unknown"); }
  }

  private workspaceRootIsSafe(): boolean {
    try {
      const info = lstatSync(resolve(this.directory));
      return !info.isSymbolicLink() && info.isDirectory();
    } catch {
      return false;
    }
  }

  private directoryBytes(kind: "assets" | "backups" | ".folio-sync-assets-staging"): number {
    if (!this.workspaceRootIsSafe()) throw refusal("unknown");
    let usage: ReturnType<typeof scanDirectoryTree>["usage"];
    try {
      usage = scanDirectoryTree(join(this.directory, kind)).usage;
    } catch {
      throw refusal("unknown");
    }
    // ENOENT is the only measured zero. A child that vanishes mid-scan, a
    // permission failure or an unsafe root already reports null bytes.
    if (usage.root === "missing") {
      if (
        usage.state !== "complete" ||
        usage.bytes !== 0 ||
        usage.symlinks !== 0 ||
        usage.unscannedEntries !== 0
      )
        throw refusal("unknown");
      return 0;
    }
    // Any partial scan is fail-closed, including a skipped symlink: the
    // measured sum is not the whole managed directory.
    if (
      usage.root !== "present" ||
      usage.state !== "complete" ||
      usage.symlinks !== 0 ||
      usage.unscannedEntries !== 0 ||
      usage.bytes === null ||
      !isSafeByteCount(usage.bytes)
    )
      throw refusal("unknown");
    return usage.bytes;
  }

  private assertDirectoryGrowth(
    kind: "assets" | "backups",
    maximum: number | undefined,
    additionalBytes: number,
  ): void {
    if (!isSafeByteCount(additionalBytes)) throw refusal("unknown");
    if (maximum === undefined) return;
    const current = this.directoryBytes(kind);
    const projected = current + additionalBytes;
    if (!isSafeByteCount(projected)) throw refusal("unknown");
    if (projected > maximum) throw refusal("exceeded", kind === "assets" ? "添付容量" : "バックアップ容量");
  }
}
