# livesync-workers（R2永続化フォーク）

Obsidian の Self-hosted LiveSync 互換 API と MCP サーバーを、Cloudflare Workers 上で提供します。
永続データの正本は R2 に置き、更新の調整は Vault ごとの SQLite-backed Durable Object（DO）が行います。
検索索引は R2 上の再生成可能なデータです。

## 文書

- [セットアップと設定](docs/setup.md)：必要な binding と secret、LiveSync の接続、複数 Vault、MCP、サインインの保護
- [Cloudflare CLI](docs/cloudflare-cli.md)：cf CLI での開発、デプロイ、ログ調査
- [保存、復元、移行](docs/r2-operations.md)：保存の確定点、障害時の再生、GC、旧 SQLite からの移行と切り戻し
- [Original files in R2](docs/file-mirror.md): automatic latest-file copies, progress, recovery, and limits
- [リクエスト上限](docs/request-limits.md)：同期リクエストの上限と、413 が返ったときの対処
- [テストと CI](docs/testing.md)：Workers 統合テスト、公式 CLI と実 Obsidian の E2E
- [独自 Worker への組み込み](docs/embedding.md)：独自の認証や Vault 管理を持つホストからの利用
- [更新手順](docs/upgrading.md)：このフォークの変更を保ったまま更新する方法
- [性能測定の記録](docs/benchmarks/)：ローカル環境での変更前後の比較

## 構成

| 構成要素 | 役割 |
| --- | --- |
| Worker | `/livesync` の互換 API、`/mcp`、OAuth、管理者向けの状態画面と接続設定 |
| `CONTENT_BUCKET` | 不変のリビジョン本文、チャンク、MCP 添付の原本、履歴と削除とチェックポイントを復元するためのコミット列と head |
| `VAULT_DB` | 原則として 1 Vault につき 1 つの SQLite DO。本文は R2 への参照だけを持ち、競合、勝者、変更 seq、同期と索引の進捗を管理する |
| `FTS_BUCKET` | 文書ごとの単語位置索引と、active および building の索引世代 |
| `OAUTH_KV` | OAuth のクライアントとトークン、サインイン失敗によるロック |
| `MCP_OBJECT` | MCP セッション |

コンテンツ用の D1、Queues、追加の KV はありません。
Workers AI と Vectorize は、任意のセマンティック検索を有効にする場合にだけ必要です。
既定の `SEMANTIC_SEARCH=off` では使いません。

## LiveSync との互換範囲

LiveSync のリビジョン、本文チャンク、バイナリチャンクを保存し、Vault 内の元のパスと添付リンクを維持します。
文書の CRUD、`_bulk_docs`、`_bulk_get`、`_revs_diff`、`_all_docs`、`_changes`、`_local` などを提供します。
ただし CouchDB のすべての機能を代替するものではありません。

通常の編集で古い基底 rev を指定すると 409 で拒否します。
`new_edits=false` で同じ rev を再送しても結果は変わりません（冪等）。
削除は `_deleted` と、LiveSync 独自の `deleted: true` の両方を扱います。

E2EE、パスの難読化、圧縮を使った内容を、サーバー側で復号したり展開したりする機能はありません。
Worker が生成する接続設定と E2E テストは、これらを無効にした構成です。

## 全文検索

検索対象は、復元できる `.md` ノートの本文、タイトル、見出し、パスです。
タイトルは最初の Markdown 見出しで、見出しがなければファイル名を使います。

索引とクエリの両方で、`Intl.Segmenter('ja', { granularity: 'word' })` による単語分割と、NFKC 正規化と小文字化を行います。
単語位置つきの転置索引を BM25 で順位付けし、重みはタイトル 3、見出し 2、パス 1.5、本文 1 です。

クエリの通常の語は AND で結合し、二重引用符で囲んだ部分は連続する単語のフレーズとして扱います。
区切り記号そのものの一致は要求しません。
結果には、原文の UTF-16 範囲に対応づけたハイライトがつきます。
Vault 単位と、`grepNotes` の `folder` によるフォルダ配下への絞り込みができます。
語形変化の吸収と任意の部分一致は保証しません。

索引は DO の alarm で非同期に更新します。
このため、更新の直後は新しい内容が検索結果に出ないことがあります。
古い本文ハッシュの候補と削除済みの候補は、検索時に除外します。

解析器の版（`ja-segmenter-nfkc-v1`）を索引のキーに含めています。
解析器や索引形式が変わると新しい世代を building として構築し、完成してから active を切り替えます。
構築中も旧 active 世代で検索できます。
初回の構築が終わるまでは、検索は building 状態を返します。

検索時に全ノートを GET することはありません。
ただし、多くのノートに現れる語の検索費用は、該当する文書数に比例します。
100 万 UTF-16 コード単位を超えるノートは索引に含めません。

画像、PDF、音声の原本は保存できますが、OCR、PDF のテキスト抽出、音声認識はありません。

## 現状と制約

実 Obsidian と公式 LiveSync プラグイン、および公式 LiveSync CLI での E2E は、CI で継続的に実行しています。
結果は [GitHub Actions](https://github.com/hayatosc/livesync-workers/actions) で確認できます。

2026 年 10 月 7 日に実 Cloudflare 環境へ初回 deploy し、公開 URL でヘルスチェック、認証、文書の作成・読取・削除、管理者ログインを確認しました。
実 Obsidian から 237 ノートの同期を確認し、本文の一致、チャンクの欠落がないこと、全文検索索引の完了を検証しました。
旧 SQLite 方式からの実 Vault の移行は未検証です。
1 Vault の管理メタデータは 1 つの SQLite DO に収まる必要があり、Workers の CPU、メモリ、リクエストの制約も残ります。
大きな Vault での検索の費用と速度、巨大な履歴の復元時間は測定していません。
既存の SQLite 方式からの移行は自動では行われないので、[明示的な移行手順](docs/r2-operations.md#既存sqliteデータの移行)に従ってください。
