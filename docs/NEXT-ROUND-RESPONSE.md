# 次ラウンド対応

基準HEAD: `7759906dbbc905a4dc79d01b97aaff6471e51eb3`、開始時master・未コミット変更なし。lockfile変更なし。元監査はreview/2026-10-26、今回の提供原本はreview/next-round-7759906。旧manifest 43ファイルと今回提供manifestの4ファイルを照合した。提供された条件式プローブを本番再現として扱っていない。

## R1 退避・復旧

実requestSchema/Storeで491・500文字の復旧拒否、実Electron IPCで500文字拒否と30.3MBの日本語JSONの「export成功/recover拒否」を再現した。証拠: r1-red-unit / r1-red-electron / r1-red-ipc-confirm。490文字も原題に接頭辞が付く旧挙動を確認した。

変更: ファイル上限をUTF-8 30,000,000 bytes（等号を含む）に統一。exportRecoveryは実ファイルのbytesで判定し、IPC JSON再エスケープのサイズを二重計上しない。通常のexportも同じbytes上限。他IPCは従来の32MB上限を維持する。復旧の前提と同じschemaを保存前に検査し、同じディレクトリ内の一時ファイルをfsync・内容照合してからrenameする。取消・失敗を成功扱いしない。

退避v2は未保存変更のあるページの最終状態を1回だけ格納する。無関係なページ/保存済み側/各キーストロークを重複収録しない。v1は従来のpages+pendingPatchesから読む。未知の版、不正構造、上限超過は書込前に拒否する。復旧は新IDの別ページで、原題・doc・DB行ID/値・添付URLを保持。復旧表示はrecoveredFromメタデータと別ラベルに分離し、原題へ接頭辞を足さない。既存の「[復旧]」タイトルは変更しない。SQLite schemaの変更なし。

上限を超えた場合は未保存パッチを保持する。アプリを閉じず、保存の再試行を行うか、該当本文・DB値を別ファイルへ手動コピーして確認する。現在のv2一式が上限を超えた場合の自動分割退避は未実装。手動コピーは書式を含む完全復旧の代替保証ではない。元JSON/バックアップを編集・削除しない。添付は同一ワークスペース参照で、ZIP移植ではない。

post-writeのloadが失敗した際もパッチを捨てないよう、再読込成功後にACK相当範囲だけ除去する。復旧は全コピーを1トランザクションに入れ、途中のSQL失敗を全rollbackする。

検証: check→単体48/48→build→Electron21/21（前回Gate A15＋今回R1の6）。単体の上限直前/一致/直後はASCII・日本語・絵文字それぞれ。Electronは実ファイル・IPC・Store・再起動、複数ページpending、選択取消、ENOENT書込失敗、再読込失敗、添付バイト照合を含む。SQL途中失敗はStoreのSQLite trigger注入で確認。物理ディスク障害の再現ではない。巨大fixtureはoutput内に実行時生成しGitへ追加しない。

## R2 トップレベルドラッグ

短い既存操作と30ブロックの境界操作を独立させた。生証拠はoutput/next-round/r2-*のdrag-events.json、screen.png、trace.zip。押下/離上/dragstart/dragover/drop/dragend、対象、座標、スクロール、選択、doc before/after、Transaction、保存ACKを専用の合成データに限って採取する。

初版の5失敗はテスト期待値が既存の末尾空段落を落とした誤り。段落も含む全ノード照合に修正した。実際の失敗は、末尾へのdragToでmousedown後にdragstartがない経路、同位置dropがUndoを1件消費する経路。前者は固定sleepを入れず、実マウスで開始位置から40pxを10段階移動してnative dragstartを確認し、目的地へ2回移動してdropを確認する経路に変更した。既存長い試験の期待値は維持。実dropは合成していない。DBボードの既存試験でもドラッグ失敗が出たため、同じ入力ヘルパーを使用する（DB機能の変更はなし）。

本番側は内容が同じdropでTransactionを作らず、ブロック操作をcloseHistoryで区切り、全文置換で文末へ写像されていたカーソルを操作したブロック近傍へ置く。pointer操作後は不要なscrollIntoViewを起こさない。永続IDやネスト粒度の移行は行わない。

反復の途中結果: r2-repeat20は36/40、r2-final-repeat20は39/40。失敗は残しており、その成功分だけで安定済みとはしない。2回目の残件もmousedown後のdragstart未発火だったため、入力経路の移動幅をさらに明確化した。変更後の最終反復acceptance-drag20は40/40（2ケース×20、retries=0）。最終の全体結果は後段を参照。これは前回失敗の全てを単一原因で説明できたという主張ではない。

## R3 ダイアログ

修正前実ElectronでDB Escape未閉鎖、aria-modal欠落、選択リンク取消後のフォーカス欠落を採取（r3-red-electron）。共通Modalはnative dialogのtop layerと背景inertを使い、初期フォーカス、明示Tabループ、復帰先、aria-modal/名前/閉じる操作を統一した。対象外の旧ダイアログは従来のラッパーを維持。IME中Enterは通常入力を妨げず、Escapeでモーダルを閉じない。defaultPreventedと内側UIを優先する。DBのnative selectを開いたEscapeで外側も閉じることを実機で追加再現し、内側selectの取消を一度だけ消費するよう修正した。

リンクは開いた時のpage ID、Editor、文書、selection bookmarkを保持する。確定/取消で元選択・書式・文言を保持し、page/docが変われば挿入を止める。検索で別ページへ移動した後は移動先タイトル、DBは起点カードへフォーカスを戻す。React StrictModeのeffect再実行をユーザーの取消扱いにしない。

r3-picker-electron-v2は7/7。追加のnative select試験は最初FAIL、修正後PASS。途中のTypeScriptチェックエラーではパイプラインを停止し、古いdistによるE2Eを実行していない。物理IMEは引き続きNOT_RUN。

## 証拠

docs/validation/next-roundの各実行JSONにcommand/exitCode/HEAD/source hash/build hashを記録。失敗ログを上書きせず保持。生trace・画面・巨大fixtureはローカルoutput/next-roundへ保存する。Notion比較はNOTION-PARITY-BASELINE.mdでFolio結果と別判定。物理IME/Notion実測はNOT_RUN。

## 全体試験で検出した試験側の残件

最初の全体3回はfull-e2e-1が37/37、full-e2e-2が36/37（F11の移動後load待機に入らず）、full-e2e-3が36/37（F02のsoftware選択範囲を即時取得すると空）だった。追加R1/R2/R3の15件はこの3回とも通過した。失敗ログは削除していない。

F02は診断付き10回で3回再現。失敗直後の画面にはsoftware全体の選択があり、使用中のTiptap `focus.ts` がrequestAnimationFrameでfocusするコードとも一致する。表示ボタン直後の即時取得を、エディタへのフォーカスと同じ完全一致の選択文字列に対する条件待ちへ変更した。語句・書式・件数の期待値は変更していない。

F11は診断付き10回では未再現。先の1件は詳細なネイティブイベントが未取得のため原因未特定であり、保存不具合の解決済みとはしない。ページツリー移動の前提を明示するため、既存の実マウスヘルパーでdragstart/dropを確認し、move/load/updateのIPC、ACK、画面、traceを保存するよう試験だけを修正した。保持中のloadへ入力→解放→保存→再起動という元の検証は維持。ツリー本体の挙動や保存処理には追加変更していない。

これらの診断と修正は全体受入を成立させる局所的なテスト変更であり、今回の製品機能範囲を増やすものではない。初期の失敗、診断付き再現、変更後の実行は別ラベル・別source hashで記録する。

F11へ実マウス操作を組み込んだ最初の診断（f11-f02-green）は10/20で、F02は10/10、F11は10件とも試験のdrop検知で失敗した。captureログにはnative drop、move ACK、heldLoad=trueがすべて記録されていた。ページツリーの既存onDropがstopPropagationするため、documentのbubble監視では拾えないという試験側の問題だった。F11だけcapture journalで実dropを検証するよう変更した。アプリ、ブロックDnDヘルパー、保存ACKの期待値には変更なし。名称にgreenを含む実行でも、結果はFAILのまま保存する。

## レビューする変更単位

| 対象 | ローカルコミット | 主なファイル |
| --- | --- | --- |
| R1 | `1034364` | shared/recovery・limits、persistence/recovery-file・store、main、App、recovery単体/E2E |
| R2 | `c631aa1`、`8599027` | editor/Editor、drag-observer・real-drag・drag回帰、既存desktop E2E |
| R3 | `a4c9abf` | renderer/Modal・App・styles、database/Database、dialogs回帰 |
| 比較・受入試験の局所修正 | `917efa6`、`0bf710e` | gate-a.spec.tsの両語検索、入力完了待ち、ページ移動の診断 |

最終アプリソースは`a4c9abf94baaf726669d0c058626d23db446c8cd`、テストを含む実装HEADは`0bf710eec16d065535674e41196312141e2d0233`。各実行はその時点のsource/build hashを持つ。証拠集約コミットはこれらを包含するローカルコミットで特定できる。GitHubへのpush・公開設定変更・履歴書き換えはしていない。

## 今回の未実施・制限

- Notion実測は全8件NOT_RUN、比較は全てUNKNOWN。公式資料・推定と実観測を混ぜない。物理日本語IMEもNOT_RUNで手順を残した。
- 既存F11の初回停止の原因は未特定。診断付きの元入力では10回未再現。追加観測下の成功だけで、過去の停止が解決済みとはしない。
- トップレベルDnDのみ。永続block ID、ネスト全面対応、DB行ページ化、独立View、Relation/Rollup/Formula、同期、AI、全面UI改装は実装範囲外。
- 退避は同一ワークスペース内。30MB超の自動分割、添付同梱ZIP、物理ディスク故障、電源断、別OSの検証は行っていない。
- `dist`を新規ビルドし、実Electronで起動・保存・再起動を検証する。既存の起動中ユーザーアプリを終了・置換しない。パッケージ済み.appの再生成・配布は今回の成果に含めない。

最終受入の確定結果: check・単体48/48・buildはPASS。トップレベルドラッグは40/40。全体Electronはacceptance-full-1 **37/37**、acceptance-full-2 **37/37**、acceptance-full-3 **36/37**で、全体受入はPARTIAL。最後のF11はcapture記録がmousedownのみ、dragstart/dropなし、move IPCなし。ページツリー操作の入力開始に残件があり、根本原因は未特定。保存不具合を再現したという判定ではないが、全体成功にも数えない。対象ブロック操作の20反復が通ったこととは区別する。

開発モードの初回起動待ちはFAIL（Vite依存最適化/reloadのログあり）。別の診断起動で画面表示を確認し、同じサーバーでリンク確定/取消の回帰は1/1 PASS。StrictMode下の選択・書式・focus保持の限定確認で、cold startの安定性を証明していない。production distの起動・保存・再起動は全体試験で確認済み。
