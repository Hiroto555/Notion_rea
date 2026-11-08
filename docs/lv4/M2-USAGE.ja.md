# M2 第1区切り：モデル実行と使用量

2026-11-08。OpenCode Go / Devin CLIが返した値を保存する。**金額・残枠・節約率・計算速度の比較ではない。** 中断時の未報告stepは不明であり、0として総量を保証しない。Codex親の使用量はこの外部CLI集計に含まれない。

## 実行数と受け入れ

- OpenCode Go `opencode-go/deepseek-v4.1-flash` / `high`: **18実行**。
- 受け入れ: 新規製品モジュール3本（inventory/probe/budget）、独立試験3本（journal/partial/製品適用）、実ソース読取調査4本。
- 不採用/やり直し: permission path不一致の未読調査2本、実装探索で中断したJ1/J2の初回と修正版4本、採用可能なコードを得なかったtool-free生成2本。これらの報告済みtokenも集計に含める。
- journal/partial本体はCodexが実装した。Flashの実装成果として水増ししない。J9/J10はstep上限に達して最終文章が無いが、実際のread/test tool出力とファイルを親が確認した。J10の2件PASSは親の統合検証でも確認する。
- Devin CLI `claude-opus-5-5-medium`: 方針/契約の2相談。`claude-opus-5-5-high`: 差分・修正差分・最終条件の3相談。同じsessionのexportは累計であり、重複加算しない。

## CLIの報告フィールド

Flashの18実行のresult JSONにある `step_finish.tokens`、152stepを合算したスナップショット。

| フィールド | 報告値 |
|---|---:|
| input | 573,730 |
| output | 54,862 |
| reasoning | 106,911 |
| cache.read | 3,105,664 |
| cache.write | 0 |
| total | 3,841,167 |

`total`と各内訳を足さない。J2生成実験は報告済みstepが0で、実際に無使用だったという意味ではない。中断した未完stepの課金/消費をこの表から推定しない。

Devinの最終export `final_metrics` の累計（同一sessionの過去exportを足さない）。

| フィールド | 報告値 |
|---|---:|
| total_prompt_tokens | 258,472 |
| total_completion_tokens | 29,949 |
| total_cached_tokens | 119,711 |
| total_steps | 19 |

各CLIでtokenの意味とcacheの内包関係が異なる可能性があるため、FlashとDevinを足して単一の使用量にしない。料金表・実請求・追加課金有無の監査は行っていない。追加課金設定、利用枠、モデルのグローバル設定は変更していない。

## 使用量を抑えるために行ったこと・次の改善

- 隔離worktreeと担当ファイルallowlist。共有transport/型/IPCは親が所有し、同じ既存ファイルを並列で書き換えない。
- 最大4job、個別cache、workerは対象テスト/maxWorkers=1。全体quietは統合後にまとめる。レビュー継続は差分と検証結果を中心に渡す。
- 探索に偏ったJ1/J2は中断して再分担した。探索/生成の試行分まで節約できたとは言わない。
- 次回は共通契約を固定し、既存ファイルの長文再読を減らす。実装が始まらないjobを繰り返すより、親の実装＋Flashの独立故障試験へ早く切り替える。

生のjsonl、会話export、prompt、stderr、owned PID、各worktreeはローカル `Folio-next-parallel-20261108.*` に残す。秘密情報や個人環境が混入する可能性を考え、丸ごとはGitへ保存せず、この集計と必要な検証証拠だけを残す。
