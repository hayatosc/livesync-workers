# Original files in R2

The Worker automatically saves the latest reconstructable files in
`CONTENT_BUCKET`, using their original vault-relative paths:

```text
files/v1/<encoded-owner>/<encoded-vaultId>/
  Notes/Example.md
  Images/photo.png
  Attachments/document.pdf
  .obsidian/settings.json
```

The owner and immutable vault ID are URL-encoded. File paths retain their
original spelling, case, Unicode characters and folder structure. LiveSync's
`i:` prefix for internal files is removed. Markdown and other `plain` files
contain UTF-8 text; `newnote` attachments contain decoded binary bytes, rather
than JSON or base64. Relative attachment links remain unchanged.

These objects are **derived copies of the latest winning revisions**. The
revision objects, commit chain and head under `content/v1/` remain authoritative
for replication and recovery. Conflicting revisions and historical versions
remain there; the file mirror contains only the current winner for each path.
Content GC does not collect the separate `files/v1/` prefix.

## Updates and recovery

DO alarms discover and export files in bounded batches. Once caught up, the
mirror collects changes for five seconds from the first committed change. Later
edits do not extend this deadline, and only the latest complete winner for each
path is exported. Search indexing and authoritative sync commits keep their own
timing. Initial backfills and queued batches continue without this delay.

Each pass visits at most eight files, handles at most 16 MiB of content and
issues at most 64 mirror R2 operations, starting no further file after one
second. Reads and uploads may finish after
that time budget; files are decoded one part at a time. Checkpoint and search
work run first. Remaining files stay queued for the next alarm. Creating or editing a file queues a replacement, and
deletion removes its copy. A changed path removes the old copy and writes the
new one. Existing vaults are backfilled on their next
access. A file whose chunks have not arrived waits until the missing chunks are
received. While an update is incomplete, its last complete copy can remain.

Source reads and multipart part uploads release the normal request lock, so
replication can proceed during those calls. Final PUT/completion holds the lock
after validating the source revisions, preventing a stale job from publishing
after a newer committed edit. An edit cancels old multipart work. Upload
failures are retried without rejecting an already committed sync write or
preventing search/checkpoint maintenance. Each copy is eventually consistent;
the folder as a whole is not an atomic snapshot of the vault.

After rebuilding SQLite from the R2 journal, the mirror scans existing copy keys
and current documents. It replaces missing or stale copies and removes keys for
files no longer present. Purging a vault removes its mirrored files while
preserving other vaults' copies and the existing recovery history.

`vaultStatus` and `indexStatus` include `index.fileMirror` or `fileMirror`, with:

- `prefix`: the vault's file prefix.
- `saved`: files successfully exported.
- `pending`: queued files, missing chunks, and retryable storage failures.
- `errors`: unsupported files and retryable storage failures.
- `rebuilding`: whether the initial R2/current-document scan is incomplete.
- `stale`: pending/error paths retaining a previously acknowledged copy.
- `active`: a resumable job's path, phase, decoded/uploaded bytes and target revision, or `null`.

The counters describe work discovered so far; additional files can be found in
later scan batches. During an edit, a previous copy may still exist even though
the file is counted as pending. Detailed per-file errors are stored in the DO's
derived `file_mirror_state` table.

An authenticated host can request a fresh scan with the internal
`POST /internal/op` operation `{"op":"filesRebuild"}`. It requires the same
internal secret and trusted vault identity as other internal operations, and
returns `{"ok":true,"pending":true}`. It is not a public LiveSync endpoint.
This also recreates copies manually removed from R2.

## Supported files and limits

The mirror supports the unencrypted, uncompressed `plain` and base64 `newnote`
documents used by the generated connection settings. Encrypted chunks, encrypted
inline chunks, compressed data and unsupported binary encodings are not exported
as if they were original content. They are reported as errors. There is no
server-side decryption or decompression.

Each exported file is limited to **100 MiB of actual decoded bytes**. The
attachment write API retains its separate 10 MiB limit. Files up to 8 MiB use a
single PUT; larger files use resumable 8 MiB multipart parts. A revision's JSON
envelope must fit 4 MiB; legacy whole-file inline revisions exceeding this must
be split into LiveSync chunks. At most 8,192 source occurrences and 4 MiB of
manifest descriptors are accepted. Incorrect declared sizes are rejected.

Invalid paths and keys exceeding R2's
[1,024-byte key limit](https://developers.cloudflare.com/r2/platform/limits/)
are rejected. Validation failures retain an older complete copy and leave the
authoritative revision data intact. Storage errors use persisted jittered
exponential backoff, up to fifteen minutes; a new source revision requeues them.

Objects have a content type, `mirrorFormat: "2"`, a source fingerprint/revision
and an optional `mtime` custom metadata field. Small direct PUTs also have a
SHA-256 `contentHash`. Multipart objects omit `contentHash`: their actual output
SHA-256 is retained in the derived DO state, avoiding a second source pass or a
full R2 staging copy. After complete SQLite recovery, an existing matching
format-2 copy can be adopted with digest unknown. Unknown extensions use
`application/octet-stream`. See the [large-file implementation specification](file-mirror-large-files.md)
for recovery, budgets, cost accounting and qualification limits.

Original timestamps are metadata; the R2 upload timestamp reflects the copy's
upload time.

The mirror uses the existing private content bucket and adds storage and R2
operations. It does not enable public bucket access or introduce a file download
endpoint. Bucket credentials grant access to these plain file copies, including
synced hidden files. Keep the bucket private as for the authoritative data.

For library hosts, set `VaultBindings.fileMirror: true` alongside `contentBucket`
to enable the same behavior. Hosts that omit it retain their existing behavior.
