# Folio：次のチャットへの引継ぎ

2026-11-10：Lv4〜Lv6継続実装後の最新入口は[GitHub保存・引き継ぎ](../roadmap/20261110-HANDOFF-LV4-LV6.ja.md)。以下の2026-11-08時点の未実装・件数は履歴として読む。確認済みLevelはLv3、現在候補のGUI／物理機受入はNOT_RUN。

2026-11-08。実装と計画の区切りでチャットを切り替えるための入口。**この文書は新しい実装・GUI実行・mergeの許可ではない。新チャットの最新ユーザー指示を優先する。**

最新の非GUI追記：`codex/folio-lv4-quiet-residuals-20261108`（開始 `ab48aab`）で、DeepSeek最大10並列＋限定修正2件を統合した。終了予約の書込み前失敗後の取消しと、既存binding不一致の接続設定保存を修正し、外部監視・remote H1起動経路・artifact snapshot・Keychain/native観測判定・12条件台帳を実装した。**型検査・243ファイル/2,292 Nodeテスト・build PASS、今回の変更は追加GUIなしの最終レビュー後、この文書を含むローカルcommitへ保存する。** [実装・再現・境界](QUIET-RESIDUAL-EXECUTION.ja.md)と[最終レビューJSON](validation/lv4-quiet-residuals-final-review-20261108.json)を最優先する。製品srcが変わったため、以下のGUI240件は前候補の履歴。新候補のGUIはNOT_RUN、Lv3確認済み/Lv4未認定、追加GUI・push・workflow・master mergeなし。

最新追記：利用者のTV視聴中の明示指示で、このMacのGUI受入を実施した。**240 PASS / 実IME 1 INFRA_BLOCKED**、最終quietは型検査・232ファイル/2,165テスト・build PASS。[今回の範囲と残件](MAC-LOCAL-GUI-ACCEPTANCE-20261108.ja.md)を最優先する。作業branchは `codex/folio-mac-gui-acceptance-20261108`、開始HEADは `b19ecbe1fd9700575d75474c5e08573ffcbb75d9`。今回のharness・結果文書は追加GUIなしの最終レビュー後、この文書を含むローカルcommitへ保存する。結果JSONの `harnessStateAtRun` は未コミットだった実行時の記録であり、保存後の未保存差分を意味しない。実Keychain・別ホスト・物理2台はNOT_RUNで、Lv3/Lv4未認定を維持する。[MAC-P05の機材・権限・最小H1範囲](MAC-P05-RESOURCES-AND-SCOPE.ja.md)も整理済み。以下の「このMacのGUIは未使用」は今回より前の履歴であり、今後のGUI起動は再び既定拒否とする。

追記：利用者の具体的な依頼を受け、`codex/folio-mac-poc-quiet-20261108` でMac PoCのguard/schema/validator/外部watchdogを非GUIで実装し、最終レビュー後に同branchへローカルcommitで保存する。pushはしない。[今回の実装・境界・最終レビュー/検証記録](MAC-POC-QUIET-IMPLEMENTATION.ja.md)を参照。下記の「計画のみ」「未着手」は保存commit当時の記録。実Electron・Keychain・別ホスト・workflowへの接続は引き続きNOT_RUNで、M3待ち/Lv3/Lv4未認定を維持する。

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
| M3 | 最終受入待ち。Mac nativeの一部は上記でPASS、実IMEは基盤保留、実Keychain・物理Mac2台はNOT_RUN |
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

- **今回の明示許可によるGUI受入は終了。今後は、このMacのGUI/Electron/ブラウザ/E2E/スクリーンショット用アプリ/native dialog/OS clipboard/遠隔画面viewer/VMを新しい明示指示まで起動しない。** 非表示・headless・直接起動で迂回しない。
- 原本master・実データは変更せず、統合ツリーと使い捨てデータを使う。master mergeは別途の指示まで行わない。
- GUIの実行先候補はGitHub側macOSまたは別の専用Mac。実機2台をこのMac抜きで満たすには、別物理Mac A/Bと常時稼働server Sが必要。台数/利用枠は未確認。
- 課金・global設定・クラウド契約・TCC/OS保護設定を自動変更しない。モデル使用量は報告値を保存し、quota画像をlive値と扱わない。
- 読み取りや文書整理をすでに依頼された場合、同じ許可を何度も求めない。具体的な実装・実行範囲は最新ユーザー指示から判断する。

## 次の小さな候補

**別ホストMAC-P05のH1だけ。** MAC-P01/P03/P04は `b19ecbe` で実装済み。このMacの一部native操作は上記で受入済み。別ホストのguard/監督接続と起動・保存・正常終了・再読込は未実装/未実行で、実行先1台から始める候補。[機材と実装範囲](MAC-P05-RESOURCES-AND-SCOPE.ja.md)を参照し、自動着手しない。

注意点：Playwright標準loaderの模擬Keychainを実Keychain証拠にしない。新規workflow_dispatchの初回起動を作業branchだけで成立すると仮定しない。専用PR経路・対象source/artifactとharnessの別記録を検討する。正常終了/Dock新PID・入力による閉鎖拒否・予約失敗による同PID再表示を区別する。

機材待ちにはLv5の隔離比較を検討できるが、今は計画のみ。Yjs等の方式・Lv6仕様を確定しておらず、全計画を実装する必要もない。M3待ちで凍結する選択も有効。
