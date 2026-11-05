# Folio Round 3 C — 容量不足の独立受入試験と障害条件

2026-11-05 JST。担当C（DeepSeek V4.1 Flash）。対象worktreeは `<workspace-root>/Folio-l3-r3-acceptance`、ブランチは `codex/folio-l3-r3-acceptance-20261105`、共通baseは `e26d1711de2d94e11475d1731576490c3ca4e808`。製品 `src/`、既存テスト、既存スクリプトは変更していない。A/B moduleはCのworktreeにまだ存在しないため、新規試験は **NOT_RUN（統合後にCodexが実行）** である。以下のPASSは既存の小試験だけを指し、新規受入試験の合格ではない。

## 結論

| 項目 | 結果 |
| --- | --- |
| 新規C受入試験 `tests/storage-pressure-integration.test.ts` | **NOT_RUN**。A/B module不在でcollection時に `Cannot find module '../src/main/storage-pressure'`。試験本体は未実行 |
| 既存の小試験（coordinator/receipt/recovery/初期本文） | **4ファイル / 35件 PASS**（`output/dispatch/r3-c-existing.log`） |
| `npm run check` | **FAIL（統合待ち）**。新規試験のA/B import 3件が `TS2307`。製品sourceの失敗ではない（`output/dispatch/r3-c-check.log`） |
| 新規試験の構文変換（esbuild、type-checkではない） | PASS。テスト実行・型検査の代用にはしない |
| GUI / Electron / browser / clipboard / osascript / screenshot / native dialog | **NOT_RUN**（明示的な禁止を継続） |
| 実ディスクの容量圧迫 | **NOT_RUN**。probe注入のみ。ディスクを埋めていない |

## 試験の境界

- 本試験は契約A（`src/shared/storage-pressure.ts`、`src/main/storage-pressure.ts`）と契約B（`src/main/storage-write-policy.ts`）の公開APIだけをimportする。実装は推測して作っていない。
- 本物の `Store`、`PageOperationCoordinator`、`RecoveryCheckpoint`、`CrashRecoveryFile`、一時checkpointファイル、一時SQLiteを使う。
- 容量は `WorkspaceStoragePressure` の `probe` に `{bsize, bavail}` を注入して作る。実ファイルシステムを埋めたり、既存データを圧迫したりしない。
- **本試験のdispatchはテストローカルである。** `assertRequestStorage(request, pressure)` を `store.handle` の前に呼ぶ最小dispatchをテスト内に置き、その順序と分類を検証する。`src/main/index.ts`、IPC、preload、renderer UI、`WorkspaceBackupService` の自動backup前確認、実際の `storage:pressure` IPC配線はimportも実行もしていない。これらはCodex統合後の確認対象であり、本試験のPASSで代替できない。
- `Request["type"]` に `storage:pressure` がまだ無い場合に備え、テスト側は `Request | {type:"storage:pressure"}` のローカル型を使う。Codexが `shared/types.ts` にIPCを追加した後も同じ試験が通る想定。`storage:pressure` の実request形（追加引数の有無）が契約と異なる場合はCodexが調整する。

## 試験一覧

| # | 条件 | 期待 | 検証コード |
| --- | --- | --- | --- |
| C3-1 | 空きが `reserve + additional` 未満のとき、`PageOperationCoordinator.create` が送信する `page:commit` をguardが拒否する | Storeの `handle` は呼ばれない。新規Pageなし。`save_receipts` 増加なし。coordinatorは `unknown` で入力を保持し、`rejected` に偽装しない | `tests/storage-pressure-integration.test.ts:103` |
| C3-1b | 同じ圧迫中でも `load` / `search` / `versions` / `pageSource` / `page:resolve` / `recovery:read` / `storage:pressure` を使える | いずれもguardを通り、Storeまたはcheckpointの読み取りが成功する。`page:resolve` はreceipt不在のため `unknown` のまま | 同 `:103` |
| C3-1c | 圧迫中でも `recovery:write`（checkpoint）を書ける | `RecoveryCheckpoint` が一時checkpointファイルへ保存し、`recovery:read` が同じpage operationを返す。generationが1進む | 同 `:103` |
| C3-2 | 空き回復後、checkpointから同じoperationを明示再試行する | 最初に `page:resolve` で `unknown` を確認し、同じoperationId/sessionId/seq/payloadで1回だけ `page:commit`。Pageは1つだけ増え、receiptも1つだけ増える | `tests/storage-pressure-integration.test.ts:209` |
| C3-2b | 回復後の2回目の明示再試行 | `resolve` が `applied` を返し、再commitしない。Page/receiptは増えない。同じreceipt bytesを保つ | 同 `:209` |
| C3-3 | 既存の確定Page/receiptがある状態で圧迫と再試行を行う | 既存receiptの `result_json` が前後でbyte同一。削除・書換えをしない | 同 `:209` |
| C3-4 | 全 `Request` typeのread/checkpoint/write分類 | 契約どおり。`recovery:write` だけcheckpoint、resolve群はread、永続変更はwrite | `tests/storage-pressure-integration.test.ts:316` |
| C3-4b | 未知typeの分類 | fail closed（throwまたはwrite）。read/checkpointに落ちない | 同 `:316` |
| C3-4c | guard dispatchでread/checkpoint/writeを実際に分岐する | readとcheckpointは `assertWritable` を呼ばない。writeは呼ぶ。blocked writeはStoreに到達しない。`recovery:copy` もwriteとして拒否される | 同 `:316` |
| C3-5 | 空き不明（probe例外） | `state:"unknown"`、`availableBytes:null`、`assertWritable` が `capacity-unknown` と保存停止・入力保全の案内でthrow | `tests/storage-pressure-integration.test.ts:492` |
| C3-5b | 空き値のoverflow | `unknown`。書込みはfail closed | 同 `:492` |
| C3-5c | 不正なoptions（負数・非整数のreserve） | 構築時にthrow | 同 `:492` |

## 分類の受入表

`Request["type"] | "storage:pressure"` の全52 typeをテスト内の `Record` で網羅する。Codexがtypeを追加した場合、この `Record` の不足が型検査で検出される。

- **read（26）**: `load`, `search`, `versions`, `pageSource`, `page:resolve`, `save:resolve`, `database:resolve`, `migration:preview`, `migration:resolve`, `property:preview`, `property:resolve`, `database:read`, `record:get`, `record:read`, `database:load`, `recovery:read`, `export`, `exportRecovery`, `exportPendingJournal`, `downloadAttachment`, `openExternal`, `workspaceBackup:choose`, `workspaceBackup:restore`, `workspaceBackup:open`, `import`, `storage:pressure`
- **checkpoint（1）**: `recovery:write`
- **write（25）**: `create`, `update`, `move`, `duplicate`, `trash`, `restore`, `setting`, `page:commit`, `save:commit`, `database:commit`, `migration:commit`, `property:commit`, `record:pageUpdate`, `record:create`, `record:patch`, `record:trash`, `record:restore`, `record:duplicate`, `database:settings`, `recovery:copy`, `restoreVersion`, `recover`, `backup`, `workspaceBackup:create`, `attach`

`assertRequestStorage` はwriteのときだけ `pressure.assertWritable()` を呼び、requestを変更しない。テストは `load` と `recovery:write` でguardが呼ばれないこと、`page:commit` で1回だけ呼ばれること、requestのdeep copyが不変であることを確認する。

## 障害注入とデータ

- 一時ディレクトリは `mkdtempSync(resolve("output/dsh-r3-acceptance-"))` と `.../dsh-r3-unknown-`。SQLite、checkpoint、WALはすべてその中に作り、finallyでStoreをcloseして削除する。
- probeは `{bsize:4096n, bavail:2n}` でblocked、`{bsize:4096n, bavail:10000n}` でreadyにする。実ディスクの空きは読まない。
- 圧迫中もcheckpointを書けることを、実際の `CrashRecoveryFile.write`（fsync・atomic rename・readback）で確認する。ただし物理停電やwrite cache消失の証明ではない。
- `save_receipts` は実SQLiteからCOUNTと `result_json` を直接読み、Page数とreceipt bytesを比較する。既存receiptを削除するコードはテストにも製品にも追加していない。

## unknown / rejected の扱い

rendererの既存仕様を尊重する。`assertRequestStorage` が投げる容量拒否は、`page:commit` のtransport失敗として `exchangePageOperation` が `unknown` に変換する。本試験は次を固定する。

- 圧迫中のcreateは `firstUnknown()` が定義され、`firstRejected()` はundefined。
- メッセージは「不明」「保持」を含み、成功やterminal rejectionを偽装しない。
- 圧迫中の `page:resolve` はreceiptが無いため `unknown` のままで、rejectedに変換しない。
- 空き回復後も、まずresolveし、unknownのときだけ同じoperationを再送する。applied/rejectedを再commitしない。

## 未検証範囲（重要）

1. `src/main/index.ts` の実際のguard配線、IPC sender検証、`storage:pressure` IPC、preload、rendererの手動容量確認UI、`WorkspaceBackupService` の自動backup前確認は **NOT_RUN**。本試験のdispatchはテストローカルの代替であり、製品配線の証明ではない。
2. `npm run check` はA/B module不在でFAIL。統合後にCodexが再実行する。新規試験の型検査・実行PASSをCは主張しない。
3. 実ディスクの空き不足、workspace quota、GC、物理ディスク故障、write cache消失、電源断は **NOT_RUN**。probe注入はG7の安全余裕判定の受入であって、ストレージ故障耐性の証明ではない。
4. backup/restore、DB集計、保持・削除、自動backup、同時書込み、複数プロセス、Windows/Linux、大容量workspaceは対象外。
5. GUI/Electron/browser/OS clipboard/native dialog/screenshot/osascriptは **NOT_RUN**。
6. 全suite、build、hosted CIはCodexが統合後に実行する。Cは対象の既存小試験と新規試験のattemptだけを実行した。

## 実行コマンドとログ

環境変数 `FOLIO_VITE_CACHE_DIR=$PWD/output/vite-cache`、maxWorkers=1。GUIは起動していない。

| コマンド | 結果 | ログ |
| --- | --- | --- |
| `npx vitest run tests/page-operation-coordinator.test.ts tests/recovery-checkpoint.test.ts tests/page-operation-receipts.test.ts tests/l3-page-initial-doc.test.ts --maxWorkers=1` | 4ファイル / 35件 PASS | `output/dispatch/r3-c-existing.log` |
| `npx vitest run tests/storage-pressure-integration.test.ts --maxWorkers=1` | **NOT_RUN**（collection error: A/B module不在） | `output/dispatch/r3-c-new-test-attempt.log` |
| `npm run check` | **FAIL（統合待ち）**: `TS2307` 3件 | `output/dispatch/r3-c-check.log` |
| `npx esbuild tests/storage-pressure-integration.test.ts --format=esm` | 構文変換のみPASS。型検査・実行ではない | 一時出力（commit対象外） |
| 契約シグネチャだけの一時stubを `/tmp` に置いたテスト単体の型検査 | 型エラーなし。実A/B moduleでのcheckでも実行でもない | `/tmp`（commit対象外） |

## Codex統合時の受入条件

1. A（`src/shared/storage-pressure.ts`、`src/main/storage-pressure.ts`）とB（`src/main/storage-write-policy.ts`）を統合し、`shared/types.ts` に `storage:pressure` を追加する。
2. `npx vitest run tests/storage-pressure-integration.test.ts --maxWorkers=1` を実行し、4件がPASSすることを確認する。失敗した期待値を緩めたりskipしたりしない。
3. `npm run check` を実行し、新規試験の `TS2307` が解消することを確認する。`Request` にtypeを追加した場合は分類 `Record` の網羅性も型検査で確認する。
4. `src/main/index.ts` で `assertRequestStorage` が `store.handle` より前に呼ばれ、`storage:pressure` がreadとして処理されることをレビューする。本試験はこの配線を検証しない。
5. 全体suite/buildはCodexの統合worktreeで実行する。GUIは利用者の明示許可があるまで **NOT_RUN** のままにする。
