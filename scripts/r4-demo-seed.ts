import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { markRecordStoreVersion } from "../src/persistence/record-version";
import { emptyDatabase } from "../src/shared/types";

export function seedDemo(path: string) {
  const store = new Store(path);
  try {
    if (store.pages().length) throw new Error("Demo initialization requires an empty synthetic workspace");
    const home = store.create(null, "page", "R4 合成デモの使い方");
    store.update(home.id, home.revision, { doc: { type: "doc", schemaVersion: 1, content: [
      { type: "heading", attrs: { level: 2, id: "demo-heading" }, content: [{ type: "text", text: "レコードをページとして編集する" }] },
      { type: "paragraph", attrs: { id: "demo-guide" }, content: [{ type: "text", text: "合成タスクDBを開き、行の右矢印から本文・タイトル・メモ・見積・完了を編集できます。閉じて一覧へ戻り、このデモを再起動すると保存内容を確認できます。ここにある内容はすべて合成データです。" }] }
    ] } });
    let owner = store.create(null, "database", "R4 合成タスクDB");
    const database = emptyDatabase();
    database.properties = [
      { id: "note", name: "メモ", type: "text" },
      { id: "estimate", name: "見積", type: "number" },
      { id: "done", name: "完了", type: "checkbox" },
    ];
    owner = store.update(owner.id, owner.revision, { database });
    const records = new RecordRepository(store);
    store.transaction(() => { records.createSchema(); records.registerDatabase(owner.id); markRecordStoreVersion(store.db); });
    for (const [index, title] of ["募集資料を確認する", "週次レビューをまとめる", "次回の打合せを準備する"].entries()) {
      const record = records.create(owner.id, title, { note: "合成データのメモ", estimate: index + 1, done: false });
      store.updateRecordPage(record.pageId, owner.id, record.revision, { doc: { type: "doc", schemaVersion: 1, content: [
        { type: "paragraph", attrs: { id: `demo-task-${index}` }, content: [{ type: "text", text: "ここに詳細を入力します。/ で見出しやTo-doへ変換できます。" }] }
      ] } });
    }
    store.handle({ type: "setting", key: "activePage", value: owner.id });
  } finally { store.close(); }
}
