# Mac PoC：非GUIの基盤実装

2026-11-08。利用者の具体的な実装依頼を受け、既存の統合ツリーでguard・証拠schema・validator・外部watchdogのNode検証を実装した。作業branchは `codex/folio-mac-poc-quiet-20261108`、開始点は文書保存commit `e6a019b4bedf133f7269a721510c8964f13f55ee`。製品受入基準は `bd65b73b492b95b8b9a2a1f73ad9a5e114c509dc` のまま。

製品src・依存・既存GUI入口・workflowを変更しない。このMacではNodeだけを起動し、GUI/Electron/headless browser/Keychain/native dialog/clipboard/画面収集/VM/viewerを使わない。原本master・実データ・課金設定・mergeは対象外。今回の合格は試験基盤のNode検証であり、M3受入待ち・Lv3確認済み・Lv4未認定を維持する。

## 実装と境界

| 対応        | ファイル                                         | 実装したこと                                                                                                                                                                                       |
| ----------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MAC-P01     | `scripts/mac-acceptance/policy/guard.mjs`        | 現用Macのhostname hashを優先拒否。登録済みDarwin arm64 host、host種別、runner名、2つの完全一致opt-in、debug/dev拒否、実際の一時parentとの一致を確認。毎回新規のdata/vault/evidence領域を0700で作る |
| MAC-P01/P03 | `scripts/mac-acceptance/policy/schema.mjs`       | Zodによる実行可能な単一schema。選定case、source/artifact/harness/merge ref、host/VM/物理識別、期待件数・結果・参照ファイル・Keychain観測を明示する                                                 |
| MAC-P03     | `scripts/mac-acceptance/validate.mjs`            | 別途固定したplanとreportを照合。canonical plan digest、全選定case、件数、由来、観測条件、証拠の実ファイルbytes/hashを検証する読み取り専用CLI                                                       |
| MAC-P04     | `scripts/mac-acceptance/watchdog/node-probe.mjs` | 親Nodeの期限監視、独立process group、TERM→猶予→KILL、groupとpipeの終了確認、途中/最終metadata保存。実行対象は同梱の固定Node workerのみ                                                             |

`tests/acceptance-metadata/` は既存のVitestに含まれる。新たなnpm scriptやworkflowを必要としない。MAC-P02の追加モデル相談とMAC-P05の実Electron/batch/別ホストへの接続は今回行っていない。

## guardの契約

- 実行側の `assertMacExecution` はOSからplatform/arch/hostname hashを取得する。CI環境変数のコピーでは現用Macの拒否を上書きできない。Node試験だけはpureな `evaluateMacPolicy` に人工のhostを渡す。
- GitHub-hostedは `GITHUB_ACTIONS=true`、`CI=true`、`RUNNER_OS=macOS`、`RUNNER_ENVIRONMENT=github-hosted` と登録runner名を要求する。専用Macは物理識別を登録したself-hostedを要求する。機材やrunnerはまだ登録・作成していない。
- `FOLIO_MAC_ACCEPTANCE_OPT_IN=1` と、既存batch入口の `FOLIO_GUI_TEST_OPT_IN=1` の両方を必要とする。guardはGUIを起動する機能を持たず、この環境変数を設定して実行する作業も今回行わない。
- hostedのparentはcanonicalな `RUNNER_TEMP`、専用Macでは実際の `os.tmpdir()` と一致させる。data/vault/evidenceは新規領域のみ。単に `FOLIO_DATA_DIR` を隔離したことをKeychainの隔離証拠にはしない。
- 一時領域検査はcanonical child・所有者・0700を確認し、外へ出るsymlink、親自身、兄弟、相対path、公開権限を拒否する。許可範囲内のabsolute pathやcanonical aliasは受け入れる。

これは信頼したharnessの運用guardであり、OS sandbox・ハードウェア証明・敵対する同一UIDへの防御ではない。hostname変更時には保護host登録の見直しが必要。環境変数や自己申告の物理識別だけで実機2台を認定しない。

## 証拠schemaとvalidator

選択できるcaseはMac計画の `MAC-H1`（起動/保存/正常終了/新PID再読込）、`MAC-H2`（実Keychainの独立process復号）、`MAC-H3`（利用不能時の保留/暗号文維持）。既存L4番号の定義は変えず、これらだけでL4のgateを合格にはしない。

- planは選定caseを1〜3件で固定し、worker1/retry0/期限と製品commit・source tree・build inputs・artifact・harnessを分けて保持する。PR merge refを製品commitへ読み替えない。ローカル未commitのharnessもtree digestで識別する。
- reportは全選定caseを一度ずつ含める。期待/実行/PASS/FAIL/NOT_RUN/INFRA_BLOCKED/UNRESOLVED/skip/retry/flakyの件数と最終statusを再計算する。PASSにはskip/retry/flaky0を必要とする。
- `origin=synthetic` はE1のみで、validatorが正常でも製品の受入候補にしない。観測済みMac PASSはmockなしE2を必要とする。このPoCは単一hostに限定し、E3または物理2台の主張を拒否する。物理2台は別契約・別受入のまま。
- H1は正常終了・異なるPID・保存revision hash・本文と再読込hashの一致を確認する。入力による閉鎖拒否、予約失敗の同PID再表示、実Cmd+Q/Dockは別の未実行caseであり、このH1で代替しない。
- H2/H3は有効なmain switchとargv、実アクセスしたprivate Keychainのpath hash、項目識別hash、対照条件、cold/warmのPID・項目状態・API結果を別に記録する。H2は独立したcold processの復号、H3はcold/warmの結果を分けて記録し、実際にAPI利用不能を観測した経路での保全を要求する。warm cacheの継続を失敗とは決めず、lockという状態やwarm cacheだけでは利用不能の証拠にしない。
- 原因不明timeoutは `UNRESOLVED/TIMEOUT_UNKNOWN`。原因判明後は期限到達の事実を保持したまま、`INFRA_BLOCKED/ENVIRONMENT` または `FAIL/PRODUCT` として記録できる。期限到達には実行済みのcaseを必要とする。watchdogの期限到達、強制停止、異常終了、残留processの掃除を製品正常終了へ読み替えない。validator自体は原因を推定しない。
- 参照先は最大1MiBの通常file。相対path、canonicalなroot内、非symlink、非hardlink、実bytes/hash一致を要求する。読取り量も上限で打ち切る。診断は提出値や秘密tokenを出力しない。

読み取り専用のCLI（3引数はすでに存在するファイル/領域を指定）:

```text
node scripts/mac-acceptance/validate.mjs PLAN.json REPORT.json EVIDENCE_ROOT
```

終了コード0は「観測済み全件PASSのmetadataと参照fileが整合し、人の照合へ進める」、1は不正、2は整合するがsynthetic/未実行/非PASS/参照file未検証。`eligibleForReview` と製品の最終判定は別で、返す `productResult` は常に `NOT_RUN`。fileが本当にOS観測から生成されたかを暗号学的に証明するものではない。人工のobserved fixtureもvalidatorの分岐検証用であり、Macを操作した証拠として保存・集計しない。

## 外部watchdogのNode検証

固定workerは正常終了・exit7・応答停止・同期的なevent loop停止・SIGTERM無視・子孫の停止・親だけexit0で子孫残留・出力上限を再現する。任意のcommand/script/PIDを受け付けず、外部から渡したPIDを停止対象にしない。子孫は所有するprocess groupだけを停止し、関係のないNode sentinelの生存も確認する。

中間/最終fileには所有PID、観測した子孫PID、固定enumの最後のphase、期限、signal、終了結果、stdout/stderrのbyte数とhashだけを残す。raw stream・argv・環境・秘密を保存しない。stackは収集しておらず `NOT_COLLECTED`。証拠領域は関数が勝手に消さず、試験側が自分の一時rootだけをfinallyで削除する。

`AbortSignal` による取消しも所有groupだけを停止する。将来のbatch接続側がSIGINT/SIGTERMをAbortSignalへ渡す必要がある。監視process自身のSIGKILL、別sessionへ逃げる敵対的子孫、ホスト停止の封じ込めはこのNode PoCでは保証しない。OS sandboxや常時稼働監督の代替ではない。

## 検証と次の境界

初回実装時の `npm run verify:quiet` は型検査・231ファイル/2,155テスト・buildの全段階がPASS。新規77テスト（policy 7、evidence 59、watchdog 11）を含む。その検証中と終了後の9コードファイルのSHA-256一致を確認した。初期の型検査失敗と修正後の成功を分けて [初回検証記録](validation/mac-poc-quiet-20261108.json) に保存した。Viteの既存のimport/chunk警告は残る。

初回検証後の最終レビューで、原因が判明したtimeoutまでUNRESOLVEDに固定していた不整合を修正した。追加回帰試験で環境要因/製品要因の2件が修正前に失敗することを再現し、未実行caseのtimeout拒否も含め4件を追加。関連81テストは全件PASS。初回の77件とは対象のhash・件数を分ける。全体再検証とレビューの結論は [最終レビュー記録](validation/mac-poc-final-review-20261108.json) を参照する。

レビュー修正後の `npm run verify:quiet` も型検査・231ファイル/2,159テスト・buildがすべてPASS（skip 0、新規81件）。この最終候補の9コードファイルのhashも検証の前後で一致した。今回の非GUI基盤のレビュー範囲では、未解決のコミット阻害事項はない。実Keychainや物理端末の受入完了を意味しない。

変更はこの統合ツリーの作業branchへローカルcommitで保存し、pushしない。初回検証JSONの `localChangesUncommitted` はその検証時点の状態。Macの実起動・実Keychain・実IME・Cmd+Q・native picker/clipboard・物理Mac2台・workflowはすべて **NOT_RUN**。

次に実行先やGUIを接続するならMAC-P05として別に範囲を固定し、既存 `test:e2e:batch` の中へ接続する。新規workflowの作成/実行、機材/権限設定、このMacのGUI、課金変更、master mergeをこの実装から自動的に進めない。
