# REA Evidence report — 2026-10-26

## 分類

- VERIFIED: 実際のコマンド/解析結果で確認した、その範囲の事実。
- OBSERVED: 実行中のUIまたはブラウザーで確認した動作/表示。
- INFERRED: 限定した根拠による候補。実際の実装・実行を断定しない。
- UNKNOWN: 未確認。自作アプリの設計で代用しない。

## 証拠一覧

| ID        | 分類                 | 内容                                                                                                                 | 証拠                                             |
| --------- | -------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| ENV-01    | VERIFIED             | 空のGit作業ツリー、macOS arm64、Node/Notion/開発依存の版                                                             | evidence/environment.json                        |
| MCP-01    | VERIFIED             | MCP handshake、tools/list 229件                                                                                      | tools/rea/client.mjs、evidence/rea-tools.json    |
| NOTION-01 | VERIFIED             | REAがNotionの300エントリ、9ヘッダー、684bytesを読み取った                                                            | evidence/rea-inspect_desktop_application.json    |
| NOTION-02 | INFERRED             | app.asar配置を根拠とするElectron候補                                                                                 | 同上。REAのconfidence=inferred                   |
| DOC-01    | OBSERVED             | 公開編集ヘルプをREAの隔離ブラウザーで表示し、DOM/AX取得                                                              | evidence/rea-capture_browser_scenario.json       |
| UI-01     | OBSERVED             | Notionネイティブ画面のAXにサイドバートグル、戻る/進む、タブバー、別のページWebコンテンツ、見出し/引用/表の役割を確認 | evidence/notion-ui-observation.md                |
| FOLIO-01  | VERIFIED（静的限定） | REAがFolioのmain/preloadからcontext bridge APIと対応IPC送受信を抽出                                                  | evidence/rea-analyze_javascript_application.json |
| FOLIO-02  | OBSERVED             | 自作Electronの編集、永続化、再起動、DB等                                                                             | tests/e2e/desktop.spec.ts、output/e2e-tests.log  |

### Notionローカル調査

操作は `inspect_desktop_application`、path `/Applications/Notion.app`、max_entries=300、max_probe_bytes=4096。
親Evidence: `ev_efdcce9e825a3428cf20cc3fd037db397946581caeae55ab79e13f56db904b60`。
要約Evidence: `ev_723df25edd39242b27abd4305a93a7e4e4367ea265979f92e1b219a30fd29a89`。
保持範囲digest: `31bfaa2304f39457eef21b767079fc9454027625332d18274ba475d13372ddb0`。

このdigestは完全なアプリ全バイトのハッシュではない。走査は300件の上限に達した。symlinkは追跡せず、元ファイルは変更していない。`Contents/Resources/app.asar`を検出したが、内容を抽出・解析していない。候補からElectronの実行状態、Main/Rendererの役割、データモデルを断定していない。

### 公開ヘルプ観察

Evidence: `ev_615aba6cf5debae7836bc23bd5fec3e0173d996eb177586697f43cbabfe45133`。
REA `capture_browser_scenario`、公式公開URL、headless Chromium、空の初期storage。URL/DOM/accessibilityを取得し、所有したブラウザープロセスはREAが終了した。Notionアカウントのcookie・認証情報を渡していない。

公開ヘルプが説明するハンドル操作、スラッシュメニュー、複製・移動・削除を仕様項目へ変換した。これはNotionの内部コードの発見ではなく、公開UI仕様の確認である。

### 自作アプリ解析

main.cjsとpreload.cjsを選択。初回は応答の10MiB上限で失敗（rea-folio-response-budget-error.json）。`detail:"summary"`で再取得成功。パース失敗なし、context bridge 1、露出APIメンバー1、literal IPC channel 1、対応する送信とhandlerを抽出した。ただし制限付き解析なのでBrowserWindow抽出数0をウィンドウ不在と解釈しない。runtimeのsandbox/contextIsolationは別途Electron実機テストで確認する。

各証拠の対象digestはJSON中にある。ビルド変更後のEvidenceが必要なときは同じスクリプトで再生成する。以前の解析を新ビルドの証明として扱わない。

## 許諾・ライセンス

ユーザーが依頼した範囲のインストールメタデータ読み取りと、公開ドキュメント/表示中UIの観察を実施。現行の利用契約と非公開コード抽出の許諾を確定できていない。公式terms入口はJavaScriptアプリへ転送され、検索で見つかったPersonal Use Termsは2024年にdeprecatedと表示されたため現行契約とは扱わなかった。したがって深い抽出を許可済みと推定していない。

ASAR抽出・デコンパイル・認証回避・暗号化解除・private API利用・Notion既存データの変更・保護素材の流用は行っていない。深い解析を進める前に、適用契約・許諾範囲を確認する必要がある。これはREA未接続による技術的停止ではない。

## UNKNOWN

NotionのMain/Preload/IPC実装、内部ブロックIDとトランザクションモデル、検索インデックス、永続化・キャッシュ・同期、画像管理、編集の詳細なIME挙動、タブ間状態管理。FolioのSQLite、Tiptap、revision、バックアップ方式は独立設計であり、Notion内部解析結果ではない。

## 一次資料

- [REA公式](https://github.com/morluto/rea)
- [REAセットアップ](https://github.com/morluto/rea/blob/main/docs/installation.md)
- [Notion編集の基本](https://www.notion.com/help/writing-and-editing-basics)
- [Notionキーボード操作](https://www.notion.com/help/keyboard-shortcuts)
- [Notionサイドバー](https://www.notion.com/help/navigate-with-the-sidebar)
- [Notion terms入口](https://www.notion.com/terms)
