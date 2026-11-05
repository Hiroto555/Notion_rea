# Folio Round 3 — 画面を使わない容量不足対策

2026-11-05 JST。**実装・ローカル統合・非GUI検証は完了。GUIはNOT_RUN。**

- 統合先: `<workspace-root>/Folio-l3-r3-integrated`
- ブランチ: `codex/folio-l3-r3-integrated-20261105`
- 検証対象コード: `3fd951d869e1d0b04f2abf0cc21b07ff01f68561`
- 共通base: `e26d1711de2d94e11475d1731576490c3ca4e808`（Round 2統合済み）
- 到達判定: **Level 2到達 / Level 3部分達成を維持**。G7の一部を進めたが、quota・保持保守・製品画面の確認は残る。
- 変更は上記worktreeに保存した。旧 `Notion_rea` master、既存Desktopアプリ、利用者データ、リモートへの反映は行っていない。

## 実際の分担と統合

DeepSeek Harnessの公式headless CLIで3担当を並列実行。`deepseek-account / deepseek-flash / reasoningEffort=max` のtask-local overlayを使用した。インストール済みcatalogのモデル名はDeepSeek V4.1 Flash。Full Accessは今回の子プロセスに設定し、Desktopのグローバルprofileは変更していない。Codexが契約・配線・レビュー・最終検証を担当した。

| 担当 | 確定HEAD | 成果 | 実行証拠 |
| --- | --- | --- | --- |
| A | `c1abffc06321ad301b740109da4742361c40db8a` | 空き容量判定、境界・overflow・実statfs試験 | exit 0 / 45 tool calls / 18 tests PASS |
| B | `cd4a3c2cd9c9d6da989cd8b325112be755d975ef` | 全52種のIPC要求をread/checkpoint/writeに分類 | exit 0 / 29 tool calls / 7 tests PASS |
| C | `4f47bc1e7e3d278015a6eac633ec2baff4414dc1` | 実SQLite・checkpointを使う独立受入試験 | exit 0 / 72 tool calls。新規4件は統合前NOT_RUN、統合後PASS |

最終確認で3worktreeはclean、HEAD不変、完了イベントあり。確定HEADをそれぞれmergeし、全て統合HEADの祖先にした。Cの単独check失敗はA/B module未統合によるもので、統合先のcheckで解消した。担当の自己申告だけでは合格にしていない。

## 今回変わった動作

| 動作 | 実装証拠 | 検証・境界 |
| --- | --- | --- |
| 通常の保存前にディスクの空きを確認 | `src/main/storage-pressure.ts:97` / `:144` | `bavail * bsize`。inspectごとにstatfsを1回実行し、全ファイル走査はしない。既定の安全余裕256 MiBを下回る場合、取得失敗・overflowの場合に書込みを止める |
| 読取り・照合・復旧checkpointを残す | `src/main/storage-write-policy.ts:79` / `:89` | 26 read / 1 checkpoint / 25 write。全Request型の分類を型検査、未知typeは拒否。外部書出しの入口も容量判定で塞がない |
| IPCの保存・自動backupより前に判定 | `src/main/index.ts:168` / `:182` | sender/schema/サイズ検査の後、個別handlerの前。容量拒否で終端rejected receiptを作らない。実IPCの実行はNOT_RUN、順序はコード確認 |
| backup作成前、復元先作成前に判定 | `src/main/workspace-backup-service.ts:27` / `:38` | 自動rich/layout backupも対象。復元は元workspaceではなく復元先volumeを確認。別の復元先への救出をsourceの容量だけで止めない |
| 保留中のページ作成を同じ操作で再試行 | `src/renderer/page-operation-coordinator.ts:209` / `src/renderer/App.tsx:1020` | 再checkpoint→resolve→unknownだけ再送。operationId/sessionId/seq/本文を維持。連打、checkpoint失敗、lost ACK、rejected保持を試験 |
| 通常ページの保留保存を安全に再試行 | `src/renderer/reliable-save.ts:50` / `src/renderer/App.tsx:646` | 保持済みのimmutable operationだけを対象にする。適用済み/拒否済みなら再送しない。古いrevisionを新しいrevisionへ勝手に置き換えない |
| 容量を手動表示 | `src/renderer/StoragePressurePanel.tsx:13` / `src/shared/types.ts:375` | ページ情報欄のボタンから取得。pollingなし、失敗時は前のready表示を消す。型検査・build済み、実画面操作はNOT_RUN |

添付と復旧ファイル取込みでは、ファイル選択を待った後にも容量を再確認する（`src/main/index.ts:275` / `:289`）。実際のnative dialogは開いていない。

## Codexの追加レビューと検証

容量判定を入れるだけでは、拒否後に入力が保留状態で残り、通常ページの画面から同じ操作を再送できない経路があった。既存の変更元revisionとoperationを保持できている場合に限定して、明示再試行を接続した。変更元が不明な入力は従来どおり退避を案内し、最新版へ強制上書きしない。

`tests/dsh-r3-integration-regressions.test.ts` の追加8件:

- `:63` 再checkpoint中の連打を直列化し、元の本文・IDで1ページだけ作成。
- `:116` retry前checkpoint失敗では送信ゼロ、入力を保持。
- `:138` 容量不足継続ではunknown保持、lost ACKはresolveだけで確定。
- `:157` rejectedの入力は保持し、自動再送しない。
- `:171` 通常保存も同じrevision/IDで再試行、適用済み照合では履歴・revisionを増やさない。
- `:207` 他の更新が先行した場合は拒否し、新しい内容を維持。
- `:225` 自動rich backup拒否時にbackup directory・Page・receiptを作らない。
- `:257` 復元先容量不足ではtargetを作らず、回復後は別場所へ復元して原本を維持。

Cの4件は実Store / CrashRecoveryFile / RecoveryCheckpointを使用するが、dispatchはテスト内で組み立てている。main/preload/Electron/画面の一連経路を実行した証拠とは区別する。ディスクを実際に埋めず、probe注入で圧迫を再現した。

## 最終検証結果

Node v24.20.0 / npm 11.19.0、既存依存、worktree専用Vite cache、使い捨てfixture、maxWorkers=2。

| 検証 | 結果 | ログ |
| --- | --- | --- |
| 容量・retry・backup関連 | **7ファイル / 55件 PASS** | `output/review-r3/targeted.log` |
| `npm run verify:quiet` 型検査 | **PASS** | `output/review-r3/verify-quiet.log` |
| 同 unit suite | **101ファイル / 1,033件 PASS** | 同上 |
| 同 production build | **PASS** | 同上 |
| quiet全体 | exit 0 / 32.0秒 | 同上 |
| `git diff --check` | PASS | 最終差分確認 |
| GUI / Electron / browser / clipboard / native dialog | **NOT_RUN** | 実行禁止を継続 |
| hosted CI / Windows / Linux / 実ディスク圧迫 / 物理停電 | **NOT_RUN** | 対象外 |

従来のdynamic/static import混在・500kB超chunkのbuild警告は残る。合格件数だけで操作感やLevel到達を判定しない。

## 重要な制限と次の順序

1. **これは保存前の空き容量確認**。workspaceの使用量上限、予約領域の確保、1操作の最大割当保証ではない。巨大backup/duplicateや別プロセスの書込みで確認後に容量が減る可能性がある。`additionalBytes` APIはあるが、製品経路の全操作サイズ見積りは未実装。
2. 起動時のStore/schema準備はこのIPC guardより前。全ての起動時書込みを保護する機能とは扱わない。完全にディスクが満杯なら、許可している復旧checkpointも実ファイル書込みで失敗し得る。
3. 256 MiBは既定の安全余裕。workloadに基づく容量設計・保持期間・安全な保守操作・処理量制御は残る。receipt/historyは削除していない。
4. 容量表示はページ情報欄にある。空workspaceなどでのアクセス、停止表示、IME、再試行後の選択、再openはGUI枠で確認する。今の成果をDesktop配布版で利用済みとは扱わない。
5. R2の破損Pageがあると完全backupが失敗する制限は維持。破損原本のraw救出bundleは別の残件。

**G7はPARTIALのまま**。非GUIで次に進めるのは、既存容量集計と安全な保守の設計・上限停止の追加、破損原本救出の改善。**G8もPARTIALのまま**。GUI検証は `docs/GUI-VALIDATION-QUEUE.ja.md` に追記し、利用者が実行タイミングを指定した後にまとめて行う。Level 4の製品同期・クラウド対応は今回実装していない。

固定成果物: `<workspace-root>/Notion_rea/outputs/folio-l3-r3-20261105/integration/`。`RESULT.json` に最終HEAD・検証対象コード・worker HEAD・状態、`SOURCE-SHA256.json` にソース指紋を保存する。
