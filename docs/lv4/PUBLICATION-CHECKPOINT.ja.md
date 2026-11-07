# GitHub保存チェックポイント

2026-11-08 JST。利用者の「今の所までgithubに完全に反映」という指示を受け、現在の統合候補を `codex/folio-lv4-20261107-3qxb-integration` へ保存する。基準は `e269137f191081cabc0f05aa03ec68339ce413c2`。元のmasterを変更しない既存の指示を保ち、masterへのマージ・実データ移行・追加実装は行わない。

保存対象は、Lv4の実装・単体試験・未実行のGUI試験仕様、統合済みのDnD／復元／並び順修復、容量試験スクリプトと測定結果、残作業計画、状況図のソース、当初の計画、競合コアとUIのSolレビュー・DeepSeek提案、主要な非GUI検証ログ。新機能の実装は再開していない。

## この候補での非GUI検証

| 検査 | 結果・証拠 |
|---|---|
| `npm run verify:quiet` | PASS：型検査、166ファイル／1,509テスト、ビルド。[ログ](validation/publication-quiet.txt) |
| `npm run review:test` | PASS：5テスト。[公開前検査ログ](validation/publication-hygiene.txt) |
| ローカルassets検査／headless救出のhelp | 3ファイルの参照検査PASS／`--help`はexit 0。データを開かずに確認 |
| `npm run review:scan` | ローカルパスを整理後、現在の候補に残る検出は下記の合成テスト1件。検査器自体は変更していない |
| GUI・Electron・実IPC・実終了・IME・OS操作 | **NOT_RUN** |
| 物理Mac 2台・実トンネル・Windows | **NOT_RUN** |
| GitHub Actions | PR作成後にquiet-checksを実行する。ローカル検証と別の結果としてPRのChecksに記録される |

ビルドには既存のchunkサイズ／dynamic importに関する警告が残る。認定は**Lv3のまま、Lv4未認定**。

## 公開前検査の判定

検査器は `tests/lv4-secret-store.test.ts` の `accepts only loopback targets without credentials or token-bearing parts` にある拒否対象URLを `credential-url` と検出する。`TOKEN` は同ファイル先頭で `"A".repeat(43)` と定義した合成値で、宛先は127.0.0.1、外部通信や実資格情報を使用しない。認証情報入りURLを拒否し、エラーへ内容を漏らさないことを確認する既存の試験データとして、そのまま保存する。このためscanの終了コードは1であり、検出ゼロとは報告しない。

履歴検査はローカルで到達できる全refも対象とする。過去の実験用refにある検出と、今回送る現在ファイルを分け、過去refの一括pushや履歴の書換えは行わない。生のモデルセッションや個人パスを含む過去の実験ログを追加公開しない。パターン検査は秘密情報の不存在を完全に証明するものではない。

元の統合差分は作業外の保全先へコピーしてから文書を整理した。今回の整理では実装の動作・試験内容を変更していない。ソース／試験3ファイルの末尾空行と、収録ログの行末空白だけを正規化した。依存・ビルド成果物、実DB、実backup、秘密ファイル、元masterの未追跡artifacts／outputsは保存対象外。
