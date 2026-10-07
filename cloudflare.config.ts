import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig({
  accountId: "9edb79449ad0a1d1ca7b838a0a8de179",
  worker: {
    name: "livesync-workers",
    compatibilityDate: "2026-04-30",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "./worker/index.ts",
    observability: { enabled: true },
    // These declarations preserve the existing SQLite namespaces.
    exports: {
      VaultDO: exports.durableObject({ storage: "sqlite" }),
      VaultMCP: exports.durableObject({ storage: "sqlite" }),
    },
    // Declare optional variables here. cf does not support Wrangler's keep_vars.
    env: {
      LIVESYNC_DATABASE: bindings.text("vault"),
      LIVESYNC_VAULT_ID: bindings.text("primary"),
      SEMANTIC_SEARCH: bindings.text("off"),
      LIVESYNC_USERNAME: bindings.text("obsidian"),
      LIVESYNC_PASSWORD: bindings.secret(),
      ADMIN_PASSWORD: bindings.secret(),
      SESSION_SECRET: bindings.secret(),
      OAUTH_KV: bindings.kv({ id: "c093a4d3d8eb448cba3846844baef0c5" }),
      FTS_BUCKET: bindings.r2({ name: "livesync-fts" }),
      CONTENT_BUCKET: bindings.r2({ name: "livesync-content" }),
      VAULT_DB: bindings.durableObject({ worker: "livesync-workers", exportName: "VaultDO" }),
      MCP_OBJECT: bindings.durableObject({ worker: "livesync-workers", exportName: "VaultMCP" }),
      AUTH_FAILURE_LIMITER: bindings.rateLimit({ namespace: "4801", simple: { limit: 10, period: 60 } }),
    },
  },
});
