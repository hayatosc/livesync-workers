# Cloudflare CLI

This project uses `cf` for development, deployment, resource setup, types, and
persisted observability queries. Node.js 24 or later is required by the project.
The pinned versions are `cf@1.0.0-beta.12` and `wrangler@4.136.0`; Wrangler remains
the build implementation invoked by `cf`, rather than the operator-facing CLI.

`cloudflare.config.ts` is the deployment configuration. It targets the existing
account, OAuth KV namespace, R2 buckets, and live SQLite Durable Object classes.
Declare optional variables in its `worker.env` block: `cf` does not support
Wrangler's `keep_vars`. The legacy `wrangler.jsonc` is retained for existing
Deploy to Cloudflare and test integrations.

## Commands

```sh
pnpm exec cf auth login
pnpm run setup --dry-run
pnpm run cf-typegen
pnpm typecheck
pnpm build
pnpm exec cf deploy --dry-run
pnpm run deploy
```

`cf` has its own OAuth credentials. A Wrangler login does not authenticate it.
The setup dry run prints planned resource requests without creating resources.
Deployment builds the library first, then lets `cf` build and deploy the Worker.
Existing secrets are declared with `bindings.secret()` and need not be uploaded
again. For a first deployment, fill `.dev.vars` from `.dev.vars.example`, build
the library, and use `pnpm exec cf deploy --secrets-file .dev.vars`.

## Persisted logs

Discover the current API surface with `cf cli search` and command help:

```sh
pnpm exec cf cli search "query workers observability telemetry logs"
pnpm exec cf observability telemetry query --help
```

For the investigation on October 7, create a local query JSON file:

```json
{
  "queryId": "sync-performance-investigation",
  "timeframe": { "from": 1791345780000, "to": 1791346980000 },
  "dry": true,
  "view": "events",
  "limit": 1000,
  "parameters": {
    "filters": [{
      "key": "$workers.scriptName",
      "operation": "eq",
      "type": "string",
      "value": "livesync-workers"
    }],
    "filterCombination": "and",
    "limit": 1000
  }
}
```

```sh
pnpm exec cf observability telemetry query --body @query.json
pnpm exec cf r2 buckets metrics list
pnpm exec cf workers versions get latest --worker-id livesync-workers
```

Adjust the millisecond timestamps for each investigation. Keep analysis focused
on method, path, status, CPU time, wall time, execution model, and trace ID.
Match stateless requests to Durable Object events by trace ID; do not add both
wall times together. Durable Object event lifetime can extend beyond the HTTP
response, so the stateless request provides the response latency measurement.

After deployment, check `$workers.scriptVersion.id` on both the stateless Worker
and the VaultDO events. A new Worker can still call an older Durable Object
during rollout; a successful upload or a 100% deployment record alone does not
prove that a performance probe exercised the new vault implementation. See
[code update propagation](https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates).

The vault emits aggregate `LiveSync filtered changes`, `LiveSync bulk preparation`
and `LiveSync maintenance timings` logs. These separate selector scan/body
fallback counts, bulk preparation time, and index preparation/publication time
without recording note contents or credentials.

A broad events query can fill its 1,000-event limit with informational logs.
Query warnings and errors separately by adding a `$metadata.level` equality
filter (`warn` or `error`) alongside the script filter, so failures are not
silently omitted from the diagnostic sample. Maintenance logs also report
`publicationBatchSize`, which decreases after an invocation API-limit failure.

References: [migration](https://developers.cloudflare.com/cf/wrangler/migrate/),
[authentication](https://developers.cloudflare.com/cf/get-started/),
[timing metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/).
