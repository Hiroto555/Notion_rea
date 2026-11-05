# Folio L3-C 非GUI障害試験 FAULT-MATRIX

2026-11-05 JST。担当C（DeepSeek V4.1 Flash）。対象は基準HEAD `e00dc172f413f547ee6f0a0beab6d7bfa6d757d3`、ブランチ `codex/folio-l3-r2-faults-20261105`。本書はCが追加した独立試験の実施条件・検証コード・コマンド・結果・未検証範囲を固定する。製品 `src/` と既存テストは変更していない。A/Bの将来変更は試験済みではない。

## 結論（C範囲）

| 項目 | 結果 |
| --- | --- |
| 新規C試験 | **13件 PASS**（3ファイル） |
| 既存baseline関連試験の再実行 | **8ファイル / 73件 PASS** |
| `npm run check` | PASS |
| `npm run build` | PASS（既存のdynamic/static import警告と500kB超chunk警告のみ） |
| `git diff --check` | PASS |
| GUI / Electron / ブラウザ / OSクリップボード / ネイティブダイアログ / スクリーンショット / osascript | **NOT_RUN** |
| 物理停電・OSクラッシュ・ディスク故障 | **NOT_RUN**。SIGKILLはプロセス境界だけを検証する |
| G6の確定事項 | finding F1（破損Pageがあると完全backupを作成できない）。修正はCodex判断 |
| Level 3到達判定 | しない。C範囲の証拠を追加しただけ |

## 環境と方法

- macOS、Node `v24.20.0`、npm `11.19.0`、Vitest `3.2.7`、esbuild `0.25.12`、`node:sqlite`。
- 全DB・添付・backup・restore先は `mkdtemp` の一時ディレクトリだけ。実データ、既存Desktopアプリ、既存プロセス、他worktree、認証設定には触れていない。
- 子プロセスはテストが `spawn` したNodeだけ。`tests/fixtures/l3-crash-worker.ts` を既存esbuildで一時CJSにbundleし、IPC付きで起動する。子のenvは `PATH` / `HOME` / `TMPDIR` / `LANG` / `LC_ALL` だけを明示し、`FOLIO_*`、Electron、表示系の環境変数を継承しない。
- 子は `process.send` でbarrierを通知し、`Atomics.wait` で停止する。親は通知を受けた後に、保持した `child.pid` のその子だけへ `SIGKILL` を送る。sleepでタイミングを推測しない。barrier待ちは20秒、各試験は30秒、afterEachの強制終了は5秒を上限とする。
- `pkill` / `killall` / アプリプロセス終了 / `git reset` / `git clean` / push / deploy / 依存追加は実行していない。

### barrierの位置

| mode | 子が停止する位置 | 製品経路 |
| --- | --- | --- |
| `page-before-commit` | `Store.transaction` の `COMMIT` 実行直前 | Page変更とreceiptが同じtransaction内 |
| `page-after-commit` | `COMMIT` が返った直後 | 確定後・ACK喪失相当 |
| `page-between-writes` | 最初の `INSERT INTO pages` 実行後、receipt INSERT前 | Pageだけ書けた状態 |
| `backup-before-manifest` | DBとassetsのコピー・fsync後、`manifest.json` 公開前 | `createFullBackup` の検証前 |
| `backup-before-marker-removal` | manifest公開・`verifyFullBackup` 成功後、marker削除直前 | 完了扱いにする直前の境界 |

barrier実装は `tests/fixtures/l3-crash-worker.ts:71`（通知と停止）、`:85`（Page経路）、`:138`（backup経路）。marker削除前の停止は同 `:168`。

## Gate別の実施結果

### G2 正常操作の不変条件（C範囲: Page receipt / subtree複製）

| 条件 | 検証コード | 結果 | 未検証範囲 |
| --- | --- | --- | --- |
| 通常Page作成のoperation/receiptが同じtransactionで確定し、同じoperationの再送でPageが増えない | `tests/l3-crash-boundaries.test.ts:399`（COMMIT後kill）、`:326`（COMMIT前kill） | PASS | GUIからの作成、ACK喪失UI、template/import |
| subtree複製が元Pageと子孫のID・親子関係・順序を保ち、元subtreeのraw bytesを変えない | `tests/l3-crash-boundaries.test.ts:435`、`:489`、`:533` | PASS | record所有subtree、move/trash/restore、GUI |
| 複製の再試行で二重コピーがなく、同じreceipt結果を返す | 同 `:533`、`:435` | PASS | 同一operationをUIが保持する経路 |
| 破損Pageがあるworkspaceでも健康なPageを読み・編集でき、破損原本のrawを `pageSource` で取得できる | `tests/l3-durability-corrupt.test.ts:72` | PASS | GUIの救出導線、record所有Pageの全variant |

### G3 保存の確定と入力保護（C範囲: Page作成のCOMMIT境界）

| 条件 | 検証コード | 結果 | 未検証範囲 |
| --- | --- | --- | --- |
| COMMIT前に子をkillするとPageもreceiptも残らず、`integrity_check` が `ok`、`resolve` は `unknown` | `tests/l3-crash-boundaries.test.ts:326` | PASS | 物理停電、SQLite以外の層の故障 |
| Page INSERT後・receipt INSERT前にkillしても両方がrollbackされ、再試行で1 Pageだけ作られる | 同 `:365` | PASS | 途中のSQLiteエラー注入は既存回帰に依存 |
| COMMIT後にkillするとPageとreceiptが共存し、`resolve` が `applied`、再送しても二重Pageがない | 同 `:399` | PASS | GUIのACK処理、timeout処理 |
| 複製の部分subtreeがkillでrollbackされ、receiptも残らない | 同 `:489` | PASS | record所有データの複製 |
| 全境界で `PRAGMA integrity_check` が `ok` | 上記4試験 | PASS | 破損ディスク・bit rot |

### G5 backup/restore耐障害性（C範囲）

| 条件 | 検証コード | 結果 | 未検証範囲 |
| --- | --- | --- | --- |
| DBとassetsのコピー・fsync後、manifest公開前に子をkillすると、`FOLIO-RECOVERY-INCOMPLETE` が残り、manifestは公開されない | `tests/l3-crash-boundaries.test.ts:584` | PASS | 物理停電、OSのwrite cache消失 |
| manifest公開・検証後、marker削除前に子をkillすると、manifestは存在するがmarkerが残り、完全に見える内容でも拒否される | `tests/l3-crash-boundaries.test.ts:704` | PASS | 物理停電、GUIの復元導線 |
| その不完全backupを `verifyFullBackup` / `restoreFullBackup` / `new Store` が拒否し、restore先を作らない | 同 `:584` | PASS | GUIのbackup選択・復元導線 |
| 不完全backup作成後も元workspaceのPage・version・setting・receipt・asset bytesが変わらない | 同 `:584` | PASS | 大容量workspace、同時書き込み |
| 完全backupを別の一時場所へrestoreし、DB bytes・添付SHA-256・manifest fingerprintが一致する | `tests/l3-crash-boundaries.test.ts:802`、`tests/l3-durability-backup.test.ts:113` | PASS | GUIの復元・再open |
| 完全backup/restore後もPage・version・setting・receipt・assetのraw内容が元と一致し、restored DBの `integrity_check` が `ok` | `tests/l3-durability-backup.test.ts:113` | PASS | record所有データのbackup/restore（既存r8試験の範囲） |
| 誤ったexpected fingerprintではrestoreせず、restore先を残さない | `tests/l3-durability-backup.test.ts:229` | PASS | GUIのticket経路 |

既存の `tests/durability-attachment-backup.test.ts` は `durableFs` のfsync順序・失敗時cleanupを検証する。Cはこれを再実行してPASSを確認したが、**fsync完了を物理停電耐性とは扱わない**。SIGKILLはプロセスの即時終了であって、ストレージのwrite cacheや電源断を再現しない。

### G6 破損・未知schemaの隔離（C範囲）

| 条件 | 検証コード | 結果 | 未検証範囲 |
| --- | --- | --- | --- |
| 不正JSONのPageがあると完全backupはfail-closedし、markerと途中コピーを残し、元DBのraw bytesを変えない | `tests/l3-durability-corrupt.test.ts:72` | **PARTIAL（F1）** | 完全backupを作る代替経路、GUIのエラー表示 |
| 破損Pageがあっても健康なPageのload/search/editが通り、破損Pageの `pageSource` が元の不正JSONをそのまま返し、書き込みは拒否される | 同 `:72` | PASS | GUIのraw救出導線 |
| 未知 `user_version=5` のDBはStoreが起動を拒否し、backupはmanifestを公開せずmarkerを残し、元DBの `user_version`・Page raw・integrityを変えない | `tests/l3-durability-corrupt.test.ts:158` | PASS | 将来versionの移行、GUIの案内 |
| 不完全marker付きbackupはverify/restore/Store openで拒否される | `tests/l3-crash-boundaries.test.ts:584`、`:704` | PASS | GUIの救出導線 |

## 不具合・制約

### F1（G6）破損Pageがあると完全backupを作成できない

- 最小再現: 一時workspaceに通常Pageを2つ作り、1つの `pages.data` を `'{"id": "incomplete",\n'` に更新する。`createFullBackup(db, source, destination)` を呼ぶ。
- 期待（G6の救出性）: 破損Pageを書換えず、少なくとも診断用のraw snapshotを作れる。あるいは健康なPage/DBだけでも検証済みbackupとして公開できる。
- 実測: `createFullBackup` は `Invalid page document JSON` で失敗する。destinationには `FOLIO-RECOVERY-INCOMPLETE`、`workspace.sqlite`、`assets/` が残るが、`manifest.json` は公開されない。元DBのraw bytesは不変。Storeを再openすると健康Pageは編集でき、破損Pageは `pageSource` でraw取得できる。
- 関連コード: `src/persistence/full-backup-verify.ts:321` / `:328` が全Page行のJSON parseを要求し、`src/persistence/full-backup-create.ts:274` が `inspectWorkspaceSnapshot` を呼ぶ。Store側は `src/persistence/store.ts:268` で破損Pageをquarantineし、`:1341` の `pageSource` でrawを返す。
- 影響: 破損が1 Pageでも、ユーザーは完全backupを作れない。原本は保護されるが、backupを救出の入口にできない。データ損失ではない。
- Cの試験: `tests/l3-durability-corrupt.test.ts:72`。Cは製品コードを変更していない。修正方針はCodexが決める。

## 未検証範囲

1. GUI/Electron/ブラウザ/OSクリップボード/ネイティブダイアログ/スクリーンショット/osascriptは **NOT_RUN**。画面からのbackup作成・復元・再open・エラー表示は未確認。
2. 物理停電、OSクラッシュ、ディスク故障、write cache消失は **NOT_RUN**。SIGKILLとfsync seamの成功を物理耐久性の証明にしない。
3. Windows/Linux、別ファイルシステム、ネットワークドライブは未実行。macOSの一時ディレクトリのみ。
4. record所有データ（登録DB・record・record version）を含むbackup/restoreは、Cの新規試験では扱っていない。既存 `tests/r8-backup-*.test.ts` の範囲であり、今回は再実行した8ファイル/73件に含まれるが、Cの独立した新規証拠としては数えない。
5. A/Bの将来変更、統合後の全suite、GitHub Actionsは未実行。全体suiteはCodexが統合後に実行する。
6. `fsync` の順序・失敗時cleanupは既存 `tests/durability-attachment-backup.test.ts` の証拠であり、Cの新規試験ではない。
7. 大量Page/大容量添付、同時書き込み、長時間稼働、容量上限（G7）はCの範囲外。

## 実行コマンドと結果

環境変数 `FOLIO_VITE_CACHE_DIR=$PWD/output/vite-cache` を指定。GUIは起動していない。

| コマンド | 結果 | ログ |
| --- | --- | --- |
| `npm run check` | PASS | `output/dispatch/l3-c-check.log` |
| `npx vitest run tests/l3-crash-boundaries.test.ts --maxWorkers=2` | 9件 PASS（3回繰り返しもPASS） | `output/dispatch/l3-c-crash-marker.log`、`l3-c-repeat.log` |
| `npx vitest run tests/l3-durability-backup.test.ts tests/l3-durability-corrupt.test.ts --maxWorkers=2` | 4件 PASS | `output/dispatch/l3-c-durability.log` |
| 新規3ファイル合計 | **13件 PASS** | `output/dispatch/l3-c-targeted.log` |
| 既存baseline関連8ファイル | **73件 PASS** | `output/dispatch/l3-c-baseline.log` |
| `npm run build` | PASS | `output/dispatch/l3-c-build.log` |
| `git diff --check` | PASS | — |

既存baseline関連8ファイル: `durability-attachment-backup`、`page-operation-receipts`、`corrupt-page-isolation`、`store-atomic-load`、`dsh-integration-regressions`、`r8-backup-independent`、`r8-backup-restore`、`r8-backup-verify`。

## 証拠の所在

- 新規試験: `tests/l3-crash-boundaries.test.ts`、`tests/l3-durability-backup.test.ts`、`tests/l3-durability-corrupt.test.ts`
- 子プロセスfixture: `tests/fixtures/l3-crash-worker.ts`
- 生ログ: `output/dispatch/l3-c-*.log`（`output/` はgitignore対象）
- 最終HANDOFF: `docs/parallel/dsh-r2/HANDOFF-C.ja.md`
