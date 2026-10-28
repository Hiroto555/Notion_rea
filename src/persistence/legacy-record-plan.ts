import type { DatabaseSync } from "node:sqlite";
import { normalizeDatabaseData } from "../database/model";
import { isDocument } from "../shared/types";
import { isLosslessDatabaseData } from "../database/strict-database";

export type LegacyRecordIdentity = {
  databasePageId: string;
  legacyRowId: string;
  inCurrent: boolean;
  inHistory: boolean;
};
export type LegacyPlanIssue = {
  pageId: string;
  versionId?: number;
  reason: string;
};
export type LegacyRecordPlan = {
  records: LegacyRecordIdentity[];
  issues: LegacyPlanIssue[];
};

/** Read-only preflight. Unknown bytes are neither normalized nor written.
 * A caller must abort conversion when issues are present and rerun preflight
 * inside the same write transaction before consuming the plan. */
export function inspectLegacyRecords(
  db: DatabaseSync,
  databasePageIds?: readonly string[],
): LegacyRecordPlan {
  const selected =
    databasePageIds === undefined ? undefined : new Set(databasePageIds);
  const records = new Map<string, LegacyRecordIdentity>();
  const issues: LegacyPlanIssue[] = [];
  const addRows = (
    databasePageId: string,
    value: unknown,
    inHistory: boolean,
    versionId?: number,
  ) => {
    if (value === null || value === undefined) return;
    const result = normalizeDatabaseData(value);
    if (!result.ok) {
      issues.push({
        pageId: databasePageId,
        versionId,
        reason: "unsupported or malformed database",
      });
      return;
    }
    // Normalization is intentionally permissive. Conversion must never rely on
    // it when it would drop or repair any field present in the source.
    if (!isLosslessDatabaseData(value)) {
      issues.push({
        pageId: databasePageId,
        versionId,
        reason:
          "database contains data not safely representable by record migration",
      });
      return;
    }
    for (const row of result.data.rows) {
      const key = JSON.stringify([databasePageId, row.id]);
      const entry = records.get(key) ?? {
        databasePageId,
        legacyRowId: row.id,
        inCurrent: false,
        inHistory: false,
      };
      if (inHistory) entry.inHistory = true;
      else entry.inCurrent = true;
      records.set(key, entry);
    }
  };
  const allPages = db
    .prepare("SELECT id,data FROM pages ORDER BY id")
    .all() as {
    id: string;
    data: string;
  }[];
  const pages = selected
    ? allPages.filter((row) => selected.has(row.id))
    : allPages;
  if (selected)
    for (const id of selected) {
      if (!pages.some((row) => row.id === id))
        issues.push({
          pageId: id,
          reason: "選択したデータベースが見つかりません。",
        });
    }
  for (const row of pages) {
    let value: any;
    try {
      value = JSON.parse(row.data);
    } catch {
      issues.push({ pageId: row.id, reason: "malformed page JSON" });
      continue;
    }
    if (
      !value ||
      typeof value !== "object" ||
      value.id !== row.id ||
      (value.schemaVersion !== undefined && value.schemaVersion !== 1) ||
      !isDocument(value.doc)
    ) {
      issues.push({
        pageId: row.id,
        reason: "unsupported or malformed page/document",
      });
      continue;
    }
    if (value.kind !== "page" && value.kind !== "database") {
      issues.push({ pageId: row.id, reason: "unsupported page kind" });
      continue;
    }
    if (value.kind === "database" && value.database == null) {
      issues.push({ pageId: row.id, reason: "database page has no database" });
      continue;
    }
    if (value.kind !== "database" && value.database != null) {
      issues.push({ pageId: row.id, reason: "unexpected database on page" });
      continue;
    }
    addRows(row.id, value.database, false);
  }
  const versions = db
    .prepare("SELECT id,pageId,doc,database FROM versions ORDER BY id")
    .all() as {
    id: number;
    pageId: string;
    doc: string;
    database: string | null;
  }[];
  const pageIds = new Set(pages.map((p) => p.id));
  for (const v of versions) {
    if (selected && !selected.has(v.pageId)) continue;
    if (!pageIds.has(v.pageId)) {
      issues.push({
        pageId: v.pageId,
        versionId: v.id,
        reason: "orphan history",
      });
      continue;
    }
    let doc: unknown, database: unknown;
    try {
      doc = JSON.parse(v.doc);
      database = v.database === null ? null : JSON.parse(v.database);
    } catch {
      issues.push({
        pageId: v.pageId,
        versionId: v.id,
        reason: "malformed history JSON",
      });
      continue;
    }
    if (!isDocument(doc)) {
      issues.push({
        pageId: v.pageId,
        versionId: v.id,
        reason: "unsupported or malformed history document",
      });
      continue;
    }
    addRows(v.pageId, database, true, v.id);
  }
  return { records: [...records.values()], issues };
}
