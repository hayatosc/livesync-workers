import type { IndexedNote } from "./segmenter-analysis.js";
import { analyzeWords, SEGMENTER_ANALYZER, searchWordIndex } from "./segmenter-analysis.js";
import { SharedSegmenterIndex } from "./shared-segmenter.js";
export { analyzeWords, SEGMENTER_ANALYZER };
/** New generations use shared positional pages; legacy active generations remain readable during rebuild. */
export class SegmenterFullTextIndex extends SharedSegmenterIndex {
  constructor(bucket: R2Bucket) {
    super(bucket, async (prefix, query, limit) => {
      async function* notes(): AsyncGenerator<IndexedNote> {
        let cursor: string | undefined;
        do {
          const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
          for (const object of page.objects) {
            const value = await bucket.get(object.key);
            if (!value) continue;
            const note = await value.json<IndexedNote>();
            if (note.analyzer !== SEGMENTER_ANALYZER) throw new Error("Search analyzer mismatch");
            yield note;
          }
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
      }
      return searchWordIndex(notes(), query, limit);
    });
  }
}
