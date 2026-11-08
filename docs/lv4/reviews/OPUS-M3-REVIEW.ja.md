# M3：Devin CLI Opus 5.5レビューと採否

2026-11-08。実際のDevin CLIを使用。初回方針は `claude-opus-5-5-medium`、契約・ソース・完全復元・最終差分は `claude-opus-5-5-high`。Codexが実コードと故障試験を照合して採否を決めた。モデルの提案や「問題なし」は実試験の代わりにしない。raw会話・一時ディレクトリはGitへ追加しない。

| 節目 | 指摘・相談 | 採否と証拠 |
|---|---|---|
| 方針・契約 | 削除の所有証明、空scope metadata、暗号化秘密と復元後の再登録、サーバー全履歴保全 | FD/path/root/DB pin、共通mutex、external vault、通常復元後の明示recover、全receipt/blob検査へ反映 |
| ソース安全性 P1 | journalの解放mark COMMIT後、global ledgerのphase記録前に落ちると永久保留 | **採用・修正**。`marking` 意図を先に永続化し、再開時にjournalを再照合。lost COMMIT後・期限経過後も同じIDで再開する試験 |
| ソース安全性 P1 | キャンセルしたplanが累積し1,000件で操作不能 | **採用・修正**。所有確認できた期限切れ未開始planのみ整理。完了照会は直近256件。進行中・不明は保持。1,000件の試験 |
| ソース安全性 P2 | disable中に同じ転送passの後続HTTPが始まり得る | **採用・修正**。実HTTPごとのguardをtransport/blobに接続。実listenerを使う3件PASS。すでに送った要求のACKは保全 |
| 完全復元 P2 | blobの中間ディレクトリfsyncが不足 | **採用・修正**。workspace hash directory・blob root・出力rootを公開前に同期。fault時のmarker/原本保全を2件で検証 |
| 完全復元 P2 | hot journalとreadonly検査の関係 | **採用・修正**。serveで所有を検証してRW回復し、全内容を検証してからlisten。backupは固定理由で保留。実子プロセスSIGKILL等3件PASS |
| 完全復元 P2 | 公開後の検査/close失敗で完了か分からない | **採用・修正**。`server-full-published-unverified` を返し、公開出力を消さない |
| 資格情報 | 旧client IDの再利用を全て禁止する案 | **一部採用**。失効済みIDは拒否。同じactive IDの意図したtoken rotationは維持。Codexが追加発見した旧handoffのreuseによる巻き戻しをCAS拒否し、独立4件PASS |
| 保存耐性 | NodeのfsyncでMac F_FULLFSYNC/停電耐性が保証されるという説明 | **不採用**。今回のNode/故障注入からその保証は出せない。Mac/実停電はNOT_RUN |

最終差分レビューはCLI exit 0で完了し、**提示範囲に確定P0/P1なし**。対象は競合確認ボタンの再照会、cache計数、Linux一時keyringの実行入口、運用手順。P2と未提示範囲は以下のとおりCodexが照合した。

- 古いpreview/応答不明：mainの `WorkspaceConflictDecisionControl.confirm` は同期処理で、preview ID・canPreview・固定targetを検査してメモリ予約する。ここで非同期COMMITはしない。全window閉鎖時にも `assertTarget` を再実行し、初めて永続予約を作る。単なるUI status成功で古いtargetを適用できる構造ではない。既存のtarget変更・unknown応答試験と実終了/起動CIで確認。古いpreviewを自動で閉じるUX変更は今回追加しない。
- byte counter：catalog内はjournal close後、serviceの診断値はledger/mutex close後の観測。書込みadmissionや削除の承認に流用しない。並行変化で保留する場合とページ単位の理由表示を手順書へ追記。
- Linux fixture：Playwright loaderがbasicを後付けするため、一時entryで実keyring backendを復元した。引数末尾のassert、gnome/basicの実backend確認、finally cleanupを追加。FOLIO_DATA_DIR/vaultは専用一時先。各shardは別runner、worker 1。実データの秘密は一切使わず、traceには終了済み合成サーバーのtokenが残り得ることと7日保持を明記。
- 運用：受渡しJSONの登録後の保管/削除、clipboardに残さないこと、hot journal回復中にトンネルを閉じることを追記。
- レビュー本文の「CIは未完」という記述は途中時点の証拠に基づく。その後 `9ddb60c` のquiet 2,078件・GUI 238件が全PASS。レビューに提示していなかったlifecycleのConnection: closeは試験fixtureだけの変更で、実HTTP・全内容検査を維持し、製品のretryは追加していない。Codexが非GUI/Actionsで合格を確認した。Opusがそのコードまで読んだとは扱わない。

レビューは提示ソースについての助言であり、全経路の無欠陥証明・Mac/物理2台の受入ではない。

主要な試験：`m3-transfer-maintenance.test.ts`、`m3-transfer-suspension.test.ts`、`m3-full-directory-sync.test.ts`、`m3-credential-reuse.test.ts`、`m3-server-hot-recovery.test.ts`、`m3-product-lifecycle.test.ts`。ファイル名・件数は最終quiet記録で照合する。
