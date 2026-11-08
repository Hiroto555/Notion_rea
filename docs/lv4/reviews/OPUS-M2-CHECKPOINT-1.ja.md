# Opus 5.5：M2第1区切りの安全性レビュー記録

2026-11-08。Devin CLIの `claude-opus-5-5-medium` で方針・共通契約を相談し、`claude-opus-5-5-high` で実ソース/統合差分・修正差分・最終条件をレビューした。生の会話exportはローカルrun rootに保持し、ここには採否と範囲を記録する。レビュー役はコードを実行していない。実行の証拠はCodexが統合ツリーで取得した [最終quiet](../validation/m2-checkpoint-1-quiet.txt)。

## 結論の範囲

最終レビューは **A3全体/M2/Lv4ではなく、添付再開・保持・限定解放の第1区切り** に限る。未解決のP0/P1を確認せず、共有添付/cleanup故障の製品2試験と、統合後の型検査・全Vitest・buildが通れば、この区切りを閉じてよいという条件付き判定だった。

最終レビュー入力は `c5a08dc` の修正差分と対象試験結果。以後の `522589d` では、非blockerの指摘を受け、budget全体のunsafeが関係ない転送recordをblockしないよう、partial/hashに関係する固定エラーコードの完全一致へ限定し、再試行できる独立試験を追加した。Flashの共有添付/cleanup試験も取り込んだ。最終quietはこの候補で実行した。レビュー役が最終commitの全ファイルを再実行/再監査したとは扱わない。

## 指摘と採否

| 指摘 | 実コードとの照合・処置 |
|---|---|
| uploadのreceived==bytesで公開PUTが無い | 最後のserverHasは既存だったため不正checkpoint成功ではなくliveness問題。final sliceを再送して公開し、実server fixtureで検証 |
| transient open障害で永久block | unsafeにするerrnoを限定、他は503。EMFILE後のprefix保持と再openを試験 |
| missing/prefix mismatchの繰り返し | 明示blockし証拠を保持。自動reset/破損証拠削除は採用しない |
| 完成targetと不完全partialでreconcile停止 | 完成target全体と、所有partialの記録済みprefixをそれぞれ検証して限定回収。blockedは自動変更しない |
| scopeごとの上限だけで累積が無界 | workspace横断のread-only予算とcache mutexを追加。旧epochのsparse保持でも通信前に止まる |
| 二重の転送予約で正常データも停止 | pinned partialの残りbytes＋8MiBへ修正。20 MB＋92 MiB既存保持で受入 |
| COMMIT後cleanup例外が成功を失敗にする | 呼出し全体をcatch。トランザクション失敗はcleanup前に従来通り伝播。実Storeのapply後cleanup例外でも成功/内容/位置を確認 |
| 共有添付の後続offline適用が失敗 | stagingが無い場合も、hash/sizeが正しいactive bytesを再利用。server停止後の2revisionを製品経路で確認 |
| canonical path不一致 | 製品workspaceは既にrealpath由来。低水準入口もcaller pathは比較だけに使い、canonicalなscope pathを構築して使用。ancestor aliasを試験 |
| root全体のbudget-unsafeが別recordをblock | 固定したpartial/hashエラーの完全一致へ限定。budget異常の後もactive recordから再試行する試験を追加 |
| 元々fsync/workspace分離/最終serverHasが無いという仮説 | 既存実装と照合し、欠落とは扱わない |
| DBの排他が実際に取れるか、SQLite付随fileがorphanにならないか | BEGIN IMMEDIATEを伴うconstructorと実process/SIGKILL試験を確認。inventoryは固定名のstate.sqliteとsidecarだけをmetadata扱い |
| 上限を超えたら旧無記録転送へ戻す提案 | 上限を無効化するため不採用。保全停止を維持 |

## 残件

- blocked/古いscope/未知fileの診断と所有証明付き明示解放。件数・対象固定・中断/結果不明の契約を先に決める。
- apply COMMIT後cleanup前に終了した残留の起動時整理、最大checkpoint・大量履歴・長時間転送の測定。
- 128 MiB/entries/directories上限は新しい保守的な製品制限で、受信できない量がある。固定error codeだけでなく利用者が理由と次の操作を分かる導線が必要。
- active bytesが後から壊れ、共有stagingも既に解放済みならoffline適用は保留する。オンライン再取得を含む実機受入は別枠。
- A4接続/秘密、A5実server復旧、A6全領域保持、A7全経路、GUI/OS/実機2台はこのレビューで完了としていない。

次の優先は、A4/A5の機能追加より前に、A3の保全停止から安全に戻す内部API・診断・試験の契約を固めること。新しい削除境界を実装する際には改めて差分レビューする。
