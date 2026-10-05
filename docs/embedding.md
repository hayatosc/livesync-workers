# 独自Workerへの組込み

独自ユーザー認証や動的Vaultレジストリを持つホスト向けです。以下はこのフォークのworkspaceソース版の契約で、既存公開npm版への対応を保証するものではありません。通常の導入は[セットアップ](setup.md)を使ってください。

## ホストとbinding

`VaultHost.verifyCredential`はBasic資格情報を認証し、所有範囲・不変ID・接続DB名を返します。`loadVaultPolicy`はそのVaultの存在／所有範囲を確認して、reservedPaths・excludedFolders・timeZone等を返します。DO alarmからも呼ばれるため、認証前の入力やキー接頭辞だけを信用しないでください。

```ts
import {
  LiveSyncVaultDO, SegmenterFullTextIndex, handleLiveSyncRequest,
  createVault, type VaultHost, type VaultBindings,
} from "livesync-workers";

// Env、lookupCredential、lookupPolicyは独自ホストで定義する。
function myHost(env: Env): VaultHost {
  return {
    async verifyCredential(username, password) {
      const row = await lookupCredential(env, username, password);
      return row ? {
        tenantId: row.ownerId,
        vaultId: row.immutableVaultId,
        databaseName: row.databaseName,
      } : null;
    },
    loadVaultPolicy: (ref) => lookupPolicy(env, ref),
    internalSecret: env.INTERNAL_SECRET,
    serverName: "my-service",
  };
}
function myBindings(env: Env): VaultBindings {
  return {
    vaultDb: env.VAULT_DB,
    contentBucket: env.CONTENT_BUCKET,
    bucket: env.FTS_BUCKET,
    fullText: new SegmenterFullTextIndex(env.FTS_BUCKET),
  };
}
export class VaultDO extends LiveSyncVaultDO<Env> {
  protected host() { return myHost(this.env); }
  protected bindings() { return myBindings(this.env); }
}
```

DOはSQLite-backed classとしてbinding／migrationを設定します。`vaultObjectName(ref)`は`vaultId`があればtenantと不変IDをエンコードした名前を生成します。IDなしの旧`${tenantId}:${databaseName}`形式は旧ホスト互換用です。新R2ホストには不変IDを設定してください。

実workerdではDO内の`ctx.id.name`が使えないことがあります。`handleLiveSyncRequest`と`createVault`は認証済みのVault参照と内部secretを転送します。DOはnamespaceの実ID一致とpolicyを検証して識別情報だけをKVへ保持します。直接内部APIを呼ぶホストもこの契約が必要です。識別できない場合にSQLite本文保存へfallbackさせないでください。

## APIとVaultクライアント

```ts
// Worker.fetch内。urlはrequestのURL。
if (url.pathname === "/livesync" || url.pathname.startsWith("/livesync/")) {
  return handleLiveSyncRequest(request, {
    host: myHost(env), bindings: myBindings(env),
  });
}

// refは認証済みprincipalに対して認可したVault参照。
const vault = createVault(myBindings(env), {
  ref,
  policy: await myHost(env).loadVaultPolicy(ref),
  internalSecret: env.INTERNAL_SECRET,
});
await vault.readNote("Projects/Plan.md");
await vault.grep("東京 API", 20, "Projects");
```

`unrestricted()`はreservedPathsのフィルタを外すホスト内部用です。ユーザー向けツールへ公開する場合の認可はホストの責任です。excludedFoldersは検索対象の設定で、読取権限ではありません。

## MCP・OAuth

`livesync-workers/mcp`の`registerVaultTools`へ、現在のスコープとprincipalがアクセスできるVaultを返すcallbackを渡します。書込scopeはreadersではなくownerとして検証してください。実装例は[worker/mcp.ts](../worker/mcp.ts)と[worker/host.ts](../worker/host.ts)です。

`livesync-workers/oauth`の`createVaultOAuthProvider`には独自セッションの`authenticate`、`loginRedirect`、提供scopeを設定します。既存Workerはadmin principalですが、ライブラリを組み込むホストは独自principalを実装できます。MCP依存は`@modelcontextprotocol/sdk`／`zod`、OAuth依存は`@cloudflare/workers-oauth-provider`です。

## 検索と旧ホスト互換

この例はR2のSegmenter索引を明示指定し、AI／Vectorizeを要求しません。任意のベクトル検索にはVectorize・embedderとVault隔離設定を追加します。独自`FullTextIndex`を渡す場合はVault隔離、本文ハッシュ照合、世代再構築の契約を維持してください。

`contentBucket`や不変IDを指定しない旧ホスト向けのSQLite保存・旧全文索引経路はライブラリに残っていますが、root WorkerのR2方式とは別です。旧データを新方式へ移すときは[明示移行](r2-operations.md)を使用します。旧索引の容量guardをSegmenter方式の保証値として流用しないでください。
