# Lv3残件〜Lv6：DeepSeek担当/依存計画

2026-11-10 JST。**全担当UNASSIGNED / NOT_STARTED。** この文書は実装workerの起動でも実行用runnerでもない。利用者への計画報告後、明示Goサインを受けてからpacket化/投入する。

有料model固定: `opencode-go/deepseek-v4.1-flash`。親Codexが共通契約・oracle・authority transaction coordinator・main/preload・既存App/Editor・central config/lockの変更と最終統合を所有する。以下のpathは新規専有先の案で、既存同名file/適用AGENTS/依存をGo後に確認し、個別の正確なallowlistへ固定する。workerはshell/git/network/GUI/再委譲を行わず、一時コピー内の許可file toolのみ。追加workerのための設定変更・起動はGo前に行わない。

[Fable5.2差分判断](20261110-fable52-delta-review.ja.md)のW0追加条件と出口判定もpacketへ含める。現在は全担当未投入のまま。

## W0で親が先に渡す契約

- intentId/intentFingerprint、attemptId/attemptFingerprint、不変raw、現在の認証context、editorWriterId、scope/lifecycle/cut、receipt/拒否/UNKNOWNと再試行可能条件。
- authorityの唯一のcommit_seqとepoch/prefix-chain hash、workspace cut/document versionの派生関係、org失効/role/lifecycleの同一transaction、helperのtransaction context。
- block内anchorとsplit/join/delete、行/列/cell identity、実体化側のintent/attempt/commit順に依存しない派生ID、構造metadata+stepの原子確定、commandと保存済み実行結果の確認/Undo。
- 再attemptのための未適用証明（永続確定拒否または照会と原子的な旧attempt封鎖）、attempt/intent状態の区別、serverでの正当な実体化検証、writer fence/backup証拠とdedup保持。
- canonical JSON/fingerprint/Unicode/unsafe integerとraw境界のgolden vectors。private形式は不変、draft quarantineをauthoritative queueへ読み替えない。
- R01〜14の必須正常系・許容拒否・禁止結果。oracle/fixture採点器は親が固定し、adapter実装者は書き換えない。
- platform capability、認証bootstrap/招待/復旧、組織/space責任者、保存/復旧UIの操作契約。

## 担当候補

すべて合成データ、実schema/型を用いる。実装担当と独立review担当を分け、同じfileへ同時に書かない。

| ID | 一貫した担当単位 | 専有path案 | 開始依存 | 正常/障害の採用条件 |
|---|---|---|---|---|
| D01 | block move/delete/copyの意味付きcommand | `src/collaboration/semantics/block-commands.ts`＋専用試験 | W0 | 最新block内容を保持、move/edit・二重move・nested/cycle/delete、拒否intent回収 |
| D02 | 表row/column/cellと合法形 | `src/collaboration/semantics/table-commands.ts`＋専用試験 | W0 | 同時row+column双方の追加成功、交差cell一意ID、既存cell本文/ID/mark保持、削除/旧cut |
| D03 | pending本文anchor/再具体化 | `src/collaboration/semantics/text-intent.ts`＋専用試験 | W0 | move/split/join/deleteをまたぐoffset/mark/依存suffix、UNKNOWN時新attempt禁止、字句期待結果 |
| D04 | 自分のUndo/Redoと操作単位 | `src/collaboration/semantics/local-history.ts`＋専用試験 | W0、D01〜03の固定API | remoteを巻戻さずslash/構造/表/typingの境界、他者が触れた逆操作の回収 |
| D05 | B実binding＋構造command adapter | `experiments/collaboration-comparison/next/b/` | W0、D01〜03契約、D07/08最小cut | 同じoracleでR01〜05最小形。新binding置換が必要なら既存Bの完成と呼ばず設計差分を報告 |
| D06 | C collab/history＋構造command adapter | `experiments/collaboration-comparison/next/c/` | W0、D01〜03契約、D07/08最小cut | R01〜05最小形、own-step確認とcommand結果対応、再base意図保持。独自汎用OTを作らない |
| D07 | clientのdurable intent/outbox/receipt/restart | `src/collaboration/client/durable-queue.ts`等＋専用試験 | W0 | 原文/試行/receipt原子対応、UNKNOWN query-first、破損/容量/再起動、確定拒否と回収 |
| D08 | shared server永続化・復元検査helper | `src/collaboration/server/storage.ts`等＋専用試験 | W0 | format/header/sidecar/旧writer拒否、intent重複/receipt、単一transaction参加、実SQLite。COMMIT coordinatorは親 |
| D09 | user/device credential・登録・招待 | `src/collaboration/server/identity/` | W0 identity契約 | 永続userとdevice分離、bootstrap/招待一回性/期限/取消、盗用/失効、最後のdevice喪失時の回復 |
| D10 | role/lifecycle/revocation policy | `src/collaboration/server/policy/` | W0 | org/space役割、最後のowner、live queue/subscription/asset/receipt再認可。決定を親transactionへ渡す |
| D11 | provider/通信と購読寿命 | `src/collaboration/provider/` | W0、D07〜10、選定方式API | 実loopback HTTP、断線/ACK喪失/重複/旧epoch/遅延応答/失効、listener/queue上限とclose |
| D12 | shared Editor adapterとorigin伝播 | `src/editor/shared/` | 候補適格性、D03/04/07、親IPC契約 | real PM/jsdom、LOCAL/REMOTE/SEED transaction由来、ID補修なし、二重historyなし。既存Editor/Appは親が接続 |
| D13 | ページ階層/DB owner/schema/record/値 | `src/collaboration/resources/records/` | W0、D08/10、実DB型 | 本文と値/所有/削除を同cutへ参加、実Folio全対応型・未知raw、cycle/旧owner/ABA競合 |
| D14 | 添付staging/公開/再開/GC | `src/collaboration/resources/assets/` | W0、D08/10 | bytes/hash/size、公開前参照なし、scope拒否、中断/容量/backup参照を含むGC |
| D15 | private→shared preview copy/import | `src/collaboration/transfer/copy.ts`等 | D13/14＋W0 | 選択cutと再確認、ID/link mapping、範囲外title/内容送信なし、未知raw保全、実copy commit |
| D16 | 検索/backlink/export用共有投影 | `src/collaboration/projection/` | W0、D08、resource API | watermarkと同cut参照、別scope権限、rebuild/restart。private CONTENT表へ共有正本を置かない |
| D17 | delete/restore/new incarnation・履歴 | `src/collaboration/recovery/lifecycle.ts`等 | D08/10/13 | 新seed一度、遅延ACK/旧offline intent回収、remote変更後の復元再確認 |
| D18 | 完全backup/restore/旧server巻戻し | `src/collaboration/recovery/backup.ts`等 | D08/10/13/14/17 | 実payload/asset/member/revoke/cut manifest、復元後再open、R10旧epoch clientと既知欠落/UNKNOWN |
| D19 | compaction/保持/offline/容量 | `src/collaboration/recovery/retention.ts`等 | W0、D07/08/17/18 | checkpoint+suffix原子切替、delete-only/未確定receipt保全、期限/backup猶予、不足は停止。quota確定拒否 |
| D20 | Lv6組織加入/離脱/全space引継ぎ | `src/collaboration/organization/membership.ts`等 | W0、D09/10の固定API | 組織責任とspace roleを分離、最後の責任者とdevice喪失、全領域revoke同cut |
| D21 | multi-workspace service/cross-scope | `src/collaboration/organization/workspaces.ts`等 | W0、D08/10/20 | 同名ID/asset/operation/navigationでも分離、org管理者の自動本文閲覧なし |
| D22 | 監査/容量/backup管理service | `src/collaboration/operations/status.ts`等 | W0、D08/10/18/19 | 実保存情報から権限付き診断、秘匿/監査上限、解放/backup/復旧の操作根拠 |
| D23 | 更新互換/失敗/復旧再開 | `src/collaboration/operations/upgrade.ts`等 | W0、D08/18/19 | version writer fence、中断/失敗後原本保全・再開、旧writer再開でrollback偽装なし |
| D24 | 保存/共有/権限/復旧UI状態・部品 | `src/renderer/shared/` | W0、serviceの固定API | pure状態＋Node/jsdomの操作、未保存/local/server/receipt/peer/UNKNOWN。実GUIはNOT_RUN、App接続は親 |
| D25 | Windows private file/path/ACL/identity | `src/platform/windows/files/`＋固有suite | W0 platform契約 | SID/DACL/handle/reparse/case/8.3/ADS/UNC/flush/publication/有界retry。Mac fixtureはOS合格ではない |
| D26 | Windows credential/async storage候補 | `src/platform/windows/credentials/`＋固有suite | W0、D09/25契約 | DPAPI semantics/不可用/旧暗号文維持/rotation、Electron45互換。個人Keychain不使用 |
| D27 | Windows所有process/packaging準備 | `scripts/platform/windows/`＋固有suite | W0 | Job Object/native API helper、owned childのみ停止、残留/pipe、artifact manifest。package既存入口は親 |
| D28 | platform-neutral複数機受入harness | `tests/acceptance-common/`＋手順資料 | W0、D11/25〜27固定API | Windows port単体gate後に共通suite、実OS/物理/user/hash記録、合成/VMを物理に数えない |
| D29 | Lv3/4残件の照合と非GUI反例 | 専有 `tests/lv34-plan-followup/`＋残件資料 | W0 | 古い未完の再開を避け、private保存/回復/容量/vault/予約の実再現。製品修正は親が担当pathを限定 |
| Rxx | 独立した敵対review/反例 | 各担当と別一時コピーのreview report/専用fixture | 対象diffの到着 | 正常系と故障traceを別観点から評価。親oracle/必須条件を緩めない |

D01〜04/D07〜10/D20〜29の契約が独立した範囲は早期に並行できる。D05/06は具体的構造/pending APIと最小durable境界後。D11/12等は前提がreadyになってから起動し、API不在をstubや自由探索で埋めない。D13以降のpolicy/fixture設計は先行できるが、実service接続を未実装のまま合格にしない。

## 親の継続責任と停止/再開

1. canonicalJson/fingerprint golden vectors、型/API、oracle、ID/cutをW0で固定。採用済み変更が契約を変えたら依存packetを更新し、古いhelperへ同時編集させない。
2. 初回4件→ready数/資源/応答/親統合に合わせ拡大。24は過去観測、hard limit未確認。heavy Node/buildは2枠。未統合queueが一波分を超えたら実装投入を抑えてreview/反例へ配分する。
3. parentは小さな受理cutで接続・非GUI検証を繰り返す。子の独立test passだけで受け取らず、authority/Editor/serviceへ接続したpathを台帳化する。
4. Bで既存binding置換が必要、Cでanchor/history/collab契約が成立しない、64kでもlength/無成果物が続く等は該当系列を再分割/停止する。独立系列は継続。自作の汎用CRDT/OT開発へ膨張させない。
5. 同じ失敗を同じpromptで繰り返さない。所有外差分/成果物欠落/timeout/length/テスト0/未取得usageを全て残す。provider制限は購入/課金切替/無限retryで解決しない。
6. 各担当の完了報告には、専有差分、実装済みAPI、接続先、未実装/未知/既知FAIL、実行していない試験、必要な親統合点を含める。workerは自分でtest/buildを回さない。
7. scopeを満たすコードを優先し、最大並列数やtoken消費自体を成果としない。最終候補のcheck/test/buildと関連非GUIsuiteはGo後に親が実行。GUI/Windows/物理機は別のNOT_RUN列。
