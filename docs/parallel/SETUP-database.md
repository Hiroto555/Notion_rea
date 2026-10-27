# 開発環境の準備結果 — database

- 共通の開始コミット: `b7c150d15739c59edf6ba9a62ebda4794748d46b`。branch: `sprint/database-v2`。このworktree: `/Users/shiroto/Documents/ChatGPT/Folio-database`。
- macOS 26.6.2 arm64、Node.js 24.20.0、npm 11.19.0、Electron 45.0.0。各worktreeで `npm ci --no-audit --no-fund`、Electron実行バイナリ、型検査、buildを確認し、各終了コード0。`output/agent-workspace/logs/` に記録。npm install-scripts警告は残るが、実際のビルドは通過。
- データ: `output/agent-workspace/data/`、入力・出力: `inputs/`, `exports/`、cache: `cache/`、ログ: `logs/`、検証: `evidence/`。dev port `56132`、127.0.0.1でstrictPort。
- 4本のdevを同時実行し各HTTP 200・所有Electron PID・独立SQLite4ページ・integrity_check=okを確認。テスト自身のプロセスをSIGINTで停止、PIDとportの解放確認。SIGINT停止の終了1は意図した停止であり機能の失敗ではない。詳細は `evidence/concurrent-dev*.json` と該当dev log。画面の全操作や長時間稼働はこの同時起動試験では未検証。
- editor worktreeで実Electron出力保護の重点E2E 1件が通り、E2Eロックの終了後解放を確認。database worktreeで他実行を模したロック中の呼出しが試験開始前に終了2となることを確認。全体E2Eを今回4回実施したわけではない。GUI E2Eの直実行やsandboxの異なるtemp空間を経由した場合に、共通ロックが効く保証はない。
- macOS Seatbeltを使う別の合成Git worktree実験で、workspace外の共有Git index.lockに対する `git add` は権限拒否（128）。Desktop実セッションでのAgent実行は未実測。DeepSeek Harness のWorkspace Writeで同じ制約に当たった場合は、GUIの1回限りの承認が必要。無制限アクセスを恒久有効にしない。
- Agentは [AGENT_TASK.md](../../AGENT_TASK.md) と [CONTRACTS.md](CONTRACTS.md) に従い、コマンドは `scripts/folio-agent.mjs` 経由で実行する。APIキーはこの作業で入力・保存・取得していない。DeepSeekへの課金・利用枠やモデル応答は未試験。
- 初回のeditor Electron存在確認時、明示的な独立cache設定前にElectronの遅延インストールが走ったため、OSの通常Electron cacheが利用された可能性がある。既存のFolioデータは対象にしていない。以後の各環境は独立cacheを指定。
