import { writeFileSync } from "node:fs";
import { Store } from "../src/persistence/store";
import { seedDemo as seedBase } from "./r7-demo-seed";
import type { Doc } from "../src/shared/types";
const text = (value: string): Doc => ({ type: "text", text: value });
const paragraph = (value: string): Doc => ({
  type: "paragraph",
  content: [text(value)],
});
const callout = (tone: string, title: string, body: string): Doc => ({
  type: "callout",
  attrs: { tone },
  content: [
    {
      type: "paragraph",
      content: [{ ...text(title), marks: [{ type: "bold" }] }],
    },
    paragraph(body),
  ],
});
export function seedDemo(
  database: string,
  manifestPath: string,
  image: string,
) {
  const manifest = seedBase(database, manifestPath, image);
  const store = new Store(database);
  try {
    const page = store.create(null, "page", "W3｜考えを伝えるページ");
    const rows = [
      ["項目", "決めたこと", "次の行動"],
      [
        "コールアウト",
        "大切な情報を目立たせる",
        "メモ・ヒント・注意を切り替える",
      ],
      ["簡易表", "比較と整理を、本文の中で", "行・列を追加して編集する"],
      [
        "保存と復元",
        "タイトルも本文も保持する",
        "Markdown往復・完全バックアップ",
      ],
    ];
    const doc: Doc = {
      type: "doc",
      schemaVersion: 2,
      content: [
        paragraph("小さな工夫で、読み返したくなるノートへ。"),
        callout(
          "note",
          "今日のメモ",
          "コールアウトの中でも、文章・リンク・箇条書きをそのまま編集できます。",
        ),
        {
          type: "heading",
          attrs: { level: 2 },
          content: [text("ひと目でわかる比較表")],
        },
        {
          type: "table",
          content: rows.map((row, i) => ({
            type: "tableRow",
            content: row.map((value) => ({
              type: i === 0 ? "tableHeader" : "tableCell",
              attrs: { colspan: 1, rowspan: 1, colwidth: null },
              content: [paragraph(value)],
            })),
          })),
        },
        callout(
          "tip",
          "使い方のヒント",
          "空の行で /callout または /table。表のセルにカーソルを置くと、行・列の操作が現れます。",
        ),
        callout(
          "warning",
          "安心して試すために",
          "この画面は専用のサンプルデータです。既存のノートとは別に保存されます。",
        ),
        paragraph(
          "ここから自由に書き足してみてください。表の移動には Tab / Shift+Tab、表から出るには ⌘Enter を使えます。",
        ),
      ],
    };
    store.update(page.id, page.revision, { doc, icon: "📝" });
    store.handle({ type: "setting", key: "activePage", value: page.id });
    const result = {
      ...manifest,
      w3: {
        pageId: page.id,
        title: page.title,
        marker: "folio-r9-w3-synthetic-v1",
      },
    };
    writeFileSync(manifestPath, JSON.stringify(result, null, 2) + "\n");
    return result;
  } finally {
    store.close();
  }
}
