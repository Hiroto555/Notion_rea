# 担当B 完了報告：G7 容量の非破壊計測と保持・上限の契約

2026-11-05 / branch `codex/folio-l3-r2-capacity-20261105` / 基準 `e00dc172f413f547ee6f0a0beab6d7bfa6d757d3`

## 結論

読み取り専用の容量レポート `readStorageUsage(store)` と、保持・上限の設計文書を追加しました。SQLiteの行数・UTF-8保存bytes・実ファイルbytes・未測定・未走査・不完全backupを分けて返し、書込み・VACUUM・削除・圧縮・receipt書換えは行いません。

**G7はPARTIALです。** receipt/backupの自動GCは実装していません。現状の永続owner/ack watermark不足により「再送同一性を壊さずに消してよい」と証明できないためです。main/Appへの容量上限配線も未実施で、設計のみです。計測APIの追加だけでG7 PASSとはしません。

実装commit: `e31fd9b20ebb23c83496fe6a245802ed0ebaf29a`（このHANDOFFは次のローカルcommit）。
作業ツリーの既存ファイルは変更していません。

## 所有ファイル（すべて新規）

| ファイル | 行数 | SHA-256 |
| --- | --- | --- |
| `src/shared/storage-usage.ts` | 408 | `d66b63600bc22c2ed2c88f4aa7075d3fe49aa8b35c3bfe0a9e7c7b91c6148794` |
| `src/persistence/storage-usage.ts` | 1476 | `4bba4daffef0542b9e03adc772279d87726f75b31cbb47280d13b188db129448` |
| `tests/l3-storage-usage.test.ts` | 600 | `0151cab9493593c693fbf32da31fa598bec5521469253217008af25cd5bb4f3e` |
| `tests/l3-storage-usage-files.test.ts` | 441 | `e51b4a679da2c8aabf27df7a0e83cd9e911d3e5e24cbc48ad0ad8662448db211` |
| `docs/parallel/dsh-r2/STORAGE-RETENTION.ja.md` | 273 | `83c75c556a61b0e62c872264cc2de692c9e2b54cc9f078493f87ed4f5818b24f` |

`Store`、`src/main`、`App`、既存保存/backupソース、既存テスト、`package.json`、`node_modules`は変更していません。

## 公開API

```ts
readStorageUsage(store: Store, options?: {
  now?: () => Date;
  scanLimits?: Partial<StorageScanLimits>;
  operations?: Partial<StorageScanOperations>; // 試験用。本番はnative fs
}): StorageUsageReport

evaluateStorageCapacity(report, limits): {
  status: "not-configured" | "within" | "exceeded" | "unknown";
  violations?: {limit, actual, maximum}[];
  unknownLimits?: string[];
}
```

### 計測の要点

- DB集計は既存の `Store.readSnapshot` の中だけで行う。caller所有transactionは再利用し、**commitもrollbackもしない**。`database.snapshot.callerOwnedTransaction` に観測値を残す。
- 必須5表（pages/settings/versions/save_receipts/assets）と任意10表を区別。任意表の欠落は `missing`（null）で、0行と混同しない。既知でない表は内容を走査せず `partial`。
- `receipts` は行数、`result_json` のUTF-8 bytes、最大行bytes、壊れたJSON数、status別件数を返す。本文・title・例外messageは返さない。壊れたJSONは `json_valid` で計数し、statusはSQLの `json_extract` で分類する（値は返さない）。
- 実ファイルbytesは、DB本体・WAL・SHM・journal・pre-v2/pre-v3・`crash-recovery.json`・未完marker・`crash-recovery.json.stage-*`・assetsツリー・backupsツリーを分けて計測。
- filesystem走査はワークスペース内の明示targetのみ。symlinkを辿らず、`..`/区切り/NUL/root外を拒否。既定上限は20,000 entries / 深さ8 / receipt分類50,000行 / 未認識表50件。
- 打切り・ENOENT・EACCES/EPERM・readdir失敗・counter overflowは `unknown`/`partial` とし、部分合計を `bytes` に入れない。
- backupは marker・manifest種別・`workspace.sqlite` の有無・宣言bytes一致で `complete`/`incomplete`/`unknown` に分類。**ハッシュ検証はしない**（`verifyFullBackup` の代替ではない）。
- `evaluateStorageCapacity` は、設定limitが無ければ `not-configured`、実測超過なら `exceeded`、実測不能またはレポートが `complete` でなければ `unknown`。**`unknown` を書込み可に読み替えない。**

## 保持・上限の設計（文書の要約）

- 保護対象: 全 `save_receipts`、`unknown` receipt、crash-recovery snapshotとstaging、外部pending journal、versions、assets登録と実ファイル、全backup、不完全backup、legacy-migration snapshot、pre-v2/v3、未完marker。
- 現状の不足: `save_receipts` にsession/seq/ack列がない。rendererのACKはメモリのみ。crash-recovery snapshotはoperationIdを持つがreceiptとの索引がない。snapshotとSQLiteは別ファイルで原子的でない。外部journalの書き出し台帳がない。restore epochがない。単一owner前提。
- 将来のGC証明条件（未実装）: `operation_ack_watermarks`、`workspace_restore_epoch`、`journal_export_log`、`maintenance_audit` を追加し、applied/rejectedのみ、ack watermark、live pendingなし、snapshot/staging参照なし、export台帳なし、epoch一致、verify済み事前backup、削除後も再送を明示拒否、のすべてを満たす場合だけ。古さ・件数だけのGCは禁止。
- 上限到達時: transaction開始前・receipt書込み前に拒否する。容量拒否はoperationの結果ではないのでrejected receiptを書かず、pending入力を保持する。空けた後に同じoperationId/fingerprintで再送すれば初回適用される。resolve・recovery read・export・download・backup verify/restoreは救出経路として許可する設計。
- 計測コスト: 10,000 receiptで約30〜60ms（合成fixtureの参考値）。保存のたびに全filesystem走査はしない設計。main同期処理の制限とheadroomは文書に明記。

## 検証結果

環境: Node `v24.20.0`、npm `11.19.0`、既存 `node_modules` symlink、`FOLIO_VITE_CACHE_DIR=output/vite-cache`。

| 検証 | 結果 | 証拠 |
| --- | --- | --- |
| `npm run check` | **PASS**（exit 0） | `output/dispatch/B-check.log` |
| 新規2ファイル | **28/28 PASS**（15 + 13） | `output/dispatch/B-tests.log` |
| 関連既存テスト8ファイルを含む重点実行 | **10ファイル / 107件 PASS**（exit 0） | 同上 |
| `npm run build` | **PASS**（exit 0）。既存のdynamic/static import警告と500kB超chunk警告は残存 | `output/dispatch/B-build.log` |
| 全体Vitest | 未実行（Codex統合後に実行） | — |
| GUI / Electron / browser / E2E / OS clipboard / native dialog / screenshot / osascript | **NOT_RUN**（実行していない） | — |
| 実データ・既存Desktop・既存プロセス・他worktree | 未使用・未変更 | — |
| push / deploy / PR | 未実施 | — |

重点実行の内訳: `l3-storage-usage`(15)、`l3-storage-usage-files`(13)、`database-read-snapshot`(21)、`record-read-snapshot`(2)、`local-integrity-regressions`(12)、`durability-attachment-backup`(12)、`r8-backup-create`(6)、`r8-backup-verify`(9)、`r8-backup-service`(2)、`store-atomic-load`(15)。

## 受入条件との対応

- **日本語/絵文字bytes**: `pages` のid/data/bodyをUTF-8 bytesで合計し、レポートの `storedBytes` と一致。本文・titleがレポートJSONに含まれないことも確認。
- **missing optional tables**: 任意表の `missing`（null）と、空表の `present`（0行）を別fixtureで確認。
- **10k receipt**: 10,000行を一時SQLiteへ投入し、行数・bytes・status別件数・壊れたJSON 1件を確認。所要時間は参考値としてログへ。
- **壊れたresult_json**: `corruptRows=1`、本文のsecret文字列がレポートに含まれないことを確認。
- **snapshot整合性**: callerが `BEGIN` した中でレポートを呼び、transactionが継続し、`ROLLBACK` 後にreceiptが見えないことを確認。
- **read-only raw bytes**: DB・WAL・添付・backupのSHA-256が前後で一致。`-shm` はSQLiteのread markで変わるため、データファイルから除外したことを明記。
- **symlink/過大tree/途中削除/権限失敗/部分結果**: 仮想filesystemで、symlink不追跡、entries上限、深さ上限、ENOENT、EACCES/EPERM（stat/readdir）、path escape、通常ファイル以外を確認。いずれも0 bytesにせず `unknown`/`partial`。
- **counter overflow**: `addCounts`/`sumNullable` と、`Number.MAX_SAFE_INTEGER` サイズ2ファイルの走査で確認。
- **不完全backup**: markerあり、manifest不正/欠落、DB欠落、宣言bytes不一致、backup内symlinkを `incomplete`/`partial` として確認。legacy/migration manifestも認識。
- **取得失敗で保存可能と誤判定しない**: Store close後とassets root EACCESで `unknown` を返し、`evaluateStorageCapacity` が `within` を返さないことを確認。

## 残件（PARTIAL）

1. main/Appへの計測・上限判定の配線（IPC拒否コード、UI、救出導線）。
2. 永続的なack watermark / restore epoch / journal export台帳 / maintenance audit。receipt GCはこれらが揃うまで実装しない。
3. crash-recovery snapshotとSQLite watermarkの順序保証、operationId索引。
4. backup保持UIと明示削除（verify済み・restore ticket排他・不完全backup診断）。
5. 添付孤児の突合と明示削除。
6. 計測の非同期化/スロットリング、headroomとbackup作成予約の実装。
7. 実データ規模・空きディスク・backup作成時予約の検証。今回は合成fixtureの参考値のみ。
8. GUI/Electronでの容量表示・拒否・救出の確認。**NOT_RUN**。

## Codexへの申し送り

1. **backupの `complete` は構造分類**であり、完全性・ハッシュ検証ではない。削除判断には必ず既存の `verifyFullBackup` を使うこと。
2. `readStorageUsage` はDBスナップショットの外でfilesystemを読む。両者の原子的一致は主張しない。`state` と `generatedAt` を確認すること。
3. `evaluateStorageCapacity` はレポートが `complete` でない場合、measured値が上限以下でも `unknown` を返す。書込み許可には `within` だけを使い、`unknown` を許可に読み替えないこと。
4. receiptのstatus分類はSQLiteのJSON関数に依存する。JSON関数が無いbuildでは `receipts.state=partial`、`corruptRows=null` になるが、行数・bytesは計測済み。
5. `readdir` は1ディレクトリの全entry名を返すため、極端に多い直下entryでは一覧取得コストが残る。mainで同期実行する場合はスロットリングが必要。
6. 10,000 receiptの約30〜60msは合成fixtureの参考値。実データの性能保証ではない。
7. 本APIは読み取り専用で、削除・圧縮・VACUUM・receipt更新の経路を持たない。GCを追加する場合は、上記の証明条件と監査記録をセットで設計してほしい。

証拠ログ: `output/dispatch/B-environment.log`、`B-check.log`、`B-tests.log`、`B-build.log`（`output/*` はgitignore対象）。設計の詳細は `docs/parallel/dsh-r2/STORAGE-RETENTION.ja.md`。
