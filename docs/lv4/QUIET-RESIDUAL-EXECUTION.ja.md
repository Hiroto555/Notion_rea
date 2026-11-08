# Lv4：GUIを起動しない残件の実装・検証

2026-11-08。今回の実装指示に基づき、統合ツリーの `codex/folio-lv4-quiet-residuals-20261108` で作業した。開始commitは `ab48aab830ae9d924829c9fd66e195a8df3ebd70`。**型検査・243ファイル/2,292 Nodeテスト・build PASS。追加127テスト。確認済みLv3、Lv4未認定を維持する。** 実装時の未コミット状態と保存候補の検証を分けて記録した。この文書を含むローカルcommitが今回の保存単位。

結果・コードhash・修正前の再現記録は[検証JSON](validation/lv4-quiet-residuals-20261108.json)、DeepSeekの分担と使用量は[実行記録](validation/lv4-quiet-residuals-model-usage-20261108.json)を参照する。GUI/Electron、headless browser、OS Keychain、native dialog、clipboard、画面収集は今回起動していない。push・workflow作成/実行・master merge・課金/global設定変更も行っていない。

## 今回実装したもの

| 部品                     | 実装と非GUIで確かめたこと                                                                                                                                               | まだ証明しないこと                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 所有processの外部監視    | `watchdog/owned-process.mjs`。自分で起動したgroupだけを監視。期限、取消し、TERM→猶予→KILL、同期停止、子孫残留、pipe終了、出力上限、関係のないNode sentinelの保全を試験  | 実Electron/Keychain promptの停止・回収はNOT_RUN                                                             |
| build artifactのsnapshot | `preflight/artifacts.mjs`。通常fileのbytes/hash、変更・symlink/hardlink・path逸脱・件数/容量上限を検査。remote batchでmain/preload/renderer等の実ファイルhashを収集する | 署名/OS動作/別ホスト実行の証明ではない。Git refだけでdirty sourceを固定したことにしない                     |
| H1の起動前検査           | `preflight/remote-h1.mjs`。実OS identityの既存guard、H1単独、main.cjsのhashと16MiB上限、private data/vault割当、継承同期設定の除去                                      | 対象Macの登録・権限・実起動はNOT_RUN                                                                        |
| 既存batchへの監視接続    | `remote-batch.mjs` と `run-gui-tests.mjs`。固定suite/引数だけを外部監視下へ接続。SIGINT/SIGTERMをAbortSignalへ変換し、秘密を含む任意metadataを拒否                      | 任意command/PIDのCLIは追加していない。現用Macの別ホストguard拒否は維持                                      |
| remote H1 suite/config   | 合成の日英ページを保存→正常終了→新PID→ID/revision/本文hashを再読込で照合するコードを追加。新configも型検査対象にした                                                    | GUI試験自体はNOT_RUN。実Cmd+Q/Dockの代替ではない                                                            |
| Keychainの準備判定       | `preflight/keychain.mjs`。有効switch/argvのmock、private隔離先hashと実アクセス観測・項目・対照条件の欠落を保留するpure関数                                              | 結果はREADY_FOR_OS_PROBEまたはINFRA_BLOCKED。保存/復号のPASSやE2を生成しない                                |
| native観測の判定         | `native-observations.mjs`。IME経路、複数update、信頼できるイベント、正常再起動、新/同PID、予約失敗後の入力保全を検査。未観測はNOT_RUN、合成結果を実操作へ昇格しない     | 自己申告JSONの由来を証明するものではなく、OS操作も行わない                                                  |
| Lv4の12条件台帳          | `gate-ledger.mjs`。全12 gate・必要な証拠種別・候補hash・欠落/失敗/合成OS証拠を照合。現在候補を判定する呼出しではexpected candidateを明示する                            | 入力された証拠の整合性検査で、物理台数の実証・ハードウェア認証・Lv4自動認定ではない。productResultはNOT_RUN |

判定・監視の部品は `scripts/mac-acceptance/` 以下。suiteは `tests/acceptance/macos/`、専用configはrepository直下に配置した。既存の固定Node probeは互換性のため維持し、新しい監視部品も独立した実Node子processで検証した。remote側のOS identity guard本体、依存/lockfile、workflowは変更していない。

## 再現して修正した製品の問題

### 終了予約の書込み前失敗から取消せない

`normal-apply-intent.ts` の永続journalが空でも、書込みに失敗したメモリ上の予約の取消しを「別の予約」と判断していた。ストレージの受付失敗後に終了が保留され、取消しでも復帰できないケースを一時SQLiteで再現した。

自分の選択対象を照合したうえで、実際に空のjournalを「予約なし」と扱う。別IDで同じ対象の予約、破損journal、消費済み予約は保全する。COMMIT後の応答喪失は引き続き結果不明として保留し、対象が同じというだけで自動確定しない。修正前は新5件中1件失敗、修正後は関連62件PASS。

### 起動時に使えない接続設定を保存できる

`sync-connection-vault.ts` は、既存の端末識別sidecarと一致しない設定でもpending-restartとして保存していた。暗号化前とtransaction内の書込み直前に既存bindingを再検査し、不一致時は旧profile・暗号文・receiptを保持して保留する。暗号化中にsidecarが変化するケースも再現して防いだ。

修正前は新4件中3件失敗。書込み直前の追加反例も修正前に失敗した。最終の新5件と既存vault8件は全13件PASS。同じ端末のtoken更新は継続でき、コピー/破損/リンクのsidecarは保留する。

旧環境変数で接続済みのDBを初めてUI設定へ移す場合も、既存bindingを自動採用せず保留する。旧方式からの自動移行は追加していない。試験の暗号化は合成AES portであり、実Keychainの証拠ではない。

## 統合レビューと検証

DeepSeek実モデル `opencode-go/deepseek-v4.1-flash` / `high` を、別々の一時コピーで10並列に投入し、その後2つの限定修正を再委譲した。最大同時CLI数は実測10。providerのハード上限は未確認で、「10がサービスの絶対上限」とは扱わない。shell、GUI、再委譲は許可せず、親が差分を選別して試験した。担当外の変更は0件だった。

CLI引数と書込み権限の初期失敗、停止・再開を含め全履歴を保全した。使用量は10 sessionのexportを重複計上せず集計し、途中停止した20メッセージの最終usageは不明としている。報告値を請求額・節約率・利用枠残量へ換算しない。

Codexが修正した主な差分:

- 任意のbindingや後から変更されたobjectをwatchdog metadataへ保存できた問題。固定schemaで検査・複製し、秘密fieldと未束縛のremote観測を拒否した。修正前に2件の失敗を再現。
- IME updateをちょうど1回に限定していた判定。複数updateを許容し、未収集の観測を製品不具合と推測せずNOT_RUNにした。修正前の失敗を再現。
- artifactの読取り上限、候補SHA-256の形式、null PIDが停止確認に見えてしまう試験、remote環境の型宣言を補正した。

実装段階の `npm run verify:quiet` は **型検査・242ファイル/2,290テスト・build PASS**（117.86秒）。29コードファイルのhashは前後一致。既存のVite import/chunk警告は残る。rawログとモデルexportは検証JSONの専用一時領域だけに置き、repositoryへDB・trace・生会話・秘密を追加していない。一時領域の永続保存は保証しない。

## 次のOS受入で使う入口

**今回このコマンドは実行していない。登録済み別Macで明示許可がある場合だけ使う。**

```text
npm run test:e2e:batch -- --mac-acceptance-plan /PRIVATE_TEMP/PLAN.json
```

受け付けるのは上記のflagとplan pathだけで、自由なPlaywright引数は付けられない。planは実測したsource/artifact/harness、登録host、実際の一時parent、`caseIds=[MAC-H1]`、worker1/retry0/期限を固定する。人工fixtureを実測planへ転用せず、現在のbuildを別Macへ転送した後にもhashを確認する。このMacはCI変数をコピーしても拒否される。

H1 suiteは実測したPID・ID・revision/本文hash・有効mock switchを診断JSONに記録する。stock Playwrightのmock Keychainは外しておらず、診断JSONを既存evidenceSchemaの観測済みPASS reportに変換しない。batchやwatchdogの終了0も、Lv4認定や実Keychain合格ではない。H2/H3のmockなし起動・private Keychainへの実アクセスは、対象Macのidentity/隔離条件を確認して接続・受入する。

## 現在の残件

**製品srcを2ファイル修正したため、前候補のGUI240件PASSは履歴として保持し、新候補のGUI合格へ流用しない。** 新候補のGUI再受入、実IME、実Keychain、Dock、終了予約失敗後のnative再表示、pickerの親フォルダ/権限拒否/待ち中変更、物理Mac A/B＋Sの実SSH・切断・sleep・完全server復元・実機性能はNOT_RUN。以前のIME入力経路はINFRA_BLOCKEDのまま。

別Macの台数/OS/占有枠、runner登録、GUI/Keychain権限、SSH/復帰担当は未確認。必要な機材は[計画](MAC-P05-RESOURCES-AND-SCOPE.ja.md)、以前の実測は[GUI記録](MAC-LOCAL-GUI-ACCEPTANCE-20261108.ja.md)を参照する。証拠を12条件へ揃えてからLv4を判定し、masterへのmergeは別判断とする。

## 保存前の最終レビュー

登録runnerの一時parentがOS標準の一時領域と異なる場合に、監視とplan配置の検査が拒否する不整合を修正した。既存の実OS identity guardで承認された `plan.tempParent` を配置検査と内部監視へ渡す。通常のNode probeは既定のOS一時領域に限定したままで、親そのもの・兄弟領域への逸脱も拒否する。CLIから任意の一時parentを指定する経路は追加していない。

追加2テストは修正前に両方失敗し、修正後は関連27件PASS。保存候補全体も再検証し、**型検査・243ファイル/2,292 Nodeテスト・build PASS**（108.94秒）。30コードファイルのhashは検証前後一致。今回のレビューで製品srcの追加変更はなく、追加GUI・実Keychain・物理2台はNOT_RUNのまま。現用Macの別ホスト実行拒否、workflow・依存・原本masterを維持し、未解決のcommit阻害事項はない。

保存候補のコードhash・再現・再検証は[最終レビュー記録](validation/lv4-quiet-residuals-final-review-20261108.json)を優先する。[実装段階の記録](validation/lv4-quiet-residuals-20261108.json)にある2,290件と29ファイルのhashは修正前の段階の証拠で、保存候補と混同しない。
