import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Store } from "./store";
import { canonicalOperation } from "../shared/save-contract";
import {
  legacyMigrationOperationSchema,
  type LegacyMigrationOperation,
  type LegacyMigrationPreview,
  type LegacyMigrationResult,
} from "../shared/legacy-migration-operation";
import { inspectLegacyRecords } from "./legacy-record-plan";
import { convertLegacyRecordsInTransaction } from "./record-migration";
import { createMigrationSnapshot } from "./migration-snapshot";
import { RecordRepository } from "./record-repository";
import { normalizeDatabaseData } from "../database/model";
import type { LegacyMigrationIssue } from "../shared/legacy-migration-operation";

const hash = (value: unknown) =>
  createHash("sha256").update(canonicalOperation(value)).digest("hex");
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const hasTable = (db: DatabaseSync, name: string) =>
  !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
const registered = (db: DatabaseSync, id: string) =>
  hasTable(db, "record_databases") &&
  !!db
    .prepare("SELECT 1 FROM record_databases WHERE database_page_id=?")
    .get(id);
const coherentRead = <T>(store: Store, read: () => T): T =>
  store.db.isTransaction ? read() : store.transaction(read);

function sourceState(store: Store, databasePageId: string) {
  return {
    databasePageId,
    version: store.db.prepare("PRAGMA user_version").get()?.user_version,
    registered: registered(store.db, databasePageId),
    page:
      store.db
        .prepare("SELECT id,data,body FROM pages WHERE id=?")
        .get(databasePageId) ?? null,
    versions: store.db
      .prepare(
        "SELECT id,pageId,createdAt,title,doc,database FROM versions WHERE pageId=? ORDER BY id",
      )
      .all(databasePageId),
  };
}

function valueIssues(
  store: Store,
  databasePageId: string,
): LegacyMigrationIssue[] {
  const issues: LegacyMigrationIssue[] = [];
  const check = (database: unknown, versionId?: number) => {
    if (database == null) return;
    const parsed = normalizeDatabaseData(database);
    if (!parsed.ok) return; // The structural preflight supplies this reason.
    for (const row of parsed.data.rows)
      for (const [key, value] of Object.entries(row.values)) {
        const property = parsed.data.properties.find(
          (candidate) => candidate.id === key,
        );
        if (
          !property ||
          (property.type === "number" &&
            (typeof value !== "number" || !Number.isFinite(value))) ||
          (property.type === "checkbox" && typeof value !== "boolean") ||
          (["text", "date", "select"].includes(property.type) &&
            typeof value !== "string") ||
          (property.type === "select" &&
            value !== "" &&
            !property.options?.includes(String(value)))
        ) {
          issues.push({
            pageId: databasePageId,
            ...(versionId === undefined ? {} : { versionId }),
            reason:
              "プロパティに未対応または型が一致しない値があります。原本を保持しています。",
          });
          return;
        }
      }
  };
  const page = store.db
    .prepare("SELECT data FROM pages WHERE id=?")
    .get(databasePageId);
  try {
    if (page) check(JSON.parse(String(page.data)).database);
  } catch {
    /* Structural preflight reports raw JSON errors. */
  }
  for (const version of store.db
    .prepare(
      "SELECT id,database FROM versions WHERE pageId=? AND database IS NOT NULL ORDER BY id",
    )
    .all(databasePageId))
    try {
      check(JSON.parse(String(version.database)), Number(version.id));
    } catch {
      /* Reported by structural preflight. */
    }
  return issues;
}

/** Reads selected raw bytes and history; no schema installation or conversion. */
export function previewLegacyMigration(
  store: Store,
  databasePageId: string,
): LegacyMigrationPreview {
  if (
    typeof databasePageId !== "string" ||
    !databasePageId ||
    databasePageId.length > 500
  )
    throw new Error("移行対象が不正です。");
  return coherentRead(store, () => {
    const source = sourceState(store, databasePageId);
    const plan = inspectLegacyRecords(store.db, [databasePageId]);
    const issues = [...plan.issues, ...valueIssues(store, databasePageId)];
    let title = databasePageId,
      revision = 0;
    try {
      const page = store.get(databasePageId);
      if (typeof page.title === "string") title = page.title;
      if (Number.isSafeInteger(page.revision)) revision = page.revision;
      if (
        page.kind !== "database" ||
        !page.database ||
        page.documentError ||
        page.deletedAt !== null
      )
        issues.push({
          pageId: databasePageId,
          reason: "移行できる未削除のデータベースではありません。",
        });
      if (
        !Number.isSafeInteger(page.revision) ||
        page.revision < 0 ||
        page.revision >= Number.MAX_SAFE_INTEGER
      )
        issues.push({
          pageId: databasePageId,
          reason: "データベースの revision が不正です。",
        });
    } catch (error) {
      issues.push({ pageId: databasePageId, reason: errorText(error) });
    }
    if (source.registered)
      issues.push({
        pageId: databasePageId,
        reason: "このデータベースは既に行ページ形式です。",
      });
    if (source.version !== 3 && source.version !== 4)
      issues.push({
        pageId: databasePageId,
        reason: "未対応の workspace 形式です。",
      });
    return {
      databasePageId,
      title,
      revision,
      sourceFingerprint: hash(source),
      canApply: !issues.length,
      currentRecords: plan.records.filter((record) => record.inCurrent).length,
      historicalRecords: plan.records.filter(
        (record) => record.inHistory && !record.inCurrent,
      ).length,
      issues,
    };
  });
}

/** Compare logical data, not VACUUM-dependent SQLite file offsets. All raw
 * payload strings, schema definitions and attachment registrations participate. */
function workspaceFingerprint(db: DatabaseSync): string {
  const schema = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
    )
    .all();
  const tables = schema
    .filter((row) => row.type === "table")
    .map((row) => String(row.name));
  const data = tables.map((name) => {
    const escaped = name.replaceAll('"', '""');
    return [
      name,
      db
        .prepare(`SELECT * FROM "${escaped}"`)
        .all()
        .map((row) => canonicalOperation(row))
        .sort(),
    ];
  });
  return hash({
    version: db.prepare("PRAGMA user_version").get(),
    schema,
    data,
  });
}
function assetsFingerprint(path: string): string {
  if (!isAbsolute(path)) throw new Error("添付ファイルの保存先が不正です。");
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("添付フォルダーを安全に確認できません。");
  return hash(
    readdirSync(path)
      .sort()
      .map((name) => {
        const file = join(path, name),
          info = lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink())
          throw new Error("未対応の添付ファイルがあります。");
        const bytes = readFileSync(file);
        return {
          name,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      }),
  );
}
function outcome(
  operation: LegacyMigrationOperation,
  status: LegacyMigrationResult["status"],
  message?: string,
): LegacyMigrationResult {
  return {
    status,
    operationId: operation.operationId,
    sessionId: operation.sessionId,
    seq: operation.seq,
    databasePageId: operation.databasePageId,
    fingerprint: hash(operation),
    ...(message ? { message } : {}),
  };
}
function receipt(
  store: Store,
  operation: LegacyMigrationOperation,
): LegacyMigrationResult | undefined {
  const row = store.db
    .prepare(
      "SELECT fingerprint,result_json FROM save_receipts WHERE operation_id=?",
    )
    .get(operation.operationId) as
    { fingerprint: string; result_json: string } | undefined;
  if (!row) return;
  if (row.fingerprint !== hash(operation))
    return outcome(
      operation,
      "rejected",
      "同じ操作 ID に異なる移行要求があります。原本を保持しています。",
    );
  return JSON.parse(row.result_json) as LegacyMigrationResult;
}
function saveReceipt(
  store: Store,
  operation: LegacyMigrationOperation,
  result: LegacyMigrationResult,
) {
  store.db
    .prepare(
      "INSERT INTO save_receipts(operation_id,fingerprint,result_json) VALUES(?,?,?)",
    )
    .run(operation.operationId, hash(operation), JSON.stringify(result));
  return result;
}
export function resolveLegacyMigration(
  store: Store,
  input: LegacyMigrationOperation,
): LegacyMigrationResult {
  const operation = legacyMigrationOperationSchema.parse(input);
  return (
    receipt(store, operation) ??
    outcome(
      operation,
      "unknown",
      "この移行操作の確定結果が見つかりません。新しい移行を開始せず、保持した操作を確認してください。",
    )
  );
}

export type LegacyMigrationEnvironment = {
  /** Both paths come from main's workspace context, never the renderer. */
  assetsPath: string;
  snapshotRoot: string;
};

/** Explicit-only entrypoint. Main must quiesce all workspace/attachment writes
 * from preview until this returns. Filesystem changes by arbitrary external
 * processes cannot be excluded by SQLite's write lock. Failed snapshots are
 * retained, never reused. Conversion and its applied receipt commit together. */
export function commitLegacyMigration(
  store: Store,
  input: LegacyMigrationOperation,
  environment: LegacyMigrationEnvironment,
): LegacyMigrationResult {
  const operation = legacyMigrationOperationSchema.parse(input);
  const existing = receipt(store, operation);
  if (existing) return existing;
  let snapshotPath: string | undefined;
  try {
    const preview = previewLegacyMigration(store, operation.databasePageId);
    if (
      !preview.canApply ||
      preview.revision !== operation.revision ||
      preview.sourceFingerprint !== operation.sourceFingerprint
    )
      throw new Error(
        "移行プレビューから原本または履歴が変わりました。再確認してください。原本は保持されています。",
      );
    if (!isAbsolute(environment.snapshotRoot))
      throw new Error("移行前コピーの保存先が不正です。");
    mkdirSync(environment.snapshotRoot, { recursive: true });
    const snapshotRoot = realpathSync(environment.snapshotRoot);
    snapshotPath = join(snapshotRoot, `legacy-${randomUUID()}`);
    const sourceDatabase = coherentRead(store, () =>
      workspaceFingerprint(store.db),
    );
    const sourceAssets = assetsFingerprint(environment.assetsPath);
    createMigrationSnapshot(store.db, environment.assetsPath, snapshotPath);
    const copy = new DatabaseSync(join(snapshotPath, "workspace.sqlite"), {
      readOnly: true,
    });
    let copiedDatabase: string;
    try {
      copiedDatabase = workspaceFingerprint(copy);
    } finally {
      copy.close();
    }
    const copiedAssets = assetsFingerprint(join(snapshotPath, "assets"));
    if (sourceDatabase !== copiedDatabase || sourceAssets !== copiedAssets)
      throw new Error(
        "移行前コピーが原本と一致しません。原本を変更せず停止しました。",
      );
    return store.transaction(() => {
      const already = receipt(store, operation);
      if (already) return already;
      const current = previewLegacyMigration(store, operation.databasePageId);
      if (
        !current.canApply ||
        current.revision !== operation.revision ||
        current.sourceFingerprint !== operation.sourceFingerprint ||
        workspaceFingerprint(store.db) !== copiedDatabase ||
        assetsFingerprint(environment.assetsPath) !== copiedAssets
      )
        throw new Error(
          "コピーの検証後に原本が変わりました。原本を変更せず停止しました。",
        );
      const converted = convertLegacyRecordsInTransaction(store, undefined, [
        operation.databasePageId,
      ]);
      if (
        converted.databases !== 1 ||
        converted.records !== preview.currentRecords
      )
        throw new Error("移行件数がプレビューと一致しません。");
      const page = store.get(operation.databasePageId),
        database = new RecordRepository(store).databaseProjection(page.id);
      if (page.revision !== operation.revision + 1)
        throw new Error("移行後の revision が一致しません。");
      return saveReceipt(store, operation, {
        ...outcome(operation, "applied"),
        page,
        database,
        snapshotPath,
        records: converted.records,
      });
    });
  } catch (error) {
    // A COMMIT exception may be ambiguous. A durable receipt wins; only a
    // usable, rolled-back connection may record a rejected operation.
    try {
      const found = receipt(store, operation);
      if (found) return found;
      return store.transaction(() => {
        const found = receipt(store, operation);
        return (
          found ??
          saveReceipt(store, operation, {
            ...outcome(operation, "rejected", errorText(error)),
            ...(snapshotPath ? { snapshotPath } : {}),
          })
        );
      });
    } catch {
      return outcome(
        operation,
        "unknown",
        "移行結果を確認できません。保持した操作 ID で結果を照会してください。",
      );
    }
  }
}
