# Round 3 Fidelity — 比較台帳（Folio 実測 / Notion / 公式資料 / 判定）

2026-10-27。この文書は **Folio の実測**と **Notion の観測**、**公式資料**、**比較判定**を混ぜないための台帳である。Notion は今回一切操作しておらず、専用テスト領域の現地確認もアクセス許可の証拠もない。したがって Notion 側はすべて `UNKNOWN`、物理 IME は `NOT_RUN`、MATCH は 0 件、確定した差分も 0 件である。公式資料の記載だけを MATCH の根拠にしない。

## 1. 記録条件

| 項目                  | Folio（実測）                                                                       | Notion（参照）          |
| --------------------- | ----------------------------------------------------------------------------------- | ----------------------- |
| 実施日時              | 2026-10-27 16:20–16:22 JST（E2E）                                                   | 未実施（日時 UNKNOWN）  |
| 版                    | Electron 45.0.0 / Chromium 156.0.8078.48 / commit は feature commit                 | 版・取得日 **UNKNOWN**  |
| OS                    | macOS 26.6.2 (25G83) arm64                                                          | UNKNOWN                 |
| UI 言語 / theme       | ja / light・dark                                                                    | UNKNOWN                 |
| viewport / zoom / DPR | 1440×907, 1024×720, 960×700 / 1 / 2（実測 innerWidth/Height）                       | UNKNOWN                 |
| 入力経路              | Playwright pointer/keyboard、合成 composition                                       | UNKNOWN                 |
| fixture               | 隔離一時ワークスペースの合成 seed（ようこそ、アイデアノート、プロジェクト DB 3 行） | 比較用 fixture は未作成 |
| 保存結果              | legacy `DatabaseData` v2 の fixture 経路で再起動後も保持（R3-2）                    | UNKNOWN                 |
| 許可根拠 / 観測者     | このセッションの Fidelity 担当。実ユーザーデータ不使用                              | **確認できず**          |
| 証拠                  | `evidence/*.json`、`output/playwright/results/` の合成 PNG                          | なし                    |

Notion のテスト専用領域は「現地で確認できる」という証拠がないため、ログイン・ページ作成・観測のいずれも行っていない。個人/顧客ページへの転用はしていない。

## 2. 比較台帳

| ID  | 操作・対象                                   | Folio 実測（状態）                                                                                                                                              | Notion 観測 | 公式資料                                      | 判定                                            |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------- | ----------------------------------------------- |
| C1  | 960 幅で本文を編集する                       | 右余白 292px、content 右端 657、inspector 左端 680、横 overflow 0。タイトルも 623 で終わる（PASS）                                                              | UNKNOWN     | 今回参照せず（既存 research snapshot は保持） | Folio 側の修正。比較は UNKNOWN                  |
| C2  | 1024/1440 の本文とパネル                     | 1024: content 右端 789 ≤ panel 800 / 1440: 1135.5 ≤ 1200、overflow 0（PASS）                                                                                    | UNKNOWN     | 参照せず                                      | Folio のみ                                      |
| C3  | ページメニュー・アイコンピッカーの画面内配置 | 3 幅とも viewport 内（PASS）                                                                                                                                    | UNKNOWN     | 参照せず                                      | Folio のみ                                      |
| C4  | slash メニューの表示とキー                   | 960 で listbox は x=299.5..599.5, y=333.6..530.6 で viewport 内。Arrow/Enter/Escape は既存 E2E と実装で確認（Folio PASS、ただし深いネスト・960 未満は NOT_RUN） | UNKNOWN     | 参照せず                                      | Folio のみ。Editor 内部の改善依頼は HANDOFF     |
| C5  | dialog の初期 focus / Tab / Escape / 復帰    | search/link/record と旧 4 dialog で確認（PASS）。背景 click は dismiss のみ                                                                                     | UNKNOWN     | WAI-ARIA は Notion の証拠ではない             | Folio のみ / 比較 UNKNOWN                       |
| C6  | 背景操作の遮断                               | native modal（search/link/record/旧 dialog 共通）。Tab は dialog 内、背景クリックはページ操作なし（PASS）                                                       | UNKNOWN     | —                                             | Folio のみ                                      |
| C7  | DB record の表示                             | gallery/board/calendar は同じ fixture modal。960/1024/1440 で viewport 内・Tab 4 要素・Escape でカード復帰（PASS）。table は行内編集で full-page record なし    | UNKNOWN     | 契約は「全 view から同じ full-page record」   | **未実装（NOT_IMPLEMENTED）**。fixture 表示のみ |
| C8  | DB record の保存                             | fixture の title 編集 → 再起動 → 再 open で保持（PASS）。`RecordRequest` の live 保存は未実装                                                                   | UNKNOWN     | 契約は revision/ACK を規定                    | **NOT_RUN**（live storage）                     |
| C9  | 長い日本語タイトル                           | 119 文字で document overflow 0。sidebar/breadcrumb は ellipsis、inspector は折返し、title input は内部スクロール（PASS）                                        | UNKNOWN     | 参照せず                                      | Folio のみ。title の折返しは App 依頼           |
| C10 | light/dark の可読性                          | 本文・補助・inspector・sidebar の contrast は全条件 4.5 以上（PASS）                                                                                            | UNKNOWN     | 参照せず                                      | Folio のみ                                      |
| C11 | reduced motion                               | scroll-behavior auto、dropdown animation none、transition 0s（PASS）                                                                                            | UNKNOWN     | 参照せず                                      | Folio のみ                                      |
| C12 | 物理日本語 IME                               | **NOT_RUN**（合成 composition のみ）                                                                                                                            | NOT_RUN     | —                                             | NOT_RUN                                         |
| C13 | OS 実画面の動的領域比較                      | 自前の 4 幅・2 theme の screenshot のみ。pixel diff なし                                                                                                        | 取得なし    | —                                             | UNKNOWN                                         |
| C14 | 既存 E2E 回帰                                | 権限保留のため **NOT_RUN**                                                                                                                                      | —           | —                                             | NOT_RUN                                         |

## 3. 判定の要約

- Folio 側で PASS と確認できたのは C1–C6 と C9–C11。C7/C8 は fixture の表示までで、契約の full-page record / live storage ではない。
- Notion 側は全項目 UNKNOWN。表示比較は動的領域（topbar、sidebar、editor column、inspector、popover、dialog）に分けて Folio だけを測ったが、Notion の同時刻・同条件の観測がないため pixel/操作の MATCH 判定はできない。
- 公式資料は今回新規参照していない。既存 `docs/parallel/research` の snapshot（前回の記録）は変更せず、MATCH の根拠に使っていない。
- 保存結果の比較は Folio fixture の再起動確認まで。Notion の保存結果は UNKNOWN。

## 4. 生データ

- `evidence/r3-responsive.json` — C1/C2/C3/C10/C11 の実測
- `evidence/r3-focus-contract.json` — C5/C6/C12（合成 composition）の記録
- `evidence/r3-db-record-display.json` — C7/C8 の fixture 表示
- `evidence/r3-long-title-keyboard-motion.json` — C9/C11 の実測
- `evidence/MANIFEST.json` — 上の sha256 と screenshot の sha256
