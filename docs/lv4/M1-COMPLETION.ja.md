# M1完了記録：非GUIでの競合データ回収まで

2026-11-08 JST。利用者が指定した **A0〜A2のM1を完了し、A3へ進まず停止**した。確認済みLevelは **Lv3のまま**。GUI・Electron・実IPC・実IME・物理2台の受入は **NOT_RUN**。

Codexが契約・共有部分・統合を管理し、OpenCode GoのDeepSeekを最大4本で並列実行した。Sol XHighは契約、途中候補、最終候補をread-onlyで安全性レビューした。作業は隔離した統合ツリーと一時データに限定し、元masterと利用者の実データを変更していない。

## 固定候補と検証

| 項目 | 記録 |
|---|---|
| M1ブランチ | `codex/folio-m1-20261108` |
| 保存済み基準 | `732fad58681c45931c1a16ee90fa1bfcff0a9072`。過去の[GitHub保存記録](PUBLICATION-CHECKPOINT.ja.md)とは別の追加分 |
| 実装・最終検証・Sol S2の候補 | `d509edff574fc1f40e1bbdb93cbb5d45176f683b` |
| src tree | `378c75ce5f86f7d2feb5ec462bac1d84ee622a94` |
| tests tree | `b4a510df8fbb59d838099a8fab46462496165dba` |
| `npm run verify:quiet` | **PASS**：型検査、**180ファイル／1,673テスト**、build。[候補のログ](validation/m1-quiet.txt) |
| Sol XHigh S2 | **未解決P0/P1なし**。試験実行と分離した[レビュー記録](reviews/m1/SOL-XHIGH-M1-REVIEW.ja.md) |
| 追加確認 | `review:test` 5件PASS、buildのローカルasset参照3ファイルPASS、headless救出CLIの`--help` exit 0（データを開かない） |
| 共有前の内容検査 | 現在ファイルのpattern scanで既存の合成URL試験1件を検出。検出ゼロとは扱わず、検査器は変更していない。判定は[過去保存記録の説明](PUBLICATION-CHECKPOINT.ja.md)と同じ。生のモデルログ・一時DBは追加収録しない |
| 原本 | 元master/HEADは`e269137f191081cabc0f05aa03ec68339ce413c2`、開始時と終了時のGit状態は一致。既存の`artifacts/`・`outputs/`はそのまま |
| 保存先 | ローカルのM1ブランチへcommit。今回のM1追加分はpush/mergeしていない |

この後の文書・証拠保存commitは上記src/tests treeを変更しない。Viteの既存の大きなchunk／dynamic import警告は残るが、buildは成功した。

## できるようになったこと

- 通常適用の新規予約を、UUID付きSQLite journalへ変更。取消しは期待IDとレコード全体を照合し、本文適用と予約消費は同じtransactionで確定する。競合予約との相互排他もtransaction内で確認する。
- 同期が無効・未接続でも、ローカルに保全した競合archiveを一覧・選択できる。破損行を隔離し、古い項目にはpaginationで到達できる。
- JSONだけの退避と、必要な添付を全件照合した回収bundleを区別する。保存先はmainが外部の新しいフォルダとして決め、原本や既存出力を上書きしない。
- 回収bundleから新規v4 DBを構成し、内容11表・履歴・添付を保持する。sourceの設定・秘密・同期識別・予約・receipts・未保存入力を持ち込まず、新しい回収識別と同期保留markerを付ける。
- 書出し・復元の結果不明を保全し、同じ出力の完成検査で再照合する。IPC応答だけが失われても操作IDを保持し、画面部品の再生成後も同じ要求を照会する。確認できるまで新たな出力を作らない。

画面コードは接続済みだが実操作は未確認。操作入口と保全時の手順は[回収手順書](m1/RECOVERY-RUNBOOK.ja.md)を参照。

## M1終了条件の照合

すべて上記候補の非GUI証拠。拒否試験のPASSは、仕様どおりBLOCKED/unknownとして保全したことを意味する。

| ID | 判定 | 主な証拠・終了した範囲 |
|---|---|---|
| M1-01 | PASS | [契約](M1-CONTRACT.ja.md)、[A0上限・fixture](m1/A0-SCALE-AND-FIXTURES.ja.md)、[担当カード](M1-DISPATCH-PACK.ja.md)。未決のAPI/schema変更なし |
| M1-02 | PASS | `m1-normal-apply-journal`29件、`m1-normal-apply-faults`12件と既存restart/startup。ID/CAS、別ID取消し拒否、再open後の適用・照合 |
| M1-03 | PASS | 同じ独立故障試験、既存`lv4-conflict-resolution`/restart/coordinator。通常・競合のreserve/consume相互拒否、入力/処理中保留、COMMIT前rollback・後の再照合 |
| M1-04 | PASS（保全停止） | legacy存在・破損・差替えで実行/削除を拒否。同期設定なしでも理由を返す。旧形式解除は未対応として保持 |
| M1-05 | PASS | `m1-conflict-archive-catalog`9件、独立`m1-conflict-recovery-adversarial`14件。50/100件、anchor、破損隔離、登録/DDLなし |
| M1-06 | PASS | catalog/export/flow。source/id/op/kind/日時/hashの一致、picker後のtarget/送信元再検査、差替え時の拒否 |
| M1-07 | PASS | verifier9件、export12件、独立adversarial。strict manifest、UTF-8 bytes、添付不足/改竄/上限超過の拒否、JSON-only非復元を明示 |
| M1-08 | PASS | assets12件、io故障4件、export/flow。別inode、FD/path差替え、FIFO、symlink/hardlink、ENOSPC注入、fsync/完了応答不明の保全・再照合 |
| M1-09 | PASS | importer6件、独立acceptance10件、flow6件。全11表のhash/件数/参照・添付、v4再open同値、検証用コピーで通常保存・履歴追加 |
| M1-10 | PASS | acceptance/flow/io/routing。設定/秘密/同期表/receipts等不在、新識別、直接同期・環境設定付きstartupのguard。marker破損も保留。再接続入口も同じguardを再検査 |
| M1-11 | PASS | flow6件とacceptance10件。一覧から新規コピー再openまで、source内容/archive/添付の不変、未完了保持、同一IDの効果1回・16件上限 |
| M1-12 | PASS | 最終quietの全3段階PASS、Sol S2未解決P0/P1なし。応答喪失修正は独立したmock IPC11件＋model27件で確認し、全quietを再実行 |
| M1-13 | PASS（非GUI区切り） | 手順書・本記録・実装状況・受入待ち一覧を更新。GUI等はNOT_RUN、Lv3維持、A3未着手で停止 |

試験名は`tests/<名前>.test.ts`。全体でbaselineより164テスト増えたが、件数からLv4の達成率は算出しない。故障注入は電源断・実OS・実ネットワークの成功を証明しない。

## 並列実装と修正の実績

| 担当 | 実際の受入 |
|---|---|
| D01 | Codexが既存計測を引き取りA0文書と境界を固定。DeepSeek実行なし |
| D02 Pro | 通常journal。Codexがpendingの排他判定、消費根拠の実checkpoint hash、protocol識別子との互換を補正 |
| D03/D04/D05 Flash | catalog、verifier、添付コピー。Codexが読取り結果不明の接続再利用拒否、archive/checkpoint hashの結合・canonical bytesを補強 |
| D06 Flash | export。Codexが日本語のUTF-8 bytesと完了directory fsync応答不明を補正 |
| D07 Pro→Flash | 初回ProとFlash再投入を途中停止し、読取り権限修正後のFlashでimporterを受入。Codexが固定v4構成、禁止情報検査、fingerprint/出力境界を担当 |
| D08 Flash | 回収UI部品・pure model。App/IPC/bridgeはCodex。Sol差戻し後、Codexが操作ID保持と応答喪失からの再照会を修正 |
| D09/D10/D11 Flash | 実装者と別sessionで通常故障、bundle/添付、復元の独立試験。D09/D11の初回は権限不一致で停止し、修正して再投入。D11のworker実行はNOT_RUNで返し、Codexが統合ツリーで実行 |
| D12 Flash | 全11表の回収往復、冪等性、保全結果の独立試験と手順書。Codexが実入口・制約の文言を照合 |
| Codex | 共有I/O、schema、main、同期transaction、startup/quit、IPC、UI接続、既存回帰更新、全体検証、記録・停止判定 |

OpenCode 1.18.30で実際に15回の実装/修正run（2回はexit -2で中断）。別に小さい読取り権限probeを実施。実装成功や試験合格をCLIのexit 0だけでは判定せず、差分と親の試験で受入した。[モデル別の実行・usage記録](reviews/m1/deepseek-implementation-runs.json)。

取得できたproviderフィールドの合計はinput **1,233,763**、output **126,913**、reasoning **315,082**、cache read **19,563,904**。input/outputの運転カウンタは計画の暫定値内だが、cacheやreasoningを足した総転送量・課金tokenが200万以内だったという意味ではない。中断時に未報告のstepがあればそのusageは含まれない。課金額・総context量・速度倍率は評価していない。追加課金設定は変更せず、全workerは終了済み。次回の予算はcache/reasoningを含む集計方法を明確にしてから決める。

最初の最終quietでは過去のstartup fixtureが旧sidecarによる成功を期待して1件失敗した。通常成功fixtureを新SQLite予約へ移行し、旧sidecarを拒否する独立試験を残して全体を再実行した。Solの途中/最終指摘も修正済みであり、最初から全試験が合格していたという記録にはしない。

## 維持した制約と停止地点

- 旧sidecarは保全してBLOCKED。自動移行・解除は提供しない。
- 回収画面の「新規コピーとして復元」は、選択archiveからbundleを作り、別の新規workspaceへ復元する。既存の保存済みbundleをファイル選択する画面入口は未追加。独立bundleの検証・復元は内部APIとNode試験で受入した。
- 完全bundleに必要な添付がsourceに残っていなければ保留する。自動ネットワーク取得はしない。
- hostの冪等ID記録はmain session内16件、削除/evictなし。再起動を越える永続journalとは別。過去の未確認出力は手順で保全・確認し、自動再実行しない。
- 回収markerによる同期保留の解除は未提供。任意の同一UID processによる改竄全般の防御は主張しない。
- 上限の構造試験と小さい全内容fixtureを受入した。100 MiB/1,000件の実コピー性能、最大RSS、main停止時間の保証は未測定。
- GUI、実終了イベント、native picker、OS clipboard、実IME、物理Mac2台、実トンネル、Windows、M1版のGitHub Actionsは **NOT_RUN**。

**A3の添付再開/整理、接続設定、実serverの完全backup/restore、容量保持の拡張は開始していない。** 続ける際はこの記録と[GUI待ち](GUI-ACCEPTANCE-QUEUE.ja.md)から新しい作業範囲を決める。
