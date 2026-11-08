# 次回実装の担当カード（提案のみ）

2026-11-08。Opus 5.5 XHighの提案をCodexが既存コード・計画へ照合した設計メモ。**計画のみ・未実装・試験NOT_RUN。新しい実行範囲の承認ではない。** 製品候補bd65b73、master e269137、Lv4未認定を維持する。

この12カードは実行依頼ではない。M1〜M3/V01〜V15と番号を衝突させず、MAC-Pxx/EXP-Pxxを使う。pathは将来の置き場所の案で、着手時に実ツリーへ割り当てる。

| ID | 担当 | 専有する成果物/置き場所の案 | 依存・終了条件 |
|---|---|---|---|
| MAC-P01 | Codex | 証拠schema/実行先guard契約、scripts/mac-acceptance/policy/ | 現用Mac拒否、専用host/一時path/期待件数をNodeで検証 |
| MAC-P02 | Opus | OS/Keychain/終了の反例仕様、docs/acceptance/mac/ | L4番号・観測・期待値の対応、未実行を明記 |
| MAC-P03 | DeepSeek | validator/良悪fixture、tests/acceptance-metadata/ | MAC-P01後。VMやmockを物理2台PASSにする悪fixtureを拒否 |
| MAC-P04 | DeepSeek | 外部watchdog/所有process停止、scripts/mac-acceptance/watchdog/ | MAC-P01後。Node疑似hangで期限/証跡/停止を検証、GUIは起動しない |
| MAC-P05 | Codex | 起動/Keychain/手動OS/A-B-Sの接続、tests/acceptance/macos/ | MAC-P01〜04後。製品mainを変えない第一案。実GUIは別の環境限定指示後 |
| EXP-P01 | Opus | V01範囲/非目標、scratch/contracts/scope/ | private不変、人数/方式は仮説と明記 |
| EXP-P02 | Codex | V02一次資料/互換/license/lock、scratch/manifest/ | EXP-P01後。版固定と実fixtureを根拠にする。公開日数ルールは置かない |
| EXP-P03 | Opus | 共通14反例/必須受理/許容拒否、scratch/contracts/scenarios/ | EXP-P01後。全部拒否で合格にならない判定契約 |
| EXP-P04 | Codex | 決定的scheduler/判定/trace/replay、scratch/harness/ | EXP-P03後。反例前提と因果関係を維持して最小化 |
| EXP-P05 | DeepSeek | Bの候補adapter/往復、scratch/adapters/b/ | EXP-P02/EXP-P04後。共通harnessを書き換えない |
| EXP-P06 | DeepSeek | Cの候補adapter/往復、scratch/adapters/c/ | EXP-P02/EXP-P04後。Bと同じ入力/予算/判定器 |
| EXP-P07 | Opus＋Codex | V05採否ADR/未解決/停止判断、scratch/decisions/ | EXP-P05/EXP-P06の実trace後。思想だけで方式を採用しない |

## 実行を管理するときの規則

- 共有型・main/preload・既存protocol・config・harnessの改変/統合はCodex一人が所有。独立fixture/adapterだけをDeepSeekへ並列に渡す。
- Mac GUI案は既存Linuxのtests/e2e/**/*.spec.tsへ無条件で混ぜない。Mac専用directory/configを選び、runtime skipで件数を隠さない。central configとworkflow接続はCodex所有。
- heavy Nodeは2枠、GUIは別hostごとに1枠。独立した設計相談は並列にできる。
- task packetに現在の利用者指示、AGENTS/必要文書、所有path、入力契約、許可command、STOP条件、報告先を同梱する。古いquiet文書の履歴を現在の指示へ取り違えない。
- allowlistはcanonicalな作業ツリーの所有範囲で検査する。許可済みツリー内のabsolute pathを一律拒否せず、symlink等で外へ出るaliasを拒否する。
- 早く成果物の骨格を作り、探索上限と権限拒否の反復を止める。報告はstdoutまたは許可した専用fileへ。allowlist外のBLOCKED.mdを強制しない。
- 失敗/無編集/上限到達/再投入を全て台帳に含める。CLI exit0、テスト0、別OSの結果をPASSにしない。cache/read/output/reasoningは報告値を分け、未取得は不明。
- すでに許可されたread-only調査やreversible文書整理のたびにユーザーへ再承認を求めない。GUI/実データ/課金変更/mergeの未許可範囲へは進めない。
- 同じ失敗promptをそのまま回さず、入力・権限・task境界を修正してから再投入する。

## 再受入の原則と現在のCI動作

| 変更するもの | 必要な再確認の原則 |
|---|---|
| 文書のみ | link/JSON/差分を確認。製品のPASSを更新したことにしない |
| 製品src・lock・build/署名 | 新artifactのprovenance、quiet/Linux GUIと影響するMac/実機caseを再受入 |
| Mac harness/config | Mac caseとcross-platform型検査・GUI guard。Linuxのinclude globへの影響を確認 |
| isolated scratchだけ | scratchの比較/traceを再実行。製品へimportや依存更新をしない |

これは希望する検証範囲の原則。現在のPR workflowには無条件起動があり、doc pushでも実行され得る。今回の計画文書はpushせず、CI節約を実施済みとは主張しない。TypeScriptはtests全体を対象にするため、Macのspecを別directoryへ置いても型検査から自動的に外れるわけではない。現行のVitest/include/Playwright設定を読んで接続を決める。存在しないlint commandをゲートに足さない。
