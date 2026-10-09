# 残課題

期限や前提のある作業を記録します。
このリポジトリでは GitHub の Issues を無効にしているので、ここで管理します。
終わった項目は、関連する文書に結果を反映してから削除してください。

## E2E の GUI ジョブを Ubuntu 22.04 から移行する

期限の目安：2027 年 2 月（runner の退役は 2027 年 4 月の予定）

`.github/workflows/e2e.yml` の `obsidian` ジョブ（実 Obsidian と公式 LiveSync プラグイン）は `ubuntu-22.04` で動いています。
このジョブは、sysctl、AppArmor、seccomp、setuid を変更せずに、Electron の標準の namespace sandbox が動くことを前提にしています。
後継の runner では、unprivileged user namespace の制限で sandbox が起動しない可能性があります。

- [ ] `ubuntu-24.04`（またはその時点の後継）で、前提の確認と GUI の 7 ケースが通るか試す
- [ ] 通らない場合は、OS の設定を変えずに済む代替（別の hosted image、コンテナなど）を検討する
- [ ] `e2e.yml` の runner と、[テストと CI](testing.md) の該当箇所を更新する

## 旧 SQLite 方式からの移行を実 Vault で検証する

実 Vault での、旧 SQLite 方式から R2 方式への移行は検証していません。
移行は自動では行われず、[明示的な移行手順](r2-operations.md#既存sqliteデータの移行)に従う必要があります。
統合テスト（`test/workers/migration.test.ts`）では検証していますが、実データの規模と内容では試していません。

- [ ] 本番の Vault のコピー、または同等の規模の検証用 Vault を用意する
- [ ] 手順どおりに移行し、ノート数、本文とチャンクの一致、添付の SHA-256、削除したファイルが再び現れないことを確認する
- [ ] 移行にかかった時間、R2 の操作数、DO の SQLite のサイズを記録する
- [ ] [切り戻し手順](upgrading.md)も一度通す
- [ ] 結果を README と[テストと CI](testing.md) に反映する

## LiveSyncVaultDO のクラス本体を責務ごとに分ける

`packages/livesync-workers/src/durable/livesync-db.ts` から、トップレベルの補助関数（`rows.ts`、`settings.ts`、`revisions.ts`、`selector.ts`、`notes.ts`、`params.ts`）と、組み込みの全文検索索引（`full-text.ts`）を切り出しました。
クラス本体には、まだ次の責務が同居しています。

- R2 ジャーナルの復元とバックグラウンドのチェックポイント
- CouchDB 互換 API（`_bulk_docs`、`_changes`、`_all_docs`、`_local` など）
- リビジョン木の操作と勝者の再計算
- ベクトル索引と外部全文検索への公開
- ファイルミラーの起動と内部操作
- `init()` のスキーマ作成とマイグレーション

`full-text.ts` と同じく、DO への依存を小さなインターフェースにまとめてから移します。
`sqlExec` は必ず DO の journaled SQL を通し、書き込みが R2 のコミット列に届くようにします。
1 回の変更で 1 つの責務を移し、Workers 統合テストと E2E で確認します。
