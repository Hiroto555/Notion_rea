# Folio review bundle

対象コミット：abb1e3131d1b4cab6aee4560c6d8aa819859bc29

- Folio_Audit_2026-10-26.md：17指摘、証拠区分、修正順序、受け入れ条件、固定ソースリンク。
- Codex_Folio_Improvement_Prompt.txt：そのまま開発セッションへ渡すための改修指示。
- Folio_Acceptance_Catalog.json：68件の未実行の受け入れテスト提案。Notion全仕様の網羅を意味しない。
- audit_probes.mjs：ソースから転記した抜粋ロジックだけの確認。Nodeで実行可。
- audit_probe_results.json：今回の14条件の確認結果。アプリ全体のテスト結果ではない。

この監査ではリポジトリを変更していません。実Electron/Notion比較、既存テストの再実行、全依存脆弱性走査は未実施です。
