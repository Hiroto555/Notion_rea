# REAとCodexの接続

## 実際に使用した経路

Codex → terminal tool → `tools/rea/client.mjs`（公式MCP SDK Client）→ stdio → REA 6.8.0 MCPサーバー。

これはCLIの解析コマンドをMCPと称したものではない。`initialize`、`tools/list`、`tools/call`を実際に使用した。ただしCodex Desktopのネイティブツール一覧へREAを追加したわけではない。ネイティブ登録は未変更。

## 初期原因

- 有効なツール一覧にREAがなく、`.codex/config.toml`のMCPサーバー名にもREAなし。
- プラグイン検索でも該当REAを発見できず（検索は非網羅的）。
- グローバル`rea`コマンドなし。
- Node v24.20.0に対しREA 6.8.0のenginesは `^22.23.4 || ^24.22.1 || >=26.12.1`。

プロジェクト内 `tools/rea/node_modules/node/bin/node` v24.22.1で起動して解消。公式npmパッケージのrepositoryが `morluto/rea` を指すことを確認し、固定バージョンを採用。依存の固定値はtools/rea/package-lock.json。

```sh
npm ci --prefix tools/rea --cache .cache/npm
node tools/rea/client.mjs
node tools/rea/client.mjs inspect_desktop_application \
  '{"path":"/Applications/Notion.app","max_entries":300,"max_probe_bytes":4096}'
```

`rea-tools.json`に229ツールの完全な入力スキーマを記録。MCP接続の成功は全229機能の実行可能性を意味しない。Hopper/Ghidra等のエンジンはインストールしておらず、ネイティブ解析は未検証。

## 任意の将来変更案（未適用）

Codexから直接列挙したい場合、次の登録を `~/.codex/config.toml` へ追加し、Codex再起動が必要になる。このプロジェクトではグローバル設定を変更しない要望に従い実施していない。適用するなら既存設定を保った追記とバックアップを事前レビューする。

```toml
[mcp_servers.rea]
command = "<PROJECT_ROOT>/tools/rea/node_modules/node/bin/node"
args = ["<PROJECT_ROOT>/tools/rea/node_modules/rea-agents/scripts/rea.mjs", "mcp"]
startup_timeout_sec = 30
tool_timeout_sec = 180
```

`<PROJECT_ROOT>` は説明用のプレースホルダーです。TOMLが自動展開する値ではないため、将来登録する場合は各自の絶対パスに置き換えてください。共有資料には端末固有のパスを記載しません。

現在のMCPクライアントで解析可能なので、この設定変更は継続開発の前提条件ではない。

## 診断記録

FolioのJS解析の初回応答が10MiBのstdio予算を超えた。REAは解析結果そのものを切り詰めずエラーを返した。エラーを保存し、公式ツールスキーマの `detail:"summary"` を指定して再取得成功。要約のcoverageはpartialであり、取得成功を全面解析完了とは解釈しない。

[公式リポジトリ](https://github.com/morluto/rea) / [公式インストール手順](https://github.com/morluto/rea/blob/main/docs/installation.md)
