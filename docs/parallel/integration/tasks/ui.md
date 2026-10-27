# DeepSeek B — UI/UX 2.0

対象branch `sprint/ui-v2`。既存機能を壊さずサイドバー、ページ表示、視覚階層、ホバー、メニュー、レイアウト、テーマ、レスポンシブ挙動を改善する。担当は `src/renderer/styles.css`、`src/renderer/App.tsx` の表示専用JSX、表示専用コンポーネント、UI専用新規テスト。Editor、Database、SQLite、共有型・契約・IPC・保存動作には触れない。

既存操作・キーボード/フォーカス・保存・復旧・drag・アクセシビリティを維持し、異なるviewportとテーマで画面の実測証拠と回帰を残す。表示変更にビジネスロジックの変更が不可避なら勝手に広げず必要最小案を残す。

## 共通安全・操作

最初に `docs/parallel/CONTRACTS.md` を読み、現在のbranchとworktreeがこの文書の指定と一致すること、開始時状態を確認する。ユーザーがターミナルを操作する必要はない。下記コマンドはあなた自身が実行する。

- 型検査 `node scripts/folio-agent.mjs check`、単体 `node scripts/folio-agent.mjs test`、ビルド `node scripts/folio-agent.mjs build`、全体E2E `node scripts/folio-agent.mjs test:e2e --retries=0 --reporter=list`。起動 `node scripts/folio-agent.mjs dev`。環境表示 `node scripts/folio-agent.mjs environment`。引数は `npm run` に渡される。出力・終了コードは各 `output/agent-workspace/logs/` に記録される。
- 直接 `npm run dev`、`npm start`、`npx electron`、生のPlaywright等を使わない。ランチャーのデータ/キャッシュ隔離とテスト排他を迂回しない。実データ、ユーザーappData、既存server、他worktree、masterへ触れない。Agentによる任意コマンドをこのランチャーはOSレベルでは制御しない。
- 既存テストは削除・skip・期待値弱体化しない。失敗を隠さず、全試行のコマンド・終了コード・source/build hash・ログ・残件を自分の `docs/parallel/<担当>/` に記録。許可ないNotion実測や物理IMEは行わず UNKNOWN / NOT_RUN。
- 他Agentの変更を無断で取り込まない。自branchに独立commitを作成し、commitと検証結果・未完を報告。マージ・pushはしない。Gitメタデータがsandboxで拒否されたら1回限りの承認を要請し、他worktreeやmasterを変更しない。
