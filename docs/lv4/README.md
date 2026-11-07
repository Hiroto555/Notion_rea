# Folio Lv4 の現在地

2026-11-08 JST、GitHub保存用チェックポイント。**確認済みの段階はLv3。Lv4は実装途中で、GUI・Electron・実機2台の受入はNOT_RUN。** 現状を保存し、追加の実装は停止している。

| 確認したいこと | 読む資料 |
|---|---|
| 残作業の優先順・終了条件・概算工数・区切り | [残作業計画](REMAINING-WORK-PLAN.ja.md) |
| 12項目ごとの実装済み・未達 | [受入ゲート](GATE-STATUS.ja.md) |
| これまでの実装と試験の履歴 | [実装状況](IMPLEMENTATION-STATUS.ja.md) |
| 当初のT01〜T14との対応 | [タスク対応状況](PLAN-TASK-STATUS.ja.md) |
| 勝者確認→終了時予約→次回起動適用の設計 | [競合解決](CONFLICT-RESOLUTION.ja.md) |
| GUI・OS・物理2台で残る確認 | [受入待ち一覧](GUI-ACCEPTANCE-QUEUE.ja.md) |
| 並列実装を再開するときの役割分担案 | [並列実装案](PARALLEL-IMPLEMENTATION-PROPOSAL.ja.md) |
| 保存範囲・検証・公開前検査 | [GitHub保存記録](PUBLICATION-CHECKPOINT.ja.md) |

今の区切りは **M0：競合の勝者確認UI、取消し、終了時のSQLite予約、次回起動の適用をコード接続し、非GUIで確認したところ**。保全データの取り出し・コピー復元は未実装で、次のM1案に含めている。M1以降の採用・着手は未決定。Lv4完成まで継続する指示として扱わない。

GitHub保存時の `npm run verify:quiet` は、型検査・166ファイル／1,509テスト・ビルドの全3段階PASS。[実行ログ](validation/publication-quiet.txt)。これは実画面・実終了イベント・IME・実端末同期の成功を意味しない。

## 図と元の計画・レビュー

- [状況図のHTMLソース](visualizations/folio-lv4-status.fragment.html)：会話内visualizeに使った既存の断片を保存。GitHubのファイル画面では対話実行されない。GitHub上で読める同じ12項目の整理は[受入ゲート](GATE-STATUS.ja.md)を参照。
- [当初のLv4計画・レビュー版](planning/LV4-PLAN.ja.md)、[Opus回答原文](planning/OPUS-LV4-PLAN.raw.ja.md)、[計画への補正](planning/REVIEW-NOTES.ja.md)。計画時点の資料として保存しており、現在の完成判定ではない。
- Sol XHigh：[競合コアの安全性レビュー](reviews/SOL-XHIGH-DESIGN-REVIEW.ja.md)、[勝者UI・終了時予約の安全性レビュー](reviews/SOL-XHIGH-ARCHITECTURE-REVIEW.ja.md)。指摘・修正後の確認経緯を含む。
- DeepSeek：[コアの限定実装・テスト案](reviews/DEEPSEEK-PROPOSAL.md)、[UIの限定実装・テスト案](reviews/DEEPSEEK-UI-PROPOSAL.md)。提案であり、DeepSeek自身による製品実装・テスト完了の証拠ではない。

ローカル絶対パスは移植可能な相対参照かプレースホルダーに置き換えた。`<LOCAL_RUN_ROOT>` は未収録の過去ログ、`<BASELINE_SOURCE>` は計画時のソーススナップショット、`<INTEGRATION_WORKTREE>` は統合ツリーを表す。生のモデルセッション、使い捨てDB、利用者の実データ、秘密情報、依存・ビルド成果物は保存対象に含めない。過去記録の「未コミット」「pushなし」は各記録の時点を示す。
