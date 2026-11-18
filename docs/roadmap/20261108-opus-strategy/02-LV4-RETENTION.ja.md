# Lv4長期運用：上限で止まった後を設計する

2026-11-08。Opus 5.5 XHighの提案をCodexが既存コード・計画へ照合した設計メモ。**計画のみ・未実装・試験NOT_RUN。新しい実行範囲の承認ではない。** 製品候補bd65b73、master e269137、Lv4未認定を維持する。

現行は保持量を制限し、不確かなデータを消さず保留する。安全な自動履歴rolloverは未実装。上限と実測fixtureを、任意規模・無期限運用の保証へ読み替えない。

| 選択 | 現在の扱い | 次に必要な判断・証拠 |
|---|---|---|
| 保持して保留＋既存の外部退避 | 現行の基本。検証済み古いbackupを外部へ移す導線がある | 次回完全backupの実寸/空きと増加速度を測る。外部保存先が確保できない場合は保留 |
| 新しいworkspaceへ移す | lossless移行機能は未実装。計画候補 | 11表/履歴/添付/ID/link/保留操作/receiptの対応表、明示選択、原本保全、旧clientの扱いを証明 |
| 同じworkspaceのbootstrap/compaction | 新しいprotocol/保持設計が必要 | 同一cutの内容とreceipt証拠、offline依存、参照中blob、復元/旧clientの契約、保存先可用性を先に定義 |

## 誤って採用しない近道

- backup枠満杯は即「永久停止」ではない。既存の検証済み退避で解消できる場合がある。ただし次の完全backup自体が上限を超える場合や空き不足は別問題。
- backupを1回取っても保持上限はリセットされない。backup watermarkだけで、live履歴・未確認操作・参照blobを消せるわけではない。
- M1回収bundleの100MiB/1,000添付と、通常workspace/server完全backupの上限は別。すべてを100MiBへ制限する案は採らない。
- R3は全量checkpointなので、R2の内容を含み得る。差分操作と仮定して「R2 opが無ければ内容回復不能」と断定しない。実際に残るworkspace/履歴/backup/payloadを確認する。
- 旧server封印は、復元先で失ったreceiptを戻さず、跨epochの再送冪等性を証明しない。現Lv4のwire/fingerprintは維持する。
- 現行recoverはworkspace ID一致を要求する。通常fullbackup→新client copyで同じworkspaceへ再登録する既存導線と、新workspace IDへの移行案を混同しない。
- M1回収コピーの恒久同期保留markerは解除しない。

## 次の設計成果物

1. 仮の70%/85%ではなく「次回fullbackup＋復旧用余裕」と増加速度の計測計画。
2. ACK済/unknown/未送信/現在内容/履歴/外部backupを分けた保存先一覧。
3. 消せることの証拠と、証拠または保存先が失われた場合に保留する条件。
4. 復元元以後の既知欠落と、独立証拠がなく不明な範囲を分けた表示。

現在の適用予約とcache解放は別の状態機械。cacheのmark/trash/unlinkを本文適用へ流用しない。上記はM3受入候補に追加した機能ではない。
