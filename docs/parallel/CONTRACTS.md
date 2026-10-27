# Folio 並列開発の契約（共通）

共通基準 `b7c150d15739c59edf6ba9a62ebda4794748d46b`。4本は同一リポジトリの別worktree。Agentは自分の指定branch/フォルダだけで作業し、他branchのmerge・rebase・cherry-pick・pushをしない。統合は別途レビューする。`AGENT_TASK.md`、`folio-agent.json`、`scripts/folio-agent.mjs`、`docs/parallel/CONTRACTS.md` はセットアップ用で各branchに重複し、統合時に担当機能のコミットと区別する。

## ファイル担当と衝突

| 領域 | 主担当 | 他担当の扱い |
| --- | --- | --- |
| `src/editor/`, `src/shared/editor-schema.ts`, `src/shared/validation.ts` | Editor | Database/UIは変更しない。Documentに関わる変更は提案を残す |
| `src/database/`, `src/shared/types.ts`, `src/persistence/store.ts` | Database | Editor/UIは直接変更しない。必要な変更は契約提案として残す |
| `src/renderer/App.tsx`, `src/renderer/styles.css`, 表示専用コンポーネント | UI | Editor/Databaseは直接変更しない。UIはデータ保存・Editor/DB API・共有スキーマの意味を変更しない |
| `src/main/`, `src/preload/`, `src/persistence/` のstore以外 | 共通インフラ | 原則変更しない。必須なら実装せず根拠・最小差分案を報告 |
| `docs/parallel/research/` と研究専用の小テスト | Research | Researchはアプリ本体・共通契約・他担当を編集しない |
| テスト | 各担当は担当機能の新規テストを専用ファイルに追加 | 既存試験の削除・skip・期待値弱体化は禁止。競合の恐れのある共有試験の変更は提案する |

## 現行契約と互換性

- `Doc` は再帰ノード、`attrs` は任意のキー・値。既存文書の `schemaVersion` は未指定または1。未知schemaはread-only/errorで原文を保護する。EditorのIDは既存文書、空文書、複製・コピー・ペースト・Undo/Redo・ネスト・エクスポート/復旧を含め、同一性と衝突時の扱いを明文化する。Editor固有の追加属性で収まらない共通型・保存処理変更が必要なら実装前に `docs/parallel/proposals/editor-contract.md` を作り、差分と保留を報告する。共通型はDatabaseの担当。
- 現行 `DatabaseData` は `properties`, `rows`, 単一の `view`, `filter`, `sort` を持ち、SQLiteは `user_version=2`、page JSONとrevisionベースで保存。Database担当は既存ID・データ・履歴・部分更新・楽観的競合・backup/recoveryを保持し、旧形式との読込みと移行・失敗時rollbackを合成fixtureで証明する。新しいview/filter/sort契約、未知version拒否と古い文書への影響を `docs/parallel/proposals/database-contract.md` に文書化する。EditorのDocument構造は変更しない。
- `App.tsx` のUI担当変更は表示層と既存コールバックに限る。保存の意味、IPC、競合処理、Editor/Databaseプロパティ契約を変更しない。契約競合や他担当が必要な場合は実装を捏造せず提案と未完を報告する。
- 実ユーザーデータ・Notion個人領域を使用しない。既存R1/R2/R3の保護と全試験を維持。実測していないNotion挙動はUNKNOWN、物理IME未実施はNOT_RUN。公開されていないコード・素材は使わない。
- 4branchとも同じGitオブジェクト・refsを共有する。masterや他branchをcheckout/変更せず、自branchにのみコミット。GitHub公開、push、統合は行わない。通常のGit worktree管理情報は作業ディレクトリ外にあり、Workspace Write sandboxから `git add` / `git commit` が拒否される場合がある。拒否時は理由を報告し、Harnessの狭い1回限りの承認経路を使う。sandboxを恒久的に無制限へ変更しない。要求された承認を勝手に回避しない。
- `node scripts/folio-agent.mjs` 経由で作業用 `check`, `test`, `build`, `test:e2e`, `dev`, `start` を実行する。data/cache/tmp/logsは各worktreeの `output/agent-workspace/`、portは `folio-agent.json`。単体とE2Eは同一Mac上の負荷とnative UI競合を避ける共有ロックを取り、競合時はファイルイベントで待機してから一度だけ実行する。テスト開始後の自動retry・固定sleep・失敗の選別は行わない。個別の直接コマンドやAIが設定を変更した場合まで隔離を保証する仕組みではない。
