# 競合勝者UI・終了時予約の安全性レビュー

2026-11-07。親が編集する隔離integration候補の読み取り専用レビュー。GUI/Electron/browser/clipboard/native dialogは未実行。今回は設計上の必須条件を先に共有し、実装後に再レビューする。

## 最小の安全な構成

1. mainが `conflictResolutionTarget(choice)` と最新保存内容の概要を作成し、コピーしたtargetに紐付くopaqueな `previewId` を返す。rendererはchoice、両候補、最新保存内容、比較対象外、checkpointのみの保全、次回起動での実行を明示した確認を表示する。確認要求はpreviewIdだけを返し、mainが現在targetと再照合する。
2. 確認後はwindowが存在する間、mainのメモリにconfirmed reservationを保持する。ここではdurable consentを作らず、本文もoutboxも変更しない。新しい編集/対象変化で古い予約を暗黙更新しない。
3. `will-quit` で全windowの閉鎖、recoveryがclean、保存/保守/同期と待機中writeのgateがidle、同じtarget、通常restartのメモリ予約・sidecarがないことを再検査する。すべて成立してからSQLiteにpending intentをtransactionで記録する。失敗・結果不明ならquitを阻止してwindowを再表示する。
4. SQLiteの小さいlocal recordは `{format, decisionId, target, state: pending|consumed|cancelled, result?}` を保持する。設定keyを使うなら既存の4つのrenderer設定key allowlistを維持し、checkpoint対象外であることを確認する。専用tableを増やすならstrict v5 known-table/schema/trigger検証の変更が必要になる。
5. 再起動では最初のrendererを作る前にpending recordを検査し、recovery、identity/binding/epoch、通常sidecarとの排他、対象head、candidateと最新ローカル内容を再照合して `resolveConflictTarget` を呼ぶ。今回のコアはonline-onlyなので、server不通なら保留し、通常offline適用の制約を緩めて流用しない。
6. **consumed/resultへの移行をchooseLocalのoutbox/chosen、またはchooseRemoteのarchive/content/applied/chosenと同じSQLite transactionで確定する。** localは生成した新outbox operationIdとcheckpoint hash、remoteはapplied revision/hashを結果に結び付ける。transaction後に別途consumedを付ける設計は採用しない。
7. 再起動でconsumedならwinner選択を再実行しない。localの送信応答不明は既存outbox operationIdのreceipt照合へ進める。pendingのまま元conflictがchosenになっており対応するatomic resultを証明できない場合は結果不明として保留する。
8. cancelはdecisionId・target・pending状態のCASでcancelledへ変える。DELETE/unlinkは使わない。新しい別予約を消さない。再起動後の保留pendingも、メモリ予約なしで利用者が取り消せるようにする。

## 具体的に見つかったブロッカー

`src/renderer/App.tsx:971` のbeforeunloadはpending編集・数値draft・構造操作・recovery queue等を確認するが、`composition.current` が条件にない。IME開始だけでまだdirty checkpointができていない場合、mainのrecovery読取りからは変換中を観測できない。compositionを終了拒否条件へ加え、preview/confirm側にもAppのfreshな入力readiness確認を渡す。最後のmainチェックの代用としてrenderer booleanを信用する設計にはしない。

通常restartと競合restartは相互排他が必要。prepare時だけでなくconfirmed reservation、quitの確定直前、startupの各段階で両者を確認する。quit内で一方を先にcommitした後、もう一方があったことを知る順序は避ける。両方あればどちらも適用せず保留する。

## 既存境界との関係

- 現在のactive-window `WorkspaceSyncService` は転送のみ。winnerの実適用を通常service methodやrenderer IPCへ公開せず、serviceはpreview用target/概要の読み取りだけを提供する。
- `WorkspaceConflictPanel` のlocal比較は競合時点。localを選ぶ意味は最新保存内容であるため、確認画面に最新checkpointを別に示す。未保存の入力を選択結果に含める表示にしない。
- `WorkspaceSyncRestartCoordinator` は普通のpending/conflictを拒否する。新規競合flowのためにこのguardを外さない。
- `finishWorkspaceQuit` は実際に終了できるかの最終関門で、今回の変更でも未確定・不明時はcloseStoreを呼ばず、quitを止めて再表示する。
- 初期の設定keyに関する懸念はソース再確認で訂正した。`shared/types.ts:540` はactivePage/theme/sidebar/expandedのallowlistを既に持つため、generic setting IPCによる新intent keyの生成は現状ではできない。

## 必須の非GUI回帰

- preview→confirmの間、confirm→window閉鎖の間、startup通信の間の保存/候補/hash/identity変更で保留。targetを自動更新しない。
- 変換中、未保存draft、recovery破損/dirty、recovery書込み待機、保存/保守/同期の実行中と待機writeで確定しない。
- 閉鎖取消し、Cmd+Q相当と通常window-close相当、quit保留後の再表示、再表示後のcancelをNode lifecycle seamで試験する。実ElectronイベントはNOT_RUN。
- SQLite pending記録のCOMMIT前後fault、consumed/result COMMIT前後fault、local server ACK喪失で二重winner実行や重複archive/outboxがない。
- cancelとconsumeのCAS、古いdecisionId、別previewId、mainで期限/世代の変わったpreview、malformed recordを拒否する。durable pendingを再起動後にもcancelできる。
- 通常restartのメモリ/sidecarと競合予約が同時に存在する場合は両方保留。recover rebindとpending intentも同時に進めない。
- read-only拒否、sender認証、strict IPC shape、容量拒否と結果不明の保全。await後は送信元を再確認する。

## 保留範囲

checkpoint archiveは添付本体の完全保全ではない。archiveの取出し・復旧UI、実IME、実Electron quit/relaunchイベント、物理2台、実serverのrestore排他は別の受入。通常sidecarの外部同一UID writerとのread→unlink競合は既知の未修正事項であり、新flowへ複製しない。SQLiteの明示状態遷移も、外部同一UID writerの任意改竄に対する防御を意味しない。

## コア・mainの中間レビュー

新しい `src/sync/conflict-decision.ts` と `src/main/workspace-conflict-decision-control.ts`、store/sync・startup・main IPC/quit・通常restartとの相互排他を読んだ。local/remote双方でdecisionのconsumed/resultを選択と同一transactionで保存し、admission後にpendingを再確認する構造になっている。startupのpending処理は通常転送・rebindより先にあり、consumedは再選択しない。`sync:run` はgate待機後の送信元再確認とreservationチェックを行う。通常restartとの相互参照は `hasReservation()` だけを呼ぶため、status同士の再帰にはならない。

この中間時点で、上記コア・main経路に新たなブロッカーは見つけていない。次の軽微な点と、後続UIの必須条件を親へ連絡した。

- 生成時はcanonical JSONだが、read側は非canonicalなJSONも受け入れる。`raw === canonicalJson(record)` の確認を加えるとduplicate keyや書換えられた形式を保全停止にできる。
- recordは単一setting slotで、次の予約が前のterminal rowを置き換える。削除操作を使わないことと、全terminal IDの無期限保持は異なる。コメント・文書は直近結果のみの有界保持と説明する。
- UIはsync transportがdisconnected、または候補inspectionが取得できない状態でもdurable pendingと取消しを表示する必要がある。再起動後の取消しはmain controllerに実装されているため、親UIの早期returnで到達不能にしない。

この中間レビューでは新journal用のNode試験がまだ追加途中であり、試験合格・GUI受入を主張しない。

## UI・終了処理の最終候補レビュー

`WorkspaceConflictDecisionControls.tsx`、`conflict-decision-model.ts`、`input-close-guard.ts`、Appのreadiness/beforeunload接続、journal/main/startupの最終候補と新規試験を読んだ。前述のcanonical JSON検査と単一slotの説明は修正されている。入力guardはIMEを含み、preview/confirmとbeforeunloadで同じfreshなref状態を確認する。勝者適用やquitの直接IPCは追加されていない。UIの不明応答は新選択を送らずstatus再確認へ進み、confirm重複を抑制し、取消しは未接続時も要求できる。

2026-11-07 23:29 JSTに次を独立実行した。

`npm test -- --maxWorkers=2 tests/lv4-conflict-resolution.test.ts tests/lv4-conflict-decision-ui.test.ts tests/sync-conflict-inspection.test.ts tests/lv4-sync-restart-coordinator.test.ts tests/lv4-workspace-quit.test.ts tests/storage-write-policy.test.ts`

**6ファイル・90試験PASS**。内訳はresolution 33、UI model 21、inspection 16、通常restart coordinator 10、quit 3、storage policy 7。これらはNode/一時SQLite/loopbackであり、Electronの実イベント・画面・IME動作の証拠ではない。

新たに見つかった到達性の問題を親へ連絡した。`App.tsx:1791` は引き続き `syncMessage` がtruthyの場合だけindicatorをmountする。同期を無効化または設定なしで再起動するとstartup helperは即座に `{}` を返すため、durable pendingがあっても状態・取消しUIがmountされない。main controller自身はsourceなしでも取消しを提供できる。サービス未接続時のindicator内修正だけでは、このAppの外側の条件を解消できない。同期設定がない起動も「未接続時の取消し」に含めるなら、小さいdecision controllerをstartupMessageと独立してmountするか、local pending signalで表示する必要がある。

この到達性以外には、再bind/consumed結果の扱い、原子的な記録、main/rendererのライフサイクルに新たな阻害事項は見つけていない。GUI/ElectronはNOT_RUN。

## 到達性の修正確認

親の修正後、`App.tsx:1791` がstartupMessageの有無にかかわらず `WorkspaceSyncIndicator` をmountすることを確認した。indicatorのunavailable分岐は候補ボタンを隠した `WorkspaceConflictPanel` を常にmountし、その中のdecision controlsがtransportと独立してlocal journalのstatusを要求する。pendingの表示と取消しはsource未接続でも到達できる。未接続・idle時には候補ボタンや初期の確認ボタンを表示しない条件も確認した。

前述の取消しUIの到達性問題は**ソース上で解消**された。preview領域へのfocusとEscapeによる閉鎖コードも追加されているが、実際のfocus・keyboard・画面動作はGUI NOT_RUN。今回の差分について広範な試験は繰り返しておらず、親の最終quiet検証の対象とする。

この確認時点で残る追加ブロッカーはない。既知の通常sidecar外部writer競合、実Electron/IME/実機受入、checkpoint保全と完全backupの違いは引き続き制約として残る。
