# テストと CI

## 単体テストと Workers 統合テスト

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

`pnpm test` は、次の 3 つを順に実行します。

- **ライブラリのテスト**：`packages/livesync-workers/test`。Node 上で実行する
- **Worker のテスト**：`worker/*.test.ts`。Node 上で実行する
- **Workers 統合テスト**：`test/workers`。`pnpm test:workers` で単独でも実行できる

Workers 統合テストは、[Cloudflare 公式の Vitest 統合](https://developers.cloudflare.com/workers/testing/vitest-integration/)を使います。
`vitest.workers.config.ts` から `test/workers/wrangler.jsonc` を読み、ローカルの workerd で本物の Workers、SQLite DO、R2 の binding を使います。
独自に Miniflare を起動することはしません。
`pnpm test:workers` は同時実行を 1 worker に制限し、各テストの timeout を 60 秒に設定します。
ローカル SQLite/R2 の競合による短い timeout を避けるためです。

統合テストが検証する主な内容は次のとおりです。

- 同期 API、リビジョンの競合、チャンクとバイナリ
- 保存の各境界での障害注入と再試行、R2 head の CAS
- DO の行やスキーマが消えた後の再生
- 削除、チェックポイント、GC、明示的な移行
- 管理 DB の圧縮、容量による拒否、ページ化した復元と保存失敗
- バックグラウンドのチェックポイント（途中での更新と削除、カーソルからの再開、未完了ページの GC 保護、head の 429 と外部からの CAS）
- Segmenter の解析、索引の更新と世代の切り替え、共有索引の木の分割と旧根の不変性
- 旧 BM25 との順位、スコア、フレーズ、原文ハイライトの一致
- 保守 alarm の交互実行と、欠けていたチャンクが届いた後の再開
- Vault をまたぐアクセスの拒否、MCP の scope、更新の競合
- [リクエスト上限](request-limits.md)の境界

これは CPU 制限による実際の強制終了や、本番 R2 の障害を再現したものではありません。

## 公式 LiveSync CLI の E2E

```sh
pnpm test:e2e:cli:prepare  # 任意：公式ソースの取得とビルドだけを行う
pnpm test:e2e:cli
```

公式 LiveSync 1.0.34（commit `27a2d9e8c9672fb8df522470712da3cc6e35af11`）を取得し、上流の lockfile で `npm ci` を実行して、公式 CLI の workspace をビルドします。
共有コアの版は 0.1.35 です。
同じ commit のクリーンな checkout がすでにあれば、`LIVESYNC_CLI_SOURCE=/absolute/path` で指定できます。
初回は GitHub と npm への接続が必要です。

実際の CLI がチャンク、rev、チェックポイントを生成し、Wrangler で起動したローカルの Worker と同期します。
結果は `.local/e2e/cli-evidence/result.json` に書き出します。
CLI の E2E は、Obsidian の API、ファイルイベント、プラグインの読み込みの検証を代替するものではありません。

## 実 Obsidian と公式プラグインの E2E

Linux x64、Node 24、標準の Electron sandbox を使える環境と、表示サーバーが必要です。

```sh
pnpm test:e2e:install
pnpm test:e2e:plugin
pnpm test:e2e:backend  # 任意：ローカルのバックエンドの前提を確認する

OBSIDIAN_BINARY="$PWD/.local/e2e/obsidian/squashfs-root/obsidian" \
OBSIDIAN_CLI="$PWD/.local/e2e/obsidian/squashfs-root/obsidian-cli" \
xvfb-run -a -s '-screen 0 1280x900x24 -nolisten tcp' pnpm test:e2e:obsidian
```

公式の Obsidian 1.13.7 と公式 LiveSync プラグイン 1.0.34 を使い、`test/e2e/plugin-lock.json` の SHA-256 で検証します。
インストーラは配布物を `.local` に取得して展開するだけで、sandbox helper の所有者や setuid、OS の設定は変更しません。
上の例はホストの Xvfb と xauth を使います。
既存の表示サーバーを使う場合は、`DISPLAY` と `XAUTHORITY` を設定して `pnpm test:e2e:obsidian` を直接実行できます。

ハーネスは標準の sandbox を維持したまま、隔離した user-data-dir、一時的な Vault、loopback だけで待ち受けるデバッグ接続を使います。
起動したアプリとプラグインの版を照合し、`actualObsidian: true` と 7 ケースすべての成功を要求します。
結果は `.local/e2e/evidence/result.json` に書き出します。
起動に失敗した環境の結果を、GUI の合格として扱うことはありません。

## E2E のケース

CLI と GUI は、それぞれ次の 7 ケースを検証します。

1. ノートと、複数チャンクに分かれる添付を作成し、別のクライアントでバイト単位で一致する
2. 2 つの Vault で、同じパスのファイルが分離される
3. 本文と添付を更新しても、元のリンクとバイト列が保たれる
4. バックエンドが止まっている間のローカルの更新が、再接続後に同期される
5. クライアントの再起動や別プロセスの間で、チェックポイントが保たれる
6. ノートと添付の削除が伝わる
7. DO の管理 DB を消して Worker を再起動した後、R2 から復元され、残っている添付の SHA-256 が一致し、削除したファイルが再び現れない

添付の fixture は、画像や PDF の拡張子をつけた任意のバイト列です。
画像の表示や PDF の解析は検査しません。

実行のたびに、ローカル用の Basic 認証のパスワード、内部 secret、R2 と DO の保存領域を生成し、終了時に profile、Vault、プロセス、資格情報を破棄します。
実際の Cloudflare の資源、実ユーザーの Vault、永続的な資格情報は使いません。

## GitHub Actions

[CI](../.github/workflows/ci.yml) は、build、型検査、全テスト、`.mjs` の構文、main との差分の空白を検査します。
lint と formatter は設定していないので、空白の検査をそれらの代わりとは扱いません。

[LiveSync E2E](../.github/workflows/e2e.yml) は、draft を含む PR で、CLI と GUI を別々のジョブとして実行します。
CLI は Ubuntu 24.04、GUI は Ubuntu 22.04 の hosted VM で動きます。
通常の namespace sandbox と、認証つきの Xvfb を使い、sysctl、AppArmor、seccomp、setuid は変更しません。
前提の確認に失敗した場合は、ジョブも失敗します。
workflow の権限は `contents: read` で、checkout は認証情報を残しません。

結果の JSON は、失敗したときも Actions の artifact として 14 日間保存します。
GUI のジョブでは、失敗時のスクリーンショットも保存します。
一時的な Vault、profile、資格情報は保存しません。
各実行の結果と対象の commit は [Actions の一覧](https://github.com/hayatosc/livesync-workers/actions)で確認できます。

Ubuntu 22.04 の runner は 2027 年 4 月に退役する予定なので、それまでに後継の runner でも標準の sandbox が動くことを確かめて移行する必要があります。
release 専用の Publish workflow は、PR では実行しません。

## 性能測定

性能測定は通常のテストに含めず、別に実行します。

```sh
pnpm test:performance
```

測定条件と結果は[性能測定の記録](benchmarks/)にあります。

## 検証していないこと

次の項目は検証していません。

- 本番の負荷と費用
- 本番 R2 の障害と、実際のネットワークの切断
- CPU 上限による実際の強制終了
- 巨大な履歴の復元
- 実ユーザーの Vault の移行
- E2EE や圧縮を使った同期
- OAuth のブラウザ操作から McpAgent までの通しの E2E

MCP の scope と Vault の認可は、SDK のトランスポートと実 Workers での統合テストで検証しています。
容量の制約は[保存、復元、移行](r2-operations.md#容量と性能の制約)を参照してください。
