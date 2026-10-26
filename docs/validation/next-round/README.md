# 次ラウンド実行記録

レビュー基準は `7759906dbbc905a4dc79d01b97aaff6471e51eb3`。最終のアプリ・テストを含む実装HEADは `0bf710eec16d065535674e41196312141e2d0233`、最後のアプリソース変更は `a4c9abf94baaf726669d0c058626d23db446c8cd`。これ以降の集約作業は文書・証拠のみ。ローカルコミットで、push・公開設定変更・履歴書き換えは実施しない。

- [結果一覧](results.json): 全コマンド、終了コード、PASS/FAIL/NOT_RUN、最終照合。過去の失敗を含む。
- [manifest](manifest.json): 現在のsource/test/config/lockfile、実dist、証拠文書のSHA-256。manifest自身を除外。
- [Git記録](git-state.json): 基準・実装・ローカル変更単位。証拠コミットのIDは自己参照を避け、これらのファイルを包含するGitコミットで特定する。
- [全生証拠index](raw-artifacts.json): 失敗を含む各runのtrace・画面・診断JSONのローカルパスとhash。
- [環境](environment.json): 実Electronのversion/locale/viewport/zoomとNotion側の未確認欄。
- [保護対象の照合](data-protection.json): 既存SQLite/WAL/SHMとlockfileの前後hash、既存アプリプロセスの存続。
- [ドラッグ全試行](drag-trials.json): 各試行の結果、イベント数、ACK数、before/after文書hash、失敗時の座標・対象・選択状態。生証拠の相対パス/hashも収録。

各 `<label>.json` は実行開始時のソースhashとbuild前後のhash、command、時刻、exitCodeを持つ。隣のtxtは個人のホーム/リポジトリパスを匿名化し、ANSIだけ除去したログ。改行や失敗内容は保存する。初期のrunnerはHEADを終了時に取得していたため、その期間はsource hashが実行コードを特定する根拠。後半は開始HEADとendHeadを分離した。コミット前の試験を、記録されたHEADのコミット済み内容と同一だと解釈しない。

## 最終受入のコマンド

`scripts/run-next-round.mjs` で次の順に実行し、各ラベルのファイルを保存した。

```sh
node scripts/run-next-round.mjs acceptance-check-v2 npm run check
node scripts/run-next-round.mjs acceptance-unit-v2 npm test
node scripts/run-next-round.mjs acceptance-build-v2 npm run build
node scripts/run-next-round.mjs acceptance-full-1 npx playwright test --retries=0 --output=output/next-round/acceptance-full-1
node scripts/run-next-round.mjs acceptance-full-2 npx playwright test --retries=0 --output=output/next-round/acceptance-full-2
node scripts/run-next-round.mjs acceptance-full-3 npx playwright test --retries=0 --output=output/next-round/acceptance-full-3
```

ドラッグ最終反復は `acceptance-drag20.json` の `--repeat-each=20 --retries=0`。2ケース×20回で40試行。この反復の後に変更したコードはgate-a.spec.tsのN02/F11テスト・診断だけで、アプリ・ドラッグ回帰・distのhashは最終全体試験と一致する。全体は37件（既存22件＋R1の6件＋R2の2件＋R3の7件）。以前の「Gate A追加15件」は既存22件に含むため足し直さない。

全試験は生成した専用FOLIO_DATA_DIRで実行。既定保存先のF03はappData自体も隔離。ネイティブのファイル選択ダイアログは選択結果だけを注入し、実IPC・Store・ファイル処理を通す。実マウスのdragstart/dropを確認し、合成dropで代替しない。待機は要素/イベント/保存ACKに対する条件待ちで、固定sleep・timeout増加・retries・skipによる合格化はない。

## 途中の失敗の読み方

| 記録 | 内容 |
| --- | --- |
| r1-red-unit / r1-red-electron / r1-red-ipc-confirm | 修正前のタイトル長・UTF-8上限不一致の再現。最後の記録は有効な退避JSONが実IPCでexport成功/recover拒否 |
| r2-observe-original | 初期のテストが既存の末尾空段落を期待値から落としていた。製品不具合としない |
| r2-corrected-observe / r2-real-pointer-red | 期待値修正後の入力未発火と、同位置dropがUndoを消費する問題の切り分け |
| r2-electron | 既存ボードDnDの入力失敗も観測。アプリDB機能は変えず、実ポインターヘルパーを共用 |
| r2-repeat20 / r2-final-repeat20 | 36/40、39/40。失敗分も保存。成功した再実行だけを原因解決の証拠にしない |
| r3-red-electron | DB Escape未閉鎖、modal属性/フォーカス不備の修正前再現 |
| r3-final-electron / r3-native-picker-observe / r3-native-key-events | native selectのEscapeが外側も閉じる経路の再現 |
| full-e2e-1 / 2 / 3 | 最初の全体3回は37/37、36/37、36/37。F11待機前の停止とF02即時selection取得の失敗を保存 |
| f11-f02-observe | F02は診断付き10回で3失敗、F11は10回で未再現。F02失敗後の画面には正しい選択がある |
| f11-f02-green | F02は10/10。F11は実dropとmove ACKを観測したがbubble監視がstopPropagationで遮られ10失敗。試験側のcapture観測へ修正。ラベル名でPASSと解釈しない |
| r3-picker-check | TypeScriptエラーで停止。この失敗後に旧distでE2Eを実行していない。修正後のcheck→unit→build→Electronは別ラベル |

生trace・スクリーンショット・イベントログは `output/next-round/<run>/` に保持し、生成した巨大fixtureやSQLiteとともにGit対象外。ドラッグ診断は専用合成データだけを記録する。共有用のindexと匿名化ログから失敗試行とローカル原本へ辿れる。HTML reporterは次の実行で更新されるため、永続証拠は各runのtrace/画面/JSON/txtとする。

## 未実施と判定範囲

Notionの実操作比較と物理日本語IMEはNOT_RUN、全8項目のNotion比較はUNKNOWN。[固定比較表](../../NOTION-PARITY-BASELINE.md)に公式資料/推定/未確認と手動手順を分けた。合成compositionやinsertTextを物理IME確認済みとしない。

3回の全体試験と20回の対象反復は、このOS・版・合成文書・入力条件での結果。絶対的安定性、すべての旧失敗の原因特定、Gate A全体の完了、Notion全体との一致を宣言する資料ではない。

## 確定した判定

最終全体は37/37、37/37、36/37、全体受入はPARTIAL。最後のF11はページツリーのmousedown後にdragstart/dropがなくmove IPCも空。対象のトップレベルブロック回帰40/40と区別し、ページツリーの根本原因は未特定のまま残す。成功が出るまで全体試験を繰り返して置換することはしない。

開発モードは最初のdev-dialog-smokeが画面起動待ちでFAIL。Viteが新依存の最適化/reloadを記録したことはdev-server.jsonに残すが、単一原因を確定した記録ではない。その後dev-diagnosticはready=true、dev-dialog-smoke-v2はリンク選択/確定/取消/書式/focusの1件PASS。diagnostic-scriptはrunnerが生成する専用FOLIO_DATA_DIRと記録したViteサーバーで実行した補助観測。warm成功をcold startの安定性に読み替えない。
