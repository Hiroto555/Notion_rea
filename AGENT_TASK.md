# DeepSeek A — Database 2.0

対象branch `sprint/database-v2`。複数の独立ビュー、AND/ORフィルター、複数ソート、グループ化、ビュー管理とSQLite永続化を実装する。担当は `src/database/`、`src/shared/types.ts`、`src/persistence/store.ts`、Database専用新規テスト。`Doc`・Editor、`App.tsx`、UIの保存以外の表示には触れない。

旧単一view/filter/sort形式の読込、IDと値・順序・履歴・添付・revisionの維持、旧データからの安全な移行、異常時rollback、競合・復旧・再起動を合成fixtureと実Electronで検証する。Editorの共有文書型を変える必要があれば契約提案に留める。UI内部を変更しないために必要な接続を既存Databaseコンポーネント契約内に収め、実装できない部分は明示する。独立ビューの相互非干渉を証明する。

## 共通安全・操作

最初に `docs/parallel/CONTRACTS.md` を読み、現在のbranchとworktreeがこの文書の指定と一致すること、開始時状態を確認する。ユーザーがターミナルを操作する必要はない。下記コマンドはあなた自身が実行する。

- 型検査 `node scripts/folio-agent.mjs check`、単体 `node scripts/folio-agent.mjs test`、ビルド `node scripts/folio-agent.mjs build`、全体E2E `node scripts/folio-agent.mjs test:e2e --retries=0 --reporter=list`。起動 `node scripts/folio-agent.mjs dev`。環境表示 `node scripts/folio-agent.mjs environment`。引数は `npm run` に渡される。出力・終了コードは各 `output/agent-workspace/logs/` に記録される。
- 直接 `npm run dev`、`npm start`、`npx electron`、生のPlaywright等を使わない。ランチャーのデータ/キャッシュ隔離とテスト排他を迂回しない。実データ、ユーザーappData、既存server、他worktree、masterへ触れない。Agentによる任意コマンドをこのランチャーはOSレベルでは制御しない。
- 既存テストは削除・skip・期待値弱体化しない。失敗を隠さず、全試行のコマンド・終了コード・source/build hash・ログ・残件を自分の `docs/parallel/<担当>/` に記録。許可ないNotion実測や物理IMEは行わず UNKNOWN / NOT_RUN。
- 他Agentの変更を無断で取り込まない。自branchに独立commitを作成し、commitと検証結果・未完を報告。マージ・pushはしない。Gitメタデータがsandboxで拒否されたら1回限りの承認を要請し、他worktreeやmasterを変更しない。
