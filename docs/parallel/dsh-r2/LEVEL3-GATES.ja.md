# Folio Level 3 到達条件と第2ラウンド

2026-11-05 JST。コード基準 `2d3ee785921dbb6e86b0ca56b42cd3b5fa5c0be6`。
**現状: Level 2到達 / Level 3部分達成。今回の目的は以下の未達条件を閉じること。GUI試験はNOT_RUNのまま。**

## 判定を固定する

元の監査 `Notion_rea/outputs/folio-technical-audit-20261104/REPORT.ja.md` のLevel 3定義を具体化する。これはこのプロジェクト内の評価基準であり、外部認証ではない。全gateの根拠を同一統合版に揃えてから到達判定する。テスト件数や見た目の評価点からLevelを推測しない。全47項目をLevel3の必須機能とは扱わない。Level4以降の複数端末同期・共同編集・権限管理は別。

対象はローカルSQLite、単一所有者、現行の単一アプリウィンドウで提供中の操作。record/登録DBの未対応lifecycleを単に有効にすることや、既存データの自動移行・自動修復は条件にしない。未対応操作は明確かつ安全に拒否する。

| Gate | 必要条件と合格証拠 | 現状・次の担当 |
| --- | --- | --- |
| G1 ローカル完結 | ネットなしで起動・通常編集・ローカル検索・保存・再open・ローカル書出しが成立。任意の外部AI等は除外。ネット依存の実コード点検＋後日の隔離GUI確認 | Node経路の証拠あり。アプリ全体のoffline確認は保留。Dが経路棚卸し |
| G2 正常操作の不変条件 | Page/Doc/recordのID・所属・順序・参照とtitle上限を維持。create/duplicate/move/trash/restore・legacy/v4混在、失敗時原本不変、再openを試験 | 既知の同順位・長title回帰は修正済。Bの修復APIは存在、GUI未接続。C/Dで不足確認 |
| G3 保存の確定と入力保護 | Pageとreceiptが一緒に確定/rollback。ACK喪失・重複・timeoutで二重生成/虚偽成功なし。template/importの初期本文を作成と同一操作で永続化し、送信前checkpointにも含める | 通常作成/複製はR1で改善。初期本文が別保存の穴をAで閉じる |
| G4 復旧と競合 | 未保存入力と未確定操作を再open後も保持。未送信操作はユーザーの明示再試行で同じIDを使用。rejected/unknownを消して成功にしない。revision不一致は上書きせず、復旧コピーなど説明可能な出口を持つ | unknown照会だけでは未送信操作が解決しない。Aが再試行と結果表示を整える |
| G5 backup/restore耐障害性 | 完了前にDB・全添付・directoryのdurability barrierと検証。別の一時場所に復元し、原本不変。途中失敗・不完全marker・再openを検証 | fsyncの既知穴は修正済。Cが新たな子Nodeの中断試験を行う。物理停電耐性は主張しない |
| G6 破損・未知schemaの隔離 | 壊れた対象へ書かず原本rawを救出可能。健康なページ/DBへ到達できる。未対応schema/transaction cleanup失敗は安全に停止 | Node試験あり。C/Dが実経路と不足を点検、GUI救出導線は後日 |
| G7 容量と処理量の管理 | receipt・backup・添付等の容量/増加を把握し、入力を消さない上限/保守手段を持つ。unknown操作をGCしない。1千/1万規模の処理量と許容範囲を記録し、main同期処理の制限を隠さない | receipt/backupの保持・容量制御は未達。Bがまず非破壊の計測・保守契約を実装し、安全な上限の設計を提示。計測だけではPASSにしない |
| G8 独立検証と製品経路 | 同じ統合コミットで型/unit/build、障害・復旧試験、重要な画面操作→再openまでの証拠を揃える。既知P1を残して到達としない | R1は89files/929tests PASSの過去証拠。今回は再実行前。GUIは明示許可待ち。CI定義あり、hosted CI成功はGUIの代替ではない |

条件を満たしたgateは根拠と範囲付きでPASSにする。未検証はUNKNOWN/NOT_RUN、部分実装はPARTIALとして残す。新たな不具合はどのgateに反するかを示す。全機能の完全無欠や物理故障の万能保証は要求しない。

## 第2ラウンドの分担

- A: 作成と初期本文の原子性、同じoperationを使う明示的な復旧再試行。保存・復旧・Appの密接な変更を1担当にまとめる。
- B: 保存容量の非破壊計測と保持・上限制御の契約。receipt/backupの自動削除は実装しない。制御を安全に統合できる条件を具体化する。
- C: 既存保存/backup基盤の独立した非GUI障害試験。自分で起動した一時データ専用の子Nodeだけを中断し、アプリや既存プロセスに触らない。
- D: 上記8gateの実装経路と不足証拠を独立監査。コード変更はせず、他担当の報告を鵜呑みにしない。監査表はこの固定基準を維持する。

4担当は別worktree。実装の中心はA、Bと検証C・Dを並列化する。src/shared/types.ts、Store、App、既存復旧はAだけが所有する。Bのmain/App配線はCodexレビュー後に行う。C/Dは製品コードに触らない。

## 共通の関所

DeepSeek V4.1 Flash / Max / Full Accessを使用。ただしGUI/Electron/browser/OS clipboardは起動しない。Node/SQLiteの一時fixtureのみ。git push/deploy/既存Desktop差替え/実データ移行なし。他モデルや追加agentへの再委譲なし。

各担当の上限は約90分を目安に検証済みのまとまりで停止し、HANDOFFとローカルcommitを残す。Codexが完了HEAD、差分、独立再現と統合後のquiet検証を確認する。G7やGUIなど残件を残した状態でLevel3完成と言わない。
