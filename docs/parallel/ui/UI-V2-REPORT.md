# UI/UX 2.0 — 実装・検証記録（ui / `sprint/ui-v2`）

2026-10-27。開始時 branch は `sprint/ui-v2`、worktree はこのフォルダ、開始 HEAD は `27243170102e753ce70ef5255c22edd61710d164`（共通基準 `b7c150d15739c59edf6ba9a62ebda4794748d46b`）。他の worktree・master は checkout も変更もしていない。この記録は自分の `docs/parallel/ui/` 配下だけに置く。

## 1. 変更した範囲

| 種別             | ファイル                  | 内容                                                                                                  |
| ---------------- | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| 表示             | `src/renderer/styles.css` | デザイントークン、サイドバー、ページ表示、ホバー、メニュー、レイアウト、テーマ、レスポンシブ          |
| 表示専用JSX      | `src/renderer/App.tsx`    | クラス・`title`・`aria-*`・見出し構造、要素のグルーピング、メニュー外クリックの閉じ処理（state のみ） |
| UI専用新規テスト | `tests/e2e/ui-v2.spec.ts` | 4テスト。実Electronで画面を実測し、JSONとスクリーンショットを残す                                     |
| 記録             | `docs/parallel/ui/`       | 本報告、結果JSON、実測JSON、スクリーンショット                                                        |

変更していない: `src/editor/`、`src/database/`、`src/shared/`、`src/main/`、`src/preload/`、`src/persistence/`、既存テスト、`scripts/folio-agent.mjs`、`package.json` / lockfile、`docs/parallel/CONTRACTS.md`。保存・IPC・競合・Editor/DB の契約には触れていない。

### UI/UX 2.0 の要点

1. **トークン**: light/dark の色・影・角丸・幅・コード色・フォーカス色をCSS変数に集約。`color-scheme`、`::selection`、`prefers-contrast`、`prefers-reduced-motion` を追加。
2. **サイドバー**: 252px。スクロールするセクション見出しを sticky 化、ページ件数バッジ、階層のインデントガイド（`page-tree-children` の縦線）、アクティブ行の左レール、長題の省略と `title`、キーボード時も出る子ページ追加ボタン（`focus-within`）、空状態、フッターのバッジ。
3. **ページ表示**: タイトル `clamp(30px, 2.5vw, 37px)`、種別ピル、メタ情報の区切り、カバー操作、ページ操作のホバー/フォーカス表示、子ページ見出しと件数、文章末の区切り。
4. **ホバー**: 行・お気に入り・子ページ・アウトライン・メニュー項目・検索結果・DBカード・カレンダー日の背景遷移。`@media (hover: none)` では操作を常時表示。
5. **メニュー**: セクション見出し、余白、危険操作の色分け、`aria-expanded`、ビューポート内への収まり。アンカー外の pointerdown で閉じる（表示状態の変更のみで、既存ハンドラ以外は呼ばない）。
6. **レイアウト**: 上部バーのグループ化・区切り、パンくずの省略と `aria-current`、保存状態の `data-state`、サイドバー非表示時に信号機を避ける左余白、狭幅で情報パネルを閉じるボタン。
7. **テーマ**: 暗色の背景・パネル・境界・影・カバー・コード・危険色を専用トークン化。計測で AA 以上を確認（後述）。
8. **レスポンシブ**: 1280px で圧縮、1120px で本文余白を調整、1000px 以下でサイドバー 208px＋情報パネルをオーバーレイ化（明示の閉じるボタン付き）。低いウィンドウではカバーと余白を縮小。

## 2. 実測証拠（最終 run / retries 0）

計測テスト: `tests/e2e/ui-v2.spec.ts`。各値は `getBoundingClientRect` / `getComputedStyle` の実測。生データは [evidence/](evidence/) に保存した。

| 条件           | サイドバー | 情報パネル          | 文書領域 | 本文幅 / 余白 | タイトル   | 横overflow | コントラスト                                          |
| -------------- | ---------- | ------------------- | -------- | ------------- | ---------- | ---------- | ----------------------------------------------------- |
| 1440×907 light | 252        | 240（in-flow）      | 948      | 702px / 64px  | 36px / 700 | 0          | 本文 12.57、見出し 12.57、補助 4.59                   |
| 1440×907 dark  | 252        | 240（in-flow）      | 948      | 702px / 64px  | 36px / 700 | 0          | 本文 13.28、見出し 13.28、補助 6.83、サイドバー 14.15 |
| 1024×720 light | 220        | 224（in-flow）      | 580      | 569px / 46px  | 33px       | 0          | 本文 12.57                                            |
| 960×700 light  | 208        | 268（オーバーレイ） | 752      | 741px / 34px  | 29px       | 0          | 本文 12.57                                            |

- 上部バーは 54px。1440 で操作群の右端は 1428、メニューは `x=1157.2, y=52.9, 270×427` でビューポート内。
- 階層: ルート行の左端 8px、展開した子ページ行は 33px。アクティブ行は 31px 高、`aria-current="page"`。
- ホバー: 行ホバー前 `opacity 0`・`:hover false` → 実マウス移動後 `:hover true`、0.30（遷移中）→ 1。子ページ追加はフォーカスでも表示。ページ操作もホバーで表示。
- キーボード: タイトルから Tab で「太字」へ、`outline: 2px solid`。⌘P で検索ダイアログが開き、入力に初期フォーカス、Esc で閉じる。Enter でページメニュー、Esc で閉じ、フォーカスはメニューボタンに残る。検索結果は ↓ で `aria-current` が移動。
- テーマ: 切替後に `data-theme="dark"` と `aria-pressed="true"`、再読込後も dark（既存設定の維持）。
- 1024 では情報パネルが本文の右（`x=800`）で、本文右端 789 と重ならない。960 ではオーバーレイ（`x=680, y=66, 268×622`）で、閉じるボタンから閉じて上部バーから再表示できる。サイドバー非表示時は上部バーの左余白 88px、横overflow 0。

スクリーンショット（合成テストデータのみ。PNG の sha256 は [evidence/MANIFEST.json](evidence/MANIFEST.json)）:

- `evidence/ui-light-1440x907.png`（実際のビューポートは 1440×907。ファイル名は指定したウィンドウサイズ 1440×960 由来）
- `evidence/ui-dark-1440x907.png`
- `evidence/ui-light-1024x720.png`
- `evidence/ui-light-960x700.png`

## 3. 検証結果

| 実行           | コマンド（すべて隔離ランチャー経由）                               | 結果                        | ログ                                                                      |
| -------------- | ------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------- |
| 型検査（最終） | `node scripts/folio-agent.mjs check`                               | PASS / 0                    | `output/agent-workspace/logs/2026-10-27T03-58-36-305Z-check-917bf229.log` |
| 単体（最終）   | `node scripts/folio-agent.mjs test`                                | PASS 50/50 / 0              | `output/agent-workspace/logs/2026-10-27T03-58-39-337Z-test-5a910661.log`  |
| ビルド（最終） | `node scripts/folio-agent.mjs build`                               | PASS / 0                    | `output/agent-workspace/logs/2026-10-27T03-47-03-114Z-build-889f8213.log` |
| UI実測 4件     | `... test:e2e --retries=0 --reporter=list tests/e2e/ui-v2.spec.ts` | 4/4 PASS / 0                | `...03-53-53-652Z-test-e2e-950bf306.log`                                  |
| 全体E2E        | `... test:e2e --retries=0 --reporter=list`                         | **45/45 PASS / 0**（3.6分） | `...03-54-30-494Z-test-e2e-ae989fde.log`                                  |

source/build hash（`shasum -a 256`）:

- `src/renderer/App.tsx` `67a336df175f98538c9d03dd1809a7a07e6a1274fdf3e66ec32aa88596b0b403`
- `src/renderer/styles.css` `25420e12a46ba196daffba4a7483236e8c128a8bb75e214df1adee66e31b5a88`
- `tests/e2e/ui-v2.spec.ts` `e115ca723752e761bb4b477e4aa4b960b4e0d6d8124eecdd479a0d9c5e3d96e0`
- `dist/renderer/assets/index-BOHnGoVY.css` `dc131258cddf2c4edb30ac3acd4a84fb8cb8a677c34302cd32277c72b579a5d6`
- `dist/renderer/assets/index-dl_u_r6y.js` `f657b02ee0c509a3fd97299028c2cdfcad5baaca0164e17db88d17a31b4e726e`

全体E2Eには既存の desktop / dialogs / drag / gate-a / page-move / recovery / output-boundary と今回の UI 4件を含む。実行後のツリーは clean ではなく、この担当の変更だけが残っている（コミット前時点）。

## 4. 失敗・試行の記録（失敗を隠さない）

1. **03:20 UI E2E 起動失敗（4件）**: Harness が `ELECTRON_RUN_AS_NODE=1` を設定しており、Electron が Node として起動して `bad option: --remote-debugging-port=0`。ランチャーは変更せず、そのコマンドだけ `env -u ELECTRON_RUN_AS_NODE` で子プロセスの環境を戻した。ログ: `...03-20-22-938Z-test-e2e-a535cbee.log`。
2. **03:24 レンダラ異常終了**: `sandbox initialization failed: Operation not permitted`。DSH の Workspace sandbox 下では Chromium の OS サンドボックスが初期化できない。これはアプリやテストの失敗ではなく実行環境の制約。同じコマンドを1回限りの承認付き `danger-full-access` で再実行した。恒久的な sandbox 変更、ランチャー変更、`--no-sandbox` 等の迂回はしていない。ログ: `...03-24-19-860Z-test-e2e-78c153c9.log`。
3. **03:27〜03:30 診断**: 一時的なデバッグ spec で、最小の Electron ページでも同様に sandbox 初期化拒否になることを確認（コミット前に削除。作業ファイルは残していない）。ログ: `...03-27-28-425Z`、`...03-27-57-096Z`、`...03-29-23-234Z`、`...03-30-03-949Z`。
4. **03:32 / 03:37 / 03:43 / 03:49 UI E2E 失敗**: すべてテスト側のホバー観測。macOS のウィンドウが非アクティブな run では `:hover` が付かないことがあり、`locator.hover()` だけでは不安定だった。`app.focus({ steal: true })` と `BrowserWindow.focus()`、実マウスの2段移動、`:hover` 自体の検証を追加して解消。製品CSSの不具合ではなく、再現しなかった成功だけを根拠にしないよう失敗ログを残す。ログ: `...03-32-57-321Z`（1 fail）、`...03-37-57-727Z`（1 fail）、`...03-43-26-684Z`（1 fail）、`...03-49-57-864Z`（1 fail）。
5. 上記の後、UI 4/4 と全体 45/45 を retries 0 で取得。自動 retry、固定 sleep による回避、既存テストの skip/期待値変更はしていない。

## 5. 未完・未検証・注意

- 物理日本語IME、Notionとの実比較は未実施（NOT_RUN / UNKNOWN）。今回の合成 composition テストは既存の範囲を変更していない。
- `dev` サーバー起動は今回 NOT_RUN。検証はビルド済み `dist` の実Electronで行った。
- 計測した画面は 1440×907 / 1024×720 / 960×700（light/dark は 1440 のみ）。中間幅の全ピクセル比較や旧画面との画像差分は未実施。
- 960 以下では情報パネルが本文に重なるオーバーレイ（明示の閉じるボタン付き）。本文を隠さない配置の最適化は未実施。
- 新しい証拠PNGは合成データだが、`docs/review-policy.json` の reviewedBinaries には未登録。共有・レビュー時の登録（または `docs/screenshots/` への移動）は統合側の作業。自分では共有ポリシーと他担当のファイルを変更していない。
- ホバー検証は実ウィンドウのアクティブ状態に依存するため、テスト内でウィンドウを前面化している。ヘッドレスや非アクティブ窓での `:hover` 保証ではない。
- スクリーンショットはテストの一時ワークスペース（`output/` 配下）で取得し、`docs/parallel/ui/evidence/` にコピーした。実ユーザーデータは使用していない。

## 6. 参照

- 生の計測: [ui-light-metrics.json](evidence/ui-light-metrics.json)、[ui-dark-metrics.json](evidence/ui-dark-metrics.json)、[ui-responsive-metrics.json](evidence/ui-responsive-metrics.json)、[ui-hover-state.json](evidence/ui-hover-state.json)、[ui-keyboard-metrics.json](evidence/ui-keyboard-metrics.json)
- 実行結果の構造化記録: [results.json](results.json)
- タスク・契約: [AGENT_TASK.md](../../../AGENT_TASK.md)、[CONTRACTS.md](../CONTRACTS.md)
