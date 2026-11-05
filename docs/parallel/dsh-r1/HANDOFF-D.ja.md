# Folio D — 非GUI検証入口とCI

2026-11-04 / branch `codex/folio-dsh-r1-quietci-20261104`
worktree `<workspace-root>/Folio-dsh-r1-quietci`

基準commit: `b96422fc2eee354b7a8d77a9de6018394708b5e3`
基準側の過去証拠は「83ファイル・850件 PASS」。これは前回の証拠であり、下記の今回実行結果とは混ぜていない。

実装commit: `619071072b2c158ef4022e6d967299297f9ceeac`
このHANDOFFのcommit: 実装commitの次のローカルcommit（最終HEADは完了報告に記載）。

## 結論

- `npm run verify:quiet` を追加した。型検査 → Vitest（`--maxWorkers=2`）→ 既存の production build の順に実行し、最初の失敗stageで停止する。失敗stage、exit code、signalを結果とプロセスの終了コードに保持する。
- quiet入口は Electron / Playwright / browser / `dev` / `start` / `package` / screenshot / OS clipboard / `osascript` を起動しない。stageと実行ファイルはspawn前に拒否リストで検証し、`FOLIO_GUI_TEST_OPT_IN`、`PWDEBUG`、`PWTEST_WATCH` は子プロセスの環境から削除する。
- `.github/workflows/quiet-checks.yml` を追加した。`pull_request` と `master` への `push` だけを対象に、`contents: read`、`ubuntu-latest`、Node 24、`npm ci`、15分timeoutでquiet entranceだけを実行する。
- 現ブランチで `npm run verify:quiet` を1回実行し、**84ファイル・866件 PASS / 3 stage PASS / exit 0**。ログを `output/dispatch/quiet-run-final.log` に保存した。
- GUI/Electron/browserの実試験と、GitHub Actions上でのCI実行は **NOT_RUN**。

## 変更ファイル

| ファイル                               | 変更                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `.github/workflows/quiet-checks.yml`   | 新規。quiet checks専用のGitHub Actions workflow。                               |
| `package.json`                         | `scripts` に `verify:quiet` を1行追加。既存scriptは変更していない。             |
| `scripts/verify-quiet.mjs`             | 新規。stage runner、拒否リスト、環境sanitize、失敗時のexit code保持。           |
| `tests/quiet-runner.test.ts`           | 新規。16件。stage順序、失敗stage/exit code、mock spawn、GUI拒否、CI定義を検証。 |
| `docs/parallel/dsh-r1/HANDOFF-D.ja.md` | この引き継ぎ。                                                                  |

`src/`、GUI gate、Playwright config、lockfile、他担当のtestは変更していない。新しい外部依存も追加していない。既存testのskip・削除・assertion弱体化はしていない。

## 実装

### 実行入口

`package.json`:

```json
"verify:quiet": "node scripts/verify-quiet.mjs"
```

stageはデータとして固定し、シェル文字列に連結しない。

| 順序 | stage       | 実行内容                                                                         |
| ---- | ----------- | -------------------------------------------------------------------------------- |
| 1    | `typecheck` | `npm run check`                                                                  |
| 2    | `test`      | `npm run test -- --maxWorkers=2`                                                 |
| 3    | `build`     | `npm run build`（既存の `tsc --noEmit && vite build && node scripts/build.mjs`） |

- `build` は既存scriptの意味をそのまま使うため、型検査が2回走る。数秒の重複は許容し、build定義の複製・乖離を避けた。
- Vitestのworkerは2に固定。test timeoutは上書きせずVitest既定のまま。過大なtimeoutやworkerを設定していない。
- `spawn(command, args, { shell: false, stdio: "inherit" })` で引数を配列のまま渡す。
- 最初の失敗で後続stageを実行しない。結果は次を保持する。

```js
{
  ok: false,
  failedStage: "test",
  exitCode: 3,
  signal: null,
  results: [{ id, status, exitCode, signal, durationMs, error? }]
}
```

- `main()` はstageのexit codeを `process.exitCode` に設定する。signal終了時は同じsignalを自分へ送る。引数付き実行は誤用としてexit 2で拒否し、stageを起動しない。
- ログは `[quiet] ==> stage`、`[quiet] PASS stage=... in ...`、`[quiet] FAIL stage=... exit=...` の形式で、失敗stageとexit codeがCIログに残る。

### GUIに進まないためのfail-closed

- stageのnpm script名と引数を、`dev` / `start` / `package` / `test:e2e` / `test:e2e:batch`、および `electron|playwright|puppeteer|chromium|google-chrome|screenshot|clipboard|osascript|pbcopy|pbpaste|gui-test` のトークンで拒否する。大文字小文字も区別しない。
- 実行ファイル（npm自体）のbasenameも同じ拒否リストで検証する。
- 全stageをspawn前に検証するため、後続stageがGUI可能でも先行stageを起動しない。
- 子プロセス環境から `FOLIO_GUI_TEST_OPT_IN`、`PWTEST_WATCH`、`PWDEBUG` を削除する。opt-inを新規設定したり、`test:e2e:batch` へ切り替えたりする経路はない。
- 既存の `test:e2e`（既定拒否）と `test:e2e:batch`（明示opt-in）の意味は変更していない。CIもquiet入口だけを呼ぶ。

### CI

`.github/workflows/quiet-checks.yml` の要点:

- イベント: `pull_request` と `master` への `push` のみ。`workflow_dispatch`、schedule、deploy、publishはない。
- 権限: `permissions: contents: read` のみ。secret、PRコメント、self-hosted runnerは使わない。
- runner: `ubuntu-latest`、`timeout-minutes: 15`、PR/ref単位のconcurrencyで古い実行をcancel。
- Node: `actions/setup-node` の `node-version: "24"`。`node:sqlite` の `DatabaseSync` をin-memory DBで実行するpreflightを置き、APIが使えない環境を早期に落とす。
- install: `npm ci --no-audit --no-fund`。lockfileで再現する。
- 実行: `npm run verify:quiet` のみ。GUI系scriptは呼ばない。
- checkoutは `persist-credentials: false`。
- 外部Actionは公式の2つだけをcommit SHAでpinした（2026-11-04にGitHub APIでtagのcommitを確認）。
  - `actions/checkout` v7.0.1: `3d3c42e5aac5ba805825da76410c181273ba90b1`
  - `actions/setup-node` v7.1.0: `949feb2413d6458794dcd2491c4babbbce0c15c1`
  - https://github.com/actions/checkout/releases/tag/v7.0.1
  - https://github.com/actions/setup-node/releases/tag/v7.1.0

`push` のbranch filterは `master` だけにした。PRのbranch pushとCIが二重に走るのを避けるためで、統合branchへのpushでも回したい場合はCodex側でfilterを調整する。今回はpush禁止のためworkflowを実行していない。

## 検証結果

実行環境: macOS 26.6.2 / Node `v24.20.0` / npm `11.19.0`。

| 確認                                | 結果                                                                  | 証拠                                      |
| ----------------------------------- | --------------------------------------------------------------------- | ----------------------------------------- |
| `npm run verify:quiet`              | **PASS / exit 0 / 36.3秒**。typecheck 5.5秒、test 22.4秒、build 8.5秒 | `output/dispatch/quiet-run-final.log`     |
| 全Vitest（quiet入口内）             | **84ファイル・866件 PASS**                                            | 同上                                      |
| TypeScript（`npm run check`）       | **PASS**                                                              | quiet入口内、および単独実行               |
| production build（`npm run build`） | **PASS**。Vite 1742 modules / `dist/` 生成                            | 同上                                      |
| 新規Vitest 16件（verbose）          | **16/16 PASS**                                                        | `output/dispatch/quiet-runner-test.log`   |
| workflow YAMLの構文・主要値         | **PASS**。`on`、`permissions`、`runs-on` をparse確認                  | `output/dispatch/quiet-workflow-yaml.log` |
| Prettier check（所有ファイル）      | **PASS**                                                              | `output/dispatch/quiet-prettier.log`      |
| GitHub Actions上での実行            | **NOT_RUN**（push禁止）                                               | —                                         |
| GUI/Electron/browser/OS clipboard   | **NOT_RUN**（今回は実装・非GUI検証のみ）                              | —                                         |

実行コマンド:

```sh
npm run verify:quiet
node node_modules/vitest/vitest.mjs run tests/quiet-runner.test.ts --maxWorkers=2 --reporter=verbose
node -e "const YAML=require('yaml');const fs=require('fs');const doc=YAML.parse(fs.readFileSync('.github/workflows/quiet-checks.yml','utf8')); ..."
node node_modules/prettier/bin/prettier.cjs --check scripts/verify-quiet.mjs tests/quiet-runner.test.ts .github/workflows/quiet-checks.yml package.json
```

基準の83ファイル・850件から、新規1ファイル・16件を追加した計算で84ファイル・866件。既存testの件数・意味は変えていない。

build時のdynamic/static import警告と500kB超chunk警告は基準から存在するもので、今回解消していない。`node_modules` はこのworktreeでは既存環境へのsymlinkで、警告にはsymlink先のパスが出る。lockfileは変更していない。

## 受入表

| 受入項目                                                    | 判定             | 証拠                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 型検査 → Vitest → buildの順序                               | PASS             | `tests/quiet-runner.test.ts`「runs typecheck, Vitest, then build in order without a shell」                                                                                                                                                 |
| 失敗stageとexit codeの保持                                  | PASS             | 同「stops at the first failing stage and preserves its exit code」「reports the failing test stage and skips build」。exit 7/3、signal、spawn error、同期throwを検証                                                                        |
| プロセス終了コードへの反映                                  | PASS             | 同「sets the failing stage's exit code on the process」（exit 9）                                                                                                                                                                           |
| mock spawnでGUI commandを呼ばない                           | PASS             | 同「rejects GUI-capable scripts and arguments before spawning anything」「rejects a GUI-capable executable even if the stage list is valid」「strips ambient GUI opt-in and debug variables from every child」。`calls.length === 0` を確認 |
| 現ブランチでのquiet入口1回実行                              | PASS（exit 0）   | `output/dispatch/quiet-run-final.log`                                                                                                                                                                                                       |
| 既存 `npm test` / `check` / `build` / `test:e2e` の意味保持 | PASS             | 同「adds verify:quiet without changing existing script semantics」                                                                                                                                                                          |
| CI: Node 24 / node:sqlite / npm ci / 最小権限 / pin         | PASS（静的検証） | 同「keeps CI limited to quiet checks on GitHub-hosted Node 24 with pinned official actions」、YAML parse                                                                                                                                    |
| GitHub Actionsの実実行                                      | **NOT_RUN**      | push禁止のため。初回PR/push時にCodexが確認する                                                                                                                                                                                              |
| GUI実行                                                     | **NOT_RUN**      | 画面・Electron・browser・clipboardは一切起動していない                                                                                                                                                                                      |

## 残件・注意

1. **CIの実実行は未確認**。push/PR時に `npm ci`、Node 24のpreflight、`npm run verify:quiet` が通るかを確認する必要がある。特にsetup-node v7.1.0と`node-version: "24"`（最新24.x）の組み合わせはこのworktreeでは実行できない。
2. workflowの `push` は `master` のみ。統合branchへのpushでも回す運用にするなら、branch filterを広げる変更が必要。PRでは常に走る。
3. CIはartifact uploadやPRコメントをしない。証拠はActionsのconsole logだけ。必要ならCodex側でlog保存を追加する。
4. `verify:quiet` は既存 `npm run build` を使うため `tsc --noEmit` が2回走る。build定義を複製しないための意図的な選択で、今回の実測でも全体36秒程度。
5. `docs/QUIET-TESTING.ja.md` への `verify:quiet` 追記は所有外のため行っていない。Codex統合時に追記候補。
6. GUI/Electron/実画面の回帰、CI runner上の挙動、Windows/macOS runnerは未検証。単体・型・buildの合格をGUI合格として扱わない。
7. 既存のGUI gate（`scripts/run-gui-tests.mjs`、`tests/gui-test-policy.*`、Playwright config）は変更していない。quiet入口からGUI gateへ遷移する経路もない。

## commit

- 実装: `619071072b2c158ef4022e6d967299297f9ceeac` `feat: add quiet verification runner and CI workflow`
- HANDOFF: このファイルを含む次のローカルcommit（最終HEADは完了報告に記載）

push、deploy、PR作成、他worktree・他担当ファイルの変更は行っていない。
