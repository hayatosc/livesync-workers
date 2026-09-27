/**
 * Segment compaction: merge the shards of several segments into one without
 * re-tokenizing. Postings are copied as encoded bytes; only doc ids are
 * remapped (and dropped docs skipped), so memory is the input shards plus the
 * output, never a decoded posting list.
 */

import { ByteReader, ByteWriter, SHARD_FORMAT_VERSION } from "./codec.js";

const MAGIC = [0x4b, 0x46, 0x54, 0x53]; // "KFTS"

export type MergeInput = {
  /** Raw (gunzipped) shard bytes, or null when the segment has no such shard file. */
  data: Uint8Array | null;
  /** New doc id per segment-local doc id; -1 drops the doc. Must be ascending over kept docs. */
  remap: Int32Array;
};

type Cursor = {
  reader: ByteReader;
  remaining: number;
  term: string;
  docCount: number;
  remap: Int32Array;
};

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function openCursor(input: MergeInput): Cursor | null {
  if (!input.data) return null;
  const reader = new ByteReader(input.data);
  for (const byte of MAGIC) {
    if (reader.u8() !== byte) throw new Error("Bad shard magic");
  }
  const version = reader.varint();
  if (version !== SHARD_FORMAT_VERSION) {
    throw new Error(`Unsupported shard format version ${version}`);
  }
  const cursor: Cursor = {
    reader,
    remaining: reader.varint(),
    term: "",
    docCount: 0,
    remap: input.remap,
  };
  return advance(cursor) ? cursor : null;
}

/** Read the next term header; false at the end of the shard. */
function advance(cursor: Cursor): boolean {
  if (cursor.remaining === 0) return false;
  cursor.remaining -= 1;
  cursor.term = decoder.decode(cursor.reader.bytes(cursor.reader.varint()));
  cursor.docCount = cursor.reader.varint();
  return true;
}

/**
 * Copy one term's postings from a cursor into `body`, remapping doc ids.
 * Returns how many docs were kept. Position runs are copied verbatim since
 * positions are doc-relative.
 */
function copyPostings(cursor: Cursor, body: ByteWriter, prevDoc: number): { kept: number; prevDoc: number } {
  const { reader, remap } = cursor;
  let doc = 0;
  let kept = 0;
  for (let d = 0; d < cursor.docCount; d += 1) {
    doc += reader.varint();
    const start = reader.offset;
    const posCount = reader.varint();
    reader.skipVarints(posCount);
    const mapped = remap[doc] ?? -1;
    if (mapped < 0) continue;
    if (mapped < prevDoc) throw new Error("mergeShards: remapped docs must stay ascending");
    body.varint(mapped - prevDoc);
    prevDoc = mapped;
    body.bytes(reader.slice(start, reader.offset));
    kept += 1;
  }
  return { kept, prevDoc };
}

/**
 * Merge shards of the same shard number from several segments. Inputs are
 * in doc-id order: every kept doc of input i must map below every kept doc
 * of input i+1 (the natural layout when segments are concatenated).
 */
export function mergeShards(inputs: MergeInput[]): Uint8Array {
  const cursors = inputs.map(openCursor).filter((c): c is Cursor => c !== null);
  const writer = new ByteWriter();
  for (const byte of MAGIC) writer.u8(byte);
  writer.varint(SHARD_FORMAT_VERSION);
  const countAt = writer.length;
  // Term count is patched at the end; reserve a fixed-width varint slot.
  writer.fixedVarint(0);
  let termCount = 0;
  const body = new ByteWriter(4096);

  while (cursors.length > 0) {
    let term = cursors[0]!.term;
    for (const cursor of cursors) if (cursor.term < term) term = cursor.term;
    body.reset();
    let kept = 0;
    let prevDoc = 0;
    for (let i = 0; i < cursors.length; i += 1) {
      const cursor = cursors[i]!;
      if (cursor.term !== term) continue;
      const copied = copyPostings(cursor, body, prevDoc);
      kept += copied.kept;
      prevDoc = copied.prevDoc;
      if (!advance(cursor)) {
        cursors.splice(i, 1);
        i -= 1;
      }
    }
    if (kept === 0) continue;
    const termBytes = encoder.encode(term);
    writer.varint(termBytes.length);
    writer.bytes(termBytes);
    writer.varint(kept);
    writer.bytes(body.view());
    termCount += 1;
  }
  writer.patchFixedVarint(countAt, termCount);
  return writer.toUint8Array();
}
