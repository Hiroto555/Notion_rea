# Folio Lv4〜Lv6 引き継ぎ・GitHub保存

2026-11-10。前回の約4時間の実装と継続実装をまとめた引き継ぎ。今回の依頼は、ここまでの候補・証跡をcommitしGitHubへ保存すること。追加の機能実装やGUI受入は行わず、ここで区切る。

## 最初に確認すること

- repository: `Hiroto555/Notion_rea`。
- 作業branch: `codex/folio-lv5-collaboration-20261109`。原本側のmasterとは別のintegration worktree。
- 実装開始base: `522665c28747d91bb5f23f007b4037375933b893`。このメモを含む保存commitは`git log -1 --format=%H -- docs/roadmap/20261110-HANDOFF-LV4-LV6.ja.md`で特定できる。
- [GitHubの保存先](https://github.com/Hiroto555/Notion_rea/tree/codex/folio-lv5-collaboration-20261109)。GitHub反映はこの作業branchのみ。既存Draft PR #12等のheadを動かさず、新規PRを作成しない。
- 試験対象source manifest SHA-256: `bd4fa1fd02f4c689ea703b76be05fc9d60edc341745a73c1c55e0da4fbc2afe0`。[899ファイルの正本](20261110-lv46-continuation-evidence/source-manifest.json)。Git commit hashとは別の値。
- **確認済みLevelはLv3。Lv4〜Lv6は実装候補で、GUI・物理機の受入完了ではない。**

実際のローカルpathは`git worktree list`とユーザーが指定したintegrationを照合する。新しい環境では上記branchを別worktreeへ取得し、既存の個人Folio・DB・assets・credentialを開かない。

## 読む順序

1. repositoryの`AGENTS.md`、`docs/QUIET-TESTING.ja.md`、`docs/QUIET-IMPLEMENTATION.ja.md`。
2. [今回までの到達点・未達・検証](20261110-lv46-continuation-progress.ja.md)。現在地の正本。
3. [共有Editor候補の採否](20261110-shared-editor-candidate-decision.ja.md)。旧NO_GOと今回の正常系確認を混同しない。
4. [Node保守・復旧CLI](20261110-shared-runtime-operator.ja.md)。実データでの実行許可ではない。
5. [検証JSON](20261110-lv46-continuation-evidence/validation.json)、[独立レビュー採否](20261110-lv46-continuation-evidence/review-triage.json)。
6. 必要な場合だけ[前回4時間分](20261110-lv36-execution-progress.ja.md)、[Fable5.2差分判断](20261110-fable52-delta-review.ja.md)、[承認した計画](20261110-lv36-implementation-plan.ja.md)。古い未実装欄を現在の未達へ戻さない。

## 累積した到達点

| Level | 実装・本体接続できたもの | 残る実装・制約 | 未実施の受入 |
| --- | --- | --- | --- |
| Lv4 自分の複数端末 | 既存同期・競合保全・終了時予約／次回起動適用・完全backup／restoreを維持。Windows PrivateLedger／vault／runtime／旧writer原稿回収等のnative proof候補を本体factoryへ接続 | private journal／汎用durable-file／終了監視のWindows全面移植は未完 | 実Mac Keychain／IME／終了復帰、物理Mac A/B＋server、Windows OS／DPAPI等 |
| Lv5 異なる人の共同編集 | 実認証・権限、専用durable storeとoutbox、通常Editorのrich／mark／split／join／move／frame／表、他者変更を残すown Undo、DB5型・record、添付、選択copy、ごみ箱・旧原稿回収 | 無条件full採用HOLD。有界profileと競合停止を越える自動解決・無制限履歴は保証しない | 現候補のGUI、実IME／clipboard／DnD、物理複数利用者 |
| Lv6 組織運用 | 複数workspaceとorg／本文権限分離、加入離脱・引継ぎ、監査・容量、実backup隔離復元証明、圧縮、1003→1004実移行、所有者回復、添付回収、fenced writerのstaging明示回収 | Windows私有資格情報の安全な公開portは未実装。過去raw／receipt／Undoの完全自動purgeと実運用SLO/RPO/RTOは未完・未測定 | 小組織の実運用、物理機での更新・障害・復旧受入 |

今回解消した主要残件は、Cの本文＋構造mixed Undo反例、通常Editorのrich／frame接続、DB／record copy、約850KBを超えるcopy、旧writer原稿を新接続から読むUI、実migration runner、保守CLI、Windows本体の部分接続。過去のB/C比較の反例再現PASSを採用成功と数えない。

## 最終検証と再現の注意

| 検証 | 現候補の結果 |
| --- | --- |
| `npm run check` | PASS |
| 全体Vitest | **336ファイル／3,458件PASS、失敗0、skip0** |
| `npm run build` | PASS。大きいchunkとstatic/dynamic importのVite warningあり |
| B/C binding＋独立gate＋shared image | 合計40件PASS。R05 in-memory診断はdurability成功ではない |
| ビルド済みNode CLI | 一時SQLiteと所有loopback serverでbootstrap→回復→旧token失効→backup検証→圧縮→protocol更新→restore→再openがPASS |
| Windows helper | probe／Job helperのwin-x64 single-file EXE生成、PE／埋込app DLL照合PASS。Windows実行ではない |
| GUI・実Mac／Windows・実Keychain／DPAPI・物理複数機 | すべてNOT_RUN |

3,458件のうち2件は一時領域のWindows生成物を読む検査。元のEXE／SDK／一時SQLiteはGitへ含めない。新cloneで`npm test -- --maxWorkers=2`を実行すると、生成物を明示しない既定では**3,456 PASS／生成物2件SKIP**になる。これはWindows OS確認の代替ではない。生成物を再buildしてその専用一時rootを`FOLIO_WINDOWS_HELPER_BUILD_ROOT`へ渡したときだけ2件を再実行する。Windows build手順は`scripts/platform/windows/build-native.ps1`を参照し、EXEは起動しない。

製品・test・script sourceは最終検証manifestから変更せず保存する。今回の保存準備は引き継ぎ文書と、公開用ログ等のローカルhome pathラベル整理だけ。公開ログのhashと元ローカルhashを区別する。前回3,214件と今回3,458件は別候補の全体試験で、足し算しない。

新しい検証環境はNode 24系を使う。rootと比較packageの依存をlockfileから準備した後、必要な非GUI確認を次の入口で再現できる。heavyな試験／buildは最大2 jobまでにする。

```sh
npm ci --no-audit --no-fund
npm run check
npm test -- --maxWorkers=2
npm run build
npm --prefix experiments/collaboration-comparison ci --no-audit --no-fund
node experiments/collaboration-comparison/build.mjs
node experiments/collaboration-comparison/next/build.mjs
node --test experiments/collaboration-comparison/next/b/binding.test.mjs experiments/collaboration-comparison/next/c/binding.test.mjs experiments/collaboration-comparison/next/independent-gates.test.mjs experiments/collaboration-comparison/next/shared-image.test.mjs
```

比較用bundleは生成物なのでGitへ含めない。上のbuildを省いて新cloneで比較試験だけを実行しない。

## 保存形式と接続境界

- private／sharedのSQLite、assets、authority、credential、checkpointを分離。
- `SharedWorkbench → Editor共有分岐 → preload FIFO → SharedRuntimeService → durable client → HTTP/TLS → SharedAuthority → shared SQLite`。
- intent／attempt原文はimmutable。送信前にUNKNOWNを永続化。receipt不在は未適用の証明ではなく、自動再送しない。
- 既知epoch／seq／prefix hashと現在の認可・incarnationを照合。大きい文書の初回state取得と以後の差分取得を分離し、未公開copy原稿・拒否原文を他writerへ返さない。
- 原稿回収は読み取り専用。旧intentの新writerへの書換え・自動再送をしない。staging回収は同一actorの明示操作、または現在org ownerによるexact-cut＋全device/session失効確認後の明示操作だけ。
- 実装profile: 本文1ページ2MB、64 atom/batch、1MB wire、原稿copy32MiB／100分割、未完了8件／予約32MiB、Store64MiB、outbox20MB等。各最大値を同時に使える保証ではない。

主なコードは`src/collaboration/runtime/`、`src/main/shared-runtime-service.ts`、`src/editor/shared-{projection,frame-step,image}.ts`、`src/renderer/shared/`、`src/platform/windows/`。保守入口は`src/collaboration/runtime/{server-entry,maintenance-operator,recovery-operator,restore-operator}.ts`。

## 再開時の優先候補

1. 読取調査でbranch／保存commit／source hash／原本の不変を照合。原本master・未追跡artifacts/outputsを変更しない。
2. コードを続けるなら、Windows資格情報公開portとprivate残経路の全面移植を、OS受入とは別の課題として扱う。保全データのpurgeはUNKNOWN／receipt／Undo依存を破壊せず、明示した保持契約から設計する。
3. 実利用受入へ進むなら、同じ候補のMac／Windows固有portと物理A/B＋独立serverを確認する。GUIには別の明示指示が必要で、入口は一時`FOLIO_DATA_DIR`付きの`npm run test:e2e:batch`。現時点で実行しない。

## 権限・モデル使用

今回のGitHub保存指示で許可されたのは、このbranchのcommit／push。**GUI起動、workflow作成・変更・実行、master merge、デプロイ、実データ操作、課金／global設定変更は禁止を維持。** PRは`pull_request` workflowを起動し得るので作らない。保存commitに`[skip ci]`を付け、既存workflow定義は変更しない。

Fable5.2の再相談は済みで、5.1資産を再利用した差分採否が保存されている。必要なく全packetを再投入しない。OpenCode Go DeepSeekは継続中に有料上限、次にfree上限へ到達し、停止中の所有CLIを終了した。残作業は既存成果を引き継いだCodex並列担当で完了。残quotaのlive値は未確認で、課金／設定を変更したり無限retryしたりしない。

GitHubへ載せるのはコード、計画、レビュー、集計usage、合成試験の整理済み証跡。auth設定、生session／思考ログ、実資格情報、DB、native binary、個人Folioデータは含めない。
