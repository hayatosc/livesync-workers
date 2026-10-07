# セットアップと設定

この Worker を新しく導入する手順と、設定項目を説明します。
既存の SQLite 方式の Vault がある場合は、先に[移行手順](r2-operations.md#既存sqliteデータの移行)を確認してください。

## 新規導入

Node.js 24、pnpm 12、Cloudflare アカウント、cf CLI の認証が必要です。
CLI の使い方とログ調査は [Cloudflare CLI](cloudflare-cli.md) を参照してください。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

ここまではローカルで完結します。
ローカルでテストするだけなら、続きは[テスト手順](testing.md)を参照してください。

以下のコマンドは、Cloudflare の実際の資源を作成して使います。

この checkout の `cloudflare.config.ts` は既存の稼働環境を参照しています。
別のアカウントへ新規導入する場合は、`pnpm exec cf auth login` で認証し、`accountId` と Worker・バケットの名前を変更して、
`pnpm exec cf kv namespaces create --title livesync-oauth` で作った namespace の ID を
`OAUTH_KV` に設定してください。既存環境を更新する場合は、これらの ID を維持します。
Worker 名を変更するときは、DO binding の `worker` も同じ名前に揃えてください。

既存の Wrangler 環境から初めて `worker.exports` に移行する場合は、デプロイ前に[切り戻し用ビルドを準備](upgrading.md#初回-exports-デプロイ前の切り戻し準備)してください。

```sh
pnpm exec cf auth login
pnpm run setup
# .dev.vars.example を参考に .dev.vars に必要な secret を用意する
pnpm exec cf deploy --secrets-file .dev.vars
```

`pnpm deploy` と `pnpm setup` は pnpm 自体のコマンドなので、`pnpm run` をつけて実行します。

`pnpm run setup`（`scripts/setup.mjs`）は、`cloudflare.config.ts` に書かれた R2 バケットを作成します。
Vectorize の索引は、現在の設定では作成しません。
SQLite DO のクラスは、`worker.exports` の宣言で作成されます。
以降の更新には `pnpm run deploy` を使います。既存の secret は維持されます。

既存の環境を更新するときは、バケット名、binding の ID、DO の migration 履歴を書き換えずに維持してください。

## binding と secret

| 名前 | 種類 | 用途 |
| --- | --- | --- |
| `CONTENT_BUCKET` | R2 | コンテンツの正本。必須 |
| `FTS_BUCKET` | R2 | 検索索引。必須。正本とは別のバケットにする |
| `VAULT_DB` | DO | `VaultDO`。Vault ごとの SQLite DO |
| `MCP_OBJECT` | DO | `VaultMCP`。MCP セッション |
| `OAUTH_KV` | KV | OAuth の情報と、サインイン失敗によるロック |
| `AUTH_FAILURE_LIMITER` | Rate Limiting | サインイン失敗の回数。省略するとロックアウトは無効 |
| `SQLITE_MAX_BYTES`、`SQLITE_HEADROOM_BYTES` | 変数 | DO の容量による書き込み停止の設定。既定は 900MB と 100MB。詳細は[容量の制約](r2-operations.md#容量と性能の制約) |
| `LIVESYNC_PASSWORD` | secret | 既定 Vault の Basic 認証パスワード |
| `ADMIN_PASSWORD` | secret | 管理者ログインと OAuth の承認に使うパスワード |
| `SESSION_SECRET` | secret | 管理セッションの署名と、DO の内部 API の保護。32 文字以上のランダムな値を推奨 |

空の値や、`change-me` で始まる仮の値は、未設定として扱います。
ローカル開発では、`.dev.vars.example` を参考に `.dev.vars` を作成します。
資格情報は Git にコミットしないでください。

## LiveSync の接続（単一 Vault）

既定値は `LIVESYNC_VAULT_ID=primary`、`LIVESYNC_DATABASE=vault`、`LIVESYNC_USERNAME=obsidian` です。
プラグインには次のように設定します。

- **URI**：`https://<Worker のホスト>/livesync`
- **データベース名**：`vault`
- **ユーザー名**：`obsidian`
- **パスワード**：`LIVESYNC_PASSWORD` に設定した値

Worker のトップページで管理者としてログインすると、状態の確認と Setup URI の生成ができます。
接続設定を返す API は管理者だけが使え、`Cache-Control: no-store` で返します。
Setup URI は接続設定を受け渡すために暗号化しますが、Vault のデータを E2EE にするものではありません。

生成する接続設定では、E2EE、パスの難読化、圧縮を無効にしています。
サーバーには復号や展開の処理がなく、ユーザーの復号鍵も管理しません。
そのため、暗号化したデータは全文検索も MCP からの読み書きもできません。
暗号化した同期そのものも、E2E テストの対象外です。

## 複数 Vault

Worker の変数 `VAULTS_JSON` を指定すると、既定の単一 Vault の設定の代わりに、この静的なレジストリを使います。

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

`passwordSecret` には secret の名前を書き、パスワード本体は JSON に入れません。
この例では `cloudflare.config.ts` の `worker.env` に `WORK_PASSWORD: bindings.secret()` を宣言し、
`.dev.vars` に用意した値を `pnpm exec cf deploy --secrets-file .dev.vars` で設定します。
`VAULTS_JSON` などの任意の変数も `worker.env` に宣言してください。
`vaultId` と `username` は、レジストリの中で一意にします。

`vaultId` と `tenantId` を変えなければ、表示名や接続 DB 名を変更しても、DO、R2、索引の ID は変わりません。

Basic 認証はリクエストごとに検証し、その資格情報に対応する DB だけを許可します。
MCP は、ツールを呼び出すたびに現在の owner、readers、scope を確認します。
readers に与えられるのは読み取りだけです。

`VAULT_EXCLUDED_FOLDERS` には、検索から除外するフォルダをカンマ区切りで指定します。
これは検索対象の設定であり、読み取りの認可には影響しません。

この Worker の OAuth で認証される principal は管理者 `admin` だけです。
別の owner の Vault は Basic 認証で同期できても、管理者として MCP からアクセスできるとは限りません。
一般ユーザーの登録や権限を管理する画面はありません。
独自の principal が必要な場合は、[ホストへの組み込み](embedding.md)で実装します。
Setup URI と状態画面は、admin がアクセスできる最初の Vault を使います。

## サインインの保護

`AUTH_FAILURE_LIMITER` を設定すると、LiveSync の Basic 認証と管理者ログインの失敗を、クライアントの IP ごとに数えます。
既定の設定では、1 分間に 10 回を超えて失敗した IP（11 回目の失敗）を 15 分間ロックします。
ロック中は、その IP からの試行を、パスワードが正しいかどうかに関係なく 429 で拒否します。
正しいパスワードだけを通すと、どの推測が当たったかが攻撃者に分かってしまうためです。

ロックは `OAUTH_KV` に保存するので、Worker のインスタンスをまたいで有効です。
同じ NAT の内側にいる利用者は同じ IP として数えられます。
保存したパスワードが古い LiveSync クライアントが失敗を繰り返すと、同じネットワークの正しいクライアントもロックされます。
回数と期間は、`cloudflare.config.ts` の `AUTH_FAILURE_LIMITER` と `worker/throttle.ts` で変更できます。

## MCP

接続先は `https://<Worker のホスト>/mcp` です。
OAuth の承認フローを使うか、`MCP_STATIC_TOKEN` を Bearer トークンとして使います。

OAuth の同意画面には、クライアント名に加えて、承認結果の送り先（redirect URI の origin）を表示します。
クライアントの登録は誰でもでき、名前も自由に付けられるので、承認する前に送り先が使っているアプリのものかを確認してください。

静的トークンは admin として動作し、既定の scope は `vault:read` だけです。
書き込みを許可するには、`MCP_STATIC_TOKEN_SCOPES=vault:append,vault:write` のように明示します。

| ツール | 必要な scope と制限 |
| --- | --- |
| `listVaults`、`listFiles`、`listDirectory`、`listNotes`、`listRecentNotes`、`readNote`、`readDailyNote`、`searchNotes`、`grepNotes`、`vaultStatus` | `vault:read` |
| `readAttachment` | `vault:read`。デコード後 10 MiB まで。base64、contentHash、size、contentType を返す |
| `appendToNote`、`appendToDailyNote` | `vault:append`。1 回 20,000 UTF-16 コード単位まで |
| `writeNote` | `vault:write`。200,000 UTF-16 コード単位まで。作成または上書き |
| `uploadAttachment` | `vault:write`。デコード後 10 MiB、base64 文字列で 14,000,000 文字まで |

各ツールで `vaultId` を省略すると、認可された既定の Vault を使います。

既存のノートや添付を上書きするときは、読み取ったときの `contentHash` を `expectedContentHash` として渡します。
ハッシュが一致しない場合と、チャンクが同期しきっていない場合は、更新を拒否します。
新規作成でも空の本文のハッシュを照合するので、同時に作成されたことを検出できます。
追記は、読み取った版のハッシュを照合して書き込み、別の書き込みと競合したときは読み直して最大 3 回まで試します。
MCP に削除と名前変更のツールはありません。

MCP の操作には重複排除の ID がなく、ちょうど 1 回だけ実行されることは保証しません。
応答を受け取れなかった追記を新しい操作として再実行すると、同じ内容が重複して追記されることがあります。
再実行する前に内容を読み直して、前の操作が成功していないかを確認してください。

MCP からの書き込みでは Vault 相対パスを検査し、先頭の `/`、`.` や `..`、空のセグメント、バックスラッシュ、制御文字を拒否します。
ライブラリの reservedPaths も適用しますが、この Worker の reservedPaths は空です。

10 MiB は MCP の添付の上限であり、LiveSync で同期するファイルの上限ではありません。
LiveSync の同期にも、Workers の実行とリクエストの制約は残ります。
同期リクエストの上限は[リクエスト上限](request-limits.md)を参照してください。

`searchNotes` は任意のベクトル検索です。
既定では無効で、呼び出すと `grepNotes` を使うよう案内を返します。
有効にするには `SEMANTIC_SEARCH=on` にして、`AI` と `VECTORIZE` の binding を追加します。
Vectorize の索引は、埋め込みモデル embeddinggemma-300m に合わせて 768 次元、cosine で作成します。
全文検索だけを使うなら、どちらも不要です。
