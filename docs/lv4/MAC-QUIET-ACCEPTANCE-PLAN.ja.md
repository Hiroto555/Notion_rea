# Folio：このMacの操作を奪わない最終受入計画

2026-11-08追記：具体的な後続依頼に基づく[非GUIのguard/schema/validator/watchdog実装](MAC-POC-QUIET-IMPLEMENTATION.ja.md)を追加した。以下は当初計画。MacのGUI/実Keychain/別ホスト/workflowは引き続きNOT_RUN。

2026-11-08、計画のみ。製品候補 bd65b73（darwin/arm64、Electron45.0.0、Node24、lockfileのPlaywright1.64.1）。M2/A0〜A7とLinux GUI238件は受入済み。Mac/物理2台の追加試験はすべてNOT_RUN。現用MacのGUI、workflow追加・実行、環境構築、署名/秘密の設定、製品改修、master mergeは今回行わない。

## 結論と配置

GitHub Actionsを司令塔にし、実行先を「GitHubのMac」と「別の専用Mac A/B」に分ける。実機が必要な試験もself-hosted runnerから指示できるため、このMacでウィンドウを出す必要はない。このMacはNode/CLIの管理・ログ確認だけ。自動操作と画面収集は別ホスト内で完結し、必要な初期操作はそのMac側で行う。

| 役割 | 必要なもの | 担当する確認 |
|---|---|---|
| 現用Mac | 現状のまま。新たなGUI/VM/遠隔画面viewerを起動しない | Codex管理、Opus相談、結果の照合 |
| GitHub-hosted macOS | まずarm64標準runner 1 job。macos-15または26を対象OS決定後に固定。実image版も記録 | Darwin上のbuild/起動/保存・復旧、終了イベント、可能なら実Keychain基本系 |
| 専用Mac A | 現用Macとは別の物理arm64 Mac、専用testユーザー、GUIログインセッション | 実IME・Cmd+Q・赤ボタン・Dock・picker・Keychain許可/拒否 |
| 専用Mac B | Aとは別の物理Mac、同じ候補artifactと独立data/vault/client ID | 双方向同期・競合・切断・sleep |
| サーバーS | 試験中常時稼働する別Linux等。serverはloopbackのみ、A/BからSSH転送 | 認証・履歴/添付・完全backup/restore。client sleepから独立 |

現用Macを試験端末に数えない条件では、ほかに物理Mac2台が必要。別Mac1台＋VM/2プロセスでは事前確認まで。クラウドのmacOS VMは2物理端末の証拠へ換算しない。クラウドの専用物理Macを候補にする場合も、別個の物理ホストと対話セッション・復帰手段を確認してから採否を決め、今回は契約/作成しない。

## 試験の分担

○=実行対象として計画、△=起動/権限PoC後の限定確認、実行済みの意味ではない。

| 項目 | GitHub-hosted macOSで先に行う分 | 別Mac/物理2台で最終確認する分 | 必要な準備・終了条件 |
|---|---|---|---|
| build/通常保存・復旧 | ○ Darwin arm64のcheck/build、△実Electron起動→保存→再起動 | 同じartifactの起動・保存を別Macでも確認 | OS/arch/SHA/実バイナリhashと一時data/vaultを固定。未保存/復旧入力の保全 |
| 通常/競合予約・終了イベント | △ app.quitとwindow-closeのイベント、windowless起動で一度だけ適用 | 実Cmd+Q/赤ボタン/取消し、終了失敗時の再表示、Dockからの新規起動/activate | open中は適用0、閉鎖成功後だけ予約確定し次回起動で1回適用。Cmd+Q等をapp.quit試験へ置換しない |
| 実Keychainの基本系 | △ mockなし・隔離Keychainで保存/別process再起動/復号/更新/無効化 | 対象アプリidentityでの永続化と許可/拒否UI | Playwright標準loaderの--use-mock-keychainを除いた別harnessを既存batch入口内に用意。FOLIO_DATA_DIRだけではKeychainは隔離されない |
| Keychain利用不能・コピー | △ 独立起動で暗号化不能/拒否を観測できる範囲 | cold/warm起動を分け、実利用不能時の保留・別Mac/コピーDBの秘密分離 | ロック操作だけで利用不能と仮定しない。cached keyも観測。無期限のprompt待ちはPASSにせず、環境要因か製品の応答不良かを切り分ける |
| 日本語IME・数値・Undo | 合成compositionの既存結果は維持。実IMEの代替にしない | 実日本語入力、候補選択、変換/数値途中の同期・終了、入力/Undo保持 | 入力ソース/JIS・USを記録。人がOS操作を行う最小batchを用意 |
| native picker・権限・focus | △ GUIと許可が使えるなら実pickerの予備確認。応答mockと分ける | 実選択/取消し/権限拒否、待ち中の対象変更、focus復帰 | 専用素材/選択先、Automation/Accessibility等の必要許可を別Macで確認 |
| clipboard/キー操作 | △ 隔離runnerのOS clipboard API/roundtrip | 実Cmd+C/V、リッチ内容、focus、既存keyboard契約 | Universal Clipboard/共有clipboardを使わない試験アカウント/設定。秘密でなく合成canaryだけを使う |
| 双方向の全内容・競合 | ○ 既存Linux/Nodeの論理確認を利用、△同じMac上の複数processでDarwin回帰 | 物理A→B/B→A、本文/階層/DB/record/添付/ごみ箱/履歴・競合候補 | 独立client ID、同じworkspace、manifest/ID/revision/asset hashを比較。receipt等は端末固有の期待を別定義 |
| 実SSH・切断・sleep | tunnel停止/応答断の模擬は先行確認 | 物理A/Bで実SSH、回線変更、sleep/wake、再開・重複適用0 | server Sを常時稼働。端末上のharnessが通信断中も証跡保持。現地担当/検証済みwake等の復帰手段を先に用意 |
| server完全復元・新登録 | ○ 復元/fresh epoch/全旧device失効の既存ロジック試験 | 復元後に物理A/Bで新client copyへ明示recover | 原本・backup保持、新規先/新ID。旧端末拒否とM1回収コピーの恒久同期保留を確認 |
| 実起動/表示・通信性能 | CIでは傾向の計測 | 対象実機で固定fixtureの実起動・表示・転送時間を記録 | 閾値/回数を実行前に固定。Node/VMの時間を実機保証にしない |

## 証拠の種類と実行先を別に記録する

各caseに、元のL4番号・実行先（hosted Mac/Mac A/B/S）・証拠種別・物理端末数・mock有無・候補/artifact hash・期待件数/実行件数/skip/retry/flaky・結果を保存する。macOS VMでも実OS APIの確認になり得るが、物理2台とは数えない。

- E1：Node/合成イベント/論理通信の証拠。
- E2：実macOS API/デスクトップの証拠。VMか物理Macかも明記する。実IMEやキー/許可UIはOS操作を実施したcaseだけ。
- E3：別々の物理Mac A/B＋サーバーSでの証拠。

| 元のGate | 最終判定へ追加する証拠 |
|---|---|
| L4-01 | E1回帰＋E2 Macアプリ回帰 |
| L4-02、L4-12 | E3の全内容双方向/実SSH/sleep等 |
| L4-03、L4-07、L4-08 | E1故障試験＋E3の再送/添付/復元運用 |
| L4-04、L4-05、L4-09 | E1境界試験＋E2の実IME/終了/実Keychain |
| L4-06 | E1保全＋E2勝者/回収UI＋E3競合の実運用 |
| L4-10 | 固定fixtureの物理Mac上E2性能＋E3実通信。VM速度を実機保証にしない |
| L4-11 | E2状態表示/接続設定＋E3で運用手順を再現 |

これは今後集める証拠の対応表。Mac分の合格を示す表ではなく、元のL4-01〜12の定義を変更しない。

## 先に用意するもの

| 準備 | 現在の確認状態 | 用意する内容 |
|---|---|---|
| Mac A/B | 台数・利用枠は未確認 | 専用/借用等。2台の物理識別、arm64/OS、占有できる時間 |
| サーバーS・SSH | 実試験環境は未確認 | always-onの試験server、private SSH鍵・known_hosts、A/B個別のloopback転送。2つのhosted jobのlocalhostは別物 |
| GUI権限 | NOT_RUN | 別MacのtestユーザーでGUI login。必要なAccessibility/Automation/画面収集許可はそのMac側で初期設定。SSH daemon/serviceだけでGUI可とはしない |
| Keychain・署名 | 現行packageに署名/公証設定なし | 一時Keychain/専用ユーザー。bundle IDと署名方針を固定。同じartifactでまず検証し、再buildを跨ぐidentityは別判定。証明書購入/公証を無条件にLv4要件へ追加しない |
| 操作担当・復帰 | 未確定 | 実IME/許可拒否/sleepは必要な範囲だけ人が操作。screen-controlは別Macで行い、このMacにviewerを出さない |
| テスト素材・観測 | 合成fixtureあり、Mac manifestは未作成 | 既存rich fixture、最大容量fixture、コピー/競合/復元シナリオをL4-01〜12へ対応。候補・OS・binary hash・件数を記録 |
| CI権限とコスト | Mac workflowは未作成 | 利用者が実行範囲を固定/対象SHA・artifact固定/worker1、MacごとのGUI排他。self-hostedは信頼した対象コードだけ実行。Devin枠とActions枠を区別し、課金設定は変更しない |

## 起動と試験の分離条件

- 現行はLinux専用workflowだけ。Mac用の実行先ガード/一時領域/configは新規作成が必要。GitHub-hosted macOSまたは登録済みの専用A/Bだけを許可し、現用Macはrunnerにしない。既存batch入口内で実行し、直接Electron起動でローカル制約を迂回しない。
- 実Keychainは、プロセスのargvだけでなくmain内の有効な `app.commandLine` のmock switchも確認する。`getSelectedStorageBackend()` はLinux専用なのでMacの判定に使わない。hosted予備試験は指定した一時Keychainへの実アクセスと対象項目の作成を確認し、想定外のKeychainへ保存していないことを照合する。実機最終確認は専用testユーザーのKeychainと対象artifactのidentityで行う。
- 同期safeStorage APIの入力待ちはmain内timerでは監視できないため、アプリ外のwatchdogを計画する。hostedで権限prompt/待ちが出たら限定時間で所有processを停止・証跡保全し、原因によりINFRA_BLOCKEDまたはFAILへ分ける。promptが絶対に出ないとは保証しない。拒否/許可の実UIは専用Mac側の操作caseとして記録する。
- 終了はPIDを観測する。正常終了→Dockで新PID、終了記録失敗による再表示→同じPID、入力保護による閉鎖拒否→同じwindow/入力保持を別caseにする。activateの再利用経路は実際に到達可能な状態を確認してから選定する。
- sleep/回線変更区間は、A/Bのローカルharnessにシナリオ・期限・ログを先に配置する。Actionsは配布/開始と復帰後の回収を担当し、切れる端末上のrunner/SSH接続の維持に合否判定を依存させない。別の常時稼働制御元と、現地担当または検証済みwake等の復帰手段を用意する。
- artifactの転送方法とquarantine/Gatekeeper状態、署名identityと転送後hashを記録する。未署名開発artifactの結果を配布/公証の合格へ置換せず、全体のOS保護設定を自動で緩めない。

## 進める順序と停止地点

1. GitHub Mac起動可否を1job・2〜3 smoke case・上限15分程度のPoCで確認する案。GUI session/実app起動/正常終了と、mockなしKeychainの可否を分けて判定する。利用枠/対象OSを実行前に確認。今回はworkflow作成も実行もしない。
2. PoCが使えた範囲へDarwinの製品回帰を移す。画面回帰と実Keychainを別suiteにする。機材未準備でもここを次の一区切りにできる。失敗をGUI非表示やmock追加でPASSへ変えない。
3. 専用Mac Aで最小のOS操作batchを行う。現行実装はwindow-all-closedでapp.quitするため、赤ボタン後の常駐を合格条件にしない。正常終了→Dockから新規起動と、終了保留時の再表示を別に確認する。
4. 専用Mac A/B＋Sで物理2台のシナリオを順序管理して実施する。AのsleepでB/Sや監督が一緒に止まらない構成を選ぶ。
5. 元計画のL4-01〜12に証拠を対応させ、Mac固有と実機分を全て照合した後にLv4を判定する。L4番号の意味は変更しない。master mergeは別判断。

各段階は、選定した全caseのPASS・skip/retry/flaky0が終了条件。環境不足はINFRA_BLOCKED、製品不具合はFAIL、未実行はNOT_RUNで残す。選定外は事前に理由付きで区別し、Mac未実施を既存Linux PASSへ混ぜない。timeoutの原因不明はPASSにしない。製品/ハーネスが変われば影響caseを再実行し、資料だけの変更を全証拠失効にはしない。

## Codex / DeepSeek / Opus

Codexは環境の切り分け、SHA/manifest、実行権限、統合と最終判定を管理。OpusはPoCの設計、Keychain/終了の安全条件、物理2台のシナリオ・結果を重点レビューする。DeepSeekは次回以降、hostedMac guard、fixture、結果集計、個別テスト等の限定実装に使う。GUI操作は1台1job。同じMac上でGUIの大量並列は行わず、独立した設計/Node試験だけを並列化する。

今回のOpus案からCodexが補正した点：赤ボタン後の常駐を仮定しない／既存L4番号を再定義しない／内容本文の平文と秘密tokenの露出を混同しない／mockを外した事実だけで実Keychain証拠とせずprivate Keychainへの実アクセス・cold/warmを確認／署名や高度なOSアクセシビリティ機能を根拠なく追加必須にしない。

## Opusの使用と採否

Devin CLI `claude-opus-5-5-high` で構成案と反証レビューの2回を実行した。raw会話は一時作業root内だけに保管し、repoへ入れない。別Macでの実行分離、実Keychainの偽PASS防止、切断中の端末ローカルharness、証拠種類の区別を採用した。

Codexが補正した点：Opusの「sleepでrunner jobは必ず失敗」「hostedでpromptを出さずに即失敗できる」「system serviceは一律GUI不可」という断定は採らず、実行条件・deadline・観測で判定する。再起動/Keychain/終了の具体的な契約は実コードとElectron45仕様を優先する。現用MacへのGUI許可や、計画を実行した意味にはしない。

## 根拠

- GitHub-hosted macOSは利用できるがGUI/TCC/Keychain条件のFolioでの成立は未実行。[GitHub-hosted runners公式仕様](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- Actionsは別の自前Macも実行先にできる。[Self-hosted runners公式仕様](https://docs.github.com/en/actions/concepts/runners/self-hosted-runners)
- Playwright1.64.1のlocal loaderに--use-mock-keychain。native dialogはrenderer操作とは別。[PlaywrightのElectron仕様](https://playwright.dev/docs/api/class-electron)
- Electron45公式safeStorageはMac Keychainへのアクセスが入力待ちでblockし得ることと一貫した署名の重要性を記載。[Electron45 safeStorage仕様](https://github.com/electron/electron/blob/v45.0.0/docs/api/safe-storage.md)
- 製品の終了/activate動作：src/main/index.tsのapp.on(window-all-closed)、app.on(activate)、will-quit。

## Opus戦略ラボで補足した起動条件

新規workflowを未登録の作業branchへ置いただけでworkflow_dispatchが成立するとは前提にしない。GitHub公式はdefault branch上の定義を要件としている。登録済みworkflowの別ref起動と初回登録を分け、master未マージのPoCは専用・信頼済みPRイベント＋固定対象を先行案にする。これは起動経路の計画補正で、workflow作成/実行は行っていない。

[GitHub公式の手動起動条件](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)、[7回のOpus相談の統合結果](../roadmap/20261108-opus-strategy/README.ja.md)。PRのmerge ref・製品source・実artifact・harnessを別々に記録する。
