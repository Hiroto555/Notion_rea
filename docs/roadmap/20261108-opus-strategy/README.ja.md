# Folio：Opus戦略ラボの統合結果

2026-11-08。利用者の「Opusの頭脳を今のうち使う」を受け、Devin CLIの **claude-opus-5-5-xhighへ6本並列＋統合反証1本、計7回**を実行した。すべてCLI exit0・exportあり。Codexが現行source・既存計画と照合し、採否を分けた。モデルの完了は実装/試験の合格を意味しない。

**今回は文書のみ。製品コード・依存・workflow・実データ・課金設定・masterを変更せず、このMacでGUIを起動していない。** 現在地は[M3最終受入待ち](../../lv4/M3-ACCEPTANCE.ja.md)、確認済みLevelはLv3のまま。Mac/物理2台も、以下の将来研究もNOT_RUN。

| 相談 | 次の判断に使う成果物 |
|---|---|
| Mac受入 | [限定PoC・実Keychain・終了・watchdog・起動経路](01-MAC-ACCEPTANCE.ja.md) |
| Lv4長期運用 | [保持上限・外部退避・移行/compactionを混同しない設計](02-LV4-RETENTION.ja.md) |
| Lv5方式比較 | [B/C共通の14反例、必須受理/許容拒否、traceと採否](03-LV5-COMPARISON.ja.md) |
| 保存・権限 | [3つの障害順序、永続化・失効・incarnation・receipt](04-LV5-SAFETY.ja.md) |
| 停止点 | [現在で凍結／Lv4保守／長期運用／Lv5比較の選択肢](05-STOPPING-POINTS.ja.md) |
| 並列担当 | [Codex/DeepSeek/Opusへの12枚の担当カード](06-DISPATCH-PACK.ja.md) |

[採用・保留・不採用と照合理由](DECISION-LOG.ja.md)、[実行/使用量記録](model-usage.json)。raw prompt・会話・未補正の出力はrepoへ入れず、ローカルの計画用rootだけに保管した。この6文書はそのままの原文ではなく、Codexによる統合メモ。

## 一番価値のある次の区切り

**優先1：Mac PoCの最小一式。** MAC-P01〜04のguard・証拠・外部watchdogを非GUIで具体化し、その後に別ホスト上の1jobへ接続する案。製品mainへのhook追加を既定にせず、起動/保存と実Keychainの証拠を別にする。新規branchのworkflow_dispatchがそのまま使える前提を避け、master未マージの専用PR経路を検討する。実行は今回始めない。

**優先2：機材待ちの間のLv5比較仕様。** V01〜V05を引き継ぎ、B/Cに同じintent/scheduleを与える。まず必須の正常受理と、回復可能な拒否を許す例外を決める。Yjs・CRDTを思考上の優劣だけで採用しない。将来の隔離scratch実行と製品実装・Lv5認定は別の判断。

**条件付き：長期運用対策。** 次回backupの実寸と増加速度から、どの上限が先に来るかを測る計画を作る。既存の外部退避で足りる場合は、新しいbootstrapを追加しなくてよい。新workspace移行やcompactionを「現在ある安全な手順」として扱わない。

## 守る区切り

- M3受入待ちで候補を凍結して止める選択も有効。Mac試験基盤/受入/発見時の修正が残っており、「証跡を取るだけで必ず終わる」とは約束しない。
- 既存のL4-01〜12、V01〜V15、L5-01〜14の意味を変えない。新しい担当カードは別prefixで識別する。
- Lv5の2〜5人・単一server等は初期案。Lv6は暫定であり、最終仕様や実装順を勝手に確定しない。
- 新しい実行の前に具体的な範囲を固定する。すでに許可された読み取りや文書整理に、繰り返し承認を要求する運用は採らない。
- 推奨案・Nodeの結果・Mac OS操作・物理2台の証拠を分ける。docsだけの変更を、全製品試験の失効とも新しいPASSとも扱わない。
