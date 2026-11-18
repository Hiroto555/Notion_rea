# Folio Lv4 競合選択コアの設計・安全性レビュー

2026-11-07。レビュー元は `<INTEGRATION_WORKTREE>` の既存dirty候補。親から指定された読み取り専用レビューであり、製品ソースは変更していない。Electron・GUI・ブラウザ・OS clipboard・native dialogは未実行。作業はソース確認と使い捨てNode/SQLiteの再現に限定。

## 結論

今回の安全な実装単位は、**正確な選択対象を固定し、両候補と最新ローカルcheckpointを容量検査付きの同一SQLite transactionで保全するコア**まで。勝者ボタンや新しいrestart sidecarは接続しない。既存の通常restartは競合・pendingを拒否するため、そのチェックを緩めて競合適用へ流用しない。

## 接続前のブロッカー

### P1: 表示候補と実際に選択されるローカル内容が一致しない

`src/renderer/WorkspaceConflictPanel.tsx:69` は競合記録時点の候補を示し、同70行は後から保存された入力が含まれないことを説明する。一方 `src/sync/workspace-store.ts:776` の `chooseLocal` は実行時DBからcheckpointを生成する。既存 `resolveConflict(choice, expectedRevision)` (`src/sync/workspace-sync.ts:289`) はoperation ID・両hash・generationを受け取らず、同revisionのまま候補やローカル入力が変わっても選択を特定できない。

新しい対象はidentity（workspace/client/binding/epoch）、競合operation ID、競合local generation、両候補revision/hash、現在のgeneration/clean generation、適用済みrevision、最新ローカルcheckpoint hashを固定する。targetは入口で検証・コピーし、呼び出し側がawait中にobjectを書き換えても選択が変わらないようにする。`receivedCursor` は受信catch-upで正常に進められるため完全一致にはせず、後退や候補の変更を拒否する。対象を勝手に最新化しない。

### P1: 既存local選択は破損候補を拒否しない

`chooseRemote` (`src/sync/workspace-store.ts:832`) はtransaction内で `validateConflictRecord` を実行するが、`chooseLocal` (`src/sync/workspace-store.ts:763`) はremote JSONを直接parseするだけ。

使い捨てSQLiteで `workspace_sync_conflicts.local_checkpoint_json='{}'` にすると、`conflictInspection()` は拒否する一方、`chooseLocal(3)` は成功し、archiveを1件作り、元の競合をchosenにして新しいoutboxを作ることを再現した。実行出力: `{"inspectionRejected":true,"chosenAccepted":true,"archives":1,"pending":true,"conflict":false}`。再現コードは同ディレクトリの `review-local-candidate-probe.ts`、実行bundleは `.cjs`。

新しいguarded経路とlegacy選択の双方で、候補の構文・hash・operation/result/fingerprint/identity、既知の前版との連続性をtransaction内で検査する。破損したときはoutbox・archive・chosen・本文を全て変更しない。

### P1: archive増加全体を容量検査していない

既存local選択は1件の最新checkpoint archiveとoutboxを作る (`workspace-store.ts:797`, `807`) が容量callbackがない。既存remote選択は元local・remote・追加の最新localを最大3件archiveする (`864`, `874`, `893`)。上位の `workspace-sync.ts:408` が認めるのは受信checkpoint1件相当であり、archive全体の追加量を表していない。

選択に伴う全新規archive JSON、local outbox、適用済みcheckpointと本文置換の保守的な追加予算を、transactionの書込み前にまとめてadmitする。callbackのthrowとSQLite failureで全DB変更をrollbackする。容量検査は予約ではないため、ディスク競合・COMMIT結果不明を別途保全停止に扱う。候補削除を容量回避に利用しない。

### P1: 画面からremote勝者を直適用してはいけない

`WorkspaceSyncService` は転送のみで適用methodを持たず (`src/main/workspace-sync-service.ts:47`)、通常restart guardはconflict/pendingを拒否する (`src/main/workspace-sync-apply-guard.ts:21`, `47`)。この境界は維持する。

将来のremote勝者は独立したwindowless conflict restart意図へ接続し、mainが入力/recovery、active/queued writeとmaintenanceを含むgate idle、全window閉鎖、同一対象を確定直前と起動時に確認する必要がある。現コアの `canApply` は呼び出し側契約であり、実Electronの入力・IME保護を証明しない。今回はservice/IPC/rendererへ選択を追加しない判断でよい。

## 推奨コア手順

1. targetを作るpreviewは読み取りのみで、厳格な候補検査と最新checkpoint生成を行う。返したtargetのsnapshotをresolve入口で保持する。
2. `exclusive` とbinding確認後、targetと `canApply` を検査し、server headをidentity/epoch/revision/hashで照合する。localの新規outboxもpreflightの後に作る。server CASはその後のhead移動を防ぐ最終条件。
3. remoteは最大8 revisionの既存catch-upを維持する。中途で上限に達したら選択・archive・本文を変えずに停止し、受信したstagingは残す。受信で進んだcursorだけを理由に古い選択とはしない。
4. head取得・receive・asset転送等のawait後に、targetとclean入力を再検査する。asset転送後に最新headを再確認する。backup/admission後にも同期境界で検査する。
5. transaction内で同じtargetを再検査し、候補両方と最新localを保全してから、local outbox/chosenまたはremote本文/applied/chosenを一括変更する。最新localが元候補と同じかはhashで区別する。
6. local送信のACK喪失は、新outboxと選択済み記録を保持する。元targetのresolveを再実行して別operationを作らず、`sendPending` で同operation IDを照合して再送する。serverが前進していれば新しい競合となる。既に確定したDB選択をネットワーク失敗だけでrollbackしない。

## 宣言すべき範囲制約

- checkpoint JSON archiveは添付manifestを含むが添付本体を複製しない。特に既存local選択はremote専用添付を取得しない。完全な候補保全を宣言するなら両側assetの取得・検証・保持契約が必要。今回はcheckpoint保全と明記する。
- archive概要は取得できるが、解決済み候補のarchive ID/hash指定の内容取得・取り出し・復旧UIは現時点でない。原本候補はconflict行にも残るが `conflictCandidate()` は未解決候補のみを返す。製品として復旧可能と呼ぶ前に読取り・取り出し導線が必要。
- `validateWorkspaceCheckpoint(latest, remote)` はremoteの既存ページ・asset・record所有権の欠落を拒否する。remote専用データを持たないlatest localを無条件の勝者にはできない。この保全制約を緩めず、明示merge/importは別設計とする。
- archive・同期履歴の有界保持と掃除は未完。容量不明/不足なら保全して停止する。
- sidecarのread→unlinkと外部同一UID writerのpath置換競合は既知の未修正事項。lstat追加だけでは原子的条件付き削除にならない。今回新規sidecarを増やさず、将来は協調writer排他または条件付き削除不要の記録方式を選ぶ。
- server head照合は履歴lockではない。照合後からSQLite適用までにserver復元が起こる条件は運用排他の別課題。新方式の受入でもこれをPASS扱いしない。

## 必須の非GUI回帰

- local/remoteとも、元候補とlatestをhash指定で読める形で保全し、再open後も残る。
- target取得後の最新編集・generation同値の内容改変・clean/applied変更・operation差替え・片側hash不一致を拒否。outbox/archive/chosen/本文は不変。
- local候補破損、remote result/fingerprint/identity破損、staged candidate相違をlocal/remote双方で拒否。
- target objectをhead/asset待機中に呼び出し元が変更しても、選択が変化しない。
- head待機、receive、asset転送、backup/admissionの境界で新編集または `canApply=false` を注入すると選択を拒否する。
- 正常な受信cursor前進は許すが、head変更/epoch変更/後退を拒否。catch-up上限ではarchiveも選択も作らない。
- 容量不明・不足・archive追加時のSQLite例外で原子的rollback。全追加量のadmissionがarchive/outboxを書き始める前に行われる。
- local送信ACK喪失→再open→同一operationのreceipt照合→重複archive/commitなし。server CAS不成立は新競合として双方を保持。
- 通常の転送service/IPCは引き続き本文を適用しない。GUI/Electron/IME/実機2台・native dialogは全てNOT_RUN。

## 親のコア実装を読んだ追記

親が追加した `src/shared/workspace-conflict-resolution.ts`、storeのpreview/assert・選択transaction、`WorkspaceSync.resolveConflictTarget` を読み直した。flatなtargetを4096bytesに制限してawait前に複製・freezeすること、candidate/identityとlatest hashを再照合し、received cursorの正常な単調前進だけを許す方針、双方のcheckpointとlatestを元競合operation IDへ束縛して同一transactionでarchiveする方針は、今回のコア限定範囲に適している。

破損候補probeを変更後のソースから再bundleして再実行した結果は `{"inspectionRejected":true,"chosenAccepted":false,"archives":0,"pending":true,"conflict":true}`。前述のlocal選択の破損受入は拒否され、archive/chosenも変化しなくなった。

追加提案として、`apply()` のbackup/容量callback後、およびchooseLocal/chooseRemoteへ渡す容量callbackの直後でも `canApply` を再確認するよう親へ連絡した。現コードのtarget再検査はDBの変化を捉えるが、recoveryだけがdirtyになった場合はtargetに含まれない。実イベントループ経路では同期区間にrendererイベントは入らないものの、注入callbackの境界と呼び出し契約を明確にする回帰条件として有用。

この追記時点では、これ以外にtarget/candidate/archive transactionのコア設計上の阻害事項は見つけていない。親が追加中の回帰試験と統合checkの結果は別記録であり、このレビュー自体は全suite合格や製品受入を主張しない。

## 最終のコア再レビュー

親がcallback後のbarrier再検査を追加した版を再読した。local選択のadmission後に `canApply` とtargetを再確認し、remote適用ではbackup/最初のcontent admission後に再確認、transaction側のarchive admission後も `canApply` とtargetを再確認する。以前の追加提案は反映された。

`tests/lv4-conflict-resolution.test.ts` と `tests/sync-conflict-inspection.test.ts` を読み、2026-11-07 22:56 JSTに独立して `npm test -- --maxWorkers=2 tests/lv4-conflict-resolution.test.ts tests/sync-conflict-inspection.test.ts` を実行した。**2ファイル・30試験PASS**。実loopback catch-up、await中の編集、early/late head移動、caller object改変、recovery-only入力のcallback境界、local送信ACK喪失後のreopenと同operation再送、容量拒否とarchive途中失敗rollback、generationが同じ内容のhash変化を確認する試験である。

今回の**core-only・単一所有者の範囲で追加のブロッカーは見つからない**。全体のquiet一括検査は親が別途行う。GUI/Electron、実際の終了、IME、添付を含む製品の完全保全、実機2台はNOT_RUNのまま。

成功/失敗の表現には次の条件を残す。

- resolveのPromiseがrejectしても、常に「未適用」とは限らない。local選択またはremote適用のSQLite COMMITが完了した後に結果受領で失敗する可能性がある。曖昧な結果では再openしてchosen/outbox/appliedを調べる。localのネットワークACK喪失は同operationの `sendPending` でreceiptを照合し、元targetの再resolveで新しい選択を作らない。
- DB transactionのrollbackはファイル操作のrollbackではない。選択拒否・容量不足の前後で、既に作成したbackupや検証済みasset/stagingが残る場合がある。これを本文適用成功や添付の自動掃除と扱わない。
- 新targetはstale-state guardであり、利用者の承認やrestart intentそのものではない。legacy revision-only選択経路は互換用に残り、新しいtarget方式と同じstale-selection保証を主張しない。active-window service/IPC/rendererへの勝者接続を今回含めないことが、このコア評価の前提である。
