# 実Obsidian E2Eとクラウド実行記録

## コードと実行結果を区別する

`test/e2e/obsidian.mjs`は実Obsidian 1.13.7と公式Self-hosted LiveSync 1.0.34を使用する7段階のシナリオです。モックやPouchDBだけのAPI呼出を実Obsidianとして数えません。実行可否・観測版・各段階の成功は`.local/e2e/evidence/result.json`に保存します。前提不足はexit 2／blocked、実アプリのシナリオ失敗はexit 1、全段階成功はexit 0です。ロックファイルで同じハーネスの二重起動を拒否します。

今回、このCodexクラウド環境へ公式AppImageをダウンロード・展開しました。配置先は`.local/e2e/obsidian/squashfs-root/obsidian`、CLIは同じディレクトリの`obsidian-cli`です。公式配布URLと取得物SHA-256を`test/e2e/plugin-lock.json`に固定しました。別のdotデスクトップへのインストールをこの環境での成功として数えていません。

Debian公式のXvfbを`.local/e2e/xserver/`へ展開し、Xauthority認証・`-nolisten tcp`付きで起動してから、実Obsidian起動を試しました。Electronは以下の理由でSIGTRAP停止しました。

> The SUID sandbox helper binary was found, but is not configured correctly.

さらに、同梱`chrome-sandbox`がroot所有かつ4755である必要があると通知されました。`unshare --user --map-root-user true`による機能確認も`/proc/self/uid_map: Read-only file system`で失敗しました。`--no-sandbox`／sandbox無効化、root所有への変更、setuid権限付与、永続認証情報の追加は行っていません。**インストールは成功、GUI起動と実同期E2Eはブロック、7段階の実同期合格は0件**です。

標準Electron sandboxを利用できる管理者許可済みの実行環境が必要です。現状のAppImageをこの環境で起動する場合、Electronが要求する変更は同梱`chrome-sandbox`のroot所有・4755設定です。これは特権実行ファイルの許可となるため、当初の承認前には実行しませんでした。後の限定承認に基づく試行結果は末尾に記録しています。sandboxを無効にする手順は提供しません。

## 7段階の検証内容（コード化済み・GUI経路は未実行）

| 段階 | 実際の操作／成功条件 |
|---|---|
| 作成 | 実Obsidianのvault APIで日英・絵文字Markdownと約160 KiBのバイナリを作成。公式プラグインで同期し、同じVault IDの別ObsidianのファイルをSHA-256照合 |
| Vault分離 | 別Vault IDに同一パスの異なる本文を作成。同じVaultのreaderは元本文を維持し、別Vaultに添付が現れない |
| 更新 | 本文と添付約180 KiBを更新し、リンク・パスと完全バイト列を別Obsidianで照合 |
| 再接続 | ローカルWorkersを停止中に編集し、オフライン同期の成功誤報を拒否。再起動後に公式プラグイン再同期してreaderを照合 |
| クライアント再起動 | readerの実Obsidianを停止し同じ使い捨てVaultで再起動。次の変更を同期しcheckpoint再利用経路を検証 |
| 削除 | 本文と添付を実Obsidianから削除し、readerのObsidianファイル一覧から消える |
| R2復元 | テスト専用ルートでDO管理キャッシュを消去しWorkers再起動。新しいObsidianへ同期し、残存本文と削除済みファイルの非復活を確認 |

書込と同期は`app.vault`と実プラグインのservice APIを使い、転送用ドキュメントやチャンクをテストが代わりに組み立てません。プラグインの既存公開E2Eセッションパッケージ`@vrtmrz/obsidian-test-session=0.3.0`を利用します。このパッケージのデフォルトargvには`--no-sandbox`があるため、ハーネスは起動前フックでargv全体を置き換えます。loopbackのデバッグポートと分離したprofileだけを指定し、保護無効化のスイッチは含めません。Obsidian 1.13.7はパッケージの検証済みカタログ外なのでprobeとして起動しますが、rendererの実観測版は必ず1.13.7と照合します。

## ローカルサービスの実行済み検証

`npm run test:e2e:backend`はWrangler `dev --local`で本物のworkerd／SQLite DO／R2を起動し、別Vaultの同一ID分離とR2再構築・Workers再起動を実行しました。成功しています。これはGUI E2Eとは別の前提検査です。

この検査は、DO内部で`ctx.id.name`が失われるためVaultを識別できずR2保存に入らない問題を発見しました。Vitest環境の名前付きDOだけでは発見できなかったものです。認証済みホストからURL符号化した内部Vault参照を転送し、既存内部secret、実DO ID一致、ホストpolicyを検査した後にDO KVへ識別のみ保持します。外部Basic同期からの`/internal/*`は404で遮断し、信頼済みヘッダー転送によって管理ルートが開かないことも検証します。本文はR2のままです。識別不能なR2ホストはSQLiteへ黙ってfallbackせず失敗します。SQLite-onlyライブラリホストの既存契約は維持しています。

公式Workersテストにも、DO名を使わない経路、日本語Vault ID、内部secret拒否、実DO ID不一致、インスタンス再構築・管理キャッシュ消去後の復元を追加しました。また前回レビューコミットのWorker OAuth構成に残った`requireSecret`のimport漏れを型検査で確認し復元しました。

## 再実行手順

Node.js 24.19以降、Linux x64、表示サーバー、標準Electron sandboxの利用許可が必要です。ローカルサービスに本番トークンや本番Vaultは使いません。

```bash
npm ci --cache /tmp/livesync-e2e-npm-cache
npm run test:e2e:install
npm run test:e2e:plugin
npm run test:e2e:backend
```

すでに適切な表示サーバーがある場合は、そのDISPLAY／XAUTHORITYを維持したまま実行します。

```bash
OBSIDIAN_BINARY="$PWD/.local/e2e/obsidian/squashfs-root/obsidian" \
OBSIDIAN_CLI="$PWD/.local/e2e/obsidian/squashfs-root/obsidian-cli" \
npm run test:e2e:obsidian
```

表示サーバーがない場合に使った使い捨てXvfbの起動例です。これはElectron sandboxのブロッカーを解除しません。終了後は起動したPIDだけを停止し、認証cookieを削除します。

```bash
xauth -f "$PWD/.local/e2e/xserver/Xauthority" add :91 . "$(openssl rand -hex 16)"
"$PWD/.local/e2e/xserver/root/usr/bin/Xvfb" :91 \
  -screen 0 1280x900x24 -nolisten tcp \
  -auth "$PWD/.local/e2e/xserver/Xauthority" &
e2e_display_pid=$!
DISPLAY=:91 XAUTHORITY="$PWD/.local/e2e/xserver/Xauthority" \
OBSIDIAN_BINARY="$PWD/.local/e2e/obsidian/squashfs-root/obsidian" \
OBSIDIAN_CLI="$PWD/.local/e2e/obsidian/squashfs-root/obsidian-cli" \
npm run test:e2e:obsidian
kill "$e2e_display_pid"
rm "$PWD/.local/e2e/xserver/Xauthority"
```

ハーネスは実行ごとにephemeralなsecret／Basicパスワード、loopbackポート、2Vault、ローカルR2／DO保存域と隔離Obsidian profileを作り、finallyでプロセス・Vault・ローカル保存域を破棄します。プロダクションWrangler設定を変更せず、テスト専用entrypointの復元ルートを本番へ追加しません。個別操作は45秒、サービス起動45秒、ファイル反映60秒で失敗する上限を設けています。

このクラウドと別のdotデスクトップに共有ファイルシステムがあるとは仮定しません。ソース一式のhandoffアーカイブを承認済みのプラットフォーム添付経路で転送し、受信側でchecksumを照合して展開し、同じ手順を実行できます。ただしユーザーの最新指定はこのクラウドでの実行です。Libraryは前回HTTP 401であり、別経路のLibrary書込みによる回避は行いません。

## 参照

- [Playwright Electron公式API](https://playwright.dev/docs/api/class-electron)
- [公式LiveSyncリリース1.0.34](https://github.com/vrtmrz/obsidian-livesync/releases/tag/1.0.34)
- [LiveSync公式実Obsidianテスト](https://github.com/vrtmrz/obsidian-livesync/tree/14141446a14deab3353a8864dee41e44c372d006/test/e2e-obsidian)
- [公式Obsidian配布1.13.7](https://github.com/obsidianmd/obsidian-releases/releases/tag/v1.13.7)

## 最終検証と保存

追加の内部識別転送は、別の読み取り専用担当にも認可境界をレビューしてもらい、重大な漏れ・競合・既存ホスト互換性回帰は見当たりませんでした。最終の`npm test`はNode163件＋公式Workers25件＝188件が成功し、`npm run typecheck`、build、各E2Eスクリプトの`node --check`、`git diff --check`、ローカルWrangler前提検査も成功しました。GUI起動失敗と実同期未実行はこれらの成功とは別です。

証跡と復元物は`.local/e2e/evidence/`の`result.json`、`summary.json`、ログ、SHA256SUMS、Git bundle、ソースアーカイブに保存しています。実Cloudflare資源作成、実Vault移行、push／PR／merge／本番deploy、dotデスクトップ変更はしていません。

## 同梱sandbox設定への限定承認後の再試行

ユーザーは公式Obsidian同梱`chrome-sandbox`だけをroot所有・4755へ設定する操作を明示承認しました。重複実行とE2Eロックがないことを確認した後、承認済みの昇格実行を試しました。この環境には`sudo`がなく、同一ファイルへの直接の`chown root:root`もOSから`Operation not permitted`で拒否されました。実行ユーザーはuid 1000のままです。所有者はagent:agent、modeは755で変更されていません。

指示どおり拒否時点で設定変更を停止しました。別の昇格経路、sandbox無効化、システムの追加変更は試していません。自動承認レビューの拒否ではなく、実行環境の所有者変更権限不足です。標準sandboxの前提が満たされていないためGUI／実同期E2Eは再開できません。プラットフォーム側で、この同一ファイルに承認済み設定を適用できる管理権限が必要です。証跡は`.local/e2e/evidence/sandbox-approved-attempt.json`です。コード変更はなく、前回成功した188件の結果はそのまま保持します。

## Obsidian CLIと代替経路の調査

公式[Obsidian CLI文書](https://obsidian.md/help/cli)は、CLIが実行中のObsidianアプリを操作し、アプリが起動していなければ初回コマンドで起動する方式であると明記しています。plugin:reload、command、evalを使えるため、アプリが正常起動する環境では実プラグインE2Eの操作経路として使えます。このクラウドで同梱`obsidian-cli help`を実行すると「The CLI is unable to find Obsidian. Please make sure Obsidian is running and try again.」と返りました。独立したプラグイン実行ランタイムではありません。既存ハーネスもこの公式CLIを起動手順に使用しています。

公式[Obsidian Headless](https://obsidian.md/help/headless)はアプリ不要ですが、[Headless Sync](https://obsidian.md/help/sync/headless)はObsidian Sync契約・サービス向けです。任意のCouchDB互換WorkerやSelf-hosted LiveSyncプラグインの実行経路とは確認できません。実アカウント／契約は作成・利用していません。

別の有効な選択肢は、[公式Self-hosted LiveSync CLI](https://raw.githubusercontent.com/vrtmrz/obsidian-livesync/main/src/apps/cli/README.md)です。公式READMEはObsidian不要で、プラグインと同じ同期コアを使い、CouchDBへのsync／ファイルのpush・pull／Vault mirrorを提供すると説明しています。これをローカルWorkersへ接続したヘッドレス同期E2Eは、権限変更なしで取り組める経路です。ただしObsidianのファイルイベント・API・プラグインロードの保証は別で、実Obsidian E2Eと同一視しません。代替調査時点では未実行でしたが、以下の追加検証で公式CLI同期E2Eを実行しました。

読み取りの実行環境確認では`CapEff=0`、`NoNewPrivs=1`、`Seccomp=2`でした。既存Chromiumのsandbox helperもroot所有ではありません。[Linux公式文書](https://docs.kernel.org/userspace-api/no_new_privs.html)によればNoNewPrivsは子へ継承され、setuidによるexec時の権限上昇も抑止します。そのため、前に述べた「同梱helperのroot所有・4755」だけで起動できるとは保証できません。既に観測したuser namespaceのuid_map書込み拒否も残ります。NoNewPrivsやseccompを解除したり、拒否されたchownを再試行したり、別バイナリ経由で迂回していません。

実Obsidianを残す選択肢は、プラットフォームが標準Electron sandboxに必要な機能を許可する実行プロファイル、または標準sandboxで動く別の許可済み環境に同じハーネスを移すことです。この既存コマンド環境内での、確認済みの非root・標準sandbox起動経路は見つかっていません。これは全環境／全代替が不可能という主張ではありません。ソースコード変更はなく、前回の188件の結果は維持しています。


## 公式LiveSync CLIの実同期検証（GUI受け入れは未完了）

`npm run test:e2e:cli`で公式ソースの取得・ビルドから実同期まで成功しました。ソースは[公式1.0.34の固定コミット](https://github.com/vrtmrz/obsidian-livesync/blob/27a2d9e8c9672fb8df522470712da3cc6e35af11/src/apps/cli/README.md) `27a2d9e8c9672fb8df522470712da3cc6e35af11`、共有コアは`@vrtmrz/livesync-commonlib 0.1.35`です。ソースと上流lockを変更せず、`npm ci`と公式CLI workspaceのbuildを実行します。CLIが生成する実リビジョン・チャンクを使用し、テスト側でCouch文書を組み立てません。

```bash
npm run test:e2e:cli:prepare  # 任意: 固定ソースの取得・公式ビルド
npm run test:e2e:cli          # build + 隔離された実同期7段階
```

既存のクリーンな同一コミットを使う場合のみ`LIVESYNC_CLI_SOURCE=/absolute/path`を指定できます。既定は`.local/e2e/livesync-cli`です。初回はGitHub/npmへの接続が必要です。公式ソース・ビルドreceiptを再利用し、個別CLIコマンドは45秒で失敗する上限を設けます。

成功した7段階は、ノート／複数チャンクのバイナリ作成、2Vaultの同一パス分離、本文／バイナリ更新と添付リンク維持、バックエンド停止中のローカル更新と再接続、別Nodeプロセス間のPouchDB／チェックポイント維持、削除伝播、DO管理DBの消去＋Workers再起動後のR2復元です。160,003バイトの添付は実splitterで2チャンクになりました。更新後180,011バイトと復元対象の残存添付もSHA-256で原本と照合しています。削除されたノート／添付は新規クライアントへ復元されず、他Vaultの同一パスは残ります。

実LiveSync CLIの削除はCouchDBの`_deleted`だけではなく`deleted: true`のアプリ側記録です。この実形式を変更せず、その伝播・復元後の非再出現を検証します。ローカル資格情報・PouchDB・R2／DO保存域は実行ごとに作成し終了時に破棄します。画像／PDFの拡張子を持つ任意バイト列を使い、画像表示やPDF解析の検証は含みません。

再実行の回帰検査は`npm test`のNode163件＋公式Workers25件＝188件、`npm run typecheck`、build、スクリプト構文検査が成功しました。lint用スクリプトは既存構成にありません。証跡は`.local/e2e/cli-evidence/result.json`、ビルドreceipt・ログ・回帰ログ・checksum・Git bundle・ソースアーカイブに保存します。

**実Obsidian＋公式プラグインのE2Eは未完了です。** CLIはファイルイベント・Obsidian API・プラグインロードを検証しません。結果には`actualObsidian: false`、`overallObsidianE2EComplete: false`を明記し、GUIハーネスと起動失敗の証跡を保持しています。

## 選択中クラウドで標準sandboxを使うための前提

[Electron公式sandbox説明](https://www.electronjs.org/docs/latest/tutorial/sandbox)と[Chromium Linux sandboxの構成](https://chromium.googlesource.com/chromium/src/+/HEAD/sandbox/linux/README.md)に基づき、プラットフォーム管理者が同じ選択環境に適切な実行プロファイルを提供する必要があります。現在のセッションから設定変更や別環境への切替は行いません。

| 条件／標準経路 | この環境での確認 | 再開に必要なもの |
| --- | --- | --- |
| 公式Obsidian・CLI・プラグイン | 配布物取得済み | 既存の固定版を使用 |
| 表示サーバー | 認証付き・TCP無効のXvfbを起動できた | 再実行時に同じ使い捨て表示サーバーを起動 |
| 非特権user namespace経路 | namespace作成に伴う`/proc/self/uid_map`書込みがread-onlyで拒否 | 承認済みプロファイルで必要なnamespace作成とUID/GID mappingが許可されることを管理者が確認 |
| 同梱setuid helper経路 | helperはagent所有755。承認済みchownはOS拒否。`NoNewPrivs=1` | 管理者による同梱helperのroot所有4755だけでなく、helperの標準権限動作を実行プロファイルが許可することを確認 |
| 制約の確認 | `CapEff=0`、`Seccomp=2` | seccompの値だけで原因を断定しない。管理者が必要なsandbox操作の許可を確認し、標準sandboxを維持して起動検証 |

[LinuxのNoNewPrivs文書](https://docs.kernel.org/userspace-api/no_new_privs.html)が示すとおり、その属性は継承されsetuid execによる権限上昇を抑止するため、helperのファイルmodeだけを直しても起動成功は保証できません。プラットフォームが上記の標準経路を提供した後に、既存`npm run test:e2e:obsidian`で起動と7段階を実測して初めてGUI受け入れを判定します。拒否された所有者変更の再試行、sandboxの迂回・無効化、別環境への切替、本番deployは実施していません。


## GitHub Actionsのdraft PR検証

`LiveSync E2E`は`pull_request`（draftを含む）で公式CLIと実Obsidianを別ジョブとして実行します。手動再実行用`workflow_dispatch`もあります。CLIはUbuntu 24.04、GUIは標準user namespace経路を使うUbuntu 22.04 hosted VMで、Node 24・上流lock・固定checksumの公式配布物を使用します。Ubuntu 22.04 runnerは2027年4月に終了予定なので、その前に標準sandboxで動く後継runnerを実測して移行する必要があります。

資格情報はローカルハーネスが毎回生成し、CloudflareアカウントやGitHub Secretsは不要です。checkoutは認証情報を残さず、workflow権限は`contents: read`のみです。root所有／setuid設定、sandbox無効化、sysctl・AppArmor・seccomp変更、deployを行いません。標準sandboxのnamespace前提が満たされなければそのジョブを失敗として記録します。GUIの成功判定は実アプリ・プラグイン版の照合と`actualObsidian: true`および7段階の成功を要求します。

`CI`はbuild、TypeScript、Node／公式Vitest Workersテスト、`.mjs`構文検査、mainとの差分空白検査を実行します。既存設定にESLint／Prettier／Biome等のlint／formatterはありません。空白検査をformatterの合格とは扱わず、無関係なツール導入・全コード整形を避けています。`Publish to npm`はreleaseイベント専用で今回のPRでは実行しません。

失敗時も`actual-obsidian-evidence`と`official-cli-evidence`に結果JSONを保存します。一時Vault・profile・R2／DO保存域・資格情報はアップロード対象外です。CLI成功、GUI成功、型／回帰検査を別々に確認し、GUIの未実行／失敗をE2E完了とは扱いません。


### GitHub Actionsでの実GUI合格記録

2026-10-05、[draft PR #1](https://github.com/hayatosc/livesync-workers/pull/1)のhead `a474bed28c69b2bce3168eb59a12f47d97ecf305`で[LiveSync E2E run 37291648624](https://github.com/hayatosc/livesync-workers/actions/runs/37291648624)が成功しました。取得したGUI artifactは`status: passed`、`actualObsidian: true`、7ケース成功で、全5回の起動／再起動readinessに実Obsidian 1.13.7・プラグイン1.0.34を記録しています。標準namespace前提とauthenticated Xvfbが動作し、root所有・setuid・セキュリティ設定変更なしで実アプリの作成・同期・更新・削除・再起動・DO復元を検証しました。これにより、前節の「GUI未完了」はCodexコンテナでの過去の試行結果となります。現在のGUI受け入れ結果はGitHub Actionsの成功です。

[CI run 37291648668](https://github.com/hayatosc/livesync-workers/actions/runs/37291648668)もbuild、構文、空白、型検査、188テストが成功しました。CodeRabbitはdraftを理由にレビューをskipしており、コードレビュー成功とは扱いません。既存v4 ActionsにはNode 20非推奨・runner側Node 24実行への移行警告がありますが、各checkは成功しています。lint／formatterの未設定とUbuntu 22.04の退役予定は引き続き明示しています。

artifactのCLI経由取得はストレージ側403になりましたが、認可済みGitHub connectorのartifact読取で取得し、両結果JSONを確認しました。ローカル証跡は`.local/e2e/github-actions-evidence/`です。Libraryにはアップロードしていません。PRはdraftのままで、merge・deployしていません。

続くGUI検査では実プラグインが作るチャンク数を明示検証し、DO復元後に残存バイナリも原本SHA-256と照合します。最新headの判定はPR checksを参照してください。
