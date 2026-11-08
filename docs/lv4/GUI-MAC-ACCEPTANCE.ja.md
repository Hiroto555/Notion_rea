# Mac固有のGUI受入（別枠）

最新の非GUI追記：[終了予約・接続設定の修正と検証準備](QUIET-RESIDUAL-EXECUTION.ja.md)を追加。243ファイル/2,292 Nodeテスト・型検査・build PASS。今回srcを2ファイル変更したため、新候補のMac GUIはNOT_RUN。下記240件とnative4件は前候補の実測として保持し、新候補へ自動で引き継がない。追加GUIは起動していない。

2026-11-08更新。利用者のTV視聴中の明示許可により、このMacで**240 PASS / 実IME 1 INFRA_BLOCKED**。[ローカル実行結果・残件・試行履歴](MAC-LOCAL-GUI-ACCEPTANCE-20261108.ja.md)を最新記録とする。実Keychain・物理2台はNOT_RUN。Lv3確認済み、Lv4未認定、masterへはマージしない。Linuxの共通GUIは[CI実行範囲](GUI-LINUX-CI.ja.md)、A0〜A7は[M3候補](M3-ACCEPTANCE.ja.md)に分離して記録する。

今回PASSしたnative条件は、保存処理中のCmd+Q拒否と保存後の正常終了/新PID再読込、赤ボタンの正常終了/新PID再読込、file picker取消し/合成ファイル選択、実Cmd+C/V。下表の終了条件全体を満たした意味ではなく、Dock、変換中保護、予約COMMIT失敗後の同PID再表示、親フォルダ/権限拒否などは残る。今回の実行許可は終了しており、新たなGUI起動は最新ユーザー指示に従う。

[このMacの操作を奪わない最終受入計画](MAC-QUIET-ACCEPTANCE-PLAN.ja.md)と[MAC-P05の機材・権限・最小範囲](MAC-P05-RESOURCES-AND-SCOPE.ja.md)に、別host・Mac A/B・Sと実行前の区切りを整理した。**別hostのworkflow/実機試験は未作成・未実行。** ローカルの合格を別hostや実Keychainの証拠にしない。

| 優先 | Mac/OSで確認するもの | 終了条件 |
|---|---|---|
| 1 | Cmd+Q・赤ボタン・終了取消し・再表示 | 未保存入力/保存中/IME中は終了と予約確定を保留。正常終了後だけ予約を確定し、次回起動で一度だけ適用。Dockからの復帰も確認 |
| 1 | 実IMEと入力保護 | 日本語変換・数値入力途中・候補選択中の同期/移動/終了で入力が失われない。synthetic composition試験とは別に記録 |
| 1 | native picker | 親フォルダ選択、取消し、選び直し、権限拒否、picker待ちの状態変化を実ダイアログで確認。Linux CIは返却値を代替している |
| 2 | macOS clipboard・キー操作・focus | OS clipboardを使う明示枠だけで確認し、普段の操作/clipboardと分離。キーボード配列とアクセシビリティも確認 |
| 2 | Keychain/safeStorage | 接続設定・更新・無効化の製品導線は実装済み。Macで保存/復号/ロック時の保留・更新・無効化を受入 |
| 別工程 | 物理Mac2台・実トンネル | 方向、切断、スリープ、競合、添付、削除/復元を同じ候補で確認。Linux上の一時DB/loopbackと区別する |

後続の候補環境は専用の仮想Macまたは別Mac。共有clipboard・共有フォルダ・認証情報の持込みを避け、試験用プロフィールと一時`FOLIO_DATA_DIR`を使う。別hostの環境構築は今回行っていない。

ページツリーのdrag・移動中編集・再起動は[Linuxの記録](GUI-PAGE-TREE-CI.ja.md)に加え、今回のMac共通GUIでも実行済み。ただしnative物理dragや全キーボード配列の受入へは拡張しない。残件は[受入待ち](GUI-ACCEPTANCE-QUEUE.ja.md)、以前の記録は[GUIの履歴](../GUI-VALIDATION-QUEUE.ja.md)を参照する。
