# Mac受入を実行可能にする最小設計

2026-11-08。Opus 5.5 XHighの提案をCodexが既存コード・計画へ照合した設計メモ。**計画のみ・未実装・試験NOT_RUN。新しい実行範囲の承認ではない。** 製品候補bd65b73、master e269137、Lv4未認定を維持する。

## 次の一区切り

別ホスト上での起動・保存・正常終了と、実Keychainを区別する限定PoC。新しい製品機能より先に、実行先guard・証拠schema・外部watchdogを用意する案。現用Macは管理専用。

| case案 | 立証すること | 立証しないこと |
|---|---|---|
| MAC-H1 | Darwin app起動、保存revision/内容hash、正常終了、新PIDで再読込 | 実Keychain、実Cmd+Q/IME/native picker |
| MAC-H2 | mockを使わない実暗号化、指定Keychainへの実アクセス、別processでの復号、平文token露出なし | 同一processのcacheだけによる成功、署名変更後の互換性 |
| MAC-H3 | key項目状態とprocess寿命を分け、利用不能時の保留/暗号文維持、外部watchdogの停止・証跡 | ロックしただけで必ず失敗する保証、watchdog成功を製品の正常応答とすること |

- 新process/既存processと、key項目の有無/lock/拒否を別軸で記録する。cache継続の成否は実測し、勝手に必須にしない。
- stock Playwright loaderのままのMac試験は実Keychain証拠へ流用しない。有効switch・実アクセス・独立process・対照条件を確認する。main attachやargvの不在だけを証明にしない。
- 製品main/preloadへの診断hookは既定案にしない。外部harness/既存UI・IPC・OS側観測を先に検討し、足りない観測は別差分としてレビューする。成立しなければNOT_RUN。
- safeStorage同期APIがmainを止めても監視できる親processで期限を管理。取得可能なstack・所有PID・最終状態を保全し、所有processだけ停止する。原因不明timeoutはUNRESOLVEDで非PASS。環境由来か製品由来か判明した後に分類する。
- 最終window閉鎖はapp.quit。正常終了/Dock新規起動、入力での閉鎖拒否、予約確定失敗の同PID再表示を別caseにする。
- sleep/回線変更はA/B端末localの手順と証跡で進め、常時稼働Sと独立した復帰手段を用意する。SSH/job接続の維持を合否条件にしない。

## master未マージでの実行経路

新規workflow_dispatchを未登録の作業branchへ置くだけで実行できるとは扱わない。GitHub公式はdefault branch上の定義を前提にしている。既存のPRイベント経路を使った専用・信頼済みPR＋固定対象SHA＋少数のhosted jobを先行候補にする。現在はworkflowもジョブも追加・実行しない。

[GitHub公式の手動起動条件](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)。登録済みworkflowの別ref実行と、新規workflowの初回起動を区別する。

## PoCへ渡す固定対象

製品commit/source tree/build inputsのdigestと、harnessのcommitを分けて記録する。PR既定のGITHUB_SHA（merge ref）を凍結製品と同一視しない。checkout対象を明示し、初回の指定sourceから作った実artifactのhash・署名・builder環境を記録する。同じsourceを再buildしただけでbit単位に同一artifactになるとは保証しない。

PoCは1job/worker1、実行時間上限・再試行0・対象path/branch/SHA・concurrencyを明示する案。新Macworkflowのpath制限だけでは、現在の既存Linux workflowの自動起動は止まらない。CI起動範囲の変更はCodexが別のconfig差分として扱う。
