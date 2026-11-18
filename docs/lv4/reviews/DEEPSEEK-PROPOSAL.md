## 最終提案（SAFE EXPLICIT 勝者解決 / store primitive 先行）

### 設計原則
- 権威は **SQLite transaction 内の再検査**。token は「同じ inspection を見ている」ことを示す整合 digest であり、認証 MAC ではない。
- 既存の `chooseLocal(revision)` / `chooseRemote(change, assertAssets)` / `resolveConflict(choice, revision)` は互換維持。新 target 版を overload で追加。
- 新規 sidecar・table・GUI/IPC 接続なし。失敗時は transaction rollback で conflict/outbox/archive/body を不変に保つ。

### 固定 target の必須フィールド
`src/shared/workspace-conflict-view.ts` に追加:

```
WorkspaceConflictSelectionTarget = {
  operationId; side: "local"|"remote";
  expectedHeadRevision; expectedHeadCheckpointHash: string|null;
  expectedLocalCandidateRevision; expectedLocalCandidateHash;
  expectedRemoteCandidateRevision; expectedRemoteCheckpointHash: string|null;
  expectedCandidateGeneration;      // conflicts.local_generation
  expectedLatestGeneration;         // inspection 時の state.generation
  expectedLatestCheckpointHash;     // inspection 時の live checkpoint hash
  token;                            // 上記の canonicalJson の sha256
}
```

`WorkspaceConflictInspection` へ加算的に `latestLocal: {generation, checkpointHash}` と `selectionToken` を追加（既存 `toMatchObject` は不変）。`side` は候補選択と一致必須。

### transaction 内再検査（`workspace-store.ts`）
**chooseLocal(target, admitBytes?)**
1. `validateConflictRecord(row)` を最初に実行（破損・chosen 済み・identity 不一致を拒否。現状 chooseLocal に無い穴）。
2. `buildWorkspaceCheckpoint(db)` を再計算し `hashCheckpoint`。
3. `expectedLatestGeneration === state.generation` かつ hash 一致を要求。不一致は `conflict-selection-stale` 409。
4. target の operationId/両候補 revision・hash/head revision・hash/`expectedCandidateGeneration===row.local_generation` を保存値と照合。不一致は `conflict-selection-changed` 409。
5. target 全フィールドから digest を再計算し `token` と一致要求。
6. 既存どおり `!pendingOutbox()`、`validateWorkspaceCheckpoint(latest, result.head.checkpoint)`（remote 追加データを落とさない）、`expectedHeadRevision >= applied_revision`。
7. 書き込み前に `admitBytes(commit の canonical bytes + archive checkpoint bytes)`。throw なら rollback（outbox/archive/chosen なし）。

**chooseRemote(change, assertAssets, target?, admitBytes?)**
- target 省略時は現行挙動（新規編集を `choose-remote-latest` に archive）を保持。
- target 指定時は上記 1〜5 と同じ検査を **archive 挿入・replaceContent より前** に実行。新規ローカル編集があれば `conflict-selection-stale` で拒否し、既存 body と conflict を保持（暗黙 archive 置換をしない）。
- 既存の staged inbox 一致、`checkpointAtRevision(expected.revision-1)` 連続性、`assertAssets`、head revision/hash 一致は維持。
- archive 2件（conflict-local/conflict-remote）と（legacy 時のみ）latest の bytes を `admitBytes` で事前計上。失敗時は body/archive/outbox/conflict すべて rollback。

**resolveConflict（`workspace-sync.ts`）**
- `(choice, target: WorkspaceConflictSelectionTarget)` overload を追加。既存 `(choice, expectedRevision: number)` は残す。
- target 指定時: stored conflict の operationId/side/head revision・hash と target を照合。
  - local: `remote.head()` を1回取得し、epoch・revision・hash が target と一致しなければ `conflict-head-changed` 409。その後 `chooseLocal(target, admitBytes)`。
  - remote: 既存 catch-up 後、`apply(change, true, false, target)` へ thread。apply 内の既存 head 再取得後、`chooseRemote(change, assertAssets, target, admitBytes)`。
- `canApply()===false`・asset staging 後の head 変更・generation 変化は従来どおり/新規に 409 で停止し、本文を置換しない。

### 新しいローカル編集と旧候補の扱い
- 旧 local candidate は conflict 記録時点の checkpoint（`operation.checkpoint`）。inspection の `latestLocal` は現在 DB の checkpoint。両者は generation/hash で区別。
- target は「旧候補の revision/hash」と「inspection 時の最新 local generation/hash」の両方を固定する。選択時に最新側が動いていれば **選択を拒否**し、再 inspection を要求する。
- したがって token 経由の選択は新規編集を暗黙に取り込まず、**黙って捨てない**。legacy `chooseLocal(revision)` は現行どおり最新を選択（互換）、legacy `chooseRemote` は最新を archive（互換）と明記する。

### 回帰テスト（4〜8件、一時 SQLite fixture）
`tests/sync-conflict-selection.test.ts` を追加（既存の `makeStore/identity/bootSharedPage/makeConflict` パターン）。

1. **local: 新規編集後の stale token 拒否** — inspection 後 `store.update(...,{title:"later"})` → `chooseLocal(target)` が `conflict-selection-stale`。body="later"、chosen NULL、outbox/archive 件数不変。
2. **remote: 新規編集後の stale token 拒否** — `chooseRemote(change, cb, target)` 拒否。remote 本文未適用、inbox/conflict/archive 不変。
3. **changed head 拒否** — 保存 `remote_result_json` を revision 4 の valid conflict に差替え（A で新 commit 生成）→ 旧 target が `conflict-selection-changed`。両候補・body 保持。revision+1 直接指定ケースも `sync-head-changed`。
4. **破損候補の local 選択拒否** — `local_checkpoint_json="{}"` → `chooseLocal(target)` が `invalid-conflict-checkpoint`。archive/outbox/body/chosen 不変（既存 chooseRemote 破損試験と対）。
5. **一致 token の local 成功** — commit.baseRevision=head revision、archive kind=`choose-local-latest`、その hash=target の latest hash、conflict chosen="local"、outbox 1件。
6. **一致 token の remote 成功（編集なし）** — archive は conflict-local/conflict-remote の2件のみ（latest archive なし）、appliedRevision=head、cleanGeneration=generation、body=remote。
7. **容量 admission 失敗で無変更** — `admitBytes` が throw → body は local、archive 0、conflict 未解決、outbox 不変。再試行は成功。
8. **legacy 互換** — target なしの `chooseLocal(3)`/`chooseRemote(change,cb)` が従来動作。後者は新規編集を `choose-remote-latest` に残す。

### 互換性・範囲外
- 追加は optional 引数と additive view field のみ。schema・既存 error code は不変（新 code は追加）。既存 `sync-conflict-inspection.test.ts` / `sync-workspace-store.test.ts` と `lv4-core-split` の legacy 呼出しはそのまま通る想定。
- remote 拒否時に staging 済み未参照 asset が残り得る（既存既知制約。body は不変）。選択成功後の新規編集は pending として残り、破棄されない。
- 勝者 UI、IPC 接続、sidecar、再起動連携は対象外。GUI は **NOT_RUN**。