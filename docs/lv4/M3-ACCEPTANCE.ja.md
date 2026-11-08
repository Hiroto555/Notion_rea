# M3：最終受入候補の到達点

2026-11-08。**現在は最終検証中。M3最終受入待ちの判定は保留。確認済みLevelはLv3。** 利用者の今回の停止地点は、A0〜A7とLinuxで実行できるGUI受入を完了し、Mac固有・物理2台の最終受入だけを残すところ。従来計画の「M3＝Lv4完成」と区別する。

統合branchは `codex/folio-m3-ready-20261108`。[Draft PR #12](https://github.com/Hiroto555/Notion_rea/pull/12) は既存の未マージPR #11をbaseとする。masterは `e269137` のまま。原本・実データ・このMacのGUIは使わない。

## 機能と終了条件

| 範囲 | 今回実装したこと | 完了判断の条件 |
|---|---|---|
| A0 | 1MiB checkpoint、1件20MB、回収100MiB/1,000添付、保持上限とNode性能予算 | 上限を超える成功を主張せず、実ファイル・bytes/hash・RSSを計測 |
| A1 | 通常/競合予約のSQLite/CAS、入力・相互排他、結果不明の照合 | 適用と予約消費の原子性、別IDを取消さない、中断後再open |
| A2 | 保全archiveからJSON/添付付き回収、新規コピー復元、恒久同期保留 | 原本不変、全添付検証、未知の完了を重複作成しない |
| A3 | 添付再開・容量診断・ドライラン・所有ticketによる明示cache解放、古い空scope整理 | 実行途中SIGKILLとlost COMMIT後も同じIDで回復。live assets/staging/backupを削除しない |
| A4 | 接続UI、外部暗号化vault、次回起動時有効化、更新・無効化、通常復元後の明示recover | コピーDBが旧秘密を取得しない。Linux basic_textは保留。Mac Keychainは別受入 |
| A5 | 実サーバーCLI、排他、全履歴/receipt/敗者添付の完全backup、新規先restore | fresh epoch＋全旧device失効、旧token復活拒否、出力不明は保全 |
| A6 | queue/履歴/blob/backup/cacheの有界化、ACK用余白と固定理由の診断 | 不確かな履歴・入力を自動削除しない。上限時の手順を明文化 |
| A7 | 製品起動/実HTTPをつないだ統合、Linuxの実Electron/IPCと表示試験 | 同一ソース候補でquiet/build/CIを合格、skip/retry/flakyを分けて集計 |

自動同期・CRDT・差分転送・無損失の自動履歴rolloverは初期範囲外。履歴上限時は保全停止する。比較UIは要約・抜粋であり、全データ種別の完全diffではない。

## 証拠と再現

最終候補のquiet・Linux CIのSHA/件数は検証終了後にここへ固定する。古い69件のPASSを今回の変更の証拠へ流用しない。

- 非GUI：`npm run verify:quiet`（型検査→Vitest 2 worker→build）。一時Node/SQLite/loopbackだけを使う。
- 大容量：`node scripts/run-m3-benchmarks.mjs all`。対象は `tests/benchmarks/m3-scale.ts`、`tests/benchmarks/m3-recovery.ts`。通常のVitestに重い計測を混ぜず、Node/esbuildで個別実行する。事前に一時volumeの空き3GiB以上を確認し、全所有出力をfinallyで削除する。
- Linux GUI：`gui-linux-xvfb` workflow、6 shard、各worker 1、retry 0。Xvfb/DBus/一時keyring・一時data/vault。テスト自体の変更を含む同じ候補で受入する。
- 共有前検査：現行ファイルの秘密情報検査、既存の拒否試験用credential URLだけを既知fixtureとして区別する。rawモデル会話・token・一時DB・GUI traceはrepositoryへ追加しない。

大容量計測はこのMac上の合成Node試験1回の観測であり、端末一般の速度保証・GUI応答SLO・実通信・停電耐性を意味しない。SQL読取りが作る空WAL/SHM等の所有metadataと、原本の内容DB/config/blobの不変検査を区別する。

## 最後に残す受入

| 受入先 | 残す内容 | 状態 |
|---|---|---|
| Mac固有 | 実Keychainの保存/更新/無効化・ロック、実IME、Cmd+Q/閉鎖取消し、native picker/clipboard | NOT_RUN |
| 物理Mac 2台＋サーバー | 実SSHトンネル、双方向の本文/階層/DB/record/添付/削除復元、切断・回線変更・スリープ・再接続、完全server復元後の新端末登録 | NOT_RUN |
| 最終判定 | 同じ候補のL4-01〜12証拠を照合、未解決の重大不具合がないことを確認 | 受入待ち。Lv4認定前 |

[運用・保全手順](M3-OPERATIONS.ja.md)を使用する。Macの実行には改めて利用者が明示した実行時間を使い、入口は `npm run test:e2e:batch`、データは新規一時領域。今回masterへのマージ・実データ導入・Lv5実装は進めない。
