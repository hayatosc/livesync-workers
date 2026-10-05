# セットアップ・設定・認可

このフォークのWorkerを新規に導入するための手順です。既存SQLite Vaultがある場合は、先に[移行手順](r2-operations.md)を確認してください。以下の本番用コマンドはCloudflareの実資源を作成・使用します。ローカルテストだけなら[テスト手順](testing.md)を使用し、setup／deployは実行しません。

## 新規導入

Node.js 24、npm、CloudflareアカウントとWranglerの認証が必要です。

```sh
npm ci
npm run build
npm run typecheck
npm test

# 本番資源を作成する場合だけ実行
npx wrangler login
npm run setup
npx wrangler secret put LIVESYNC_PASSWORD
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npm run deploy
```

`scripts/setup.mjs`は`wrangler.jsonc`のR2 bucketを作成します。現設定ではVectorizeを作成しません。OAuth KVは初回deploy時の自動provisioningを利用する設定です。SQLite DOクラスの作成はWranglerの`migrations`にあります。既存環境のbucket名・binding ID・DO migration履歴は上書きせず維持してください。

| binding／secret | 用途 |
| --- | --- |
| `CONTENT_BUCKET` | コンテンツ正本のR2。必須 |
| `FTS_BUCKET` | 検索用R2。必須。正本と分離 |
| `VAULT_DB`／`MCP_OBJECT` | `VaultDO`／`VaultMCP`のSQLite DO |
| `OAUTH_KV` | OAuth情報 |
| `LIVESYNC_PASSWORD` | 既定VaultのBasic認証パスワード |
| `ADMIN_PASSWORD` | 管理者ログイン・OAuth承認用 |
| `SESSION_SECRET` | 管理セッション署名・DO内部API用。32文字以上のランダム値を推奨 |

空・`change-me`系の仮シークレットは拒否します。ローカル開発では`.dev.vars.example`を参考に`.dev.vars`へ値を設定します。資格情報をGitへコミットしないでください。

## 単一VaultのLiveSync接続

既定は`LIVESYNC_VAULT_ID=primary`、`LIVESYNC_DATABASE=vault`、`LIVESYNC_USERNAME=obsidian`です。プラグインのCouchDB URIを`https://<Workerのホスト>/livesync`、DB名を`vault`、ユーザーを`obsidian`、パスワードを設定済みsecretにします。

Workerのトップページで管理者ログインすると状態とSetup URIを生成できます。接続設定の取得は管理者のみ・`Cache-Control: no-store`です。URIは接続設定を受け渡すために暗号化しますが、VaultデータのE2EEを有効にするものではありません。

生成設定と検証済み構成はE2EE・パス難読化・圧縮を無効にしています。サーバーに復号・展開処理やユーザーの復号鍵管理はありません。暗号化データの全文検索・MCP読取／編集は対応済みとして扱えません。暗号化同期自体も現在のGUI／CLI E2Eの検証対象外です。

## 複数Vault

`VAULTS_JSON`をWorker変数に指定すると、既定設定の代わりにこの静的レジストリを使います。

```json
[
  {
    "vaultId": "work-vault",
    "tenantId": "owner-a",
    "databaseName": "work",
    "displayName": "仕事",
    "ownerId": "admin",
    "readers": [],
    "username": "obsidian-work",
    "passwordSecret": "WORK_PASSWORD"
  }
]
```

`passwordSecret`はsecret名で、パスワード本文をJSONへ入れません。この例では`wrangler secret put WORK_PASSWORD`で設定します。各Vaultの`vaultId`と`username`はレジストリ内で一意にします。不変IDとtenantを保持すれば、表示名・接続DB名を変更してもDO／R2／索引のIDは変わりません。

Basic認証は各リクエストで検証し、その資格情報のDBだけを許可します。MCPは各ツール呼出しで現在のowner／readersとスコープを確認します。readersは読取共有のみです。`VAULT_EXCLUDED_FOLDERS`はカンマ区切りで検索から除外するフォルダを指定し、読取認可の代わりにはなりません。

現在のWorkerのOAuth principalは管理者`admin`です。別ownerはBasic同期できても、現在のMCP管理者ログインでそのVaultにアクセスできるとは限りません。一般ユーザーの登録・権限管理画面はありません。独自principalは[ホスト組込み](embedding.md)で実装します。Setup URI／管理状態画面はadminがアクセスできる最初のVaultを使用します。

## MCP

接続先は`https://<Workerのホスト>/mcp`です。既存OAuthの承認フローを使うか、任意の`MCP_STATIC_TOKEN`をBearer tokenにします。静的tokenはadminとして動作し、既定で`vault:read`のみです。追加権限は`MCP_STATIC_TOKEN_SCOPES=vault:append,vault:write`で明示します。

| 操作 | scope／制限 |
| --- | --- |
| `listVaults`、`listFiles`、`listDirectory`、`listNotes`、`listRecentNotes`、`readNote`、`readDailyNote`、`grepNotes`、`readAttachment`、`vaultStatus` | `vault:read` |
| `appendToNote`、`appendToDailyNote` | `vault:append`。1回20,000 UTF-16コード単位まで |
| `writeNote` | `vault:write`。200,000 UTF-16コード単位まで。作成または上書き |
| `uploadAttachment` | `vault:write`。デコード後10 MiB、base64文字列14,000,000文字まで |
| `readAttachment` | デコード後10 MiBまで。base64・contentHash・size・contentTypeを返す |

各ツールの`vaultId`を省略すると、認可された既定Vaultを使用します。既存ノート・添付の上書きには読取結果の`contentHash`を`expectedContentHash`として渡します。追記も内部で読取版のハッシュを確認します。競合や未同期チャンクがある場合は更新を拒否します。MCPに削除・名前変更ツールはありません。

MCPには操作IDによるexactly-once保証はありません。応答を失った追記を新操作として再実行すると重複し得るため、内容を再読取して結果を確認してください。上書き・添付の新規作成も空本文のハッシュを用いて同時作成を検出します。

MCP書込はVault相対パスを検査し、先頭`/`、`.`／`..`、空セグメント、バックスラッシュ、制御文字を拒否します。ライブラリのreservedPathsも適用します。現WorkerのreservedPathsは空です。添付10 MiBはMCPの上限であり、LiveSync同期の一般ファイル上限ではありません。LiveSync側にもWorkersの実行・リクエスト制約が残ります。

`searchNotes`は任意のベクトル検索用です。既定では無効で`grepNotes`を案内します。`SEMANTIC_SEARCH=on`にする場合のみ`AI`と`VECTORIZE`を追加し、現在のembeddinggemma-300mに合う768次元・cosineの索引を設定します。全文検索だけなら不要です。
