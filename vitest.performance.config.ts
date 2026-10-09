import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "test/workers/wrangler.jsonc" } })],
  test: {
    include: ["test/performance/**/*.test.ts"],
    testTimeout: 120_000,
    env: { PERF_LABEL: process.env.PERF_LABEL ?? "working-tree" },
  },
});
