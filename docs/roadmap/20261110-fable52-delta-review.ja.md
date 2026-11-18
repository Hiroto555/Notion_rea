# Fable 5.2 XHighの差分判断と採否

2026-11-10 JST。利用者の「もう一度だけFable5.2に判断させる、最初から全投入しない」という追加依頼への結果。**指定モデルでの生成を確認済み。製品実装のGoサインは未受領。** 認定Lv3、full共同編集NO_GO、GUI/物理機NOT_RUNを維持する。

## 判断

Fable5.2の結論は「追加条件をW0へ入れれば、Go承認にかけられる計画」。提示した事実への設計レビューであり、方式採用や試験合格ではない。以下を親Codexが既存契約と照合し、計画へ反映する。追加の追問は行わない。

| 指摘 | 親の採否・補正とW0追加契約 |
|---|---|
| 派生cell IDへ実体化側の順序を混ぜない | 採用。初期cell/内包blockのIDはtable/row/columnのincarnation付き論理identityと固定node種別/slot namespaceから決定的に導出し、実体化側のintent/attempt/commit_seqは混ぜない。削除したrow/columnの再作成は新identity、後から追加したblockも新identityとする |
| IDと内容の帰属はintent集合、位置だけが順序依存 | 範囲を限定して採用。同じ論理cell incarnationのIDは実体化順に依存しない。一方、一般の本文/delete/restoreまで集合だけで決まるとは扱わず、受理・存在・削除・内容は権威の順序付きlogで決める。pending本文を隣blockへ付け替えず、元IDへ保持できなければraw draftへ隔離 |
| 構造metadataとstepを同時確定 | 採用。列ID等のmetadata・派生PM step/head・receiptを同一transaction/commit_seqへ入れ、双方を覆う構造hashを持つ。shared構造を変える生PM stepの迂回経路を受理しない |
| materializationはcommit時に一度 | 採用。追随/reopenは保存済み実行結果/logをreplayし、現在頭へcommandを再実行しない。command入力と実行結果のcut/hashを区別してreceiptで確認し、PM versionは検証済みlog/receiptから進める |
| 削除IDは永久tombstone、構造Undoは新intent | 論理的非再利用とUndoは採用。無制限の個別記録保持は採用しない。旧writer/epochを拒否する永続fenceと圧縮済み削除証拠を設計し、旧要求が参照可能な間は根拠を消さない。証明できなければ保全停止。構造Undoは現在状態に対する新しい逆command intent |
| receipt不在は未適用の証明にならない | 採用。現PoCの不在時UNKNOWN停止を維持。再attemptの根拠は同一authority epoch内の永続的な確定拒否、または照会と同じtransactionで旧attemptを封鎖する無効化記録に限定。遅延した旧attemptを以後拒否できなければ再送しない |
| old backupはseqだけでは検知できない | 採用。authorityEpoch/commit_seq/prefix-chain hashをclient既知cutへ照合。同じcutのprefixだけを比較し、正常なhead進行を不正扱いしない。確認できた後退/不一致はepoch宣言なしでも停止。既知ACK欠落と証拠なしUNKNOWNを分け、原文/receiptを保全し自動healingしない |
| attemptがintentの正当な実体化か検証 | 採用。hash一致だけで許可せず、serverがscope/lifecycle/anchor/前提と実行内容の対応を検証する。同じintentを別編集へ付け替えない |
| 最小の永続写像 | 状態階層を補正して採用。serverはwriter/intent hash/状態/受理attemptとhash/epoch/cut/結果hashをlog/headと原子確定。attemptの拒否/無効化とintent全体の終端を区別する。clientは意図原文・attempt列・最終観測を送信前に永続化 |
| dedupはwriter fenceまで保持、ACK本文はbackup水位まで保持 | 復元可能性の証拠を加えて採用。receipt本文の圧縮で重複防止根拠を失わず、writer終端fence等を永続保持。clientの解放はbackupのepoch/cut/hash/復元検証済みmanifest、最小保持期間、独立証拠も照合する。単なるseqやbackup存在だけを根拠にしない。容量不足では保全/停止を選び、全証拠喪失の完全回復を保証しない |
| W1出口/両候補不合格時を固定 | 採用。下表をW0で固定。両方不適格ならfull Editor系列を保留し、保存/認可/Windows/Lv6/Lv3-4の独立系列を継続。排他編集leaseへ自動置換せず、共同編集やfull Lv5の代替合格としない |
| 契約/oracle変更は親も毎回ユーザー承認 | 不採用・補正。利用者のGo後に各waveで同じ再承認を求めない指示を優先。親も合否を黙って緩めず、変更理由/版/影響/依存成果の無効化と再検証を記録する。承認範囲内の具体化/欠陥修正は継続し、必須条件の緩和や範囲拡大を勝手に行わない |
| Windowsは現Macで全てcompile不能 | 未確認の断言は不採用。Go後に実toolchainで可能なTS/port/必要ならcross-buildを確認。native固有の未buildはBUILD_NOT_RUN、Windows OS実行はNOT_RUN。Mac回帰を確認し、未build候補を完成済みに算入しない |
| Bにbinding全面置換の懸念 | 未検証の条件付き懸念として維持。Yjs一般の不可能性は確定しない。既存bindingで成立しない場合、その系列の費用/範囲/停止を再評価し、汎用CRDT開発へ無条件に拡張しない |

## W1出口の判定案

| 対象 | 必須の観測 | 現在の状態 |
|---|---|---|
| R01 rich/seed/ID/viewer | 実schema/mark/raw境界、seed一度、viewer無変更、共有乱数補修なし | 新実装NOT_RUN |
| R02 move/pending | 両順序/分断で元blockの期待本文/IDを字句断定。split/join/delete+pendingも対応 | 旧B/Cは既知FAIL、新案NOT_RUN |
| R03 table | row/column追加が双方成功、合法形・旧cell内容・派生ID/metadata/step一致 | 旧B/Cは既知FAIL、新案NOT_RUN |
| R04 local Undo | remote内容保持、意味付き構造Undo/操作単位、拒否intent回収 | 新案NOT_RUN |
| R05 最小durable | 両adapterでintent/attempt/receipt再構成、ACK不明、不在照会、二重適用なし | 新案NOT_RUN |
| 候補適格性 | 必須結果が揃った方式だけを制限付き実保存/auth/provider/Editorへ接続 | C優先は仮説、本採用NO_GO |
| 両方不適格 | full Editorを保留、独立系列を継続、反例/次手を保存 | 自動代替方式への切替なし |

full採用には残るR05〜14の保存/権限/DB/添付/削除復元/backup/compaction等を引き続き要求する。モデルの判断やCLI正常終了をgate合格に加えない。

## 指定モデルの確認経路

初回のprint経路は5.1 Fusionと記録されたため、今回は同じDevin CLIのACP入口を使った。推論前にadvertised configOptionsを読み、model=`claude-fable-5-2-medium`（5.2 family selector）、thought_level=`xhigh`、speed=`standard`、mode=`ask`を明示選択した。familyとreasoningが別selectorであり、mediumで推論したという意味ではない。終了後のsession DBとassistant metadata.generation_modelは両方 `claude-fable-5-2-xhigh` で一致。

判断依頼は1回、重複を除いた生成応答1件、tool call0件。DBには同じmessage/requestの複製2行があり、二重計上していない。事前のselector確認では推論を送っていない。global/課金設定は変更していない。[選択記録](20261110-lv36-plan-evidence/fable52-selection-proof.json)、[生成モデル/usage](20261110-lv36-plan-evidence/fable52-delta-usage.json)。

実装根拠の一次資料: [Devin models](https://docs.devin.ai/cli/models)、[ACP config options](https://agentclientprotocol.com/protocol/v1/session-config-options)、[session setup](https://agentclientprotocol.com/protocol/v1/session-setup)、[prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)。実際の選択/生成の証拠は、当該sessionの返却値と保存metadataによる。

## usage節約の方法と実測

5.1の全文履歴・思考ログ・元packetは再送せず、既存の指摘とCodex採否を圧縮し、未決3論点と必要なsource要約だけを渡した。相談本文は29,399→9,623 bytes（約67%縮小）。これは本文byte数であり、token/請求額の削減率ではない。

| 報告値 | 初回 | 今回 |
|---|---:|---:|
| context input tokens | 41,546 | 20,821 |
| output tokens | 17,813 | 41,275 |
| 上記合計 | 59,359 | 62,096 |
| cache creation/write | 38,813 | 18,020 |

今回のgeneration metricsはfresh input2,801、cache creation18,020、context input20,821。cache readはusage欄で未指定（response statisticsは0）。本文/思考の出力内訳と請求額は不明。**入力は減ったが、XHighの出力欄が増え、報告総token数は減っていない。** 短い回答依頼でも総出力/思考量の削減は保証できなかった。請求額や総usageの節約成功とは報告しない。

今回も製品コード・依存・設定を変更せず、実装worker/test/build/GUIは未着手。[実装計画](20261110-lv36-implementation-plan.ja.md)へ反映し、**明示的なGoサインを待つ。**
