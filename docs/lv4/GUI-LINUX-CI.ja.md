# 操作中のMacを使わないGUI試験

2026-11-08。利用者の指示により、GUI試験の実行先をGitHub-hosted Linuxの仮想画面へ分ける。このMacではElectron/ブラウザ/OS clipboard/native dialogを起動しない。統合ツリーと合成一時データを使用し、masterへマージせず、A3以降の製品実装は開始しない。

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

初回はallowlistで範囲を固定する。残りの既存GUI suite（ページツリーの実dragを含む）は未移植・未実行のまま記録し、Mac固有という理由に置き換えない。初回42件の合格を全GUI suiteの合格と呼ばない。

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

HTML/JSONレポートと失敗時trace、合成データのスクリーンショットは`output/playwright-linux/`だけをartifactへ保存し、保持は7日。workspace DBやprofileをまとめてuploadしない。通常のMacでreportを自動で開かない。最終結果は本資料とPRへ追記する。

公式根拠：[ElectronのXvfb試験](https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci)、[Playwright CI](https://playwright.dev/docs/ci)。この構成は試験実行先の変更であり、Lv4完成やMac GUI合格の宣言ではない。
