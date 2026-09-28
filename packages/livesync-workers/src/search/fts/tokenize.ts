/**
 * Tokenizer for the R2 full-text index.
 *
 * Text is normalized per code point (NFKC + lowercase) and split into runs:
 *   - ASCII word runs ([a-z0-9_]) become one exact-match word token
 *   - separator chars (whitespace / punctuation / symbols) are skipped
 *   - everything else (CJK, kana, accented latin, ...) becomes character
 *     bigrams, giving substring semantics without a dictionary
 *
 * Index mode additionally emits unigrams for the first and last char of each
 * non-word run, so phrases spanning a word/CJK boundary ("第1回") stay
 * searchable. Query mode emits only the minimal cover needed to verify a
 * phrase: bigrams for runs of 2+, a unigram only for single-char runs.
 * Consequence: a single-CJK-char query only matches places where that char is
 * adjacent to a word char, separator, or text edge.
 *
 * The index build streams: {@link normalizedChars} yields one normalized
 * char at a time and {@link tokenizeChars} hands each token to a callback as
 * soon as it is complete, so a note costs no per-char arrays or token list
 * (a 2M-char note used to need ~130 bytes of heap per char that way).
 */

export type Token = { term: string; pos: number };

export type NormalizedText = {
  /** Normalized code points (positions in tokens index into this array). */
  chars: string[];
  /** For each normalized char, the code-unit offset in the original string. */
  orig: number[];
};

const WORD_RE = /^[a-z0-9_]$/;
const SEP_RE = /^[\s\p{P}\p{S}\p{C}]$/u;

/**
 * NFKC + lowercase applied per code point so positions map back to the
 * original string (whole-string NFKC could merge across combining sequences,
 * which we accept losing for the sake of a stable offset map).
 */
export function normalizeText(text: string): NormalizedText {
  const chars: string[] = [];
  const orig: number[] = [];
  let offset = 0;
  for (const ch of text) {
    for (const nc of ch.normalize("NFKC").toLowerCase()) {
      chars.push(nc);
      orig.push(offset);
    }
    offset += ch.length;
  }
  return { chars, orig };
}

/** The normalized chars of `text`, one at a time (same sequence as normalizeText().chars). */
export function* normalizedChars(text: string): IterableIterator<string> {
  for (const ch of text) {
    const norm = ch.normalize("NFKC").toLowerCase();
    if (norm.length === 1) yield norm;
    else for (const nc of norm) yield nc;
  }
}

/**
 * Tokenize a stream of normalized chars, calling `emit` for each token in
 * position order (a run's bigrams first, then its boundary unigrams in index
 * mode). Returns the number of chars consumed.
 */
export function tokenizeChars(
  chars: Iterable<string>,
  mode: "index" | "query",
  emit: (term: string, pos: number) => void,
): number {
  let i = 0;
  let run: "word" | "other" | null = null;
  let runStart = 0;
  let word = "";
  let first = "";
  let prev = "";
  const flush = (): void => {
    if (run === "word") {
      emit(word, runStart);
    } else if (run === "other") {
      if (i - runStart === 1) {
        emit(first, runStart);
      } else if (mode === "index") {
        emit(first, runStart);
        emit(prev, i - 1);
      }
    }
    run = null;
  };
  for (const c of chars) {
    const kind = WORD_RE.test(c) ? "word" : SEP_RE.test(c) ? null : "other";
    if (kind !== run) {
      flush();
      run = kind;
      runStart = i;
      word = "";
      first = c;
    }
    if (kind === "word") {
      word += c;
    } else if (kind === "other") {
      if (i > runStart) emit(prev + c, i - 1);
      prev = c;
    }
    i += 1;
  }
  flush();
  return i;
}

export function tokenize(chars: string[], mode: "index" | "query"): Token[] {
  const tokens: Token[] = [];
  tokenizeChars(chars, mode, (term, pos) => tokens.push({ term, pos }));
  return tokens;
}

/** Number of normalized chars a token's term covers in the text. */
export function termCharLength(term: string): number {
  return [...term].length;
}
