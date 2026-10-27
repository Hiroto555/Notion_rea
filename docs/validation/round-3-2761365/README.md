# Round 3 実行記録（進行中）

`<repo>` は現在の専用作業フォルダ、`<review>` はユーザー指定の添付レビュー資料フォルダを表す。ログはこれらの個人パスを匿名化。開始時点・OS・lockfile: `start.txt`。専用作業ツリー HEAD は 276136519164c7a1a1c6366398ed3dc3f09350c0、tracked/index ともクリーン。以降の検証対象は未コミット差分を含み、HEAD だけを検証対象としない。全コマンドで `FOLIO_DATA_DIR=$PWD/output/round-3-2761365/workspace`、`FOLIO_VITE_CACHE_DIR=$PWD/output/round-3-2761365/cache/vite`、`npm_config_cache=$PWD/output/round-3-2761365/cache/npm` を指定。Electron E2E は各自の合成 workspace を追加で指定し、実ユーザーの workspace を開いていない。テストごとに独立した出力/traceは `output/round-3-2761365/evidence/`。Playwright は `--retries=0`、既存の本番サーバーは使用しない。

| 記録 | 実行コマンド | 終了コード・注記 |
| --- | --- | --- |
| s1-review-probe.txt | `node <review>/probes/probe-boundaries.mjs` | 0、同梱Git blobと分離済みパス式。2欠陥再現。実ダイアログの試験ではない |
| s1-check/test/build.txt | `npm run check` → `npm run test` → `npm run build` | 各0、50単体 |
| s1-independence.txt | `npm test -- tests/workspace.test.ts tests/output-path.test.ts` | 0、7件。通常移行元を削除した後もコピーとbackupを照合 |
| s1-e2e.txt | `npx playwright test tests/e2e/output-boundary.spec.ts tests/e2e/recovery.spec.ts tests/e2e/gate-a.spec.ts --grep 'S1 real IPC\|R1\|F01\|F05\|failed write' --retries=0 --output=output/round-3-2761365/evidence/s1-e2e` | 0、14件 |
| s2-baseline.txt | `npx playwright test tests/e2e/gate-a.spec.ts --grep 'F11 editing during move' --retries=0 --output=output/round-3-2761365/evidence/s2-baseline` | 0、旧問題は未再現で原因不明 |
| s2-check.txt | `npm run check` | 2、追加試験の型エラー。記録保持 |
| s2-check-corrected.txt | `npm run check` | 0、型を修正 |
| s2-first.txt | `npx playwright test tests/e2e/page-move.spec.ts tests/e2e/gate-a.spec.ts tests/e2e/drag.spec.ts --grep 'S2 \|F11 editing\|R2' --retries=0 --output=output/round-3-2761365/evidence/s2-first` | 1、4成功・1失敗。メニュー試験の対象ボタンが3件に一致 |
| s2-menu-corrected.txt | `npx playwright test tests/e2e/page-move.spec.ts --grep 'S2 menu F11' --retries=0 --output=output/round-3-2761365/evidence/s2-menu-corrected` | 0、ダイアログ内を指定 |
| s2-tree20.txt | `npx playwright test tests/e2e/page-move.spec.ts --grep 'S2 tree input' --repeat-each=20 --retries=0 --output=output/round-3-2761365/evidence/s2-tree20` | 0、20/20 |
| s2-menu10.txt | `npx playwright test tests/e2e/page-move.spec.ts --grep 'S2 menu F11' --repeat-each=10 --retries=0 --output=output/round-3-2761365/evidence/s2-menu10` | 0、10/10 |
| s2-block40.txt | `npx playwright test tests/e2e/drag.spec.ts --repeat-each=20 --retries=0 --output=output/round-3-2761365/evidence/s2-block40` | 1、39/40。matrix試行16の複数選択ドラッグでmousedown後dragstartなし。原因未確定 |
| s2-coverage-check.txt | `npm run check` | 0 |
| s2-coverage.txt | `npx playwright test tests/e2e/page-move.spec.ts tests/e2e/recovery.spec.ts --grep 'S2 tree order\|multiple pending' --retries=0 --output=output/round-3-2761365/evidence/s2-coverage` | 0、2件 |
| s2-final-check/test/build.txt | `npm run check` → `npm run test` → `npm run build` | 各0、50単体 |
| s2-full-{1,2,3}.txt | `npx playwright test --retries=0 --output=output/round-3-2761365/evidence/s2-full-N` | 実行中。個別ログに終了コード |

`s2-source-build-sha256.txt` は20/10/40実行時、`s2-final-source-build-sha256.txt` は後続全体試験時の各ファイルの SHA-256。両者は試験強化のため異なる。S1のbuildは `s2-source-build-sha256.txt` に含まれる。合成データ由来のローカルtraceはGitに含めない。実行途中の失敗と修正後の試行を分けて保持し、旧結果の成功回数へ加算しない。

注意: 上記の Playwright 既定設定は `output/playwright/report` を再生成し、desktop.spec の固定スクリーンショット `output/playwright/folio-light.png` を上書きした。過去の `docs/validation/` のログは変更していないが、共通HTMLレポートと固定画像の従前内容は復元確認できていない。後続コマンドでは専用 reporter/output と個別 screenshot を使う。

S2 全体結果は追加後41件を数え、1回目41/41、2回目41/41、3回目39/41（終了コード1）。3回目のR3選択範囲は操作前の `不` 対 `不動産`、F06はリンク要素未検出。原因は未特定。各失敗traceはローカル `output/round-3-2761365/evidence/s2-full-3/`。

| 記録 | 実行コマンド | 終了コード・注記 |
| --- | --- | --- |
| s3-fixture-check.txt | `npm run check` | 2。追加試験fixtureの型エラー |
| s3-fixture-check-corrected.txt | `npm run check` | 0 |
| s3-check.txt | `npm run check` | 2。診断イベント型のオーバーロードエラー |
| s3-corrected-check/test/build.txt | `npm run check` → `npm run test` → `npm run build` | 各0。50単体 |
| s3-dev-trials.txt | `node scripts/round3-dev-validation.mjs` | 0。ready手前の意図的失敗は試験子プロセス終了1・trace/PID/port確認。cold 5/5、warm 5/5、開発 R3 link 1/1。全子プロセスの一覧は `output/round-3-2761365/evidence/dev-run-ArzQl3/results.json` と各 `playwright.txt` |
| final-check/test/build.txt | `npm run check` → `npm run test` → `npm run build` | 各0。50単体 |
| s3-launcher.txt | `node scripts/round3-launcher-check.mjs` | 0。専用の占有portに対しlauncherが終了1で拒否し、占有側は存続。SIGTERM時に試験所有Electronが終了しportが解放 |
| final-full.txt | `npx playwright test --reporter=list --retries=0 --output=output/round-3-2761365/evidence/final-full` | fixture等の最終変更後の全体試験。個別ログ末尾に終了コード |

開発起動の各試行ではViteとElectronを起動し直し、各テストworkspaceで保存ACKとElectron再起動後の内容を照合した。coldは新規cacheを各々使用、warmはcold-1の試験用cacheを再利用。Vite設定のport 0 はこのVite版では5173に解決されたが、`strictPort` により同portが占有済みなら別サーバーに接続せず失敗する。各試行でその試験のサーバーを終了し、同じportを再bindできることを確認した。別途launcher試験は試験自身が確保した動的portを指定している。

ready失敗は `.page-title` の待機前に試験フラグで例外を注入したもので、過去の自然発生したcold障害の再現ではない。`startup-diagnostics.json` はlaunch/trace/first-window/UI-ready、捕捉できたstdout/stderr・navigation・pageerror・webContentsイベント・cleanupを保持する。Playwrightのlaunch返却以前やlistener接続以前に発生したrendererイベント、初回IPCの開始とACKを完全には観測できない。ロード後のpreload公開・明示的load IPCと保存状態を検証しており、旧失敗の原因は未特定。

最終fixture変更後の `final-full.txt` は41/41・終了0。追加のDBリンク単体は `npm test -- tests/workspace.test.ts tests/output-path.test.ts`、`s1-final-unit.txt`、終了0。続く `npm run check` は `final-post-unit-check.txt`、終了0。最終全体E2E後に変更したのは `tests/workspace.test.ts` のDBリンク単体追加のみで、全体実行時は `final-source-build-sha256.txt`、その時点は `end-source-build-sha256.txt` に対応する。その後のパス結合修正を含む現在は `path-final-source-build-sha256.txt`。tree20の試行別イベント抜粋は `s2-tree20-diagnostics.json`。最初のS1重点E2E時のテストファイル個別ハッシュは取得していないため、その初回の完全なソース対応は未記録。後続の全体試験はハッシュを記録している。

traceの限定パターン検査: `trace-scan.json`。329 archive / 2190テキストentryで該当パターン0、25件の30MB超entryと画像等は対象外。試験は合成データのみで実施し、画像は取得元を確認したが、網羅的な秘密情報不在の証明ではない。生traceはローカルoutputに保持し、共有しない。

最終確認で未作成出力先のパス結合を `basename` / `sep` に変更。`npm run check` → `npm run test` → `npm run build` は各0（`path-final-{check,test,build}.txt`、50単体）。`npx playwright test tests/e2e/output-boundary.spec.ts tests/e2e/recovery.spec.ts --grep 'S1 real IPC|multiple pending' --reporter=list --retries=0 --output=output/round-3-2761365/evidence/path-final` は0（2/2、`path-final-e2e.txt`）。このソース変更後の全体E2Eは未実行であり、前の41/41は `final-source-build-sha256.txt` と対応する。Windowsでの実行は未検証。

追加の重点E2Eのtrace 3 archiveも `path-final-trace-scan.json` で限定パターンを検査し、21テキストentryに該当0、画像等47件は対象外。`shasum -a 256 -c docs/validation/round-3-2761365/path-final-source-build-sha256.txt` は `final-hash-check.txt`、終了0。初期のS2単独・初回失敗試行やS3の途中の型検査についても、各試行開始時の全ファイルハッシュは取得していない。対応が明確なのは記録済みの反復・全体・開発試行と最後の重点検査であり、初期の全試行が厳密にhash固定されていたとは主張しない。
