# Folio Round 4　使用量の上限、保守、破損データの救出

2026-11-05。統合先は `<workspace-root>/Folio-l3-r4-integrated`、ブランチは `codex/folio-l3-r4-integrated-20261105`。Round 3の `646b658` から開始した。検証したコードは `a4bb88c5af57f88542faceb7227740eab25eb872`。

## 統合した動作

| 利用場面 | 動作 | 根拠 |
| --- | --- | --- |
| ワークスペースの使用量を把握する | 手動でDB・添付・保存記録・バックアップを計測。前回の完全な計測との増減を表示する。専用workerが読み取り専用SQLiteで集計し、同時の計測要求を共有する。ページがない場合にも入口がある | `workspace-overview.ts`、`storage-overview-reader.ts`、`WorkspaceMaintenancePanel.tsx` |
| 保存量を制限する | ワークスペースごとのDB・添付・バックアップ容量、保存記録の件数を設定できる。設定をSQLiteに保存し、別画面の古い設定更新は拒否する。環境変数と利用者設定が共存する場合は小さい上限を採用 | `workspace-limit-settings.ts`、`workspace-growth.ts`、`WorkspaceLimitsPanel.tsx` |
| 容量上限に達する | ページ変更と保存記録の作成より先に拒否。DBは現在の論理ページ総量を使うため、1回の操作で上限を越えた場合は次の操作を止める。保存記録の上限では既存IDの照合を維持し、未適用の操作は同じIDで再試行できる | `workspace-storage-service.ts`、`dsh-r4-storage-integration.test.ts` |
| 添付・バックアップ・復元を開始する | 添付は読んだ実バイト数、バックアップはWALを反映したSQLite論理ページと添付ツリーの見積もり、復元は復元先ボリュームの容量で判定。旧バックアップと移行前スナップショットにも適用 | `bulk-storage-budget.ts`、`assets.ts`、`workspace-backup-service.ts`、`legacy-migration-operation.ts` |
| 古い完全バックアップを退避する | 事前選択と明示実行を分離。厳密に新しい検証済み世代があり、選択した元が使用中でない場合のみ、同じボリュームの外部フォルダーへ移動する。元と先の内容を再確認し、移動後の失敗は移動済みとして通知する。移動先から復元できる | `backup-maintenance.ts`、`workspace-maintenance.ts` |
| 台帳外ファイルを整理する | 台帳と実ファイルを照合。登録済み、添付URLで参照可能なUUID名、リンク、台帳解読失敗などは保全する。対象を選択して確認した場合だけ、参照不能な補助ファイルを同じボリュームの外へ退避する | `orphan-maintenance.ts`、`workspace-overview.ts` |
| 破損ページを救出する | 同一ワークスペースのライブSQLiteから一貫したスナップショットを取得し、通常添付と復旧ジャーナルを外部の新しいフォルダーに書き出す。ファイルのハッシュ、SQLite整合性、未完マーカーを確認。ページJSONを解読できなくても原文を取得できる。形式を完全バックアップと区別する | `raw-workspace-salvage.ts`、`raw-workspace-salvage.test.ts` |

上限は初期状態では未設定。画面から指定する容量の単位はMiB、保存記録は件数。管理者は `FOLIO_MAX_DATABASE_BYTES`、`FOLIO_MAX_ASSET_BYTES`、`FOLIO_MAX_BACKUP_BYTES`、`FOLIO_MAX_RECEIPT_ROWS` を設定できる。R3の256 MiBのディスク安全余裕は別に判定する。設定が不正・破損しても使用量の計測・救出は利用できる。

## DeepSeekの分担とCodexレビュー

DeepSeek Harness headless、Flash 4.1、推論max、独立worktreeで4並列。Aは上限と永続設定、Bは大きな書込みの見積もり、Cはバックアップと台帳外ファイルの保守、Dは破損データの救出を担当した。Aの初回はプロバイダー応答のJSONエラーで中断した。同じセッションと作業ツリーから再開し、境界条件を修正して完了した。各担当の確定SHA、完了状態、実行ログの所在は成果物の `RESULT.json` に記載した。

Codexが実際のIPC・アプリ側の入力経路、計測worker、上限変更、復旧用の経路を接続した。独立試験で最初に再現した3件は、別ワークスペースのSQLite接続を使って救出できたこと、ハードリンクされた別ファイルを取り込めたこと、退避後に表示した親ディレクトリをそのまま復元に使えなかったこと。3件とも修正した。さらに、別の完全バックアップの内部を出力先に選ぶと、そのバックアップを無効にしてしまう問題も防いだ。

確認できないフォルダー使用量は上限内と扱わない。救出用の追加容量には復旧ジャーナルを含めた。古いバックアップの保護は「選択した元より新しく、完全検証に成功した世代がある」ことを条件とし、検査対象数にも上限を設けた。

## 検証結果

| 確認 | 結果 |
| --- | --- |
| 保存・保守・救出の対象試験 | 11ファイル / 94件 PASS |
| 統合版の型検査 | PASS |
| 統合版の全unit suite | 108ファイル / 1,101件 PASS |
| production build | PASS |
| ビルド済みの集計workerをNodeから実起動 | PASS。一時SQLiteの保存記録を1件取得 |
| `verify:quiet` 全体 | exit 0、45.3秒、maxWorkers=2 |
| GUI・Electron起動・実ダイアログ・実ディスク圧迫 | NOT_RUN |

ビルドには既存のdynamic/static import混在と500 kB超chunkの警告が残る。全体ログは `output/review-r4/verify-quiet.log`、対象ログは `output/review-r4/targeted-integrated.log`。独立再現した修正前3件は `output/review-r4/independent-before.log` に残した。IPCのsender/schema境界はコード確認、製品が使うサービスは選択先を一時フォルダーに差し替えて実行した。

合成計測では、1,000件・10,000件の保存記録とそれぞれ同数の空添付ファイルを一時フォルダーに作った。通常保存用のDBサイズ判定は200回平均で各0.004ms、添付追加時のツリー判定は9.5ms / 44.0ms、workerでの全体計測は46.1ms / 87.9msだった。計測中に親側の10msタイマーは4回 / 8回動いた。1台のMacによる参考値で、通常保存の数値はDBページ確認単体の値。添付・バックアップ・退避・救出の大きな処理はmainで同期実行する部分がある。

## 到達段階と残る確認

**Level 2到達、Level 3部分達成。** 容量と保守（G7）では、保存を止めても入力・保存記録を保持する経路と、実ファイルを安全に退避する経路を非GUIで確認した。過去のUUID添付のうち参照を否定できないものは保全する。完全バックアップの退避は同じボリュームに限られ、ワークスペースの上限を空けても、ディスク全体の空き容量は増えない。DBの上限はSQLite論理サイズの事前判定で、WALや次の取引が書く全バイトの厳密な物理上限ではない。

G1/G8のネットワーク遮断下の起動→編集→再起動、容量停止からの実画面の操作、IME、保存先選択、退避した世代の実機復元は **NOT_RUN**。起動時のStore準備・旧スキーマ移行は通常IPCの容量判定より前に動く。実データ・物理停電・Desktop配布版・GitHubへの反映は検証範囲外。次の実機項目は `docs/GUI-VALIDATION-QUEUE.ja.md` に記録した。


検証ログ・分担記録の固定コピーは `<workspace-root>/Notion_rea/outputs/folio-l3-r4-20261105/integration` に置いた。
