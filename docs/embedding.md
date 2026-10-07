# 独自 Worker への組み込み

独自のユーザー認証や、動的な Vault のレジストリを持つホストから、ライブラリ `livesync-workers` を使う方法です。
ここで説明するのは、このリポジトリの workspace にあるソース版の契約です。
npm で公開されている既存の版が同じ契約に対応しているとは限りません。
通常の導入は[セットアップと設定](setup.md)を参照してください。

## ホストと binding

`VaultHost.verifyCredential` は Basic 認証の資格情報を検証し、所有範囲、不変 ID、接続 DB 名を返します。
試行を拒否したいとき（失敗が続いた IP をロックするときなど）は、`AuthThrottledError` を投げると 429 と `Retry-After` を返します。

`loadVaultPolicy` は、その Vault の存在と所有範囲を確認して、reservedPaths、excludedFolders、timeZone などを返します。
DO の alarm からも呼ばれるので、認証前の入力やキーの接頭辞だけを信用しないでください。

```ts
import {
  LiveSyncVaultDO, SegmenterFullTextIndex, handleLiveSyncRequest,
  createVault, type VaultHost, type VaultBindings,
} from "livesync-workers";

// Env、lookupCredential、lookupPolicy はホスト側で定義する。
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

DO は SQLite-backed のクラスとして binding と migration を設定します。
`vaultObjectName(ref)` は、`vaultId` があれば tenant と不変 ID をエンコードした名前を返します。
ID のない旧形式 `${tenantId}:${databaseName}` は、旧ホストとの互換のためだけに残しています。
R2 を使う新しいホストでは、必ず不変 ID を設定してください。

実際の workerd では、DO の中で `ctx.id.name` を使えないことがあります。
`handleLiveSyncRequest` と `createVault` は、認証済みの Vault 参照と内部 secret を DO に転送します。
DO は namespace の実際の ID との一致とポリシーを検証してから、識別情報だけを KV に保存します。
内部 API を直接呼ぶホストも、この契約に従う必要があります。
Vault を識別できない場合に、本文を SQLite に保存する経路へ fallback させないでください。

## API と Vault クライアント

```ts
// Worker の fetch の中。url は request の URL。
if (url.pathname === "/livesync" || url.pathname.startsWith("/livesync/")) {
  return handleLiveSyncRequest(request, {
    host: myHost(env), bindings: myBindings(env),
  });
}

// ref は、認証済みの principal に対して認可した Vault の参照。
const vault = createVault(myBindings(env), {
  ref,
  policy: await myHost(env).loadVaultPolicy(ref),
  internalSecret: env.INTERNAL_SECRET,
});
await vault.readNote("Projects/Plan.md");
await vault.grep("東京 API", 20, "Projects");
```

`unrestricted()` は reservedPaths のフィルタを外す、ホスト内部用の操作です。
これをユーザー向けのツールに公開する場合の認可は、ホストの責任です。
excludedFolders は検索対象の設定であり、読み取りの権限ではありません。

## MCP と OAuth

`livesync-workers/mcp` の `registerVaultTools` には、現在の scope と、principal がアクセスできる Vault を返すコールバックを渡します。
書き込みの scope は、readers ではなく owner として検証してください。
登録されるツールの名前は `VAULT_TOOL_NAMES` で取得できます。
実装例は [worker/mcp.ts](../worker/mcp.ts) と [worker/host.ts](../worker/host.ts) です。

`livesync-workers/oauth` の `createVaultOAuthProvider` には、独自セッションの `authenticate`、`loginRedirect`、提供する scope を設定します。
この Worker の principal は admin だけですが、ライブラリを組み込むホストは独自の principal を実装できます。

MCP には `@modelcontextprotocol/sdk` と `zod`、OAuth には `@cloudflare/workers-oauth-provider` が必要です（peer dependency）。

## 検索と旧ホストとの互換

上の例は R2 の Segmenter 索引を明示的に指定しているので、Workers AI と Vectorize は不要です。
任意のベクトル検索を使う場合は、Vectorize、embedder、Vault の隔離設定を追加します。
独自の `FullTextIndex` を渡す場合は、Vault の隔離、本文ハッシュの照合、世代の再構築という契約を守ってください。

`contentBucket` や不変 ID を指定しない旧ホスト向けに、SQLite に保存する経路と旧全文索引がライブラリに残っています。
これはこのリポジトリの Worker が使う R2 方式とは別のものです。
旧データを新方式に移すときは[明示的な移行](r2-operations.md#既存sqliteデータの移行)を使ってください。
旧索引の容量ガードを、Segmenter 索引での保証値として流用しないでください。
