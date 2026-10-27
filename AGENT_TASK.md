# Folio 統合ワークスペース

Editor、Database、UI、Research の成果を統合し、元のブランチ・master・実ユーザーデータを保護する。各担当への元の指示は `docs/parallel/integration/tasks/` に保存する。

検証は `node scripts/folio-agent.mjs` 経由で実行し、専用のデータ・cache・ログ・ポートと共有のテストロックを使用する。既存テストを削除・skipせず、失敗と未検証を記録する。Notionの未実測はUNKNOWN、物理IMEはNOT_RUN。masterへの統合、GitHubへのpushは別の指示があるまで行わない。
