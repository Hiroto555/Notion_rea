# Codex — Editor 2.0

対象branch `sprint/editor-v2`。目的は既存文書を保ち、安定したblock ID、ネストしたブロック操作、Undo/Redo、コピー＆ペースト、既存文書の安全な移行を実装すること。担当は `src/editor/`、`src/shared/editor-schema.ts`、`src/shared/validation.ts` とEditor専用新規テスト。共通 `src/shared/types.ts`、`src/persistence/store.ts`、`src/renderer/App.tsx` は担当外。必要なら契約提案として記録し、他担当を変更しない。

まず現行文書・操作・R1/R2/R3を再現し、文書の順序、書式、添付、子孫、永続ID、コピー時の重複防止と移行前後の損失ゼロを実fixtureで検証する。R2の既知の断続dragstart失敗は隠さない。安全な移行・旧読込・異常データ拒否・保存競合・再起動を試験し、必要な境界が他担当で実装できないなら未完と報告。実際に動く成果物と再現可能な証拠を残す。

## 共通安全・操作

最初に `docs/parallel/CONTRACTS.md` を読み、現在のbranchとworktreeがこの文書の指定と一致すること、開始時状態を確認する。ユーザーがターミナルを操作する必要はない。下記コマンドはあなた自身が実行する。

- 型検査 `node scripts/folio-agent.mjs check`、単体 `node scripts/folio-agent.mjs test`、ビルド `node scripts/folio-agent.mjs build`、全体E2E `node scripts/folio-agent.mjs test:e2e --retries=0 --reporter=list`。起動 `node scripts/folio-agent.mjs dev`。環境表示 `node scripts/folio-agent.mjs environment`。引数は `npm run` に渡される。出力・終了コードは各 `output/agent-workspace/logs/` に記録される。
- 直接 `npm run dev`、`npm start`、`npx electron`、生のPlaywright等を使わない。ランチャーのデータ/キャッシュ隔離とテスト排他を迂回しない。実データ、ユーザーappData、既存server、他worktree、masterへ触れない。Agentによる任意コマンドをこのランチャーはOSレベルでは制御しない。
- 既存テストは削除・skip・期待値弱体化しない。失敗を隠さず、全試行のコマンド・終了コード・source/build hash・ログ・残件を自分の `docs/parallel/<担当>/` に記録。許可ないNotion実測や物理IMEは行わず UNKNOWN / NOT_RUN。
- 他Agentの変更を無断で取り込まない。自branchに独立commitを作成し、commitと検証結果・未完を報告。マージ・pushはしない。Gitメタデータがsandboxで拒否されたら1回限りの承認を要請し、他worktreeやmasterを変更しない。
