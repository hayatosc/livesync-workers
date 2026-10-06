# livesync-workers（R2永続化フォーク）

Obsidian Self-hosted LiveSync互換APIとMCPをCloudflare Workersで提供します。永続データの正本はR2、更新の調整はVaultごとのSQLite-backed Durable Object、検索索引は再生成可能なR2データです。

## 導入と文書

- [セットアップ・設定・認可](docs/setup.md)：必須binding／secret、LiveSync接続、複数Vault、MCP。
- [保存・復元・移行](docs/r2-operations.md)：確定点、障害時の再生、GC、旧SQLiteからの移行と切戻し。
- [テストとCI](docs/testing.md)：公式Workers統合、実Obsidian／公式CLIのE2E、検証済み範囲。
- [Workerへの組込み](docs/embedding.md)：独自認証・Vault管理を持つホストでの利用。
- [更新手順](docs/upgrading.md)：このフォークの変更を保った更新。

## 構成と対応範囲

| 構成要素 | 役割 |
| --- | --- |
| Worker | `/livesync`互換API、`/mcp`、OAuth、管理者向け状態・接続設定画面 |
| `CONTENT_BUCKET` | 不変リビジョン本文、チャンク、MCP添付原本、履歴・削除・チェックポイントを復元するコミット列とhead |
| `VAULT_DB` | 原則1Vault＝1SQLite DO。本文はR2参照のみ。競合、勝者、変更seq、同期・索引進捗を管理 |
| `FTS_BUCKET` | 文書ごとの単語位置索引とactive／building世代 |
| `OAUTH_KV`／`MCP_OBJECT` | 既存OAuth情報とMCPセッション |

コンテンツ用D1・Queues・追加KVはありません。AI／Vectorizeは任意のセマンティック検索を有効にする場合だけ必要です。既定の`SEMANTIC_SEARCH=off`では利用しません。

LiveSyncのリビジョン、本文・バイナリチャンクを保存し、元のVault内パス・添付リンクを維持します。文書CRUD、`_bulk_docs`、`_bulk_get`、`_revs_diff`、`_all_docs`、`_changes`、`_local`等を提供しますが、CouchDB全機能の代替ではありません。通常編集は古い基底revを409で拒否し、`new_edits=false`の同一rev再送は冪等です。`_deleted`とLiveSyncの`deleted: true`を扱います。

## 全文検索

検索対象は復元できる`.md`の本文・最初のMarkdown見出し（なければファイル名）・見出し・パスです。`Intl.Segmenter('ja', { granularity: 'word' })`とNFKC＋小文字化を索引・クエリで共通に使用します。単語位置付き転置索引をBM25で順位付けし、重みはタイトル3、見出し2、パス1.5、本文1です。

通常語はAND、二重引用符内は連続単語のフレーズです。区切り記号そのものの一致は要求しません。原文のUTF-16範囲へ対応付けたハイライト、Vault／`grepNotes.folder`の配下絞込みを提供します。原形化・任意部分一致は保証しません。Linderaや新しい2-gram索引は導入していません。旧索引はライブラリの旧ホスト互換用として残りますが、このWorkerはSegmenter索引を使用します。

索引はDO alarmで非同期更新します。古い本文ハッシュと削除済み候補を除外するため、更新直後に新しい検索結果が出ないことがあります。解析版`ja-segmenter-nfkc-v1`をキーに含め、再構築完了後にactive世代を切り替えます。初回はbuilding状態です。現Workerでは100万UTF-16コード単位を超えるノートを索引から除外します。

画像・PDF・音声の原本保存はできますが、OCR・PDFテキスト抽出・音声認識はありません。検索できるMarkdownとは別に扱います。E2EE・パス難読化・圧縮した内容のサーバー復号／展開は実装していません。生成する接続設定とE2Eはこれらを無効にしています。

## 状態と制約

[PR #1](https://github.com/hayatosc/livesync-workers/pull/1)で開発中です。実Obsidian＋公式プラグイン7ケース、公式CLI7ケース、Node／公式Workersテスト215件が成功しています。詳細・対象commitは[検証記録](docs/testing.md)を参照してください。

実Cloudflare本番deploy・実Vault移行は未実施です。1Vaultの管理メタデータはSQLite DOに収まる必要があり、WorkersのCPU・メモリ・リクエスト制約も残ります。大Vaultの検索費用・速度と巨大履歴の復元は未ベンチマークです。既存SQLiteからの移行は自動ではありません。
