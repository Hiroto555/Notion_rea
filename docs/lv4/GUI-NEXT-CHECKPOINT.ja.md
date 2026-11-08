# GUI受入の残件と次の一区切り

> **後続の実行指示（2026-11-08）**：利用者が保存・復旧24件＋既存45件＝69件のLinux CI受入を指示した。[実行記録](GUI-RECOVERY-CI.ja.md)に結果を記録する。以下の「今回は計画だけ」は棚卸し時点の履歴。Mac GUI・A3以降・masterへのマージは引き続き範囲外。

2026-11-08 JST。利用者の依頼に基づく棚卸しと提案。**今回は計画・記録だけで、GUI実行・試験実装・製品実装・push・masterへのマージを行わない。A3以降は未着手のまま。**

## 現在の証拠

- 対象head：`e818fd5e1f9c9c0d2bd9939c2f09df3c9651b506`、統合ブランチ`codex/folio-page-tree-ci-20261108`。作業開始時はclean。
- [GitHub Actions GUI #6](https://github.com/Hiroto555/Notion_rea/actions/runs/42437471755)：**45/45 PASS、retry/skip 0**。実Electron/実IPC17件、代替応答Electron表示2件、Chromium表示26件。
- [quiet-checks #15](https://github.com/Hiroto555/Notion_rea/actions/runs/42437471713)：型検査・181ファイル/1,678テスト・build PASS。
- ページツリーの実drag・移動中の題名編集・再起動3件は[受入済み](GUI-PAGE-TREE-CI.ja.md)。本文ブロックのdragは別suiteで、現候補のLinux CIにはまだ含まれない。
- 今回の安全な`npm run test:e2e -- --list`では**227件/60ファイル**。CIの45件/8ファイルとの差は**182件/52ファイル**。これは現候補のLinux CIへ未移植の既存試験数で、Lv4の必須残件数とは別。過去の別候補でのGUI合格は今回の証拠へ繰り越さない。listは実行・合格を意味しない。
- 未作成のLv4実同期・終了時適用E2E、Mac固有・物理2台の手動受入は、上の227件だけでは網羅できない。

## GitHub Actions＋Linux仮想画面で進められる範囲

移植候補の分類。以下の未移植試験と新規受入はすべて**NOT_RUN**。既存45件の合格とは区別する。

| 優先 | 確認するもの | 現在の不足・終了条件 |
|---|---|---|
| 1・次の区切り | 保存・未保存入力・クラッシュ復旧（既存24件/9ファイル） | 遅延/喪失ACK、失敗した保存の後続入力、退避取消し/競合、SIGKILL後の復旧、数値の未確定入力と通常再起動を実Electronと一時データで確認。対象は後述の表に固定 |
| 2・別の区切り | 本文ブロックの実drag・block ID（既存6件/2ファイル） | `drag.spec.ts`2件と`editor-identity.spec.ts`4件。単一/複数、入れ子、スクロール、同位置、取消し、Undo/Redo、コピー後のID、再起動。ページツリー合格とは別に証拠を採る |
| 3・専用計画が必要 | Lv4の実IPCによる通常予約・競合勝者選択→終了→次回起動適用 | 現在の表示2件はbackend代替。専用の一時server/loopback・登録済み合成workspaceと実製品IPCで、勝者両側、予約/取消し、正常終了後だけの確定、入力中の終了拒否、候補変更/通信断/応答喪失からの復帰を確認。試験用接続で既存導線を検証し、接続設定・資格情報UIを追加しない |
| 後続・範囲を選択 | その他の既存ローカル回帰（残り152件/41ファイル） | DB作成・record/設定・旧DB移行・構造変更再試行、検索/リンク/モーダル、rich block/Markdown/添付/backup/表示など。危険度と既存受入との重複を見て小分けにする。182件の一括移植を次の終了条件にしない |

旧fixtureにはMacの`Meta`固定、親env継承、repo配下の一時データ、Linux専用起動条件の未対応が残る。移植時は既存CIのRUNNER_TEMP・FOLIO_DATA_DIR隔離、env除去、起動/終了とタイムアウト処理へ揃える。OS dialogの返却を代替した試験やsynthetic clipboard/compositionは、その事実を明記する。合格を実picker・macOS clipboard・実IMEへ読み替えない。

CI内で複数Electronプロセスとloopback serverを動かす統合試験は計画できるが、物理2台・実トンネルの合格とは分ける。実機受入が必要なすべての項目をLinuxの試験で代替したとは扱わない。

## Mac固有と物理2台に残すもの

いずれも**NOT_RUN**。このMacの操作を奪わない方針を維持し、Mac用の専用環境または別Macで実施する。

| 実行枠 | 残る確認 | 境界・依存 |
|---|---|---|
| Mac 1台 | Cmd+Q、赤ボタン、Dock復帰、終了取消し/拒否、保存中の再表示、次回起動 | Linuxのclose/restartで共通処理を先に確認できるが、Macの実終了導線は別受入 |
| Mac 1台 | 実日本語IME・候補選択中・数値入力途中、Macショートカット、focus、実clipboard | synthetic inputやLinuxのキー操作では証明しない。物理入力機器を含む最終確認は手動枠 |
| Mac 1台 | native file picker、取消し/選び直し、OS権限拒否 | 現CIはpicker返却を代替している。原本保護の実IPC試験と、実ダイアログの操作確認を分ける |
| A4接続後のMac | Keychain/safeStorage、秘密の更新・削除・失効 | SecretStoreの製品接続が未完。今回のGUIだけで閉じる残件には入れず、A4の後に受入する |
| 物理Mac 2台＋実トンネル | 双方向の本文・階層・DB/record・添付・削除/復元、競合からの回収 | 同じ候補・合成データで操作する。loopbackやmockの合格を代替にしない |
| 物理Mac 2台＋実トンネル | 切断/再接続、スリープ/復帰、回線切替、応答喪失、復元後の再登録 | 添付の再開はA3、接続/資格情報はA4、server backup/restoreはA5等に依存。未実装の経路を今回の試験作業として追加しない |

Windows/Intel Macを追加の必須受入へ広げない。Lv4の最終受入はA3以降の未完実装と対応範囲の確定を待つ。現時点の確認済みLevelはLv3のまま。

## 推奨する次の一区切り：保存・復旧24件のCI受入

**目標：既存45件＋下記24件＝69件を、GitHub Actionsの一時環境だけで受入して停止する。** 24件は現行の収集結果で固定し、新たなパラメータ化等で件数が変わる場合は対象と理由を記録する。

| 対象ファイル（tests/e2e/配下） | 件数 | 主な終了条件 |
|---|---:|---|
| `r4-page-save.spec.ts` | 4 | 履歴復元・refresh・遅延ACKで別のページや新しい入力を置き換えない |
| `queued-failure-guard.spec.ts` | 1 | 先行保存が失敗しても後続入力を保持し、誤送信しない |
| `pending-journal.spec.ts` | 2 | 未保存の退避、取消し、既存出力の保護 |
| `recovery-race-guard.spec.ts` | 4 | 出力待ちに状態が変わっても入力と原本を保護し、取消し・書込失敗で消さない |
| `r6-recovery.spec.ts` | 8 | 強制終了後の最新入力・未確定値・同一操作の照合、破損journalの保護 |
| `r7-data-safety/raw-input.spec.ts` | 1 | 数値/フィルターの未確定値を画面切替・保護されたreloadで保持 |
| `r7-data-safety/restart.spec.ts` | 1 | 通常再起動後もrecord本文・表示設定を保持 |
| `r7-data-safety/save-ack.spec.ts` | 2 | 遅延/喪失ACKから同じreceiptを照合し、二重commitを起こさない |
| `r7-data-safety/side-full-editor.spec.ts` | 1 | side/full切替でEditor・選択・Undo履歴を保持 |
| 合計 | **24** | **9ファイル** |

終了条件：

1. 上記24件を既存45件と合わせ、固定した同じ候補で**69/69 PASS、skip 0、retry 0**。失敗はfixture・期待値・製品不具合を分けて記録し、期待値の弱体化で通さない。
2. `npm run verify:quiet`の型検査・Node試験・buildもPASS。追加内容に応じて適切な非GUI回帰を確認する。
3. 合成入力だけのtrace/journal/report、対象head、件数、実IPCと代替応答の区分を保存。profileやworkspace DBをartifactへまとめて含めない。
4. このMacのGUI・実データ・元masterを変更しない。A3以降・接続設定追加・実server運用・masterへのマージへ進まない。
5. 上を満たしたら停止する。本文blockの6件、残る回帰152件、Lv4実同期の新規E2E、Mac/物理2台は次の実行範囲として残す。

工数の目安は**6〜12人時**（fixtureのLinux対応、実行、初回失敗の切り分け、証拠整理）。Codexの経過時間や納期の約束ではない。大きな製品不具合や設計変更は別途見積り、範囲を広げて続行しない。

この区切りは「Linuxで保存・復旧の安全性を追加受入した」状態。Lv4完成、Mac GUI全合格、物理2台の合格は含まない。今回はこの提案を保存するところで停止する。

関連：[Linux実行範囲](GUI-LINUX-CI.ja.md)、[ページツリーの証拠](GUI-PAGE-TREE-CI.ja.md)、[Mac受入待ち](GUI-MAC-ACCEPTANCE.ja.md)、[Lv4全体の残作業](REMAINING-WORK-PLAN.ja.md)。
