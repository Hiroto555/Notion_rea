# Lv5の保存・権限・削除復元を分けて考える

2026-11-08。Opus 5.5 XHighの提案をCodexが既存コード・計画へ照合した設計メモ。**計画のみ・未実装・試験NOT_RUN。新しい実行範囲の承認ではない。** 製品候補bd65b73、master e269137、Lv4未認定を維持する。

以下はshared専用の将来案。Lv4 wire/fingerprint・private DB・既存M1の回収契約を変更するものではない。

| 境界 | 同じcommitで確定する候補 | 成功として表示できる時点 |
|---|---|---|
| local outbox | 不変envelope/payload hash、操作ID、未確定状態 | local永続化が確認できた後 |
| server受理 | 現在の認可、doc/incarnation、重複照合、検証、順序、内容/receipt | server commitを確認した後 |
| client受領 | receiptと操作状態の更新 | client側commit後。送信完了/onlineと区別 |
| membership/lifecycle | role/revoke/最後のowner、新旧incarnationとcut | 決定済みcutに従う。過去受理を消さない |

共通event_seqの範囲、sharedの操作identity、epochとの関係、証拠digest、compactionはADR前の候補。既存Lv4へそのまま持ち込まない。

## 三つの順序付き反例

1. **削除・offline編集・復元**：旧incarnationに対する未送信を保持→削除前の受理cutを固定→新incarnationへ一度だけseed→旧操作の自動流入を拒否→回収intentを明示選択して新操作へ。既存M1コピーの同期保留を解除する導線にしない。
2. **失効と処理中の送受信**：受理が先ならそのcommitを保持。失効cutが先なら新規受理/認可/配信を拒否。cut前に送信済みのbytesやACKがcut後に届くことまで取り消せない。取得済みデータの遠隔回収は保証しない。
3. **ACK喪失・古いserver復元**：旧epochのunknownと原本を保持。新epoch/失効/巻戻しで自動再送を保留。残るworkspace内容・履歴・backup・receipt/payloadを照合し、既知欠落と不明を分ける。全独立証拠を失った範囲を完全検出/回復できるとは言わない。

## 比較の単位

- server順序は単なるseq数値で識別せず、epoch・resource・cutと結ぶ。同じ数値seqがfresh epochで現れたことだけを障害としない。
- prefix digestは同じcutの証拠を比較する。進んだheadのdigestが旧headと違うのは正常。
- 古いtokenの接続はauth拒否が先の場合がある。特定STALE_EPOCH文字列ではなく、保留・無変更・誤再送なしを判定する。
- 操作fingerprintのactor/deviceは認証済みcontextへ束縛する。再登録や新incarnationで旧intentを黙って別envelopeに変換しない。
- 512行/64MiBは現Lv4の予算。将来Lv5の保持値や、回復できるデータ全体の上限として自動採用しない。

最小の認証・役割・失効・最後のowner・asset/receipt認可はLv5の境界に含む。Lv6へ全て先送りしない。Lv6の組織/運用機能はまだ未確定。
