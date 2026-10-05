import { env, runInDurableObject } from "cloudflare:test";
import { it, expect } from "vitest";
import type { TestEnv, LegacyVaultDO, PersistentVaultDO } from "./entry.js";
const bindings = env as unknown as TestEnv;
it("migrates a frozen SQLite source explicitly, reconstructs the new vault, and preserves the rollback source", async () => {
  const source = bindings.LEGACY_DB.get(bindings.LEGACY_DB.idFromName("migration:old-name"));
  const destination = bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName("v1:migration:stable-id"));
  await source.fetch("https://db/", { method: "PUT" });
  const largeBody = "日本語😀".repeat(150_000);
  expect((await source.fetch("https://db/large", { method: "PUT", body: JSON.stringify({ path: "large.md", data: largeBody, type: "plain" }) })).status).toBe(200);
  await source.fetch("https://db/_local/checkpoint", { method: "PUT", body: '{"last_seq":1}' });
  await runInDurableObject(source, async (instance: LegacyVaultDO) => {
    const original = (instance as unknown as { bindings(): Record<string, unknown> }).bindings.bind(instance);
    const mutable = instance as unknown as { bindings(): Record<string, unknown> };
    mutable.bindings = () => ({ ...original(), contentBucket: bindings.CONTENT });
    try {
      expect((await instance.fetch(new Request("https://db/internal/migrate-r2", { method: "POST", body: '{"targetVaultId":"stable-id"}' }))).status).toBe(403);
      const response = await instance.fetch(new Request("https://db/internal/migrate-r2", {
        method: "POST", headers: { "X-LiveSync-Internal": "integration-secret" }, body: '{"targetVaultId":"stable-id"}',
      }));
      expect(response.status).toBe(200);
    } finally { mutable.bindings = original; }
  });
  const restored = await (await destination.fetch("https://db/large")).json() as { data: string };
  expect(restored.data).toBe(largeBody);
  expect((await destination.fetch("https://db/_local/checkpoint")).status).toBe(200);
  expect((await (await source.fetch("https://db/large")).json() as { data: string }).data).toBe(largeBody);
  await runInDurableObject(destination, async (_instance: PersistentVaultDO, state) => {
    expect(state.storage.sql.exec("SELECT * FROM rev_body_chunks").toArray()).toHaveLength(0);
    expect(state.storage.sql.exec<{ body_chunked: number }>("SELECT body_chunked FROM revs").one().body_chunked).toBe(2);
  });
});
