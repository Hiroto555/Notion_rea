# 外部コードレビューの入口

> **R6更新（2026-10-28）**：最新の実装範囲と検証結果は [R6チェックポイント](R6-CHECKPOINT.md) を参照してください。以下は記載日の履歴です。「行本文・独立ビュー・複合フィルター・永続復旧が未実装」などの過去記述はR6の現状を表しません。

対象はFolio 0.1.0の独立したローカルデスクトップアプリです。元の実装コミットは `abb1e3131d1b4cab6aee4560c6d8aa819859bc29`。2026-10-26のレビュー準備は未コミットのドキュメント・検査ツール変更として区別しています。今回の準備ではpush、履歴書き換え、公開範囲変更を行っていません。

## 依頼された8項目

| 項目                     | 確認先・結果                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 起動・ビルド・テスト手順 | [README](../README.md)。Node/OS、コマンド順、データ保存先、テストの副作用を記載                             |
| 実装済み・未実装         | [FEATURES](../FEATURES.md)。P0〜P2を実装・部分実装・未実装に分類                                            |
| REA解析と証拠            | [REA資料](rea/README.md)。証拠ID、原本hash、coverage、未確認を保存                                          |
| テストと既知の問題       | [結果](TEST-RESULTS.md)、[既知の問題](KNOWN-ISSUES.md)、[共有ログ](validation/README.md)                    |
| 主要画面                 | [ページ編集・ダーク・ボード](screenshots/README.md)。サンプルデータの実Electron画像                         |
| ignore設定               | [.gitignore](../.gitignore)。データ・鍵・解析原本・生成物を除外                                             |
| 混入検査                 | [検査結果](SHARING-AUDIT.md)。現在のツリーと既存履歴を分けて報告                                            |
| 共有構成                 | source/test/docs/を整理し、履歴なしのレビューアーカイブ生成を用意。既存履歴をそのまま再公開する準備は未完了 |

## 読む順序

1. [FEATURES](../FEATURES.md) と [KNOWN-ISSUES](KNOWN-ISSUES.md) で範囲を確認。
2. [SPEC](SPEC.md) と [ARCHITECTURE](ARCHITECTURE.md) で設計判断を確認。
3. `src/main/index.ts` → `src/shared/types.ts` → `src/preload/index.ts` でプロセス境界を確認。
4. `src/persistence/store.ts` と `tests/store.test.ts` で永続化・revision・階層を確認。
5. `src/renderer/App.tsx` の保存キュー、エラー回復、ツリー操作を確認。現状は大きなコンポーネントで、分割が次の改善項目。
6. `src/editor/Editor.tsx` / `blocks.ts` と `src/database/`、`tests/e2e/desktop.spec.ts` で操作と制限を確認。
7. [REA資料](rea/README.md) で参照製品の観察事実と独立設計を区別。

## 再現

[READMEのセットアップ](../README.md#起動) に従い `npm ci`、`npm run setup`、`npm run check`、`npm test`、`npm run build`、`npm run test:e2e` を実行します。テストは専用データを使いますが、GUIとOSクリップボードに触れます。パッケージ確認は `npm run package` と `node scripts/verify-package.mjs`。

既存のテスト記録は13単体テスト・7実Electronシナリオです。レビュー準備時は記録のソースhashを照合し、共有検査の5テストを追加実行しました。記録を再実行済みと読み替えないでください。

レビューで優先してほしい点は、保存競合の回復、Main/Renderer APIの入力検証、ツリーと文書操作の整合性、アクセシビリティ、異常終了時の未保存データ、DB機能の境界です。未実装を完全互換として評価しないため、既知の制限を先に提示しています。

## 共有前の確認

`npm run review:scan` は現在の追跡ファイルと無視対象外の新規ファイルを検査します。新しいスクリーンショットやバイナリは内容を確認してから `docs/review-policy.json` のhashを更新してください。APIキー等の検出値そのものをログに出しません。

`npm run review:export` は検査成功時に現在のファイルだけを梱包し、一覧と各ファイルのhashを展開結果と照合します。`.git`・ローカルDB・原本・node_modulesは含めません。出力とmanifestは `output/review/`。フォルダ全体の手動ZIPや `.git` 付き共有はこの検査済み範囲とは異なります。

共有検査とexportはコミット履歴のあるGit作業ツリーで使う管理者向けの手順です。アーカイブ受領者のアプリ起動・ビルド・単体/ElectronテストはGit履歴やREA原本なしで実行できます。
