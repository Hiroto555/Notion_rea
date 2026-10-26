# Notion比較の固定仕様 — 次ラウンド

実装前の基準: `7759906dbbc905a4dc79d01b97aaff6471e51eb3`。8シナリオを先に固定した。実顧客データ・私的ページを使わない。

参照実測はNOT_RUN。許可されたNotionテスト領域が提示されていないため、ログインや既存ページ操作は行わない。Notion版/OS/言語/テーマ/viewport/ズーム/入力方式はすべてUNKNOWN。Folioの自動試験と比較判定は別列にする。

Folioの条件: macOS、Electron 45、UI日本語、light、1440×960ウィンドウ、zoom 1、Playwrightの実マウス/キーボード。正確な実行環境はvalidation/next-roundへ記録する。合成compositionとinsertTextは物理IMEではない。

同一の合成文書: 「比較用ノート」、本文「不**動**産」「soft**ware**」、リンク先「比較用リンク先」、順序付きの「Alpha」「Bravo」「Charlie」ブロック（太字/見出し/段落）、DB行「Record A」（status未着手、date 2026-10-26、数値123）。実測が可能になった際にNotionにもこの文書を用意する。

| ID | 固定する操作・観測 | 参照根拠 | Folio | Notion実測 | 比較 |
| --- | --- | --- | --- | --- | --- |
| N01 | 同一ページ再選択5回→本文確認→Undo/Redo→Markdown/HTML書き出し。対象/本文/履歴を確認 | INFERRED（状態維持の期待は今回の契約） | NOT_RUN | NOT_RUN | UNKNOWN |
| N02 | 書式をまたぐ「不動産」「software」を全体/ページ内検索。ヒットと選択範囲を確認 | INFERRED（書式境界の検索は未観測） | NOT_RUN | NOT_RUN | UNKNOWN |
| N03 | 太字を含む本文選択→⌘K→リンク確定/取消。ページ・範囲・文言・書式・フォーカスを確認 | DOCUMENTED_REFERENCE: [公式shortcuts](https://www.notion.com/help/keyboard-shortcuts) は選択テキストへのリンクを説明。取消/復帰の細部はINFERRED | NOT_RUN | NOT_RUN | UNKNOWN |
| N04 | /メニュー→上下選択→Enter、別試行でEscape。カーソルと入力継続を確認 | DOCUMENTED_REFERENCE: [公式編集](https://www.notion.com/help/writing-and-editing-basics) のslash、詳細な取消状態はINFERRED | NOT_RUN | NOT_RUN | UNKNOWN |
| N05 | 単一トップレベルブロックをハンドルで移動→Undo/Redo→保存/再起動 | DOCUMENTED_REFERENCE: [公式編集](https://www.notion.com/help/writing-and-editing-basics) のハンドル移動、詳細な境界はINFERRED | NOT_RUN | NOT_RUN | UNKNOWN |
| N06 | Shiftで連続複数選択→先頭/末尾移動、同位置drop、Escape取消、スクロール後の移動。順序/個数/書式を照合 | DOCUMENTED_REFERENCE: [公式shortcuts](https://www.notion.com/help/keyboard-shortcuts) の複数選択。DnD取消はINFERRED | NOT_RUN | NOT_RUN | UNKNOWN |
| N07 | DBレコードを開く→入力→Tab/Shift+Tab周回→Escape→再度開く/再起動。値と復帰先を確認 | INFERRED: [WAI-ARIA modal](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)を操作契約として使用。Notion実装の証拠ではない | NOT_RUN | NOT_RUN | UNKNOWN |
| N08 | 本文/検索/リンクで物理日本語IMEの変換・候補選択・取消・再変換 | UNKNOWN | NOT_RUN | NOT_RUN | UNKNOWN |

N08手動手順: 日本語入力を選び「ふどうさん」を入力、Spaceで候補変更、Enterで確定。再変換・候補中Escapeを実施。本文の欠落/二重挿入、検索/リンクの意図しない確定/閉鎖を確認。各入力欄で繰り返し、OS/IME版・キー・画面・保存結果・観測者を記入する。観測欄: 未実施。

OBSERVED_REFERENCE=実Notionの観測、DOCUMENTED_REFERENCE=公式文書、INFERRED=推定した局所契約、UNKNOWN=根拠なし。公式資料は2026-10-26取得。MATCHは同条件の実測がある場合に限る。今回の表は実行後にFolio列と証拠を追記する。
