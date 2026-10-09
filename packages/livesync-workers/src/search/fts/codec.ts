/**
 * Binary codec for shard files: LEB128 varints, delta-encoded posting lists,
 * gzip via CompressionStream (available in Workers and Node 18+).
 *
 * Shard layout (before gzip):
 *   magic "KFTS", format version varint, term count varint, then per term:
 *     term byte length varint, term bytes (UTF-8), doc count varint, per doc:
 *       docId delta varint, position count varint, position delta varints
 */

export const SHARD_FORMAT_VERSION = 1;

const MAGIC = [0x4b, 0x46, 0x54, 0x53]; // "KFTS"

export type Posting = { doc: number; positions: number[] };

/** Postings already in shard byte form (everything after the doc count). */
export type EncodedPostings = { docCount: number; body: Uint8Array };

export class ByteWriter {
  private buf: Uint8Array;
  private len = 0;

  constructor(initialCapacity = 1024) {
    this.buf = new Uint8Array(initialCapacity);
  }

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(value: number): void {
    this.ensure(1);
    this.buf[this.len] = value & 0xff;
    this.len += 1;
  }

  varint(value: number): void {
    if (value < 0 || !Number.isSafeInteger(value)) {
      throw new Error(`varint out of range: ${value}`);
    }
    this.ensure(10);
    let v = value;
    while (v >= 0x80) {
      this.buf[this.len] = (v & 0x7f) | 0x80;
      this.len += 1;
      v = Math.floor(v / 128);
    }
    this.buf[this.len] = v;
    this.len += 1;
  }

  bytes(data: Uint8Array): void {
    this.ensure(data.length);
    this.buf.set(data, this.len);
    this.len += data.length;
  }

  get length(): number {
    return this.len;
  }

  /** Forget everything written so far (keeps the buffer). */
  reset(): void {
    this.len = 0;
  }

  /** The written bytes as a view; invalid after the next write. */
  view(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }

  /** A 5-byte varint (values below 2^35) whose slot can be patched later. */
  fixedVarint(value: number): void {
    this.ensure(5);
    this.writeFixedVarint(this.len, value);
    this.len += 5;
  }

  patchFixedVarint(at: number, value: number): void {
    this.writeFixedVarint(at, value);
  }

  private writeFixedVarint(at: number, value: number): void {
    if (value < 0 || value >= 2 ** 35) throw new Error(`fixed varint out of range: ${value}`);
    let v = value;
    for (let i = 0; i < 5; i += 1) {
      const last = i === 4;
      this.buf[at + i] = (v % 128) | (last ? 0 : 0x80);
      v = Math.floor(v / 128);
    }
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export class ByteReader {
  private pos = 0;
  private readonly buf: Uint8Array;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  get eof(): boolean {
    return this.pos >= this.buf.length;
  }

  /** Current read offset, for slicing already-encoded runs back out. */
  get offset(): number {
    return this.pos;
  }

  /** Raw bytes between two offsets (a view, not a copy). */
  slice(start: number, end: number): Uint8Array {
    return this.buf.subarray(start, end);
  }

  /** Skip `count` varints without decoding them. */
  skipVarints(count: number): void {
    for (let i = 0; i < count; i += 1) {
      while ((this.u8() & 0x80) !== 0) {
        // continue
      }
    }
  }

  u8(): number {
    if (this.pos >= this.buf.length) throw new Error("Unexpected end of shard data");
    const value = this.buf[this.pos]!;
    this.pos += 1;
    return value;
  }

  varint(): number {
    let value = 0;
    let shift = 1;
    for (;;) {
      const byte = this.u8();
      value += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) return value;
      shift *= 128;
    }
  }

  bytes(length: number): Uint8Array {
    if (this.pos + length > this.buf.length) {
      throw new Error("Unexpected end of shard data");
    }
    const slice = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return slice;
  }
}

export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  const bytes = new TextEncoder().encode(text);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function shardForTerm(term: string, shardCount: number): number {
  return fnv1a(term) % shardCount;
}

export function encodePostings(writer: ByteWriter, postings: Posting[]): void {
  let prevDoc = 0;
  for (const posting of postings) {
    writer.varint(posting.doc - prevDoc);
    prevDoc = posting.doc;
    writer.varint(posting.positions.length);
    let prevPos = 0;
    for (const pos of posting.positions) {
      writer.varint(pos - prevPos);
      prevPos = pos;
    }
  }
}

/**
 * Entries may carry decoded postings or bytes pre-encoded by PostingsBuilder;
 * both produce the same shard bytes. Entries are sorted by term here.
 */
export function encodeShard(entries: Iterable<[string, Posting[] | EncodedPostings]>): Uint8Array {
  const writer = new ByteWriter();
  for (const byte of MAGIC) writer.u8(byte);
  writer.varint(SHARD_FORMAT_VERSION);
  const list = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  writer.varint(list.length);
  const encoder = new TextEncoder();
  for (const [term, postings] of list) {
    const termBytes = encoder.encode(term);
    writer.varint(termBytes.length);
    writer.bytes(termBytes);
    if (Array.isArray(postings)) {
      writer.varint(postings.length);
      encodePostings(writer, postings);
    } else {
      writer.varint(postings.docCount);
      writer.bytes(postings.body);
    }
  }
  return writer.toUint8Array();
}

export function decodeShard(data: Uint8Array): Map<string, Posting[]> {
  const reader = new ByteReader(data);
  for (const byte of MAGIC) {
    if (reader.u8() !== byte) throw new Error("Bad shard magic");
  }
  const version = reader.varint();
  if (version !== SHARD_FORMAT_VERSION) {
    throw new Error(`Unsupported shard format version ${version}`);
  }
  const termCount = reader.varint();
  const decoder = new TextDecoder();
  const result = new Map<string, Posting[]>();
  for (let t = 0; t < termCount; t += 1) {
    const term = decoder.decode(reader.bytes(reader.varint()));
    const docCount = reader.varint();
    const postings: Posting[] = [];
    let doc = 0;
    for (let d = 0; d < docCount; d += 1) {
      doc += reader.varint();
      const posCount = reader.varint();
      const positions: number[] = [];
      let pos = 0;
      for (let p = 0; p < posCount; p += 1) {
        pos += reader.varint();
        positions.push(pos);
      }
      postings.push({ doc, positions });
    }
    result.set(term, postings);
  }
  return result;
}

async function pipeThrough(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const response = new Response(source.pipeThrough(stream));
  return new Uint8Array(await response.arrayBuffer());
}

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  return pipeThrough(data, new CompressionStream("gzip"));
}

export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  return pipeThrough(data, new DecompressionStream("gzip"));
}

// ---------------------------------------------------------------------------
// Shard format 2: buckets
//
// A format-2 shard file is a plain concatenation of independently gzipped
// buckets; the segment's index.bin holds each bucket's byte range, so a
// search reads only the buckets its terms hash into (R2 range reads) instead
// of the whole shard. Terms are assigned by the bits of fnv1a above the shard
// bits, so the two splits are independent.
//
// Bucket layout (before gzip):
//   term count varint, then per term (sorted by term):
//     term byte length varint, term bytes, doc count varint,
//     body byte length varint, body (docId/position delta varints, as in v1)
// ---------------------------------------------------------------------------

export const SHARD_FORMAT_VERSION_2 = 2;
export const DEFAULT_BUCKET_COUNT = 64;

export function bucketForTerm(term: string, bucketCount: number): number {
  return Math.floor(fnv1a(term) / 16) % bucketCount;
}

/** One term's postings in their encoded form. */
export type TermEntry = { term: string; docCount: number; body: Uint8Array };

export function encodeBucket(entries: TermEntry[]): Uint8Array {
  const writer = new ByteWriter();
  const encoder = new TextEncoder();
  const sorted = [...entries].sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
  writer.varint(sorted.length);
  for (const entry of sorted) {
    const termBytes = encoder.encode(entry.term);
    writer.varint(termBytes.length);
    writer.bytes(termBytes);
    writer.varint(entry.docCount);
    writer.varint(entry.body.length);
    writer.bytes(entry.body);
  }
  return writer.toUint8Array();
}

/** All entries of a (gunzipped) bucket, bodies as views into `data`. */
export function decodeBucket(data: Uint8Array): TermEntry[] {
  const reader = new ByteReader(data);
  const decoder = new TextDecoder();
  const count = reader.varint();
  const entries: TermEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const term = decoder.decode(reader.bytes(reader.varint()));
    const docCount = reader.varint();
    const body = reader.bytes(reader.varint());
    entries.push({ term, docCount, body });
  }
  return entries;
}

/** Postings of the wanted terms in a (gunzipped) bucket; terms not present map to []. */
export function decodeBucketTerms(data: Uint8Array, wanted: Iterable<string>): Map<string, Posting[]> {
  const want = new Set(wanted);
  const result = new Map<string, Posting[]>();
  for (const term of want) result.set(term, []);
  for (const entry of decodeBucket(data)) {
    if (!want.has(entry.term)) continue;
    result.set(entry.term, decodePostings(entry.body, entry.docCount));
  }
  return result;
}

export function decodePostings(body: Uint8Array, docCount: number): Posting[] {
  const reader = new ByteReader(body);
  const postings: Posting[] = [];
  let doc = 0;
  for (let d = 0; d < docCount; d += 1) {
    doc += reader.varint();
    const posCount = reader.varint();
    const positions: number[] = [];
    let pos = 0;
    for (let p = 0; p < posCount; p += 1) {
      pos += reader.varint();
      positions.push(pos);
    }
    postings.push({ doc, positions });
  }
  return postings;
}

/** Entries of a format-1 shard (gunzipped) without decoding the postings. */
export function readShardEntries(data: Uint8Array): TermEntry[] {
  const reader = new ByteReader(data);
  for (const byte of MAGIC) {
    if (reader.u8() !== byte) throw new Error("Bad shard magic");
  }
  const version = reader.varint();
  if (version !== SHARD_FORMAT_VERSION) {
    throw new Error(`Unsupported shard format version ${version}`);
  }
  const termCount = reader.varint();
  const decoder = new TextDecoder();
  const entries: TermEntry[] = [];
  for (let t = 0; t < termCount; t += 1) {
    const term = decoder.decode(reader.bytes(reader.varint()));
    const docCount = reader.varint();
    const start = reader.offset;
    for (let d = 0; d < docCount; d += 1) {
      reader.varint(); // doc delta
      reader.skipVarints(reader.varint());
    }
    entries.push({ term, docCount, body: reader.slice(start, reader.offset) });
  }
  return entries;
}

export type BucketedShard = {
  /** Concatenated gzipped buckets. */
  data: Uint8Array;
  /** Byte offset of each bucket, plus the total length (bucketCount + 1 entries). */
  offsets: Uint32Array;
};

/** Group entries into buckets and gzip each; empty buckets take no bytes. */
export async function encodeBucketedShard(entries: Iterable<TermEntry>, bucketCount: number): Promise<BucketedShard> {
  const buckets: TermEntry[][] = Array.from({ length: bucketCount }, () => []);
  for (const entry of entries) buckets[bucketForTerm(entry.term, bucketCount)]!.push(entry);
  const compressed = await Promise.all(
    buckets.map((bucket) => (bucket.length === 0 ? null : gzip(encodeBucket(bucket)))),
  );
  const offsets = new Uint32Array(bucketCount + 1);
  let total = 0;
  compressed.forEach((chunk, i) => {
    offsets[i] = total;
    total += chunk?.length ?? 0;
  });
  offsets[bucketCount] = total;
  const data = new Uint8Array(total);
  compressed.forEach((chunk, i) => {
    if (chunk) data.set(chunk, offsets[i]!);
  });
  return { data, offsets };
}

/**
 * index.bin: for each shard, bucketCount + 1 little-endian u32 offsets.
 * Read with {@link decodeSegmentIndex}.
 */
export function encodeSegmentIndex(shards: BucketedShard[], bucketCount: number): Uint8Array {
  const out = new Uint8Array(shards.length * (bucketCount + 1) * 4);
  const view = new DataView(out.buffer);
  shards.forEach((shard, s) => {
    for (let b = 0; b <= bucketCount; b += 1) {
      view.setUint32((s * (bucketCount + 1) + b) * 4, shard.offsets[b]!, true);
    }
  });
  return out;
}

export function decodeSegmentIndex(data: Uint8Array, shardCount: number, bucketCount: number): Uint32Array[] {
  const stride = bucketCount + 1;
  if (data.length !== shardCount * stride * 4) {
    throw new Error(`FTS segment index has ${data.length} bytes, expected ${shardCount * stride * 4}`);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const shards: Uint32Array[] = [];
  for (let s = 0; s < shardCount; s += 1) {
    const offsets = new Uint32Array(stride);
    for (let b = 0; b < stride; b += 1) offsets[b] = view.getUint32((s * stride + b) * 4, true);
    shards.push(offsets);
  }
  return shards;
}
