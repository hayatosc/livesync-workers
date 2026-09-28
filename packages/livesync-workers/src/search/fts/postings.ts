/**
 * Incrementally encoded posting lists for the index build.
 *
 * The naive build kept `{ doc, positions: number[] }` objects for every
 * (term, doc) pair and ran at roughly 150 bytes of heap per indexed code
 * point, which is what put a 2M-code-point vault past the Durable Object's
 * 128 MB limit. Here every posting is written straight into its final
 * delta-varint form as documents stream through in ascending docId order, so
 * memory is the encoded size (a few bytes per code point) plus one small
 * bookkeeping slot per distinct term.
 *
 * Per-term bytes live in a chunked arena (fixed-size slots linked by index)
 * instead of one growable buffer per term, so a vocabulary of a few hundred
 * thousand terms does not cost a JS object and an ArrayBuffer each.
 */

import { ByteWriter, shardForTerm, type EncodedPostings } from "./codec.js";

const CHUNK_BYTES = 32;
// Doc-local (term id, position) pairs are packed into one double so the
// per-doc sort is a native numeric typed-array sort: id * POS_SPACE + pos.
const POS_SPACE = 2 ** 24;

export class PostingsBuilder {
  private readonly ids = new Map<string, number>();
  private readonly names: string[] = [];
  private readonly shards: number[] = [];
  private readonly docCount: number[] = [];
  private readonly prevDoc: number[] = [];
  private readonly head: number[] = [];
  private readonly tail: number[] = [];
  private readonly tailUsed: number[] = [];
  private arena = new Uint8Array(CHUNK_BYTES * 1024);
  private next = new Int32Array(1024);
  private chunkCount = 0;
  private bytes = 0;
  private readonly maxTerms: number;
  // Tokens of the doc being collected (see collect/commitDoc), reused across docs.
  private docKeys = new Float64Array(1024);
  private docLen = 0;

  constructor(
    private readonly shardCount: number,
    options: {
      /** Distinct terms the builder may hold; collect() refuses past this (see commitDoc). */
      maxTerms?: number;
    } = {},
  ) {
    this.maxTerms = options.maxTerms ?? Number.POSITIVE_INFINITY;
  }

  get termCount(): number {
    return this.names.length;
  }

  /** Encoded posting bytes so far (before per-term headers and gzip). */
  get encodedBytes(): number {
    return this.bytes;
  }

  /** Docs must arrive in ascending order; positions must be sorted ascending. */
  add(term: string, doc: number, positions: number[]): void {
    const id = this.intern(term);
    if (id < 0) throw new Error(`PostingsBuilder: more than ${this.maxTerms} distinct terms`);
    this.beginPosting(id, doc, positions.length);
    let prev = 0;
    for (const pos of positions) {
      this.varint(id, pos - prev);
      prev = pos;
    }
  }

  /**
   * Record one token of the doc being collected; commitDoc() writes the
   * doc's postings grouped by term. Tokens may arrive in any order. Returns
   * false (recording nothing) when the term would be a new one past
   * `maxTerms`: the caller then abortDoc()s, since a doc of mostly unique
   * terms (random-looking text) costs bookkeeping per term, not per byte.
   */
  collect(term: string, pos: number): boolean {
    if (pos < 0 || pos >= POS_SPACE) throw new Error(`PostingsBuilder: position out of range: ${pos}`);
    const id = this.intern(term);
    if (id < 0) return false;
    if (this.docLen === this.docKeys.length) {
      const grown = new Float64Array(this.docKeys.length * 2);
      grown.set(this.docKeys);
      this.docKeys = grown;
    }
    this.docKeys[this.docLen] = id * POS_SPACE + pos;
    this.docLen += 1;
    return true;
  }

  /** Write the collected tokens as doc `doc`'s postings; returns how many. Docs must be committed in ascending order. */
  commitDoc(doc: number): number {
    const keys = this.docKeys.subarray(0, this.docLen);
    keys.sort();
    let i = 0;
    while (i < keys.length) {
      const id = Math.floor(keys[i]! / POS_SPACE);
      let end = i + 1;
      while (end < keys.length && Math.floor(keys[end]! / POS_SPACE) === id) end += 1;
      this.beginPosting(id, doc, end - i);
      let prev = 0;
      for (let k = i; k < end; k += 1) {
        const pos = keys[k]! - id * POS_SPACE;
        this.varint(id, pos - prev);
        prev = pos;
      }
      i = end;
    }
    const count = this.docLen;
    this.docLen = 0;
    return count;
  }

  /** Forget the collected tokens of the current doc (terms it interned stay, unused). */
  abortDoc(): void {
    this.docLen = 0;
  }

  /** Slot of a term, allocating one unless that would exceed maxTerms (then -1). */
  private intern(term: string): number {
    let id = this.ids.get(term);
    if (id === undefined) {
      if (this.names.length >= this.maxTerms) return -1;
      id = this.names.length;
      this.ids.set(term, id);
      this.names.push(term);
      this.shards.push(shardForTerm(term, this.shardCount));
      this.docCount.push(0);
      this.prevDoc.push(0);
      const chunk = this.allocChunk();
      this.head.push(chunk);
      this.tail.push(chunk);
      this.tailUsed.push(0);
    }
    return id;
  }

  private beginPosting(id: number, doc: number, positionCount: number): void {
    if (doc < this.prevDoc[id]! && this.docCount[id]! > 0) {
      throw new Error("PostingsBuilder: docs must be added in ascending order");
    }
    this.varint(id, doc - this.prevDoc[id]!);
    this.prevDoc[id] = doc;
    this.varint(id, positionCount);
    this.docCount[id] = this.docCount[id]! + 1;
  }

  /** Terms of one shard, sorted, with their encoded postings (terms no doc ended up using are left out). */
  *shardEntries(shard: number): IterableIterator<[string, EncodedPostings]> {
    const ids: number[] = [];
    for (let id = 0; id < this.names.length; id += 1) {
      if (this.shards[id] === shard && this.docCount[id]! > 0) ids.push(id);
    }
    ids.sort((a, b) => {
      const x = this.names[a]!;
      const y = this.names[b]!;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    for (const id of ids) {
      yield [this.names[id]!, { docCount: this.docCount[id]!, body: this.collectBytes(id) }];
    }
  }

  private collectBytes(id: number): Uint8Array {
    const writer = new ByteWriter();
    let chunk = this.head[id]!;
    const last = this.tail[id]!;
    while (chunk !== last) {
      writer.bytes(this.arena.subarray(chunk * CHUNK_BYTES, (chunk + 1) * CHUNK_BYTES));
      chunk = this.next[chunk]!;
    }
    writer.bytes(this.arena.subarray(last * CHUNK_BYTES, last * CHUNK_BYTES + this.tailUsed[id]!));
    return writer.toUint8Array();
  }

  private varint(id: number, value: number): void {
    if (value < 0 || !Number.isSafeInteger(value)) {
      throw new Error(`varint out of range: ${value}`);
    }
    let v = value;
    while (v >= 0x80) {
      this.byte(id, (v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    this.byte(id, v);
  }

  private byte(id: number, value: number): void {
    let used = this.tailUsed[id]!;
    if (used === CHUNK_BYTES) {
      const chunk = this.allocChunk();
      this.next[this.tail[id]!] = chunk;
      this.tail[id] = chunk;
      used = 0;
    }
    this.arena[this.tail[id]! * CHUNK_BYTES + used] = value;
    this.tailUsed[id] = used + 1;
    this.bytes += 1;
  }

  private allocChunk(): number {
    if (this.chunkCount === this.next.length) {
      const arena = new Uint8Array(this.arena.length * 2);
      arena.set(this.arena);
      this.arena = arena;
      const next = new Int32Array(this.next.length * 2);
      next.set(this.next);
      this.next = next;
    }
    const chunk = this.chunkCount;
    this.chunkCount += 1;
    this.next[chunk] = -1;
    return chunk;
  }
}
