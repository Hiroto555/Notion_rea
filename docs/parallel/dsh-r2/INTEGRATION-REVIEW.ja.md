# Folio DeepSeek Round 2 統合レビュー

2026-11-05T01:19:53+09:00

## 結論

**A/B/C/Dの完了報告・差分を確認し、4担当の成果をローカル統合済み。独立再現で確認した問題をCodexが修正し、統合ソースで型検査・97ファイル / 996テスト・buildがPASS。GUIはNOT_RUN。**

- 統合worktree: `<workspace-root>/Folio-dsh-r1-integrated`
- ブランチ: `codex/folio-dsh-r1-integrated-20261105`
- 検証対象コードcommit: `bca29d1310d92f53a329d912f4527963f1989a5f`。検証後にcommitし、その後はレポートのみ変更。
- 共通開始点: `e00dc172f413f547ee6f0a0beab6d7bfa6d757d3`
- 現状: **Level 2到達 / Level 3部分達成**。固定したG7の上限・保守制御とG1/G8のGUI証拠が未達。テスト件数をLevelの代用にしない。
- リモートへのpush、PR、デプロイ、Desktopアプリ差替え、利用者の実データ操作は未実施。統合先は上記worktreeで、古い `Notion_rea` masterへの差替えではない。

## 4担当の確認

| 担当 | 確定HEAD | 採用した成果 | 境界 |
| --- | --- | --- | --- |
| A | `2576c399dd7a196913502851ea5d1d891f120049` | 初期本文とPage/検索本文/receiptの原子作成、同じ操作の明示再試行、拒否入力の保全 | mainのrich backup接続はCodexが補完。GUI未確認 |
| B | `872d866d34242abe2917e447f17999ff046e0be4` | 読取専用の容量集計、保持・制御設計 | IPC/UI/書込み上限/GCは未実装。計測だけでG7合格にしない |
| C | `3acae130ca9cb177baad571c7c7d48e71f1c68d2` | 専用子Nodeの強制終了、backup/restore/破損時の独立試験 | 物理停電の保証ではない。製品ソースは変更していなかった |
| D | `4d994f5e80ecb009630c8bda47940267d9a94564` | 固定8条件の独立監査・残件一覧 | 監査本文は開始点e00dc17の記録。最新判断は本書 |

4 worktreeは調査開始時と最終確認時にcleanで、HEADは不変。完了HANDOFFとcommitを証拠として確認し、GUIを使わず調査した。元の担当branchは書き換えていない。

統合merge: C `f1f204f` → D `8a725e1` → A `0272427` → B `37b0535`。その後のCodex修正は `bca29d1`。

## レビューで修正した問題

| No. | 重大度 | 再現条件・影響 | 修正・証拠 |
| --- | --- | --- | --- |
| R2-01 | P1 | 初期本文付きcreateの送信前checkpointが失敗すると、coordinatorが操作を削除し、その入力を保持できない | `src/renderer/page-operation-coordinator.ts:253`。`uncheckpointed`としてメモリに保持、終了防止の対象にし、明示再試行で同じ操作を再checkpointしてから送信。`tests/dsh-r2-integration-regressions.test.ts:89` と `:125`。ディスクへの保存成功を偽らず、保存不能中の強制終了まで保護できるとは主張しない |
| R2-02 | P2 | 存在する任意テーブル（復旧コピー等）の読取失敗を容量レポートが無視し、`complete`/`within`になり得る | `src/persistence/storage-usage.ts:493`。任意テーブルのunknownも全体に伝播、TEXT合計はnull。独立障害注入 `tests/dsh-r2-integration-regressions.test.ts:37` |
| R2-03 | P2 | backup rootのEACCES等で未計測bytesが0になり、総量に誤った数値が出る | `src/persistence/storage-usage.ts:148`。unknownのbytesをnullにする。独立試験 `tests/dsh-r2-integration-regressions.test.ts:72` |
| R2-04 | P2 | symlinkを走査しなかったbackup entryを`complete`と分類していた。既存追加テストもこの値を期待していた | `src/persistence/storage-usage.ts:1036`。部分走査はunknownとし、当該テストの期待値を強化。容量計測の構造分類は完全backup verifierの代替ではない |
| R2-05 | P1・Aの申し送り | 初期rich本文をupdateからpage:commitへ移すと、従来の事前backup入口を通らない | `src/main/index.ts:167`、新規 `src/main/rich-document-protection.ts:6`。実際にmainが使うguardをNodeで試験。実backupが作成より前に存在すること、失敗時にPageもreceiptも作らないこと、resolveでbackupを作らないことを検証 |

R2-01〜03は修正前に3件とも独立テストが失敗した（`output/review-r2/regressions-before.log`）。修正後の新規6テストはすべてPASS。既存assertionを外したりskipしたりせず、入力保持・不完全判定の契約を強化した。

追加で、CのPage中断試験にAの初期本文を渡してCOMMIT前・Page INSERT後/receipt前・COMMIT後を検証した。backupの中断fixtureは実際のassets directory fsyncを実行した後にbarrierで止めるよう補正し、報告の境界と一致させた。

## CのF1に対する判断

1 PageのJSONが破損していると、完全backup verifierが拒否し、未完marker付きの途中コピーが残る。これは `tests/l3-durability-corrupt.test.ts` で独立確認した。

**完全backupの検証を緩める変更は行わない。** 破損原本を「復元確認済みの完全backup」と表示しない現行の失敗処理を維持する。健康Pageのload/search/edit、破損Pageの `pageSource` によるraw JSON取得、原本不変を確認済み。破損workspace全体をrawで救出する専用bundleは残件であり、完全backupとは区別する。画面でのraw救出はNOT_RUN。壊れたPageがあると、初回rich編集の事前backupも失敗し、その編集を止め得る制限は残る。

## 今回の実行結果

Node v24.20.0 / npm 11.19.0。既存依存を使用、worktree専用 `output/vite-cache`、maxWorkers=2。データは使い捨てfixtureのみ。

| 検証 | 結果 | ログ |
| --- | --- | --- |
| 独立回帰・A/B関連 | 6ファイル / 62件 PASS | `output/review-r2/targeted.log` |
| C障害・復元（A初期本文との統合） | 3ファイル / 13件 PASS | `output/review-r2/crash.log` |
| `npm run verify:quiet` 型検査 | PASS | `output/review-r2/verify-quiet.log` |
| 同 unit suite | **97ファイル / 996件 PASS** | 同上 |
| 同 production build | PASS | 同上 |
| quiet全体 | exit 0、37.3秒 | 同上 |
| `git diff --check` | PASS | 最終差分確認 |
| GUI / Electron / Playwright / clipboard / native dialog | **NOT_RUN** | 明示的な禁止を継続 |
| hosted CI / Windows / Linux / 物理停電 | **NOT_RUN** | 範囲外 |

buildには従来のdynamic/static import混在と500kB超chunkの警告がある。成功は警告解消や操作感の検証を意味しない。今回ブラウザ、Folio本体、HarnessのGUIも操作していない。

## 固定Gateの統合後評価

PASSは記載した非GUI条件の充足。製品画面の一連操作はG8で別途保留し、Levelを累積評価する。

| Gate | 統合後 | 根拠・残件 |
| --- | --- | --- |
| G1 ローカル完結 | PARTIAL | ローカル経路のコード・Node試験。ネットワーク遮断下のアプリ全体はNOT_RUN |
| G2 正常操作の不変条件 | PASS（非GUI範囲） | 既存local integrity、legacy/record、並び順、R1 regressionsを含む全suite。旧順位修復サービスのGUIは未接続 |
| G3 保存と入力保護 | PASS（非GUI範囲） | 初期本文/検索本文/receipt同一tx、lost ACK、重複、rollback、SIGKILL、checkpoint失敗時の保全。Appとmainの接続はコード点検、実画面はG8 |
| G4 復旧・競合 | PASS（非GUI範囲） | 起動時は照合のみ、明示再試行のみ同じIDを使用、rejected/unknown保全、既存revision conflict試験。再試行・復旧コピーの画面操作はG8 |
| G5 backup/restore | PASS（非GUI範囲） | 添付digest、別場所restore、manifest前/marker削除前SIGKILL、未完拒否、原本不変。物理停電は対象外 |
| G6 破損・未知schema | PASS（非GUI範囲） | 原本raw救出、健康Page編集、未知schema拒否、transaction cleanup失敗時の停止。F1の完全backup制限とGUI救出未検証は上記参照 |
| G7 容量・処理量 | PARTIAL／必須条件未達 | 非破壊計測と保持設計まで。UI/IPC・上限/保守実装・増加管理は残る。計測がunknownならwithinにしない |
| G8 製品経路・独立検証 | PARTIAL | 今回の統合ソースで型/unit/build/障害試験はPASS。GUI→再openの証拠はNOT_RUN |

Dの旧表を最新の評価と誤読しないよう、`GATE-EVIDENCE.ja.md` と `LEVEL3-RESIDUALS.json` に本統合レビューへの参照を追加した。監査時点の記録は改変していない。

## 次に残る仕事

- ローカル完成度: G7の計測APIを安全な頻度で接続し、容量上限で入力を保全して停止できる経路・保守操作を実装する。receiptを古さだけで削除しない。DB集計やdirectory一覧は同期処理なので毎保存に全走査を組み込まない。
- GUIの実行許可後: `docs/GUI-VALIDATION-QUEUE.ja.md` のRound 2分を一時データでまとめて確認。今回のレポートは実行許可ではない。
- クラウド/同期: 製品経路未接続の実験moduleのまま。Level 4対応や多端末同期完了とは扱わない。

レポートとログの固定コピー: `Notion_rea/outputs/folio-l3-r2-20261105/integration/`。`RESULT.json` に最終HEADと検証状態、`SOURCE-SHA256.json` に対象ソースの指紋を保存する。
