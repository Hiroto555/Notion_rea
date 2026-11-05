# Folio C — `database:read` を対象DBだけのSQLite snapshotへ

2026-11-04 / branch `codex/folio-dsh-r1-dbread-20261104`
作業場所: `<workspace-root>/Folio-dsh-r1-dbread`
開始点: `b96422f`（83ファイル・850件PASSは基準側の記録。下記の件数はこの担当の実行結果）

GUI・Electron・GUIブラウザ・ネイティブダイアログ・OSクリップボード: **NOT_RUN**（今回一切起動していない。`test:e2e` 系も未実行）

## 変更ファイル

| ファイル | 変更 |
| --- | --- |
| `src/persistence/database-operations.ts` | `readDatabaseSnapshot` を新モジュールへ委譲。公開シグネチャと `DatabaseReadSnapshot` の形は不変 |
| `src/persistence/database-read-snapshot.ts`（新規） | 対象DBのowner/settings/recordsだけを1つの読み取りsnapshotで返す実装 |
| `src/persistence/record-repository.ts` | read専用 `projectionsForDatabase` とmembership行→projection変換を追加。write経路は不変 |
| `tests/database-read-snapshot.test.ts`（新規） | 21件（parity、別接続interleaving、caller transaction、拒否、生バイト不変、10k decode/SQL規模） |
| `docs/parallel/dsh-r1/HANDOFF-C.ja.md`（本ファイル） | 引き継ぎ |

`store.ts` / `shared/types.ts` / `src/main` / `src/renderer` / schema / migration / 既存write command / global `Store.load` / `search` は変更していない。

## 実装内容

旧 `readDatabaseSnapshot` は `Store.load()` を呼び、全Pageのdecode・全membershipからの全record projection・workspace settingsの読み取りを行ってから対象DBをfilterしていた。新実装は1つのread transaction内で次だけを読む。

1. owner Page 1件を `store.get`（`decodeRow` のstrict decodeと原本保護）
2. record schema（`record_memberships` と `record_databases`）が両方存在し、ownerが `record_databases` に登録済みであること
3. `SELECT page_id,database_page_id,values_json FROM record_memberships WHERE database_page_id=? ORDER BY position,page_id`
4. 各record Pageを `store.get`。membershipの `values_json` を既存の `parseValues` で検証

無関係なPage・DB・recordはdecodeもSQL読取もしない。10,003 Page（対象DB 3 Page + 無関係10,000 Page、うち別DBのrecord 999件）の合成fixtureで、decode 3件・`pages` へのSELECT 3件・membership SELECT 1件・索引 `record_memberships_database` の使用を確認した。同じfixtureの `Store.load()` は参考値で 57.3ms、新経路は 0.28ms（同一プロセス・暖機後。SLAではなくUI/IPC越しの体感も未計測）。

### 契約の維持

- 返り値は不変。full loadのpage/settings/recordsとdeep equal、record順は `position,page_id`、trashed recordも `deletedAt` 付きで同順に含む（parity試験）。
- ownerの拒否条件は旧実装と同じ: `kind==="database"`、`database` 非null、旧 `rows` なし、未trash、`documentError` なし、登録済み、record schema存在。v3の未登録DBも同じ経路で拒否。
- 対象owner/recordが壊れている場合は部分collectionを返さずthrowする。対象recordが不正JSON・未知schema・ID不一致・values不正のいずれでもcollection全体を拒否する。
- 無関係なPage/DB/recordの破損（不正JSON、未知schema）は対象DBの読み取りを妨げない。
- 読み取り専用。BEGIN/COMMIT以外の書込みはせず、対象外raw bytes・行数・`data`長の不変を試験で確認した。
- caller-owned transaction内ではcommitもrollbackもしない。呼び出し元の未commit書込みが見え、読み取り失敗後もtransactionは維持される（`exec` 未呼び出しを確認）。

### transaction方式とtrade-off

`Store.transaction`（BEGIN IMMEDIATE）は使っていない。読み取りで短いwrite lockを取ると、別接続の書込みと競合して `database:read` がbusyになり得るため。代わりに `Store.load` と同じ「`db.isTransaction` のcaller-owned判定 + deferred `BEGIN`」を使い、WALのread snapshotでowner/settings/recordsを一致させる。別 `Store`（別SQLite接続）が読み取り中にowner title・settings・record title/values・新規recordをcommitするinterleaving試験で、返るsnapshotが読み取り開始時点のまま一貫し、次の `database:read` で初めて新stateが見えることを確認した。write lockを取らないため、この経路によるwriterの待たせはない。

BEGIN/COMMIT/ROLLBACKが失敗した場合は成功扱いにせず、`store.close()` で接続を閉じて `AggregateError` を投げる。`Store` のprivate `unusable` フラグは担当外の `store.ts` から設定できないため、closeをfail-closedの恒久シグナルにした。以後の `database:read` は "SQLite connection is unusable" で拒否する（他のStore操作は閉じた接続のエラーになる）。旧 `Store.load` のpoisonは `unusable` メッセージだったため、この差はCodexレビューの対象。

### レビュー観点・残件

- `store.ts` に「read snapshot開始＋失敗時poison」の公開APIを置けば、今回のcloseによるfail-closedをStore本来の `unusable` に寄せられる。担当外のため変更していない。
- 対象record破損時のメッセージを「関連するレコードを安全に読み込めません。原本を保全し、編集を停止しています。」に具体化した（旧 `Store.load` 経由ではowner側の汎用文言になっていた。拒否の意味は同じで、既存テストに文言依存はない）。
- `database:read` のElectron IPC越しの時間・UI体感はNOT_RUN。時間値はすべて合成SQLiteの参考値。
- global `Store.load`/search、record一覧のページ分割、他担当領域は今回の対象外のまま。

## 実行結果（この担当の実行値）

| 確認 | 結果 |
| --- | --- |
| `npm run check` | **PASS**（exit 0） |
| `npx vitest run tests/database-read-snapshot.test.ts --maxWorkers=2 --testTimeout=60000` | **21/21 PASS** |
| 関連10ファイル `--maxWorkers=2` | **107/107 PASS**（database-read-snapshot, database-operations-r5, database-session-r5, crash-recovery, prepare-crash-recovery, store-atomic-load, record-read-snapshot, r8-width-persistence, record-page-owner-update, record-repository） |
| `npx vitest run --maxWorkers=2 --testTimeout=30000` | **84ファイル・871件 PASS**（開始点83/850 + 新規21） |
| `npm run build`（`tsc --noEmit` + Vite + esbuild） | **PASS**（exit 0）。既存のdynamic/static import警告と500kB超chunk警告のみ |
| GUI/Electron/ブラウザ/OS clipboard | **NOT_RUN** |
| 実データ・既存Folio・他worktree | 未使用・未変更（fixtureは `output/` 配下の使い捨てSQLite） |

ログ（git管理外）: `output/dispatch/logs/full-suite-c-final.log`、`build-c-final.log`、`database-read-snapshot-final.log`、`related-tests-final.log`、`check-c-final2.log`。作業メモは `output/dispatch/NOTES-C.ja.md`。
