# Resumable original-file mirror

Implemented in the Worker source. This document describes the code's contract;
it does not indicate a production deployment or a measured memory guarantee.

## Storage and size contract

The authoritative content remains in `content/v1/`. The derived originals retain
Obsidian's folder structure under `files/v1/<tenant>/<vault>/`. No full-file R2
staging prefix, Queue, cron or per-file HTTP request is added.

| Item | Bound |
| --- | --- |
| Actual decoded original | 100 MiB inclusive (104,857,600 bytes) |
| Direct PUT | Complete output at most 8 MiB |
| Multipart part | 8 MiB; only the final part may be smaller |
| Source JSON envelope | 4 MiB of streamed UTF-8 input, including revision/history overhead |
| Source occurrences | 8,192, including repeated children |
| Serialized manifest descriptors | 4 MiB per job |
| Unfinished byte cache | 8 MiB per vault, SQLite pages at most 1 MiB |
| Mirror work per alarm | At most eight paths and 16 MiB of decoded/uploaded work, including retry uploads |
| R2 operations per mirror slice | 64, including discovery, reads, HEAD, uploads and cleanup |
| Cooperative time target | Stop starting another path/part after one second; current bounded work may finish later |
| Change window | Five seconds from the first change, without extension by later changes |

These are separate from the attachment write API's existing 10 MiB limit. Large
legacy inline revisions must fit the envelope bound or be split into LiveSync
children. Actual bytes enforce limits even when declared sizes are missing or
wrong. A valid declared size above the maximum can fail early; a different
actual size fails final validation. Invalid encoding, encryption, compression,
unsafe paths and unsupported structures never replace a previous complete copy.

## Reading, hashes and publication

Capture the root revision and each ordered child's current revision/object key
under the ordinary DO request lock. Persist the immutable manifest in derived
SQLite rows; active references are roots for authoritative content GC. Child
revision changes requeue dependent originals. Root and child generation checks
cancel work after edits, rename, deletion or winner changes.

Read one bounded JSON envelope at a time, allocating from the R2 object's size
and rejecting oversized metadata before reading. Actual streamed bytes are still
checked against the buffer bound. Carry base64 quartets/padding or a
trailing UTF-16 high surrogate across source/string boundaries; preserve UTF-8,
Unicode and newlines as `TextEncoder` does. Decoder pieces are at most 16K code
units, producing at most 48 KiB. Never concatenate a complete file or decode a
complete attachment into memory. Assemble one 8 MiB part, then upload it directly
to the final key's multipart upload. Copy decoded bytes directly into the part;
only an unconsumed remainder crossing a part/budget boundary is base64 encoded
for the persisted cursor.

SHA-256 advances over the decoded bytes in the same pass. The pinned JavaScript
`@stablelib/sha256` 2.0.1 implementation uses its public
[saveState/restoreState API](https://www.stablelib.com/classes/_stablelib_sha256.SHA256.html).
Saved state includes partial-block bytes and a format version. Incompatible
state restarts the job. Dynamic Wasm compilation is unavailable in Workers and
is not required by this implementation.

Persist upload ID, opaque Workers part ETags, per-part MD5, source cursor,
actual length and SHA checkpoint. Acknowledged parts do not reread their source
prefix. A lost part acknowledgement retries identical bytes with the same part
number. Workers binding part ETags are completion tokens, not portable MD5
values: Miniflare deliberately returns random tokens. Check the completed
object's size and multipart ETag against the locally computed MD5 aggregate.
The final [multipart ETag](https://developers.cloudflare.com/r2/objects/upload-objects/#etags)
is distinct from the original's SHA-256. A checksum failure after completion
cannot undo the provider's publication; it prevents successful acknowledgement
and triggers a retry. Small PUTs supply SHA-256 for R2's server-side validation.

Source reads and part uploads release the ordinary request lock. Immediately
before direct PUT or multipart completion, take that lock, validate the epoch
and all input revisions, and hold it through publication and SQL acknowledgement.
This final R2 call can delay a sync request. Maintenance, purge, rebuild and GC
acquire the maintenance lock before the request lock. An epoch guard prevents
writes to derived job state after canonical recovery has reset the mirror.

Files retain their previous complete object until publication succeeds. The
vault as a whole remains eventually consistent, not an atomic folder snapshot.

## Partial progress and recovery

Ordinary successful PUTs/parts do not persist their bytes in SQLite. Only a
forced budget yield or failed upload saves the unfinished part in local pages.
Keep complete pages immutable while appending, and remove them after the part
acknowledgement. If a small file overtakes an active large job but must yield or
fails, discard its partial local job rather than allocate a second byte cache.
It can retry from its bounded source later. The source manifest and hash/cursor
state are separate from this unfinished-byte cache.

All `file_mirror_*` tables bypass canonical SQL journaling and are excluded from
checkpoint table selection. Their loss does not lose authoritative content.
Hash state, decoder carry and unacknowledged bytes survive DO reconstruction.
A process crash may replay one unacknowledged bounded unit. A small PUT lost to
a process crash can be safely repeated; a caught ambiguous PUT retains its
completed digest and is reconciled by HEAD. Incomplete upload creation lost
before its ID is persisted can leave an orphan until R2 lifecycle cleanup.

Before completion, durably save the final digest. After a lost completion
acknowledgement, HEAD verifies job ID, source fingerprint, size and aggregate
ETag, then acknowledges the saved digest without reuploading. An expired or
externally aborted upload restarts from canonical sources. Known abandoned
uploads are aborted in bounded maintenance batches. Jobs restart after 24 hours
without progress or six days of total age; R2's default incomplete multipart
lifecycle aborts uploads after seven days.

A root/ordered-child source fingerprint allows unchanged requeued files to skip
data decoding/upload. After a full SQLite recovery or explicit rebuild, HEAD
can adopt an existing matching format-2 copy. This confirms source identity and
known size, not a fresh byte audit; a missing digest remains unknown in derived
state. A byte audit would require streaming the output separately. No automatic
extra read or re-export is performed just to refill digests.

Small PUT metadata includes `contentHash`. Multipart metadata cannot receive a
late SHA-256 via [complete(parts)](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2multipartupload-definition),
so it includes `mirrorFormat`, `mirrorJobId`, `sourceFingerprint`, `sourceRev`
and optional `mtime`, while SHA-256 remains in DO derived state. Existing
replication, search and attachment APIs continue using authoritative data.

## Scheduling and diagnostics

Checkpoint/search work runs first in the existing alarm. The mirror processes
at most two parts for a path in a pass, rotates the path cursor and permits
bounded small jobs to overtake the one active large job. Four mirror calls are
reserved from further source GETs for publication/progress operations. The
64-call mirror ceiling does not imply a 64-call total for search/checkpoint work.

Permanent error strings include `FILE_TOO_LARGE`, `SOURCE_TOO_LARGE`,
`MANIFEST_TOO_LARGE`, `SIZE_MISMATCH`, `INVALID_ENCODING` and
`UNSUPPORTED_CONTENT`. Missing chunks wait for changes. Transient errors persist
a full-jitter exponential retry deadline: base five seconds, capped at fifteen
minutes. No alarm sleeps for backoff. A retry before its deadline does not count
as runnable work, so reads preserve its alarm and unrelated edits retain the
five-second batching window. New committed source changes clear the delay.
The implementation does not interpret provider Retry-After values.

Existing `indexStatus`/`vaultStatus` mirror counters also expose `stale` and
`active` (path, phase, decoded/uploaded bytes and target revision). `saved` means
the current desired source fingerprint was acknowledged. A previously saved
pending/error path is stale. Unknown pre-recovery copies are not counted as
acknowledged stale copies. Detailed errors remain in `file_mirror_state`.
On the format upgrade, files blocked by the previous mirror-size limit are
requeued automatically; permanent unrelated errors remain blocked.

## R2 and DO costs

For P = ceil(file size / 8 MiB) and C source GETs, the successful large-file base
cost is P uploadPart + create/complete + C reads. Add discovery, HEAD, root
reads, partial-source rereads and retries separately. A successful 100 MiB export
has 13 parts, one create and one complete. Direct small PUT uses one write.

| Strategy | Class A operations | Class B operations |
| --- | --- | --- |
| Direct multipart (selected) | P + 2 | C |
| Full R2 staging then publication | 2P + 2 | C + P |
| Hash first, reread then publish | P + 2 | 2C |

A single streamed whole-file PUT has fewer operations, but cannot checkpoint its
open request across alarms or keep the fragmented-source call budget. Retries
would reread the entire file. Direct multipart avoids staging and a deliberate
full second source pass; interruptions can reread the current envelope.

[R2 Standard rates](https://developers.cloudflare.com/r2/pricing/) checked on
2026-10-09 are $4.50/million Class A and $0.36/million Class B. At P=13 and C=2,000,
proportional operation costs are $0.00078750 direct, $0.00085068 staged and
$0.00150750 two-pass, before free usage, billing-unit rounding, storage and
Workers/DO costs. Direct saves about 7.4% of R2 operation cost versus staging in
this example. Source GETs still dominate; this is not an invoice prediction.

[DO SQLite](https://developers.cloudflare.com/durable-objects/platform/pricing/)
cache pages, manifests, progress and deletes incur metered rows and storage.
The cache is not free staging. DO active duration includes I/O waiting and bills
allocated memory. Measure actual source calls, retries, cache rows, alarm count
and duration before claiming a workload's total cost reduction.

## Validation and qualification

Workers tests cover exact streamed SHA-256 for 0 bytes, 1/8/20/50/100 MiB, 8 MiB + 1 byte and
10 MiB + 1 byte, including repeated source references. They reject 100 MiB+1 byte
and wrong declared sizes while preserving the old copy. They also cover missing
chunks/eden, UTF-8 paths, source boundaries, concurrent edits, purge, rebuild,
byte/call budgets, small-file progress and reconstruction after lost part and
completion acknowledgements. Known SHA-256 vectors and decoder boundary tests
run separately. Cache rows are asserted absent from canonical commits and
checkpoint dirty tracking.

[Workers' 128 MB limit](https://developers.cloudflare.com/workers/platform/limits/#memory)
is shared per isolate, not a per-file allowance. Bounded arrays/reads do not
prove a heap ceiling: JSON strings, parsed descriptors, GC and runtime buffering
also consume memory. The 100 MiB functional tests are not a peak-memory
measurement. No synchronous heap circuit breaker is claimed.

Production qualification should measure a 100 MiB chunked file with two vault
exports, ordinary bulk sync and checkpoint/search work, recording baseline,
peak, runtime version, operation counts and duration. Engineering targets remain
at most 32 MiB extra live memory for one job and below 96 MiB total isolate use.
These targets have not been measured here. Production deployment and bucket
lifecycle verification are separate from this source implementation.
