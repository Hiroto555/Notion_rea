# 競合の明示選択と終了時予約

2026-11-07。統合用ツリーだけで継続実装。確認画面・typed IPC・終了時の予約・次回起動時の適用をコードで接続し、Node/一時SQLite/loopbackで状態遷移を確認した。実画面・Electron・実終了イベントは **NOT_RUN**。Lv4完成の記録ではない。

## 利用者が選ぶ流れ

1. 「競合候補」を開き、この端末の最新保存内容またはリモート版の確認へ進む。mainが両候補と最新保存内容を固定したpreview IDを発行する。
2. 確認画面は最新保存内容と相手候補を比較する。競合時点の古いローカル候補とは世代・hashを区別する。抜粋、比較対象外、添付本体と復元画面の制約を示し、チェックを入れてから準備を要求する。
3. 「この選択を終了時に確定する準備」はメモリ上の予約だけで、本文もdurable intentも変更しない。予約は取り消せる。アプリを自動終了せず、利用者が通常どおり終了する。
4. 全windowが閉じた後、mainが未保存/復旧入力・同期/保存/保守の排他・通常適用予約・固定targetを再検査し、SQLiteにpendingを記録する。不一致・容量拒否・結果不明なら終了を保留してwindowを開き直す。IME変換中も既存のunload拒否条件へ追加した。
5. 次回起動のrenderer生成前にオンラインで対象・head・入力を再検査し、コアAPIで一度だけ選択する。競合の通常送受信や再登録はこの選択より先に実行しない。接続できない、head/対象が変わった、入力がある場合はpendingを保つ。
6. 設定なし・無効・未接続で起動した場合にも、ローカルのpending状態と取消し操作を表示する。取消しはdecision ID付きのSQLite CASであり、本文や入力を削除しない。

## 固定する内容

`WorkspaceSync.conflictResolutionTarget(choice)` は、端末・workspace・binding・server epoch、競合の操作ID、両候補のrevision/hash、競合時と現在のgeneration、clean generation、適用位置、最新の保存済み本文のcheckpoint hashを返す。`local` は**現在の保存済み内容**を意味する。比較画面の競合時点のローカル候補や、未保存の入力とは区別する。

`resolveConflictTarget(target)` は小さいtargetをコピーして固定し、通信待ちの間に呼び出し側がオブジェクトを変更しても追従しない。相手headを照合し、通信・受信・添付取得の後と、SQLite transaction内で対象を再確認する。新しい保存、候補の差替え、識別・epoch・適用位置の変更があれば停止する。受信cursorだけの前進は許すが、候補を新しいheadへ自動で変更しない。

targetは古い状態の検知用であり、認証、未保存入力の確認、終了処理、排他の代わりにはならない。呼び出し側は編集・保存の排他と復旧入力の検査を保持する必要がある。backup・容量検査の後にも `canApply` を再検査する。active-windowのservice/typed IPCは確認・メモリ予約・取消しだけを提供し、本文を適用する入口は公開しない。既存のrevisionだけを取る `resolveConflict` は内部互換入口として残っており、画面の選択要求に使わない。

## durableな状態と結果不明

競合用の新しいsidecarやtableは追加しない。checkpointへ含まれないローカルsettingsのprivate keyを使う。一般の`setting` IPCは既存のallowlistによりこのkeyを書けない。レコードは8KiBまでのstrict/canonical JSONで、固定target、UUID、pending/cancelled/consumed、結果を持つ。破損・非canonicalな値を上書きしない。

pending→consumedと結果の記録は、localならoutbox/chosen、remoteなら本文/applied/chosenと**同一SQLite transaction**で行う。local結果には新しい送信操作ID/hash、remote結果にはrevision/hashを保存する。consumedは決して選択し直さず、outboxやarchive/chosenの根拠を再読して扱う。local送信ACKを失った場合、次回の通常送受信が同じ操作IDのreceiptを照合する。

取消しはpendingのIDと記録全体を比較してcancelledへ変える。削除や別の新予約の取消しをしない。直近のterminal結果を1件保持し、明示的な次の予約でCAS置換する。履歴全件のjournalではない。通常の再起動適用とは、画面での準備・終了時の確定・起動時の双方で相互排他にする。

UIは非同期応答の世代を確認して、古いpreview/statusやunmount後の応答を無視する。confirm/cancelの応答が不明な場合は、新しい選択を自動発行せずmainの状態を再照会する。取消しは、予約時に取得したIDまたは状態照会で確認したIDだけを送る。

## 保存と失敗

- ローカル選択は両候補の永続記録・識別・履歴を検査し、最新の保存済み内容のoutbox、両候補のcheckpoint JSON、最新のローカルcheckpoint JSON、決定を同一transactionに保存する。相手のページ・添付識別を暗黙に失う選択は従来どおり拒否する。
- リモート選択は両候補と、異なる最新ローカルcheckpointを保存してから本文を置き換える。各archiveは元の競合操作IDに結び付ける。候補破損は既存の内部選択入口でも拒否する。
- 容量検査はoutbox・全archive・適用checkpoint・置換内容等を含む追加量の見積りを使う。予約やSQLiteの実割当量の厳密な上限ではない。検査拒否やtransaction途中のarchive書込み失敗では、本文・候補・outbox・決定をロールバックする。容量設定が無制限の場合の有界保持は未実装。
- `local` の送信応答を失っても、決定と同じ操作IDのoutboxを保持する。元のtargetで決定をやり直さず、再読後に `sendPending()` で既存のreceiptを照合する。その後に保存した編集は別の未送信内容として残る。

拒否・例外が常に「未適用」を意味するわけではない。SQLiteのCOMMIT完了後に応答を失った場合や、決定後の送信失敗では、再openしてchosen・outbox・appliedの永続状態を調べる必要がある。transactionのロールバックはファイルのロールバックではなく、取得したstagingやbackupが残る場合がある。

## 保全範囲と残る導線

archiveはcheckpoint JSONと添付manifestを保存する。添付本体を全て複製・保持する完全backupではなく、archiveからの復元・取り出し画面も未実装。特にローカル選択は相手候補だけの添付本体の取得を保証しない。既存のGCを拡張したりarchiveを自動削除したりしていない。

head照合は読み取り時点の検査とserver CASに基づく。検査後のserver履歴をロックしない。ローカル選択後にheadが進めば、新しいoutboxが次の競合になる場合がある。リモート適用とserver復元の原子的な排他は提供しない。

確認・準備・取消し・終了後の確定・次回起動時の適用はコードを接続したが、Electronの実終了イベント、IME、操作中断、focus/Escape、小さい画面・アクセシビリティの受入は未実施。archiveの取り出し・復元画面も未実装。通常再起動適用のsidecarは別経路のまま残り、既知の外部同一UID writerによるread→unlink差替え問題も未解決。競合用の予約はこのsidecarを流用しない。

## 検証

一時SQLiteと実loopback serverを使用し、候補破損、generationが変わらない本文変化、識別/候補の不一致、容量拒否、途中archive障害、通信前・通信中・受信中の編集、headの前進、targetオブジェクトの変更、backup/容量検査中の復旧入力、送信ACK喪失と再open後の同一操作回収を試験する。実製品のIPC、終了、GUI、添付本体の完全保全、物理2台の証拠とは区別する。

追加の非GUI試験では、両方向のpreview→閉鎖観測→予約→Store再open→startupの一度だけの選択、取消し、古いpreview/ID、同期設定なし・未接続の取消し、通常適用との排他、COMMIT前失敗・COMMIT後の応答喪失、送信ACK喪失、取消しと起動時head取得の交差、IMEのみのclose拒否、UIの遅延応答を確認する。Electronのwindowは作らず、閉鎖の観測値をNodeで供給した試験である。
