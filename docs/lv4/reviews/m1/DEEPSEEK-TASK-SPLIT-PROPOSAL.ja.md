> 計画作成時のDeepSeek提案の原文。採用済み仕様ではありません。誤り・未採用部分は[計画レビュー記録](../../M1-PLANNING-REVIEW.ja.md)を参照。実装・試験実行なし。

前提: 基準732fad5、Lv3確認済/Lv4途中。M1はA0/A1予約、archive検証付き書出し、別新規領域への復元まで。GUI/Electron/実データ/master/A3は対象外。12jobは6束に統合し、共通部はCodex単独所有、DSはisolated worktreeで独立モジュール＋専用テストに限定する。

| Job | 依存 | 担当・単独所有 | 終了条件 | 波/並列 |
|---|---|---|---|---|
| J0 契約固定 | なし | Codex: shared型/IPC/Store interface/契約文書 | API署名・型・エラー・schema方針を確定し契約commit。依存実装は未着手 | W0単独 |
| J1 Store CAS＋同一COMMIT | J0 | Codex: Store/main | SQLite CASと本文適用を同一COMMIT、旧sidecarはblocked保持、競合試験合格 | W1 |
| J2 intent差替え | J0 | DS1: workspace-sync-intent＋専用テスト | read→unlink差替え、再試行・不同intent保持、残存リスク明記 | W1 |
| J3 archive一覧→検証付き書出し | J0 | DS2: conflict-export＋専用テスト | hash再検証、picker後auth再確認、添付本体を含まない旨を明示 | W1 |
| J4 新規v4復元 | J0 | DS3: restoreモジュール＋専用テスト | 内容11表・新identity・origin marker、startup sync保留。settings/秘密/outbox/予約/未保存入力を持ち込まない | W1 |
| J5 独立試験 | J1〜J4 | DS4/DS5: testのみ | データ整合、復元差分、競合・否認系、env時のsync保留を検証。shared無編集 | W2で2並列 |

重要注意:
1. J0契約commit前はJ1〜J4着手禁止。各jobは編集allowlist・同一契約commit・差分/ログ/未確認点を必須とし、API変更はCodexのみ。shared編集が必要になった時点で停止。
2. 同一失敗2回、差分なし、API不明、未確認点残で停止。12〜24人時は粗い概算で実時間保証なし。初回4並列で計測し最大6。workerはmaxWorkers=1、全体quietはCodexのみ。
3. archiveはcheckpoint JSON＋manifestであり添付本体の完全保全ではない。FullBackupを同期archive/全backupと呼ばない。同一UID writerへのOS防御を過剰主張せず、復元は別領域・同期無効・envがあってもstartup sync保留を試験する。
