# DeepSeek C — Notion比較研究

対象branch `sprint/research`。公式公開資料およびユーザーから権限を明示されたテスト専用領域の観測のみで、Folioとの差分・優先順位・再現可能な操作テストを整備する。成果物は `docs/parallel/research/` と研究専用の小テスト。既存アプリ本体・機能コード・共有型・スキーマ・他担当の文書は変更しない。

`docs/NOTION-PARITY-BASELINE.md` と既存結果を保持し、Folio試験、参照実測、公式文書、比較判定を別列にする。未観測はUNKNOWN、物理IMEはNOT_RUN。資料への直接リンク、取得日、実測のOS・版・言語・theme・viewport・zoom・入力方式・合成fixtureを記録し、文書だけをMATCHにしない。非公開の個人/顧客ページや未公開コード・素材を扱わない。実際に試せる手順と根拠、未解決を残す。

## 共通安全・操作

最初に `docs/parallel/CONTRACTS.md` を読み、現在のbranchとworktreeがこの文書の指定と一致すること、開始時状態を確認する。ユーザーがターミナルを操作する必要はない。下記コマンドはあなた自身が実行する。

- 型検査 `node scripts/folio-agent.mjs check`、単体 `node scripts/folio-agent.mjs test`、ビルド `node scripts/folio-agent.mjs build`、全体E2E `node scripts/folio-agent.mjs test:e2e --retries=0 --reporter=list`。起動 `node scripts/folio-agent.mjs dev`。環境表示 `node scripts/folio-agent.mjs environment`。引数は `npm run` に渡される。出力・終了コードは各 `output/agent-workspace/logs/` に記録される。
- 直接 `npm run dev`、`npm start`、`npx electron`、生のPlaywright等を使わない。ランチャーのデータ/キャッシュ隔離とテスト排他を迂回しない。実データ、ユーザーappData、既存server、他worktree、masterへ触れない。Agentによる任意コマンドをこのランチャーはOSレベルでは制御しない。
- 既存テストは削除・skip・期待値弱体化しない。失敗を隠さず、全試行のコマンド・終了コード・source/build hash・ログ・残件を自分の `docs/parallel/<担当>/` に記録。許可ないNotion実測や物理IMEは行わず UNKNOWN / NOT_RUN。
- 他Agentの変更を無断で取り込まない。自branchに独立commitを作成し、commitと検証結果・未完を報告。マージ・pushはしない。Gitメタデータがsandboxで拒否されたら1回限りの承認を要請し、他worktreeやmasterを変更しない。
