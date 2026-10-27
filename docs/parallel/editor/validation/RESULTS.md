# Editor 2.0 実装と試験記録

- 開始branch: `sprint/editor-v2`、開始HEAD `666882c44f908fa15bcb85fb1347961494e9449d`、共通基準 `b7c150d15739c59edf6ba9a62ebda4794748d46b`。開始時の作業ツリーはクリーン。
- コマンドはすべて `node scripts/folio-agent.mjs` を使用。`folio-agent.json` が専用の `output/agent-workspace/data`、cache、ポート 56131 を指定し、テストはリポジトリ共通のロックで直列化した。既存データはfixtureに使っていない。
- `runs/` に全実行ログを保存。各ログ先頭のJSONに実際のnpm引数・開始時刻、末尾に終了コードがある。出力および失敗traceの元ファイルは `output/agent-workspace/evidence/editor-v2/` と `output/agent-workspace/logs/` にある（Git管理外）。
- ソース・ビルドのSHA-256一覧は `baseline-*-sha256.txt` と `source-sha256.txt` / `build-sha256.txt`。後者の一覧ファイル自体のSHA-256はそれぞれ `cde7071983bc92f439647ec67c55ff0a21851f49edc20cc6a25965864d5a2c5d`、`8f21ee3c04bc3027d16871c8541646d516415930ae3ccebcd5efd818dcb52656`。途中段階の各試行ごとのsource/build hashは採取できていない。最終一覧を途中の試行のhashとして扱わない。

## 開始前の実測

- `check`: 終了0。`test`: 終了0、50/50。`build`: 終了0。
- `test:e2e --grep 'R2 short original regression|R3 selected text link|R1 multiple pending' --retries=0 --reporter=list`: 終了0、3/3。これは全E2Eではない。

## 実装中の試行と失敗

- ID単体試験3/3、全単体試験53/53が成功した中間版がある。
- 初回のID E2Eは終了1。旧文書を開いた際、既存Tiptapが末尾の空段落を追加するため、保存結果を4 IDとした期待値に対して5 IDだった。原文維持と全IDを含めて検査する期待値に修正後、同試験は終了0。初回失敗を成功扱いしない。
- 初回ネスト操作E2Eは終了1、2件中1件失敗。親・子のハンドルが重なりクリックが遮られた。位置を修正し、その後の同一階層移動・複製・Undo/Redo・再起動を含む試行は2/2で終了0。さらにドラッグを追加した試行も2/2で終了0。その後、先頭段落の選択操作とハンドルの表示を変更したため、最終版の全E2E結果を別途参照。
- 別リスト間移動と保存競合を含む2件の試行は終了1、1成功・1失敗。移動試験の本文・子孫ID・Undo/Redo・再起動後の期待値はtrace上すべて通過したが、共有 `folio` fixtureの `app.close()` 終了処理が60秒でタイムアウトした。試験全体は失敗であり、終了処理の原因は未確定。競合時の退避・復元試験は成功。
- 残る制限は [CONTRACT.md](../CONTRACT.md) を参照。物理IMEは NOT_RUN、未観測のNotion操作は UNKNOWN。未実施の旧版アプリ全体での読込・大規模性能・OS実クリップボード・全添付形式などを成功扱いしない。

## 最終版の結果

- `node scripts/folio-agent.mjs check`: 終了0。`node scripts/folio-agent.mjs build`: 終了0。
- `node scripts/folio-agent.mjs test`: 終了0、56/56。うち旧validator互換1件およびIDの操作・構造5件。
- `node scripts/folio-agent.mjs test:e2e --retries=0 --reporter=list --output=output/agent-workspace/evidence/editor-v2/final-e2e`: 終了0、45/45。新Editor 4件、既存R1/R2/R3、実Electronの標準HTML貼付け・添付を含む。先行のタイムアウトが解消したとは断定しない。
- 共通基準のvalidatorはIDなし文書を受け入れ、ID付き文書を拒否した。旧版アプリがID付きの文書を開こうとした場合のUI・復旧は未検証。統合時に互換性方針が必要。
