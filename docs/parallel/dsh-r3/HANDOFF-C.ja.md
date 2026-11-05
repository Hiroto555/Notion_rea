# Folio Round 3 C HANDOFF — 独立受入試験と障害条件

2026-11-05 JST。担当C（DeepSeek V4.1 Flash）。

- 作業場所: `<workspace-root>/Folio-l3-r3-acceptance`
- ブランチ: `codex/folio-l3-r3-acceptance-20261105`
- 共通base: `e26d1711de2d94e11475d1731576490c3ca4e808`
- 状態: **Cの成果物は作成済み。新規受入試験はA/B module不在のためNOT_RUN。統合後にCodexが実行する。**
- ローカルcommit: 本書と試験を含むcommitを1つ作る（pushなし）。SHAは最終報告に記載する。

## 変更したファイル

新規のみ。製品 `src/`、既存テスト、既存スクリプトは変更していない。他worktreeにも書いていない。

| ファイル | 内容 |
| --- | --- |
| `tests/storage-pressure-integration.test.ts` | 契約A/B APIだけをimportする独立受入試験。実Store・実PageOperationCoordinator・実RecoveryCheckpoint・一時CrashRecoveryFileを使用。4テスト |
| `docs/parallel/dsh-r3/FAULT-CASES.ja.md` | 障害条件、分類表、期待、未検証範囲、実行コマンド、Codex受入条件 |
| `docs/parallel/dsh-r3/HANDOFF-C.ja.md` | 本ファイル |

## 実装した受入条件

1. **圧迫中のcommit停止**: `probe` を `bavail=2` にすると `page:commit` が `capacity-exceeded` で拒否され、Storeの `handle` に到達しない。新規Pageなし、`save_receipts` 増加なし。
2. **入力保持**: `PageOperationCoordinator` は容量拒否を `unknown` として保持し、`rejected` に偽装しない。operationの初期本文はcoordinatorと一時checkpointファイルの両方に残る。
3. **読み取り・救出**: 圧迫中でも `load` / `search` / `versions` / `pageSource` / `page:resolve` / `recovery:read` / `storage:pressure` が通り、`recovery:write`（checkpoint）が保存できる。`recovery:read` は同じoperationを返す。
4. **明示再試行**: 空き回復後に `retryUnconfirmedPageOperations` がまずresolveし、unknownのときだけ同じoperationId/sessionId/seq/payloadで1回commitする。2回目は `resolvedApplied` になり再commitしない。
5. **既存receipt保護**: 圧迫・再試行の前後で既存receiptの `result_json` がbyte同一。receiptを削除しない。
6. **readonly分類のguard**: 全52 Request typeのread/checkpoint/write分類を `Record` で網羅し、テストローカルdispatchで `assertRequestStorage` を `store.handle` の前に置く。read/checkpointは `assertWritable` を呼ばず、writeは呼ぶ。blocked writeはStoreに到達しない。`recovery:copy` もwriteとして拒否される。未知typeはfail closed。
7. **不明容量**: probe例外とoverflowは `unknown`、`assertWritable` は `capacity-unknown` と日本語の保存停止・入力保全案内でthrow。不正なreserve optionsは構築時にthrow。

## 検証結果（正直な状態）

環境: Node `v24.20.0`、npm `11.19.0`、Vitest `3.2.7`、`node:sqlite`。`FOLIO_VITE_CACHE_DIR=$PWD/output/vite-cache`、maxWorkers=1。GUIは起動していない。

| 検証 | 結果 | ログ |
| --- | --- | --- |
| 既存の小試験4ファイル（coordinator/receipt/recovery/初期本文） | **35件 PASS** | `output/dispatch/r3-c-existing.log` |
| 新規 `tests/storage-pressure-integration.test.ts` | **NOT_RUN**。collection時に `Cannot find module '../src/main/storage-pressure'`。テスト本体は未実行 | `output/dispatch/r3-c-new-test-attempt.log` |
| `npm run check` | **FAIL（統合待ち）**。新規試験のA/B import 3件が `TS2307` | `output/dispatch/r3-c-check.log` |
| `npx esbuild ... --format=esm` | 構文変換のみPASS。型検査・実行の代用にしない | 一時出力（commit対象外） |
| `git diff --check` | 最終差分確認でPASS | — |
| GUI/Electron/browser/clipboard/osascript/screenshot/native dialog | **NOT_RUN** | — |
| 実ディスク圧迫/物理故障/quota/GC | **NOT_RUN** | — |
| 全体suite/build/hosted CI | Codexが統合後に実行 | — |

**新規試験の4件をPASSとは報告しない。** 実行できていないため、受入済み・Level到達の根拠にしない。

### check FAILの理由

`npm run check` の失敗は次の3件だけで、いずれもC worktreeにまだ無い契約moduleのimportである。

```text
tests/storage-pressure-integration.test.ts(9,42): error TS2307: Cannot find module '../src/main/storage-pressure'
tests/storage-pressure-integration.test.ts(13,8): error TS2307: Cannot find module '../src/main/storage-write-policy'
tests/storage-pressure-integration.test.ts(17,8): error TS2307: Cannot find module '../src/shared/storage-pressure'
```

A/B統合後に解消する見込み。契約シグネチャだけの一時stubを `/tmp` に置いたテスト単体の型検査では、テスト側の型エラーは検出されなかった（実A/B moduleでのcheckではなく、commit対象外・実行でもない）。実moduleでの `npm run check` は未実行であり、PASSとは扱わない。

## テストローカルdispatchの限界

`tests/storage-pressure-integration.test.ts:86` の `makeDispatch` は、次の順序をテスト内で再現するだけである。

```text
assertRequestStorage(request, pressure)
  -> storage:pressure / recovery:read / recovery:write の専用処理
  -> store.handle(request)
```

これは**製品の `src/main/index.ts` をimportしていない**。したがって次は本試験の対象外であり、PASSの根拠にできない。

- `main/index.ts` が実際に `assertRequestStorage` を `store.handle` より前に呼ぶこと
- `folio:request` IPC sender検証との順序
- `shared/types.ts` の `storage:pressure` schemaとpreload
- rendererの手動容量確認表示
- `WorkspaceBackupService` の自動backup前確認
- 実際の `storage:pressure` IPCの戻り値

これらはCodexの所有・統合レビュー対象である。

## Codexへの依頼

1. **A/Bの統合**: `src/shared/storage-pressure.ts`、`src/main/storage-pressure.ts`、`src/main/storage-write-policy.ts` を統合する。Cは実装していない。
2. **`storage:pressure` の型/IPC**: `shared/types.ts` と `main/index.ts` に追加する。本試験は `Request | {type:"storage:pressure"}` のローカル型で書いてあるため、追加後も同じ試験が通る想定。requestに必須引数が必要な形にした場合は、試験のrequest objectだけを契約に合わせて調整する（期待値を緩めない）。
3. **新規試験の実行**: `npx vitest run tests/storage-pressure-integration.test.ts --maxWorkers=1` を実行し、4件PASSを確認する。失敗時は実装か試験の前提を直し、skip・assertion削除・`any`での握り潰しをしない。
4. **check**: `npm run check` を実行し、`TS2307` が解消し、新規試験を含めて型検査が通ることを確認する。`Request` にtypeを追加した場合は分類 `Record` の網羅性が型で検査される。
5. **main配線のレビュー**: `assertRequestStorage` が `store.handle` の前、`protectRichRequest` や個別分岐より前に置かれていること、`storage:pressure` がreadとして処理されることを確認する。本試験はこの配線を検証しない。
6. **全体suite/build**: 統合worktreeでCodexが実行する。Cは対象の既存小試験と新規試験attemptだけを実行した。

## API変更の依頼

なし。Cは契約A/BのAPIを変更していない。依存として、Codex所有の `shared/types.ts` に `storage:pressure` IPCを追加する必要がある。Cの試験は `Request["type"] | "storage:pressure"` をローカルに補ってimportしている。

## 既知のリスク・注意

1. A/Bの実装が契約と異なる場合（例: `inspect` の `additionalBytes` の扱い、`recovery:write` のcheckpoint分類、未知typeの扱い）、新規試験は失敗する。それは受入の意図であり、期待値を緩めない。
2. `WorkspaceStoragePressure` の `assertWritable` メッセージに `capacity-exceeded` / `capacity-unknown` と日本語の保存停止・入力保全案内が含まれることを前提にしている。文言を変える場合は契約と試験を同時にレビューする。
3. `CrashRecoveryFile` のfsync・rename・readbackは実ファイルで動かすが、物理停電の証明ではない。
4. テストは `retryUnconfirmedPageOperations`（既存のrenderer recovery helper）を使う。このhelperのシグネチャ・report shapeが変わった場合はCodexが追随する。
5. 新規試験は528行で、A/B実装のような250行目標の対象ではない。Cは製品sourceを追加していない。
6. `output/` はgitignore対象。ログはworktree内に残るがcommitには含まれない。

## 安全性

- GUI/Electron/browser/OS clipboard/native dialog/screenshot/osascriptは起動していない。`dev` / `start` / `test:e2e:batch` / 直接Electron起動も実行していない。
- 実データ、既存Desktopアプリ、他プロセス、他worktree、認証設定には触れていない。
- 一時ディレクトリは `mkdtempSync` の `output/dsh-r3-*` だけ。実ディスクを埋めていない。
- 依存追加、node_modules再インストール、ネット調査、追加agent、`git reset` / `clean` / `force` / push / deploy / PRは実行していない。commitはローカルのみ。
- 既存receipt/historyは削除していない。既存テストを弱めたりskipしたりしていない。

## 再現コマンド（統合後）

```sh
cd <workspace-root>/Folio-l3-r3-acceptance
export FOLIO_VITE_CACHE_DIR="$PWD/output/vite-cache"
npm run check
npx vitest run tests/storage-pressure-integration.test.ts --maxWorkers=1
npx vitest run tests/page-operation-coordinator.test.ts tests/recovery-checkpoint.test.ts tests/page-operation-receipts.test.ts tests/l3-page-initial-doc.test.ts --maxWorkers=1
```

全体suite/buildはCodexの統合worktreeで実行する。GUIは利用者の明示許可があるまで実行しない。
