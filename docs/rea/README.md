# REA解析・共有用証拠

原本から必要なフィールドを選択し、端末固有情報を置換した資料です。REAの生応答そのものではありません。原本は `research/evidence/` にローカル保持し、この共有ツリーから除外しています。原本SHA-256は後日照合するための識別子であり、原本未提供の読者が内容すべてを検証できるという意味ではありません。

| 資料                                                           | 内容                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------ |
| [EVIDENCE](EVIDENCE.md)                                        | VERIFIED / OBSERVED / INFERRED / UNKNOWN、許諾と解析の境界   |
| [environment](evidence/environment.json)                       | OS/Node/依存版、project pathをプレースホルダーに置換         |
| [mcp-capabilities](evidence/mcp-capabilities.json)             | 実際に列挙された229ツールと使用した3機能                     |
| [notion-desktop-summary](evidence/notion-desktop-summary.json) | 300エントリ・9ヘッダー・684bytes、Electron候補、部分coverage |
| [public-help-summary](evidence/public-help-summary.json)       | 公式公開ヘルプのcapture ID・方式・制約。HTML/AX本文は省略    |
| [UI観察](notion-ui-observation.md)                             | 内容を転記しないネイティブ画面の役割観察メモ                 |
| [folio-static-summary](evidence/folio-static-summary.json)     | 自作main/preloadのbridge・IPC解析。静的な部分解析            |
| [FINDINGS](FINDINGS.md) / [COMPARISON](COMPARISON.md)          | 構造上の結論と独立実装への変換、比較未完了の範囲             |

端末のユーザー名・絶対project path、inode/device識別情報、原本MCPの重複テキスト、公開ページのHTML・スクリプト断片・画像は共有版に含めていません。NotionのASAR内容は調査時にも抽出していません。

REA接続の診断と再現は [MCP-CONNECTION](../MCP-CONNECTION.md)。原本がある作業環境で `node scripts/prepare-review-evidence.mjs` を実行すると派生JSON・匿名化テストログ・画面コピーを再生成します。このスクリプトはREAやNotionを起動せず、元の検証manifestとのhash一致を要求します。新しい解析・テストに更新する際は、日時や対象バージョンもレビューしてください。

`complete-within-view` は取得した要約のページング範囲内での完全性です。Notion全体やFolio全コードの解析完了を意味しません。公開ページcaptureの `complete` も指定したcapture種別の範囲です。
