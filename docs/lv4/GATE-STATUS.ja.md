# Lv4 受入ゲートの途中記録

2026-11-08保存時点。この候補はLv4未認定。ここでの「部分確認」はNode/SQLite/loopbackの証拠に限り、GUI・実機・実運用を満たした意味ではない。[全体の入口](README.md)、[実装履歴](IMPLEMENTATION-STATUS.ja.md)、[今回の検証ログ](validation/publication-quiet.txt)を参照。

| Gate | 状態 | 今回の範囲・残件 |
|---|---|---|
| L4-01 | 部分確認 | 非GUI回帰を実行。既存draftと新UIのGUIはNOT_RUN |
| L4-02 | 部分確認 | 合成端末で本文・添付等の同期部品を試験。全データ種別の新製品導線と実機2台は未受入 |
| L4-03 | 部分確認 | ACK喪失・echo・未送信保持、再起動後のoffline適用をNodeで試験。製品全体の中断受入は未完 |
| L4-04 | 部分確認 | recovery inputで適用を保留し、IMEを含む共通入力保護条件をコード接続。実IME、入力途中、画面終了時の全条件はNOT_RUN |
| L4-05 | 部分確認 | 稼働中サービスは送信とstagingのみ。保存/保守の書込み排他はNodeで試験、実IPC/GUIと全操作経路は未受入 |
| L4-06 | 部分確認 | 候補情報・JSON取り出し・ページ本文／移行済みDBレコード比較・勝者確認UI・終了時予約／起動時適用をコード接続しNode確認。保全archiveの取り出し／コピー復元、旧形式DB行・添付本体・完全diff、実画面受入は未完 |
| L4-07 | 部分確認 | 添付の隔離staging・hash・容量拒否・offline公開を試験。未完転送の再起動をまたぐ再開と保持上限は未完 |
| L4-08 | 部分確認 | 意図/epoch/head/history、取消しとoffline保全、競合選択のSQLite予約／一度だけの消費をNodeで試験。GUI未検証。通常sidecarの外部同一UID writerによる差替え競合、server運用・実復元受入は未完 |
| L4-09 | 部分確認 | 既存のdevice/binding/schema検査とfixture失効を試験。SecretStore製品連携・OS試験はNOT_RUN |
| L4-10 | 未完 | 一部の合成容量・時間を計測。目標規模・保持・有界化・実通信/実端末の予算は未確定 |
| L4-11 | 部分確認 | 手動同期・状態表示・競合勝者確認／予約／取消しと終了・起動処理を接続しNode確認。同期設定なしでもpending取消しに到達するコードを追加。接続設定・SecretStore製品接続・画面検証は未完。成功時刻は保存失敗時にメモリのみ |
| L4-12 | NOT_RUN | 同じ候補の物理Mac 2台と実トンネルによる受入を実施していない |

GUI関連の具体的な待ち項目は `GUI-ACCEPTANCE-QUEUE.ja.md`。本番データ、実server、既存バックアップには触れていない。
