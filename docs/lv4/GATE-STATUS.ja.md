# Lv4 Gateの現在の証拠と最終受入

2026-11-08。**M3最終受入待ち、Lv4未認定。** [製品候補と証拠](M3-ACCEPTANCE.ja.md)で非GUI2,078件・Linux GUI238件を受入した。以下の部分確認はMac/物理2台を含むGate全体の合格ではない。原本master・実データ・このMacのGUIは使用していない。

| Gate | 状態 | 取得した証拠 / 最終受入で残すもの |
|---|---|---|
| L4-01 | 部分確認 | quiet/buildと既存GUI全体・DnD・保存/復旧のLinux回帰PASS / Mac OS操作 |
| L4-02 | 部分確認 | rich内容/records/添付・履歴の実HTTP/Node統合 / 物理2台の双方向全データ照合 |
| L4-03 | 部分確認 | ACK喪失・echo・同一操作照合・再起動・SIGKILL / 実回線/スリープ |
| L4-04 | 部分確認 | 入力/unknown保存/構造操作/recovery gate、Linux composition合成 / 実IME・OS入力途中 |
| L4-05 | 部分確認 | 稼働中は送受信のみ、実IPCの保存/保守排他とwindowless適用 / 実Mac終了経路 |
| L4-06 | 部分確認 | 両候補と最新localを保全、勝者確認/明示予約、archive回収/復元・同一ID照会 / 2台の同時更新とOS導線。完全diffは初期範囲外 |
| L4-07 | 部分確認 | 添付再開/hash/容量/所有/中断/明示解放、大容量実ファイル / 実スリープ・通信断 |
| L4-08 | 部分確認 | 通常完全backup→新clientコピーrecover、server完全restore/fresh epoch/全旧端末失効、旧queue自動再送拒否 / 物理2台で手順再現 |
| L4-09 | 部分確認 | workspace/device/schema拒否、外部暗号化vault、実Secret Serviceとbasic拒否、コピーDBの秘密分離 / Mac Keychain |
| L4-10 | 部分確認 | 固定fixtureのcheckpoint/送信/Node windowless startup/完全backup/回収復元の時間・増加量・RSS / Mac実起動・描画と実通信の性能 |
| L4-11 | 部分確認 | 接続/保留/未確定/競合/予約の実UI/IPC、運用CLIと手順 / OS側での設定と回復 |
| L4-12 | NOT_RUN | 同じ候補の物理Mac2台・実SSH・スリープ・回線切替・復元再登録は未実行 |

同一UIDによる任意改竄全般への防御や、fsyncによる実停電耐性を主張しない。[Mac項目](GUI-MAC-ACCEPTANCE.ja.md)、[運用手順](M3-OPERATIONS.ja.md)を用い、一時データと明示された実行枠で最終受入する。masterへのマージ判断はその後に別途行う。
