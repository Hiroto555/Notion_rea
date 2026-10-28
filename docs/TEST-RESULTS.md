# 検証結果 — 2026-10-26

> **R6更新（2026-10-28）**：最新の実装範囲と検証結果は [R6チェックポイント](R6-CHECKPOINT.md) を参照してください。以下は記載日の履歴です。「行本文・独立ビュー・複合フィルター・永続復旧が未実装」などの過去記述はR6の現状を表しません。

外部レビュー向けに [docs/validation](validation/README.md) へ匿名化ログと元のhash記録を保存しました。以下は実装コミット `abb1e3131d1b4cab6aee4560c6d8aa819859bc29` に対応する既存の実行結果です。レビュー準備では元の全ソースhashを照合し、アプリ本体・既存単体/E2Eテスト・依存lockfileを変更していません。

## 実行結果

| 検証                                 | 結果         | 証拠                                                         |
| ------------------------------------ | ------------ | ------------------------------------------------------------ |
| TypeScript strict                    | PASS         | [ログ](validation/typecheck.txt) / npm run check             |
| Vitest                               | 13 / 13 PASS | [ログ](validation/unit-tests.txt) / tests/store.test.ts      |
| 実Electron Playwright                | 7 / 7 PASS   | [ログ](validation/e2e-tests.txt) / tests/e2e/desktop.spec.ts |
| Vite開発モード起動                   | PASS         | [smoke結果](validation/smoke.json)                           |
| パッケージ済み.app起動・編集・再起動 | PASS         | [smoke結果](validation/smoke.json)                           |
| ビルド                               | PASS         | [ログ](validation/build.txt)                                 |

ビルド警告: エディタを含むrenderer bundleは約826kB（gzip約257kB）。ローカルデスクトップで検証したが、遅延ロード/分割は今後の最適化項目。dynamic importがstatic importと重なるという警告もあり、機能失敗ではない。

## 実機で確認した内容

Electronウィンドウ上でページ・本文・チェック状態を編集し、保存の表示を待ってからプロセスを閉じ、同じSQLiteを再度開いて値を確認した。モックの保存APIではない。検索、スラッシュ、ブロック実ドラッグ、Shift複数選択、複製Undo/Redo、ページ複製/ゴミ箱/復元、階層ページ、履歴の復元を実行した。

データベースでは表編集、filter、sort、ボードへのカードドロップ、42日カレンダー、ギャラリー、再起動後の行値を検証した。ページリンクを挿入し、相手側でBacklinksを確認した。

ファイルテストはネイティブダイアログの「選択結果」だけをテスト用パスに差し替え、実際のMarkdownパース、ファイルコピー、画像表示、添付取り出し、書き出し、SQLiteバックアップを実行した。全ダイアログを人間が手動操作したという意味ではない。

OSクリップボードへHTML/テキストを書き、実際の⌘Vで見出し・太字・斜体・日英混在長文を貼り付けた。Electron 45の新しいClipboardItem APIを使用。初回開発試行では旧API/読み取り専用itemの再書き込みが失敗し、元のクリップボード内容を復元できなかった。その後、変更前に各形式を新しいitemへ複製する方式へ修正し、テストが通った。ページ・既存ファイルの破損は発生していない。

## データ整合性

150段階の階層、循環移動の拒否、子孫を含む複製、古いrevisionの拒否、トランザクション、削除済み親から子単独の復元、履歴、日英長文、1,000ブロック、VACUUM INTOによるSQLiteスナップショットをテスト。通常ファイルとバックアップでPRAGMA integrity_check=okを確認。

実機でcontextIsolation=true、sandbox=true、nodeIntegration=false、rendererのrequire未公開、未定義IPC操作の拒否を確認。保存競合を意図的に発生させ、ローカル入力が維持され、退避JSONに残り、DB側の変更が上書きされないことを追加実機テストで確認。包括的な侵入テストや電源断試験は行っていない。

## 再現可能な性能サンプル

最終全件実行の `output/benchmark.json`:

| 条件                                         |    時間 |
| -------------------------------------------- | ------: |
| 155ページ＋1,000ブロックの投入               |    98ms |
| ページ再読み込みから1,000段落確認            |   261ms |
| 自動操作のクリック開始から挿入・保存確認まで |   598ms |
| プロセス再起動から本文表示確認               | 2,440ms |

1台・1回のwarmサンプル。p95、純粋なキーストローク遅延、物理IME入力時間ではない。`npm run test:e2e -- --grep 'reproducible load'` で再実行できる。

最終ソース・バンドル・テストログのSHA-256とREA Evidence IDは [共有用manifest](validation/baseline.json) に保存。原本 `research/evidence/final-validation.json` はローカル保持です。

## 画像

[主要3画面](screenshots/README.md) にGit管理対象のコピーを保存。原本は `output/playwright/folio-light.png` / `folio-dark.png` / `folio-board.png`。
チェックボックスと文章が別行になる問題を画像で発見し、修正後の画像を確認した。

## 未検証

物理日本語IMEの連続変換、全Markdown変換、複雑HTMLの完全往復、添付を含むポータブルExport、ネスト内ブロックの任意DnD、Notionとの同一文書の実操作比較、別OS、コード署名/公証、自動更新、クラッシュ/ディスク満杯/電源断注入、同期/共同編集。

## レビュー準備での追加検証

`npm run review:test` は5件成功。秘密情報を検出しても値を出力しないこと、著作者メール例外の限定、未確認バイナリ拒否、ignore対象でも追跡済み原本を拒否すること、symlink拒否を検証しました。これはアプリの13単体・7E2Eとは別の件数です。

レビュー用アーカイブは各ファイルの展開後hashを元の共有候補と照合します。構成、原本保存、履歴に残る所見は [SHARING-AUDIT](SHARING-AUDIT.md)。アプリの既知の問題は [KNOWN-ISSUES](KNOWN-ISSUES.md)。

## Gate A改修後の実行 — 2026-10-26

今回の検証はコミット前の修正を対象として実施し、そのアプリソースを後から `754430158ee1de811bebdcc5a66602a13f3d3cb9` に固定した。元の基準コミット検証とは別。[Gate AのGit記録](validation/gate-a/git-state.json) を参照。ソースとビルドのハッシュは [Gate A manifest](validation/gate-a/manifest.json)、コマンド/終了コードは [結果JSON](validation/gate-a/results.json)。

| 試験 | 結果 |
| --- | --- |
| 単体 | 32/32 PASS |
| Gate A追加の実Electron | 15/15 PASS |
| 全体Electron E2E（最新実行） | 21/22。既存ブロックドラッグ試験が1件失敗 |
| 失敗した同一ドラッグ試験の再実行 | 3/3 PASS。コード・期待値は未変更、原因未特定 |
| check / build | PASS |
| 開発起動 / .app生成 / パッケージの保存・再起動 | PASS、専用FOLIO_DATA_DIR |

F01/F02/F04/F05/F06/F07/F11は失敗→成功の記録、F03は基準ソースのパス式の再現と修正後の既定保存先・移行/復元・起動失敗試験を残した。初回のテスト実装不備や中間build失敗は結果JSONで区別している。

Gate Aの自動試験成功はNotionとの一致を意味しない。物理IME、実際の/Applications配置、全体のドラッグ安定性は未確認または残件。全22件の完全成功という結論にはしていない。

## 次ラウンド R1/R2/R3 — 2026-10-26

基準`7759906`からの新しい検証。アプリソースは`a4c9abf`、最終テストを含む実装HEADは`0bf710e`。旧Gate Aの32件/15件/21-of-22結果を新HEADに転用していない。[今回の全コマンド・終了コード](validation/next-round/results.json)、[source/build hash](validation/next-round/manifest.json)、[詳細](NEXT-ROUND-RESPONSE.md)。

| 検証 | 今回の結果・記録 |
| --- | --- |
| check → unit → build | PASS、単体48/48。acceptance-check-v2 / unit-v2 / build-v2 |
| 対象ドラッグの20反復、retries=0 | 40/40（2ケース×20）。acceptance-drag20。アプリ・drag回帰・distは最終版とhash一致、後続変更はgate-a.spec.tsのN02/F11試験だけ |
| 全体Electron 3回、retries=0 | 37/37、37/37、36/37（最後はページツリーF11開始イベント未発火）。全体受入PARTIAL。既存22＋今回15件で、旧Gate A15件を再加算しない |
| Notion実測 / 物理日本語IME | NOT_RUN。Notion比較は8件ともUNKNOWN |

最初の全体3回は37/37、36/37、36/37。F11の移動後load待機前の停止は診断付き10回で未再現であり原因未特定。F02は選択取得がTiptapの非同期focusより早いことを失敗後画面と実装から確認し、同じ文字列の完全一致を条件待ちする試験へ修正した。F11の追加監視でbubble側のdropを拾えなかった試験実装不備も記録し、capture journalへ修正。これらを製品の保存不具合やNotion不一致と断定しない。

R1はタイトル490/491/500/501、UTF-8上限直前/一致/直後、旧形式、複数ページ、取消・書込/再読込失敗・SQL rollback、実ファイル→復旧→再起動。R2は単一/複数/先頭/末尾/同位置/取消/スクロール、Undo/Redo、完全なdoc照合、ACK、再起動。R3は3ダイアログのfocus/Tab/Escape、native select優先、リンク範囲と書式、文書/ページ変更時の拒否、DB入力の再起動保持を検証する。

旧データ6ファイルとlockfileの前後SHA-256一致。既存アプリを終了せず、全試験は専用データ、既定パス試験は隔離appDataを使用。[保護記録](validation/next-round/data-protection.json)。生trace・画面・巨大fixtureはローカルoutputに保持し、匿名化コマンドログとhash indexをGitに保存する。パッケージ済み.appの再生成は今回未実施。Gate A全体完了・絶対安定・Notion 100%一致は宣言しない。

最終全体3回目のF11診断はmousedownのみ、dragstart/dropなし、move IPCなし。根本原因未特定で残件。詳細はacceptance-full-3のtrace/画面/drag-events/move-requests。開発モードの初回起動待ちもFAILとして保持し、Vite依存最適化後の診断起動PASSとリンク回帰1/1 PASS（dev-dialog-smoke-v2）を別記録にした。cold start安定性を確認済みとはしない。

## 2026-10-27 Round 3（2761365）

[詳細・全試行](validation/round-3-2761365/README.md)、[受入と残件](ROUND-3-RESPONSE.md)。最終単体50/50、S2反復 tree 20/20・menu 10/10・既存block 39/40。全体3回41/41・41/41・39/41、fixture変更後の追加全体41/41。開発cold 5/5・warm 5/5と負例cleanupを確認。失敗は除外せず総合PARTIAL。Notion比較UNKNOWN、物理IME NOT_RUN。

全体41/41の後、出力先パス結合を修正。現ビルドはcheck・単体50・build・重点E2E 2件で検証し、全体E2Eは再実行していない。
