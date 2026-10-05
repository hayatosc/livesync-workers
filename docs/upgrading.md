# 更新手順

このフォークはR2正本・不変Vault ID・Segmenter索引を追加しています。upstreamの最新版をそのまま取り込むと、この構成を失う可能性があります。upstreamの変更とこのフォークの差分をレビューし、検証したcommitを選んで更新してください。現在のdraft PRを既存公開npm版と同一仕様とは扱いません。

## 更新前

1. 現Worker commit、`wrangler.jsonc`の資源名／ID／変数／DO migration履歴を記録する。
2. コンテンツ正本・旧DO・旧索引を保全し、復元と切戻し条件を[運用文書](r2-operations.md)で確認する。
3. `npm ci`、build、型検査、全テストと[CLI／GUI E2E](testing.md)を更新候補で実行する。
4. binding・secret・migration・解析版に変更がないか確認する。既存DO migrationを削除／並べ替えしない。

SQLiteからR2への切替は通常のWorker更新とは別の明示移行です。新IDの設定だけでは旧データをコピーしません。R2参照を持つDOを旧SQLite方式Workerで直接開くこともできません。

## 反映

deployを承認・計画した場合にのみ、検証したcheckoutから実行します。

```sh
npm ci
npm run build
npm run deploy
```

Cloudflare Workers Builds等の自動deployを利用している環境では、production branchへのpushがdeployを引き起こす設定かを確認してください。このリポジトリのGitHub ActionsはPR検査とrelease時のnpm公開であり、Workerの本番deploy workflowはありません。必要なsecretは環境側で設定し、Gitへ保存しません。

検索解析版が変わるときは索引を再構築し、切替後の検索を確認します。旧索引は切戻し判断が終わるまで保持します。新Vaultへの書込後のロールバックでは、新しい更新を引き継ぐ復元／レプリケーションと差分確認を先に行ってください。

## 独自ホスト

[組込み契約](embedding.md)の`VaultHost`・`VaultBindings`・MCP操作を更新候補と照合します。root workspaceで検証しているソース版と、既存公開npm版には差があります。パッケージversionだけでR2方式への対応を判断しないでください。
