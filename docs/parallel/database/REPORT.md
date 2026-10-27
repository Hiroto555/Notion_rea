# Database 2.0 実装・検証報告

- 担当: Database
- branch: `sprint/database-v2`
- worktree: `/Users/shiroto/Documents/ChatGPT/Folio-database`
- 開始 commit: `b43f713`（共通基準 `b7c150d15739c59edf6ba9a62ebda4794748d46b` + 環境準備）
- 変更範囲: `src/database/`, `src/shared/types.ts`, `src/persistence/store.ts`, Database専用テスト、`docs/parallel/`
- 未変更: `src/editor/`, `src/shared/editor-schema.ts`, `src/shared/validation.ts`, `src/renderer/App.tsx`, `src/renderer/styles.css`, `src/main/`, `src/preload/`, 他worktree, master

## 実装

1. 複数ビュー: `views` 配列と `activeViewId`。各ビューが type/name/filterText/AND-OR filter/複数sort/groupBy を独立に保持。作成・改名・複製・削除・左右移動・切替を純関数で実装。
2. フィルター: 入れ子 AND/OR ツリー、最大200ノード・深さ8、型別オペレータ18種。`title` 仮想プロパティ。空値・数値・日付・チェックボックス・日本語文字列を評価。
3. ソート: 複数キー、安定、空値は昇順/降順とも末尾。旧 `-key` 形式を読込み。
4. グループ化: 1キー。select は選択肢順（降順指定で逆順）、checkbox は未チェック→チェック済み、その他は値順、未設定は末尾。table/gallery/board に反映。board は未設定時に最初の select、calendar は最初の date を使う。
5. UI: 旧 `Database` の `{ value, onChange }` 契約を維持。旧ラベル/クラス（絞り込み、並べ替え、テーブル/ボード/カレンダー/ギャラリー、`.db-card`, `.board-column`, `.gallery`, `.day`）を維持。ビュー管理バー、フィルタービルダー、複数ソート、グループ化を追加。`App.tsx` は変更しない。
6. 永続化: `DatabaseData.schemaVersion=2` を page JSON に保存。SQLite `user_version` 2→3。v2 ワークスペースは `.pre-v3.sqlite` を保存後、全 page/version の database JSON を単一トランザクションで移行。
7. 互換投影: `view`/`filter`/`sort` を active view の互換投影として維持。旧 `{...emptyDatabase(), filter, sort}` と旧UIの読込みを維持。
8. 異常時: 未知 database version・不正構造はページを `documentError` にして編集停止し、`pageSource` の原本を保持。migration 失敗は ROLLBACK して user_version 2 のまま再試行可能。

詳細契約は [database-contract.md](../proposals/database-contract.md)。

## 変更ファイル

- `src/database/model.ts`: 正規化、フィルター評価、sort/group、view CRUD、旧形式移行
- `src/database/Database.tsx`: 複数ビューUI、フィルター/複数ソート/グループ化、既存4表示の維持
- `src/database/FilterBuilder.tsx`: 入れ子 AND/OR UI
- `src/shared/types.ts`: v2 型、`databaseDataSchema`、`emptyDatabase`
- `src/persistence/store.ts`: v3 migration、backup、read normalization、write validation
- `tests/database-v2.test.ts`: 新規単体19件
- `tests/e2e/database-v2.spec.ts`: 新規実Electron 1件
- `docs/parallel/proposals/database-contract.md`: 契約提案
- `docs/parallel/database/REPORT.md`: 本報告

## 実行コマンドと結果

すべて `node scripts/folio-agent.mjs ...` 経由。E2E は、実行環境が `ELECTRON_RUN_AS_NODE=1` を設定しているため `env -u ELECTRON_RUN_AS_NODE` を前置した。これはアプリ/テスト設定の変更ではなく、Electron を GUI として起動するための環境補正である。DSH のファイルsandbox下では Chromium の子プロセス sandbox が `sandbox initialization failed: Operation not permitted` で画面クラッシュしたため、E2E のみ Harness の1回限りのホスト権限承認を使用した。恒久的なsandbox設定変更はしていない。

| # | コマンド | 終了 | 結果 | ログ |
| --- | --- | --- | --- | --- |
| 1 | `check` | 0 | PASS | `output/agent-workspace/logs/2026-10-27T03-04-23-737Z-check-ce5d7e78.log` |
| 2 | `test`（変更前基準） | 0 | 50/50 | `output/agent-workspace/logs/2026-10-27T03-04-26-400Z-test-6b691cd3.log` |
| 3 | `test -- database-v2`（初回） | 1 | 67/69。sort降順の空値位置とテスト期待の誤り2件 | `output/agent-workspace/logs/2026-10-27T03-20-11-334Z-test-0c30d676.log` |
| 4 | `test -- database-v2`（修正後） | 0 | 69/69 | `output/agent-workspace/logs/2026-10-27T03-23-31-239Z-test-9c66bffd.log` |
| 5 | `build` | 0 | PASS（Vite chunk警告のみ） | `output/agent-workspace/logs/2026-10-27T03-23-46-103Z-build-93d51b73.log` |
| 6 | E2E（`ELECTRON_RUN_AS_NODE=1` のまま） | 1 | 全42件 launch 失敗。`bad option: --remote-debugging-port=0` | `output/agent-workspace/logs/2026-10-27T03-24-02-452Z-test-e2e-78b595f0.log` |
| 7 | E2E 対象1件（env解除、sandbox下） | 1 | renderer crash。Chromium sandbox 初期化拒否 | `output/agent-workspace/logs/2026-10-27T03-26-37-890Z-test-e2e-db449899.log` |
| 8 | E2E 起動診断（一時ファイル、削除済み） | 1 | `sandbox initialization failed` / Page crashed | `output/agent-workspace/logs/2026-10-27T03-28-57-995Z-test-e2e-f8712f7f.log` |
| 9 | E2E 対象1件（ホスト権限） | 1 | 新規テストの `getByLabel("並べ替え")` が2要素に一致 | `output/agent-workspace/logs/2026-10-27T03-33-17-921Z-test-e2e-62d7af90.log` |
| 10 | E2E 対象1件（exact指定後） | 0 | 1/1 PASS | `output/agent-workspace/logs/2026-10-27T03-36-12-641Z-test-e2e-573ce6ec.log` |
| 11 | 全体E2E | 0 | **42/42 PASS**（2.5m） | `output/agent-workspace/logs/2026-10-27T03-38-21-787Z-test-e2e-933deb1d.log` |
| 12 | `test`（最終コード） | 0 | **69/69 PASS** | `output/agent-workspace/logs/2026-10-27T03-41-49-865Z-test-c36e19ac.log` |
| 13 | `build`（最終コード） | 0 | PASS（Vite chunk警告のみ） | `output/agent-workspace/logs/2026-10-27T03-42-10-202Z-build-b426143a.log` |
| 14 | 全体E2E（最終build） | 0 | **42/42 PASS**（3.5m） | `output/agent-workspace/logs/2026-10-27T03-43-53-763Z-test-e2e-5b4245de.log` |

## 前回失敗の扱い

- 3回目までの E2E 失敗は、アプリの機能ではなく実行環境（Electron の Node モード、Chromium sandbox、テストセレクタ）に起因する。製品コードの不具合として扱わず、製品コードを変更していない。
- 6回目は launcher への引数に余分な `--` を付けたため Playwright が全ファイルを対象にした。7回目は DSH の sandbox が Chromium の sandbox 初期化を拒否した。9回目は新規テストのラベル指定が `複数並べ替えを追加` にも部分一致した。いずれも製品コードではなく実行手順/テスト記述の問題として修正した。
- 3回目の単体失敗のうち、sort 降順で空値が先頭になる点は実装の不具合だったため `compareRows` を修正した。もう1件はテスト期待値の誤りで、AND条件の構築を修正した。既存テストの削除・skip・期待値弱体化はしていない。
- 全試行のログを上表に残し、成功した試行だけを根拠にしない。

## 限界・未検証

- 行ごとのページ本文、Relation/Rollup/Formula、プロパティ削除/並べ替え、複数グループキー、ビューごとの列表示/幅は未実装。今回の要求外。
- 入れ子 AND/OR のUIは深さ上限8まで。上限超過は保存時に拒否される。
- Notion実比較、物理IME、ピクセル差分は NOT_RUN。Notion内部仕様は UNKNOWN。
- 大規模データの性能は既存の 150ページ/1000ブロックE2Eの範囲。100,000行のUI操作は未検証。
- ホスト権限は E2E 実行の1回限り承認であり、恒久的な権限変更ではない。`ELECTRON_RUN_AS_NODE` の解除はテスト実行環境の補正。
- 旧アプリは `user_version=3` を拒否する。これは旧UIが v2 ビュー定義を失って上書きするのを防ぐための意図的な互換境界。ロールバックは `.pre-v3.sqlite` と assets の組で行う。

## ソース/ビルド hash

- source:
  - `src/database/model.ts` `706f493d19bb489407a08eff90005bae11db18ddf52b243d160f80bbe2fab914`
  - `src/database/Database.tsx` `421c24f65c990b9fe8ee797390bf3c33603e8f41e6e580dcad1fb17f36f903c9`
  - `src/database/FilterBuilder.tsx` `a1976bebe076599707144dd44b9d30edc55def73ed192ed5b9b61f2c0b1d86d6`
  - `src/shared/types.ts` `14e0a7415d0a0efcc82d275bafb5f0523a7ecbd38172eeb70f261108d6ae8fae`
  - `src/persistence/store.ts` `62b0d8d76cfa5d1a63518c851e63bcdd94c44ba02d409d2911834792d1d789ab`
- tests:
  - `tests/database-v2.test.ts` `01e60f9e3974ed1b03342228d95ebd35e8b3bdabd7d55cf61f21ef65c0efb32e`
  - `tests/e2e/database-v2.spec.ts` `fc83a52c179ca0686bd6647eb0de0c9ded8aaf428c65919cd372b32d25b05ee9`
- build:
  - `dist/renderer/assets/index-DV3A2xEl.js` `f5bdb837ef08933763b5087a8cff745d82677409f05c5926e97c5265bef6124b`
  - `dist/main.cjs` `f5c2784b888670e7d4eac8478b032c1fc7d4284a6e0fc0ccf78b58fd958a3513`
- 実行環境: macOS 26.6.2 arm64 / Node v24.20.0 / npm 11.19.0 / Electron 45.0.0
- 最終コードの commit はこの後作成する。commit hash は作業完了報告に記載する。
