# M1 G0実装契約 v1

2026-11-08。利用者がM1実装を明示。対象はA0〜A2、非GUI、一時データのみ。A3へ進まず停止。保存計画の限界・終了条件M1-01〜13を適用。基点はこの契約を含むcommit。

共通型は`src/shared/conflict-recovery.ts`、安全な小さいfile入力・出力は`src/persistence/recovery-io.ts`、v4内容構成は`recovered-content.ts`、回収由来guardは`recovery-origin.ts`。これらと既存共有部分はCodex単独所有。workerは担当カードのallowlistだけ編集する。

## 固定予算

checkpoint上限1,048,576 B、添付1件20,000,000 B、合計100 MiB／1,000件、一覧50件／最大100。metadata manifestは1 MiBまで。容量は既知payload×4＋64 MiB余裕を新規出力先volumeで事前確認し、不明は保留。見積りは予約ではないためENOSPCも保持する。添付stream、重い試験同時2。初回DS4本、受入2件後最大6、各対象試験maxWorkers=1。36依頼／input200万・output20万token上限、6時間で再評価、追加課金設定変更なし。

## D02 normal journal

`normal-apply-journal.ts`のexportsを以下に固定。

- `NORMAL_APPLY_KEY = "folio.sync.normal-apply.v1"`
- `NormalApplyRecord`: format `folio-normal-apply/v1`、UUID `id`、nonnegative safe integer `createdAt`、`target`（workspaceId/clientId/bindingId/serverEpoch: identifier、revision: positive safe integer、checkpointHash: hex64）、state pending/cancelled/consumed。consumedのみresult `{revision, checkpointHash}`（targetと同値）。strict/canonical 8KiB。
- `readNormalApply(db): {status:"empty"}|{status:"blocked"}|{status:"ready",record,raw}`。
- `reserveNormalApply(db, record: NormalApplyRecord): void`（pendingのみ、新ID、既存terminalはCAS置換可）。`assertPendingNormalApply(db, expected: NormalApplyRecord):void`、`completeNormalApply(db, expected):void`、`cancelNormalApply(db,expected):void`。
- 全mutationは`db.isTransaction`必須。expectedのcanonical raw全体一致CAS。reserve/consumeは`readConflictDecision(db)`がblocked/pending、または同じbindingのconsumedで`consumedDecisionMatches`がfalseなら拒否。cancelは相手状態によらず同じpendingだけcancelled化。consumeは本文適用と同一transaction内からだけ呼ぶ（統合Codex）。新IDをretryで作らない。
- `normalApplyResultMatches(db,record):boolean`と`normalApplyBlocks(db):boolean`もexportする。同じbindingのnormal consumedは保存済みworkspace_sync_appliedのrevision/hashを照合（現在の編集本文ではない）。appliedが対象より前ならfalse、同じならapplied checkpoint hash、後なら保持済みinboxの対象revision/hashを根拠にする。判定不能はblocked。別bindingのterminalは新しい予約を妨げない。自身の未検証consumedを黙って置換しない。
- Codexが競合journal側にもnormal guardを接続する。旧sidecar存在はCodexのreadonly検出でreserve/consume前に拒否。任意UID改竄を防御したと主張しない。

## D03 catalog

- `listConflictArchives(db: DatabaseSync, options?: {limit?:number; cursor?:ArchiveCursor}):ArchivePage`。
- `readConflictArchive(db, target: ArchiveTarget):ArchiveSnapshot`。
- `source`は保存済みworkspace_sync_stateのworkspace_id/client_id/binding_id/server_epochをcanonical JSON SHA256したscope。tableなしは空一覧、stateが不正な場合は保留。enable/rebind/readState/DDLは呼ばない。
- read transaction（既存transaction内ならそのsnapshotを使う）でlimit+1のkeyset読取り。anchorは最初に固定したmax id、before未満。次pageでもanchor維持。正常summaryはtarget固定、破損はvalid=false,target=null。parse前に`length(CAST(checkpoint_json AS BLOB))`で1MiBを超える行を拒否し、その行だけsummaryにする。target再取得はsource/id/op/kind/createdAt/hashすべて一致が必要。

## D04 verifier

- `validateRecoveryManifest(value: unknown): RecoveryManifest`。strict keys／format／version、target、固定`checkpoint.json`、各asset.fileは正確に`assets/${id}`、重複なし、上限とsafe sum。
- `verifyRecoveryBundle(directory: string, options?: {allowIncomplete?:boolean}):VerifiedRecoveryBundle`。通常はINCOMPLETE存在を拒否。内部の出力前検証だけallowIncomplete=true。manifest.jsonとcheckpoint.jsonはrecovery-ioで上限付き取得。checkpointはparse＋workspace validator＋hash／bytes、assetsは完全一致と全file hashを確認。canonical manifestのSHA256をfingerprintとする。token/DB dump/extra keysは拒否。内容とmanifestのasset順は正規化して比較可だが曖昧な重複は禁止。

## D05 assets

- `copyRecoveryAsset(sourceRoot:string, destinationRoot:string, asset:AssetManifest, options?:{sourcePrefix?:string;destinationPrefix?:string;fault?:RecoveryFault}):void`。prefix既定`assets`。親rootはcanonicalでassets directoryはcallerが先にfresh作成。inputFDは`withRecoveryRead`、max20,000,000 B、chunk stream→new-only outputFD→fsync→input hash/bytes照合→output readback hash。nlink/差替えはrecovery-ioで検査し、出力は失敗でも削除しない。

## D06 export（W2）

- `exportRecoveryArchive(snapshot:ArchiveSnapshot, sourceDirectory:string, destination:string, mode:"metadata-only"|"complete-bundle", options:{assertTarget:()=>void;admitBytes:(bytes:number)=>void;fault?:RecoveryFault}):RecoveryExportResult`。
- inputをコピー固定、assertTargetは出力前と完了公開直前。admitBytesはmkdir前。fresh dest＋INCOMPLETE→canonical checkpoint／manifest／必要添付→verify（内部allowIncomplete）→完了公開→directory fsync。metadata-onlyはcheckpointと明示的な非復元説明、bundle形式にはしない。completeはmanifestとの照合必須。削除は自分が作った固定INCOMPLETEを完了時に外す操作のみ、失敗cleanupしない。完了公開応答不明は例外として再検証へ。
- destinationはsourceDirectoryの同一／内側を拒否。mainはFolioのデータ／backup領域内も既存の出力先検査で拒否。canonicalな親を基準に比較し、generic recovery-ioだけでこの境界を満たすと扱わない。

## D07 import（W2）

- `restoreRecoveryBundle(verified:VerifiedRecoveryBundle, destination:string, options:{admitBytes:(bytes:number)=>void;fault?:RecoveryFault}):RecoveredWorkspace`。
- verifyし直しfingerprint比較→容量→fresh dest＋INCOMPLETE＋assets→copy→new Store(path,{allowIncompleteRecovery:true})→CodexのinitializeRecoveredContent→close→readOnly再open（allowIncompleteRecoveryも使用）でhash/marker/v4／private持込みなし検査→close→source再verify同fingerprint→完了marker公開／fsync。新UUID、source不変、内容ID保持、自動起動なし。通常保存試験は検証用コピーだけで行う。
- destinationは元bundleの同一／内側を拒否。mainは元workspaceとFolioデータ／backup内の親も拒否。

## D08 UI／D09〜12独立試験

`WorkspaceConflictRecoveryPanel` propsは`{port:RecoveryPanelPort}`。`conflict-recovery-model.ts`は世代と不明応答を守るpure model。UIを起動する試験は禁止。list/target/JSON-only/bundle/新規コピー復元／結果path／未完了・不明の注意／pagination。IPC/App接続はCodex。

`RecoveryPanelPort.status()`はmainが保持した直近操作の結果を再照会する。unknownはdirectory/targetを必須とし、再照合した同じ生成先の完成検査に通った場合だけ成功へ回収する。

mainはcore例外をRecoveryActionResultの`blocked`（出力前の拒否）／`outcome-unknown`（作成したdirectory、固定target、公開用の安全なreasonを保持）へ変換する。出力後例外を『未作成』とせず、同じ操作の結果照会を提供し、自動再実行・削除しない。rendererはunknownを成功と区別して保全先を示す。

独立試験は別file、期待hashはNode cryptoやfixtureの固定値から。fault stageはbefore/after-file-sync、before/after-directory-syncに加え、各workerがbefore/after-completeを定義。通常COMMIT前後のfaultはStore.transaction seamで注入。結果が不明なら新規ID・同一先再適用・削除をせず再openで照合。

## ホストの操作ID契約追記

UI生成のoperationIdは冪等key、mainが発行する固定target ticketは別物。run/statusはそのIDを照合し、main session中の最大16件は完了済みも削除せず、満杯なら新規だけ拒否。同一IDの同時retryには同じPromiseを返す。main再起動では操作sessionが失効し、過去の未確認出力は自動再実行せず、生成先の手順に従って確認する。通常・競合のSQLite予約はこれと異なり再起動を越えて保持する。

statusは正規INCOMPLETE確認→blocked＋保全先、marker不在で全完成検査成功→成功、検査不能→unknown。未解決unknownの記録を新操作で置換しない。known incompleteは新しい別先への試行を妨げず、前の出力は削除しない。
