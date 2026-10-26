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

反復の途中結果: r2-repeat20は36/40、r2-final-repeat20は39/40。失敗は残しており、その成功分だけで安定済みとはしない。2回目の残件もmousedown後のdragstart未発火だったため、入力経路の移動幅をさらに明確化した。変更後の最終反復・全体3回の結果は後段に追記する。これは前回失敗の全てを単一原因で説明できたという主張ではない。

## R3 ダイアログ

修正前実ElectronでDB Escape未閉鎖、aria-modal欠落、選択リンク取消後のフォーカス欠落を採取（r3-red-electron）。実装・追加検証中。

## 証拠

docs/validation/next-roundの各実行JSONにcommand/exitCode/HEAD/source hash/build hashを記録。失敗ログを上書きせず保持。生trace・画面・巨大fixtureはローカルoutput/next-roundへ保存する。Notion比較はNOTION-PARITY-BASELINE.mdでFolio結果と別判定。物理IME/Notion実測はNOT_RUN。
