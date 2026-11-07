# Folio Lv4（同一所有者・複数端末同期）到達計画

**前提**：この作業ではソースを読んだだけです。テスト、ビルド、GUIはどれも実行していません。

- 文中の「既存試験」は、テストコードがあることを指します。もう一つの根拠は `PLANNING-CONTEXT.md` に記録された前回の非GUI実行です（130ファイル／1284件、build合格）。どちらも今回の合格判定ではありません。
- GUI/E2Eは NOT_RUN です。Lv4は未到達です（`docs/LEVEL3-STATUS.json` は db7bf1a の時点で `"level4":"NOT_REACHED"`）。
- 今回の基準は e269137 に、未コミットのDnD・ゴミ箱・復元・並び順修復の草案を加えたものです。

## 1. 現状診断

### 1.1 すでにあるもの（コードで確認）

| 機能 | 実装の場所 | 既存試験（今回は未実行） |
|---|---|---|
| 製品の入口（起動時に1回、環境変数でopt-in） | `src/main/index.ts:141-145` で、窓を作る423行より前に `runStartupWorkspaceSync` を呼ぶ。`FOLIO_SYNC_ENABLED=1` と `FOLIO_DATA_DIR` が両方必要（`workspace-sync-startup.ts:12-14`）。往復は最大8回（同65-74） | `sync-workspace-startup.test.ts:30` |
| 保存と送信世代の原子性 | 内容表・settings・save_receipts のトリガー（`workspace-checkpoint.ts:1186-1218`）。v5への昇格は検証済みバックアップの後に1トランザクションで行う（`workspace-store.ts:260-316`） | store test「explicit version-5 promotion」群 |
| 不変envelope、ACK喪失、再送 | `prepare`（`workspace-store.ts:387-423`）、送信前のreceipt照会（`workspace-sync.ts:210-225`）、自端末echoの照合（`workspace-store.ts:575-625`） | level4「recovers from an ACK lost strictly after the server committed」 |
| 受信と適用の分離 | inboxとcursorを同じトランザクションで更新（`workspace-store.ts:506-573`）。dirty・競合・pending の間は適用しない（`workspace-sync.ts:146-162, 234-271`） | 「defers remote apply while canApply is false…」 |
| workspace単位のCASと両版保持 | サーバー側 `checkpoint-server.ts:477-521`、端末側 conflicts/archives（`workspace-store.ts:478-502, 694-843`）。local選択ではremote側の追加を落とせない（同710-715） | 「preserves both conflict snapshots across reopen…」 |
| 削除と復元 | tombstoneのみ。前の版にあったPage・添付・所属が欠けると拒否する（`workspace-checkpoint.ts:970-1034`）。src内に物理削除の経路は無い | DB tombstone試験、添付の trash/restore 試験 |
| 添付 | SHA-256経路、1 MiBチャンク単位の再開、検証後に排他hard linkで公開（`workspace-blobs.ts:9-34, 1512-1557`）、上限20,000,000 B | `sync-workspace-blobs*.test.ts` |
| 復元後の再登録 | binding sidecarがDBのinodeとvolumeに結び付く（`workspace-binding.ts:22-77`）。`recover` には新しいclient/bindingが必要で、旧キューは退避する（`workspace-store.ts:321-364`） | startup test 156-232行 |
| 旧版の書込み拒否 | v5の `user_version` と `folio_sync_v5_write` ガード | startup test 99-116行、「inherited v4 Store binary refuses…」 |
| 端末認証と失効 | device token のhash照合、失効は永続（`checkpoint-server.ts:93-94, 307-359`） | `sync-device-auth.test.ts`、「stops a revoked device…」 |

注意点が2つあります。

- `tests/sync-level4.test.ts` は `openWorkspaceSync` を子プロセスから直接動かします（1-11行）。Electron、IPC、rendererは通りません。
- `sync-level4-transport.test.ts` は冒頭で「does not claim product sync」と明記した、旧transport journalの試験です。

### 1.2 本当に足りないもの

1. **アプリ稼働中の同期が無い。**
   - 同期は起動時の1回だけで、`WorkspaceSync` は保持されません。終了時にも同期しません（`index.ts:432-433`）。
   - そのため、Aでの編集はAを次に起動するまで送信されません。
   - IPCに同期要求が無く、preloadには `request` しかありません（`preload/index.ts:3-5`）。
2. **適用境界が起動時の前提でしか作られていない。**
   - `canApply` が見ているのは crash-recovery.json だけです（`workspace-sync-startup.ts:25-33`、`shared/crash-recovery.ts:35-38`）。
   - 稼働中のIME、入力途中の数値、unknown save、未確定作成、構造操作はrenderer側で判定しています（`App.tsx:971` のunload判定、`1486-1491`）。mainからは見えません。
   - `writeEpoch/assertWritable`（`workspace-sync.ts:138-144`）は製品では使われていません。試験でも直接呼んでいるだけです（level4 test 795-812行）。
3. **容量が足りない。**
   - checkpointは全内容表と版履歴の全量で、上限は1 MiBです（`protocol.ts:5`、`workspace-checkpoint.ts:23-35`）。
   - 版はdoc/titleを保存するたびに作られ、1ページ100件まで残ります（`store.ts:707-710, 969`）。よく編集するページが1つあれば上限に届き得ます。
   - 受信は1回1件です（`protocol.ts:8`、`checkpoint-server.ts:628-633`）。
   - 端末inboxは全revisionを恒久保持します（schema検査が `count===receivedCursor` を要求、`workspace-checkpoint.ts:1346-1351`）。サーバーもchangeとoperationの全量を残します（537-567）。
   - 1件適用するたびに、添付を含む完全バックアップを作ります（`workspace-sync.ts:258`、`full-backup-create.ts:260-264`）。
4. **起動時間と排他。**
   - 通信、添付取得、完全バックアップがすべて、窓を出す前のmainで同期実行されます。要求1回のタイムアウトは5秒です（`client.ts:32`）。
   - 排他はインスタンス内の `running` フラグだけです（`workspace-sync.ts:197-208`）。
5. **UIと運用が無い。**
   - 設定、端末登録、競合選択はすべて環境変数で行います（`FOLIO_SYNC_CONFLICT_*`）。表示はヘッダーの文字列1つです（`App.tsx:1781`）。
   - tokenも環境変数で渡します。サーバーはライブラリだけで、CLI、バックアップ、epoch更新の手順がありません。
   - クライアントとblobはloopback限定です（`client.ts:29`、`workspace-blobs.ts:535`）。別端末から使うにはトンネルが要ります（`SYNC-WORKSPACE-EXPERIMENT.ja.md:35`）。
6. **競合解決が実用的でない。**
   - remote側でページが増えているとlocal選択は拒否されます。そのため別ページを同時に編集しても、実質remoteを採るしかありません。
   - 自端末側の版は archives に入りますが、取り出すUIがありません。
7. **1件で全体が止まる。** 未知フィールドを持つPage（`workspace-checkpoint.ts:481-501`）や、読めない登録DB・record（742-745, 773-776）が1件でもあると、送信全体が止まります。
8. **故障注入に空白がある。**
   - SIGKILLを試しているのは「保存後・同期前」だけです（level4 test 858-881行）。
   - 送信直後、staging中、バックアップ後で適用前、製品経路での添付中断は試していません。
   - Changeに前版のhashが無いため、同じepochのままサーバーを巻き戻すと分岐を検出できません。

### 1.3 旧文書と現コードの相違

| 旧文書の記述 | 現コード |
|---|---|
| `SYNC-FOUNDATION.ja.md:1,5,35-43`「未接続」「添付・v5・再binding未実装」 | checkpoint、blobs、rebindは実装済み。起動時の入口にopt-inで接続済み。ただしIME等の境界は、稼働中については今も未実装 |
| `QUIET-HANDOFF.ja.md:17,40`、`QUIET-IMPLEMENTATION.ja.md:20`「未接続」 | 起動時の経路は接続済み |
| `SYNC-DESIGN.ja.md:70-82` のnonce quiesce | 製品には無い。同15行が示す `store.ts:725` は、現在の `commitSave` では802行（行がずれている） |
| `GUI-VALIDATION-QUEUE.ja.md:62`「並び順修復はGUI未接続」 | 草案で `index.ts:248-249`、`App.tsx:2813-2822` に接続済み（GUIはNOT_RUN） |

現状の説明として最も近いのは `SYNC-WORKSPACE-EXPERIMENT.ja.md` です。

### 1.4 DnD・ゴミ箱・復元・並び順修復の草案が同期に与える影響

- **保存の原子性**：`patchPageMetadata`（`store.ts:1056`）は `json_set` で直接更新します。同じトランザクションの中でトリガーが世代を上げるので、原子性は保たれます。これはコードを読んだ上での判断です。
- **差分量**：moveが兄弟全件の再採番から1件だけの更新になったので、差分は減ります。
- **並び順修復と競合**：並び順修復はPageを大量に書き換えるので、他端末とほぼ確実にworkspace競合を起こします。
- **重複の伝播**：検証器は兄弟positionの重複を拒否しません。旧版端末が作った重複は同期で伝わり、草案のmove（1078行〜）がそれを拒否するため、相手端末で操作できなくなります。
- **ファイルの衝突**：草案と同期作業は index.ts、App.tsx、types.ts を共有します。
- **揃えるべき基準版**：草案をコミットしてLv3を再確認した版です。両端末をこの版にし、publishの前に並び順修復を済ませてください。

## 2. Lv4の範囲と合格条件

**範囲**：所有者1人、macOS 2台（`scripts/package.mjs:31-32` はdarwin/arm64のみ）、自分で運用するサーバー1台、接続はloopbackと認証済みトンネル。CRDT、共有、権限、共同編集は対象外です。

**利用シナリオ**

- **S1**：iMacで編集したあとMacBookを起動すると反映される。MacBookでの編集はアプリ稼働中に送信され、iMacは「再起動して適用」1回で反映される。
- **S2**：両方がオフラインで編集し、再接続で競合する。両版が残り、選択でき、選ばなかった側を取り出せる。
- **S3**：15 MBの添付の取得が中断し、再開できる。
- **S4**：Aで削除し、Bで復元すると、Aにも反映される。
- **S5**：完全バックアップから復元し、新端末として再登録すると、差分は競合候補になる。
- **S6**：旧版の端末からの書込みは拒否され、更新を促される。
- **S7**：IME変換中や数値の入力途中に変更が届いても、入力を保持するまで適用しない。

**Gate**（テスト件数だけでは認定しない）

| Gate | 合格条件 |
|---|---|
| G0 | 基準版でLv3を再確認する（非GUI3段とGUI batch） |
| G1 | 環境変数なしで、アプリ内からpublish/join/recover/切断ができる。tokenはKeychainに置き、ログ・バックアップ・環境変数に出ない |
| G2 | 本文、階層と並び、DB/record/値、削除と復元、D2で決めた範囲の履歴が双方向で届く。ID・revision・hashが一致する。送信元の再起動は不要 |
| G3 | 7種の未確定状態のどれかがあれば適用せず、入力を保持する。Undoが旧内容に戻らない。旧rendererの書込みが新内容に届かない |
| G4 | ACK喪失、各段階でのSIGKILL、サーバー再起動、オフライン復帰のどれでも、重複も欠落も出ない |
| G5 | 競合の両版が再起動後も残る。UIで選択でき、選ばなかった側を取り出せる |
| G6 | 添付の上限、製品経路での中断再開、hash不一致の拒否が働く。容量で拒否したときは状態が変わらない |
| G7 | 復元先は自動同期しない。新しいclientIdになる。旧outboxを再送しない。失効した端末は止まる。サーバーの巻き戻しを検出する |
| G8 | D3で決めた規模で同期できる。端末側の表・サーバー履歴・バックアップが保持上限内に収まる。窓を出すまでの時間とmainの最大ブロック時間が予算内 |
| G9 | 保守操作や2重起動と干渉しない。旧Store、旧protocol、旧checkpoint版からの書込みを拒否する |
| G10 | 状態（未送信・受信済み・適用待ち・競合・エラーコード・最終成功時刻）が表示される。サーバーCLIで登録・失効・バックアップ・epoch更新ができる |
| G11 | 物理Mac 2台と実トンネルで、スリープ復帰と回線切替を含めてS1〜S7が通る |

## 3. 採る設計

### 3.1 データ方式

| 案 | 内容 | 容量 | 競合の粒度 | 主な危険 |
|---|---|---|---|---|
| **A 最小** | v1の全量checkpointを維持する。上限と履歴を含める範囲を計測で決め、head起点のbootstrapと保持上限を加える | 保存ごとに全量を送る | workspace単位 | 大きいworkspaceでmainが止まる、転送量が多い |
| **B 差分化** | 論理的には全量snapshotのまま、行単位の内容アドレスchunkとmanifestで送受信・保存する。検証は再構成した全量に既存の検証器を使う | 変化分だけ | 同じ | protocolと端末schemaのv2移行 |
| **C 細粒度化** | applied版を基準にした3-way行merge。結果は既存検証器で検査し、失敗したら全体競合に戻す | Bと組み合わせる | 行単位 | 階層・並び・trash batch・所属のような行をまたぐ不変条件を壊す |

**推奨**：Aを採り、計測ゲート（T2）を置きます。

- 保存ごとに版が増え、1ページ100件まで残るので、Bが必要になる見込みは高いと考えます。ただし切り替えは数値を見てから決めます。
- Cは、実際の運用で競合の頻度が問題になったときだけ扱います。CRDTはLv5側です。

### 3.2 適用方式

| 方式 | 内容 | 評価 |
|---|---|---|
| **R1 再起動適用（推奨）** | 稼働中は送信と受信staging（inboxと、検証済みの添付を別領域へ）だけを行い、内容表は変えない。適用は既存の窓作成前の経路で、通信なしに行う。旧rendererはプロセスごと終わる。IME、unknown save、Undo、遅延書込みは、既存のunload判定（`App.tsx:971`）とcrash-recovery判定で守られる | 新しい安全不変条件が最も少ない。local選択は内容表を変えないので、稼働中に送ってよい（`workspace-sync.ts:175-179` を緩める）。remote選択は再起動で行う |
| **R2 reload適用** | preloadで文書ごとのnonceを付け、変更系の全IPC（草案のpageOrderを含む）でepochを照合し、quiesce ACKを取る | 使い勝手は良いが、新しい不変条件が多い。Lv4の後に回す |

### 3.3 手動同期とバックグラウンド同期の順序

1. 手動の「今すぐ同期」（送信と受信staging）と「再起動して適用」
2. 保存後の自動送信（デバウンスし、オフライン時はoutboxに保持）
3. 定期的な受信stagingと通知
4. （後続）アイドル時にR2で自動適用

原則は「送受信は自動、適用は利用者の操作で」です。

### 3.4 Mac 2台とWindows

Mac 2台を本線にし、Windowsは別分岐として後で受け入れます。ソースにはWindows対応を示す根拠がなく、逆に次の依存があります。

- パッケージがdarwin専用
- ディレクトリfsyncを `openSync(dir,"r")` で行っている（`durable-file.ts:24`）
- bindingがinode/nlinkの意味に依存している（`workspace-binding.ts:28-41`）
- 添付の公開にhard linkを使う（`workspace-blobs.ts:783`）

Windows分岐のGateは次の3つにします：W1 ビルドと耐久書込み、W2 添付公開とbinding、W3 実機での同期と復元。

## 4. 実装順（依存順）

| 段階 | 変更対象 | 成果物 | 実装前に書く失敗テスト | 終了条件 |
|---|---|---|---|---|
| **0 基準固定** | 草案の14ファイル | コミットしたhash（利用者の承認後）、非GUI3段のログ | — | check/test/build合格。GUIはNOT_RUNと記録 |
| **1 計測と判断** | 計測スクリプト（一時ディレクトリで実行）、判断記録 | 規模ごとのbytes/ms表、D1〜D9の承認 | 「目標規模のcheckpointが上限内に収まる」 | 案AかBかが決まる |
| **2 受信と適用の分離** | `workspace-sync.ts`、`workspace-store.ts`、startup | `stageRemote`/`applyStaged`、最新版の一括適用 | §7のT4テスト | 起動時に通信が要らない。バックアップは1回 |
| **3 main常駐サービス** | 新 `src/main/workspace-sync-service.ts`、index、types、write-policy、read-only | `sync:status`/`sync:now`、staging領域、保守操作との排他 | 「同時要求は1本にまとまる」「read-onlyでは無効」「staged添付は孤児整理やバックアップの対象にならない」 | 窓を出した後に送受信する。内容表は変えない |
| **4 再起動適用** | startup、index、意図の保存先 | 競合選択などの意図を永続化、relaunch、環境変数の撤去 | 「未保存入力があれば起動時も保留し、意図を保持する」「relaunchが中断されたら何も変わらない」 | env不要で再起動適用できる |
| **5 容量制御** | store・checkpointのschema v2、server、（Bの場合）protocol | bootstrap、保持K件、バックアップの保持数 | 「inboxの行数が上限内」「切り詰めたcursorならbootstrapする」「v1 binaryはv2を拒否する」 | G8の数値を満たす |
| **6 資格情報・運用・故障注入** | credentials、server CLI、level4 tests | Keychain、CLI、版互換、各段階のSIGKILL・添付中断・巻き戻し試験 | 「旧protocolの書込みをサーバーが拒否する」 | G1、G4、G7、G9、G10の非GUI分 |
| **7 UIと受入** | App、Sync/Conflictパネル、E2E spec | 状態表示、今すぐ同期、適用、競合、取り出し | 状態reducerの単体試験 | GUIと実機は許可を得てから |

## 5. タスク表（規模は相対値）

| ID | 優先 | 前提 | 内容／主な対象 | 受入条件 | 規模 |
|---|---|---|---|---|---|
| T1 | P0 | — | 草案コミットで基準を固定。`GUI-VALIDATION-QUEUE.ja.md` を更新 | hashと非GUI合格ログがある。GUIはNOT_RUN | S |
| T2 | P0 | T1 | 容量計測（Store APIで合成した一時workspaceを使う） | checkpoint、build/validate/apply、バックアップのbytes/msが分かる。実データを使わない | S–M |
| T3 | P0 | T2 | 判断記録D1〜D9、旧文書に現状の注記 | 利用者が承認する | S |
| T4 | P0 | T1 | 受信と適用の分離、最新版の一括適用（§7） | 新しい試験と既存のsync試験が合格 | M |
| T5 | P0 | T4 | main常駐SyncService（送信と受信のみ）とIPC | 窓表示後に動く。内容表を変えない。同時実行は409 | M |
| T6 | P0 | T5 | `sync-staging/` を分離し、適用時に検証して公開 | 孤児整理とバックアップの対象外 | M |
| T7 | P0 | T4, T5 | 再起動適用、意図の永続化、local選択は稼働中に送信 | 環境変数不要。未保存入力があれば保留 | M |
| T8 | P1 | T2, T4 | bootstrap、端末とサーバーの保持K件、適用前バックアップの保持数（sync schema v2） | 増加量が有界。移行はバックアップ後に原子的に行い、旧binaryは拒否する | L |
| T9 | P1（条件付き） | T2, T8 | B：内容アドレスchunk、protocol v2、前版hash | Aが不合格だったときだけ行う。論理検証は変えない | L |
| T10 | P1 | T5 | safeStorageのアダプター、プロファイル内の設定、join/recover手順 | tokenが環境・ログ・バックアップに出ない | M |
| T11 | P1 | T8 | サーバーCLI（init/serve/register/revoke/backup/rotate-epoch）、最小版の強制 | 旧版の書込みを拒否する試験がある | M |
| T12 | P1 | T5–T8 | 製品経路の故障注入（送信後・staging中・バックアップ後のSIGKILL、添付中断、巻き戻し） | 収束し、重複も欠落も無い | M |
| T13 | P1 | T5–T7, T10 | UI（状態、今すぐ同期、適用、設定、競合と取り出し）とE2E spec | 非GUI単体が合格。GUIはNOT_RUN | L |
| T14 | P2 | T13 | GUI batch、実機2台、Windows分岐の手順と証拠の様式 | 結果はPASS/FAIL/NOT_RUNのみで記録 | S |

取り出しUIでは、既存の `crash-recovery-copy.ts` を再利用できる可能性があります。ただし、使えるかどうかはまだ確認していません。

## 6. 検証の区分

- **今すぐ非GUIで進められるもの**：T2〜T12のNode・子プロセス・loopback試験、`npm run check`、`npm test`、`npm run build`、`npm run verify:quiet`。`npm run test:e2e -- --list` は一覧を見るだけで、動作確認にはなりません。
- **後日、明示的な許可が要るGUI試験**：
  - G0のLv3回帰
  - 草案の `page-move.spec.ts` と `page-order-repair.spec.ts`
  - 同期の設定、状態表示、今すぐ同期、再起動して適用（unload判定・IME・数値入力中を含む）、競合、取り出し、添付の表示

  入口は `npm run test:e2e:batch` です。専用の一時 `FOLIO_DATA_DIR` と、試験が持つloopbackサーバーを使います。relaunchをE2Eでどう扱うかは、まだ設計が要ります。
- **実端末2台・外部接続（別の許可が要る）**：サーバー設置、SSHトンネル、S1〜S7、スリープと回線切替、低速回線での添付、失効、復元と再登録、版の不一致。Windowsはさらに別の許可が要ります。証拠は秘密を含まない状態ダンプで残します。

## 7. リスク、先に固定する判断、最初の実装単位

**主なリスク**

| # | リスク | 対策 |
|---|---|---|
| 1 | 1 MiBを超えると全体が止まる | T2の計測とB |
| 2 | 1件適用するたびに完全バックアップを作り、容量不足で止まる | D6、T4 |
| 3 | 競合時に実質remoteしか選べず、自端末の版が埋もれる | 取り出しUI（T13） |
| 4 | 未知フィールドを持つPageが1件あると全体が止まる | 状態表示と修復の導線 |
| 5 | 並び順の重複が伝播し、草案と同期作業が衝突する | T1、D8 |
| 6 | 同じepochのままサーバーを巻き戻すと黙って分岐する | rotate-epochの義務化、前版hash |
| 7 | schema v2移行に失敗するとv5 DBが開けなくなる | バックアップを先に取り、原子的に移行する |
| 8 | 待機中のrelaunch登録が、終了を取り消した後の次回終了で起動を引き起こす | `will-quit` が確定してから登録する |
| 9 | tokenが漏れる | Keychainに置く |

**先に固定する判断**

| # | 判断事項 | 推奨 |
|---|---|---|
| D1 | 適用方式 | R1（再起動適用） |
| D2 | データ方式と、履歴を同期対象に含めるか | A/BをT2の数値で決める |
| D3 | 目標規模 | 例：Page 500、平均8 KB、版のあるページ20×100、添付300 MB。利用者が決める |
| D4 | 接続 | loopbackとSSHの局所転送 |
| D5 | 資格情報 | safeStorageと、バックアップ対象外の設定 |
| D6 | 適用前バックアップ | 適用する起動ごとに1回、保持数に上限 |
| D7 | サーバー履歴 | 直近K件とbootstrap、epochの運用 |
| D8 | 基準版と並び順 | 基準版で揃える。新しく生じた重複を拒否するか |
| D9 | 版互換 | protocol・checkpoint・schemaの最小版をサーバーで強制 |

**最初の実装単位**：T4「受信と適用の分離、最新checkpointの一括適用」です。

- 対象は `src/sync/workspace-sync.ts`、`workspace-store.ts`、`src/main/workspace-sync-startup.ts` です。
- 先に書く失敗テストは次の5つです。
  1. foreign revisionが3件stagedのとき、最新版だけを適用し、before-apply backupは1回だけ作る
  2. `stageRemote` は、`canApply=true` でも内容表と `applied_revision` を変えない
  3. `applyStaged` はサーバーが止まっていても成功する
  4. echo照合を一括適用より先に行う
  5. バックアップ後・適用前にSIGKILLしても、再起動後に同じ結果へ収束する
- これを最初にする理由：R1にもR2にも、AにもBにも共通です。適用ごとのバックアップと「起動8回分」の追いつき制限をなくせます。Node単体で検証できます。

**未実施のもの**：GUI、実機2台、Windows、そして今回のすべての試験（NOT_RUN）。ソース、設定、テスト、文書には一切変更を加えていません。
