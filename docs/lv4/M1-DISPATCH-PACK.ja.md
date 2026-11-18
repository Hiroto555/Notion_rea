# M1の担当カードと投入手順

2026-11-08。**M1の非GUI受入完了、全worker終了、A3未着手で停止。** [実績](M1-COMPLETION.ja.md)を参照。以下は実行時の担当カード。D01はCodexが引き取り、D02〜D12をDeepSeekへ割当て、最大4本で実行した。 [実行計画](M1-EXECUTION-PLAN.ja.md)のG0レビューで契約と所有を固定し、実装開始の指示後にだけ使う。現在の基準は `732fad5`。workerへ渡す基点は、Codexが計画・契約を含めて新たに固定したcommitとする。

## CodexとSolの仕事

| ID | 担当 | 成果物・編集責任 | 終了条件 |
|---|---|---|---|
| C0 | Codex | A0、`src/shared/conflict-recovery.ts`、通常予約の共有契約、v4 schema構成と容量／fault portの契約。回収markerのprivate key／strict codec、一般setting IPCの拒否を固定。全jobの所有・基点・予算一覧 | G0：I/O、固定対象、失敗型、schema、marker、対象外をSol S0確認。宣言だけの曖昧なTODOで依存workerを走らせない |
| C1 | Codex | 既存`src/persistence/store.ts`、`src/sync/workspace-store.ts`／`workspace-sync.ts`／`workspace-checkpoint.ts`、通常restart／startup／quit／競合decision controller、`src/main/index.ts`／ローカルarchive service、shared IPC／preload、既存backup部品からのhelper抽出。v4 schema組立と共通の同期開始guardも単独所有 | G1：同一transaction消費、cross-journal排他、同期無効での回収、回収由来markerでstartup／手動再接続とも保留。既存互換を維持 |
| C2 | Codex | `src/renderer/App.tsx`／既存ConflictPanel／stylesの接続、全体quiet、候補hash、実装状況／GUI待ち一覧／結果記録。package／lockfile／試験設定もCodexのみ | G2：終了条件M1-01〜13と証拠を同じ候補へ揃え、A3へ進まず停止 |
| S0 | Sol XHigh | 契約・脅威境界・タスク依存のread-onlyレビュー | 出力はP0/P1、根拠、必要な試験、G0可否。実装しない |
| S1 | Sol XHigh | journal／export／importの固定候補をread-onlyレビュー | 重大指摘の処置を確認。自己検証するhash、旧予約移行、sourceへの書込み、情報持込みを重点確認 |
| S2 | Sol XHigh | 最終候補・独立試験・残件をread-onlyレビュー | P0/P1未解決なし。実画面未確認を認定に含めない |

共有ファイルをDeepSeekへ「ついでに直して」と渡さない。Codex側の変更で契約が変わったら、影響workerを止めて契約版と基点を更新する。Solのレビュー後に意味のある変更が入った場合は影響範囲を再レビューへ戻す。

## DeepSeekの12ジョブ

表のファイルは**編集allowlist**。既存の共通ファイルは読めるが編集不可。各実装担当は自分の単体試験を持ち、D09〜D12は独立した別試験を持つ。同じ試験ファイルを共有しない。

| ID・モデル案 | 内容・投入条件 | 編集可能なファイル案 | 完了として返す条件 |
|---|---|---|---|
| **D01 Flash** | A0の規模・容量・fixture案。W0、read-only調査から開始 | `docs/lv4/m1/A0-SCALE-AND-FIXTURES.ja.md`のみ | 既存1MiB／20,000,000 Bとの対応、合成fixture、上限超過時の停止、容量見積りと不確定を表で返す。上限変更の実装なし |
| **D02 Pro** | 通常適用予約journal。C0のID／CAS／transaction port確定後 | `src/sync/normal-apply-journal.ts`、`tests/m1-normal-apply-journal.test.ts` | strict／canonical／8KiB以内、古いID拒否、pending／cancelled／consumed、破損保全、cross-journal条件。consumeを本文更新の外で確定しない。既存restart接続はCodexへ |
| **D03 Flash** | ローカルarchive catalogと選択対象。C0確定後 | `src/sync/conflict-archive-catalog.ts`、`tests/m1-conflict-archive-catalog.test.ts` | sync transport／readStateを経ずread transactionで一覧・対象取得。50件page／最大100、keyset cursor、破損行の隔離、固定tuple再照合。register／rebind／schema変更なし |
| **D04 Flash** | 回収bundleの構造・内容検証。C0確定後 | `src/persistence/conflict-recovery-verify.ts`、`tests/m1-conflict-recovery-verify.test.ts` | JSON-onlyとrestorableを区別。strict format／version／bytes／hash／manifest／参照／上限／未完了markerを検査。sourceやbundleを書き換えない |
| **D05 Flash** | 添付のFD検証と新規出力へのコピー。C0確定後 | `src/persistence/conflict-recovery-assets.ts`、`tests/m1-conflict-recovery-assets.test.ts` | regular file／nlink／size／path境界、stream hash、別inode出力と再検証、入力差替え／欠損／ENOSPCで保全停止。ネットワーク取得・GCなし |
| **D06 Flash** | 検証付きJSON／bundle書出し。D03〜D05受入後 | `src/persistence/conflict-recovery-export.ts`、`tests/m1-conflict-recovery-export.test.ts` | ticket再照合→fresh出力→検証→完了公開直前の再照合→durable完了。JSON-onlyには添付なしを明示。bundle成功は全件の添付完全性を要する。中断出力は未完了のまま保持 |
| **D07 Pro** | bundleから新規v4 DBへ内容を復元。D04／D05とC0のschema契約受入後 | `src/persistence/conflict-recovery-import.ts`、`tests/m1-conflict-recovery-import.test.ts` | source DDL不使用。内容11表・FTS等の派生表・record marker・sequence整合、新しい回収由来marker。close／reopenで内容hash一致、source秘密／sync metadataなし。通常保存と履歴追加も確認 |
| **D08 Flash** | 回収一覧／確認／結果のUI部品とpure model。C0のprops／view型確定後、mockで先行可 | `src/renderer/WorkspaceConflictRecoveryPanel.tsx`、`src/renderer/conflict-recovery-model.ts`、`tests/m1-conflict-recovery-model.test.ts` | 未接続でも一覧へ到達するprops、古い応答無視、取消し／不明応答／JSONとbundleの区別、コピー先と未完了の明示。main／App／IPC／global stylesは編集せず接続要求を返す。GUI実行なし |
| **D09 Flash** | 通常予約の独立故障試験。契約後に条件を先行作成、実行はD02／C1受入後 | `tests/m1-normal-apply-faults.test.ts`のみ | 二接続CAS、reserve／cancel／consume競合、別ID、COMMIT前／後、再open、通常・競合両pending、旧sidecar差替えを再現。製品コードを直さず最小再現を返す |
| **D10 Flash** | catalog／bundle／添付の独立試験。契約後に先行、実行は対象部品受入後 | `tests/m1-conflict-recovery-adversarial.test.ts`のみ | 破損1件、page境界、巨大JSON、hash不一致、manifest差替え、symlink／hardlink／特殊path、容量不足／中断／完了markerのfsync失敗を独立fixtureで試す。expected hashを対象verifier自身から得ない |
| **D11 Flash** | コピー復元の独立受入。契約後に先行、実行はD07／C1受入後 | `tests/m1-conflict-recovery-acceptance.test.ts`のみ | v4再open・本文／DB／履歴／添付同値・新識別・禁止表／設定不在・source不変・通常保存を検査。環境変数がある後日起動／再接続でも回収markerで同期保留 |
| **D12 Flash** | 全導線と手順書。D06〜D11／C1接続後 | `tests/m1-recovery-flow.test.ts`、`docs/lv4/m1/RECOVERY-RUNBOOK.ja.md` | 一覧→選択→検査→書出し→新規復元→再openをNode seamで通す。不明／失敗の再照合・保全先・未対応の旧予約・GUI待ちを説明。自動起動しない |

D01はコードを変更しない計画job。D09／D10／D11はAPI契約への試験設計を先行できるが、実装前のred testは独立worktreeに留める。未完成のstubやskipで通した試験を受入済みとは扱わない。

## 先に決めるI/O

これは実装コードではなく、G0で確定する契約項目の一覧。名前の修正はCodexが一度だけ全担当へ配布する。

| 契約 | 必須入力・出力と禁止事項 |
|---|---|
| `NormalApplyReservation` | UUID、fixed target（workspace／client／binding／epoch／revision／hash）、state、結果。expected raw／IDをCAS。reserve／consumeで相手journalを検査。効果と消費を同一Store transactionで完了するportを必須にする |
| `ArchivePage` | sourceの固定識別、limit／cursor／一覧anchor。summaryにJSON検証状態と添付検証状態を別々に持つ。全件parseを要求しない。巨大／破損行は理由付きsummaryへ |
| `ArchiveTarget`／ticket | source scope、archive ID、operation ID、kind、checkpoint hash。実データ取得・外部file作成直前に再検査。ticketはmain所有で、任意path能力にしない |
| `RecoveryExportResult` | `metadata-only`／`complete-bundle`／`blocked`／`outcome-unknown`を区別。completeの証拠はcheckpoint hash＋必要添付全件のsize／hash＋出力再検証。出力pathはmainが決めた新規先だけ |
| `VerifiedRecoveryBundle` | format/version、checkpoint、source provenance、manifest、fingerprint、上限、完全性。token、source settings／DB dump／DDLを含めない。検査完了後にも入力の変化を再照合 |
| `RecoveredWorkspace` | 新規directory、source checkpoint hash、復元後の同値検査、v4、同期未登録、destination自身の回収marker。markerはprivate settingsへdurableに保存し、同期開始の前に検査。markerの解除はM1対象外 |
| `File/DB fault port` | open／stream read／write／fsync／marker publication／DB COMMITの前後に注入できる最小seam。製品の権限・guardを無効化するテスト専用分岐は作らない |

v4 schemaはCodexが固定した既存helperの構成を使う。新規Store→record／lifecycle／legacy schema→固定SQLで内容11表→record marker→user_version=4→close／reopenの順を確認する。各段階が失敗してもsourceと既存destinationは変更せず、新規出力を未完了／結果不明として保全する。DBと必要添付・markerの検査が済むまで完成として返さない。完了markerの公開／fsync応答が不明なら、markerが必ず残る・必ず消えるとは仮定せず、完成内容を再照合して回収し、同じ出力へ再適用しない。

## workerへ渡す共通指示テンプレート

```text
作業: <Dxx / card version>
基点: <contract commit SHA / dependency acceptance SHA>
phase: IMPLEMENTATION_AUTHORIZED（実装開始の明示指示後にCodexだけが設定）
読むもの: AGENTS.md、M1-EXECUTION-PLAN、当カード、確定契約、指定した既存コード4〜8ファイル
編集allowlist: <当カードのファイルだけ>
入力と出力: <固定契約>
不変条件: source変更なし、既存先上書きなし、秘密/予約/送信待ち持込みなし、不明は成功にしない
実行可能: 指定したNode/Vitestの対象試験、使い捨てSQLite/一時フォルダ、read-only Git確認
禁止: GUI/Electron/Playwright実行、dev/start、OS clipboard/native dialog、実データ、master、
      git push/merge、ネットワークsync、任意依存追加、担当外編集、試験skip/guard緩和
契約が不足/矛盾: CONTRACT_CHANGEで根拠・必要I/O・影響を返して停止。独断でAPIを変えない
検証: npm test -- --maxWorkers=1 <担当試験>; 他の試験は必要な根拠を添える
報告: base SHA/tree、編集一覧、diff、試験command/exit/件数、故障ケース、未確認、残課題、usage/時間
予算: 初回30分で報告、修正2往復まで。上限超過・進捗なし・429継続はCodexへ戻す
完了: allowlist差分＋試験証拠＋制約。COMPLETEDという文章だけでは受入済みにしない
```

プロンプトの禁止だけをOS隔離の代わりにしない。OpenCodeのtool権限もjobに絞り、外部processのcwd／編集先／ログ／DB／portを分離する。`git worktree`はファイル競合を分けるもので、他のディレクトリへ書けないOS sandboxではない。Codexが許可外差分・秘密混入・実行コマンドを受入前に検査する。

Codexが全体の`npm run verify:quiet`を最後に1回実行し、失敗・新変更・未解決の懸念がある場合だけ必要な再試験を行う。worker全員に全体ビルド／全体試験を同時実行させない。GUI spec作成や`--list`確認をGUI合格として数えない。
