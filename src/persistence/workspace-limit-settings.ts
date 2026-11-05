import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ManagedGrowthLimits as GrowthLimits, WorkspaceLimitView } from "../shared/storage-overview";

const SETTINGS_KEY = "folio.workspace.growthLimits";
const FORMAT_VERSION = 1;
const LIMIT_KEYS = [
  "maxDatabaseBytes",
  "maxAssetBytes",
  "maxBackupBytes",
  "maxReceiptRows",
] as const;

type StoredPolicy = {
  revision: string;
  limits: GrowthLimits;
  raw: string;
};

const INVALID = "workspace-limit-settings-invalid";
const STALE = "workspace-limit-settings-stale";
const CORRUPT = "workspace-limit-settings-corrupt";
const WRITE_FAILED = "workspace-limit-settings-write-failed";

function invalid(detail: string): TypeError {
  return new TypeError(`保存領域の上限設定が不正です (${INVALID}): ${detail}`);
}

function corrupt(detail: string): Error {
  return new Error(
    `保存領域の上限設定が壊れています (${CORRUPT})。上書きせずに停止しました: ${detail}`,
  );
}

function stale(): Error {
  return new Error(
    `保存領域の上限設定が競合しています (${STALE})。再読み込みしてください。`,
  );
}

function isSafeLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Exact keys only. `undefined` is treated as an omitted optional property;
 * every present value must be a non-negative safe integer. */
function normalizeLimits(
  value: unknown,
  source: string,
  fail: (detail: string) => Error,
): GrowthLimits {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw fail(`${source} must be an object`);
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(key))
      throw fail(`${source}.${key} is not a growth limit`);
  }
  const normalized: GrowthLimits = {};
  for (const key of LIMIT_KEYS) {
    const limit = input[key];
    if (limit === undefined) continue;
    if (!isSafeLimit(limit))
      throw fail(`${source}.${key} is not a safe integer`);
    normalized[key] = limit;
  }
  return normalized;
}

function sameLimits(left: GrowthLimits, right: GrowthLimits): boolean {
  return LIMIT_KEYS.every((key) => left[key] === right[key]);
}

function serialize(revision: string, limits: GrowthLimits): string {
  const ordered: GrowthLimits = {};
  for (const key of LIMIT_KEYS) {
    const value = limits[key];
    if (value !== undefined) ordered[key] = value;
  }
  return JSON.stringify({
    version: FORMAT_VERSION,
    revision,
    limits: ordered,
  });
}

/** User-editable limits persisted in the existing settings table. `operator`
 * is the admin/environment ceiling and is never persisted. */
export class WorkspaceLimitSettings {
  private readonly db: DatabaseSync;
  private readonly operator: GrowthLimits;

  constructor(db: DatabaseSync, operator: GrowthLimits) {
    this.db = db;
    this.operator = normalizeLimits(operator, "operator", invalid);
  }

  read(): WorkspaceLimitView {
    const stored = this.readStored();
    return stored
      ? this.state(stored.revision, stored.limits)
      : this.state(null, {});
  }

  apply(
    expectedRevision: string | null,
    configured: GrowthLimits,
  ): WorkspaceLimitView {
    if (expectedRevision !== null && typeof expectedRevision !== "string")
      throw invalid("expectedRevision must be a string or null");
    const next = normalizeLimits(configured, "configured", invalid);
    const stored = this.readStored();

    if (!stored) {
      if (expectedRevision !== null) throw stale();
      if (Object.keys(next).length === 0) return this.state(null, next);
      const revision = randomUUID();
      const changes = this.write(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING",
        [SETTINGS_KEY, serialize(revision, next)],
      );
      if (changes !== 1) throw stale();
      return this.state(revision, next);
    }

    if (expectedRevision !== stored.revision) throw stale();
    if (sameLimits(next, stored.limits))
      return this.state(stored.revision, stored.limits);

    const revision = randomUUID();
    const changes = this.write(
      "UPDATE settings SET value=? WHERE key=? AND value=?",
      [serialize(revision, next), SETTINGS_KEY, stored.raw],
    );
    if (changes !== 1) throw stale();
    return this.state(revision, next);
  }

  private state(
    revision: string | null,
    configured: GrowthLimits,
  ): WorkspaceLimitView {
    const effective: GrowthLimits = {};
    for (const key of LIMIT_KEYS) {
      const user = configured[key];
      const admin = this.operator[key];
      const value =
        user === undefined
          ? admin
          : admin === undefined
            ? user
            : Math.min(user, admin);
      if (value !== undefined) effective[key] = value;
    }
    return { revision, configured: { ...configured }, effective };
  }

  private readStored(): StoredPolicy | undefined {
    const row = this.db
      .prepare("SELECT substr(value,1,1025) AS value FROM settings WHERE key=?")
      .get(SETTINGS_KEY) as { value?: unknown } | undefined | null;
    if (row === undefined || row === null) return undefined;
    if (typeof row.value !== "string")
      throw corrupt("stored value is not text");
    const raw = row.value;
    if (raw.length > 1024) throw corrupt("stored value exceeds the policy size limit");

    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw corrupt("stored value is not JSON");
    }
    if (
      envelope === null ||
      typeof envelope !== "object" ||
      Array.isArray(envelope)
    )
      throw corrupt("stored value is not an object");
    const object = envelope as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    if (
      keys.length !== 3 ||
      keys[0] !== "limits" ||
      keys[1] !== "revision" ||
      keys[2] !== "version"
    )
      throw corrupt("stored value has unexpected fields");
    if (object.version !== FORMAT_VERSION)
      throw corrupt("stored value has an unsupported version");
    if (
      typeof object.revision !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(object.revision)
    )
      throw corrupt("stored value has an invalid revision");
    const limits = normalizeLimits(object.limits, "stored limits", corrupt);
    return { revision: object.revision, limits, raw };
  }

  private write(sql: string, parameters: string[]): number {
    try {
      const result = this.db.prepare(sql).run(...parameters);
      return Number(result.changes);
    } catch (error) {
      throw new Error(
        `保存領域の上限設定を保存できませんでした (${WRITE_FAILED})。以前の設定は保持されています。`,
        { cause: error },
      );
    }
  }
}
