/**
 * R2-backed full-text index (see ./fts/), stored as immutable segments:
 *
 *   fts/{tenantId}/{databaseName}/
 *     manifest.json                  live segment list; swapped atomically
 *     seg-{id}/docs.json.gz          segment-local docId → path, hash, chars, mtime
 *     seg-{id}/index.bin             bucket byte ranges of every shard
 *     seg-{id}/shard-000..015.bin    postings, term → fnv1a(term) % 16, in 64
 *                                    independently gzipped buckets per shard
 *     debug.json                     last phase reached (survives DO resets)
 *
 * A search reads, per segment, docs.json.gz, index.bin and one byte range
 * per bucket its terms hash into (segment format 2). Segments written by
 * 0.3.0 (format 1: shard-NNN.bin.gz, one gzip stream each, read whole) stay
 * searchable and are rewritten to format 2 by the maintenance pass.
 *
 * A segment holds the notes one indexing pass wrote (new or changed notes),
 * so an update costs O(changed text), not O(vault). Replaced and deleted
 * notes linger in older segments until compaction merges them away; a search
 * therefore returns (path, hash) candidates that the vault checks against its
 * current state. Version-1 manifests (one generation for the whole vault)
 * are read as a single legacy segment without hashes.
 */

import {
  buildIndex,
  DOCS_FILE_NAME,
  INDEX_FILE_NAME,
  shardFileName,
  type FtsDocInput,
  type FtsDocMeta,
} from "./fts/build.js";
import {
  DEFAULT_BUCKET_COUNT,
  decodeSegmentIndex,
  encodeSegmentIndex,
  gunzip,
  gzip,
  type BucketedShard,
} from "./fts/codec.js";
import { mergeShard, type MergeInput } from "./fts/merge.js";
import {
  parsePhrases,
  rankHits,
  searchSegment,
  type RankedHit,
  type SegmentFiles,
  type SegmentSearchResult,
} from "./fts/search.js";
import type { VaultRef } from "../types.js";

export const FTS_SHARD_COUNT = 16;
export const FTS_BUCKET_COUNT = DEFAULT_BUCKET_COUNT;
/** How long a retired segment stays readable for searches that already read the old manifest. */
const RETIRED_GRACE_MS = 5 * 60_000;

export type FtsSegment = {
  /** Directory name under the vault prefix. */
  id: string;
  docCount: number;
  totalChars: number;
  builtAt: number;
  /** False for a legacy generation, whose docs carry no content hash. */
  hashed: boolean;
  /** Shard file layout (see shardFileName); absent means 1. */
  format?: 1 | 2;
};

export function segmentFormat(segment: FtsSegment): 1 | 2 {
  return segment.format ?? 1;
}

export type FtsManifest = {
  version: 2;
  shardCount: number;
  segments: FtsSegment[];
  /** Segments dropped from `segments` but not yet deleted from R2. */
  retired: Array<{ id: string; at: number }>;
  /** Time of the last change to the index. */
  builtAt: number;
  /** Sums over `segments` (they count replaced versions until compaction). */
  docCount: number;
  totalChars: number;
};

type LegacyManifest = {
  version: 1;
  generation: string;
  shardCount: number;
  docCount: number;
  totalChars: number;
  builtAt: number;
};

function basePrefix(ref: VaultRef): string {
  return `fts/${ref.tenantId}/${ref.databaseName}`;
}

function manifestKey(ref: VaultRef): string {
  return `${basePrefix(ref)}/manifest.json`;
}

function newSegmentId(): string {
  return `seg-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

async function listAllKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

async function deleteKeys(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    await bucket.delete(keys.slice(i, i + 1000));
  }
}

/**
 * Crash-surviving progress marker (R2 writes are not rolled back when a DO
 * event dies, unlike its SQLite writes). After a CPU-limit reset, this shows
 * the last phase the pass completed.
 */
export async function markFtsPhase(
  bucket: R2Bucket,
  ref: VaultRef,
  phase: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await bucket
    .put(`${basePrefix(ref)}/debug.json`, JSON.stringify({ phase, at: Date.now(), ...extra }), {
      httpMetadata: { contentType: "application/json" },
    })
    .catch((error) => console.warn("FTS debug marker write failed", error));
}

export async function readFtsPhase(
  bucket: R2Bucket,
  ref: VaultRef,
): Promise<Record<string, unknown> | null> {
  const object = await bucket.get(`${basePrefix(ref)}/debug.json`);
  if (!object) return null;
  try {
    return (await object.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Phases after which the index is consistent; anything else means an interrupted pass. */
export const FTS_SETTLED_PHASES = ["segment-complete", "compact-complete", "retire-complete", "rebuild-complete", "failed", "too-large"];

function normalizeManifest(raw: FtsManifest | LegacyManifest): FtsManifest {
  if (raw.version === 2) return { ...raw, retired: raw.retired ?? [] };
  return {
    version: 2,
    shardCount: raw.shardCount,
    segments: [
      {
        id: raw.generation,
        docCount: raw.docCount,
        totalChars: raw.totalChars,
        builtAt: raw.builtAt,
        hashed: false,
      },
    ],
    retired: [],
    builtAt: raw.builtAt,
    docCount: raw.docCount,
    totalChars: raw.totalChars,
  };
}

export async function readFtsManifest(bucket: R2Bucket, ref: VaultRef): Promise<FtsManifest | null> {
  const object = await bucket.get(manifestKey(ref));
  if (!object) return null;
  return normalizeManifest((await object.json()) as FtsManifest | LegacyManifest);
}

function withTotals(manifest: Omit<FtsManifest, "docCount" | "totalChars">): FtsManifest {
  return {
    ...manifest,
    docCount: manifest.segments.reduce((sum, s) => sum + s.docCount, 0),
    totalChars: manifest.segments.reduce((sum, s) => sum + s.totalChars, 0),
  };
}

async function writeManifest(bucket: R2Bucket, ref: VaultRef, manifest: FtsManifest): Promise<void> {
  await bucket.put(manifestKey(ref), JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" },
  });
}

/**
 * Delete segment files nothing refers to: retired segments past their grace
 * period and leftovers of passes that died before updating the manifest.
 * Returns the manifest with the deleted entries dropped from `retired`;
 * callers write that manifest right after.
 */
async function sweep(bucket: R2Bucket, ref: VaultRef, manifest: FtsManifest, now: number): Promise<FtsManifest> {
  const base = basePrefix(ref);
  const keep = new Set(manifest.segments.map((s) => s.id));
  const retired = manifest.retired.filter((r) => now - r.at < RETIRED_GRACE_MS);
  for (const r of retired) keep.add(r.id);
  const stale = (await listAllKeys(bucket, `${base}/`)).filter((key) => {
    const rest = key.slice(base.length + 1);
    const slash = rest.indexOf("/");
    return slash > 0 && !keep.has(rest.slice(0, slash));
  });
  await deleteKeys(bucket, stale);
  return { ...manifest, retired };
}

async function putSegment(
  bucket: R2Bucket,
  ref: VaultRef,
  id: string,
  files: Map<string, Uint8Array>,
): Promise<void> {
  const base = basePrefix(ref);
  for (const [name, body] of files) {
    await bucket.put(`${base}/${id}/${name}`, body);
  }
}

/**
 * Index the given notes as one new segment and add it to the manifest.
 * The manifest write is the commit point: a pass that dies earlier leaves
 * orphan files the next pass sweeps. Returns null when there was nothing to
 * index (no files are written).
 */
export async function appendFtsSegment(
  bucket: R2Bucket,
  ref: VaultRef,
  docs: Iterable<FtsDocInput> | AsyncIterable<FtsDocInput>,
  options: {
    /** Carried into every phase marker (e.g. the attempt counter). */
    marker?: Record<string, unknown>;
    now?: number;
  } = {},
): Promise<{ manifest: FtsManifest; segment: FtsSegment } | null> {
  const extra = options.marker ?? {};
  const now = options.now ?? Date.now();
  const built = await buildIndex(docs, { shardCount: FTS_SHARD_COUNT });
  if (built.stats.docCount === 0) return null;
  await markFtsPhase(bucket, ref, "segment-build-done", {
    ...extra,
    docCount: built.stats.docCount,
    termCount: built.stats.termCount,
  });
  const id = newSegmentId();
  await putSegment(bucket, ref, id, built.files);
  await markFtsPhase(bucket, ref, "segment-upload-done", { ...extra, segment: id });

  const previous = (await readFtsManifest(bucket, ref)) ?? {
    version: 2 as const,
    shardCount: FTS_SHARD_COUNT,
    segments: [],
    retired: [],
    builtAt: now,
  };
  if (previous.shardCount !== FTS_SHARD_COUNT) {
    throw new Error(`FTS manifest shard count ${previous.shardCount} does not match ${FTS_SHARD_COUNT}`);
  }
  const segment: FtsSegment = {
    id,
    docCount: built.stats.docCount,
    totalChars: built.stats.totalChars,
    builtAt: now,
    hashed: true,
    format: 2,
  };
  // Sweep before the commit: the new segment is in the manifest being
  // written, so it survives; a crash in between only leaves it orphaned.
  const manifest = await sweep(
    bucket,
    ref,
    withTotals({ ...previous, segments: [...previous.segments, segment], builtAt: now }),
    now,
  );
  await writeManifest(bucket, ref, manifest);
  await markFtsPhase(bucket, ref, "segment-complete", { ...extra, segment: id });
  return { manifest, segment };
}

/** Drop segments from the manifest (files are deleted by a later sweep). */
export async function retireFtsSegments(
  bucket: R2Bucket,
  ref: VaultRef,
  ids: string[],
  options: { now?: number } = {},
): Promise<FtsManifest | null> {
  const now = options.now ?? Date.now();
  const previous = await readFtsManifest(bucket, ref);
  if (!previous) return null;
  const dropped = previous.segments.filter((s) => ids.includes(s.id));
  if (dropped.length === 0) return previous;
  await markFtsPhase(bucket, ref, "retire-start", { segments: ids });
  const manifest = withTotals({
    ...previous,
    segments: previous.segments.filter((s) => !ids.includes(s.id)),
    retired: [...previous.retired, ...dropped.map((s) => ({ id: s.id, at: now }))],
    builtAt: now,
  });
  await writeManifest(bucket, ref, manifest);
  await markFtsPhase(bucket, ref, "retire-complete", { segments: ids });
  return manifest;
}

export type CompactionPlan = {
  /** Segments to merge, in manifest order. A single segment means a format upgrade. */
  segments: FtsSegment[];
};

/**
 * Which segments to merge next, if any: first any hashed segment still in
 * shard format 1 (rewritten alone into format 2, so searches can read it by
 * range), then the two smallest hashed segments once there are more than
 * `maxSegments`, provided the result stays under `maxMergedChars` (bounds
 * the CPU one merge pass needs). Legacy segments are never merged; they are
 * retired once every note has been re-indexed.
 */
export function planFtsCompaction(
  manifest: FtsManifest,
  options: { maxSegments?: number; maxMergedChars?: number } = {},
): CompactionPlan | null {
  const maxSegments = options.maxSegments ?? 8;
  const maxMergedChars = options.maxMergedChars ?? 16_000_000;
  const hashed = manifest.segments.filter((s) => s.hashed);
  const outdated = hashed.find((s) => segmentFormat(s) !== 2);
  if (outdated) return { segments: [outdated] };
  if (hashed.length <= maxSegments) return null;
  const smallest = [...hashed].sort((a, b) => a.totalChars - b.totalChars).slice(0, 2);
  if (smallest.length < 2) return null;
  if (smallest[0]!.totalChars + smallest[1]!.totalChars > maxMergedChars) return null;
  const chosen = new Set(smallest.map((s) => s.id));
  return { segments: manifest.segments.filter((s) => chosen.has(s.id)) };
}

async function readSegmentDocs(bucket: R2Bucket, base: string, id: string): Promise<FtsDocMeta[]> {
  const object = await bucket.get(`${base}/${id}/${DOCS_FILE_NAME}`);
  if (!object) throw new Error(`FTS segment ${id} has no docs file`);
  const raw = new Uint8Array(await object.arrayBuffer());
  return (JSON.parse(new TextDecoder().decode(await gunzip(raw))) as { docs: FtsDocMeta[] }).docs;
}

/**
 * Merge the planned segments into one, keeping only docs `isLive` accepts
 * (the vault's current version of each path) and the first copy of any
 * duplicated (path, hash). The manifest swap is the commit point.
 */
export async function compactFtsSegments(
  bucket: R2Bucket,
  ref: VaultRef,
  plan: CompactionPlan,
  options: {
    isLive: (docs: FtsDocMeta[]) => Promise<boolean[]> | boolean[];
    marker?: Record<string, unknown>;
    now?: number;
  },
): Promise<{ manifest: FtsManifest; segment: FtsSegment } | null> {
  const extra = options.marker ?? {};
  const now = options.now ?? Date.now();
  const base = basePrefix(ref);
  const ids = plan.segments.map((s) => s.id);
  await markFtsPhase(bucket, ref, "compact-start", { ...extra, segments: ids });

  // Doc ids of the merged segment: kept docs of the first input, then the second, ...
  const mergedDocs: FtsDocMeta[] = [];
  const remaps: Int32Array[] = [];
  const seen = new Set<string>();
  for (const segment of plan.segments) {
    const docs = await readSegmentDocs(bucket, base, segment.id);
    const live = await options.isLive(docs);
    const remap = new Int32Array(docs.length).fill(-1);
    docs.forEach((doc, index) => {
      const key = `${doc.hash ?? ""}\u0000${doc.path}`;
      if (!live[index] || seen.has(key)) return;
      seen.add(key);
      remap[index] = mergedDocs.length;
      mergedDocs.push(doc);
    });
    remaps.push(remap);
  }

  const files = new Map<string, Uint8Array>();
  if (mergedDocs.length > 0) {
    // Bucket offsets of the format-2 inputs, read once.
    const indexes = await Promise.all(
      plan.segments.map(async (segment) => {
        if (segmentFormat(segment) !== 2) return null;
        const object = await bucket.get(`${base}/${segment.id}/${INDEX_FILE_NAME}`);
        if (!object) throw new Error(`FTS segment ${segment.id} has no index file`);
        return decodeSegmentIndex(new Uint8Array(await object.arrayBuffer()), FTS_SHARD_COUNT, FTS_BUCKET_COUNT);
      }),
    );
    const shards: BucketedShard[] = [];
    for (let shard = 0; shard < FTS_SHARD_COUNT; shard += 1) {
      const inputs: MergeInput[] = [];
      for (let i = 0; i < plan.segments.length; i += 1) {
        const format = segmentFormat(plan.segments[i]!);
        const object = await bucket.get(`${base}/${plan.segments[i]!.id}/${shardFileName(shard, format)}`);
        inputs.push({
          format,
          data: object ? new Uint8Array(await object.arrayBuffer()) : null,
          ...(format === 2 ? { offsets: indexes[i]![shard]! } : {}),
          remap: remaps[i]!,
        });
      }
      const merged = await mergeShard(inputs, FTS_BUCKET_COUNT);
      shards.push(merged);
      files.set(shardFileName(shard, 2), merged.data);
    }
    files.set(INDEX_FILE_NAME, encodeSegmentIndex(shards, FTS_BUCKET_COUNT));
    files.set(DOCS_FILE_NAME, await gzip(new TextEncoder().encode(JSON.stringify({ docs: mergedDocs }))));
  }

  const id = newSegmentId();
  if (files.size > 0) await putSegment(bucket, ref, id, files);
  await markFtsPhase(bucket, ref, "compact-upload-done", { ...extra, segment: id, docCount: mergedDocs.length });

  const previous = await readFtsManifest(bucket, ref);
  if (!previous) return null;
  const segment: FtsSegment = {
    id,
    docCount: mergedDocs.length,
    totalChars: mergedDocs.reduce((sum, d) => sum + d.chars, 0),
    builtAt: now,
    hashed: true,
    format: 2,
  };
  const remaining = previous.segments.filter((s) => !ids.includes(s.id));
  // Keep the merged segment where the earliest input was, so manifest order stays by age.
  const at = previous.segments.findIndex((s) => ids.includes(s.id));
  if (mergedDocs.length > 0) remaining.splice(at < 0 ? remaining.length : at, 0, segment);
  const manifest = await sweep(
    bucket,
    ref,
    withTotals({
      ...previous,
      segments: remaining,
      retired: [...previous.retired, ...ids.map((rid) => ({ id: rid, at: now }))],
      builtAt: now,
    }),
    now,
  );
  await writeManifest(bucket, ref, manifest);
  await markFtsPhase(bucket, ref, "compact-complete", { ...extra, segment: id, merged: ids });
  return { manifest, segment };
}

export async function deleteFtsIndex(bucket: R2Bucket, ref: VaultRef): Promise<void> {
  await deleteKeys(bucket, await listAllKeys(bucket, `${basePrefix(ref)}/`));
}

export type FtsSearchResult =
  | { status: "ready"; manifest: FtsManifest; hits: RankedHit[] }
  | { status: "not-built" };

/**
 * Read-through cache for immutable segment files (the Workers Cache API).
 * Keys are object keys, with "@offset+length" appended for a byte range.
 */
export type FtsFileCache = {
  match(key: string): Promise<Uint8Array | null>;
  put(key: string, body: Uint8Array): Promise<void>;
};

const CACHE_ORIGIN = "https://fts-segments.livesync-workers.invalid/";

function cacheUrl(key: string): string {
  const at = key.lastIndexOf("@");
  return at < 0 ? CACHE_ORIGIN + key : `${CACHE_ORIGIN}${key.slice(0, at)}?range=${key.slice(at + 1)}`;
}

/** Segment files never change, so they can be cached for as long as they exist. */
export function ftsCacheFromWorkersCache(cache: Cache | undefined): FtsFileCache | undefined {
  if (!cache) return undefined;
  return {
    async match(key) {
      const hit = await cache.match(cacheUrl(key));
      return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
    },
    async put(key, body) {
      await cache.put(
        cacheUrl(key),
        new Response(body, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "public, max-age=2592000",
          },
        }),
      );
    },
  };
}

export function defaultFtsCache(): FtsFileCache | undefined {
  const caches = (globalThis as { caches?: { default?: Cache } }).caches;
  return ftsCacheFromWorkersCache(caches?.default);
}

/**
 * Search every live segment and rank across them. `limit` should be a
 * multiple of what the caller needs: hits still include versions the vault
 * has since replaced or deleted, which only the vault can tell apart.
 */
export async function ftsSearch(
  bucket: R2Bucket,
  ref: VaultRef,
  query: string,
  limit: number,
  options: { cache?: FtsFileCache } = {},
): Promise<FtsSearchResult> {
  const manifest = await readFtsManifest(bucket, ref);
  if (!manifest) return { status: "not-built" };
  const phrases = parsePhrases(query);
  if (phrases.length === 0) return { status: "ready", manifest, hits: [] };
  const base = basePrefix(ref);
  const cache = options.cache;

  const fetchBytes = async (
    key: string,
    range?: { offset: number; length: number },
  ): Promise<Uint8Array | null> => {
    const cacheKey = range ? `${key}@${range.offset}+${range.length}` : key;
    if (cache) {
      const cached = await cache.match(cacheKey).catch(() => null);
      if (cached) return cached;
    }
    const object = await bucket.get(key, range ? { range } : undefined);
    if (!object) return null;
    const body = new Uint8Array(await object.arrayBuffer());
    if (cache) await cache.put(cacheKey, body).catch(() => undefined);
    return body;
  };
  const filesOf = (segment: FtsSegment): SegmentFiles => ({
    get: (name) => fetchBytes(`${base}/${segment.id}/${name}`),
    getRange: (name, offset, length) => fetchBytes(`${base}/${segment.id}/${name}`, { offset, length }),
  });

  const results: SegmentSearchResult[] = await Promise.all(
    manifest.segments.map((segment) =>
      searchSegment(phrases, {
        shardCount: manifest.shardCount,
        bucketCount: FTS_BUCKET_COUNT,
        format: segmentFormat(segment),
        files: filesOf(segment),
      }),
    ),
  );
  return { status: "ready", manifest, hits: rankHits(results, { limit }) };
}
