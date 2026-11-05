# Folio L3 D — 到達条件の独立監査 HANDOFF

2026-11-05 JST。作業場所 `<workspace-root>/Folio-l3-r2-audit`、branch `codex/folio-l3-r2-audit-20261105`。
基準HEAD `e00dc172f413f547ee6f0a0beab6d7bfa6d757d3`。

担当Dの範囲は、固定したG1–G8の実装経路・既存テスト・残件の独立監査であり、Level 3の最終判定ではない。**製品コード、既存テスト、設定、lockfileは変更していない。**

## 結論

| Gate | 現時点判定 | 要点 |
| --- | --- | --- |
| G1 ローカル完結 | PARTIAL | 製品entryに外部ネット依存なし。オフライン隔離GUIはNOT_RUN |
| G2 正常操作の不変条件 | PASS（非GUI範囲） | 通常Pageのcreate/duplicate/move/trash/restore、順序・title・rollbackをコードと既存試験で確認 |
| G3 保存の確定と入力保護 | PARTIAL | save/receiptは原子的。template/importの初期本文が作成と別操作 |
| G4 復旧と競合 | PARTIAL | 保持・照会・競合拒否は成立。未送信操作を同じIDで再試行できない |
| G5 backup/restore耐障害性 | PARTIAL | fsync・検証・別場所復元・markerは実装済み。独立SIGKILL試験（C）が未実施 |
| G6 破損・未知schemaの隔離 | PASS（非GUI範囲） | 破損Page隔離・健康Pageのload/search・raw救出・未知version停止を確認 |
| G7 容量と処理量の管理 | **UNMET** | receipt/backup/添付の保持・上限・GC・容量表示がない。main同期処理の制限も残る |
| G8 独立検証と製品経路 | PARTIAL | 同一ソースでcheck/buildと限定235件PASS。全体929件・GUI・CIはNOT_RUN |

**Level 3到達とは報告しない。** G2/G6のPASSも非GUI範囲であり、G7は未達、G8は全体suite・GUI・CIが未実行である。

## 変更ファイル（所有分のみ）

| ファイル | 内容 |
| --- | --- |
| `docs/parallel/dsh-r2/GATE-EVIDENCE.ja.md` | G1–G8の必要条件、file:function:line、既存test、前回範囲、残件、次の最小試験 |
| `docs/parallel/dsh-r2/LEVEL3-RESIDUALS.json` | 機械可読のGate status・34件の残件・実行記録 |
| `docs/parallel/dsh-r2/HANDOFF-D.ja.md` | この引き継ぎ |

`src/`、`tests/`、`package.json`、`package-lock.json`、`.github/`、他担当の文書は変更していない。新しい依存も追加していない。既存テストのskip・削除・assertion弱体化もしていない。作業ログは `output/dispatch/d-logs/`（gitignore対象）に置いた。

## 実行結果

環境: macOS / Node `v24.20.0` / npm `11.19.0`。`node_modules` は既存symlink。Vite cacheは `output/vite-cache`。GUIは起動していない。

| 実行 | 結果 | 証拠 |
| --- | --- | --- |
| `FOLIO_VITE_CACHE_DIR=... npm run check` | PASS / exit 0 | 端末出力 |
| 限定Vitest 1回目（7ファイル） | 72件 PASS | `output/dispatch/d-logs/targeted-1.log` |
| 限定Vitest 2回目（7ファイル） | 55件 PASS | `output/dispatch/d-logs/targeted-2.log` |
| 限定Vitest 3回目（7ファイル） | 86件 PASS | `output/dispatch/d-logs/targeted-3.log` |
| 限定Vitest 4回目（1ファイル） | 15件 PASS | `output/dispatch/d-logs/targeted-4.log` |
| 限定Vitest 5回目（1ファイル） | 6件 PASS | `output/dispatch/d-logs/targeted-5.log` |
| 合成scale（1ファイル） | 1件 PASS / 6.3秒 | `output/dispatch/d-logs/record-scale.log` |
| `FOLIO_VITE_CACHE_DIR=... npm run build` | PASS / exit 0（既知警告あり） | `output/dispatch/d-logs/build.log` |
| 全体suite / `verify:quiet` | **NOT_RUN**（Codex） | — |
| GUI / E2E / clipboard / osascript | **NOT_RUN** | — |
| GitHub Actions | **NOT_RUN** | — |

合計24ファイル・235件。R1の89ファイル・929件は**過去記録**であり、今回の235件を全体の代わりにしない。`a8bfd32..e00dc17` の差分はdocs 4ファイルのみで、src/testsはR1統合時と同一である。

### 合成scaleの実測値（参考）

`tests/record-scale.test.ts`、SQLite+modelのみ。GUI・起動・入力latencyは測っていない。

- 1,000件: load 35.6–102.7ms、search 71.7–145.2ms、移行265.3ms。
- 10,000件: load 196.4–526.6ms、search 210.6–463.1ms、移行2,767.6ms。

この値はG7の容量制御の代替ではない。計測だけではG7をPASSにしない。

## 主要な発見

1. **G3の実穴（A担当）**: template/importは `create()` で空Pageを作成した後、`if (doc) update(p.id, {doc})` で本文を別保存する（`src/renderer/App.tsx:808`）。作成と初期本文が同一operationでなく、間で落ちると空Pageが残る。R1残件4と同じ。templateはiconも別update（`:2517`）。
2. **G4の実穴（A担当）**: 送信前checkpointはあるが、一度も送信されなかった操作を同じoperationIdで再送する経路がない。resolveはreceiptがない限りunknownを返し続け、session中の「保存を再試行」は明示的に拒否する（`src/renderer/App.tsx:1750-1756`）。起動時もunknownが1件あると「入力を復元」が止まる（`src/renderer/prepare-crash-recovery.ts:22-25`）。copy/exportの出口はある。
3. **G7は未達（B担当）**: `save_receipts` は各operationでINSERTされるだけで、削除・上限・GCがない。backupは `backups/` へ作成するだけ、添付は20MB/件の上限だけ。容量表示はbackup previewのbytes/inventoryに限る。mainは同期SQLite/fsyncで、重いload/search/backupをWorkerへ逃がさない。
4. **G5は実装済みだが独立中断試験が未実施（C担当）**: 添付1件ごとの本文fsync→readback→directory fsync、DB/target fsync、verify後のmarker削除、別場所復元と再検証、不完全markerの起動拒否は確認した。既存試験はfsync/copy失敗の注入で、SIGKILL中のpartial/marker/再openは未実行。
5. **G6は非GUIで成立**: 破損Pageをread-only placeholderにし、健康Pageのload/search/editとraw `pageSource` を維持。未知 `user_version` は開かず停止。record ownerの破損はそのDB配下だけread-only。GUI救出導線はNOT_RUN。
6. **G1はコード点検のみ**: 製品entryに外部ネット依存は見当たらない。`src/sync/` はテスト専用で、build entryに入っていない。ただしネットワーク遮断下のアプリ全体はNOT_RUNであり、G1の「隔離GUI確認」は未達。
7. **単一instance/windowの範囲**: `requestSingleInstanceLock` はプロファイル単位。同一 `userData` では二重起動を拒否しwindowは1つだが、別 `FOLIO_DATA_DIR` のプロファイルは同時起動できる。複数window同時編集はない。

## 残件（Codex統合後）

| 残件 | 担当 | 次の最小試験 |
| --- | --- | --- |
| template/importの初期本文を作成と同一operationへ | A | createと本文保存の間の失敗で空Pageが残らない。checkpointに本文が入る |
| 未送信操作の同じoperationIdでの明示再試行 | A | 未送信checkpoint→再起動→retryでPageが1つだけ |
| backup/restore途中のSIGKILL独立試験 | C | DB snapshot後・添付コピー中・manifest公開前・marker削除直前の中断 |
| receipt/backup/添付の非破壊計測・保持・上限制御 | B | 容量・増加率・unknown保持・入力削除なし。計測だけではPASSにしない |
| 修復APIのGUI/IPC接続（任意） | B/Codex | 通常操作の不変条件を壊さない |
| 破損PageのGUI救出導線 | Codex/GUI | read-only表示→健康Page編集→原本JSON保存 |
| オフライン隔離GUI | Codex/GUI | ネットワーク無効で起動〜書出し |
| 全体suite・GUI batch・CI | Codex | 同一統合コミットで `verify:quiet` / `test:e2e:batch` / Actions |

A/B/Cの第2ラウンド成果はこのworktreeに未統合。将来の成果を織り込んでいない。統合後に更新すべき行は `GATE-EVIDENCE.ja.md` の「A/B/C統合後に更新する行」と `LEVEL3-RESIDUALS.json` の `integrationUpdates` に明記した。

## 制約の遵守

- GUI / Electron / browser / OS clipboard / ネイティブダイアログ / スクリーンショット / osascript: **NOT_RUN**。`dev` / `start` / `test:e2e:batch` / 直接Electron起動も未実行。
- 実データ、既存Desktopアプリ、既存プロセス、他worktree、認証設定: 触っていない。既存receipt/historyの削除なし。
- 外部依存追加、node_modules再インストール、git reset/clean/force/push/deploy/PR: 未実施。
- 変更は自分の所有ファイルのみ。ローカルcommitのみ。

## commit

- 基準HEAD: `e00dc172f413f547ee6f0a0beab6d7bfa6d757d3`
- 本書を含むDのローカルcommit: 最終HEADは完了報告に記載（`git log -1`）。
- push、deploy、PR作成、他worktree・他担当ファイルの変更は行っていない。
