import { Store } from "../src/persistence/store";
import { emptyDatabase } from "../src/shared/types";
/** An isolated synthetic v3 source; migration is performed through the UI. */
export function seedDemo(path: string) {
  const store = new Store(path);
  try {
    if (store.pages().length) throw new Error("Demo requires an empty synthetic workspace");
    const home = store.create(null, "page", "R6 合成デモの使い方");
    store.update(home.id, home.revision, {doc: {type: "doc", content: [
      {type: "heading", attrs: {level: 2}, content: [{type: "text", text: "旧DB移行・列設定・強制終了からの復旧"}]},
      {type: "paragraph", content: [{type: "text", text: "この画面は合成データです。旧DBはコピーを検証してからページ形式へ移行できます。「列の設定」から列の追加・名前変更・型変更ができます。変更をプレビューし、変換できない値があれば原本を変更せず止まります。復旧用保存済みの入力は、強制終了後に保存結果と照合して戻せます。版が変わった場合は別ページへ復旧できます。"}]}
    ]}});
    const legacy = store.create(null, "database", "R6 移行サンプル");
    const database = emptyDatabase();
    database.properties = [{id: "note", name: "メモ", type: "text"}, {id: "estimate", name: "見積", type: "text"}];
    database.rows = [{id: "r6-demo-row-a", title: "募集資料を確認する", values: {note: "元の旧DBから引き継ぐ入力", estimate: "8"}},
      {id: "r6-demo-row-b", title: "週次レビューをまとめる", values: {note: "合成サンプル", estimate: "5"}}];
    store.update(legacy.id, legacy.revision, {database});
    store.handle({type: "setting", key: "activePage", value: home.id});
  } finally {store.close();}
}
