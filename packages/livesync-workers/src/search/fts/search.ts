import { decodeShard, gunzip, shardForTerm, type Posting } from "./codec.js";
import {
  normalizeText,
  termCharLength,
  tokenize,
  type Token,
} from "./tokenize.js";
import { DOCS_FILE_NAME, shardFileName, type FtsDocMeta } from "./build.js";

/** Fetch a segment-relative file ("shard-003.bin.gz"); null if missing. */
export type FetchSegmentFile = (name: string) => Promise<Uint8Array | null>;

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
      tokens,
      basePos: first.pos,
      matchLen: last.pos + termCharLength(last.term) - first.pos,
    });
  }
  return phrases;
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
    fetchFile: FetchSegmentFile;
    maxMatchesPerDoc?: number;
  },
): Promise<SegmentSearchResult> {
  const { shardCount, fetchFile } = options;
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
  const shardIds = new Set<number>();
  for (const term of terms) shardIds.add(shardForTerm(term, shardCount));

  const [docsRaw, ...shardBodies] = await Promise.all([
    fetchFile(DOCS_FILE_NAME),
    ...[...shardIds].map((shard) => fetchFile(shardFileName(shard))),
  ]);
  if (!docsRaw) throw new Error("FTS segment docs file is missing");
  const docs = (
    JSON.parse(new TextDecoder().decode(await gunzip(docsRaw))) as {
      docs: FtsDocMeta[];
    }
  ).docs;
  if (phrases.length === 0) return empty(docs);

  const termPostings = new Map<string, Posting[]>();
  const shardList = [...shardIds];
  for (let i = 0; i < shardList.length; i += 1) {
    const body = shardBodies[i];
    const decoded = body ? decodeShard(await gunzip(body)) : new Map<string, Posting[]>();
    for (const term of terms) {
      if (shardForTerm(term, shardCount) !== shardList[i]) continue;
      termPostings.set(term, decoded.get(term) ?? []);
    }
  }

  // Verified match start positions per doc, per phrase. Every phrase is
  // evaluated even when an earlier one found nothing, so df stays comparable
  // across segments.
  const phraseMatches: Array<Map<number, number[]>> = [];
  for (const phrase of phrases) {
    const ordered = [...phrase.tokens].sort(
      (a, b) =>
        postingsSize(termPostings.get(a.term) ?? []) -
        postingsSize(termPostings.get(b.term) ?? []),
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
      let bases: number[] | null = rarestPositions.map(
        (pos) => pos - (rarest.pos - phrase.basePos),
      );
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
      if (bases && bases.length > 0) matches.set(doc, bases.sort((a, b) => a - b));
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
  const n = Math.max(1, segments.reduce((sum, s) => sum + s.docCount, 0));
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
    fetchFile: FetchSegmentFile;
    limit?: number;
    maxMatchesPerDoc?: number;
  },
): Promise<SearchHit[]> {
  const phrases = parsePhrases(query);
  if (phrases.length === 0) return [];
  const result = await searchSegment(phrases, options);
  return rankHits([result], { ...(options.limit !== undefined ? { limit: options.limit } : {}) });
}

export type Snippet = { before: string; match: string; after: string };

/**
 * Slice a snippet out of the original document text for a match whose
 * position refers to normalized code points. Positions can drift if the doc
 * changed after the segment was built; the slice is best-effort.
 */
export function extractSnippet(
  content: string,
  match: SearchMatch,
  context = 40,
): Snippet {
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
