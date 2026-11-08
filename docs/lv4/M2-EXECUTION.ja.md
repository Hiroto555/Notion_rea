# M2 非GUI実装の実行記録

2026-11-08。M1とLinux GUI69件の受入後、利用者がOpenCode GoのDeepSeek Flash 4.1を主力に、Devin CLIのOpus 5.5へ方針・分担を相談し、使用量を工夫して進めるよう指示した。範囲確認への回答は「できるだけ進めて」。以前のA3前停止から、A3以降の非GUI作業を段階的に進める指示として扱う。

統合ブランチ`codex/folio-m2-20261108`、基準`3aac7e9`。Mac GUI・Electron・実OS操作、利用者の実データ、元master、masterへのマージは範囲外。まずA3の再開・保持を検証し、その後A4〜A7の依存が成立する範囲へ進む。機能ごとに終了条件・実行結果を区別する。Levelは実機受入までLv3を維持する。

## A3の契約（第1段階）

- 親だけが既存workspace-blobs.ts、WorkspaceSync、共有型、schema/IPC等の統合部分を編集する。Flashは担当した新規モジュールと専用試験だけを編集する。
- 永続再開は明示的なtransfer scope付きで有効化する。scopeはbaseURL hash、workspace/client/binding/epoch。tokenを記録しない。回収marker・apply guardは変更しない。
- 独立した転送用SQLite journalをprivate directoryに作る。アプリの内容schemaは変更しない。SQLiteの排他lockingで、別processが同時に転送記録を所有せず、SIGKILL後にOSがlockを解放する。
- download partialはjournalで指定したkey.partだけ。全体サイズ/SHAの検証前にactive assetsへ公開しない。既存の排他hardlink公開を再利用する。
- 再開offsetはfsync済みのcheckpointのみ。partialのprefix SHAも記録し、再開時に照合する。短縮・改変・symlink・特殊file・不明な所有は保全して停止する。未確定tailの巻戻しは記録で所有を証明したpartialのみ。
- server upload partialは既にworkspaceごとに分離され、slice ACK前にfsyncされている。新規の認証付きHEAD確認ではpartialのoffset/prefix SHAのみを返し、GETには公開しない。既存の範囲PUTを再利用する。
- 上限は保守的に転送journal1000件、active/blocked予約100MiB、添付1件20,000,000B。上限時に無記録・無制限転送へfallbackせず保全停止する。
- 棚卸しはread-only。legacy orphan、未知ファイル、active/blocked、完成済みを区別する。TTLだけの自動削除、M1 archive/backup/原本の削除は追加しない。完了済み記録の整理はcache bytesの安全な解放と分ける。
- Nodeの子process SIGKILL→別process再開、Range起点、送信再開、hash/size、不正partial、排他、容量、公開前後の中断を一時データ・loopbackで検証する。

## 分担・使用量

| 担当 | 範囲 |
|---|---|
| Codex | API/型、既存transportとWorkspaceSync接続、差分検査、独立受入、最終quiet、scope/記録 |
| Flash J1 | 転送SQLite journal・排他・上限・単体試験 |
| Flash J2 | partial FDの安全なopen/checkpoint/再開・公開後回復・単体試験 |
| Flash J3 | read-onlyの保持量/所有状態の棚卸し・単体試験 |
| Flash J4 | server partial offset/prefix確認・process間upload排他・専用試験 |
| Opus 5.5 / Devin CLI | 小さい共通要約で方針相談、契約レビュー、統合差分の重点安全性レビュー |

Flashの初回read-only調査2本はpermission path不一致で未読。relative-path allowlistへ修正して同じモデルで再実行し、読取り済みの調査2本を取得した。未読の出力を実ソースのレビュー合格とは扱わない。

Opusの助言は親が実コードと照合して採否を判断する。既に存在するworkspace分離/fsyncを不足とする指摘は採用しない。上限超過時に従来の無記録転送へ戻す提案も採用しない。新たなGUI実行や削除承認が必要という一般的な提案を、利用者の実装範囲へ勝手に適用しない。

各workerへは担当ファイル・小さい契約・対象試験コマンドだけを渡す。全履歴・共通長文の重複送信、同じ機能の重複実装、workerごとの全suite実行を避ける。最大4本、対象Vitest maxWorkers=1、個別cache。追加課金・利用枠・グローバル設定は変更しない。usageは取得できたproviderフィールドを別々に集計し、課金や総量の断定に使わない。
