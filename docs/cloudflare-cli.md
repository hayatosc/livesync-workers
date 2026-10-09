# Cloudflare CLI

このプロジェクトは、開発、デプロイ、資源の準備、型の生成、永続化されたログの調査に `cf` を使います。
Node.js 24 以降が必要です。
固定している版は `cf@1.0.0-beta.12` と `wrangler@4.136.0` です。
Wrangler は `cf` が内部で呼び出すビルドの実装として残っているだけで、運用者が直接使う CLI ではありません。

デプロイの設定は `cloudflare.config.ts` です。
既存のアカウント、OAuth の KV namespace、R2 バケット、稼働中の SQLite DO クラスを参照しています。
任意の変数も `worker.env` に宣言してください。
`cf` は Wrangler の `keep_vars` に対応していません。
旧 `wrangler.jsonc` は、誤って `wrangler deploy` を実行して古い `migrations` の設定を再デプロイすることがないように削除しました。
Workers 統合テストは、専用の `test/workers/wrangler.jsonc` を使います。

最初の exports のデプロイの前に、[更新手順](upgrading.md#初回-exports-デプロイ前の切り戻し準備)に従って、exports に対応した切り戻し用のビルドを用意してください。
このライフサイクルの変更をまたいで、exports 以前の版へ Cloudflare の機能で切り戻すことはできません。
以降のデプロイでも exports を維持する必要があります。
Git 履歴から旧 `wrangler.jsonc` を戻して、切り戻し用の設定として使わないでください。

## コマンド

```sh
pnpm exec cf auth login
pnpm run setup --dry-run
pnpm run cf-typegen
pnpm typecheck
pnpm build
pnpm exec cf deploy --dry-run
pnpm run deploy
```

`cf` は独自の OAuth の認証情報を持ちます。
Wrangler にログインしても、`cf` の認証にはなりません。
setup の dry run は、作成予定の資源を表示するだけで、資源は作りません。
既存の secret は `bindings.secret()` で宣言しているので、アップロードし直す必要はありません。
初回のデプロイでは、`.dev.vars.example` をもとに `.dev.vars` を用意し、`pnpm run deploy -- --secrets-file .dev.vars` を実行します。

## デプロイと記録

`pnpm run deploy`（`scripts/deploy.mjs`）は、ライブラリをビルドしてから `cf deploy` で Worker をビルドしてデプロイします。
`--` の後の引数は、そのまま `cf deploy` に渡します。

コミットしていない変更があると、デプロイせずに終了します。
デプロイに成功すると、その commit に `deploy/<UTC の日時>`（例：`deploy/20261009-083005`）という注釈つきタグを作り、`origin` に push します。
これで、稼働中のコードがどの commit かを後から確認でき、同じ commit を再デプロイして切り戻せます。

```sh
git tag -l 'deploy/*' --sort=-creatordate | head   # 最近のデプロイ
git show deploy/20261009-083005                    # そのとき何をデプロイしたか
```

`--dry-run` ではタグを作りません。
`--allow-dirty` をつけると未コミットの変更もデプロイしますが、コードと一致する commit がないのでタグは作りません。
タグの push に失敗した場合は、表示されるコマンドで後から push してください。

## 永続化されたログ

現在の API は、`cf cli search` とコマンドのヘルプで調べます。

```sh
pnpm exec cf cli search "query workers observability telemetry logs"
pnpm exec cf observability telemetry query --help
```

10 月 7 日の調査では、次のようなクエリの JSON をローカルに作りました。

```json
{
  "queryId": "sync-performance-investigation",
  "timeframe": { "from": 1791345780000, "to": 1791346980000 },
  "dry": true,
  "view": "events",
  "limit": 1000,
  "parameters": {
    "filters": [{
      "key": "$workers.scriptName",
      "operation": "eq",
      "type": "string",
      "value": "livesync-workers"
    }],
    "filterCombination": "and",
    "limit": 1000
  }
}
```

```sh
pnpm exec cf observability telemetry query --body @query.json
pnpm exec cf r2 buckets metrics list
pnpm exec cf workers versions get latest --worker-id livesync-workers
```

調査ごとに、ミリ秒のタイムスタンプを調整してください。
分析では、メソッド、パス、ステータス、CPU 時間、wall time、実行モデル、trace ID に絞ります。
ステートレスな Worker のリクエストと DO のイベントは、trace ID で対応づけます。
両者の wall time は足し合わせません。
DO のイベントは HTTP の応答より長く続くことがあるので、応答の遅延はステートレスなリクエストの値で測ります。

デプロイの後は、ステートレスな Worker と VaultDO の両方のイベントで `$workers.scriptVersion.id` を確認してください。
ロールアウト中は、新しい Worker が古い DO を呼ぶことがあります。
アップロードの成功や 100% のデプロイ記録だけでは、性能の測定が新しい Vault の実装を通ったことの証明になりません。
[コード更新の伝播](https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates)を参照してください。

Vault は、集計したログ `LiveSync filtered changes`、`LiveSync bulk preparation`、`LiveSync maintenance timings` を出力します。
これらは、セレクタの走査と本文へのフォールバックの回数、一括処理の準備時間、索引の準備と公開の時間を分けて記録し、ノートの内容や認証情報は含みません。

広いイベントのクエリは、情報レベルのログで 1,000 件の上限が埋まることがあります。
失敗が診断用の標本から黙って漏れないように、スクリプトのフィルタに `$metadata.level` の一致条件（`warn` または `error`）を加えて、警告とエラーを別に問い合わせてください。
保守のログには、呼び出し回数の上限による失敗の後に小さくなる `publicationBatchSize` も含まれます。

参考：[移行](https://developers.cloudflare.com/cf/wrangler/migrate/)、[認証](https://developers.cloudflare.com/cf/get-started/)、[時間の指標](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)
