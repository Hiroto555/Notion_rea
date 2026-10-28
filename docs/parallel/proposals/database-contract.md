# Database 2.0 契約提案

- 対象: `sprint/database-v2` / `<workspace-root>/Folio-database`
- 基準: `b7c150d15739c59edf6ba9a62ebda4794748d46b`
- 状態: 実装済み。統合レビュー対象。`Doc`・Editor schema・`App.tsx` は変更しない。

## 目的

旧 `DatabaseData` の単一 `view` / 文字列 `filter` / 単一 `sort` を維持したまま、複数の独立ビュー、AND/OR の入れ子フィルター、複数ソート、グループ化、ビュー管理を同じページ JSON に保存する。旧ページは読取り時に正規化し、実データ（プロパティID、行ID、値、順序、添付、revision、履歴）を変更しない。

## v2 データ形

```ts
type DatabaseData = {
  schemaVersion: 2;
  properties: Property[]; // 既存の5型
  rows: RecordRow[]; // 既存のID・title・values
  views: DatabaseView[]; // 1〜100。順序はタブ順
  activeViewId: string;
  // 旧UI/旧テストとの互換投影。active view の type/filterText/先頭sortのみ。
  view: "table" | "board" | "calendar" | "gallery";
  filter: string;
  sort: string;
};

type DatabaseView = {
  id: string;
  name: string;
  type: "table" | "board" | "calendar" | "gallery";
  filterText: string; // 旧「絞り込み」文字列。空白なら未使用
  filter: FilterGroup; // AND/ORの条件木
  sorts: SortRule[]; // 優先順。0〜50
  groupBy: { propertyId: string; direction: "asc" | "desc" } | null;
};

type FilterGroup = {
  kind: "group";
  id: string;
  conjunction: "and" | "or";
  conditions: (FilterCondition | FilterGroup)[];
};
type FilterCondition = {
  kind: "condition";
  id: string;
  propertyId: string; // "title" は行タイトル
  operator:
    | "contains" | "not_contains" | "equals" | "not_equals"
    | "starts_with" | "ends_with"
    | "is_empty" | "is_not_empty"
    | "greater_than" | "greater_than_or_equal"
    | "less_than" | "less_than_or_equal"
    | "before" | "after" | "on_or_before" | "on_or_after"
    | "is_checked" | "is_not_checked";
  value?: string | number | boolean;
};
type SortRule = { id: string; propertyId: string; direction: "asc" | "desc" };
```

- `title` は予約済みの仮想プロパティ。実プロパティIDはアプリがUUIDで生成するため衝突しない。
- フィルターは最大200ノード・深さ8。ビューは最大100。行は最大100,000。プロパティは最大1,000。
- 評価: 空グループは全件一致。`and` は全条件、`or` は1条件以上。空値は比較条件で不一致、`is_empty` で一致。数値は数値比較、日付は ISO `YYYY-MM-DD` の辞書順、文字列は日本語ロケール・大文字小文字非依存。
- 複数ソートは先頭から比較し、同値なら次のキー。空値は昇順/降順とも末尾。安定ソートなので全キー同値なら元の行順を保つ。
- グループ化は1キー。select はプロパティの選択肢順、その他の型は値順、未設定は末尾。ボードは `groupBy` が無ければ最初の select、カレンダーは最初の date（または date の `groupBy`）を使う。
- ビューは `views` 配列と `activeViewId` だけで独立する。1つのビューの filter/sort/group/name/type 変更は他ビューの値と配列内の位置を変えない。

## 旧形式の読込みと移行

旧形式は `schemaVersion` 未指定または `1` で、`views` を持たず `view`/`filter`/`sort` を持つ。

1. `Store` は v2 ワークスペースを開くと、`workspace.sqlite.pre-v3.sqlite` を `VACUUM INTO` で保存する。
2. `BEGIN IMMEDIATE` 内で全 `pages.data` と `versions.database` の旧 `database` を v2 に変換する。
3. `PRAGMA user_version=3` を同じトランザクションで設定する。
4. 変換失敗時は `ROLLBACK` し、DB は v2 のまま、原本 JSON は変更されない。次回起動で再試行できる。
5. 変換できない未知 version・壊れた構造のページは書き換えず、`pageSource` を原本のまま保持する。

変換内容:

- `properties` / `rows` は既存の配列順・ID・値・title をそのまま引き継ぐ。
- `view` → `views[0].type`、`filter` → `views[0].filterText` と互換投影、`sort`（`-key` を含む）→ `views[0].sorts[0]`。
- `views[0].id = "view-default"`、`activeViewId = "view-default"`、`filter.id = "filter-legacy"`。決定的IDなので再変換は no-op。
- ページの `revision`、`updatedAt`、`createdAt`、`parentId`、本文、添付URL、履歴の行数・日時・タイトル・doc は変更しない。
- 履歴の `database` も同じ純関数で v2 にする。旧アプリで作られた履歴に `database` が無い場合は `undefined` のまま。
- 読取り時にも同じ正規化を行う。メモリ上だけの旧データは次回の保存で v2 として永続化される。

## 未知versionと保全

- `DatabaseData.schemaVersion` が 2 でも 1 でもない場合、`Store.decode` はページを `documentError` 状態にし、`database` を `null` にして表示・編集を止める。`pageSource` は元の JSON 文字列を返す。
- 未知versionのページは v3 migration でも書き換えない。壊れた行・プロパティ・フィルターも同様に書き換えない。
- `requestSchema` は未知version・不正オペレータ・重複IDを拒否する。旧形式の更新入力は受理し、保存前に v2 へ正規化する。
- `Page.schemaVersion` / `Doc.schemaVersion` の意味は変更しない。Editor の既存文書 v1 読込みと未知文書versionの read-only 保護はそのまま。

## 互換投影と旧UI

- `view` / `filter` / `sort` は、旧UI・既存テスト・旧履歴表示のための**投影**である。v2 の正は `views` + `activeViewId`。
- ビュー操作を行うモデル関数は active view の投影を更新する。v2 入力に投影が無い場合は active view から補完する。入力に投影がある場合は値を保持する。
- `queryRows` は active view を優先する。`filterText` が空のときだけ旧 `filter` を、`sorts` が空のときだけ旧 `sort` を使う。これにより既存の `{ ...emptyDatabase(), filter, sort }` 形式の単体テストと旧データの意味を維持する。
- `Database` コンポーネントの公開契約 `{ value, onChange }` は変更しない。`App.tsx` は従来どおり `page.database` 全体を `update` するだけで、IPC・競合・保存キューを変更しない。

## UI と制限

- 旧ラベル（`データベースを絞り込む`、`並べ替え`、`アイテム名`、`テーブル`/`ボード`/`カレンダー`/`ギャラリー`、`.db-card`、`.board-column`、`.gallery`、`.day`）は維持する。
- 型ボタンは既存ビューがあればそのビューへ切り替え、無ければ現在ビューの設定を複製して新しいビューを作る。明示的な「ビューを追加」、名前変更、複製、削除、左右移動を提供する。
- フィルターUIは入れ子グループ、AND/OR、型別オペレータ、値入力を提供する。旧「絞り込み」文字列は各ビューに残る。
- 未実装・範囲外: 行ごとのページ本文、行プロパティの削除・並べ替え、Relation/Rollup/Formula、複数グループキー、ビューごとの列表示/幅、テンプレート。物理IME・Notion実比較は未実施。

## SQLite バージョン

`user_version` を 2 から 3 に上げる。データの実体は引き続き `pages.data` の JSON で、テーブル追加はしない。v3 は「ページ内 database が v2 形式であり、旧アプリで開くと view 定義を失う」ことを防ぐための互換境界である。旧アプリは 3 を拒否する。

ロールバック:

1. アプリを終了する。
2. ワークスペース全体を別名でコピーする。
3. `workspace.sqlite.pre-v3.sqlite` を `workspace.sqlite` として別フォルダに置き、同時点の `assets/` と組み合わせる。
4. v3 で追加した変更は pre-v3 スナップショットには含まれない。
