# Lv5方式比較：同じ14反例から採否を決める

2026-11-08。Opus 5.5 XHighの提案をCodexが既存コード・計画へ照合した設計メモ。**計画のみ・未実装・試験NOT_RUN。新しい実行範囲の承認ではない。** 製品候補bd65b73、master e269137、Lv4未認定を維持する。

B＝文書CRDT＋server順序の構造command、C＝server順序付きProseMirror steps/rebase。Yjs等の製品採用は未決定。現在のlockはTiptap3.32.0で共同編集依存は未導入。次の実験前に一次資料・版・licenseを確認してscratch内へ固定する。

## 共通の実験契約

| 成果物 | 内容 |
|---|---|
| fixture | raw元bytes/hash、rich schema、block ID、権限、doc lifecycle |
| scenario | 抽象intent、script/schedule/faultのseed、必須受理・許容拒否・禁止結果 |
| trace | actor/resource、操作fingerprint、epoch/cut、local/server receipt、公開projection、payload参照 |
| result | case/engine/seed別の観測・未実行・最小反例・harness/fixture/依存lockのhash |

同じfixture・intent・障害schedule・判定器をB/Cへ与える。通常の合法な共同本文編集など、必ず受理すべき正常系も明示する。全部をSAFE_REFUSEしても合格にはしない。例外的拒否は事前に許容した条件だけで、拒否intentの回収可能性を検証する。

| 反例 | 検証する意味 |
|---|---|
| R01 | legacy JSONの二重seed、欠落block IDの独立乱数補修、viewerの書込み |
| R02 | moveと他者edit、順序逆転/分断、IDと入力意図 |
| R03 | 表の並行row/column変更と合法projection |
| R04 | local Undo/Redo、remote編集、slashの操作境界 |
| R05 | local/server commit前後の中断、ACK喪失、重複効果 |
| R06 | Lv4 private checkpointがshared正本を置換しない |
| R07 | DB schema/record ownerと本文/値/削除の共通cut |
| R08 | offline旧incarnationとdelete/restore、新seed一度だけ |
| R09 | 失効、既存socket/queue/asset/receiptの認可 |
| R10 | server旧backup復元とACK済変更の既知欠落/不明範囲 |
| R11 | compaction、長期offline、delete-only更新 |
| R12 | private→shared copyの範囲・raw未知値・ID/link/asset |
| R13 | 同じPageIDのprivate/shared、navigation、旧sessionの遅延ACK |
| R14 | 合成compositionとremote更新。実IME/clipboard/native DnDは別GUI受入 |

## 判定の注意

- 見るのは受理commit・公開projection・ユーザーへ見せる状態。未公開内部transactionの過渡状態まで不正表示扱いにしない。
- 比較するのは内容・ID・意図・有効な因果関係。意味的に同じCRDTの内部binaryが完全一致することは要求しない。
- state vectorやprovider syncedだけで保存完了にしない。JSON投影だけで未知の因果rootを無視しない。
- trace最小化では元の前提・権限・因果関係を保存し、成立しないscriptを反例にしない。
- 有限seedで反例0は、その試験範囲の結果。全ケース正しさの証明でもLv5認定でもない。

V01範囲→V02依存→V03往復→V04同じ反例→V05採否ADR。方式の採用と本体実装を分ける。両方が不適ならNo-Goも正当。基本機能を外した小pilotは、Lv5全体の合格と区別する。

同じ位置への同時挿入ではB/Cの合法な順序が違い得る。BとCの最終doc完全一致を要求するのでなく、事前に定めた合法結果集合と、各engine内のreplica収束で判定する。共通seedからintent単位のschedule fileを先に生成し、adapter内部の乱数消費で障害順序が変わらないようにする。内部保存境界ごとの故障注入は別軸で記録する。
