# livesync-workers 完成前レビュー報告

## 対象と結論

実リモートは `https://github.com/hayatosc/livesync-workers.git`、作業ブランチは `work`。開始基底は `06258af99dc1048f830f2c8cc4502e323529f953`。最初の実装コミットは `428683709d11bea4def593dd0e21fc426f6da434`。着手時の既存変更はありません。AGENTS.mdのコミット文英語指定を確認し、関連するローカル `.agents/skills` はありませんでした。

R2保存・確定順序・復元は実装担当が再点検し、別の読み取り専用担当が認可・MCP・検索・セットアップを独立レビューしました。3件の導入回帰／新機能不足を修正しました。追加8件を含む全187件が成功しています。実ユーザーデータ移行、push、PR公開、merge、deploy、実Cloudflare資源作成／課金／認証変更は実行していません。

## 発見事項と最小修正

| 項目 | 分類・根拠 | 修正・検証 |
|---|---|---|
| 既存ノートが索引バージョン更新後の新世代から消える | 今回導入した世代切替の回帰。`hash`だけをNULLにし、`fts_hash`が一致するため新世代書込みを省略していた | `fts_hash`も消去。既存索引と旧versionを作りalarm経由で再構築し、変更していないノートが検索できることを確認 |
| VAULTS_JSONとSetup URI／画面のDB・資格情報が不一致 | 今回の複数Vault追加による回帰。レジストリではなく従来の既定値／LIVESYNC_PASSWORDを使用していた | 管理者が認可される既定Vaultを共通関数で選択し、databaseName・username・passwordSecretを統一。レジストリのみの設定をWorkersで検証 |
| MCP添付読取で10 MiB上限が守られない | 今回の添付機能不足。base64文字数だけ検査し、同期経由のファイルと偽のsizeを信用できた | 実際のbase64をデコードして上限・応答sizeを検証。LiveSyncで10 MiB超のチャンクを受け入れ、MCP内部読取では413になることを確認 |
| 本文なし祖先を後から受信しても本文が入らない | 基底に存在した問題。基底のリビジョン既存判定がbody_available=0の行も省略。最初の実装で修正済み | プロトコル回帰テストで祖先本文を後から取得可能なことを確認。今回の3件とは区別 |
| OAuthのprincipalがadminに限られる | 既存認証方式の制約。権限漏れではない | 維持しREADMEに記載済み。bob等のownerはBasic同期可能だが現在のWorker MCPログインでは到達できない。別principalにはホストの認証フックが必要 |

Vault越境の漏れは確認されませんでした。DO名／R2キーはtenantと不変vaultIdを含み、実ホストの資格情報確認・Vault選択・所有者／reader権限確認をリクエスト／ツール呼出ごとに実施しています。接頭辞だけを認可にはしていません。新しい認可テストでは実ホスト設定とMCP SDKを接続し、同一パスの2Vault分離、他所有者拒否、reader書込拒否、スコープ取消とreader取消の即時反映を確認しています。

## 当初のWorkers 16件と保存境界の対応

各行が1件です。複数のassertionを持つテストを別件として数えていません。注入障害は実R2へのputをラップして例外を発生させ、その他の保存は実バインディングを使用します。

| # | ファイル・ケース | 境界／検証内容 | 当初の限界 |
|---:|---|---|---|
| 1 | persistence: 本文・履歴等復元 | 応答済みR2 headから、本文・添付チャンク・履歴・墓標・同期checkpointを再生。DO本文不保持 | テーブル行消去であり全スキーマ再作成ではない |
| 2 | persistence: 並行更新と所有者 | 同じ基底revから1成功／1競合、Basic所有者分離、内部secret拒否 | 静的テストホスト |
| 3 | persistence: GC候補 | 到達不能本文のみ候補、確定本文保持、越境参照拒否 | dry runのみ |
| 4 | persistence: objects/障害 | 不変本文put前に失敗→旧head維持→同rev再送 | 実CPU強制終了ではない |
| 5 | persistence: commits/障害 | 本文後、確定用コミットput前に失敗→同rev再送 | 同上 |
| 6 | persistence: head.json障害 | コミット後、head更新前に失敗→旧head維持 | 同上 |
| 7 | persistence: head-after障害 | head更新成功後の例外→復元して確定版保持、再送で変更feed重複なし | HTTP応答喪失の模擬 |
| 8 | persistence: CAS race | 独立writer2つのhead条件更新、1つだけ確定、stale writer拒否 | 本番分散ネットワークではない |
| 9 | search: Segmenter解析 | 日英・識別子・NFKC・結合文字・UTF-16原文対応 | 固定入力、任意部分一致／原形化なし |
| 10 | search: AND／phrase／重み | 単語位置フレーズ、BM25順位、原文ハイライト、別Vaultと表示名変更 | 大Vault速度／費用は対象外 |
| 11 | search: 世代切替 | active維持→building公開、旧候補消滅、削除 | DOの旧version経路を欠いていた |
| 12 | search: 復元と古い候補 | DO復元後再構築、削除済み候補排除、フォルダ絞込 | 行消去のみ |
| 13 | mcp: SDK往復 | scope、Vault指定、添付往復、更新競合、予約パス、base64 | Vault選択を独自callbackで代替していた |
| 14 | migration: 明示移行 | 旧SQLite源→別R2 ID→DO復元、元源不変更 | 実ユーザーデータは使わない |
| 15 | protocol: 同期回帰 | filtered changes、競合葉、祖先、bulk API、open_revs、compact履歴 | 実Obsidian E2Eではない |
| 16 | attachments: バイナリ | 多チャンク、生バイナリ原本、GC保持、10 MiB upload／パス拒否 | read側上限の抜けがあった |

## 追加したWorkers 8件

| # | ケース | 補った重要な境界 |
|---:|---|---|
| 17 | SQL changes挿入失敗 | 本文保存後・確定head前のSQL失敗を注入。未確定版は非可視、同rev再送で1feed。全スキーマ再作成後も一致 |
| 18 | SQL r2_applied_head更新失敗 | head確定後・SQLite適用マーカー前に例外。500でも確定版は可視、同rev再送で重複なし。全スキーマ再作成後も一致 |
| 19 | 全スキーマ消失と履歴／checkpoint | コンテンツ・索引・schema migration全テーブルをDROPし新インスタンスを構築。競合／削除葉／原rev本文／完全feed／checkpoint更新・削除を再確認 |
| 20 | DB削除と再作成 | purge後復元してDB不存在を維持、再作成後に古い本文・checkpoint・feedが復活しない |
| 21 | 索引version更新 | 既存fts_hashを持つ未変更ノートが新世代へ再投入される |
| 22 | 同期経由の読取上限 | 10 MiB超の添付と偽sizeをLiveSync投入。readAttachmentが実デコードサイズで413 |
| 23 | 実Vaultホスト認可＋MCP | レジストリ資格情報、DB越境、同一path分離、reader書込、scope取消、reader取消、設定画面の正しいsecretを検証 |
| 24 | GC実行／確定manifest欠損 | 実削除でorphanだけ除去。確定manifestを故意に消すとhistoryとGCが例外で停止し、他orphanを削除しない |

## 確定順序と復元の評価

不変本文→SQLite管理更新→不変コミット→条件付きR2 head→SQLite適用マーカー→応答／変更通知、の順序を確認しました。R2とSQLiteを横断する原子性を仮定せず、失敗時に確定headを読み直して管理状態を再生します。確定前の失敗では旧状態へ戻り、head確定後の応答喪失では確定版を保持します。同revのnew_edits=false再送は冪等です。通常PUTの基底rev／MCPの本文hashが古い再送は競合として返し、無条件二重追記はしません。

本文とローカルcheckpointはSQLiteにR2参照だけを残し、復元に必要な管理操作・版・削除・変更feedもコミットに保存します。検索は再生成可能な派生物です。全履歴を保持しているためcompact／GCは確定履歴を捨てません。移行・切戻し手順はdocs/r2-operations.mdにあり、実データでは未実行です。

## 実行結果と残る限界

`npm run build`、`npm run typecheck`、`npm test`、`node --check scripts/setup.mjs`、`git diff --check`成功。型検査はライブラリ・Worker・Workersテストを含みます。lintスクリプト／設定はありません。テスト内訳はライブラリNode156、Worker Node7、公式Workers24、合計187です。既存と追加を一括で実行しました。公式@cloudflare/vitest-pool-workers 0.22.0／Vitest4.1.5を使い、独自Miniflare起動やsetup-node追加はありません。

実Obsidian E2E、実OAuthブラウザ／McpAgentセッションの端から端の接続、CPU制限による本番強制終了、本番R2障害／ネットワーク断、本番負荷は未検証です。検索はR2文書数に比例する読取、復元は全履歴再生のメモリ／時間が必要で、ページ付き復元checkpointは未実装です。Segmenterは原形化／任意部分一致を保証しません。大Vaultの速度・費用は本番導入前の評価が必要です。今回のローカル改修・テストの完了を、本番運用適合性の証明とはしていません。

MCP SDKの欠落sourcemap、プロキシ検出、公式OAuthライブラリのCIMD無効通知が出ます。CIMD通知はstatusPageが既存OAuthのexportを読み込む経路で出るもので、認証設定を変更せず全テストが成功しました。

実行証跡は `.local/review-evidence/`。Libraryへ保存するのは4286837からの小さなレビュー修正差分と本報告です。全実装は開始基底からの差分、Git bundle、ソースアーカイブでも保存します。

## 開始基底からの変更ファイル（37件）

- `README.md`
- `docs/embedding.md`
- `docs/r2-operations.md`
- `docs/review-report-ja.md`
- `docs/upgrading.md`
- `docs/validation.md`
- `package-lock.json`
- `package.json`
- `packages/livesync-workers/src/durable/livesync-db.ts`
- `packages/livesync-workers/src/index.ts`
- `packages/livesync-workers/src/mcp/index.ts`
- `packages/livesync-workers/src/search/fts-index.ts`
- `packages/livesync-workers/src/search/segmenter-index.ts`
- `packages/livesync-workers/src/search/vector-index.ts`
- `packages/livesync-workers/src/storage/r2-journal.ts`
- `packages/livesync-workers/src/types.ts`
- `packages/livesync-workers/src/vault/client.ts`
- `scripts/setup.mjs`
- `test/workers/attachments.test.ts`
- `test/workers/entry.ts`
- `test/workers/host-authorization.test.ts`
- `test/workers/mcp.test.ts`
- `test/workers/migration.test.ts`
- `test/workers/persistence.test.ts`
- `test/workers/protocol.test.ts`
- `test/workers/recovery-boundaries.test.ts`
- `test/workers/search.test.ts`
- `test/workers/wrangler.jsonc`
- `tsconfig.workers.json`
- `vitest.workers.config.ts`
- `worker/env.ts`
- `worker/host.test.ts`
- `worker/host.ts`
- `worker/index.ts`
- `worker/mcp.ts`
- `worker/pages.ts`
- `wrangler.jsonc`

## Library保存の結果

現在のLibraryスキルから取得した公式prepared-upload helperへ、レビュー修正差分と本報告の2ファイルを渡しました。最初のhosted apps `tools/list`がHTTP 401となり、prepare／転送／finalizeには到達していません。LibraryファイルIDは取得できず、保存成功とは報告しません。スキルの「Never switch a started helper write to a direct action.」に従い、別経路への切替はしていません。Library認証が利用できるセッションでの保存が残るブロッカーです。ローカル成果物は保持しています。
