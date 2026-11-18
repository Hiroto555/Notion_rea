> 計画作成時のDeepSeek提案の原文。採用済み仕様ではありません。誤り・未採用部分は[計画レビュー記録](../../M1-PLANNING-REVIEW.ja.md)を参照。実装・試験実行なし。

## M1 独立試験計画案（最終）

**最優先の失敗ケース（入力／操作／期待結果）**

| # | 入力/操作 | 期待結果 |
|---|---|---|
|1|A1 intent存在中に別processが同UIDへunlink成功後、create(read→write) | readbackが別内容を検知し `409`、上書きせず `blocked` |
|2|A1 SQLite予約行+本文差分ありの状態で電源断→再open | 予約と本文が同一COMMITで揃い、原子適用か完全無し |
|3|A2 archive内 checkpoint改ざん・manifest欠損 | `valid=false` となり書出し拒否 |
|4|添付がmissing/bytes不一致 | 検証失敗で復元停止・途中成果物を残さない |
|5|復元=新規v4 DB+内容11表+新local設定のorigin marker有 | 環境変数があってもstartup同期保留、outbox空 |
|6|復元中kill→再open | 部分適用せず初回から冪等にやり直し |
|7|容量不足／空白・unicode特殊path | 事前容量検証し失敗時クリーン、`invalid-path` |
|8|sourceのsettings/秘密/outbox/予約/未保存入力 | 復元先に持ち込まれない |

**API固定で先行可能な並列対象**
`sync/protocol`（identifier/canonicalJson/hash/revision）、`durable-file`、`pending-journal-file`、`workspace-checkpoint`検証、共有型（conflict-view/backup/intent）が固まれば、A1原子性・A2検証の独立モジュールとテストを並列開始可能。

**誤った成功判定**
`blocked`をready扱い／validを緩和／復元完了をファイル存在のみで判定／添付hash未検証で成功宣言。

**scope拡大の危険**
settings一部持込み、GUI・Electron・A3実装、実データ・master変更、同一UIDへのOSレベル防御過剰主張。

---
初回4並列で計測後に増加、各worker `maxWorkers=1`、各job編集allowlist・同一契約commit・差分/ログ/未確認点を必須とします。
