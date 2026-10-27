# Folio 統合結果・検証記録

## 対象と隔離

- 共通基準: `b7c150d15739c59edf6ba9a62ebda4794748d46b`。統合用branch: `codex/folio-integration-v2`。master と4本の担当branchを変更せず、統合用の独立worktreeで作業した。
- merge元の最終commit: Editor `8e1760643655789d429ec5cb83ed66d390a7293d`、Database `1f56f6e6e836116e339edeb14518c1725c4aee66`、UI `f81cf0b62e6d3a185413a7d72701879ef6182f0b`、Research `8a21ffb5441bb9f0aa27524ca68fe9b8310d03e1`。各branchはmerge commitの親として保持。
- Gitの衝突は担当ごとに異なる `AGENT_TASK.md` と `folio-agent.json`。4人の元の指示書を `tasks/` に保存し、統合用の指示書・設定に置き換えた。共通のcontractとランチャーは同一内容。アプリ本体の同一ファイルでのテキスト衝突はなかった。
- 専用 `folio-agent.json` から統合branchを検証し、`output/agent-workspace/data`、専用npm/Electron/Vite/tmp cache、port 56135、同一リポジトリのテストロックを使用。E2Eの作業領域・添付・DB・出力先は `output/` 配下の合成fixture。実データ・他worktree・既存サーバーは使わない。
- `env -u ELECTRON_RUN_AS_NODE node scripts/folio-agent.mjs ...` を使用。`install` は `npm ci`、試験時の自動retryは0。`review:test` は専用環境変数を明示して実行。

## 統合時に見つけた問題と修正

v2→v3 のDatabase移行は、Databaseが旧形式であればページJSONを再出力していた。そのため、Editorの未知schemaを含むページまで原文が書き換わり、既存の未知文書に対する「原本は変更しない」保護と矛盾した。再現試験 `tests/integration-migration.test.ts` の修正前試行は 1件失敗・1件成功、終了1。

`src/persistence/store.ts` で、未知・不正文書や未知ページschema、不正なDBを含むページの原文とその履歴を移行対象から外す。未知・不正文書の履歴自体も対象から外す。正常な旧ページのDBと履歴は引き続き移行する。未知ドキュメント／未知ページの各ケースについてJSONの完全一致・編集拒否・履歴の完全一致を確認した。

合成した旧形式ページについて、DB移行・旧DBスナップショット・書式と画像・Editor ID付与・ビュー追加・再オープンの組合せも確認。実アプリでは旧文書に編集・画像添付・ネスト操作を加え、DBの独立ビューとテーマを設定し、再起動後に全内容を照合した。

## 全試行の主な結果

| 時刻（UTC）・ログ識別 | 操作 | 終了 | 結果 |
| --- | --- | --- | --- |
| 04:39 install-60f3e528 | 依存関係 `install` | 0 | npm ci 成功。Electronは初回試験時に専用環境へ取得 |
| 04:39 check-02ef9b11 | 型検査 | 0 | 統合直後成功 |
| 04:39 test-cd203e09 | 全単体 | 0 | 85/85 |
| 04:39 build-986fe848 | ビルド | 0 | 成功、Vite chunk警告あり |
| 04:40 check-ca48e6b6 | 型検査 | 0 | 合同試験追加後成功 |
| 04:40 test-e2e-969de626 | 合同E2E初回 | 1 | 添付画像の挿入位置を固定で想定した試験側の誤り |
| 04:41 test-c2b0f9a7 | 合同移行単体 | 0 | 1/1 |
| 04:41 test-e2e-9d8a7584 | 合同E2E修正後 | 1 | Editor内のJSONと永続JSONの `schemaVersion` 差を比較していなかった試験側の誤り |
| 04:41 check-5155366e | 型検査 | 0 | 成功 |
| 04:41 test-e2e-ec8019ab | 全E2E、移行保護修正前 | 0 | 51/51（合同E2Eを含む） |
| 04:44 test-a64d470a | 未知文書保護の再現 | 1 | 未知文書が移行で書き換わる問題を再現。1成功・1失敗 |
| 04:45 check-a47dbfba | 型検査 | 0 | 最初の保護修正後成功 |
| 04:45 test-79abe097 | 保護修正の部分単体 | 0 | 2/2。その後、未知ページschema・履歴のケースを追加 |
| 04:45 build-7619e2c5 | 最終ビルド | 0 | 成功、Vite chunk警告あり |
| 04:45 test-6cef697d | 最終の全単体 | 0 | **88/88**（研究10、合同移行3を含む） |
| 04:45 test-e2e-3e944028 | 最終全E2E | 0 | **51/51**、retries=0。Editor・Database・UI・保存復旧・添付・再起動と合同E2Eを含む |
| review-test | `npm run review:test` | 0 | 5/5 |

再現時の失敗は後の成功で消さない。ログ複製は [evidence/runs/](evidence/runs/) に保存（ローカルパスを置換し行末空白を整形）。元ログ・Playwright traceは各worktreeの `output/agent-workspace/` に保持。各ログ先頭にコマンドと引数、末尾に終了コードがある。初回試験と修正後試験の source/build SHA-256 一覧は [evidence/](evidence/) に記録し、一覧自体の SHA-256 は次のとおり。

- 初回統合 source: `05dfac7f1ace895268bd4e61f4c458d7324aa205e01c79da13bd2056a9db3b7a`
- 初回統合 build: `35f0fcd12689393c375d6ae8ca6f93059bf7d6aaa065c98634bbee5cacf4aa02`
- 最終 source: `1c136ddc4e9f40aec444584412fd3cfb44f33c4731aa93fa0cd92b6aeaf0fbab`
- 最終 build: `371901007802f87df4c952db3e835f2a9fda5d0fa4bd03415bbfe548b316330f`

## 限界・残件

- 実ユーザーのDBは使っていない。試験は合成fixtureであり、すべての実データや障害条件を保証しない。
- SQLiteはv3に移行され、旧Folioは拒否する。v2からの移行前スナップショットと同時点のassetsを保全する必要があり、旧版へ戻すとv3移行後の編集は含まれない。Editorの新しいID属性も旧validatorが拒否する。実データでの移行や旧アプリの復旧操作は未実施。
- 切取り→貼付けではブロックIDが新しくなる。100,000ノード／100,000行の性能、全形式の添付、物理IME、Notion実測は未検証。物理IMEは NOT_RUN、Notion比較は UNKNOWN。Researchの過去のページ移動F11失敗とEditorの途中の終了タイムアウトは今回の成功だけで消えない。
- UIの4枚の合成データ画像を目視し、ハッシュを `docs/review-policy.json` に登録した。作業ツリーの共有前走査には個人パスの検出が27件残る。過去の担当branchと統合履歴も含むため、GitHub公開やpushの前に別途履歴を含む共有レビューが必要。今回pushしていない。
- 960px幅では情報パネルが本文に重なる（閉じるボタンあり）。表示領域の改善は未実施。
