# shared runtime候補のNode運用仕様

これは今回実装した候補の入口を説明する資料。実データ・既存Folio profile・本番serverで実行した記録ではない。今回の実行は専用一時directoryとloopback試験に限る。GUI、push、workflow、master merge、実Keychain/DPAPI、課金設定を操作していない。

`npm run build` はGUIを起動せず、通常bundleに加えて `dist/shared-server.cjs` とnative helperのsourceを生成する。native .exeを実行・配布・署名する処理ではない。

## 新しい検証用authorityを作る

`npm run folio:shared-server -- bootstrap` の引数:

- `--root`: 新しい専用shared rootの絶対path。private Folio DBを開かない。
- `--org` / `--user` / `--device` / `--workspace` / `--document`: 検証用identity。
- `--credentials-output`: root外の新規fileの絶対path。親は利用者所有のprivate directory。既存fileを上書きしない。

資格情報は0600の新規fileだけへ出力し、stdoutにはtoken/recovery keyを出さない。作成結果が不明なら `BOOTSTRAP_UNKNOWN` として出力と専用rootを残し、同じ操作を自動再試行しない。rootのrole/application ID/versionが違うと拒否する。

## Node serverを起動する

`npm run folio:shared-server -- serve --root /ABS/OWNED/shared --host 127.0.0.1 --port PORT --loopback-http`

これは使い捨てデータのloopback用。非loopbackは `--key` / `--cert` で与えたTLS材料を使い、TLS1.3以上を要求する。通常のsystem TLS検証を無効にしたり、trust storeを変更したりしない。`--loopback-http` とTLS設定を混ぜない。既存のbootstrapped authorityだけをserveし、起動時にownerを作り直さない。

本体の「共有ワークスペース」で、server URL・org ID・tokenを明示入力して接続する。記憶を選んだ場合だけmainの非同期credential portを使用する。招待tokenは別の参加フォームで使う。独立serverでの実運用はNOT_RUN。

## backupと復旧

`POST /v1/backup` は現在token、org管理権限と全workspaceのreadを確認し、canonical backupを返す。通常のJSON RPCの8MB上限と別に有界streamで取得する。本体からのexportは新規外部file限定で、private/shared root内、rootの祖先、既存file、symlink/hardlink aliasを拒否する。

復元は新しいdestinationとepochを使う。元authority・backup file・元credentialsを上書きしない。現在の正当な運用者を再認可し、過去のsession/device/recovery keyを復活させない。復元後のoperator credentialは新規0600 fileへだけ出力する。運用入口は `npm run folio:shared-server -- restore` に、`--root`（現在authority）、`--org`、`--token-file`（現在の0600 credential JSON）、`--backup`（canonical backup）、`--destination`（未作成directory）、`--epoch`（新ID）、`--device`（新device ID）、`--credentials-output`（外部の新規0600 file）を渡す。key/tokenをargvへ渡さない。新realmの明示再認可を行い、最終genesisは新sessionと元backup hashへbindする。

運用入口の最終引数・試験は `src/collaboration/runtime/restore-operator.ts` と `tests/shared-runtime-restore-operator.test.ts` を参照する。成功を確認できなければ `RESTORE_UNKNOWN` として出力を残す。

低位の `SharedAuthority.restoreInto` は新realm・新recovery keyと `requiresReauthorization` を返す。retentionの `verifyBackup` は別destinationへ実restoreした証明を発行する。これを任意hashやmetadataだけで代用しない。現在のorg管理者だけが検証・compactionでき、対象writerのdurable fenceが必要。receipt/dedup/Undoと必要prefixを削除しない。

## 対応範囲

本体Editorは型付きbatch、rich inline／mark、split/join、move、list/quote等のframeと専用表操作を共有serviceへ接続した候補。position更新は専用PM Step/Mapとincremental projectionを使う。無条件のfull採用・Level認定はしていない。最新の根拠は[継続記録](20261110-lv46-continuation-progress.ja.md)へ分離する。

個人→共有copyは通常ページ・DB・選択recordの5 property型に対応。大きなコピーをmanifest、分割原稿、別送添付へ分け、最終cutで公開する。1ページ2MB、分割原稿合計32MiB、100分割、同時未完了8件／全体予約32MiB、実Store64MiB、outbox20MB等の複数の上限があり、これらを同時に最大まで使える保証ではない。未公開原稿・拒否原文を他のwriterのsnapshotへ送らない。中止は受付結果を確認した後の明示操作で、原文・receiptを無条件削除しない。

Windows候補はnative probe／Job Object／専用root／File ID／SID/DACL、shared RuntimeStoreとPrivateLedger／vault／recovery index／選択添付読取のnative proofへ接続するコードを持つ。helperはアプリDLLを埋め込むsingle-file EXEとしてbuildし、指定hashを照合する。共有system .NET 10 runtimeが必要で、実OS動作を証明するものではない。Mac上のmanaged compilation、win-x64 cross-publish、PE/bundle検査と注入contractをWindows OSのPASSとしない。

本CLIのbootstrap／restore／maintain／recoverが使う私有資格情報の新規公開はPOSIXのfile＋directory fsyncに依存する。Windows用のnative資格情報公開portと、既存privateの全journal／durable-file／終了監視を共通portへ移す作業は完了していない。Windows OS／DPAPI／sharing violation／Job Object回収／署名・アプリpackage／停電耐性はNOT_RUN。このコード上の不足を実機待ちだけとは記載しない。


## 所有者の端末・キー回復（非GUI）

既存authorityを停止した保守枠で、`folio:shared-server -- recover` に次の引数を渡す。

- `--root`：既存shared専用root。
- `--org` / `--device`：対象組織と新device ID。
- `--recovery-key-file`：0600の回復キー原文、またはbootstrap/restoreが出した `{token,recoveryKey}` JSON。
- `--credentials-output`：root外のprivate directory内の新規0600 file。

新token／回復キーを上書きしない私有fileへ永続公開した後で、所有者回復の外側SQLite transactionをCOMMITする。元キー・旧tokenは確定後に失効する。結果が不明なら `RECOVERY_UNKNOWN` と出力を保全し、自動再試行しない。秘密はargv/stdoutへ出さない。Windows資格情報公開portは未実装なので、この入口はWindowsで明示拒否する。

## 検証・圧縮・protocol更新・添付回収

`folio:shared-server -- maintain --root ROOT --org ORG --token-file FILE --action ACTION` が入口。稼働中authorityと同時に実行せず、同じ専用rootを保守枠で開く。tokenをargvへ直接置かない。結果JSONには秘密を含めない。

| ACTION | 追加引数と意味 |
| --- | --- |
| `preview` | 容量・保持等の状態を読む |
| `verify` | `--destination NEW --epoch ID`、任意`--backup FILE`。実隔離restoreで検証 |
| `compact` | `--destination NEW --epoch ID --backup FILE`。既知prefixの実復元証明とwriter fenceが必要 |
| `upgrade` | `--destination NEW --epoch ID`。実復元検証後、1003→1004のbaselineを原子的に作る |
| `collect-preview` | `--workspace ID --document ID --incarnation ID`。参照・履歴・Undo等を確認した候補cut/hashを返す |
| `staging-preview` | `--workspace ID --document ID --incarnation ID`。組織ownerが未公開copyのwriter／hash／予約容量／fence状態とcutを読む |
| `staging-abandon` | 同じscopeに加え`--writer ID --copy-id ID --manifest-hash HASH --expected-cut JSON`。全device／session失効済みwriterの未公開原稿だけを明示回収。旧raw／intent／receiptは保持 |
| `collect` | 同じscopeに加えて`--expected-cut JSON --hashes JSON_ARRAY`。同じcutの再計算が一致した場合だけ実行 |

圧縮はreceipt／dedup／未確定原文を消す万能purgeではない。有限容量に達したときは保全停止し、完了したように表示しない。保持期間・実負荷のRPO/RTO保証は未測定。
