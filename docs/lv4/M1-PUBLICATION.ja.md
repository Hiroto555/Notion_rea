# M1のGitHub保存とマージ判断

2026-11-08 JST。利用者の「M1完了分もGitHubに反映」という指示により、`codex/folio-m1-20261108`をGitHubへ保存する。元master、実データ、既存のPR #7のheadは変更しない。A3以降の実装やGUIの実行は開始しない。

## 保存するもの

[M1完了記録](M1-COMPLETION.ja.md)のA0〜A2の実装・試験、計画・担当表、Sol XHighレビュー、DeepSeek実行の要約、回収手順、GUI待ち、非GUI検証ログを含む。生のモデルsession、一時DB、実データ、依存・build成果物は追加公開しない。

M1の実装・試験候補は`d509edff574fc1f40e1bbdb93cbb5d45176f683b`。その後は文書とログ整形だけを変更した。保存ログの行末空白2か所は除去し、検証結果の意味は変更していない。

- src tree：`378c75ce5f86f7d2feb5ec462bac1d84ee622a94`
- tests tree：`b4a510df8fbb59d838099a8fab46462496165dba`
- ローカルquiet：型検査・180ファイル／1,673テスト・build PASS。
- Sol XHigh S2：未解決P0/P1なし。GUIと試験の実行を行わない独立ソースレビュー。
- 共有前pattern scan：既存の合成loopback URL試験1件の検出が残る。[判定の根拠](PUBLICATION-CHECKPOINT.ja.md)。検出ゼロとは扱わず、検査器は変更しない。

## PRの構成

[既存Draft PR #7](https://github.com/Hiroto555/Notion_rea/pull/7)はM1以前の保存版として残す。M1の別Draft PRは、#7のhead `codex/folio-lv4-20261107-3qxb-integration`（`732fad5`）をbaseにし、M1追加分だけを確認できる形にする。Git履歴には#7以前の実装も含まれる。新しいPRのheadは`codex/folio-m1-20261108`。

GitHub Actionsは既存の`quiet-checks`だけを使う。型検査・Vitest・build・ローカルasset参照・headless救出helpを実行する設定で、Electron/GUIは起動しない。CIの最新結果と対象headはPRのChecksに記録し、ローカル合格とは区別する。

## 今回はmasterへマージしない

**現時点の推奨は、Draft PRで保存してmasterを維持すること。** M1は非GUIの終了条件を満たしたが、終了時の予約確定、次回起動、実IPC、native picker、IMEと未保存入力の保護は実画面で未受入である。起動・終了やデータ適用を変える候補を、現在のmasterへ直ちに昇格させる判断はしない。

マージを検討する次の区切りは、今回の差分に関係するGUI/OS受入を一時データで通し、同じ最終候補のCIと安全性レビューを揃えた時点。既存PR #7に含まれる追加画面差分も受入範囲に含める。発見した問題を直した場合は影響検査を再実行する。

その際は#7とM1 PRの依存を整理し、masterへ入れる最終差分を一つの候補として判断する。M2/A3以降を自動的に追加する必要はない。物理2台や実トンネルによるLv4認定は別の条件であり、masterへのマージだけでLevelを上げない。

今回の保存はマージ、GUI実行、実データ移行の指示とは扱わない。確認済みLevelはLv3、GUI/実機はNOT_RUNのまま。
