# 共有Editor候補の継続判断

2026-11-10。対象はintegrationの未commit候補。[最終source／検証](20261110-lv46-continuation-evidence/validation.json)、[到達点と未達](20261110-lv46-continuation-progress.ja.md)を正本とする。

2026-11-09の「本文限定C PoC、full NO_GO」は当時の候補への判断として保存する。今回、最新blockへ意味付きcommandを適用するauthority、durable intent／attempt／receipt、実認証・providerを持つ共有runtimeへ、通常Editorの型付きbatchと専用PM Move／Frame Stepを接続した。単なる生PM stepの全面送信や排他leaseへの置換はしていない。

| 観測 | 現候補の結果 | 採否への意味 |
| --- | --- | --- |
| B/Cの実binding・意味付き構造 | 20件PASS | 共通の合法move／表の正常系を保ち、旧方式の反例再現だけを緑にしていない |
| 独立R01〜R05と共有画像 | 20件PASS | C mixed text／structure Undoが正しい逆順へ戻る。R05のin-memory診断はdurability成功ではない |
| 実runtime／本体接続 | 製品336ファイル3,458件PASS | main→HTTP→SQLite、UNKNOWN／再起動／receipt／権限、private隔離、DB／添付、backup／restore等の根拠を別に持つ |
| 通常Editorの変更・投影 | rich／複数block／Enter／move／frame／表、own Undo／remote保持をNode／PMで確認 | 有界候補として共有分岐へ接続できる範囲を増やした |
| GUI／実IME／物理複数機 | NOT_RUN | 実利用のfull Lv5認定根拠にはならない |

継続する候補は、既存C系のサーバー順序と専用意味付き操作、immutable保存、実provider、PMの位置写像を組み合わせたもの。B一般やCRDTを不適格と結論しない。現在の本体接続をBへ全面置換する追加作業も行わない。

**候補コードの非GUI継続は可。無条件full Editor採用・Lv5/6実利用受入はHOLD。認定Lv3を維持する。**

有界profileは、文書2MB、64 atom/batch、1MB wire、有限outbox／Store／history cache、複雑な同時変更のdiff上限等を持つ。大きい既存本文の小変更・単一markはcompact commandで送るが、任意の巨大paste・複雑な競合が必ず受理されるとはしない。競合や容量で原文を残して止める境界を、全拒否による合格にすり替えない。受理する正常系と拒否時の保全を別々に検証する。

残るWindows private移植・資格情報公開port、保持資料の完全purge、実運用SLOの未計測も[継続記録](20261110-lv46-continuation-progress.ja.md)へ明記した。これらをGUI未実行だけの欄へ移して完成扱いしない。
