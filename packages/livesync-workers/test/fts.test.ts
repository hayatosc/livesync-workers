import { describe, expect, it } from "vitest";
import { buildIndex, DEFAULT_SHARD_COUNT, type FtsDocInput } from "../src/search/fts/build.js";
import { decodeShard, encodeShard, gunzip, gzip, shardForTerm, type Posting } from "../src/search/fts/codec.js";
import { PostingsBuilder } from "../src/search/fts/postings.js";
import { normalizeText, tokenize } from "../src/search/fts/tokenize.js";
import { extractSnippet, searchIndex } from "../src/search/fts/search.js";

async function search(docs: FtsDocInput[], query: string, limit?: number) {
  const built = await buildIndex(docs);
  return searchIndex(query, {
    shardCount: DEFAULT_SHARD_COUNT,
    fetchFile: (name) => Promise.resolve(built.files.get(name) ?? null),
    ...(limit !== undefined ? { limit } : {}),
  });
}

const paths = (hits: Array<{ path: string }>) => hits.map((hit) => hit.path);

describe("tokenize", () => {
  it("emits bigrams for CJK runs and words for ASCII runs", () => {
    const { chars } = normalizeText("会議室でLiveSyncを使う");
    const tokens = tokenize(chars, "query");
    expect(tokens).toEqual([
      { term: "会議", pos: 0 },
      { term: "議室", pos: 1 },
      { term: "室で", pos: 2 },
      { term: "livesync", pos: 4 },
      { term: "を使", pos: 12 },
      { term: "使う", pos: 13 },
    ]);
  });

  it("adds boundary unigrams only in index mode", () => {
    const { chars } = normalizeText("会議室");
    const queryTerms = tokenize(chars, "query").map((t) => t.term);
    const indexTerms = tokenize(chars, "index").map((t) => t.term);
    expect(queryTerms).toEqual(["会議", "議室"]);
    expect(indexTerms.sort()).toEqual(["会議", "会", "室", "議室"].sort());
  });

  it("normalizes width and case with a usable offset map", () => {
    const original = "ＬｉｖｅＳｙｎｃ設定";
    const { chars, orig } = normalizeText(original);
    expect(chars.join("")).toBe("livesync設定");
    expect(original.slice(orig[8]!)).toBe("設定");
  });
});

describe("buildIndex term cap", () => {
  const richDoc = { path: "rich.md", content: "壱弐参肆伍陸漆捌玖拾", hash: "r" }; // 9 bigrams + 2 unigrams = 11 terms
  const plainDoc = { path: "plain.md", content: "会議", hash: "p" }; // 3 terms

  it("hands back a doc the segment has no room for, and drops one no segment can hold", async () => {
    const both = await buildIndex([plainDoc, richDoc], { maxTerms: 8 });
    expect(both.docs.map((doc) => doc.path)).toEqual(["plain.md"]);
    expect(both.dropped).toEqual([]);
    const alone = await buildIndex([richDoc, plainDoc], { maxTerms: 8 });
    expect(alone.docs).toEqual([]);
    expect(alone.dropped).toEqual(["rich.md"]);
    // Terms the dropped doc interned do not leak into the files.
    expect(alone.stats.postingCount).toBe(0);
  });
});

describe("codec", () => {
  it("round-trips shard postings through encode/gzip", async () => {
    const postings = new Map<string, Posting[]>([
      [
        "会議",
        [
          { doc: 0, positions: [0, 5, 130000] },
          { doc: 7, positions: [42] },
        ],
      ],
      ["z", [{ doc: 3, positions: [1] }]],
    ]);
    const decoded = decodeShard(await gunzip(await gzip(encodeShard(postings))));
    expect(decoded).toEqual(postings);
  });

  it("PostingsBuilder produces byte-identical shards to the object encoder", () => {
    const shardCount = 4;
    const byTerm = new Map<string, Posting[]>();
    const builder = new PostingsBuilder(shardCount);
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    const terms = ["会議", "室内", "livesync", "z", "検索", "メモ", "第1", "1回"];
    for (let doc = 0; doc < 300; doc += 1) {
      const chosen = [...new Set(Array.from({ length: 1 + rand(5) }, () => terms[rand(terms.length)]!))];
      for (const term of chosen) {
        const positions = Array.from({ length: 1 + rand(40) }, () => rand(200000)).sort((a, b) => a - b);
        builder.add(term, doc, positions);
        const list = byTerm.get(term) ?? [];
        list.push({ doc, positions });
        byTerm.set(term, list);
      }
    }
    for (let shard = 0; shard < shardCount; shard += 1) {
      const expected = encodeShard([...byTerm].filter(([term]) => shardForTerm(term, shardCount) === shard));
      expect(encodeShard(builder.shardEntries(shard))).toEqual(expected);
    }
    expect(builder.termCount).toBe(byTerm.size);
  });

  it("PostingsBuilder collect/commitDoc writes the same bytes as add, whatever the token order", () => {
    const direct = new PostingsBuilder(2);
    const collected = new PostingsBuilder(2);
    const docs = [
      { 会議: [0, 7, 30], 室内: [2], z: [99] },
      { 会議: [5], 検索: [1, 2, 3] },
    ];
    docs.forEach((doc, docId) => {
      const tokens: Array<[string, number]> = [];
      for (const [term, positions] of Object.entries(doc)) {
        direct.add(term, docId, positions);
        for (const pos of positions) tokens.push([term, pos]);
      }
      // Reverse arrival order: boundary unigrams come after bigrams in index mode.
      for (const [term, pos] of tokens.reverse()) expect(collected.collect(term, pos)).toBe(true);
      expect(collected.commitDoc(docId)).toBe(tokens.length);
    });
    for (const shard of [0, 1]) {
      expect(encodeShard(collected.shardEntries(shard))).toEqual(encodeShard(direct.shardEntries(shard)));
    }
  });

  it("PostingsBuilder refuses new terms past maxTerms and leaves unused terms out of the shards", () => {
    const builder = new PostingsBuilder(1, { maxTerms: 2 });
    expect(builder.collect("a", 0)).toBe(true);
    expect(builder.collect("b", 1)).toBe(true);
    expect(builder.collect("c", 2)).toBe(false);
    builder.abortDoc();
    expect(builder.collect("a", 4)).toBe(true);
    builder.commitDoc(0);
    expect([...builder.shardEntries(0)].map(([term]) => term)).toEqual(["a"]);
  });

  it("PostingsBuilder rejects out-of-order docs", () => {
    const builder = new PostingsBuilder(1);
    builder.add("a", 5, [1]);
    expect(() => builder.add("a", 3, [1])).toThrow(/ascending/);
  });
});

describe("searchIndex", () => {
  const docs: FtsDocInput[] = [
    { path: "a.md", content: "東京都の会議室を予約した", mtime: 100 },
    { path: "b.md", content: "会議と室内の話。LiveSync の設定メモ", mtime: 200 },
    { path: "c.md", content: "毎年第1回目のイベント", mtime: 300 },
    { path: "d.md", content: "全文検索のメモ。会議室 会議室 会議室", mtime: 400 },
  ];

  it("matches CJK substrings with adjacency verification", async () => {
    expect(paths(await search(docs, "会議室"))).toEqual(["d.md", "a.md"]);
    // Substring semantics: 京都 inside 東京都 is a correct hit.
    expect(paths(await search(docs, "京都"))).toEqual(["a.md"]);
    // 会議…室 without adjacency must not match.
    expect(paths(await search(docs, "議と室"))).toEqual(["b.md"]);
    expect(paths(await search(docs, "都会"))).toEqual([]);
  });

  it("treats ASCII runs as exact words, case- and width-insensitive", async () => {
    expect(paths(await search(docs, "livesync"))).toEqual(["b.md"]);
    expect(paths(await search(docs, "ＬｉｖｅＳｙｎｃ"))).toEqual(["b.md"]);
    expect(paths(await search(docs, "live"))).toEqual([]);
  });

  it("spans word/CJK boundaries via boundary unigrams", async () => {
    expect(paths(await search(docs, "第1回"))).toEqual(["c.md"]);
    expect(paths(await search(docs, "第1回目のイベント"))).toEqual(["c.md"]);
  });

  it("ANDs whitespace-separated phrases", async () => {
    expect(paths(await search(docs, "会議室 予約"))).toEqual(["a.md"]);
    expect(paths(await search(docs, "会議室 存在しない"))).toEqual([]);
  });

  it("ranks more matches higher and reports positions", async () => {
    const hits = await search(docs, "会議室");
    expect(hits[0]!.path).toBe("d.md");
    expect(hits[0]!.matches.length).toBe(3);
    const first = (await search(docs, "会議室"))[1]!;
    expect(first.matches).toEqual([{ pos: 4, len: 3 }]);
  });

  it("returns nothing for empty or separator-only queries", async () => {
    expect(await search(docs, "")).toEqual([]);
    expect(await search(docs, "、。 ・")).toEqual([]);
  });

  it("respects the limit", async () => {
    expect((await search(docs, "の", 1)).length).toBeLessThanOrEqual(1);
  });
});

describe("extractSnippet", () => {
  it("slices the original text around a normalized match position", async () => {
    const content = "前置きの文章。ＬｉｖｅＳｙｎｃ設定はここ。後ろの文章";
    const hits = await search([{ path: "x.md", content }], "livesync設定");
    const snippet = extractSnippet(content, hits[0]!.matches[0]!, 5);
    expect(snippet.match).toBe("ＬｉｖｅＳｙｎｃ設定");
    expect(snippet.before).toBe("きの文章。");
    expect(snippet.after).toBe("はここ。後");
  });
});

describe("mergeShard", () => {
  const shardName = (shard: number, format: 1 | 2) =>
    `shard-${String(shard).padStart(3, "0")}.bin${format === 1 ? ".gz" : ""}`;
  async function decodeBucketed(data: Uint8Array, offsets: Uint32Array) {
    const { decodeBucket, decodePostings } = await import("../src/search/fts/codec.js");
    const result = new Map<string, Posting[]>();
    for (let b = 0; b + 1 < offsets.length; b += 1) {
      if (offsets[b + 1]! <= offsets[b]!) continue;
      for (const entry of decodeBucket(await gunzip(data.subarray(offsets[b], offsets[b + 1])))) {
        result.set(entry.term, decodePostings(entry.body, entry.docCount));
      }
    }
    return result;
  }
  const a: FtsDocInput[] = [
    { path: "a0.md", content: "京都の会議メモ。LiveSync 設定" },
    { path: "a1.md", content: "消える文書 会議" },
    { path: "a2.md", content: "第1回のイベント" },
  ];
  const b: FtsDocInput[] = [
    { path: "b0.md", content: "会議室の予約と検索" },
    { path: "b1.md", content: "残る文書 メモ" },
  ];
  // Drop a1 and b0; new ids: a0→0, a2→1, b1→2.
  const kept = [a[0]!, a[2]!, b[1]!];

  it("produces the same postings as rebuilding from the kept docs", async () => {
    const { mergeShard } = await import("../src/search/fts/merge.js");
    const { decodeSegmentIndex, DEFAULT_BUCKET_COUNT } = await import("../src/search/fts/codec.js");
    const [builtA, builtB, expected] = await Promise.all([buildIndex(a), buildIndex(b), buildIndex(kept)]);
    const index = (built: typeof builtA) =>
      decodeSegmentIndex(built.files.get("index.bin")!, DEFAULT_SHARD_COUNT, DEFAULT_BUCKET_COUNT);
    const [indexA, indexB, indexE] = [index(builtA), index(builtB), index(expected)];
    for (let shard = 0; shard < DEFAULT_SHARD_COUNT; shard += 1) {
      const merged = await mergeShard(
        [
          {
            format: 2,
            data: builtA.files.get(shardName(shard, 2))!,
            offsets: indexA[shard]!,
            remap: Int32Array.from([0, -1, 1]),
          },
          {
            format: 2,
            data: builtB.files.get(shardName(shard, 2))!,
            offsets: indexB[shard]!,
            remap: Int32Array.from([-1, 2]),
          },
        ],
        DEFAULT_BUCKET_COUNT,
      );
      expect(merged.offsets).toEqual(indexE[shard]);
      expect(await decodeBucketed(merged.data, merged.offsets)).toEqual(
        await decodeBucketed(expected.files.get(shardName(shard, 2))!, indexE[shard]!),
      );
    }
  });

  it("reads format-1 inputs and writes format 2 (the upgrade path)", async () => {
    const { mergeShard } = await import("../src/search/fts/merge.js");
    const { decodeSegmentIndex, DEFAULT_BUCKET_COUNT } = await import("../src/search/fts/codec.js");
    const [oldA, oldB, expected] = await Promise.all([
      buildIndex(a, { format: 1 }),
      buildIndex(b, { format: 1 }),
      buildIndex(kept),
    ]);
    decodeSegmentIndex(expected.files.get("index.bin")!, DEFAULT_SHARD_COUNT, DEFAULT_BUCKET_COUNT);
    for (let shard = 0; shard < DEFAULT_SHARD_COUNT; shard += 1) {
      const merged = await mergeShard(
        [
          { format: 1, data: oldA.files.get(shardName(shard, 1))!, remap: Int32Array.from([0, -1, 1]) },
          { format: 1, data: oldB.files.get(shardName(shard, 1))!, remap: Int32Array.from([-1, 2]) },
        ],
        DEFAULT_BUCKET_COUNT,
      );
      expect(merged.data).toEqual(expected.files.get(shardName(shard, 2)));
    }
  });

  it("skips missing inputs and terms that lose every doc", async () => {
    const { mergeShard } = await import("../src/search/fts/merge.js");
    const { decodeSegmentIndex, DEFAULT_BUCKET_COUNT } = await import("../src/search/fts/codec.js");
    const built = await buildIndex([
      { path: "x.md", content: "abc def" },
      { path: "y.md", content: "def" },
    ]);
    const index = decodeSegmentIndex(built.files.get("index.bin")!, DEFAULT_SHARD_COUNT, DEFAULT_BUCKET_COUNT);
    const shard = shardForTerm("abc", DEFAULT_SHARD_COUNT);
    const merged = await mergeShard(
      [
        { format: 2, data: null, remap: Int32Array.from([]) },
        {
          format: 2,
          data: built.files.get(shardName(shard, 2))!,
          offsets: index[shard]!,
          remap: Int32Array.from([-1, 0]),
        },
      ],
      DEFAULT_BUCKET_COUNT,
    );
    const decoded = await decodeBucketed(merged.data, merged.offsets);
    expect(decoded.has("abc")).toBe(false);
    if (shardForTerm("def", DEFAULT_SHARD_COUNT) === shard) {
      expect(decoded.get("def")).toEqual([{ doc: 0, positions: [0] }]);
    }
  });
});

describe("coveringTokens", () => {
  it("keeps every other bigram of a CJK run and still matches exactly", async () => {
    const { coveringTokens } = await import("../src/search/fts/search.js");
    const { chars } = normalizeText("神霊の力を持った女性絵師");
    const tokens = tokenize(chars, "query");
    expect(tokens).toHaveLength(11);
    const chosen = coveringTokens(tokens);
    expect(chosen.map((t) => t.pos)).toEqual([0, 2, 4, 6, 8, 10]);
    // Exactness: the pruned tokens reject a doc where the middle differs.
    const docs: FtsDocInput[] = [
      { path: "hit.md", content: "神霊の力を持った女性絵師の話" },
      { path: "near.md", content: "神霊の力を持った男性絵師の話" },
      { path: "split.md", content: "神霊の力を、持った女性絵師" },
    ];
    expect(paths(await search(docs, "神霊の力を持った女性絵師"))).toEqual(["hit.md"]);
  });

  it("keeps single tokens and mixed runs intact", async () => {
    const { coveringTokens } = await import("../src/search/fts/search.js");
    const one = tokenize(normalizeText("livesync").chars, "query");
    expect(coveringTokens(one)).toEqual(one);
    const mixed = tokenize(normalizeText("第1回目").chars, "query");
    const chosen = coveringTokens(mixed);
    const covered = new Set<number>();
    for (const t of chosen) for (let i = 0; i < [...t.term].length; i += 1) covered.add(t.pos + i);
    expect([...covered].sort((x, y) => x - y)).toEqual([0, 1, 2, 3]);
  });
});
