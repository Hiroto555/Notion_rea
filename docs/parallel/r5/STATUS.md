# R5 統合結果

2026-10-28 (Asia/Tokyo)。R4完了commit `23f47c9ccd24376174bac170a43f5a794377d1a5` を基点に、R5専用worktreeへ実装・統合。

現在のcheckpoint: **R5_READY_FOR_REVIEW**。新DB作成・新規行追加・ビュー/フィルター/並べ替え/グループ設定保存を実Appへ接続し、固定候補の全件検証と合成デモの再起動確認まで完了。

## 実Appに接続した操作

| 成果 | 状態 | 証拠 |
|---|---|---|
| 明示的な新DB作成 | 接続済み。初回だけv4 record schemaを導入し、SQLite snapshotを作成 | R5-01、03 |
| 新規行追加、ページとして開く、本文・タイトル・基本3型の編集 | 接続済み。実SQLite再起動まで最終全件PASS | R5-02、04 |
| ビュー追加・改名・切替、filter/sort/groupの保存 | 接続済み。実SQLite再起動まで最終全件PASS | R5-05、06、12 |
| ACK保留・喪失・競合・数値途中入力と画面移動 | 入力とoperation identityを保持、二重作成を防止 | R5-07〜10、13 |
| グループ内の連続入力 | 同じinput/focusを維持、行外blur時に再配置 | R5-11 |

保存処理(A1)、設定UI(A2)、実App検証(A7)を並列で作業し、A0がApp接続と統合を担当した。重いbuild/unit/Electronは直列実行した。

## 保存の契約

- DB作成・行作成・設定/owner更新をoperation ID、session ID、連番、内容fingerprintで識別し、更新とreceiptを同じtransactionに記録。
- 同ID/同要求は二重適用せず、同ID/別要求は拒否。COMMIT後の応答喪失は同ID照会で確定する。
- 設定とowner Pageのtitle/doc更新はApp寿命の単一DB sessionでrevisionを直列に進める。外部変更への無条件rebaseはしない。
- record本文・propertyは既存R4 sessionへ接続。設定ACKで編集中のrecord入力を捨てない。
- 未完成の数値filterとpending/unknownは通常reload/終了を抑止。強制終了からのdraft復旧とは別。
- 既存legacy DBのJSON/行を変更せず、登録や自動変換もしない。初回snapshotはSQLite単体であり、添付を含む完全backupではない。

## 検証

検証場所: `<workspace-root>/Folio-r5-20261028/validation`、branch `codex/r5-validation`。
固定commit: `51ff1727742a9d0510c50b380c297dd83af159cb`、tree `d03eceb953739c04bd61f3f19990396ffae67ab1`。実行開始時clean。integrationの製品source・test・実行scriptと一致し、差分は担当guard設定と報告文書のみ。

最終run（2026-10-28 **14:54:27–15:01:46 JST**）: **build/typecheck PASS、全unit499/499 PASS（53 files）、全E2E137/137 PASS（Electron109 + Chromium表示fixture28）、FAIL 0、SKIP 0**。一回の全体runの結果であり、過去の部分成功との合算ではない。

| 検証 | 生log |
|---|---|
| build/typecheck | [build-edc7461a](../../../../validation/output/agent-workspace/logs/2026-10-28T05-54-27-996Z-build-edc7461a.log) |
| 全unit | [test-e8ef496d](../../../../validation/output/agent-workspace/logs/2026-10-28T05-54-34-841Z-test-e8ef496d.log) |
| 全E2E | [test-e2e-2770be76](../../../../validation/output/agent-workspace/logs/2026-10-28T05-55-01-836Z-test-e2e-2770be76.log) |

[最終manifest](../../../../validation/output/r5-final-verification/manifest.json)。macOS Darwin25.6.0/arm64、Node v24.20.0。`node scripts/r5-verify.mjs` からguard経由でbuild→unit→E2Eを直列実行。unitはmaxWorkers=1/file parallelismなし、E2Eはworkers=1/retries=0。FOLIO_DATA_DIR/userData/sessionDataは試験ごとの合成workspace。buildのchunk size/dynamic import警告は残るが、コンパイル・型検査のエラーはない。

初回固定候補 `0401d96` はunit499成功、E2E136成功/1失敗だった。既存clipboard試験の空MIME項目の退避処理を修正し、assertionは維持した。初回のmanifest/trace/reportは `validation/output/r5-run-history/attempt-01/` に保存。初期のTypeScript構文失敗、checkbox ACK照合不一致とその修正履歴も[実行履歴](RUN-HISTORY.md)に分けて残している。

R5新規E2Eは11件。旧DBの表示fixtureの成功を新DBの保存証拠へ読み替えない。R4とH0の結果・未確認事項は従来の記録を保持する。

[操作別台帳](SCENARIOS.md) / [失敗を含む履歴](RUN-HISTORY.md) / [保存処理](A1.md) / [UIレビュー](A2.md) / [QA](A7.md)。

## 合成デモ

[起動ファイル](../../../../開く_R5合成デモ.command) / [操作手順](TRY-IT.md)。依存準備・build済み。専用保存先は `<workspace-root>/Folio-r5-20261028/validation/output/r5-demo/data`。

最終固定候補で、v3合成workspaceから**実UIによる新DB作成→3行追加→本文・基本properties編集→2ビュー作成→checkboxフィルターと降順sort→正常終了→再起動→実IPCとSQLite読戻し**を実行した。3行中、条件に合う2行が再表示され、旧DBの内容も不変。15:01:57 JSTに確認。編集したrecordのside peekを開いた状態で残している。このデモは全E2E137件に加算しない。

[DB画面](../../../../validation/output/r5-demo/database.png) / [再起動後のrecord画面](../../../../validation/output/r5-demo/record.png) / [保存確認JSON](../../../../validation/output/r5-demo/demo-proof.json)。再実行手順は `node scripts/r5-demo.mjs --prepare-only`、新規デモの場合のみ `node scripts/r5-demo-exercise.mjs --keep-open`。既存デモの再起動は起動ファイルを使う。

## 未完・未確認

- 旧DBの自動変換・実データ移行、列の追加/型変更の実UI、select/dateのlive編集。
- record/登録DBの削除・複製・履歴復元など、未接続のlifecycle操作。
- 強制終了からのdraft永続復旧、未解決operationの再起動後の再発見、完全backup/recovery。
- 物理日本語IME、native OS clipboardの手動確認、Notionライブ同条件比較。
- 任意の外部SQLite writerや旧binaryとの一般的排他、receipt GC。

元repo/H0/R4 worktreeへの変更、push、公開PR、master mergeは行っていない。
