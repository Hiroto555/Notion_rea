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

## 初回の結果と試験の修正

候補`7701a8c`の[GUI run #4](https://github.com/Hiroto555/Notion_rea/actions/runs/42436558051)は44 PASS / 1 FAIL、retry 0。実ポインタの2件はPASSしたが、load保留中の題名編集を確認するF11が旧題名を読み取り失敗した。[quiet-checks](https://github.com/Hiroto555/Notion_rea/actions/runs/42436558032)はPASS。

artifactの`f11-journal.json`では、`fill`の呼出し後にも題名のinputイベントと`save:commit`が一度も発生せず、move/loadだけが記録された。製品による入力消失とは判定しない。mainのload保留はReactによるnative modalの終了より早く観測されうるため、試験を次の条件へ補強する。

- 移動dialogが閉じ、題名を実クリックしてフォーカスできた後に入力する。
- trusted inputイベント、入力後の値、loadが未解放であること、保存中表示を確認してから応答を解放する。
- 新題名を含む実`save:commit`の結果と保存済み表示を確認し、実loadと再起動後の状態も照合する。
- 文書の比較基準は、storageによるblock ID等の正規化後の移動前文書に揃える。ID・本文・子孫・順序の保持を引き続き検査する。

製品`src`は変更せず、assertionの削除・skip・自動retryも行わない。修正後も既存42件を含む45件を再実行する。
