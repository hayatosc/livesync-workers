/**
 * Segment compaction: merge the shards of several segments into one without
 * re-tokenizing. Postings are copied as encoded bytes; only doc ids are
 * remapped (and dropped docs skipped), so memory is the input shards plus the
 * output, never a decoded posting list. Inputs may be format-1 (one gzip
 * stream per shard) or format-2 (bucketed) shards; the output is format 2,
 * which is also how a lone format-1 segment gets upgraded.
 */

import {
  ByteReader,
  ByteWriter,
  bucketForTerm,
  decodeBucket,
  encodeBucketedShard,
  gunzip,
  readShardEntries,
  type BucketedShard,
  type TermEntry,
} from "./codec.js";

export type MergeInput = {
  format: 1 | 2;
  /** The whole shard file, or null when the segment has no such file. */
  data: Uint8Array | null;
  /** Format 2: this shard's bucket offsets from the segment's index.bin. */
  offsets?: Uint32Array;
  /** New doc id per segment-local doc id; -1 drops the doc. Must be ascending over kept docs. */
  remap: Int32Array;
};

/** Entries of one input shard, grouped by bucket and sorted by term within each. */
async function bucketedEntries(input: MergeInput, bucketCount: number): Promise<TermEntry[][]> {
  const buckets: TermEntry[][] = Array.from({ length: bucketCount }, () => []);
  if (!input.data) return buckets;
  if (input.format === 1) {
    for (const entry of readShardEntries(await gunzip(input.data))) {
      buckets[bucketForTerm(entry.term, bucketCount)]!.push(entry);
    }
    return buckets;
  }
  const offsets = input.offsets;
  if (!offsets) throw new Error("mergeShard: format-2 input needs bucket offsets");
  for (let b = 0; b < bucketCount; b += 1) {
    const start = offsets[b]!;
    const end = offsets[b + 1]!;
    if (end <= start) continue;
    buckets[b] = decodeBucket(await gunzip(input.data.subarray(start, end)));
  }
  return buckets;
}

/**
 * Append one entry's postings to `body`, remapping doc ids and dropping
 * docs mapped to -1. Position runs are copied verbatim (they are
 * doc-relative). Returns the kept count and the last doc id written.
 */
function copyPostings(
  entry: TermEntry,
  remap: Int32Array,
  body: ByteWriter,
  prevDoc: number,
): { kept: number; prevDoc: number } {
  const reader = new ByteReader(entry.body);
  let doc = 0;
  let kept = 0;
  for (let d = 0; d < entry.docCount; d += 1) {
    doc += reader.varint();
    const start = reader.offset;
    reader.skipVarints(reader.varint());
    const mapped = remap[doc] ?? -1;
    if (mapped < 0) continue;
    if (mapped < prevDoc || (mapped === prevDoc && (kept > 0 || prevDoc > 0))) {
      throw new Error("mergeShard: remapped docs must stay ascending");
    }
    body.varint(mapped - prevDoc);
    prevDoc = mapped;
    body.bytes(reader.slice(start, reader.offset));
    kept += 1;
  }
  return { kept, prevDoc };
}

/**
 * Merge the same-numbered shard of several segments. Inputs are in doc-id
 * order: every kept doc of input i must map below every kept doc of input
 * i+1 (the natural layout when segments are concatenated).
 */
export async function mergeShard(inputs: MergeInput[], bucketCount: number): Promise<BucketedShard> {
  const perInput = await Promise.all(inputs.map((input) => bucketedEntries(input, bucketCount)));
  const merged: TermEntry[] = [];
  const body = new ByteWriter(4096);
  for (let b = 0; b < bucketCount; b += 1) {
    // Merge-join the sorted term lists of this bucket across inputs.
    const lists = perInput.map((buckets) => buckets[b]!);
    const cursors = lists.map(() => 0);
    for (;;) {
      let term: string | null = null;
      for (let i = 0; i < lists.length; i += 1) {
        const entry = lists[i]![cursors[i]!];
        if (entry && (term === null || entry.term < term)) term = entry.term;
      }
      if (term === null) break;
      body.reset();
      let kept = 0;
      let prevDoc = 0;
      for (let i = 0; i < lists.length; i += 1) {
        const entry = lists[i]![cursors[i]!];
        if (!entry || entry.term !== term) continue;
        cursors[i] = cursors[i]! + 1;
        const copied = copyPostings(entry, inputs[i]!.remap, body, prevDoc);
        kept += copied.kept;
        prevDoc = copied.prevDoc;
      }
      if (kept > 0) merged.push({ term, docCount: kept, body: body.toUint8Array() });
    }
  }
  return encodeBucketedShard(merged, bucketCount);
}
