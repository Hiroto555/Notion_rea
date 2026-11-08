# 共同編集方式の判断と非GUI接続PoC（2026-11-09）

## 判断

**本採用は保留（NO_GO）。次の限定PoCには C（サーバー順序付きProseMirror steps）を選ぶ。通常画面の共同編集は有効化しない。**

比較では本体の22 node / 6 mark、`attrs.id`、表形状guardを使用した。BはYjs13 + y-prosemirrorの実binding/Undo、Cはcollab/rebase/historyを使う。BのbindingはNode内のjsdomで動かしたもので、GUIブラウザ・Electron・OS画面は起動していない。

| 観点 | B: CRDT binding | C: PM steps/rebase |
|---|---|---|
| 本体の全node/markのseed・本文編集 | 限定試験合格 | 限定試験合格 |
| 2・5クライアントの日本語/emoji入力 | 合格 | 合格 |
| 相手の入力を残すローカルUndo/Redo | 限定試験合格 | 限定試験合格 |
| 削除＋挿入での移動と他者の本文編集 | 同じIDでも編集が別blockへ入る反例 | 編集が残らない反例 |
| 同時の表行追加・列追加 | guardありでは収束しない | guardありでは収束しない |
| full Lv5の採用 | 保留 | 保留 |
| 構造変更不可の接続PoC | 今回は選ばない | 採用・Node検証済み |

`experiments/collaboration-comparison/comparison-result.json`が実測結果。試験コードの緑は「反例を再現できた」ことも含む。R02/R03の受入合格を意味しない。guardなしの予備試験では不正な表形状も観測した。正式な比較結果は本体guardありの条件を採る。

Bの当初案にはサーバー順序付き構造コマンドも含まれる。今回その層を完成した比較ではないため、Bの完成形やCRDT一般を否定した結果として扱わない。Cも素の位置stepだけでFolioの移動意図を保証できない。どちらの本採用にも、最新block IDの内容に対する構造コマンドと、未採用意図の保全を再設計して再比較する必要がある。

Cを限定PoCに選ぶ理由は、既存のサーバーreceipt・SQLite境界に、読み取り可能なstepと派生文書を一つのtransactionで検証して接続しやすいため。性能や全機能でBより優れているという比較結果ではない。

## 本体側に実装した準備境界

- `src/collaboration/contract.ts`: workspace/document/incarnation、actor/device、session/epoch/generationを分離して束縛する。
- `raw-json.ts` / `document-input.ts`: JSON.parse前の重複key・unsafe整数・不正Unicode・深さ/byte数を検査。未対応node/属性やID不足を黙ってPMに通さず原文付きで拒否。空のmarks/contentなどの意味を持たない表現は許可し、明示されたschemaVersionは維持する。小数/指数表記/-0はこの準備ポートでは保守的に拒否する。
- `draft-store.ts`: 独立した`shared-drafts.sqlite`へ原文を保持。application_id=`0x464c4452`、user_version=1001。STAGED/UNKNOWNを区別し、原文・メタ情報のchecksum、idempotency、容量、schema、sidecar安全性を検査する。rawは最大2M UTF-16単位、対応文書は2,000,000 UTF-8 bytes。最大1000行/20MB、allocation上限32MB。validationCodeは保存時の判定として保持し、後のvalidator変更で原文回収不能にしない。
- `src/main/shared-preparation.ts`: main所有のtrusted bindingからactor等を導出するstrictな下書き用service。read-only既定、失効・終了後の要求拒否、同じ安定owner/scopeによる再接続後の原文回収を扱う。**Electron IPCには未登録**。実認証の代用ではない。
- `editor-port.ts`: 古いsession/epoch/generation/incarnation/sequence、再入projectionを拒否する。REMOTE originを遅延callbackまで渡し、私用保存へのechoを防ぐための独立ポート。**現在のEditor.tsx/App.tsxには未接続**。
- privateの`schema-startup.ts` / `store.ts`: SQLiteを開く前のheader拒否と、WALを反映するapplication_id検査を追加。通常の共有ファイルを私用Storeが開く際に空のWAL/shmを作らない。main headerは粗い拒否専用で、WALを反映したSQL検証も必須とする。
- `rich-structure-guard.ts`: 既存guardを再利用できるplugin factoryとして取り出した。私用ページの保存fingerprint、private schema、Lv4 checkpoint形式は変更していない。

下書き領域は本採用後のauthoritative共有ログではない。privateと同じpageIdでも経路を共有しない。privateの既存full checkpointを共有データへ適用する経路は設けていない。

## Cの限定接続PoC

`experiments/collaboration-comparison/text-*.mjs`に隔離した。main下書きserviceへの実接続を含むNode試験を行う。

- 既存の同一textblock内の非装飾text ReplaceStepだけを受理する。構造変更、移動、split/join、mark変更、表構造変更、UTF-16 surrogateの途中を拒否する。既存のrich構造・IDは保持する。
- 一つのSQLite transactionでstep log、派生head、receiptを確定。duplicate operationは同じreceipt、identity/fingerprint違いの再利用は拒否。別application_id=`0x464c5450` / version1002。これはPoC専用形式で、本体の共有形式の固定ではない。
- ローカル入力はLOCAL_INTENT原文として先に保全。送信試行は別の正確なwire envelope原文を保全する。両者は履歴/隔離用で、未送信キューの同義ではない。自動再生や勝手な再送はしない。
- ACK消失はUNKNOWNで保持し、同じoperationのreceiptを先に照会する。receiptが見つからなければUNKNOWNのまま停止。原文を残す。認可拒否/容量拒否などを区別した自動回復は未実装。
- seed、epoch/scope、log prefix、stepから再構成した文書を確認してから受信する。rebaseで未確定stepが消える場合は旧stateと原文を保持して停止する。
- actorは試験用allowlistで、ネットワーク認証・権限・招待・失効socketの検証ではない。専用Node子プロセスの確定前/後SIGKILL、ACK消失、再送拒否を検証した。電源断耐性の証明ではない。

上限は32 steps/送信、256 total steps、1MiB envelope、2,000,000 bytes/文書、8MBの保持データ。compaction、再起動時のクライアントstate自動再構成、intentとreceiptの永続対応/回収、画面・実ネットワークへの接続は未実装。

## Lv5計画に対する現在地

| gate / scenario | 今回の証拠と未完部分 |
|---|---|
| V01–V03 | 限定契約・依存/ライセンス・本体スキーマroundtripと生入力境界を実装/検証。full Lv5契約の凍結ではない |
| V04 / R01 | 同一seedとID必須を部分検証。実サーバーの二重seed競争は未実施 |
| R02 / R03 | 生の移動・表構造mergeはFAIL。text-only制限はこのFAILの解決ではない |
| R04 | PM/yUndoの限定試験合格。slash/IME/全操作境界は未完 |
| R05 | main下書き/限定Cのreceipt・rollback・ACK消失・専用Node SIGKILLを部分検証 |
| R06 | privateによる共有draft DB誤open、共有DBへのcheckpoint生成を拒否。全backup/restore受入ではない |
| R07 | DB schema/record/owner/common cutはNOT_RUN |
| R08–R10 | scope/lifecycle/epoch/bindingを部分検証。restore/既存socket失効/旧server backup検出は未完 |
| R11 | compaction/長期offline/delete-only updateはNOT_RUN |
| R12 | raw unknown/大整数/IDは保全。preview copy/外部link/asset一式は未接続 |
| R13 | 名前空間/世代の独立ポートを部分検証。通常画面navigationはNOT_RUN |
| R14 | 実IME/composition/clipboard/native DnDはNOT_RUN。日本語文字列試験で代替しない |
| V05–V09 | 本採用NO_GO。draft境界と限定接続PoCまで。full共有store/provider/本体Editor接続の完了ではない |

**認定はLv3のまま。** Lv4の実機受入、Lv5/6の本採用、GUI・別Mac・実ユーザー/権限・本番server接続を今回の合格に加算しない。

次は、block IDを解決するサーバー構造コマンド、同時行/列の合法形、未採用意図の復旧とoutbox再構成を実装してR02/R03を再比較する。権限/復元/compaction等の必須gateを通してから共有形式と通常画面接続を決める。

## 一次資料と再現

- [y-prosemirror v1.3.7 README](https://github.com/yjs/y-prosemirror/tree/v1.3.7#readme): binding、local Undo、Y.Doc binary保存。
- [ProseMirror collab](https://github.com/ProseMirror/prosemirror-collab): 実装は導入した1.3.1のsourceを確認した。公式guideはHTTP403で取得できなかったため、その内容を未確認の根拠にしない。
- [Tiptap Collaboration](https://tiptap.dev/docs/editor/extensions/functionality/collaboration): UndoRedoの二重登録を避ける。現行資料のschema保護は3.33以降の条件があるため、本体3.32へ適用済みと扱わない。

固定依存は実験package-lock、実体は`dependencies.json`。比較bundleは本体のPM実装を一つだけ使い、collabは実験側の1.3.1へ明示解決する。祖先directoryの依存を借りる解決をbuild時に拒否する。

再現コマンド、実装時の件数とhashは実験README/validation.jsonを参照。実装・検証ではGUI起動、push、workflow作成/実行、master mergeを行っていない。実装時点のローカルcommitは未実施で、後続の最終レビューによるcommitとは区別する。

## 最終レビュー（2026-11-09）

利用者の指示により、作業ブランチ`codex/folio-lv5-collaboration-20261109`でローカルcommit前のレビューを行った。main準備境界、private/sharedのformat拒否、限定Cのlog/head/receipt、受信・Undo・UNKNOWN停止、比較の反例と資料を対象とする。

実装時に本体2,329件・比較/限定PoC48件が合格したコードとログのhashを照合し、関連する本体55件・比較/限定PoC48件、型チェック・ビルド・測定reportを再検証し、すべて合格した。限定PoCとしてのcommitを妨げる問題は確認されなかった。最終確認の結果と対象hashは`experiments/collaboration-comparison/final-review.json`に記録する。

本採用NO_GO、通常画面未接続、GUI/実機受入NOT_RUN、認定Lv3は維持する。過去のDeepSeekレビューの未完・timeoutを独立した全面合格として扱わない。今回の判断は限定PoCと接続準備を保存するためのローカルcommit可否である。
