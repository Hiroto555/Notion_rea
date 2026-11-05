# Folio Level 3 — G1–G8 独立証拠監査（担当D）

> この文書は開始点 e00dc17 の独立監査記録です。A/B/CとCodex修正を統合した最新の評価は [統合レビュー](INTEGRATION-REVIEW.ja.md) を参照してください。

2026-11-05 JST。作業場所 `<workspace-root>/Folio-l3-r2-audit`、branch `codex/folio-l3-r2-audit-20261105`。
基準HEAD `e00dc172f413f547ee6f0a0beab6d7bfa6d757d3`。この文書は**到達判定ではなく、判定に使える証拠と不足の棚卸し**である。最終判定と統合はCodexが行う。

- 製品コード、既存テスト、設定、lockfileは変更していない。変更したのは `docs/parallel/dsh-r2/` の本書・`LEVEL3-RESIDUALS.json`・`HANDOFF-D.ja.md` だけ。
- GUI / Electron / browser / OS clipboard / ネイティブダイアログ / スクリーンショット / osascript は**一切起動していない（NOT_RUN）**。
- 全体suiteは実行していない。Codex統合後に実行する。Dが今回実行したのは限定した既存Vitest 24ファイル・235件、`npm run check`、`npm run build`。
- A/B/Cの第2ラウンド成果はこのworktreeに存在しない。将来の成果を織り込まず、基準HEADの実装だけを監査した。

## 0. 判定サマリ

| Gate | Dの現時点判定 | 一言の根拠 | GUI |
| --- | --- | --- | --- |
| G1 ローカル完結 | **PARTIAL** | 製品entryに外部ネット依存は見当たらない。オフライン隔離GUIが未実施 | NOT_RUN |
| G2 正常操作の不変条件 | **PASS（非GUI範囲）** | 通常Pageのcreate/duplicate/move/trash/restore、順序・title上限・失敗rollbackをコードと既存試験で確認 | NOT_RUN |
| G3 保存の確定と入力保護 | **PARTIAL** | save/receiptの原子性は成立。template/importの初期本文が作成と別操作（既知の穴） | NOT_RUN |
| G4 復旧と競合 | **PARTIAL** | 未確定の保持・照会・競合拒否は成立。未送信操作を同じIDで明示再試行する経路がない | NOT_RUN |
| G5 backup/restore耐障害性 | **PARTIAL** | fsync・検証・別場所復元・不完全markerは実装済み。独立したプロセス中断試験（C担当）が未実施 | NOT_RUN |
| G6 破損・未知schemaの隔離 | **PASS（非GUI範囲）** | 破損Pageのread-only隔離、健康Pageのload/search、raw救出、未知versionの停止を確認 | NOT_RUN |
| G7 容量と処理量の管理 | **UNMET** | receipt・backup・添付の保持/上限/GC/容量表示がない。main同期処理の制限も残る | NOT_RUN |
| G8 独立検証と製品経路 | **PARTIAL** | 同一ソースでcheck/buildと限定235件はPASS。全体929件・GUI・CIは今回NOT_RUN | NOT_RUN |

**この表のPASSはLevel 3到達認定ではない。** G2とG6も「Dが確認した非GUI範囲」のPASSであり、GUI操作・全体suite・CIを含むG8を満たした意味ではない。G7は未達のままである。

### 証拠の区別

| 区分 | 意味 |
| --- | --- |
| 実装 | 基準HEADの製品コードで経路を確認した。動作の保証ではない |
| 既存試験 | テストファイルが存在し、対象の不変条件を書いている。今回未実行のものも含む |
| 今回実行 | Dがこの監査で実行し、結果を確認した |
| 過去記録 | 元監査（2026-11-04）またはR1統合（`a8bfd32`）の記録。今回の再実行結果ではない |
| GUI | 画面・Electron・browser等での確認。今回はすべてNOT_RUN |

テスト件数、0 failures、過去の929件はGate PASSの根拠にしない。件数は「何を実行したか」の記録としてだけ使う。

## 1. 横断点検

### 1.1 単一instance / 単一windowの範囲

- `app.requestSingleInstanceLock()` で同一プロファイルの二重起動を拒否し、2つ目の起動は既存windowのshow/focusに回す（[main/index.ts:68](../../../src/main/index.ts#L68)、[main/index.ts:73-76](../../../src/main/index.ts#L73-L76)）。
- `userData` は `FOLIO_DATA_DIR` 指定時にそのプロファイルへ切り替わる（[main/index.ts:43-50](../../../src/main/index.ts#L43-L50)）。したがって**ロックの範囲はプロファイル単位**であり、別の `FOLIO_DATA_DIR` を使う検証用instanceは同時に起動できる。これは復元先の起動試験など既存の意図した使い方で、「全OSプロセスで常に1つ」ではない。
- アプリ内のwindowは `let win` 1つ。`activate` はwindowが0件のときだけ再作成する（[main/index.ts:346-369](../../../src/main/index.ts#L346-L369)、[main/index.ts:398-400](../../../src/main/index.ts#L398-L400)）。複数windowで同じworkspaceを編集する機能はない。
- 単一writerの前提はStoreの同期SQLite接続とIPC送信元検証で守る（[main/index.ts:161-169](../../../src/main/index.ts#L161-L169)、[store.ts:236-254](../../../src/persistence/store.ts#L236-L254)）。ただし別プロファイル・別プロセスが同じ実データを開くことは防がない。運用上の前提として残る。

### 1.2 offline経路

- 製品のmain entryはローカルSQLiteとローカルファイルだけを使う。`net.fetch` は `folio-asset:` のローカルファイルURL読み出しにだけ現れる（[main/index.ts:137-152](../../../src/main/index.ts#L137-L152)）。HTTP API、クラウド同期、認証、テレメトリの呼び出しは製品entryにない。
- rendererはCSPで `default-src 'self'`、`connect-src 'self' ws://127.0.0.1:5173`、`img-src 'self' data: folio-asset:` に制限される（[index.html:1](../../../index.html#L1)）。`ws://127.0.0.1:5173` はVite開発サーバー用で、本番のfile load時には接続するコードがない。`FOLIO_DEV_URL` も開発時の上書き（[main/index.ts:157-160](../../../src/main/index.ts#L157-L160)）。
- `src/sync/` にはfetch/HTTPのcheckpoint server/clientがあるが、**製品entryからimportされていない**。buildのentryは `src/main/index.ts` と `src/preload/index.ts` だけで（[scripts/build.mjs:3](../../../scripts/build.mjs#L3)、[scripts/build.mjs:12](../../../scripts/build.mjs#L12)）、syncを使うのはテストだけ（[sync-checkpoint.test.ts:19-22](../../../tests/sync-checkpoint.test.ts#L19-L22)）。Level 3に分散機能を追加する根拠にはしない。
- 外部リンクのクリックは `shell.openExternal` でOSブラウザへ渡す（[main/index.ts:224-227](../../../src/main/index.ts#L224-L227)、[App.tsx:1926](../../../src/renderer/App.tsx#L1926)）。ユーザー操作による任意の外部遷移であり、保存・検索・起動のデータ依存ではない。オフライン試験ではこの導線を踏まない。
- 保存・検索・書き出しはローカル完結: searchはStore内のsnapshotから（[store.ts:1334-1340](../../../src/persistence/store.ts#L1334-L1340)、[search-query.ts:57](../../../src/persistence/search-query.ts#L57)）、exportは選択先へ `writeFileSync`（[main/index.ts:310-323](../../../src/main/index.ts#L310-L323)）。Markdown変換もローカル関数（[markdown.ts:46](../../../src/document-io/markdown.ts#L46)、[markdown.ts:102](../../../src/document-io/markdown.ts#L102)）。
- 残件: ネットワークを実際に切った状態でのアプリ起動〜編集〜検索〜保存〜再open〜書出しは**NOT_RUN**。コード点検だけでは「アプリ全体のoffline確認」を満たさない。

### 1.3 正常操作の不変条件

- Pageのtitle上限500はrequest schemaで検証し（[types.ts:475](../../../src/shared/types.ts#L475)、[types.ts:483](../../../src/shared/types.ts#L483)）、複製はサロゲートペアを割らずに500以内へ切る（[store.ts:1157-1161](../../../src/persistence/store.ts#L1157-L1161)）。
- createは同一親の既存position（trashを含む）を予約し、重複・非有限・増分不能なら書かずに拒否する（[store.ts:556-578](../../../src/persistence/store.ts#L556-L578)）。duplicateは子孫へ新IDを振り、rootだけ新しい兄弟位置を与え、部分複製はtransactionで戻す（[store.ts:1126-1177](../../../src/persistence/store.ts#L1126-L1177)）。
- moveは子孫循環、削除済み親、同順位tie、record/登録DBの保護を書き込み前に検査する（[store.ts:1034-1116](../../../src/persistence/store.ts#L1034-L1116)、[store.ts:966-988](../../../src/persistence/store.ts#L966-L988)）。
- trash/restoreは同一削除stampのsubtreeだけを対象にし、親が消えていればrootへ戻す（[store.ts:1179-1208](../../../src/persistence/store.ts#L1179-L1208)）。
- 失敗時は `BEGIN IMMEDIATE` / `ROLLBACK` で戻し、ROLLBACK失敗は接続をunusableにして「不明」を成功に見せない（[store.ts:236-254](../../../src/persistence/store.ts#L236-L254)）。
- 既知の同順位tieと500文字titleの回帰は、基準HEADの祖先 `1eebb71` で修正され、`tests/local-integrity-regressions.test.ts` に回帰試験がある。今回の基準HEADはその子孫で、src/testsはR1統合 `a8bfd32` と同一（`a8bfd32..e00dc17` の差分はdocs 4ファイルのみ）。

### 1.4 startup recoveryの未確定操作

- 復旧journalはworkspace ID・generation・checksum付きで、staging書込→fsync→readback→rename→fsyncで公開する（[crash-recovery-file.ts:73-112](../../../src/persistence/crash-recovery-file.ts#L73-L112)）。
- rendererは送信前にcheckpointを確定させ、失敗したら送信しない（[page-operation-coordinator.ts:187-198](../../../src/renderer/page-operation-coordinator.ts#L187-L198)、[App.tsx:597-600](../../../src/renderer/App.tsx#L597-L600)）。ACK喪失・timeout・不一致は `unknown` として操作を保持する（[reliable-save.ts:7-37](../../../src/renderer/reliable-save.ts#L7-L37)、[page-operation-coordinator.ts:28-68](../../../src/renderer/page-operation-coordinator.ts#L28-L68)）。
- 起動時は保持したoperationを `page:resolve` / `save:resolve` で照会し、`applied` でなければ復旧を止める（[prepare-crash-recovery.ts:18-47](../../../src/renderer/prepare-crash-recovery.ts#L18-L47)）。**一度も送信されなかった操作はreceiptがないため永久にunknown**で、そのままでは「入力を復元」できない。ユーザーは「別ページに復旧」でpayloadを新Pageへ保存できる（[CrashRecoveryDialog.tsx:87-99](../../../src/renderer/CrashRecoveryDialog.tsx#L87-L99)、[crash-recovery-copy.ts:12-41](../../../src/persistence/crash-recovery-copy.ts#L12-L41)）。
- これはR1レビューの残件3と同じ（[INTEGRATION-REVIEW.ja.md:67](../dsh-r1/INTEGRATION-REVIEW.ja.md#L67)）。第2ラウンドAの「同じoperationを使う明示的な再試行」はこのworktreeには未統合。

### 1.5 未知schema・破損

- `PRAGMA user_version` が既知の最大4を超えるworkspaceは開かずに閉じる（[store.ts:82-89](../../../src/persistence/store.ts#L82-L89)）。
- `FOLIO-RECOVERY-INCOMPLETE` があるworkspaceは通常起動を拒否する（[store.ts:51-57](../../../src/persistence/store.ts#L51-L57)）。
- 壊れたPage JSON、ID/metadata不整合、未知の `schemaVersion` は `PageDataError` としてread-only表示にし、原本bytesは書き換えない（[store.ts:199-235](../../../src/persistence/store.ts#L199-L235)、[store.ts:256-288](../../../src/persistence/store.ts#L256-L288)）。`write` は `documentError` の原本を拒否する（[store.ts:295-312](../../../src/persistence/store.ts#L295-L312)）。
- `load` は破損Pageをplaceholderにして健康なPageを返し、record ownerが壊れている場合はそのDBのrecordだけをread-onlyにする（[store.ts:360-412](../../../src/persistence/store.ts#L360-L412)）。原本rawは `pageSource` で取得でき、UIに「原本JSONを保存」がある（[types.ts:509](../../../src/shared/types.ts#L509)、[App.tsx:2129-2141](../../../src/renderer/App.tsx#L2129-L2141)）。
- snapshotのCOMMIT/ROLLBACK/close失敗は接続をpoisonし、読み続けない（[store.ts:416-509](../../../src/persistence/store.ts#L416-L509)）。

### 1.6 receipt/backup容量とmain同期処理

- `save_receipts` はsave/Page/DB/property/migrationの各operationでINSERTされるが、**削除・保持上限・GCのコードが1つもない**（[store.ts:837-838](../../../src/persistence/store.ts#L837-L838)、[database-operations.ts:87](../../../src/persistence/database-operations.ts#L87)、[page-operations.ts:181](../../../src/persistence/page-operations.ts#L181)、[property-operations.ts:208](../../../src/persistence/property-operations.ts#L208)、[legacy-migration-operation.ts:274](../../../src/persistence/legacy-migration-operation.ts#L274)）。
- versionsだけはPageごと100件に切る（[store.ts:945-949](../../../src/persistence/store.ts#L945-L949)）。receiptのresult JSONは本文・record valuesを含み得る。
- backupは `backups/` へ作成するだけで、世代数・合計bytes・古いbackupの保守がない（[workspace-backup-service.ts:24-28](../../../src/main/workspace-backup-service.ts#L24-L28)）。legacyの `backup` 要求も同じ（[main/index.ts:249-265](../../../src/main/index.ts#L249-L265)）。
- 添付は1件20MBの上限だけで、未登録orphanの回収・全workspaceの容量表示はない（[assets.ts:25-56](../../../src/persistence/assets.ts#L25-L56)）。
- 容量に触れるUIはbackup previewのbytes/inventoryだけ（[workspace-backup.ts:22-25](../../../src/shared/workspace-backup.ts#L22-L25)、[WorkspaceBackupDialog.tsx:229](../../../src/renderer/workspace-backup/WorkspaceBackupDialog.tsx#L229)）。receipt・assets・backupsの合計や増加率は表示しない。
- mainは `ipcMain.handle` のasync関数内で同期Store/同期backupを呼ぶ（[main/index.ts:161](../../../src/main/index.ts#L161)、[main/index.ts:344](../../../src/main/index.ts#L344)）。`DatabaseSync` と同期fsyncのため、大きいload/search/backupはmainのevent処理を占有し得る。worker隔離はない。
- 今回の合成測定（`tests/record-scale.test.ts`）は1,000件でload 35.6–102.7ms・search 71.7–145.2ms、10,000件でload 196.4–526.6ms・search 210.6–463.1ms、10,000件の移行2.77秒。**GUI・起動・入力遅延は測っていない**単発の合成値で、p95でも保証でもない。

## 2. Gate別の証拠

### G1 ローカル完結 — PARTIAL

必要条件: ネットなしで起動・通常編集・ローカル検索・保存・再open・ローカル書出しが成立。任意の外部AI等は除外。ネット依存の実コード点検＋後日の隔離GUI確認。

- 主要関数・入口: `createWindow` / `ipcMain.handle`（main）、`searchPages`、`Store.load` / `Store.commitSave`、`exportMarkdown`。

実装（提供中）:

- 起動はローカル `workspace.sqlite` と `assets/`（[main/index.ts:122-128](../../../src/main/index.ts#L122-L128)）。SQLiteはWAL・`synchronous=FULL`（[store.ts:79-81](../../../src/persistence/store.ts#L79-L81)）。
- 検索はローカルsnapshot（1.2節参照）。保存は `commitSave` / `commitPageOperation`。再openはStore再接続。書き出しはローカル保存ダイアログ先への `writeFileSync`。
- 製品entryに外部ネットの必須経路なし。sync moduleはテスト専用。
- 添付表示はmainのローカルfileを `folio-asset:` で返す。`net.fetch` の引数は `pathToFileURL(asset.path)` で、外部URLではない。

既存試験: `tests/store.test.ts:26`（保存・再open）、`tests/r7-search.test.ts:41`（ローカル検索）、`tests/r7-markdown.test.ts:7`（Markdown入出力）、`tests/workspace.test.ts:60`（workspace移行・添付bytes）、`tests/output-path.test.ts:5`（外部出力先の境界）。store/r7-search/workspace は今回の限定実行に含む。r7-markdown/output-path は既存試験のみで今回未実行。

前回検証の範囲: 元監査はNode試験757件とE2E 197件の**過去記録**を持つが、通信遮断での全アプリ操作は未実施（[REPORT.ja.md:45-53](../../../../Notion_rea/outputs/folio-technical-audit-20261104/REPORT.ja.md#L45-L53)）。R1はquiet入口だけで、GUI/オフライン確認はNOT_RUN。

今回の残件:

1. ネットワークを切った状態の起動〜編集〜検索〜保存〜再open〜書出しが**NOT_RUN**。「コードに外部呼び出しがない」ことだけでは条件を満たさない。
2. 本番CSPにも開発用 `ws://127.0.0.1:5173` が残る。localhost限定で外部依存ではないが、本番で不要な許可としては残る。`FOLIO_DEV_URL` は開発用の上書き。
3. 外部リンクの `shell.openExternal` はユーザー操作でネットワークへ出る。データ依存ではないが、オフライン試験の対象外と明記する。
4. `src/sync/` は製品未接続。Level 3の条件に分散同期を追加しない。

次の最小受入試験: 専用の一時 `FOLIO_DATA_DIR` とネットワーク無効の環境で、GUI許可後に「起動→Page作成→本文編集→検索→保存→終了→再起動→再open→Markdown/HTML/JSON書出し」を行い、外部通信がないことと書出し内容を確認する。GUIなしで代替するなら、製品entryのimport graphにネットワークAPIがないことを静的に検査する補助試験を追加する（ただし隔離GUIの代替にはしない）。

担当依存: GUIはCodex/利用者許可。コード側の追加変更は不要と見るが、CSPの開発用ws整理はCodex判断。

### G2 正常操作の不変条件 — PASS（非GUI範囲）

必要条件: Page/Doc/recordのID・所属・順序・参照とtitle上限を維持。create/duplicate/move/trash/restore、legacy/v4混在、失敗時原本不変、再openを試験。

- 主要関数: `Store.create` / `duplicateInTransaction` / `move` / `trash` / `restore` / `updatePageInTransaction`、`previewPageOrderRepair` / `applyPageOrderRepair`。

実装（提供中）:

- title: request schemaの500上限（[types.ts:475](../../../src/shared/types.ts#L475)、[types.ts:483](../../../src/shared/types.ts#L483)）。duplicate suffixのclamp（[store.ts:1157-1161](../../../src/persistence/store.ts#L1157-L1161)）。
- create: 親のdeleted/documentError拒否、record/登録DB配下の拒否、兄弟positionの重複・非有限・増分不能の拒否、SAVEPOINTでのDB登録（[store.ts:537-627](../../../src/persistence/store.ts#L537-L627)）。
- duplicate: 子孫の新ID、rootの兄弟位置、trash位置の予約、部分複製rollback（[store.ts:1117-1177](../../../src/persistence/store.ts#L1117-L1177)）。doc値をそのまま複製（JSON再直列化）するため、Page内のblock IDと `folio-page://` リンクは変更しない（リンク先を複製先へ書き換える仕様ではない）。
- move: record/登録DBの拒否、循環拒否、tie検出、有限な中間positionの検査（[store.ts:1034-1116](../../../src/persistence/store.ts#L1034-L1116)）。
- trash/restore: 削除stamp単位のsubtree、親が消えた場合のroot復帰（[store.ts:1179-1208](../../../src/persistence/store.ts#L1179-L1208)）。
- 失敗時rollbackと、record/登録DBを巻き込む汎用lifecycleを**明示的に拒否**する経路（[store.ts:966-988](../../../src/persistence/store.ts#L966-L988)、[store.ts:630-682](../../../src/persistence/store.ts#L630-L682)）。record/登録DBには専用のbackend lifecycleもある（[store.ts:1278-1321](../../../src/persistence/store.ts#L1278-L1321)）。

既存試験（今回実行、すべてPASS）:

- `tests/local-integrity-regressions.test.ts:59`（反復複製+移動+新規作成）、`:90`（歴史的tieを書き換えない）、`:114`（tieを含む移動拒否）、`:132`（subtree複製と子順序）、`:164`（表現不能なgap）、`:187`（500文字/絵文字title）、`:207`（trash位置予約）、`:223`（部分複製rollback）、`:239`（record owner拒否）。
- `tests/store.test.ts:57`（150階層・循環拒否）、`:72`（subtree複製）、`:82`（古いwrite拒否・履歴復元）、`:107`（move/trash/restore）、`:189`（trash親の子restore）。
- `tests/move-record-isolation.test.ts:29`（record bytesを変えない移動）、`:43`（record移動拒否）、`:78`（書き込み失敗時に全Page不変）、`:118`（混在DB順序の再起動）、`:173`（非canonical bytes拒否）、`:223`（trash位置予約）。
- `tests/record-lifecycle.test.ts:37`（record trash batch）、`:59`（DB trash rollback）、`:86`（record複製とlink rewrite）、`:160`（revision/子持ち拒否）。
- `tests/page-order-repair.test.ts:156-770`（Bのpreview/apply、backup必須、rollback、再open）。※このAPIは製品IPC/UIに未接続。

前回検証の範囲: 元監査は通常操作のtieと500文字titleを独立probeで再現（I02/I09）。基準HEADの祖先 `1eebb71` で修正され、回帰試験が追加された。今回の基準HEADはその修正を含む。

残件:

1. Bの順序修復APIは存在するが、GUI/IPCから呼ぶ経路がない。既存tieは「安全に拒否」で止まり、ユーザーが修復できない。G2の通常操作条件は満たすが、既存破損の回復導線としては未提供。
2. record/登録DBのtrash/restore/duplicate/historyはbackendに一部経路があるが、製品UIは `unavailable` で未提供（I07）。履歴復元はmainでも拒否する。G2は「未対応操作は明確かつ安全に拒否する」ため減点しないが、提供機能として数えない。
3. Page複製はdocをそのまま複製する。block ID/リンクを複製先へ再マップする仕様はなく、専用試験もない。参照が壊れることはないが、「複製先への参照書き換え」は提供していない。
4. GUIでのcreate/duplicate/move/trash/restoreはNOT_RUN。

次の最小受入試験: GUI許可後に一時workspaceで「作成→複製（500文字title含む）→移動→ゴミ箱→復元→再起動→再open」を行い、ID・親子・順序・本文・title上限を確認する。Nodeでは既存試験を統合HEADで再実行する。

担当依存: B（修復のGUI接続はCodex判断）、Codex（GUI）。

### G3 保存の確定と入力保護 — PARTIAL

必要条件: Pageとreceiptが一緒に確定/rollback。ACK喪失・重複・timeoutで二重生成/虚偽成功なし。template/importの初期本文を作成と同一操作で永続化し、送信前checkpointにも含める。

- 主要関数: `Store.commitSave`、`commitPageOperation`、`PageOperationCoordinator.run`、`sendPageOperation` / `sendReliableSave`、`App.create` / `update`。

実装（提供中）:

- `commitSave` は `BEGIN IMMEDIATE` 内でreceiptを読み、SAVEPOINTでPage変更を行い、成功/拒否のreceiptを同一transactionでINSERTする（[store.ts:780-840](../../../src/persistence/store.ts#L780-L840)）。拒否時はSAVEPOINTへROLLBACKしてからreceiptを書く（[store.ts:830-836](../../../src/persistence/store.ts#L830-L836)）。receipt INSERT失敗は外側transactionを失敗させ、Pageも残さない。
- Page create/duplicateは `save_receipts` を共有し、operation ID+fingerprintで同一操作を1回に固定する（[page-operations.ts:118-183](../../../src/persistence/page-operations.ts#L118-L183)）。duplicateの事前拒否もterminal receiptとして残す。
- rendererは送信前に復旧checkpointをflushし、失敗時は送信しない（[page-operation-coordinator.ts:187-198](../../../src/renderer/page-operation-coordinator.ts#L187-L198)）。saveも `pageOperations` にoperationを置いてから `recoveryBarrier` を待つ（[App.tsx:596-602](../../../src/renderer/App.tsx#L596-L602)）。
- ACK照合はoperation/session/seq/fingerprint/page revision/patchの一致を要求し、不一致・timeoutは `unknown` にする（[reliable-save.ts:14-36](../../../src/renderer/reliable-save.ts#L14-L36)、[page-operation-coordinator.ts:46-67](../../../src/renderer/page-operation-coordinator.ts#L46-L67)）。
- **未達**: template/importは `create()` で空Pageを作成した後、`if (doc) update(p.id, { doc })` で本文を別保存する（[App.tsx:767-812](../../../src/renderer/App.tsx#L767-L812)、[App.tsx:1195](../../../src/renderer/App.tsx#L1195)）。templateはさらにiconを別updateする（[App.tsx:2516-2517](../../../src/renderer/App.tsx#L2516-L2517)）。作成と初期本文は同一operationではなく、間で落ちると空Pageが残る。送信前checkpointは本文updateについても送信前に取るが、作成receiptには本文が含まれない。

既存試験（今回実行、PASS）:

- `tests/page-operation-receipts.test.ts:63`（同一operationのcreateをreplay）、`:100`（ACK喪失後のresolveで1 Page）、`:120`（複製1回・stale revision拒否）、`:148`（部分複製rollback）、`:175`（receipt失敗でPageも戻す）、`:193`（terminal rejectionのreplay）。
- `tests/save-receipts.test.ts:10`（data+receipt原子性）、`:50`（receipt失敗でdata/history rollback）、`:62`（拒否receiptとrollback）、`:82`（COMMIT後例外をreceiptから解決、再open）、`:105`（receiptなしはunknown）、`:117`（壊れたACKをunknown扱い）。
- `tests/dsh-integration-regressions.test.ts:103`（RAISE(FAIL)後にPageを残さない）、`:116`（Page ID欠落ACKをunknown保持）、`:135`（checkpointからのACK回復）。

前回検証の範囲: R1で通常作成/複製のatomicityを改善。template/importの2段階は残件4として記録済み（[INTEGRATION-REVIEW.ja.md:68](../dsh-r1/INTEGRATION-REVIEW.ja.md#L68)）。第2ラウンドAの修正は未統合。

残件:

1. template/importの初期本文が作成と別操作。作成成功後・本文保存前にプロセスが落ちると、空Pageが1つ残る。Aの担当範囲。
2. templateのiconはさらに別update。表示上の付加情報だが、同様に部分状態が残り得る。
3. GUIでのtemplate/import作成と再openはNOT_RUN。

次の最小受入試験: template/importの作成を1つのoperation（Page+doc）としてcommitし、`create` と本文保存の間で失敗を注入しても空Pageが残らないこと。ACK喪失・同じoperationの再送でPageが1つだけであること。送信前checkpointに初期本文が含まれること。既存`page-operation-receipts`と`save-receipts`に追加する。

担当依存: A（実装）、Codex（統合後の全体suite）。

### G4 復旧と競合 — PARTIAL

必要条件: 未保存入力と未確定操作を再open後も保持。未送信操作はユーザーの明示再試行で同じIDを使用。rejected/unknownを消して成功にしない。revision不一致は上書きせず、復旧コピーなど説明可能な出口を持つ。

- 主要関数: `CrashRecoveryFile.write`、`RecoveryCheckpoint.offer` / `retry`、`prepareCrashRecovery`、`acknowledgePage`、`resolveReliableSave`、`createRecoveryCopy`。

実装（提供中）:

- 未保存入力は編集session/pending editsとして保持し、checkpointにPage/record/DB/raw draft/未確定操作を含める（[App.tsx:260-290](../../../src/renderer/App.tsx#L260-L290)）。
- 復旧journalはfsync・checksum・generation CAS・readbackで、ACK喪失後の同一内容再送も扱う（[crash-recovery-file.ts:77-105](../../../src/persistence/crash-recovery-file.ts#L77-L105)）。rendererのqueueは失敗したattemptを固定し、明示retryで同じCASを再送する（[recovery-checkpoint.ts:37-64](../../../src/renderer/recovery-checkpoint.ts#L37-L64)）。
- 起動時はreceiptを照会し、`applied` のときだけ入力を復元する。`rejected`/`unknown` を成功にしない（[prepare-crash-recovery.ts:18-47](../../../src/renderer/prepare-crash-recovery.ts#L18-L47)）。
- revision不一致は書かずに拒否し、入力を保持する（[store.ts:640-647](../../../src/persistence/store.ts#L640-L647)、[store.ts:756-759](../../../src/persistence/store.ts#L756-L759)）。UIはエラーを出し、`edits.current.failed` を維持する（[App.tsx:606-612](../../../src/renderer/App.tsx#L606-L612)）。
- 説明可能な出口: (a) 起動時の「別ページに復旧」はpayloadを新しいPageへ保存する（[crash-recovery-copy.ts:12-41](../../../src/persistence/crash-recovery-copy.ts#L12-L41)）、(b) session中の「未保存の変更を別ファイルに記録」、(c) 「退避して再読込」でJSONを書き出し、後から「退避JSONから復旧」で新Pageにする（[App.tsx:1792-1888](../../../src/renderer/App.tsx#L1792-L1888)、[App.tsx:1705-1717](../../../src/renderer/App.tsx#L1705-L1717)）。
- **未達**: 未送信のsave/Page作成を**同じoperation IDで再送**する経路がない。`resolve` はreceiptがない限りunknownを返し続け（[store.ts:775-779](../../../src/persistence/store.ts#L775-L779)、[page-operations.ts:102-110](../../../src/persistence/page-operations.ts#L102-L110)）、session中の「保存を再試行」ボタンは「保存の競合を安全に再試行できません」と明示的に拒否する（[App.tsx:1750-1756](../../../src/renderer/App.tsx#L1750-L1756)）。起動時もunknownの操作があると復旧全体が止まる（[prepare-crash-recovery.ts:22-25](../../../src/renderer/prepare-crash-recovery.ts#L22-L25)）。

既存試験（今回実行、PASS）:

- `tests/crash-recovery.test.ts:93`（operation-bearing checkpointを送信前に待つ）、`:112`（COMMIT済みrecordの再開）、`:134`（古いreceiptを新しいsourceへ昇格せず、競合入力をidempotent copyにする）、`:154`（receiptなしをquery-onlyで保持）、`:193`（recovery copyのdedupe receipt rollback）。
- `tests/prepare-crash-recovery.test.ts:21`（COMMIT ACK喪失後のPage準備）、`:85`（新しいsourceを上書きしない）、`:98`（unverified inputはIPC前に拒否）、`:123`（raw number draftのbound確認）。
- `tests/recovery-checkpoint.test.ts:9`（即時capture・coalesce・ACK後だけsaved）、`:39`（同じCASでretry）、`:55`（無関係generationを上書きしない）、`:84`（timeoutをerrorとして保持）。
- `tests/pending-journal-file.test.ts:30`（検証・fsync・no-overwriteの公開）。

前回検証の範囲: R1は未送信checkpoint操作がunknownのまま残ることを残件3として明記（[INTEGRATION-REVIEW.ja.md:67](../dsh-r1/INTEGRATION-REVIEW.ja.md#L67)）。元監査はSIGKILLでCOMMIT前後を確認したが、全入力タイミングではない（[REPORT.ja.md:70](../../../../Notion_rea/outputs/folio-technical-audit-20261104/REPORT.ja.md#L70)）。

残件:

1. 未送信操作の明示再試行（同じIDで送信）がない。Aの担当。現状は「照会し続ける」「別ページへコピー」「JSON退避」のどれかで、元の操作を完了できない。
2. 起動時recoveryはunknownが1件でもあると「入力を復元」を止める。ユーザーがcopy/exportを選ぶまで元Pageの編集を再開できない。
3. session中の「保存を再試行」は安全側に倒して拒否する。復旧コピーは手動のJSON退避→再読込→取込で、1操作ではない。
4. GUIでの起動時復旧・競合・再開はNOT_RUN。

次の最小受入試験: 送信前checkpointだけを作り、実送信しない状態で再起動→ユーザーの明示retryが同じ `operationId` で送信され、Pageが1つだけ作られること。ACK喪失→resolve→retryでも重複しないこと。stale revisionで上書きせず、同じ入力から復旧コピーを作れること。Aの試験とGUIで確認する。

担当依存: A（実装）、Codex（統合・GUI）。

### G5 backup/restore耐障害性 — PARTIAL

必要条件: 完了前にDB・全添付・directoryのdurability barrierと検証。別の一時場所に復元し、原本不変。途中失敗・不完全marker・再openを検証。

- 主要関数: `createFullBackup` / `copyAssetTree` / `writeNewFileDurably` / `restoreFullBackup` / `verifyFullBackup`。

実装（提供中）:

- 作成: 出力先を排他作成し、`FOLIO-RECOVERY-INCOMPLETE` をwrite+fsync、親directoryをfsync（[full-backup-create.ts:243-256](../../../src/persistence/full-backup-create.ts#L243-L256)）。`VACUUM INTO` 後、添付を1ファイルずつ `writeNewFileDurably`（本文fsync）→readback比較→directory fsync（[full-backup-create.ts:68-113](../../../src/persistence/full-backup-create.ts#L68-L113)、[durable-file.ts:48-80](../../../src/persistence/durable-file.ts#L48-L80)）。SQLite snapshotとassets directoryをfsync（[full-backup-create.ts:260-269](../../../src/persistence/full-backup-create.ts#L260-L269)）。
- 検証: `inspectWorkspaceSnapshot` とmanifestを作り、`verifyFullBackup(..., {allowIncomplete:true})` の後にだけmarkerを消す。marker削除後のdirectory fsync失敗はmarkerを戻して失敗する（[full-backup-create.ts:274-307](../../../src/persistence/full-backup-create.ts#L274-L307)、[full-backup-verify.ts:641](../../../src/persistence/full-backup-verify.ts#L641)、[full-backup-verify.ts:817](../../../src/persistence/full-backup-verify.ts#L817)）。
- 復元: 元backupを再検証し、manifest bytesとfingerprintを照合してから、存在しない新規folderを排他作成（[full-backup-restore.ts:293-345](../../../src/persistence/full-backup-restore.ts#L293-L345)）。各fileをhash照合しながら書き、fsync、directory fsync（[full-backup-restore.ts:215-268](../../../src/persistence/full-backup-restore.ts#L215-L268)）。コピー後に元と先を再検証し、一致したときだけmarkerを消す（[full-backup-restore.ts:363-393](../../../src/persistence/full-backup-restore.ts#L363-L393)）。
- 不完全workspaceはStoreが起動を拒否する（[store.ts:51-57](../../../src/persistence/store.ts#L51-L57)）。

既存試験（今回実行、PASS）:

- `tests/r8-backup-create.test.ts:198`（全table/history/receipt/assetsのsnapshot）、`:306`（既存先・symlink・source拒否）、`:345`（transaction中は作成しない）、`:364`（添付bytes不一致をmarker付きで拒否）、`:390`（失敗時にmarker付きpartialを残す）。
- `tests/r8-backup-independent.test.ts:330`（v4 fixtureのtable/byte round-trip）、`:508`（破損・future version・欠損asset・symlink・traversalを公開前に拒否）、`:575`（stale fingerprint・既存復元先を拒否）、`:626`（既存backup先を上書きしない）、`:647`（不完全markerのStore起動拒否）。
- `tests/r8-backup-restore.test.ts:273`（ID/row/settings/history/receipt/assetsのbyte復元）、`:429`（stale fingerprint・既存先・backup内path拒否）、`:487`（検証後のsource変更検知）、`:514`（コピー失敗のmarkerとStore拒否）。
- `tests/durability-attachment-backup.test.ts:132`（添付body→directory→metadataの順）、`:171`/`:194`（fsync失敗で登録しない）、`:314`（backupの本文→directory→完了の順）、`:361`（親directory fsync失敗で公開しない）、`:372`（最終fsync失敗でmarker復帰）、`:384`（nested fsync失敗でmarkerとsource保持）。
- `tests/r8-backup-verify.test.ts:463`（不完全marker・future schemaの拒否）。

前回検証の範囲: 元監査I01で添付fsync欠如を指摘。基準HEADの祖先 `136bbfc` で本文→directory→参照の順に修正済み。物理停電耐性は主張しない。

残件:

1. backup作成/復元の途中で**プロセスを強制終了する独立試験**（C担当）がこのworktreeにはない。既存はfsync/copy失敗の注入で、SIGKILL中のmarker・partial・再openは未実行。
2. 物理電源断・OSクラッシュの保証は対象外。fsyncの範囲を超える主張はしない。
3. GUIの「バックアップと復元」画面、復元先を開く導線はNOT_RUN。

次の最小受入試験: 使い捨てfixtureの子Nodeで、DB snapshot後・添付コピー中・manifest公開前・marker削除直前の各点をSIGKILLし、残ったmarker/partialがStore起動を拒否し、元workspaceがbyte不変であること。復元側も同様に中断し、不完全markerと原本不変を確認する。Cの独立試験として実施する。

担当依存: C（中断試験）、Codex（GUI復元）。

### G6 破損・未知schemaの隔離 — PASS（非GUI範囲）

必要条件: 壊れた対象へ書かず原本rawを救出可能。健康なページ/DBへ到達できる。未対応schema/transaction cleanup失敗は安全に停止。

- 主要関数: `Store.decode` / `pages` / `load` / `write` / `poisonSnapshotConnection` / `assertRecordWriteSchema`。

実装（提供中）:

- 未知の `user_version` は開かずに停止（[store.ts:82-89](../../../src/persistence/store.ts#L82-L89)）。不完全復旧markerも停止（[store.ts:51-57](../../../src/persistence/store.ts#L51-L57)）。
- 壊れたJSON/ID/metadata/未知schemaVersionは `PageDataError` → read-only placeholder。`load` は健康なPageを返し、record ownerの破損はそのowner配下だけread-onlyにする（[store.ts:199-288](../../../src/persistence/store.ts#L199-L288)、[store.ts:360-412](../../../src/persistence/store.ts#L360-L412)）。
- 破損Pageへの `write`/`update`/`move`/`duplicate`/`trash`/`restore` は原本を書き換えず拒否する（[store.ts:295-312](../../../src/persistence/store.ts#L295-L312)、[store.ts:547](../../../src/persistence/store.ts#L547)、[store.ts:566](../../../src/persistence/store.ts#L566)、[store.ts:1081](../../../src/persistence/store.ts#L1081)、[store.ts:1145](../../../src/persistence/store.ts#L1145)）。
- 原本rawの救出は `pageSource`（[types.ts:509](../../../src/shared/types.ts#L509)）とUIの「原本JSONを保存」（[App.tsx:2129-2141](../../../src/renderer/App.tsx#L2129-L2141)）。
- transaction cleanup失敗は接続をpoisonし、close失敗でも読み続けない（[store.ts:416-509](../../../src/persistence/store.ts#L416-L509)）。未知/不完整なrecord schemaはwrite前に拒否する（[store.ts:861-906](../../../src/persistence/store.ts#L861-L906)）。

既存試験（今回実行、PASS）:

- `tests/corrupt-page-isolation.test.ts:54`（invalid JSON/missing metadata/ID不一致で健康Pageのload/search/edit/再open、原本bytes不変）、`:107`（record projectionの隔離とowner read-only）、`:135`（破損DB ownerのrecord隔離）、`:158`（未知schemaVersionのread-only保護）、`:174`（malformed membershipを部分成功にしない）。
- `tests/store-raw-database-guard.test.ts:60`（未知history bytesを保持）、`:82`（lossy database変更の拒否）。
- `tests/record-page-schema-guard.test.ts:28`（欠損tableでwrite拒否）、`:47`（未知/曖昧markerの拒否）、`:69`（未知columnの拒否）。
- `tests/store-atomic-load.test.ts:60`（単一snapshot）、`:352`/`:383`/`:424`（COMMIT/close/state API失敗時に接続を無効化）。

前回検証の範囲: 元監査I03は1件の不正JSONでworkspace全体が止まることを独立probeで再現。基準HEADの祖先 `1eebb71` でpage単位のquarantineとowner隔離へ拡張された（[REPORT.ja.md:219](../../../../Notion_rea/outputs/folio-technical-audit-20261104/REPORT.ja.md#L219)）。

残件:

1. GUIの「読めないページ」表示から健康Pageの閲覧・原本JSON保存を行う導線はNOT_RUN。コード経路はあるが、画面での確認はない。
2. SQLite本体が壊れた場合の修復は提供しない（integrity_check失敗は停止）。Page JSONの破損とは別で、G6の「壊れた1ページの隔離」の範囲外。
3. 未知schemaは移行せず停止する。これは意図した安全側の動作で、自動移行は条件にしていない。
4. transaction cleanup失敗は再接続（アプリ再起動）が必要。プロセス内で自動回復しない。

次の最小受入試験: GUI許可後に、一時workspaceの1 PageだけJSONを壊し、再起動→健康Pageの表示・検索・編集・保存→壊れたPageのread-only表示→原本JSON保存→再起動で原本bytes不変、を確認する。

担当依存: Codex（GUI救出導線は後日）。

### G7 容量と処理量の管理 — UNMET

必要条件: receipt・backup・添付等の容量/増加を把握し、入力を消さない上限/保守手段を持つ。unknown操作をGCしない。1千/1万規模の処理量と許容範囲を記録し、main同期処理の制限を隠さない。

- 主要関数: `Store.recordVersion`、`WorkspaceBackupService.create`、`attachFile`、`ipcMain.handle`。

実装（現状）:

- receiptはINSERTのみ。削除・上限・世代管理・容量表示がない（1.6節の各INSERT）。本文やrecord valuesを含むresult JSONがoperationごとに残る。
- versionsは100件/Pageで切る（[store.ts:945-949](../../../src/persistence/store.ts#L945-L949)）。receiptには同等の上限がない。
- backupは作成のみ。`backups/` の一覧・削除・保持世代・合計bytesの制御がない（[workspace-backup-service.ts:24-28](../../../src/main/workspace-backup-service.ts#L24-L28)）。
- 添付は20MB/件の上限だけで、orphan/未登録fileの回収やworkspace全体の容量表示がない（[assets.ts:25-56](../../../src/persistence/assets.ts#L25-L56)）。
- 容量UIはbackup previewのbytes/inventoryだけ（[WorkspaceBackupDialog.tsx:229](../../../src/renderer/workspace-backup/WorkspaceBackupDialog.tsx#L229)）。
- mainは同期SQLite/fsyncで、重い処理をWorkerへ逃がさない（[main/index.ts:161](../../../src/main/index.ts#L161)、[main/index.ts:344](../../../src/main/index.ts#L344)）。

測定（今回実行、合成値）:

| 規模 | load (ms) | search (ms) | view model (ms) | 移行 (ms) |
| --- | --- | --- | --- | --- |
| 1,000 | 35.6–102.7 | 71.7–145.2 | 52.7–83.7 | 265.3 |
| 10,000 | 196.4–526.6 | 210.6–463.1 | 176.2–192.6 | 2,767.6 |

出典: `tests/record-scale.test.ts:10`、ログ `output/dispatch/d-logs/record-scale.log`。SQLite+modelのみの単発合成値で、GUI・起動・入力latency・p95ではない。10,000件ではload/searchが数百ms、移行が秒単位で、main同期処理ではUI/ IPCを待たせ得る。

前回検証の範囲: 元監査I04は8,000字本文105回保存でreceipt result JSON 905,722 bytes、versions 100に対しreceipt 105を実測（[REPORT.ja.md:220](../../../../Notion_rea/outputs/folio-technical-audit-20261104/REPORT.ja.md#L220)）。I05/I06は同期SQL・全件検索・逐次IPCを指摘（[REPORT.ja.md:221-222](../../../../Notion_rea/outputs/folio-technical-audit-20261104/REPORT.ja.md#L221-L222)）。R1のCは対象DBのscoped readだけを改善し、workspace全体・検索・backupは対象外（[INTEGRATION-REVIEW.ja.md:69](../dsh-r1/INTEGRATION-REVIEW.ja.md#L69)）。

残件:

1. receiptの保持/上限/容量表示/安全な保守契約がない。Bの担当。自動削除は未実装のままでよく、まず非破壊の計測・保守契約が必要。
2. backupの保持世代・合計容量・削除/移動の保守手段がない。
3. 添付のorphan回収・容量集計がない。
4. main同期処理の制限（大きなload/search/backupでevent loopが止まる）を隠さない。Worker/分割は未実装。
5. unknown操作をGCしない要件は、GC自体がないため「消していない」が、容量制御の代替にはならない。
6. GUIでの容量表示・backup管理はNOT_RUN。

次の最小受入試験: Bの非破壊計測contractで、receipt/backup/assetの件数・bytes・増加率を表示し、unknown/rejected receiptを削除しないことを試験する。1,000/10,000件でmain同期処理のlatencyを記録し、上限を設計する。**計測だけではG7をPASSにしない**。上限/保守手段が入り、入力削除なし・unknown保持・復旧可能を試験して初めてPASS候補になる。

担当依存: B（契約・計測・上限制御）、Codex（統合判断）。このGateは現時点で未達。

### G8 独立検証と製品経路 — PARTIAL

必要条件: 同じ統合コミットで型/unit/build、障害・復旧試験、重要な画面操作→再openまでの証拠を揃える。既知P1を残して到達としない。

- 主要入口: `npm run check` / `npm run build` / `scripts/verify-quiet.mjs` / `.github/workflows/quiet-checks.yml`。

今回の証拠（基準HEAD `e00dc17`）:

- `npm run check`: PASS（exit 0）。
- `npm run build`: PASS（exit 0）。Vite 1745 modules、`dist/` 生成。既知のdynamic/static import警告と500kB超chunk警告は残る（R1から同様）。
- 限定Vitest: **24ファイル / 235件 PASS**（7+7+7+1+1+1ファイル）。内訳はG2/G3/G4/G5/G6の主要試験。全体suiteではない。
- ソース同一性: `a8bfd32..e00dc17` の差分はdocs 4ファイルのみ。`a8bfd32` のR1統合記録は89ファイル/929件PASS（[INTEGRATION-REVIEW.ja.md:45-53](../dsh-r1/INTEGRATION-REVIEW.ja.md#L45-L53)）。ただし**これは過去記録**で、今回Dは929件を再実行していない。
- CI定義は `.github/workflows/quiet-checks.yml` にあり、`npm run verify:quiet` を呼ぶ（[quiet-checks.yml:49](../../../.github/workflows/quiet-checks.yml#L49)）。hosted CIはNOT_RUN。
- GUI/E2EはNOT_RUN。既存E2E 197件の記録も過去のもので、今回の画面確認ではない。

残件:

1. 統合HEADでの全体suite（R1の89/929相当）をCodexが実行する。Dの235件を全体の代わりにしない。
2. GUIの重要操作→再open（G1/G2/G3/G4/G5/G6の画面導線）がNOT_RUN。`npm run test:e2e -- --list` も実行していない。
3. GitHub Actionsの実実行がNOT_RUN。workflow定義の存在は実行成功ではない。
4. build警告（dynamic/static import、500kB超chunk）は未解消。機能停止ではないが、G8の「きれいなbuild」を主張しない。
5. 429/929等の件数、0 failuresだけではPASSにしない。今回の235件も同様。

次の最小受入試験: Codexが統合コミットで `npm run verify:quiet` を実行し、型/全unit/buildの同一ログを保存する。利用者許可後に一時データで `npm run test:e2e:batch` を実行し、主要操作→再openの結果を記録する。CIは初回push/PRで確認する。

担当依存: Codex（全体suite・GUI・CI）、利用者（GUI実行許可）。

## 3. 提供中・意図的未対応・未実装の区別

| 区分 | 項目 | 根拠 |
| --- | --- | --- |
| 提供中 | 単一プロファイル/単一window、ローカルSQLite、検索、保存receipt、Page作成/複製receipt、crash recovery、full backup/restore、破損Page隔離、raw JSON救出 | G1–G6の各節 |
| 提供中（範囲限定） | backup/restoreはGUI導線あり。通常Pageのcreate/duplicate/move/trash/restoreを提供。record/登録DBは専用backend経路の一部があるがUIはunavailable | [main/index.ts:184-204](../../../src/main/index.ts#L184-L204)、[store.ts:1278-1321](../../../src/persistence/store.ts#L1278-L1321)、[LiveRecordDatabase.tsx:82](../../../src/renderer/LiveRecordDatabase.tsx#L82) |
| 実装済みだが未提供 | 順序修復API（preview/apply、backup必須、testあり）、sync checkpoint server/client（testのみ） | [page-order-repair.ts:693](../../../src/persistence/page-order-repair.ts#L693)、[page-order-repair.ts:861](../../../src/persistence/page-order-repair.ts#L861)、[sync-checkpoint.test.ts:19-22](../../../tests/sync-checkpoint.test.ts#L19-L22) |
| 意図的未対応 | record/登録DBのtrash/restore/duplicate/historyのUI提供、未知schemaの自動移行、物理停電保証、クラウド同期/共同編集 | I07、G6、G5、Level 4 |
| 未実装 | template/import初期本文の作成同一操作（G3）、未送信操作の同じIDでの明示再試行（G4）、receipt/backup/添付の容量制御（G7） | G3/G4/G7の残件 |

## 4. A/B/C統合後に更新する行

このworktreeにはA/B/Cの第2ラウンド成果がない。以下は**Codex統合後に再監査する行**であり、現時点のPASS根拠にしない。

| 行 | 現在 | 統合後に確認すること |
| --- | --- | --- |
| G3 template/import | PARTIAL | Aの作成operationに初期本文が含まれ、失敗時に空Pageが残らないか。checkpointに本文が入るか |
| G4 未送信retry | PARTIAL | Aの明示再試行が同じoperationIdを使い、1 Page/1 saveに収束するか |
| G5 中断試験 | PARTIAL | Cの子Node SIGKILLでmarker/partial/原本不変/再openが成立するか |
| G7 容量 | UNMET | Bの非破壊計測・保持契約・上限制御。計測だけならUNMETのまま |
| G2 修復導線 | PASS（通常操作） | Bの修復APIをGUI/IPCへ接続した場合、通常操作の不変条件を壊さないか |
| G6 GUI救出 | PASS（非GUI） | 壊れたPageのread-only表示・raw保存・健康Page編集をGUIで確認 |
| G8 全体 | PARTIAL | Codexの全体suite、GUI batch、CIの同一コミット証拠 |
| G1 offline | PARTIAL | ネットワーク無効の隔離GUIで起動〜書出しを確認 |

## 5. 実行記録

環境: macOS / Node `v24.20.0` / npm `11.19.0`。`node_modules` は既存symlink。Vite cacheは `output/vite-cache` に分離。GUIは起動していない。

```sh
FOLIO_VITE_CACHE_DIR="$PWD/output/vite-cache" npm run check
FOLIO_VITE_CACHE_DIR="$PWD/output/vite-cache" npx vitest run --maxWorkers=2 \
  tests/page-operation-receipts.test.ts tests/save-receipts.test.ts \
  tests/local-integrity-regressions.test.ts tests/corrupt-page-isolation.test.ts \
  tests/durability-attachment-backup.test.ts tests/crash-recovery.test.ts \
  tests/dsh-integration-regressions.test.ts
FOLIO_VITE_CACHE_DIR="$PWD/output/vite-cache" npx vitest run --maxWorkers=2 \
  tests/r8-backup-independent.test.ts tests/r8-backup-create.test.ts \
  tests/r8-backup-restore.test.ts tests/r8-backup-verify.test.ts \
  tests/pending-journal-file.test.ts tests/prepare-crash-recovery.test.ts \
  tests/recovery-checkpoint.test.ts
FOLIO_VITE_CACHE_DIR="$PWD/output/vite-cache" npx vitest run --maxWorkers=2 \
  tests/store.test.ts tests/move-record-isolation.test.ts \
  tests/page-order-repair.test.ts tests/record-lifecycle.test.ts \
  tests/workspace.test.ts tests/r7-search.test.ts \
  tests/store-raw-database-guard.test.ts
FOLIO_VITE_CACHE_DIR="$PWD/output/vite-cache" npx vitest run --maxWorkers=2 tests/store-atomic-load.test.ts
FOLIO_VITE_CACHE_DIR="$PWD/output/vite-cache" npx vitest run --maxWorkers=2 tests/record-page-schema-guard.test.ts
FOLIO_VITE_CACHE_DIR="$PWD/output/vite-cache" npx vitest run --maxWorkers=1 tests/record-scale.test.ts
FOLIO_VITE_CACHE_DIR="$PWD/output/vite-cache" npm run build
```

結果:

| 実行 | 結果 | ログ |
| --- | --- | --- |
| `npm run check` | PASS / exit 0 | 端末出力 |
| 限定Vitest 1回目（7ファイル） | 72件 PASS | `output/dispatch/d-logs/targeted-1.log` |
| 限定Vitest 2回目（7ファイル） | 55件 PASS | `output/dispatch/d-logs/targeted-2.log` |
| 限定Vitest 3回目（7ファイル） | 86件 PASS | `output/dispatch/d-logs/targeted-3.log` |
| 限定Vitest 4回目（1ファイル） | 15件 PASS | `output/dispatch/d-logs/targeted-4.log` |
| 限定Vitest 5回目（1ファイル） | 6件 PASS | `output/dispatch/d-logs/targeted-5.log` |
| 合成scale（1ファイル） | 1件 PASS / 6.3秒 | `output/dispatch/d-logs/record-scale.log` |
| `npm run build` | PASS / exit 0（既知警告あり） | `output/dispatch/d-logs/build.log` |
| 全体suite | **NOT_RUN**（Codex担当） | — |
| GUI / E2E / CI | **NOT_RUN** | — |

合計は24ファイル・235件。うちG2/G3/G4/G5/G6の主要試験を含むが、全体suiteの代替ではない。

## 6. 限界とNOT_RUN

- GUI / Electron / browser / OS clipboard / ネイティブダイアログ / スクリーンショット / osascript: **NOT_RUN**。
- 全体Vitest、E2E、`npm run verify:quiet`、hosted CI: **NOT_RUN**。
- 実データ、既存Desktopアプリ、他worktree、認証設定: 触っていない。
- 物理停電・OSクラッシュ・SIGKILL中のbackup: 未実施（Cの範囲）。
- ネットワーク遮断下のアプリ全体: 未実施（G1の残件）。
- 1,000/10,000件の値は合成SQLite+modelの単発値で、GUI latency/p95ではない。
- 外部リンクの `shell.openExternal` はユーザー操作でネットワークへ出る。データ依存ではない。
- この文書はDの独立監査であり、Level 3到達の最終認定ではない。Codexが統合HEADで再検証する。

## 7. 参照

- [LEVEL3-GATES.ja.md](LEVEL3-GATES.ja.md): 固定したG1–G8条件。
- [INTEGRATION-REVIEW.ja.md](../dsh-r1/INTEGRATION-REVIEW.ja.md): R1の受入・残件・929件の過去記録。
- 元監査 [REPORT.ja.md](../../../../Notion_rea/outputs/folio-technical-audit-20261104/REPORT.ja.md): Level 3定義、I01–I10、757件/E2E 197件の過去記録。source/archiveは最新実装ではない。
- [LEVEL3-RESIDUALS.json](LEVEL3-RESIDUALS.json): 本監査の機械可読な残件一覧。
