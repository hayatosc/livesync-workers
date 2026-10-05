# クラウド内改修の検証記録

- 元リポジトリ：`https://github.com/hayatosc/livesync-workers.git`
- 作業ブランチ：`work`
- 開始HEAD：`06258af`（`origin/main`と同一）
- 着手時：既存変更なし。`AGENTS.md`はコミット／リリース文を英語にする指示。関連`.agents/skills`なし。
- 実行環境：クラウド内ローカルNodeと、Cloudflare公式Vitest Workers統合のworkerd。
- 統合：`@cloudflare/vitest-pool-workers=0.22.0`、既存Vitest 4.1.5。

## 実行結果

`npm run build`、`npm run typecheck`、`npm test`、`node --check scripts/setup.mjs`、`git diff --check`が成功しました。型検査はライブラリ、Worker、公式Workers統合テストを含みます。既存lint設定／スクリプトはありません。

| テスト | 件数 |
|---|---:|
| 既存ライブラリNode回帰 | 156 |
| Worker Node（既存5件＋所有／読取共有認可2件） | 7 |
| Cloudflare Workers／SQLite DO／R2統合（当初16＋レビュー追加8＋実runtime識別1） | 25 |
| 合計 | 188 |

Workers統合の対象：

- 本文・バイナリチャンク・リビジョン履歴・削除・ローカル同期チェックポイントのR2復元。
- SQLite管理DBを消し、インスタンスを存続させた状態からの再生。DOに本文／本文チャンクを残さないこと。
- リビジョン競合・並行更新・所有者/Vault越境・内部APIの認可。
- 本文put、コミットput、head put、head成功後の応答喪失に対する注入障害と冪等再試行。
- stale writerとR2 head CAS競合、未確定オブジェクトのGC候補と確定版／バイナリ原本の保護。
- 日本語・英語混在・識別子・幅・結合文字・サロゲート文字の解析、単語位置フレーズ、原文ハイライト、BM25のフィールド重み。
- 索引世代の切替、削除反映、フォルダ絞込み、管理DB復元後の索引再構築、更新前索引の古い候補の排除。
- 実MCP SDKトランスポートでのスコープ、Vault指定、添付往復、更新競合、予約パス・パストラバーサル。
- 大きなバイナリの複数チャンク往復、R2生バイナリ原本、10 MiB超過・不正base64・制御文字の拒否。
- 凍結した旧SQLite源から新R2 Vaultへの明示移行と、未変更の切戻し元。
- `_changes`フィルタ完了、競合葉、`_revs_diff`、`_bulk_get`、`open_revs`、履歴を保持するcompact。
- 後から受信した本文なし祖先の本文を確定・取得できること。

## 未検証・残る運用制約

実ObsidianクライアントとのE2E同期、本番CPU強制終了、本番R2障害／ネットワーク断、本番負荷、大Vaultでの速度・費用は未検証です。検索のR2読取数は文書数に比例し、コミット全再生と移行は履歴量に比例します。ページ付き復元チェックポイントは未実装です。詳細は[運用・復元](r2-operations.md)を参照してください。

テスト時にはMCP SDKの欠落sourcemapとプロキシ検出の警告が出ますが、テストは成功しています。Cloudflareログの出力先を`WRANGLER_LOG_PATH=/tmp/livesync-wrangler.log`にして、環境のホームディレクトリ制約を回避しました。

push、PR公開、merge、本番deploy、実Cloudflare資源作成、課金操作、実認証変更、実ユーザーデータ移行は行っていません。

実行ログとコードの復元用アーカイブはリポジトリの`.local/evidence/`に保存します。Gitのローカルコミットとbundle／差分からも復元可能です。

## 完成前レビュー

独立レビューと追加検証は[日本語レビュー報告](review-report-ja.md)を参照してください。索引バージョン更新、複数VaultのSetup URI、添付読取サイズ制限の3件を修正し、SQL障害境界と全スキーマ消失を含む8件のWorkersテストを追加しました。

実Obsidian 1.13.7をこのクラウドへ配置し、実行用ハーネスを追加しました。GUI起動はElectronの標準sandbox要件で停止し、実同期7段階は未実行です。[実Obsidian記録](obsidian-e2e-ja.md)を参照してください。別枠のWranglerローカルサービス検査は成功しています。
