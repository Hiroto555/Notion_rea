# ページツリーの実ドラッグをLinux仮想画面で確認する

2026-11-08。利用者の指示で、既存の`tests/e2e/page-move.spec.ts`の3件をLinux GUI CIへ追加する。このMacのElectron/ブラウザ/OS操作は起動しない。統合ツリーの専用ブランチと使い捨て`RUNNER_TEMP`/`FOLIO_DATA_DIR`を使い、master・実データ・M1保存版を変更しない。A3以降の実装は行わない。

## 追加する受入

| 既存試験 | 確認する操作と終了条件 |
|---|---|
| edited source becomes target child | 本文を編集・保存したページを実ポインタで別ページの子へ移動。本文・子孫・IDを保持し、再起動後も同じ階層・順序 |
| delayed load preserves local edit | 移動メニューで子孫を対象から除外。移動後のload応答を保留した間の題名編集が、応答解放・保存・再起動でも残る |
| order, root, cancellation and cycle rejection | inside/before/after、展開した枝の後ろ、Escape取消しと表示解除、最上位への移動を実ポインタで確認。循環指定は製品のmove IPCで拒否し、再起動後も階層・順序が同値 |

既存の42件も維持し、合計45件/8ファイルを1 worker・retry 0で実行する。うち製品Electron/実IPCは17件、同期の代替応答表示2件、Chromium表示26件。ドラッグ開始・dropはブラウザの`isTrusted`がtrueのイベントを観測し、synthetic drag/dropのdispatchや製品handlerの直接呼出しで置き換えない。

## 不成立・失敗時の証拠

各ドラッグのattempt IDとcaptureしたpointer/dragイベント、実ヒット要素、座標、接続状態、focus、defaultPrevented、DataTransferの型とdrop時のpage IDを保持する。複数の試行を上書きせず、`drag-events.json`へまとめる。実move/save/load IPCの応答、画面trace、前後の文書・階層を合成データだけで保存する。load保留の試験は専用のIPC/renderer journalも残す。

`dragstart`不成立を無条件retryやskipで合格にしない。対象の取り違え、fixtureのデータ形式、実DOMのイベント処理、保存・復旧の問題を証拠で分けて修正する。MacでのGUI再現へ切り替えない。

ローカルで行える一覧確認（実行ではない）：

```sh
npm run test:e2e -- --list --config playwright.linux-ci.config.ts
```

本実行はGitHubの新しいDraft PRの`gui-linux-xvfb` Checksで確認する。実行結果と対象headは確認後に記録する。Mac固有の実IME・Cmd+Q・native dialog・物理2台の状態は[別枠のNOT_RUN](GUI-MAC-ACCEPTANCE.ja.md)を維持する。Linuxでの合格だけでLv4認定は行わない。
