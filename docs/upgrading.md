# 更新手順

このフォークは、upstream に対して R2 の正本、不変の Vault ID、Segmenter 索引を追加しています。
upstream の最新版をそのまま取り込むと、これらの構成が失われる可能性があります。
upstream の変更とこのフォークの差分を確認し、検証した commit を選んで更新してください。

## 更新の前に

1. 現在の Worker の commit と、`cloudflare.config.ts` の資源名、ID、変数、DO の export 宣言を記録する。旧 Wrangler 方式の migration 履歴は、削除済みの `wrangler.jsonc`（Git 履歴）で確認する。
2. コンテンツの正本、旧 DO、旧索引を保全し、[保存、復元、移行](r2-operations.md)で復元と切り戻しの条件を確認する。
3. 更新候補で、`pnpm install --frozen-lockfile`、build、型検査、全テスト、[CLI と GUI の E2E](testing.md) を実行する。
4. binding、secret、migration、解析器の版に変更がないかを確認する。既存の DO の migration は削除も並べ替えもしない。

SQLite 方式から R2 方式への切り替えは、通常の Worker の更新とは別の、明示的な移行です。
新しい ID を設定しただけでは、旧データはコピーされません。
R2 への参照を持つ DO を、旧 SQLite 方式の Worker で直接開くこともできません。

## 初回 exports デプロイ前の切り戻し準備

Wrangler の `migrations` から `worker.exports` に移行する最初のデプロイは、切り戻しの境界になります。
そのライフサイクル変更より前にデプロイされたバージョンへは、Cloudflare の rollback 機能で戻せません。
以降のデプロイで旧 `migrations` 配列に戻すこともできません。
[Cloudflare の制約](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/#constraints-and-limitations)を確認し、初回デプロイの前に、既知の正常な R2 方式のコードに現在の `worker.exports` を組み合わせた切り戻しビルドを用意してください。

```sh
# この PR の直前の R2 方式の実装。別の commit を使う場合も保存形式の互換性を確認する
pnpm run rollback:prepare 059f58d0525b61e3cda4ff545588ea7f0a5c1d13
# 表示された .local/rollback-... ディレクトリへ移動する
cd <表示されたディレクトリ>
pnpm install --frozen-lockfile
pnpm build
pnpm exec cf deploy --dry-run
```

`scripts/prepare-rollback.mjs` は指定 commit の追跡済みファイルを新しいディレクトリに展開し、
現在の cf 設定・依存ロック・ツール設定・AGENTS.md を重ねます。認証情報はコピーせず、デプロイもしません。
`ROLLBACK_BUILD.json` に元の commit と、重ねたファイルの SHA-256 を記録します（現在の未コミット変更も含みます）。
作成前に `cloudflare.config.ts` が対象環境の設定であることを確認してください。
dry run で `VaultDO` と `VaultMCP` の SQLite exports、Worker 名、Vault ID、KV と R2 の binding が現在の稼働環境と一致することを確認します。
動作と保存形式の互換性も検証してから、このビルドを保管してください。dry run は実際の rollback 成功やデータ互換性を保証しません。

切り戻す場合は、そのディレクトリから `pnpm exec cf deploy` で既知のコードを新しいバージョンとして再デプロイします。
旧バージョンを直接選ぶ rollback、旧 `wrangler.jsonc` の `migrations` による再デプロイ、DO namespace の削除・再作成は行いません。
この手順が戻すのはアプリケーションコードであり、Vault のデータは現在の R2 正本を使います。

## 反映

deploy は、検証した checkout から実行します。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm run deploy
```

`pnpm run deploy` は、コミットしていない変更があるとデプロイしません。
成功すると、デプロイした commit に `deploy/<UTC の日時>` タグを付けて push します。
切り戻すときは、直前の `deploy/*` タグの commit を checkout して、同じ手順で再デプロイします。
詳しくは [Cloudflare CLI](cloudflare-cli.md#デプロイと記録) を参照してください。

Cloudflare Workers Builds などの自動 deploy を使っている場合は、production branch への push が deploy を起こす設定かどうかを確認してください。
リポジトリのルートの `wrangler.jsonc` は削除したので、`wrangler deploy` を実行するビルド設定は失敗します。
自動 deploy を使う場合は、`pnpm run deploy` 相当の手順に切り替えてください。
このリポジトリの GitHub Actions は PR の検査と release 時の npm 公開だけで、Worker を本番に deploy する workflow はありません。
必要な secret は Cloudflare 側で設定し、Git には保存しません。

検索の解析器の版が変わるときは索引を再構築し、切り替えた後に検索を確認します。
旧索引は、切り戻すかどうかの判断が終わるまで残しておきます。
新しい Vault に書き込んだ後に切り戻す場合は、先に新しい更新を復元またはレプリケーションで引き継ぎ、差分を確認してください。

## 独自ホストの場合

[組み込みの契約](embedding.md)にある `VaultHost`、`VaultBindings`、MCP の操作を、更新候補と照合してください。
このリポジトリで検証しているのは workspace のソース版で、npm で公開されている既存の版とは差があります。
パッケージの version だけで、R2 方式に対応しているかを判断しないでください。
