# Lv3残件〜Lv6：実装候補と非GUI検証（2026-11-10）

明示Goを受けて、Fable5.2の差分指摘を反映し、integrationへ実装・本体接続・独立レビューを進めた。**Level認定はLv3のまま。full Editorの方式採用はNO_GO。** これはLv6完成の宣言ではない。最終候補の検査数・hash・実行種別は [検証台帳](20261110-lv36-execution-evidence/validation.json) を正本とする。

対象branchは `codex/folio-lv5-collaboration-20261109`、開始HEADは `522665c28747d91bb5f23f007b4037375933b893`。製品変更はintegrationだけ。原本Notion_rea/master、既存artifacts/outputs、実データを変更していない。GUI/Electron/ブラウザ/ネイティブダイアログ/クリップボード起動、push、workflow作成・変更・実行、master merge、課金/global設定変更を行っていない。

Fable相談の根拠は [5.2の判断と採否](20261110-fable52-delta-review.ja.md)、承認範囲は [計画](20261110-lv36-implementation-plan.ja.md)。今回のGo後にFableへの重複相談はしていない。

最終非GUI結果は **306 files / 3,214 tests PASS、型検査PASS、build PASS**。build済みCLIのbootstrap→loopback serve→backup→restore→再openと新token/旧token判定もPASS。C#3部品はMac上のmanaged compilation PASS。B/C比較の1 FAILと、GUI/物理端末NOT_RUNをこの数へ混ぜていない。

## 本体へ接続したもの

`App → SharedWorkbench / 通常Editorの共有分岐 → preload folio.sharedの有界FIFO → main SharedRuntimeService → durable document/resource client → HTTP/TLS provider → SharedAuthority → shared専用SQLite`。

private Store/save/checkpointを共有更新へ流用していない。sharedのauthority/client/resource-client/connection-cacheはDBの役割を固定し、private DBや異なる役割の誤openを拒否する。資格情報はmain所有で、明示的に記憶を選んだときだけ非同期credential portで暗号化する。sender/frame/URL、navigation generation、現在のtoken/user/device/writer、scope/incarnationを確認する。

- 本文の限定編集、別利用者の変更取得、2秒間隔の非編集中refresh、保存状態、未確定照会・原子的封鎖、確定不適用の保全、原本回収を接続。IME合成中は権威intentを送らず、未送信rawをFIFOで端末へ保存する。
- block move/insert/delete、表の行列追加、ページ移動は専用の意味付き操作として接続。派生cell IDはincarnation/table/row/column/種別から決定し、attemptやcommit順を混ぜない。
- 5種類のpropertyを持つ共有DB、fresh scopeでのrecord作成、schema/valueのCAS、本文との共通cutを実authority/service/UIへ接続。空の新規workspaceでも、偽の文書snapshotを作らず最初のページを作成できる。
- 20MBまでの添付stage/publish/read、SHA-256照合、権限再確認を接続。画像のnode viewはshared APIから取得したPNG/JPEG/GIF/WebPのdataを描画し、privateのfolio-assetハンドラーや外部URLへ流さない。描画用URLはDoc JSONに書き戻さない。
- 選択した個人の通常ページだけを読み取り、ID/link/添付を検証・再割当するcopy previewとcommitを接続。preview中は送信しない。commit時に選択原本を再照合し、複数ページ・階層・blob・lifecycle/historyを同一transaction/cutで確定する。初版はintent全体の約850KB上限。record/DB copyと大きなcopyは拒否し、個人原本を保持する。
- 現在権限による検索/backlinks/文書exportと、明示的な履歴を接続。ゴミ箱と旧incarnationは通常投影から除外する。
- 組織管理とworkspace権限を分離。招待/参加、workspace作成、grant、退会失効、引継ぎ、復旧キー再発行、監査・容量・検証済みbackup一覧を接続。組織管理者であるだけでprivate workspace本文を読めるとはしない。
- backupの大容量HTTP経路と、専用main exportを接続。出力は新規file限定で、private/shared rootへの出力や既存file上書きを拒否する。保存後の不確定はUNKNOWNのまま原本を残す。運用者用のNode server入口と復元経路は [運用仕様](20261110-shared-runtime-operator.ja.md) を参照。

## Fable5.2の不変条件と修正

intentとattemptのimmutable bytes/fingerprintを分け、同一意図を二重適用しない。送信前にraw/attempt/UNKNOWNを永続化し、receipt不在だけでは不適用と見なさない。新たな試行は確定拒否または原子的invalidateの証明が必要。別文書・再接続・末尾slashのURL表記差で未確定outboxを迂回しない。

log/head/receipt、構造metadata、DB body/value、認可変更を同じSQL transactionへ置く。epoch/seq/prefix hashに加え、現在の文書・role・identity・receipt/dedup・Undo witness・公開blobのrootをcommitへbindした。hash循環の正規化は「現在commitの既知のcut pointer」だけ。immutable baseと過去cutのhashを消さず、pointerとprefixも照合する。rootedでない旧候補を黙って新形式へ昇格しない。

復元は元のlog/receiptを保存し、新epoch/genesisへbackup hashをbindする。古いsession/device/recovery keyを再活性化しない。現在の正当な運用者を新しいrealmへ認可し直し、新しいキーを生成する。引継ぎ後の古いrole cacheや招待によるowner復活、退会後tokenの利用、古いretention facadeの利用を拒否した。古いbackupの作成後に加入した現ownerが復元する経路も確認した。

保持処理は実exportと実隔離restoreの証明を使い、対象writerがdurably fencedの場合だけprefixをcheckpointへ移す。headが進んでも検証済みprefixとsuffixを照合し、receipt/intent/attempt/Undo/必要prefixを残す。容量は有限で、無制限保持や停電時RPO0を保証しない。

## 独立レビューとoracleの扱い

実装workerは専有コピーの所有fileだけを編集し、親が差分・入力hash・接続先・試験を確認した。workerの終了0、自己申告、テスト作成だけをPASSと扱っていない。読み取りレビュー、反例作成、親の統合修正、再実行を分けた。

主な修正は、構造metadata/column IDの衝突、実namespaceとの不一致、lifecycle bypass、共有/個人DB誤open、queue容量とreceipt予約、失効・引継ぎ・復旧キー、復元先operatorのidentity key、backup file readback、大きなbase64の検証、sender待ち中の接続活性化、rootの正規化範囲、通常投影へのゴミ箱混入である。

oracleの訂正・失効も [レビュー台帳](20261110-lv36-execution-evidence/review-triage.json) に記録する。

- R03のcolumn identityはDoc attrsではなく原子的table metadataで検証する。Doc全体のID一意性と、両順序の合法な行列追加成功は維持した。
- 不正なroot attrs、IDのない段落、sync APIへのPromise拒否期待、ReceiptをSnapshotとするfixtureなどを実契約へ訂正。rawのlossless拒否を緩めていない。
- copy後に旧block IDで本文を探すfixture、別directoryを再openするtamper fixture、capabilityを省いたHTTP spyを訂正し、実コピー先/実DB/実endpointで再実行した。
- 送信後にsenderが失効した場合、承認済みのremote commitを巻き戻せるというoracleは採らない。旧frameへの応答を拒否し、旧writerのdurable receipt/UNKNOWNを保全する。送信前・接続活性化前の失効は副作用を防ぐ。再送しないことと、別世代へ結果を混入しないことを検証する。

## 方式判定とR01〜14

| gate | 今回の非GUI根拠 | 判定境界 |
|---|---|---|
| R01 identity/seed | 実schema、ID衝突、二重seed、raw拒否 | 限定範囲PASS |
| R02 move/edit | 最新blockのKEEP/mark/ID保全、両順序、delete conflict | 新意味付き候補の限定正常系PASS。full採用とは別 |
| R03 row/column | 両順序の合法な3×3、交差ID/内容、metadata共通cut | 限定正常系PASS |
| R04 own Undo | root text/表の削除証明、他者保持。B/C実bindingの独立比較 | **Cの本文＋構造混在UndoがFAIL** |
| R05 crash/ACK | 実SQLite/HTTP、ACK喪失、所有Nodeをcommit前/後でSIGKILL | shared runtimeの非GUI PASS。B/C binding再起動の全面採用gateは未達。停電/物理機ではない |
| R06 private隔離 | private/shared format/役割/backup誤open、既存private全体回帰 | 非GUI PASS |
| R07 DB複合cut | fresh record、schema/value CAS、body/lifecycle、拒否rollback | 非GUI PASS、5 property型の初版 |
| R08 incarnation | trash/restore、新incarnation、旧scope拒否・原本保持 | 非GUI PASS。全UI導線の完成とは別 |
| R09 失効 | receipt/asset/projection/backup/retention、roleとtokenの現在認可 | 非GUI PASS |
| R10 旧backup | 根拠hash、新epoch、旧資格失効、現owner再認可、元receipt保持 | 非GUI PASS |
| R11 compaction | 実backup+restore証明、writer fence、checkpoint/suffix、offline原文 | 非GUI PASS。有限容量/性能の運用保証は未確定 |
| R12 copy | 選択外本文の不送信、原本再照合、ID/link/blobと共通cut | 初版上限内PASS。DB/record copyは未対応 |
| R13 writer/navigation | deviceとwriter分離、世代/IPC FIFO/遅延結果/再接続 | 非GUI PASS。実window操作はNOT_RUN |
| R14 composition | 合成draft/FIFO/main、compose中の非送信、終了後確定 | Node合成PASS。実IMEはNOT_RUN |

新B/C比較は36件中35 PASS、1 FAIL。Cの `R04 mixed text and structure undo follows the author's reverse operation order` が `Aabc` を残す。旧baseline48件のPASSには旧反例の再現も含み、方式合格へ読み替えない。Bにもfull transport/restart/history/全node・markを本体へ統合した証拠は揃っていない。したがって**full Editor採用はNO_GO**。通常Editorには限定本文seamと専用意味付き操作を接続し、排他leaseへ黙って代替していない。

## Windowsと保留事項

Windows path/SID/DACL/reparse/hardlink/volume/File IDのport、native probe、Job Objectによる所有process停止、専用candidate root作成、helper hash pin、SQLite adapter、x64/arm64 package計画・native build scriptを実装した。実compiled probeをRuntimeStoreへ接続するcandidate loaderも存在する。Mac上でC#3部品のmanaged compilationとTSの注入contractを検査した。

**Windows OS上の実行・DPAPI・ACL/NTFS/sharing violation・Job Object回収・packaged起動・署名はNOT_RUN。** 注入portや同一Macの複数processをWindows実機・物理複数台と呼ばない。既存private ledger/vault/watchdogをWindows desktopへ全面接続したわけではなく、該当入口はfail closedのまま。Windowsは専用shared runtime/candidateまでである。namespace publication/停電耐性も未実証。package自体は実行していない。

GUI待ちと区別するコード上の保留は、full B/C Editorのmixed Undo/Redo・mark/inline/構造履歴・durable transport統合、DB/record copy、大きなcopy、旧writerの全原本を新しい認証世代へ移すUI、運用upgradeの実migration runner、添付GC/保持操作の運用入口、Windows private本体の全面移植である。原本・未知結果を残して停止する。初版の有限容量とSLO/RPO/RTOの実運用値は保証していない。

Mac実Keychain/IME/picker/Dock/終了、同じ候補のGUI・物理Mac A/B+S、Windows A/B+独立serverはすべてNOT_RUN。認定Lv3を変更しない。禁止操作も引き続き行っていない。

## モデルと証拠

有料OpenCode Go `opencode-go/deepseek-v4.1-flash` を並列使用。実際の枯渇時に `opencode/deepseek-v4.1-flash-free` へ切り替える設定を用意したが、全82 dispatchの終了まで枯渇は検出していない。実CLI重複の最大は15本。請求額や残quotaを推測しない。

CLIごとのmodel、output cap、入力/出力/推論/cache数値、finish reason、timeout/無成果物、再投入と実同時数は [dispatch台帳](20261110-lv36-execution-evidence/dispatch.json)。同時数はCLI processの重なりで、backend同時推論数ではない。巨大な思考本文・生session・秘密をrepoへ入れない。親による統合後のfile hashは [候補manifest](20261110-lv36-execution-evidence/source-manifest.json)。全体非GUI試験・型検査・build・方式比較・C# compilationを別々に記録する。
