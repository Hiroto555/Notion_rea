# Folio shared workspace lab

2026-11-08開始の、約1時間を上限とするDeepSeek並列スプリントの先行実装です。**Folio本体への接続・Lv5/Lv6認定は未実施。確認済みLevelはLv3、Lv4は実機受入待ちです。**

## 実装と接続範囲

| 範囲 | 実際の動作 |
|---|---|
| 共同編集の比較 | 実Yjs＋y-prosemirrorと、実ProseMirror collab/rebase。共通の限定schemaで本文挿入、逆順/重複配送、両者の編集保持を照合 |
| 現Folio由来の文書 | 候補0305999からJSON grammar/defaultを抽出した22node/6markのschemaを再構築し、見出し・太字・表を含む合成fixtureを試験。editor plugin/guardは実行しない |
| サーバー側 | Node SQLiteのCAS文書・操作log・receipt・監査を同じCOMMITへ保存。COMMIT前後の実子process SIGKILL、応答喪失の結果不明、再照会、同一操作再試行を試験 |
| 通信とメンバー | 127.0.0.1の一時HTTP listener、fixture bearer認証、役割と失効、招待状態のowner承認、最後のowner保護。製品identity provider/実招待配送は未実装 |
| クライアント側 | 独立SQLite outboxで元command・fingerprintを保持し、結果不明はQUERY_FIRST。確認済みreceiptの適用と再起動を試験 |
| DBレコード | text/number/checkboxの限定型、schema版・record版、patch/delete/restoreをSQLiteへ保存。HTTPから認可し、操作/receipt/auditと同じCOMMITへ接続。実Folio DB形式/本文との参照整合は未接続 |
| 添付 | 実bytesのSHA256/size/上限と私有copyを検査し、SQLite BLOBへ保存。HTTPのupload/read、失効と再openを照合。本文参照・private copyと連動する公開/回収は未接続 |
| 共有copyと復旧 | 選択範囲/リンク/IDのmetadata preview、旧pendingを保全し自動再送しない復旧計画。本文copy・実backup検証/復元は未実装 |
| UI | 保存/接続/権限/競合のpure状態投影。GUIはNOT_RUN |

`demo.mjs`は上記の接続範囲を区別して出力します。DB/添付は同じSQLite/event sequenceへ単操作として接続しました。本文・record所有・添付参照をまたぐ複合整合性とcopy/backup本体は未実装です。Yjs/PM比較の結果を本体の保存経路へ取り込んでいません。LabAuthorityの文書更新は版照合付きsnapshot置換で、選定済みの共同編集engineではありません。

## 実行

Node24で、専用packageの依存だけを使用します。既存Folioのpackage/lockを更新しません。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run compare
npm run demo
```

demo/testは自分で作った一時SQLite・listenerだけを回収します。`FOLIO_DATA_DIR`や既存FolioのDBは使いません。GUI/Electron/clipboard/native dialog/実SSHを起動する入口はありません。GUI受入は既存batchと利用者の明示実行指示に従います。

## 結果の読み方

- `validation.json`と`final-review.json`が保存候補の結果（319 Nodeテスト、比較32ケース、接続demo PASS）。`sprint-validation.json`はスプリント終了時306件の履歴です。Node試験とFolioの実機受入を分けます。
- `compare.mjs`は同じseed/intentを両engineへ渡し、engine内部での収束と受理編集の保持を検査します。B/C間で同時挿入の最終順が同じであることは要求しません。
- outboxは行ID・command・fingerprint・scope・保存段階の整合を読出し時に照合し、不整合は原本を保ったままCORRUPT_OUTBOXで停止します。既存queue tableの欠落も空queueとして再作成しません。これはローカル整合性検査であり、真正性を署名で保証する仕組みではありません。
- 共同編集の限定engineでは整形式のUnicodeだけを受理し、不正UTF-16やサロゲート中間への挿入は変換前に拒否します。元のcommandをUnicode補修で書き換えません。
- 有限seedのPASSは限定試験の結果です。V01〜V05全体、表の同時構造変更、local Undo、実IME、実回線、causal hidden roots、engineの永続化、失効と復元の全反例は未完です。方式採用はUNDECIDEDです。
- Y bindingのraw JSON投影では`colwidth:null`の省略とmarkの空attrsが観測されました。反映schemaによる既知defaultの復元後は今回のfixtureで意味/IDが一致します。raw bytes保全や未知値を含む一般的lossless変換の証明にはしません。
- 反映schemaはJSON specです。実FolioのBlockIdentity、RichStructureGuard、Tiptap editor、selection、IMEを動かした結果ではありません。使用PMの版も既存アプリとは異なり、依存互換・接続は別途必要です。
- LabAuthorityのactor引数とHTTPのfixture tokenは合成利用者用です。実アカウント、永続credential、Keychain、TLS、招待配送、組織をまたぐ運用を提供しません。
- quotaはevent payloadの16MiBとBLOBの8MiBなど別々の限定した計測で、SQLite全ファイル/監査/indexのディスク使用量を保証しません。監査hash chainはローカルの整合性検査です。監査上限ではAUDIT_LIMITを返し、既存receiptの再照会/許可された同一要求再送は保ちます。自動ローテーションは実装していません。
- 失効後は古いreceiptも再認可します。役割降格後にwrite再送が禁止されても、read権限が残る場合は自分のreceiptを別経路で照会できます。失効後のアクセスを先行させる案は採用していません。

## Lv4・Lv5・Lv6への残件

Lv4のL4-01〜12、Lv5のV01〜15/L5-01〜14を維持します。このlabの部品・限定試験を対応する調査/実装の材料にし、現Folioの全schema/ID/Undo/権限/削除復元/backupと統合して判定します。resource endpointは専用protocol `folio-resource-lab/1`であり、既存Folio IPC/Storeへ接続していません。

Lv4は新候補GUI・実IME/Keychain・Dock/終了/pickerと、現管理Macを除く別Mac A/B＋Sが未確認です。機材待ち中も隔離比較は進められます。Lv6の組織/複数shared workspace、引き継ぎ、監査/容量の管理画面、実backup/更新失敗/復旧手順は今後の実装・受入です。

## API参照と出所

- [Yjs document updates](https://docs.yjs.dev/api/document-updates)
- [ProseMirror collab公式source](https://github.com/ProseMirror/prosemirror-collab)
- package-lockと各packageに同梱された実source/APIを使用。第三者モデルの出力は親が検証し、原文のまま全採用していません。
- 生のモデル会話・rawログ・一時DBはrepoへ追加せず、実行用の一時rootへ保全しました。その一時領域の長期保存は保証しません。
