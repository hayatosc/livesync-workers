# Upgrading

New versions are published as [GitHub Releases](https://github.com/odiak/livesync-workers/releases).
To be notified, **Watch** this repository → **Custom** → **Releases**.

## If you deployed with the Deploy to Cloudflare button

The button does not fork this repository. It creates an independent copy under your
GitHub/GitLab account as a single commit, with `wrangler.jsonc` rewritten to point at
the resources it created for you (bucket and index names, binding ids) and the `name`
in `package.json` changed. Your copy shares no git history with this repository and
does not receive updates on its own.

### With a coding assistant

Open your copy in Claude Code, Codex, Cursor or similar and give it this prompt:

```text
This repository is a copy of https://github.com/odiak/livesync-workers made by the
Deploy to Cloudflare button. It is not a fork, and until its first upgrade it shares
no git history with upstream. Upgrade it to the latest upstream release by following
the "If you deployed with the Deploy to Cloudflare button" section of
https://github.com/odiak/livesync-workers/blob/main/docs/upgrading.md

- Keep my resource names, ids and variables in wrangler.jsonc, and bring in any new
  bindings, variables and Durable Object migrations from upstream.
- Read the release notes at https://github.com/odiak/livesync-workers/releases
  between my current version (packages/livesync-workers/package.json) and the new
  one, and tell me about any new secrets or variables I need to set in the
  Cloudflare dashboard.
- Pushing deploys to production. Show me the result and wait for my OK before pushing.
```

The rest of this section is what the assistant will do, if you would rather do it by hand.

### First upgrade only: connect your copy to upstream

Git cannot merge two histories that have nothing in common, so first record which
upstream commit your copy was made from. This changes no files; it only gives later
merges a common ancestor.

```sh
git remote add upstream https://github.com/odiak/livesync-workers.git
git fetch upstream --tags

# Prints a commit if your copy is already connected. Then skip to "Every upgrade".
git merge-base HEAD upstream/main
```

Find the upstream commit closest to the commit the button created (the root of your
history):

```sh
import=$(git rev-list --max-parents=0 HEAD)
best= min=
for c in $(git rev-list upstream/main); do
  n=$(git diff --numstat "$c" "$import" | awk '{ s += $1 + $2 } END { print s + 0 }')
  if [ -z "$min" ] || [ "$n" -lt "$min" ]; then best=$c min=$n; fi
  [ "$n" -eq 0 ] && break
done
git log -1 --oneline "$best"
git diff --stat "$best" "$import"
```

The diff should list only `wrangler.jsonc` and `package.json`, with a few changed
lines each. If it lists more, the match is wrong; do not continue. Otherwise record
that commit as merged, keeping all of your files:

```sh
git merge -s ours --allow-unrelated-histories -m "Record upstream ${best:0:7} as the base of this copy" "$best"
```

### Every upgrade

Merge the latest release tag and push. Workers Builds redeploys on every push to your
production branch.

```sh
git fetch upstream --tags
git merge "$(git tag -l 'v*' --sort=-v:refname | head -n 1)"
git push
```

### What conflicts

Usually nothing. The only lines your copy differs in are the ones the button wrote
(ids and names in `wrangler.jsonc`, `name` in `package.json`), and a merge conflicts
only when upstream changes those same lines, for example by adding a binding next to
yours. Keep **your** values and add upstream's change around them; the release notes
say when a new binding or variable is involved.

If you committed your own changes to the copy after deploying, the files you changed
can conflict as well. Resolve those as you would any merge conflict.

Secrets live in Cloudflare, not in the repository, so they survive upgrades.
If an upgrade needs a new secret or variable, add it in the dashboard under
Settings → Variables and Secrets.

### Durable Object migrations

Upstream ships schema changes as new entries in the `migrations` list in
`wrangler.jsonc`. Keep the whole list from upstream in order; Cloudflare applies
only the tags it has not seen for your Worker.

## If you deployed with wrangler

Your clone tracks this repository directly:

```sh
git pull
npm install
npm run build && npm run deploy
```

New secrets or variables are announced in the release notes; set them with
`wrangler secret put NAME` or in the dashboard before deploying.

## If you embed the library

Bump `livesync-workers` in your `package.json` and read the changelog for
breaking changes to `VaultHost`, `VaultPolicy` or the MCP tool surface.
