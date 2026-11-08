# 保存・復旧24件のLinux GUI受入

2026-11-08。利用者の実行指示により、[次の区切りの計画](GUI-NEXT-CHECKPOINT.ja.md)に固定した24件・9ファイルを、既存45件と合わせた**69件・17ファイル**で検証する。

作業場所は統合ツリーの`codex/folio-recovery-ci-20261108`、基準`e818fd5`。このMacでElectron/GUIブラウザ/native dialog/OS clipboardを起動しない。GitHub-hosted Ubuntu/Xvfbと専用RUNNER_TEMP/FOLIO_DATA_DIR・合成データを使う。元master・実データ・既存保存ブランチは変更せず、A3以降・masterへのマージには進まない。

## 固定した対象と終了条件

追加はr4-page-save 4件、queued-failure-guard 1件、pending-journal 2件、recovery-race-guard 4件、r6-recovery 8件、r7-data-safetyのraw-input/restart/save-ack/side-full-editor計5件。対象ファイルの完全な表は[計画](GUI-NEXT-CHECKPOINT.ja.md)を参照する。既存45件も維持する。

- 同じ候補で**69/69 PASS、skip 0、retry 0**。実Electron/実IPC41件、代替応答Electron表示2件、Chromium表示26件を区別する。
- 型検査・Node試験・buildがPASS。候補head、件数、失敗と修正、合成データの証拠を記録する。
- 入力消失・誤上書き・二重commit・原本破壊を通過扱いにしない。失敗をskip・自動retry・assertionの弱体化で隠さない。
- 満たしたら停止。本文blockのdrag6件、ほかの回帰152件、Lv4実同期・終了時適用の新規E2E、Mac/実機2台は追加しない。確認済みLevelはLv3のまま。

## CIへの移植

fixtureの一時保存先をRUNNER_TEMPのfresh childへ揃え、親の同期設定・実データ保存先・dev URLを除去する。Linux CIの起動条件を検査し、`--no-sandbox`は当該CIの試験子だけに限定する。localの既定拒否は維持する。

旧fixtureで曖昧だった保存済みlocatorは`.save-state[data-state]`へ限定する。起動に失敗した場合も自分で作った子だけを停止し、試験の終了時と意図的なSIGKILL前にtrace・画面・既存故障注入gateのjournalを保存する。SIGKILL前のdurable checkpoint照合と、同一receipt/operationの検査は維持する。profile/workspace DBをまとめてartifactへ含めない。

picker返却とcompositionは試験で代替している。実OS dialogと物理IMEの合格にはしない。[Mac別枠](GUI-MAC-ACCEPTANCE.ja.md)はNOT_RUN。

ローカルは型検査・隔離条件のNode試験8件がPASS。収集専用`--list`で69件・17ファイルを確認しただけで、本実行の合格とは扱わない。実行結果はGitHubのChecksと合成データのartifactから確認後に追記する。
