# 更新手順

このフォークは、upstream に対して R2 の正本、不変の Vault ID、Segmenter 索引を追加しています。
upstream の最新版をそのまま取り込むと、これらの構成が失われる可能性があります。
upstream の変更とこのフォークの差分を確認し、検証した commit を選んで更新してください。

## 更新の前に

1. 現在の Worker の commit と、`wrangler.jsonc` の資源名、ID、変数、DO の migration 履歴を記録する。
2. コンテンツの正本、旧 DO、旧索引を保全し、[保存、復元、移行](r2-operations.md)で復元と切り戻しの条件を確認する。
3. 更新候補で、`pnpm install --frozen-lockfile`、build、型検査、全テスト、[CLI と GUI の E2E](testing.md) を実行する。
4. binding、secret、migration、解析器の版に変更がないかを確認する。既存の DO の migration は削除も並べ替えもしない。

SQLite 方式から R2 方式への切り替えは、通常の Worker の更新とは別の、明示的な移行です。
新しい ID を設定しただけでは、旧データはコピーされません。
R2 への参照を持つ DO を、旧 SQLite 方式の Worker で直接開くこともできません。

## 反映

deploy は、検証した checkout から実行します。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm run deploy
```

Cloudflare Workers Builds などの自動 deploy を使っている場合は、production branch への push が deploy を起こす設定かどうかを確認してください。
このリポジトリの GitHub Actions は PR の検査と release 時の npm 公開だけで、Worker を本番に deploy する workflow はありません。
必要な secret は Cloudflare 側で設定し、Git には保存しません。

検索の解析器の版が変わるときは索引を再構築し、切り替えた後に検索を確認します。
旧索引は、切り戻すかどうかの判断が終わるまで残しておきます。
新しい Vault に書き込んだ後に切り戻す場合は、先に新しい更新を復元またはレプリケーションで引き継ぎ、差分を確認してください。

## 独自ホストの場合

[組み込みの契約](embedding.md)にある `VaultHost`、`VaultBindings`、MCP の操作を、更新候補と照合してください。
このリポジトリで検証しているのは workspace のソース版で、npm で公開されている既存の版とは差があります。
パッケージの version だけで、R2 方式に対応しているかを判断しないでください。
