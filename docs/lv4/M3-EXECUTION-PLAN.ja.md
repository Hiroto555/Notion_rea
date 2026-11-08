# M3最終受入待ちまでの実行契約

2026-11-08。利用者がM3最終受入待ちまで、Codex管理・OpenCode Go DeepSeek並列・Devin CLI Opus5.5レビュー・GitHub Actions GUIを明示的に指示した。Mac GUI/実データ/master mergeは行わない。統合branch `codex/folio-m3-ready-20261108`、基準 `4613662`。開始時191ファイル/1,760件・check/build PASS。古いGUI69件は最終候補へ再実行する。

## 完了条件

A3の診断/所有証明付き明示解放、A4の接続設定/暗号化秘密の保存更新削除/初回設定と復元後再登録、A5の全履歴とreceiptが参照する添付を含む完全backup/新規先restore/fresh epoch/排他、A6の有界保持/保全停止と診断、A7の製品経路統合を実装する。同一ソース候補で非GUI・型・build・Linux GUIを合格させ、公開前検査後に専用branch/Draft PRへ保存する。Mac IME/native picker/Keychain/物理Mac2台/実トンネル/スリープはNOT_RUNの残件とし、Lv4認定はしない。A4/A5等が未完ならM2未完と報告し、M3最終受入待ちと称さない。

## 固定する安全境界

- 内容適用/登録/再bind/schema昇格は既存のwindowless起動と明示mode/予約を通す。稼働中設定保存は次回起動向けで、本文を適用しない。通常/競合予約とrecovery inputの保護を維持する。
- 接続UIはadmin CLIで発行したclientId/tokenを受け取る。管理HTTPや自動再登録を追加しない。tokenはmain入力だけ、応答/ログ/argv/workspace/backupへ出さない。暗号化不能/basic_textは保全停止。
- 保存資格情報はworkspace外のprivate vaultへ、physical DB identityとvault側nonceで結び付ける。コピーしたDBが旧資格情報を自動取得しない。M1回収由来markerの恒久保留は維持。通常v5 backup復元後は新client/bindingを使う明示recover。
- serverEpochは既存wireのUUIDを維持し、restoreごとに新UUID。device全失効と同じSQLite transactionで確定。旧clientの再登録を拒否し、旧epochのcommitをreceipt検索より前に拒否する。履歴の旧epoch receiptは回復用証拠として保持する。
- rebind前の既存完全workspace backupは内容/添付/旧queue/receiptを保全する。epoch相違だけで自動rebind/再送/削除しない。検証済みbackup無しにqueueを初期化しない。
- full server backupはcatalog v1と別形式。headsだけでなく全change/operation/losing candidate/resultの整合性と必要blobを検査。snapshot/restoreは排他されたserverディレクトリで、新規先だけに作り、未完了marker中は起動しない。
- A3明示解放はmain所有ticketがrecord/FD/path/root/DB identityを固定し、共通cache SQLite mutexで実行。releasing→trash rename+fsync→unlink+fsync→record CAS削除を耐中断にする。unknown/変更済み/別scope対象の差替えは拒否。live assets/staging/M1 archive/backupは消さない。旧scopeの空metadata整理も非再帰で固定名だけ。
- 全領域の上限時に未解決情報を自動削除しない。lookup/revoke/diagnostic/export/backup検査は維持。履歴/receiptの無条件pruneやCRDT/bootstrap/差分方式の大改造は追加しない。

## 分担と使用量

共有型/既存transport/WorkspaceSync/IPC/main/App/CI接続はCodexが所有。Flashは新規module/UIと専用試験を別worktreeで担当し、受入後commitの依存だけを渡す。初回read-only8本、その後独立実装8本程度を同時実行する。重いNode試験は共通semaphore2枠、maxWorkers=1、個別cache。探索に偏るjobは早く停止し独立試験へ回す。Opusは契約/削除/秘密/復元の節目の差分に集中し、全会話の反復送信を減らす。モデルの追加課金/利用枠/global設定は変更しない。未報告usageを0扱いせず、失敗jobも含めて記録する。
