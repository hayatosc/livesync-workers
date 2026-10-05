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
