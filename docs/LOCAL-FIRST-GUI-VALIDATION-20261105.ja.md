# Folio Local-first GUI検証 — 2026-11-05

状態: **Level 3到達（固定G1〜G8基準、ローカル単一所有者の範囲）。**

修正版の最終GUIバッチは57ファイル / 212件がすべてPASS。内訳は実際のElectron 184件と、独立したブラウザーpresentation harness 28件。スキップ0、失敗0、flaky0、再試行0、suite外エラー0。Level 4以降の端末間同期・共同編集への到達は主張しない。

実装・テストの検証コミットは `db7bf1aecc303c600ae4beab6c02b544aeb31de8`。
固定した到達条件は [Level 3のG1〜G8](parallel/dsh-r2/LEVEL3-GATES.ja.md) を使用する。対象はローカルSQLite・単一所有者・現在提供している単一ウィンドウの製品経路であり、複数端末同期や共同編集は別段階。

## 実行環境と隔離

- macOS arm64、Node 24.20.0、Electron 45.0.0、Playwright 1.64.1。production buildで実行。
- 利用者から今回のGUIバッチ実行を明示的に許可された。通常時のGUI禁止と `test:e2e:batch` の入口は維持した。
- 全Electron試験の保存先は使い捨てフォルダー。既定の保存先を確認する既存試験も、一時的な `appData` に差し替える。通常のFolioと利用者のページは操作しない。
- 追加15件は `tests/e2e/local-first-fixture.ts` から、専用 `FOLIO_DATA_DIR`、専用Electron profile/sessionで起動する。GUIは1 workerで直列実行する。
- 起動前からElectronのテスト用sessionをofflineにし、HTTP/WebSocket要求を拒否する。mainのfetch/HTTPも子プロセス内で拒否し、起動後のrendererでもoffline状態と通信失敗を確認する。Mac全体の通信設定は変更しない。カーネルによるネットワーク隔離の検証ではない。
- 容量不足・容量不明は、この子プロセスの一時ワークスペースに対するstatfsだけに注入する。実ディスクを埋めない。
- 未確定操作を残す障害試験の終了では、その試験が起動した子だけを必要に応じて停止する。

## 見つかった不具合と修正

1. **複製完了後に古い復旧記録が残る。** `App` のPageOperationCoordinatorの変更通知が再描画だけを行い、完了した操作を復旧記録から除くcheckpointを発行していなかった。複製後に本文編集をせず再起動すると、不要な復旧ダイアログが現れた。通知時にcheckpointを更新し、複製直後の再起動を回帰試験に追加した。
2. **作成の復旧に成功しても保存エラー表示が残る。** 未送信作成の再試行、結果照合、拒否された入力の別ページ保存に成功した場合、その操作に対応する古いエラー表示だけを解除する。無関係なエラーは保持する。

変更箇所: `src/renderer/App.tsx` のPageOperationCoordinator配線、`retryUncheckpointedPageCreation`、`resolvePageCreation`、`preserveRejectedPageCreation`。

テスト側も現在の契約に合わせた。作成の障害注入は旧`create`から`page:commit`へ変更した。バックアップ先が復旧した後の安全な保存再試行は、拒否を期待する旧試験から、1 revisionの保存と本文一致を確認する試験に更新した。未確定入力による終了防止を無効化せず、fixtureの後片付けだけに上限時間を設けた。非同期モーダルの終了は、閉じるボタンのクリック後に実際の消滅を待つ。

初回の既存197件では191件成功・6件失敗とworker後処理のtimeoutを記録した。失敗は4件の旧作成APIへの注入、複製完了記録の不具合、旧保存再試行の期待値に分けて調査した。追加試験の作成中に見つかった保存エラー表示も修正し、selector・モーダル終了待ち等のfixture側の問題と区別した。最終バッチは修正後の単一コミットを最初から全件実行した結果である。

## 実行結果

| 検証 | 結果 |
| --- | --- |
| `npm run verify:quiet` | PASS: 型検査、116ファイル / 1,148 unit試験、production build。49.9秒 |
| `node scripts/check-local-assets.mjs` | PASS: ビルド済みHTML/CSSの参照はローカルファイル |
| `node dist/raw-rescue.cjs --help` | PASS: 単独救出CLIの入口 |
| 修正版GUI全件 | PASS: 57ファイル / 212件、6.4分。追加15件もすべてPASS |
| 公開用の現在ツリー検査 | PASS: 924ファイル、検出0件。既存binary allowlistと照合。個人データとGUI成果物は含めない |
| GitHub CI / master | この文書を含むPRのチェック履歴とmasterのActions履歴を参照。CI合格後に統合し、ローカルGUI証拠と区別する |

再実行の入口:

```sh
npm run verify:quiet
npm run test:e2e:batch
```

この文書は次回のGUI実行許可にはならない。Macで別作業中はquiet検証を使い、GUIバッチは利用者が指定した時間に行う。

## G1〜G8の判定

| Gate | 判定 | 根拠 |
| --- | --- | --- |
| G1 ローカル完結 | PASS | `local-first.spec.ts` のoffline起動→新規作成→編集→検索→Markdown書出し→再起動。`r5-offline-lifecycle.test.ts` とローカルasset検査も使用 |
| G2 正常操作の不変条件 | PASS | Page/record/DBのID・owner・revision・順序・参照は既存unit群。`desktop.spec.ts`、`editor-identity.spec.ts`、`record-core.spec.ts`、移動・ゴミ箱・復元のGUI群 |
| G3 保存の確定と入力保護 | PASS | `page-operation-coordinator.test.ts`、保存契約のunit群。追加GUIで作成ACK喪失、同じ操作の照合、初期本文のatomic import、初回backup拒否時の原本保持を確認 |
| G4 復旧と競合 | PASS | `r6-recovery.spec.ts` のSIGKILL、`pending-journal.spec.ts`、`recovery-race-guard.spec.ts`、追加GUIの同じIDによる明示再試行・拒否理由・復旧コピー・再open |
| G5 backup/restore | PASS | `l3-durability-backup.test.ts`、backup故障注入群。`r8-acceptance/backup.spec.ts`、`real-launch.spec.ts` で実際の復元先child起動。追加GUIでpin/最新保護、古い世代だけの外部退避と復元DBの内容を検証 |
| G6 破損・未知schema隔離 | PASS | `r5-schema-startup.test.ts`、raw rescue群、`gate-a.spec.ts` F07。追加GUIで壊れたPageを保全し健康Pageを保存、診断用DB救出と完全backupの拒否を区別 |
| G7 容量と処理量の管理 | PASS | storage pressure/growth/limits/maintenanceのunit群。追加GUIで使用量の2回計測、上限のCAS・変更・解除・再open、容量停止時の入力退避・同じ操作の再試行、read-only起動・原本救出を確認 |
| G8 同一統合版の検証 | PASS | 上記コミットのquiet結果とGUI全212件・回帰試験がPASS。実装/テスト等414ファイルのSHA-256集合digestは `5298d74cca6a4877255389190159510cbd53267ac1e281411739be2124c42bf3`。後続の文書追加はruntime/testを変更しない。GitHub CIは統合前の別の関所として確認する |

G7の計測補足: 1,000 / 10,000件規模の保存記録・空添付ファイルに対する前段の計測値と方法は [Round 4レビュー](parallel/dsh-r4/INTEGRATION-REVIEW.ja.md) に残した。通常保存のDB判定は200回平均で各0.004ms、添付ツリー判定は9.5 / 44.0ms、workerでの全体計測は46.1 / 87.9ms。今回のGUI suiteは150ページ・1,000ブロックの入力と再起動も含む。これらは1台のMacの合成計測で、p95や全利用規模の保証ではない。

## 検証範囲の境界

- 追加GUIは本物のElectron・renderer・IPC・SQLite・ファイル処理を使う。保存先選択ダイアログの戻り値はスタブを使う。OSネイティブのファイル選択パネル自体の操作は未検証。
- 日本語本文の保存・再openと、synthetic compositionによるIME中の抑止は検証する。物理キーボードからOSのIMEで変換・確定する試験は未検証。
- 容量判定は事前確認で、領域の予約ではない。DB上限はhigh-water方式で、1操作が境界を越えた後の次の保存を停止する。バックアップ等の大きな処理にはmainで同期実行する部分がある。
- 古い/不明な添付参照と未確定操作は自動削除しない。バックアップと補助ファイルの退避は同一ボリューム限定。停電・物理故障の万能な保証は行わない。
- 旧ワークスペース発見時のOS chooserを含む初回取込み操作は別枠で未検証。コピー・容量・移行・救出のサービスとCLIはunit/一時DB試験の範囲で確認する。
- GitHubへのソース統合と、利用者のインストール済みDesktopアプリ差替え・リリース配布は別。今回、通常のDesktop Folioは差し替えない。
