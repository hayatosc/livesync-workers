import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerVaultTools, type VaultScope } from "../../packages/livesync-workers/src/mcp/index.js";
import { env } from "cloudflare:test";
import { it, expect } from "vitest";
import { authorizedVaults, setupVaultConfig, setupVaultPassword, vaultFor, vaultHost } from "../../worker/host.js";
import { statusPage } from "../../worker/pages.js";
import { handleLiveSyncRequest } from "../../packages/livesync-workers/src/livesync/handler.js";
import { hashText } from "../../packages/livesync-workers/src/search/chunk-md.js";
import type { Env } from "../../worker/env.js";
import type { TestEnv } from "./entry.js";
const bindings = env as unknown as TestEnv;
it("uses real host registry authorization and keeps equal paths isolated across vaults", async () => {
  const configs = [
    { vaultId: "a", tenantId: "registry", databaseName: "work", displayName: "仕事", ownerId: "admin", readers: ["viewer"], username: "alice", passwordSecret: "ALICE_PASSWORD" },
    { vaultId: "b", tenantId: "registry", databaseName: "private", displayName: "個人", ownerId: "bob", username: "bob", passwordSecret: "BOB_PASSWORD" },
  ];
  const app = { VAULT_DB: bindings.VAULT_DB, CONTENT_BUCKET: bindings.CONTENT, FTS_BUCKET: bindings.SEARCH, SESSION_SECRET: "integration-secret", ALICE_PASSWORD: "alice-pass", BOB_PASSWORD: "bob-pass", VAULTS_JSON: JSON.stringify(configs) } as unknown as Env;
  const host = vaultHost(app);
  const sync = (database: string, username: string, password: string, method: string) => handleLiveSyncRequest(new Request(`https://worker/livesync/${database}`, { method, headers: { Authorization: `Basic ${btoa(`${username}:${password}`)}` } }), { host, bindings: { vaultDb: bindings.VAULT_DB } });
  expect((await sync("work", "alice", "alice-pass", "PUT")).status).toBe(200);
  expect((await sync("private", "bob", "bob-pass", "PUT")).status).toBe(200);
  expect((await sync("private", "alice", "alice-pass", "GET")).status).toBe(403);
  expect((await sync("work", "alice", "bob-pass", "GET")).status).toBe(401);
  const a = vaultFor(app, "a", "admin", true), b = vaultFor(app, "b", "bob", true);
  expect((await a.writeNote("same.md", "owner A", await hashText(""))).ok).toBe(true);
  expect((await b.writeNote("same.md", "owner B", await hashText(""))).ok).toBe(true);
  expect(await vaultFor(app, "a", "viewer").readNote("same.md")).toBe("owner A");
  expect(await b.readNote("same.md")).toBe("owner B");
  expect(() => vaultFor(app, "b", "admin")).toThrow("access denied");
  expect(() => vaultFor(app, "a", "viewer", true)).toThrow("access denied");
  const selected = setupVaultConfig(app);
  expect(selected.databaseName).toBe("work");
  expect(setupVaultPassword(app)).toBe("alice-pass");
  const page = await statusPage(app, { origin: "https://worker", admin: true, configured: { livesync: true, admin: true, session: true }, username: selected.username }).text();
  expect(page).toContain("ALICE_PASSWORD");
  expect(page).toContain("<code>work</code>");
  const scopes = new Set<VaultScope>(["vault:read", "vault:write"]);
  const server = new McpServer({ name: "host-auth", version: "1" });
  registerVaultTools(server, {
    vault: async (id, scope) => vaultFor(app, id, "viewer", scope === "vault:write" || scope === "vault:append"),
    hasScope: (scope) => scopes.has(scope),
    listVaults: async () => authorizedVaults(app, "viewer").map(({ vaultId, displayName }) => ({ vaultId, displayName })),
  });
  const client = new Client({ name: "host-auth-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    expect((await client.callTool({ name: "readNote", arguments: { vaultId: "a", path: "same.md" } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "readNote", arguments: { vaultId: "b", path: "same.md" } })).isError).toBe(true);
    expect((await client.callTool({ name: "writeNote", arguments: { vaultId: "a", path: "same.md", content: "denied" } })).isError).toBe(true);
    scopes.delete("vault:read");
    expect((await client.callTool({ name: "readNote", arguments: { vaultId: "a", path: "same.md" } })).isError).toBe(true);
    scopes.add("vault:read");
    app.VAULTS_JSON = JSON.stringify(configs.map((config) => ({ ...config, readers: [] })));
    expect((await client.callTool({ name: "readNote", arguments: { vaultId: "a", path: "same.md" } })).isError).toBe(true);
  } finally { await client.close(); await server.close(); }

  expect(authorizedVaults(app, "viewer")).toEqual([]);
  expect(() => vaultFor(app, "a", "viewer")).toThrow("access denied");
});

it("renders configuration warnings for malformed registries and registries without an admin vault", async () => {
  for (const VAULTS_JSON of ["{", JSON.stringify([{ vaultId: "only", tenantId: "other", databaseName: "other", displayName: "Other", ownerId: "someone", username: "other", passwordSecret: "OTHER_PASSWORD" }])]) {
    const app = { VAULTS_JSON } as Env;
    for (const admin of [false, true]) {
      const response = statusPage(app, { origin: "https://worker", admin, configured: { livesync: true, admin: true, session: true }, username: "obsidian" });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Vault configuration unavailable");
    }
  }
});
