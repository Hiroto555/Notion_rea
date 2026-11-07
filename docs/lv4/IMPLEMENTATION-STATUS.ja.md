# Lv4 実装状況（M1非GUI完了・停止）

> **Linux GUI追加受入**：GitHub Actionsの仮想画面で42/42件PASS（retry/skip 0）。[範囲・証拠・初回失敗の修正](GUI-LINUX-CI.ja.md)を参照。このMacのGUIは起動せず、製品srcはM1と同一。Mac/OS固有・実機2台・未移植GUIはNOT_RUN、Lv3維持、A3未着手。以下のM1完了当時のGUI未実施記録と区別する。

> **2026-11-08 M1完了**：利用者の明示指示でA0〜A2を実施し、A3へ進まず停止した。通常予約をUUID/CASのSQLite journalへ移し、保全archiveの一覧・JSON/添付付き書出し・新規v4 DBへのコピー復元を接続した。結果不明とIPC応答喪失は同じ操作IDで照会するまで新効果を止める。最終候補`d509edf`は型検査・**180ファイル／1,673テスト**・build PASS、Sol XHigh最終レビューで未解決P0/P1なし。[M1完了記録](M1-COMPLETION.ja.md)、[手順書](m1/RECOVERY-RUNBOOK.ja.md)、[最終ログ](validation/m1-quiet.txt)を参照。

GUI/Electron/実IPC/実IME/物理2台はNOT_RUN、確認済みLevelはLv3のまま。元master・実データは変更せず、ローカルM1ブランチへcommitした。M1追加分のpush/mergeは行っていない。旧sidecarは保全停止し、解除/移行は未対応。回収先の同期保留markerも解除しない。

## M1以前の履歴（以下は各記録当時の状態）

> **2026-11-08の過去保存時点**：当時の実装・計画・レビュー・検証記録を専用ブランチとPRへ保存した。以下の「未コミット」「pushなし」「sidecar」「未実装」などは各記録当時の状態。[GitHub保存記録](PUBLICATION-CHECKPOINT.ja.md)を参照。M1後の現状は上記と[M1完了記録](M1-COMPLETION.ja.md)を優先する。

基準: e269137 と、ハッシュ照合したDnD/復元等の未コミットdraft。作業は別worktree。現在の認定はLv3のまま。Lv4の完了や利用可能性の認定ではない。

最新の追加は末尾の「勝者選択UIと終了時予約の接続」。確認・メモリ予約・取消し・全window閉鎖後のSQLite予約・次回起動時適用を接続し、非GUI一括検証は166ファイル/1,509テスト・型検査・build PASS。以下の古い記録にある「勝者UI/typed IPC未接続」は追加前の状態。実画面/Electronは引き続きNOT_RUN。

**現在は実装を止め、[残作業・工数・停止地点の計画](REMAINING-WORK-PLAN.ja.md)を保存した段階。M1は推奨案であり、採用・着手の指示ではない。**

## 実装済みの境界

- `WorkspaceSync` に送信、受信staging、対象指定の適用を分けた。受信だけでは本文表・applied revisionを変えない。既存 `syncOnce()` の互換入口は維持。
- 添付は別stagingに取得し、適用前にサイズ・hashを検証して別inodeとして有効assetsへ公開する。途中失敗時の未参照ファイルは保持し、既存ファイルは上書きしない。
- 明示意図はworkspace/device/binding/server epoch/revision/hashを含む小さなdurable sidecar。異常な記録は保留。再起動前のSQLite位置・未送信・競合・復旧入力を確認し、停止したserverなしで適用する。コミット後に意図の削除が不明となった場合は、保存済みcheckpointのhashとrevisionを照合して再適用せずに回収する。
- ACK喪失による自端末echoが対象の前にある場合、対象を先に照合し、保存済みechoとoutboxを照合してから位置を進める。未送信の新しいローカル変更があれば後続の本文適用は停止する。
- 既存の起動時同期は、意図がないとき本文を自動適用せず、送信と受信stagingまでに変更。以前の `FOLIO_SYNC_CONFLICT_CHOICE` による暗黙の起動時競合選択は保留する。再bindと未処理の適用意図は同時実行しない。
- mainが保持するサービスとtyped IPCで手動の送信・受信stagingと状態表示を接続。同期と保存/保守の書込みを排他し、復旧入力のcheckpointは待たせない。画面・Electron経路はNOT_RUN。秘密を返さないstatusを持つ使い捨てloopback server fixtureも用意。fixture資格情報はインメモリのみで、実運用serverを対象としない。

## 未完成・受入待ち

- 再起動適用予約・取消しの画面と終了処理のコードを追加したが、Electron/GUIで未検証。終了時の入力保護・取消し・表示は実画面受入待ち。
- 手動同期はmain/typed IPC/状態表示へ接続したが、起動時の接続失敗後、登録済みv5の通常接続に限って手動再接続できる。未登録時の初回登録、復元後の再登録、保留中の適用意図は手動再接続では実行せず、起動時の手順に留める。定期同期と保存後同期は未完成。同期成功時刻はworkspace/device/binding/epochに結び付いたローカル設定へ保存し、再起動後も読める。保存失敗時は当該プロセスのメモリだけに残り、次回は以前の記録に戻り得るため「記録された同期成功」と表示する。保存・保守・修復・backupとの排他はNode単体試験のみで、実Electron IPC/画面や終了中断を含む実操作は未検証。長時間転送中の書込み待ち行列の上限・UXも未検証。競合比較・取り出し、接続設定、SecretStoreの製品接続も未完成。
- 添付途中データの再起動をまたぐ再開、有界な保持と掃除は未完成。受信待ち添付は設定済み添付容量上限と容量画面に算入し、計測不能なら保留する。障害時には保全して停止する必要がある。
- fixture-only CLIは一時serverのstatus/register/revokeに限る。運用のbackup・restore・epoch更新CLI、実サーバーの排他、秘密の永続化は未完成。Keychain/safeStorageのOS試験はNOT_RUN。
- 既存のcheckpoint上限・履歴保持を変更していない。受信ごとの未適用revision添付の再検証は履歴数に応じて増えるため、計測後の有界化が必要。records・実HTTP・実端末を含む容量目標と検証は未完了。
- Electron/GUI/IME/OS clipboard/実機2台/実トンネル/Windows/GitHub ActionsはNOT_RUN。元draftに由来するGUI受入も保留。commit/push/mergeなし。

## 外部モデルの出所

最初の3並列は、利用者の指定を親が誤解しDevin経由のDeepSeek V4 Pro Maxで実行した。書込みは自動承認で拒否され、その後の読み取り専用レビュー案のうち、echoの回帰テストと容量計測案を親が修正・実行した。後から指定されたOpenCode Go `deepseek-v4.1-flash` / `max` を別途3並列で実行している。両者を同一視しない。PID・モデル・ログ・拒否内容は隔離rootと共有coordinationの記録にある。

## 運用案のレビュー保留

Devinの読み取り専用出力に含まれたファイル資格情報・復元案はそのまま採用していない。ファイル作成失敗時に既存pathを削除し得る処理、親ディレクトリ権限とsymlinkの検証不足、別途起動されたserverと共有しない排他、復元中断時の部分状態があるため。親が追加したfixtureは毎回新しい一時serverに限定し、実serverのrestoreや資格情報のディスク保存を提供しない。fixture内の秘密keyは一時server epoch・workspace・deviceを区別するが、実serverの安定identity設計を代替しない。

## 親側の非GUI実行記録

統合中の2026-11-07の `npm run verify:quiet` は型検査、137テストファイル・1,301テスト（Vitest maxWorkers=2）、buildがPASS。ログは隔離root `integration-current-quiet.log`。この後のworker差分を取り込んだ場合は別途再実行する。先行1,286件・1,295件・1,300件の結果とは対象版が異なる。

OpenCode Go担当の追加回帰試験では、ACK喪失後の自端末echoと他端末revisionを受信してから新たなローカル編集を行い、offline適用時にechoだけ照合し、未送信編集と後続revisionを保持することを親側で確認した。運用担当のfixture CLIは親側で、長い標準入力行の上限、公開エラーの許可リストと出力のbackpressureを追加して確認中。

手動同期サービスとIPCを追加した統合候補に対し、`integration-service-quiet.log` の `npm run verify:quiet` は型検査、143ファイル・1,317テスト、buildがPASS。mainの同期処理は保存・保守の書込みと排他し、`recovery:write` は別経路で続行する。これはNode試験と静的な接続検証であり、Electronの実IPC・画面操作はNOT_RUN。

その後、ACK喪失試験の送信を `WorkspaceSyncControl` と `WorkspaceSyncService` 経由へ変更して単独実行し、エラー表示・未確定送信の維持・offline echo照合を確認した。Electronのイベント配送はこのNode試験に含まれない。

再起動適用時、serverが応答する場合は、適用前にepoch・head後退・対象revisionのhashを照合し、不一致や認証/応答異常では保留する。loopback接続自体が `ECONNREFUSED` の場合だけ、検証済みstagingをoffline適用できる。offline中はserver側の復元・分岐を観測できず、その検知は後の再接続までできない。タイムアウトや接続途中の失敗を安易にoffline成功と扱わない。
server照合はその時点の読み取りであり、照合後からSQLite適用までserverの履歴をロックしない。serverがその間に復元・分岐した場合は次の接続で検出・保留する必要がある。実サーバー復元の運用排他は未完成。

再起動要求の状態管理部品は、ウィンドウが閉じるまでは意図をメモリに留め、終了取消し時には永続化しない。閉鎖後に入力・対象・排他を再確認し、書込み結果が不明なときは対象一致を確認してのみ取消すNode試験を追加した。ただしElectronイベントへの接続と、観測値をmainが正しく供給する実画面検証は未実装・NOT_RUN。

OpenCode Goのread-only再レビューで、restart intentの読取り後・適用前の非同期区間に取消しが入ると、元の意図で適用し得る競合を再現した。適用直前に意図を再読し、取消し・変更・破損なら本文を適用しない。適用後の意図削除も一致する対象だけに限定する。追加のNode試験と型検査はPASS。実際の終了/取消しのUI接続は未実装。


## 最新の非GUI検証（2026-11-07）

最終候補の `npm run verify:quiet` は型検査、145ファイル・1,330テスト、buildの全3段階がPASS。詳細は隔離rootの `integration-final-quiet.log`。Viteは動的importと既存の大きなchunkについて警告を出したが、buildは成功した。GUIや実端末の受入を意味しない。

OpenCode Goの添付・受信経路レビューで、競合時に受信が1 revisionしか進まず、離れたheadを選べない問題を再現・修正した。1回につき最大8 revisionを受信し、続きが必要なら競合とローカル変更を保持する。選択後にserver headが変わった場合も古い選択を適用しない。複数回の追いつきとhead変更はNode/loopback試験でPASS。添付公開後のhead変更では、未参照の公開済みファイルが残る場合があり、回収は未実装。

排他の追加OpenCode Goレビューは、初回が429で失敗し、同モデルでの再試行は終了コード0だったが `reason: length` で結論を返さなかった。レビュー合格とは扱わない。親はゲートとIPCを読み直し、既存のNode試験・型検査・buildを実行したが、実Electronの排他受入はNOT_RUN。

元worktreeとDnD draftの状態は変更せず、計画時source 682ファイルについて現在の元worktree 658件またはdraft 24件とのSHA-256一致を確認した。


## 継続実装（2026-11-07、非GUI）

添付容量の上限が設定されている場合、active assetsと受信stagingの両方を合計し、新しいstagingやactiveへの別コピーを作る前に必要量を加算する。使用量を完全に計測できない場合は停止し、stagingや入力は消さない。容量画面の添付・合計にもstagingを含める。未完stagingの安全な整理や無制限設定での有界化は未実装。詳細診断の `readStorageUsage` 自体は従来どおりstagingを集計しないため、その合計値は実使用量を下回り得る。容量画面の概要は別途加算する。上限判定と容量画面の一時SQLite/ファイル試験はPASS、画面表示はNOT_RUN。

DeepSeekの再接続案を親側で修正し、既存v5 binding・適用意図なし・recover以外に限って手動再接続を許可した。同期要求は既存のmainゲート・送信元再確認の後に動き、受信はstagingのみ。未登録のschema昇格やrecover再bindを画面稼働中に行わない。loopback/Nodeで接続断からの再接続、未適用維持、意図保留、未登録・recover拒否を確認した。実Electron/GUI、ネットワークの実機接続はNOT_RUN。

資格情報の部品として、暗号化機能を注入するSecretStore境界を追加した。接続・端末・epochごとに暗号文内でも対象を照合し、他の対象へ移された記録を拒否する。Linuxでは安全なbackendを識別できなければ停止する。DeepSeekの初期案は復号結果のJSON解析漏れで17件中7件が失敗し、親が修正とLinux fail-closed試験を追加して18件PASS。これはモック暗号とインメモリ保存によるNode試験であり、永続化先・起動設定・Electron safeStorage/Keychainには未接続、実OS試験NOT_RUN。

再接続・SecretStore境界統合後の中間 `npm run verify:quiet` は型検査・148ファイル/1,362テスト・buildがPASS。ログは `<LOCAL_RUN_ROOT>/Folio-lv4-continuation-20261107/integration-reconnect-quiet.log`。他モデルの差分を取り込んだ後は再実行する。

再起動時の排他確認に使うため、mainの同期ゲートへ `isIdle()` を追加。実行中の書込み、同期待ち/実行中、同期待機中に並んだ書込みをすべて非idleとする。Node試験PASS。再起動操作にはまだ接続していない。

SecretStoreの暗号文永続化について追加でOpenCode Goへ依頼したが、プロセス終了コード0にもかかわらず `reason: length` で結論を返さなかった。永続化は未実装のまま。添付再開の別案もpath確認後の削除競合が残ると自己報告したため製品に取り込まず、作業コピーに保存している。

サーバー稼働中のcatalog-only SQLite snapshotをサーバー内部APIに追加した。新規専用ディレクトリを排他的に作成し、SQLite snapshotの整合性・epoch・head等を検証、添付を含まないことをmanifestに明記する。接続とsource pathの一致、source hardlink拒否、空き容量の事前検査、失敗時の不完全markerを追加。snapshotと既存同期のNode/loopback試験22件PASS。最初のモデル案では `DatabaseSync` が型専用importだったため6件中3件失敗し、親が修正した。空き容量の検査は予約ではなく後から消費され得る。外部writerのすべての変更を検出する保証はない。安全のためmanifestの小さな一時hardlinkを残す。添付blob、復元、epoch更新、運用CLI、実server検証は未実装・NOT_RUNで、完全backupではない。

競合については、保存済みのローカル/リモート候補をrevision・hashと操作IDで検証し、読み取りと候補の取得を行う非GUI部品を追加した。既存本文を書換えず、不一致や破損を拒否する3試験PASS。候補生成後の新しいローカル編集はその候補とは別であり、generationで区別する。モデル案の候補追加保存は容量検査と待機後の送信元検査が不足していたため取り込まず、選択・archive追加の既存挙動も変えていない。読み取り専用のtyped IPC、候補のrevision・ページ数・添付数・hash表示とJSON書き出しの画面コードを接続した。JSONは添付本体を含まず完全backupではない。保存先はnative dialogで利用者が選び、既存ファイルを上書きしない。選択・本文差分の比較は未実装。実Electron IPC・画面・dialogはNOT_RUN。

再起動適用予約のmain用coordinatorを非GUI部品として追加。対象の選択、入力保護、取消し、全ウィンドウ閉鎖後の再検査を扱う。モデル案に不足していた保存/保守を含むゲートのidle観測を必須にし、予約前と確定直前の両方でbusyなら保留する。関連18試験・型検査PASS。Electronイベント・再起動画面・再接続したtransportへの接続は未実装、終了中断と実画面の検証NOT_RUN。


## 再起動適用の接続（後続作業）

上記の過去記録にある「UI未接続」はこの追記より前の状態。mainが対象を選んで予約/取消しするtyped IPCと画面コードを追加し、終了時の予約確定をElectron `will-quit` に置いた。同梱Electron型定義ではCmd+Qや `app.quit()` では `window-all-closed` が発火しないため、両方の終了経路を扱う。終了時に入力・対象・同期と保存/保守のゲートを再確認し、未完了ならquitを阻止して画面を開き直す設計。

Node/一時SQLite/loopbackでは、予約後に書込みが残ると終了と適用意図の確定を保留し、書込み終了後に確定、server停止中の再起動相当処理で対象版を適用する試験がPASS。これはElectronイベント配送や実画面の確認ではない。GUI/Electron、Cmd+Q、画面取消し、IME、ネイティブダイアログ、実機はすべてNOT_RUN。終了操作・入力保全の完成やLv4到達は主張しない。

再起動予約、競合の読み取り専用IPC、catalog snapshotを含む統合候補で `npm run verify:quiet` を再実行し、型検査・153ファイル/1,389テスト・buildがPASS。詳細は `<LOCAL_RUN_ROOT>/Folio-lv4-continuation-20261107/integration-restart-quiet.log`。Electron/GUI・実機・Keychain・サーバー実運用はNOT_RUN。

競合JSON書き出しはdialogの前後で同じ操作ID・revision・hashの候補を確認し、dialog後は送信元を再認証する。既存の安全な外部出力writerで候補のcheckpointを再検証して新規pathへ公開し、既存ファイルを上書きしない。temp hardlinkは保持され、同時に第三者が保存先を変更するケースはwriterの制約がある。Node一時データで正しいJSON・hash不一致・既存path・拒否された保存先を確認。画面やnative dialogはNOT_RUN。

候補情報とJSON書き出しを追加した版の `npm run verify:quiet` は型検査・154ファイル/1,391テスト・build PASS。ログは `<LOCAL_RUN_ROOT>/Folio-lv4-continuation-20261107/integration-conflict-quiet.log`。GUI、保存dialog、実端末、Keychain、実運用serverはNOT_RUN。

最終成功時刻をSQLiteのローカル設定に保存する処理を追加。IDとepochのhashで保存キーを分離し、別binding・別epochでは旧時刻を表示しない。保存に失敗しても送受信成功を失敗扱いにせず、そのプロセス中だけ時刻を保持する。設定の破損値は上書きせず、新しい時刻の永続化を保留する。SQLite再読、別binding/epoch、同期世代・checkpoint hashが変化しないこと、保存エラー時の同期結果をNodeで確認した。実画面はNOT_RUN。古いbindingの時刻設定の自動掃除はない。

接続ごとの同期成功時刻を加えた候補で `npm run verify:quiet` は型検査・155ファイル/1,393テスト・build PASS。ログは `<LOCAL_RUN_ROOT>/Folio-lv4-continuation-20261107/integration-history-quiet.log`。GUI/Electron・Keychain・実機・実運用serverはNOT_RUN。

成功時刻は送受信処理が戻っただけで更新せず、その時点で未送信または競合が残る場合は以前の記録を維持する。受信済み未適用revisionは別途表示するため、この時刻を全端末が同一内容である保証とは扱わない。

未送信/競合時に成功時刻を進めない修正とserver snapshotの再検査後、`npm run verify:quiet` は型検査・155ファイル/1,395テスト・build PASS。ログは `<LOCAL_RUN_ROOT>/Folio-lv4-continuation2-20261107/integration-current-quiet.log`。別コピーでの追加案はこの検証対象に含まれない。

競合候補を固定したoperation ID・revision・hashで取得し、差のあるページの題名と本文をローカル/リモートそれぞれ表示する比較コードを追加した。ページ情報のいずれかが異なれば対象に含める。表示は最大50ページ、本文は各500文字までで省略を明示する。DBレコード、添付本体、履歴、書式の完全な差分ではなく、未保存入力も含まない。ローカル/リモートのみ存在するページ、設定のみの変更、表示上限、不正なページの拒否をNode単体試験で確認。実画面・操作はNOT_RUNで、勝者選択は未実装。上記の旧記録にある「本文比較は未実装」はこの追加より前の状態。

比較機能追加後の `npm run verify:quiet` は型検査・156ファイル/1,398テスト・build PASS。ログは `<LOCAL_RUN_ROOT>/Folio-lv4-continuation2-20261107/integration-comparison-quiet.log`。GUI向けに応答を模擬した表示spec 2件を追加し、一覧取得と型検査のみ確認した。GUI実行はNOT_RUN。

比較表示のHTML構造調整と実SQLite候補からの比較検査を加えた後も、`npm run verify:quiet` は型検査・156ファイル/1,398テスト・build PASS。ログは `<LOCAL_RUN_ROOT>/Folio-lv4-continuation2-20261107/integration-latest-quiet.log`。

OpenCode Go `opencode-go/deepseek-v4.1-flash` / `max` の競合再起動案を隔離コピーで型検査・17テスト実行しPASS。ただし提案は製品の起動/画面に未接続で、sidecar削除時のpath置換競合と、終了時の排他を必須とする呼び出し契約が残るため、そのまま統合していない。候補破損を防ぐ独立した改善のみ採用し、既存のremote選択のSQLite transaction内でローカル/リモート候補と履歴の連続性を再検査する。改竄した候補ではarchiveも本文も変更しないこと、既存の競合/同期を含む36試験と型検査がPASS。選択画面は引き続き未実装。

この候補保護を加えた `npm run verify:quiet` は型検査・156ファイル/1,399テスト・build PASS。ログは `<LOCAL_RUN_ROOT>/Folio-lv4-continuation2-20261107/integration-conflict-guard-quiet.log`。

OpenCode Goの途中案を独立コピーで確認し、暗号文レコードを新規作成専用で保持するPOSIXファイル部品を追加。明示された既存のprivate directoryとworkspace/backupの除外root、所有者・権限、canonical path、リンク数、キー形状とサイズを検査し、既存内容の置換や削除を拒否する。生成直後の異常時にpathを確認して削除するモデル案は、確認と削除の間に別ファイルに置き換わる余地があるため親が外し、不完全なファイルも保持する。fsync失敗注入で保持を確認し、既存SecretStoreを含む32試験と型検査PASS。不完全な記録は手動調査が必要になる場合がある。ディレクトリ内の同一ユーザーによる同時変更をOSのopenat等で原子的に固定するものではなく、除外対象は呼び出し側が正しく列挙する必要がある。実際の保存先、接続設定、更新・失効・削除、Electron safeStorage/Keychainには未接続。モック暗号と一時ディレクトリのNode試験であり、OS実連携はNOT_RUN。

暗号文ファイル部品を含む `npm run verify:quiet` は型検査・158ファイル/1,413テスト・build PASS。ログは `<LOCAL_RUN_ROOT>/Folio-lv4-continuation2-20261107/integration-secret-file-quiet.log`。

OS保護フラグが0や未提供なら停止する検査を追加し、同じ非GUI一括検証を再実行、型検査・158ファイル/1,413テスト・build PASS。ログは `<LOCAL_RUN_ROOT>/Folio-lv4-continuation2-20261107/integration-final-current.log`。

暗号文ファイルの再読、record pathがディレクトリの場合の拒否、親ディレクトリのsymlink経由拒否を確認した後、非GUI一括検証は型検査・158ファイル/1,414テスト・build PASS。ログは `<LOCAL_RUN_ROOT>/Folio-lv4-continuation2-20261107/integration-secret-reopen-quiet.log`。

添付再開のOpenCode Go最終案は隔離コピーに保存。初回型検査で `null` と `undefined` の型エラー1件が出たため親がコピー内で修正し、型検査と再開・対象束縛・途中ファイル保全・容量拒否・完全長hash再検査の5試験がPASS。ただしpathのinode確認とunlinkが原子的でないこと、複数プロセスの排他と検証後の同一inodeの書換えを保証しないこと、残った途中ファイルの有界整理が未完のため、製品側には取り込まない。実プロセス再起動・GUI・実端末はNOT_RUN。

秘密ファイルのread前後に所有者・mode・pathの再検査を加えた最終統合候補は、`npm run verify:quiet` の型検査・158ファイル/1,414テスト・buildがPASS。ログは `<LOCAL_RUN_ROOT>/Folio-lv4-continuation2-20261107/integration-final-guarded-quiet.log`。GUI/Electron、Keychain、実端末、実運用serverはNOT_RUN。

## Sol XHigh・DeepSeek分担の追加作業（2026-11-07）

DeepSeekの容量概要案を検討し、管理画面の添付容量に含まれる同期受信待ちのbytesを内訳として追加。存在しないstagingは0、symlink・部分走査・overflow・不整合な計測結果はnullとして全体を不明にする。既存の容量上限判定とversion付き詳細診断の形式は変更していない。型検査と容量/上限に関する24試験PASS。GUI表示NOT_RUN。

Sol XHighの独立レビューでは、起動意図sidecarについてread→unlinkの間に外部同一UIDプロセスが別ファイルに差し替える競合をfault injectionで再現した。既存の単一所有者・単一イベントループの通常UI経路ではその同期区間に割り込みはないが、同一UIDの外部writerがいる条件では新しい予約を消しうる。再現した範囲では本文の誤適用は確認されていない。事前lstatの追加だけでは解決しないため、条件付き削除に依存しない設計または協調writerの排他契約が必要。未修正として記録。

DeepSeekの読み取り専用比較部品を基に、競合候補中の `record_memberships` について、レコードの有無・所属・位置・値の違いを固定ID/hashの候補から比較するコードを追加。差は最大50件、各側の値は500文字に制限し、DB設定・履歴・添付本体を比較しないことを表示する。合成データ、実際の一時SQLiteから生成したcheckpointと既存候補検査の11試験PASS。現状は項目識別子の表示であり、項目名や全変更の完全なdiffではない。GUI・画面操作NOT_RUN。再起動意図破損・client/epoch不一致・復旧入力で本文もintentも保全するNode/loopback 3試験を追加し、既存故障試験と合わせ5試験PASS。

Sol XHighの追加レビューで、移行済みrecordの題名変更・ゴミ箱移動が比較されない問題、値のJSON key順だけで変更と判定する問題、旧形式DB行を比較できるかのように読める表示、適用済みstagingを「受信待ち」と呼ぶ表示を、正規の一時SQLite操作で再現。親が題名とゴミ箱状態の比較、key順の正規化、旧形式DB行が対象外という明示、適用済み分を含む一時保存という表示に修正。修正後の関連18試験と型検査PASS。旧形式DB行の詳細比較は未実装。表示確認はGUI NOT_RUN。

DeepSeek案とSolレビューを基に、server catalog snapshotの読み取り専用概要検査 `inspectCheckpointServerBackup` を追加。未完marker、sidecar、manifest/SQLite形式・hash/bytes、epoch、head・件数・revision範囲、SQLite物理整合性を確認する。内部APIのみで実server運用には未接続。検査対象は既定1GiBまで（呼び出し側が上限を明示可能）。SolがNode 24の `readOnly` openだけではWAL形式で `-wal/-shm` が作成されうると実測したため、親がimmutable URIとWAL/sidecar事前拒否を追加。パス入替えfault injectionでも検査を拒否し、対象にsidecarが生まれないことを確認。実creatorのmanifest hardlinkと特殊文字pathでも検証。結果はcatalogの概要に限定し、全履歴・receipt・復元可能性・同時writerの排他は未検証、添付本体は含まれないと構造化して明示する。関連22試験と型検査PASS。実OS/Electronと実運用serverはNOT_RUN。

上記を含む非GUI `npm run verify:quiet` は型検査・161ファイル/1,428テスト・build PASS。ログは `<LOCAL_RUN_ROOT>/Folio-lv4-round3-20261107/integration-round3-quiet.log`。GUI、実OS、実端末とサーバー実運用はNOT_RUN。

catalog概要検査を加えた統合候補の `npm run verify:quiet` は型検査・164ファイル/1,441テスト・build PASS。ログは `<LOCAL_RUN_ROOT>/Folio-lv4-round3-20261107/integration-final-quiet.log`。GUI/Electron、Keychain、実端末と実運用serverはNOT_RUN。

## 競合解決の継続実装（2026-11-07、非GUI）

指定の3文書とGit状態を確認してから、既存の統合ブランチ `codex/folio-lv4-20261107-3qxb-integration` で継続した。HEADとmaster参照は `e269137` のまま。既存の未コミット差分を保持し、元masterのGit状態も開始前と一致する。commit/push/mergeはしていない。

両候補の操作ID・revision/hash、workspace/device/binding/epoch、最新のgeneration・適用位置・保存済みcheckpoint hashを固定する `conflictResolutionTarget` と `resolveConflictTarget` を追加。targetは通信前にコピーし、保存・受信・添付取得・head照合の後とtransaction内で再確認する。受信cursorの前進だけは許すが、選択対象を新しい候補へ自動変更しない。ローカル選択は最新の保存済み内容を意味し、競合時点の比較候補や未保存入力とは区別する。

既存のlocal選択が破損した候補でも進む問題をSol XHighが一時SQLiteで独立再現したため、local/remote双方の選択で永続候補・識別・履歴を検査するよう修正した。local選択でも両候補と最新保存内容のcheckpoint JSONをarchiveし、outbox・決定と同一transactionに保存する。remote選択では両候補と異なる最新保存内容を保持してから本文を置き換える。容量検査は全archive・outbox/適用/置換等の追加見積りを含め、拒否や途中書込み障害ではDB変更をロールバックする。backup・容量callback後の `canApply` も再確認する。

Solは `gpt-6.1-sol` / `xhigh` で設計・安全性レビューと最終再レビューを実施。関連2ファイル/30試験を独立実行してPASS、コア限定の評価では追加ブロッカーなし。レビューと破損候補の独立再現は `reviews/SOL-XHIGH-DESIGN-REVIEW.ja.md`。

DeepSeekには隔離した読取り専用snapshotで、`opencode-go/deepseek-v4.1-flash` / `max` の限定した実装・テスト案を並行依頼した。最初の読取り処理は長期化したためSIGINTで中断（exit -2）。同じセッションへ追加読取りなしで最終案を求めた実行はexit 0・`reason: stop` で完了。最終案は `reviews/DEEPSEEK-PROPOSAL.md`、原記録は同rootの `deepseek-final-request.jsonl`。これは提案であり、DeepSeek自身のテスト実行や実装完了の証拠ではない。

両候補と最新generation/hashの固定、transaction内検査、容量拒否と互換性試験の案を親実装と照合した。自己計算digestは認証にはならず、固定フィールドとの直接比較で足りるため追加しない。`validateConflictRecord` だけでは現在のworkspace/deviceとの一致を保証しないため、親実装は現在identityとの検査も行う。またtarget取得時点で既に旧候補より新しい保存内容がある場合、そのlatest archiveを省く提案は採用しない。remote選択時にも旧候補と異なる最新保存内容をarchiveし、保全を維持する。勝者UI・新しいsidecarは追加していない。

親側の `npm run verify:quiet` は型検査・165ファイル/1,467テスト・buildの全3段階PASS。ログは `validation/conflict-core-quiet.txt`。今回追加した26試験には、generationが変わらない本文変化、候補/識別の差替え、容量拒否、途中archive障害、通信前/通信中/受信中の編集、headの前進、呼出元targetの変更、復旧入力のdirty化、ACK喪失と再open後の同一操作回収を含む。Viteの既存のchunk/dynamic import警告は残るがbuildは成功。

このAPIはactive-window service/typed IPC/rendererには未接続。勝者選択の画面・終了時の明示適用・archiveの回収導線は未実装。archiveはcheckpoint JSONと添付manifestであり、添付本体の完全保全を保証しない。例外でもCOMMIT済みの場合があり、結果不明時は永続状態の再読が必要。sidecarの既知の外部writer競合、実server復元との排他も未解決。詳細は `CONFLICT-RESOLUTION.ja.md`。GUI/Electron・物理端末・OS・実運用は **NOT_RUN**、認定はLv3のまま。

## 勝者選択UIと終了時予約の接続（2026-11-07、非GUI）

競合候補から、この端末の最新保存内容またはリモート版の確認へ進むrendererとtyped IPCを追加した。mainがopaqueなpreview IDと固定targetを保持し、確認画面は最新保存内容と相手の本文/移行済みDBレコードの抜粋を表示する。旧ローカル候補とは世代・hashを分け、未保存入力、比較上限、添付本体・復元画面の制約を表示する。明示チェック後のconfirmはメモリ上の準備だけで、本文やdurable予約を変更しない。利用者が通常どおり終了し、終了拒否時には準備を取り消せる。

全windowが閉じた後にmainが復旧入力・保存/保守/同期のidle・通常適用予約との排他・固定targetを再検査し、private settingsへ8KiB以下のstrict/canonicalなSQLite pending記録をCAS保存する。新しいsidecar/tableは追加しない。通常のsetting IPCは既存allowlistによりこのkeyを書けない。次回起動の画面生成前にだけオンラインでコアAPIを実行し、consumed/resultをoutbox/chosenまたは本文/applied/chosenと同一transactionで保存する。結果不明で古い選択を繰り返さない。取消しもID付きCASでpending→cancelledとし、削除しない。直近のterminal結果だけを次の明示予約まで保持する。

同期設定なし・無効・未接続で再起動しても、ローカルpendingの状態照会と取消しへ到達できるよう操作部を接続した。通常の再起動適用とは準備・終了確定・startupで相互排他にする。IMEのみの入力を見落とさないよう、beforeunloadと競合preview/confirmに共通の入力保護条件を使う。古い非同期応答やunmount後の応答を無視し、confirm/cancel応答が不明なら状態照会で回収する。

Sol `gpt-6.1-sol` / `xhigh` は設計・中間・最終の安全性レビューを行い、関連6ファイル/90試験を独立実行してPASS。同期メッセージがないとpending取消しUIが表示されない到達性の問題を指摘し、親が常時マウントへ修正した。Solが修正を再確認し、追加ブロッカーなし。レビューは `reviews/SOL-XHIGH-ARCHITECTURE-REVIEW.ja.md`。これはソース/Nodeの評価であり、画面での到達確認ではない。

DeepSeek `opencode-go/deepseek-v4.1-flash` / `max` には、必要な契約とコードを含めた小さい入力だけでUI状態・typed IPC・回帰試験案を並行依頼し、追加ツールを禁止した。exit 0・`reason: stop`で完了。遅延応答の世代管理、重複confirm、結果不明の照会、read-only/未接続の試験案を親が照合・実装した。自己計算digestの追加と「confirm後は取消し不可」は採用せず、main保持IDとの直接照合と準備後の取消しを維持する。提案は同rootの `DEEPSEEK-UI-PROPOSAL.md`、原記録は `deepseek-ui.jsonl`。DeepSeek自身の実装やテスト実行の証拠ではない。

親の最終 `npm run verify:quiet` は型検査・166ファイル/1,509テスト・buildの全3段階PASS。ログは同rootの `integration-ui-final-quiet.log`。追加42試験は、両選択の確認→閉鎖観測→予約→Store再open→startup適用、設定なし/未接続の取消し、未保存入力・通常予約との排他、COMMIT前失敗/COMMIT後の応答喪失、送信ACK喪失と同一outbox回収、取消しとhead取得の交差、旧preview/ID、UI遅延応答・二重confirm、IMEを含むclose条件を扱う。実windowを作らず、閉鎖観測はNodeで供給した。途中に旧テストのIPC分類件数と試験期待値を修正したが、最終候補は全件PASS。Viteの既存のchunk/dynamic import警告は残る。

GUI/Electron・実IPC・実終了/再起動・IME・focus/Escape・小画面/アクセシビリティ・実機2台は **NOT_RUN**。archiveの復元/取り出し画面と添付本体の完全保全、通常sidecarの既知の外部writer競合、実server復元との排他は未完。受入条件は `GUI-ACCEPTANCE-QUEUE.ja.md` に記録し、認定はLv3のまま。作業は既存の統合ツリーのみ、HEAD/master参照はe269137、変更は未コミット。commit/push/mergeや実データの移行はしていない。
