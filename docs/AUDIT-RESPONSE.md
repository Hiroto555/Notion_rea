# Gate A 監査対応 — 2026-10-26

対象はFolio。Notionとの動作一致を判定する作業は実施していない。Gate Aのコード修正と自動回帰を実施し、F06の物理日本語IME確認は未実施として残す。

## 基準と作業範囲

- 作業開始時のHEADと監査基準はどちらも `abb1e3131d1b4cab6aee4560c6d8aa819859bc29`。コミット間差分は0。
- 開始時に存在したREADME・レビュー資料・package.jsonの変更、research原本をGitインデックスから外した変更は保持。アプリ本体・既存テスト・lockfileは開始時点で基準と同一だった。
- 指定の `review/2026-10-26/` は未作成だったため、提供された7ファイルを同ディレクトリへコピー。元manifestの6ファイルのSHA-256を照合した。原本の監査・指示・受け入れカタログは変更していない。
- 全アプリ試験に専用FOLIO_DATA_DIRを使用。既定保存先の試験はElectronのappData自体をテスト用フォルダに差し替えて実施。既存 `.folio-data` と `release/.folio-data` は移行していない。SQLite/WAL/SHM計6ファイルは作業前後でハッシュ一致。作業前20:42:28から起動していたFolioは終了させておらず、そのセッション領域のGPUキャッシュ4ファイルには差分があった。保存内容の差分とは区別して記録した。
- 検証時点では修正を作業ツリーに保持し、その後ユーザーのGitHub反映指示に基づき修正コミット [`7544301`](https://github.com/Hiroto555/Notion_rea/commit/754430158ee1de811bebdcc5a66602a13f3d3cb9) を固定した。[Git記録](validation/gate-a/git-state.json)とmanifestのソースハッシュで再レビューできる。以後の変更は検証記録・文書のみ。公開設定変更と履歴書き換えは行わない。

## 指摘ごとの結果

| ID | 再現と修正 | 検証・状態 |
| --- | --- | --- |
| F01 | 基準Electronで同一ページ再選択後のMarkdown本文が `null` になることを再現。同一IDでEditor参照を破棄せず、page IDとインスタンスを照合。取得不能時は本文書き出しを停止。添付選択中の別ページ遷移も検知する | 自動回帰PASS。サイドバー5回＋検索の再選択、同一DOM、Undo/Redo、添付、ページリンク、Markdown/HTML出力 |
| F02 | 実textOfが `不 動 産` / `soft ware` を返すことを再現。インラインは連結し、hardBreak・ブロック境界はLF。検索・プレビュー・文字数を統一し、ページ内検索はProseMirror位置へ写像する | 自動回帰PASS。太字/リンク混在、改行、複数段落、全体検索、12文字の表示、書式をまたぐ選択 |
| F03 | 基準ソースのdataDir式を抽出して実行し `/Applications/Folio.app/Contents/MacOS/Folio` → `/.folio-data` を確認。既定をuserData/workspaceへ。明示指定は維持。新規保存先へのバックアップ付きコピー移行、初回選択ダイアログ、起動前mkdir失敗の表示を実装 | 自動回帰PASS。パス、移行・復元、行ID/値/添付バイト、元DB保全、既存先拒否、破損/シンボリックリンク拒否、隔離appDataでの既定起動・エラー表示。実際の/Applicationsへのインストールは未実施 |
| F04 | 実StoreでDB削除後の履歴が無いことを再現。DB・タイトル・本文の変更前スナップショットをSQLite v2で保存。DB Undoボタンを追加。旧本文履歴は保持し、DBの記録がない旧履歴の復元では現在のDBを維持 | 自動回帰PASS。削除→Undo、削除→再起動→履歴復元、同じ行ID/値、プロパティ変更→履歴復元、SQLエラー時の全体ロールバック。行本文はGate Cの未実装項目 |
| F05 | 実Electronのattach→downloadで拡張子なし・日本語・長い拡張子が拒否されることを再現。UUIDと表示名/拡張子/MIME/保管名/サイズ/hashを分離。新旧URLを安全な同一ファイル名として解決 | 自動回帰PASS。5種類の名称の同一バイト往復、実画像描画、旧URL、トラバーサル/シンボリックリンク拒否 |
| F06 | 実Electron上の合成composition/keydownで検索のEnterが確定することを再現。isComposing・composition状態・keyCode229、defaultPrevented、モーダル、入力欄、エディタ選択の優先を統一。選択本文への⌘Kはページリンクを付与し文言を保持。⌘Pは検索 | 自動回帰PASS。物理日本語IMEの変換・再変換・候補選択はNOT_RUN。合成イベントやinsertTextを物理IME試験とは扱わない |
| F07 | 実requestSchemaでdoc直下text、list直下paragraph、不正level、未知schemaVersionが受理されることを再現。React非依存の共通Tiptap拡張からschemaを作成し、属性/上限検査とNode.checkを実行。Storeへの直接保存も検査 | 自動回帰PASS。正常複合文書、不正IPC、未知page/doc版、壊れたJSON、null doc、深さ制限、原本JSONの完全一致、再起動後のエラー画面とバックアップ。Tiptap contentError時は保存・編集を停止 |
| F08 | DB行のページ化、独立View、複合条件、Relation等 | Gate C、未着手 |
| F09 | 安定block ID、ネスト粒度、局所Transaction | Gate B、未着手 |
| F10 | 入力性能・クラッシュ耐久性 | Gate E、未着手。以前のwarm単発値をp95と呼ばない |
| F11 | 遅延IPCを注入した実Electronで、移動後loadの待機中に入力したタイトルが旧値へ戻ることを再現。編集と構造変更を同一キューへ集約。連番付き未ACKパッチを即時記録、ACK範囲のみ除去、snapshotへマージ | 自動回帰PASS。移動中の編集・再起動、競合時の未保存本文/タイトル保持、退避ファイル内の保存済み側とpending patch、別ページ復旧と再起動 |
| F12 | Gate Aに必要な退避JSONの復旧のみ実装。元ページを保持し `[復旧]` ページを新規作成 | 部分対応。添付同梱の可逆JSON/ZIP、階層を含む移植はGate E |
| F13 | 共通モーダル、focus trap、状態復元 | Gate B、未着手 |
| F14 | Notionとの画面・操作比較 | Gate D、未実施 |
| F15 | 本番関数の失敗→成功ログ、実Electronの回帰、移行・障害注入を追加。空文字へのtoContainTextを行数の検証に置換 | Gate A範囲を改善。Notion同等性・全受け入れ68件のPASSとはしない |
| F16 | REA証拠区分 | 既存の対象/範囲区分を維持。新たなNotion解析・参照操作は実施していない |
| F17 | 見出しIDとアウトラインの対応 | Gate B、未着手 |

## 保存・復旧の契約

新規PageはschemaVersion 1。従来の版番号なしPage/文書はv1として読む。文書に保存された未知の版を既知の版へ変換したり、不正な内容を空文書として保存することはない。

検索は書式を無視した文字列に対する部分一致。インライン境界に空白を追加せず、hardBreakとブロック境界にLFを1文字入れる。文字数はこの文字列のJavaScript UTF-16 length（改行込み）であり、書記素数ではない。段落をまたぐ一致にはLFを含む検索語を使う。ページ内検索は最初の一致を選択する。前/次巡回・全件ハイライトは未実装。

DB Undoは画面セッション内に最大100操作。明示的な履歴復元後は古いUndoスタックを破棄する。永続履歴は各ページの直近100件。削除を永久保存する別のゴミ箱は実装しておらず、再起動後の誤削除復元は変更履歴を使う。歴史上のDB操作まで遡って復元可能にしたわけではない。

未ACK/失敗パッチは即時メモリへ記録する。最新パッチを含む保存ACKが揃うまで保存中と表示する。競合は勝手に上書きせず、退避JSONに `pages` / `persistedPages` / `pendingPatches` を保存する。復旧は同じワークスペースに新しいページを作るため、DB側とローカル側が両方残る。強制終了前の未ACK内容をディスクジャーナルから回収する機能は未実装。

## 移行とロールバック

既定はmacOSの `~/Library/Application Support/Folio/workspace`。FOLIO_DATA_DIRが指定されればその場所を使用する。旧 `.folio-data` / `release/.folio-data` を削除・統合しない。

1. 旧アプリを終了する。
2. `node scripts/migrate-workspace.mjs --source /path/to/old-data --destination /path/to/new-data` を実行する。移行先は未作成でなければならない。
3. コマンドが返す `backup` はSQLiteの整合したスナップショット＋assets。stagingから新規移行先へ切り替える。失敗したstaging/backupは診断用に残し、元データは保持する。
4. `FOLIO_DATA_DIR=/path/to/new-data npm start` で確認する。初回起動時に既知の旧データが見つかった場合はUIから同じコピー移行を選べる。
5. 元のアプリへ戻す場合は新しいアプリを終了し、未変更の旧フォルダを旧アプリの保存先に指定する。新しいフォルダで追加した編集は旧フォルダには含まれないため、先に新しいフォルダも退避する。
6. バックアップの復元は同じコマンドのsourceにbackup、destinationに別の未作成フォルダを指定する。既存データやWAL/SHMへ上書きしない。

SQLite v1→v2の初回変換前には `workspace.sqlite.pre-v2.sqlite` を保存する。スキーマのみ戻す場合もアプリを終了し、現フォルダ全体を別名で退避したうえで、別フォルダにpre-v2をworkspace.sqliteとしてコピーし、同時点のassetsと組み合わせる。v2 DBを旧アプリで直接開かない。変換後に追加した変更はpre-v2には含まれない。

## 実行証拠と未実施

[実行コマンド・終了コード](validation/gate-a/results.json)、[ソース/証拠manifest](validation/gate-a/manifest.json)、[カタログとの対応](../review/2026-10-26/gate-a-results.json) を参照。生ログ・失敗時のtrace・テスト画面はローカル `output/gate-a/`。共有用のテキストログは `docs/validation/gate-a/` に実行環境の個人パスを除いて保存する。

基準check/unit/build/Electron E2Eは実行済み。初回追加E2Eの3件はボタンのアクセシブル名指定が誤っており、修正してからF01/F06/F11の実失敗を採取した。F11の旧版は未保存ガードでテスト終了が遅れたため、失敗時にも専用ウィンドウを破棄する後処理へ変更した。途中の復旧試験でテスト側のundefined参照、環境変数型によるbuild失敗も発生し修正した。これらを製品不具合やPASSとして計上しない。

物理IME、Notion実操作比較、実際の/Applicationsへの配置、別OS、署名/公証、電源断、実際のディスク満杯、性能p95、Gate B〜Eの全受け入れは未実施。SQL失敗注入は実際のディスク満杯ではない。カタログ原本68件のNOT_RUNは変更せず、補足結果を別ファイルに残す。

## 最終試験の残件

単体は32/32、Gate A追加の実Electronは15/15成功。最新の全体実行は21/22で、既存の「real Electron: page edit…」内のブロックドラッグが1回、並べ替わらず失敗した。同じコード・同じテストを3回再実行すると3/3成功した。原因は未特定のため、修正済み・安定済みとは扱わない。失敗ログ `verified-e2e.txt` と再確認ログ `drag-recheck.txt` を両方保持する。Gate Bでドラッグイベントとレイアウトの観測を増やす対象。

## 次ラウンドの追補 — 2026-10-26（基準7759906）

上記は前回Gate A時点の記録として保持する。今回の変更・証拠は[NEXT-ROUND-RESPONSE](NEXT-ROUND-RESPONSE.md)、[TEST-RESULTSの追記](TEST-RESULTS.md)、[結果JSON](validation/next-round/results.json)。最後のアプリソース変更は`a4c9abf`、テストを含む実装HEADは`0bf710e`。各結果の対象をsource/build hashで区別する。

| 既存指摘との関係 | 今回の局所対応 |
| --- | --- |
| F11/F12 → R1 | 491〜500文字タイトルの復旧拒否と、30.3MB日本語退避のexport成功/recover拒否を実コード/IPCで再現。上限をUTF-8 30MBへ統一、原題を切らず別メタデータで識別。v2は変更ページの最終状態だけ、v1も読み戻せる。元ページと未保存内容を保護 |
| F09/F15 → R2 | 既存トップレベル範囲で同位置drop、Undo、カーソル/scrollを修正。実ポインター回帰を2ケース×20回実行し40/40。永続IDやネスト全面対応は未実装。初期失敗は全て保持 |
| F06/F13 → R3 | 検索/ページリンク/DBレコードだけ共通Modalへ。native select/IME合成イベント優先、focus/Tab/Escape、リンク範囲/文書/ページの保持を検証。物理IMEはNOT_RUN |
| F14 → 比較基準 | N01〜N08を事前固定。Notion実測NOT_RUN、比較はUNKNOWN。WAI指針への適合をNotionとの実測一致としない |

単体48/48とcheck/buildを今回実行。全体37件には旧22件と新15件を含み、旧Gate A追加15件を再加算しない。最終全体3回の結果・途中の失敗・ソース照合は今回の結果JSONに記載。最初の全体試験で起きたF11待機前の停止は、元入力の診断付き10回では未再現で原因未特定。F02の非同期focusと試験期待値の時点、F11のcapture/bubble監視の差は試験側で修正した。単なる再実行成功で旧失敗を解決済み扱いしない。

前回の「[復旧]をタイトルに付ける」「pages/persistedPages/pendingPatchesを全収録する」は旧v1の記録。今回v2では原題をそのまま保持し、recoveredFromと画面の復旧ラベルで区別し、変更ページの最終状態を一度だけ収録する。既存v1ファイルと既存ページ名は変更しない。SQLite schema migrationなし。添付は同一ワークスペース参照で、ポータブルZIPや強制終了時の永続ジャーナルは未実装。

既存SQLite/WAL/SHM計6ファイルとlockfileは前後hash一致、ユーザーの起動アプリは終了していない。全試験は専用FOLIO_DATA_DIR、既定パス試験は隔離appData。今回のGitHub push、公開設定変更、履歴書換えはない。Gate A全体完了やNotion全体一致を宣言しない。

最終受入の確定結果: check・単体48/48・buildはPASS。トップレベルドラッグは40/40。全体Electronはacceptance-full-1 **37/37**、acceptance-full-2 **37/37**、acceptance-full-3 **36/37**で、全体受入はPARTIAL。最後のF11はcapture記録がmousedownのみ、dragstart/dropなし、move IPCなし。ページツリー操作の入力開始に残件があり、根本原因は未特定。保存不具合を再現したという判定ではないが、全体成功にも数えない。対象ブロック操作の20反復が通ったこととは区別する。

開発モードの初回起動待ちはFAIL（Vite依存最適化/reloadのログあり）。別の診断起動で画面表示を確認し、同じサーバーでリンク確定/取消の回帰は1/1 PASS。StrictMode下の選択・書式・focus保持の限定確認で、cold startの安定性を証明していない。production distの起動・保存・再起動は全体試験で確認済み。
