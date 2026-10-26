# Gate A 検証証拠

対象はFolioのみ。Notion比較・物理日本語IMEは未実施。

- [結果と終了コード](results.json)
- [ソースとビルドのSHA-256](manifest.json)
- [改修対応・移行・ロールバック](../../AUDIT-RESPONSE.md)
- [最新単体32件](verified-unit.txt)
- [最新全体Electron 21成功/1失敗](verified-e2e.txt)
- [失敗したドラッグ試験の未変更での再実行3件](drag-recheck.txt)
- [修正前の実Store失敗6件](red-unit.txt)
- [修正前のF01/F06/F11実Electron失敗](red-e2e-corrected.txt)
- [修正前の添付失敗（テスト初期不備を含む）](red-e2e.txt)
- [修正前の保存先計算](red-storage-path.json)
- [パッケージ起動・保存・再起動](verified-package-smoke.txt)

Gate A追加15件はすべて成功。全体E2Eのブロックドラッグ1件は原因未特定の不安定性が残るため、全体完全成功とは記載しない。rawログの個人パスとANSI制御文字のみを除去し、raw/共有版の両方のhashをmanifestに記録した。原本ログ・trace・画像はローカルoutput/gate-aに保持する。

既存データの検査はSQLite/WAL/SHMとセッションキャッシュを分けた。内容6ファイルはハッシュ一致、追加された保存内容ファイルは0。作業前から起動中のアプリのGPUキャッシュ4ファイルは異なった。検査ツールもこの差異を隠さず記録する。
