# 7回のOpus相談の採否ログ

2026-11-08、計画のレビュー。製品試験・Mac受入のPASSではない。Opusの出力には、現行との不一致や過剰な断定もあった。以下の補正を統合文書へ反映し、未補正の原文は参照の既定にしない。

| 論点 | 判断 | 理由 |
|---|---|---|
| 小さなMac PoC＋外部watchdog | 採用する計画 | GUI実行先と実Keychain証拠を切り分ける。現用MacでのGUIは始めない |
| 新規branchへworkflow_dispatchだけ置く | 前提にしない | default branch上の定義/登録条件がある。専用PR＋固定対象を候補にする |
| PRのGITHUB_SHAを製品候補と同一視 | 不採用 | merge refとheadを区別し、製品source/build inputs/artifactとharnessを別に記録 |
| 既定Playwrightで実Keychain PASS | 不採用 | 内部mock switchの効果を確認。argv不在だけでは足りず、実アクセスと対照条件が必要 |
| warm processは必ず継続／lockで必ず失敗 | 不採用 | key状態とprocess寿命を別に観測し、API利用不能時の保留を確認する |
| 赤ボタン後の常駐 | 不採用 | 現行index.tsはwindow-all-closedでapp.quit。失敗時再表示を分ける |
| sleep中もrunner/SSHを保持 | 前提にしない | 端末local harness、独立したS/復帰手段、復帰後回収を計画 |
| backup満杯＝永久停止 | 不採用 | 検証済みbackupの外部退避が現行にある。実寸/物理空き/形式上限は別 |
| backup watermarkだけで安全prune | 保留・不足 | live依存/参照blob/offline/保存先可用性/再照合を別に証明する必要 |
| 旧server封印で跨epoch再送も冪等 | 不採用 | 失ったreceiptは戻らない。既存wire/fingerprintの変更も今回対象外 |
| recovery100MiBを全backupへ適用 | 不採用 | M1回収と通常workspace/server完全backupは別形式/別上限 |
| 新workspaceへ既存recoverで移行 | 不採用 | 現行rebindRestoredはworkspace ID一致を要求。lossless移行は別機能 |
| 同じ14反例・seed・判定器 | 採用する比較設計 | B/Cの内部乱数に左右されないintent-level scheduleを事前生成 |
| BとCの最終JSON完全一致 | 不採用 | engineごとに合法な同時挿入順が違い得る。同じ合法集合と各engine内収束で判定 |
| 全caseをSAFE_REFUSEで通過 | 不採用 | 必須受理の正常系が必要。例外拒否で機能欠落を隠さない |
| state vector/provider syncedをACK | 不採用 | local/serverのdurable receiptを分ける |
| revoke後に届く全bytesを禁止 | 不採用 | cut前に送信済みのbytesは取り戻せない。cut後の新規認可を制限 |
| seq数値単独・進んだheadのdigest比較 | 不採用 | epoch/resourceと同じcutへ束縛して照合 |
| 公開7日以上なら依存を採用 | 不採用 | 実際の版/互換/license/fixtureが根拠。日数閾値は導入しない |
| 全waveやネットreadごとに再承認 | 不採用 | すでに許可された読み取り・文書の範囲では継続する。課金/GUI/実データ/mergeの未許可操作へは進めない |
| カードをM1〜M5と再命名 | 不採用 | 既存milestoneと衝突するためMAC-Pxx/EXP-Pxxへ分離 |
| 製品main診断hookを先に追加 | 既定にしない | 外部harness/既存契約での観測を先に検討。追加は必要性と影響を別レビュー |
| 資料SHA変更で全試験失効 | 不採用 | artifact/署名/対象harness/OSと変更影響で再受入を決める |

## 根拠の扱い

- 現行source：src/main/index.ts、src/sync/workspace-store.ts、src/sync/protocol.ts、現行workflow・tsconfig・lockfile。
- 既存文書：M3-ACCEPTANCE、M3-OPERATIONS、Mac無干渉計画、2026-11-07のLv5計画と14反例。Lv5の古いAPI行番号を現在の証拠へ流用しない。
- [GitHub公式のworkflow手動実行条件](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)。初回登録と別ref実行の条件を分けて確認する。
- それ以外のlibrary機能/版/causal validation可能性は次の比較時に一次資料とfixtureで確認する。今回の思考結果から実装済み・安全性証明済みへ格上げしない。
