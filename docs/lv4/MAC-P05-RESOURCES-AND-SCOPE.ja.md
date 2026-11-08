# MAC-P05：実行先・権限・最小PoCの範囲

2026-11-08。MAC-P01/P03/P04の保存commitは `b19ecbe1fd9700575d75474c5e08573ffcbb75d9`、製品受入基準は `bd65b73b492b95b8b9a2a1f73ad9a5e114c509dc`。これは後続の実装範囲を決める計画書で、別Mac・サーバーの存在や利用権限を確認した記録ではない。

その後、利用者はTV視聴中の**このMacでのアプリ起動検証**を明示許可した。[今回のローカルGUI受入](MAC-LOCAL-GUI-ACCEPTANCE-20261108.ja.md)は240 PASS / 実IME 1 INFRA_BLOCKED。既存 `test:e2e:batch` と専用一時領域で別に記録した。別ホスト用MAC-P05の現用Mac拒否は維持し、その環境変数を偽装してローカル結果を別ホストの証拠にしない。push・workflow作成/実行・課金設定変更・master mergeは引き続き行わない。

## 機材は段階ごとに用意する

| 段階                                         | 必要な実行先                                                                                     | まだ必要としないもの                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 最小H1：起動・保存・正常終了・再読込         | 別の専用Mac A **1台**、または実行を許可されたGitHub-hosted macOS 1 job                           | Mac B、独立server S、SSH、実Keychainの操作                     |
| H2：実Keychainの保存と独立process復号        | 隔離可能なMac A/hosted Mac。対象artifact、private test Keychain、対照条件                        | 物理2台。接続設定に必要な合成serverはA上のloopbackで用意できる |
| H3：利用不能時の保留・暗号文維持             | cold/warm・項目状態・API結果を別々に観測できる専用Mac。人による許可/拒否が必要なcaseは現地操作枠 | 物理2台を使う通信試験                                          |
| 最終E3：双方向・実SSH・sleep・完全server復元 | **異なる物理Mac A/B＋常時稼働server S**                                                          | このMacをA/Bに数えること、VM/2 processによる物理台数の代替     |

最初から2台とserverを揃えることをH1の前提にしない。GitHub標準hosted runnerはVMとして記録し、E3へ換算しない。hostedのGUI session/KeychainがFolioで成立するかは未実行であり、runnerを用意できることと合格は別。[GitHubのrunner仕様](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

### Mac A/Bに確認すること

- 現用Macとは別の物理識別、arm64、OS版、占有可能な時間、再起動やsleep後の復帰担当/手段。現行guardのarch条件を黙って広げない。
- 試験用ユーザーとGUIログインsession。個人のFolio/Keychain/認証情報を持ち込まず、合成データを使う。ディスク空きはartifact・独立data/vault・ログを置けるか実測する。
- Node 24、lockfileに対応した依存、Electron 45.0.0、Playwrightの固定版。製品sourceとharnessを別に固定し、同じartifactを再起動間で使う。
- artifact転送後のhash、bundle ID、署名identity、quarantine/Gatekeeper状態。署名/公証や証明書購入を追加の必須条件にせず、未署名の結果の適用範囲を明記する。
- GUI排他は1台1 job。OS操作を行う場合は、そのMacで必要な権限と操作担当を確認する。VMや遠隔viewerをこのMacへ自動的に導入しない。

実Keychainはapp identityと署名が挙動に影響し、同期safeStorage APIは入力待ちでmain threadを止め得る。同じsourceの再buildを同じidentity/artifactの証明にせず、外部watchdogを使う。[Electron 45 safeStorage](https://github.com/electron/electron/blob/v45.0.0/docs/api/safe-storage.md)

### server Sに確認すること

Sが必要なのはA/B・実SSH・sleepの受入段階。Aのsleep中もB/S/監督が動く構成にする。Linux等の常時稼働host、Node 24、固定した `dist/server-ops.cjs`、試験専用の所有ディレクトリを用意する。

- Folio serverは127.0.0.1のみでlisten。A/Bは個別のSSH認証と転送先を使う。ホスト鍵を確認し、FolioのHTTPポートをインターネットへ直接公開しない。
- server・資格情報受渡し・backupを別領域にする。親0700、合成資格情報0600。秘密をargv/stdout/チャット/Git/CI artifactへ出さない。
- test用アカウントに必要なのは自分のserver起動/停止、資格情報発行、backup/新規先restore、SSH転送。root権限や本番serverの操作を前提にしない。
- 古いserverを止めてから復元先へ切り替える。旧端末の失効と新端末登録を同じ候補で確認し、未確定送信・receipt・backupを保全する。

CLIの既存契約は [M3運用手順](M3-OPERATIONS.ja.md) を使う。実サーバー/鍵/接続先は今回作成も接続もしていない。

## 権限と担当の整理

| 用途                        | 必要な権限・状態                                                                              | 確認する人/場所                                       |
| --------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| H1のapp内UI/IPC             | 試験ユーザーでappを起動し、専用一時data/vault/evidenceへ読み書きできること                    | Mac A側。OS全体の管理者権限を既定にしない             |
| native Cmd+Q/IME/picker操作 | 実際の自動操作方式が必要とするAccessibility/Automation等。app内Playwright操作だけの権限と区別 | そのMacで許可状態を確認。必要な場合だけ現地担当が設定 |
| 画面の観測                  | app自身のcaptureとOS画面収集を区別し、後者に必要な許可を確認                                  | 別Mac側。許可不足をmock画像のPASSで埋めない           |
| 実Keychain                  | 試験用Keychain/ユーザーと対象appのアクセス許可、復元可能な隔離方法                            | Mac A側。個人のlogin Keychainや検索順を無断変更しない |
| GitHub-hosted実行           | 対象repoの実行経路、固定ref/artifact、利用枠/時間上限                                         | repo管理側。今回workflowは作らず起動しない            |
| 専用self-hosted登録         | repo/organizationでrunnerを登録・限定できる担当と、Mac側の所有/運用権限                       | 両方の管理者。token発行/登録は別作業                  |
| SSHとSの運用                | testアカウント、A/Bの認証手段、host鍵、転送、Sの専用領域                                      | S/A/Bの担当。利用可能か未確認                         |

TCC DBの直接編集、OS保護機能の無効化、全アプリへの包括許可、課金/global設定変更を解決策にしない。UIの許可が不足したcaseだけをINFRA_BLOCKED等で保留し、他の独立した項目を先に進める。

現行の別ホストguardはhosted jobまたは登録済みself-hosted runnerを想定している。単に別Macを手動で開くだけではその契約を満たさない。手動実行経路を採用するなら、実際のhost登録/監督契約を先に別差分で設計し、CI環境変数の偽装で通さない。

## 次の実装はH1だけを最小単位にする

実行先準備と並行して、次の5点を実装候補にする。今回の文書整理をその実装開始の許可にしない。

1. **別ホスト専用suite/config**：`tests/acceptance/macos/` の今回の `local-native` とは別のsuite/configへ配置し、既存 `test:e2e:batch` を入口にする。ローカルopt-inで別hostのguardを通さず、Linux suiteの無条件globにも混ぜない。最初のplanは `caseIds=[MAC-H1]`、worker1/retry0、job上限15分を候補とする。
2. **起動前preflight**：実host・runner・一時parent・固定source/artifact/harnessを照合し、新規data/vault/evidenceを割り当てる。guard拒否時は最初のapp processも起動しない。
3. **watchdogの実process接続**：現状のwatchdogは固定Node worker専用。監督部分を分離し、batch内部で許可した起動の所有groupだけを監視する。任意PIDへのattachや管理Macの直接Electron起動CLIを追加しない。中断signal・正常exit後の子孫残留・pipe閉鎖を既存Node反例で再確認する。
4. **MAC-H1**：合成の日本語/英語ページを作成→編集→保存ACK→正常終了→新PIDで再起動し、ID/revision/内容hashを再照合する。同期を有効化せず、本番serverへ接続しない。programmatic app.quitの証拠は実Cmd+Q/Dockの証拠と区別する。
5. **実測からの証拠生成**：OS/arch/image、対象artifact、PID、保存/再読込hash、所有processの終了、参照ファイルを収集する。人工fixtureの真偽値をコピーしてobserved reportを作らない。validatorのexit0は人の照合候補で、Lv4認定ではない。

H1が成立してからH2を別planとして追加する。H2はstock Playwright loaderの `--use-mock-keychain` が対象外になることに加え、mainの有効switch、期待するprivate Keychainと実アクセス先、項目識別、別processの復号と対照条件を確認する。argvにswitchが見えない事実だけでは合格にしない。製品main/preloadへの診断hookは既定で追加せず、外部harnessで観測できなければ不足を別差分としてレビューする。

H3はkey項目状態とcold/warm processを分ける。warm cacheの継続を失敗とは決めず、実際にAPIが利用不能になった経路での保留と暗号文維持を確認する。ロックだけで利用不能と仮定しない。原因不明timeoutはUNRESOLVEDのまま、原因判明後は期限到達の事実を保持したINFRA_BLOCKED/FAILへ分類する。

## 実行経路と停止点

- 新規 `workflow_dispatch` は作業branchへ置くだけで初回実行できると仮定しない。公式のdefault branch条件と、登録済みworkflowの別ref起動を区別する。専用PR経路も、実際に用意する段階で対象・権限・既存workflowへの影響をレビューする。[GitHubの手動起動条件](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
- remoteを起動する前に、host/OS/時間枠、候補artifact、plan hash、選定caseと件数、期限/停止/証拠回収方法を固定する。
- H1だけの完了、H2を追加する、機材待ちで候補を凍結する、のいずれも有効な停止点。H1成功を実Keychainや物理2台の合格へ拡張しない。
- 現在の未確認項目は、別Mac台数・OS・占有枠、Sの利用先、runner登録経路、SSH/復帰担当、GUI/Keychain権限、署名identityと転送方法。これらは利用者/担当者の実環境情報で確認する。

M3は最終受入待ち、確認済みLv3、Lv4未認定。今回のローカルGUI結果と将来のMAC-P05/E3結果は、それぞれ実測と未実行の境界を維持して記録する。
