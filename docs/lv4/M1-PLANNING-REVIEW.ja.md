# M1計画のレビュー・提案と採否

> 後続の実装・受入は[M1完了記録](M1-COMPLETION.ja.md)、[実装のSolレビュー](reviews/m1/SOL-XHIGH-M1-REVIEW.ja.md)に記録した。以下は実装指示より前の計画レビューとして残す。

2026-11-08。対象は基準 `732fad5` からの**計画作成だけ**。実装・製品試験・GUI実行の記録ではない。計画と担当表は [実行計画](M1-EXECUTION-PLAN.ja.md)、[担当カード](M1-DISPATCH-PACK.ja.md)。

## 実施したことと未実施

- Codexが現在のコード、保存済み計画、既知の安全性残件を読み、終了条件・契約・12jobの割当を作成した。`beyond-vibe-coding-review`の責任分界・仕様・検証・自律性境界の観点を適用。
- Sol `gpt-6.1-sol` / `xhigh` がread-onlyで独立レビュー。実装、試験実行、ファイル書込みは行っていない。
- OpenCode GoのDeepSeekへ2本並列で、担当分割と独立試験の提案を依頼。toolsはdeny、外部pluginsなし、製品ツリー外の計画用cwd、自己完結した入力だけを使用。書込み・試験・追加調査を依頼していない。
- 製品の実装worker、worktree作成、schema変更、Node／SQLite試験、全体quiet、GUI／Electron、実データ操作、commit／push／mergeは、この計画作業では**NOT_RUN**。前回の1,509テスト／CI成功を今回の新しい結果として扱わない。

## Solの主要指摘と計画への反映

| 指摘・根拠 | 採った対処 | 担当・終了条件 |
|---|---|---|
| 通常sidecarのread→unlinkは原子的な条件付き削除ではない。inode再検査だけでも直後のrename競合は残る。`src/main/workspace-sync-intent.ts:73-90` | 通常writerをSQLite CASへ。本文／appliedとconsumedを同一transaction。旧sidecarは自動実行・削除・移行せずBLOCKED保全 | D02／C1／D09、M1-02〜04 |
| 通常・競合の排他をmainの事前観測だけで判定するとreserve／consumeの交差が残る。現行通常経路は適用後cancel結果を無視する。`src/main/workspace-sync-restart.ts:40-60` | 双方のtransaction内でも相手journalと期待レコードを検査。COMMIT応答不明は再open照合で回収 | C1／D09、M1-03 |
| 既存full backupの復元はDBをそのままコピーし、identity／outbox／settingsを除去しない。`src/persistence/full-backup-restore.ts:351-393` | full backupの丸コピーを使わず、固定schemaの新規v4 DBへ内容11表を構成。source DDL・秘密・予約・送信待ちは持ち込まない | C0／C1／D07／D11、M1-09〜10 |
| v5は全sync tables／state／guard triggersを要求する。sync stateなしのv5復元は不整合。`src/persistence/schema-startup.ts:18-31,186-191`、`src/sync/workspace-store.ts:305-328` | v4のschema構成順をCodexが所有。再open同値だけでなく、使い捨て復元先の通常保存・履歴追加も検証 | C1／D07／D11、M1-09 |
| ローカルarchiveの現入口はtransport／readStateに依存し、rebindはarchivesを削除する。`src/main/workspace-sync-service.ts:86-88`、`src/sync/workspace-store.ts:364-370,741-760` | 同期登録・再接続なしで読むmainのローカルservice。pagination、破損行の隔離、対象tuple＋hashの固定 | D03／C1／D10、M1-05〜06 |
| 既存asset copyはpathのlstat後にpathをreadし、開いたFDの検査を持たない。`src/persistence/full-backup-create.ts:78-103` | 添付入力はFDのregular／size／nlink、stream hash、出力再検証を契約化。既存の耐久出力部品だけを条件付きで再利用 | D05／D10、M1-08 |
| v4でsync stateがなくても、後の起動でFOLIO_SYNC_*からpublish／joinへ進み得る。`src/main/workspace-sync-startup.ts:20-21,51-60,142-145` | destinationが新規生成するprivate設定に回収由来marker。strict codec／一般setting IPC拒否、startupとmanual reconnectで共通guard。M1では解除しない | C0／C1／D07／D11、M1-10 |
| 上限・予算・レビュー候補が曖昧だと並列数だけが増える。`src/sync/protocol.ts:5-7` | 既存bytes上限維持、仮bundle上限、同一候補hash、4→6本、修正回数・usage・工数・時間の再評価地点を固定 | C0／C2／S0〜S2、M1-01／12 |

Solは修正後の実行計画について、**計画上の未解決P0/P1なし**と回答した。回収marker、v4 schemaの単独所有、完了直前ticket再照合、markerのfsync故障を担当カードへ割り当て、追加のread-only確認でも「担当カードも計画として未解決P0/P1なし」と回答した。これは実装の安全性・性能・GUIの合格を意味しない。

## DeepSeekの実行記録

| 依頼 | モデル／推論量 | 結果 |
|---|---|---|
| 担当分割・依存・並列運転の提案 | `opencode-go/deepseek-v4.1-flash` / max | 240秒で最終回答なし。SIGINTで中断、exit -2。提案を得た／実装したとは扱わない |
| 独立した故障試験表の提案 | `opencode-go/deepseek-v4-pro` / max | 240秒で最終回答なし。SIGINTで中断、exit -2 |
| 担当分割の短い最終提案を同sessionへ再依頼 | Flash / high | exit 0、112.0秒、最終回答1,238文字、reason stop。ツール実行なし |
| 故障試験の短い最終提案を同sessionへ再依頼 | Pro / high | exit 0、30.2秒、最終回答1,045文字、reason stop。ツール実行なし |

保存資料：[担当分割提案の原文](reviews/m1/DEEPSEEK-TASK-SPLIT-PROPOSAL.ja.md)、[故障試験提案の原文](reviews/m1/DEEPSEEK-FAULT-PROPOSAL.ja.md)、[呼出し結果・usage](reviews/m1/deepseek-planning-runs.json)。推論量は要求したvariantであり、初回maxと縮約後highを混同しない。

初回2本とも時間上限へ達したため、今の環境で「並列数を増やせばすぐ速くなる」とは評価しない。実装開始時はjobを短くし、最初の受入2件で待機・出力・統合時間を測る。CLIの終了コード、最終回答の有無、提案の正しさは別の判定とする。生のsession JSONLとプロンプトはローカル計画保全先に留め、GitHub向け文書へはそのまま混ぜない。

## 独立試験案の採否と、親が固定する期待結果

Flashからは契約先行、共通部のCodex所有、固定基点・allowlist、独立試験担当、初回4→6本、同じ失敗の繰返しで停止という運転案を採用した。一方、既存`workspace-sync-intent`の修正をDeepSeekへ分ける案と、export／verify／importを依存なしで同時着手する表は採用しない。新journalと旧形式の保全停止を混ぜず、12jobは担当カードへ分け、契約と受入済み部品の依存を維持する。提案中の12〜24人時は旧概算で、今回具体化した20〜36人時を現行案とする。

DeepSeek Proの短い提案には、SQLite原子性、破損／欠損添付、復元先への禁止情報の持込み、markerによる同期保留、容量と中断の観点が含まれた。一方、次の期待値は採用しない。

| 提案の問題 | 固定する期待結果 |
|---|---|
| unlink後のreadbackで409になればA1解決、というsidecar中心の期待 | 旧sidecarは実行・削除をしない。新予約はSQLite CASと同一transactionの効果で検証する |
| 添付失敗時に途中成果物を残さない／失敗時クリーン | 未完了出力を保全し、完成と区別する。自動削除・既存pathの掃除を成功条件にしない |
| 空白・Unicodeのpathを一律invalid扱い | 正規の空白・Unicodeは動作確認し、path逸脱・symlink・特殊file等の具体的な不正だけを拒否 |
| kill後は初回から冪等にやり直す | 結果不明は再照合。完了済みへ再適用しない。未完了の再開・掃除をM1へ自動追加せず、新しい試行は新規先で行う |

| 試験 | 操作 | 期待結果・主担当 |
|---|---|---|
| R01 | 別ID／別targetでcancel／consumeを交差させる | 別予約を変更しない。D09 |
| R02 | 通常予約と競合予約を二接続からreserve | transaction内で片方だけ成立。破損状態は保留。D09 |
| R03 | COMMIT直前／直後の応答喪失、再open | 本文／applied／consumedの一致を確認。二重適用なし。D09 |
| R04 | 旧sidecarの存在・破損・差替え | 内容と予約を保全してBLOCKED、unlink／applyなし。D09 |
| R05 | 多page・古いarchive・破損1件・巨大行 | 全件へ到達し、正常分を回収。無制限parseなし。D10 |
| R06 | ticket発行後と公開直前にrow／checkpoint／scopeを差替え | 再確認へ戻り、別内容の出力を成功にしない。D10 |
| R07 | JSONは正常、必要添付だけ欠損／hash不一致 | metadata-onlyとbundleを区別。復元は成功にならない。D10 |
| R08 | FD／path差替え・symlink／hardlink／特殊file・正常なUnicode先 | 不正は保全停止、正常なpathは成功。source・既存先を上書きしない。D10 |
| R09 | 容量見積り不能／ENOSPC／marker write・fsync失敗／kill | 未完了／結果不明として保全。公開済みか不明なら再検証で回収し、成功と即断・再適用・削除をしない。D10／D12 |
| R10 | 内容11表・添付を新規v4へ復元、close／reopen、通常保存 | 復元直後のhash同値、参照整合性、保存・履歴の正常動作。D11 |
| R11 | sourceに秘密／identity／outbox／予約／receipts／復旧入力 | destinationに持ち込まれない。新しい回収markerだけは意図的に生成。D11 |
| R12 | 回収先をFOLIO_SYNC_*付きで後日起動／manual reconnect | marker確認が登録・昇格・送信に先行し保留。marker破損も保留。D11 |
| R13 | 未接続で一覧→bundle→別領域復元→結果応答を喪失 | 原本不変、結果再照合、完了／未完了を区別。GUIなしで状態遷移。D12 |

## AI支援開発としての責任境界

この作業は既存データ保存機構の改修なので、探索用の試作として進めない。モデルに仕様・期待値・合格判定を一任せず、Codexが説明できる契約・差分・証拠を持つ。

| 観点 | Evidence／Risk | Fix・担当 |
|---|---|---|
| ownership | shared編集を多workerへ渡すと整合・責任が分散する | Codex単独所有、受入commit、許可外差分検査 |
| testing | 自分で書いたexportとverifyが同じ欠陥を共有し得る | 独立fixture／hash／故障担当D09〜12、Sol再レビュー |
| prompt-spec | 設計未確定で並列実装すると統合で作り直す | G0を先行し、CONTRACT_CHANGEで停止 |
| trust | 高い自律性でGUI／master／実データ／課金まで広がり得る | 権限・cwd・allowlist・実行記録を分離。M1以外を投入しない |
| mode-selection | Node合格が製品の画面・実機合格に読み替わり得る | GUI／実IME／実機2台はNOT_RUN、Lv3据置、M1で停止 |

OpenCodeの実行・権限設定はローカルV1と公式V2を区別する。[公式Agents](https://opencode.ai/docs/agents/)、[Permissions](https://opencode.ai/docs/permissions/)、[Goの利用枠](https://opencode.ai/docs/console/go/)を2026-11-08に確認。モデル一覧の存在は、速度・利用枠・料金・実装成功の保証ではない。
