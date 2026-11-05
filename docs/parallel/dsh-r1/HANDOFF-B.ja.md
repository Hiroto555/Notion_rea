# 担当B 完了報告：既存の並び順を安全に修復

2026-11-04 / branch `codex/folio-dsh-r1-repair-20261104` / 基準 `b96422fc2eee354b7a8d77a9de6018394708b5e3`

## 結論

旧duplicateが残した同順位（同じ`position`）の通常Pageを、**読み取り専用preview → 明示的なapply**で修復できる自己完結サービスを追加しました。自動起動・CLI・IPC/GUI配線はありません。applyは変更前に既存の`createFullBackup`で完全バックアップを作成・検証し、同じraw stateであることを再確認したうえで、1トランザクション内のsavepointで位置が変わるPageだけを書き換えます。失敗時は全Pageをrollbackし、対象外のPage・record・登録DB・history・receipt・設定・添付は変更しません。

実装commit: `e0584ae`（このHANDOFFは次のローカルcommit）。作業ツリーの他のファイルは変更していません。

## 所有ファイル（新規のみ）

| ファイル | 行数 | SHA-256 |
| --- | --- | --- |
| `src/persistence/page-order-repair.ts` | 1006 | `741e71ca7118daa2a1b5361acc9cc0c998db2cd3991c959e8062437aae284a4b` |
| `src/shared/page-order-repair.ts` | 92 | `fb8787b792764d44aa1f0981ff581478c305e567abb09c3b9c7d7dd86f047258` |
| `tests/page-order-repair.test.ts` | 791 | `9819414322ab59c74b3c38a8d50bfef48243d7dad38e1caec4f187814b765177` |

`store.ts`、`shared/types.ts`、`src/main`、`src/renderer`、backup実装、既存テストは編集していません。

## 公開API（配線はCodexの後続関所）

```ts
previewPageOrderRepair(store: Store): PageOrderRepairPreview
applyPageOrderRepair(
  store: Store,
  plan: { sourceFingerprint: string },
  options?: { backupDirectory?: string },
): PageOrderRepairResult
```

- `preview`は`PageOrderRepairPreview`を返します。`groups[].targets[]`は修復後の決定的な順序で、`pageId`、`title`、`deleted`、`fromPosition`/`toPosition`、`fromRevision`/`toRevision`、`changed`を持ちます。同じ位置の並びは`(createdAt, pageId)`昇順で固定し、先頭だけが元の位置を維持します。
- `sourceFingerprint`は`PRAGMA user_version`、全`pages`行の`id/data/body`、`record_databases`行、`record_memberships`行のSHA-256です。callerはpreviewのこの値だけを保持してapplyします。applyは渡された位置を信用せず、現在のraw stateから同じpreviewを再計算します。
- `rejections[]`は対象idと拒否理由、`issues[]`はワークスペース全体の停止理由です。`canApply`は「修復グループが1件以上」かつ「issues/rejectionsが0件」のときだけtrueです。
- applyは全or無です。1件でも危険な同順位があれば、他の安全なグループも含めて適用しません（部分修復はしない）。理由は`issues`に返します。

## applyの順序と不変条件

1. transaction外でpreviewし、`sourceFingerprint`一致を確認。不一致は**書き込みもbackup作成もせず**拒否。
2. `createFullBackup(store.db, <workspace>, <workspace>/backups/page-order-repair-<時刻>-<UUID>)`で変更前の完全バックアップを作成し、既存の`verifyFullBackup`で検証済みのmanifest fingerprintを保持。作成失敗時はPage変更0。`options.backupDirectory`で親ディレクトリを差し替え可能（既存パスは再利用しない）。
3. `store.transaction`内で`assertRecordWriteSchema`、fingerprint再確認、backupの再検証（manifest fingerprint一致）を行う。
4. `SAVEPOINT`内で、位置が変わる通常Pageだけ`store.write({...page, position, revision: revision + 1, updatedAt: now})`を実行。親・所属・title・doc・database・icon・cover・favorite・width・createdAt・deletedAt・recoveredFromは変更しない。
5. 適用後に全体を再読込し、次を検証。1つでも崩れたらsavepointをROLLBACKして拒否する。
   - Page数不変。対象外Pageの`data`/`body`が**バイト一致**。
   - 対象Pageは`position`/`revision`/`updatedAt`以外のJSON値が不変で、`body`も不変。
   - `record_databases`、`record_memberships`、`versions`、`save_receipts`、`settings`、`assets`が完全一致。
   - 全非レコード兄弟の`position`が有限かつ厳密に一意。
6. commit後も同じ`sourceFingerprint`では再適用できません（staleとして拒否）。

## 拒否・保護の条件

- Pageの未知`schemaVersion`、JSON破損、親なし/循環、`position`の非有限値はワークスペース全体の`issues`として拒否。
- 同順位グループ内のPageが`kind: "database"`、登録済みDB（`record_databases`）、`database`を持つPage、未対応キー、再現不能なraw JSON、不正な`doc`、安全でない整数・非有限値を含む場合は、そのグループを理由付きで拒否。
- 位置の空きがない場合（隣接するdoubleしかない、2^53付近、`Number.MAX_VALUE`、範囲が表現不能）は拒否。安全な新位置は有限・JSONで完全往復・安全な整数（該当時）を満たす値だけです。
- trashed Pageの位置は予約し、同順位グループに含まれる場合は位置だけ修復します（`deletedAt`は不変、restore後に重複しない）。
- Record Pageは`Store.create/move/duplicate`と同じく兄弟順序の対象外です。`position`はレコード順であり、raw bytesとmembership行はfingerprintと保護テーブル検証で不変を確認します。不完全なrecord schemaは`assertRecordWriteSchema`で全体拒否します。
- 実データ、既存アプリ、既存プロセス、認証設定は使用・変更していません。試験はすべて`mkdtemp`の使い捨てSQLiteです。

## 検証結果

| 確認 | 結果 |
| --- | --- |
| `npm run check` | **PASS**（exit 0） |
| 新規`tests/page-order-repair.test.ts` | **20/20 PASS**。5回連続実行もPASS |
| 関連既存テスト（local-integrity / store / atomic-load / r8-backup-create / r8-backup-verify / r8-backup-independent / durability-attachment-backup） | **7ファイル・72/72 PASS** |
| `npm run build` | **PASS**（tsc + Vite + esbuild）。既存のdynamic/static import警告と500kB超chunk警告は残存 |
| 全体Vitest | 今回は未実行（Codex統合後に実行）。基準の83ファイル・850件は前回証拠であり、本報告の数値とは合算していません |
| GUI / Electron / ブラウザ / E2E / ネイティブダイアログ / OSクリップボード / スクリーンショット / osascript | **NOT_RUN**（実行していない） |
| 実データでの修復 | **未実施**（fixtureのみ） |
| 自動修復CLI・起動時修復 | 未実装（意図どおり対象外） |

証拠ログは`output/dispatch/B-final-verification.log`（`output/*`はgitignore対象）に保存しました。

## 試験が証明している受入条件

- 旧duplicate相当のtie fixtureで、preview前後の全Page raw bytesと保護テーブルが一致（無書込）。
- apply後に`create`（record storeの重複位置guardが有効な状態で事前拒否→修復後成功）、`move`、`trash`/`restore`が成功し、reopen後も一意順序を維持。
- 変更前バックアップが`verifyFullBackup`を通り、バックアップ内には修復前の同順位が残っている。
- 変更されたPageだけ`revision + 1`、title/doc/body不変。対象外Pageはバイト一致。
- stale preview、backup作成失敗（assets内シンボリックリンク）、後続SQL失敗（triggerによる強制ABORT）でPage変更0または完全rollback。
- 登録DBを含む同順位は理由付き拒否。record workspaceでrecord/owner/membership/history/receiptsが不変。
- unknown schema、malformed JSON、非有限位置、未知フィールド、隣接double、`Number.MAX_VALUE`、親なし、循環、record schema不完全を拒否。
- 同順位が複数・サブツリー内・trashed Pageを含む場合も、対象外Pageを再採番せず修復。

## 申し送り（Codex側で判断してほしい点）

1. **IPC/GUI配線は未実施**。previewの`groups`/`rejections`/`issues`をユーザーに表示し、明示確認後にpreviewの`sourceFingerprint`だけでapplyする形を想定しています。起動時・保存時・移行時に自動実行しないでください。
2. **全or無の粒度**。危険な同順位が1件あると安全なグループも適用しません。グループ単位の選択適用が必要ならAPI拡張が必要です。
3. **バックアップの保存先と保持期間**は未決定。既定は`<workspace>/backups`で、`WorkspaceBackupService`と同じ場所です。GCは行いません。
4. **DBファイル名の前提**。`createFullBackup`は`<workspace>/workspace.sqlite`を要求するため、applyは既存アプリのレイアウトでのみbackupを作れます。別名DBではbackup失敗として安全に拒否します。
5. **ページのraw JSONは正規形のみ対象**。`JSON.stringify(JSON.parse(raw)) === raw`と未知キーなしを要求します。過去の外部writerが整形JSONを書いた場合は理由付きで拒否します。
6. **v3（record tablesなし）では`Store.create`に重複位置guardがない**既存挙動は変更していません。修復自体はv3でも動作し、`move`/`restore`の安全性を回復します。
7. **修復操作のreceiptは作っていません**。既存`save_receipts`は保護対象として不変です。監査記録が必要なら別設計で追加してください。
8. **対象外のまま**: 長タイトル修復、GC、クラウド同期、実データ移行、Level評価の引き上げ。GUI確認は利用者の明示許可後に別途。

## 実行コマンド

```sh
npm run check
npx vitest run tests/page-order-repair.test.ts --maxWorkers=2
npx vitest run tests/local-integrity-regressions.test.ts tests/store.test.ts \
  tests/store-atomic-load.test.ts tests/r8-backup-create.test.ts \
  tests/r8-backup-verify.test.ts tests/r8-backup-independent.test.ts \
  tests/durability-attachment-backup.test.ts --maxWorkers=2
npm run build
```
