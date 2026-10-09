// Built-in R2 full-text index of one vault: one immutable segment per pass,
// driven by index_state.fts_hash (null or stale = the note waits for the index).
import {
  appendFtsSegment,
  compactFtsSegments,
  FTS_SETTLED_PHASES,
  markFtsPhase,
  planFtsCompaction,
  planFtsStaleRewrite,
  readFtsManifest,
  readFtsPhase,
  readFtsSegmentDocs,
  retireFtsSegments,
  type CompactionPlan,
  type FtsManifest,
  type FtsSegment,
} from "../search/fts-index.js";
import type { FtsDocInput } from "../search/fts/build.js";
import type { FullTextIndex, VaultBindings, VaultRef } from "../types.js";
import type { RevRow } from "./rows.js";
import {
  FTS_BUILD_RETRY_MS,
  FTS_COMPACT_MAX_MERGED_CHARS,
  FTS_COMPACT_MAX_SEGMENTS,
  FTS_ERROR_META_KEY,
  FTS_GENERATION_META_KEY,
  FTS_MAX_BUILD_ATTEMPTS,
  FTS_MAX_NOTE_CODE_UNITS,
  FTS_MAX_TOTAL_CODE_UNITS,
  FTS_REBUILD_AT_META_KEY,
  FTS_REBUILD_EPOCH_META_KEY,
  FTS_SEGMENT_MAX_CODE_UNITS,
  FTS_SEGMENT_MAX_DOCS,
  FTS_STALE_REWRITE_MIN_CHARS,
  FTS_STALE_REWRITE_MIN_RATIO,
  FTS_STALE_SCAN_DOC_RATIO,
} from "./settings.js";

/** What the index needs from the vault Durable Object that owns it. */
export interface FullTextHost {
  vaultRef(): VaultRef | null;
  dbExists(): boolean;
  bindings(): VaultBindings;
  externalFullText(): FullTextIndex | undefined;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  /** Must go through the object's journaled SQL so writes reach the R2 commit log. */
  sqlExec(query: string, ...args: unknown[]): void;
  first<T>(query: string, ...args: unknown[]): T | null;
  rows<T>(query: string, ...args: unknown[]): T[];
  scheduleIndexing(delayMs: number): Promise<void>;
  rawWinningRow(id: string): RevRow | null;
  fileContentForRow(row: RevRow): Promise<string | null>;
  noteMtimeForRow(row: RevRow): number | null;
}

const FTS_PENDING_WHERE = `pending = 0 AND hash IS NOT NULL AND doc_id IS NOT NULL
         AND (fts_hash IS NULL OR fts_hash != hash)`;

class FtsTooLargeError extends Error {
  constructor(
    readonly codeUnits: number,
    readonly limit: number,
  ) {
    super(`FTS rebuild input exceeds ${limit} code units`);
  }
}

export class BuiltInFullText {
  constructor(private readonly host: FullTextHost) {}

  ftsBucket(): R2Bucket {
    const bucket = this.host.bindings().bucket;
    if (!bucket) throw new Error("VaultBindings needs either bucket or fullText");
    return bucket;
  }

  hasFtsPending(): boolean {
    return this.host.first<{ n: number }>(`SELECT 1 AS n FROM index_state WHERE ${FTS_PENDING_WHERE} LIMIT 1`) != null;
  }

  countFtsPending(): number {
    return (
      this.host.first<{ count: number }>(`SELECT COUNT(*) AS count FROM index_state WHERE ${FTS_PENDING_WHERE}`)
        ?.count ?? 0
    );
  }

  armFtsBuild(delayMs: number): void {
    this.host.setMeta(FTS_REBUILD_AT_META_KEY, String(Date.now() + delayMs));
  }

  async maybeRunFtsBuild(): Promise<void> {
    if (!this.host.vaultRef() || !this.host.dbExists() || this.host.externalFullText()) return;
    const dueRaw = this.host.getMeta(FTS_REBUILD_AT_META_KEY);
    let due = dueRaw ? Number(dueRaw) : null;
    if (due == null) {
      // Nothing armed: notes can still be waiting after a reset rolled the
      // arming back, or from before the index tracked them per note.
      if (this.host.getMeta(FTS_ERROR_META_KEY) || !this.hasFtsPending()) return;
      due = Date.now();
    }
    if (Date.now() < due) {
      await this.host.scheduleIndexing(due - Date.now());
      return;
    }
    try {
      const more = await this.runFtsPass();
      if (more) {
        this.armFtsBuild(0);
        await this.host.scheduleIndexing(0);
      } else {
        this.host.sqlExec(`DELETE FROM meta WHERE key = ?`, FTS_REBUILD_AT_META_KEY);
      }
    } catch (error) {
      console.warn("FTS pass failed", error);
      this.armFtsBuild(FTS_BUILD_RETRY_MS);
      await this.host.scheduleIndexing(FTS_BUILD_RETRY_MS);
    }
  }

  /**
   * One alarm event's worth of full-text work: index pending notes into a
   * new segment, or, once nothing is pending, one maintenance step (retire
   * the legacy generation, merge two segments). Returns whether another pass
   * is needed right away.
   */
  private async runFtsPass(): Promise<boolean> {
    const ref = this.host.vaultRef();
    if (!ref) return false;
    const bucket = this.ftsBucket();

    // An interrupted previous attempt (memory reset, CPU limit) leaves its
    // last phase marker behind; a completed or abandoned one does not count.
    const previous = await readFtsPhase(bucket, ref);
    const interrupted = previous != null && !FTS_SETTLED_PHASES.includes(String(previous.phase));
    const attempts = (interrupted ? Number(previous.attempts) || 0 : 0) + 1;
    if (attempts > FTS_MAX_BUILD_ATTEMPTS) {
      const message = `full-text pass was interrupted ${attempts - 1} times (last phase: ${String(previous?.phase)}); the vault is probably too large for the in-DO build`;
      console.warn("FTS pass giving up", { attempts: attempts - 1, lastPhase: previous?.phase });
      await markFtsPhase(bucket, ref, "failed", { attempts: attempts - 1, lastPhase: previous?.phase });
      this.host.setMeta(FTS_ERROR_META_KEY, message);
      return false;
    }
    const marker = { attempts };

    const pending = this.host.rows<{ path: string; doc_id: string; hash: string }>(
      `SELECT path, doc_id, hash FROM index_state
       WHERE ${FTS_PENDING_WHERE}
       ORDER BY path LIMIT ?`,
      FTS_SEGMENT_MAX_DOCS + 1,
    );
    if (pending.length > 0) {
      await markFtsPhase(bucket, ref, "segment-start", { ...marker, pending: pending.length });
      const manifest = await readFtsManifest(bucket, ref);
      const maxTotal = this.host.bindings().ftsMaxTotalCodeUnits ?? FTS_MAX_TOTAL_CODE_UNITS;
      const indexedChars = manifest ? this.ftsCountedSegments(manifest).reduce((sum, s) => sum + s.totalChars, 0) : 0;
      try {
        return await this.buildFtsSegment(ref, pending, { marker, budget: maxTotal - indexedChars, maxTotal });
      } catch (error) {
        if (!(error instanceof FtsTooLargeError)) throw error;
        // Over the guard. Dead weight (replaced versions) counts toward it,
        // so shed the worst segment's first and try again; only a vault that
        // is too big when live is recorded as such and disarmed.
        const rewrite = manifest ? await this.planFtsStaleRewrite(ref, manifest, { force: true }) : null;
        if (rewrite) {
          console.warn("FTS pass over the size guard; rewriting a segment to drop stale text", {
            segment: rewrite.segments[0]?.id,
          });
          await this.runFtsCompaction(ref, rewrite, marker, "current");
          return true;
        }
        const message = `vault exceeds the full-text size guard (${error.codeUnits.toLocaleString("en")}+ of ${error.limit.toLocaleString("en")} code units)`;
        console.warn("FTS pass aborted: vault exceeds size guard", { codeUnits: error.codeUnits });
        await markFtsPhase(bucket, ref, "too-large", { codeUnits: error.codeUnits });
        this.host.setMeta(FTS_ERROR_META_KEY, message);
        return false;
      }
    }

    // Nothing pending: maintenance, one step per event.
    const manifest = await readFtsManifest(bucket, ref);
    if (!manifest) return false;
    const epoch = this.ftsRebuildEpoch();
    const outdated = this.ftsOutdatedSegments(manifest).map((s) => s.id);
    if (outdated.length > 0) {
      // Every note is in a hashed segment now (and, after a rebuild, in one
      // built since): the older ones are redundant.
      await retireFtsSegments(bucket, ref, outdated);
      this.host.sqlExec(`DELETE FROM meta WHERE key = ?`, FTS_REBUILD_EPOCH_META_KEY);
      console.log("FTS outdated segments retired", { segments: outdated, rebuild: epoch != null });
      return true;
    }
    if (epoch != null) {
      // Nothing pending and nothing older than the rebuild: it is complete.
      this.host.sqlExec(`DELETE FROM meta WHERE key = ?`, FTS_REBUILD_EPOCH_META_KEY);
    }
    const merge = planFtsCompaction(manifest, {
      maxSegments: FTS_COMPACT_MAX_SEGMENTS,
      maxMergedChars: FTS_COMPACT_MAX_MERGED_CHARS,
    });
    if (merge) {
      await this.runFtsCompaction(ref, merge, marker, "indexed");
      return true;
    }
    const rewrite = await this.planFtsStaleRewrite(ref, manifest);
    if (!rewrite) return false;
    await this.runFtsCompaction(ref, rewrite, marker, "current");
    return true;
  }

  /**
   * Merge or rewrite segments. "indexed" keeps the version the index last
   * recorded for a path (searches never lose a note that way); "current"
   * keeps only the vault's current content, dropping versions of notes that
   * are still waiting to be re-indexed, which is what frees space.
   */
  private async runFtsCompaction(
    ref: VaultRef,
    plan: CompactionPlan,
    marker: Record<string, unknown>,
    keep: "indexed" | "current",
  ): Promise<void> {
    const merged = await compactFtsSegments(this.ftsBucket(), ref, plan, {
      isLive: (docs) =>
        docs.map((doc) =>
          keep === "indexed"
            ? this.ftsDocIsLive(doc.path, doc.hash ?? null)
            : this.ftsDocIsCurrent(doc.path, doc.hash ?? null),
        ),
      marker,
    });
    if (merged) this.host.setMeta(FTS_GENERATION_META_KEY, merged.segment.id);
    console.log("FTS segments compacted", {
      merged: plan.segments.map((s) => s.id),
      into: merged?.segment.id,
      docCount: merged?.segment.docCount,
    });
  }

  private ftsRebuildEpoch(): number | null {
    const raw = this.host.getMeta(FTS_REBUILD_EPOCH_META_KEY);
    return raw ? Number(raw) || null : null;
  }

  /** Segments a maintenance step retires: the legacy generation, and those a rebuild replaced. */
  private ftsOutdatedSegments(manifest: FtsManifest): FtsSegment[] {
    const epoch = this.ftsRebuildEpoch();
    return manifest.segments.filter((s) => !s.hashed || (epoch != null && s.builtAt < epoch));
  }

  /** Whether a segment entry is the vault's current content of its path (see runFtsCompaction). */
  private ftsDocIsCurrent(path: string, hash: string | null): boolean {
    if (hash == null) return false;
    const row = this.host.first<{ hash: string | null }>(`SELECT hash FROM index_state WHERE path = ?`, path);
    return row?.hash === hash;
  }

  private ftsStaleRewriteCandidates(manifest: FtsManifest): FtsSegment[] {
    return this.ftsCountedSegments(manifest).filter((s) => s.hashed && s.format === 2);
  }

  /** Cheap check (manifest and doc counts only) for whether a stale scan could find enough to rewrite. */
  private ftsStaleDocsSuspected(manifest: FtsManifest): boolean {
    const candidates = this.ftsStaleRewriteCandidates(manifest);
    if (!candidates.some((s) => s.totalChars >= FTS_STALE_REWRITE_MIN_CHARS)) return false;
    const liveDocs =
      this.host.first<{ count: number }>(`SELECT COUNT(*) AS count FROM index_state WHERE fts_hash IS NOT NULL`)
        ?.count ?? 0;
    return candidates.reduce((sum, s) => sum + s.docCount, 0) > liveDocs * FTS_STALE_SCAN_DOC_RATIO;
  }

  /** Segments the size guard counts: all of them, minus those a rebuild in progress will retire. */
  private ftsCountedSegments(manifest: FtsManifest): FtsSegment[] {
    const epoch = this.ftsRebuildEpoch();
    return epoch == null ? manifest.segments : manifest.segments.filter((s) => s.builtAt >= epoch);
  }

  /**
   * The segment worth rewriting alone to drop replaced/deleted versions, if
   * any. Reading every segment's doc list is skipped while the manifest's
   * doc count says there is little to gain, unless `force` (the size guard
   * tripped).
   */
  private async planFtsStaleRewrite(
    ref: VaultRef,
    manifest: FtsManifest,
    options: { force?: boolean } = {},
  ): Promise<CompactionPlan | null> {
    const candidates = this.ftsStaleRewriteCandidates(manifest);
    if (candidates.length === 0) return null;
    if (!options.force && !this.ftsStaleDocsSuspected(manifest)) return null;
    const liveChars = new Map<string, number>();
    for (const segment of candidates) {
      const docs = await readFtsSegmentDocs(this.ftsBucket(), ref, segment.id);
      let live = 0;
      for (const doc of docs) if (this.ftsDocIsCurrent(doc.path, doc.hash ?? null)) live += doc.chars;
      liveChars.set(segment.id, live);
    }
    return planFtsStaleRewrite({ ...manifest, segments: candidates }, liveChars, {
      minFreedRatio: FTS_STALE_REWRITE_MIN_RATIO,
      minFreedChars: FTS_STALE_REWRITE_MIN_CHARS,
    });
  }

  /**
   * Index up to one segment's worth of the pending notes and record them as
   * indexed. Returns whether another pass is needed: more of the backlog, or
   * a maintenance step the new manifest calls for. Bodies are read one note
   * at a time while the segment is built, so only the postings and one note
   * live in memory at once.
   */
  private async buildFtsSegment(
    ref: VaultRef,
    pending: Array<{ path: string; doc_id: string; hash: string }>,
    options: { marker: Record<string, unknown>; budget: number; maxTotal: number },
  ): Promise<boolean> {
    const bucket = this.ftsBucket();
    const self = this;
    const written: Array<{ path: string; hash: string }> = [];
    // Notes not worth a segment entry (oversized, body gone) are still marked
    // indexed, or the pass would pick them up again forever.
    const skipped: Array<{ path: string; hash: string }> = [];
    let consumed = 0;
    let codeUnits = 0;
    async function* inputs(): AsyncGenerator<FtsDocInput> {
      for (const row of pending) {
        if (consumed >= FTS_SEGMENT_MAX_DOCS || codeUnits >= FTS_SEGMENT_MAX_CODE_UNITS) break;
        const rev = self.host.rawWinningRow(row.doc_id);
        const full = rev ? await self.host.fileContentForRow(rev) : null;
        if (full == null) {
          consumed += 1;
          console.warn("FTS pass skipping note without a readable body", { path: row.path });
          skipped.push(row);
          continue;
        }
        // The note is indexed as its body is now, under the hash the vault
        // recorded for it (which is what "indexed" is checked against). If
        // the body moved on since, the change is in the feed and re-queues
        // the note with its new hash; a note whose recorded hash never
        // matches its body would otherwise stay pending forever.
        // A long note is indexed up to the cap (its first part stays
        // searchable), and a note the segment has no room for starts the
        // next one rather than stretching this one.
        const content = full.length > FTS_MAX_NOTE_CODE_UNITS ? full.slice(0, FTS_MAX_NOTE_CODE_UNITS) : full;
        if (content.length < full.length) {
          console.warn("FTS pass indexing only the start of a long note", { path: row.path, codeUnits: full.length });
        }
        if (consumed > 0 && codeUnits + content.length > FTS_SEGMENT_MAX_CODE_UNITS) break;
        consumed += 1;
        codeUnits += content.length;
        if (codeUnits > options.budget) {
          throw new FtsTooLargeError(options.maxTotal - options.budget + codeUnits, options.maxTotal);
        }
        const mtime = rev ? self.host.noteMtimeForRow(rev) : null;
        written.push(row);
        yield {
          path: row.path,
          content,
          hash: row.hash,
          ...(mtime != null ? { mtime } : {}),
        };
      }
    }

    const result = await appendFtsSegment(bucket, ref, inputs(), { marker: options.marker });
    // A note the build handed back (segment full of terms) stays pending for
    // the next segment; one it dropped (too many terms on its own) is marked
    // like an oversized note.
    if (result.dropped.length > 0)
      console.warn("FTS pass dropping notes with too many distinct terms", { paths: result.dropped });
    const settled = new Set([...result.docs.map((doc) => doc.path), ...result.dropped]);
    const indexed = written.filter((row) => settled.has(row.path));
    for (const row of [...indexed, ...skipped]) {
      this.host.sqlExec(
        `UPDATE index_state SET fts_hash = ? WHERE path = ? AND hash = ?`,
        row.hash,
        row.path,
        row.hash,
      );
    }
    if (result.segment) this.host.setMeta(FTS_GENERATION_META_KEY, result.segment.id);
    this.host.sqlExec(`DELETE FROM meta WHERE key = ?`, FTS_ERROR_META_KEY);
    console.log("FTS segment written", {
      segment: result.segment?.id ?? null,
      docCount: result.segment?.docCount ?? 0,
      codeUnits,
      skipped: skipped.length,
      dropped: result.dropped.length,
      segments: result.manifest?.segments.length,
      attempts: options.marker.attempts,
    });
    return consumed < pending.length || this.hasFtsPending() || this.ftsNeedsMaintenance(result.manifest);
  }

  /** Whether the idle maintenance step (retire outdated, merge, shed stale text) may have work. */
  private ftsNeedsMaintenance(manifest: FtsManifest | null | undefined): boolean {
    if (!manifest) return false;
    return (
      this.ftsOutdatedSegments(manifest).length > 0 ||
      planFtsCompaction(manifest, {
        maxSegments: FTS_COMPACT_MAX_SEGMENTS,
        maxMergedChars: FTS_COMPACT_MAX_MERGED_CHARS,
      }) != null ||
      this.ftsStaleDocsSuspected(manifest)
    );
  }

  /**
   * Whether a segment entry is the vault's current version of its path. A
   * hashed entry is current when the index last wrote that hash, or, while a
   * forced rebuild has cleared the index's record, when the note still has
   * that content. A legacy entry (no hash) stands until the note is written
   * to a hashed segment.
   */
  ftsDocIsLive(path: string, hash: string | null): boolean {
    const row = this.host.first<{ hash: string | null; fts_hash: string | null }>(
      `SELECT hash, fts_hash FROM index_state WHERE path = ?`,
      path,
    );
    if (!row) return false;
    if (hash == null) return row.fts_hash == null;
    return row.fts_hash === hash || (row.fts_hash == null && row.hash === hash);
  }
}
