# Round 3 Fidelity — 他担当への具体的差分依頼

2026-10-27。Fidelity が変更していないファイル（Editor / App / DB UI / Core）に対する依頼。いずれもこの branch では実装していない。行番号は feature commit 時点のもの。

## P0: 既存 E2E と契約が衝突しうる点（レビュー必須）

### H-01 `page-move.spec.ts` F11 と native modal の背景 inert

- 現状: Fidelity は `DialogFrame` の旧非モーダル分岐を廃止し、移動・履歴・ゴミ箱・テンプレートも native `<dialog>` にした。これは「モーダル中の背景操作防止」を揃えるためで、E2E 4/4 で確認した範囲では focus/Tab/Escape/復帰が動く。
- 衝突候補: `tests/e2e/page-move.spec.ts` の “S2 menu F11: delayed load preserves local edit…” は、移動 dialog を開いたまま `load` を保留し、その間に `w.getByLabel("ページタイトル").fill(...)` で背景の title を編集する。native modal の背景は inert なので、programmatic focus と `fill` が届かない可能性がある。
- **重要**: この spec は Fidelity の変更後に実行できていない（権限保留）。したがって「壊れる」と断定しない。既存の「遅延 load 中でも local patch と保存 revision を失わない」保証は弱めない。
- 推奨修正（App/Core、`src/renderer/App.tsx` の `move`）: `await api({type:"move"})` の ACK 直後に `setDialog(null)` し、その後の `await refresh()` を背景で待つ。dialog が先に閉じるため、ユーザーは「load 遅延中」に title を編集でき、F11 の保証は維持される。成功/失敗の表示は既存の error banner/queue に委ねる。
- 代替: F11 を「別の load を保留して編集する」形に書き換える。ただし共有テストの変更は written rationale と Core レビューが必要。
- この branch では `page-move.spec.ts` を変更していない。

### H-02 ui-v2 の 960 期待値

- `ui-v2.spec.ts` の 960 は `inspector position: absolute`、`.inspector-close` 表示、title 29px を固定している。Fidelity はこの 3 点を維持したまま `padding-right` の余白で本文の遮蔽だけを解消した。**したがって既存期待値の更新は不要**。
- ただし同 spec は権限保留で **NOT_RUN**。960 の新しい不変条件（content/title の右端 ≤ inspector 左端）は Fidelity 側 `r3-fidelity.spec.ts` と `tests/fidelity-display-contract.test.ts` に別途追加した。統合時に両方を実行してほしい。

## P1: Editor 内部（`src/editor/Editor.tsx`）

### H-10 slash メニューの画面外回避

現行 `setSlash`（`update()` 内、`top: rect.bottom - base.top + 8`, `left: Math.max(0, rect.left - base.left)`）は caret 基準で配置するだけで、右端・下端の clamp/flip がない。960 の実測では段落先頭基準のため x=299.5..599.5 に収まったが、深いネスト（左インデントが大きい）や 960 未満、caret が画面下端付近の場合は viewport 外になりうる。

提案:

```ts
const MENU_WIDTH = 300,
  MENU_GAP = 8,
  MENU_MAX_HEIGHT = 360;
const hostRect = base!;
const left = Math.min(
  Math.max(0, rect.left - hostRect.left),
  Math.max(0, hostRect.width - MENU_WIDTH - 12),
);
const below = rect.bottom - hostRect.top + MENU_GAP;
const above = rect.top - hostRect.top - MENU_MAX_HEIGHT - MENU_GAP;
const top =
  rect.bottom + MENU_MAX_HEIGHT + MENU_GAP > window.innerHeight
    ? Math.max(0, above)
    : below;
```

併せて window resize / document scroll でも `update()` を再実行し（現在は transaction と ResizeObserver のみ）、メニューを開いたまま resize した場合の位置ずれを防ぐ。Esc/Arrow/Enter の取消・入力継続は既存のまま。

### H-11 slash listbox の補助技術向け状態

`src/editor/Editor.tsx:628` の `role="listbox"` に対し、option の `aria-selected` はあるが、エディタ側に `aria-controls` / `aria-activedescendant` がない。フォーカスは editor に残したまま候補を移動する設計なので、各 option に安定 id を付け、editor の attributes に `aria-controls` と `aria-activedescendant` を同期する。

### H-12 block handle の狭幅・深いネスト

`.block-handle` は `left: -28px`、ネストは `Math.max(-27, rect.left - base.left - 24)`。960 で sidebar 表示時は content x=242 のため 214 でギリギリ見えるが、sidebar 非表示・960 未満・深いネストでは負座標になりうる。狭幅では editor host の左 padding を 28px 以上確保するか、handle を `left: 0` に寄せて本文の行頭と重ならない位置へ退避する。focus/selected 時の可視性（`.block-handle:focus`）は現状維持。

### H-13 スクロール中の sticky block-actions

`.block-actions` は `position: sticky; top: 10px`。960 で inspector の右余白がある状態でも幅は max-content で収まるが、複数選択のラベルが長い場合の折返しは未確認（NOT_RUN）。Editor 側で label を `aria-live` にするか、選択数を短く表示する。

## P1: App / Core（`src/renderer/App.tsx`）

### H-20 ページメニューの初期 focus と矢印キー

`App.tsx:993` のメニューボタンは `aria-expanded` のみで、`open` 時に focus はボタンに残る。キーボードでは Tab で `.dropdown` に入る。Fidelity の実測では Escape 後にボタンへ focus が残ることは確認済み。WAI-ARIA の menu 相当にするなら:

- trigger に `aria-haspopup="menu"`、`.dropdown` に `role="menu"`、各項目に `role="menuitem"`。
- 開いた直後に最初の enabled 項目へ focus。ArrowUp/Down/Home/End で移動、Escape で閉じて trigger に復帰、Tab は閉じて次の要素へ。
- 破壊的項目（ゴミ箱に移動）だけは初期 focus にしない選択肢も検討。

これは App の保存・遷移には触れない表示/キーボード変更だが、担当外なので依頼に留める。

### H-21 アイコンピッカーの Escape と矢印

`App.tsx:1229` の `.icon-picker` は `role="group"`。外側 pointerdown と再クリックで閉じるが、Escape では閉じない（App の global Escape は menu/find のみ）。`role="group"` のまま Escape で閉じ、4 列グリッドを矢印で移動できるようにする。`aria-expanded` は既にある。

### H-22 長い日本語タイトルの折返し

`App.tsx:1280` の `.page-title` は 1 行 `<input>`。119 文字の実測では値は保持され、内部スクロールで横 overflow は出ないが、Notion のような複数行表示にはならない。autosize `<textarea rows={1}>` に変更し、`aria-label`・disabled 条件・onChange・フォーカス ring を維持する。Fidelity 側 CSS は `textarea.page-title` でも効くよう `outline` の扱いをレビューする（現状 `.page-title:focus-visible` は input 前提ではない）。

### H-23 アウトラインの reduced motion

`App.tsx:1483` の `scrollIntoView({behavior:"smooth"})` は、generic CSS の `prefers-reduced-motion: reduce` では止まらない（programmatic の smooth 指定が優先）。`matchMedia("(prefers-reduced-motion: reduce)").matches` のとき `behavior: "auto"` にする。

## P2: DB UI / Core

### H-30 full-page record の受入

- 契約: table/board/calendar/gallery のいずれからも同じ full-page record を開く。現行 fixture は board/calendar/gallery の modal のみで、table は行内編集。Fidelity の `r3-db-record-display.json` に `tableViewObservation.fullPageRecordFromTable = NOT_IMPLEMENTED_OBSERVED` として記録した。
- `DatabaseProjection` / `RecordRequest` 接続後、Fidelity の `tests/e2e/r3-fidelity.spec.ts` の DB テストに table ケースを追加できる。表示側の invariants は「modal/full-page の panel が viewport 内」「初期 focus が title」「Tab/Shift+Tab が内側」「Escape で起動元カードへ復帰」「背景 click でページ操作なし」。
- live storage の保存・revision/ACK は Fidelity の受入対象外。fixture の保存を live 保存と表示しない。

### H-31 表示専用コンポーネントの抽出

Core が record 表示を切り出す場合、Fidelity は `Modal` と `styles.css`、抽出された表示専用コンポーネントの CSS だけを担当する。App の保存・遷移・DB model は変更しない。slot/callback の形は CONTRACT の `DatabasePresentationProps` に従う。

## 依頼の状態

H-01 は P0（統合前に必ず判断）。H-10〜H-13、H-20〜H-23、H-30 は未実装の依頼。Fidelity 側の証拠は [RESULTS.md](RESULTS.md)、受入対応は [ACCEPTANCE-MAP.md](ACCEPTANCE-MAP.md)。
