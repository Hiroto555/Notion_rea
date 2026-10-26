# Notion UI observation

2026-10-26 / macOS / cua_repl.getApp("Notion")。既存ウィンドウのAccessibility treeを読み取り。入力・クリック・ページ編集・ログインを実行していない。

OBSERVED:
- アプリのネイティブウィンドウとmacOSメニューバー。
- ローカルのタブ用Web領域（app.asar/.webpack/renderer/tabs/index.htmlというAX URL）。これはソース閲覧ではない。
- サイドバーを閉じるボタン（Cmd+\）、戻る/進む、新規タブ。
- 別のページWeb領域。page title、heading level 1/2/3、text area、quote、table/row/cellなどの役割。

対象の既存ページのタイトル、本文、外部リンク、ユーザー情報は調査資料や自作アプリへ転記しない。表示中ページを変更していない。

UNKNOWN: ログイン状態の詳細、各編集操作の結果、非公開のイベント処理やデータ保存。AXにsettableと表示されることは編集成功の証明ではない。
