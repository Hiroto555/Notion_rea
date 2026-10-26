import { Store } from "./store";
import type { Doc } from "../shared/types";
const p = (text: string): Doc => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
export function seed(s: Store) {
  if (Number(s.db.prepare("SELECT count(*) AS n FROM pages").get()?.n) > 0)
    return;
  const home = s.create(null, "page", "ようこそ、Folioへ");
  s.update(home.id, 0, {
    icon: "✳️",
    cover: "sage",
    favorite: true,
    doc: {
      type: "doc",
      content: [
        p(
          "考えを集めて、少しずつ形に。ここはあなたのための、静かなワークスペースです。",
        ),
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "小さく書きはじめる" }],
        },
        p(
          "この文章は自由に編集できます。空の行で / を入力すると、見出しやチェックリストを追加できます。",
        ),
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [p("自分だけのワークスペースを開く")],
            },
            {
              type: "taskItem",
              attrs: { checked: false },
              content: [p("最初のアイデアを書き留める")],
            },
            {
              type: "taskItem",
              attrs: { checked: false },
              content: [p("ページを作って、考えを整理する")],
            },
          ],
        },
        {
          type: "blockquote",
          content: [p("大きなアイデアも、はじまりは一行から。")],
        },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "すべて、手元に。" }],
        },
        p(
          "ページはこのMacのSQLiteに保存されます。⌘Kで検索、⌘Nで新しいページ。右側のパネルから履歴や関連ページを確認できます。",
        ),
      ],
    },
  });
  const ideas = s.create(null, "page", "アイデアノート");
  s.update(ideas.id, 0, {
    icon: "💡",
    doc: {
      type: "doc",
      content: [
        p("気づいたこと、試したいこと、まだ名前のないアイデア。"),
        p("ここから、新しいことをはじめよう。"),
      ],
    },
  });
  s.create(ideas.id, "page", "いつか、やりたいこと");
  const db = s.create(null, "database", "プロジェクト");
  s.update(db.id, 0, {
    icon: "◈",
    database: {
      ...db.database!,
      rows: [
        {
          id: "welcome-task",
          title: "ワークスペースを整える",
          values: { status: "完了", date: "2026-10-26" },
        },
        {
          id: "research-task",
          title: "次のアイデアを見つける",
          values: { status: "進行中", date: "2026-10-28" },
        },
        {
          id: "launch-task",
          title: "小さなプロジェクトをはじめる",
          values: { status: "未着手", date: "2026-10-30" },
        },
      ],
    },
  });
  s.handle({ type: "setting", key: "activePage", value: home.id });
}
