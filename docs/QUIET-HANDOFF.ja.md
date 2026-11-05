# Folio：画面を開かない改善の引き継ぎ

2026-11-04。作業ブランチ `codex/folio-l4-quiet-20261104`。
基準はGitHub masterの `8bfb3d2430a738e034371df28bc311bb2863fb3f`。
作業場所は `<workspace-root>/Folio-l4-quiet`。

## 今回の実装

| 対象 | 変更 | 証拠となる試験 |
| --- | --- | --- |
| GUIを勝手に起動しない | `test:e2e` は既定拒否。明示実行は `test:e2e:batch`。Playwright設定からの直接実行もguardする | `tests/gui-test-policy.test.ts` と既定拒否／list-onlyの実コマンド |
| 反復複製の並び順 | rootだけ隣接ページ間に固有位置を取り、子孫の位置・無関係なDB/recordを保持する。空きがない場合は原子的に拒否 | `tests/local-integrity-regressions.test.ts` |
| 複製タイトル | suffixを含め500 UTF-16以内、絵文字のsurrogate pairを切らない | 同上 |
| 壊れたページの隔離 | load/searchは読み取り専用の表示を返し、正常ページへのアクセスを継続。原本は保存せず、strictな取得・書込み・階層操作は拒否する | `tests/corrupt-page-isolation.test.ts`、既存atomic-load/raw guard |
| 添付の永続化順序 | file fsync → directory fsync → SQLite登録。INSERTの成否が不明なら本文を削除しない | `tests/durability-attachment-backup.test.ts` |
| 完全バックアップ | コピーした添付本文もfsync。最後のdirectory flush失敗は成功とせず、incomplete markerの復帰を試みる | 同上、既存backup/restore試験 |
| 将来の同期 | 独立したJSON checkpoint通信基盤、CAS、同一操作再送、永続outbox/inbox、競合双方保持 | `tests/sync-checkpoint.test.ts`。FolioのStore/UIには未接続 |

関連する実装は `src/persistence/store.ts`、`src/persistence/assets.ts`、`src/persistence/durable-file.ts`、`src/persistence/full-backup-create.ts`、`src/sync/`。

## 検証の読み方

最終の実行結果とコードのhash照合は、このディレクトリの `QUIET-VALIDATION.ja.md` に記録します。
テスト列挙は56ファイル・197件で、GUIテスト本体は **NOT_RUN**。
GUI・Electron・ネイティブダイアログ・OSクリップボード操作は今回の実装時に使っていません。
単体試験のfixtureは使い捨てDB、通信試験はloopbackのみです。

DeepSeekはOpenCode Goの `deepseek-v4.1-flash / high` を実際に2並列で利用しました。
担当は添付／backup耐久性とGUI実行guard。本人の差分を親側でレビュー・補強し、統合しました。Opusは使っていません。

原本の実行記録:
`<workspace-root>/Notion_rea/outputs/folio-l4-quiet-20261104`

## 未完了を引き継ぐ

- 過去にできた並び順の重複や500文字超の複製タイトルは、自動修復していません。今回の複製処理は新規発生を防ぎます。
- SQLite/JSONの破損を修復する機能ではありません。原本JSONの退避経路を保ち、他の正常ページへアクセスできるようにしています。関連する階層を証明できない操作は引き続き停止します。
- 通常添付の登録失敗で未参照ファイルが残る場合があります。成否が不明な登録から本文を消さないことを優先し、GCは別途設計します。
- fsyncの順序と例外は確認しましたが、物理ディスク障害・停電での実証ではありません。
- 同期は通信モジュールまでです。実Folio schema、添付、削除・復元、Storeとoutboxの原子的確定、既存Editorの未保存入力保護、v5移行、実端末の検証が残っています。`SYNC-FOUNDATION.ja.md`を参照してください。
- save receiptの増大、main threadでの重い処理、DB/recordの操作UIなど、監査の他項目は今回すべて解消したわけではありません。
- 監査レベルは累積条件で評価します。今回の修正・独立通信試験だけでLevel 3/4到達とは判定しません。

## 次の実行順

1. 利用者がMacを使用している間は非GUIの実装・型検査・単体試験を続ける。
2. GUI実行タイミングの指示が来たら、`GUI-VALIDATION-QUEUE.ja.md`に沿い、ビルド後に専用一時データでまとめて確認する。
3. 次の同期実装は、まず本体snapshotの契約と全書込み経路の捕捉を設計する。通信モジュールのinboxを本体DBへ直接流し込まない。
4. 配布・GitHub反映・デプロイは、検証済みのブランチと残件が分かる状態で扱う。今回はデスクトップ版の差し替えやクラウド公開を行っていない。
