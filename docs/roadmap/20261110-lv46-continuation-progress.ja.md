# Lv4〜Lv6 継続実装・最終非GUI結果

2026-11-10 JST。今回の明示Goに基づき、前回候補の未接続点と反例を実装・統合・独立レビューした。**非GUIの候補検証は完了。認定はLv3のまま。Lv4〜Lv6の実利用受入完了とはしていない。**

最終結果は **336ファイル／3,458テストPASS、失敗0・skip0、check PASS、build PASS**。この件数には一時領域へ生成したWindows EXEのPE／埋め込みassembly検査2件を含み、Windows実行を含まない。通常の環境変数なしでは、その生成物検査2件だけskipする。比較40件とビルド済みCLIの連続運用確認もPASS。[検証正本](20261110-lv46-continuation-evidence/validation.json)、[ファイル別結果](20261110-lv46-continuation-evidence/non-gui-suite.json)。過去の3,214件や途中の3,330件を今回の結果へ加算していない。

変更先はintegration、branch `codex/folio-lv5-collaboration-20261109`、開始・現在HEAD `522665c28747d91bb5f23f007b4037375933b893`。検証終了時点では未commitだった。現在の保存先・再開手順は[引き継ぎメモ](20261110-HANDOFF-LV4-LV6.ja.md)を参照。[候補source manifest](20261110-lv46-continuation-evidence/source-manifest.json)のSHA-256は `bd4fa1fd02f4c689ea703b76be05fc9d60edc341745a73c1c55e0da4fbc2afe0`。文書の自己参照hashを避け、source／test／script／比較候補等899ファイルを固定している。

## 各Levelの到達点と未達

| 対象 | コード・本体接続 | 今回の非GUI確認 | 残る条件 |
| --- | --- | --- | --- |
| Lv3 個人利用 | 既存private保存／DB／添付／回復契約を維持 | 個人機能を含む全体回帰PASS | 新候補の実GUI・IME等はNOT_RUN。過去の個人機能を未完成へ戻していない |
| Lv4 複数端末 | 既存同期に加えWindows PrivateLedger／vaultのnative proof候補、本体factory、回復indexを接続 | 実SQLite、所有Node障害、資格情報port、sidecar／path／UNKNOWNの注入契約、既存Mac回帰PASS | Mac実Keychain／終了・復帰／実2台＋server、Windows固有OS／DPAPI等はNOT_RUN。private全journal／汎用durable-file／監視のWindows全面移植は未完 |
| Lv5 共同編集 | 通常Editor、型付きbatch、rich inline／mark／split／join／move／frame／表、own Undo、DB／record copy、大きいcopy、復旧・ごみ箱の導線を接続 | main→HTTP→SQLite、PM Step/Map、同時変更・Undo・UNKNOWN・原文保持、900k本文の差分保存、DB／record、添付公開を確認 | GUI／実IME／物理複数利用者はNOT_RUN。無条件full採用はHOLD。有界profileと明示競合停止を越える保証をしない |
| Lv6 組織運用 | 既存role／複数workspace／加入離脱・引継ぎに、実backup復元証明、圧縮、protocol移行、容量・添付回収、所有者回復、失効writer staging回収を接続 | current認可、旧writer拒否、実1003→1004移行、backup→隔離restore、compiled CLIの連続経路PASS | 実組織運用・実測SLO/RPO/RTOは未受入。過去raw／Undo／receipt等の完全自動purgeは実装していない。Windowsの私有資格情報公開portは未実装 |

GUI／実機待ちと、実装不足は別欄で管理する。Windows版の全面対応やLv6認定を、Macの注入試験・cross-buildから推論しない。

## 通常Editorと永続保存

`App / SharedWorkbench → Editor共有分岐 → preload有界FIFO → SharedRuntimeService → durable document/resource client → HTTP/TLS → SharedAuthority → shared専用SQLite`へ接続した。privateの全量checkpointを共有更新へ転用しない。

- `editorDocument`の通常編集を64 atom以内の型付きbatchへ分解。rich inline／6 mark、複数block、heading属性、Enter／join、list／quote／details等の包み込み・解除、既存wrapperを残す子移動、表行列を扱う。
- `block.frame`は保持対象の**現在のsubtree**を運ぶ。削除される部分への未観測変更は`DELETE_CONFLICT`。旧containerを残すshellを扱い、retained descendant IDの二重挿入を拒否する。
- 移動・frame専用のPM Step/Mapとincremental projectionを使い、remote更新で`setContent`／history clearを繰り返さない。通常Editorの共有Undo/Redoはmainへ接続。
- source beforeはclient入力を信用せず、root-boundなcontent-addressed versionから検証。適用直前状態`appliedBefore`をイベントhashへ含め、他者の既存装飾・後続入力をown Undoが消さない。
- 900k本文の1文字変更と全体boldは、source hashに結び付く小さいpatch／mark commandで保存。emojiのsurrogate境界、hardBreak、未知attrsのlossless拒否を検証。混合した大変更が必ず小さくなる保証はない。
- 初回は現在stateだけ、以後は差分を取得。既知cutのepoch／prefix照合を維持し、履歴event cacheを最大4MB／128件へ制限。大量差分の読取上限ではstateへ切り替え、必要なら古いUndoを明示的に切り詰める。無制限履歴ではない。
- UNKNOWNは送信前に永続化し、自動再送しない。accepted receipt後の読取失敗もpending historyを保持し、新規保存／Undoを止めてreconcileで解決する。取得eventはreceiptのcut／hash／scope／writer／intent／attemptへ照合する。

主なsourceは `src/collaboration/runtime/{client,authority,editor-batch,editor-plan,compact-inline,block-frame,editor-versions,local-history}.ts`、`src/collaboration/runtime/pm-move.ts`、`src/editor/shared-frame-step.ts`、`src/editor/shared-projection.ts`、`src/editor/Editor.tsx`。実際のファイル名とhashはmanifestを正本とする。

## コピー・回復・保守

- 大きいcopyはimmutable manifest、最大100分割の原稿、別送binary添付を使い、文書／metadata／assetを最後のcutで公開。消費後のstaging原稿を削除し、receipt／dedupは保つ。0-byte添付も検証した。
- 1ページ2MB、原稿合計32MiB、未完了8件／全体予約32MiB、Store64MiB、outbox20MB等の複数の入場制限がある。32MiBを必ず格納できるという意味ではない。
- 未公開staging原稿と拒否原文を他writerのsnapshotへ返さない。正当な共有文書は最終公開後に参照できる。
- 個人DBと明示選択recordの5 property型（text／number／select／date／checkbox）を、新しいDB／property／record IDへ写す。DBとrecordの選択順に依存しない。選択外bodyを読まないmetadata catalogをpickerへ接続。
- 同一actorの未公開copyをmetadata一覧から明示中止できる。UNKNOWN・pending・編集中rawがある場合は止める。元ページがごみ箱でもstagingだけを除去し、ページを再作成しない。
- 旧writerのdirectoryを新認証から読み取り専用で回収でき、文書未選択でも原文を確認できる。旧intentを新writerへ自動再送しない。
- ごみ箱一覧と新incarnationへの復元をmain／IPC／UIへ接続。
- `maintain` CLIは実backupの隔離restore検証、fence後のprefix圧縮、実1003→1004 baseline移行、添付回収を扱う。SQLite物理version1003とlogical protocol1004を区別する。
- `recover` CLIは新token／回復キーを私有fileへ永続公開した後で外側COMMIT。結果不明は`RECOVERY_UNKNOWN`として出力を保ち、自動再試行しない。
- 失効writerのstagingは**現在の組織ownerによる明示操作**だけで回収。exact cut、scope／writer／copy／manifest hashと全device・session失効を照合する。元raw／intent／receipt／auditは変更しない。active writerとcommit済みcopyは回収できない。

運用引数は[Node運用仕様](20261110-shared-runtime-operator.ja.md)。既存Folioや本番serverでこれらを実行したものではない。

## 方式再比較・独立レビュー

[新しい採否記録](20261110-shared-editor-candidate-decision.ja.md)に整理した。B/C binding20件、独立gate＋shared image20件、計40件PASS。旧Cのmixed text／structure Undo反例は、専用MoveStep/Mapを用いた現在候補で通過した。R05のin-memory「unprovable delivery」診断をdurable成功と数えず、実HTTP／SQLite／所有子process障害は製品suiteの別証拠を使う。旧baselineの反例再現PASSを本採用へ加算しない。

OpenCodeの別レビューsessionと、実装者と異なるCodex reviewerで、frame削除競合／ID重複、record順序、staging容量、history pending、event-cut整合性、Windows禁止領域／COMMIT後UNKNOWN、helperの外部DLLを照合し修正した。最終の対象範囲に未解決の確定P1/P2はないというレビュー結果であり、全製品・全環境の保証ではない。[指摘と採否](20261110-lv46-continuation-evidence/review-triage.json)、[R07](20261110-lv46-continuation-evidence/reviews/R07-final-rpc-staging.md)、[R08](20261110-lv46-continuation-evidence/reviews/R08-staging-owner.md)、[Windows](20261110-lv46-continuation-evidence/reviews/R05-windows-codex-final.md)。

## Windowsの実装候補と証拠

実SID／DACL／reparse／hardlink／volume・File IDのprobe、動的writer directory、sidecar pin、native create/openとFlush/readbackを、本体RuntimeStore／PrivateLedger／vault／recovery index／選択asset読取のfactoryへ接続した。workspaceと資格情報rootの重なりを拒否し、COMMIT後の不確実性を成功や単なるlocal errorへ変換しない。

C# probeと所有process Job helperはMac上でmanaged compilationおよび**win-x64 single-file EXE cross-publish PASS**。実PEは`0x8664`で、埋め込んだapp DLLをビルドassemblyのSHA-256へ照合し、出力に外部app DLLがないことを確認。共有system .NET10 runtimeは別途必要。[生成物hash](20261110-lv46-continuation-evidence/validation.json)。Windows EXEは実行していない。arm64 publish／アプリpackage／署名はNOT_RUN。

コード上の残件は、Windowsでの私有資格情報の安全なnamespace公開port、および既存private journal／汎用durable-file／終了監視の全面的なport移行。CLI recover等のPOSIX file＋directory fsyncをWindows対応済みとはしない。実ACL／NTFS／sharing violation／DPAPI／Job Object回収／停電耐性の受入は別のNOT_RUNである。

## 後日の最小受入

1. Windows A/B＋独立serverは、専用candidate rootとhelper hash／OS・machine・user identityを記録し、native path／SID/DACL／sidecar／owned processの固有suiteを先に実行する。次に共通の同時編集・切断・ACK喪失・失効・restore／容量suiteへ進む。同一PCの2 processやWSLを物理2台と数えない。
2. Macは同じ候補をビルドし、専用一時dataで実Keychain／IME／picker／終了復帰等とA/B＋serverを確認する。既存MAC-P05のguardと実ホスト条件を維持する。
3. GUI実行は後日の明示指示が必要。入口は`npm run test:e2e:batch`で、専用一時`FOLIO_DATA_DIR`を使う。現在はGUI／実機すべてNOT_RUN。

## モデル使用・禁止事項

有料Go DeepSeekを小さい専有packetで並列使用し、実際の`Go usage limit exceeded`でfree DeepSeekへ切り替えた。free側も`Free usage limit reached`となったため所有する停止中CLIだけを終了し、途中成果・文脈・指摘をCodexの並列担当へ引き継いだ。課金／global設定は変更していない。継続分35 CLI dispatchのmodel／終了状態／取得usageは[台帳](20261110-lv46-continuation-evidence/dispatch.json)。stepの繰り返しcache読取を、請求額・残quota・節約率へ読み替えない。Fable5.2は[既存差分相談と採否](20261110-fable52-delta-review.ja.md)を再利用し、追加呼出ししていない。

原本Notion_reaはmaster `e269137f191081cabc0f05aa03ec68339ce413c2`、tracked clean、既存untracked `artifacts/`／`outputs/`はそのまま。[所有監査](20261110-lv46-continuation-evidence/ownership-audit.json)。GUI起動、push、workflow作成・変更・実行、master merge、デプロイ、実データ操作、課金設定変更は行っていない。
