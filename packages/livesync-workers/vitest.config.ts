import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": new URL("./test/cloudflare-workers.ts", import.meta.url).pathname,
      "cloudflare:email": new URL("./test/cloudflare-email.ts", import.meta.url).pathname,
    },
  },
  test: {
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider", "agents", "partyserver"] } },
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
