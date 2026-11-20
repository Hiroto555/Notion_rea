# Folio 日常利用に向けた本体改善仕様書（Codex実装用・2026-11-19）

この文書は、ローカル単一所有者（Mac一人用・Lv3範囲）としてFolioを毎日使ったときに効いてくる本体側の弱点を、**既存の安全性契約と6,147件の単体テストを壊さずに順番に直すための実装指示書**である。作成時点では調査・設計のみ完了しており、本体コードの変更は行っていない。

---

## Codexへ最初に渡すプロンプト例

```text
docs/roadmap/20261119-CODEX-PRODUCT-IMPROVEMENT-SPEC.ja.md と AGENTS.md を読んでください。
GUI・Electronは起動せず（npm run verify:quiet の範囲）、仕様書の P1 から順番に 1 パケットずつ実装・単体テスト追加・検証を進めてください。
各パケットの「踏んではいけない罠」にあるスキーマ検証器と既存テストの前提を必ず守ってください。
```

---

## 0. 全パケット共通のガードレール（必読）

1. **GUI非起動の徹底（`AGENTS.md` / `docs/QUIET-TESTING.ja.md`）**
   - 通常検証は `npm run check`、対象ファイルの `npx vitest run <file>`、区切りごとの `npm run verify:quiet` のみを使う。
   - 利用者の明示許可があるまで `npm start` / `npm run dev` / `npm run test:e2e:batch` / Electron直接起動は行わない（GUI確認項目は `NOT_RUN` として記録する）。
2. **SQLiteの既存テーブル定義・列名を安易に変えない**
   - 以下の検査器がテーブル名・列名・型・`PRAGMA table_xinfo`・`user_version` を厳格に照合している：
     - `src/persistence/schema-startup.ts`（`verifySchemaSnapshot` / `validateV5WorkspaceSchema`）
     - `src/persistence/full-backup-verify.ts`（`inspectWorkspaceSnapshot` / `inventoryOf` / `logicalDigest`）
     - `src/persistence/storage-usage.ts`（`save_receipts` の `result_json` 集計を含む）
     - `src/persistence/record-version.ts`・`src/persistence/store.ts:910-955`（`assertRecordWriteSchema`）
     - `src/sync/workspace-checkpoint.ts`（`WORKSPACE_CONTENT_TABLES` と v5 トリガ）
   - したがって、**既存テーブルのスキーマ変更なしで解ける方法を最優先**にする。どうしてもテーブルや列を増やす場合は、マイグレーションと上記すべての検査器・バックアップ検証テスト（`tests/r8-backup-*.test.ts`、`tests/r5-schema-startup.test.ts`）を同時に更新すること。
3. **保存・復旧の安全性契約を緩めない**
   - 未送信・送信中・結果不明（`unknown`）の入力がある間は、`beforeunload`（`syncDecisionInputReady`）と `ensureSaved()` が必ず停止・待機すること。
   - 壊れたJSON（`documentError`）や競合（`revision` 不一致）を黙って上書きしないこと。
4. **ソース文字列を直接検査するテストの存在**
   - `tests/sync-panel-wiring.test.ts:212-213` は `src/renderer/App.tsx` のソース文字列に `<WorkspaceSyncIndicator` と `<SyncManagementButton` が含まれることを検査している。
   - `tests/quiet-runner.test.ts:405-425` は `.github/workflows/quiet-checks.yml` の `timeout-minutes: 15` 等を固定検査している。
5. **Mac試用候補（`rc06`）との関係**
   - `src/`・`tests/`・`scripts/` を編集した時点で、`docs/roadmap/mt12-refreeze-20261119` の固定候補 `rc06` からは進む。全パケット完了後に試用へ進む場合は、パッケージ再ビルドまたは再固定を行うこと。

---

## 推奨実行順とパケット一覧

| 順 | ID | 対象 | 効果 | 主な変更先 |
|---|---|---|---|---|
| 1 | **P1** | 保存デバウンス・変更履歴の間引き・`save_receipts` 肥大化防止 | 打鍵ごとのI/O解消、履歴消失の防止、SQLite無限肥大化の停止 | `App.tsx`, `edit-session-coordinator.ts`, `store.ts`, `workspace-startup.ts` |
| 2 | **P2** | バックリンク計算のメモ化＋検索の軽量化 | ページ増加時の入力カクつき・検索時のメインスレッド停止を解消 | `App.tsx`, `store.ts`, `search-query.ts` |
| 3 | **P3** | 新DB作成入口の統一＋新DB・レコードの基本操作接続 | 旧DB誤作成の解消、「新DBを消せない・動かせない・行を消せない」の解消 | `App.tsx`, `LiveRecordDatabase.tsx`, `ControlledRecordTable.tsx`, `main/index.ts`, `store.ts` |
| 4 | **P4** | ゴミ箱の完全削除＋画像ペースト/ドロップ添付＋Base64直埋め込み防止 | 不要データ整理、スクショ貼り付け体験の改善、JSON爆発防止 | `store.ts`, `main/index.ts`, `shared/types.ts`, `Editor.tsx`, `editor-schema.ts`, `App.tsx` |
| 5 | **P5** | ワークスペース一括書き出し（Markdown＋画像）＋編集表現の補強 | データロックイン解消、コードブロック等の日常体験向上 | `main/`, `persistence/`, `document-io/`, `editor/`, `database/` |
| 6 | **P6** | 未認定UI（共有・同期）の表示制御＋`ErrorBoundary`＋依存脆弱性対応 | 一人用UIの整理、全画面白画面化の防止、`zod` / `electron` 更新 | `StartupApp.tsx`, `App.tsx`, `package.json` |
| 7 | **P7** | リンク周りの3重欠陥解消（誤遷移防止・外部URL入力と解除・レコード内リンク） | リンク文字の編集を可能にし、Webリンク作成/解除とレコード内リンクを動作させる | `App.tsx`, `RecordPage.tsx`, `Editor.tsx` |
| 8 | **P8** | 新DBの列削除・並び替え、`⌘F` 前後移動、通常ページのタイトル導線・絵文字入力 | 不要列の整理、ページ内検索の実用化、`⌘N`→タイトル→`Enter`→本文の自然な執筆導線 | `property-operation.ts`, `property-operations.ts`, `PropertySchemaPanel.tsx`, `App.tsx` |

---

## P1：保存デバウンス・変更履歴の間引き・`save_receipts` 肥大化防止（最優先）

### 現状の問題（Why）
1. **打鍵ごとの即時全文保存：** `src/editor/Editor.tsx:333-336` の `onUpdate` が毎回 `e.getJSON()` を返し、`src/renderer/App.tsx:744-764`（通常ページ）と `App.tsx:876-883`（レコード）が**待ち時間0ms**で `recoveryBarrierRef`（復旧ファイルのfsync書き込み）＋`sendReliableSave`（SQLite `BEGIN IMMEDIATE`、`synchronous=FULL`）を走らせている。
2. **変更履歴（100件）が数分で埋まる：** `src/persistence/store.ts:737, 813, 873, 956-999` の `recordVersion` が保存1回ごとに `versions` へ全文をINSERTし、100件を超えた分を即座にDELETEする。100文字書くだけで履歴100件が直近数分の1文字差分で埋まり、少し前の版がすべて消える。
3. **`save_receipts` が無限に膨らむ：** `src/persistence/store.ts:841, 886-888` が `save:commit` のたびに **ページ全文JSON（`page.doc` 込み）を含む `SaveResult`** を `save_receipts` にINSERTし、削除処理がコードベースに一切ない。

### 実装方針（How）

#### 1-A. 入力デバウンス（ローカル捕捉は即時、IPC送信だけ遅延）
- **原則：** 画面表示とメモリ上の未保存保持（`edits.current.addObservedPage` / `sessions.current.edit`）は**今まで通り0ms即時**で行う。遅延させるのは「復旧チェックポイント書き込み＋`save:commit` 送信」のトリガだけにする。
- **通常ページ（`App.tsx:743-774`）：**
  - `pageId` ごとにデバウンスタイマー（既定 `saveDebounceMs = 500`、連続入力時の最大遅延 `maxWaitMs = 2500`）を持つ小さなスケジューラ関数（例：`src/renderer/save-scheduler.ts` として純粋クラスに切り出すと単体テストしやすい）を導入する。
  - `update()` 呼び出し時は `edits.current.addObservedPage` と `commit(...)` を即実行し、スケジューラに `schedule(id)` する。
  - タイマー発火時、または明示 `flushAll()` 呼び出し時に、既存の `checkpointRef.current()` → `enqueue(...)` を走らせる。
- **レコード編集（`EditSessionCoordinator`、`src/renderer/edit-session-coordinator.ts:104-142`）：**
  - `options` に `debounceMs?: number; maxWaitMs?: number`（既定 `0` にしておき、`App.tsx:227` で `{ beforeSend: ..., debounceMs: 500, maxWaitMs: 2500 }` を渡す！）を追加する。
  - `App.tsx:881` と `LiveRecordDatabase.tsx:94` は `sessions.scheduleFlush(id)`（デバウンスあり）を呼び、即時送信が必要な場面では `sessions.flushAll()` を呼ぶ。
- **強制フラッシュ（`flushAll`）を必ず入れる境界：**
  - `ensureSaved()`（`App.tsx:657`）：先頭で通常ページと `sessions` / `databases` の保留タイマーをすべて即時発火させてから `queue.current` と各 `running` Promise を `await` する。
  - ページ遷移・開閉：`select()`（`App.tsx:607`）、`openRecord()`（`App.tsx:822`）、`closeRecord()`（`App.tsx:853`）の切り替え前に現在のページのタイマーを即時フラッシュする（待たずに送信キューへ乗せるだけでよい）。
  - タイトル以外の単発ボタン操作（アイコン変更、お気に入り、カバー変更、ページ幅変更）は `immediate: true` でデバウンスせず即送信すると体感が良い。
  - `beforeunload`（`syncDecisionInputReady`、`App.tsx:1122, 1146`）：タイマー待機中でも `edits.current.size > 0` または `sessions.current.hasUnsaved()` が `true` なので、終了保留ガードはそのまま効く。加えて `beforeunload` 内で保留タイマーを即時フラッシュして保存を完了させやすくする。

#### 1-B. `versions`（変更履歴）の時間窓による間引き
- **仕組み（`src/persistence/store.ts:956` `recordVersion`）：**
  - `StoreStartupOptions`（`src/persistence/schema-startup.ts`）に `versionMinIntervalMs?: number`（**既定値 `0`**）を追加し、本番起動経路（`src/main/workspace-startup.ts` で `new Store(...)` する箇所）でのみ `versionMinIntervalMs: 120_000`（2分）〜 `300_000`（5分）を渡す。
  - `recordVersion(p: Page, options?: { force?: boolean })` で、`!options?.force && this.versionMinIntervalMs > 0` のとき：
    1. `SELECT createdAt FROM versions WHERE pageId=? ORDER BY id DESC LIMIT 1` を読む。
    2. **履歴が0件なら必ずINSERTする**（編集前の初期状態を確実に残すため）。
    3. 最新行があり、`now >= last.createdAt` かつ `now - last.createdAt < this.versionMinIntervalMs` なら、**既存行をUPDATEせず、新規INSERTをスキップする**。（UPDATEしてしまうと「編集開始前の状態」が上書きで消えてしまうため、スキップが正しい。）
  - `restoreVersion`（`store.ts:1487`、`record-repository.ts:393`、`legacy-database-restore.ts`）から呼ばれる保存では必ず `{ force: true }` にし、復元直前の状態を必ず履歴に残す。

#### 1-C. `save_receipts` の上限整理（スキーマ変更なし）
- **仕組み（`src/persistence/store.ts:886` ほか）：**
  - `StoreStartupOptions` に `maxRetainedReceipts?: number`（例：本番起動時 `200`、単体テスト既定は `undefined` または `200`）を設けるか、以下のルールで古い確定済みレシートを自動整理する。
  - `commitSave`（および `commitPageOperation` / `commitDatabaseOperation`）のトランザクション末尾で、`INSERT INTO save_receipts` の直後に、件数が保持上限（例：`200` 件）を超えていれば `rowid` の古い順に削除する：
    ```sql
    DELETE FROM save_receipts
    WHERE rowid IN (
      SELECT rowid FROM save_receipts
      ORDER BY rowid DESC
      LIMIT -1 OFFSET ?
    )
    ```
  - さらに同じトランザクション内で、**同一 `sessionId`・同一 `pageId` で `seq < operation.seq` の過去 `applied` レシート**（Rendererが前段ACKを受領済みと確定しているもの）の `result_json` から巨大な `page` / `record` フィールドだけを落として軽量JSON（`{ status: "applied", operationId, sessionId, seq, pageId, fingerprint }`）へ `UPDATE` すれば、長文ページを連続編集しても200件分の本文コピーすら残らない。

### 踏んではいけない罠
- **罠1（既存テストとの衝突）：** `tests/store.test.ts:91-105` や `tests/lv4-core-echo-offline.test.ts:186` は、1ミリ秒以内に `store.update()` を2回呼んで2件とも `versions` に残ることを検査している。だから `new Store(path)` の既定 `versionMinIntervalMs` は **`0` のまま**にし、本番の `workspace-startup.ts` と新規テストでのみ `versionMinIntervalMs > 0` を渡すこと。
- **罠2（`maxReceiptRows` テストとの衝突）：** `tests/dsh-r4-storage-integration.test.ts:405-421` や `tests/r5-startup-integration.test.ts:81` は、`maxReceiptRows: 1` や `2` を設定して上限拒否を検証している。幸い `WorkspaceGrowth.assertReceiptWritable`（`src/main/workspace-growth.ts:107`）は `store.handle` の**前**に走り、設定上限（1〜5件など）で止めるため、保持上限を `200` 件にしておけばそれらのテスト（1〜5件）には一切干渉しない。念のため `WorkspaceLimitSettings` で `maxReceiptRows` が明示設定されている場合は自動削除を行わないガードを入れるとさらに安全。
- **罠3（`storage-usage.ts` の集計互換）：** `src/persistence/storage-usage.ts:358-370` は `save_receipts.result_json` に対して `json_valid(result_json)` と `json_extract(result_json, '$.status')` を実行する。軽量化した `result_json` にも必ず正当なJSONと `status: "applied"` を残すこと。

### 検証・追加テスト
- `tests/save-scheduler.test.ts`（新規）：フェイクタイマーで500ms以内の10打鍵が1回の送信にまとまること、`maxWaitMs` で強制送信されること、`flushAll()` で即座に送信されること。
- `tests/version-coalescing.test.ts`（新規）：`versionMinIntervalMs: 120_000` で初回編集は必ず履歴に入り、10秒後の連続編集はスキップされ、3分後の編集と `restoreVersion` は必ず記録されること。
- `tests/save-receipts.test.ts`（追記）：同一セッションで `seq: 1 -> 2` と進んだとき、`seq: 2` の `resolveSave` は完全な `page` を返し、200回超の保存後も `save_receipts` 行数とDBファイルサイズが頭打ちになること。

---

## P2：バックリンク計算のメモ化＋検索の軽量化

### 現状の問題（Why）
1. **`App` 再描画ごとの全件クローン＋AST走査：** `src/renderer/App.tsx:1621-1624` がレンダー関数直下にあり、`setQuery`・`setPageDrop`（ドラッグ中毎フレーム）・メニュー開閉・文字入力のたびに `sessions.current.views()`（内部で全ページ `structuredClone`）と `queryBacklinks`（全ページのProseMirror木走査）が同期実行されている。
2. **検索1文字ごとのフル `load()`＋スキーマ検証：** `src/persistence/store.ts:1444-1450` の `case "search":` が毎回 `this.load()` を呼ぶため、**ゴミ箱を含む全ページの `JSON.parse` と `isDocument()`（`documentSchema.nodeFromJSON().check()`）とレコードN+1読み込み**が検索のたびにElectronメインスレッドをブロックする。しかも `pages` テーブルには書き込み時に更新済みの `body TEXT NOT NULL` 列（`store.ts:402`）がすでにあるのに使われていない。

### 実装方針（How）

#### 2-A. バックリンク計算の遅延・メモ化（`App.tsx:1621-1624`）
- バックリンクの表示先は2箇所しかない：
  1. 右インスペクタが開いているとき（`inspector === true`、`App.tsx:2765`）
  2. レコードページを開いているとき（`recordView !== null`、`App.tsx:2680`）
- **手順：**
  1. `inspector === false && recordView === null` のときは `queryBacklinks` を呼ばず空配列 `[]` にする（初期状態ではインスペクタは閉じているため、これだけで通常編集中のコストが0になる）。
  2. 開いているときも、各ページの `(id, revision, seq)` または参照が変化したページだけを対象にする逆引きインデックス（`Map<sourcePageId, Map<targetPageId, BacklinkGroup>>`）を `useRef` キャッシュで持ち、変更があった1ページ分だけ `queryBacklinks([changedPage], ...)` 相当で差分更新するか、最低限 `[pages, activeTargetId, sessionRevisionKey, inspector, Boolean(recordView)]` で `useMemo` する。

#### 2-B. SQLite検索の軽量化（`store.ts:1444-1450`）
- **第1段階（スキーマ変更ゼロで即効性大）：**
  - `store.ts` に検索専用の軽量読み出しメソッド `search(query: string)` を作る。
  - 空クエリ（`!query.trim()`）のときは、全文デコードは不要か、既存の `pages` 一覧のうち `deletedAt === null` だけ返せばよい（`SearchPanel.tsx` が表示に使うのは `id`, `title`, `icon`, `kind`, `searchMatch` のみか確認すること）。
  - キーワードがあるときは：
    1. まずSQLite側で `json_extract(data, '$.deletedAt') IS NULL` の行だけを対象にし、`isDocument(p.doc)` の重いProseMirrorフルチェックを走らせない軽量デコード（または既に `body` 列に入っている `pageSearchBody(page)` テキスト）を使う。
    2. さらに `record_memberships` がある場合も `RecordRepository.projection` をN+1で呼ぶのではなく、`SELECT page_id, values_json FROM record_memberships` を1クエリで一括取得する。
- **第2段階（必要なら・任意）：**
  - 数千〜数万ページ規模まで見据える場合は、メモリ内キャッシュ（`Store` インスタンス内に `Map<pageId, { revision: number; title: string; icon: string; kind: Page["kind"]; deletedAt: number | null; body: string; propertySources: PropertySource[] }>` を持ち、`write` / `patchPageMetadata` / `record_memberships` 更新時に該当IDだけ更新・無効化する）を置けば、**SQLiteスキーマや `user_version`・バックアップ検証器に一切触れずに** 2回目以降の検索を数ミリ秒（O(生きたページのプレーンテキスト走査のみ、JSON.parseゼロ・SQLクエリ最小）にできる。FTS5仮想テーブルをSQLiteファイル内に足すと `full-backup-verify.ts` や `workspace-checkpoint.ts` のテーブル検査に波及するため、**オンメモリ検索インデックス方式の方がFolioの厳格なDB検査と相性が圧倒的に良い**。

### 踏んではいけない罠
- **罠1（破損ページの隔離）：** `searchPages`（`src/persistence/search-query.ts:87`）は `page.documentError` があるページの本文を検索対象外にしつつ、タイトル一致なら結果に含める仕様になっている。オンメモリ索引や軽量読み出しでも、壊れたJSON行（`PageDataError`）で例外落ちせず既存の隔離挙動（`quarantineCorrupt: true` と同等）を保つこと。
- **罠2（日本語部分一致とスニペット）：** SQLite FTS5のtrigram等に変えると1〜2文字検索の挙動や `buildSnippet` の一致位置レンジ計算が変わり既存テスト（`tests/search-*.test.ts`）とずれる。既存の `searchPages()` 関数（`search-query.ts`）のランキング・スニペットロジック自体はそのまま使い、**そこへ渡す入力データの構築コスト（毎回フル `load()` + `nodeFromJSON().check()` + N+1クエリ）だけを削る**のが最も安全で確実。

### 検証・追加テスト
- 既存の検索・バックリンク関連テスト（`npx vitest run tests/search* tests/backlinks*`）が全件そのまま通ること。
- 500ページ＋200レコードの合成ワークスペースで `store.handle({ type: "search", query: "テスト" })` を連続10回呼んだときの処理時間を計測する単体テストを追加（目安：1回あたり数ms〜十数ms以内）。

---

## P3：新DB作成入口の統一＋新DB・レコードの基本操作接続

### 現状の問題（Why）
1. **作成入口によって旧DBが作られる：**
   - サイドバーの「新しいデータベース」（`App.tsx:1859`）は `setNewDatabaseOpen(true)` → `createRegisteredDatabase()` で **新DB（行がページ本文を持つ登録済みDB）** を作る。
   - ところが検索パレットの「データベース」（`App.tsx:2876-2880`）とテンプレート画面の「データベース」（`App.tsx:2952-2959`）は `create(null, "database", "新しいデータベース")` を直接呼ぶ。新規ワークスペースは `user_version = 3` で始まるため（`store.ts:45, 655-660`）、ここから作ると **行ページを持たない旧DB** が作られ、直後に「旧DBをページ形式へ移行」ボタンが出るちぐはぐな状態になっている。
2. **新DBとレコードの基本操作がUIで塞がれている（バックエンド実装はあるのに未接続）：**
   - **裏側には既にある実装：**
     - `src/persistence/record-lifecycle.ts` には `trashRecord` / `restoreRecord` / `duplicateRecord` / `trashDatabase` / `restoreDatabase` / `duplicateDatabase` が実装済みで、`store.ts:1388-1435` の `handle()` にも接続されている！
     - `src/persistence/record-repository.ts:393` と `src/persistence/legacy-database-restore.ts` には履歴復元も実装されており、`store.ts:1458-1484` に分岐がある。
   - **表側で塞いでいる箇所：**
     - `App.tsx:2060`（お気に入り）、`2089`（複製）、`2107`（変更履歴）、`2154`（ゴミ箱に移動）、`2766`（インスペクタの変更履歴）、`2992`（ゴミ箱からの復元）がすべて `recordDatabaseIdsRef.current.has(page.id)` で `disabled` になっている。
     - `main/index.ts:599-605` が `restoreVersion` を `store.handle` に届く前にエラーで弾いている。
     - `LiveRecordDatabase.tsx:81-83, 119-120` で `trashRecord` / `duplicateRecord` 等がすべて `unavailable` 固定になっており、さらにテーブル以外の3ビュー（ボード・カレンダー・ギャラリー）に `readOnly` が渡されている。
     - `store.ts:1128-1134` で登録済みDB（および登録済みDBを子孫に含む通常ページ）の `move` が拒否されている。

### 実装方針（How）

1. **作成入口の統一（最小変更で即解決）：**
   - `App.tsx:2876-2880`（検索パレット内）と `App.tsx:2952-2959`（テンプレートダイアログ内）の「データベース」ボタンを、`setDialog(null); setNewDatabaseOpen(true);` に統一する。（注意：既存E2Eテストでテンプレートやパレットから旧DBが作られることを前提にした古いspecがないか `grep` で事前確認すること。もし旧DB専用テストがそれに依存していれば、テスト側のfixture作成方法を確認する。）
2. **新DBのお気に入り・ゴミ箱・復元・複製の有効化：**
   - **お気に入り：** `store.ts:698-731` の `updatePageInTransaction` を確認する。登録済みDBは `cleanPatch.database === undefined`（つまり `{ favorite: true }` や `{ icon }` 等）なら `DatabaseSessionCoordinator.editPage`（`App.tsx:715-722`）経由で保存されるか、`database:commit` の `updateDatabase` パッチが `favorite` を受け取れるか確認し、通る経路に合わせて `App.tsx:2060` の `disabled` を外す。
   - **ゴミ箱移動・ゴミ箱からの復元・複製：** `store.ts:1400-1435` はすでに `trash` / `restore` / `duplicate` リクエストで登録済みDBを `RecordLifecycle` に振り分けている！
     - ただし **未保存セッションとの整合** が重要：登録済みDBをゴミ箱へ移す・複製する前には `await ensureSaved()` を通し、ゴミ箱移動後は `databases.current` と配下レコードの `sessions.current` から該当エントリをデタッチ（または `refresh()` 後に再アタッチ）する処理を入れてから、`App.tsx:2089, 2154, 2992` の `disabled` を解除する。
     - 注意：`RecordLifecycle.trashDatabase`（`record-lifecycle.ts:106`）は `assertNoChildren` で子ページ付きDBを弾く（作成時も子ページ追加不可なので通常は空）。
3. **新DB内のレコード（行）の削除・複製と、ボード/カレンダー/ギャラリーでの編集：**
   - `ControlledRecordTable.tsx` と `RecordPage.tsx` に行の「複製」「ゴミ箱へ移動」アクションを追加し、`workspace` / `api` の `record:trash`・`record:duplicate`（またはreceipt付きの `database:commit` 拡張）へ接続する。実行前に該当レコードの `sessions.flush(pageId)` を完了させ、削除後は `databases` の再読込（`workspace.readDatabase`）で投影を更新する。
   - `LiveRecordDatabase.tsx:119-120` の `<DatabasePresentation ... readOnly />` について：`callbacks` の `patchRecord` を `sessions.edit` + `sessions.scheduleFlush` に、`createRecord` を `onCreateRecord` に、`updateSettings` を `databases.editSettings` に繋げば、**ボードビューでのカード移動（ステータス変更）やギャラリー・カレンダーからの追加・編集がそのまま動く**！
   - また `LiveRecordDatabase.tsx:48-59` の「マウント時に全行を1件ずつ `for ... await workspace.readRecord` で直列取得する処理」は、行数が増えると遅い。バッチ取得IPC（`database:readRecords` で1回のSQLiteトランザクションから全行の本文・値をまとめて返す）にするか、テーブル表示中は値投影だけ使い、本文は抜粋分または開いた行だけアタッチする設計に改めると劇的に速くなる。
4. **登録済みDBのツリー移動（`store.ts:1128-1134`）：**
   - なぜ現在 `move` が登録済みDBを拒否しているか：`move` が `pages` の `parentId` / `position` を書き換える際、`DatabaseSessionCoordinator` が保持している `base.revision` が1進むため、Renderer側で `databases.current` の保持revisionも同期更新する必要があるから（通常ページ用の `App.tsx:1261-1265` と同じ追随処理を `databases.current` にも入れ、`store.ts:1120-1134` では「`recordIds`（行ページ）の直接移動・親指定だけを禁止し、`registeredDatabases` の移動（ただし別のDBやレコード配下へのネストは不可）は許可」にすれば、DBの並び替えとフォルダ整理ができるようになる）。

### 踏んではいけない罠
- **罠1：** `tests/move-record-isolation.test.ts` が「レコード（`recordIds`）や登録済みDBに対する `move` の境界」を細かくテストしている。DB移動を解禁する場合は必ず最初に `tests/move-record-isolation.test.ts` を読み、どの不変条件（「レコード自体はサイドバーの通常ページ階層へ移動できない」「レコードやDBの子には移動できない」等）を守るべきか確認してから変更すること。
- **罠2：** `main/index.ts:599-605` の `restoreVersion` 拒否を外す場合は、`RecordPage` / `LiveRecordDatabase` 側のメモリ内セッション（`sessions.current` / `databases.current`）が古い `base.revision` を握ったままにならないよう、`App.tsx:1309-1312` と同様にセッションの再アタッチを行ってから解禁すること（それまでは無理に外さず別ステップにしてもよい）。

---

## P4：ゴミ箱の完全削除＋画像ペースト/ドロップ添付＋Base64直埋め込み防止

### 現状の問題（Why）
1. **ゴミ箱から完全削除できない：** `App.tsx:2981-3010` のゴミ箱モーダルには「復元」ボタンしかなく、削除済みページが永久にSQLiteに残り続ける。
2. **画像の貼り付け・ドロップが添付にならず、Base64直埋め込みが許されている：**
   - `src/shared/editor-schema.ts:109` が `Image.configure({ allowBase64: true })` のため、ブラウザ等から画像付きHTMLを貼り付けると数MBの `data:image/...;base64,...` がページJSON本体に直接入る。
   - 一方でクリップボードの画像（スクリーンショットの `⌘V`）やFinderからの画像/ファイルドロップを `assets/` に保存して `folio-asset://` として挿入する処理が `Editor.tsx` にない。

### 実装方針（How）

#### 4-A. ゴミ箱の「完全削除」「ゴミ箱を空にする」
- **IPCとStoreメソッド追加：**
  - `Request`（`src/shared/types.ts`）に `{ type: "purgeTrash"; id?: string }`（`id` 指定ならその削除済みサブツリー／DBのみ、省略時はゴミ箱内の全削除済み項目）を追加し、`src/main/storage-write-policy.ts` の `REQUEST_STORAGE_ACTIONS` に `"purgeTrash": "maintenance"`（容量逼迫時でも不要データを消して空きを作れるように `"write"` ではなく `"maintenance"` にするのがポイント！）として登録する。
- **SQLiteの外部キー順序（厳守）：**
  - `PRAGMA foreign_keys=ON` が有効なため、`store.transaction` 内で以下の順で消すこと：
    1. 対象ID集合を確定し、**対象およびその子孫・配下レコードのすべてが `deletedAt !== null` であること**を検証する（1件でも生きたページが混ざっていたら即ロールバックして拒否）。
    2. `DELETE FROM versions WHERE pageId = ?`（`record_value_versions` は `ON DELETE CASCADE` で自動削除される）。
    3. `record_database_trash_members` / `record_database_trash_batches` テーブルが存在すれば該当行をDELETE。
    4. `record_memberships` / `record_databases` テーブルが存在すれば該当行をDELETE。
    5. **注意：** `legacy_record_map` は `store.ts:571` で過去ID再利用防止に使われているため残す（外部キー参照がないか事前確認すること）。また v5 昇格済みワークスペース（`src/sync/workspace-checkpoint.ts` の `registerWorkspaceWriteGuard`）では同期世代トリガが貼られているため、v5 ワークスペースでの `DELETE FROM pages` がトリガと整合するか必ず単体テストで確認すること！
    6. 最後に `DELETE FROM pages WHERE id = ?`。
  - **未参照アセットの扱い：** 他ページ（および履歴 `versions`）から参照されている可能性があり、また電源断時の安全性のため、`purgeTrash` のトランザクション内でいきなり `assets/` の実ファイルを `unlinkSync` するのは避け、既存の `OrphanMaintenance`（または別途の「未使用添付の整理」プレビュー→移動/削除）に任せる方がFolioの保全思想に合う。
- **UI（`App.tsx:2981-3010`）：**
  - 各行に「完全に削除」ボタン、モーダル上部に「ゴミ箱を空にする」ボタン（2段階確認つき：誤クリック即消失を防ぐためダイアログ内確認ステップを挟む）を追加する。

#### 4-B. 画像・ファイルのペースト／ドロップ添付と Base64 ガード
- **新規IPC `attachBytes` の追加：**
  - 既存の `attach`（`main/index.ts:654`）はネイティブのファイル選択ダイアログを開く専用になっている。
  - `Request` に `{ type: "attachBytes"; name: string; mime: string; dataBase64: string }`（または `Uint8Array` を受け取れる IPC 経路。Zodスキーマ検証を通すなら上限付き base64 文字列または `Buffer` 変換が既存 `folio:request` と整合しやすい。ただし20MBバイナリのbase64は約27MBなので `FILE_MAX_BYTES` 30MB以内に収まる！）を追加する。
  - `src/persistence/assets.ts` に `attachBuffer(db, assetsDir, { name, mime, bytes }, beforeWrite, options)` を切り出し、`attachFile` と共通化する（20MB上限検査、SHA-256計算、`writeNewFileDurably`、`INSERT INTO assets`、容量検査 `storage.admitAttachment(bytes.length)` をすべて通す）。
  - `storage-write-policy.ts` に `"attachBytes": "write"` を追加する。
- **Editor側のペースト／ドロップ処理（`Editor.tsx:914, 1194`）：**
  - `onPasteCapture` で `!event.clipboardData.types.includes(BLOCK_CLIPBOARD_TYPE)` かつ `event.clipboardData.files.length > 0` のとき（スクリーンショットの `⌘V` 等）、`event.preventDefault()` してファイルを `arrayBuffer()` で読み、`onAttachFile` コールバック経由で `attachBytes` を呼び、返ってきた `folio-asset://<uuid>` を `setImage`（画像以外ならリンク段落）で挿入する。
  - `onDropCapture` でもブロック移動（`application/x-folio-blocks`）でなく外部ファイル（`event.dataTransfer.files.length > 0`）のときは同様に `attachBytes` 経由で挿入する。
- **Base64画像の扱い（後方互換を壊さない方法）：**
  - **重要：** 既存ページや既存テストのfixtureに `data:image/...` がすでに含まれている場合、`editor-schema.ts:109` の `allowBase64: true` をいきなり `false` に変えると、**既存のBase64画像入りページが `isDocument()` 不正扱い（`documentError` で閲覧・編集停止！）になってしまう**！
  - したがってスキーマ側の `allowBase64: true` は既存データ互換のため残し、**入り口（HTMLペースト・インポート時）で `data:image/(png|jpeg|gif|webp);base64,...` を検出したら自動で `attachBytes` により `folio-asset://` へ変換する（または一定サイズ以上の `data:` URI貼り付けを拒否してファイル添付を案内する）** のが安全。

---

## P5：ワークスペース一括書き出し（Markdown＋画像）＋編集表現の補強

### 現状の問題（Why）
- `App.tsx:1403-1434` の書き出しは「いま開いている1ページ」のみで、Markdown内の画像URLも `folio-asset://<uuid>` のまま出力されるため、Obsidian・VS Code・GitHub・Typora等で開いても画像が表示されず、ノート数が増えるほどデータを外へ持ち出せなくなる。
- コードブロックに言語属性・シンタックスハイライトがなく、DB列型も5種類（`text`, `number`, `select`, `date`, `checkbox`）のみで複数選択（`multi_select`）や `url` がない。

### 実装方針（How）

#### 5-A. ワークスペース一括エクスポート（フォルダ書き出し：Markdown＋`assets/`）
- `WorkspaceTools` または「バックアップと復元」の隣に「Markdown一括書き出し」を追加する。
- Mainプロセス側で保存先親フォルダを `dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] })` で選び、`assertExternalOutput(dataDir, destDir)`（ワークスペース自身の内部への書き出し拒否）を通したうえで新規サブフォルダ `folio-export-YYYYMMDD-HHMMSS/` を作成する。
- ページ階層（`parentId`）に合わせてフォルダまたはファイル名を安全なスラッグ（重複時は連番付与）で出力し、本文中の `folio-asset://<id>` を相対パス `./assets/<id>.<ext>` に書き換えたうえで、参照されている添付ファイル実体を書き出し先の `assets/` にコピーする。
- 登録済みDB・旧DBについては、同フォルダに `<DB名>.csv`（またはMarkdown表）＋各レコードページの `.md` を出力すると実用性が非常に高い。
- 読み取り専用操作なので `storage-write-policy.ts` では `"read"` 分類にし、容量上限到達時の救出手段としても使えるようにする。

#### 5-B. コードブロック・DBプロパティ（段階的追加）
- **コードブロック：** 新規パッケージを増やす場合は7日以上前に公開された安定版（例：`@tiptap/extension-code-block-lowlight` + `lowlight`）を使うが、**スキーマ属性（`language: { default: null }`）を増やすと `src/shared/validation.ts:94-120` の `attributes()` 検査を通るか確認が必須**（`language` は `string | null` なので `validation.ts:111` の `v !== null && typeof v !== "string"` 分岐でそのまま通るが、既存文書との互換テストを必ず書く）。
- **DBプロパティ型追加（任意・別PR推奨）：** 列型を増やすと `src/database/model.ts`、`strict-database.ts`、`store.ts:854-859`、`database-operations.ts:106-115`、`sync/workspace-checkpoint.ts` まで影響範囲が広いため、P1〜P5-Aとは明確に別PRに分離すること。

---

## P6：一人用UIの整理＋`ErrorBoundary`＋依存パッケージ更新

### 現状の問題（Why）
1. 左サイドバー最上部に未認定の「共有ワークスペース」ボタン（`App.tsx:1848`）、トップバーに同期インジケータと同期管理ボタン（`App.tsx:2052-2053`）が常時露出している。
2. `StartupApp.tsx` / `App.tsx` にReactの `ErrorBoundary` がなく、描画中の例外1つで画面全体が白画面になり未保存入力の退避UIにすら触れなくなる。
3. `npm audit` で `zod`（high: 巨大コレクション検証時のメモリ消費）や開発依存の報告があり、`electron` も `45.0.0` 固定（`45.4.1` あり）。

### 実装方針（How）
1. **実験機能（同期・共有）の表示制御：**
   - 既定のローカル一人用起動ではサイドバー最上部の「共有ワークスペース」や同期ボタンを非表示（または `WorkspaceTools` 内の「実験的な同期・共有を表示」トグル／環境変数 `FOLIO_EXPERIMENTAL_SHARED_UI=1` や既存の保存済み同期設定があるときのみ表示）にする。
   - **罠の回避：** `tests/sync-panel-wiring.test.ts:212-213` が `App.tsx` 内の `<WorkspaceSyncIndicator` と `<SyncManagementButton` の文字列存在を検査しているため、JSXタグ自体は `App.tsx` に残したまま表示条件フラグで囲む（かつ `FOLIO_SYNC_ENABLED === "1"` または保存済み接続が `enabled` / `held` のときは自動表示する）と、既存の同期テストと両立できる。
2. **React `ErrorBoundary` の導入：**
   - クラスコンポーネント `ErrorBoundary` を `src/renderer/ErrorBoundary.tsx` に作成し、少なくとも以下の2段階を囲む：
     - 外側：`StartupApp.tsx` 全体（万一のクラッシュ時にも `window.folio.request({ type: "backup" })` で診断用原本コピーを保存できるフォールバック画面を出す）。
     - 内側：`App.tsx` のメインペイン（`<Editor />` / `<LiveRecordDatabase />` / `<Database />` / `<RecordPage />`）単位で囲み、特定ページや特定DBビューの描画バグが起きてもサイドバーでの別ページ移動や書き出し・バックアップ操作が生き残るようにする。
3. **依存パッケージ更新（独立した1PRで行うこと）：**
   - `electron` のパッチ更新（`45.0.0` → `45.4.x`、公開から7日以上経過した版を選ぶ）は、`node:sqlite` の内蔵バージョンやABIが変わる可能性があるため、必ず単独ブランチで `npm run verify:quiet` を通す（特に `F02` 文書等で SQLite バージョン前提のテストがないか確認）。
   - `zod` 3 → 4 は破壊的変更があるため、`src/shared/types.ts` ほか全22箇所の `zod` 利用箇所のテストを通せる単独PRとして切り出す（あるいは現行 `zod` 3系で配列・文字列長の上限 `.max()` が全スキーマに付いているか監査して塞ぐだけでも実害は防げる）。

---

## P7：リンク周りの3重欠陥の解消（誤遷移防止・外部URL入力と解除・レコード内リンク）

### 現状の問題（Why）
1. **リンク文字を編集しようとクリックすると飛ばされる：** `App.tsx` の `.document-scroll` の `onClick` が修飾キー判定なしで全 `<a>` クリックを横取りし、即座に `select(id)` または `openExternal` を呼ぶため、リンク文字列の中にカーソルを置いて誤字を直すことができない。
2. **外部URL（`https://...`）の入力UIもリンク解除（Unlink）UIもない：** `openLink` / `applyPageLink`（`dialog === "link"`）がワークスペース内ページ検索専用になっており、任意のWeb URLを入力・編集する欄も、既存リンクを外すボタンもない。
3. **DBレコード画面（`RecordPage`）の本文内ではリンクが完全に無反応：** `RecordPage` は `.document-scroll` の外側（兄弟要素）に描画されており、リンククリックのハンドラ自体が付いていない。

### 実装方針（How）

#### 7-A. 編集中リンクの誤遷移防止＋リンク操作導線
- 編集可能なエディタ領域（`.folio-editor[contenteditable="true"]` 内）にある `folio-page://` および `https?://` リンクについては：
  - **`e.metaKey || e.ctrlKey`（⌘クリック / Ctrlクリック）のときだけ即時遷移・外部ブラウザ起動**を行う。
  - 修飾キーなしの通常クリックでは `e.preventDefault()`（ブラウザ既定ナビゲーション抑止）だけ行い、ProseMirrorの通常カーソル配置をそのまま通す。
  - マウス操作だけでも迷わないよう、カーソルが `link` マーク内にあるときは小さなリンク操作バー（または既存のリンクダイアログを開いたとき）に **「リンク先を開く」「リンクを変更」「リンクを解除」** ボタンを出す。
  - なお添付ファイルリンク（`folio-asset://`、`📎 filename`）はダウンロード目的でクリックされることが多いため、素クリックでもダウンロードするか、リンクバーの「保存」と両立させる（既存E2Eテストで `<a>` を素クリックしている箇所がないか `tests/e2e/` を事前確認すること）。

#### 7-B. 外部URL（`https://...` / `http://...`）の作成・編集とリンク解除
- `dialog === "link"`（ページリンクモーダル）を拡張する：
  - 入力欄に `https://...` または `http://...` 形式の文字列が入力された場合（`new URL(trimmed)` が成功し、`protocol === "https:" || protocol === "http:"` であることを検証）、検索結果の先頭に **「Webリンクを設定：`https://...`」** 候補を表示し、`Enter` またはクリックで `e.chain().focus().setLink({ href: normalizedUrl }).run()`（選択範囲が空ならURL文字列テキスト＋`link` マークを挿入）を実行する。
  - `openLink()` 実行時点で選択範囲またはカーソル位置に既存の `link` マークがある場合は、現在のリンク先（ページ名またはURL）と **「リンクを解除」** ボタン（`e.chain().focus().extendMarkRange("link").unsetLink().run()`）および **「リンク先を開く」** ボタンをモーダル上部に表示する。

#### 7-C. `RecordPage` 本文へのリンクハンドラ共通化
- `.document-scroll` 内のリンク処理ロジックを共通関数 `handleDocumentLinkClick(e: React.MouseEvent<HTMLElement>)` として切り出し、`RecordPage` に渡す `body` ラッパ要素の `onClick` にも同じハンドラを取り付ける。
- レコード本文内の `folio-page://` リンクを開いたときは `select(targetId)`（対象が別レコードなら `openRecord`）が呼ばれ、編集中のレコード入力は `sessions.current` に保持されたまま安全に遷移できる。

### 踏んではいけない罠
- **罠1（リンク属性のスキーマ検証）：** `src/shared/validation.ts:94-120` は `link` マークの属性型と `javascript:` / `vbscript:` スキーム拒否を厳格に検査しており、`tests/mac-trial-editor-cases.test.ts` 等もTiptap標準の `setLink({ href })` が付与する既定属性（`target`, `rel` 等）を前提にしている。独自属性を足さず、既存の `setLink({ href })` / `unsetLink()` コマンドをそのまま使うこと。

---

## P8：新DBの列削除・並び替え、ページ内検索（`⌘F`）の改善、執筆フォーカス導線

### 現状の問題（Why）
1. **新DBで列（プロパティ）を削除・並び替えできない：** `src/shared/property-operation.ts` と `src/persistence/property-operations.ts`、`src/renderer/PropertySchemaPanel.tsx` には `add` / `rename` / `changeType` しかなく、新規DB作成時に自動挿入される3列（「メモ・見積・完了」）を含め、不要な列を消すことも順番を変えることもできない。
2. **ページ内検索（`⌘F`）が「最初の1件」にしか飛べず、レコード画面で動かない：** `App.tsx` の `.page-find` は常に `findText(...)[0]` しか選択せず、次へ／前へ移動も `Enter` 送りのキー操作もない。さらに `RecordPage` 表示中は裏の `inert` な親DBページ側で開くためレコード本文を検索できない。
3. **通常ページの `⌘N` 後にすぐ書き始められず、タイトル `Enter` で本文へ移れない：** `RecordPage.tsx:118-122, 167-171` には自動フォーカスとタイトル `Enter` → 本文移動があるのに、通常ページの `.page-title` には両方ない。
4. **ページアイコンが固定12種のみ：** `App.tsx` の固定配列以外の絵文字を設定できない。

### 実装方針（How）

#### 8-A. 新DBのプロパティ「削除（`remove`）」と「並び替え（`reorder`）」
- **スキーマ拡張（`src/shared/property-operation.ts`）：**
  - `propertyChangeSchema` の discriminated union に以下の2種を追加する：
    - `z.object({ kind: z.literal("remove"), propertyId: id }).strict()`
    - `z.object({ kind: z.literal("reorder"), propertyIds: z.array(id).max(1000) }).strict()`
- **プラン・適用処理（`src/persistence/property-operations.ts`）：**
  - **`remove`（列削除）：**
    - 対象列が `settings.properties` に存在することを確認する。
    - `viewImpacts` と同様に、いずれかのビューの `filter` / `sorts` / `groupBy`（およびカレンダー・ボードの暗黙グループ列）がその `propertyId` を参照している場合は、プレビューの `issues` に出して誤破壊を防ぐ（またはプレビューに明示したうえで該当条件を同時除去する）。
    - 値の消失を伴う構造変更なので `requiresBackup: true` にし、`changeType` と同じく事前 `verifiedBackup` を作成してから、全所属レコード（ゴミ箱内を含む）の `values_json` から該当キーを除去して `recordVersion(page, { force: true })` 付きで更新し、`settings.properties` から対象列を除く。
  - **`reorder`（列の並び替え）：**
    - `change.propertyIds` が現在の `settings.properties.map(p => p.id)` と集合として完全一致（長さ一致・重複なし・過不足なし）することを検証する。
    - レコード値の変更はないため `requiresBackup: false` とし、`settings.properties` を指定順に並べ替えて `state.page` の `revision` を1進める。
- **UI（`src/renderer/PropertySchemaPanel.tsx`）：**
  - 各列の行に「上へ」「下へ」「削除」ボタンを追加し、既存のプレビュー →「この変更を適用」の安全な2段階フローにそのまま乗せる。

#### 8-B. ページ内検索（`⌘F`）の前後移動・Enter対応・レコード画面対応
- **対象エディタと本文の統一：**
  - `recordView && openedRecord` が開いているときは、検索件数計算の本文を `openedRecord.page.doc` にし、検索バー自体も `RecordPage` 上（または共通の上部オーバーレイ）で操作できるようにする。
- **前後ナビゲーション：**
  - `findIndex` state を追加し、`pageFind` 変更時は `0` にリセットする。
  - `matches = currentEditor() && pageFind ? findText(currentEditor()!.state.doc, pageFind) : []` を使い、検索 `<input>` の `onKeyDown`（`!composing` 時）で `Enter` → 次の一致（`(findIndex + 1) % matches.length`）、`Shift+Enter` → 前の一致へ移動して `setTextSelection(match)` + スクロールを行う（「前へ」「次へ」「×」ボタンも併設）。
- **踏んではいけない罠：**
  - `tests/e2e/gate-a.spec.ts:407` が `await expect(window.locator(".page-find")).toContainText("1 件")` を検査している。したがって一致件数の表示は、0件なら `"0 件"`、一致ありなら `"1 / 1 件"` や `"2 / 5 件"` のように、**末尾に必ず `"<総件数> 件"` の部分文字列が残る形式**にすること！（`"1/1"` のように `"件"` を消すとE2Eテストが落ちる。）

#### 8-C. 通常ページの執筆フォーカス導線と任意絵文字アイコン
- **タイトル欄からの本文移動：**
  - 通常ページの `<input className="page-title">` に `onKeyDown` を追加し、`!composing(e.nativeEvent)` かつ `(e.key === "Enter" || e.key === "ArrowDown")` のときに `e.preventDefault(); currentEditor()?.commands.focus("start");` を呼ぶ。
- **新規ページ作成直後の自動フォーカス：**
  - 単なる `select()` ページ切り替えで毎回フォーカスを奪うとサイドバーのキーボード操作を邪魔するため、**新規ページ作成（`create()` で `kind === "page"` が完了して選択された直後）に限り** `pendingTitleFocusIdRef.current = created.id` をセットし、対象ページの `.page-title` が描画されたフレームで `.focus()`（初期タイトル `"無題"` なら `.select()`）する。
- **ページアイコンの任意絵文字入力（軽量改善）：**
  - `iconMenu` ピッカー内に短いテキスト入力欄を1つ足し、入力された先頭1書記素（`new Intl.Segmenter("ja", { granularity: "grapheme" })` で1書記素に切り出し、かつ `store.ts` のスキーマ上限 `icon.length <= 16` を満たすこと）を `update(page.id, { icon })` で設定できるようにすれば、DBスキーマ変更ゼロで任意の絵文字が使える。
- **補足（macOSのウィンドウ閉鎖挙動について）：**
  - `src/main/index.ts` の `app.on("window-all-closed", () => app.quit())` をmacOS標準のDock常駐に変える場合は、`owned-shutdown` や `mac-trial` 系の終了監視テストがウィンドウ閉鎖＝プロセス終了を前提にしていないか事前確認が必須なため、無理に変更せず別検討とすること。

---

## 各パケット完了時の共通チェックリスト

1. `npm run check` がエラー0件で通ること。
2. 追加・変更した単体テストを `npx vitest run <対象テスト>` で実行し、パスすること（一時ディレクトリを作るテストは必ず `os.tmpdir()` ＋ `onTestFinished` で削除し、`output/` にゴミを残さないこと）。
3. 区切りごとに `npm run verify:quiet`（型チェック → 全単体テスト → 本番ビルド）が全3ステージ `PASS` すること。
4. `git diff --check` と `git status` で意図しないファイル変更や未削除の一時ファイルがないこと。
