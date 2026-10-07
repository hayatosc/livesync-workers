#!/usr/bin/env node
// Creates the resources cloudflare.config.ts declares. Idempotent.
import { spawnSync } from "node:child_process";
import config from "../cloudflare.config.ts";

const resources = Object.values(config.worker.env);
const indexNames = resources.filter((binding) => binding.type === "vectorize").map((binding) => binding.name);
const bucketNames = resources.filter((binding) => binding.type === "r2").map((binding) => binding.name);
const dryRun = process.argv.includes("--dry-run");

function cf(args, { allowExisting = true } = {}) {
  if (dryRun) args = [...args, "--dry-run"];
  console.log(`\n$ cf ${args.join(" ")}`);
  const result = spawnSync("pnpm", ["exec", "cf", ...args], { encoding: "utf8", shell: process.platform === "win32" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(output);
  if (result.status !== 0) {
    if (allowExisting && /already exists|already_exists|409/i.test(output)) {
      console.log("(already exists, continuing)");
      return;
    }
    console.error(`cf exited with ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

// Dimensions must match the embedding model (embeddinggemma-300m → 768).
for (const indexName of indexNames) cf(["vectorize", "create", "--name", indexName, "--config-dimensions", "768", "--config-metric", "cosine"]);
for (const bucketName of bucketNames) cf(["r2", "buckets", "create", "--name", bucketName]);

console.log(`
${dryRun ? "Dry run complete. No resources were created." : "Done."}
The OAuth KV binding is declared in cloudflare.config.ts.

Next:
  1. Sign in: pnpm exec cf auth login
  2. For a first deployment, fill .dev.vars using .dev.vars.example and upload
     its secrets: pnpm exec cf deploy --secrets-file .dev.vars
  3. For subsequent deployments: pnpm run deploy
`);
