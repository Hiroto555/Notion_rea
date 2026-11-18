# M2 第1区切り：添付転送の再開と保全停止

2026-11-08。利用者の「できるだけ進めて」を受け、以前のA3前停止からM2の非GUI作業へ進めた。統合ブランチは `codex/folio-m2-20261108`、出発点は `3aac7e9`。**M2全体・A3全体・Lv4の完成宣言ではない。**

## 今どこまで進んだか

| 範囲 | この区切りの結果 | 残り |
|---|---|---|
| M1 A0〜A2 | 既存の完了状態を維持 | Mac/実機受入は別枠 |
| A3 添付再開 | download/uploadとも実Node子processのSIGKILL後に再開。サイズ・全体hash前に公開しない | 実ネットワーク・スリープ・実機2台 |
| A3 保持・整理 | スコープ付きSQLite記録、process排他、部分hash照合、保持上限、検証済み公開後の回復、適用完了後の限定的なstaging解放 | blocked/古いscope/未知ファイルの利用者向け診断・明示解放、commit後cleanup前の中断残留、最大規模の計測 |
| A4 接続・秘密 | Flashで実ソースを調査し、配線済み部品と未実装を分離 | 初回登録・接続設定・SecretStore製品接続・更新/削除・復元後再登録は未実装 |
| A5 サーバー復旧 | Flashでcatalog backupと完全backupの差を確認 | 添付同梱・履歴/receipt検査・新規先復元・fresh epoch・maintenance排他は未実装 |
| A6 容量/保持 | clientの転送cache＋stagingについて有界な保全停止を追加 | server履歴・backup・受信待ち全体の保持制御、A0規模/時間予算の受入は未完 |
| A7 統合受入 | この区切りの非GUI検証を実施 | M2全経路の候補固定・GUI受入は未完 |

## この区切りの終了条件

1. 一時workspace・loopbackのみで、実client SIGKILL後のdownload Range起点と、client/server双方のSIGKILL後のupload offsetを照合する。
2. 改変prefix・容量超過では通信前に保全停止し、無記録転送へfallbackしない。symlink/FIFO/hardlink/差替えは拒否する。
3. fsync済みprefixの後にSQLite offsetを確定する。別processの同時所有を拒否し、SIGKILL後はOSのlock解放で再開できる。
4. 全bytes受信後・公開前のserver partialをfinal slice再送で公開できる。公開先が正しいcacheの中断残留を先に回復する。
5. 適用済みstagingは、指定manifestに含まれ、別inodeの正常なactiveコピーを再照合できたものだけ解放する。未知/破損/共有inodeは残し、後片づけの失敗で確定済みCOMMITの成功を失敗に変えない。
6. 共有添付を含む後続revisionのoffline適用を壊さない。型検査・全Vitest・buildを通し、Opusの未解決指摘を分類する。

## 実装上の上限と保全方針

- 添付1件 `20,000,000 B`。journalは1スコープ/方向/保存先につき1,000件、active/blocked予約100 MiB。内容DBのschemaは変更しない。
- workspace全体の `.folio-sync-transfers` と `.folio-sync-assets-staging` は、論理bytes合計128 MiB、2,048 entries、128 directories、根から深さ4のread-only棚卸しを行う。別epoch/bindingの保持も数える。論理上限であり、OSの容量予約ではない。
- 正当な転送の競合をglobal cacheのSQLite mutexで直列化する。追加admissionは、所有を検証したpartialの残りbytes＋8 MiBの余裕。公開は同じinodeのhardlinkを利用する。通常のdisk容量部品も継続する。
- 上限で停止したデータ・blocked・古いscope・legacy orphan・未知ファイルを自動で消さない。epoch/bindingを繰り返し変更した場合もentry/directory上限で止まる。解除UIはまだ無い。
- 完了済みjournal行の整理はcacheファイル削除とは別。原本assets・M1 archive・backupを掃除しない。tokenをjournal/scope/statusへ保存しない。
- 既存のtransfer指定が無い低水準呼出しは従来動作を維持。製品のWorkspaceSyncは転送scopeとworkspace上限を渡す。
- 20 MB一件と92 MiBの既存sparse保持データの共存を確認した。最大checkpoint・大量履歴・長時間転送の性能保証にはしない。

## モデル分担とレビュー

OpenCode Goの実モデル `opencode-go/deepseek-v4.1-flash` を隔離worktreeで並列利用した。Devin CLIは `claude-opus-5-5-medium` で方針/契約、`claude-opus-5-5-high` で統合差分を相談した。今回Solの追加レビューを受けたとは報告しない。

| 担当 | 実際に受け入れた成果 |
|---|---|
| Flash J3/J4/J7 | read-only転送inventory、server upload partial probe/排他、workspace横断budgetと専用試験 |
| Flash J5/J6/J10 | journal/partialの独立故障試験、共有添付/COMMIT後cleanupの製品経路試験 |
| Flash read-only調査 | 転送/安全境界、A4/A5の実装箇所と不足の棚卸し |
| Codex | 型/契約、journal/partial本体、既存transport/WorkspaceSyncへの接続、独立受入、レビュー指摘の修正、全体検証 |
| Opus 5.5 | 方針・契約・統合差分の複数回の重点レビュー。指摘を実ソースと照合して採否を判断 |

J1/J2の初回・修正版は担当ファイルを作らず探索に偏ったため中断した。tool-free生成実験も採用できなかった。親がjournal/partialを実装し、Flashには独立故障試験を割り振り直した。未読の調査や生成失敗を実装/レビュー完了として数えない。

Opusの指摘から、全bytes partialのfinalize、transient open失敗の分類、公開済み不完全cacheの回復、スコープ横断上限、残りbytesのadmission、COMMIT後cleanupの例外隔離、共有添付の再利用を修正した。既存のfsync/workspace分離/最終serverHasや正規化は実コードで既に成立しており、欠落とは扱わない。上限超過の無記録fallback、未知ファイルやprefix不一致の自動削除/無条件resetは採用しない。

重点レビューの採否は [Opusレビュー記録](reviews/OPUS-M2-CHECKPOINT-1.ja.md)。

使用量と中断を含む実行数は [使用量記録](M2-USAGE.ja.md) に分ける。課金・節約率・無制限利用の証明とはしない。

## 検証結果

最終候補 `522589d` は `npm run verify:quiet` の全3段階PASS：型検査、**191ファイル／1,760テスト**、build。M2追加前の1,681件から専用79件を追加した。[実行ログ](validation/m2-checkpoint-1-quiet.txt)。全体quietは統合後に1回実行し、103.3秒。通常の型検査/対象試験の途中失敗は修正後に再検証した。buildの既存chunk/dynamic import警告は残る。

Opus最終確認は、この区切りに未解決のP0/P1を確認せず、製品2試験と全体quietの合格を条件とした。両条件を満たした。A3全体/M2の完了とは区別する。最終レビュー後のbudget block分類の限定も専用試験と全体quietで確認した。

元master/HEAD/origin masterは `e269137` のまま。統合ブランチにローカルcommitし、今回のM2変更はまだpush/mergeしていない。Mac GUI/Electron/OS/実機2台は **NOT_RUN**。前回のGitHub Actions GUI69件は `3aac7e9` までの証拠で、今回変更したsrcの合格へ流用しない。

## 次の実装順・担当カード

| 優先 | 作業 | 主担当と独立担当 | 終了条件 |
|---|---|---|---|
| 1 | A3の保全停止を利用者が診断・明示解放できる契約 | Codexが対象固定/所有証明/結果不明契約、Flashがread-only表示モデルと独立試験、Opusが削除境界をレビュー | 対象差替え/別scope/破損/応答喪失で誤消去せず、保持量と解除可否を説明できる。既知の未完転送を単純TTLで消さない |
| 2 | A4資格情報の更新・削除と製品接続の契約 | Codexが既存binding/recovery/write policyを所有。Flashは永続化部品、fake safeStorage試験、設定schema/表示を別カードへ。Opusが秘密と再登録をレビュー | 現行create-once adapterのdelete非対応を明示的に解決。scope分離・失効・再登録で自動bindせず、秘密はUI応答/log/backupへ返さない。Mac safeStorage受入は別枠 |
| 3 | A5添付付きserver snapshot・新規先復元 | Codexがmaintenance/fresh epoch/既存catalog形式の契約。Flashはblobコピー、検査、fault試験を分離。Opusが復旧/receipt境界をレビュー | 履歴/receiptが必要とする添付まで照合し、新規先のみへ復元。旧epochを拒否、既存serverを上書きしない |
| 4 | A6→A7 | Codexが全領域の容量/保持基準と候補を固定、Flashが各規模/故障試験 | client/server/backup/inboxの増加を有界化。全非GUI証拠が同じ候補へそろうまでM2を完了にしない |

詳細なA4/A5読取結果と生のモデルログはローカルrun rootに残し、秘密情報を含み得る実行環境や全会話はGitへ入れない。どのカードも、このMacのGUIや実データ、元master、master mergeを前提にしない。
