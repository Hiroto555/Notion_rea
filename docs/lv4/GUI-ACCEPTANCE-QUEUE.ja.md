# Lv4 GUI・実機の受入待ち（M3候補）

最新の非GUI追記：終了予約の取消しと既存binding不一致の保存を修正した新候補は、型検査・243ファイル/2,292 Nodeテスト・build PASS。[今回の実装と境界](QUIET-RESIDUAL-EXECUTION.ja.md)。**新候補のGUI再受入はNOT_RUN。以下の240件は前候補 `ab48aab` までの履歴であり、今回の製品src修正への合格として流用しない。** 実IME・実Keychain・物理2台の残条件も未受入、Lv4未認定を維持する。

2026-11-08更新。**M3最終受入待ち。確認済みLevelはLv3、Lv4は未認定。** 明示許可された[このMacのGUI受入](MAC-LOCAL-GUI-ACCEPTANCE-20261108.ja.md)は240 PASS / 実IME 1 INFRA_BLOCKED。最終quietは232ファイル/2,165テスト・型検査・build PASS。実Keychain・物理2台は未実行。製品 `src` は受入基準 `bd65b73` と同じで、master `e269137`・実データは変更していない。[到達点](M3-ACCEPTANCE.ja.md)、[運用](M3-OPERATIONS.ja.md)、[分担・Usage](M3-USAGE.ja.md)も参照する。

| 実行先 | 現在の結果・残件 |
|---|---|
| GitHub Actions＋仮想画面 | Linux設定下の全238件PASS。新M3の実IPC11件を含む。[集計](validation/m3-gui-linux-20261108.json) |
| このMacの共通GUI | 236 PASS（Linux backend固有2件を除く）。実際のfixtureでElectron UI/IPC206・Electron表示代替2・Chromium28 |
| Mac native | Cmd+Q/赤ボタン/file picker/clipboardの限定4件PASS。実IMEはINFRA_BLOCKED。Dock・変換中保護・予約COMMIT失敗後の同PID再表示・親フォルダ/権限拒否等はNOT_RUN |
| Mac Keychain | 保存/独立process復号/更新/無効化/利用不能時の保留はNOT_RUN。今回のstock Playwright mock Keychainを代替証拠にしない |
| 物理Mac 2台＋サーバー | 実SSH、双方向データ/添付、切断・回線変更・スリープ・競合・復元後の新端末登録と性能受入がNOT_RUN |
| Lv4最終判定 | 上記を同じ候補へ揃え、L4-01〜12を照合する。まだ認定・master mergeしない |

[Mac受入項目](GUI-MAC-ACCEPTANCE.ja.md)。Linux上の実IPCでもnative picker返答やcompositionイベントを合成する試験は、OS実操作の代わりにしない。

## 以前の待ち項目（当時の履歴）

以下のNOT_RUNや69件という記述は各時点の記録。消化済みの範囲は上記の最新Mac結果とLinux238件を優先し、歴史上のNOT_RUNを再び現行の待ち項目へ数えない。

### M2以前の記録

> **M2第1区切り追加後**：[添付再開・保持・限定解放](M2-CHECKPOINT-1.ja.md)のsrc変更は非GUI検証のみ。以下のLinux69件は`3aac7e9`までの証拠。今回候補のLinux GUI再受入、Mac/OS、物理2台はいずれも **NOT_RUN**。

> **実行先の分離（2026-11-08）**：GitHub Actions＋Linux仮想画面の69件がPASSした（実Electron/実IPC41件、代替応答のElectron表示2件、Chromium表示26件）。[ページツリー3件](GUI-PAGE-TREE-CI.ja.md)と[保存・復旧24件](GUI-RECOVERY-CI.ja.md)を追加受入した。[CI対象と結果](GUI-LINUX-CI.ja.md)を最新の実行記録とする。[Mac/OS固有](GUI-MAC-ACCEPTANCE.ja.md)は別枠でNOT_RUN。このMacではGUIを起動しない。以下は従来の待ち項目であり、Linuxの確認範囲とMacの未確認範囲を混同しない。

M1は当時、非GUIで完了しA3前で停止した。その後の指示で上記M2第1区切りへ進んだ。[候補・証拠](M1-COMPLETION.ja.md)を参照。以下の実行許可や合格を得た意味ではない。

Mac・実機の状態: **NOT_RUN**。この候補をLv4完成として扱わない。GUIは利用者の明示指示後、今回の候補をビルドし、専用の一時 `FOLIO_DATA_DIR` で `npm run test:e2e:batch` を入口に実施する。実機2台と実トンネルは別の受入として記録する。

## M2第1区切りで追加した受入待ち

- 転送中断→アプリ再起動→送受信再開と、適用前のhash照合を実Electron/IPCと隔離データで確認する。
- 容量/所有異常時に保全停止し、raw errorや秘密を表示しないこと。現状は固定codeの表示で、診断・明示解放UIは未追加。
- 共有添付の複数受信revisionを終了/起動にまたいで適用し、cleanup後も後続が正常に進むこと。
- 実機2台・トンネル・スリープ・回線切替はLinux仮想画面と別枠。Macでの実行は新たな明示指示まで開始しない。

## M1で追加した導線のGUI受入待ち

Macの実操作はすべて **NOT_RUN**。Linuxでは上記CI範囲を実行済み。Nodeのmock/pure modelとも区別する。

- 同期設定なし・無効・未接続・read-onlyでも、保全一覧と回収操作へ到達する。通常/競合予約の保留・取消し、旧sidecarの解除未対応が分かる。
- 「保全した競合データを取り出す」の表示、小画面・dark theme・スクロール・focus・Escape・キーボード、破損行とpagination、選択対象の表示を確認する。
- JSONのみと添付付き回収データの違い、未保存/その後の編集が含まれない説明、添付不足で成功にしない表示を確認する。
- native pickerで親フォルダを選び、原本/Folio領域/backup/既存先の拒否、picker待ちの対象差替え・送信元失効・二重操作を実IPCで確認する。新規コピー復元はarchiveからbundleと復元先を作る導線で、保存済みbundleのfile pickerは未追加。
- host成功後の応答喪失・画面部品再生成でも同じ操作IDで再照会でき、保全先を表示し、未確認のまま新規出力を増やさない。未完了と結果不明を区別する。
- 復元先を後日起動する場合も一時データで実施し、環境の同期設定に関係なく登録/送信を保留する。回収marker破損も保留。元のFolioは操作しない。

操作契約と失敗時の保全手順は[回収手順書](m1/RECOVERY-RUNBOOK.ja.md)を参照。実画面受入を終えるまでLevelは上げない。

`tests/e2e/lv4-sync-presentation.spec.ts` に比較表示と予約表示の2件を追加し、`npm run test:e2e -- --list tests/e2e/lv4-sync-presentation.spec.ts` で一覧のみ確認した。これらはmainの応答をfixtureで置き換える表示試験であり、GUI実行、実IPCの同期、終了時のデータ保全、ネイティブdialogの証拠にはならない。

- 起動時: 意図なしでは受信版を自動適用せず、送信待ち・受信revision・適用済みrevision・競合・失敗・最終成功を混同しない。表示範囲・小さい画面・アクセシビリティも確認。
- 編集中に手動同期: 通常ページ、DB/record、数値編集中、IME変換中、未確定保存、構造変更、添付と復旧入力でデータが消えない。同期中の保存・保守の待機とエラー復帰を確認。実画面では未試験。
- 再起動適用: **操作導線のコードは追加済み、GUIはNOT_RUN**。Cmd+Qとウィンドウ閉鎖の双方、終了拒否、取り消し、書込み中の再表示、途中停止、復旧入力、epoch・対象revision変更、server停止、再起動後の適用結果を検証する。完了前に結果をPASSとしない。
- 競合: **候補情報・比較・JSON取り出し・勝者の確認/予約/取消し・終了時確定/次回起動適用のコードは接続済み、GUIはNOT_RUN**。比較の両候補、題名・ゴミ箱状態・値、抜粋や50件の上限、小さい画面、旧形式DB行・DB設定・添付・履歴等が比較に含まれない説明、添付本体がJSONに含まれない表示、保存先の拒否、候補変更時の停止、後から保存した入力の注意表示を確認。完全diffは未実装。archive回収画面はM1で接続し、GUI受入待ち。
- 物理Mac2台と実トンネル: 両方向の本文・階層・DB・添付・削除/復元、切断/再接続、スリープ、ACK喪失、競合、バックアップ復元後の再登録。利用規模と接続手順の確定も必要。
- Keychain/safeStorage、ネイティブファイル選択、OS clipboard、IME、Windowsはそれぞれ別の条件で確認する。fixture専用CLIの合格を実server運用の証拠にしない。

## 競合の勝者選択UI・終了時予約の接続後

状態は引き続き **NOT_RUN**。固定targetによるコアAPIとtyped IPC・rendererを接続した。確認とメモリ予約、全window閉鎖後のSQLite pending確定、次回起動の画面生成前のオンライン適用という流れ。Node試験は実windowやElectronを使用しない。

- 最新保存内容と旧ローカル候補の違い、比較範囲、確認チェック、準備が本文適用ではない説明、通常終了の案内、focus/Escapeとキーボード操作を確認する。
- 準備後の保存・未保存入力・IME変換・処理中のCmd+Q/閉鎖で、終了を拒否し入力と予約を保つ。全window閉鎖後の記録失敗で再表示し、取消しできることを確認する。
- 同期設定あり/なし・無効・未接続の起動でもpending状態と取消しへ到達できること、read-onlyでは取消しを拒否することを確認する。
- 通常適用予約との排他、確認・取消し応答の喪失、startup中断、COMMIT後の結果不明、同一操作IDの送信回収を実IPC/終了で確認する。NodeのCOMMIT故障注入・再open合格とは別に扱う。

後続の実装・受入では、ローカル選択が比較時点の旧候補ではなく最新の保存済み内容であること、未保存入力は別であること、通信中に編集/相手headが変われば再確認に戻ることを確かめる。ACK/COMMIT応答が不明な場合の永続状態の再照合、既存outboxによる同一操作回収、archive JSONと添付本体の範囲、保全内容の取り出し導線も必要。詳しくは `CONFLICT-RESOLUTION.ja.md`。
