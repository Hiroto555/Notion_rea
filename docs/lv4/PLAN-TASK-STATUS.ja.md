# Opus案のタスク対応状況

2026-11-07の隔離統合候補について、[レビュー版計画](planning/LV4-PLAN.ja.md)のT01〜T14に対応させた途中記録。実装済みのコードと、Node/一時SQLite/loopbackで確認した範囲を示す。GUI・実機・OS・実運用は別の受入であり、Lv4完成の判定ではない。

**残作業の優先順・概算工数・停止地点： [Lv4の残作業・工数・区切り](REMAINING-WORK-PLAN.ja.md)。計画保存のみで、M1等の実行範囲は未決定。**

| ID | 状態 | 今回の実装・残り |
|---|---|---|
| T01 | 実施 | 基準・元draft・GUI未実施を記録。作業は別ツリー |
| T02 | 部分 | 合成checkpoint・record・添付・backupを計測。実機・通信・目標規模の予算は未完 |
| T03 | 部分 | 同一所有者Mac 2台、R1、loopback/トンネル等を候補として記録。対応規模・OS・保持と秘密情報の運用判断は未確定 |
| T04 | 実装・非GUI確認 | 送信・受信staging・対象指定適用を分離し、既存入口も維持 |
| T05 | 部分 | 添付staging・hash・容量確認は実装。プロセス再起動をまたぐ未完転送の再開と掃除は未完 |
| T06 | 部分 | mainサービス、手動同期、登録済みv5の手動再接続とtyped IPCを実装。自動同期・初回登録の接続設定は未完 |
| T07 | 部分 | 保存・保守と同期の排他、ゲートのidle、適用前の検査をNodeで確認。Electronの全操作経路はNOT_RUN |
| T08 | 部分 | 通常適用の対象固定・予約/取消し・終了時再検査・offline適用を実装。競合の選択はSQLite予約→次回起動前のオンライン適用を接続し、結果を同一transactionで消費。実終了取消し・入力/IME保護のGUI受入はNOT_RUN |
| T09 | 部分 | 状態・最終成功時刻、競合候補・ページ本文/移行済みDBレコード比較・JSON取り出し、SecretStore/暗号文ファイル部品を実装。勝者確認UI・typed IPC・メモリ予約/取消し・全window閉鎖後のSQLite予約・次回起動時の適用と再適用防止をコード接続しNode確認。実画面・実IPCはNOT_RUN。archive回収、旧形式DB行・完全diff、接続設定、秘密の更新/削除・製品/OS連携は未完 |
| T10 | 未完・条件付き | 容量上限の保全停止と一部計測を実施。履歴の有界保持・bootstrap・差分転送の必要性と方式は未確定 |
| T11 | 部分 | fixture運用CLIと、添付を含まないserver catalog snapshotの作成・読み取り専用概要検査の内部API。履歴全件・復元可能性の検査、実serverのCLI、添付を含む完全backup・復元・epoch更新は未完 |
| T12 | 部分 | ACK喪失、通信断、backup失敗、意図破損・識別不一致・復旧入力、path差替え、競合決定のCOMMIT前/後の故障・取消しとstartupの交差を一時環境で確認。製品全経路の故障注入は未完 |
| T13 | 部分 | 非GUI状態遷移試験とGUI受入待ちの項目を記録。表示用fixtureのGUI spec 2件を追加し一覧確認のみ。製品の実IPC・終了・dialog等のGUI specと画面検証は未完 |
| T14 | NOT_RUN | GUI batch、物理Mac 2台・実トンネル、Windows分岐の受入を未実施 |

最新の試験結果と制約は `IMPLEMENTATION-STATUS.ja.md`、各受入条件は `GATE-STATUS.ja.md` を参照する。

競合選択の固定対象・保全範囲・結果不明時の扱いは `CONFLICT-RESOLUTION.ja.md` に記録。コアの試験合格を製品UIでの勝者選択完了として扱わない。
