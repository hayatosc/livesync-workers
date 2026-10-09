#!/usr/bin/env node
// Builds and deploys the Worker with cf, then records the deployed commit as a
// `deploy/<UTC timestamp>` tag and pushes it, so the running code can be traced
// back and redeployed. Extra arguments are passed to `cf deploy`.
//
//   pnpm run deploy
//   pnpm run deploy -- --secrets-file .dev.vars
//   pnpm run deploy -- --dry-run          # no tag
//   pnpm run deploy -- --allow-dirty      # deploy uncommitted changes, no tag
import { spawnSync } from "node:child_process";

// pnpm forwards the "--" separator itself; cf would treat what follows as positionals.
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const allowDirty = args.includes("--allow-dirty");
const cfArgs = args.filter((arg) => arg !== "--allow-dirty");
const dryRun = cfArgs.includes("--dry-run");

function run(command, commandArgs, { capture = false } = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

function git(...gitArgs) {
  const result = run("git", gitArgs, { capture: true });
  if (result.status !== 0) throw new Error(`git ${gitArgs.join(" ")} failed`);
  return result.stdout.trim();
}

const dirty = git("status", "--porcelain") !== "";
if (dirty && !allowDirty) {
  console.error("The working tree has uncommitted changes. Commit them first, or pass --allow-dirty");
  console.error("to deploy them anyway (no deploy tag is created, since no commit matches the code).");
  process.exit(1);
}

for (const [command, commandArgs] of [
  ["pnpm", ["build"]],
  ["pnpm", ["exec", "cf", "deploy", ...cfArgs]],
]) {
  const { status } = run(command, commandArgs);
  if (status !== 0) process.exit(status);
}

if (dryRun) process.exit(0);
if (dirty) {
  console.warn("\nDeployed uncommitted changes; no deploy tag was created.");
  process.exit(0);
}

const commit = git("rev-parse", "HEAD");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const tag = `deploy/${stamp}`;
git("tag", "-a", tag, "-m", `Deployed ${commit} with cf deploy`, commit);
console.log(`\nTagged ${commit.slice(0, 12)} as ${tag}.`);
const pushed = run("git", ["push", "origin", `refs/tags/${tag}`]);
if (pushed.status !== 0) {
  console.warn(`Could not push the tag. Push it later with: git push origin ${tag}`);
}
