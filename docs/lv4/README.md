# Folio Lv4 の現在地

2026-11-08。**M3最終受入待ち。M2（A0〜A7）の実装と非GUI・Linux共通GUIを完了。確認済みLevelはLv3、Lv4は未認定。** [到達点・終了条件・証拠](M3-ACCEPTANCE.ja.md)、[運用・保全手順](M3-OPERATIONS.ja.md)、[分担・Usage](M3-USAGE.ja.md)を最新の入口とする。製品候補 `9ddb60c` は型検査・228ファイル/2,078テスト・build PASS、Linux GUI 238/238 PASS（実IPC207、Electron表示5、Chromium表示26、skip/retry/flaky 0）。Mac固有・物理2台はNOT_RUN。master `e269137`・実データ・このMacのGUIは変更/使用していない。

| 確認すること | 資料 |
|---|---|
| 現在地・M1/M2/M3・終了条件・残件 | [M3最終受入候補](M3-ACCEPTANCE.ja.md) |
| 接続・秘密・完全server backup/restore・容量上限 | [運用・保全手順](M3-OPERATIONS.ja.md) |
| Codex/DeepSeek/Opusの実際の分担と使用量 | [M3 Usage](M3-USAGE.ja.md) |
| レビュー指摘・採否・修正 | [Opus M3レビュー](reviews/OPUS-M3-REVIEW.ja.md) |
| T01〜T14との対応 | [計画タスク状況](PLAN-TASK-STATUS.ja.md) |
| L4-01〜12の確認範囲 | [Gate状況](GATE-STATUS.ja.md) |
| 次の実機受入 | [GUI/実機待ち](GUI-ACCEPTANCE-QUEUE.ja.md)、[Mac固有](GUI-MAC-ACCEPTANCE.ja.md) |
| M1回収コピーの恒久保留と復元 | [M1手順](m1/RECOVERY-RUNBOOK.ja.md) |
| 過去の区切り | [M1完了](M1-COMPLETION.ja.md)、[M2第1区切り](M2-CHECKPOINT-1.ja.md) |
| 元計画と当時の見積り | [残作業計画](REMAINING-WORK-PLAN.ja.md)、[Lv4計画](planning/LV4-PLAN.ja.md) |

[Draft PR #12](https://github.com/Hiroto555/Notion_rea/pull/12)へ保存。未マージPR #11に積んでおり、masterへはマージしない。このMacでGUIを起動しない方針を維持する。
