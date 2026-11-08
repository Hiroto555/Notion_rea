# Mac固有のGUI受入（別枠）

2026-11-08。**すべてNOT_RUN。今回の指示はGitHub ActionsのLinux仮想画面だけで、このMacでのGUI実行は含まない。** Linuxの共通GUI試験は[CI実行範囲](GUI-LINUX-CI.ja.md)に分離した。Lv3確認済み、Lv4未認定、masterへはマージしない。A0〜A7とLinux共通GUIは[M3候補](M3-ACCEPTANCE.ja.md)で受入済み。

[このMacの操作を奪わない最終受入計画](MAC-QUIET-ACCEPTANCE-PLAN.ja.md)に、GitHub-hosted macOS・別Mac A/B・サーバーSの担当、必要な準備、実行前の区切りを整理した。**計画だけで、Mac workflow/GUI/実機試験はまだ開始していない。**

| 優先 | Mac/OSで確認するもの | 終了条件 |
|---|---|---|
| 1 | Cmd+Q・赤ボタン・終了取消し・再表示 | 未保存入力/保存中/IME中は終了と予約確定を保留。正常終了後だけ予約を確定し、次回起動で一度だけ適用。Dockからの復帰も確認 |
| 1 | 実IMEと入力保護 | 日本語変換・数値入力途中・候補選択中の同期/移動/終了で入力が失われない。synthetic composition試験とは別に記録 |
| 1 | native picker | 親フォルダ選択、取消し、選び直し、権限拒否、picker待ちの状態変化を実ダイアログで確認。Linux CIは返却値を代替している |
| 2 | macOS clipboard・キー操作・focus | OS clipboardを使う明示枠だけで確認し、普段の操作/clipboardと分離。キーボード配列とアクセシビリティも確認 |
| 2 | Keychain/safeStorage | 接続設定・更新・無効化の製品導線は実装済み。Macで保存/復号/ロック時の保留・更新・無効化を受入 |
| 別工程 | 物理Mac2台・実トンネル | 方向、切断、スリープ、競合、添付、削除/復元を同じ候補で確認。Linux上の一時DB/loopbackと区別する |

候補環境は専用の仮想Macまたは別Mac。共有clipboard・共有フォルダ・認証情報の持込みを避け、試験用プロフィールと一時`FOLIO_DATA_DIR`を使う。環境構築・Mac GUI実行の開始は今回行わない。

ページツリーの実drag・移動中編集・再起動の3件は[Linuxで追加受入済み](GUI-PAGE-TREE-CI.ja.md)。このMacでのドラッグや物理入力の合格は意味しない。ほかのOS共通で未移植の試験も、このMac固有表とは別の未実行バックログとして扱う。残件は[従来の受入待ち](GUI-ACCEPTANCE-QUEUE.ja.md)、[GUIの履歴](../GUI-VALIDATION-QUEUE.ja.md)を参照する。
