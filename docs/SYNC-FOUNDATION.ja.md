# Checkpoint同期の通信基盤（非GUI・未接続）

この文書は通信基盤単体の段階の記録です。製品の試験経路は [Folioの端末同期実験](SYNC-WORKSPACE-EXPERIMENT.ja.md) を参照してください。

この実装は `src/sync/` に閉じた、同一所有者の複数clientを想定する通信基盤です。**Folio本体の双方向同期やLevel 4到達を意味しません。** Store/main/IPC/renderer/backupとは接続しておらず、GUIも起動していません。

## 確認対象

- `protocol.ts`：name/versionを明示したJSON checkpoint、canonical SHA-256、strict wire shape、サイズ・複雑さの制限。
- `checkpoint-server.ts`：127.0.0.1限定HTTP、workspace capability token、SQLite永続head/change/operation receipt、workspace単位CAS。
- `transport-journal.ts`：client固有SQLite、immutable送信envelope、受信inboxとcursorの同一transaction、競合双方の保持。認証tokenは保存しません。
- `client.ts`：明示的なhead/prepare/push/receipt照会/pull。自動再base、自動conflict解決、バックグラウンド送信はありません。
- `sqlite-guard.ts`：BEGIN/COMMITの成否不明、ROLLBACK失敗、transaction状態の不明時には接続を停止します。serverは以後のDB APIをHTTP 503、journalは以後のDB読み書きを拒否し、close/reopen後に確定したreceiptを調べ直します。元の処理エラーとrollbackエラーを両方保持します。

同じoperation IDと同じfingerprintの再送は、最初に確定したreceiptを返します。同IDで違う内容は拒否します。サーバーcommit後にACKが失われてもclientは同じenvelopeを保持し、再送またはreceipt照会できます。競合ではlocal候補と競合時のremote headを両方残し、clientの新規送信を停止します。別ページ同士の編集でもworkspace全体が競合する粗い方式です。

受信cursorは「SQLite inboxに格納済み」の位置です。**Folioに適用済みの位置ではありません。** `status().application`は常に`not-connected`です。apply APIは設けていません。conflict解決APIもこの段階では未実装です。

## 呼び出し契約

1. 専用のserver DBに`startCheckpointServer({databasePath, capabilities, validateCheckpoint})`。tokenは暗号学的乱数32byte以上から作り、設定で渡します。サーバーはtoken本体をDBに書きません。owner/workspaceを既存DBと照合します。
2. clientごとに別のjournal DBと`clientId`、DB外の設定に保持する`bindingId`を用意します。同じDBを違うbindingで開くと拒否します。
3. `client.head()`でserver epochを結合し、観測したrevisionを取得します。serverが作り直された場合はepoch不一致で停止します。
4. `client.prepare(checkpoint, observedRevision)`でenvelopeをSQLiteへ確定してから`push()`します。別のlocal保存と同一transactionにする機構はまだありません。
5. `pull()`を繰り返すと1 checkpointずつinboxへ蓄積します。inboxは読み出せますが製品へ適用しません。

checkpointは`{format:'folio-checkpoint/v1', name, version, payload:{...}, assets:[]}`です。`payload`はtransportにとって不透明です。サーバーには同期的なschema predicate `(checkpoint) => boolean` が必須で、`true`だけを受理します。async predicateやfalse/例外はhead/receipt/changeを変更せず拒否します。テストではfixture専用name/versionのみ許可します。Folioのpage/record/親子/削除整合性を検証したと誤認しないでください。

上限はcheckpoint 1MiB、HTTP envelope約2MiB、変更取得1件/回。大workspaceを無条件に扱える実装ではありません。超過時は拒否し、送信箱を保持します。外部依存追加はありません。NodeのHTTP/crypto/SQLiteと既存Vitestのみ利用します。

## 明示的な未実装・未検証

| 項目 | 状態 |
| --- | --- |
| Store保存とoutboxの原子的確定、全変更入口の捕捉 | 未接続 |
| 実Folio snapshotの生成・適用・tombstone/親子/record検証 | 未実装 |
| 添付blob転送 | 未実装。非empty assetsを拒否 |
| IME/raw/dirty/unknown sessionのquiescenceと旧epoch save拒否 | 未実装。inboxで停止 |
| 旧Storeの書込み拒否に必要なv5移行/record/backup検査 | 未実装 |
| backup復元後のdevice再bindingフロー | 未実装。journal binding不一致拒否だけ確認 |
| 自動競合解決、CRDT、複数人共同編集、Presence、ページACL | 対象外 |
| インターネット公開/TLS/アカウント・token配布/失効UI | 未実装・未公開 |
| Electron/ブラウザGUI、実2端末 | NOT_RUN |

DB外のbinding設定ごとコピーすると同一client identityを複製できます。このモジュール単独では端末識別やバックアップ再結合を完成させません。サーバー全履歴とjournalは無期限保持であり、GC/容量運用も後続です。server DBの過去バックアップへの巻き戻し検出にはepochの運用設計が必要です（同じepochのまま以前のDBへ戻してはいけません）。

## 検証方法

`npx vitest run tests/sync-checkpoint*.test.ts`。テストはOS一時ディレクトリの専用DBとloopbackだけを使用し、既存Folioデータを開きません。テスト成功が保証する範囲は通信/再送/永続journalの境界までです。

故障注入では、serverのreceipt INSERT失敗時にhead/changeもrollbackすること、clientのcursor UPDATE失敗時にinbox INSERTもrollbackすることを確認します。いずれも失敗を解除すると同じoperation/cursorから再開します。これはSQL transaction途中失敗の検証であり、電源断や実端末の障害検証ではありません。
