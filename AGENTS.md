Write commit messages and release titles and notes in English.

Create pull requests only in the user's repository, `hayatosc/livesync-workers`.
Do not create pull requests in the upstream repository or any other repository.
Before pushing or creating a pull request, verify the destination repository is
`hayatosc/livesync-workers`. Specify this repository explicitly in PR tools and
commands; do not rely on an inferred upstream or CLI default.

Write documentation (`README.md`, `docs/`) in Japanese. Write code comments,
workflow comments, script output and identifiers in English.

Before committing, run `pnpm lint` (Biome format and lint) along with
`pnpm typecheck` and `pnpm test`. `pnpm format` applies formatting. Keep
formatting-only commits separate and list them in `.git-blame-ignore-revs`.

Deploy only with `pnpm run deploy`, which uses `cloudflare.config.ts`. Do not
run `wrangler deploy` or restore the removed root `wrangler.jsonc`: its
`migrations` configuration predates `worker.exports`.
