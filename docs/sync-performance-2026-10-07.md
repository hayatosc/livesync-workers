# LiveSync performance investigation: October 7, 2026

The main replication bottleneck is the filtered `_changes` endpoint. It reads
R2 bodies for revisions that the Obsidian selector excludes, while holding the
Vault's request lock. This both makes the changes scan slow and queues unrelated
DB requests behind it. The changes described below were implemented and deployed
with the official cf CLI; the earlier sections record the baseline investigation.

## Scope and measurements

- Production version: `aa3d32f9-f2ba-4787-ac60-c8eb6bf1ba82`.
- Cloudflare persisted logs: 825 events between 13:03 and 13:23 JST, retrieved
  with the authenticated official `cf observability telemetry query` command.
- Live read-only probes: small unfiltered and filtered changes feeds, DB info,
  checkpoints, revision differences, bulk reads, and concurrent requests.
- Obsidian settings: `readChunksOnline: true`, `batch_size: 25`,
  `batches_limit: 25`, encryption off.
- Vault: 237 Markdown files, 781,732 bytes in total; largest file 93,892 bytes.
- Remote: 1,695 replication documents, including chunks and plugin metadata.
  This is not the count of Markdown files.

## Primary finding: unnecessary body reads in filtered changes

The local plugin sets its pull selector to `{ "type": { "$ne": "leaf" } }`
when online chunk reading is enabled. Production request logs confirm POST
`_changes` calls with `filter=_selector`, `style=all_docs`, and `limit=25`.

`changeBatch()` in `packages/livesync-workers/src/durable/livesync-db.ts` loads
each candidate's leaves through `hydrateRevision()` before applying its
selector. `hydrateRevision()` fetches the revision envelope from R2. Candidates
are processed one document at a time. Meanwhile, revision `type` is already
stored in the local `rev_metadata` table.

| Measurement | Result |
| --- | --- |
| Second Obsidian sync, 13:14:32–13:18:49 JST | About 257 seconds |
| Eleven sequential filtered `_changes` calls in that sync | 243.853 seconds, about 95% of the sync |
| Filtered `_changes`, all 13 logged calls | Median 19.475 seconds; maximum 72.699 seconds |
| Paired Durable Object CPU for these calls | Median 4ms; maximum 522ms |
| Unfiltered five-row changes probe, `since=532` | 0.782 seconds |
| Filtered five-row probe, same `since` | 23.278 seconds; last sequence 705 |
| DB info started 500ms after the filtered probe | 22.916 seconds |
| Concurrent public Worker endpoint | 65ms |
| Filtered one-row probe, `since=532` | 6.392 seconds; last sequence 578 |

The five-row filtered probe advances through sequence numbers 533–705 to return
only five matching notes. The concurrent DB/public comparison reproduces the
Vault request-lock interference independently of full-text indexing.

The earlier sync transferred no additional document bodies, but it still had
unexamined remote changes: its pull scan began at sequence 532, not 1,695.
After the checkpoint caught up, another actual Obsidian sync completed between
13:37:35 and 13:37:40 JST, approximately five seconds.

Priority: evaluate supported selectors using revision metadata and document IDs
without fetching bodies. Preserve generic-selector fallback, conflict-leaf
semantics, filtered limits, pending counts, and checkpoint advancement.

## Secondary finding: serial writes in bulk replication

The 46 logged `_bulk_docs` calls had a median wall time of 9.501 seconds, p95 of
10.909 seconds, and maximum of 11.505 seconds. Their wall times sum to 396.652
seconds. The paired Durable Object CPU median was 78ms and maximum 134ms.

`handleBulkDocs()` awaits `insertRevision()` for each document. For new revisions,
`writeRevision()` uploads one R2 envelope before updating SQLite. Thus a batch
of 25 new documents performs serial body uploads before the journal commit.

Priority after the changes optimization: stage independent body uploads with
bounded concurrency, then perform ordered SQLite revision/sequence updates and
the fenced journal commit. Do not simply parallelize `insertRevision()`, because
sequence allocation and revision dependencies require ordering.

## Full-text indexing remains slow

At 13:40 JST, the changes cursor had reached 1,695, but the index reported 43
indexed paths and 194 pending paths. Background alarm wall times reached
211.254 seconds. These event lifetimes are not equivalent to HTTP response
latency; trace-matched Durable Object events can outlive their parent responses.

The preparation budget is 50ms after the first path. R2 hydration can exceed
that budget for one path, leading to small publication batches. Publication
also merges posting pages once the manifest delta exceeds 256 KiB or 32 paths.
These are additional optimization candidates, but their individual contribution
has not been timed. The historical trace query returned zero traces, so there
is no measured per-R2-operation breakdown for this period.

Next diagnostic step for search: record time and operation counts separately
for note/chunk hydration, writer upserts, posting-page reads/writes, and manifest
publication, before changing those algorithms.

## Other indicators

- Warm direct probes: DB info median 169ms; idle changes 151ms; checkpoint reads
  291ms; 25-revision differences 164ms; two-document bulk reads 279ms.
- The version's recorded startup time was 43ms.
- SQLite used 1,605,632 bytes, with 900,000,000-byte limit and 100,000,000-byte
  reserved headroom; writable was true. Capacity was not close to its limit.
- The logged filtered changes and bulk writes returned HTTP 200; there were no
  warning/error console events in the retrieved period. Client-aborted health
  probes appear as canceled events and are not server 500 responses.
- Account-level R2 metrics reported 1,632 published objects and 35,057,294 bytes.
  These delayed account-level metrics include journal/search objects and cannot
  be interpreted as current live Vault size or request-operation counts.

## CLI migration validation

`cf@1.0.0-beta.12` was installed and authenticated. Project configuration,
development/deployment/type-generation scripts, and resource setup were migrated
to `cf`. Wrangler 4.136.0 remains the supported bundler. The root application
was explicitly included in the workspace list for cf's project detection.

Existing account/resource identifiers and SQLite export names were verified
against the live version. Library build, type checks, resource setup dry run,
`cf deploy --dry-run`, and seven Worker maintenance tests passed. The legacy
Wrangler configuration and the pre-existing README edit were preserved.

See [Cloudflare CLI usage](cloudflare-cli.md). Measurement summaries are retained
in this report. Temporary investigation scripts, raw outputs and validation logs
were removed from the ignored `.local/` directory when preparing the pull request.

## Optimization implementation

- `_changes` evaluates selectors against revision metadata before loading bodies.
  Unknown fields and SQL NULL values fall back to the full document, preserving
  absent/null/non-scalar values, nested fields and conflict-leaf behavior. The
  normal LiveSync `type != leaf` selector needs no revision body reads.
- Replication bulk writes upload immutable envelopes in windows of four. SQL
  insertion, sequence allocation, conflict handling, ancestry and journal CAS
  remain ordered. Every started upload settles before an error is returned.
- Index preparation hydrates up to 16 notes together, with a shared four-read
  limit and per-snapshot coalescing of shared chunks. Network wait no longer
  reduces each preparation pass to one note. Deferred paths and their durable
  retry/sweep cursor are retained.
- Independent posting-tree branches update concurrently, with a shared four-I/O
  limit across recursive reads and writes. Old roots remain immutable; only
  manifest CAS publishes the result.
- Posting pages now hold up to 256 entries instead of 64, retaining the 512 KiB
  byte cap and bounded cache. Versioned rebuilds abandon interrupted old-layout
  builds while keeping an active generation readable, without re-embedding vectors.
- Normal requests rearm lost maintenance alarms when retryable pending notes
  remain, even if the change cursor has caught up. Exhausted missing-chunk retries
  remain capped.
- Maintenance explicitly continues when pending paths remain outside the current
  batch. Finishing all 16 selected paths must not stop work on subsequent batches.
  A pending-only regression test verifies continuation without another request.
- Invocation API-limit failures halve the persistent publication batch size,
  down to one path. Preparation observes the same limit; deferred paths remain
  pending and continue in subsequent alarms. Ordinary service errors retain the
  existing retry behavior. A regression test simulates the invocation limit,
  verifies 16 -> 8 -> 4 adaptation and all 16 notes becoming searchable.
- Aggregate logs record selector scans/body fallbacks, bulk preparation time,
  and index preparation versus publication time.

Validation: 168 library tests, 11 application tests and 81 Worker tests passed,
along with type checks, build and cf deployment dry run. Worker tests cover zero
body reads across long filtered runs, null/missing/custom-field fallbacks,
bounded upload/read concurrency, failed-upload settlement, stale index
publication, immutable roots, and recovery after cache loss. The first full
run hit existing five-second Worker timeouts under parallel load; the complete
Worker suite passed with one worker and a 60-second test timeout.

Local Workers measurements with a synthetic 2ms R2-operation delay (not
production throughput): bulk25 median 359ms -> 277ms; initial128 1824ms -> 1253ms;
checkpoint/index maintenance128 3061ms -> 2638ms, with search R2 GETs 66 -> 41
and PUTs 180 -> 155. A standalone index-build128 run took 1321ms -> 2243ms
despite fewer operations (GETs 40 -> 22, PUTs 195 -> 162); these local timings
do not establish improved production index throughput.

Deployed via cf at 14:07 JST: `23191247-f0dd-4a68-8526-11522fd7a90e`.
Existing resource identifiers and all three secret bindings were retained.
Production checkpoint write/read/delete passed and left doc_count/update_seq
unchanged at 1695. Initial probes at 14:07–14:11 still reached the old VaultDO
version, as confirmed by cf telemetry, so those results are rollout observations
and cannot be used as measurements of the optimization.

At 14:14 JST, after the VaultDO rolled onto the new version, the identical
filtered5 replay completed in 209ms instead of the original 23,278ms; filtered1
completed in 184ms instead of 6392ms. Matching counts, last_seq and pending
counts were unchanged. Concurrent DB info completed in 184ms instead of
22,916ms. Obsidian's regular one-shot synchronization completed normally from
14:16:00 to 14:16:05 without additional document transfers.

The initial optimized version repeatedly exceeded the invocation's API request
limit during search publication. Search stayed at 94 indexed/143 pending after
the reset because pending paths did not trigger a new alarm once indexed_seq
reached current_seq. Version `ea84c69b-3974-4d88-ad89-0cb018efb632`, deployed at
14:26 JST, increased posting-page capacity, rotated the derived index layout and
repaired alarm recovery. An initial request-limit error occurred at 14:31; later
16-path publications succeeded and advanced the rebuild to 224 indexed/13 pending
by 14:51. The last, denser batch exceeded the API limit again. Warning-specific
cf queries exposed these errors, which were omitted by the broad query's
1,000-event limit. Preparation ranged from roughly two seconds to 25 seconds;
publication took tens of seconds and remains the main background cost. Some
foreground DB reads still waited for preparation, including a 9.6-second probe
during this rebuild; the improved filtered feed does not guarantee every
request stays under a second during maintenance.

Batching also exposed a continuation defect: after processing all selected
paths, `more` was false even when other pending paths remained. The follow-up
fix, deployed at 14:45 JST as `35e0078b-7dc6-47da-8d92-8c40266e2d71`, explicitly
continues those pending-only batches. VaultDO telemetry confirmed the new version
by 14:52. Warning queries showed repeated API-limit failures on the final 13
paths, prompting the persistent adaptive-batch change. Production completion
after that change is recorded below.

The adaptive-batch version was deployed at 15:01 JST as
`f35bf3ec-824f-4e5a-a59f-1e0ddfa14cea`. It retains the existing Vault, buckets,
namespace bindings and secrets, and applies the smaller batch size only to
background index preparation/publication.

At 15:03 JST, the authenticated status endpoint reported 237 indexed notes,
zero pending notes, indexed_seq/current_seq 1,695 and no index error. Production
R2 state confirmed an active `shared-postings-256-v1` generation with no building
generation. A read-only cf CLI adapter queried that published index for `CYP1A2`:
docCount 237, three hits and highlights for all hits, using nine R2 object reads.
This validates the stored production search index; it is not an HTTP/MCP search
latency measurement.

Obsidian's final regular synchronization ran from 15:04:06 to 15:04:11 JST and
logged `Replication completed`. The same filtered-five-row replay at 15:04 took
188ms, retaining count five, last_seq 705 and pending 990. Concurrent DB info
took 301ms. The replica still contains 1,695 canonical documents at sequence
1,695; local Vault content and auto-sync settings were not changed.

Persisted telemetry subsequently confirmed both stateless Worker requests and
VaultDO requests using `f35bf3ec-824f-4e5a-a59f-1e0ddfa14cea` for the final
15:04 probes. The filtered-five scan evaluated all 173 candidates from metadata,
with zero body fallbacks. The recent diagnostic sample contained no warning or
error events; the separate warning query for the final deployment window was
empty. The adaptive-limit behavior is verified by the regression test; this
final observation does not establish how much it contributed to production
completion or measure a fresh full-Vault upload.

All 237 local Markdown notes were compared with content reconstructed from the
production revision envelopes and 1,457 chunks. SHA-256 checks matched byte for
byte for every note (781,732 bytes), with no missing local files, missing chunks,
content differences or line-ending-only differences. Canonical doc_count and
update_seq remained 1,695.
