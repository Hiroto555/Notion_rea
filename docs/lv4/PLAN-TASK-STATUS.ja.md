# Lv4計画タスクの対応状況（M3最終受入待ち）

2026-11-08。[M3候補・証拠](M3-ACCEPTANCE.ja.md)が現在地。A0〜A7の実装・非GUIとLinux共通GUIを受入した。物理Mac 2台やOS固有を未確認のままLv4完成とはしない。確認済みLevelはLv3。masterは未マージ。

| ID | 現在の範囲 | 残す確認 |
|---|---|---|
| T01 | 統合branch・製品候補9ddb60c・quiet/CI・公開先を固定 | Mac受入も同じ候補へ揃える |
| T02 | 1MiB、201ページ/100records/100MB添付/8revision、100MiB・1,000添付の実byte/hash・時間・RSSを計測 | Mac実起動/描画・実通信/スリープでの性能 |
| T03 | 同一所有者Mac2台/単一server、R1/手動同期、外部暗号化vault、保持上限を固定 | 実機・実SSHで再現 |
| T04 | 送信/受信staging/固定対象の起動時適用を分離 | 実機2台の両方向受入 |
| T05 | 添付再開・scope排他・全体hash・容量/所有拒否、診断と所有ticketによる明示cache解放 | 物理回線断/スリープの受入 |
| T06 | main同期サービス・手動送受信/再接続・初回設定/更新/無効化・通常復元後recoverを接続 | Mac Keychain、初回空workspaceのOS起動手順 |
| T07 | 入力・保存・保守と同期の排他、実IPC/Linux回帰を受入 | 実IME・数値途中・native picker中の終了 |
| T08 | 通常/競合ともUUID/CAS・原子的消費。実終了→windowless起動→一度だけ適用をLinux受入 | Mac Cmd+Q/赤ボタン/終了取消し/Dock復帰 |
| T09 | 状態/設定・勝者確認・archive回収/復元・秘密の保存更新無効化を製品へ接続 | Mac OS連携。比較は抜粋で、全データの完全diffは初期対象外 |
| T10 | server/client履歴・ACK余白・blob/cache/backupを有界化。上限時は保全停止、手順を記録 | 大規模長期運用・自動rollover/bootstrap/差分転送は別設計 |
| T11 | 実server CLI、排他・発行/失効・全履歴/receipt/敗者添付の完全backup、新規先restore/fresh epoch/全旧device失効 | 2台目で実運用手順を再現 |
| T12 | SIGKILL・ACK/COMMIT/IPC喪失・sidecar回復・所有差替え・ENOSPC注入・quota競合・復元後再登録を一時環境で試験 | 物理故障/停電を模擬注入の合格へ含めない |
| T13 | Linux GUI全238件PASS：実IPC207、Electron表示5、Chromium表示26。skip/retry/flaky 0 | native OS操作を代替応答の合格へ含めない |
| T14 | Linux側の共通受入を完了、Mac/物理2台のキューを固定 | **NOT_RUN**：Mac固有・物理2台・L4-01〜12の最終判定 |

[運用・保全手順](M3-OPERATIONS.ja.md)、[GUI待ち](GUI-ACCEPTANCE-QUEUE.ja.md)、[Gate状況](GATE-STATUS.ja.md)を参照。M1/M2第1区切りの古い未完記録は各時点の履歴として残す。
