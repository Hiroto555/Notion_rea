前提: 実画面・Electron・実SQLite・実終了/再起動は **NOT_RUN**。以下はNode/Vitestで検証できるUI制御とtyped IPCの最小案で、schema変更・new sidecar・core変更は含まない。

## 最小typed IPC

```ts
export type ConflictDecisionRequest =
  | { type: "sync:conflictPreview"; operationId: string; choice: "local" | "remote" }
  | { type: "sync:conflictConfirm"; operationId: string; previewId: string; targetDigest: string }
  | { type: "sync:conflictCancel"; operationId: string; previewId: string }
  | { type: "sync:conflictDecisionState" };

export type ConflictPreview = {
  previewId: string;
  targetDigest: string;
  target: WorkspaceConflictResolutionTarget;
  latest: { generation: number; cleanGeneration: number; checkpointHash: string };
};

export type ConflictDecisionReply =
  | { status: "previewed"; preview: ConflictPreview }
  | { status: "confirmed"; operationId: string; previewId: string }
  | { status: "cancelled"; operationId: string; previewId: string }
  | { status: "unknown"; operationId: string; previewId: string | null }
  | { status: "rejected"; reason: "stale-preview" | "read-only"
      | "not-connected" | "restart-pending" | "duplicate" };
```

`previewId` と `targetDigest` はmainが発行・保持し、UIは返送だけ。`operationId` はユーザー意図ごとに1回生成し、再送・二重押下で再利用する。confirm/cancelはterminalとし、同IDの後着は`duplicate`。`conflictDecisionState`は再起動後の表示復元専用で、永続化しない。

## UI状態

```ts
type ConflictDecisionUi =
  | { kind: "idle" }
  | { kind: "loading"; seq: number }
  | { kind: "preview"; seq: number; preview: ConflictPreview; dirtyAck: boolean }
  | { kind: "sending"; seq: number; preview: ConflictPreview }
  | { kind: "confirmed"; operationId: string }
  | { kind: "cancelled"; operationId: string }
  | { kind: "unknown"; operationId: string };
```

受信は`seq`と`operationId`/`previewId`が現在値に一致する場合だけ反映。confirm成功は「メモリ予約のみ・本文未変更」、取消しは予約とpreviewを破棄。未保存入力がある間はconfirmを無効化し、保存または破棄の明示後だけ許可する。previewには「候補は競合時点、localは最新保存内容」を明記し、`target.generation !== target.cleanGeneration`なら競合後の保存を警告する。

## 回帰テスト8件（Vitest、deferred promise/fake timers/fake `folio.request`）

1. **preview→confirm→予約**: preview解決後にconfirm。confirm送信1回、状態`confirmed`、設定レコード書込み0、本文変更IPC 0を確認。
2. **cancelと二重取消し**: preview→cancelで`cancelled`。同じoperationIdのcancel再送は同一結果で、confirmは`duplicate`、予約0。
3. **非同期応答の入替え**: P1保留中にcancel→P1解決。古いseqのため無視。P2発行後にP1が再解決してもP2だけ反映。
4. **古いpreview**: P1→P2後、P1でconfirmすると`stale-preview`。UIは再確認を促し`confirmed`にならない。targetDigest不一致も同様。
5. **最新保存と旧候補・未保存**: `localGeneration < status.generation`のとき、previewのlocalは`latestCheckpointHash`を使い、旧candidateのrevision/hashを適用対象にしない。dirty時はconfirm不可、保存/破棄のack後に可。
6. **read-only/未接続**: `available:false`の各reasonでpreview操作を無効化し、IPCを送らない。直接要求しても`read-only`/`not-connected`でconfirmされない。
7. **重複operationId**: confirmを二重送信しても予約は1回。最初の応答保留中に再送しても同じ`confirmed`。confirm後のcancelは`duplicate`で取消しにならない。
8. **結果不明と通常restart排他**: quit/applyが`unknown`なら状態`unknown`、再実行せず新operationIdも発行しない。再起動後のstate照会でunknown/pendingを表示。通常restart予約中はconfirmが`restart-pending`で拒否され、永続化されない。

**NOT_RUN**: 実GUI/ブラウザ/Electron、実quit・再起動、実SQLite CAS、online guarded coreの適用。