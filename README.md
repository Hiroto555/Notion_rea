# Folio

ローカルで書き、ページを整理する、独立したElectronデスクトップアプリ。
Notionのコード・ロゴ・イラストを使用していません。Notionとの提携はありません。

> 現段階は実際に利用できる開発版です。依頼全体の完成、Notionとの完全互換、内部解析完了を意味しません。検証範囲と未完成機能は [機能一覧](docs/FEATURES.md) を参照してください。

## 起動

macOS Apple Silicon / Node.js 24で検証。

```sh
npm ci
npm run setup         # Electronバイナリが未取得の場合のみ取得
npm run build
npm start
```

開発時は `npm run dev`。ビルド済みアプリは `release/Folio-darwin-arm64/Folio.app`。
署名・公証はしていません。このフォルダ内で起動する開発用成果物です。

```sh
npm test              # SQLite・階層・編集・データベースの単体テスト
npm run test:e2e      # 実Electronの操作・保存・再起動テスト（先にbuild）
npm run check        # TypeScript strict
npm run package      # macOS arm64アプリを作成
```

E2Eテストは専用データを作成し、終了時にそのデータのみ削除します。クリップボードテストは一時的にサンプルを書き込み、テスト開始時の内容を復元します。実行中に他のアプリでコピーしないでください。最初の開発試行で復元APIの差異による失敗があったことは進捗記録に残しています。

## 基本操作

- 左側でページ作成・展開。ページを別ページにドロップすると入れ子、行の上端へドロップするとその前へ移動。最下部「ページを追加」へドロップすると最上位へ。
- `⌘N` 新規、`⌘K / ⌘P` 全文検索、`⌘F` ページ内検索、`⌘\\` サイドバー、`⌘⇧L` テーマ、`⌘[ / ⌘]` 戻る・進む。
- 本文で `/` → 矢印キーとEnterでブロック選択。`# ` 見出し、`- ` 箇条書き、`[] ` To-do、`> ` トグル、`| ` 引用。`⌘B` 太字、`⌘I` 斜体。
- 本文左のハンドルでブロック選択、Shiftクリックで範囲選択、ドラッグで並べ替え。選択後のボタンで上下移動・複製・削除。Undo/Redo対応。
- ページメニューから複製・移動・ゴミ箱・書き出し・履歴・バックアップ。
- テンプレートまたは検索パレットからデータベース作成。行・プロパティを編集し、表・ボード・カレンダー・ギャラリーで表示。
- リンクボタンから別ページへリンクすると、リンク先にバックリンクが表示されます。

## データ

通常起動はプロジェクト直下 `.folio-data/workspace.sqlite`。添付は `.folio-data/assets/`。
ビルド済みアプリは `release/.folio-data/` に保存します。開発用とは別ワークスペースです。
`FOLIO_DATA_DIR=/absolute/path npm start` で明示的に切り替えられます。

保存表示が「保存済み」になってから終了してください。保存待ちがある場合はウィンドウの終了を止めます。保存失敗は赤い通知に表示されます。失敗した変更はメモリに保持され、保存の再試行ができます。「退避して再読込」は未保存内容をJSONに書き出せた場合だけ保存済みデータへ戻ります。強制終了時の復元ジャーナルは未実装です。

「ワークスペースをバックアップ」はSQLiteスナップショットとassetsを `backups/workspace-<timestamp>/` に保存します。復元はアプリを終了し、現在のデータフォルダを別名で退避してから、スナップショットの `workspace.sqlite` と `assets` をデータフォルダへコピーしてください。古い `workspace.sqlite-wal` / `-shm` と混在させないでください。UIからの全体復元は未実装です。

## 調査と引き継ぎ

- [仕様](docs/SPEC.md) / [構成と判断](docs/ARCHITECTURE.md)
- [機能一覧・未完成](docs/FEATURES.md)
- [検証結果](docs/TEST-RESULTS.md)
- [REA Evidenceレポート](research/EVIDENCE.md)
- [REA接続方法](docs/MCP-CONNECTION.md)
- [現在地・次の作業](docs/PROGRESS.md)

REAは `tools/rea/` に隔離してあります。アプリの起動には不要です。CodexのグローバルMCP設定は変更していません。
