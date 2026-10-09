import type { FullTextNote, FullTextSearchHit } from "../types.js";

/** Analyzer version is part of every artifact key: old analyzers never mix with new queries. */
export const SEGMENTER_ANALYZER = "ja-segmenter-nfkc-v1";
export type Word = { term: string; position: number; start: number; end: number };
const words = new Intl.Segmenter("ja", { granularity: "word" });
const graphemes = new Intl.Segmenter("ja", { granularity: "grapheme" });

/** Whole grapheme normalization preserves combining characters and maps expansions back to original UTF-16. */
export function analyzeWords(text: string): Word[] {
  let normalized = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (const part of graphemes.segment(text)) {
    const value = part.segment.normalize("NFKC").toLowerCase();
    normalized += value;
    for (let i = 0; i < value.length; i++) {
      starts.push(part.index);
      ends.push(part.index + part.segment.length);
    }
  }
  const result: Word[] = [];
  for (const part of words.segment(normalized)) {
    if (!part.isWordLike) continue;
    result.push({
      term: part.segment,
      position: result.length,
      start: starts[part.index]!,
      end: ends[part.index + part.segment.length - 1]!,
    });
  }
  return result;
}

export type FieldName = "body" | "title" | "heading" | "path";
export type Field = {
  text: string;
  length: number;
  postings: Record<string, Array<{ position: number; start: number; end: number }>>;
};
export type IndexedNote = {
  analyzer: typeof SEGMENTER_ANALYZER;
  path: string;
  hash: string;
  updatedAt: number;
  fields: Record<FieldName, Field>;
};
export const weights: Record<FieldName, number> = { body: 1, title: 3, heading: 2, path: 1.5 };
function field(text: string): Field {
  const tokens = analyzeWords(text);
  const postings: Field["postings"] = Object.create(null);
  for (const { term, position, start, end } of tokens) {
    const list = postings[term] ?? [];
    postings[term] = list;
    list.push({ position, start, end });
  }
  return { text, length: tokens.length, postings };
}
export function indexNote(note: FullTextNote): IndexedNote {
  const headings = note.content
    .split("\n")
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, ""));
  const title = headings[0] ?? note.path.split("/").at(-1)?.replace(/\.md$/i, "") ?? note.path;
  return {
    analyzer: SEGMENTER_ANALYZER,
    path: note.path,
    hash: note.contentHash,
    updatedAt: Date.now(),
    fields: {
      body: field(note.content),
      title: field(title),
      heading: field(headings.join("\n")),
      path: field(note.path),
    },
  };
}
export function queryPhrases(query: string): string[][] {
  const phrases: string[][] = [];
  // Quoted phrases use consecutive word positions. Other words are AND terms.
  for (const part of query.matchAll(/"([^"]+)"|([^\s"]+)/g)) {
    const tokens = analyzeWords(part[1] ?? part[2] ?? "").map((word) => word.term);
    if (part[1] !== undefined) {
      if (tokens.length) phrases.push(tokens);
    } else for (const term of tokens) phrases.push([term]);
  }
  return phrases;
}
export function occurrences(field: Field, phrase: string[]): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = [];
  for (const first of field.postings[phrase[0]!] ?? []) {
    let end = first.end;
    const matched = phrase.every((term, i) => {
      const match = field.postings[term]?.find((word) => word.position === first.position + i);
      if (!match) return false;
      end = match.end;
      return true;
    });
    if (matched) result.push({ start: first.start, end });
  }
  return result;
}

export async function searchWordIndex(
  notes: AsyncIterable<IndexedNote>,
  query: string,
  limit: number,
): Promise<{ hits: FullTextSearchHit[]; docCount: number; builtAt: number }> {
  const phrases = queryPhrases(query);
  const fields = Object.keys(weights) as FieldName[];
  const df = phrases.map(() => 0);
  const totalLengths = fields.map(() => 0);
  let docCount = 0;
  let builtAt = 0;
  const candidates: Array<{
    path: string;
    hash: string;
    tf: number[][];
    lengths: number[];
    snippets: FullTextSearchHit["snippets"];
  }> = [];
  for await (const note of notes) {
    docCount++;
    builtAt = Math.max(builtAt, note.updatedAt);
    const matches = phrases.map((phrase) => fields.map((name) => occurrences(note.fields[name], phrase)));
    fields.forEach((name, f) => {
      totalLengths[f] = totalLengths[f]! + note.fields[name].length;
    });
    matches.forEach((phrase, p) => {
      if (phrase.some((positions) => positions.length)) df[p] = df[p]! + 1;
    });
    if (!phrases.length || matches.some((phrase) => phrase.every((positions) => !positions.length))) continue;
    const snippets: FullTextSearchHit["snippets"] = [];
    matches.forEach((phrase) => {
      phrase.forEach((positions, f) => {
        const text = note.fields[fields[f]!].text;
        for (const occurrence of positions.slice(0, 3)) {
          if (snippets.length >= 5) break;
          snippets.push({
            before: [...text.slice(Math.max(0, occurrence.start - 100), occurrence.start)].slice(-40).join(""),
            match: text.slice(occurrence.start, occurrence.end),
            after: [...text.slice(occurrence.end, occurrence.end + 100)].slice(0, 40).join(""),
          });
        }
      });
    });
    candidates.push({
      path: note.path,
      hash: note.hash,
      tf: matches.map((phrase) => phrase.map((positions) => positions.length)),
      lengths: fields.map((name) => note.fields[name].length),
      snippets,
    });
  }
  const hits = candidates.map((candidate): FullTextSearchHit => {
    let score = 0;
    let matchCount = 0;
    candidate.tf.forEach((phrase, p) => {
      phrase.forEach((tf, f) => {
        if (!tf) return;
        const average = Math.max(1, totalLengths[f]! / Math.max(1, docCount));
        const idf = Math.log(1 + (docCount - df[p]! + 0.5) / (df[p]! + 0.5));
        score +=
          (weights[fields[f]!] * idf * (tf * 2.2)) / (tf + 1.2 * (0.25 + (0.75 * candidate.lengths[f]!) / average));
        matchCount += tf;
      });
    });
    return { path: candidate.path, contentHash: candidate.hash, score, matchCount, snippets: candidate.snippets };
  });
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return { hits: hits.slice(0, limit), docCount, builtAt };
}
