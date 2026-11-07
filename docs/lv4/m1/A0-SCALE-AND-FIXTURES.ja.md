# M1 A0：範囲・上限・合成fixtureの固定

2026-11-08。Codexが既存の[合成計測](../capacity-results.ja.md)と[M1契約](../M1-CONTRACT.ja.md)を照合し、D01の文書作業を引き取った。D01をDeepSeekが実装したという記録ではない。A0は今回の回収機能の成立範囲を決める作業で、Lv4全体の運用規模の認定は含まない。

| 項目 | M1で固定した条件 | 試験・限界 |
|---|---|---|
| 対象 | A1の通常予約、A2の保全archiveから外部への回収・新規コピー復元 | 原本へのmerge/上書き、GC、添付転送再開、同期設定の製品接続は対象外 |
| checkpoint | UTF-8で最大1,048,576 B。内容11表と履歴・添付manifestを含む | ページ数による保証はしない。既存の130ページ×本文8,192 B fixtureは1,142,888 Bで拒否された。上限・履歴を黙って変更しない |
| 添付 | 1件20,000,000 B、合計100 MiB、最大1,000ファイル | verifierで宣言値のちょうど上限・次の1 B・次の1件を試験。実ファイル全件のbytes/hash照合は別に必須 |
| 一覧 | 既定50件、最大100件、anchor固定のkeyset cursor | 巨大JSONはSQLでbytesを判定してから取得。破損行はその行だけ無効表示 |
| 出力容量 | 既知payload×4＋64 MiBの空きを出力volumeで確認 | DB・WAL・コピー・再検証の余裕を含む保守的な見積り。容量予約や最大DBサイズの証明ではない。不明/不足は作成前保留、実行中ENOSPCは未完了を保全 |
| メモリ | 添付を64 KiB chunkで読み、FD・入力・出力を再照合 | 最大100 MiB/1,000件の実コピーの性能・最大RSSは未計測 |
| 同期 | 回収先は新しいローカルv4 DB。回収markerで同期を保留 | 環境変数付きstartup、直接publish/join/recover、再接続入口でguard。解除・自動登録・起動・送信は追加しない |
| 保持 | source archiveと失敗出力を保持する | M1では保持期限・GCを定めない。同期全体の保持設計はA3/A6以降へ残す |
| 実行負荷 | DeepSeekは実際には最大4本、worker対象試験はmaxWorkers=1、最終quietは2 | 6本への増加は行わなかった。並列数による短縮率は未測定 |

## 合成fixtureと受入対応

すべて一時ディレクトリ・一時SQLiteで作成する。実FolioのDB、設定、添付を読まない。

| fixture・故障 | 主な証拠ファイル（repository rootから） |
|---|---|
| 内容11表すべてに行を持つworkspace、旧形式DBとrecords、削除状態、本文・履歴・添付、新規v4 DB再open、通常保存と履歴追加 | `tests/m1-recovery-flow.test.ts`、`tests/m1-conflict-recovery-acceptance.test.ts` |
| 日本語のUTF-8、空添付、別inodeコピー、既存出力の拒否 | `tests/m1-conflict-recovery-export.test.ts`、`tests/m1-conflict-recovery-assets.test.ts` |
| 破損/巨大archive、pagination中の新規追加、scope/対象差替え、read transactionの応答不明 | `tests/m1-conflict-archive-catalog.test.ts`、`tests/m1-conflict-recovery-adversarial.test.ts` |
| manifest・checkpoint・添付の欠損/不一致、symlink/hardlink/逸脱path、上限 | `tests/m1-conflict-recovery-verify.test.ts`、`tests/m1-conflict-recovery-adversarial.test.ts` |
| FIFOをblockせず拒否、FD読取り中のpath差替え、ENOSPCの故障注入後も出力保持 | `tests/m1-recovery-io-faults.test.ts`、`tests/m1-conflict-recovery-export.test.ts` |
| COMMIT前後、二接続CAS、別ID取消し、通常/競合予約の相互拒否、旧sidecar保留 | `tests/m1-normal-apply-faults.test.ts`、既存`lv4-restart-*.test.ts` |
| 完了markerを外した直後の応答不明、壊れた添付で成功に上げない、同じ出力の再照合 | `tests/m1-recovery-flow.test.ts`、`tests/m1-conflict-recovery-acceptance.test.ts` |
| host成功後のIPC応答喪失、ID保持、部品再生成、照会失敗・not-foundで再実行しない | `tests/m1-recovery-response-loss.test.ts` |

ENOSPCは実volumeを満杯にせずfault seamで注入する。fsync/COMMIT faultも電源断実験とは区別する。最大物理容量の実測、長時間のmain thread停止時間、実IME・実IPC・2台の受入は未確認であり、この資料から性能SLOやLv4完成を推定しない。
