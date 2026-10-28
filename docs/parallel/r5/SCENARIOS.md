# R5 操作と証拠の対応

各E2Eは本体Electron・実IPC・試験専用SQLiteを使用する。旧形式DBの表示fixtureは新DBの保存証拠に含めない。最終全件結果はSTATUS.mdを参照。

| ID | 操作・受入条件 | 試験 |
|---|---|---|
| R5-01 | v3から「新しいデータベース」で登録DBを作る。旧DBのJSONと行を変換しない | r5-create: first registered DB |
| R5-02 | 新規行をページとして開き、本文・タイトル・text/number/checkboxを編集し再起動で読戻す | r5-create: first registered DB |
| R5-03 | DB作成COMMIT後のACK喪失で同じoperationを照会し、DBを二重作成しない | r5-create: create DB lost ACK |
| R5-04 | 行追加COMMIT後のACK喪失で同じoperationを照会し、membershipを二重作成しない | r5-create: add row lost ACK |
| R5-05 | ビュー追加・改名・切替、text/number/checkbox条件、sort/groupを保存し再起動で一致 | r5-settings: UI view creation |
| R5-06 | フィルターに合わない新規行でも「追加したページを開く」で見つかる | r5-settings: UI view creation |
| R5-07 | settings ACK保留中の追加入力・ページ移動・owner titleを同じrevision系列で保存 | r5-settings: held settings ACK |
| R5-08 | settings unknownで新IDを発行せず照会、reload抑止、再起動で結果保持 | r5-settings: unknown settings |
| R5-09 | 外部で進んだowner revisionへdraftを載せ替えず、競合として入力保持 | r5-settings: external owner revision |
| R5-10 | 数値の途中入力「-」を移動後も保持しreloadを抑止。条件対象変更時はraw/canonical両方reset | r5-interactions: numeric filter raw |
| R5-11 | グループ対象textの連続入力で同じDOM/focusを保ち、row blur後に移動 | r5-interactions: continuous typing |
| R5-12 | ボードのgroupとギャラリーのfilterが再起動後も一致し同じrecordを開く | r5-interactions: board groups and gallery |
| R5-13 | DB作成ACKが遅れても、その間に開いた既存recordを閉じない | r5-interactions: late database creation ACK |

unitは初回schema導入とSQLite snapshot、作成/更新とreceiptの原子性、同operation再照会・別要求衝突、owner境界・schema変更拒否、ACK照合、intent順序とrevision系列を確認する。ビューintent helperも単独で確認する。

## 今回直した問題

1. checkbox条件への対象変更で`value: undefined`が残り、SQLiteのJSON roundtrip後のACKとの差をunknownと判定していた。JSONで安定する空値へ変更し、実Appの既存typed-filter試験が通ることを確認。
2. 数値条件の対象変更で古いraw textが残っていた。条件変更時に親のraw textもreset。
3. group/filter対象の値を編集中に行が消失・移動してfocusを失っていた。focus開始時の値で配置を保ち、表示する入力値は最新sessionを使用。row blurで条件を再適用。
4. DB作成の遅延ACKがrecordへの新しい移動を見落としていた。recordのopen/closeも選択世代を進める。

## 境界

物理日本語IME、native OS clipboard、実データ・外部SQLite writer、Notionライブ比較はこの合成試験では確認しない。途中draftはAppメモリに保持されるため、強制終了からの完全復旧は未実装。calendarの選択UIはあるが、新DBの標準列にはdate列がなく、実date編集の完成は主張しない。
