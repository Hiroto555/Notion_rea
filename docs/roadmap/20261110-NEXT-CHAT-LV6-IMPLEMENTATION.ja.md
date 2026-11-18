# 次チャットへの依頼：Fable方針レビュー → 計画を返信 → Goサイン後にDeepSeek並列実装

2026-11-10 JST。これは次チャットへ渡す実行プロンプト。作成時は現状調査と本文書の追加のみ。Fable相談・DeepSeek投入・製品の追加実装・試験はまだ行っていない。

## 利用者からの依頼

FolioのLv3の残件があれば拾い、Lv4・Lv5・Lv6を含む、今このMacで可能なコード実装と非GUI検証を最大限進めるための方針と計画を、まず作成してください。**方針を実コードと照合して計画を固めたら、必ず一度利用者へ返信してターンを終了し、明示的なGoサインを待ってください。計画報告と同じターンで実装へ移らないでください。** Goサイン後に、承認された範囲の実装・本体接続・独立レビュー・検証・結果資料まで続けてください。目標は、後に実機とGUIで検証する候補コードをできるだけ完成させておくことです。100%と断言するために合否条件を下げることは求めていません。

最初に **Devin CLI経由のClaude Fable 5.2 XHigh** に全体方針を相談し、その回答を実コード・既存契約へ照合して計画を固めてください。Goサイン前に許可されるのは、読み取り調査・この方針相談・計画資料の作成までです。**製品コード/依存/設定の変更、実装用DeepSeek workerの投入、テスト/buildの実行はGoサイン後**に行ってください。その後は **有料OpenCode GoのDeepSeekを最大限並列** に活用し、実際に接続できた経路を増やすことを優先してください。

## 作業先・禁止事項

- 実装する統合ツリー：`<LOCAL_HOME>/Documents/ChatGPT/Folio-lv4-implementation-20261107.3qXBLqRk/integration`
- 確認時branch：`codex/folio-lv5-collaboration-20261109`
- 確認時HEAD：`522665c28747d91bb5f23f007b4037375933b893`。本文書追加前はclean。
- 原本：`<LOCAL_HOME>/Documents/ChatGPT/Notion_rea`。masterは`e269137f191081cabc0f05aa03ec68339ce413c2`。原本と既存の未追跡artifacts/outputsには触れない。
- 変更は上記統合ツリーと、その作業が所有する一時コピー/一時データのみ。開始時にGit・worktree・進行中processと適用されるAGENTS.mdを再確認する。他人の変更を消さない。
- **GUI起動禁止**。Electron、GUIブラウザ、GUI E2E、ネイティブダイアログ、OSクリップボード、スクリーンショット用アプリを使わない。hidden window、dev/start、demo等による迂回もしない。
- **push、workflowの作成・変更・実行、master merge、デプロイ、課金/グローバル設定変更は禁止**。既存Folio・実データ・個人Keychain・既存server・無関係なprocessは操作しない。
- Node/Vitest、Node内のjsdom、一時SQLite、自分で起動したNode子process、一時のloopback通信、型検査/buildは可。loopback以外の実サーバー接続や複数機での実行は今回しない。外部モデル呼出しは指定経路で行う。
- GUI/実機待ちを理由に独立した非GUI実装を止めない。必要な画面/IPC/UI状態の**コードは実装してよい**が、アプリは起動しない。GUIと実機の結果はNOT_RUNのまま残す。

## 読む資料と現在地

以下は統合ツリーを基準に読む。古い文書の「計画だけ」「Lv5未実装」等は履歴で、最新判断・コードを優先する。今回の計画対象は過去の「今回は隔離PoCのみ」より広いが、実装着手は計画報告後のGoサインを待つ。方式採用gate・個人データ保護・証拠基準は解除しない。

1. `AGENTS.md`、`docs/QUIET-TESTING.ja.md`、`docs/QUIET-IMPLEMENTATION.ja.md`。
2. **最新判断** `docs/roadmap/20261109-collaboration-decision.ja.md`。
3. `experiments/collaboration-comparison/{README.ja.md,TEXT-PILOT-CONTRACT.md,comparison-result.json,text-pilot-result.json,final-review.json}`。
4. `docs/roadmap/20261108-lv456-sprint.ja.md` と `experiments/shared-workspace-lab/{README.ja.md,final-review.json}`。
5. `docs/lv4/{NEXT-SESSION.ja.md,GATE-STATUS.ja.md,M3-ACCEPTANCE.ja.md,QUIET-RESIDUAL-EXECUTION.ja.md,MAC-P05-RESOURCES-AND-SCOPE.ja.md}`。
6. `<LOCAL_HOME>/Documents/ChatGPT/Folio-lv5-plan-20261107.jdt9aoyu/LV5-PLAN.ja.md`：既存V01〜V15 / L5-01〜14。
7. `<LOCAL_HOME>/Documents/ChatGPT/Folio-lv6-direction-20261108.edo0y4q0/LV4-LV6-DIRECTION.ja.md`：Lv4〜6全体、Lv6初版の提案範囲。
8. `docs/roadmap/20261108-opus-strategy/{03-LV5-COMPARISON.ja.md,04-LV5-SAFETY.ja.md,05-STOPPING-POINTS.ja.md,06-DISPATCH-PACK.ja.md}`。

| 段階 | 現在の到達点 | 今回進める方向 |
| --- | --- | --- |
| Lv3：個人利用 | 確認済みLevel。既存の編集/保存/階層/DB/添付等を保護 | 現コード/台帳から残欠陥があれば修正。古い記録だけで全部未完に戻さない |
| Lv4：個人の複数端末 | 同期・運用・guard・証拠validator・外部watchdog等を実装。Mac実機受入待ち | 非GUIで残る回復/永続化/ハーネス/移植を進める。実機条件を偽装しない |
| Lv5：異なる人の共同編集 | 実schema比較と本文限定C方式PoC、main下書き準備まで | 既知反例解決→採否→永続化/認可/provider/通常Editor/DB/添付/復旧を接続 |
| Lv6：組織の継続運用 | 一部の隔離部品・状態投影・metadata案まで | 複数共有領域、加入/離脱/引継ぎ、監査/容量、backup/更新/復旧を実装・接続 |

認定は**Lv3**のまま。コード実装、非GUI合格、GUI確認、物理端末確認、Level受入を別の列で管理する。前回の2,329件/245ファイルPASS、比較/限定PoC48件、旧lab319件は過去証拠。最新保存前レビューでは関連55件＋48件・型検査・build等を再検証している。今回のfresh実行と混ぜない。旧候補Mac GUI240 PASS/実IME1 INFRA_BLOCKEDも現候補のGUI証拠ではない。

### コードを読む際の重大な注意

- 本体のrich schemaは22 node/6 mark、block識別は`attrs.id`。`experiments/shared-workspace-lab`の旧試作は`blockId`/`strong`等が本体と異なり、そのまま製品形式へ昇格させない。
- 実schema比較ではB（Yjs/y-prosemirror）もC（PM collab/history）も限定本文/Undoは通るが、**R02 moveと他者編集、R03 同時の表行/列変更が失敗**。緑テストには失敗反例の再現が含まれる。**full採用NO_GO**。C採用は同一textblockの非装飾ReplaceStepだけ。
- B当初案のserver構造コマンド層は完成比較していない。CRDT一般が駄目、Cが全面優位とは結論しない。最新block IDへ解決する意味付き構造コマンド等を具体化し、両方式を同じ意味の合否で再比較する。既知の消失を黙認して全面接続しない。
- `src/collaboration/`と`src/main/shared-preparation.ts`は原文保全・別SQLite・session/epoch/generation fence等の準備。**通常Editor/AppとElectron IPCへ未接続**。trusted試験bindingは本番認証ではない。
- 本文PoCのLOCAL_INTENT/WIRE_ATTEMPT保存は隔離履歴。**再起動可能なdurable outbox、intent→receiptの永続対応、破棄/回収、実provider/auth、compactionは未完**。ACK不明はreceipt-firstで照会し、欠落ならUNKNOWNのまま原文を残して停止する。
- 個人と共有のSQLite/assets/binding/authorityを分離。private fingerprint/schema/checkpointをlabに合わせない。private全量checkpointがsharedを書き換える経路を作らない。
- raw未知値・unsafe整数・ID・不正Unicode・負けた編集意図を黙って落とさない。LOCAL_DURABLE / SERVER_ACCEPTED / CLIENT_RECEIPT_DURABLE / PEER_APPLIED / UNKNOWNを区別する。

## 最初にDevin CLIのFableへ相談する

今回確認したCLI：`<LOCAL_HOME>/.local/bin/devin`。`devin models list --format json`で **`claude-fable-5-2-xhigh`** を実際に確認済み。次チャットでも再確認し、別model/fast版へ黙って置換しない。

親Codexが上記資料とコードを読んで、短い共通brief、現在の契約、失敗trace要約、必要な型/APIと接続図だけを一時領域へまとめる。全文履歴や巨大ログは渡さない。CLIの`--model`、`--prompt-file`、`--print`、`--export`、`--permission-mode auto`を使う非対話相談を基本とし、使用可能な設定とtrustは実CLIのhelpで確認する。GUIのdesktop/cloud sessionは使わない。相談は設計のみで、Fableには編集・shell・ネット操作・再委譲をさせない。秘密をbrief/exportに含めない。

### 必須：Fableのusageを節約するための情報整理と渡し方

- **資料収集・コード探索・事実確認・重複除去・計画の初稿は親Codexが先に済ませる。** Fableにリポジトリ全探索や長文資料の要約を代行させない。本引き継ぎ文書や会話履歴を丸ごと送らない。
- 一つの相談packetを「目標/禁止事項」「確認済みの現在地」「既存契約と既知FAIL」「Codexの推奨案と代案」「判断してほしい論点」に整理する。事実・仮説・未確認を区別し、同じ情報は一度だけ書く。初回入力は目安4〜8k tokens程度で、判断に不可欠な情報だけを残す。必要な根拠まで削ることを優先しない。
- コードは問題に関係する型/API、保存境界、最小失敗trace、代表的な呼出しだけを抜粋し、source path/行/commitを付ける。巨大ログ、全test一覧、生成物、不要な依存、秘密を送らない。Fableが参照できないpathだけを渡して根拠の代わりにしない。
- 相談は優先度順の3〜5論点にまとめる。Fableの役割は**初稿の重大な穴・採否・依存順・並列境界のレビュー**とし、確定済み事項の再説明、一般論、全コード生成、詳細な全担当カードの書き直しを頼まない。回答は変更すべき点・理由・実行順を中心に、目安1,500〜3,000字程度で求める。細かな担当カードと最終計画への展開は親が行う。
- 原則1回にまとめる。追問が不可欠なら、前回答の該当箇所・追加根拠・未解決の質問だけの短い差分にする。同じbriefを新規sessionへ何度も再投入したり、Fable同士の重複相談をしたりしない。再開/context再利用は現CLIで成立する範囲を確認し、cache節約を保証しない。
- `claude-fable-5-2-xhigh`指定は維持し、節約のために別model/fast版へ黙って変更しない。取得できるinput/cache/output等のusageと呼出し回数を記録し、不明値は不明とする。表示上限やtoken数だけから請求額・節約率を断言しない。
- **整理済みpacketでFableへ相談 → 親が採否と計画をまとめる → 利用者へ返信して終了 → 明示的なGoサインを待つ**。usage節約を理由に必要な相談を省略したり、Go待ちを省略して実装へ進んだりしない。

Fableへの相談本文に、最低限以下を含める：

> 目標はLv3残件からLv6まで、GUI/実機待ち以外のコードを最大限完成させること。現認定Lv3、Lv4実機待ち、Lv5 full NO_GO/本文限定C PoC、Lv6隔離試作。添付のCodex初稿について、次の3論点をレビューしてほしい。(1) R02/R03解決とB/C再判定、実schema/ID/Undo、outbox/receipt/認可、DB/添付、通常Editor接続からLv6運用へ進む順序に重大な穴があるか。(2) Windows複数機で共通同期を先に検証するための移植境界と、Mac固有受入の切り分けは妥当か。(3) DeepSeekの並列担当境界/依存DAGと親の統合責任は妥当か。変更点・理由・優先順・見落としている必須条件だけを簡潔に回答し、初稿の反復や詳細な全担当カード生成は不要。本文の収束だけを編集意図保全やfull採用の根拠にしない。不足する根拠は推測で埋めず指摘してほしい。

原則1回の相談と、重大な不足への短い差分追問に絞る。モデルの賛成・CLI終了0を合格証拠にしない。親が実コード/反例/既存gateへ照合し採否を記録したら、**推奨方針、実装範囲と順序、DeepSeek並列分担、Windows対応、保留事項とリスクを利用者へ返信し、ターンを終了する。明示的なGoサインが届くまで実装しない。** 相談経路が利用不能ならその事実を明記し、他modelに勝手に切り替えず、読み取り調査と計画整理までに留めて報告する。

## Goサイン後に実装する作業の波

順序は依存部分だけ守る。Lv4実機待ちや一つの方式反例で、独立したLv6/Windows作業を全停止しない。各波を小さく接続・検証し、巨大な最後の一括統合にしない。

1. **現状固定と残件台帳**：Lv3/4/5既存gateとLv6初版条件を、コードpath・未接続点・非GUI合否・実機待ちに対応付ける。Lv6初版は既存提案の1組織・単一server・小チーム・複数shared workspaceを基本に契約化する。人数/容量/保持/offline期間/復旧目標は測定可能な暫定値を明示し、未計測保証をしない。
2. **共同編集の既知失敗を解決**：移動/削除/表の意味付きserver構造コマンド、block/row/column ID、競合intent保存/回収、Undoの関係を実装。両方式で同じ合法操作と反例を評価して採否ADRを更新。全部拒否して合格にしない。未解決なら依存するfull editor接続だけを保留し、実際に残る障害を明記する。
3. **本体の共有保存経路**：実schemaに基づく専用共有store/version/fence、server log/head/receiptのatomic commit、client outboxとreceipt対応、再起動再構成、ACK喪失/確定拒否/UNKNOWN、epoch/incarnation/旧backup/長期offline、compaction/保持/容量を実装・試験する。旧labの再利用は契約/形式を移植して実際に接続する。
4. **認証・権限・provider・通常Editor接続**：user/deviceの実認証境界、招待/role/失効/最後のowner保護、既存接続・queue・asset・receipt再認可、main-owned typed IPCとpreload、scope/session/generation/navigation fence、remote変更のprivate保存echo防止、各人のUndoを接続。前段gateを通した機能から、明示された共有経路として配線する。実ユーザーの共有やserver接続は有効化せず、一時の合成データで縦切りを通す。
5. **Lv5機能の統合**：階層、DB schema/record所有/content/value/deleteの共通cut、asset bytes/hash/公開順/GC、private→sharedのpreview copy（リンク/ID/未知raw/添付）、検索/参照、export、履歴/削除/restore/new incarnation、完全backup/restore、UI保存/権限/復旧状態を実装。本文だけの共同編集をfull Lv5としない。
6. **Lv6の運用を接続**：組織とworkspaceのrole分離、複数共有領域の分離、加入/離脱/引継ぎと最後の管理責任者、監査とアクセス、容量/保持/backup状態一覧、更新互換/旧writer拒否、更新失敗/復元/recovery後の再開を実装。metadata案やUI投影だけでなく、実authority/persistence/serviceへ接続する。課金/SSO/SCIM/巨大分散基盤等へ範囲を広げない。
7. **Windowsで後日実行できる候補と受入ハーネス**：下記の移植境界と共通複数機suiteを実装。Mac上で可能なpure adapter/contract testsとbuildまで進め、Windows実行はNOT_RUNで残す。
8. **非GUI最終レビュー**：個人機能回帰、方式反例、合成複数利用者、実SQLite・HTTP・自分の子process障害を統合検証。差分/依存/license/秘密/所有pathを確認し、結果台帳と最短の残検証手順を保存する。実装未完を実機待ち欄へ押し込めない。

V04の共通14反例は元計画を引き継ぐ。特にR01二重seed/ID、R02移動意図、R03表、R04自分のUndo、R05障害/ACK重複、R06private checkpoint、R07DB複合cut、R08旧incarnation、R09失効、R10旧server backup/UNKNOWN、R11compaction、R12preview copy、R13private/shared同名ID/navigation、R14composition/remoteを落とさない。R14の合成イベントは実IMEの代替ではない。

## Windows複数機の方針

**Windowsを使うことは可。共通エンジン/通信の実機検証と、Mac固有受入を分ける。今回その準備コードまで進め、複数機実行はしない。**

| 対象 | Windowsを使った後日の確認 | Macに残るもの |
| --- | --- | --- |
| 同期/共同編集/認可/ACK/切断/復元/容量 | Windows A/B＋独立serverで共通suiteを実行できるようにする。物理機・OS・利用者・hashを記録 | 共通ロジックの証拠を再利用可能かgateへ対応付ける。既存Mac受入を自動PASSにはしない |
| 資格情報/ファイル安全性/終了監視 | Windows用provider・ACL・path/link・durability・process所有契約と固有suiteが必要 | Keychain、macOS権限/署名identity、Mac固有終了/復帰の受入 |
| 日本語入力/clipboard/picker/DnD/packaged app | Windows固有の実GUI受入は後日、別途明示実行指示で行う | Mac固有の実IME/clipboard/picker/Dock/Cmd+Q等 |

現コードはそのままWindows対応済みではない。調査時の具体箇所：

- `scripts/package.mjs`は`platform: darwin`/`arch: arm64`固定。Windows artifact生成/配布方法は追加実装が必要。cross-packageできたこととWindowsでの動作確認を区別する。
- `src/main/sync-connection-vault.ts`のworkspace所有判定は`process.getuid()`を必須にする。Windowsではこの契約をそのまま使えない。
- `src/sync/secret-record-file.ts`はwin32を明示拒否。`src/sync/private-ledger.ts`等のuid/mode、directory fsync、sidecar/link/inode前提も監査する。
- POSIXの0700/0600や負PID/process group、SIGKILL試験を、Windowsの安全性/終了証拠へ読み替えない。Windows ACL/所有・reparse point・case/path・原子的公開/永続化・所有子process停止等のadapterと合否を設計する。Windows実測が必要な部分はNOT_RUNとしてfail closedにする。
- Electron safeStorageはMacがKeychain、WindowsがDPAPIで、同じユーザー内の他appに対する保護の意味も異なる。共通portで隠して同一保証としない。現行Electron45の同期API非推奨も更新互換の台帳へ記録し、無計画なElectron全体upgradeへ広げない。
- 既存MAC-P05 guard/証拠schemaのMac要件を弱めない。別のplatform-neutral suiteとWindows固有caseを設け、既存L4 gateとの対応を明記する。WSL/VM/同一PCの2processをWindows物理2台として数えない。

仕様の一次資料： [Electron45 safeStorage](https://github.com/electron/electron/blob/v45.0.0/docs/api/safe-storage.md)、[Node24 process.getuid](https://nodejs.org/docs/latest-v24.x/api/process.html#processgetuid)。Fableには「Windowsで共通部分を先に実証する条件」と「Mac版としての未受入」を分けてレビューさせる。

## DeepSeekを最大限使う実行規則

- modelを **`opencode-go/deepseek-v4.1-flash`** に固定する。有料Goが指定であり、`opencode/deepseek-v4.1-flash-free`やDevin側DeepSeekへ勝手に変えない。認証/請求/グローバル設定を変更しない。
- 独立したtask packetを一時コピーへ配布し、入力commit/契約版/実際の型とAPI/必要helper/source hash/専有path/依存/正常系と反例/許可操作/報告先を同梱する。親Codexが共有型・main/preload・authority共通契約・harness/設定の最終統合を所有する。実装をDeepSeekへ委譲する際も同じファイルを同時編集させない。
- 小さな雑務だけに分割せず、一貫した縦切りを担当できる単位にする。大contextには関連する実コード・契約・試験を入れ、不要な履歴で埋めない。足りないhelperを探索権限の拡大で解決せず、packetを補充する。
- 過去は最大24 CLIの重なりを観測したがprovider hard limitは未確認。最初の少数packetで実動作/成果/制限を確認後、独立したready仕事を最大限増やす。24を絶対上限とも、何十でも成功する保証とも扱わない。heavy Node/buildは原則2枠まで。余剰枠は独立反例/レビュー/移植/運用suiteへ回す。
- 既存OpenCode1.18.30/runnerは有効出力上限32,000が問題になった。過去記録にlength終了3件、思考だけで通常出力0が2件あった。**model catalogの384k出力と実際のrequest上限は別**。まず現CLIの実効上限とprovider対応を確認し、必要なpacketに限りprocess単位の`OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`等の現在有効な設定で64k/128k候補を試す。全workerへ最大値を盲目的に指定しない。設定名/送信値/終了理由/成果物を確認し、秘密や思考本文を記録しない。
- variantは現catalogを確認し、使える値を指定する。過去はlow/high/maxで、mediumを仮定しない。高reasoningだけで成果物0になる仕事は、具体API・粒度・途中ファイル出力・上限を見直す。
- CLI exit0・modelの完了報告だけでは採用しない。所有外差分、成果物欠落、timeout、契約逸脱、テスト0件、length終了を台帳に記録。親が差分を読み、独立した正常系/障害系を実行して統合する。同じ失敗を同じpromptで繰り返さない。
- workerはshell/GUI/git/network/再委譲を禁止し、許可file toolだけに限定する構成を基本にする。親がNode試験と依存導入を管理する。自分が起動した所有processだけを期限付きで監督・停止する。
- 使用量はcache/fresh input/text output/reasoning、失敗/再投入を区別する。最大並列数だけを成果とせず、**採用できた接続済みコード・独立合格・親の手戻り**を測る。rate limitや枠不足は記録し、購入/課金切替/無限retryで解決しない。

前回runnerとauditは次に存在したが、OSの一時削除で失われ得る。なくても本文と現在のCLIから最小限を再構成し、汎用orchestrator作りを主目的にしない：

`/var/folders/fm/qk5fr3z11wq8hbphz6gk9llc0000gn/T/folio-lv5-selection-20261109-if07a_pv/`

`dispatch.py`、`prepare.py`、`usage-capacity-audit.ja.md`等。古いジョブ/権限/configをそのまま再実行しない。過去のusageは同じcontextの繰返しcache読込みを含むので、一度に大contextを使い切った証拠ではない。

## 終了時に必要な成果と報告

- 実コードへ照合済みのFable方針採否、依存DAG、担当/実行台帳。
- 各Lvのコード/本体接続/非GUI確認/GUI/実機を分けた一覧。未実装、BLOCKED、NOT_RUN、既知FAILを正確に記載。
- 新規機能を実authority/永続化/通常Editor/serviceへ接続したpathと、まだstub/metadata/試作のpath。mock-onlyを本体完成と呼ばない。
- 実行したcheck/test/build、対象件数、候補commit/差分hash、実行環境、結果。最終候補で必要な範囲を再確認し、過去ログだけでPASSを更新しない。通常は`npm run check`、`npm test -- --maxWorkers=2`、`npm run build`と対象実験suiteを使う。テスト件数を増やすこと自体を目的にしない。
- 実機/GUIなしで可能な作業を終えたか、その根拠。未完の実装は未完のまま理由/次手を記す。残るWindows A/B＋serverとMac固有受入の最小手順/必要権限をまとめる。UIの見た目調整は後回しにできるが、保存・権限・未確定・復旧の操作契約は今実装する。
- 変更は作業ブランチに保持し、禁止事項を守って結果を報告する。**最初の計画報告後のGoサインは必須**。Goサイン後は、承認された範囲内で毎waveの再承認を求めず、実装・修正・非GUI検証を継続する。Level認定、実機/GUIの起動、push/master mergeとは分ける。
