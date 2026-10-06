# テストとCI

## 回帰・Cloudflare Workers統合

```sh
npm ci
npm run build
npm run typecheck
npm test
# Workers統合だけ
npm run test:workers
```

`npm test`はライブラリNode156件、Worker Node7件、公式Vitest Workers59件の計222件です。`vitest.workers.config.ts`から`test/workers/wrangler.jsonc`のローカルWorkers／SQLite DO／R2 bindingを使用します。[Cloudflare公式Vitest統合](https://developers.cloudflare.com/workers/testing/vitest-integration/)で、独自Miniflare起動は使いません。

統合テストは、同期API・リビジョン競合・チャンク／バイナリ、保存境界の注入障害と再試行、R2 head CAS、DO行／スキーマ消失後の再生、削除・checkpoint、GC、明示移行、管理DB圧縮／容量拒否／ページ化復元と保存失敗、Segmenter解析・索引更新／世代切替、Vault越境・MCP scope／更新競合を検証します。実CPU強制終了・本番R2障害を再現したという意味ではありません。

## 公式LiveSync CLI E2E

```sh
npm run test:e2e:cli:prepare  # 任意: 公式固定ソース取得・ビルド
npm run test:e2e:cli
```

公式LiveSync 1.0.34のcommit `27a2d9e8c9672fb8df522470712da3cc6e35af11`を取得し、上流lockで`npm ci`、公式CLI workspaceをbuildします。共有コアは0.1.35です。クリーンな同じcommitの既存checkoutは`LIVESYNC_CLI_SOURCE=/absolute/path`で指定できます。初回はGitHub／npmへの接続が必要です。

実CLIがチャンク・rev・checkpointを生成し、実WranglerローカルWorkerへ同期します。結果は`.local/e2e/cli-evidence/result.json`です。CLIはObsidianのAPI・ファイルイベント・プラグインロードの検証を代替しません。

## 実Obsidian＋公式プラグインE2E

Linux x64、Node 24、標準Electron sandboxを利用できる実行環境と表示サーバーが必要です。

```sh
npm run test:e2e:install
npm run test:e2e:plugin
npm run test:e2e:backend  # 任意: ローカルサービスの前提検査

OBSIDIAN_BINARY="$PWD/.local/e2e/obsidian/squashfs-root/obsidian" \
OBSIDIAN_CLI="$PWD/.local/e2e/obsidian/squashfs-root/obsidian-cli" \
xvfb-run -a -s '-screen 0 1280x900x24 -nolisten tcp' npm run test:e2e:obsidian
```

公式Obsidian 1.13.7と公式LiveSyncプラグイン1.0.34を`plugin-lock.json`のSHA-256で検証します。installerは配布物を`.local`へ取得・展開し、sandbox helperの所有者／setuidやOS設定を変更しません。上の実行例はホストのXvfb／xauthを使用します。既存表示サーバーを使う場合はDISPLAY／XAUTHORITYを設定してnpmコマンドを直接実行できます。

ハーネスは標準sandboxを維持し、隔離user-data-dir・一時Vault・loopbackのみのデバッグ接続を使用します。実アプリ版・プラグイン版を照合し、`actualObsidian: true`と7ケース成功を要求します。結果は`.local/e2e/evidence/result.json`です。起動に失敗した環境の結果をGUI合格として扱いません。

GUI／CLIはそれぞれ次の7段階を検証します。

1. ノート・複数チャンク添付の作成と独立クライアントへのバイト一致。
2. 2Vaultで同一パスの分離。
3. 本文・添付更新と元リンク／バイトの維持。
4. バックエンド停止中のローカル更新と再接続。
5. クライアント再起動／別プロセス間のcheckpoint維持。
6. ノート・添付削除の伝播。
7. DO管理DB消去＋Worker再起動後のR2復元、残存添付のSHA-256一致、削除済みファイルの非再出現。

添付fixtureは画像／PDF拡張子を持つ任意バイト列です。画像表示やPDF解析は検査しません。実行ごとにローカルBasicパスワード、内部secret、R2／DO保存域を生成し、終了時にprofile・Vault・プロセス・資格情報を破棄します。実Cloudflare資源・実ユーザーVault・永続的な資格情報は使いません。

## GitHub Actionsと確認済み結果

[CI](../.github/workflows/ci.yml)はbuild、型検査、全222テスト、`.mjs`構文、mainとの差分空白検査を実行します。lint／formatterは未設定で、空白検査をそれらの合格とは扱いません。

[LiveSync E2E](../.github/workflows/e2e.yml)はdraftを含むPRでCLIとGUIを別ジョブ実行します。CLIはUbuntu 24.04、GUIはUbuntu 22.04 hosted VMです。通常のnamespace sandboxとauthenticated Xvfbを使い、sysctl・AppArmor・seccomp・setuid変更は行いません。前提検査が失敗した場合はジョブも失敗します。workflow権限は`contents: read`、checkoutは認証情報を残しません。

検証結果と対象headは[PR checks](https://github.com/hayatosc/livesync-workers/pull/1/checks)で確認してください。GUIの結果JSONは実アプリ／プラグイン版と実チャンク数を記録します。

失敗時も結果JSONをActions artifactに保存し、保持期間は14日です。GUIの失敗スクリーンショットも対象ですが、一時Vault／profile／資格情報は対象外です。既存v4 ActionsのNode 20非推奨警告（runnerはNode 24で実行）と、Ubuntu 22.04の2027年4月退役予定があるため、後継runnerは標準sandboxで実測して移行してください。release専用Publish workflowはPRで実行しません。

## 検証外

本番負荷・費用、本番R2障害／実ネットワーク断、CPU上限による実強制終了、巨大履歴の復元、実ユーザー移行、E2EE／圧縮した同期、OAuthブラウザからMcpAgentまでの完全E2Eは未検証です。MCP scope／Vault認可はSDKトランスポートと実Workersの統合で検証しています。詳細な容量制約は[運用文書](r2-operations.md)を参照してください。

バックグラウンドチェックポイントは途中更新／削除、カーソル再開、未完了ページのGC保護、保存失敗再試行、同時更新、head 429／外部head CAS、順序付きカタログ境界を検証します。実CLI／GUIの復元ケースも圧縮を完了してからDOキャッシュを消去します。性能試験は別途`npm run test:performance`で実行します。[測定条件と結果](performance.md)を参照してください。

## チェックポイント境界テストの期限

mainのActions 37404146196では、rolling snapshotのケースだけが5秒期限を約172ms超え、他214件は成功しました。同じ旧ケースはローカルで約3645msで完了し、実行中に自動索引alarmと手動alarmが混在していました。対象ケースは自動スケジューラを止めて手動進行に統一し、129文書で128行ページ境界を越える条件を維持します。途中更新・削除・競合・バイナリ・ローカル同期記録削除・復元後の変更フィード一致を省略していません。

対象ケースだけの期限を15秒とし、フェーズ到達は50回、完了drainは1000回の有限ループで検査します。suite全体の期限は引き上げません。変更後の初回ローカル測定は約790ms、対象ケースの独立3回再実行は864／804／906msで成功しました。これはローカル観測で、本番性能ではありません。新しい[本文／文書／件数上限](request-limits.md)の境界テストも実Workers／SQLite／R2で実行します。
