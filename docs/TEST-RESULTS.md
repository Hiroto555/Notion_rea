# 検証結果 — 2026-10-26

## 実行結果

| 検証                                 | 結果         | 証拠                                             |
| ------------------------------------ | ------------ | ------------------------------------------------ |
| TypeScript strict                    | PASS         | output/typecheck.log / npm run check             |
| Vitest                               | 13 / 13 PASS | output/unit-tests.log / tests/store.test.ts      |
| 実Electron Playwright                | 7 / 7 PASS   | output/e2e-tests.log / tests/e2e/desktop.spec.ts |
| Vite開発モード起動                   | PASS         | output/dev-smoke.json                            |
| パッケージ済み.app起動・編集・再起動 | PASS         | output/package-smoke.json                        |
| ビルド                               | PASS         | output/build.log、dist/                          |

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

最終ソース・バンドル・テストログのSHA-256とREA Evidence IDは `research/evidence/final-validation.json` に保存。

## 画像

`output/playwright/folio-light.png` / `folio-dark.png` / `folio-board.png`。
チェックボックスと文章が別行になる問題を画像で発見し、修正後の画像を確認した。

## 未検証

物理日本語IMEの連続変換、全Markdown変換、複雑HTMLの完全往復、添付を含むポータブルExport、ネスト内ブロックの任意DnD、Notionとの同一文書の実操作比較、別OS、コード署名/公証、自動更新、クラッシュ/ディスク満杯/電源断注入、同期/共同編集。
