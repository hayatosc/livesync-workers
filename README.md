# livesync-workers（R2永続化フォーク）

Obsidian Self-hosted LiveSync互換APIとMCPをCloudflare Workersで提供します。このフォークでは、永続コンテンツをR2、更新の調整と再構築可能な管理DBをVaultごとのSQLite-backed Durable Objectに分けます。

## 構成

- `CONTENT_BUCKET`：不変のリビジョン本文、バイナリ原本、履歴・削除・同期チェックポイントを復元するコミット列とhead。
- `VAULT_DB`：原則1Vault=1SQLite DO。本文の代わりにR2参照を保持し、リビジョン競合、勝者、変更フィード、同期進捗を調整します。
- `FTS_BUCKET`：再生成可能な検索索引。`Intl.Segmenter('ja', { granularity: 'word' })`で解析し、単語位置の転置索引とBM25で検索します。
- `OAUTH_KV`／`MCP_OBJECT`：既存OAuthとMCPセッションの互換性を維持します。コンテンツ保存のためのD1、追加KV、Queuesは使いません。
- ベクトル検索は任意です。既定の`SEMANTIC_SEARCH=off`ではAI／Vectorizeバインディングも不要です。既存の`searchNotes`は残し、無効時には`grepNotes`を案内します。

本文はDOの`revs.body`や`rev_body_chunks`に残しません。新方式の`revs.body`には`{"r2":"…"}`参照のみを保存します。LiveSyncで届く任意のJSONリビジョンとバイナリチャンクを元のまま永続化し、MCPアップロードではバイナリ原本も不変オブジェクトとして保存します。Vault内パスと添付リンクは書き換えません。

## 検証

```sh
npm ci
npm run build
npm run typecheck
npm test
```

`npm test`は既存Nodeテストに加えて、[Cloudflare公式Vitest Workers統合](https://developers.cloudflare.com/workers/testing/vitest-integration/)を実行します。`vitest.workers.config.ts`と`test/workers/wrangler.jsonc`のローカルWorkers／SQLite DO／R2バインディングを使用します。独自Miniflare起動や実Cloudflare資源の作成はしません。

`npm run test:workers`でWorkersテストだけを実行できます。専用テストの型検査は`tsconfig.workers.json`を使います。既存リポジトリにlintスクリプトはありません。変更の空白検査には`git diff --check`を使用します。

## Vaultと権限

既定Vaultの不変IDは`LIVESYNC_VAULT_ID=primary`です。`LIVESYNC_DATABASE`はLiveSync接続名です。不変IDを変更せずに表示名・接続名を変更できます。旧版の`${tenantId}:${databaseName}`というDO名は、明示的な移行の読み元として維持しています。新しいDO名はエンコードした所有範囲と不変IDから生成します。

複数Vaultには`VAULTS_JSON`で静的な管理情報を設定します。パス接頭辞を認可として扱いません。Basic資格情報は各リクエストで検証し、MCPは各ツール呼出しでスコープと現在の所有／読取権限を検証します。

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

`passwordSecret`は環境シークレットの名前で、設定JSONにパスワードを埋め込みません。Vault IDとusernameは設定内で一意にします。現在のWorkerのOAuthログインは既存の管理者認証のままで、principalは`admin`です。他のprincipalを利用するホストは既存OAuthライブラリの認証フックを実装します。今回、アカウント作成や実認証設定の変更は行っていません。

読取共有の`readers`に含まれるprincipalは、OAuthの書込スコープがあってもそのVaultの所有者でなければ更新できません。管理用DOは静的設定で足りるため追加していません。

## MCP

既存の一覧・読取・全文検索・追記・上書きツールに任意の`vaultId`を追加し、未指定では認可された既定Vaultを使用します。新たに`listVaults`、`listFiles`、`readAttachment`、`uploadAttachment`を提供します。

- `vault:read`：一覧・読取・検索・添付取得。
- `vault:append`：既存の追記操作。
- `vault:write`：ノート上書きと添付アップロード。

上書きは前回読取時の`contentHash`が必要です。添付はbase64で入出力し、デコード後の上限は10 MiBです。絶対パス、`..`、空セグメント、バックスラッシュ、制御文字を拒否し、予約パス制限を適用します。読取対象が完全に同期していない場合は更新を拒否します。OCR／音声認識は行いません。画像・PDF・音声の原本と、検索できるMarkdownを別に扱います。

## 全文検索

日本語・英語混在、幅・大小文字、結合文字、識別子、サロゲート文字をWorkersで検証します。NFKC＋小文字化をグラフェムごとに行い、解析語から元のUTF-16範囲へ対応付けて原文をハイライトします。通常の単語はAND、二重引用符で囲んだ語は連続単語位置によるフレーズです。区切り記号そのものの一致は要求しません。

タイトル3、見出し2、パス1.5、本文1の重みを付け、単語数によるBM25で順位付けします。`grepNotes.folder`はVault相対フォルダとその配下に絞り込みます。検索候補の本文ハッシュを現在のVaultと照合し、削除済み・古い版を除外します。

Segmenterは原形化や任意の部分一致を保証しません。日本語の活用形や語の一部分だけでは見つからない場合があります。Linderaも新しい2-gram索引も導入していません。旧2-gram実装はライブラリの旧ホスト互換性のために残っていますが、このWorkerはSegmenter索引を使用します。

解析バージョンは`ja-segmenter-nfkc-v1`で、索引キーに含めます。再構築中は以前のactive世代を検索し、全処理完了後にactiveを切り替えます。初回はbuildingを返します。旧R2索引はその場で破壊せず、旧版への切戻しに残します。Workersランタイムの語境界挙動が変わる更新ではテストを確認し、解析バージョンを上げて再構築してください。

## 整合性・復元・移行

[運用と復元手順](docs/r2-operations.md)を参照してください。既存SQLite Vaultは自動移行しません。既存データのあるDOを新方式で開くと、明示移行が必要な旨で失敗します。移行先IDの変更によって既存データが自動的にコピーされることもありません。

この変更はクラウド内の実装とローカル統合テストまでです。push、PR公開、merge、本番deploy、実資源作成、実ユーザーデータ移行は実施していません。

## 実Obsidian E2E

`npm run test:e2e:obsidian`は実Obsidianと公式LiveSyncプラグインを使う隔離ローカルE2Eです。インストール・前提検査・実行済み結果・sandboxによるブロッカーは[実Obsidian E2E記録](docs/obsidian-e2e-ja.md)を参照してください。API-onlyの前提検査を実Obsidianの合格として扱いません。
