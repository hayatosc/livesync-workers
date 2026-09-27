import {
  DEFAULT_BUCKET_COUNT,
  encodeBucketedShard,
  encodeSegmentIndex,
  encodeShard,
  gzip,
  type BucketedShard,
} from "./codec.js";
import { PostingsBuilder } from "./postings.js";
import { normalizeText, tokenize } from "./tokenize.js";

export const DEFAULT_SHARD_COUNT = 16;

export type FtsDocInput = {
  path: string;
  content: string;
  title?: string;
  mtime?: number;
  /**
   * Content hash (sha256 hex) of `content`. Segments are immutable, so a
   * search checks each hit's (path, hash) against the vault's current state
   * to drop versions that were replaced or deleted since the segment was built.
   */
  hash?: string;
};

/** Entry in docs.json.gz; the docId is the array index (segment-local). */
export type FtsDocMeta = {
  path: string;
  title?: string;
  /** Normalized char count (BM25 document length). */
  chars: number;
  mtime?: number;
  /** Content hash the segment was built from; absent in legacy generations. */
  hash?: string;
};

export type FtsBuildResult = {
  /** Segment-relative name (e.g. "shard-003.bin") to file body. */
  files: Map<string, Uint8Array>;
  docs: FtsDocMeta[];
  stats: { docCount: number; totalChars: number; termCount: number; postingCount: number };
};

/** Shard file name: format 1 is one gzip stream, format 2 a bucketed file read by range. */
export function shardFileName(shard: number, format: 1 | 2 = 2): string {
  const stem = `shard-${String(shard).padStart(3, "0")}.bin`;
  return format === 1 ? `${stem}.gz` : stem;
}

export const DOCS_FILE_NAME = "docs.json.gz";
/** Bucket byte ranges of every shard (format 2 only). */
export const INDEX_FILE_NAME = "index.bin";

/**
 * Build one complete segment in memory. Pure apart from gzip; callers decide
 * the segment id and where the files live (R2, disk, memory). Memory is
 * dominated by the encoded postings (a few bytes per code point) plus
 * per-term bookkeeping; see PostingsBuilder.
 */
export async function buildIndex(
  inputs: Iterable<FtsDocInput> | AsyncIterable<FtsDocInput>,
  options: { shardCount?: number; bucketCount?: number; format?: 1 | 2 } = {},
): Promise<FtsBuildResult> {
  const shardCount = options.shardCount ?? DEFAULT_SHARD_COUNT;
  const bucketCount = options.bucketCount ?? DEFAULT_BUCKET_COUNT;
  const format = options.format ?? 2;
  const postings = new PostingsBuilder(shardCount);
  const docs: FtsDocMeta[] = [];
  let totalChars = 0;
  let postingCount = 0;

  // Inputs may be a lazy generator so callers can read one note at a time
  // instead of holding every body in memory alongside the postings.
  for await (const input of inputs) {
    const docId = docs.length;
    const { chars } = normalizeText(input.content);
    docs.push({
      path: input.path,
      ...(input.title !== undefined ? { title: input.title } : {}),
      chars: chars.length,
      ...(input.mtime !== undefined ? { mtime: input.mtime } : {}),
      ...(input.hash !== undefined ? { hash: input.hash } : {}),
    });
    totalChars += chars.length;

    const positionsByTerm = new Map<string, number[]>();
    for (const token of tokenize(chars, "index")) {
      let positions = positionsByTerm.get(token.term);
      if (!positions) {
        positions = [];
        positionsByTerm.set(token.term, positions);
      }
      positions.push(token.pos);
    }
    for (const [term, positions] of positionsByTerm) {
      // Tokens are emitted in ascending position order per mode section, but
      // index-mode boundary unigrams arrive after the bigrams; keep sorted.
      positions.sort((a, b) => a - b);
      postings.add(term, docId, positions);
      postingCount += positions.length;
    }
  }

  const files = new Map<string, Uint8Array>();
  const shards: BucketedShard[] = [];
  for (let shard = 0; shard < shardCount; shard += 1) {
    if (format === 1) {
      // The 0.3.0 layout, kept for tests of the upgrade path.
      files.set(shardFileName(shard, 1), await gzip(encodeShard(postings.shardEntries(shard))));
      continue;
    }
    const entries = Array.from(postings.shardEntries(shard), ([term, encoded]) => ({
      term,
      docCount: encoded.docCount,
      body: encoded.body,
    }));
    const bucketed = await encodeBucketedShard(entries, bucketCount);
    shards.push(bucketed);
    files.set(shardFileName(shard), bucketed.data);
  }
  if (format === 2) files.set(INDEX_FILE_NAME, encodeSegmentIndex(shards, bucketCount));
  files.set(
    DOCS_FILE_NAME,
    await gzip(new TextEncoder().encode(JSON.stringify({ docs }))),
  );

  return {
    files,
    docs,
    stats: {
      docCount: docs.length,
      totalChars,
      termCount: postings.termCount,
      postingCount,
    },
  };
}
