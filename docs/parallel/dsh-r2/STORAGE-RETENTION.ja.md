# Folio G7 — 容量計測と保持・上限制御の契約（担当B）

2026-11-05 / branch `codex/folio-l3-r2-capacity-20261105` / 基準 `e00dc172f413f547ee6f0a0beab6d7bfa6d757d3`

## 結論

- 読み取り専用の容量レポート `readStorageUsage(store)` を追加した。SQLiteの行数・UTF-8保存bytes・実ファイルbytes・未測定・未走査・不完全backupを別々に返す。書込み・VACUUM・削除・圧縮・receipt書換えは一切しない。
- **receipt/backupの自動削除（GC）は実装していない。** 現状の永続的なowner/ack watermarkが不足しており、「再送同一性を壊さずに消してよい」と証明できないため。件数や古さだけでのGCは行わない。
- 上限到達時の書込み停止も**設計のみ**。main/Appへの配線はCodexレビュー後の別変更とする。計測できただけではG7 PASSとしない。
- 本ラウンドのG7は **PARTIAL**。計測APIと試験、保護対象・GC証明条件・停止境界の設計まで。GUIはNOT_RUN。

## 1. 追加した読み取り専用API

| ファイル | 役割 |
| --- | --- |
| `src/shared/storage-usage.ts` | レポート型、上限評価、安全な加算、状態合成。I/Oなし |
| `src/persistence/storage-usage.ts` | `Store.readSnapshot` 内のSQLite集計、明示対象だけのfilesystem走査、backup分類 |
| `tests/l3-storage-usage.test.ts` | 実SQLite/実ファイルfixtureによる統合試験 |
| `tests/l3-storage-usage-files.test.ts` | 仮想filesystemによる打切り・race・権限・symlink・overflow試験 |

```ts
readStorageUsage(store: Store, options?: {
  now?: () => Date;
  scanLimits?: Partial<StorageScanLimits>;
  operations?: Partial<StorageScanOperations>; // 試験用。本番はnative fs
}): StorageUsageReport

evaluateStorageCapacity(report, limits): {
  status: "not-configured" | "within" | "exceeded" | "unknown";
  ...
}
```

### 1.1 レポートの状態

| フィールド | 意味 |
| --- | --- |
| `state` | `complete` / `partial` / `unknown`。不完全を0 bytesとして扱わない |
| `database.tables[]` | 必須5表と任意10表。`present`（行数・保存bytes）と`missing`（null）を区別 |
| `database.unrecognizedTables[]` | 既知でない表。内容は走査せず、`partial` にする |
| `database.receipts` | 行数、`result_json` のUTF-8 bytes、最大行bytes、壊れたJSON数、status別件数、検査行数 |
| `database.slots[]` | DB本体、`-wal`、`-shm`、`-journal`、`.pre-v2`、`.pre-v3`、`crash-recovery.json`、未完marker、`crash-recovery.json.stage-*` の実bytes |
| `workspace.assets` | 添付ツリーの実bytes。symlink・権限失敗・打切りを別計数 |
| `workspace.backups.entries[]` | backupごとの `complete` / `incomplete` / `unknown`、marker、manifest種別、宣言bytes |
| `totals` | DBファイル、添付、backup、その他の実bytesと、保存TEXT bytesを分離 |
| `issues[]` | 固定コードのみ。本文・title・ファイル名・例外messageは含めない |

`receipts` は `result_json` の本文を返さない。壊れたJSONは `json_valid` で計数し、statusはSQLiteの `json_extract` で分類する。値は返さず、件数だけを保持する。`maxReceiptClassificationRows` を超えた場合は `inspectedRows` を明示して `partial` にする。

### 1.2 SQLite snapshotの所有権

- DB集計は既存の `Store.readSnapshot` の中でだけ行う。
- callerが既にtransactionを持っている場合、`readSnapshot` はそれを再利用し、**commitもrollbackもしない**。`database.snapshot.callerOwnedTransaction` に観測結果を残す。
- `Store` が閉じている/読めない場合はthrowせず、`database.state = unknown` と `issues` を返す。このとき `evaluateStorageCapacity` は `within` を返さない。

### 1.3 filesystem走査の境界

走査対象はワークスペース直下の明示targetだけ:

- `<db>`, `<db>-wal`, `<db>-shm`, `<db>-journal`
- `<db>.pre-v2.sqlite`, `<db>.pre-v3.sqlite`
- `crash-recovery.json`, `FOLIO-RECOVERY-INCOMPLETE`
- `crash-recovery.json.stage-<id>`（最大100件、prefix一致のみ）
- `assets/` 配下（深さ・件数上限あり）
- `backups/` 直下の各ディレクトリとその配下（深さ・件数上限あり）

`session/`、外部へ書き出したpending journal、ユーザーが選んだ外部backup、`downloads/` は対象外。理由は「Folioの保存データではない」または「ワークスペース外で、読み取り対象を明確に限定できない」ため。

- symlinkは `lstat` で検出し、**辿らない**。リンク先のbytesは数えない。
- `..`・`/`・`\`・NULを含む名前、root外へ解決されるパスは `path-escape` として拒否。
- 既定の仕事量上限: 20,000 entries / 深さ8 / receipt分類50,000行 / 未認識表50件。
- 上限到達は `truncated` / `unscannedEntries` / `state = unknown`。部分合計を `bytes` に入れない。
- 注意: `readdir` 自体は1ディレクトリの全entry名を返すため、極端に多い直下entryでは一覧取得のコストは残る。深い再帰・`lstat`・ファイル読取りは上限で止まる。`assets` と `backups` の直下が数十万件になる場合は、このAPIをmainで同期実行しないこと。
- ENOENT（走査中の削除）、EACCES/EPERM、readdir失敗は `unknownFiles` と `issues` に残し、0 bytesにしない。
- ファイルサイズ加算は `Number.MAX_SAFE_INTEGER` で打ち切り、`counter-overflow` を返す。

### 1.4 backupの分類

`complete` は「markerなし・manifestが既知formatで妥当・`workspace.sqlite` が通常ファイル・workspace形式なら宣言bytesと実bytesが一致」の**構造的な完了**だけを意味する。ハッシュや `integrity_check` は行わない（`verifyFullBackup` の代替ではない）。

- `FOLIO-RECOVERY-INCOMPLETE` あり → `incomplete`
- manifestなし/不正/読めない → `incomplete` または `unknown`
- `workspace.sqlite` なし/危険 → `incomplete`
- 宣言DB bytesと実bytesの不一致 → `incomplete`
- 未知のmanifest形式 → `incomplete`（`kind: "unknown"`）
- backup内のsymlinkや読めないentry → entryの `bytes.state` は `partial`/`unknown`、backups全体も同じ状態

旧来の `{app:"Folio", schema:1}` manifestと、`folio-pre-migration-snapshot` も認識する。**どちらも削除・移動しない。**

## 2. 保護対象（現状の保持方針）

以下はすべて「自動では消さない」。容量レポートは計測のみで、削除APIを持たない。

| 対象 | 保護理由 | 現状 |
| --- | --- | --- |
| `save_receipts` 全行 | 同じoperationIdの再送で二重適用を防ぐ唯一の永続証拠 | 全件保持 |
| `status = unknown` のreceipt | 結果未確定。消すと再送で再適用しうる | 無期限保持 |
| `status = applied` / `rejected` | ACK喪失・再送・復旧snapshotが参照しうる | 無期限保持 |
| `crash-recovery.json` と `.stage-*` | 未保存入力・未確定操作。利用者の救出対象 | 自動削除なし。stage失敗ファイルも診断用に残す |
| 外部へ書き出したpending journal | 手動確認用。アプリは内容も存在も追跡しない | 一切触らない |
| `versions` / `record_value_versions` | 履歴・復旧の根拠 | 全件保持 |
| `assets` 登録行と実ファイル | 孤児ファイルはrollback後の正常な残骸になりうる | 自動削除なし |
| `backups/` の全ディレクトリ | 完全backup・不完全backup・移行前snapshotを含む | 自動削除なし |
| 不完全backup（marker/manifest欠落） | 障害診断と原本保護 | 保持 |
| `backups/legacy-migration/*` | 旧形式変換前の原本 | 保持 |
| `.pre-v2.sqlite` / `.pre-v3.sqlite` | schema移行前の原本 | 保持 |
| `legacy_database_archive` 等の旧形式表 | 変換前データ | 保持 |
| `FOLIO-RECOVERY-INCOMPLETE` があるworkspace | 起動停止の根拠 | 保持 |

## 3. 現状のowner/ack watermark不足（隠さない）

receiptを安全にGCするには「このoperationIdはもう再送されない」ことを永続的に証明する必要がある。現状は証明できない。

1. **`save_receipts` にsession/seq/ack列がない。** 主キーは `operation_id` だけで、`result_json` の中に `sessionId`/`seq` が入るが、検索用の列でも永続watermarkでもない。
2. **rendererのACKはメモリだけ。** `PendingEdits.ack` はプロセス内のMapで、再起動で消える。SQLiteへ「ここまでACKした」を書く経路がない。
3. **crash-recovery snapshotがoperationIdを保持する。** `CrashRecoverySnapshot` の `operation` / `creations` / `pageOperations` / `externalOperations` はoperationIdを含む。再起動後に明示再試行されうる。snapshotのgenerationとreceiptを結ぶ索引はない。
4. **復旧snapshotとSQLiteは別ファイルで原子的でない。** 「snapshotからoperationを消す」と「receiptを消す」の順序保証がない。
5. **外部pending journalの存在を追跡していない。** 書き出し先・operationIdの台帳がない。ユーザーが保持している限り、receiptを消す根拠がない。
6. **restore epochがない。** backupを復元するとreceipt集合が過去に戻る。復元前に発行されたoperationIdを拒否する世代情報がないため、GC後の再送が再適用になりうる。
7. **単一owner・単一window前提。** 複数clientのleaseやclient registryはない（Level 4の範囲）。

このため現時点の安全な運用は **「receiptを消さない」** であり、容量上限に達したら「消して空ける」のではなく「新しい書込みを止めて入力を救出する」を選ぶ。

## 4. GCの証明条件（将来の設計。今回は未実装）

以下はすべて満たすときだけ、明示的な保守操作としてreceiptを削除できる。**古さ・件数・合計bytesだけを理由にしない。**

### 4.1 前提として追加が必要な永続情報

- `operation_ack_watermarks(session_id, acked_seq, epoch, updated_at)`:
  - rendererが「結果を永続的に受理し、pendingから除去した」後にだけ前進させる。
  - 順序は **crash-recovery snapshotの更新（fsync+rename）→ watermark更新**。逆順だと、watermarkだけ進んでsnapshotにoperationが残る危険がある。
- `workspace_restore_epoch`: 復元のたびに更新。復元前epochのoperationIdは `resolve` でも「新規適用」でも拒否する。
- `journal_export_log(operation_id, exported_at, destination_hint)`: 外部journalへ出したoperationIdの台帳。外部ファイルの削除は証明できないため、この台帳があるだけでは不十分。ユーザーが「このjournalを破棄した」と明示した記録が必要。
- `maintenance_audit`: GCの実行日時、対象operationId、事前backupのfingerprint、実行者。

### 4.2 receipt 1件をGCしてよい条件

`R = receipt(operationId O, session S, seq N, status X)`:

1. `X` が `applied` または `rejected`。`unknown` は不可。
2. `S` の `acked_seq >= N` が永続watermarkにあり、そのwatermarkが現在の `restore_epoch` と一致する。
3. 現在のプロセスに `O` のpending操作がない（IPC/メモリregistryで確認）。
4. 最新の `crash-recovery.json` と全 `.stage-*` のどれも `O` を参照していない。
5. `journal_export_log` に `O` がない、またはユーザーが該当journalの破棄を明示済み。
6. 復元epochが一致し、`O` が復元前のものではない。
7. 事前に `verifyFullBackup` を通した完全backupが存在し、そのmanifest fingerprintを監査記録に残す。
8. 削除後も `resolve(O)` が「未知の操作」ではなく「保守により削除済み」を返せる（監査表で判定）。同じoperationIdの再送は明示的に拒否し、再適用しない。

1〜8のどれかが欠ける場合は保持する。**現状は2・3・4・5・6・7・8の仕組みがないため、自動GCは0件が正しい。**

### 4.3 receipt以外

- `versions` / `record_value_versions`: ページ単位の明示的な保持設定を作るまでは削除しない。削除する場合も、その版を参照するcrash-recovery・未確定操作・backupが無いことを証明する。
- 孤児asset: 登録行と実ファイルの両方を突き合わせ、**完全backup作成後**に、明示操作でのみ削除する。INSERT rollback後の残骸を孤児と断定しない。
- 不完全backup: 自動削除しない。診断後、ユーザーがパスを確認して明示削除する。
- 完全backup: 自動削除しない。削除は「verify成功」「最新backupではない」「ユーザーがパスと日時を確認」「同時に開いているrestore ticketがない」を満たす明示操作のみ。件数・古さでの自動ローテーションは禁止。
- 外部journal: アプリから削除しない。

## 5. 上限到達時の停止境界（設計）

### 5.1 判定

`evaluateStorageCapacity(report, limits)` は次の順で判定する。

1. 設定されたlimitが0件 → `not-configured`（暗黙の「安全」にしない）。
2. 実測値が上限超過 → `exceeded`。
3. 実測値が不明、またはレポートが `complete` でない → `unknown`。
4. すべて実測済みで上限以下 → `within`。

`unknown` は「書込み可」ではない。**取得失敗・部分計測で保存可能と誤判定しない。**

### 5.2 main側の境界（未配線）

書込みを止める位置は、mainプロセスのIPCハンドラで、**transactionを開始する前**。対象は永続bytesを増やしうる操作:

- `save:commit`, `update`, `record:pageUpdate`, `database:commit`, `database:settings`
- `property:commit`, `migration:commit`, `recovery:copy`, `attach`
- `workspaceBackup:create`（backup自身が容量を食うため、残量予約を別に必要とする）
- `restoreVersion`, `duplicate` など履歴・Pageを増やす操作

許可し続ける操作（救出・確認・削減）:

- `resolve*`（receipt照会は読み取りのみ）
- `recovery:read` / `exportRecovery` / `exportPendingJournal` / `export`
- `downloadAttachment`（読み出し）
- `workspaceBackup:choose` / `verify` / `restore`（別ディレクトリへの救出。restore先の空き容量は別判定）
- `workspaceBackup:open`（復元済みワークスペースの起動は別プロセス）
- `trash` / `delete` はデータを減らさないため「容量回復」とみなさない。実行可否は別途ユーザー確認とし、自動で許可しない。

### 5.3 拒否の意味（再送同一性）

容量拒否は **operationの結果ではない**。

- transaction開始前・receipt書込み前に拒否する。`save_receipts` にrejectedを書かない。versionも作らない。
- rendererはpending入力を保持し、crash-recovery snapshotも前進させない。
- ユーザーが容量を空けた後、**同じoperationId・同じfingerprint**で再送する。receiptが無いので初回適用され、二重適用しない。
- 拒否メッセージは「保存できません。入力は保持されています」+ 理由コード（`capacity-exceeded` / `capacity-unknown`）+ 救出導線。入力を切り捨てたり、古いreceiptを消して空けたりしない。

### 5.4 計測の鮮度と同期コスト

- DB集計（行数・保存bytes・receipt分類）は10,000 receiptの合成fixtureで約30〜60ms（本試験環境の参考値。実データの保証ではない）。
- filesystem走査は最大20,000 entries / 深さ8で打ち切る。遅いディスクではmainを同期ブロックしうる。
- したがって、**保存のたびに全走査しない**。設計案:
  - DB系limitは保存前の軽量集計（表counts+receipt集計）で判定。
  - filesystem/backup系limitは起動時・backup作成後・手動更新時だけ再計測。
  - 計測後に増えたbytesは、書込み結果のサイズ（receipt/version/doc）で保守的に加算し、次の再計測まで下限として使う。
- この「下限加算」と「計測時点」の設計は未実装。ここを実装するまで本番の書込み停止に配線しない。

### 5.5 予約とheadroom

上限ちょうどで停止すると、保存自体に必要な一時bytes（WAL、version、backup staging）が入らない。設計では以下を予約する。

- 1回の保存上限（IPC 32MB、添付20MB）を踏まえたheadroom。
- backup作成は「DB+assetsのコピー」を別ディレクトリに作るため、`maxBackupFileBytes` とは別に「backup作成に必要な空き」を判定する。
- 空きディスクそのものはレポート対象外。OSの空き容量をFolioの上限と混同しない。

## 6. 今回の受入試験との対応

`tests/l3-storage-usage.test.ts`（15件）:

- 日本語・絵文字のUTF-8 bytes（`pages` のid/data/body合計と一致）
- 任意表のmissingと0行の区別
- 10,000 receiptの計数、壊れた `result_json` の計数、本文・titleをレポートに含めない
- caller所有transactionをcommit/rollbackしない
- DB・添付・backupのraw bytes不変（`-shm` はSQLiteのread markで変わるため除外し、DB/WAL/添付/backupは一致を確認）
- complete/incomplete/invalid/legacy/migration/size不一致backupの分類
- assets内symlinkを辿らない
- 未認識表をpartialにする
- 容量不明時に `within` を返さない
- receipt分類の行数上限でpartial
- Store close後にunknownを返す
- crash-recovery stagingのbytes計測（内容は読まない）
- backup内symlinkでpartial
- 旧形式manifestでDB欠落はincomplete

`tests/l3-storage-usage-files.test.ts`（13件）:

- 入れ子の通常ファイル計測
- symlinkを辿らない（リンク先を `lstat` しない）
- entries上限での打切り（部分合計を返さない）
- 深さ上限
- 走査中ENOENT
- stat/readdirの権限失敗
- path escape
- counter overflow
- 通常ファイル以外
- root missing / root symlink
- 加算・合計のoverflow、状態合成
- 上限評価（not-configured / within / exceeded / unknown / exceeded優先）
- 不正limit・不正reportの拒否

いずれも一時 `mkdtemp` のSQLiteと仮想filesystemのみ。実データ、既存Desktop、GUI、Electron、browser、OS clipboard、osascriptは使用していない。GUIは **NOT_RUN**。

## 7. 残件（PARTIALの内容）

1. main/Appへの計測・上限判定の配線。IPCの拒否コード、UI表示、救出導線。
2. 永続的な `operation_ack_watermarks`、`workspace_restore_epoch`、`journal_export_log`、`maintenance_audit`。receipt GCはこれらが揃うまで実装しない。
3. crash-recovery snapshotとSQLite watermarkの順序保証、およびsnapshot/stagingからoperationIdを引く索引。
4. backup保持UIと明示削除。verify済みbackupの選択、restore ticketとの排他、不完全backupの診断表示。
5. 添付孤児の突合と明示削除。
6. 計測の非同期化またはスロットリング。main同期処理の上限を実測で決める。
7. 実データ規模での性能・ディスク空き容量・backup作成時の予約の検証。今回は合成fixtureの参考値のみ。
8. GUI/Electronでの容量表示・拒否・救出の確認。**NOT_RUN**。

## 8. Codexへの申し送り

- 本変更は新規4ファイルのみで、Store/main/App/既存保存/backupソースには触れていない。
- `readStorageUsage` は `Store.readSnapshot` の外側でfilesystemを読む。DBとfilesystemの間の原子的な一致は主張しない。レポートの `state` と `generatedAt` を必ず確認すること。
- `evaluateStorageCapacity` はレポートが `complete` でない場合、measured値が上限以下でも `unknown` を返す。書込み許可に使う場合は `within` のみを許可し、`unknown` を許可に読み替えないこと。
- backupの `complete` は構造分類であり、`verifyFullBackup` の代替ではない。削除判断には必ず既存のverifyを使うこと。
- receiptのstatus分類はSQLiteのJSON関数に依存する。JSON関数が使えないbuildでは `receipts.state = partial`、`corruptRows = null` になる。その場合も行数・bytesは計測済み。
- 10,000 receiptの約30〜60msは合成fixtureの参考値。本番のmain同期処理時間を保証しない。
