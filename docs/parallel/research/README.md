# 並列研究: Notion 比較（Research）

## 目的と範囲

Folio と Notion の比較研究を、**Folio 自動試験 / 参照実測 / 公式文書 / 比較判定** の4列に分離して維持する。対象は `docs/NOTION-PARITY-BASELINE.md` の N01〜N09（N09 は 2026-10-27 追加）。成果物は本ディレクトリと研究専用の小テストのみで、アプリ本体・機能コード・共有型・スキーマ・他担当の文書は変更しない。

- branch: `sprint/research`、worktree: この checkout。
- 開始 HEAD: `0c85f9a5ad29147c5da422b88ed984ba26b44315`（base `b7c150d15739c59edf6ba9a62ebda4794748d46b`）。
- 合意文書: [AGENT_TASK.md](../../../AGENT_TASK.md)、[CONTRACTS.md](../CONTRACTS.md)。
- 既存の [NOTION-PARITY-BASELINE.md](../../NOTION-PARITY-BASELINE.md) と `docs/validation/` は保持する。基準文書の SHA-256 は `parity-matrix.json` に記録し、研究用テストで照合する。

## 現状（2026-10-27）

- 参照実測（Notion）: **NOT_RUN**。テスト専用領域の明示許可がないため、ログイン・ページ作成・既存ページ操作を行っていない。
- 物理日本語 IME: **NOT_RUN**。合成 composition は補助証拠に留める。
- 比較判定: **全件 UNKNOWN**。MATCH/DIFF は 0 件。
- Folio: N01〜N07 は既存の自動回帰記録があり PASS、N08 は NOT_RUN、N09 は既知の F11 FAIL を含む PARTIAL。今回の parity E2E は Harness の workspace-write sandbox で Chromium sandbox を初期化できず、全件がアプリ起動前に NOT_RUN。既存記録を保持し、今回の実行で置き換えない（[verification.json](verification.json)、[evidence/parity-e2e-attempt.json](evidence/parity-e2e-attempt.json)）。
- Notion の版・OS・言語・theme・viewport・zoom・入力方式: **UNKNOWN**。

## ファイル

| ファイル | 内容 |
| --- | --- |
| [parity-matrix.json](parity-matrix.json) | 正本データ。シナリオ、4列、優先度、未確認の差分候補、未解決参照 |
| [parity-matrix.md](parity-matrix.md) | 人が読む比較表。JSON と矛盾させない |
| [references.md](references.md) | 公式資料の直接リンク・取得日・HTTP 結果・確認した記述と限界 |
| [procedures.md](procedures.md) | Folio の実行コマンド、合成 fixture、許可後に行う Notion 手順 |
| [priorities.md](priorities.md) | P0〜P3 の作業順序と差分候補 H1〜H8（すべて未確認） |
| [unresolved.md](unresolved.md) | 未解決 U01〜U10 と解除条件 |
| [environment.json](environment.json) | Folio/OS/入力の記録、合成 fixture、Notion の UNKNOWN 欄 |
| [verification.json](verification.json) | 今回のコマンド・終了コード・ログ・build hash・スコープ監査 |
| `evidence/` | 今回の実測から取った環境・実行要約（個人データなし） |
| [tests/research/parity-docs.test.ts](../../../tests/research/parity-docs.test.ts) | 研究専用テスト。文書の4列・権限・比較判定の整合性を検証 |

## 検証の実行

すべてランチャー経由。ブランチが違えばランチャーが拒否する。

```sh
node scripts/folio-agent.mjs check
node scripts/folio-agent.mjs test
node scripts/folio-agent.mjs build
env -u ELECTRON_RUN_AS_NODE node scripts/folio-agent.mjs test:e2e --retries=0 --reporter=list --output=output/research/parity-e2e --grep "F01 same-page|F02 full-text|selected text link|stale link|N04 slash|R2 short original|R2 top-level matrix|R3 DB Escape|R3 search/link/record|nested native UI|synthetic composition|S2 tree input|S2 menu F11|S2 tree order"
```

- `check` / `test` / `build` は今回のソースに対して実行する。E2E は build 済みの `dist/main.cjs` を使う。
- 初回の E2E は、親プロセスの `ELECTRON_RUN_AS_NODE=1` をそのまま継承して Electron が Node として起動し、14件すべてが起動前に失敗した。これはアプリの失敗ではなく、`env -u` で親の変数を外して再実行した理由である。
- 再実行では Electron 自体は起動したが、`sandbox initialization failed: Operation not permitted` により Chromium の子プロセス sandbox を初期化できず、`.page-title` の表示前に終了した。14件すべてが起動待ちで失敗し、アプリのアサーションには到達していない。このため今回の Folio 実行は **NOT_RUN** とし、既存記録を保持する。診断ログと全試行は [verification.json](verification.json) と [evidence/parity-e2e-attempt.json](evidence/parity-e2e-attempt.json) に残す。
- 上記の E2E は N01〜N09 の対応ケースに絞った **parity 用の部分実行**であり、全体 E2E の代替ではない。全体の既存記録は `docs/validation/next-round/` にある。
- 研究用テストはネットワーク・Notion・GUI に触れない。ローカルの文書と JSON だけを読む。
- 失敗・既知の不安定さ・ログ・終了コードは隠さず `verification.json` に残す。

## 研究用テストが守る規則

1. シナリオは N01〜N09 が重複なく揃い、4列と優先度を持つ。
2. 参照実測の許可がない限り、`reference.status` は NOT_RUN、`comparison` は UNKNOWN。
3. `MATCH` は、参照実測が OBSERVED で、同一 fixture・同一環境の証拠がある場合だけ許可する。現在は 0 件。
4. 物理 IME は NOT_RUN を維持し、Folio の N08 も物理 IME の PASS にしない。
5. 公式資料は https の直接リンクと取得日を持ち、`references.md` と一致する。
6. Notion の環境欄が UNKNOWN のままなら、比較を確定しない。
7. 基準文書の SHA-256 が記録と一致する（無断変更の検出）。
8. `parity-matrix.md` の表が JSON の ID・比較判定と一致し、`| MATCH |` を含まない。
9. 参照するテストファイル・文書・未解決 ID・差分候補 ID が実在する。

## ガードレール

- Notion の個人/顧客ページ、共有リンク、未公開コード・素材を扱わない。テスト専用領域の許可が出るまでログインしない。
- 許可後も、観測対象は合成ページのみとし、環境・fixture・観測者・取得日を記録する。
- 公式資料の記述だけを根拠に MATCH にしない。WAI-ARIA は設計契約であり Notion の実装証拠ではない。
- Folio の既存試験を削除・skip・期待値弱体化しない。既存の失敗を成功した再実行で置き換えない。
- アプリを変更しない。Folio 側の既知不具合（N09）は、再現証拠と提案を残すに留める。
- 他 worktree、master、他担当ブランチに触れない。マージ・push をしない。

## 現在の結論

- 参照実測がなく、Notion の環境も UNKNOWN のため、**差分は確定していない**。H1〜H8 はすべて検証待ちの候補。
- Folio 側は N09 の F11 が未解決。N08 は物理 IME 未実施。
- 次に必要なのは、テスト専用 Notion 領域の許可と環境記録（U01/U02）、物理 IME の人手観測（U03）、N09 の Folio 側切り分け（U04）、sandbox 制約のない環境での E2E 再実行（U10）。
- 未解決の詳細と解除条件は [unresolved.md](unresolved.md)、作業順序は [priorities.md](priorities.md) を参照。
