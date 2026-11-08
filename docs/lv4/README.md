# Folio Lv4 の現在地

2026-11-08 JST。**M1（A0〜A2）を完了し、ページツリーの実drag等を含むLinux仮想画面のGUI 45件も受入した。A3未着手、確認済みLevelはLv3。** [CIの範囲と結果](GUI-LINUX-CI.ja.md)を参照。Mac固有・実機2台・残りの未移植GUI suiteはNOT_RUN。Lv4全体は未完成。

利用者のM1実行指示に従い、Codexが管理・統合、DeepSeekが最大4本で並列実装・独立試験、Sol XHighが安全性レビューを担当した。最終候補は`d509edf`、型検査・**180ファイル／1,673テスト**・build PASS、未解決P0/P1なし。[M1完了記録](M1-COMPLETION.ja.md)と[回収手順書](m1/RECOVERY-RUNBOOK.ja.md)を最初に読む。

| 確認したいこと | 読む資料 |
|---|---|
| M1の終了条件・実績・制約・停止地点 | [M1完了記録](M1-COMPLETION.ja.md) |
| M1のGitHub保存・PRの依存・マージ判断 | [M1保存記録](M1-PUBLICATION.ja.md) |
| 操作中のMacを使わないGUI試験 | [Linux GUI CI](GUI-LINUX-CI.ja.md) |
| ページツリーの実drag・移動中編集・再起動の追加受入 | [ページツリーCI結果](GUI-PAGE-TREE-CI.ja.md) |
| GUIの残件分類と次の一区切りの提案（まだ未実行） | [GUI受入の次の区切り](GUI-NEXT-CHECKPOINT.ja.md) |
| Mac/OS固有の別枠 | [Mac受入待ち](GUI-MAC-ACCEPTANCE.ja.md) |
| 保全データの回収・コピー復元・失敗時の手順 | [回収手順書](m1/RECOVERY-RUNBOOK.ja.md) |
| 残作業の優先順・終了条件・概算工数・区切り | [残作業計画](REMAINING-WORK-PLAN.ja.md) |
| 12項目ごとの実装済み・未達 | [受入ゲート](GATE-STATUS.ja.md) |
| これまでの実装と試験の履歴 | [実装状況](IMPLEMENTATION-STATUS.ja.md) |
| 当初のT01〜T14との対応 | [タスク対応状況](PLAN-TASK-STATUS.ja.md) |
| 勝者確認→終了時予約→次回起動適用の設計 | [競合解決](CONFLICT-RESOLUTION.ja.md) |
| GUI・OS・物理2台で残る確認 | [受入待ち一覧](GUI-ACCEPTANCE-QUEUE.ja.md) |
| M1の具体的な順序・責任・終了条件 | [M1実行計画](M1-EXECUTION-PLAN.ja.md) |
| DeepSeekの担当ファイル・依存・投入指示 | [12ジョブの担当カード](M1-DISPATCH-PACK.ja.md) |
| Sol／DeepSeekの計画レビューと採否 | [計画レビュー記録](M1-PLANNING-REVIEW.ja.md) |
| 並列実装の当初の会話案 | [並列実装案](PARALLEL-IMPLEMENTATION-PROPOSAL.ja.md) |
| 保存範囲・検証・公開前検査 | [GitHub保存記録](PUBLICATION-CHECKPOINT.ja.md) |

今の区切りは **M1：通常予約の安全性残件、保全一覧→JSON/添付付き書出し→新規v4 DBへのコピー復元を非GUIで受入したところ**。原本を変更せず、添付欠損や結果不明は保留する。旧sidecarの解除、同期保留markerの解除、A3以降には進んでいない。利用者の後続指示により`codex/folio-m1-20261108`を別Draft PRでGitHubへ保存する。masterへはマージしない。[保存方針](M1-PUBLICATION.ja.md)を参照。

M1最終の `npm run verify:quiet` は、型検査・180ファイル／1,673テスト・ビルドの全3段階PASS。[M1実行ログ](validation/m1-quiet.txt)。以前のGitHub保存候補は166ファイル／1,509テストだった。[過去ログ](validation/publication-quiet.txt)。どちらも実画面・実終了イベント・IME・実端末同期の成功を意味しない。

## 図と元の計画・レビュー

- [状況図のHTMLソース](visualizations/folio-lv4-status.fragment.html)：会話内visualizeに使った既存の断片を保存。GitHubのファイル画面では対話実行されない。GitHub上で読める同じ12項目の整理は[受入ゲート](GATE-STATUS.ja.md)を参照。
- [当初のLv4計画・レビュー版](planning/LV4-PLAN.ja.md)、[Opus回答原文](planning/OPUS-LV4-PLAN.raw.ja.md)、[計画への補正](planning/REVIEW-NOTES.ja.md)。計画時点の資料として保存しており、現在の完成判定ではない。
- Sol XHigh：[競合コアの安全性レビュー](reviews/SOL-XHIGH-DESIGN-REVIEW.ja.md)、[勝者UI・終了時予約の安全性レビュー](reviews/SOL-XHIGH-ARCHITECTURE-REVIEW.ja.md)。指摘・修正後の確認経緯を含む。
- DeepSeek：[コアの限定実装・テスト案](reviews/DEEPSEEK-PROPOSAL.md)、[UIの限定実装・テスト案](reviews/DEEPSEEK-UI-PROPOSAL.md)。提案であり、DeepSeek自身による製品実装・テスト完了の証拠ではない。

ローカル絶対パスは移植可能な相対参照かプレースホルダーに置き換えた。`<LOCAL_RUN_ROOT>` は未収録の過去ログ、`<BASELINE_SOURCE>` は計画時のソーススナップショット、`<INTEGRATION_WORKTREE>` は統合ツリーを表す。生のモデルセッション、使い捨てDB、利用者の実データ、秘密情報、依存・ビルド成果物は保存対象に含めない。過去記録の「未コミット」「pushなし」は各記録の時点を示す。
