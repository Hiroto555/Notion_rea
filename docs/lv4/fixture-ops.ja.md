# 使い捨て同期serverの操作fixture

`node scripts/lv4-go-ops-runner.mjs` は毎回、一時ディレクトリに新しいloopback serverを立て、標準入力のNDJSONを1行ずつ処理する。標準入力を閉じるとfixtureを終了し一時データを削除する。既存server、実workspace、秘密の永続化を対象にしない。引数は受け取らず、tokenを引数・URL・status・ログ・応答へ出さない。識別子に秘密を入れない。

例（プロセスが終了すると全登録も消える）:

```json
{"id":"1","command":"status"}
{"id":"2","command":"register","clientId":"device-a"}
{"id":"3","command":"revoke","clientId":"device-a"}
```

入力は1行4,096 Bまで。超過行は区切りまで読み捨て、次の行の処理を継続する。OpenCode Go `deepseek-v4.1-flash` / `max` の提案を親が確認し、読み込み前の長さ制限と公開エラーコードの制限を追加した。

これはT11の一部を試すfixtureであり、実serverの管理CLIではない。backup・restore・epoch更新、再起動後の登録保持、OS安全領域、SSHトンネルや2端末での受入は未実装・NOT_RUN。外部から端末接続する機能も提供しない。

異常終了やSIGKILLでは、一時ディレクトリが残る場合がある。復旧や自動削除は未実装。残ったディレクトリを実serverのデータと混同せず、内容を確認してから扱う。
