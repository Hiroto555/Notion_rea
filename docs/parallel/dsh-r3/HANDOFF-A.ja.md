# 担当A HANDOFF — 空きディスク安全余裕の保存前判定

2026-11-05 JST / ブランチ `codex/folio-l3-r3-pressure-20261105`
基準: `e26d1711de2d94e11475d1731576490c3ca4e808`
実装 commit: 本書を含むローカル HEAD（`git log -1` で確認）
作業ログ: `output/dispatch/A-targeted.log`、`output/dispatch/A-check.log`（`output/` は gitignore 対象）

## 結論

- 契約の exact API を実装した。`WorkspaceStoragePressure.inspect(additionalBytes?)` は
  1回の `statfsSync(..., {bigint:true})` の `bavail * bsize` だけを使い、
  `available < reserve + additional` のときだけ `blocked` にする。等号は `ready`。
- 取得失敗・不正な statfs 値・乗算 overflow・headroom 加算 overflow は `unknown`。
  `unknown`/`blocked` の `assertWritable` は固定の日本語メッセージで停止する。
- **GUI / Electron / browser / clipboard / osascript / ネイティブダイアログは NOT_RUN。**
  実行したのは対象 Vitest（maxWorkers=1）と `npm run check` のみ。
- A の所有外（`src/main/index.ts`、`src/shared/types.ts`、renderer、Store、backup service、
  package）は変更していない。API 変更の必要もなかった。

## 実装した API

`src/shared/storage-pressure.ts`

```ts
export type StoragePressureSnapshot = {
  state: "ready" | "blocked" | "unknown";
  checkedAt: string;
  availableBytes: number | null;
  reserveBytes: number;
  additionalBytes: number;
  reason?: string;
};
export const DEFAULT_STORAGE_RESERVE_BYTES = 256 * 1024 * 1024;
```

`src/main/storage-pressure.ts`

```ts
export class WorkspaceStoragePressure {
  constructor(directory: string, options?: {
    reserveBytes?: number;
    probe?: (directory: string) => { bsize: bigint; bavail: bigint };
    now?: () => Date;
  });
  inspect(additionalBytes?: number): StoragePressureSnapshot;
  assertWritable(additionalBytes?: number): void;
}
```

`StoragePressureProbe` / `WorkspaceStoragePressureOptions` は実装補助の型として
同ファイルから追加 export した。クラス・メソッド・定数の形は契約から変えていない。

## 判定の詳細

- `availableBytes = Number(bsize * bavail)`。`bfree` は読まない。1 inspect につき
  probe は1回だけで、ディレクトリ走査はしない。
- `bavail = 0n` は「空き 0」という実測値として扱う。`reserveBytes = 0` かつ
  `additionalBytes = 0` なら契約どおり等号なので `ready`、reserve が 1 以上なら `blocked`。
- `bsize <= 0n`、`bavail < 0n`、bigint でない値、乗算結果が
  `Number.MAX_SAFE_INTEGER` を超える場合は `unknown` / `availableBytes: null`。
- probe の throw、`statfsSync` の失敗（ENOENT 等）、probe の不正な返り値は
  `unknown`。snapshot の `reason` は固定コード `capacity-unknown` のみで、
  directory・例外 message・errno は入れない。
- `reserveBytes + additionalBytes` が safe integer を超える場合も `unknown`。
  このとき measured な `availableBytes` は保持する（比較だけが不能なため）。
- `checkedAt` は注入 clock の1回の `toISOString()`。Invalid Date / Date 以外は
  `TypeError`（`readStorageUsage` の既存 clock 検査と同じ方針）。偽の時刻は作らない。
- `blocked` の `reason` は `capacity-exceeded`、`unknown` は `capacity-unknown`。
  `ready` では `reason` を省略する。

## 入力検証とメッセージ

- 不正な options は constructor で `TypeError`: options が null/配列、未知キー、
  reserve が負・小数・NaN・Infinity・unsafe・文字列・null、probe/now が関数でない、
  directory が空文字・文字列でない。
- 不正な `additionalBytes`（負・小数・NaN・Infinity・文字列・null・unsafe）は
  `inspect` / `assertWritable` で `TypeError`。
- `assertWritable` の message は状態ごとに固定:
  - `capacity-exceeded`: 「保存を停止しました (capacity-exceeded)。…入力は保持されています。…再試行してください。」
  - `capacity-unknown`: 「保存を停止しました (capacity-unknown)。…入力は保持されています。…再試行してください。」
  どちらも path や例外を含めない。`ready` では何も throw しない。

## 変更ファイル

新規:
- `src/shared/storage-pressure.ts`（20行）
- `src/main/storage-pressure.ts`（151行）
- `tests/storage-pressure.test.ts`（335行）
- `docs/parallel/dsh-r3/HANDOFF-A.ja.md`（本書）

実装 source 合計は 171 行。既存ファイルは変更していない。

## 検証（今回の実行）

| 検証 | 結果 | 証拠 |
| --- | --- | --- |
| `npm test -- tests/storage-pressure.test.ts --maxWorkers=1` | **1ファイル / 18件 PASS** | `output/dispatch/A-targeted.log` |
| `npm run check` | **PASS** | `output/dispatch/A-check.log` |
| 全体 suite / build | **NOT_RUN**（指示どおり Codex が統合後に実行） | — |
| GUI / Electron / Playwright / clipboard / native dialog | **NOT_RUN** | — |

新規試験の範囲:
- default reserve の exact 値、threshold 等号、1 byte 下の blocked、additional の等号
- 空き 0、bsize 0、負の bsize/bavail、bigint でない値、乗算 overflow、headroom overflow
- probe throw と実 `statfsSync` 失敗（存在しない temp path）。snapshot に path/例外が
  入らないこと
- 使い捨て `mkdtemp` への実 statfs（巨大 file は作らない）
- clock の ISO 固定・1 inspect 1 probe、probe への directory 受け渡し
- 不正 options / directory / additionalBytes / Invalid Date
- 日本語 message の `capacity-exceeded` / `capacity-unknown`・保存停止・入力保持・再試行
- ready の `assertWritable` が throw しないこと、ready だけ `reason` を省略すること

既存テストの skip・assertion 削除・弱体化はしていない。

## 未配線・他担当への申し送り

- **Codex（main/IPC/renderer/backup）**: `storage:pressure` の手動確認は
  `inspect()` の snapshot をそのまま返せる。書込み前は B の
  `assertRequestStorage(request, pressure)` に本クラスを渡し、write のときだけ
  `assertWritable(additionalBytes?)` が呼ばれる形を想定している。
  自動 backup 前は、backup が追加で必要とする bytes を見積もって
  `inspect(estimatedBytes)` / `assertWritable(estimatedBytes)` に渡す。
- 本クラスは同期で statfs 1回のみ。毎キーストロークや全走査の代わりに、
  保存操作の直前など呼び出し側が決めた頻度で使う。結果のキャッシュは持たない。
- `reason` は UI 表示に安全な固定コード。日本語の停止・入力保全案内は
  `assertWritable` の message に含まれる。renderer で独自の短文を出す場合も
  path や例外を表示しないこと。
- これは保存前の空きディスク安全余裕であり、workspace quota、GC、物理ディスク故障、
  1操作全体の最大割当を保証しない。`reserveBytes` は余裕分であって上限ではない。
- directory が存在しない場合は `unknown` で安全に停止する（存在確認の追加はしていない）。
- A の担当範囲に未配線の製品コードはない。統合後の全体 suite / build / GUI は
  Codex の最終確認に委ねる。

## 境界

既存アプリ・実データ・認証設定・他プロセス・他 worktree には触れていない。
外部依存の追加、ネット調査、追加 agent、push / PR / deploy / reset / clean / force は
していない。`node_modules` は既存 symlink のまま。
