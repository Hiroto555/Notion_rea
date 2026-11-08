# Folio：次のチャットへの引継ぎ

2026-11-08。実装と計画の区切りでチャットを切り替えるための入口。**この文書は新しい実装・GUI実行・mergeの許可ではない。新チャットの最新ユーザー指示を優先する。**

## 作業場所と保存状態

- 既存の統合ツリー：`<INTEGRATION_WORKTREE>`。実際のローカルパスは新チャットの引継ぎメッセージで指定する。
- 資料保存branch：`codex/folio-planning-handoff-20261108`。この文書とMac受入計画・Opus戦略ラボを同じ文書保存commitにまとめる。このbranchから取得すれば、計画資料も引き継げる。
- 製品の受入基準commit：`bd65b73b492b95b8b9a2a1f73ad9a5e114c509dc`（`codex/folio-m3-ready-20261108`）。資料保存branchはこのcommitを基点とし、製品コードは変更しない。
- 実装候補は[Draft PR #12](https://github.com/Hiroto555/Notion_rea/pull/12)へ保存済み。baseは未マージPR #11のbranch。masterへは未マージ。
- 新チャットではGit状態・保存branch・remoteとの一致を確認する。文書保存commitと、製品試験がPASSした上記の基準commitを区別する。
- 原本側masterは`e269137f191081cabc0f05aa03ec68339ce413c2`。既存の未追跡`artifacts/`・`outputs/`は触っていない。

## 現在地

| 範囲 | 状態 |
|---|---|
| 確認済みLevel | Lv3。Lv4は未認定 |
| Lv4 M1/M2（A0〜A7） | 実装・非GUI・Linux共通GUIを受入済み |
| M3 | 最終受入待ち。Mac固有・物理Mac2台はNOT_RUN |
| 最終候補の検証 | 型検査・228ファイル/2,078テスト・build PASS。Linux GUI238/238 PASS、skip/retry/flaky 0 |
| Mac用workflow/実機基盤 | 計画のみ。未作成・未実行 |
| Lv5 | 既存V01〜V05等を具体化した設計候補。今回の実装・依存導入・試験はなし |

製品受入基準commitのActions：[quiet](https://github.com/Hiroto555/Notion_rea/actions/runs/42459303418)、[Linux GUI](https://github.com/Hiroto555/Notion_rea/actions/runs/42459303433)。実IPC207、応答代替Electron表示5、Chromium表示26。Linuxの合格をMac OS操作へ流用しない。

## 最初に読む資料

1. この統合ツリーのAGENTS.mdと、[M3の到達点・証拠](M3-ACCEPTANCE.ja.md)。
2. [このMacの操作を奪わない最終受入計画](MAC-QUIET-ACCEPTANCE-PLAN.ja.md)。
3. [Opus戦略ラボの統合結果](../roadmap/20261108-opus-strategy/README.ja.md)。必要なテーマだけ先へ読む。

新チャットの初回は読み取りとGit状態の確認だけを行い、現在地・制約・次の候補を短く報告して止まる。実装、workflow追加・実行、環境構築、追加のモデル相談は自動で開始しない。

戦略ラボはOpus 5.5 XHighの6並列＋統合反証1本、計7回をCodexが照合した文書。12担当カード・共通14反例・保存/権限/復旧・停止点を保存。未補正のmodel出力を承認済み仕様にしない。[採否ログ](../roadmap/20261108-opus-strategy/DECISION-LOG.ja.md)を優先する。

## 維持する制約

- **このMacではGUI/Electron/ブラウザ/E2E/スクリーンショット用アプリ/native dialog/OS clipboard/遠隔画面viewer/VMを起動しない。** 非表示・headless・直接起動で迂回しない。
- 原本master・実データは変更せず、統合ツリーと使い捨てデータを使う。master mergeは別途の指示まで行わない。
- GUIの実行先候補はGitHub側macOSまたは別の専用Mac。実機2台をこのMac抜きで満たすには、別物理Mac A/Bと常時稼働server Sが必要。台数/利用枠は未確認。
- 課金・global設定・クラウド契約・TCC/OS保護設定を自動変更しない。モデル使用量は報告値を保存し、quota画像をlive値と扱わない。
- 読み取りや文書整理をすでに依頼された場合、同じ許可を何度も求めない。具体的な実装・実行範囲は最新ユーザー指示から判断する。

## 次の小さな候補

**Mac受入の最小PoC一式。** MAC-P01〜04の実行先guard・証拠schema・validator・外部watchdogを非GUIで具体化し、その後、別ホストの起動/保存/終了と実Keychainの可否を限定jobで確認する案。今回は着手していない。

注意点：Playwright標準loaderの模擬Keychainを実Keychain証拠にしない。新規workflow_dispatchの初回起動を作業branchだけで成立すると仮定しない。専用PR経路・対象source/artifactとharnessの別記録を検討する。正常終了/Dock新PID・入力による閉鎖拒否・予約失敗による同PID再表示を区別する。

機材待ちにはLv5の隔離比較を検討できるが、今は計画のみ。Yjs等の方式・Lv6仕様を確定しておらず、全計画を実装する必要もない。M3待ちで凍結する選択も有効。
