# 再現可能な操作テスト手順

参照実測は **NOT_RUN**、物理 IME は **NOT_RUN**。以下は Folio 側で実際に実行できる自動試験と、許可後にのみ実施する Notion 側の手動手順を分けて記す。Notion 手順はまだ実行していない。

## 0. 共通の実行条件

- リポジトリの `sprint/research` worktree で、必ずランチャー経由で実行する。ブランチが違う場合はランチャー自身が拒否する。
- 直接 `npm run test:e2e`、`npx playwright`、`npm run dev`、`npx electron` を実行しない。データ・cache・TMPDIR・port の隔離を迂回しない。
- 単体試験と E2E は `/tmp` の共有ロックで排他される。待機中は「Tests have not started.」の表示を確認し、ロックを削除・改名しない。
- E2E は `dist/main.cjs` を起動するため、先に `node scripts/folio-agent.mjs build` を通す。古い dist での結果を新しいソースの証明にしない。
- 失敗時も `--retries` を 0 のままにする。固定 sleep、skip、期待値の弱体化で PASS にしない。
- 出力・終了コードは `output/agent-workspace/logs/` に残る。研究側の要約は `verification.json` に記録する。
- この Harness 環境では親プロセスに `ELECTRON_RUN_AS_NODE=1` が設定されている場合がある。そのまま E2E を起動すると Electron が Node として起動し、`bad option: --remote-debugging-port=0` で全件が起動前に失敗する（2026-10-27 の初回試行で発生）。アプリやテストの失敗ではない。ランチャーはそのまま使い、E2E のときだけ親の変数を外す（`env -u ELECTRON_RUN_AS_NODE node scripts/folio-agent.mjs test:e2e ...`）。
- さらに、DSH の workspace-write sandbox 下では Chromium の子プロセス sandbox が `Operation not permitted` で初期化できず、GPU/network プロセスが終了してアプリが `.page-title` を表示しない（2026-10-27 に再現）。この場合、テストの期待値・retry・skip を変えず、そのセッションの結果を **NOT_RUN（環境要因）** と記録する。sandbox を無効化する起動オプションや恒久的な権限変更で迂回しない。通常のデスクトップセッションで同じランチャー・同じコミットを使って再実行する。

## 1. 記録テンプレート

参照実測を実施するときは、操作前に次を記録する。1つでも UNKNOWN のままなら比較判定は UNKNOWN とする。

| 項目 | 必須 | 記録例 |
| --- | --- | --- |
| 実施日時（タイムゾーン付き） | 必須 | 2026-10-27T13:00:00+09:00 |
| Notion の版 / surface | 必須 | 例: 45.x / desktop。UNKNOWN なら比較しない |
| OS / ビルド / CPU | 必須 | macOS 26.6.2 (25G83) arm64 |
| UI 言語 / theme | 必須 | 日本語 / light（dark も別試行） |
| viewport / zoom / devicePixelRatio | 必須 | 1440×907 / 1 / 2 |
| 入力方式 | 必須 | 実マウス・物理キーボード、日本語 IME 名と版 |
| fixture | 必須 | 合成文書の項目一覧と作成日。個人/顧客データを含めない |
| 操作手順 | 必須 | 各操作のキー・クリック位置・待機条件 |
| 観測結果 | 必須 | 画面、選択範囲、フォーカス、順序、保存結果、再起動後 |
| 証拠ファイル | 必須 | 合成画面のスクリーンショット、保存結果の要約。生データは共有しない |
| 観測者 / 許可根拠 | 必須 | 誰が、どの許可に基づき、どのテスト専用領域で実施したか |

Folio 側の実測条件は [environment.json](environment.json) と `docs/validation/next-round/environment.json`（0bf710e 時点）に記録がある。今回の再実行は `verification.json` と `evidence/` に追記する。

## 2. fixture

### 2.1 将来の同一比較用fixture（Notion 側は未作成）

- ページ「比較用ノート」
- 本文「不**動**産」「soft**ware**」
- リンク先「比較用リンク先」
- 順序付きブロック「Alpha」「Bravo」「Charlie」（太字/見出し/段落）
- DB 行「Record A」（status 未着手、date 2026-10-26、数値 123）

Notion 側にはまだ作成していない。Folio の各 E2E は専用の一時ワークスペースに別の合成 seed を作るため、現時点で「同一 fixture」の比較は成立しない。

### 2.2 Folio 自動試験が作る合成 fixture

| ID | テストファイル | 合成内容 |
| --- | --- | --- |
| N01 | `tests/e2e/gate-a.spec.ts` | 「Gate A original」/「Original body」、添付 note.txt、リンク先「アイデアノート」、Markdown/HTML 出力 |
| N02 | 同上 | 「Formatted words」、`不`+太字`動`+`産`、hardBreak、`soft`+link`ware`（12文字） |
| N03 | `tests/e2e/dialogs.spec.ts` | 太字を含む「不動産 software」とリンク先「アイデアノート」 |
| N04 | 同上 | 新規ページで `/heading`・`/todo`、矢印/Enter/Escape、カーソル位置 |
| N05 | `tests/e2e/drag.spec.ts` | 「Alpha heading」「Bravo 不動産」「Charlie task」と末尾空段落 |
| N06 | 同上 | Alpha/太字Bravo/斜体Charlie/Block 4〜30、30ブロック、スクロール領域 |
| N07 | `tests/e2e/dialogs.spec.ts` | 合成seedのプロジェクトDB、ギャラリーカード、Record updated Aあ😀 |
| N08 | 補助のみ | 合成 composition。物理 IME の代用にしない |
| N09 | `tests/e2e/page-move.spec.ts` | 「Move Target」「Move Source」「Move Child」、太字本文「移動前本文」 |

## 3. シナリオ別手順

### N01 同一ページ再選択・Undo/Redo・書き出し

**Folio（実行可能）**

```sh
node scripts/folio-agent.mjs test:e2e --retries=0 --reporter=list tests/e2e/gate-a.spec.ts --grep "F01 same-page"
```

- 5回のサイドバー再選択、検索結果からの再選択、Markdown/HTML 書き出し、Undo/Redo、添付・リンクの維持を確認する。
- 断言: エディタ DOM の同一性、`.folio-editor` の本文、出力ファイルの内容、保存済み表示。
- 証拠: 実行ログ、`environment.json`、失敗時の screenshot/trace（`--output` 配下）。

**Notion（BLOCKED / NOT_RUN）**

1. テスト専用領域に固定 fixture を作り、環境を記録する。
2. サイドバーで同じページを5回選び直し、本文・添付・リンク・DB 参照の表示を確認する。
3. Undo/Redo を各1回以上実行し、履歴の戻り先を確認する。
4. Markdown/HTML を書き出し、本文・書式・リンク・添付の表現を比較する。
5. 再読み込みし、同じ状態が残るか確認する。

**比較判定**: 両側の fixture と環境が一致し、参照実測が OBSERVED になった場合のみ MATCH/DIFF。現在は UNKNOWN。

### N02 書式境界をまたぐ検索

**Folio（実行可能）**

```sh
node scripts/folio-agent.mjs test:e2e --retries=0 --reporter=list tests/e2e/gate-a.spec.ts --grep "F02 full-text"
```

- 「不動産」「software」を全体検索とページ内検索で検索し、件数・プレビュー・選択文字列・太字の保持を確認する。
- 状態の取得はユーザー選択が完了した後（poll）に行う。過渡状態を合格にしない。

**Notion（BLOCKED / NOT_RUN）**

1. 固定 fixture を作成し、環境を記録する。
2. `⌘/Ctrl+K`（全体検索）で各語を検索し、ヒット件数とプレビューを記録する。
3. `⌘/Ctrl+F`（ページ内検索）で各語を検索し、件数・強調・選択範囲を記録する。
4. 書式境界（太字、改行、リンク）ごとに、検索語が一致した範囲を画面で確認する。

**比較判定**: 件数と選択範囲が両側で記録できた場合のみ判定。公式資料は検索の存在のみ。

### N03 選択テキストへのリンク確定/取消

**Folio（実行可能）**

```sh
node scripts/folio-agent.mjs test:e2e --retries=0 --reporter=list tests/e2e/dialogs.spec.ts --grep "selected text link"
node scripts/folio-agent.mjs test:e2e --retries=0 --reporter=list tests/e2e/dialogs.spec.ts --grep "stale link"
```

- 太字を含む「不動産」を選択して `⌘K`→Escape。文書・選択範囲・フォーカスが元に戻ることを確認する。
- 別試行でリンク先を確定し、リンク化後も太字が残ることを確認する。
- 古い/競合するリンク文書が拒否され、両ページが変わらないことを確認する。

**Notion（BLOCKED / NOT_RUN）**

1. 固定 fixture で「不動産」を選択し、`⌘K` を押す。
2. Escape で取消し、選択範囲・書式・フォーカス・文書内容を確認する。
3. 再度 `⌘K` でリンク先を確定し、リンク範囲と太字を確認する。
4. 別ページへ移動して戻り、取消が文書を変えていないことを確認する。

**比較判定**: 公式資料は⌘Kのリンク追加のみ。取消の細部は実測がない限り UNKNOWN。

### N04 slash メニューのキーボード操作

**Folio（実行可能）**

```sh
node scripts/folio-agent.mjs test:e2e --retries=0 --reporter=list tests/e2e/dialogs.spec.ts --grep "N04 slash"
```

- `/heading` でメニューを開き、ArrowDown→Enter で確定して入力継続を確認する。
- `/todo` でメニューを開き、Escape で取消して文書と選択位置が変わらないことを確認する。

**Notion（BLOCKED / NOT_RUN）**

1. 空行で `/h1` を入力し、候補の上下移動・Enter・Escape を各1回試す。
2. 確定後のカーソル位置と、Escape 後の入力継続を確認する。
3. 候補が絞り込まれた状態、候補ゼロ件、IME 変換中の Enter を別試行として記録する（物理 IME は N08）。

**比較判定**: 公式はメニューの存在のみ。キー処理と取消は実測が必要。

### N05 単一ブロックのハンドル移動

**Folio（実行可能）**

```sh
node scripts/folio-agent.mjs test:e2e --retries=0 --reporter=list tests/e2e/drag.spec.ts --grep "short original"
node scripts/folio-agent.mjs test:e2e --retries=0 --reporter=list tests/e2e/drag.spec.ts --grep "top-level matrix"
```

- 実マウスでハンドルをつかみ、dragstart/drop と move ACK を観測する。合成 drop で代替しない。
- 移動後、Undo/Redo、保存済み、再起動後の順序・本文を確認する。

**Notion（BLOCKED / NOT_RUN）**

1. 「Alpha heading」「Bravo」「Charlie」を作り、⋮⋮ ハンドルで先頭→末尾、末尾→先頭、同位置を試す。
2. 各ドロップ後に順序・書式・選択・フォーカスを確認する。
3. Undo/Redo、再読み込み（または再起動）後の状態を確認する。
4. ドロップ境界の外へ出した場合、Escape した場合を別試行で記録する。

**比較判定**: 公式はハンドル移動の存在のみ。境界・取消・履歴は実測が必要。

### N06 複数ブロック選択と移動

**Folio（実行可能）**

```sh
node scripts/folio-agent.mjs test:e2e --retries=0 --reporter=list tests/e2e/drag.spec.ts --grep "top-level matrix"
```

- 2ブロックを Shift で選択し、2ブロック表示を確認してから先頭/末尾へ移動する。
- 同位置ドロップ、Escape 取消、スクロール後の移動、Undo/Redo、再起動を確認する。
- 同位置ドロップが直前の移動を Undo 履歴から隠さないことを確認する。

**Notion（BLOCKED / NOT_RUN）**

1. 連続する3ブロックを Shift+クリックで選択し、選択数・書式・順序を記録する。
2. 先頭/末尾へドラッグし、移動後の順序・個数・書式を確認する。
3. 同位置ドロップ、Escape 取消、スクロール後の移動を別試行で確認する。
4. Undo/Redo と再読み込みを確認する。

**比較判定**: 公式は複数ブロック選択の存在を示すが、選択規則・取消・境界は未記載。実測なしに MATCH にしない。

### N07 DB レコードのモーダル操作

**Folio（実行可能）**

```sh
node scripts/folio-agent.mjs test:e2e --retries=0 --reporter=list tests/e2e/dialogs.spec.ts --grep "R3 DB Escape"
node scripts/folio-agent.mjs test:e2e --retries=0 --reporter=list tests/e2e/dialogs.spec.ts --grep "R3 search/link/record"
node scripts/folio-agent.mjs test:e2e --retries=0 --reporter=list tests/e2e/dialogs.spec.ts --grep "nested native UI"
```

- ギャラリーの Record を開き、タイトルを編集して Escape。保存・再起動・値の保持・カードへのフォーカス復帰を確認する。
- 検索/リンク/レコードの各モーダルで、初期フォーカス・Tab/Shift+Tab の循環・背景の不活性・close を確認する。
- ネイティブ UI（select 等）が Escape を1回消費し、外側のモーダルを巻き込まないことを確認する。

**Notion（BLOCKED / NOT_RUN）**

1. テスト用 DB に Record A を作成し、環境を記録する。
2. レコードを開き、初期フォーカス位置と背景の操作可否を確認する。
3. Tab/Shift+Tab をタブ可能要素以上に繰り返し、フォーカスが外へ出ないことを確認する。
4. 入力→Escape→再オープン→リロードを行い、値とフォーカス復帰先を確認する。
5. ページのプロパティ選択などネイティブ風の UI がある場合、Escape の消費先を確認する。

**比較判定**: WAI-ARIA は観測項目の設計契約であり、Notion の実装証拠ではない。Notion 実測がない限り UNKNOWN。

### N08 物理日本語 IME

**現状: NOT_RUN。自動テストは補助証拠のみ。**

```sh
node scripts/folio-agent.mjs test:e2e --retries=0 --reporter=list tests/e2e/gate-a.spec.ts --grep "F06 synthetic composing"
node scripts/folio-agent.mjs test:e2e --retries=0 --reporter=list tests/e2e/dialogs.spec.ts --grep "synthetic composition"
```

上記は CompositionEvent の発火順を確認する補助試験であり、物理 IME の変換・候補選択・取消を再現しない。結果を N08 の PASS に使わない。

**手順（人間の観測者が必要）**

1. 日本語 IME（例: macOS の日本語入力）を有効にし、本文で「ふどうさん」と入力する。
2. Space で候補を変更し、Enter で確定する。本文の欠落・二重挿入・未確定文字の残りを確認する。
3. 確定済み文字列を再変換し、候補中に Escape を押す。取消前後の文書・選択・フォーカスを確認する。
4. 同じ操作を全体検索、ページ内検索、リンク先検索、DB のタイトル入力で繰り返す。Enter/Escape が意図せず確定・閉鎖しないか確認する。
5. OS/IME 版、キー列、画面、保存結果、再起動後、観測者を記録する。可能なら Folio と許可済み Notion の両方で同一手順を行う。

**比較判定**: 物理 IME の両側実測が揃うまで NOT_RUN / UNKNOWN。文書だけの判定は禁止。

### N09 ページツリーの移動

**Folio（実行可能・既知の不安定さあり）**

```sh
node scripts/folio-agent.mjs test:e2e --retries=0 --reporter=list tests/e2e/page-move.spec.ts
```

- 編集した Source を Target の子へ実ドラッグし、同一 ID・本文・子孫・兄弟順・再起動後を確認する。
- メニュー移動と遅延 load の F11、ルートへの移動、取消、循環拒否を確認する。
- 既存全体 E2E では F11 が FAIL。今回の結果が PASS でも、原因未特定の間欠失敗を消さない。失敗時は dragstart/drop、move IPC、ACK、座標、選択、前後文書を保存する。

**Notion（BLOCKED / NOT_RUN）**

1. テスト専用領域に Source / Target / Source の子を作る。Source に書式付き本文を入れる。
2. Source を Target の子へドラッグし、階層・兄弟順・選択・フォーカス・本文を確認する。
3. 兄弟内で順序を変更し、ルートへドラッグして戻す。各段階で再読み込みする。
4. ドロップ可能領域の表示、キャンセル、循環になる移動の拒否を確認する。
5. 各状態でページ URL/ID が同一のままか、画面で確認する。

**比較判定**: 公式はドラッグ再編成と親の内外への移動を説明するが、領域・フォーカス・取消は未記載。Folio 側の既知失敗が整理されるまで比較の土台を作らない。

## 4. 証拠の保存と比較への昇格

- Folio の実行結果はランチャーのログと `output/research/parity-e2e/` に残す。追跡対象は `verification.json` と `evidence/` に要約・環境・hash を置く。
- Notion 実測時は、合成ページのみを撮影し、個人/顧客情報を写さない。ファイル名に日時とシナリオ ID を含める。
- `parity-matrix.json` の `reference.status` を `OBSERVED` にできるのは、環境・fixture・観測結果・証拠が揃ったときだけ。
- `comparison` を `MATCH` / `DIFF` にするには、同一 fixture・同一環境・同一入力方式が揃い、`differences` または一致点を具体的に記述する。現在は全件 `UNKNOWN` で、研究用テストが根拠なしの `MATCH` を拒否する。
- 比較判定を更新するときは、本研究用テストの期待値も同時に更新し、その理由を `verification.json` に残す。テストを先に緩めない。
