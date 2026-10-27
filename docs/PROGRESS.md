# 継続開発の現在地 — 2026-10-26

PROJECT_ROOT: `<PROJECT_ROOT>（このリポジトリのルート）`
Agent: Codex。既存の空Gitリポジトリを使用。OpenCodeや別作業フォルダは使っていない。

## 完了した作業

- 環境調査、Notion 7.2.1の存在確認、初期MCP未登録とNodeバージョン不足の診断。
- プロジェクト内REA 6.8.0 / Node 24.22.1をMCP stdioで接続。229ツールを列挙。
- REAでNotionの限定メタデータ/header調査、公式公開ヘルプのDOM/AX観察、自作ビルドのmain/preload解析。
- NotionネイティブUIを読み取り観察。原本・既存ページ・認証情報・システム設定は変更していない。
- FolioのElectron + React + Tiptap + SQLiteアプリ実装。ソースと実行コマンドはREADME。
- 13単体テスト、7実Electronテスト、開発起動、パッケージ.appの編集・再起動を検証。
- 検索の古い結果問題、TaskItem配置、ゴミ箱からの子単独復元、開発URLの末尾スラッシュ照合を修正。
- 保存競合時の未保存変更保持・再試行・JSON退避後のデータ再読込を実装し、競合注入テストで確認。
- バックアップにSQLiteとassetsを同梱。パッケージのデータは上書きビルド対象外の `release/.folio-data` に分離。
- .appを `release/Folio-darwin-arm64/Folio.app` に生成。コード署名/公証は未完。最終版を通常起動し、native AXでFolioの画面と保存済み表示を確認。この検証時点ではアプリを開いた状態。現在の起動状態を保証する記録ではない。

## 実行

```sh
npm run setup
npm run build
npm start
npm run dev
npm test
npm run test:e2e
npm run package
node scripts/verify-dev.mjs
node scripts/verify-package.mjs
```

通常起動は `.folio-data`、パッケージは `release/.folio-data`。開発テストは `output/*` の隔離データで行う。

## REAの注意

`node tools/rea/client.mjs` で再接続可能。ネイティブCodex MCP登録は未変更。`docs/MCP-CONNECTION.md` に登録案を記載したが適用していない。

大きい解析結果で10MiB応答上限に達したため、`detail:"summary"`で再取得。Notionの解析許諾が未確認の部分は深く抽出していない。実装をその未確認内部構造の解析成果と偽らない。

## 既知の制限・次の順序

1. 現行Notion契約と解析許諾の範囲を確認し、必要ならユーザーが編集してよい比較用ページを指定。その後、同一操作の参照側証拠を採取する。ログイン情報を要求しない。
2. ツリーDnDの全境界ケース、物理IME、長文の選択範囲、複雑HTML、全ブロック変換の実機検証を追加。トップレベル以外のブロックDnDを設計する。
3. App.tsxの保存キュー、ツリー、ダイアログをhook/componentへ分割。保存失敗時の再試行・JSON退避後の読み直しは実装し競合テスト済み。次はセッションをまたぐリカバリージャーナルと競合差分UIを検討する。
4. DB行のページ本文、複数ビュー定義、AND/ORフィルター、複数ソート、プロパティ編集/削除、任意テンプレートを実装。
5. 安定block IDと文書schema versionをmigrationで導入した上でRelation/Rollup/Formula、複数workspace、履歴差分、バックアップ復元UIへ進む。
6. 配布の保存場所選択、署名・公証・自動更新。その後に同期/CRDT/公開API/拡張の権限モデルを検討。

## 残した成果物

README、SPEC、ARCHITECTURE、FEATURES、TEST-RESULTS、EVIDENCE、MCP-CONNECTION、コード、テスト、スクリーンショット、性能JSON、macOS .app。全依頼の完成宣言はしていない。

## 副作用の記録

クリップボードの初回開発テストでElectron APIの差異により元内容の復元が失敗し、検証用内容が残った。後続テストは内容を新しいClipboardItemに退避して戻す処理へ修正。ユーザーのファイルとNotionページは変更していない。

## 外部レビュー準備 — 2026-10-26

- READMEの前提条件・再現順序を補足。ルートFEATURES.mdに全機能表を置き、既知の問題・コードを読む順序・画像3枚をdocsに追加。
- REAの原本12ファイルはローカルにそのまま残し、Gitインデックスからのみ外した。docs/reaには原本hash・Evidence ID・制約を持つ選択/匿名化資料を置いた。
- アプリ本体・既存テスト・lockfileを変更せず、保存済み検証manifestのhashを照合。13単体/7E2Eの元結果を匿名化して共有資料へコピー。今回全E2Eを再実行したわけではない。
- .gitignoreと共有候補検査、履歴なしアーカイブ生成を追加。検査ツールの5テスト成功。詳細はSHARING-AUDIT.md。
- 以前のprivateリポジトリへの初回pushは存在する。今回の準備ではcommit/push/force-push/履歴書き換え/公開範囲変更をしない。新しい資料は未コミット。
- 次に再開する際は `git status` と `npm run review:scan` を確認。現在の共有候補を渡すなら `npm run review:export`。既存履歴を含むGitHubの共有範囲拡大は、残っているパス・HTML・作者情報の扱いを決めてから行う。レビュー準備をアプリ全機能完成と混同しない。

## Gate A監査対応 — 2026-10-26

監査基準/開始HEADは `abb1e3131d1b4cab6aee4560c6d8aa819859bc29` で一致。既存のレビュー準備変更とGitインデックスを保持したまま、F01/F02/F03/F04/F05/F07/F11を修正し、F06のIMEガードとキー優先順位を追加した。詳細・再現結果・制限・移行/ロールバックは [AUDIT-RESPONSE.md](AUDIT-RESPONSE.md)。

- 32単体成功。Gate A追加の実Electronは15/15成功。最新の全体E2Eは21/22（ブロックドラッグ1件失敗）、同一の失敗テストは未変更で3回とも再実行成功。不安定性は未解消として記録。
- 型検査・ビルド・隔離データでの開発起動とパッケージ起動/保存/再起動を実施。実行コマンドと終了コードは [gate-a/results.json](validation/gate-a/results.json)。
- 既定保存先はuserData/workspace。旧データは自動削除せず、コピー移行とバックアップ復元をテスト。既存2ワークスペースは移行していない。
- 競合退避JSONから同一ワークスペースに別ページを復旧可能。本文/DB/タイトル履歴を直近100件保持。不正文書は原本を保全して編集停止。
- `review/2026-10-26` の監査原本はハッシュ照合のうえ配置。原本の68ケースは変更せず、補足の `gate-a-results.json` にPASS/PARTIAL/NOT_RUNを記録。
- 物理日本語IMEとNotion比較は未実施。次はこの手動確認とドラッグの不安定性の調査を行い、Gate Bへ進む。Gate C〜Eの大機能は追加していない。
- 検証終了時点では未コミット。その後のユーザー指示により、GitHub反映対象の修正コミットは `754430158ee1de811bebdcc5a66602a13f3d3cb9` に固定した。[Git記録](validation/gate-a/git-state.json)を参照。次回はこのコミットとmanifestのハッシュを照合する。公開設定変更・履歴書き換えは行わない。

## 次ラウンド R1/R2/R3 — 2026-10-26

- レビューHEAD`7759906`と開始HEADは一致、開始時の作業ツリーはclean。旧監査/検証manifestを照合してからR1→R2→R3の順で実装した。今回の原本はreview/next-round-7759906へ保存。
- R1: 原題500文字を保持し、復旧識別を別メタデータへ。退避v2のUTF-8 30MB上限と読み戻し検査を統一し、変更ページだけを一度格納。v1互換、別ページ復旧、取消・失敗時のpending保持を確認。
- R2: 同位置dropの不要TransactionとUndo区切り/カーソル位置を修正。実ポインターのイベント・文書・ACKを記録し、短い回帰と境界matrixを追加。最終対象反復は40/40。旧成功3/3だけを原因解決の証拠にしない。
- R3: 検索/ページリンク/DBレコードを共通native Modalへ。focus、Tab周回、Escape、内側select、リンク選択保持と別ページ誤挿入防止を検証。物理IMEは未実施。
- 単体48/48、check/build成功。最終全体37件×3回の結果は[今回の結果](validation/next-round/results.json)。途中の失敗と試験側の修正も全件保持。[対応報告](NEXT-ROUND-RESPONSE.md)に変更単位と限界を記載。
- Notionの最小8シナリオを実装前に固定し、公式文書/推定/未確認を区別した。実Notion操作はNOT_RUN、比較は全てUNKNOWN。[比較基準](NOTION-PARITY-BASELINE.md)。
- 旧F11の移動待機開始前の停止は、診断付き元入力10回では未再現。過去の停止を解決済みとはしない。追加テストではnative dropとmove ACKを観測する。
- R1/R2/R3を分けてローカルコミット。GitHub push・公開設定変更・履歴書き換えなし。既存データ/lockfileは保持し、既存起動アプリは終了していない。新しいdistは起動・保存・再起動を検証済み。大機能への拡張は行っていない。

最終受入の確定結果: check・単体48/48・buildはPASS。トップレベルドラッグは40/40。全体Electronはacceptance-full-1 **37/37**、acceptance-full-2 **37/37**、acceptance-full-3 **36/37**で、全体受入はPARTIAL。最後のF11はcapture記録がmousedownのみ、dragstart/dropなし、move IPCなし。ページツリー操作の入力開始に残件があり、根本原因は未特定。保存不具合を再現したという判定ではないが、全体成功にも数えない。対象ブロック操作の20反復が通ったこととは区別する。

開発モードの初回起動待ちはFAIL（Vite依存最適化/reloadのログあり）。別の診断起動で画面表示を確認し、同じサーバーでリンク確定/取消の回帰は1/1 PASS。StrictMode下の選択・書式・focus保持の限定確認で、cold startの安定性を証明していない。production distの起動・保存・再起動は全体試験で確認済み。

## 2026-10-27 Round 3

S1出力保護と移行リンク拒否、S2試行単位のDnD診断とメニュー保存競合、S3起動失敗cleanupを追加。判定と残件は [ROUND-3-RESPONSE](ROUND-3-RESPONSE.md)。全体試験の失敗と原因未特定を保持し、範囲外のblock ID等には進んでいない。
