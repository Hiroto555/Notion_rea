# このMacでのGUI受入：2026-11-08

利用者の「TVを見るので、溜まっていたappを起動しての検証を整理して行っていい」という明示指示に基づく、今回限りのローカルGUI受入。**選定241件のうち240件PASS、実日本語IMEの1件はINFRA_BLOCKED。確認済みLv3、Lv4未認定を維持する。** 今後のGUI起動に対する包括許可にはしない。

機械集計・case一覧・ログhashは [結果JSON](validation/mac-local-gui-20261108.json)。別ホストで行うMAC-P05と必要な機材・権限は [次の最小PoC計画](MAC-P05-RESOURCES-AND-SCOPE.ja.md) に分けた。

## 対象と分離

- 作業は統合ツリーの `codex/folio-mac-gui-acceptance-20261108`。開始HEADは `b19ecbe1fd9700575d75474c5e08573ffcbb75d9`。GUI実行時のharnessは未コミットだった。利用者の最終レビュー・保存指示を受け、今回のharness・結果文書を、この文書を含むローカルcommitへ保存する。結果JSONの `harnessStateAtRun` はGUI実行時点の状態を表す。
- 製品受入基準 `bd65b73b492b95b8b9a2a1f73ad9a5e114c509dc` に対して `src`・package/lockfile・workflow定義の差分なし。別ホストguard/schema/validator/watchdogは `b19ecbe` から変更なし。このMacの拒否を緩めず、別の明示opt-inを持つローカルfixtureを使った。
- 各段階の前にbuildし、起動入口はすべて `npm run test:e2e:batch`。worker 1、retry 0。native操作はそのbatchが所有するElectronにCUAから送った。実データ・普段のFolioには接続していない。
- data/vault/reportは、所有者専用のOS一時領域 `folio-local-gui-20261108-7mfn4v6x` 以下。`FOLIO_DATA_DIR` とcredential先をfixtureごとに分離し、継承した同期設定を除去した。MacにLinux用 `--no-sandbox` を付けない。
- macOS 26.6.2 / arm64、Node 24.20.0。実行中のmainからElectron 45.0.0 / Chromium 156.0.8078.48 / `--use-mock-keychain=true` を観測した。unpackaged Electronの `app.getVersion()` をFolioの版や実Keychainの証明にしない。
- 原本masterは `e269137f191081cabc0f05aa03ec68339ce413c2` のまま。push、workflow作成/実行、master merge、課金・OS保護設定の変更は行っていない。

## 選定した最終結果

| 段階             | 件数・結果      | 範囲                                                                    |
| ---------------- | --------------- | ----------------------------------------------------------------------- |
| 01 保存smoke     | 4 PASS          | 保存・入力保護の入口                                                    |
| 02 共通GUI       | 213 PASS        | 編集、DB/record、移動/drag、保存、復旧、backup、表示等                  |
| 03 復旧・同期IPC | 19 PASS         | M1回収10、M3接続2・再起動適用2・転送5。picker返答は代替、Keychainはmock |
| 06 native OS     | 4 PASS          | Cmd+Q、赤ボタン、実file picker、実Cmd+C/V                               |
| 07 実IME         | 1 INFRA_BLOCKED | 入力source/操作経路が成立せず、trusted compositionを観測できなかった    |

最終選定分はskip 0 / retry 0 / flaky 0。ただしIMEはPlaywright上では **failed 1 / exit 1** のまま保持し、原因を実行基盤の不足と分類した。IME段階のrunnerにも `--max-failures=1` による停止通知が残る。241/241 PASSとは報告しない。

native4件の合格後にIME1件を追加し、IMEだけを個別実行した。前4件のtest本文は変更していない。結果JSONのharness hashは最終quiet時点のもので、失敗した初期harnessのhashと取り違えない。

元の一覧238件から、Linux固有backendのSecret Service/basic_textの2件を対象外とし、native 4件とIME 1件を追加した。`--list` の成功は実行合格として数えていない。

実際のfixtureによる240 PASSの内訳は、Electron製品UI/IPC（障害注入等を含む）206、応答を代替したElectron表示2、追加native 4、Chromium表示28。Electron計212、Chromium計28。以前のLinux project名をそのまま流用せず、`db-ui-legacy` は実Electron、`record-page-presentation` はChromiumとして数えた。合成composition・代替picker・mock KeychainはOS実操作と区別する。

## native操作で確認したこと

| 操作              | 観測と限界                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 保存処理中のCmd+Q | 保存IPCを保留した状態で実キーを送信。trustedなbeforeunloadがprevented、同じPIDと入力が残った。保存を解放し、必要ならreceipt照会後に保存済みへ戻した                                         |
| 保存後のCmd+Q     | exit 0 / signalなし。PID `79697 → 79837`、同じpage ID・revision 3・本文hashを再読込で照合                                                                                                   |
| 赤ボタン          | native closeボタンでexit 0 / signalなし。PID `79842 → 80039`、同じpage ID・revision 3・本文hashを再読込で照合                                                                               |
| file picker       | 実ダイアログの取消し後も元ページを保持。再度開き、OSのフォルダ移動から一時Markdownを選び、合成内容だけをimport。元ページ不変                                                                |
| Cmd+C/V           | 合成の日英canaryを実OSキーでコピーし、同じeditorへpasteして2個になることを確認。Electron ClipboardItem APIで読み出せた以前のformatをfinallyで書き戻した。OS全formatの完全復元保証とはしない |

Cmd+Q/赤ボタン後の再起動はharnessによる新process起動であり、**Dockからの起動ではない**。終了時予約のCOMMIT失敗による同PID再表示、native親フォルダ選択・権限拒否・picker待ちの状態変化も今回のnative合格には含めない。

日本語IMEはnativeキーとひらがな切替shortcutを試したが、入力は合成canary `nihongo`、compositionイベントは空だった。日本語入力sourceが選択された証拠がなく、Folioの日本語IME不具合とは推定しない。OS設定やTCCを書き換えて通していない。変換確定・変換中の同期/閉鎖/移動は引き続きNOT_RUN。

## 初期失敗とharnessの修正

phase 04/05は各 **failed 1・未実行3** で停止した記録を残した。最終集計から分けており、全試行履歴をskip 0とは扱わない。

1. phase 04：閉鎖拒否の短いtoastがnative操作完了markerを待つ間に消えた。persistentなtrusted/defaultPrevented記録と同PID・入力保持のassertionへ変更した。
2. phase 05：正常終了後にPlaywrightの破棄済みapp handleからprocessを取得して失敗。OS操作前に所有ChildProcessを保持し、exit code/signalを照合するようにした。
3. phase 06：上記4件すべてPASS。製品 `src` の修正は行っていない。

native close後のCUA状態取得でElectronのbare default_appが1度再表示された。実データを開かず、その補助windowだけを閉じた。今後のcontrollerは終了後にgetApp/getAXを呼ばず、保持したPIDの終了と次の所有cueを待つ。終了後の再表示を製品の再起動成功に数えない。

## 最終quiet検証と証拠

GUI終了後、同じ7個のharnessファイルのhashを固定して `npm run verify:quiet` を実行。**型検査・232ファイル/2,165 Nodeテスト・buildすべてPASS**。所要103.0秒。既存のVite動的/静的import混在・chunkサイズ警告は残る。harnessは最終quiet検証から変更なし。

ローカルfixtureは `FOLIO_LOCAL_GUI_BATCH=1` と `FOLIO_LOCAL_GUI_DATA_ROOT` の両方を要求し、batch子processの完全一致opt-inと、所有者専用のOS一時directoryを検査する。GitHub Actions/Linux CI・dev/debug設定の混在を拒否する。native suiteは `playwright.local-native.config.ts` で分離し、OS controllerが一時 `native-control/current.json` のnonce/phase/PIDを確認して操作後に同nonceの `.done` を返す対話型の試験である。markerは操作送信の連絡にすぎず、成功はapp状態と保存内容のassertionで決める。通常のNode試験やLinux suiteから自動起動しない。

rawログ、invocation、Playwright JSON、native再起動hash、IME probeは結果JSONの `temporaryEvidenceRoot` に置いた。一時領域なので永続保存は保証しない。repositoryには集計とhashだけを保存し、DB・trace・clipboard内容・実ファイル名を追加しない。最終確認時、統合ツリー由来のElectron processは0だった。

見た目は合成welcome画面のlight screenshotを1枚目視した。1440幅で同期設定ラベルが2行になるが、可読・操作可能だった。全画面の目視完了とは扱わず、現状維持も有効とする。

## 残す受入

| 項目                                                                              | 状態                                |
| --------------------------------------------------------------------------------- | ----------------------------------- |
| 実日本語IMEの入力経路                                                             | INFRA_BLOCKED                       |
| 変換中の入力保護、Dock起動、予約確定失敗後の同PID再表示                           | NOT_RUN（native条件）               |
| native親フォルダ選択、権限拒否、picker待ちの状態変化、配列/アクセシビリティの網羅 | NOT_RUN                             |
| 実Mac Keychainの保存・別process復号・更新・無効化・利用不能時の保留               | NOT_RUN。今回のmock合格で代替しない |
| 別ホストMAC-P05、物理Mac A/B＋S、実SSH・sleep・回線変更・server完全復元           | NOT_RUN                             |
| Lv4最終認定・master merge                                                         | 未実施                              |

次の最小単位は、[機材・権限計画](MAC-P05-RESOURCES-AND-SCOPE.ja.md)のH1（別ホスト起動/保存/正常終了/再読込）。今回のローカル結果を別Macの実測や実Keychain証拠へ変換せず、各段階の必要条件と未実行を維持する。

## 保存前の最終レビュー

利用者の指示により、追加GUIなしでローカル保存前のレビューを行った。ローカルopt-inとprivate temp分離、Linux fixtureとの条件分岐、所有processの終了/再起動、native操作のassertion、結果資料と残件の境界を確認し、commitを妨げる問題は見つからなかった。

選定241件をraw reportと1件ずつ照合し、240 PASS / IME 1 INFRA_BLOCKED、初期harness失敗2回の記録、native再起動/IME probe・各ログ・build artifactのhashを確認した。7個のharnessは最終quiet時点から変更なし。既存の型検査・2,165 Nodeテスト・buildの合格証拠を再照合し、試験は再実行していない。保存に向けた修正は実行時/保存時の状態表記とrunner停止通知の補足だけで、実行コード・製品コード・別ホストguard・workflow・原本masterは変更していない。
