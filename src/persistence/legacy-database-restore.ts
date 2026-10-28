import { blankDoc, isDocument, type Page } from "../shared/types";
import { normalizeDatabaseData } from "../database/model";
import { inspectLegacyRecords } from "./legacy-record-plan";
import { RecordRepository } from "./record-repository";
import type { Store } from "./store";

/** Restore old database snapshots without replacing record documents.
 * Newer records not represented by a legacy mapping are never removed. */
export function restoreDatabaseVersion(
  store: Store,
  id: string,
  versionId: number,
  expectedRevision: number | undefined,
): Page {
  return store.transaction(() => {
    const page = store.get(id);
    if (expectedRevision === undefined || page.revision !== expectedRevision)
      throw new Error("保存の競合を検出しました。");
    if (
      page.kind !== "database" ||
      !page.database ||
      page.deletedAt ||
      page.documentError
    )
      throw new Error("データベースを復元できません。");
    const raw = store.db
      .prepare(
        "SELECT title,doc,database FROM versions WHERE id=? AND pageId=?",
      )
      .get(versionId, id) as
      { title: string; doc: string; database: string | null } | undefined;
    if (!raw || raw.database === null)
      throw new Error("完全な履歴がありません。");
    let doc: unknown, snapshot: unknown;
    try {
      doc = JSON.parse(raw.doc);
      snapshot = JSON.parse(raw.database);
    } catch {
      throw new Error("履歴を読めません。原本は保持されています。");
    }
    const normalized = normalizeDatabaseData(snapshot);
    if (
      !isDocument(doc) ||
      !normalized.ok ||
      typeof raw.title !== "string" ||
      raw.title.length > 500 ||
      inspectLegacyRecords(store.db).issues.length
    )
      throw new Error("未対応の履歴です。原本は保持されています。");
    const legacy = !!store.db
      .prepare(
        "SELECT 1 FROM legacy_database_versions WHERE version_id=? AND database_page_id=?",
      )
      .get(versionId, id);
    if (legacy) {
      const repo = new RecordRepository(store);
      const keep = new Set(normalized.data.rows.map((r) => r.id));
      const mapped = store.db
        .prepare(
          "SELECT legacy_row_id,page_id FROM legacy_record_map WHERE database_page_id=?",
        )
        .all(id) as { legacy_row_id: string; page_id: string }[];
      const map = new Map(mapped.map((x) => [x.legacy_row_id, x.page_id]));
      for (const [position, row] of normalized.data.rows.entries()) {
        const pageId = map.get(row.id);
        if (!pageId) throw new Error("旧レコードの対応がありません。");
        const member = store.db
          .prepare(
            "SELECT database_page_id FROM record_memberships WHERE page_id=?",
          )
          .get(pageId) as { database_page_id: string } | undefined;
        const source = store.db
          .prepare("SELECT 1 FROM pages WHERE id=?")
          .get(pageId);
        if (!member && source)
          throw new Error("旧レコード ID が他のページと衝突しています。");
        if (member && (member.database_page_id !== id || !source))
          throw new Error("レコードの所属が不正です。");
        if (!member) {
          const now = Date.now();
          store.write(
            {
              id: pageId,
              schemaVersion: 1,
              parentId: null,
              title: row.title,
              icon: "📄",
              cover: "",
              position: position,
              doc: blankDoc(),
              kind: "page",
              database: null,
              favorite: false,
              createdAt: now,
              updatedAt: now,
              revision: 0,
              deletedAt: null,
            },
            true,
          );
          repo.attachForMigration(pageId, id, position, row.values);
        } else {
          const record = store.get(pageId);
          if (record.documentError || record.kind !== "page")
            throw new Error("レコード原本を保護しています。");
          store.recordVersion(record);
          store.db
            .prepare(
              "UPDATE record_memberships SET values_json=?,position=? WHERE page_id=?",
            )
            .run(JSON.stringify(row.values), position, pageId);
          store.write({
            ...record,
            title: row.title,
            deletedAt: null,
            revision: record.revision + 1,
            updatedAt: Date.now(),
          });
        }
      }
      for (const item of mapped) {
        if (keep.has(item.legacy_row_id)) continue;
        const member = store.db
          .prepare(
            "SELECT database_page_id FROM record_memberships WHERE page_id=?",
          )
          .get(item.page_id) as { database_page_id: string } | undefined;
        if (!member) continue;
        if (member.database_page_id !== id)
          throw new Error("レコードの所属が不正です。");
        const record = store.get(item.page_id);
        if (!record.deletedAt) {
          if (store.pages().some((child) => child.parentId === record.id))
            throw new Error("子ページのあるレコードは履歴から削除できません。");
          store.recordVersion(record);
          store.write({
            ...record,
            deletedAt: Date.now(),
            revision: record.revision + 1,
          });
        }
      }
    }
    store.recordVersion(page);
    return store.write({
      ...page,
      title: raw.title,
      doc,
      database: { ...normalized.data, rows: [] },
      revision: page.revision + 1,
      updatedAt: Date.now(),
    });
  });
}
