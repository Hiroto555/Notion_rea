# 保存済みの検証証拠

2026-10-26の既存実行ログから、絶対project pathだけを `<PROJECT_ROOT>` に置換したコピーです。レビュー準備時にアプリの全E2Eを再実行したものではありません。元のアプリソース・既存テスト・buildスクリプト・lockfileは変更していません。

- [単体テストログ](unit-tests.txt): 13/13成功。
- [Electron E2Eログ](e2e-tests.txt): 7/7成功、33.2秒。
- [TypeScript](typecheck.txt) / [ビルド](build.txt): 成功。ビルド警告は残しています。
- [起動smoke](smoke.json): dev起動とパッケージ編集・再起動の既存結果。
- [性能サンプル](benchmark.json): 155ページ、1,000ブロック。単一機の1回測定。
- [baseline manifest](baseline.json): 元の記録日時・テスト数・ソース/生成物hash・REA Evidence ID。レビュー準備時に全登録hashを実ファイルと照合済み。
- [共有前スキャン](sharing-scan.json): 今回の共有候補とGit履歴の機械検査結果。検出値は記録しません。
- [共有検査ツールのテスト](review-tooling-tests.txt): 今回追加した5件の実行結果。

元ログは `output/`、元manifestは `research/evidence/` に残っています。ブラウザーtrace・ローカルDB・ユーザーデータは収録しません。詳細な操作範囲と未検証事項は [TEST-RESULTS](../TEST-RESULTS.md) と [KNOWN-ISSUES](../KNOWN-ISSUES.md)。
