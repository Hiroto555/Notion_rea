# R4 統合結果

2026-10-28 (Asia/Tokyo)。H0 `af9132ea405212a76d3b2c88f76c1b57cb98a3b9` から独立repoで開発。

## 実Appで増えた操作

| 成果 | 実装 / App接続 | 合成SQLite再起動 | 検証 |
|---|---|---|---|
| record本文・タイトル編集 | 接続済み。通常Pageと同じTiptap Editor | 最終全体E2E PASS | R4-01 |
| text / number / checkbox | cellとrecord上部から同じsessionへ保存 | 最終全体E2E PASS | R4-02 |
| side peek / 全画面 / 閉じる | 同じEditor/Undoを維持、元行focus/scrollへ戻る | 保存機能と併用PASS | R4-03 |
| slash絞込み・矢印・変換・Undo・Esc | 変換を一つのUndo単位に修正、取消とblock選択を整理 | 最終全体E2E PASS | R4-11 |
| Page / DB / record外観 | 共通幅・余白・行高・focus token適用 | 対象外 | R4-12、固定1440×900画像 |

## 保存の確認範囲

- 表示doc/titleとbase revisionをsessionへ結合。refreshだけで古い本文のbaseを進めない。
- record本文/title/valuesをApp寿命の一つのcoordinatorで保存。対象ownerとrevisionをSQLite transaction内で再検査。
- 更新とreceiptを同transactionへ記録。同ID/同要求は再適用せず、同ID/別要求は拒否。receipt不在はunknownを保持。
- COMMIT後ACK欠落から照会で確定。unknown中に新IDで無条件再送しない。
- pending/unknownで閉じる・別record・再openしてもdraftを保持。通常終了/reloadを抑止。
- 履歴復元のACK/read保留中にdialogを閉じても入力を抑止し、doc/title/revisionを一緒に導入。
- 数値の途中入力もApp側に保持し、未完成なら通常終了/reloadを抑止。

## 固定候補と全体試験

検証場所: `<workspace-root>/Folio-r4-20261028/validation`、branch `codex/r4-validation`。
固定commit: `f3c4dd1e5e2734a98c2242814b989beefd58160d`、tree: `a37f348d14fe96b1bbff3de94d37341de7d7d214`。実行開始時clean。integrationの製品source・testと一致し、差分は担当guard設定と報告文書のみ。

最終run（2026-10-28 13:40:49–13:47:19 JST）: **build/typecheck PASS、全unit 480/480 PASS（50 files）、全E2E 126/126 PASS（Electron98 + Chromium表示fixture28）、FAIL 0、SKIP 0**。この一回の全体runの結果であり、過去の部分PASSとの合算ではない。

| 検証 | 生log |
|---|---|
| build/typecheck | [build-6998b899](../../../../validation/output/agent-workspace/logs/2026-10-28T04-40-49-198Z-build-6998b899.log) |
| 全unit | [test-0ecb2d31](../../../../validation/output/agent-workspace/logs/2026-10-28T04-40-56-127Z-test-0ecb2d31.log) |
| 全E2E | [test-e2e-59608387](../../../../validation/output/agent-workspace/logs/2026-10-28T04-41-29-872Z-test-e2e-59608387.log) |

buildにはchunk size/dynamic importの警告が残るが、コンパイル・型検査のエラーはない。

環境: macOS Darwin 25.6.0/arm64、Node v24.20.0、npm 11.19.0。build→unit→E2Eを直列実行。unitはmaxWorkers=1/file parallelismなし、E2Eはworkers=1/retries=0。Electronは各fixture専用のFOLIO_DATA_DIR/userDataを初回起動前から指定。

試験commandは `node scripts/r4-verify.mjs`。内部で `node scripts/folio-agent.mjs build`、`test --maxWorkers=1 --no-file-parallelism`、`test:e2e --workers=1 --retries=0` を実行する。

[実行manifest](../../../../validation/output/r4-final-verification/manifest.json) / [失敗を含むrun履歴](../../../../evidence/SOURCE-AND-RUNS.md) / [QA詳細](A7.md) / [操作別台帳](SCENARIOS.md)。

`r4-verify.mjs` がclean commit、tree、環境、command、時刻、worker=1/retries=0、終了状態を `output/r4-final-verification/manifest.json` へ記録する。生logは `output/agent-workspace/logs/`。

H0のbuild/typecheck・重点unit46件・重点E2E2件成功と、全unit/全E2EのNOT_RUNは従来記録のまま保持。本R4の結果とは別扱い。さらに以前の全E2E107成功/1失敗/2skipと部分再成功2件、全unit462成功/1timeoutと単独再成功も全体PASSへ合算しない。R4の初期失敗・中断はA7.md・attempt-01/02.json・生log/traceへ保持した。

全E2EスイートにはElectron実App98件とChromium表示fixture28件が含まれる。旧DBの表示fixtureやlegacy経路のPASSを、新recordの保存証拠へ読み替えない。既存r3-fidelity log内の未接続表記はそのlegacy試験の説明であり、R4新recordの状態はr4-record-editとrecord-coreで判定する。

## 合成デモ

`scripts/r4-demo.mjs` は専用 `output/r4-demo/data` のみを開く。初回だけ3行の合成タスクDBを作り、その後の再起動では同じSQLiteを使う。既存の実workspaceやアプリは対象にしない。

[起動用ファイル](../../../../開く_R4合成デモ.command)。最終固定候補のbuildを使用。初回の依存準備とbuildは実施済みで、ユーザーによるターミナル準備は不要。

最終固定候補を使い、デモでも本文・title・メモ・見積30・完了を実UIから変更→正常終了→再起動→SQLite読取を確認済み。編集済みのside peekを開いた状態で残している。
[再起動後のデモ画面](../../../../validation/output/r4-demo/record.png) / [DB一覧](../../../../validation/output/r4-demo/database.png) / [保存確認JSON](../../../../validation/output/r4-demo/demo-proof.json)。このデモrunは全体E2E126件には加算しない。

操作: R4合成タスクDB → 行の右矢印 → 本文・タイトル・メモ・見積・完了を編集 → 全画面/side切替 → 閉じる → 一覧確認 → 保存済み後に終了 → 同デモを再起動して確認。

## 代表画面 before / after

同じ合成内容・1440×900 viewport・light theme・日本語UI・macOSで比較したFolioの画像。Notionの画面ではない。beforeはH0製品source、afterは最終固定候補。

| 画面 | H0 | R4 |
|---|---|---|
| 通常Page | [before](../../../output/r4-visual/before/page.png) | [after](../../../../validation/output/r4-visual/after/page.png) |
| DB | [before](../../../output/r4-visual/before/database.png) | [after](../../../../validation/output/r4-visual/after/database.png) |
| record | [before](../../../output/r4-visual/before/record.png) | [after](../../../../validation/output/r4-visual/after/record.png) |

R4主成果5本はすべて実Appへ接続済みで、fixtureだけで終了した主成果は0件。既存のview/filter/sort/group編集などは表示部品・fixtureの成果を保持しているが、新record用の設定保存経路は今回開放していない。

## 未完・比較の境界

- Notionライブ同条件比較: 未実施。2026-10-28に[DB公式説明](https://www.notion.com/help/intro-to-databases)、[ビュー公式説明](https://www.notion.com/help/views-filters-and-sorts)、[ショートカット公式説明](https://www.notion.com/help/keyboard-shortcuts)を参考確認。公式資料確認は一致の証拠ではない。
- 物理日本語IME、native OS clipboard: 未確認。合成composition/clipboard試験とは別。
- 完全backup/自動draft復旧、未解決operationの再起動後再発見: 未実装。receiptの永続化とdraft復旧は別。強制終了・process crashからの未保存入力復旧は主張しない。
- 履歴復元自体のACK欠落は自動照会未対応で、編集停止を維持する。
- 所属変更/ABA一般解、旧DB自動変換、record/登録DBの危険な履歴復元は開放していない。既存v1/v2→v3 migrationは残る。
- select/dateのlive編集、center peek、DB作成/行追加とview/filter/sort/group設定保存などは次ラウンド。既存表示部品は消していない。
- 旧binary/任意SQLite writerの排他、receipt GC、実データ運用の確認は未実施。

元repo/H0/既存worktreeを変更せず、push/公開PR/master mergeはしていない。今回作成した担当branchとworktreeは追跡可能な状態で保持。

## 次に増やす一件

R5は専用record作成経路による新規行追加を、今回のcoordinatorと基本property編集へ接続し、一覧→本文編集→再起動まで確認する。続いてview/filter/sort/group設定保存を既存実装から棚卸しする。未保存draftの永続化・restore結果照会・物理IMEはそれぞれ別の確認項目として残す。
