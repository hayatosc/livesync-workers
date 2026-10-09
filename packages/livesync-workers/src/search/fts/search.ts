import {
  bucketForTerm,
  decodeBucketTerms,
  decodeSegmentIndex,
  decodeShard,
  DEFAULT_BUCKET_COUNT,
  gunzip,
  shardForTerm,
  type Posting,
} from "./codec.js";
import { normalizeText, termCharLength, tokenize, type Token } from "./tokenize.js";
import { DOCS_FILE_NAME, INDEX_FILE_NAME, shardFileName, type FtsDocMeta } from "./build.js";

/** Fetch a segment-relative file ("shard-003.bin.gz"); null if missing. */
export type FetchSegmentFile = (name: string) => Promise<Uint8Array | null>;

/** Access to one segment's files; ranges are what makes format 2 cheap to search. */
export type SegmentFiles = {
  get: FetchSegmentFile;
  /** Bytes [offset, offset + length) of a file; null if the file is missing. */
  getRange: (name: string, offset: number, length: number) => Promise<Uint8Array | null>;
};

/** A whole-file fetcher as SegmentFiles (ranges are sliced client-side). */
export function segmentFilesFromFetch(fetch: FetchSegmentFile): SegmentFiles {
  return {
    get: fetch,
    async getRange(name, offset, length) {
      const whole = await fetch(name);
      return whole ? whole.subarray(offset, offset + length) : null;
    },
  };
}

export type SearchMatch = {
  /** Match start, as an index into the doc's normalized code points. */
  pos: number;
  /** Match length in normalized code points. */
  len: number;
};

export type SearchHit = {
  /** Segment-local doc id. */
  doc: number;
  path: string;
  title?: string;
  mtime?: number;
  /** Content hash the segment was built from; null for legacy generations. */
  hash: string | null;
  score: number;
  matches: SearchMatch[];
};

export type Phrase = {
  tokens: Token[];
  /** Token positions relative to the first token. */
  basePos: number;
  matchLen: number;
};

export function parsePhrases(query: string): Phrase[] {
  const phrases: Phrase[] = [];
  for (const part of query.split(/\s+/)) {
    if (!part) continue;
    const { chars } = normalizeText(part);
    const tokens = tokenize(chars, "query");
    if (tokens.length === 0) continue;
    const first = tokens[0]!;
    const last = tokens[tokens.length - 1]!;
    phrases.push({
      tokens: coveringTokens(tokens),
      basePos: first.pos,
      matchLen: last.pos + termCharLength(last.term) - first.pos,
    });
  }
  return phrases;
}

/**
 * The fewest tokens that still pin every character of the phrase at its
 * relative position. Bigram tokens overlap, so every other one suffices:
 * with 会議 at p and 議室 implied by 室内 at p+2, a doc holding 会議 at p and
 * 室内 at p+2 necessarily holds 会議室内. Halves the postings a long CJK
 * phrase has to read without changing which documents match.
 */
export function coveringTokens(tokens: Token[]): Token[] {
  const sorted = [...tokens].sort((a, b) => a.pos - b.pos);
  const end = Math.max(...sorted.map((t) => t.pos + termCharLength(t.term)));
  const chosen: Token[] = [];
  let covered = sorted[0]!.pos;
  let i = 0;
  while (covered < end) {
    let best: Token | null = null;
    while (i < sorted.length && sorted[i]!.pos <= covered) {
      const token = sorted[i]!;
      if (!best || token.pos + termCharLength(token.term) > best.pos + termCharLength(best.term)) best = token;
      i += 1;
    }
    if (!best) {
      // A gap (separator chars between tokens): continue from the next token.
      covered = sorted[i]!.pos;
      continue;
    }
    chosen.push(best);
    covered = best.pos + termCharLength(best.term);
  }
  return chosen;
}

function postingsSize(postings: Posting[]): number {
  return postings.reduce((sum, p) => sum + p.positions.length, 0);
}

/** A doc of one segment that matched every phrase, before scoring. */
export type SegmentCandidate = {
  doc: number;
  meta: FtsDocMeta;
  /** Verified phrase occurrences per phrase (BM25 term frequency). */
  tf: number[];
  matches: SearchMatch[];
};

export type SegmentSearchResult = {
  candidates: SegmentCandidate[];
  /** Docs matching each phrase on its own (BM25 document frequency), including docs the AND dropped. */
  df: number[];
  docCount: number;
  totalChars: number;
};

/**
 * Search one immutable segment: fetch the shards the query touches, verify
 * each phrase through token positions (exact substring for CJK, exact word
 * for ASCII), and AND the phrases. Scoring happens across segments in
 * {@link rankHits}, which needs the corpus totals.
 */
export async function searchSegment(
  phrases: Phrase[],
  options: {
    shardCount: number;
    /** Shard file layout; see shardFileName. Default 2. */
    format?: 1 | 2;
    bucketCount?: number;
    files: SegmentFiles;
    maxMatchesPerDoc?: number;
  },
): Promise<SegmentSearchResult> {
  const { shardCount, files } = options;
  const format = options.format ?? 2;
  const bucketCount = options.bucketCount ?? DEFAULT_BUCKET_COUNT;
  const maxMatchesPerDoc = options.maxMatchesPerDoc ?? 20;
  const empty = (docs: FtsDocMeta[]): SegmentSearchResult => ({
    candidates: [],
    df: phrases.map(() => 0),
    docCount: docs.length,
    totalChars: docs.reduce((sum, doc) => sum + doc.chars, 0),
  });

  const terms = new Set<string>();
  for (const phrase of phrases) {
    for (const token of phrase.tokens) terms.add(token.term);
  }
  const [docs, termPostings] =
    format === 1
      ? await loadWholeShards(terms, shardCount, files)
      : await loadBuckets(terms, shardCount, bucketCount, files);
  if (phrases.length === 0) return empty(docs);

  // Verified match start positions per doc, per phrase. Every phrase is
  // evaluated even when an earlier one found nothing, so df stays comparable
  // across segments.
  const phraseMatches: Array<Map<number, number[]>> = [];
  for (const phrase of phrases) {
    const ordered = [...phrase.tokens].sort(
      (a, b) => postingsSize(termPostings.get(a.term) ?? []) - postingsSize(termPostings.get(b.term) ?? []),
    );
    const matches = new Map<number, number[]>();
    if (ordered.some((token) => (termPostings.get(token.term) ?? []).length === 0)) {
      phraseMatches.push(matches);
      continue;
    }
    const positionsByDoc = ordered.map((token) => {
      const byDoc = new Map<number, number[]>();
      for (const posting of termPostings.get(token.term)!) {
        byDoc.set(posting.doc, posting.positions);
      }
      return byDoc;
    });
    const rarest = ordered[0]!;
    for (const [doc, rarestPositions] of positionsByDoc[0]!) {
      let bases: number[] | null = rarestPositions.map((pos) => pos - (rarest.pos - phrase.basePos));
      for (let t = 1; t < ordered.length && bases.length > 0; t += 1) {
        const positions = positionsByDoc[t]!.get(doc);
        if (!positions) {
          bases = null;
          break;
        }
        const set = new Set(positions);
        const rel = ordered[t]!.pos - phrase.basePos;
        bases = bases.filter((base) => set.has(base + rel));
      }
      if (bases && bases.length > 0)
        matches.set(
          doc,
          bases.sort((a, b) => a - b),
        );
    }
    phraseMatches.push(matches);
  }

  const df = phraseMatches.map((matches) => matches.size);
  if (phraseMatches.some((matches) => matches.size === 0)) {
    return { ...empty(docs), df };
  }

  const candidates: SegmentCandidate[] = [];
  outer: for (const [doc, firstBases] of phraseMatches[0]!) {
    const allMatches: SearchMatch[] = firstBases.map((pos) => ({
      pos,
      len: phrases[0]!.matchLen,
    }));
    const tf = [firstBases.length];
    for (let p = 1; p < phraseMatches.length; p += 1) {
      const bases = phraseMatches[p]!.get(doc);
      if (!bases) continue outer;
      tf.push(bases.length);
      for (const pos of bases) allMatches.push({ pos, len: phrases[p]!.matchLen });
    }
    const meta = docs[doc];
    if (!meta) continue;
    allMatches.sort((a, b) => a.pos - b.pos);
    candidates.push({ doc, meta, tf, matches: allMatches.slice(0, maxMatchesPerDoc) });
  }
  return {
    candidates,
    df,
    docCount: docs.length,
    totalChars: docs.reduce((sum, doc) => sum + doc.chars, 0),
  };
}

async function loadDocs(files: SegmentFiles): Promise<FtsDocMeta[]> {
  const raw = await files.get(DOCS_FILE_NAME);
  if (!raw) throw new Error("FTS segment docs file is missing");
  return (JSON.parse(new TextDecoder().decode(await gunzip(raw))) as { docs: FtsDocMeta[] }).docs;
}

/** Format 1: every touched shard is read and decoded in full. */
async function loadWholeShards(
  terms: Set<string>,
  shardCount: number,
  files: SegmentFiles,
): Promise<[FtsDocMeta[], Map<string, Posting[]>]> {
  const shardIds = [...new Set([...terms].map((term) => shardForTerm(term, shardCount)))];
  const [docs, ...shardBodies] = await Promise.all([
    loadDocs(files),
    ...shardIds.map((shard) => files.get(shardFileName(shard, 1))),
  ]);
  const termPostings = new Map<string, Posting[]>();
  for (let i = 0; i < shardIds.length; i += 1) {
    const body = shardBodies[i];
    const decoded = body ? decodeShard(await gunzip(body)) : new Map<string, Posting[]>();
    for (const term of terms) {
      if (shardForTerm(term, shardCount) !== shardIds[i]) continue;
      termPostings.set(term, decoded.get(term) ?? []);
    }
  }
  return [docs, termPostings];
}

/** Format 2: only the buckets the terms hash into are read (one range each). */
async function loadBuckets(
  terms: Set<string>,
  shardCount: number,
  bucketCount: number,
  files: SegmentFiles,
): Promise<[FtsDocMeta[], Map<string, Posting[]>]> {
  const [docs, indexRaw] = await Promise.all([loadDocs(files), files.get(INDEX_FILE_NAME)]);
  if (!indexRaw) throw new Error("FTS segment index file is missing");
  const index = decodeSegmentIndex(indexRaw, shardCount, bucketCount);
  const groups = new Map<string, { shard: number; bucket: number; terms: string[] }>();
  for (const term of terms) {
    const shard = shardForTerm(term, shardCount);
    const bucket = bucketForTerm(term, bucketCount);
    const key = `${shard}:${bucket}`;
    const group = groups.get(key) ?? { shard, bucket, terms: [] };
    group.terms.push(term);
    groups.set(key, group);
  }
  const termPostings = new Map<string, Posting[]>();
  await Promise.all(
    [...groups.values()].map(async ({ shard, bucket, terms: wanted }) => {
      const offsets = index[shard]!;
      const start = offsets[bucket]!;
      const length = offsets[bucket + 1]! - start;
      const raw = length > 0 ? await files.getRange(shardFileName(shard, 2), start, length) : null;
      const decoded = raw ? decodeBucketTerms(await gunzip(raw), wanted) : null;
      for (const term of wanted) termPostings.set(term, decoded?.get(term) ?? []);
    }),
  );
  return [docs, termPostings];
}

export type RankOptions = {
  limit?: number;
  /** BM25 parameters. */
  k1?: number;
  b?: number;
};

export type RankedHit = SearchHit & {
  /** Index into the `segments` array passed to {@link rankHits}. */
  segment: number;
};

/**
 * BM25 over whitespace-separated phrases (not over bigrams, whose frequencies
 * say nothing useful): tf is the verified phrase count in the doc, df the
 * number of docs the phrase occurs in across all segments, document length
 * the normalized char count. Segments are immutable, so N and avgdl come from
 * the segment totals (stale versions inflate them slightly; harmless).
 * Duplicate paths are not collapsed here: which copy is current is only known
 * to the vault, which checks (path, hash) after ranking.
 */
export function rankHits(segments: SegmentSearchResult[], options: RankOptions = {}): RankedHit[] {
  const limit = options.limit ?? 20;
  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;
  const n = Math.max(
    1,
    segments.reduce((sum, s) => sum + s.docCount, 0),
  );
  const avgdl = Math.max(1, segments.reduce((sum, s) => sum + s.totalChars, 0) / n);
  const phraseCount = segments[0]?.df.length ?? 0;
  const idf: number[] = [];
  for (let p = 0; p < phraseCount; p += 1) {
    const df = segments.reduce((sum, s) => sum + (s.df[p] ?? 0), 0);
    idf.push(Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }

  const hits: RankedHit[] = [];
  segments.forEach((segment, index) => {
    for (const candidate of segment.candidates) {
      const dl = candidate.meta.chars;
      let score = 0;
      for (let p = 0; p < candidate.tf.length; p += 1) {
        const tf = candidate.tf[p]!;
        score += (idf[p] ?? 0) * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / avgdl)));
      }
      const meta = candidate.meta;
      hits.push({
        doc: candidate.doc,
        segment: index,
        path: meta.path,
        ...(meta.title !== undefined ? { title: meta.title } : {}),
        ...(meta.mtime !== undefined ? { mtime: meta.mtime } : {}),
        hash: meta.hash ?? null,
        score,
        matches: candidate.matches,
      });
    }
  });
  hits.sort((a, b) => b.score - a.score || (b.mtime ?? 0) - (a.mtime ?? 0));
  return hits.slice(0, limit);
}

/** Search a single segment and rank its hits (tests and one-segment indexes). */
export async function searchIndex(
  query: string,
  options: {
    shardCount: number;
    format?: 1 | 2;
    fetchFile: FetchSegmentFile;
    limit?: number;
    maxMatchesPerDoc?: number;
  },
): Promise<SearchHit[]> {
  const phrases = parsePhrases(query);
  if (phrases.length === 0) return [];
  const result = await searchSegment(phrases, { ...options, files: segmentFilesFromFetch(options.fetchFile) });
  return rankHits([result], { ...(options.limit !== undefined ? { limit: options.limit } : {}) });
}

export type Snippet = { before: string; match: string; after: string };

/**
 * Slice a snippet out of the original document text for a match whose
 * position refers to normalized code points. Positions can drift if the doc
 * changed after the segment was built; the slice is best-effort.
 */
export function extractSnippet(content: string, match: SearchMatch, context = 40): Snippet {
  const { chars, orig } = normalizeText(content);
  const at = (index: number): number => {
    if (index <= 0) return 0;
    if (index >= chars.length) return content.length;
    return orig[index]!;
  };
  const start = Math.max(0, match.pos - context);
  const end = Math.min(chars.length, match.pos + match.len + context);
  return {
    before: content.slice(at(start), at(match.pos)),
    match: content.slice(at(match.pos), at(match.pos + match.len)),
    after: content.slice(at(match.pos + match.len), at(end)),
  };
}
