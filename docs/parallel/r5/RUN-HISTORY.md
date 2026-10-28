# R5 実行履歴

すべて2026-10-28、時刻はログファイル内のUTC。integrationのguardを通した実行。最終固定候補の全件結果はSTATUS.mdへ別記し、部分成功を合算しない。

| 実行 | 結果 | integration/output/agent-workspace/logs の生log |
|---|---|---|
| 初回型検査 | FAIL。database-operations.tsの改行後`as`構文 | 2026-10-28T05-36-13-711Z-check-82710a63.log |
| 初回重点unit | 4 PASS、core 2 suiteは構文で収集失敗 | 2026-10-28T05-36-36-990Z-test-ea97410c.log |
| 構文修正後型検査 | PASS | 2026-10-28T05-37-09-012Z-check-1a9c71f3.log |
| 重点unit | 18/18 PASS | 2026-10-28T05-37-17-273Z-test-cbee9da4.log |
| 初回build/typecheck | PASS | 2026-10-28T05-37-30-184Z-build-044a0ac1.log |
| 重点E2E | 17 PASS / 1 FAIL / 0 SKIP。checkbox設定COMMIT後のACK照合不一致 | 2026-10-28T05-37-48-273Z-test-e2e-deb92dfb.log |
| ACK/画面修正後型検査 | PASS | 2026-10-28T05-42-33-284Z-check-e0ae4f5a.log |
| 追加ACK照合unitを含む重点unit | 19/19 PASS | 2026-10-28T05-42-43-733Z-test-fe584589.log |
| 修正後build/typecheck | PASS | 2026-10-28T05-42-54-346Z-build-9742d4d2.log |
| 設定E2E再実行 | 4/4 PASS | 2026-10-28T05-43-08-493Z-test-e2e-33e6abb7.log |
| 追加interaction E2E | 4/4 PASS | 2026-10-28T05-45-39-599Z-test-e2e-623e2ac0.log |

初回失敗trace/error contextは `integration/output/r5-run-history/initial-targeted-failure/results/` にコピーして保存。checkboxは保存拒否ではなく、実SQLite COMMIT成功後にrendererで結果不明になっていた。元のtyped-filter assertionを弱めず、修正後に再成功した。

最終検証は独立validation worktreeで、cleanな固定commitを`r5-verify.mjs`が記録してbuild→全unit→全E2Eを直列実行する。R4の結果・H0の未確認事項はそれぞれ従来の記録を保持する。

## 初回の全件固定検証

validation commit `0401d9636883b807077ff4d2adef1d70f703710a`。build/typecheck PASS、unit499/499 PASS、E2E136 PASS / 1 FAIL / 0 SKIP（7.1分）。失敗は既存desktop clipboard試験のempty-MIME退避処理。

- build: `2026-10-28T05-46-14-101Z-build-418db169.log`
- unit: `2026-10-28T05-46-22-974Z-test-0b7f91c6.log`
- E2E: `2026-10-28T05-46-50-380Z-test-e2e-bd47e9a8.log`

manifestとPlaywright report/traceはvalidationの `output/r5-run-history/attempt-01/` へ保存した。

harnessのみ修正した固定commit `51ff1727742a9d0510c50b380c297dd83af159cb` で該当試験は単独1/1 PASS（`2026-10-28T05-54-10-535Z-test-e2e-bd7684dd.log`）。この単独成功を136件へ加算して全件成功にしない。同commitをcleanから全件再実行する。

## 最終の全件固定検証

`51ff1727742a9d0510c50b380c297dd83af159cb`、tree `d03eceb953739c04bd61f3f19990396ffae67ab1`、開始時clean。2026-10-28 14:54:27–15:01:46 JST、build/typecheck PASS、unit499/499 PASS（53 files）、E2E137/137 PASS（Electron109 + Chromium fixture28）、FAIL0/SKIP0。

- build: `2026-10-28T05-54-27-996Z-build-edc7461a.log`
- unit: `2026-10-28T05-54-34-841Z-test-e8ef496d.log`
- E2E: `2026-10-28T05-55-01-836Z-test-e2e-2770be76.log`

生logはvalidation/output/agent-workspace/logs、manifestはvalidation/output/r5-final-verification/manifest.json。過去の成功分との合算はしていない。

同commitの合成デモでも新DB/3行/2ビューを実UIから作成し、再起動とSQLite読戻しに成功（15:01:57 JST）。validation/output/r5-demo/demo-proof.json。デモは全件数へ加算しない。
