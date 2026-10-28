# R4 操作シナリオ台帳

対象固定commit: `f3c4dd1e5e2734a98c2242814b989beefd58160d`、tree `a37f348d14fe96b1bbff3de94d37341de7d7d214`。最終固定候補の全体runで下記すべてPASS。build/typecheck PASS、unit480/480、E2E126/126、FAIL/SKIP 0。結果はSTATUSの生logとmanifestに対応する。過去runとの合算はしない。

Notion参考基準は依頼文の操作定義と公式資料。全行ともライブ比較は未実施で、「一致」または「比較済み・差分あり」とは認定しない。物理日本語IME/native OS clipboardも未確認。

| ID | 操作・期待結果 | Notion参考基準 | 実装 | 実App接続 | SQLite再起動確認 | 合成試験の層 | 操作・表示の残差 | Notion比較 | owner | commit・run・証拠 | 次の一件 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| R4-01 | record本文/titleを編集→一覧→再起動して保持 | DB項目をPageとして編集 | 済 | 済 | PASS | Electron→実Editor→IPC→SQLite→Electron再起動 | 固定所属のみ | 未比較 | A0/A1/A2/A7 | 上記固定commit、r4-record-edit: body/title/three property | 専用record新規作成の接続 |
| R4-02 | text/number/checkboxをcellとpanel双方で編集 | 表とページ上部のproperty | 済・3型 | 済 | PASS | 同上、各型をcell→panelで再編集 | select/dateはlive編集disabled | 未比較 | A0/A3/A7 | r4-record-edit: body/title/three property | 次型の保存・失敗試験 |
| R4-03 | side/full切替→Undo→元行focus/scrollへ戻る | side/full Page | 済 | 済 | 対象外 | Electron・同Editorインスタンス・非zero scroll | center peek未実装 | 未比較 | A0/A2/A7 | r4-record-edit: side/full | center peekの必要性・表示契約を確認 |
| R4-04 | ACK保留→追加入力→閉鎖→別record→再open | 編集を保った画面移動 | 済 | 済 | NOT_RUN・crash復旧対象外 | Electron barrier→SQLite、送信対象/seq厳密検査 | draftはApp寿命内 | 未比較 | A0/A1/A7 | r4-record-edit: held record ACK | durable outboxの必要範囲を設計 |
| R4-05 | COMMIT後ACK欠落→unknown→照会→同ID再送で二重適用なし | 保存結果が曖昧でも入力保持 | 済 | 済 | receiptのStore再openはPASS、App再発見は未実装 | Electron障害注入+unit transaction/receipt | unknown操作の再起動後再発見なし | 未比較 | A0/A1/A7 | r4-record-edit: lost ACK、save-receipts.test.ts | 未解決operation索引の永続化 |
| R4-06 | unknown時通常終了/reloadを防ぎ入力を保持 | 編集の離脱保護 | 済 | 済 | 対象外・再起動を阻止 | Electron native close/reload | crash/強制終了/電源断は別 | 未比較 | A0/A7 | r4-record-edit: lost ACK | 強制終了のdraft回復を別途実装 |
| R4-07 | numberの途中 '-' を閉鎖/reopenでも保持 | 入力途中の編集維持 | 済 | 済 | 対象外・未完値でreload阻止 | Electron raw form・数値parser unit | raw未完値のcrash復旧なし | 未比較 | A0/A3/A7 | r4-record-edit: incomplete numeric | 他入力型の途中値を棚卸し |
| R4-08 | 履歴restore ACK/load保留→dialog閉鎖でも編集停止 | 履歴操作中の入力整合 | 済 | 済 | 対象外 | Electron barrier+実Editor、ACK前/再load前の2経路 | restoreVersion自体のACK欠落はlock維持 | 未比較 | A0/A7 | r4-page-save: restore phases | restore receipt/queryの拡張 |
| R4-09 | 外部変更後refreshでも旧Editorへ新revisionを付けない | 競合時に外部値を上書きしない | 済 | 済 | 対象外 | Electron→実IPC外部更新→SQLite | 任意外部writer/旧binaryの排他は未確認 | 未比較 | A0/A1/A7 | r4-page-save: ordinary refresh、record-coreの旧fixme | 外部writer排他と競合解決UI |
| R4-10 | 遅延Page ACKで後続入力/別Pageを壊さない | 連続入力とページ移動 | 済 | 済 | 対象外 | Electron barrier→SQLite | tested操作列外は未確認 | 未比較 | A0/A7 | r4-page-save: delayed Page ACK | IME/unmountの物理入力確認 |
| R4-11 | slash絞込み/矢印/Enter/Undo/Esc | keyboard block編集 | 済 | 済 | 見出し/To-do PASS | Electron実Editor→SQLite→再起動 | 複数block移動等の追加棚卸しは次wave | 未比較 | A0/A4/A7 | r4-editor.spec.ts 3件 | 複数block移動・検索復帰 |
| R4-12 | Page/DB/recordの幅・余白・focus統一 | 一貫した画面表示 | 済 | 済 | 対象外 | Electron固定1440×900 before/after、960/1024 overflow | 同条件Notion画面未比較 | 未比較 | A0/A5/A7 | r4-visual、ui-v2、STATUS画像リンク | 同条件Notion比較と残差修正 |

R4対象の操作シナリオは12件、実App接続12件。再起動を直接要求する3シナリオ（01/02/11）をElectron再起動まで検証。receiptのStore再openは別証拠で、Appの未解決操作再発見を意味しない。Notionライブ比較0/12、同条件一致認定0/12。これはNotion全機能の達成率ではない。

## 長期カタログ（今回の対象から消さない）

| 項目 | 今回確認した範囲 | 残る実App接続・確認 |
|---|---|---|
| DB新規作成・record追加 | Store/既存部品・試験は存在 | 専用経路のUI接続と通常操作からの保存 |
| view/filter/sort/groupと設定 | 既存DatabasePresentationとDB UI fixtureを保持。fixtureの変更/再試行試験は実保存証拠ではない | live設定保存の接続、再読込検証 |
| center peek | side/fullを優先 | center方式は未実装 |
| select/date | 既存表示/PropertyFieldは存在 | 今回live編集は対象外・disabled |
| 複数block選択・移動・階層化・貼付け・検索復帰 | 既存実装・合成試験を維持 | 次waveで実Appの操作列を棚卸し、物理IME/clipboardを分離 |
| template/relation/rollup/formula・gallery/calendar/timeline | 今回全経路は未読・未評価 | 既存実装を確認してから不足を確定 |
| 媒体/添付・linked DB・履歴 | 既存機能を一括で未実装扱いしない | record対応/復旧/所有境界を個別確認 |
| 共有/権限/共同編集/AI | 今回評価外 | サービス依存を含め長期確認対象 |
