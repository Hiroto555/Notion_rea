# Opus案のタスク対応状況

2026-11-08 M1完了時点の隔離統合候補について、[レビュー版計画](planning/LV4-PLAN.ja.md)のT01〜T14に対応させた途中記録。Node/一時SQLite/loopbackでの確認であり、GUI・実機・OS・実運用の受入やLv4完成の判定ではない。

**今回の停止地点はM1（A0〜A2）完了。A3未着手。** [終了条件と証拠](M1-COMPLETION.ja.md)、[今後の残作業](REMAINING-WORK-PLAN.ja.md)を参照。

| ID | 状態 | 今回の実装・残り |
|---|---|---|
| T01 | 実施 | 基準・元draft・GUI未実施を記録。作業は別ツリー |
| T02 | 部分 | 合成checkpoint・record・添付・backupを計測。M1の1MiB/添付100MiB・1,000件等の上限とfixtureを固定・境界検証。Lv4全体の実機・通信・性能予算は未完 |
| T03 | 部分 | 同一所有者Mac 2台、R1、loopback/トンネル等を候補として記録。対応規模・OS・保持と秘密情報の運用判断は未確定 |
| T04 | 実装・非GUI確認 | 送信・受信staging・対象指定適用を分離し、既存入口も維持 |
| T05 | 部分 | 添付staging・hash・容量確認は実装。プロセス再起動をまたぐ未完転送の再開と掃除は未完 |
| T06 | 部分 | mainサービス、手動同期、登録済みv5の手動再接続とtyped IPCを実装。自動同期・初回登録の接続設定は未完 |
| T07 | 部分 | 保存・保守と同期の排他、ゲートのidle、適用前の検査をNodeで確認。Electronの全操作経路はNOT_RUN |
| T08 | 部分 | 通常適用もUUID/CASのSQLite予約へ統一し、本文と消費を同一transactionで確定。通常/競合の排他、COMMIT前後・古いIDの取消し拒否を独立試験。旧sidecarは保全停止。実終了取消し・入力/IME保護のGUI受入はNOT_RUN |
| T09 | 部分 | 勝者確認/予約/取消しに加え、保全archive一覧・JSON/添付付き回収・新規v4コピー復元・結果再照会をtyped IPC/UIへ接続しNode確認。IPC応答喪失のID保持と部品再生成も検証。実画面・実IPCはNOT_RUN。旧形式DB行の比較・完全diff、接続設定、秘密の更新/削除・製品/OS連携は未完 |
| T10 | 未完・条件付き | 容量上限の保全停止と一部計測を実施。履歴の有界保持・bootstrap・差分転送の必要性と方式は未確定 |
| T11 | 部分 | fixture運用CLIと、添付を含まないserver catalog snapshotの作成・読み取り専用概要検査の内部API。履歴全件・復元可能性の検査、実serverのCLI、添付を含む完全backup・復元・epoch更新は未完 |
| T12 | 部分 | ACK/IPC応答喪失、通信断、backup失敗、識別/入力、両予約のCOMMIT前後、FD/path差替え・FIFO・ENOSPC注入、回収完了不明の再照合を一時環境で確認。製品全経路の実操作故障受入は未完 |
| T13 | 部分 | Linux仮想画面で実Electron/実IPC41件、代替応答Electron表示2件、Chromium表示26件の計69件PASS。ページツリー3件と保存・復旧24件を含む。Mac/OS・残りの未移植GUI suiteはNOT_RUN。全GUI受入ではない |
| T14 | 部分 | Linux共通GUI69件PASS。Mac GUI batch、物理Mac 2台・実トンネル、Windows分岐はNOT_RUN |

最新の試験結果と制約は `IMPLEMENTATION-STATUS.ja.md`、各受入条件は `GATE-STATUS.ja.md` を参照する。

競合選択の固定対象・保全範囲・結果不明時の扱いは `CONFLICT-RESOLUTION.ja.md` に記録。コアの試験合格を製品UIでの勝者選択完了として扱わない。
