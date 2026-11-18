# M3：外部モデルの分担とUsage

2026-11-08。Codexが契約・共有型・main/IPC・既存同期経路・統合・受入を所有し、OpenCode Goの実CLIでDeepSeekを並列実行、Devin CLIの実Opus 5.5で方針と安全性をレビューした。モデル名を付けた別モデルへの代替ではない。

## DeepSeek

モデルは `opencode-go/deepseek-v4.1-flash`、variant `high`。初回8本の読み取り調査、その後48本の限定実装/GUI移植/独立試験。合計56 job。1 waveの上限は8、イベント時刻の重複で観測した同時実行ピークは10。大量の小jobに分け、統合ツリーへ同時書込みさせない。重いNode試験は共通2枠、個別cache、worker 1に制限した。

| providerが報告したカウンター | token |
|---|---:|
| input | 3,635,155 |
| output | 372,810 |
| reasoning | 776,465 |
| cache read | 38,312,828 |
| cache write | 0 |
| reported total | 43,097,258 |

input/output/reasoning/cacheを別の報告値のまま保持する。これを独自に請求tokenへ変換しない。報告のないstep token recordは0件。各jobのtoken・終了code・時間・差分ファイル・tool error・step上限メッセージは[集計JSON](validation/m3-model-usage-20261108.json)に保存した。

43 jobにworktree差分、13 jobに差分なし。読み取り調査・探索で上限到達・権限制約で書けなかったjobも含む。CLI exit 0は採用・試験合格を意味しない。GUI接続/終了の一部、vault・catalog・CLIの接着、並列成果の不具合修正はCodexが引き取った。D37の競合状態更新とD38のcache計数は親側で試験・修正してから受入した。失敗jobを集計から除いて成功率や節約効果を見せない。

主な分割はR1〜R8（契約調査）、D01〜D38＋D09b（所有ファイルを限定したmodule・UI・独立故障/容量試験）、G01〜G09（既存GUIのLinux移植・新M3実IPC試験）。共有のindex/App/types/protocolを複数workerへ同時担当させなかった。

## Opus 5.5

方針 `medium` 1回、契約・ソース安全性・完全復元・最終差分の `high` 4回、計5回の完了exportを確認。重要な境界で相談し、同じ全ソース・全会話を毎jobへ反復送信しない。[指摘と採否](reviews/OPUS-M3-REVIEW.ja.md)に、採用したP1修正と採用しなかった保証を記録した。exportの報告値の合計はprompt 196,992、completion 72,603、cached 63,520。Devinの各exportのカウンターをそのまま集計しており、独立した請求明細やcache包含関係を推定していない。短命の起動で出力/exportが残らなかった1試行はusage不明として別記し、0とは数えない。

料金・割引・利用枠の増減・節約率・並列化による速度倍率は測定していない。ここに示すのはCLI/providerの実行記録であり、請求明細ではない。追加課金設定・global設定を変更していない。大量並列は実装候補と独立試験を増やす用途で使い、削除・秘密・復元の最終判断はCodexと安全性レビューへ集約した。
