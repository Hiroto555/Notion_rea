# Opus：Mac最終受入の構成と反証レビュー

2026-11-08。対象候補 bd65b73。Devin CLIの `claude-opus-5-5-high` へ2回、計画だけを相談した。製品/テストコード・workflow・OS・クラウド環境の変更やGUI実行は依頼していない。両CLI exit 0。raw会話は一時作業rootに保管し、repositoryには入れない。

| 相談 | 主な提案・指摘 | Codexの採否 |
|---|---|---|
| 構成設計 | hosted Macの事前確認、別物理A/B＋S、GUIログイン/TCC、実Keychainの専用経路、証拠分類 | 採用。GitHub Actionsを制御系と実行先に分ける |
| 反証 | sleep/回線変更中はrunner/SSHへの依存を断つ | 端末local harnessで手順/証跡、独立した復帰手段を準備する案を採用。sleepでjobが必ず即失敗するという断定は採らない |
| 反証 | mockなしだけでは実Keychainの証拠不足 | 有効commandLine switch・実対象Keychain/項目・cold/warm・外部watchdogを計画。hostedでpromptが絶対に出ないとは保証しない |
| 反証 | 結果にE1/E2/E3の区別が必要 | 実行先と証拠種別を別記録。macOS VMのOS API証拠と物理2台を分ける |
| 補正 | 赤ボタン後は常駐する、Dockで再表示するという初回案 | 不採用。現行index.tsはwindow-all-closedでapp.quit。終了/拒否/記録失敗の再表示をPID等で別caseへ分ける |
| 補正 | L4-01〜12を新しい意味に再番号付けする初回案 | 不採用。既存Gateの定義を維持し、その番号へMac/実機証拠を対応させる |
| 補正 | 本文も含む平文の不在、資料SHA変更で全証拠失効、署名方式の先決め | 不採用。秘密tokenの境界と本文を区別。製品artifact/ハーネスの影響範囲で再検証し、署名/配布要件は対象を確認して決める |

この相談をMac/実機のPASSとして数えない。実装したMacハーネスの安全性レビュー、実行許可や機材の確保にも相当しない。次の作業は[計画](../MAC-QUIET-ACCEPTANCE-PLAN.ja.md)に従って範囲を決める。
