# Folio本体スキーマによる共同編集比較・接続PoC

本採用はNO_GO。構造変更不可のC方式だけを限定PoCに選んだ。[判断と残件](../../docs/roadmap/20261109-collaboration-decision.ja.md)を先に読む。

このpackageはGUI/ブラウザを起動しない。BのEditorView bindingはNode/jsdom内の仮想DOMを使い、CはNodeのEditorState/collab/historyを使う。IME、描画、実画面、実機同期間の証拠にはならない。本体のEditor/App/IPCは共同編集へ接続されていない。

```sh
# 統合ツリーのroot依存がpackage-lockどおり導入済みであること
cd experiments/collaboration-comparison
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm test
node report.mjs
node text-report.mjs
```

`build.mjs`は本体22 node/6 mark・richStructureGuard・新しいmain準備serviceをNode bundleにまとめ、ProseMirror実装の重複と祖先directoryからの依存解決を拒否する。生成したbundle/metafileはgit管理しない。固定version/licenseは`dependencies.json`、実装解決は`runtime-modules.json`。

- `comparison-result.json`: 固定seed/順序の測定。R02/R03は失敗。反例試験が緑でも受入合格ではない。
- `text-authority.mjs` / `text-client.mjs` / `text-protocol.mjs`: text-onlyのサーバー順序・SQLite log/head/receiptとPM client。trusted actor fixtureのみ。raw LOCAL_INTENTとwire attemptを区別し、どちらも自動再送しない。
- `tests/text-connection.test.mjs`: 本体SharedPreparationService/SharedDraftStoreとの実接続、2 client rebase、ローカルUndo、ACK消失、UNKNOWN停止。
- `tests/text-crash.test.mjs`: 自分が作った一時Node serverだけを確定前/後でSIGKILL。電源断試験ではない。
- `final-review.json`: ローカルcommit前の最終レビュー、合格記録のhash照合と再検証。
- `validation.json`: 実装時の非GUI試験と最終候補のコードhash。`review-summary.json` / `model-usage.json`: DeepSeek委任と独立レビューの扱い。

本体で再現する非GUI検証は`npm run check`、`npm test -- --maxWorkers=2`、`npm run build`。raw draftと共有authorityは別DB・別formatで、private workspace形式やLv4 checkpointを流用しない。

GUI、production authentication/roles/revocation、ネットワークprovider、構造共同編集、client再起動時のoutbox自動再構成、compaction、実機間受入は未完。通常画面への有効化やLevel昇格をこのPoCから行わない。
