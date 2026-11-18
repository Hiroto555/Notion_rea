# Sol XHigh：M1安全性レビュー記録

2026-11-08。Codexの独立subagent `m1_plan_safety`（Sol XHigh）へ依頼したread-onlyレビューの受領内容と、Codexによる処置を記録する。Solは製品コード・試験・GUIを実行/変更していない。試験結果は[親の完了記録](../../M1-COMPLETION.ja.md)と[quietログ](../../validation/m1-quiet.txt)に分ける。

| 段階 | 候補・結果 |
|---|---|
| S0 | `04e46c5`のG0契約・共通境界を確認し、実装の進行を可とした |
| S1 | 取消しのID固定、消費根拠の不一致、結果不明からの完成検査、例外時の保全先保持、cold状態での操作到達、catalogの不明snapshot再利用拒否を指摘。Codexが修正 |
| S1再確認 | unknown→正規INCOMPLETEの再判定、16件cacheのevict/処理中Promise喪失をP1として指摘。Codexが再判定と非evict・同じPromiseの保持へ変更 |
| S2初回 | `f714164`を確認。host成功後のIPC応答喪失を出力前拒否と区別できず、UIが新規操作IDへ移れるP1を発見 |
| S2最終 | `d509edff574fc1f40e1bbdb93cbb5d45176f683b`とsrc/tests treeの一致を確認。**未解決P0/P1なし**。同候補quiet PASSと証拠が揃えばM1非GUI区切りで終了可 |

## 最終差戻しの処置

[bridge](../../../../src/renderer/conflict-recovery-port.ts)は、効果の前に操作ID/target/modeを保持し、応答喪失・未確認statusの間は新効果を拒否する。[model](../../../../src/renderer/conflict-recovery-model.ts)は出力pathが不明でも未解決requestを保持する。[Panel](../../../../src/renderer/WorkspaceConflictRecoveryPanel.tsx)は再mountで同じcontextを取り込み、同一要求を再照会する。成功はhash/modeと、既知ならdirectoryの一致を要求する。

独立した[応答喪失試験](../../../../tests/m1-recovery-response-loss.test.ts)で、host成功→IPC応答喪失→部品再生成→同ID照会→効果1回、pending/not-found/照会失敗時の保持、既知path不一致の拒否を確認した。これはGUI試験ではなく、Nodeのmock IPCとpure modelの試験。

Solはさらに、通常予約の同一COMMIT、競合予約との排他、原本外fresh出力、FD/nlink/hash検査、新規v4 DBの内容11表、禁止情報の不在、復元後の同期保留、前回S1指摘の解消と独立試験の対応をソースで確認した。

## 終了判定に残す制約

main session内16件の回収IDと、再起動を越えるSQLite予約は別物。添付不足を完全bundle/復元成功にしない。旧sidecarと同期保留markerの解除、A3以降は対象外。任意の同一UID改竄全般の防御は主張しない。GUI・実IPC・実IME・物理2台はNOT_RUN、LevelはLv3を維持する。

最終src tree：`378c75ce5f86f7d2feb5ec462bac1d84ee622a94`。tests tree：`b4a510df8fbb59d838099a8fab46462496165dba`。後続の文書保存でこの実装は変更しない。
