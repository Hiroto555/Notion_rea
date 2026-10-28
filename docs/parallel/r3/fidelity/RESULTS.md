# Round 3 Fidelity — 実装・検証記録

2026-10-27（Asia/Tokyo）。lane D / role `fidelity`、branch `r3/fidelity`、開始 HEAD `9a7de18`（contract `c6ced9c`、master `bd0f1e7`）。作業はこの worktree 内の担当ファイルだけに限定した。

- 検証対象の機能コミット: **作成できず**（作業ツリーを検証。理由は「6. ローカルコミット」）。branch は開始時 `9a7de18` のまま。
- 実装対象ソース（sha256）:
  - `src/renderer/Modal.tsx` `8b145aec4a5292a8cca15feb1109114ecf279dec905390def96f95411ec966fa`
  - `src/renderer/styles.css` `d0a3a0efa64b9ca605c23e8d38bcd11b44b14b9972d3dc619b26c16966c04822`
  - `tests/e2e/r3-fidelity.spec.ts` `ad03e34b022cc840d6025fde66a563d46887f1bf18106b8395e43214266c561f`
  - `tests/fidelity-modal-contract.test.ts` `92767573cafb62c8d0bb925c0cb30e8e9aa17e0ebbd5c6ba48e643139c41b785`
  - `tests/fidelity-display-contract.test.ts` `07e5dc79e1855ed85c52ec33fd0873d02cc0270dc0884ce4cdf708d6f6646963`
  - `tests/fidelity-evidence.test.ts` `efcfe30572348c95b19da73a10920d04383244fc39e52dc485b03c002ec576e2`
- build（sha256）: `dist/renderer/assets/index-HclxMr0T.css` `0703f28e…`, `dist/renderer/assets/index-BH2kIirw.js` `02deb3a8…`（dist は git 管理外）
- E2E 後に `Modal.tsx` とテスト/文書だけ Prettier 整形した。整形後の再 build は上の dist と **同一ハッシュ**（css/js とも byte-for-byte）で、E2E が観測した runtime 成果物と一致する。styles.css は整形前後で変更なし。E2E の Playwright spec も空白のみ整形しており、操作・断言の意味は実行時と同一。

## 1. 環境

| 項目                 | 値                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------- |
| OS                   | macOS 26.6.2 (25G83) arm64                                                              |
| Node / npm           | 24.20.0 / 11.19.0                                                                       |
| Electron / Chromium  | 45.0.0 / 156.0.8078.48                                                                  |
| UI 言語 / zoom / DPR | ja / 1 / 2                                                                              |
| 実測 viewport        | 1440×907、1024×720、960×700（window 指定 1440×960 等ではない実測値）                    |
| 入力経路             | Playwright の pointer / keyboard。合成 composition のみ。物理日本語 IME は NOT_RUN      |
| データ               | 各 E2E が作る隔離一時ワークスペースの合成 seed。実ユーザー・顧客データは使っていない    |
| 実行                 | すべて `node scripts/folio-agent.mjs` 経由。単体/E2E は共有ロック、E2E は `--retries=0` |

## 2. 変更した画面・操作

### 2.1 幅 960 の情報パネル（実装）

`styles.css` の `@media (max-width: 1000px)` で、情報パネルは従来どおり浮動（`absolute`）のまま、編集列のスクロール領域にパネル分の右余白（`calc(268px + 24px)`）を確保した。パネルは閉じるボタンから閉じられ、上部バーから再表示できる既存操作を保つ。これにより 960 でも本文・タイトルがパネルの下に隠れない。

実測（light、`evidence/r3-responsive.json`）:

| 幅       | sidebar | inspector   | content 右端 | inspector 左端 | 本文幅           | title | overflow |
| -------- | ------- | ----------- | ------------ | -------------- | ---------------- | ----- | -------- |
| 1440×907 | 252     | 240 in-flow | 1135.5       | 1200           | 830（title 702） | 36px  | 0        |
| 1024×720 | 220     | 224 in-flow | 789          | 800            | 569（title 477） | 33px  | 0        |
| 960×700  | 208     | 268 浮動    | 657          | 680            | 449（title 381） | 29px  | 0        |

960 の右余白は 292px、`documentOverflow` は 0。パネルとの間に最低 23px の間隔がある。サイドバーを閉じた 960 でも content 右端 657 < inspector 左端 680、横 overflow 0（`r3-long-title-keyboard-motion.json`）。1024/1440 の in-flow 配置・title サイズ・閉じるボタン非表示という旧仕様は維持したため、`tests/e2e/ui-v2.spec.ts` の既存レスポンシブ期待値を変更していない（ただし同 spec の再実行は下記の理由で NOT_RUN）。

### 2.2 ダイアログの focus 契約（実装）

`src/renderer/Modal.tsx` を共通の native `<dialog>` 経路に統一した。`DialogFrame` の旧非モーダル分岐を廃止し、検索・リンク・DB record だけでなく、テンプレート・移動・履歴・ゴミ箱も同じ top layer と focus 契約を使う。

- 初期 focus: `[data-initial-focus]` / `[autofocus]` → 旧一覧ダイアログの先頭アクション（`.dialog-list` / `.templates`）→ 先頭の focusable → dialog 自身。
- 上下キー: 一覧系（`.dialog-list` / `.templates`）で focus を循環移動。Enter は browser の button 活性化。Escape は native cancel。
- Tab / Shift+Tab: dialog 内で循環。focus 可能要素がない場合は dialog 自身に focus。
- composition 中と、native select の popup を閉じる Escape は dialog を閉じない。
- 閉じた後: 呼び出し元の要素 → アンマウントされた dropdown 項目なら保持したメニューボタン → `.page-title` の順で復帰。StrictMode の即時再 open は復帰しない。
- 背景: native modal の inert と backdrop click（外側座標のみ）で、背景のページ操作・フォーカス移動を遮断。

実測（`evidence/r3-focus-contract.json`）:

| 画面         | 初期 focus               | 閉じた後の復帰                                              |
| ------------ | ------------------------ | ----------------------------------------------------------- |
| 検索         | 検索キーワード入力       | ページタイトル（既存の文脈なし）                            |
| ページリンク | 検索キーワード入力       | 元の本文選択（「リンク対象」）と editor focus               |
| テンプレート | 先頭カード（空のページ） | サイドバーのテンプレートボタン。Enter で「無題」作成        |
| ページを移動 | 一覧の先頭行             | 上部バーのページメニューボタン（dropdown 項目は消えるため） |
| 変更履歴     | 先頭の「復元」           | 「変更履歴を見る」ボタン                                    |
| ゴミ箱       | 先頭の「復元」           | サイドバーのゴミ箱ボタン                                    |

検索結果は ArrowDown で `aria-current` が移動し、背景 click は dialog を閉じるだけでページを切り替えない。合成 composition 中の Escape は無視され、composition 終了後の Escape で閉じた。テンプレート・移動・履歴・ゴミ箱の Tab/Shift+Tab は dialog 内に留まった。物理 IME は実施していない。

### 2.3 DB record の表示・操作（fixture）

`evidence/r3-db-record-display.json`。現行ブランチは `DatabaseData` v2 の fixture UI で、`DatabaseProjection` / `RecordRequest` は未実装である。

- ギャラリー・ボード・カレンダーのカードから同じ `アイテムを編集` dialog が開き、`aria-modal=true`、タイトル入力に初期 focus、`Tab`/`Shift+Tab` が 4 要素を循環。
- 1440/1024/960 の全 9 通りで panel は viewport 内（620×245、x=410/202/170）。Escape でカードへ focus 復帰。背景 click はページ操作を起こさない。
- 960 でも record panel は viewport 内で操作可能。長い日本語タイトル（119 文字）は record input 内で保持され、Escape → 再起動 → 再 open で同じ値だった。
- テーブル view は行内編集のままで、full-page record は開かない（`recordDialog: false`）。契約の「全 view から同じ full-page record」は NOT_IMPLEMENTED として記録し、PASS と扱わない。legacy fixture の保存経路は確認したが、新 record の live persistence は NOT_RUN。

### 2.4 長い日本語タイトル・focus 表示・色・motion

`evidence/r3-long-title-keyboard-motion.json`。

- 119 文字の日本語 + 長い ASCII 断片を 960 で設定。document 横 overflow 0、title 右端 623 < inspector 左端 680。
- sidebar の active 行と breadcrumb は `text-overflow: ellipsis`（scrollWidth > clientWidth）。inspector のページ名は `overflow-wrap: anywhere` で折り返す。タイトル入力は 1 行 input のため内部スクロール（値は保持）。input を autosize textarea にする変更は App 担当への依頼とした。
- タイトル、record タイトル、検索 input、editor、checkbox に `:focus-visible` の 2px ring を追加。タイトルで `focus-visible: true`、`outline: solid 2px`、色 `rgb(85, 119, 93)`。text input は mouse focus でも `:focus-visible` に一致するため、その事実も記録した（マウス操作時に ring が出る）。
- light/dark の本文・補助・inspector・sidebar の実測 contrast はすべて 4.5 以上（light: 12.57 / 4.59 / 6.58 / 6.29、dark: 13.28 / 6.83 / 9.79 / 5.74）。テーマ切替後も `data-theme` と token が変わる。
- `prefers-reduced-motion: reduce` で `scroll-behavior: auto`、dropdown の `animation-name: none`、`.page-tools` の transition 0 秒を確認。

## 3. 実行と終了コード

| 実行                                 | コマンド（隔離ランチャー経由）                                                                                                | 結果                                                                                                                   | ログ（`output/agent-workspace/logs/`）                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 型検査（最終）                       | `node scripts/folio-agent.mjs check`                                                                                          | PASS / 0                                                                                                               | `2026-10-27T07-50-19-630Z-check-637ac2d3.log`                                                                    |
| build（最終、E2E と同一 dist）       | `node scripts/folio-agent.mjs build`                                                                                          | PASS / 0                                                                                                               | `2026-10-27T07-44-25-905Z-build-8d1264c4.log`（E2E 時 build は `07-17-31-995Z-build-283c84b2.log`、dist は同一） |
| 単体（Fidelity 専用 26 件）          | `node scripts/folio-agent.mjs test fidelity`                                                                                  | PASS 26/26 / 0                                                                                                         | `2026-10-27T07-50-49-831Z-test-b349e8c4.log`（整形前の同内容 run: `07-29-26-802Z-test-84f2aa0e.log`）            |
| 単体（全体、1 回目）                 | `node scripts/folio-agent.mjs test`                                                                                           | **FAIL 113/114 / 1**（`recovery.test.ts` の既存 boundary case が 5000ms timeout。他 13 file と Fidelity 26 件は PASS） | `2026-10-27T07-30-25-075Z-test-e7066411.log`                                                                     |
| 単体（全体、再実行）                 | `node scripts/folio-agent.mjs test`                                                                                           | **FAIL 113/114 / 1**（同じ test が同じ 5000ms timeout）                                                                | `2026-10-27T07-38-07-197Z-test-82d64a15.log`                                                                     |
| 単体（recovery のみ、診断）          | `node scripts/folio-agent.mjs test recovery`                                                                                  | **FAIL 13/16**（同じ 3 件が timeout。43 秒）                                                                           | `2026-10-27T07-39-44-333Z-test-20933837.log`                                                                     |
| 単体（recovery のみ、1 worker 診断） | `node scripts/folio-agent.mjs test --maxWorkers=1 recovery`                                                                   | **FAIL 13/16**（同じ 3 件。38 秒。並列度は原因ではない）                                                               | `2026-10-27T07-40-49-353Z-test-fa527007.log`                                                                     |
| E2E（Fidelity 4 件）                 | `env -u ELECTRON_RUN_AS_NODE node scripts/folio-agent.mjs test:e2e --retries=0 --reporter=list tests/e2e/r3-fidelity.spec.ts` | **PASS 4/4 / 0**（1.2 分、共有ロック取得）                                                                             | `2026-10-27T07-20-35-872Z-test-e2e-a29ba222.log`                                                                 |
| E2E（既存 UI/ダイアログ回帰、全体）  | 同じ形式で `ui-v2.spec.ts` / `dialogs.spec.ts` / 全体                                                                         | **NOT_RUN**                                                                                                            | 権限拡張を保留されたため未実行。試験は開始していない                                                             |
| 単体（開始時 baseline）              | `node scripts/folio-agent.mjs test`                                                                                           | PASS 88/88 / 0                                                                                                         | `2026-10-27T07-07-51-929Z-test-de706a30.log`                                                                     |
| E2E（初回）                          | `... database-v2.spec.ts`                                                                                                     | FAIL（app 起動前に renderer が ready にならない）                                                                      | `2026-10-27T07-08-41-732Z-test-e2e-b8130c60.log`                                                                 |
| E2E（環境診断）                      | 一時 spec（削除済み）                                                                                                         | `sandbox initialization failed: Operation not permitted` / GPU 停止を記録                                              | `2026-10-27T07-10-23-874Z-test-e2e-8e7901cd.log`                                                                 |

### 失敗・未実施の扱い

- 最初の E2E は DSH workspace-write 下で Chromium の子プロセス sandbox を初期化できず、`.page-title` が出ないまま終了した。アプリ/テストの失敗ではなく実行環境の制約。テスト期待値・retry・skip は変えていない。
- 環境診断後、同じランチャー・同じ E2E コマンドを 1 回だけ承認付きで実行し、Fidelity 4/4 を得た。その後、既存 E2E 回帰と全体 E2E のための権限拡張は保留された。**回避起動・別経路・`--no-sandbox` 等は行っていない。** そのため既存 suite と全体 E2E は NOT_RUN である。Fidelity 4/4 の成功を「全体 E2E 成功」や「既存回帰なし」の証明には使わない。
- 単体全体の 1 件は、同時刻の load average が 95/68 と非常に高く、編集していない `tests/recovery.test.ts` の既知 boundary case が 5.0 秒を超えたもの。2 回目（load 49）でも同じ test が timeout し、recovery だけを 1 worker で走らせても 3/16 が timeout した。並列度ではなく実行環境の負荷と整合するが、**原因は断定しない**。開始時 baseline は 88/88 PASS だった。FAIL を隠さず残し、PASS として数えない。Fidelity 専用 26 件は同じ run で PASS。全体単体の clean PASS は **NOT_RUN** のまま。
- full unit の再実行・診断は `recovery.test.ts` の期待値や timeout を変更せず、skip/retry もしていない。
- `npm run package`、開発サーバー起動、パッケージ起動は NOT_RUN。

## 4. 同条件の比較（Folio / Notion / 公式資料 / 判定を分離）

Notion は今回一切操作していない。専用テスト領域の現地確認・アクセス根拠の証拠がないため、Notion の版、取得日、theme、viewport、入力経路、画面結果はすべて UNKNOWN。公式資料も今回新規に参照しておらず、既存 `docs/parallel/research` の snapshot は変更していない。したがって MATCH は 0 件、差分の断定も 0 件。

| ID  | 項目                                    | Folio 実測（証拠）                                                | Notion 観測 | 公式資料                          | 判定                             |
| --- | --------------------------------------- | ----------------------------------------------------------------- | ----------- | --------------------------------- | -------------------------------- |
| F1  | 960 の情報パネル                        | 右余白 292px、content 右端 657 < panel 680、overflow 0            | 未観測      | 参照せず                          | Folio 側修正。比較は UNKNOWN     |
| F2  | 1024/1440 の in-flow 配置               | 789≤800 / 1135.5≤1200、overflow 0                                 | 未観測      | 参照せず                          | Folio のみ                       |
| F3  | ダイアログ初期 focus・Tab・Escape・復帰 | search/link/record/旧 4 画面で確認                                | 未観測      | WAI-ARIA は Notion の証拠ではない | Folio のみ / 比較 UNKNOWN        |
| F4  | DB record の全 view 同一 full-page      | gallery/board/calendar は fixture modal。table は行内編集         | 未観測      | 契約は full-page を要求           | **NOT_IMPLEMENTED / NOT_RUN**    |
| F5  | 長い日本語タイトル                      | sidebar/breadcrumb 省略、inspector 折返し、title は内部スクロール | 未観測      | 参照せず                          | Folio のみ。wrapping は App 依頼 |
| F6  | physical 日本語 IME                     | NOT_RUN（合成 composition のみ）                                  | NOT_RUN     | —                                 | NOT_RUN                          |
| F7  | reduced motion / dark                   | transition/animation 停止、contrast 4.5 以上                      | 未観測      | 参照せず                          | Folio のみ                       |
| F8  | 背景操作の遮断                          | backdrop click は閉じるだけでページ操作なし、Tab は dialog 内     | 未観測      | —                                 | Folio のみ                       |

## 5. UNKNOWN / NOT_RUN

- Notion の実観測（版・取得日・画面・操作・保存結果）: **UNKNOWN**。テスト専用領域の許可・現地確認の証拠がない。個人/顧客ページは使っていない。
- 物理日本語 IME（変換・候補・取消・再変換）: **NOT_RUN**。合成 composition の結果を物理 IME の代用にしない。
- 既存 E2E の回帰（`ui-v2`、`dialogs`、`page-move`、`gate-a`、`desktop`、`drag`、`recovery` ほか）と全体 E2E: **NOT_RUN**（権限保留）。
- full-page record をテーブル view から開く動作、`RecordRequest` / `DatabaseProjection` の live 保存・競合: **NOT_IMPLEMENTED / NOT_RUN**。
- ページタイトルの複数行 autosize（長い日本語の折返し）: **NOT_RUN / App 担当**。現行は 1 行 input の内部スクロール。
- 960 未満、zoom 1 以外、日本語以外の UI、touch 実機、OS の reduced motion 設定変更、パッケージ起動: **NOT_RUN**。
- 既存 `tests/e2e/page-move.spec.ts` の F11「移動中に入力」は、移動 dialog を native modal にした影響（背景 inert で programmatic fill が届かない可能性）を**実行して確認できていない**。既存の保存・復帰保証を弱めないため、テストは変更せず、レビュー依頼として [HANDOFF.md](HANDOFF.md) に条件と代替案を記載した。**UNVERIFIED**。
- 既存 `ui-v2.spec.ts` の 960 期待値（absolute / close 表示 / title 29px）は維持する実装にしたが、同 spec の再実行は **NOT_RUN**。

## 6. ローカルコミット（未完了・sandbox 拒否）

作業ツリーは担当ファイルだけを変更した状態で残している。`git add` を 1 回実行したが、sandbox が共有 Git 管理ディレクトリへの書き込みを拒否した。

- 実行: `git add src/renderer/Modal.tsx src/renderer/styles.css tests/e2e/r3-fidelity.spec.ts tests/fidelity-*.test.ts docs/parallel/r3/fidelity`
- 終了コード: 128
- 出力: `fatal: Unable to create '<shared-git-dir>/worktrees/Folio-r3-fidelity/index.lock': Operation not permitted`
- 原因: この worktree の Git common dir は workspace 外にあり、DSH workspace-write sandbox の書き込み範囲外。`docs/parallel/CONTRACTS.md` に記録されている制約と同じ。
- 対応: 権限拡張の承認は保留されているため、`danger-full-access` の再要求・OS sandbox の回避・別経路での Git 書き込み・push・merge は行っていない。commit は作成できず、branch は `9a7de18` のまま。作業ツリーの変更は残っている。
- 影響: commit SHA を `RESULTS.md` に記録できない。レビューは working tree の diff と上の sha256 で照合する。承認された Git 書き込み（1 回限り）または統合担当による commit が必要。
- 代替の引き渡し: `output/agent-workspace/evidence/r3-fidelity-working-tree.patch` に 15 ファイルの review 用 unified diff を生成した（git 管理外、適用は未試験）。作業ツリー自体が正本で、patch は commit できない環境向けの控え。

## 7. 未完・依頼

Editor 内部（slash の clamp/flip と ARIA、block handle、深いネスト）と App（ページメニューの矢印操作、タイトル textarea、アウトラインの reduced motion、icon picker）は担当外のため、具体的な差分を [HANDOFF.md](HANDOFF.md) に残した。DB UI/Core の full-page record と `RecordRequest` 接続も未実装で、受入は fixture 表示まで。受入項目との対応は [ACCEPTANCE-MAP.md](ACCEPTANCE-MAP.md)。

## 8. 証拠

- [evidence/r3-responsive.json](evidence/r3-responsive.json)（sha256 `ce4f38b0…`）
- [evidence/r3-db-record-display.json](evidence/r3-db-record-display.json)（`e0a01cfb…`）
- [evidence/r3-focus-contract.json](evidence/r3-focus-contract.json)（`3cc69857…`）
- [evidence/r3-long-title-keyboard-motion.json](evidence/r3-long-title-keyboard-motion.json)（`2bd7f42d…`）
- [evidence/MANIFEST.json](evidence/MANIFEST.json): 上の JSON と、`output/playwright/results/` に残した合成 PNG の sha256。PNG はレビュー未登録の binary のため docs にはコミットしていない。
- 生ログ・スクリーンショット・一時ワークスペースは `output/`（git 管理外）にのみある。docs には個人パス・個人画面・生ログを置いていない。
