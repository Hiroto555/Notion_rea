# 担当A HANDOFF — 通常ページ create/duplicate の二重実行防止

2026-11-04 / ブランチ `codex/folio-dsh-r1-idempotency-20261104`
基準: `b96422fc2eee354b7a8d77a9de6018394708b5e3`（83 files / 850 tests の記録は前回証拠であり、下記の今回実行とは分けて扱う）
実装 commit: `38079d8`、`cf9415c`（この HANDOFF はその後ろの docs commit）
作業メモ／生ログ: `output/dispatch/A-WORKLOG.ja.md`、`A-test.log`、`A-check.log`、`A-build.log`（`output/` は gitignore 対象）

## 実装した契約

- IPC に `page:commit` / `page:resolve` を追加した。対象は通常 Page の `createPage` と `duplicatePage` だけ。
  - `createPage`: `{kind, parentId, title}`
  - `duplicatePage`: `{kind, pageId, revision}`
  - operation は `operationId, sessionId, seq, command` を持ち、`src/shared/types.ts` の `pageOperationSchema` で strict に検証する。
- 結果は `applied | rejected | unknown`。`src/shared/save-contract.ts` の `canonicalOperation` を共有して SHA-256 fingerprint を作る。同じ operationId + fingerprint は receipt の同じ結果を返し、同じ operationId で内容が違えば DB を変更せず `rejected`。
- `src/persistence/page-operations.ts` が Page 変更と `save_receipts` への INSERT を同一 `Store.transaction` で確定する。
  - 元 revision 不一致、元ページが database/record/deleted/corrupt、record 所有の子孫を含む、など書き込み前に判定できるものは terminal な `rejected` receipt を残す。
  - 子孫コピーの途中失敗など、書き込み開始後の例外は transaction 全体を rollback して例外を伝播する。**Page も receipt も残さない**ので、同じ operation での再試行は最初からやり直せる。
- `Store.duplicate` を `duplicateInTransaction` に分離した。呼び出し側が既に transaction を持つ場合は再利用し、直接 API は従来どおり自分で transaction を張る。`Store.create` は既に transaction 内 reuse に対応していたため、その挙動を維持している。
- renderer は `src/renderer/page-operation-coordinator.ts` が担当する。
  - ID 生成は明示的な新規操作時だけ。resolve は保持中の operation をそのまま送り、新しい ID を作らない。
  - 送信前に `persist()`（App では recovery checkpoint の capture + flush）を完了する。persist 失敗時は送信しない。
  - unknown は pending に保持して `page:resolve` で確認する。ACK の operationId/sessionId/seq/fingerprint/commandKind と applied Page の形を照合し、不一致は unknown に落とす。
  - rejected は terminal として pending から外す。
  - IPC schema を通らない操作（501文字超の title など）は journal に書く前に拒否し、解決不能な pending を残さない。
- `src/shared/crash-recovery.ts` に **任意** の `pageOperations` を追加した。空の snapshot は従来と同じ形なので既存 schema を壊さない。`hasCrashRecoveryInput` と重複 operation 検査に含めた。
  - `src/renderer/prepare-crash-recovery.ts` は起動時に保持 operation を resolve し、applied を確認してから `pageOperations` を空にする。unknown は従来の recovery dialog を維持する（未解決操作が reload/restart で消えない）。
- `src/renderer/App.tsx` は通常 Page の `create()` と `duplicate()` を coordinator 経由にした。unknown 時は既存の DB 作成と同じ位置に「作成結果を確認」バナーを出し、`beforeunload` の保留条件にも加えた。登録 DB の作成経路（`databaseCreation`）と record/database の lifecycle は変更していない。

## 変更ファイル

変更:
- `src/shared/types.ts`
- `src/shared/crash-recovery.ts`
- `src/persistence/store.ts`
- `src/renderer/prepare-crash-recovery.ts`
- `src/renderer/App.tsx`

新規:
- `src/shared/page-operation.ts`
- `src/persistence/page-operations.ts`
- `src/renderer/page-operation-coordinator.ts`
- `tests/page-operation-receipts.test.ts`
- `tests/page-operation-coordinator.test.ts`

触っていない: `src/persistence/database-operations.ts`、`src/persistence/record-repository.ts`、`src/main/index.ts`、他 worktree、既存実データ。新しい外部依存は追加していない。

## 検証（今回の実行）

| コマンド | 結果 |
| --- | --- |
| `npm test -- --maxWorkers=2` | **85ファイル / 865件 PASS**（30.03秒） |
| `npm run check` | **PASS** |
| `npm run build` | **PASS**（既存の dynamic/static import 警告、500kB 超 chunk 警告のみ） |
| Electron / GUI / Playwright / ネイティブダイアログ / OS clipboard | **NOT_RUN** |

基準の 83/850 に対して、新規は 2 ファイル / 15 件。既存テストの skip や assertion 削除はしていない。

新規試験の主な確認:
- 同じ operation の再送・Store 再 open で Page が 1 つ。
- COMMIT 後 ACK 喪失でも receipt から applied を解決できる。
- fingerprint 不一致拒否、duplicate 元 revision 不一致拒否。
- 子孫コピー途中失敗で Page と receipt の両方が rollback され、resolve は unknown。
- receipt INSERT 失敗で Page も rollback。
- coordinator が persist→send の順で動き、persist 失敗時は送信しない。
- timeout・ACK 不一致・unknown 保持・同じ operationId での resolve。
- crash recovery の `pageOperations` 検証、起動時 resolve、重複 operation 拒否。

## 残件・レビュー時の注意

- **GUI は未実行（NOT_RUN）**。バナー表示、キーボード `n`、IME 中の create 抑止、click からの duplicate は画面で確認していない。型検査と Node 単体試験だけが根拠。
- 登録済み DB / record の duplicate は既存の `RecordLifecycle` 経路のままで、今回の冪等化対象外。`PageOperation` は通常 Page だけを受理する。
- template/import は「create の後に doc を別 save」のまま。create と doc save の間で落ちた場合に空ページが残り得るのは既存挙動で、今回の変更で新たに生じるものではない。
- persist 済みで一度も送信されなかった operation は resolve が unknown のまま recovery dialog を維持する。既存の DB 作成と同じ扱いで、破棄・自動再送はしていない。
- 起動時 resolve が `rejected` を返した場合も recovery dialog を維持する（`prepareCrashRecovery` は applied 以外を通さない）。これは既存の DB 作成と同じ。復旧コピーで journal を空にすれば先へ進める。
- duplicate の書き込み開始後の失敗は `rejected` ではなく unknown（receipt なし）になる。terminal にできない失敗を誤って rejected にしないための判断。
- `pageOperations` は署名済み snapshot の任意 field。schema version の bump や既存 v3 DB の移行はしていない。
- `page:commit` は `save_receipts` を save と共用する。operationId が衝突した場合は fingerprint 不一致として拒否される。

## 引き継ぎ

Codex の統合時に全体 suite、GUI 実行タイミングがあれば `docs/GUI-VALIDATION-QUEUE.ja.md` と AGENTS.md の手順で確認してください。push、deploy、他 worktree への変更はしていません。
