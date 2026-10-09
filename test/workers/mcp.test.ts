import { env, runInDurableObject } from "cloudflare:test";
import { it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerVaultTools, type VaultScope } from "../../packages/livesync-workers/src/mcp/index.js";
import { createVault } from "../../packages/livesync-workers/src/vault/client.js";
import { DEFAULT_VAULT_POLICY, vaultObjectName } from "../../packages/livesync-workers/src/types.js";
import { SegmenterFullTextIndex } from "../../packages/livesync-workers/src/search/segmenter-index.js";
import { hashText } from "../../packages/livesync-workers/src/search/chunk-md.js";
import type { TestEnv, PersistentVaultDO } from "./entry.js";
const bindings = env as unknown as TestEnv;
function result(value: unknown): Record<string, unknown> {
  return JSON.parse((value as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
}
it("uses real MCP tool transport, per-call authorization, attachments and optimistic update locks", async () => {
  const scopes = new Set<VaultScope>(["vault:read"]);
  const ref = { tenantId: "mcp-owner", vaultId: "one", databaseName: "display" };
  const namespace = bindings.VAULT_DB;
  const stub = namespace.get(namespace.idFromName(vaultObjectName(ref)));
  await stub.fetch("https://db/", { method: "PUT" });
  const vault = createVault(
    {
      vaultDb: namespace,
      contentBucket: bindings.CONTENT,
      bucket: bindings.SEARCH,
      fullText: new SegmenterFullTextIndex(bindings.SEARCH),
    },
    {
      ref,
      policy: { ...DEFAULT_VAULT_POLICY, reservedPaths: ["private"] },
      internalSecret: "integration-secret",
    },
  );
  const server = new McpServer({ name: "integration", version: "1" });
  registerVaultTools(server, {
    vault: async (vaultId) => {
      if (vaultId && vaultId !== "one") throw new Error("Vault access denied");
      return vault;
    },
    hasScope: (scope) => scopes.has(scope),
    listVaults: async () => [{ vaultId: "one", displayName: "display" }],
  });
  const client = new Client({ name: "integration-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    expect(result(await client.callTool({ name: "listVaults", arguments: {} })).vaults).toEqual([
      { vaultId: "one", displayName: "display" },
    ]);
    expect((await client.callTool({ name: "listFiles", arguments: { vaultId: "forbidden" } })).isError).toBe(true);
    expect(
      (
        await client.callTool({
          name: "uploadAttachment",
          arguments: { path: "assets/test.pdf", base64: "AP+A", vaultId: "one" },
        })
      ).isError,
    ).toBe(true);
    scopes.add("vault:write");
    expect(
      result(
        await client.callTool({
          name: "uploadAttachment",
          arguments: { path: "assets/test.pdf", base64: "AP+A", vaultId: "one" },
        }),
      ).ok,
    ).toBe(true);
    const attachment = result(
      await client.callTool({ name: "readAttachment", arguments: { path: "assets/test.pdf", vaultId: "one" } }),
    );
    expect(attachment.base64).toBe("AP+A");
    const concurrent = await Promise.all(
      ["AQID", "BAUG"].map((base64) =>
        client.callTool({
          name: "uploadAttachment",
          arguments: { path: "assets/test.pdf", base64, expectedContentHash: attachment.contentHash, vaultId: "one" },
        }),
      ),
    );
    expect(concurrent.map((response) => (result(response).ok === true ? true : result(response).error)).sort()).toEqual(
      ["CONFLICT", true].sort(),
    );
    expect(
      (await client.callTool({ name: "uploadAttachment", arguments: { path: "../escape.pdf", base64: "AQID" } }))
        .isError,
    ).toBe(true);
    expect(
      result(await client.callTool({ name: "uploadAttachment", arguments: { path: "private/a.pdf", base64: "AQID" } }))
        .error,
    ).toBe("FORBIDDEN_PATH");
    expect(
      result(
        await client.callTool({ name: "uploadAttachment", arguments: { path: "assets/bad.pdf", base64: "invalid" } }),
      ).ok,
    ).toBe(false);
    expect(
      result(
        await client.callTool({
          name: "writeNote",
          arguments: { path: "日本語.md", content: "# 東京 API\n日本語の検索" },
        }),
      ).ok,
    ).toBe(true);
    await runInDurableObject(stub, async (instance: PersistentVaultDO) => {
      await instance.alarm();
    });
    const found = result(
      await client.callTool({ name: "grepNotes", arguments: { query: "東京 API", vaultId: "one" } }),
    );
    expect(found.status).toBe("ready");
    expect((found.hits as Array<{ path: string }>).map((hit) => hit.path)).toEqual(["日本語.md"]);
    expect((await vault.writeNote("日本語.md", "changed", await hashText("stale"))).ok).toBe(false);
  } finally {
    await client.close();
    await server.close();
  }
});

it("rejects explicit vault selection when a legacy resolver ignores its argument", async () => {
  const ref = { tenantId: "legacy-mcp", vaultId: "default", databaseName: "display" };
  const vault = createVault(
    { vaultDb: bindings.VAULT_DB, contentBucket: bindings.CONTENT },
    { ref, policy: DEFAULT_VAULT_POLICY, internalSecret: "integration-secret" },
  );
  const server = new McpServer({ name: "legacy", version: "1" });
  registerVaultTools(server, { vault: async () => vault, hasScope: () => true });
  const client = new Client({ name: "legacy-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try {
    for (const name of ["listFiles", "vaultStatus"])
      expect((await client.callTool({ name, arguments: { vaultId: "other" } })).isError).toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
});
