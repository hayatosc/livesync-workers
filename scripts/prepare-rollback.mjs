#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspace = await realpath(fileURLToPath(new URL("../", import.meta.url)));
const ref = process.argv[2];
if (!ref || ref.startsWith("-") || process.argv.length !== 3) {
  throw new Error("Usage: pnpm run rollback:prepare <known-good-R2-commit>");
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: workspace, maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${String(result.stderr).trim()}`);
  return result.stdout;
}
const sourceCommit = String(run("git", ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
const configCommit = String(run("git", ["rev-parse", "HEAD"])).trim();
const archive = run("git", ["archive", "--format=tar", sourceCommit]);
const local = path.join(workspace, ".local");
await mkdir(local, { recursive: true });
if ((await realpath(local)) !== local) throw new Error("Rollback output must stay inside this workspace");
const destination = await mkdtemp(path.join(local, `rollback-${sourceCommit.slice(0, 12)}-`));
run("tar", ["-xf", "-", "-C", destination], { input: archive });

// Keep the known-good implementation, but retain the current exports lifecycle
// and the cf toolchain needed to deploy it. Ignored credentials are not copied.
const overlays = [
  "cloudflare.config.ts",
  "wrangler.config.ts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".node-version",
  "AGENTS.md",
  "scripts/prepare-rollback.mjs",
];
const overlayHashes = {};
for (const file of overlays) {
  const bytes = await readFile(path.join(workspace, file));
  await writeFile(path.join(destination, file), bytes);
  overlayHashes[file] = createHash("sha256").update(bytes).digest("hex");
}
await writeFile(
  path.join(destination, "ROLLBACK_BUILD.json"),
  `${JSON.stringify({ sourceCommit, configCommit, overlayHashes }, null, 2)}\n`,
);
console.log(JSON.stringify({ destination, sourceCommit, configCommit }));
console.log("Prepared source only; nothing was deployed. In that directory, run:");
console.log("  pnpm install --frozen-lockfile\n  pnpm build\n  pnpm exec cf deploy --dry-run");
console.log("Verify exports and all resource bindings before any deployment.");
