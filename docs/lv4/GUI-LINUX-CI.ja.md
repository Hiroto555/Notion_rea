# 操作中のMacを使わないGUI試験

2026-11-08。利用者の指示により、GUI試験の実行先をGitHub-hosted Linuxの仮想画面へ分ける。このMacではElectron/ブラウザ/OS clipboard/native dialogを起動しない。統合ツリーと合成一時データを使用し、masterへマージせず、A3以降の製品実装は開始しない。

**現在：Linux GUI 45件すべてPASS（skip 0、retry 0、1 worker）。** ページツリーの追加3件を含む候補`aa81a9e`の[GUI run #5](https://github.com/Hiroto555/Notion_rea/actions/runs/42437077556)と[quiet-checks](https://github.com/Hiroto555/Notion_rea/actions/runs/42437077487)が合格した。非GUIは181ファイル／1,678テスト・型検査・build PASS。[ページツリーの範囲・初回失敗・証拠](GUI-PAGE-TREE-CI.ja.md)、[今回の抜粋ログ](validation/page-tree-gui-linux-20261108.txt)を参照。Mac固有・残りの未移植suiteは未確認のまま残す。

## 実行の境界

| 区分 | 場所・入口 | 扱う証拠 |
|---|---|---|
| 通常の非GUI検証 | MacまたはCI、`npm run verify:quiet` | 型検査、Node/SQLite試験、build。GUIを起動しない |
| Linux GUI実行 | GitHub Actions、`gui-linux-xvfb` workflow | Xvfb内で実Electron/実IPCとChromiumの表示試験を実行。普段のMacにウィンドウや入力を送らない |
| Macでのローカル確認 | テスト一覧の`--list`だけ | GUI合格の証拠にはしない。新しいCI入口はmacOSならopt-inがあっても起動前に拒否 |
| Mac/OS固有 | 別途の明示指示と専用環境 | 下表の項目を独立に受入。Linuxの合格で代替しない |

`.github/workflows/gui-linux.yml`はPRで実行する。`ubuntu-24.04`/Node24、固定SHAのcheckout/setup-node/upload-artifactを使い、権限は`contents: read`だけ。依存をlockfileで導入してbuildした後、Xvfb・専用D-Bus・Openbox上で`scripts/run-linux-gui-ci.mjs`を実行する。

launcherはLinux/GitHub Actions/CI/専用DISPLAYを検査してから、一時`RUNNER_TEMP`下にfreshな試験領域を作り、既存の`npm run test:e2e:batch`を経由する。既存のGUI既定拒否は変更しない。試験先のworkspace/profileは一時領域で、親からの同期資格情報・接続設定・データ保存先・dev URLを引き継がない。Linux Electronの`--no-sandbox`はこの合成データ用CI fixtureだけに限定し、製品設定には追加しない。実データを試験入力にしない。

## 初回の対象（42件・7ファイル）

| project | 件数 | 内容・代替したもの |
|---|---:|---|
| `electron-linux-real-ipc` | 14 | 新規M1の10件、既存の並び順修復3件、出力境界1件。製品main/preload/rendererと実IPC/SQLite/filesystemを通す。native pickerの返却だけはfixtureで固定 |
| `electron-linux-presentation-mocked` | 2 | 既存の競合比較・通常予約表示。同期backendの返却はmock。実同期・durable予約の証拠にはしない |
| `chromium-presentation-mocked` | 26 | DB UI・legacy/read-only表示、編集、キーボード、ACK/競合表示、画面幅・dark theme。callback型の合成harnessで、製品IPCの証拠にはしない |

M1の10件は、未接続の一覧・破損行・pagination/Escape、JSONのみ、添付付きbundle、新規v4復元と回収先再起動後の同期保留、picker取消し、添付欠損の未完了保持、原本内出力の拒否、picker待ちの対象変化、host成功後のIPC応答喪失と同ID再照会、通常保存後のElectron再起動を確認する。OS dialogの見た目や実入力機器を通す試験ではない。

allowlistで範囲を固定する。初回42件の後、`page-move.spec.ts`の3件を実Electron/実IPCへ追加し、現在は実IPC17件＋代替応答Electron表示2件＋Chromium表示26件の計45件・8ファイル。ページツリーの実dragと移動中編集・再起動はLinuxでPASSした。残りの未移植suiteをMac専用とは判定せず、45件の合格を全GUI suiteの合格とは呼ばない。初回42件の[実行記録](validation/gui-linux-20261108.txt)は履歴として保持する。

## Mac固有・実機の別枠

| 対象 | 状態・必要な確認 |
|---|---|
| Cmd+Q、赤ボタン、Dock/app activate、終了拒否と再表示 | NOT_RUN。Linuxのapp.close/restartとは別に確認 |
| 実IME・日本語変換・数値入力途中 | NOT_RUN。Playwrightの入力やsynthetic compositionで代替しない |
| native picker、キャンセル/選び直し、OS権限 | NOT_RUN。CIでは返却を代替し、実ダイアログの合格にはしない |
| macOS clipboard、Keychain/safeStorage | NOT_RUN。共有clipboardを操作せず、製品未接続の部品を完成扱いしない |
| 物理Mac2台・実トンネル・スリープ等 | NOT_RUN。Linux合成環境と分ける |

## 実行と結果の読み方

ローカルで許可されるのは以下の**一覧確認だけ**。Electron/Chromiumは起動しない。

```sh
npm run test:e2e -- --list --config playwright.linux-ci.config.ts
```

GUIの本実行はGitHub上のPRのChecksを参照する。`gui-linux-xvfb`の成功、件数、skip/retryの有無、対象headを確認する。失敗はassertion・fixture・環境導入に分けて調べ、未実行をPASSにしたり、失敗を自動skipへ変更したりしない。

HTML/JSONレポートと失敗時trace、合成データのスクリーンショットは`output/playwright-linux/`だけをartifactへ保存し、保持は7日。workspace DBやprofileをまとめてuploadしない。通常のMacでreportを自動で開かない。今回の実行結果は[Draft PR #10](https://github.com/Hiroto555/Notion_rea/pull/10)のChecksでも確認できる（baseは初回CIのPR #9、masterへはマージしない）。

公式根拠：[ElectronのXvfb試験](https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci)、[Playwright CI](https://playwright.dev/docs/ci)。この構成は試験実行先の変更であり、Lv4完成やMac GUI合格の宣言ではない。

## ローカルの準備確認

初回候補`2702eb8`の非GUI一括検証は型検査・181ファイル／1,678テスト・buildがPASS。CI専用対象の`--list`は42件を列挙しただけで、GUI成功とは扱わない。Mac上のGUIはNOT_RUN。GUIの証拠は上記GitHubの本実行。

## 初回CIで見つかった試験側の不整合

[GUI run #1](https://github.com/Hiroto555/Notion_rea/actions/runs/42394940426)は**37件PASS・5件FAIL**。失敗をskip/retryで隠さず、以下の準備・指定を修正して同じ42件を再実行する。

- 回収先の再起動では同期保留表示も`.save-state`を使うため、保存状態のlocatorを`[data-state]`付きへ限定する。保存済みの期待値は維持する。
- 既存の並び順修復3件は、fixtureのSQLite `json_set`が位置を`4.0`のように書き、原本のバイト再現性検査で正しく拒否されていた。Node/一時SQLiteで拒否を再現し、旧JS writerと同じ`JSON.stringify`のbytesで同順位を作るようfixtureを修正する。製品の安全検査は変更しない。
- 予約表示fixtureは、現在の取消しボタン名とUUID付き予約IDへ揃える。backendをmockする表示試験という区分は維持する。

同候補の[GitHub quiet-checks](https://github.com/Hiroto555/Notion_rea/actions/runs/42394940256)はPASS。製品ソースを変更せず、修正候補の型検査・対象Node試験を通してからGUI全件を再実行する。

## 初回42件の終了状態

42/42がPASS。元masterとM1保存ブランチを変更せず、`codex/folio-gui-ci-20261108`へ保存した。製品src treeはM1と同じ`378c75ce5f86f7d2feb5ec462bac1d84ee622a94`。実行候補のtests treeは`64a7dadc3861c9f1c8d08e5bb327e51c0a247932`、scripts treeは`dacc55ea5e9661cf205b61ab46d0cb252e687c5e`、workflow treeは`e2b1d74ffbc8fb93dc0c985a93f3d3c0fc11f665`。後続の文書保存でこの実装・試験・実行定義は変更しない。LevelはLv3、A3未着手のまま停止する。
