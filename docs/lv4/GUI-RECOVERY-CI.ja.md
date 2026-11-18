# 保存・復旧24件のLinux GUI受入

**完了：69/69 PASS、skip/retry/flaky 0。** [GUI #7](https://github.com/Hiroto555/Notion_rea/actions/runs/42447102289)、[quiet-checks #16](https://github.com/Hiroto555/Notion_rea/actions/runs/42447101864)。候補`6b078061670cab27617dedb1c615ea9b246a61eb`で、追加24件は初回のCI実行ですべてPASSした。この保存・復旧の受入を一区切りとして停止する。

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

ローカルは型検査・隔離条件のNode試験8件がPASS。収集専用`--list`で69件・17ファイルを確認しただけで、本実行の合格とは扱わない。本実行の証拠は下記GitHubのChecksと合成データのartifactにある。

## 実行結果と証拠

| 終了条件 | 結果 |
|---|---|
| 固定24件を追加し、既存45件も維持 | **69/69 PASS、17ファイル、1 worker**。レポートで全69件がexpectedStatus=passed、結果1件ずつ、retry=0であることを照合 |
| skip・自動retry・不安定な再試行で通さない | **skipped=0、unexpected=0、flaky=0**。本実行は2.6分。失敗によるCI再実行は不要だった |
| 保存/復旧の期待値・durable checkpoint・receipt照合 | 既存24件のassertionを維持してPASS。遅延/喪失ACK、履歴復元中の入力禁止、先行失敗後の入力保持、SIGKILL後の最新入力・未確定値、破損journal・原本の保護、同一操作の照合を確認 |
| 非GUI | **182ファイル/1,681テスト、型検査・build PASS**。新規3件はfixtureの一時領域、macOS拒否、env除去と起動条件のNode試験 |
| 証拠の保存 | [artifact 13604225980](https://github.com/Hiroto555/Notion_rea/actions/runs/42447102289/artifacts/13604225980)。追加fixture由来のtrace 35本・IPC journal 35本。ZIP内のDBファイル0。保持7日で、固定の[抜粋ログ](validation/recovery-gui-linux-20261108.txt)と[集計](validation/recovery-gui-linux-20261108.json)はrepoへ保存 |
| 作業範囲 | Mac GUIはNOT_RUN。元masterは`e269137`、M1保存ブランチも維持。製品src変更なし、A3未着手、master未マージ |

artifact SHA256は`82b689a91405782fc95e1e1f16c6dcc6e1318395e2a22020ab974c5007364ab4`。レポートには合成composition/pickerの試験が含まれ、Macの実IME/native picker・実機2台は引き続きNOT_RUN。

製品src tree：`378c75ce5f86f7d2feb5ec462bac1d84ee622a94`（M1と同一）。tests tree：`fcf3bcd28710dd2b9da7271623f19f28d4afdf20`、scripts tree：`dacc55ea5e9661cf205b61ab46d0cb252e687c5e`、workflow tree：`0d2d8521d6c33d759bdeb8e95f20caad43bd2df2`。後続は結果文書の保存だけで、これらの実行対象は変更しない。
