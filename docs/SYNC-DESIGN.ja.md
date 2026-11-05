# Folio Level 4：隔離・非GUI実装の契約案

2026-11-04。設計対象 `<workspace-root>/Folio-l4-quiet`、base `8bfb3d2430a738e034371df28bc311bb2863fb3f`。製品ファイルは変更していない。Electron/ブラウザ/OS clipboard、既存データ、公開、Opusは使用していない。

## 結論

最小実装は **同一所有者・workspace単位のcheckpoint同期**。独立した2つのSQLite clientと永続serverを作り、差分CRDTではなく、版付きの内容snapshotをCASで直列化する。別ページの同時変更も競合になる粗い粒度だが、片方を黙って消さず両側を保持できる。名称は「checkpoint同期基盤」とし、ライブ共同編集・文字単位自動マージとは呼ばない。

今回はloopback server＋2 client fixtureで通信断/再開/再送/競合/添付/削除/復元境界を検証する。実機2端末、GUIとの統合動作、インターネットdeployment、TLS運用はNOT_RUN。非GUI同期実装が通っただけで製品全体のLevel 4到達とは宣言しない。既存編集sessionと安全に接続する条件まで実装・確認する必要がある。

## 基準commitでの接続点

- `Store.commitSave()`（src/persistence/store.ts:725）にはSQLite transaction＋page revision＋operation receiptがある。ネットワークreceiptは別にし、既存receiptを流用しない。
- `Store.load()`（同:333付近）はpages/record membership/settingsを一貫したSQLite snapshotで返す。送信用snapshotも同一read transactionで採取する。
- `EditSessionCoordinator.attach()`（src/renderer/edit-session-coordinator.ts:47）は既存laneを置き換えない。`DatabaseSessionCoordinator.attach()`（同名ファイル:41）も同じ。DBだけremote更新しload()を呼んでもEditor/undoの古いbaseは残る。
- AppはIME、raw数値、pending/unknown/structural operationを別管理する（src/renderer/App.tsx:907,1308付近）。`hasUnsaved()`だけではremote適用許可の判定が不足する。
- 添付は `attachFile()`（src/persistence/assets.ts:32）でファイルを作りassets表へ登録。Store.transaction外の書込みも同期dirty記録に接続する必要。
- full backupは全SQLite表をlogical hashに含む（full-backup-verify.ts:226）一方、対応store versionは現在3/4のみ（同:661）。同期スキーマと復元の更新を同時に行う。

## 1. 同期するもの・端末に残すもの

通信payloadは実行可能SQL/DDLやDBファイルの丸コピーにしない。既知の表と列だけを許した、canonical JSONの内容snapshotとする。

**同期対象**：pages（deletedAtを含む）、record_databases、record_memberships（values/position/owner）、versions/record_value_versions、record lifecycleのtrash batches/members、存在するlegacy migration archive/map/version対応、assets metadata。ページ本文内のblock ID、page ID、property ID、record所属IDを保持する。body検索列は本文から再計算し検証する。DB view/settingsはpage.databaseにあるため含まれる。

**端末ローカル**：settingsのactivePage/theme/expanded、folio.recovery.workspaceId、save_receipts、crash-recovery journal、端末binding、認証token、sync cursor/outbox/inbox。`crash_recovery_copies`はローカル復旧操作の冪等記録として残す。generic settingsをネットワークへ丸ごと出さない。将来共有settingsが必要ならallowlistを増やす。

履歴はworkspace全体CASのsnapshotに一緒に載せる案。独立forkの履歴ID衝突はCAS conflictとして分離し、SQL整数IDを無理に行単位mergeしない。履歴100件保持の現契約は維持する。旧形式/未知table/未知schemaは静かに省略せず同期を停止し、ローカル原本を残す。

現Store v4にsync_*表を追加するだけでは旧アプリがoutbox無しに書ける。同期有効化時にはbefore-sync backup後にstore version 5へ原子的移行し、旧v4を拒否させる。record version検査・書込みguard・full backup verifier・migration testも同時更新する。新アプリが通常非同期workspaceを一律移行する必要はない。

## 2. Wire contract v1

- workspaceId：ランダムUUID。ローカルrecovery.workspaceIdとは別。
- clientId：client instanceごとの永続UUID。DBを別端末にコピーして使い回さない。
- serverEpoch：server DBのidentity。serverを作り直した場合、cursorをそのまま使わせない。
- remoteRevision：serverがworkspace単位で採番する単調増加整数。Page.revisionやクライアント時刻とは別。
- snapshotHash：version・内容・添付manifestをcanonical化したSHA-256。
- operation：`{protocol:1, workspaceId, clientId, operationId, baseRemoteRevision, snapshotHash, snapshot}`。
- ack：`{operationId, fingerprint, status:'applied', remoteRevision, serverEpoch}`。
- conflict：`{operationId, fingerprint, status:'conflict', currentRemoteRevision, currentSnapshotHash}`。サーバー側にも敗者payload/manifestを永続保持。
- change：`{cursor, operationId, clientId, snapshotHash, snapshot}`。cursorは単調なworkspace stream位置。v1ではremoteRevisionと同じ値でもよいが型を分ける。

API例：`GET /v1/workspaces/:id/head`、`GET .../changes?after=N`、`POST .../commits`、`GET .../operations/:clientId/:operationId`、`PUT/GET .../blobs/:sha256`。commitは同じkey＋同じfingerprintなら同じ結果、同じkey＋異なるfingerprintは409拒否。ネットワーク切断後はoperation result lookupか同じimmutable envelopeを再送する。新operationIdでの無条件再送は禁止。

サーバーのtransactionで、認証済workspaceのheadを読む→baseRemoteRevisionを比較→payload/refs/全添付の存在を検証→head/change/operation receiptを同時確定する。受理前にACKしない。時刻によるLast-Write-Winsは使わない。

## 3. durable outboxと取りこぼし防止

`sync_state(workspace_id, client_id, server_epoch, applied_revision, received_cursor, local_generation, uploaded_generation, enabled)` と `sync_outbox` / `sync_inbox` / `sync_conflicts` をSQLite内に置く。

ローカル内容変更と同じtransactionでlocal_generationを上げ、未送信outbox taskを作る。全ての内容変更入口を列挙する：通常save、DB/record作成、property/legacy migration、move/trash/restore/duplicate、history restore、import/recovery copy、asset registry。UI settingsやreceiptだけの書込みは内容dirtyにしない。入れ子transactionは外側で一度だけ記録する。remote適用は専用originにしoutboxへechoしない。

送信直前、BEGIN IMMEDIATEで一貫したsnapshotを採取し、最新generationとbaseRemoteRevisionを固定したimmutable envelopeをoutboxへ保存してCOMMIT。その後HTTP。未送信taskのcoalescingは許すが、**一度送信可能状態にしたpayloadは再生成しない**。local commit後にcallbackでoutboxを書くだけでは、クラッシュ隙間で変更を失うため不可。

送信中にもlocal編集は継続可能。ACKは送ったgenerationまでuploadedにするだけで、その後の変更を消さない。次のoutboxは新headをbaseに準備する。サーバーがcommit済・ACKだけ消失した場合も同一envelopeで一度だけ適用される。

pullの受信payloadをinboxへ保存しreceived_cursorを同じtransactionで進める。**receivedとappliedを分離**し、適用前にcursorだけ進めて消失させない。適用できないdirty/unknown状態ではinboxに置くだけ。restart後はinboxから再開。無効payload/添付はcursorを進めず可視エラーにする。

## 4. conflictはworkspace全体、両側を永続保持

base不一致時はサーバーの最新snapshotとローカル候補snapshot/添付manifestをconflictとして保存し、そのworkspaceのpush/applyを停止する。別ページ変更同士でも衝突する仕様を隠さない。

v1は自動mergeしない。明示的な解決APIで (a) remoteを採用、(b) localを採用して最新headに対して再CAS、を選べる。どちらでも落とした側のsnapshotは保持する。競合後にremoteがさらに進んだ場合は再びCAS conflict。単純にbaseだけ書き換えて自動再送しない。必要ならlocal候補を別workspaceへ退避するが、共有中のIDを黙って振り直すことはしない。

削除はdeletedAt tombstoneで送る。v1はpage/assetの物理purgeとtombstone GCを実装しない。前headに存在したpageをsnapshotから黙って省いた場合は拒否し、削除の代わりとしない。復元は既存tombstoneの明示状態変更。全snapshotの親参照・循環・record所有DB・property値の型・DBごみ箱batchを事前検証し、半分だけ反映しない。

## 5. 既存Editorを守るremote適用barrier

一番危険なのは「SQLiteだけ更新し、古いEditor lane/undo/raw値が残ったまま保存する」こと。最低限のhost contractを置く。

1. mainがremote適用を準備し、rendererへnonce付きquiesce要求。
2. rendererは新編集を一時停止。IME中、raw数値/不正filter入力、pending/saving/unknown/conflict、import/structural operation、journal未確定があれば拒否し、inboxを保持する。黙ってflush/dropしない。
3. 全てcleanならjournal保存を確定し、nonce＋現在のworkspace epochをACK。mainは再確認し、書込みIPCをbarrierで拒否する。
4. verified backupを作り、添付を準備し、transactionでsnapshotとapplied_revisionを反映。失敗時は元DBを維持しbarrierを解除、エラーを返す。
5. 成功時はworkspace epochを更新し、旧epochの書込み要求を拒否。古いlane/undoを流用せず、trusted rendererを明示reload（または全sessionの明示invalidate→fresh install）する。reload完了ACKまで書込みを再開しない。

既存IPCはURL/sender検証のみなので、古いframeから遅れて届く要求まで考慮するならepoch/nonceをrequest wrapperに含める必要がある。mainの単なるboolean lockだけを解除すると旧要求が後から通り得る。dirty laneをそのまま新revisionへrebaseする実装は禁止。

GUI禁止の今回：host adapterをinterfaceにし、headless fake barrierでdirty拒否/clean適用/古いepoch拒否をテストする。Electron/preload/Appへの配線を実装しても**実GUI動作はNOT_RUN**。閉じたworkspaceをCLIで適用する場合も共有の排他owner機構が必要。ElectronのrequestSingleInstanceLockだけではNode CLIとの排他は保証されない。

## 6. attachmentsとファイル/SQLite境界

添付は既存asset IDとfolio-asset URLを保持し、bytesはsha256で検証する。1ファイル上限20MB（現attachFile契約）、snapshot/総容量にも明示上限を設け、超過時はHTTP 413で変更なし・outbox保持。

送信：認証workspaceへblobを先にupload→serverはtmpへstream、サイズ/hash検証、fsync/atomic publish→DBのworkspace blob registryへ登録→そのblobを参照するcommitを受理。global hash dedupを使う場合もworkspaceの参照権限を必ず分け、他workspaceのblob存在/取得を漏らさない。

受信：stagingへdownload→hash/size検証→assets/idへ安全にpublish→SQLite transactionでmetadata/本文を反映。途中クラッシュで未参照blobが残るのは許すが、公開済本文が欠落blobを指す状態は許さない。同じasset IDに違うhashを受信したら上書きせず拒否。v1は孤児blob削除をしない。pathはIDから組み立て、remoteのstorageName/パスをそのまま使わない。symbolic link/既存ファイル差替えに対する現在のbackup/asset境界を維持する。

## 7. 認証・workspace分離

loopback serverは127.0.0.1のみにbind。fixtureでもランダム256-bit capability tokenを必須とし、server側でtoken→ownerId＋許可workspaceを対応付ける。body/pathのworkspaceIdを信用せず、認証されたworkspaceと一致する場合だけ操作。tokenはAuthorization header、URL/ログ/backupには含めない。保存するならhash、比較はtimingSafeEqual。tokenなし/誤token/別workspaceのcommit/blob/cursor/result参照をすべて拒否する。

これは同一所有者の端末同期用の最小認証であり、ユーザー登録・招待・メンバー管理・ページACL・Level 5/6ではない。loopback以外の平文HTTPはclient側も拒否。実サーバー公開/TLS/credential配布は別タスク。

## 8. backupと同期identity

backupは全SQLite表を保持するためsync_state/outboxも複製される。復元先が同じclientIdで未送信operationを自動再送すると危険。

client instance binding/tokenはbackup対象外のローカル構成に置く。復元先でbinding不一致ならsyncを停止し、明示再結合で新clientIdを発行。復元内容をremoteへ「現状」として無条件pushしない。remote head取得→相違をconflictとして扱う。旧outboxは診断用に保管し、自動再生しない。ローカルsave_receiptsとrecovery.workspaceIdは他端末から置換しない。remote適用でlocal receiptを削除しない。

## 9. 最小受入テスト

1. A/Bは別ディレクトリ、別SQLite、別clientId。同じserver workspaceへ結合。
2. Aのpage/DB/record/property/view/入れ子block/添付をBで取得し、ID・値・hash一致。
3. ネット切断中のlocal commit→client/server再起動→outbox再開→収束。
4. server commit後ACK消失→同一operationを再送→headは一度だけ進む。
5. 同じoperationIdでpayload違いを拒否。重複pull/古いcursor/順序入替で二重適用なし。
6. A/Bが同じbaseから編集→一方CAS conflict→両snapshotがrestart後も残る。
7. tombstone/子親/record所属/DB trash batchの保存・復元。欠けた親・循環・不正ownerは原子的拒否。
8. blob途中転送/サイズ超過/hash違い/同じID別hashで内容未変更。
9. dirty/IME/raw/unknown barrier拒否、clean適用、古いepochのsave拒否。
10. 別workspace tokenのhead/change/blob/receiptアクセス不可。
11. remote適用中の例外でrollback、適用後cursorのみ未確定等の故障注入。
12. backup復元でauto-syncしない、再binding時clientId変化、旧outbox自動再送なし。
13. 通常非同期workspace・旧版拒否・既存757件等の回帰。

server logの無限保持/大snapshot帯域/同時別ページも競合/保存同期ブロック時間は既知のv1限界として記載。sync専用queueとworker化の最適化は基盤が成立してから。

## 10. 実装分担案

- 親：Storeの原子的dirty hook、version 5/migration/record guards/backup対応、main/preload/Appのbarrier配線、統合回帰。
- sync担当：src/sync/{protocol,server,client,outbox,assets,checkpoint}.ts。Storeに直接手を入れず、下記host接口へ依存。
- 検証担当：2 client＋loopback fixture、通信/故障注入、CLI harness、結果レポート。実GUIは起動しない。

host接口案：`readCheckpoint(): Checkpoint`、`prepareOutbox(): PreparedCommit | null`、`recordAck(envelope, result)`、`retainIncoming(change)`、`withRemoteApplyBarrier(expectedEpoch, apply)`、`applyCheckpointInTransaction(checkpoint, cursor)`、`preserveConflict(local, remote)`、`readAsset(id)/stageAsset(manifest, bytes)`、`getSyncStatus()`。network側はStore.dbの任意SQLに依存せず、テスト用2 clientもこの接口を使う。

最初の実装対象はprotocol/認証server/durable outbox/2 client conflictでよい。ただしassets、tombstone、renderer保護が後続なら、その時点の状態をLevel 4完成と記載しない。

## 11. 今回確定する段階：Store未接続のtransport基盤

親の方針を反映し、**今回の実装対象はprotocol・durable transport journal・loopback HTTP server・隔離テストまで**とする。Store/main/preload/rendererはこのモジュールからimportせず、Folio DBを直接openしない。通常saveとの原子的outbox接続、実content schema検証、v5移行、barrier、復元binding、実Folio snapshot applyは後続の必須条件として残す。独立journalにenqueueできたことを「Folioの全変更を取りこぼしなく捕捉した」と表現しない。

### 最小module契約

```ts
// src/sync/protocol.ts — Node builtinsのみ。外部入力は必ずruntime検証。
type Checkpoint = {
  format: 'folio-content-checkpoint/v1'
  contentSchema: string // 例 fixture/v1。製品schemaはhost実装まで登録しない。
  payload: JsonObject  // 不透明なtransport payload。検証済Folio contentとは呼ばない。
  assets: AssetManifest[]
}
type Commit = {
  protocol: 1
  workspaceId: string
  clientId: string
  operationId: string
  serverEpoch: string
  baseRevision: number
  checkpointHash: string
  checkpoint: Checkpoint
}
// canonicalJson / hashCheckpoint / fingerprintCommit / validateCommit
// strict shape、finite safe整数、depth/size制限、未知field拒否。
// resultにはworkspaceId/clientId/operationId/fingerprint/serverEpochをecho。
// applied/conflictをdiscriminated unionにし、ACK検証なしにcursorを進めない。

// src/sync/journal.ts — 専用SQLite。Folio Storeとは別物。
class SyncTransportJournal {
  // tokenは引数/DBに保存しない。bindingIdはDB外のinstance構成と照合。
  constructor(options: { path: string; workspaceId: string; clientId: string; bindingId: string })
  bindServer(epoch: string): void // 初回のみ。違うepochはfail-closed。
  enqueue(commit: Commit): void // 完全payloadをcommit後に返す。同ID別内容は拒否。
  pending(): Commit[] // serial send用。prepared envelopeの変更APIなし。
  recordResult(result: CommitResult): void // exact key/fingerprint/epoch検証。
  stageChanges(page: ChangePage): void // inbox＋received cursorを同一transaction。
  pendingInbox(): Change[] // remote内容はここで止まる。Storeへ適用しない。
  conflicts(): ConflictRecord[] // losing checkpoint＋server headを保持。
  status(): TransportStatus // received≠applied。製品適用は常に未接続。
  close(): void
}

// src/sync/server.ts — 指定した専用server SQLiteだけ使用。
async function startSyncServer(options: {
  databasePath: string
  capabilities: Array<{ token: string; ownerId: string; workspaceId: string }>
  validateCheckpoint: (checkpoint: Checkpoint) => boolean // 同期predicateのtrueだけ受理。fixture validatorを製品利用しない。
  host?: '127.0.0.1' // 他hostは禁止。portは0をdefault。
  port?: number
}): Promise<{ url: string; close(): Promise<void> }>
```

HTTP契約は認証必須の`head / commits / operations/:clientId/:operationId / changes?after=N`から始める。空のworkspaceはrevision0/headなし。`changes`は昇順・上限件数・連続cursorを返す。HTTP statusだけでACKを判定しない。received cursorより後のgap、違うserver epoch、未登録workspace、異なるfingerprintのreceipt、malformed JSON、oversize、unknown formatは拒否する。同期競合は結果として永続化し、local candidateと競合時のremote headを丸ごと残す。

**添付を今回実装しない場合、assetsが非emptyのcheckpointを明示拒否する**。manifestだけ受けて「添付同期済み」としない。asset対応は第6節のblob検証/権限/存在確認が満たされた段階で解除する。tombstone/parent-child/record整合性はhost validatorを実装するまでfixture対象のみであり、transportのhash一致をその代用にしない。

この段階のテストは、2つの独立journal、永続serverの再起動、ACK消失後の同一operation再送、CAS conflictの双方保存、同ID別body拒否、cursorのrestart/duplicate/gap、binding/epoch拒否、cross-workspace認証、oversize/無効入力を中心とする。実Folio双方向同期、Editor barrier、backup復元連携、旧版拒否、添付転送は別項目でNOT_IMPLEMENTED/NOT_RUNを残す。

実装済みtransport module名は `protocol.ts` / `checkpoint-server.ts` / `transport-journal.ts` / `client.ts`。APIの実際の定義と現段階の制限は製品treeの `docs/SYNC-FOUNDATION.ja.md` を参照する。上記interfaceは設計案であり、Store apply契約は依然未接続。
