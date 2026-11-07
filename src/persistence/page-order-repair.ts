import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDocument, type Page } from "../shared/types";
import type {
  PageOrderRepairBackup,
  PageOrderRepairGroup,
  PageOrderRepairOptions,
  PageOrderRepairPlan,
  PageOrderRepairPreview,
  PageOrderRepairRejection,
  PageOrderRepairResult,
  PageOrderRepairTarget,
} from "../shared/page-order-repair";
import type { VerifiedWorkspaceBackup } from "../shared/workspace-backup";
import { createFullBackup } from "./full-backup-create";
import { verifyFullBackup } from "./full-backup-verify";
import type { Store } from "./store";

/**
 * Explicit repair for equal positions written by older duplicate versions.
 *
 * This module is deliberately self-contained: it never runs from startup, a
 * migration, or an implicit save path. A caller must first obtain a read-only
 * preview and then apply that exact preview by fingerprint. apply() creates a
 * verified full backup with the existing workspace-backup implementation before
 * a single Page is rewritten, re-checks the raw state under the write
 * transaction, and rolls every Page back together on any failure.
 *
 * Invariants kept by apply():
 * - only `position`, `revision` and `updatedAt` change, and only on ordinary
 *   Pages that need a new position; title/doc/database/icon/metadata keep their
 *   values byte-for-byte in JSON terms;
 * - parent/ownership, record pages, registered databases, record rows,
 *   versions, save receipts, settings and assets are never modified;
 * - trashed sibling positions are reserved (so restore cannot create a tie);
 * - pages unrelated to a tie keep their exact raw bytes and revision.
 *
 * A preview is all-or-nothing: if any tie is rejected for any reason, apply()
 * refuses the whole preview rather than silently repairing a subset. Record
 * Pages are outside the ordinary sibling ordering namespace, exactly as in
 * Store.create/move/duplicate; they are never rewritten and their membership
 * rows are included in the raw-state fingerprint and the protected-state check.
 */

const FINGERPRINT_DOMAIN = "folio-page-order-repair-v1";
const MAX_ID_LENGTH = 500;
const ALLOWED_PAGE_KEYS = new Set([
  "id",
  "schemaVersion",
  "parentId",
  "title",
  "icon",
  "cover",
  "position",
  "doc",
  "kind",
  "database",
  "favorite",
  "width",
  "createdAt",
  "updatedAt",
  "revision",
  "deletedAt",
  "recoveredFrom",
]);
/** Read-only fingerprints for the tables this service must never change. */
const PROTECTED_TABLES: ReadonlyArray<readonly [string, string]> = [
  ["record_databases", "database_page_id"],
  ["record_memberships", "page_id"],
  ["versions", "id"],
  ["save_receipts", "operation_id"],
  ["settings", "key"],
  ["assets", "id"],
];

type RawRow = { id: string; data: string; body: string };
type ParsedPage = { row: RawRow; value: Record<string, any> };
type Scan = {
  fingerprint: string;
  pages: Map<string, ParsedPage>;
  recordIds: Set<string>;
  registeredDatabases: Set<string>;
  issues: string[];
};
type StateRows = { rows: Map<string, RawRow>; protectedState: string };
type Allocation =
  | { ok: true; values: number[] }
  | { ok: false; reason: string };

const failure = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function storeVersion(db: DatabaseSync): number {
  return (
    db.prepare("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
}

/** Stable JSON with sorted keys, used only for equality checks and hashing. */
function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Unsupported non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalValue(item)).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("Unsupported value");
}

/** Raw bytes of every Page plus the record rows preview/apply planned against. */
function rawStateFingerprint(db: DatabaseSync): string {
  const hash = createHash("sha256");
  hash.update(`${FINGERPRINT_DOMAIN}\n`);
  hash.update(`user_version:${storeVersion(db)}\n`);
  const pages = db
    .prepare("SELECT id,data,body FROM pages ORDER BY id")
    .all() as RawRow[];
  hash.update(`pages:${pages.length}\n`);
  for (const row of pages)
    hash.update(`P${JSON.stringify([row.id, row.data, row.body])}\n`);
  for (const [table, order] of [
    ["record_databases", "database_page_id"],
    ["record_memberships", "page_id"],
  ] as const) {
    const exists = tableExists(db, table);
    hash.update(`${table}:${exists ? 1 : 0}\n`);
    if (!exists) continue;
    for (const row of db
      .prepare(`SELECT * FROM ${table} ORDER BY ${order}`)
      .all())
      hash.update(`R${canonicalValue(row)}\n`);
  }
  return hash.digest("hex");
}

function protectedState(db: DatabaseSync): string {
  const parts: unknown[] = [["user_version", storeVersion(db)]];
  for (const [table, order] of PROTECTED_TABLES) {
    if (!tableExists(db, table)) {
      parts.push([table, null]);
      continue;
    }
    parts.push([
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all(),
    ]);
  }
  return canonicalValue(parts);
}

/**
 * Parse every raw Page without decoding it into the writable model. Ordering
 * safety cannot be proven from an unknown or unreadable original, so such a
 * row becomes a workspace-wide blocker instead of being silently skipped.
 */
function scanWorkspace(db: DatabaseSync): Scan {
  const issues: string[] = [];
  const pages = new Map<string, ParsedPage>();
  const rows = db
    .prepare("SELECT id,data,body FROM pages ORDER BY id")
    .all() as RawRow[];
  for (const row of rows) {
    if (typeof row.id !== "string" || row.id.length === 0) {
      issues.push("ページIDが空の保存行があります。");
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(row.data);
    } catch {
      issues.push(`ページ ${row.id} の原本JSONを読めません。`);
      continue;
    }
    if (!isPlainObject(value)) {
      issues.push(`ページ ${row.id} の原本がオブジェクトではありません。`);
      continue;
    }
    if (value.id !== row.id) {
      issues.push(`ページ ${row.id} のIDが保存行と一致しません。`);
      continue;
    }
    if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
      issues.push(`ページ ${row.id} は未知のschemaVersionです。`);
      continue;
    }
    if (
      !(
        value.parentId === null ||
        (typeof value.parentId === "string" && value.parentId.length > 0)
      )
    ) {
      issues.push(`ページ ${row.id} の親IDを確認できません。`);
      continue;
    }
    if (typeof value.position !== "number" || !Number.isFinite(value.position)) {
      issues.push(`ページ ${row.id} の位置が有限の数値ではありません。`);
      continue;
    }
    if (value.kind !== "page" && value.kind !== "database") {
      issues.push(`ページ ${row.id} の種類を確認できません。`);
      continue;
    }
    pages.set(row.id, { row, value });
  }

  for (const [id, page] of pages) {
    const parentId = page.value.parentId as string | null;
    if (parentId !== null && !pages.has(parentId))
      issues.push(`ページ ${id} の親ページ ${parentId} が見つかりません。`);
  }

  // Detect cycles without recursion so a corrupt hierarchy cannot exhaust the
  // JavaScript stack.
  const marks = new Map<string, 1 | 2>();
  let cycle = false;
  for (const id of pages.keys()) {
    let current: string | null = id;
    const trail: string[] = [];
    while (current !== null) {
      if (marks.get(current) === 1) {
        cycle = true;
        break;
      }
      if (marks.get(current) === 2) break;
      marks.set(current, 1);
      trail.push(current);
      const page = pages.get(current);
      if (!page) break;
      current = page.value.parentId as string | null;
    }
    for (const item of trail) marks.set(item, 2);
  }
  if (cycle) issues.push("ページ階層が循環しています。");

  const recordIds = new Set<string>();
  const registeredDatabases = new Set<string>();
  const hasDatabases = tableExists(db, "record_databases");
  const hasMemberships = tableExists(db, "record_memberships");
  if (hasDatabases !== hasMemberships)
    issues.push("レコード管理テーブルが不完全です。");
  if (hasDatabases) {
    const owners = db
      .prepare("SELECT database_page_id FROM record_databases ORDER BY database_page_id")
      .all() as { database_page_id: unknown }[];
    for (const row of owners) {
      const id = row.database_page_id;
      if (typeof id !== "string" || id.length === 0) {
        issues.push("登録データベースのIDを読めません。");
        continue;
      }
      const owner = pages.get(id);
      if (!owner) {
        issues.push(`登録データベース ${id} のページが見つかりません。`);
        continue;
      }
      if (owner.value.kind !== "database") {
        issues.push(`登録データベース ${id} がデータベースページではありません。`);
        continue;
      }
      registeredDatabases.add(id);
    }
  }
  if (hasMemberships) {
    const members = db
      .prepare(
        "SELECT page_id,database_page_id,position,values_json FROM record_memberships ORDER BY page_id",
      )
      .all() as {
      page_id: unknown;
      database_page_id: unknown;
      position: unknown;
      values_json: unknown;
    }[];
    for (const row of members) {
      const pageId = row.page_id;
      const databasePageId = row.database_page_id;
      if (
        typeof pageId !== "string" ||
        typeof databasePageId !== "string" ||
        !pages.has(pageId) ||
        !registeredDatabases.has(databasePageId) ||
        !Number.isSafeInteger(row.position) ||
        (row.position as number) < 0
      ) {
        issues.push("レコードの所属または位置を確認できません。");
        continue;
      }
      const page = pages.get(pageId)!;
      if (page.value.kind !== "page" || page.value.database !== null) {
        issues.push(`レコード ${pageId} のページ構成が不正です。`);
        continue;
      }
      let values: unknown;
      try {
        values = JSON.parse(row.values_json as string);
      } catch {
        issues.push(`レコード ${pageId} の値を読めません。`);
        continue;
      }
      if (!isPlainObject(values)) {
        issues.push(`レコード ${pageId} の値がオブジェクトではありません。`);
        continue;
      }
      recordIds.add(pageId);
    }
  }

  return {
    fingerprint: rawStateFingerprint(db),
    pages,
    recordIds,
    registeredDatabases,
    issues: [...new Set(issues)],
  };
}

function hasUnsupportedNumber(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length) {
    const item = stack.pop();
    if (
      typeof item === "number" &&
      (!Number.isFinite(item) ||
        (Number.isInteger(item) && !Number.isSafeInteger(item)))
    )
      return true;
    if (item && typeof item === "object")
      stack.push(...Object.values(item as Record<string, unknown>));
  }
  return false;
}

const validTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Structural gate for a Page this service may rewrite. Anything the current
 * writer would normalize, drop, or misunderstand is refused instead of being
 * rewritten with a different shape.
 */
function targetProblem(page: ParsedPage): string | undefined {
  const value = page.value;
  if (Object.keys(value).some((key) => !ALLOWED_PAGE_KEYS.has(key)))
    return "未対応の項目が含まれています。";
  if (JSON.stringify(value) !== page.row.data)
    return "原本のバイト表現をそのまま再現できません。";
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > MAX_ID_LENGTH
  )
    return "IDを確認できません。";
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1)
    return "未知のschemaVersionです。";
  if (
    !(
      value.parentId === null ||
      (typeof value.parentId === "string" &&
        value.parentId.length > 0 &&
        value.parentId.length <= MAX_ID_LENGTH)
    )
  )
    return "親IDを確認できません。";
  if (typeof value.title !== "string" || value.title.length > 500)
    return "タイトルを確認できません。";
  if (typeof value.icon !== "string" || value.icon.length > 16)
    return "アイコンを確認できません。";
  if (typeof value.cover !== "string" || value.cover.length > 500)
    return "カバーを確認できません。";
  if (typeof value.position !== "number" || !Number.isFinite(value.position))
    return "位置を確認できません。";
  if (!isDocument(value.doc)) return "文書を確認できません。";
  if (value.kind !== "page") return "通常ページではありません。";
  if (!Object.hasOwn(value, "database") || value.database !== null)
    return "データベースを保持するページです。";
  if (typeof value.favorite !== "boolean") return "お気に入りを確認できません。";
  if (
    value.width !== undefined &&
    value.width !== "standard" &&
    value.width !== "wide"
  )
    return "幅を確認できません。";
  if (!validTime(value.createdAt)) return "作成時刻を確認できません。";
  if (!validTime(value.updatedAt)) return "更新時刻を確認できません。";
  const revision = value.revision;
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    revision >= Number.MAX_SAFE_INTEGER
  )
    return "revisionを確認できません。";
  if (!(value.deletedAt === null || validTime(value.deletedAt)))
    return "削除時刻を確認できません。";
  const recovered = value.recoveredFrom;
  if (recovered !== undefined) {
    if (
      !isPlainObject(recovered) ||
      Object.keys(recovered).some(
        (key) => key !== "pageId" && key !== "recoveredAt",
      ) ||
      typeof recovered.pageId !== "string" ||
      recovered.pageId.length === 0 ||
      recovered.pageId.length > MAX_ID_LENGTH ||
      !validTime(recovered.recoveredAt)
    )
      return "復旧情報を確認できません。";
  }
  if (hasUnsupportedNumber(value))
    return "有限でない数値または安全でない整数が含まれています。";
  return undefined;
}

function compareParent(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left < right ? -1 : 1;
}

/** Deterministic tie order: oldest first, then by stable page id. */
function compareTieMembers(left: ParsedPage, right: ParsedPage): number {
  const created = (left.value.createdAt as number) - (right.value.createdAt as number);
  if (created !== 0) return created;
  return left.row.id < right.row.id ? -1 : left.row.id > right.row.id ? 1 : 0;
}

/**
 * A position is safe only when it survives JSON exactly as itself and is not an
 * integer that JavaScript cannot represent. This rejects both non-finite values
 * and the 2^53 boundary where create() could no longer add a position.
 */
function safePosition(value: number): boolean {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (Object.is(value, -0)) return false;
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) return false;
  try {
    return Object.is(JSON.parse(JSON.stringify(value)), value);
  } catch {
    return false;
  }
}

/** Smallest representable double greater than `value` (IEEE-754 bit walk). */
function nextUp(value: number): number {
  if (Number.isNaN(value) || value === Infinity) return value;
  if (value === 0) return Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  let bits = view.getBigUint64(0, false);
  bits = value > 0 ? bits + 1n : bits - 1n;
  view.setBigUint64(0, bits, false);
  return view.getFloat64(0, false);
}

/**
 * Pick `count` distinct positions after `lower` and, when present, before the
 * next sibling `upper`. Evenly spaced midpoints keep room for later inserts;
 * adjacent doubles fall back to the next representable value. If neither fits,
 * the tie is refused rather than squeezed into an unsafe number.
 */
function allocateSlots(
  lower: number,
  upper: number | undefined,
  count: number,
): Allocation {
  if (count <= 0) return { ok: true, values: [] };
  if (!safePosition(lower))
    return {
      ok: false,
      reason: "同順位の位置が安全な数値ではないため修復しません。",
    };
  const attempts: number[][] = [];
  if (upper === undefined) {
    attempts.push(
      Array.from({ length: count }, (_, index) => lower + index + 1),
    );
  } else {
    const span = upper - lower;
    if (Number.isFinite(span) && span > 0)
      attempts.push(
        Array.from(
          { length: count },
          (_, index) => lower + (span * (index + 1)) / (count + 1),
        ),
      );
  }
  const chain: number[] = [];
  let cursor = lower;
  for (let index = 0; index < count; index++) {
    cursor = nextUp(cursor);
    chain.push(cursor);
  }
  attempts.push(chain);
  for (const candidate of attempts) {
    if (
      candidate.every((value) => safePosition(value)) &&
      candidate.every(
        (value, index) =>
          value > lower &&
          (upper === undefined || value < upper) &&
          (index === 0 || value > candidate[index - 1]),
      )
    )
      return { ok: true, values: candidate };
  }
  return {
    ok: false,
    reason:
      upper === undefined
        ? "並び順の末尾に安全な位置の空きがないため修復しません。"
        : "同順位と次の位置の間に安全な空きがないため修復しません。",
  };
}

function evaluateTie(
  scan: Scan,
  parentId: string | null,
  position: number,
  upper: number | undefined,
  members: ParsedPage[],
  groups: PageOrderRepairGroup[],
  rejections: PageOrderRepairRejection[],
): void {
  const reasons: string[] = [];
  for (const member of members) {
    if (
      member.value.kind === "database" ||
      scan.registeredDatabases.has(member.row.id)
    ) {
      reasons.push(
        `ページ ${member.row.id} はデータベースのため並び順を変更しません。`,
      );
      continue;
    }
    if (member.value.database !== null) {
      reasons.push(
        `ページ ${member.row.id} はデータベースデータを保持するため並び順を変更しません。`,
      );
      continue;
    }
    const problem = targetProblem(member);
    if (problem) reasons.push(`ページ ${member.row.id}: ${problem}`);
  }
  if (reasons.length) {
    rejections.push({
      parentId,
      position,
      pageIds: members.map((member) => member.row.id),
      reasons,
    });
    return;
  }
  const ordered = members.slice().sort(compareTieMembers);
  const allocation = allocateSlots(position, upper, ordered.length - 1);
  if (!allocation.ok) {
    rejections.push({
      parentId,
      position,
      pageIds: members.map((member) => member.row.id),
      reasons: [allocation.reason],
    });
    return;
  }
  const targets: PageOrderRepairTarget[] = ordered.map((member, index) => {
    const changed = index > 0;
    const revision = member.value.revision as number;
    return {
      pageId: member.row.id,
      title: member.value.title as string,
      parentId,
      deleted: member.value.deletedAt !== null,
      fromPosition: position,
      toPosition: changed ? allocation.values[index - 1] : position,
      fromRevision: revision,
      toRevision: changed ? revision + 1 : revision,
      changed,
    };
  });
  groups.push({ parentId, position, targets });
}

function buildRepairPreview(db: DatabaseSync): PageOrderRepairPreview {
  const scan = scanWorkspace(db);
  if (scan.issues.length)
    return {
      sourceFingerprint: scan.fingerprint,
      groups: [],
      rejections: [],
      issues: scan.issues,
      targetIds: [],
      canApply: false,
      scannedPages: scan.pages.size,
    };

  // Record Pages are hidden from the tree and their `position` describes the
  // record order inside their database, not the sibling order. Exclude them from
  // detection and allocation exactly like Store.create/move/duplicate do; their
  // Page bytes and membership rows remain protected by the fingerprint.
  const universe = [...scan.pages.values()].filter(
    (page) => !scan.recordIds.has(page.row.id),
  );
  const byParent = new Map<string | null, ParsedPage[]>();
  for (const page of universe) {
    const parentId = page.value.parentId as string | null;
    const siblings = byParent.get(parentId);
    if (siblings) siblings.push(page);
    else byParent.set(parentId, [page]);
  }
  const groups: PageOrderRepairGroup[] = [];
  const rejections: PageOrderRepairRejection[] = [];
  for (const parentId of [...byParent.keys()].sort(compareParent)) {
    const siblings = byParent
      .get(parentId)!
      .slice()
      .sort(
        (left, right) =>
          left.value.position - right.value.position ||
          (left.row.id < right.row.id
            ? -1
            : left.row.id > right.row.id
              ? 1
              : 0),
      );
    let index = 0;
    while (index < siblings.length) {
      let end = index + 1;
      while (
        end < siblings.length &&
        siblings[end].value.position === siblings[index].value.position
      )
        end++;
      if (end - index > 1) {
        const members = siblings.slice(index, end);
        evaluateTie(
          scan,
          parentId,
          members[0].value.position as number,
          end < siblings.length
            ? (siblings[end].value.position as number)
            : undefined,
          members,
          groups,
          rejections,
        );
      }
      index = end;
    }
  }
  const targetIds = groups.flatMap((group) =>
    group.targets
      .filter((target) => target.changed)
      .map((target) => target.pageId),
  );
  return {
    sourceFingerprint: scan.fingerprint,
    groups,
    rejections,
    issues: [],
    targetIds,
    canApply: groups.length > 0 && rejections.length === 0,
    scannedPages: scan.pages.size,
  };
}

/**
 * Read-only preview over one SQLite snapshot, including read-only startup.
 */
export function previewPageOrderRepair(
  store: Store,
): PageOrderRepairPreview {
  if (store.db.isTransaction)
    throw new Error("未確定のトランザクションでは並び順を確認できません。");
  return store.readSnapshot(() => {
    let schemaIssue: string | undefined;
    try {
      store.assertRecordWriteSchema();
    } catch (error) {
      schemaIssue = failure(error);
    }
    const preview = buildRepairPreview(store.db);
    if (!schemaIssue) return preview;
    return {
      ...preview,
      groups: [],
      rejections: [],
      issues: [schemaIssue, ...preview.issues],
      targetIds: [],
      canApply: false,
    };
  });
}

function applyReasons(preview: PageOrderRepairPreview): string[] {
  const reasons: string[] = [...preview.issues];
  for (const rejection of preview.rejections) {
    for (const reason of rejection.reasons)
      reasons.push(
        `並び順 ${String(rejection.position)} の同順位: ${reason}`,
      );
  }
  if (!reasons.length && preview.groups.length === 0)
    reasons.push("修復できる同順位の通常ページがありません。");
  return [...new Set(reasons)];
}

function rejectedResult(
  sourceFingerprint: string,
  issues: string[],
  options: {
    currentFingerprint?: string;
    backup?: PageOrderRepairBackup;
  } = {},
): PageOrderRepairResult {
  return {
    status: "rejected",
    sourceFingerprint,
    currentFingerprint: options.currentFingerprint ?? sourceFingerprint,
    appliedGroups: 0,
    appliedPages: 0,
    targets: [],
    issues,
    ...(options.backup ? { backup: options.backup } : {}),
  };
}

function changedTargets(
  preview: PageOrderRepairPreview,
): PageOrderRepairTarget[] {
  return preview.groups.flatMap((group) =>
    group.targets.filter((target) => target.changed),
  );
}

function readStateRows(db: DatabaseSync): StateRows {
  const rows = new Map<string, RawRow>();
  for (const row of db
    .prepare("SELECT id,data,body FROM pages ORDER BY id")
    .all() as RawRow[])
    rows.set(row.id, row);
  return { rows, protectedState: protectedState(db) };
}

/**
 * Re-read the whole workspace after the writes and prove that exactly the
 * planned fields changed, that unrelated Page bytes stayed identical, that no
 * protected table changed, and that no sibling group still shares a position.
 */
function verifyRepair(
  db: DatabaseSync,
  before: StateRows,
  targets: PageOrderRepairTarget[],
  now: number,
): void {
  const after = readStateRows(db);
  if (after.rows.size !== before.rows.size)
    throw new Error("修復前後でページ数が変化しました。");
  const targetById = new Map(targets.map((target) => [target.pageId, target]));
  const beforeValues = new Map<string, Record<string, any>>();
  for (const pageId of targetById.keys()) {
    const row = before.rows.get(pageId);
    if (!row) throw new Error(`修復対象 ${pageId} の原本が見つかりません。`);
    beforeValues.set(pageId, JSON.parse(row.data));
  }
  for (const [id, row] of before.rows) {
    const next = after.rows.get(id);
    if (!next) throw new Error(`ページ ${id} が失われました。`);
    const target = targetById.get(id);
    if (!target) {
      if (next.data !== row.data || next.body !== row.body)
        throw new Error(`対象外のページ ${id} が変更されました。`);
      continue;
    }
    const expected = {
      ...beforeValues.get(id)!,
      position: target.toPosition,
      revision: target.fromRevision + 1,
      updatedAt: now,
    };
    if (canonicalValue(JSON.parse(next.data)) !== canonicalValue(expected))
      throw new Error(`修復対象 ${id} の内容が計画と一致しません。`);
    if (next.body !== row.body)
      throw new Error(`修復対象 ${id} の本文が変化しました。`);
  }
  if (after.protectedState !== before.protectedState)
    throw new Error(
      "レコード・履歴・receipt・設定・添付など保護対象が変化しました。",
    );

  const recordIds = new Set<string>();
  if (tableExists(db, "record_memberships"))
    for (const row of db
      .prepare("SELECT page_id FROM record_memberships")
      .all() as { page_id: string }[])
      recordIds.add(row.page_id);
  const byParent = new Map<string | null, number[]>();
  for (const [id, row] of after.rows) {
    if (recordIds.has(id)) continue;
    let value: unknown;
    try {
      value = JSON.parse(row.data);
    } catch {
      throw new Error(`修復後のページ ${id} の原本を確認できません。`);
    }
    if (
      !isPlainObject(value) ||
      typeof value.position !== "number" ||
      !Number.isFinite(value.position)
    )
      throw new Error(`修復後のページ ${id} の位置を確認できません。`);
    const parentId = value.parentId as string | null;
    const positions = byParent.get(parentId);
    if (positions) positions.push(value.position);
    else byParent.set(parentId, [value.position]);
  }
  for (const positions of byParent.values()) {
    const sorted = [...positions].sort((left, right) => left - right);
    for (let index = 1; index < sorted.length; index++)
      if (sorted[index - 1] >= sorted[index])
        throw new Error("修復後も同じ位置の通常ページが残っています。");
  }
}

/**
 * Apply a preview by its opaque fingerprint. The plan carries no positions, so
 * a tampered preview cannot move a Page somewhere the preview did not show.
 *
 * Order of operations:
 * 1. preview the current raw state (no write) and require the same fingerprint;
 * 2. create and verify a complete pre-change backup with the existing
 *    createFullBackup implementation (failure stops before any Page write);
 * 3. inside one write transaction, re-check the fingerprint and re-verify the
 *    backup, then rewrite only the changed Pages inside a savepoint;
 * 4. verify the whole Page set and every protected table, or roll everything
 *    back and report rejection.
 */
export function applyPageOrderRepair(
  store: Store,
  plan: PageOrderRepairPlan,
  options: PageOrderRepairOptions = {},
): PageOrderRepairResult {
  const sourceFingerprint = plan?.sourceFingerprint;
  if (
    typeof sourceFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(sourceFingerprint)
  )
    throw new Error("修復プランのfingerprintが不正です。");
  if (store.db.isTransaction)
    throw new Error("未確定のトランザクションでは並び順を修復できません。");

  let preview: PageOrderRepairPreview;
  try {
    preview = previewPageOrderRepair(store);
  } catch (error) {
    return rejectedResult(sourceFingerprint, [
      `並び順を確認できないため修復しません: ${failure(error)}`,
    ]);
  }
  if (preview.sourceFingerprint !== sourceFingerprint)
    return rejectedResult(
      sourceFingerprint,
      ["プレビュー後に原本が変わりました。変更せず、もう一度プレビューしてください。"],
      { currentFingerprint: preview.sourceFingerprint },
    );
  if (!preview.canApply)
    return rejectedResult(sourceFingerprint, applyReasons(preview), {
      currentFingerprint: preview.sourceFingerprint,
    });

  const workspace = dirname(store.path);
  let verifiedBackup: VerifiedWorkspaceBackup;
  try {
    options.beforeBackup?.();
    const root = options.backupDirectory ?? join(workspace, "backups");
    if (typeof root !== "string" || root.length === 0)
      throw new Error("バックアップ先が不正です。");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    verifiedBackup = createFullBackup(
      store.db,
      workspace,
      join(root, `page-order-repair-${Date.now()}-${randomUUID()}`),
    );
  } catch (error) {
    return rejectedResult(
      sourceFingerprint,
      [
        `変更前の完全バックアップを作成できないため適用しません: ${failure(error)}`,
      ],
      { currentFingerprint: preview.sourceFingerprint },
    );
  }
  const backup: PageOrderRepairBackup = {
    directory: verifiedBackup.directory,
    fingerprint: verifiedBackup.fingerprint,
    inventory: verifiedBackup.manifest.inventory,
  };

  return store.transaction(() => {
    let current: PageOrderRepairPreview;
    try {
      store.assertRecordWriteSchema();
      current = buildRepairPreview(store.db);
    } catch (error) {
      return rejectedResult(
        sourceFingerprint,
        [`修復直前に原本を確認できないため変更しません: ${failure(error)}`],
        { currentFingerprint: preview.sourceFingerprint, backup },
      );
    }
    if (current.sourceFingerprint !== sourceFingerprint)
      return rejectedResult(
        sourceFingerprint,
        ["プレビュー後に原本が変わりました。変更していません。"],
        { currentFingerprint: current.sourceFingerprint, backup },
      );
    if (!current.canApply)
      return rejectedResult(sourceFingerprint, applyReasons(current), {
        currentFingerprint: current.sourceFingerprint,
        backup,
      });
    try {
      const verified = verifyFullBackup(backup.directory);
      if (verified.fingerprint !== backup.fingerprint)
        throw new Error("変更前バックアップが変更されています。");
    } catch (error) {
      return rejectedResult(
        sourceFingerprint,
        [
          `変更前の完全バックアップを再検証できないため変更しません: ${failure(error)}`,
        ],
        { currentFingerprint: current.sourceFingerprint, backup },
      );
    }

    const targets = changedTargets(current);
    const before = readStateRows(store.db);
    const now = Date.now();
    store.db.exec("SAVEPOINT page_order_repair");
    try {
      for (const target of targets) {
        const row = before.rows.get(target.pageId);
        if (!row)
          throw new Error(
            `修復対象 ${target.pageId} の原本が見つかりません。`,
          );
        const page = JSON.parse(row.data) as Page;
        const written = store.write({
          ...page,
          position: target.toPosition,
          revision: page.revision + 1,
          updatedAt: now,
        });
        if (
          written.position !== target.toPosition ||
          written.revision !== page.revision + 1
        )
          throw new Error(
            `修復後のページ ${target.pageId} が計画と一致しません。`,
          );
      }
      verifyRepair(store.db, before, targets, now);
      store.db.exec("RELEASE SAVEPOINT page_order_repair");
    } catch (error) {
      store.db.exec("ROLLBACK TO SAVEPOINT page_order_repair");
      store.db.exec("RELEASE SAVEPOINT page_order_repair");
      return rejectedResult(
        sourceFingerprint,
        [`並び順を適用できなかったため変更を戻しました: ${failure(error)}`],
        { currentFingerprint: current.sourceFingerprint, backup },
      );
    }
    return {
      status: "applied",
      sourceFingerprint,
      currentFingerprint: current.sourceFingerprint,
      appliedGroups: current.groups.length,
      appliedPages: targets.length,
      targets,
      backup,
      issues: [],
    };
  });
}
