import { env, SELF, runInDurableObject } from "cloudflare:test";
import { it, expect } from "vitest";
import { PersistentVaultDO, type TestEnv } from "./entry.js";
import { vaultObjectName, type VaultRef } from "../../packages/livesync-workers/src/types.js";
const bindings = env as unknown as TestEnv;
class AnonymousVaultDO extends PersistentVaultDO {
  // workerd inside an actual DO does not preserve idFromName's name.
  // Force that boundary while retaining the actual DO storage and id equality.
  protected vaultRef(): VaultRef | null {
    return (this as unknown as { resolvedVaultRef: VaultRef | null }).resolvedVaultRef;
  }
}
it("binds anonymous DO identity only from trusted matching headers and recovers it across instances", async () => {
  expect(
    (
      await SELF.fetch("https://test/livesync/vault/internal/op", {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa("alice:integration-pass")}`,
          "X-LiveSync-Internal": "integration-secret",
        },
        body: '{"op":"contentGc","execute":true}',
      })
    ).status,
  ).toBe(404);
  const ref = { tenantId: "runtime-identity", vaultId: "固定ID", databaseName: "vault" };
  const stub = bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName(vaultObjectName(ref)));
  await runInDurableObject(stub, async (_instance, state) => {
    const fresh = () => new AnonymousVaultDO(state, bindings);
    const headers = {
      "X-LiveSync-Internal": "integration-secret",
      "X-LiveSync-Vault-Ref": encodeURIComponent(JSON.stringify(ref)),
    };
    expect((await fresh().fetch(new Request("https://db/", { method: "PUT" }))).status).toBe(500);
    expect(
      (
        await fresh().fetch(
          new Request("https://db/", { method: "PUT", headers: { ...headers, "X-LiveSync-Internal": "wrong" } }),
        )
      ).status,
    ).toBe(500);
    const instance = fresh();
    expect((await instance.fetch(new Request("https://db/", { method: "PUT", headers }))).status).toBe(200);
    expect(
      (await instance.fetch(new Request("https://db/doc", { method: "PUT", headers, body: '{"data":"durable"}' })))
        .status,
    ).toBe(200);
    expect(
      (
        await instance.fetch(
          new Request("https://db/", {
            headers: {
              ...headers,
              "X-LiveSync-Vault-Ref": encodeURIComponent(JSON.stringify({ ...ref, vaultId: "foreign" })),
            },
          }),
        )
      ).status,
    ).toBe(500);
    for (const table of [
      "docs",
      "revs",
      "rev_metadata",
      "local_docs",
      "changes",
      "rev_body_chunks",
      "meta",
      "index_state",
    ])
      state.storage.sql.exec(`DELETE FROM ${table}`);
    expect(await (await fresh().fetch(new Request("https://db/doc"))).json()).toMatchObject({ data: "durable" });
    const row = state.storage.sql
      .exec<{ body: string; body_chunked: number }>("SELECT body, body_chunked FROM revs WHERE id = 'doc'")
      .one();
    expect(row.body_chunked).toBe(2);
    expect(JSON.parse(row.body).r2).toContain("content/v1/runtime-identity/%E5%9B%BA%E5%AE%9AID/");
  });
});
