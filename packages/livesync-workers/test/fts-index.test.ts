import { describe, expect, it } from "vitest";
import {
  appendFtsSegment,
  compactFtsSegments,
  deleteFtsIndex,
  ftsSearch,
  planFtsCompaction,
  readFtsManifest,
  retireFtsSegments,
  type FtsManifest,
} from "../src/search/fts-index.js";
import { buildIndex, type FtsDocMeta } from "../src/search/fts/build.js";
import { memoryBucket } from "./helpers.js";

const ref = { tenantId: "u1", databaseName: "v1" };

const segmentDirs = (store: Map<string, Uint8Array>) =>
  new Set(
    [...store.keys()]
      .map((key) => key.split("/"))
      .filter((parts) => parts.length === 5)
      .map((parts) => parts[3]!),
  );

async function ready(bucket: R2Bucket, query: string, limit = 10) {
  const result = await ftsSearch(bucket, ref, query, limit);
  if (result.status !== "ready") throw new Error("index not built");
  return result;
}

describe("fts-index segments", () => {
  it("appends a segment per pass and searches across them with hashes", async () => {
    const { bucket, store } = memoryBucket();
    expect(await ftsSearch(bucket, ref, "会議", 10)).toEqual({ status: "not-built" });

    const first = await appendFtsSegment(bucket, ref, [
      { path: "a.md", content: "京都の会議メモ", hash: "a1", mtime: 1 },
      { path: "b.md", content: "検索エンジンの実験", hash: "b1", mtime: 2 },
    ]);
    expect(first?.manifest.segments).toHaveLength(1);
    // a.md changed, c.md is new: only they go into the next segment.
    const second = await appendFtsSegment(bucket, ref, [
      { path: "a.md", content: "京都の会議は中止", hash: "a2", mtime: 3 },
      { path: "c.md", content: "会議室の予約", hash: "c1", mtime: 4 },
    ]);
    expect(second?.manifest.segments.map((s) => s.id)).toEqual([first!.segment.id, second!.segment.id]);
    expect(second?.manifest.docCount).toBe(4);

    const result = await ready(bucket, "会議");
    // Both versions of a.md come back; the vault decides which is current.
    expect(result.hits.map((hit) => [hit.path, hit.hash]).sort()).toEqual([
      ["a.md", "a1"],
      ["a.md", "a2"],
      ["c.md", "c1"],
    ]);
    expect(segmentDirs(store)).toEqual(new Set([first!.segment.id, second!.segment.id]));
  });

  it("writes nothing for an empty pass", async () => {
    const { bucket, store } = memoryBucket();
    expect(await appendFtsSegment(bucket, ref, [])).toBeNull();
    expect(store.size).toBe(0);
  });

  it("reads a version-1 manifest as one legacy segment and retires it later", async () => {
    const { bucket, store } = memoryBucket();
    const built = await buildIndex([{ path: "a.md", content: "旧世代の会議メモ" }], { format: 1 });
    for (const [name, body] of built.files) await bucket.put(`fts/u1/v1/gen-old/${name}`, body);
    await bucket.put(
      "fts/u1/v1/manifest.json",
      JSON.stringify({ version: 1, generation: "gen-old", shardCount: 16, docCount: 1, totalChars: 8, builtAt: 5 }),
    );
    const legacy = await ready(bucket, "会議");
    expect(legacy.manifest.segments).toEqual([
      { id: "gen-old", docCount: 1, totalChars: 8, builtAt: 5, hashed: false },
    ]);
    expect(legacy.hits.map((hit) => [hit.path, hit.hash])).toEqual([["a.md", null]]);

    const appended = await appendFtsSegment(bucket, ref, [{ path: "a.md", content: "旧世代の会議メモ", hash: "a1" }], {
      now: 1_000_000,
    });
    expect(appended?.manifest.segments.map((s) => s.hashed)).toEqual([false, true]);

    const retired = await retireFtsSegments(bucket, ref, ["gen-old"], { now: 1_000_000 });
    expect(retired?.segments.map((s) => s.id)).toEqual([appended!.segment.id]);
    expect(retired?.retired).toEqual([{ id: "gen-old", at: 1_000_000 }]);
    // Still on disk for in-flight searches; swept by the next commit once the grace period passed.
    expect(segmentDirs(store).has("gen-old")).toBe(true);
    await appendFtsSegment(bucket, ref, [{ path: "b.md", content: "新しいメモ", hash: "b1" }], { now: 1_000_000 + 10 * 60_000 });
    expect(segmentDirs(store).has("gen-old")).toBe(false);
    expect((await readFtsManifest(bucket, ref))?.retired).toEqual([]);
  });

  it("sweeps orphan files left by an interrupted pass", async () => {
    const { bucket, store } = memoryBucket();
    await bucket.put("fts/u1/v1/seg-orphan/docs.json.gz", new Uint8Array([1]));
    await bucket.put("fts/u1/v1/seg-orphan/shard-000.bin.gz", new Uint8Array([1]));
    await appendFtsSegment(bucket, ref, [{ path: "a.md", content: "本文", hash: "a1" }]);
    expect(segmentDirs(store).has("seg-orphan")).toBe(false);
    expect(store.has("fts/u1/v1/manifest.json")).toBe(true);
  });

  it("plans compaction of the two smallest segments only past the segment cap", async () => {
    const segment = (id: string, totalChars: number) => ({ id, docCount: 1, totalChars, builtAt: 0, hashed: true, format: 2 as const });
    const manifest: FtsManifest = {
      version: 2,
      shardCount: 16,
      segments: [segment("s1", 50), segment("s2", 10), segment("legacy", 1), segment("s3", 20)],
      retired: [],
      builtAt: 0,
      docCount: 4,
      totalChars: 81,
    };
    manifest.segments[2]!.hashed = false;
    expect(planFtsCompaction(manifest, { maxSegments: 3 })).toBeNull();
    expect(planFtsCompaction(manifest, { maxSegments: 2 })?.segments.map((s) => s.id)).toEqual(["s2", "s3"]);
    expect(planFtsCompaction(manifest, { maxSegments: 2, maxMergedChars: 25 })).toBeNull();
  });

  it("compacts segments, dropping stale versions and duplicate copies", async () => {
    const { bucket, store } = memoryBucket();
    const s1 = await appendFtsSegment(bucket, ref, [
      { path: "a.md", content: "京都の会議メモ", hash: "a1", mtime: 1 },
      { path: "b.md", content: "検索エンジンの実験", hash: "b1", mtime: 2 },
      { path: "d.md", content: "消される会議ノート", hash: "d1", mtime: 3 },
    ]);
    const s2 = await appendFtsSegment(bucket, ref, [
      { path: "a.md", content: "京都の会議は中止", hash: "a2", mtime: 4 },
      { path: "b.md", content: "検索エンジンの実験", hash: "b1", mtime: 2 }, // forced re-index: same hash twice
      { path: "c.md", content: "会議室の予約", hash: "c1", mtime: 5 },
    ]);
    const s3 = await appendFtsSegment(bucket, ref, [{ path: "e.md", content: "別の会議", hash: "e1", mtime: 6 }]);
    const current = new Map([
      ["a.md", "a2"],
      ["b.md", "b1"],
      ["c.md", "c1"],
      ["e.md", "e1"],
    ]);
    const isLive = (docs: FtsDocMeta[]) => docs.map((doc) => current.get(doc.path) === doc.hash);

    const manifest = (await readFtsManifest(bucket, ref))!;
    const plan = planFtsCompaction(manifest, { maxSegments: 2 })!;
    expect(plan.segments.map((s) => s.id)).toEqual([s2!.segment.id, s3!.segment.id]);
    const merged = await compactFtsSegments(bucket, ref, { segments: [s1!.segment, s2!.segment] }, { isLive, now: 10 });
    expect(merged?.segment).toMatchObject({ docCount: 3, hashed: true });
    expect(merged?.manifest.segments.map((s) => s.id)).toEqual([merged!.segment.id, s3!.segment.id]);
    expect(merged?.manifest.retired.map((r) => r.id).sort()).toEqual([s1!.segment.id, s2!.segment.id].sort());

    const result = await ready(bucket, "会議");
    expect(result.hits.map((hit) => [hit.path, hit.hash]).sort()).toEqual([
      ["a.md", "a2"],
      ["c.md", "c1"],
      ["e.md", "e1"],
    ]);
    expect((await ready(bucket, "検索エンジン")).hits).toHaveLength(1);
    // Phrase positions survive the merge (postings are copied, not rebuilt).
    expect((await ready(bucket, "会議は中止")).hits.map((hit) => hit.path)).toEqual(["a.md"]);
    expect((await ready(bucket, "会議メモ")).hits).toEqual([]);
    // Merged inputs stay on disk during the grace period.
    expect(segmentDirs(store).has(s1!.segment.id)).toBe(true);
  });

  it("upgrades a format-1 hashed segment to format 2 before merging anything", async () => {
    const { bucket, store } = memoryBucket();
    // A segment as 0.3.0 wrote it: whole-gzip shards, no index.bin, no format field.
    const built = await buildIndex(
      [
        { path: "a.md", content: "京都の会議メモ", hash: "a1" },
        { path: "gone.md", content: "消えた会議", hash: "g1" },
      ],
      { format: 1 },
    );
    for (const [name, body] of built.files) await bucket.put(`fts/u1/v1/seg-old/${name}`, body);
    await bucket.put(
      "fts/u1/v1/manifest.json",
      JSON.stringify({
        version: 2,
        shardCount: 16,
        segments: [{ id: "seg-old", docCount: 2, totalChars: 12, builtAt: 1, hashed: true }],
        retired: [],
        builtAt: 1,
        docCount: 2,
        totalChars: 12,
      }),
    );
    expect((await ready(bucket, "会議")).hits.map((hit) => hit.path).sort()).toEqual(["a.md", "gone.md"]);

    const manifest = (await readFtsManifest(bucket, ref))!;
    const plan = planFtsCompaction(manifest, { maxSegments: 8 })!;
    expect(plan.segments.map((s) => s.id)).toEqual(["seg-old"]);
    const upgraded = await compactFtsSegments(bucket, ref, plan, {
      isLive: (docs) => docs.map((doc) => doc.path === "a.md"),
      now: 10,
    });
    expect(upgraded?.segment).toMatchObject({ docCount: 1, format: 2 });
    expect(upgraded?.manifest.segments.map((s) => s.format)).toEqual([2]);
    expect(planFtsCompaction(upgraded!.manifest, { maxSegments: 8 })).toBeNull();
    expect(store.has(`fts/u1/v1/${upgraded!.segment.id}/index.bin`)).toBe(true);
    expect((await ready(bucket, "会議")).hits.map((hit) => hit.path)).toEqual(["a.md"]);
    expect((await ready(bucket, "会議メモ")).hits.map((hit) => hit.path)).toEqual(["a.md"]);
  });

  it("scores with BM25 across segments", async () => {
    const { bucket } = memoryBucket();
    await appendFtsSegment(bucket, ref, [
      { path: "short.md", content: "会議室", hash: "1" },
      { path: "long.md", content: "会議室 " + "無関係な長い本文。".repeat(20), hash: "2" },
    ]);
    await appendFtsSegment(bucket, ref, [{ path: "twice.md", content: "会議室と会議室", hash: "3" }]);
    const hits = (await ready(bucket, "会議室")).hits;
    expect(hits.map((hit) => hit.path)).toEqual(["twice.md", "short.md", "long.md"]);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it("keeps tenant and vault namespaces separate and deletes everything on request", async () => {
    const { bucket, store } = memoryBucket();
    await appendFtsSegment(bucket, ref, [{ path: "a.md", content: "会議", hash: "a1" }]);
    expect(await ftsSearch(bucket, { tenantId: "u2", databaseName: "v1" }, "会議", 10)).toEqual({ status: "not-built" });
    await deleteFtsIndex(bucket, ref);
    expect(store.size).toBe(0);
  });
});
