# Folio L3-C HANDOFF — 非GUI障害試験

2026-11-05 JST。担当C（DeepSeek V4.1 Flash）。

- 作業場所: `<workspace-root>/Folio-l3-r2-faults`
- ブランチ: `codex/folio-l3-r2-faults-20261105`
- 基準HEAD: `e00dc172f413f547ee6f0a0beab6d7bfa6d757d3`
- 試験commit: `a192c5c69f9cf761e9aa4bd7165e8da8ec167868`（初回）、`e82936eed3eedeb5711abceae3318b5b4827f24c`（marker削除前boundary追加）
- 最終HEAD: 本書を含むローカルcommit（pushなし）。SHAは最終報告に記載。
- 状態: **C範囲は完了。ただしG6 finding F1、GUI/物理故障/全体suiteは未検証のためPARTIAL。Level 3到達とはしない。**

## 変更したファイル

新規のみ。製品 `src/`、既存テスト、既存スクリプトは変更していない。

| ファイル | 内容 |
| --- | --- |
| `tests/fixtures/l3-crash-worker.ts` | 自分でspawnする子Node用fixture。IPC barrierとSIGKILL対象の停止点 |
| `tests/l3-crash-boundaries.test.ts` | Page作成/複製のCOMMIT前後・途中kill、backupのmanifest前/marker削除前kill、完全backupの子実行 |
| `tests/l3-durability-backup.test.ts` | 完全backup→別場所restore、添付digest、raw table一致、fingerprint不一致拒否 |
| `tests/l3-durability-corrupt.test.ts` | 破損Page/未知schemaのfail-closedとraw救出 |
| `docs/parallel/dsh-r2/FAULT-MATRIX.ja.md` | gate別の条件・検証コード・コマンド・結果・未検証範囲 |

## 検証結果

| 検証 | 結果 | 証拠 |
| --- | --- | --- |
| 新規C試験（3ファイル） | **13件 PASS** | `output/dispatch/l3-c-targeted.log` |
| うちcrash boundary（9件） | PASS。3回繰り返しもPASS | `l3-c-crash-marker.log`、`l3-c-repeat.log` |
| 既存baseline関連（8ファイル） | **73件 PASS** | `l3-c-baseline.log` |
| `npm run check` | PASS | `l3-c-check.log` |
| `npm run build` | PASS（既存の警告のみ） | `l3-c-build.log` |
| `git diff --check` | PASS | — |
| GUI / Electron / browser / OS clipboard / native dialog / screenshot / osascript | **NOT_RUN** | — |
| 物理停電 / OSクラッシュ / ディスク故障 | **NOT_RUN** | — |
| 全体suite / GitHub Actions | 未実行（Codexが統合後） | — |

### 追加した不変条件

- Page作成: COMMIT前killでPageもreceiptも残らない。Page INSERT後・receipt INSERT前killでも両方rollback。COMMIT後killではPageとreceiptが共存し、`resolve` が `applied`、再送で二重Pageなし。
- subtree複製: COMMIT前killで原本subtreeのraw bytesとreceipt表が不変。部分コピー後killでもrollback。COMMIT後killではコピーsubtreeとreceiptが共存し、再送で二重コピーなし。
- 全境界で `PRAGMA integrity_check` が `ok`。
- backup: DB/assetsのfsync後・manifest公開前のkillで `FOLIO-RECOVERY-INCOMPLETE` が残り、manifestは出ない。manifest公開・検証後でもmarker削除前のkillならmarkerが残り、完全に見える内容でも `verifyFullBackup` / `restoreFullBackup` / `new Store` が拒否し、restore先を作らない。元workspaceのPage・version・setting・receipt・asset bytesは不変。
- 完全backup: 子Nodeで作成→親でverify→別の一時場所へrestore。DB bytes、添付SHA-256、manifest fingerprintが一致し、restored DBのintegrityとraw tableが元と一致。
- 破損Page: 不正JSONのPageがあると完全backupはfail-closedし、markerと途中コピーを残す。元rawは不変。健康Pageはload/search/editでき、破損Pageは `pageSource` でraw取得、書込みは拒否。
- 未知schema `user_version=5`: Storeは起動拒否、backupはmanifestを公開せずmarkerを残し、元DBのversion/Page raw/integrityは不変。

## 確定事項（Codex判断待ち）

### F1（G6）破損Pageがあると完全backupを作成できない

- 再現: 一時workspaceの1 Pageの `pages.data` を `'{"id": "incomplete",\n'` にし、`createFullBackup(db, source, destination)` を呼ぶ。
- 実測: `Invalid page document JSON` で失敗。destinationにmarker・DB・assetsは残るがmanifestは出ない。元DBは不変。Store再open後、健康Pageは編集可能、破損Pageは `pageSource` でraw取得可能。
- 関連コード: `src/persistence/full-backup-verify.ts:321` / `:328` が全Page行のJSON parseを要求。`src/persistence/full-backup-create.ts:274` が `inspectWorkspaceSnapshot` を呼ぶ。Store側のquarantineは `src/persistence/store.ts:268`、raw救出は `:1341`。
- 影響: 破損が1 Pageでも完全backupを作れない。原本は保護されるが、backupを救出の入口にできない。データ損失ではない。
- Cの試験: `tests/l3-durability-corrupt.test.ts:72`。Cは製品コードを変更していない。修正する場合、この試験の期待値を「backupできる」へ変えるか、別のraw救出経路を追加するかをCodexが決める。

## 残件

1. **F1の扱い**をCodexが決める。修正する場合はbackup verifierの破損Page方針と、manifest/inventoryの扱いを設計する。
2. 統合後の全体suite・型検査・buildをCodexが実行する。Cは新規3ファイルとbaseline関連8ファイルだけを実行した。
3. GUI/Electron/ブラウザ/OSクリップボード/ネイティブダイアログ/スクリーンショット/osascriptは **NOT_RUN**。画面からのbackup作成・復元・再open・エラー表示は未確認。
4. 物理停電・OSクラッシュ・ディスク故障は **NOT_RUN**。SIGKILLとfsync seamの成功を物理耐久性の証明にしない。
5. A/Bの将来変更は未試験。対象HEADは基準版 `e00dc17` のまま。
6. record所有データ（登録DB・record・record version）のbackup/restoreはCの新規証拠にしていない。既存 `tests/r8-backup-*.test.ts` の範囲で、今回のbaseline再実行8ファイル/73件には含まれる。
7. Windows/Linux、別ファイルシステム、大容量workspace、同時書き込み、G7容量上限は未検証。

## 安全性

- GUI/Electron/browser/OS clipboard/native dialog/screenshot/osascriptは起動していない。`dev` / `start` / `test:e2e:batch` / 直接Electron起動も実行していない。
- 子プロセスはテストが `spawn` したNodeだけ。`child.pid` を保持し、その子だけに `SIGKILL` を送った。`pkill` / `killall` / アプリプロセス終了は使っていない。
- DB・添付・backup・restore先はすべて `mkdtemp` の一時ディレクトリ。子のenvは `PATH` / `HOME` / `TMPDIR` / `LANG` / `LC_ALL` だけを明示した。
- 実データ、既存Desktopアプリ、既存プロセス、他worktree、認証設定には触れていない。既存receipt/historyは削除していない。
- 依存追加、node_modules再インストール、`git reset` / `clean` / `force` / push / deploy / PRは実行していない。commitはローカルのみ。

## 再現コマンド

```sh
cd <workspace-root>/Folio-l3-r2-faults
export FOLIO_VITE_CACHE_DIR="$PWD/output/vite-cache"
npm run check
npx vitest run tests/l3-crash-boundaries.test.ts tests/l3-durability-backup.test.ts tests/l3-durability-corrupt.test.ts --maxWorkers=2
npx vitest run tests/durability-attachment-backup.test.ts tests/page-operation-receipts.test.ts tests/corrupt-page-isolation.test.ts tests/store-atomic-load.test.ts tests/dsh-integration-regressions.test.ts tests/r8-backup-independent.test.ts tests/r8-backup-restore.test.ts tests/r8-backup-verify.test.ts --maxWorkers=2
npm run build
```

子Nodeのbundleは各テストの `beforeAll` が既存esbuildで一時ディレクトリへ作り、`afterAll` で削除する。GUIは起動しない。

## Codexへの依頼

1. F1を修正するか、現行のfail-closedを正式な仕様として記録するか決める。
2. 統合後に全体suiteとGUI許可時の確認を行う。GUI未実行のままLevel 3到達としない。
3. A/Bの変更を含む統合HEADで、本マトリクスの「対象HEADは基準版」という前提を更新する。
