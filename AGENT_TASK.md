# Round 3 lane E

> このファイルはRound 3の統合作業指示の履歴です。現在の機能・検証・未対応範囲は [R6公開チェックポイント](docs/R6-CHECKPOINT.md) を参照してください。公開用ブランチでは `folio-agent.json` の設定を使います。

Remote master: `bd0f1e753258b8f29c3a436753f3bad9a1f84b16`

Contract commit: `c6ced9c906dbce1a0df1375b63d4d627f4fdb021`

Branch: `r3/integration`

Read docs/parallel/r3/CONTRACT.md, PLAN.md and ACCEPTANCE.md first. The named IPC contract is not implemented yet; use fixtures until Core connects it. Lane setup is a separate commit and is not a feature commit.

E — Codex統括: 最終統合・受入
============================================================

Folio Round 3の担当成果を統合してください。各担当の完了報告だけを信用せず、現在のbranch/commit/dirty状態、共通契約、差分、証拠を実際に確認します。ユーザーへGit操作や手作業でのSHA回収を依頼しないでください。

1. origin/masterを再確認する。開始後に更新があれば差分を評価し、未確認のまま上書きしない。担当worktreeの未コミット変更を勝手に取り込まない。
2. 各レーンの正確な最終SHAと結果を収集し、保存契約/ファイル所有/新旧互換の差分をレビューする。検証していない機能は未完として扱う。
3. 共通契約commitから専用r3/integration worktreeへ、Core→DB UI→Editor→Fidelityの依存関係を確認して段階統合する。名称が異なる場合は実在のbranchを使う。
4. AGENT_TASK.md/folio-agent.jsonの競合は担当機能と分け、統合用設定を保持する。ソース競合を一律ours/theirsで処理しない。
5. CoreとDB UIを最初に接続し、「行を開く→本文→保存→再起動」の小さな一本を通す。Editor/Fidelity統合後に合同受入を通す。
6. DB3固有の移行・履歴・退避・複製/削除/復元・更新競合を重点レビューする。旧履歴復元を黙って削除する、旧rowsと新Pageが二重正本、recordコピーが元Pageを共有する変更は戻して修正する。
7. すべてのレーンが持つ試験を統合候補上で実行する。既存意味契約の保持、新仕様に伴う期待更新の妥当性を確認する。テスト件数の増加自体を目標にしない。

最終合同受入:
A. Tableで行作成→同じPageを開く→タイトル/プロパティ/ネスト本文/画像/内部リンクを編集。
B. Board/Calendar/Galleryへ切替え、条件に合う同じ行から同じPage IDと本文・値を確認。
C. 検索結果からそのレコードを直接開き、通常ページからのリンクとバックリンクを確認。
D. 全画面/close/reopen/別ページ遷移後も未保存内容とfocusが仕様どおり。peekを共通契約で採用した場合はpeek/全画面切替も同条件で検証。完全アプリ再起動後も一致。
E. レコード単独とDB全体のtrash/restore、DB/レコード複製、旧履歴復元後の本文・所属・参照を検証。
F. 画像付きレコードをbackup/未保存退避し、別の専用workspaceへ復旧。SQLite・assetsと新旧ID対応を確認。
G. legacy ID衝突、二度目起動、移行中例外、未知schema、保存競合を合成fixtureで検証。
H. 同一文書の複数block copy/cut/paste、二回paste、cut Undo後paste、移動、Undo/Redo、reopenを通常ページとrecord本文で確認。
I. 960/1024/1440幅、light/dark、keyboard操作、menu/modal閉鎖とfocus復帰を検証。
J. 既存1,000blockと新record数増加時の性能を条件付きで比較し、未測定規模を保証しない。

検証:
- 更新済み統合configでcheck→test→build→test:e2e(retries=0)。各レーンの新規試験と既存全体試験を対象にする。
- 最終sourceとbuild hashを固定し、試験途中で同じビルドを上書きしない。
- review:testは対応した隔離環境で実行する。公開候補の差分/履歴はreview:scan等の既存仕組みで確認する。
- 開発起動と配布用package起動は別項目。今回の新データモデルでpackaged appも起動確認できるよう、既存setup/package/verify scriptsを読んで隔離fixtureで実行する。実データのFolioを起動しない。
- コードを修正したら影響する試験を再実行する。単発成功のために全試験を漫然と繰り返さない。
- 過去の失敗/NOT_RUNを消さず、今回の試行と根因を追記する。物理IMEとNotion比較が未実施なら明示する。

完了報告:
docs/parallel/r3/integration/RESULTS.mdに、開始master・契約commit・各レーンSHA・統合候補SHA、変更、全試行と終了コード、source/build hash、受入表、復旧と互換、未完/未検証、共有レビュー、配布/起動状況を記録する。
報告コミットではアプリソースとbuild hashを変更せず、検証対象commitと報告追加commitを区別して記録する。文書追加でもGit全体のtree SHAは変わることに注意する。
ユーザーへGUIで開ける場所と、今回できるようになった主要操作を示す。
明示許可がある範囲のみpush/PR/master mergeを行い、なければローカルのレビュー可能候補とPR文案まで完成させる。
不明点を完成と推定せず、データを失う曖昧な統合を行わない。
