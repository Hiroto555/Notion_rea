# Notion 比較マトリクス（Research）

公開資料と Folio の自動試験を分離して記録する。参照実測は **NOT_RUN**、比較判定は全件 **UNKNOWN**。公式資料を読んだだけでは MATCH にしない。

- 正本データ: [parity-matrix.json](parity-matrix.json)
- 取得資料と日付: [references.md](references.md)
- 実行手順: [procedures.md](procedures.md)
- 優先順位・差分候補: [priorities.md](priorities.md)
- 未解決: [unresolved.md](unresolved.md)
- 環境・fixture: [environment.json](environment.json)
- 実行検証: [verification.json](verification.json)

## 4列の意味

| 列 | 意味 | 現在の状態 |
| --- | --- | --- |
| Folio 試験 | Folio の自動回帰（既存記録。今回の再実行は環境要因で NOT_RUN）。PASS/PARTIAL/FAIL/NOT_RUN | 既存記録は N01〜N07 PASS、N08 NOT_RUN、N09 PARTIAL。今回の実行は全件 NOT_RUN |
| 参照実測 | 許可済み Notion テスト領域での観測。OBSERVED のみ比較に使える | 全件 NOT_RUN |
| 公式文書 | 公開資料の記述（DOCUMENTED_REFERENCE）、設計契約からの推定（INFERRED）、根拠なし（UNKNOWN） | 資料の細部不足を明記 |
| 比較判定 | 同一 fixture・環境・入力方式での一致/差分。MATCH/DIFF/UNKNOWN | 全件 UNKNOWN |

Folio の PASS は Folio の自動試験が通ったという意味だけであり、Notion との一致を意味しない。Notion の MATCH は、参照実測・同一 fixture・同一環境の3条件が揃ったときだけ記録する。

今回の parity E2E（2026-10-27）は、Harness の workspace-write sandbox で Chromium の sandbox を初期化できず、アプリが `.page-title` を表示する前に終了した。14件すべてが起動待ちで失敗し、アプリのアサーションには到達していない。Folio の既存記録は保持し、今回の実行を PASS とも FAIL とも扱わない（NOT_RUN）。詳細とログ hash は [evidence/parity-e2e-attempt.json](evidence/parity-e2e-attempt.json)。

## マトリクス

| ID | 操作 | Folio 試験 | 参照実測 | 公式文書 | 比較判定 |
| --- | --- | --- | --- | --- | --- |
| N01 | 同一ページ再選択5回→本文→Undo/Redo→Markdown/HTML | PASS（F01、既存記録。今回再実行は環境要因でNOT_RUN） | NOT_RUN | INFERRED（公式記述なし） | UNKNOWN |
| N02 | 書式境界の「不動産」「software」を全体/ページ内検索 | PASS（F02、既存記録。今回再実行は環境要因でNOT_RUN） | NOT_RUN | DOCUMENTED_REFERENCE（検索入口のみ） | UNKNOWN |
| N03 | 太字選択→⌘K→リンク確定/取消、範囲・書式・フォーカス | PASS（R3 link/stale、既存記録。今回再実行は環境要因でNOT_RUN） | NOT_RUN | DOCUMENTED_REFERENCE（⌘K追加のみ） | UNKNOWN |
| N04 | /メニュー→上下選択→Enter、別試行でEscape | PASS（N04 slash、既存記録。今回再実行は環境要因でNOT_RUN） | NOT_RUN | DOCUMENTED_REFERENCE（メニューのみ） | UNKNOWN |
| N05 | 単一ブロックをハンドル移動→Undo/Redo→再起動 | PASS（R2 short/matrix、既存記録。今回再実行は環境要因でNOT_RUN） | NOT_RUN | DOCUMENTED_REFERENCE（ハンドルのみ） | UNKNOWN |
| N06 | Shift複数選択→境界移動・同位置・Escape・スクロール | PASS（R2 matrix、既存記録。今回再実行は環境要因でNOT_RUN） | NOT_RUN | DOCUMENTED_REFERENCE（複数選択の存在） | UNKNOWN |
| N07 | DBレコード開く→入力→Tab周回→Escape→再起動 | PASS（R3 DB/modal/native、既存記録。今回再実行は環境要因でNOT_RUN） | NOT_RUN | INFERRED（WAI-ARIA契約） | UNKNOWN |
| N08 | 本文/検索/リンクで物理日本語IMEの変換・候補・取消・再変換 | NOT_RUN（合成compositionは補助） | NOT_RUN | UNKNOWN（英語/QWERTY注記のみ） | UNKNOWN |
| N09 | SourceをTarget内へ→兄弟順→ルートへ戻す | PARTIAL（既知のF11 FAILを含む。今回再実行は環境要因でNOT_RUN） | NOT_RUN | DOCUMENTED_REFERENCE（再編成のみ） | UNKNOWN |

## シナリオ別の要点

### N01 再選択と履歴

- Folio: `tests/e2e/gate-a.spec.ts` の F01。エディタ DOM の同一性、本文、添付、リンク、Markdown/HTML 出力、Undo/Redo を自動確認。
- 公式: 再選択時の状態維持・履歴・書き出しを説明する資料は取得範囲で確認できない（INFERRED）。
- 比較: 6条件（同じページ、同じ編集、同じ Undo/Redo、同じ書き出し形式、同じ環境、同じ入力）が揃うまで UNKNOWN。差分候補 H1。

### N02 書式境界の検索

- Folio: F02。「不」+太字「動」+「産」、hardBreak、「soft」+リンク「ware」で、全体検索・ページ内検索の件数と選択範囲を確認。
- 公式: [Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)（2026-10-27取得）は `⌘/Ctrl+F` のページ内検索と `⌘/Ctrl+K` の検索を示すが、書式境界の一致規則は示さない。
- 比較: 検索語の選択範囲とヒット件数を両側で記録するまで UNKNOWN。差分候補 H6。

### N03 リンクの確定/取消

- Folio: `tests/e2e/dialogs.spec.ts` の selected text link / stale link。取消で文書と正確な選択範囲・太字が戻り、確定後も書式が残ることを確認。
- 公式: 同資料は選択テキストへの `⌘/Ctrl+K` リンク追加を説明する。取消時の範囲復帰・フォーカスは記述なし。
- 比較: Notion の取消結果を観測するまで UNKNOWN。差分候補 H2。

### N04 slash メニュー

- Folio: `N04 slash arrow/confirm/cancel`。`/heading` の確定、`/todo` の Escape 取消、文書・カーソル不変を確認。
- 公式: [Intro to writing & editing](https://www.notion.com/help/writing-and-editing-basics)（2026-10-27取得）は `/` メニューとコマンドを説明するが、矢印/Enter/Escape の処理は説明しない。
- 比較: 未観測のため UNKNOWN。差分候補 H3。

### N05 / N06 ブロック移動

- Folio: `tests/e2e/drag.spec.ts` の short original と top-level matrix。実マウスの dragstart/drop、移動、同位置、Escape 取消、スクロール、Undo/Redo、再起動を確認。
- 公式: [Intro to writing & editing](https://www.notion.com/help/writing-and-editing-basics)（2026-10-27取得）は ⋮⋮ のドラッグ移動を、[Navigate Notion with the sidebar](https://www.notion.com/help/navigate-with-the-sidebar)（2026-10-27取得）はページのドラッグ再編成を説明する。ドロップ境界・取消・複数選択の詳細は未記載。
- 比較: 未観測のため UNKNOWN。差分候補 H4。

### N07 DB モーダル

- Folio: DB Escape、検索/リンク/レコードの初期フォーカス・Tab 循環・背景不活性、ネイティブ UI の Escape を確認。
- 公式: [WAI-ARIA Dialog (Modal) Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)（2026-10-27取得）を観測項目の設計契約として使用。Notion の実装証拠ではない。
- 比較: Notion 実測がないため UNKNOWN。差分候補 H5。

### N08 物理日本語 IME

- 状態: **NOT_RUN**。合成 composition は補助証拠であり、物理 IME の変換・候補選択・取消・再変換を代替しない。
- 公式: [Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)（2026-10-27取得）は説明が英語/QWERTY 向けで、国際化は roadmap と明記する。日本語 IME の挙動は未記載。
- 比較: 両側の物理 IME 実測が揃うまで UNKNOWN。差分候補 H7、未解決 U03/U08。

### N09 ページツリー移動

- Folio: `tests/e2e/page-move.spec.ts` の3ケース。既存の全体 E2E では F11 が FAIL し、原因未特定。1回の PASS で既知の間欠失敗を消さない。
- 公式: [Navigate Notion with the sidebar](https://www.notion.com/help/navigate-with-the-sidebar) と [Create a subpage](https://www.notion.com/help/create-a-subpage)（いずれも 2026-10-27取得）は、ページのドラッグ再編成と親の内外への移動を説明する。ドロップ領域・選択・フォーカス・取消は未記載。
- 比較: Folio 側の状態が整理されるまで UNKNOWN。差分候補 H8、未解決 U04。

## MATCH にしない条件

次のいずれかに該当する場合は UNKNOWN または NOT_RUN とする。

- 参照実測がない、または OBSERVED でない。
- 片側だけ別の fixture・seed を使っている。
- Notion の版・OS・言語・theme・viewport・zoom・入力方式のいずれかが UNKNOWN。
- 物理 IME を合成 composition や insertText で代用している。
- 公式資料に書かれているという理由だけで一致を主張している。
- Folio 側に既知の FAIL/PARTIAL があり、成功した別試行で置き換えている。

## 更新の手順

1. 実測を実施し、`environment.json` の Notion フィールドと `reference` を OBSERVED に更新する。
2. 同一 fixture の証拠を `evidence/` に追加する。
3. `comparison` と `differences` を更新する。MATCH の場合は一致点と条件を明記する。
4. `node scripts/folio-agent.mjs test` を通す。研究用テストは、根拠のない MATCH や未許可の参照実測を拒否する。
5. 比較判定の変更理由を `verification.json` に記録する。
