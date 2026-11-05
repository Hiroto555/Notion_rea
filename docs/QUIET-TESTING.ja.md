# GUIテストの quiet 運用（既定拒否）

このリポジトリでは、通常の Node 検証だけでは画面を出しません。`npm test`、`npm run check`、`npm run build` は従来どおりで、Electron・ブラウザ・Playwright の画面を起動しません。`package.json` の `dev` / `start` など、GUI を起動し得る既存スクリプトも変更していません。

## コマンド

| コマンド | 動作 |
| --- | --- |
| `npm run verify:quiet` | 型検査 → Vitest（2 workers）→ build。最初の失敗で停止。GUI なし。 |
| `npm test` | Vitest。GUI なし。 |
| `npm run check` | 型検査。GUI なし。 |
| `npm run build` | ビルド。GUI なし。 |
| `npm run test:e2e` | 既定拒否。日本語/英語のメッセージを出して終了し、Playwright を起動しない。 |
| `npm run test:e2e -- --list` | 安全な dry-run。テスト一覧のみ取得し、テスト本体は実行しない。 |
| `npm run test:e2e:batch` | ユーザーが GUI 実行を明示的に許可した場合だけ使う opt-in 起動。 |

`npm run test:e2e:batch` は子プロセスの環境変数にだけ `FOLIO_GUI_TEST_OPT_IN=1` を付与します。値は完全一致で判定し、`true`、`yes`、`01`、空文字、前後空白などは opt-in とみなしません。既定の `test:e2e` は、たとえ親環境にこの変数があっても拒否します。`--mode=batch` を後ろから追加しても batch には切り替わりません。

CLI 引数は配列のまま子プロセスへ渡し、シェル文字列に連結しません（`shell: false`）。子プロセスの終了コードはそのまま返し、シグナルで終了した場合は同じシグナルを親へ伝えます。

## 直接実行の扱い

`npx playwright test` や `npx playwright test --config playwright.dev-round3.config.ts` も、opt-in がない限り config の評価時に拒否されます。`--list` は standalone なオプションとして現れた場合だけ許可します。`--grep --list`、`--grep=--list`、`-g --list`、`-- --list`、単なる文字列中の `--list` などは list とみなしません。

既存の suite、assertions、retries、workers は変更していません（`workers: 1` のまま）。

`--list` と `--ui` / `--ui-host` / `--ui-port` / `--debug` / `--headed` / `--reporter` の併用は、引数順序に関係なく拒否します。Playwrightでは UI モードが list モードより先に選択されるためです。`PWTEST_WATCH` または `PWDEBUG` が設定された環境での既定 dry-run も拒否します。dry-run 子プロセスには、親に残っている opt-in を引き継ぎません。

## 対象外

`scripts/r9-screenshots.mjs`、`scripts/r8-screenshots.mjs`、各 demo/verify スクリプトなど、このゲートを通らない standalone スクリプトは対象外です。これらはユーザーが GUI 実行を明示的に許可した後でだけ実行してください。

この仕組みは「OS レベルですべての GUI 起動を防ぐ」ものではありません。Electron を直接起動するコマンドや他スクリプト、手動操作までは防ぎません。対象は、このリポジトリの `test:e2e` / `test:e2e:batch` と Playwright config の評価経路です。

## 2026-11-05: 統合した quiet 入口

`npm run verify:quiet` は固定の `check` → `test -- --maxWorkers=2` → `build` を順に実行します。失敗したstageとexit codeを保持し、GUI opt-in/debugの環境変数を子プロセスから除きます。これはOS sandboxではなく、信頼してレビューしたnpm scriptsをまとめて実行する入口です。将来のscript変更やpre/post hookもレビュー対象です。

`.github/workflows/quiet-checks.yml` はNode 24、GitHub-hosted Linux、最小権限で同じ入口を実行する定義です。ローカルでの成功とGitHub Actions実行は別です。今回、pushやPR作成をしていないためActions実行は **NOT_RUN** です。
