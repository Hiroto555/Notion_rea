# Round 3 担当B HANDOFF — Request容量制御分類

2026-11-05T02:58:42+09:00

- ブランチ: `codex/folio-l3-r3-routing-20261105`
- 開始base: `e26d1711de2d94e11475d1731576490c3ca4e808`
- 実装commit: `564d8164e2b4`（本HANDOFFはその後ろの文書commit）
- 担当: B（Requestの容量制御分類）。実装sourceは `src/main/storage-write-policy.ts`、試験は `tests/storage-write-policy.test.ts`。
- 変更したファイルは上記2ファイルと本HANDOFFのみ。main/App/types/Store/Aソースは未変更。

## 実装した契約

`src/main/storage-write-policy.ts`:

- `storageActionForRequest(type: Request["type"] | "storage:pressure"): "read" | "checkpoint" | "write"`
- `assertRequestStorage(request: Request, pressure: {assertWritable(): void}): void`

Requestの全51 typeと、Codexがschemaへ追加予定の `storage:pressure` を合わせた52件を
`Record<Request["type"] | "storage:pressure", StorageAction>` に対する `satisfies` で網羅した。
分類は read 26 / checkpoint 1 / write 25。

- read: load/search/versions/pageSource、record:get/read、database:load/read、全resolve、
  property:preview/migration:preview、recovery:read、import、export/exportRecovery/exportPendingJournal、
  downloadAttachment/openExternal、workspaceBackup:choose/restore/open、storage:pressure。
- checkpoint: `recovery:write` のみ。救出用checkpointは容量pressureを呼ばず、既存のサイズ上限に委ねる。
- write: create/update/move/duplicate/trash/restore/setting、save/page/database/property/migrationの全commit、
  record:create/patch/pageUpdate/trash/restore/duplicate、database:settings、recovery:copy、
  attach/recover/restoreVersion、backup、workspaceBackup:create。

`assertRequestStorage` は `write` のときだけ `pressure.assertWritable()` を引数なしで1回呼ぶ。
read/checkpointではpressureへ触れない。requestは読むだけで変更せず、戻り値もvoid。
未知typeは `Object.hasOwn` で判定して `Unknown request type for storage policy: ...` をthrowし、readへ落とさない。
`__proto__`/`constructor`/`toString` のような継承プロパティ名も未知typeとしてthrowする。
malformed request（null、非object、typeが文字列でない）も同じくfail closed。

`storage:pressure` はAPI側の型unionだけに先行追加した。`src/shared/types.ts` のRequest schemaはCodex所有のため未変更。

## 検証結果（実行したもの）

Node v24.20.0 / npm 11.19.0。既存 `node_modules` symlinkを使用。一時DB等は不要。

| 検証 | 結果 | ログ |
| --- | --- | --- |
| `npx vitest run tests/storage-write-policy.test.ts --maxWorkers=1` | 1ファイル / 7テスト PASS | `output/dispatch/storage-write-policy-test.log` |
| `npm run check` | PASS | `output/dispatch/storage-write-policy-check.log` |
| `git diff --check` | PASS | 実装commit前 |

試験内容: 全52 typeの分類一致、backup等のwrite境界、writeだけ `assertWritable` が1回呼ばれること、
writeのthrowが伝播しread/checkpointはthrowしないこと、未知type/malformed requestのfail closed、
write/exportの入力JSONが呼出前後で不変なこと。

**全suiteとbuildは未実行**（Codex統合担当）。GUI/Electron/browser/clipboard/osascript/
ネイティブダイアログ/スクリーンショットは **NOT_RUN**。今回の分類はheadless Node単体のみで確認した。

## Codexへの申し送り（未配線）

1. `src/shared/types.ts` のrequestSchemaへ `storage:pressure` を追加する（Codex所有）。
   追加後も本ファイルのRecordはそのまま網羅する。
2. `src/main/index.ts` では `requestSchema.parse(input)` の後、永続変更を始める前に
   `assertRequestStorage(req, pressure)` を1回呼ぶ。既存の `protectRichRequest(req)` や
   layout backupより前に置くのが安全（容量不足時に入力保全backup自体を走らせない）。
   `recovery:write` はpolicyがcheckpoint扱いなので、この呼び出しで救出を止めない。
3. pressureにはAの `WorkspaceStoragePressure`（`assertWritable()` を持つ）をworkspace単位で渡す。
   BはAソースをimportしていないため、A未統合のworktreeでも型検査できる。
4. `assertWritable` の例外は握り潰さずmainまで伝播させる。writeをread扱いへfallbackしたり、
   保存成功を偽ったりするcatchを追加しない。
5. 新規Request typeを追加した場合は、実装のRecordと試験の `EXPECTED` の両方が
   `satisfies` により型エラーになる。分類を追加してから統合する。
6. Bの範囲外: IPC/UIの容量表示、自動backup前確認、実pressure生成、mainへの配線、
   全suite/build。これらは契約どおりCodexが所有する。
