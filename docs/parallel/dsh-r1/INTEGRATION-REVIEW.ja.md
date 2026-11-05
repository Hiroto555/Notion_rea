# Folio: DeepSeek Desktop 4担当のレビュー・統合

2026-11-05（JST）。**4担当の成果をローカルで統合し、非GUI検証に合格。GUIとGitHub Actionsの実行はNOT_RUN。**

作業場所: `<workspace-root>/Folio-dsh-r1-integrated`

統合ブランチ: `codex/folio-dsh-r1-integrated-20261105`

基準: `b96422fc2eee354b7a8d77a9de6018394708b5e3`

レビュー修正コミット: `a8bfd32`。その後のコミットは本書と運用文書の更新のみ。

## 4担当の受入

本人のHANDOFFとコード差分、Gitの状態を確認し、完了コミットをそれぞれmergeした。元の4 worktreeは編集していない。全HEADが統合ブランチの祖先になっていること、元worktreeがcleanであることを最後に確認した。

| 担当 | 元の完了HEAD | 受入結果 | 製品上の範囲 |
| --- | --- | --- | --- |
| A: 作成・複製の二重実行防止 | `a99b54e2cdbbf0055f3bba83ab96360952354df9` | 3点補強して統合 | 通常Pageの操作ID・receipt・未確定状態・復旧記録。旧形式DBの複製経路を維持 |
| B: 並び順の修復 | `265401851e985af825343e5bbf4e0273ca9503cc` | 統合 | 明示preview/applyのサービスAPI。バックアップ必須。GUI/IPC・自動修復は未接続 |
| C: DB読み込み軽量化 | `4db6f9351f748d21718b3e1eeb6a01bb028637b2` | 1点補強して統合 | 対象DBのowner・所属recordだけを同一SQLite snapshotから読む |
| D: 非GUI検証とCI | `aadc15b09b147109b846e378b5887089d2bd54e6` | 統合 | `npm run verify:quiet` とGitHub Actions定義。Actions実行は未確認 |

mergeコミットはD=`33b2bb0`、B=`e735699`、C=`9e0ac62`、A=`a2e7967`。統合前の本人のテスト件数を、今回の独立実行の成功と混同しない。

## Codexレビューで修正した問題

すべて使い捨てfixtureで確認。実データの修復、GUI操作、外部公開は行っていない。

| 重要度 | 問題と再現条件 | 修正 | 回帰試験 |
| --- | --- | --- | --- |
| P1 | A: 旧形式DBの複製ボタンが通常Page専用coordinatorへ流れ、「通常ページ以外は複製できません」と拒否。変更前Appの呼び出しと同じ経路をNode試験で再現 | `duplicateEditorPage`を実際のAppから呼び、通常Pageだけ新protocolへ、旧形式DBは既存経路へ。登録DB/recordの既存制限は維持 | `tests/dsh-integration-regressions.test.ts:26`、`:46` |
| P1 | C: snapshot COMMIT失敗後、closeにも失敗すると、エラーを返した後もStore.getで読み続けられる | `Store.readSnapshot`を抽出して全体loadと対象DB readで共有。close失敗時もStoreを使用不能にする既存処理を共用 | 同`:59`。COMMIT/closeの二重故障を注入 |
| P1 | A: INSERT後にSQLiteのRAISE(FAIL)が発生すると、Pageを残したままrejected receiptをcommit。ABORTと異なりFAILはそれ以前の変更を残す | createにSAVEPOINTを置き、拒否receiptを記録する前に変更を戻す。cleanup失敗は外側transactionへ伝播 | 同`:103`。一時DBにAFTER INSERT triggerを置いて再現。通常データにこのtriggerがあるという主張ではない |
| P2 | A: applied ACKのPage IDが欠落していても、作成成功としてpendingを消す | IDの型・空値・上限とtitleの型を検証。不完全なACKはunknownのまま保持 | 同`:116`。返信のIDだけを欠落させ、その後同じoperationをresolve |

修正前のログは `output/review/regressions-before.log`（2失敗）、`output/review/receipt-regressions-before.log`（追加2失敗）。修正後、同じ不変条件が通ることを確認した。Aのルーティング確認は実際のAppに接続した関数をNodeから試験したもので、メニューをクリックしたGUI検証ではない。

## 統合検証

環境: Node `v24.20.0`、npm `11.19.0`、既存lockfileに対応したnode_modules。既存環境をsymlinkで利用し、今回のVite cacheは統合worktree内へ分離した。

| 検証 | 結果 | 証拠 |
| --- | --- | --- |
| 重点回帰・関連試験 | **7ファイル / 94件 PASS** | `output/review/targeted-final.log` |
| 全体 `npm run verify:quiet` | **89ファイル / 929件 PASS**、型検査・buildともPASS、exit 0 | `output/review/quiet-final.log` |
| 統合専用試験 | **7件 PASS**。上記全体件数に含む | `tests/dsh-integration-regressions.test.ts` |
| 差分の空白エラー | `git diff --check` PASS | 最終確認 |
| 公式Actionsの固定SHA | checkout v7.0.1、setup-node v7.1.0のtag SHA一致を公式Git remoteで再確認 | `git ls-remote`。実行成功の証明ではない |
| GUI / Electron / Playwright E2E / OS clipboard / ネイティブダイアログ | **NOT_RUN** | 利用者の指示どおり未実行 |
| GitHub Actions上のCI | **NOT_RUN** | push/PRを実施していない |

全体は基準83ファイル/850件から、DeepSeek追加72件と統合回帰7件を加えた89ファイル/929件。単独実行の件数を足して重複計上していない。quiet入口はtypecheck 4.8秒、test 22.1秒、build 7.2秒、計34.2秒だった。時間は今回の参考値。

追加の統合試験:

- Aのreceiptを作った後にBの同順位修復を実行し、receiptとCで読むDB/recordが変わらないことを確認。修復でrevisionが変わったPageへの古い複製要求は拒否される。
- 作成前のcheckpointを実ファイルへ保存し、COMMIT後ACK喪失を再現。Storeと復旧ファイルを再openし、同じoperationIdから結果を確認してPageが1つだけ残ることを確認。プロセス強制終了や停電そのものの実証ではない。
- Cの既存scale試験は無関係な10,000ページがあっても、対象owner+recordの3ページだけをdecodeする。UI体感や全体loadの高速化を証明するものではない。

buildは既存のdynamic/static import警告と500kB超chunk警告を出すが成功。警告は解消していない。

## 残件と次の関所

1. GUI確認は `docs/GUI-VALIDATION-QUEUE.ja.md` に追記。利用者が実行時間を明示してから、専用一時データで行う。
2. BはサービスAPIのみ。修復の確認画面やIPC配線は今回の担当範囲外。ユーザー実データに適用していない。
3. Aでcheckpoint保存後、一度も送信されなかった操作はresolveがunknownのまま残る。rejectedを起動時復旧で解決する扱いも未拡張。復旧コピー経路は維持しており、自動破棄や無条件再送は行わない。
4. template/importは作成と本文保存の2段階のまま。この間の障害で空Pageが残る既存制約を解消したとは扱わない。
5. Cは対象DBのreadだけを改善。workspace全体のload、検索、ページ分割は対象外。呼び出し元transaction内ではその所有者がcommit/rollbackを担当する。
6. Dのquiet入口はOS sandboxではない。将来のnpm script/hookの変更にもレビューが必要。CI実行結果は初回PR/push時に別途確認する。
7. クラウド同期・共同編集・Level4完成は今回の受入対象ではない。今回の成功だけで監査Levelを引き上げない。

元のNotion_rea checkout、4担当のworktree、既存Desktop Folio、実データは変更していない。GitHubへのpush、公開、配布アプリの差し替えは未実施。次の実装・レビューは上記統合worktree/ブランチを基準にする。
