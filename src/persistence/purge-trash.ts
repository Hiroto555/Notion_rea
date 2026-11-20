import type { Store } from "./store";

export function purgeTrash(store: Store, id?: string, expected?: {id: string; revision: number}[]): string[] {
  return store.transaction(() => {
    store.assertRecordWriteSchema();
    const pages = store.pages(), byId = new Map(pages.map(page => [page.id, page]));
    const trash = pages.filter(page => page.deletedAt !== null);
    if (expected) {
      const revisions = new Map(expected.map(item => [item.id, item.revision]));
      if (revisions.size !== trash.length || trash.some(page => revisions.get(page.id) !== page.revision))
        throw new Error("確認後にゴミ箱の内容が変わりました。もう一度確認してください。");
    }
    const children = new Map<string, string[]>();
    const addChild = (parent: string, child: string) => {
      const group = children.get(parent);
      if (group) group.push(child); else children.set(parent, [child]);
    };
    for (const page of pages) if (page.parentId !== null) addChild(page.parentId, page.id);
    const has = (table: string) => !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (has("record_memberships")) {
      for (const member of store.db.prepare("SELECT page_id, database_page_id FROM record_memberships").all())
        addChild(String(member.database_page_id), String(member.page_id));
    }
    const targets = new Set<string>();
    const pending = id === undefined ? trash.map(page => page.id) : [id];
    while (pending.length) {
      const next = pending.pop()!;
      if (targets.has(next)) continue;
      const page = byId.get(next);
      if (!page || page.deletedAt === null || page.documentError)
        throw new Error("使用中または状態を確認できないページを含むため、完全削除を中止しました。");
      targets.add(next);
      for (const child of children.get(next) ?? []) pending.push(child);
    }
    if (!targets.size) return [];
    const ids = JSON.stringify([...targets]);
    const selection = "(SELECT value FROM json_each(?))";
    // Published pages and record owners must remain present in the next v5
    // checkpoint. An unacknowledged outbox may already have reached the peer.
    if (has("workspace_sync_state")) {
      const inCheckpoint = store.db.prepare(`SELECT 1 FROM (
        SELECT checkpoint_json AS data FROM workspace_sync_applied
        UNION ALL SELECT json_extract(commit_json,'$.checkpoint') FROM workspace_sync_outbox WHERE result_json IS NULL
        UNION ALL SELECT local_checkpoint_json FROM workspace_sync_conflicts WHERE chosen IS NULL
      ), json_each(data,'$.payload.tables.pages') AS page
      WHERE json_extract(page.value,'$[0]') IN ${selection} LIMIT 1`).get(ids);
      if (inCheckpoint) throw new Error("同期履歴で参照されているページは完全削除できません。");
    }
    if (has("legacy_record_map")) {
      // The backup/checkpoint readers require a registered owner for every
      // reserved legacy ID, and an archive for reserved but absent records.
      const archived = has("legacy_database_archive")
        ? "NOT EXISTS (SELECT 1 FROM legacy_database_archive a WHERE a.database_page_id=m.database_page_id)" : "1";
      if (store.db.prepare(`SELECT 1 FROM legacy_record_map m WHERE m.database_page_id IN ${selection}
          OR (m.page_id IN ${selection} AND ${archived}) LIMIT 1`).get(ids, ids))
        throw new Error("旧DBのID対応表をバックアップと同期に保持するため、この項目は完全削除できません。");
    }
    store.db.prepare(`DELETE FROM versions WHERE pageId IN ${selection}`).run(ids);
    if (has("record_database_trash_members")) store.db.prepare(`DELETE FROM record_database_trash_members WHERE page_id IN ${selection}`).run(ids);
    if (has("record_database_trash_batches")) store.db.prepare(`DELETE FROM record_database_trash_batches WHERE database_page_id IN ${selection}`).run(ids);
    if (has("legacy_database_archive")) store.db.prepare(`DELETE FROM legacy_database_archive WHERE database_page_id IN ${selection}`).run(ids);
    if (has("record_memberships")) store.db.prepare(`DELETE FROM record_memberships WHERE page_id IN ${selection}`).run(ids);
    if (has("record_databases")) store.db.prepare(`DELETE FROM record_databases WHERE database_page_id IN ${selection}`).run(ids);
    store.db.prepare(`DELETE FROM pages WHERE id IN ${selection}`).run(ids);
    return [...targets];
  });
}
