import { Store } from "../src/persistence/store";
import { emptyDatabase } from "../src/shared/types";

/** v3 only: registered databases and records are created through the real UI. */
export function seedDemo(path: string) {
  const store = new Store(path);
  try {
    if (store.pages().length) throw new Error("Demo initialization requires an empty synthetic workspace");
    const home = store.create(null, "page", "R5 合成デモの使い方");
    store.update(home.id, home.revision, { doc: { type: "doc", schemaVersion: 1, content: [
      { type: "heading", attrs: { level: 2, id: "r5-demo-heading" }, content: [{ type: "text", text: "DBを作り、行と表示設定を保存する" }] },
      { type: "paragraph", attrs: { id: "r5-demo-guide" }, content: [{ type: "text", text: "サイドバーの「新しいデータベース」でDBを作れます。「新規行」でページを追加し、本文・タイトル・メモ・見積・完了を編集できます。ビュー名、フィルター、並べ替え、グループは保存され、このデモを再起動しても残ります。ここにある内容はすべて合成データです。" }] }
    ] } });
    const legacy = store.create(null, "database", "R5 旧DBの保持サンプル");
    const database = emptyDatabase();
    database.rows = [{ id: "r5-demo-legacy-row", title: "変換せず保持する旧形式の行", values: {} }];
    store.update(legacy.id, legacy.revision, { database });
    store.handle({ type: "setting", key: "activePage", value: home.id });
  } finally { store.close(); }
}
