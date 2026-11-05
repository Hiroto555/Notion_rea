# 担当A HANDOFF — Page作成の初期本文の原子性と明示的な復旧再試行

2026-11-05 JST / ブランチ `codex/folio-l3-r2-operations-20261105`
基準: `e00dc172f413f547ee6f0a0beab6d7bfa6d757d3`
実装 commit: `7de2581e066faffdc5d5029b752eb996a8adb5dc`
最終HANDOFF: 本書（`docs/parallel/dsh-r2/HANDOFF-A.ja.md`）。本書を含むHEADは `git log -1` で確認。
作業メモ／生ログ: `output/dispatch/A-worklog.ja.md`、`A-targeted.log`、`A-check.log`、`A-build.log`（`output/` は gitignore 対象）

## 結論

- 通常 Page の `createPage` に任意の初期本文 `doc` を追加した。旧 command は `doc` 無しのまま有効で、fingerprint も従来どおり。
- Page JSON・検索用 `body`・receipt を同一 SQLite transaction で確定する。R1 の SAVEPOINT、ACK 照合、operation ID 同一性は維持した。
- template / import / `create(..., doc)` は初期本文を operation に含め、送信前 checkpoint にも本文を入れる。通常 Page の「作成後に doc を別 save」の2段階を廃止した。icon 等の別 metadata は原子的と扱っていない。
- checkpoint 保存後・commit 未送信の operation は、起動時に自動再送しない。復旧ダイアログの明示操作でのみ、まず同じ ID を resolve し、unknown のときだけ同じ `operationId/sessionId/seq/payload` で commit する。
- rejected は成功扱いにも黙った破棄にもせず、理由を表示して coordinator と checkpoint に保持する。既存の復旧コピー出口は維持し、page operation の初期本文をコピー本文にも使う。
- **GUI / Electron / browser / OS clipboard / ネイティブダイアログは NOT_RUN。** 非GUIの型検査・Node/Vitest・build のみ。
- main の rich-block 事前 backup への配線は所有外のため、下記に具体的差分を残す。**統合時に必須**。

## 実装した契約

### 1. 初期本文を immutable な createPage command に含める

- `src/shared/types.ts` の `pageOperationSchema` の `createPage` に任意 `doc` を追加。
  - `isDocument` で既存の document schema（対応 node/attrs、schemaVersion 1/2、30M 文字上限、rich block の version 整合）を検証する。
  - `doc` 省略時は従来と同じ command 形。旧 checkpoint / 旧 receipt / 旧クライアントの command はそのまま受理される。
- `src/shared/page-operation.ts`
  - `preparePageCreation(title, parentId?, doc?)` を追加。`doc` は `structuredClone` して command に固定する。
  - `validAppliedPage` は、`doc` 付き command の applied ACK について `page.doc` が command と完全一致することを要求する。旧 command は従来の title/parent 検査のみ。
  - `describePageOperation` を追加。復旧ダイアログ用に「ページ『…』の作成（初期本文あり）」「ページの複製（元ページ …）」を返す。本文そのものは埋め込まない。
- fingerprint は `canonicalOperation(operation)` 全体（doc を含む）。同じ operation ID で doc だけ変えた要求は DB を変更せず rejected になる。

### 2. Page 本文・body・receipt の同一 transaction 確定

- `src/persistence/store.ts` の `Store.create(parentId, kind, title, doc?)` に任意の初期本文を追加。
  - `kind !== "page"` に `doc` を渡した場合は、書き込み前に拒否する。
  - 既存の `write()` の1 INSERT が `pages.data`（Page JSON）と `pages.body`（title + `textOf(doc)`）を同時に書く。本文はこの INSERT に含まれる。
  - `doc` は `structuredClone` して保持し、呼び出し元の後続変更と切り離す。
- `src/persistence/page-operations.ts` の `commitPageOperation` は、`Store.create(..., command.doc)` を既存の `SAVEPOINT page_operation_create` 内で呼び、同じ外側 transaction で receipt を INSERT する。
  - Page INSERT 後の `RAISE(FAIL)` でも SAVEPOINT で Page/body を戻してから terminal な rejected receipt を残す。
  - receipt INSERT 失敗時は外側 transaction が Page/body ごと rollback する。receipt も残らない。
  - COMMIT 後 ACK 喪失は receipt から applied を解決できる。

### 3. App の create / template / import と checkpoint

- `src/renderer/App.tsx` の `create(parentId, kind, title, doc)` は、通常 Page のとき `pageCreation.create(parentId, title, doc)` を呼ぶ。
  - これまでの `create` 後の `update(p.id, {doc})` を通常 Page では廃止した。Page は最初から本文付き revision 0 で作られる。
  - `kind === "database"` の既存経路、`doc` を渡した場合の非 Page 経路は従来どおり。
  - template の `icon` 更新は別の `update` のまま。cover/width/icon まで原子的とは扱わない。
  - IME 中の `composition.current` guard、`creatingCount`、selection ticket、既存の未保存入力保護は変更していない。
- `PageOperationCoordinator.create` が `doc` を受け取り、`persist()`（App では recovery checkpoint の capture + flush）の前に pending operation に本文を含める。persist 失敗時は送信しない。
- import は従来どおり `versionDocument` で rich block の schemaVersion を付けてから create に渡す。

### 4. checkpoint 後の明示的な再試行

- 新規 `src/renderer/page-operation-recovery.ts` の `retryUnconfirmedPageOperations(snapshot, api)`。
  - 各 `pageOperations` をまず `page:resolve` で同じ ID のまま照合する。**この時点では書き込まない。**
  - applied は二重 commit しない。rejected は再送せず理由を集める。unknown のときだけ `page:commit` を同じ operation で送る。
  - commit が unknown の場合は入力を保持したまま例外にする。snapshot は変更しない。
  - `save/database/property/migration` の lane には触れない。
- `src/renderer/CrashRecoveryDialog.tsx` に「同じ操作で再試行」を追加。App は `resumeCrashRecovery(false, true)` からのみこれを呼ぶ。
- 通常の「入力を復元」は従来どおり `prepareCrashRecovery` の resolve だけで、commit を発生させない。
- 起動時の自動再送、新 operation ID の生成、fingerprint の変更はしていない。

### 5. rejected の保持と説明

- `PageOperationCoordinator` の entry state に `rejected` を追加。
  - rejected は pending から消さず保持する。`hasUnresolved()` は saving/unknown のみ、`hasRetained()` は rejected を含む全保持、`firstRejected()` / `discard()` を追加。
  - 新規 create は rejected だけならブロックしない（unknown/saving は従来どおりブロック）。
  - `resolveNext()` で rejected を確認しても成功に変えず、entry を保持する。
- App は rejected バナーに理由と「入力を別ページに保存」を出す。`recovery:copy` に同じ operation と本文を渡し、成功後に明示的に discard する。これは自動破棄ではない。
- 復旧ダイアログの件数に「ページの作成・複製」を追加し、先頭5件の操作内容と「拒否された操作は再送しない」ことを表示する。
- 起動時の `prepareCrashRecovery` は applied 以外を通さないため、rejected/unknown は従来どおりダイアログに残る。「別ページに復旧」では、他に入力元ページが無い場合に page operation の初期本文をコピー本文に使い、完全な snapshot を payload に残す。

## 変更ファイル

変更:
- `src/shared/types.ts`（pageOperationSchema の createPage に任意 doc）
- `src/shared/page-operation.ts`
- `src/persistence/store.ts`（Store.create の任意 doc と body 同時 INSERT）
- `src/persistence/page-operations.ts`
- `src/renderer/page-operation-coordinator.ts`
- `src/renderer/CrashRecoveryDialog.tsx`
- `src/renderer/App.tsx`

新規:
- `src/renderer/page-operation-recovery.ts`
- `tests/l3-page-initial-doc.test.ts`（11件）
- `tests/l3-page-recovery-retry.test.ts`（9件）

触っていない: `src/main/index.ts`、`src/persistence/database-operations.ts`、`src/persistence/record-repository.ts`、容量計測、backup 実装、他 worktree、既存実データ。外部依存の追加、node_modules 再インストール、git push/reset/clean/force はしていない。既存テストの skip / assertion 削除もしていない。

## 受入試験との対応

| 受入条件 | 試験 |
| --- | --- |
| initialDoc 付き作成成功と本文/index/receipt 一致 | `l3-page-initial-doc.test.ts` の「commits the initial document…」。`pages.body` と `search`、receipt の page.doc を確認 |
| 本文 write / receipt 失敗で Page が残らない | 同「rolls the Page…receipt cannot be stored」「…Page insert fails」「…search body write fails」 |
| ACK 喪失 / 再 open / 同一操作再送で本文付き Page が1つ | 同「keeps one Page with its body across a lost ACK…」 |
| checkpoint → 未送信中断 → 明示再試行 | `l3-page-recovery-retry.test.ts` の「retries a checkpointed unsent create…」 |
| 既に applied なら二重 commit しない | 同「does not commit a retained operation that already has an applied receipt」 |
| stale duplicate 拒否 | 同「keeps a rejected operation as retained input…」、既存 `page-operation-coordinator.test.ts` |
| unknown / rejected の入力保持 | 同「retains the exact operation…」「reports a rejected operation…」「keeps a rejected page operation query-only at startup」 |
| 旧 schema / legacy DB 経路 / IME guard を壊さない | 同「keeps an old command without a document valid…」、既存 `dsh-integration-regressions.test.ts` の legacy DB 複製、`page-operation-*`。IME はコード未変更だが GUI 未実行 |

追加で、rejected の再送が page lane に限定されること（「does not retry save, database, property or migration lanes」）、起動時 resolve が commit しないこと（「resolves a committed page operation at startup without writing」）も確認した。

## 検証（今回の実行）

環境: Node `v24.20.0`、既存 `node_modules`（symlink）、Vite cache は `output/vite-cache`。

| 検証 | 結果 | 証拠 |
| --- | --- | --- |
| 重点・関連 Vitest（`--maxWorkers=2`） | **11ファイル / 110件 PASS** | `output/dispatch/A-targeted.log` |
| うち新規 l3-page 2ファイル | **20件 PASS**（11 + 9） | 同上 |
| `npm run check`（tsc） | **PASS** | `output/dispatch/A-check.log` |
| `npm run build` | **PASS**。既存の dynamic/static import 警告と 500kB 超 chunk 警告のみ | `output/dispatch/A-build.log` |
| `git diff --check` | **PASS** | 最終確認 |
| 全体 suite | **NOT_RUN**（Codex が統合後に実行） | — |
| GUI / Electron / Playwright E2E / OS clipboard / ネイティブダイアログ | **NOT_RUN** | 指示どおり未実行 |

## 所有外の提案（main の rich-block 事前 backup 配線）— 必須

これまで template/import の本文は「create の後の `update`」で保存され、`main/index.ts` の `protectRichDocument` 対象に `"update"` が含まれていた。今回その本文を `page:commit` の createPage に移したため、rich block（callout/table 等）を含む import では、初回の「before-rich-blocks」backup が従来どおりには走らない。main は所有外なので、以下の差分を Codex 統合時に適用してほしい。

```diff
--- a/src/main/index.ts
+++ b/src/main/index.ts
@@ -169,7 +169,7 @@
         const req = requestSchema.parse(input);
         // Snapshot before the first W3 database mutation. The durable draft
         // journal must still work when a backup or database save fails.
-        if (["save:commit", "update", "record:pageUpdate", "database:commit", "recovery:copy"].includes(req.type))
+        if (["save:commit", "update", "record:pageUpdate", "database:commit", "recovery:copy", "page:commit"].includes(req.type))
           protectRichDocument(req);
```

`protectRichDocument(req)` は request 全体を `containsRichBlocks` で走査するため、`page:commit` の createPage に doc が入っていれば検出できる。duplicatePage の request には本文が無く、`page:resolve` は書き込みではないため対象外のままでよい。backup 作成失敗時は create を止める既存の fail-closed 挙動を維持する。

代替として、より限定的に次の形でもよい（挙動は同じ）。

```ts
if (req.type === "page:commit" && req.operation.command.kind === "createPage")
  protectRichDocument(req.operation.command.doc);
else if (["save:commit", "update", "record:pageUpdate", "database:commit", "recovery:copy"].includes(req.type))
  protectRichDocument(req);
```

この配線は main/Electron のため今回は実行・検証していない（NOT_RUN）。統合後に rich block を含む import の初回 backup を確認する必要がある。

## 残件・レビュー時の注意

1. **GUI は NOT_RUN。** 復旧ダイアログの新ボタン、rejected バナー、「入力を別ページに保存」、IME 中の create、template 選択の実画面は確認していない。Node のロジック試験と型検査だけが根拠。
2. **main の rich-block backup 配線は未適用。** 上記差分を統合するまで、初期本文の rich block について従来の backup 保護を満たしたとは言わない。
3. rejected は checkpoint に保持し続ける。同じ操作を繰り返し拒否させると `pageOperations` の上限（1000件）まで溜まり得る。自動破棄はしない。ユーザーが「入力を別ページに保存」で保全するか、明示 discard する経路だけを用意した。
4. 初期本文のサイズは既存の `isDocument`（JSON 30M 文字）と crash recovery 32MB の制約を受ける。新しい上限や圧縮は導入していない。大きな import は checkpoint 保存段階で送信前に止まる場合がある。
5. `icon` / `cover` / `width` は従来どおり別操作。作成と同時に原子的に確定するのは Page JSON・body・receipt・初期本文まで。
6. 通常 Page の初期本文は create 時に保存されるため、旧2段階の `update` が作っていた「本文変更の version」は作らない。create 自体が version を作らない既存挙動に合わせた。履歴要件がある場合は別途。
7. legacy DB / record / 登録 DB の lifecycle は変更していない。`duplicateEditorPage` の既存経路と `Store.create` の database/record guard は既存試験で確認済み。
8. 全体 suite、GitHub Actions、実データ移行、push/deploy、他 worktree への変更はしていない。統合後の全体 `verify:quiet` と GUI キューは Codex / 利用者の指示で行う。

## 引き継ぎ

Codex は実装 commit `7de2581` の差分、上記 main 差分、全体 suite、独立再現を確認してください。GUI 実行の許可がある場合は `docs/GUI-VALIDATION-QUEUE.ja.md` と AGENTS.md の手順で、専用の一時 `FOLIO_DATA_DIR` を使ってください。今回の成功だけで Level 3 到達とはしません。
