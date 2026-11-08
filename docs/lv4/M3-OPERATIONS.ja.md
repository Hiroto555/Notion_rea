# M3候補の運用・保全手順

2026-11-08。これは最終受入候補の手順書。実データへの導入・masterへのマージ・Mac GUIの実行を今回許可するものではない。初期範囲は同一所有者のMac 2台、サーバー1台、手動送受信、全ウィンドウ閉鎖後の次回起動時適用。共同編集・常時自動同期・Windows認定は含めない。

## 1. サーバーと秘密の置き場所

Node 24とビルド済み `dist/server-ops.cjs` を使う。サーバーは127.0.0.1だけにlistenし、別端末からはSSHトンネル等でloopbackへ接続する。実トンネル・スリープの受入は別途必要。

サーバー・資格情報受渡し・バックアップは別の専用フォルダーに置く。親は所有者だけがアクセスできる0700、受渡しファイルは0600。workspace/assets/backups/serverや既存バックアップの内部へ資格情報を置かない。本番の保存先は利用者が管理する永続領域を選ぶ。以下の名前は例示で、今回これらの本番フォルダーは作成していない。

```sh
mkdir -m 700 "$HOME/Folio-Lv4"
mkdir -m 700 "$HOME/Folio-Lv4/handoff"
node dist/server-ops.cjs init --directory "$HOME/Folio-Lv4/server" --workspace my-workspace --owner my-owner --port 43121
node dist/server-ops.cjs issue --directory "$HOME/Folio-Lv4/server" --client mac-a --credential-file "$HOME/Folio-Lv4/handoff/mac-a.json"
node dist/server-ops.cjs issue --directory "$HOME/Folio-Lv4/server" --client mac-b --credential-file "$HOME/Folio-Lv4/handoff/mac-b.json"
node dist/server-ops.cjs serve --directory "$HOME/Folio-Lv4/server"
```

`serve` の終了はSIGINT/SIGTERMを使う。管理・発行・失効・status・backupは、所有プロセスの停止を確認してから実行する。別プロセスのPIDを推測してkillしない。稼働中の排他拒否をロックファイル削除で迂回しない。

トークンは受渡しJSONだけに出力する。CLI引数・stdout・エラーログへは出さない。JSONをチャット・Git・CI artifact・共有ログへ貼らない。`issue` が結果不明でも受渡しファイルやサーバーを削除しない。`--reuse-credential` は未登録または現在と同じ資格情報の再照合用。古いトークンへの巻き戻し・失効済みIDの復活には使えない。通常のローテーションは新しい受渡しファイルを指定して `issue` する。

登録と次回起動の接続が成功した後、受渡しJSONは管理する別の暗号化保管先へ退避するか、不要になったことを確認して削除する。結果不明の間は残す。手入力/貼付けに使ったトークンをclipboard履歴や画面収録へ残さない。本番の秘密を試験へ持ち込まない。CIの実IPC試験では使い捨てサーバーの合成資格情報だけを使い、その入力がtraceへ残る場合がある。終了した合成サーバー以外では使えず、artifactの保持は7日。

## 2. アプリで初回接続・更新・無効化

「同期設定」からURL・workspace ID・client ID・サーバー発行トークン・接続モードを入力する。SSH転送のローカルポートがサーバーのポートと異なる場合、URLには実際のローカル転送先を指定する。

- `publish`：この端末の保存内容を初回送信する。既存サーバーの内容を無条件に上書きしない。
- `join`：空の新規workspaceを使う。空の初回起動には `FOLIO_EMPTY_WORKSPACE=1` が必要。既存データを消して空にしない。
- `recover`：通常の完全workspaceバックアップを**新しい場所**へ復元したv5コピーを明示登録する。稼働中の原本・古いbinding付きコピーは対象外。

保存後は「次回起動待ち」。設定保存だけで送信・本文適用・schema昇格を実行しない。未保存入力を解消し、通常終了した次回起動でmainが照合する。トークン更新では同じ物理DBのbindingを保つ。無効化は新しい通信の開始を止め、永続化された無効状態を旧環境変数より優先する。すでに送った要求のACK/receiptは保全する。

秘密はworkspace外のvaultにOS暗号化で保存し、物理DBの場所・inode等とrecovery identityに結び付ける。DBをコピーしても旧資格情報を自動取得しない。暗号化不能・Linuxの `basic_text`・復号不能では保留する。Mac Keychainは今回NOT_RUN。

## 3. 完全サーバーバックアップと復元

稼働を止め、クライアントの未保存入力・未確定送信・受信待ちを記録する。完全server backupはheadsだけでなく、全change・operation・receipt・敗者候補が参照する添付を検証してコピーする。旧catalog snapshotは完全backupの代わりにならない。

```sh
node dist/server-ops.cjs status --directory "$HOME/Folio-Lv4/server"
node dist/server-ops.cjs backup --directory "$HOME/Folio-Lv4/server" --destination "$HOME/Folio-Lv4/server-backup-001"
node dist/server-ops.cjs inspect --backup "$HOME/Folio-Lv4/server-backup-001"
node dist/server-ops.cjs restore --backup "$HOME/Folio-Lv4/server-backup-001" --destination "$HOME/Folio-Lv4/restored-server-001" --port 43121
```

出力先は未存在の新規ディレクトリだけ。原本・既存先を上書きしない。復元はfresh serverEpochと全旧device失効を同じSQLite transactionで確定する。旧履歴のepochは証拠として保持する。**旧サーバーを同じendpointで稼働させたまま復元先を公開しない。** 復元先には新client IDで資格情報を発行する。

`server-recovery-required` は中断したSQLite transactionの回復が必要な状態。検証された所有ディレクトリを `serve` で開いて回復・正常終了してからbackupする。journalを手動削除しない。`server-full-published-unverified` は出力公開後の検査・close結果が不明な状態。出力を保ち、`inspect` 等で照合する。成功と決め付けたり、同じ先を削除して作り直したりしない。未完了marker付き先は起動しない。

回復用の `serve` も検証後にlistenするため、回復作業中はSSHトンネルを閉じ、ほかのクライアントを接続させない。復元先へ切替後は旧サーバーと旧トンネルを停止したままにし、原本は保全する。

## 4. サーバー復元後のクライアント

1. 原本を保持し、通常の「バックアップと復元」で完全workspaceバックアップを作り、検証する。
2. そのバックアップを新しいクライアントフォルダーへ復元する。原本に上書きしない。
3. 復元サーバーで新しいclient ID・資格情報を発行し、新規コピー側で `recover` を保存する。
4. 通常終了・次回起動で、接続・epoch・bindingと入力状態を再確認する。rebind前にも完全backupを作り、旧queue・ACK/receipt・本文・添付を保全する。
5. 自動で旧queueを再送したり、旧原本と復元先をmergeしたりしない。両候補を確認し、通常/競合の明示予約から適用する。

M1の「保全した競合データ」から作った回収コピーは恒久的に同期保留する。そのmarkerを外して `recover` する操作はない。通常完全workspace復元と、競合回収コピーを混同しない。

## 5. 容量上限と保全停止からの対応

| 領域 | 初期上限・挙動 | 対応 |
|---|---|---|
| checkpoint | UTF-8 1MiB、添付1件20,000,000B | ページ数では保証しない。上限超過を履歴削除で隠さない |
| サーバー履歴 | 保持対象1,024行 / 64MiB | 未解決履歴・receiptを自動pruneしない。検証済みserver/client backupを保全し、容量・方式を再判断する |
| クライアントqueue/履歴 | 保持対象512行 / 64MiB | pending ACKを保存する余白を事前確保。未確定送信を削除しない |
| サーバーblob | 256MiB / 4,096エントリー | 新規書込みを保留。既存blobを自動削除しない |
| 転送cache | workspace横断128MiB、走査にも上限 | 所有証明付きの明示解放。unknownは残す |
| workspace backup | 8世代 / 512MiB | 検証済みの古い世代を既存の外部退避導線で移し、再照合する。最新・使用中は保護 |
| 競合回収bundle | 100MiB / 1,000添付 | 原本archive・失敗出力を保持。今回自動GCを追加しない |

「同期設定」の診断で保持量と保留理由を確認する。転送cacheは対象・byte数・scopeをドライランで確認してから解放する。ticketは約3分有効、実行開始後の中断は同じ操作IDで照会・再開する。返答不明時に別の操作を増やさない。未開始の期限切れplanだけを所有確認後に整理し、完了照会は直近256件を保持する。実行中・所有不明の記録は自動整理しない。

容量表示はSQLiteの所有journalと排他を閉じた後の観測値で、並行処理が進めば変化する。一覧の保留理由はそのページの結果であり、最初のページの「なし」は全cacheの健全性を保証しない。走査中の変更は安全側に保留し、更新して再照合する。この診断値だけで書込み・削除を許可しない。

cache解放はlive assets・staging・backup・M1 archiveを削除しない。古い空scopeのmetadata整理も固定名の所有ファイルだけ。履歴が上限に達した場合の無損失自動rollover/bootstrapは未提供。通常のバックアップを取るだけで履歴上限がリセットされるわけではない。

## 6. 最終受入で残す確認

Mac Keychainの保存・更新・削除・ロック、実IME変換中の終了拒否、Cmd+Q/ウィンドウ閉鎖、ネイティブpicker・clipboard、物理Mac 2台での両方向同期・実SSHトンネル・切断/再接続・スリープ・復元後再登録はNOT_RUN。NodeのSIGKILL/fsync故障注入は実停電の証明ではない。`fsyncSync` をMacの `F_FULLFSYNC` や停電耐性の保証として扱わない。

Linux CIの実IPC試験でpicker応答を一時先に置き換えるものは、OSのpicker操作の合格には含めない。Lv4認定はこれらの受入結果を同じ候補へ揃えてから判定する。
