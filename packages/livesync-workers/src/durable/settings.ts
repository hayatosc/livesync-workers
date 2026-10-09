// Tuning constants and meta keys of the vault Durable Object's indexing.

export const INDEXED_SEQ_META_KEY = "indexed_seq";
export const INDEX_VERSION_META_KEY = "index_version";
// Bump to force a one-time full re-embed (e.g. when vector metadata gains new fields).
export const CURRENT_INDEX_VERSION = "4";
export const INDEX_BATCH_SIZE = 32;
export const INDEX_ALARM_DELAY_MS = 1_500;
export const INDEX_RETRY_DELAY_MS = 30_000;
export const INDEX_MAX_ATTEMPTS = 20;
// Newest segment the built-in full-text index wrote (shown as fts.generation).
export const FTS_GENERATION_META_KEY = "fts_generation";
// Layout of the built-in index this code writes: "2" = per-note segments,
// "3" = bucketed shards read by range, "4" = same layout, but the build
// streams (0.5.x) so a "failed" verdict recorded by an earlier build no
// longer applies, "5" (0.5.2) clears the verdict a pass that indexed nothing
// used to earn. The whole-vault generation before them had no version
// meta. A change clears that verdict and arms a maintenance pass, which
// rewrites what the new code cannot read efficiently.
export const FTS_INDEX_VERSION_META_KEY = "fts_index_version";
export const CURRENT_FTS_INDEX_VERSION = "5";
export const FTS_REBUILD_AT_META_KEY = "fts_rebuild_at";
// Why the last pass gave up; cleared by the next successful pass.
export const FTS_ERROR_META_KEY = "fts_error";
// Every full-text pass writes a segment (~18 R2 objects), so wait for the
// vault to go quiet before writing one for a burst of edits.
export const FTS_BUILD_DEBOUNCE_MS = 2 * 60_000;
export const FTS_BUILD_RETRY_MS = 60_000;
// One pass indexes at most this much note text (JS code units, what the
// tokenizer walks) into one segment. Measured 2026-09: ~10 bytes of heap and
// ~1.5 s of DO CPU per million code units, so a pass stays well under the
// 128 MB / 30 s Durable Object limits; a big backlog takes several passes.
export const FTS_SEGMENT_MAX_CODE_UNITS = 2_000_000;
export const FTS_SEGMENT_MAX_DOCS = 4_000;
// Ceiling on the whole index (sum of segment text); passes stop with an
// explicit error above it. 50M code units is ~120 MB of Japanese Markdown.
export const FTS_MAX_TOTAL_CODE_UNITS = 50_000_000;
// One note contributes at most this much text (code units): the built-in
// index takes the first part of a longer note, an external one skips it.
// Measured 2026-09: a 2M-code-unit note builds in ~65 MB of heap, so this
// leaves room for the rest of the segment.
export const FTS_MAX_NOTE_CODE_UNITS = 1_000_000;
// A pass that dies from a memory reset leaves no SQLite trace (the event's
// writes roll back), so attempts are counted in the R2 phase marker. After
// this many interrupted attempts the index is disarmed instead of looping.
export const FTS_MAX_BUILD_ATTEMPTS = 3;
// Compaction merges the two smallest segments once there are more than this
// many, as long as the merged text stays under the char bound (one merge per
// alarm event, no re-tokenizing).
export const FTS_COMPACT_MAX_SEGMENTS = 8;
export const FTS_COMPACT_MAX_MERGED_CHARS = 16_000_000;
// Segments count replaced/deleted versions until compaction drops them, and
// the size guard counts them too. A segment is rewritten alone once that
// dead weight is this large (share of its text, and at least this many
// code units), so a vault that is edited a lot does not grow into the guard.
export const FTS_STALE_REWRITE_MIN_RATIO = 0.25;
export const FTS_STALE_REWRITE_MIN_CHARS = 250_000;
// Finding stale text means reading every segment's doc list; skip that while
// the manifest's doc count is within this factor of the live doc count.
export const FTS_STALE_SCAN_DOC_RATIO = 1.2;
// Set by ftsRebuild: segments built before this are retired once every note
// has been re-indexed, and the size guard ignores them meanwhile.
export const FTS_REBUILD_EPOCH_META_KEY = "fts_rebuild_epoch";
// Most candidates one search asks the vault to check against its current state.
export const FTS_RESOLVE_MAX_CANDIDATES = 500;
// External full-text index (VaultBindings.fullText): notes already
// vector-indexed but not yet written there (a fresh setup, or after
// "ftsRebuild") are backfilled this many per alarm run.
export const FTS_BACKLOG_BATCH_SIZE = 16;
// Chunk documents written by the server. The hash salt is a persisted format
// detail (chunk ids are content addressed); keep it stable.
export const WRITE_CHUNK_PREFIX = "h:";
export const WRITE_CHUNK_HASH_SALT = "kuro-chunk";
export const WRITE_CHUNK_CODE_UNITS = 100_000;
