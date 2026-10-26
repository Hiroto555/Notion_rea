# Folio → Notion近似のためのソース監査と改善計画

監査日：2026-10-26（日本時間）  
対象：Hiroto555/Notion_rea / master / `abb1e3131d1b4cab6aee4560c6d8aa819859bc29`  
対象アプリ：Folio 0.1.0。環境記録上の比較対象Notionは7.2.1（最新のNotion全般の仕様を意味しない）。

## 結論

独立したローカルノートアプリの基礎はある。しかし現時点で「Notion互換」や「何％一致」と評価できる証拠はない。次の投資先は、派手な機能追加より先に、入力・検索・保存・復旧の正しさ、次いでブロック粒度とDB行/ビューのモデルである。React/Tiptap/SQLiteを捨てて全面再開発する必要はない。

本書には **17項目** を記載する。バグ、構造上の不足、未再現リスク、検証工程の不足を混在させて「17件の実証済みバグ」と呼ばない。

## 監査範囲と限界

- GitHub接続を通じて中核の実装・単体/E2Eテスト・設計/機能/REAレポートを読んだ。リポジトリへの書き込み、push、Issue作成、設定変更はしていない。
- 全体アプリのビルド、既存Vitest/Playwrightの再実行、macOSでの実Electron起動、実Notionとの画面比較はしていない。この実行環境ではGitHubからのgit cloneが名前解決エラーになり、取得したテキストを用いた監査を行った。
- 依存パッケージ全件の脆弱性調査、完全な機密情報走査、全CSSの読了は今回の範囲外。CSSは冒頭300行と対応JSXを確認した。
- 別途、取得した関数/メソッドの抜粋をJavaScript化し、Node v22.16.0で14条件のロジック確認を実行した。これは原リポジトリのテスト合格数ではない。正しい対照例も含む。
- この抜粋ではReact/Tiptap/Notion/物理IMEを実行していない。SQLite抜粋テストもアプリ全体の保存テストと区別する。
- docs/TEST-RESULTS.mdの13/13単体、7/7 E2EのPASSは開発者記録として確認した。実ログ/画面はoutputがgitignore対象のため共有されたGitツリーでは確認できない。

## 良い基盤として維持すべき点

Main/Preload/Rendererの分離、任意IPCチャンネルを露出しないbridge、IPC送信元と要求の検査、contextIsolation/sandbox、SQLiteのprepared statement・WAL・トランザクション・revision競合検出は実装されている。階層・再起動・実ファイル操作を扱うテストもあり、単なる静止画モックではない。unknownをunknownと記す調査記録も維持すべきである。ただし、これらは包括的なセキュリティ保証・耐障害性保証ではない。根拠：S03/S04/S10/S11/S14/S15/S20/S21。

## 優先度一覧

P1：次の段階へ進む前に対処すべき重要項目。P2：同等性・使いやすさ・検証強化の次順位。構造項目は短いバグ修正と分けて実装する。

| ID | 優先度 | 分類 | 指摘 |
|---|---|---|---|
| F01 | P1 | 静的確認・UI未再現 | 同じページの再選択でエディタ参照を失う |
| F02 | P1 | 抜粋ロジックで再現 | 書式境界で単語が分断され、全文検索と文字数が不正になる |
| F03 | P1／通常配布のブロッカー | パス計算を抜粋実行して再現 | 標準のmacOSインストール場所で保存先がルート直下になる |
| F04 | P1 | 静的確認＋SQLite抜粋で再現 | DB行削除にUndo・ゴミ箱・履歴復元の経路がない |
| F05 | P2 | 入力規則の抜粋で再現 | 添付時に受け付けたファイルを取り出せない場合がある |
| F06 | P1（IME）／P2（互換） | 静的確認・実機入力未再現 | 検索ダイアログのIME確定Enterと編集ショートカットの競合 |
| F07 | P2・データ検証境界 | 抜粋の受理動作を再現／描画影響は未再現 | 文書の型名検査だけで親子構造を保証していない |
| F08 | P1・再現の構造課題 | 型・UIから確認 | データベース行がページではなく、ビューが独立していない |
| F09 | P1・再現の構造課題 | 静的確認 | ブロック操作がトップレベル配列に限定される |
| F10 | P1・性能/耐久性リスク | 処理経路から判断・負荷は未計測 | 入力ごとの全文保存と同期DB処理が増幅する |
| F11 | P1・要再現のデータ競合 | 静的リスク・実アプリで未再現 | 構造操作後のrefreshが未保存のローカル状態を上書きし得る |
| F12 | P1（復旧）／P2（互換） | 静的確認・既知制限 | 書き出しと退避の復旧経路が閉じていない |
| F13 | P2 | 静的確認・操作未再現 | モーダルの閉じ方・フォーカスと状態復元が不十分 |
| F14 | P2・見た目/操作再現 | JSX/CSSから確認・画像比較未実施 | 独自の装飾と固定3カラムが再現目標から外れ得る |
| F15 | P1・検証基盤 | テストコードと記録から確認 | 合格数はNotion同等性を意味しない |
| F16 | P2・証拠/研究工程 | 既存Evidenceレポートから確認 | REA接続とNotion内部解析を区別する必要がある |
| F17 | P2 | 静的確認・DOM操作未再現 | アウトラインの項目とスクロール先がネストでずれる |

## F01 — 同じページの再選択でエディタ参照を失う

**優先度：P1 / 証拠区分：静的確認・UI未再現**

対象：`src/renderer/App.tsx / select、Editor呼び出し；src/editor/Editor.tsx / onReady effect`

**確認事項。** select(id) は同じ activeId に対しても editor.current=null にする。一方、Editorのkeyは同じpage.idなら変わらず、onReadyを呼ぶeffectの依存は[editor]だけ。継続表示しているEditorと親の参照が乖離する。

**再現・影響。** 本文のある現在ページをサイドバーまたは検索結果で再選択し、添付、ページリンク挿入、Markdown/HTML書き出しを行う。現コードのexportPageは参照不在だと通常ページでもdatabaseのJSON（null）へフォールバックする。

**修正方針。** 同一ID選択では参照を破棄しない。editorId.currentを実際の整合性検査に使い、pageIdとEditorインスタンスの対応を管理する。参照欠落時は書き出しを明示的に失敗させるか、正規のdocから静的変換する。見かけを直すための毎回強制再マウントは禁止。

**受け入れ条件。** 同一ページを5回再選択しても本文・Undo・カーソル・添付・リンク・書き出しが機能する。別ページへ移った後に旧Editorを使わない。

## F02 — 書式境界で単語が分断され、全文検索と文字数が不正になる

**優先度：P1 / 証拠区分：抜粋ロジックで再現**

対象：`src/shared/types.ts / textOf；src/persistence/store.ts / search；src/renderer/App.tsx / pageFind`

**確認事項。** textOfはすべてのcontentをスペースでjoinする。インラインテキストノードにもスペースを挿入するため、太字などでノードが分割されるだけで検索対象文字列が変わる。

**再現・影響。** 「不動産」の「動」だけ太字にしたJSONは「不 動 産」へ変換され、includes("不動産")はfalse。「soft」+太字「ware」は「soft ware」。hardBreakも改行にならない。P02〜P04で確認。

**修正方針。** インラインは連結、ブロック境界とhardBreakは明示的な区切り、とするスキーマ準拠の抽出関数へ変更。検索、プレビュー、文字数、バックリンク表示で契約を統一する。単にjoin("")へ変えるだけでは段落同士が連結するため不十分。

**受け入れ条件。** 書式なし・部分太字・部分リンクの同じ可視文字列が同じ検索結果になる。段落境界をまたぐ検索と改行の仕様を明文化し、ページ内検索もテキストノードをまたいで一致する。

## F03 — 標準のmacOSインストール場所で保存先がルート直下になる

**優先度：P1／通常配布のブロッカー / 証拠区分：パス計算を抜粋実行して再現**

対象：`src/main/index.ts / dataDir`

**確認事項。** packaged時のdirname(process.execPath)から4階層上へ移動する計算は、現在のrelease/Folio-darwin-arm64構造を前提とする。/Applications/Folio.app/Contents/MacOS/Folioでは/.folio-dataになる。

**再現・影響。** P08で計算結果を確認した。macOSへの実インストール・権限エラー発生自体は今回未実行。通常ユーザーでは書き込み不可となる可能性が高く、dataDirのmkdirは起動時catchより前にある。

**修正方針。** FOLIO_DATA_DIRの明示指定は維持し、既定保存先はElectronのuserData配下の専用workspaceディレクトリにする。既存の開発用・release用DBを無断削除せず、バックアップ付きの明示的移行を実装する。起動前ディレクトリ作成失敗も診断可能にする。

**受け入れ条件。** /Applications、ユーザーのApplications、任意フォルダから同じユーザー用データを参照できる。アプリの移動・アップデート後も既存ページと添付が失われない。

## F04 — DB行削除にUndo・ゴミ箱・履歴復元の経路がない

**優先度：P1 / 証拠区分：静的確認＋SQLite抜粋で再現**

対象：`src/database/Database.tsx / table row deletion；src/persistence/store.ts / update,recordVersion`

**確認事項。** 行削除はrows.filterで即座に配列から除去し自動保存される。recordVersionはpatch.docがある場合だけ呼ばれ、記録形式にもdatabaseがない。DBの値変更や行削除はページ履歴に残らない。

**再現・影響。** P12で、行を消すdatabase patchを適用するとrowCount=0、versionCount=0となることを抜粋SQLite処理で確認。以前のワークスペースバックアップなど別経路がある場合は復旧できるため「永久に復旧不能」とは断定しない。

**修正方針。** DB行をページ化するまでの暫定対策としても、DB操作のUndo、soft delete、databaseを含むスナップショットのいずれかを追加。最終的には行・プロパティ・ビュー・本文を一貫した操作履歴と復元仕様で扱う。

**受け入れ条件。** 行削除→Undo、削除→再起動→ゴミ箱から復元、プロパティ変更→履歴復元をテスト。すべてのビューから同一データが復旧する。

## F05 — 添付時に受け付けたファイルを取り出せない場合がある

**優先度：P2 / 証拠区分：入力規則の抜粋で再現**

対象：`src/main/index.ts / attach；src/shared/types.ts / downloadAttachment`

**確認事項。** attachは拡張子なしや任意拡張子を保存できるが、downloadAttachmentのURL検証はASCII英数字1〜12文字の拡張子を必須とする。作成側と読み出し側の契約が異なる。

**再現・影響。** P10/P11でUUIDだけのURLおよび日本語拡張子のURLが拒否されることを確認。20MB以内のLICENSEなどを添付する経路は作成側で禁止されていない。

**修正方針。** assetIdと元ファイル名・MIME・保管名を分離する。読み出しは安全なassetIdの解決に統一し、許可して保存したものは必ず取り出せるようにする。パストラバーサル防止を弱めない。

**受け入れ条件。** 拡張子なし、長い拡張子、日本語名、複合拡張子、大文字拡張子を保存→取り出し→バイト一致で確認。

## F06 — 検索ダイアログのIME確定Enterと編集ショートカットの競合

**優先度：P1（IME）／P2（互換） / 証拠区分：静的確認・実機入力未再現**

対象：`src/renderer/App.tsx / global key listener, search input onKeyDown`

**確認事項。** 全体のキー処理とEditor側にはisComposing対策があるが、検索・リンク入力のローカルonKeyDownではEnterが即座に選択を実行する。また全体のCmd/Ctrl+Kは選択テキストや対象要素を区別せず検索を開く。

**再現・影響。** 検索候補がある状態で日本語変換をEnter確定するシナリオを実機で試す必要がある。Notion公式は選択テキストに対するCmd/Ctrl+Kをリンク付与として説明している。

**修正方針。** composition状態を入力コンポーネント間で統一し、変換確定をコマンド確定に流用しない。ショートカットはIME→モーダル→エディタ選択→ワークスペースの順で処理し、defaultPreventedを尊重する。

**受け入れ条件。** Macの日本語IMEによる変換、再変換、候補選択、Enter/Escapeを手動検証。文字選択中Cmd+Kはリンク、通常のページ移動検索は定義した別文脈で動作する。

## F07 — 文書の型名検査だけで親子構造を保証していない

**優先度：P2・データ検証境界 / 証拠区分：抜粋の受理動作を再現／描画影響は未再現**

対象：`src/shared/types.ts / isDocument；src/editor/Editor.tsx / schema setup`

**確認事項。** ノード名・深さ・数の制限はあるが、doc直下にtext、bulletList直下にparagraphといった子要素の制約を検査しない。EditorではenableContentCheck/onContentErrorも指定されていない。

**再現・影響。** P06/P07でそのようなJSONをisDocumentがtrueとすることを確認。今回Tiptapを実行しておらず、クラッシュや削除が実際に起きたとは主張しない。

**修正方針。** UIと保存境界で共有できるschema仕様を設け、Node.check等または同等の厳密検証を利用する。レンダラー専用ReactモジュールをMainへ無理にimportしない。未知schemaVersionは原本を保全して読み取り専用にする。

**受け入れ条件。** 正常な複合文書は受理し、親子関係不正・不正属性・重複ID・過大サイズは書き込み前に拒否。読込不能でも原データを破壊しない。

## F08 — データベース行がページではなく、ビューが独立していない

**優先度：P1・再現の構造課題 / 証拠区分：型・UIから確認**

対象：`src/shared/types.ts / RecordRow,DatabaseData；src/database/Database.tsx`

**確認事項。** RecordRowはid/title/valuesだけ。本文docがない。DatabaseDataはview/filter/sortをそれぞれ1つだけ持ち、ビューの集合はない。boardは最初のselect、calendarは最初のdateを使用する。

**再現・影響。** カードを開くとプロパティ編集しかできない。2つの表ビューを別名・別フィルターで保持するモデルもない。Notion公式が説明する「DBの各項目はページ」「複数の独立ビュー」と異なる。

**修正方針。** ページ＋データソース所属＋型付きプロパティ値のモデルへ移行する。Viewは独立ID・名前・layout・filter AST・sort配列・groupBy・calendarBy・propertyVisibilityを持つ。既存row ID/値を保持するmigrationを先にテストする。

**受け入れ条件。** DB行を開き本文を編集でき、表・ボード・カレンダーに同じ行が反映される。同じ種類の複数ビューの条件が混ざらず再起動後も残る。

## F09 — ブロック操作がトップレベル配列に限定される

**優先度：P1・再現の構造課題 / 証拠区分：静的確認**

対象：`src/editor/Editor.tsx / doc.forEach,manipulate；src/editor/blocks.ts`

**確認事項。** ハンドルはdoc.forEachで直下ノードに対して作る。リスト内の各listItemやトグル内のブロックは独立した操作対象ではない。選択はindexで管理され、変更時は全文をreplaceWithする。

**再現・影響。** 3項目のリストが1つの直下ノードになる構造では、各項目をNotion同様に直接つかむ仕組みがない。docsもネスト内部DnD未対応を明記する。

**修正方針。** 論理ブロックの永続IDと位置解決を導入し、構造上許可した範囲でネスト内DnDを実装する。移動・複製・削除は局所的なProseMirror Transactionにする。Tiptap自体を捨てる必要はない。

**受け入れ条件。** リストの2項目目のみ移動、トグルから外へ移動、親子一括選択、別ページへのコピー、Undo/Redo後の内容・ID・カーソルを検証。

## F10 — 入力ごとの全文保存と同期DB処理が増幅する

**優先度：P1・性能/耐久性リスク / 証拠区分：処理経路から判断・負荷は未計測**

対象：`src/editor/Editor.tsx / onUpdate,layout；src/renderer/App.tsx / update,enqueue；src/persistence/store.ts / update,recordVersion`

**確認事項。** 編集トランザクションごとにgetJSON→App更新→IPC→全文JSONと検索テキスト再生成→履歴保存。DBはMainで同期実行。Editorはtransactionごとに各トップレベルDOMの矩形を読む。

**再現・影響。** 大文書・多ページ・高頻度入力で重くなる経路がある。既存ベンチは1回の入力と保存完了までを含む測定で、継続タイピングのp95ではない。実際の遅さの数値は今回測定していない。

**修正方針。** Editorローカル状態と全体のページメタデータを分離。保存は最新スナップショットのcoalescing、明確なACK、操作順序、クラッシュ耐性を両立する。計測後にSQLite worker/utility process、検索索引、部分レイアウトを導入。単なるdebounceで未保存の損失を隠さない。

**受け入れ条件。** 1,000ブロック連続入力・大きな貼付・ページ切替中保存を複数回測定しp50/p95/maxとキュー長を残す。保存済み表示後の強制終了でも内容を失わない。

## F11 — 構造操作後のrefreshが未保存のローカル状態を上書きし得る

**優先度：P1・要再現のデータ競合 / 証拠区分：静的リスク・実アプリで未再現**

対象：`src/renderer/App.tsx / refresh,ensureSaved,update,move,trash,duplicate,recovery export`

**確認事項。** updateだけがqueueに入り、move/trash/restore等はensureSaved後に別経路で実行する。ensureSavedはその時点のqueueを待つだけ。refreshは新たに入ったローカル変更やunsaved patchをマージせずページ配列を置換する。

**再現・影響。** 編集と移動のIPCへ遅延を注入し、移動がrevisionを増やす→編集が競合→loadが旧本文をcommitする順序を作る。退避JSONはpageRef.currentだけなのでunsaved mapとの差を確認する。このインターリーブは今回未実行。

**修正方針。** 文書更新と構造変更を整合したmutation coordinatorへ統合。サーバーsnapshotのrevisionとローカルpending patchを照合する。退避には未ACK/失敗patchを必ず明示的に含め、読み戻しをテストする。

**受け入れ条件。** 遅延・逆順応答・競合を注入しても、最新の入力が表示/DB/退避ファイルのどこにも残らない状態を作らない。

## F12 — 書き出しと退避の復旧経路が閉じていない

**優先度：P1（復旧）／P2（互換） / 証拠区分：静的確認・既知制限**

対象：`src/renderer/App.tsx / exportPage,importPage,recovery；src/main/index.ts / import`

**確認事項。** Markdown/HTMLの画像参照はfolio-asset://のままで添付同梱がない。独自JSONを書き出せるがimportの選択肢はMarkdown/HTMLのみ。保存競合時の退避JSONをUIから元へ戻す経路もない。

**再現・影響。** 新規ワークスペースへ書き出しを移すと添付参照を解決できない。退避ファイルが作られたことと、利用者が復元できることは別。

**修正方針。** 独自JSON/ZIPのバージョン付き可逆形式を用意し、本文・階層・DB・添付・内部参照を同梱する。Markdown/HTMLは損失のある形式として変換損失を報告。退避の復旧ではDB側と未保存側の両方を残す。

**受け入れ条件。** 書き出し→空のworkspaceへ読込→本文/DB/添付ハッシュ比較。競合退避→復旧までを同一E2Eで確認。

## F13 — モーダルの閉じ方・フォーカスと状態復元が不十分

**優先度：P2 / 証拠区分：静的確認・操作未再現**

対象：`src/database/Database.tsx / record-modal；src/renderer/App.tsx / dialogs,sidebar state`

**確認事項。** DBのrecord-modalは別のediting stateで開くが、グローバルEscapeはAppのdialogしか閉じない。モーダルのフォーカストラップ/背景inertは実装されていない。sidebar setting型はあるが切替時の保存・初期ロードへの反映がない。

**再現・影響。** レコードを開いてEscape、Tabで背景へ抜ける操作、サイドバーを閉じて再起動する操作を確認する。docsもキーボード専用操作の未完を認める。

**修正方針。** 共通Dialog/Menu/Popover基盤を作り、Escape、focus trap、focus restoration、aria-modal、背景操作防止を統一。セッション状態の永続化を明示する。

**受け入れ条件。** キーボードのみで開く/入力/閉じるができる。閉じた後は元の対象へフォーカスが戻り、背景を誤操作しない。

## F14 — 独自の装飾と固定3カラムが再現目標から外れ得る

**優先度：P2・見た目/操作再現 / 証拠区分：JSX/CSSから確認・画像比較未実施**

対象：`src/renderer/styles.css（冒頭300行確認）；src/renderer/App.tsx；src/editor/Editor.tsx`

**確認事項。** 緑系アクセント、右情報ペイン初期表示、固定format bar、ページ字幕、文末の独自コピーがある。画面がNotionと同じかどうかのスクリーンショット比較は実施できていない。

**再現・影響。** 前の依頼文が3カラムを固定要件にしていたことも見た目を独自方向へ誘導した。Notion再現ではカラム数を先に固定せず、実際の参照状態を基準にする。

**修正方針。** 参照画面のviewport、テーマ、言語、ズーム、フォントを固定して比較。独自ブランドは保持し、余白・本文幅・メニュー位置・hover/focus・選択表示を測定して調整。装飾追加を品質向上とみなさない。

**受け入れ条件。** 最低8状態（通常、暗色、slash、選択、検索、表、ボード、レコード）のbefore/afterと参照差分を保存。動的部分/ブランドのマスク理由を記録する。

## F15 — 合格数はNotion同等性を意味しない

**優先度：P1・検証基盤 / 証拠区分：テストコードと記録から確認**

対象：`tests/store.test.ts；tests/e2e/desktop.spec.ts；docs/TEST-RESULTS.md；.gitignore`

**確認事項。** 13単体/7 E2EのPASSはリポジトリの報告であり今回再実行していない。toContainText("")は内容の正しさを確認しない。DBsortのUI操作後の順序やcalendarの予定移動はそのE2Eで検証していない。screenshotは記録のみでgolden比較ではない。

**再現・影響。** outputは.gitignore対象で、記載された実行ログと画面PNGは共有ツリーにない。コミットのstatus取得は空だったが、これだけで外部CIが全くないとは断定しない。

**修正方針。** 独立した受け入れシナリオを先に固定し、回帰テスト・視覚差分・障害注入・手動IMEを分ける。CIまたは監査用artifactでコミット、依存lock、ログ、画面、測定条件を結び付ける。

**受け入れ条件。** 各修正は修正前に失敗するテストと修正後のPASSを残す。未実行/未観測をPASSと扱わず、期待値変更で実装を追認しない。

## F16 — REA接続とNotion内部解析を区別する必要がある

**優先度：P2・証拠/研究工程 / 証拠区分：既存Evidenceレポートから確認**

対象：`research/EVIDENCE.md；research/evidence/environment.json`

**確認事項。** 記録はREAによるNotionインストールメタデータの限定走査、公式ヘルプ観察、Folio自身のIPC解析など。Notion app.asarの内容は抽出・解析していない。内部モデルはUNKNOWNと明記される。

**再現・影響。** 「REAを使ったのでNotionの内部を再現できている」と評価できない。接続できていることと、参照実装の意味を把握したことは別。レポート自身はこの区別を正直に記している。

**修正方針。** 非公開コード抽出を前提条件にせず、許可されたテスト用workspaceで外部動作を観察し、入力・操作・期待状態・再起動後状態を記録する。REAには観察証拠の採取、対象/範囲の記録、差分の追跡を担わせる。

**受け入れ条件。** 仕様項目ごとに公式説明/実観察/独自設計/未確認を分類し、参照バージョンと証拠を固定する。元製品のコード・ロゴ・素材を自作成果物へ混入させない。

## F17 — アウトラインの項目とスクロール先がネストでずれる

**優先度：P2 / 証拠区分：静的確認・DOM操作未再現**

対象：`src/renderer/App.tsx / headings, outline click`

**確認事項。** 見出し一覧はpage.doc.contentの直下だけから作る。一方クリック先はquerySelectorAllでネスト内も含むh1/h2/h3の全DOMから同じindexを取る。2つの列挙集合が一致していない。

**再現・影響。** トグル内の見出しを直下の見出しより前に置き、アウトライン項目をクリックする。直下見出しの項目がネスト側DOMを指す可能性がある。今回DOMでの再現は未実行。

**修正方針。** アウトラインも見出しIDを持つ同一走査結果から生成し、IDでDOMを引く。ネスト見出しを含む/含まない仕様を定義し、折りたたみ内へジャンプする場合の展開も決める。

**受け入れ条件。** ネスト見出し・同じタイトルの見出し・順序変更後も正しい対象へ移動する。

## 改修の順序

### Gate A — 既存データと基礎操作を守る

F01/F02/F03/F04/F05を先に修正し、それぞれ修正前に失敗する回帰テストを追加する。F06のIME、F07の検証境界、F11の競合を同じ段階で扱う。データ移行前にはDB＋assetsのバックアップと、空のテスト領域での復元確認を実施する。ファイルの移動・アプリ更新でデータが別の場所へ見えなくなる問題を放置しない。

### Gate B — 日常の編集を近づける

安定したブロックID、ネスト内操作、テキスト/ブロック選択、書式・リンク、Enter/Backspace/Tabの意味、クリップボード、Undo/Redo、IME、フォーカスを揃える。単にブロック種類を増やすより「毎日使う操作の組合せ」を優先する。採用するNotion操作仕様は参照実験で固定する。

### Gate C — データベースを組み直す

DB行をページへ、ビュー設定を独立エンティティへ移す。まず行本文、型付きプロパティ、複数ビュー、型に沿ったfilter/sort、groupBy/date選択を実装。Relation/Rollup/Formulaはその次に行う。Formulaはevalではなく、制限された式評価と循環検出を持つ設計とする。

### Gate D — 実画面の差分を縮める

基準スクリーンショットと操作シナリオを固定する。右ペインやformat barを「必須だから残す」のではなく、参照状態に合わせる。独自ロゴ/名称を保ち、参照製品の保護されたコード・アセットは使わない。hover、focus、選択中、ドラッグ中、エラー、空状態も比較する。

### Gate E — 性能・復旧・配布

文書保存と構造変更の整合性を保ち、測定したボトルネックだけを分離する。p95を含む入力・検索・起動計測、データ量別の検証、ACK後強制終了、ディスク満杯、添付失敗、移行失敗を追加。全体バックアップ復元と可逆エクスポートができて初めて実データ利用を広げる。

同期・共同編集・AI・多数の連携サービスはこれらとは別の後続トラック。クラウド機能の不存在を、ローカル編集の不具合修正を止める理由にしない。

## 推奨するモデルの境界（独立設計案）

以下はNotionの非公開内部設計の説明ではなく、Folio改善の提案である。

- Page：id、parent/所属、doc、schemaVersion、revision、metadata。DB行でも本文を持つ。
- DataSource / PropertyDefinition / PropertyValue：列定義と値の型を分離し、名称変更でIDを変えない。
- View：id、dataSourceId、name、layout、filter tree、sorts、groupBy、calendarBy、property visibility。
- Block identity：文書内の論理ブロックにID。複製/貼付のID発行規則とUndo規則を明文化。
- Mutation coordinator：page editと構造操作を順序付け、未ACK/競合パッチを失わない。
- Asset registry：UUID、元ファイル名、MIME、サイズ、ハッシュ、保存先、参照情報。
- Revision / Trash / Recovery：本文だけでなくプロパティや行操作まで復元可能な契約。

全文JSON保存はそれ自体が誤りではない。必要な性能と共同編集要件を測る前に、ブロック単位のSQL分割やCRDTを全面導入しない。

## 「100％へ漸近」の測り方

評価対象を固定せずに100％と言うのは無意味である。初期基準を「記録したNotion 7.2.1の、個人利用・ページ・ブロック・DBの指定シナリオ」とし、現行バージョンへ変える場合は別baselineとして記録する。

1. 各ケースは、初期データ、操作列、期待される可視状態、保存状態、許容差、参照証拠を持つ。
2. PASS/FAIL/NOT_RUN/BLOCKED/SPEC_PENDINGを区別する。既知の未実装機能を分母から黙って除かない。
3. 「仕様が観測できた率」と「固定済み受け入れテストの合格率」を別々に報告する。
4. 機能、操作、見た目、耐久性、性能を別指標にし、重大なデータ消失や移行欠陥がある状態を総合点で隠さない。
5. 参照版、テスト、マスク、スクリーンショット基準を実装の都合で書き換えない。意図的差分は理由を残す。

同梱の受け入れカタログは監査者の提案であり、すべてのNotion挙動が実観測済みという意味ではない。実観測が必要な期待値は、その取得を前提にしている。

## 次のレビューに必要な証拠

修正コミット、変更理由、失敗→成功のテスト結果、実行コマンド/終了コード、実行環境、基準と同条件のスクリーンショット、既知の失敗・未実行一覧を一つのreview manifestで結び付ける。output全体を無差別にGitへ追加せず、機密情報を除去した監査用artifactを共有する。

GitHub API確認時点で本リポジトリはPublicだった。環境記録やキャプチャを増やす前に公開範囲を見直し、ログイン情報・Cookie・顧客データ・元製品の抽出物を含めない。今回、機密情報が一切ないという保証や全履歴走査は行っていない。

## 参照ソース

GitHubソースはすべて監査対象コミットへ固定した。表中のS番号は本書の根拠を追うための索引。

- S01 — README / 機能制限：[README.md](https://github.com/Hiroto555/Notion_rea/blob/abb1e3131d1b4cab6aee4560c6d8aa819859bc29/README.md)
- S02 — 共有型・文書検証・textOf：[src/shared/types.ts](https://github.com/Hiroto555/Notion_rea/blob/abb1e3131d1b4cab6aee4560c6d8aa819859bc29/src/shared/types.ts)
- S03 — 保存・履歴・階層・検索：[src/persistence/store.ts](https://github.com/Hiroto555/Notion_rea/blob/abb1e3131d1b4cab6aee4560c6d8aa819859bc29/src/persistence/store.ts)
- S04 — Electron/保存先/添付/IPC：[src/main/index.ts](https://github.com/Hiroto555/Notion_rea/blob/abb1e3131d1b4cab6aee4560c6d8aa819859bc29/src/main/index.ts)
- S05 — メインUI・保存キュー・各操作：[src/renderer/App.tsx](https://github.com/Hiroto555/Notion_rea/blob/abb1e3131d1b4cab6aee4560c6d8aa819859bc29/src/renderer/App.tsx)
- S06 — エディタ・選択・slash：[src/editor/Editor.tsx](https://github.com/Hiroto555/Notion_rea/blob/abb1e3131d1b4cab6aee4560c6d8aa819859bc29/src/editor/Editor.tsx)
- S07 — ブロック配列操作：[src/editor/blocks.ts](https://github.com/Hiroto555/Notion_rea/blob/abb1e3131d1b4cab6aee4560c6d8aa819859bc29/src/editor/blocks.ts)
- S08 — データベースUI：[src/database/Database.tsx](https://github.com/Hiroto555/Notion_rea/blob/abb1e3131d1b4cab6aee4560c6d8aa819859bc29/src/database/Database.tsx)
- S09 — DB検索/ソート/カレンダー計算：[src/database/model.ts](https://github.com/Hiroto555/Notion_rea/blob/abb1e3131d1b4cab6aee4560c6d8aa819859bc29/src/database/model.ts)
- S10 — 単体テスト：[tests/store.test.ts](https://github.com/Hiroto555/Notion_rea/blob/abb1e3131d1b4cab6aee4560c6d8aa819859bc29/tests/store.test.ts)
- S11 — Electron E2E：[tests/e2e/desktop.spec.ts](https://github.com/Hiroto555/Notion_rea/blob/abb1e3131d1b4cab6aee4560c6d8aa819859bc29/tests/e2e/desktop.spec.ts)
- S12 — 既存テスト結果の報告：[docs/TEST-RESULTS.md](https://github.com/Hiroto555/Notion_rea/blob/abb1e3131d1b4cab6aee4560c6d8aa819859bc29/docs/TEST-RESULTS.md)
- S13 — 実装・未実装一覧：[docs/FEATURES.md](https://github.com/Hiroto555/Notion_rea/blob/abb1e3131d1b4cab6aee4560c6d8aa819859bc29/docs/FEATURES.md)
- S14 — 設計判断：[docs/ARCHITECTURE.md](https://github.com/Hiroto555/Notion_rea/blob/abb1e3131d1b4cab6aee4560c6d8aa819859bc29/docs/ARCHITECTURE.md)
- S15 — REA解析の範囲：[research/EVIDENCE.md](https://github.com/Hiroto555/Notion_rea/blob/abb1e3131d1b4cab6aee4560c6d8aa819859bc29/research/EVIDENCE.md)
- S16 — 実行環境の記録：[research/evidence/environment.json](https://github.com/Hiroto555/Notion_rea/blob/abb1e3131d1b4cab6aee4560c6d8aa819859bc29/research/evidence/environment.json)
- S17 — CSS（今回冒頭300行）：[src/renderer/styles.css](https://github.com/Hiroto555/Notion_rea/blob/abb1e3131d1b4cab6aee4560c6d8aa819859bc29/src/renderer/styles.css)
- S18 — 成果物の除外ルール：[.gitignore](https://github.com/Hiroto555/Notion_rea/blob/abb1e3131d1b4cab6aee4560c6d8aa819859bc29/.gitignore)
- S19 — 依存関係とコマンド：[package.json](https://github.com/Hiroto555/Notion_rea/blob/abb1e3131d1b4cab6aee4560c6d8aa819859bc29/package.json)
- S20 — Preload API：[src/preload/index.ts](https://github.com/Hiroto555/Notion_rea/blob/abb1e3131d1b4cab6aee4560c6d8aa819859bc29/src/preload/index.ts)
- S21 — CSP：[index.html](https://github.com/Hiroto555/Notion_rea/blob/abb1e3131d1b4cab6aee4560c6d8aa819859bc29/index.html)

外部の機能比較・技術仕様は公式資料で確認した（2026-10-26取得）。

- N01 — [Notion 編集の基本](https://www.notion.com/help/writing-and-editing-basics)
- N02 — [Notion キーボードショートカット](https://www.notion.com/help/keyboard-shortcuts)
- N03 — [Notion データベースの基本](https://www.notion.com/help/intro-to-databases)
- N04 — [Notion ビュー・フィルター・ソート](https://www.notion.com/help/views-filters-and-sorts)
- N05 — [Notion ボード](https://www.notion.com/help/boards)
- E01 — [Electron app / userData](https://electronjs.org/docs/latest/api/app)
- T01 — [Tiptap Documentのblock+スキーマ](https://tiptap.dev/docs/editor/extensions/nodes/document)
- T02 — [Tiptap Invalid schema handling](https://tiptap.dev/docs/guides/invalid-schema)
- R01 — [React 同位置・同keyの状態保持](https://react.dev/learn/preserving-and-resetting-state)

## 同梱ファイル

`audit_probes.mjs` は抜粋ロジック検証、`audit_probe_results.json` は今回の結果。`Folio_Acceptance_Catalog.json` は未実行の提案テスト一覧。`Codex_Folio_Improvement_Prompt.txt` は実装エージェントへの引き継ぎ指示。
