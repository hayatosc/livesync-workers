import { REQUEST_LIMITS, RequestLimitError, readBoundedJson, assertDocumentSize, assertBulkLimits } from "../livesync/limits.js";
import { R2Journal, contentPrefix, type JournalStatement } from "../storage/r2-journal.js";
import { hashText } from "../search/chunk-md.js";
import { removeNoteVectors, upsertNoteVectors } from "../search/vector-index.js";
import {
  appendFtsSegment,
  compactFtsSegments,
  deleteFtsIndex,
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
import {
  CHANGES_IDLE_HEADER,
  DB_NAME_HEADER,
  VAULT_REF_HEADER,
  INTERNAL_SECRET_HEADER,
  couchError,
  json,
  numberParam,
  secretEquals,
} from "../livesync/http.js";
import {
  isHiddenPath,
  isReservedPath,
  parseVaultObjectName,
  vaultObjectName,
  type FullTextIndex,
  type FullTextIndexWriter,
  type VaultBindings,
  type VaultHost,
  type VaultPolicy,
  type VaultRef,
} from "../types.js";

type DocBody = Record<string, unknown>;

type DocRow = {
  id: string;
  winning_rev: string | null;
  deleted: number;
  updated_seq: number;
};

type RevRow = {
  id: string;
  rev: string;
  gen: number;
  parent_rev: string | null;
  body: string;
  body_chunked: number;
  body_available: number;
  deleted: number;
  seq: number;
  rev_history: string | null;
};

type LocalDocRow = {
  id: string;
  rev: string;
  body: string;
};

type ChangeRow = {
  seq: number;
  id: string;
  rev: string;
  deleted: number;
  revs?: string[];
};

type ChangeBatch = {
  rows: ChangeRow[];
  lastSeq: number;
  pending: number;
};

type RevisionMetadata = {
  soft_deleted: number;
  path: string | null;
  size: number | null;
  mtime: number | null;
  type: string | null;
};

type LiveSyncFileRow = {
  path: string;
  size: number | null;
  mtime: number | null;
  type: string | null;
};

type Selector = Record<string, unknown>;

type IndexStateRow = {
  path: string;
  doc_id: string | null;
  hash: string | null;
  chunks: number;
  pending: number;
  attempts: number;
  /** Content hash last written to the full-text index (null = not there yet). */
  fts_hash: string | null;
};

type InternalOp = {
  execute?: unknown;
  contentType?: unknown;
  op: string;
  path?: unknown;
  paths?: unknown;
  content?: unknown;
  expectedBaseHash?: unknown;
};

const INDEXED_SEQ_META_KEY = "indexed_seq";
const INDEX_VERSION_META_KEY = "index_version";
// Bump to force a one-time full re-embed (e.g. when vector metadata gains new fields).
const CURRENT_INDEX_VERSION = "4";
const INDEX_BATCH_SIZE = 32;
const INDEX_ALARM_DELAY_MS = 1_500;
const INDEX_RETRY_DELAY_MS = 30_000;
const INDEX_MAX_ATTEMPTS = 20;
// Newest segment the built-in full-text index wrote (shown as fts.generation).
const FTS_GENERATION_META_KEY = "fts_generation";
// Layout of the built-in index this code writes: "2" = per-note segments,
// "3" = bucketed shards read by range, "4" = same layout, but the build
// streams (0.5.x) so a "failed" verdict recorded by an earlier build no
// longer applies, "5" (0.5.2) clears the verdict a pass that indexed nothing
// used to earn. The whole-vault generation before them had no version
// meta. A change clears that verdict and arms a maintenance pass, which
// rewrites what the new code cannot read efficiently.
const FTS_INDEX_VERSION_META_KEY = "fts_index_version";
const CURRENT_FTS_INDEX_VERSION = "5";
const FTS_REBUILD_AT_META_KEY = "fts_rebuild_at";
// Why the last pass gave up; cleared by the next successful pass.
const FTS_ERROR_META_KEY = "fts_error";
// Every full-text pass writes a segment (~18 R2 objects), so wait for the
// vault to go quiet before writing one for a burst of edits.
const FTS_BUILD_DEBOUNCE_MS = 2 * 60_000;
const FTS_BUILD_RETRY_MS = 60_000;
// One pass indexes at most this much note text (JS code units, what the
// tokenizer walks) into one segment. Measured 2026-09: ~10 bytes of heap and
// ~1.5 s of DO CPU per million code units, so a pass stays well under the
// 128 MB / 30 s Durable Object limits; a big backlog takes several passes.
const FTS_SEGMENT_MAX_CODE_UNITS = 2_000_000;
const FTS_SEGMENT_MAX_DOCS = 4_000;
// Ceiling on the whole index (sum of segment text); passes stop with an
// explicit error above it. 50M code units is ~120 MB of Japanese Markdown.
const FTS_MAX_TOTAL_CODE_UNITS = 50_000_000;
// One note contributes at most this much text (code units): the built-in
// index takes the first part of a longer note, an external one skips it.
// Measured 2026-09: a 2M-code-unit note builds in ~65 MB of heap, so this
// leaves room for the rest of the segment.
const FTS_MAX_NOTE_CODE_UNITS = 1_000_000;
// A pass that dies from a memory reset leaves no SQLite trace (the event's
// writes roll back), so attempts are counted in the R2 phase marker. After
// this many interrupted attempts the index is disarmed instead of looping.
const FTS_MAX_BUILD_ATTEMPTS = 3;
// Compaction merges the two smallest segments once there are more than this
// many, as long as the merged text stays under the char bound (one merge per
// alarm event, no re-tokenizing).
const FTS_COMPACT_MAX_SEGMENTS = 8;
const FTS_COMPACT_MAX_MERGED_CHARS = 16_000_000;
// Segments count replaced/deleted versions until compaction drops them, and
// the size guard counts them too. A segment is rewritten alone once that
// dead weight is this large (share of its text, and at least this many
// code units), so a vault that is edited a lot does not grow into the guard.
const FTS_STALE_REWRITE_MIN_RATIO = 0.25;
const FTS_STALE_REWRITE_MIN_CHARS = 250_000;
// Finding stale text means reading every segment's doc list; skip that while
// the manifest's doc count is within this factor of the live doc count.
const FTS_STALE_SCAN_DOC_RATIO = 1.2;
// Set by ftsRebuild: segments built before this are retired once every note
// has been re-indexed, and the size guard ignores them meanwhile.
const FTS_REBUILD_EPOCH_META_KEY = "fts_rebuild_epoch";
// Most candidates one search asks the vault to check against its current state.
const FTS_RESOLVE_MAX_CANDIDATES = 500;
// External full-text index (VaultBindings.fullText): notes already
// vector-indexed but not yet written there (a fresh setup, or after
// "ftsRebuild") are backfilled this many per alarm run.
const FTS_BACKLOG_BATCH_SIZE = 16;
// Chunk documents written by the server. The hash salt is a persisted format
// detail (chunk ids are content addressed); keep it stable.
const WRITE_CHUNK_PREFIX = "h:";
const WRITE_CHUNK_HASH_SALT = "kuro-chunk";
const WRITE_CHUNK_CODE_UNITS = 100_000;

const enc = new TextEncoder();
const inlineRevisionBodyMaxBytes = 1_000_000;
const revisionBodyChunkCodeUnits = 250_000;

export function splitRevisionBody(body: string): string[] | null {
  if (enc.encode(body).byteLength <= inlineRevisionBodyMaxBytes) return null;

  const chunks: string[] = [];
  for (let start = 0; start < body.length;) {
    let end = Math.min(start + revisionBodyChunkCodeUnits, body.length);
    const lastCodeUnit = body.charCodeAt(end - 1);
    if (end < body.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
      end -= 1;
    }
    chunks.push(body.slice(start, end));
    start = end;
  }
  return chunks;
}


function isExcludedByFolders(path: string, excludedFolders: string[]): boolean {
  const normalized = path.replace(/^\/+|\/+$/g, "");
  return excludedFolders.some(
    (folder) => normalized === folder || normalized.startsWith(`${folder}/`),
  );
}

function isIndexableMarkdownPath(path: string, policy: VaultPolicy): boolean {
  return (
    path.endsWith(".md") &&
    !isReservedPath(path, policy.reservedPaths) &&
    !isExcludedByFolders(path, policy.excludedFolders) &&
    // "i:" marks files LiveSync's hidden file sync carries (".obsidian/…").
    !(policy.excludeHiddenPaths && (path.startsWith("i:") || isHiddenPath(path)))
  );
}


async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  return readBoundedJson(request);
}

function isSafeVaultPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

function isNoteDoc(doc: DocBody): doc is DocBody & { path: string } {
  return typeof doc.path === "string" && doc.type !== "leaf" && doc.type !== "chunkpack";
}

function docIsDeleted(doc: DocBody): boolean {
  return doc._deleted === true || doc.deleted === true;
}

/** Split note content into LiveSync chunk pieces (surrogate-pair safe). */
export function splitNoteContentForChunks(content: string): string[] {
  const pieces: string[] = [];
  for (let start = 0; start < content.length;) {
    let end = Math.min(start + WRITE_CHUNK_CODE_UNITS, content.length);
    const lastCodeUnit = content.charCodeAt(end - 1);
    if (end < content.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
      end -= 1;
    }
    pieces.push(content.slice(start, end));
    start = end;
  }
  return pieces;
}

async function writeChunkId(piece: string): Promise<string> {
  const digest = await hashText(`${WRITE_CHUNK_HASH_SALT}\n${piece.length}\n${piece}`);
  return `${WRITE_CHUNK_PREFIX}k${digest.slice(0, 40)}`;
}

/**
 * Derive a LiveSync document id for a path the way the plugin does without
 * path obfuscation: ids starting with "_" are prefixed with "/", and ids are
 * lower-cased when the vault appears to be using case-insensitive ids.
 */
function noteDocIdForPath(path: string, caseInsensitive: boolean): string {
  let id = caseInsensitive ? path.toLowerCase() : path;
  if (id.startsWith("_")) id = `/${id}`;
  return id;
}

class FtsTooLargeError extends Error {
  constructor(
    readonly codeUnits: number,
    readonly limit: number,
  ) {
    super(`FTS rebuild input exceeds ${limit} code units`);
  }
}

function revisionMetadata(doc: DocBody): RevisionMetadata {
  return {
    soft_deleted: doc.deleted === true ? 1 : 0,
    path: typeof doc.path === "string" ? doc.path : null,
    size: typeof doc.size === "number" ? doc.size : null,
    mtime: typeof doc.mtime === "number" ? doc.mtime : null,
    type: typeof doc.type === "string" ? doc.type : null,
  };
}

function parseRev(rev: string): { gen: number; hash: string } | null {
  const match = /^(\d+)-(.+)$/.exec(rev);
  if (!match) return null;
  return { gen: Number(match[1]), hash: match[2]! };
}

function withoutMeta(doc: DocBody): DocBody {
  const out: DocBody = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key !== "_rev" && key !== "_revisions" && key !== "_conflicts") {
      out[key] = value;
    }
  }
  return out;
}

function stableJson(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`)
    .join(",")}}`;
}

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", enc.encode(text));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function newRevision(doc: DocBody, parentRev: string | null): Promise<string> {
  const parent = parentRev ? parseRev(parentRev) : null;
  const gen = (parent?.gen ?? 0) + 1;
  const hash = await sha1Hex(`${stableJson(withoutMeta(doc))}\n${parentRev ?? ""}`);
  return `${gen}-${hash.slice(0, 32)}`;
}

function docIdFromBody(doc: DocBody): string | null {
  return typeof doc._id === "string" && doc._id ? doc._id : null;
}

function cloneBody(row: RevRow): DocBody {
  return JSON.parse(row.body) as DocBody;
}

function normalizeSince(value: unknown, currentSeq: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  if (value === "now") return currentSeq;
  return 0;
}


function boolParam(value: unknown): boolean {
  return value === true || value === "true";
}

function allDocsKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith('"')) return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Ancestors of a replicated revision, nearest first, from its `_revisions`
 * path (`ids[0]` is the revision itself). Replicators send only leaves, so
 * the generations in between must be recorded from this list or the
 * previously stored ancestor stays a leaf and surfaces as a conflict.
 */
function ancestorsFromRevisions(doc: DocBody): string[] {
  const rev = typeof doc._rev === "string" ? parseRev(doc._rev) : null;
  const revisions = doc._revisions as
    | { start?: unknown; ids?: unknown }
    | undefined;
  if (!rev || !revisions || !Array.isArray(revisions.ids)) return [];
  const ids = revisions.ids.filter((id): id is string => typeof id === "string");
  const ancestors: string[] = [];
  for (let index = 1; index < ids.length && rev.gen - index >= 1; index += 1) {
    ancestors.push(`${rev.gen - index}-${ids[index]}`);
  }
  return ancestors;
}

function revisionHistory(doc: DocBody, rev: string, parentHistory?: string | null): string {
  const existing = doc._revisions;
  if (existing && typeof existing === "object") return JSON.stringify(existing);
  const parsed = parseRev(rev);
  if (!parsed) return JSON.stringify({ start: 1, ids: [rev] });
  if (parentHistory) {
    try {
      const parent = JSON.parse(parentHistory) as { ids?: unknown };
      const parentIds = Array.isArray(parent.ids)
        ? parent.ids.filter((id): id is string => typeof id === "string")
        : [];
      return JSON.stringify({ start: parsed.gen, ids: [parsed.hash, ...parentIds] });
    } catch {
      // Fall through to a single-revision history.
    }
  }
  return JSON.stringify({ start: parsed.gen, ids: [parsed.hash] });
}

function bodyWithRevisions(row: RevRow): DocBody {
  const body = cloneBody(row);
  if (row.rev_history) {
    body._revisions = JSON.parse(row.rev_history);
  }
  return body;
}

function compareWinning(a: RevRow, b: RevRow): number {
  if (a.deleted !== b.deleted) return a.deleted ? -1 : 1;
  if (a.gen !== b.gen) return a.gen - b.gen;
  return compareCodePoints(a.rev, b.rev);
}

function compareCodePoints(a: string, b: string): number {
  const aPoints = Array.from(a, (char) => char.codePointAt(0)!);
  const bPoints = Array.from(b, (char) => char.codePointAt(0)!);
  const length = Math.min(aPoints.length, bPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (aPoints[index] !== bPoints[index]) return aPoints[index]! - bPoints[index]!;
  }
  return aPoints.length - bPoints.length;
}

function getField(doc: DocBody, field: string): unknown {
  if (field === "_id") return doc._id;
  if (field === "_rev") return doc._rev;
  return field.split(".").reduce<unknown>((value, key) => {
    if (value == null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
  }, doc);
}

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return compareCodePoints(String(a), String(b));
}

function matchesCondition(value: unknown, condition: unknown): boolean {
  if (condition == null || typeof condition !== "object" || Array.isArray(condition)) {
    return value === condition;
  }
  for (const [op, expected] of Object.entries(condition as Record<string, unknown>)) {
    switch (op) {
      case "$eq":
        if (value !== expected) return false;
        break;
      case "$ne":
        if (value === expected) return false;
        break;
      case "$lt":
        if (compareValues(value, expected) >= 0) return false;
        break;
      case "$lte":
        if (compareValues(value, expected) > 0) return false;
        break;
      case "$gt":
        if (compareValues(value, expected) <= 0) return false;
        break;
      case "$gte":
        if (compareValues(value, expected) < 0) return false;
        break;
      case "$exists":
        if ((value !== undefined) !== Boolean(expected)) return false;
        break;
      case "$in":
        if (!Array.isArray(expected) || !expected.includes(value)) return false;
        break;
      case "$nin":
        if (Array.isArray(expected) && expected.includes(value)) return false;
        break;
      case "$regex":
        if (typeof value !== "string" || typeof expected !== "string") return false;
        try {
          if (!new RegExp(expected).test(value)) return false;
        } catch {
          return false;
        }
        break;
      default:
        return false;
    }
  }
  return true;
}

function matchesSelector(doc: DocBody, selector: Selector | null): boolean {
  if (!selector || Object.keys(selector).length === 0) return true;
  for (const [field, condition] of Object.entries(selector)) {
    if (field === "$and") {
      if (!Array.isArray(condition)) return false;
      if (!condition.every((item) => matchesSelector(doc, item as Selector))) {
        return false;
      }
      continue;
    }
    if (field === "$or") {
      if (!Array.isArray(condition)) return false;
      if (!condition.some((item) => matchesSelector(doc, item as Selector))) {
        return false;
      }
      continue;
    }
    if (!matchesCondition(getField(doc, field), condition)) return false;
  }
  return true;
}


/**
 * Durable Object holding one LiveSync database (vault) in SQLite and keeping
 * its search indexes up to date. Hosts subclass it, export the subclass from
 * their Worker and bind it as a SQLite-backed Durable Object class:
 *
 *   export class VaultDO extends LiveSyncVaultDO<Env> {
 *     protected host() { return myHost(this.env); }
 *     protected bindings() { return myBindings(this.env); }
 *   }
 */
const CHECKPOINT_KEYS: Record<string, string[]> = {
  meta: ["key"], revs: ["id", "rev"], rev_metadata: ["id", "rev"], docs: ["id"],
  local_docs: ["id"], changes: ["seq"], index_state: ["path"],
};
type CheckpointWork = {
  phase: "compact" | "scan" | "dirty";
  startedSeq: number;
  table: number;
  cursor: number;
  references: Array<{ r2: string }>;
  previous: { r2: string } | null;
};

export abstract class LiveSyncVaultDO<TEnv = unknown> {
  /** Last successful setAlarm, as a cheap time-based throttle (never a hard gate). */
  private lastIndexScheduleAt = 0;
  private maintenance = Promise.resolve();
  private writes = Promise.resolve();
  private statements: JournalStatement[] | null = null;
  private contentJournal: R2Journal | null = null;
  private resolvedVaultRef: VaultRef | null = null;
  private journalHead: string | null | undefined;

  private async resolveVaultIdentity(request?: Request): Promise<void> {
    if (!this.bindings().contentBucket) return; // Preserve the legacy SQLite-only host contract.
    const supplied = request?.headers.get(VAULT_REF_HEADER);
    let ref: VaultRef | undefined;
    if (supplied) {
      if (!secretEquals(request!.headers.get(INTERNAL_SECRET_HEADER), this.host().internalSecret)) throw new Error("Untrusted vault identity");
      ref = JSON.parse(decodeURIComponent(supplied)) as VaultRef;
      if (typeof ref.tenantId !== "string" || !ref.tenantId || typeof ref.databaseName !== "string" || !ref.databaseName || (ref.vaultId !== undefined && (typeof ref.vaultId !== "string" || !ref.vaultId))) throw new Error("Invalid vault identity");
      const name = (this.bindings().objectName ?? vaultObjectName)(ref);
      if (!this.bindings().vaultDb.idFromName(name).equals(this.ctx.id)) throw new Error("Vault identity does not match this object");
      await this.host().loadVaultPolicy(ref);
      this.resolvedVaultRef = ref;
      await this.ctx.storage.put("livesync_vault_identity", ref);
    } else if (!this.resolvedVaultRef) {
      this.resolvedVaultRef = await this.ctx.storage.get<VaultRef>("livesync_vault_identity") ?? null;
    }
    if (this.bindings().contentBucket && !this.vaultRef()) throw new Error("Persistent vault identity unavailable");
  }

  private journal(): R2Journal | null {
    const bucket = this.bindings().contentBucket;
    if (!bucket) return null; // legacy host compatibility; deployed Worker always opts in
    const ref = this.vaultRef();
    if (!ref) throw new Error("R2 storage requires a named vault DO");
    const prefix = contentPrefix(ref.tenantId, ref.vaultId ?? ref.databaseName);
    if (!this.contentJournal || this.contentJournal.bucket !== bucket || this.contentJournal.prefix !== prefix) this.contentJournal = new R2Journal(bucket, prefix, 3);
    return this.contentJournal;
  }

  private sqlExec<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(query: string, ...args: unknown[]): SqlStorageCursor<T> {
    const cursor = this.ctx.storage.sql.exec<T>(query, ...args);
    if (this.statements && /^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(query.trim()) &&
        /\b(meta|docs|revs|rev_metadata|local_docs|changes|rev_body_chunks)\b/.test(query)) {
      this.statements.push({ sql: query, args: args as Array<string | number | null> });
    }
    return cursor;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writes;
    let release!: () => void;
    this.writes = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private async restoreJournal(force = false): Promise<void> {
    const journal = this.journal();
    if (!journal) return;
    const head = (await journal.head()).commit;
    if (!force && this.getMeta("r2_applied_head_v3") === head && head != null) {
      this.journalHead = head;
      return;
    }
    if (!force && head == null && this.journalHead === null && !this.dbExists()) return;
    // Refuse implicit migration of an existing SQLite-only vault.
    if (this.journalHead === undefined && !head && this.dbExists()) {
      throw new Error("Legacy vault requires explicit R2 migration before writes");
    }
    const applied = force ? null : this.getMeta("r2_applied_head_v3");
    this.statements = null;
    const clear = () => {
      this.sqlExec("DELETE FROM checkpoint_work");
      this.sqlExec("DELETE FROM checkpoint_dirty");
      for (const table of ["docs", "revs", "rev_metadata", "local_docs", "changes", "rev_body_chunks", "meta", "index_state"]) this.sqlExec(`DELETE FROM ${table}`);
    };
    let fullReset = !applied;
    if (!applied) this.ctx.storage.transactionSync(clear);
    for await (const batch of journal.replay(head, applied)) {
      this.ctx.storage.transactionSync(() => {
        if (batch.reset) { clear(); fullReset = true; }
        for (const statement of batch.statements) this.sqlExec(statement.sql, ...statement.args);
        if (batch.commit) this.setMeta("r2_applied_head_v3", batch.commit);
      });
    }
    this.journalHead = head;
    if (head) this.setMeta("r2_applied_head_v3", head);
    // Search is derived and is rebuilt from recovered content.
    if (fullReset && this.dbExists()) {
      this.requestFullTextRebuild();
      this.setMeta(INDEX_VERSION_META_KEY, "");
    }
  }

  private checkpointWork(): CheckpointWork | null {
    const row = this.first<{ state: string }>("SELECT state FROM checkpoint_work WHERE id = 1");
    return row ? JSON.parse(row.state) as CheckpointWork : null;
  }

  private saveCheckpointWork(work: CheckpointWork): void {
    this.sqlExec("INSERT INTO checkpoint_work (id,state) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state", JSON.stringify(work));
  }

  private async requestCheckpoint(schedule = true): Promise<void> {
    if (!this.checkpointWork()) this.saveCheckpointWork({ phase: "compact", startedSeq: this.currentSeq(), table: 0, cursor: 0, references: [], previous: null });
    if (schedule) await this.scheduleIndexing(25);
  }

  private snapshotRow(table: string, row: Record<string, SqlStorageValue>): JournalStatement {
    const columns = Object.keys(row);
    return { sql: `INSERT OR REPLACE INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, args: Object.values(row) as JournalStatement["args"] };
  }

  private async checkpointPage(work: CheckpointWork, statements: JournalStatement[]): Promise<void> {
    work.references.push({ r2: await this.journal()!.putBody(JSON.stringify({ statements })) });
    if (work.references.length === 128) {
      work.previous = { r2: await this.journal()!.putBody(JSON.stringify({ references: work.references, previous: work.previous })) };
      work.references = [];
    }
  }

  /** One bounded maintenance slice; requests retain their ordinary durable commit. */
  private async runCheckpointSlice(): Promise<void> {
    const work = this.checkpointWork();
    const journal = this.journal();
    if (!work || !journal) return;
    let canonicalChanged = false;
    try {
      if (work.phase === "compact") {
        this.statements = [];
        canonicalChanged = true;
        // Normalize one legacy history per event, keeping even 2 MB rows bounded.
        const legacy = this.first<RevRow>(`SELECT id,rev,rev_history FROM revs WHERE rev_history IS NOT NULL AND rev_history NOT LIKE '{"r2":%' LIMIT 1`);
        if (legacy) {
          const r2 = await journal.putBody(legacy.rev_history!);
          this.sqlExec("UPDATE revs SET rev_history=? WHERE id=? AND rev=?", JSON.stringify({ r2 }), legacy.id, legacy.rev);
        } else {
          const rows = this.rows<RevRow>(`SELECT r.* FROM revs r WHERE r.seq <= ? AND EXISTS (SELECT 1 FROM revs child WHERE child.id=r.id AND child.parent_rev=r.rev) ORDER BY r.gen,r.id,r.rev LIMIT 32`, work.startedSeq);
          const groups = new Map<string,RevRow[]>();
          for (const row of rows) (groups.get(row.id) ?? (groups.set(row.id,[]),groups.get(row.id)!)).push(row);
          const entries = [...groups];
          for (let i=0; i<entries.length; i+=6) {
            const results = await Promise.allSettled(entries.slice(i,i+6).map(([id,records]) => this.archiveRows(id,records)));
            const failure = results.find(result => result.status === "rejected");
            if (failure?.status === "rejected") throw failure.reason;
          }
          for (const row of rows) {
            this.sqlExec("DELETE FROM rev_metadata WHERE id=? AND rev=?", row.id,row.rev);
            this.sqlExec("DELETE FROM revs WHERE id=? AND rev=?", row.id,row.rev);
          }
          if (!rows.length) {
            this.setMeta("monotonic_seq",String(this.currentSeq()));
            this.sqlExec("DELETE FROM changes WHERE seq NOT IN (SELECT MAX(seq) FROM changes GROUP BY id)");
            work.phase = "scan";
          }
        }
        const statements = this.statements!;
        this.statements = null;
        if (statements.length) {
          this.journalHead = await journal.commit(statements,this.journalHead);
          this.setMeta("r2_applied_head_v3",this.journalHead);
        }
        this.saveCheckpointWork(work);
        return;
      }
      if (work.phase === "scan") {
        const tables = Object.keys(CHECKPOINT_KEYS);
        const table = tables[work.table]!;
        const rows = this.rows<Record<string, SqlStorageValue>>(`SELECT rowid AS snapshot_rowid,* FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT 128`,work.cursor);
        const statements: JournalStatement[] = [];
        for (const source of rows) {
          work.cursor = Number(source.snapshot_rowid);
          const { snapshot_rowid: _, ...row } = source;
          if (table === "meta" && ["r2_applied_head_v3", "maintenance_turn"].includes(String(row.key))) continue;
          statements.push(this.snapshotRow(table,row));
        }
        if (statements.length) await this.checkpointPage(work,statements);
        if (rows.length < 128) {
          work.table++; work.cursor = 0;
          if (work.table === tables.length) work.phase = "dirty";
        }
        this.saveCheckpointWork(work);
        return;
      }
      const dirty = this.rows<{ table_name: string; row_key: string }>("SELECT table_name,row_key FROM checkpoint_dirty ORDER BY table_name,row_key LIMIT 128");
      if (dirty.length) {
        const statements = dirty.map(({table_name: table,row_key}) => {
          const keys = CHECKPOINT_KEYS[table]!;
          const args = JSON.parse(row_key) as JournalStatement["args"];
          const where = keys.map(key => `${key}=?`).join(" AND ");
          const row = this.first<Record<string,SqlStorageValue>>(`SELECT * FROM ${table} WHERE ${where}`,...args);
          return row ? this.snapshotRow(table,row) : { sql: `DELETE FROM ${table} WHERE ${where}`,args };
        });
        await this.checkpointPage(work,statements);
        // The cursor/root and consumed changes advance atomically after immutable R2 writes.
        this.ctx.storage.transactionSync(() => {
          for (const row of dirty) this.sqlExec("DELETE FROM checkpoint_dirty WHERE table_name=? AND row_key=?",row.table_name,row.row_key);
          this.saveCheckpointWork(work);
        });
        return;
      }
      // No input can mutate SQLite during this exclusive event. The final overlay
      // records the compaction watermark, and the head CAS publishes that exact state.
      await this.checkpointPage(work,[{ sql:"INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)",args:["checkpoint_seq",String(work.startedSeq)] }]);
      const checkpoint = { r2: await journal.putBody(JSON.stringify({ references: work.references,previous:work.previous,ordered:true })), format: 2 as const };
      canonicalChanged = true;
      this.journalHead = await journal.commit([],this.journalHead,checkpoint);
      this.ctx.storage.transactionSync(() => {
        this.sqlExec("DELETE FROM checkpoint_work");
        this.sqlExec("DELETE FROM checkpoint_dirty");
        this.setMeta("checkpoint_seq",String(work.startedSeq));
        this.setMeta("r2_applied_head_v3",this.journalHead!);
      });
    } catch (error) {
      this.statements = null;
      if (canonicalChanged) {
        await this.restoreJournal(true);
        if (this.dbExists()) await this.requestCheckpoint(false);
      }
      throw error;
    }
  }

  private async archiveRows(id: string, records: RevRow[]): Promise<void> {
    const journal = this.journal()!;
    const prior = this.getMeta(`archive:${id}`);
    let previous: { r2: string } | null = prior ? JSON.parse(prior) : null;
    // Preserve 128-record archive pages despite smaller maintenance slices.
    // Replacing an immutable page keeps every older version in the journal.
    if (previous) {
      const page = JSON.parse(await journal.body(previous.r2)) as { records: RevRow[]; previous: { r2: string } | null };
      const incoming = new Set(records.map(record => record.rev));
      const merged = [...records, ...page.records.filter(record => !incoming.has(record.rev))];
      if (merged.length <= 128) { records = merged; previous = page.previous; }
    }
    const r2 = await journal.putBody(JSON.stringify({ records, previous }));
    this.setMeta(`archive:${id}`, JSON.stringify({ r2 }));
  }

  private async archivedRevRow(id: string, rev: string): Promise<RevRow | null> {
    const journal = this.journal();
    let pointer = this.getMeta(`archive:${id}`);
    if (!journal || !pointer) return null;
    const generation = parseRev(rev)?.gen;
    const maximum = this.first<{ gen: number }>("SELECT MAX(gen) AS gen FROM revs WHERE id = ?", id)?.gen;
    if (generation != null && maximum != null && generation >= maximum) return null;
    const seen = new Set<string>();
    while (pointer) {
      const key = JSON.parse(pointer).r2 as string;
      if (seen.has(key)) throw new Error("Revision archive cycle");
      seen.add(key);
      const page = JSON.parse(await journal.body(key)) as { records: RevRow[]; previous: { r2: string } | null };
      const row = page.records.find(row => row.rev === rev);
      if (row) return row;
      pointer = page.previous ? JSON.stringify(page.previous) : null;
    }
    return null;
  }

  private checkpointProgress() {
    const work = this.checkpointWork();
    return work ? { phase: work.phase, startedSeq: work.startedSeq, dirtyKeys: this.first<{ count: number }>("SELECT COUNT(*) AS count FROM checkpoint_dirty")!.count } : null;
  }

  private capacity() {
    const sql = this.ctx.storage.sql;
    const bytes = sql.databaseSize ?? 0;
    const usedBytes = bytes;
    const limitBytes = this.bindings().sqliteMaxBytes ?? 900_000_000;
    const headroomBytes = this.bindings().sqliteHeadroomBytes ?? 100_000_000;
    return { databaseSize: bytes, usedBytes, limitBytes, headroomBytes, writable: usedBytes < limitBytes - headroomBytes };
  }

  private async migrateLegacy(request: Request): Promise<Response> {
    const bucket = this.bindings().contentBucket;
    const ref = this.vaultRef();
    if (!bucket || !ref) return couchError(409, "migration_unavailable", "Content bucket and vault identity required");
    const body = await readJsonBody(request);
    const targetVaultId = typeof body.targetVaultId === "string" ? body.targetVaultId : "";
    if (!targetVaultId || targetVaultId.length > 128) return couchError(400, "bad_request", "Immutable targetVaultId required");
    const journal = new R2Journal(bucket, contentPrefix(ref.tenantId, targetVaultId));
    if ((await journal.head()).commit) return couchError(409, "conflict", "Destination already has persistent data");
    if (this.first(`SELECT 1 FROM revs WHERE body_chunked = 2 LIMIT 1`)) return couchError(409, "conflict", "Source is already R2-backed; vault IDs are immutable");
    const statements: JournalStatement[] = [];
    for (const table of ["meta", "revs", "rev_metadata", "docs", "local_docs", "changes"]) {
      for (const original of this.rows<Record<string, string | number | null>>(`SELECT * FROM ${table}`)) {
        const row = { ...original };
        if (table === "local_docs") {
          const content = String(row.body);
          row.body = JSON.stringify({ r2: await journal.putBody(content) });
        }
        if (table === "revs" && row.body_available) {
          const source = original as unknown as RevRow;
          const content = (await this.hydrateRevision(source)).body;
          row.body = JSON.stringify({ r2: await journal.putBody(content) });
          row.body_chunked = 2;
        }
        const columns = Object.keys(row);
        statements.push({ sql: `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, args: Object.values(row) });
      }
    }
    const commit = await journal.commit(statements, null);
    // The source DO is deliberately left untouched for rollback. Freeze source writes operationally.
    return json({ ok: true, targetVaultId, commit, sourcePreserved: true, statements: statements.length });
  }

  private async persistentRequest(request: Request): Promise<Response> {
    await this.resolveVaultIdentity(request);
    const journal = this.journal();
    if (new URL(request.url).pathname === "/internal/migrate-r2" && request.method === "POST") {
      if (!secretEquals(request.headers.get(INTERNAL_SECRET_HEADER), this.host().internalSecret)) return couchError(403, "forbidden", "Forbidden");
      return this.migrateLegacy(request);
    }
    await this.restoreJournal();
    if (journal) this.statements = [];
    try {
      const path = new URL(request.url).pathname;
      let growth = ["PUT", "DELETE"].includes(request.method) || (request.method === "POST" && path === "/_bulk_docs");
      if (request.method === "POST" && path === "/internal/op") {
        const body = await readJsonBody(request);
        growth = ["writeNote", "writeAttachment"].includes(typeof body.op === "string" ? body.op : "");
      }
      let blocked = false;
      if (journal && growth && !this.capacity().writable) {
        await this.requestCheckpoint();
        blocked = true;
      }
      const response = blocked ? json({ error: "SQLITE_CAPACITY", capacity: this.capacity() }, { status: 507 }) : await this.route(request);
      if (journal && !blocked && growth && this.currentSeq() - Number(this.getMeta("checkpoint_seq") ?? 0) >= 4096) await this.requestCheckpoint();
      const statements = this.statements;
      this.statements = null;
      if (journal && statements?.length) {
        this.journalHead = await journal.commit(statements, this.journalHead);
        this.setMeta("r2_applied_head_v3", this.journalHead);
        this.notifyWatchers();
      }
      return response;
    } catch (error) {
      this.statements = null;
      // R2 head resolves a write whose acknowledgement was lost as well.
      if (journal) await this.restoreJournal(true);
      throw error;
    }
  }


  /** Keep external index writes and purge ordered without blocking other DO events. */
  private async withMaintenance<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.maintenance;
    let release!: () => void;
    this.maintenance = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  constructor(
    protected readonly ctx: DurableObjectState,
    protected readonly env: TEnv,
  ) {
    this.init();
  }

  protected abstract host(): VaultHost;
  protected abstract bindings(): VaultBindings;

  private init(): void {
    const sql = { exec: this.sqlExec.bind(this) };
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        winning_rev TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_seq INTEGER NOT NULL DEFAULT 0
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS revs (
        id TEXT NOT NULL,
        rev TEXT NOT NULL,
        gen INTEGER NOT NULL,
        parent_rev TEXT,
        body TEXT NOT NULL,
        body_chunked INTEGER NOT NULL DEFAULT 0,
        body_available INTEGER NOT NULL DEFAULT 1,
        deleted INTEGER NOT NULL DEFAULT 0,
        seq INTEGER NOT NULL,
        rev_history TEXT,
        PRIMARY KEY (id, rev)
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS local_docs (
        id TEXT PRIMARY KEY,
        rev TEXT NOT NULL,
        body TEXT NOT NULL
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS changes (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL,
        rev TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS rev_body_chunks (
        id TEXT NOT NULL,
        rev TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (id, rev, chunk_index)
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS rev_metadata (
        id TEXT NOT NULL,
        rev TEXT NOT NULL,
        path TEXT,
        size REAL,
        mtime REAL,
        type TEXT,
        soft_deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (id, rev)
      )
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    const schemaVersion = sql.exec<{ version: number }>(
      `SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations`,
    ).one().version;
    const revisionColumns = new Set(
      sql.exec<{ name: string }>(`PRAGMA table_info(revs)`).toArray().map((column) => column.name),
    );
    if (schemaVersion < 1) {
      this.ctx.storage.transactionSync(() => {
        if (!revisionColumns.has("body_chunked")) {
          sql.exec(`ALTER TABLE revs ADD COLUMN body_chunked INTEGER NOT NULL DEFAULT 0`);
        }
        sql.exec(`INSERT INTO _sql_schema_migrations (id) VALUES (1)`);
      });
    }
    if (schemaVersion < 2) {
      this.ctx.storage.transactionSync(() => {
        if (!revisionColumns.has("body_available")) {
          sql.exec(`ALTER TABLE revs ADD COLUMN body_available INTEGER NOT NULL DEFAULT 1`);
        }
        sql.exec(
          `UPDATE revs SET body_available = 0
           WHERE body = '{}' AND body_chunked = 0
             AND EXISTS (
               SELECT 1 FROM revs child
               WHERE child.id = revs.id AND child.parent_rev = revs.rev
             )`,
        );
        sql.exec(`INSERT INTO _sql_schema_migrations (id) VALUES (2)`);
      });
    }
    if (schemaVersion < 3) {
      // Replicated revisions whose skipped ancestors were never recorded left
      // the stored ancestor as a leaf (a phantom conflict that resurrected
      // deleted notes). Reconnect the trees and recompute winners, and make
      // docs.updated_seq the document's latest change.
      const touched = new Set<string>();
      this.ctx.storage.transactionSync(() => {
        // Rows whose parent is missing, or that were stored without one
        // (a short history) although they are not first-generation.
        const orphans = sql
          .exec<{ id: string; rev: string; seq: number; rev_history: string | null }>(
            `SELECT r.id, r.rev, r.seq, r.rev_history FROM revs r
             WHERE (r.parent_rev IS NULL AND r.gen > 1)
                OR (r.parent_rev IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM revs p WHERE p.id = r.id AND p.rev = r.parent_rev))`,
          )
          .toArray();
        for (const orphan of orphans) {
          let revisions: unknown = null;
          try {
            revisions = orphan.rev_history ? JSON.parse(orphan.rev_history) : null;
          } catch {
            // Unreadable history: leave this branch as it is.
          }
          if (!revisions) continue;
          const ancestors = ancestorsFromRevisions({ _rev: orphan.rev, _revisions: revisions });
          if (ancestors.length === 0) continue;
          sql.exec(
            `UPDATE revs SET parent_rev = ? WHERE id = ? AND rev = ? AND parent_rev IS NULL`,
            ancestors[0],
            orphan.id,
            orphan.rev,
          );
          this.linkAncestors(orphan.id, ancestors, orphan.seq);
          touched.add(orphan.id);
        }
        for (const id of touched) {
          const before = this.first<DocRow>(`SELECT * FROM docs WHERE id = ?`, id);
          this.recalculateWinner(id);
          const after = this.first<DocRow>(`SELECT * FROM docs WHERE id = ?`, id);
          if (!after?.winning_rev || after.winning_rev === before?.winning_rev) continue;
          // Clients that replicated the phantom winner have checkpoints past
          // this document; a new change row is the only way they learn of
          // the corrected winner.
          sql.exec(
            `INSERT INTO changes (seq, id, rev, deleted) VALUES (?, ?, ?, ?)`,
            this.nextSeq(),
            id,
            after.winning_rev,
            after.deleted,
          );
        }
        sql.exec(
          `UPDATE docs SET updated_seq =
             (SELECT COALESCE(MAX(seq), 0) FROM changes WHERE changes.id = docs.id)`,
        );
        sql.exec(`INSERT INTO _sql_schema_migrations (id) VALUES (3)`);
      });
      if (touched.size > 0) {
        // Winners changed without a new change row; re-scan the search indexes
        // (unchanged notes are skipped by hash, so nothing is re-embedded).
        this.setMeta(INDEXED_SEQ_META_KEY, "0");
        this.armFtsBuild(0);
        void this.scheduleIndexing(0);
      }
    }
    if (schemaVersion < 4) {
      const metadataColumns = new Set(
        sql.exec<{ name: string }>(`PRAGMA table_info(rev_metadata)`).toArray().map((column) => column.name),
      );
      this.ctx.storage.transactionSync(() => {
        if (!metadataColumns.has("soft_deleted")) {
          sql.exec(`ALTER TABLE rev_metadata ADD COLUMN soft_deleted INTEGER NOT NULL DEFAULT 0`);
        }
        sql.exec(
          `UPDATE rev_metadata SET soft_deleted = COALESCE((
             SELECT json_extract(r.body, '$.deleted') = 1 FROM revs r
             WHERE r.id = rev_metadata.id AND r.rev = rev_metadata.rev AND r.body_chunked = 0
           ), 0)`,
        );
        const chunked = this.rows<RevRow>(`SELECT r.* FROM revs r
          JOIN rev_metadata m ON m.id = r.id AND m.rev = r.rev WHERE r.body_chunked = 1`);
        for (const row of chunked) {
          sql.exec(`UPDATE rev_metadata SET soft_deleted = ? WHERE id = ? AND rev = ?`,
            revisionMetadata(cloneBody(row.body_chunked ? { ...row, body: this.revisionBody(row) } : row)).soft_deleted, row.id, row.rev);
        }
        sql.exec(`INSERT INTO _sql_schema_migrations (id) VALUES (4)`);
      });
    }
    sql.exec(`
      CREATE TABLE IF NOT EXISTS index_state (
        path TEXT PRIMARY KEY,
        doc_id TEXT,
        hash TEXT,
        chunks INTEGER NOT NULL DEFAULT 0,
        pending INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0
      )
    `);
    const indexStateColumns = new Set(
      sql.exec<{ name: string }>(`PRAGMA table_info(index_state)`).toArray().map((column) => column.name),
    );
    if (!indexStateColumns.has("fts_hash")) {
      // NULL rows are pending for the full-text index (built-in or external).
      sql.exec(`ALTER TABLE index_state ADD COLUMN fts_hash TEXT`);
    }
    if (this.getMeta(FTS_INDEX_VERSION_META_KEY) !== CURRENT_FTS_INDEX_VERSION) {
      // Upgrading from the whole-vault build: its "too large" / "interrupted"
      // verdicts do not apply to the segmented index, which picks up every
      // note (fts_hash is NULL for all of them) in bounded passes. Arming a
      // pass also lets the maintenance step rewrite older segment formats.
      sql.exec(`DELETE FROM meta WHERE key = ?`, FTS_ERROR_META_KEY);
      this.setMeta(FTS_INDEX_VERSION_META_KEY, CURRENT_FTS_INDEX_VERSION);
      this.armFtsBuild(0);
    }
    sql.exec("CREATE TABLE IF NOT EXISTS checkpoint_work (id INTEGER PRIMARY KEY CHECK(id = 1), state TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS checkpoint_dirty (table_name TEXT NOT NULL, row_key TEXT NOT NULL, PRIMARY KEY(table_name,row_key))");
    for (const [table, keys] of Object.entries(CHECKPOINT_KEYS)) {
      for (const event of ["INSERT", "UPDATE", "DELETE"]) {
        const versions = event === "UPDATE" ? ["OLD", "NEW"] : [event === "DELETE" ? "OLD" : "NEW"];
        const changes = versions.map(version => {
          const rowKey = `json_array(${keys.map(key => `${version}.${key}`).join(",")})`;
          const condition = table === "meta" ? ` AND ${version}.key NOT IN ('r2_applied_head_v3','maintenance_turn')` : "";
          return `INSERT INTO checkpoint_dirty (table_name,row_key) SELECT '${table}', ${rowKey} WHERE NOT EXISTS (SELECT 1 FROM checkpoint_dirty WHERE table_name='${table}' AND row_key=${rowKey})${condition};`;
        }).join(" ");
        sql.exec(`DROP TRIGGER IF EXISTS checkpoint_${table}_${event}`);
        sql.exec(`CREATE TRIGGER checkpoint_${table}_${event} AFTER ${event} ON ${table}
          WHEN EXISTS (SELECT 1 FROM checkpoint_work WHERE json_extract(state,'$.phase') <> 'compact') BEGIN ${changes} END`);
      }
    }
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_revs_id ON revs (id)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_revs_parent ON revs (id, parent_rev)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_changes_id ON changes (id)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_docs_updated_seq ON docs (updated_seq)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_rev_metadata_path ON rev_metadata (path)`);
  }

  async fetch(request: Request): Promise<Response> {
    // `return await`: a handler's rejected promise must reach this catch,
    // which a bare `return handler()` inside try would skip.
    try {
      // Read and validate before entering the mutation/commit path, including direct internal calls.
      const body = await readJsonBody(request);
      if (["/_bulk_docs", "/_bulk_get"].includes(new URL(request.url).pathname) && request.method === "POST") assertBulkLimits(body);
      return await this.exclusive(() => this.persistentRequest(request));
    } catch (error) {
      if (error instanceof RequestLimitError) return couchError(413, "request_entity_too_large", error.message);
      console.warn("LiveSync DB request failed", error);
      return couchError(500, "internal_server_error", "Internal server error");
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });
    // Existing databases (created before indexing existed, or indexed under an
    // older index version) catch up on first access.
    if (
      Date.now() - this.lastIndexScheduleAt > 5_000 &&
      this.dbExists() &&
      (this.indexNeedsVersionUpgrade() ||
        this.indexedSeq() < this.currentSeq() ||
        this.hasFullTextBacklog())
    ) {
      void this.scheduleIndexing();
    }
    if (url.pathname.startsWith("/internal/")) {
      if (!secretEquals(request.headers.get(INTERNAL_SECRET_HEADER), this.host().internalSecret)) {
        return couchError(403, "forbidden", "Forbidden");
      }
      if (url.pathname === "/internal/watch" && request.method === "GET") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return couchError(426, "upgrade_required", "Expected WebSocket");
        }
        return this.acceptWatcher();
      }
      if (url.pathname === "/internal/purge" && request.method === "POST") {
        return this.deleteDb();
      }
      if (url.pathname === "/internal/files" && request.method === "GET") {
        return this.listFiles();
      }
      if (url.pathname === "/internal/file" && request.method === "GET") {
        return this.readFile(url.searchParams.get("path") ?? "");
      }
      if (url.pathname === "/internal/op" && request.method === "POST") {
        return this.handleInternalOp((await readJsonBody(request)) as InternalOp);
      }
      return couchError(404, "not_found", "missing");
    }

    const dbName = request.headers.get(DB_NAME_HEADER) ?? "livesync";

    if (parts.length === 0) {
      if (request.method === "HEAD") return this.hasDbHead();
      if (request.method === "GET") return this.dbInfo(dbName);
      if (request.method === "PUT") return this.putDb(dbName);
      if (request.method === "DELETE") return this.deleteDb();
    }

    const first = parts[0]!;
    if (first === "_changes" && (request.method === "GET" || request.method === "POST")) {
      return this.handleChanges(request);
    }
    if (first === "_revs_diff" && request.method === "POST") return this.handleRevsDiff(request);
    if (first === "_bulk_docs" && request.method === "POST") return this.handleBulkDocs(request);
    if (first === "_bulk_get" && request.method === "POST") return this.handleBulkGet(request);
    if (first === "_all_docs" && (request.method === "GET" || request.method === "POST")) {
      return this.handleAllDocs(request);
    }
    if (first === "_find" && request.method === "POST") return this.handleFind(request);
    if (first === "_compact" && request.method === "POST") return this.handleCompact();

    if (first === "_local") {
      const id = decodeURIComponent(parts.slice(1).join("/"));
      return this.handleLocalDoc(request, id);
    }

    const id = decodeURIComponent(parts.join("/"));
    return this.handleDoc(request, id);
  }

  private rows<T>(query: string, ...args: unknown[]): T[] {
    return this.sqlExec(query, ...args).toArray() as T[];
  }

  private first<T>(query: string, ...args: unknown[]): T | null {
    return this.rows<T>(query, ...args)[0] ?? null;
  }

  private getMeta(key: string): string | null {
    return this.first<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sqlExec(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  private dbExists(): boolean {
    return this.getMeta("created") === "1";
  }

  private requireDb(): Response | null {
    return this.dbExists() ? null : couchError(404, "not_found", "Database does not exist.");
  }

  private hasDbHead(): Response {
    return new Response(null, { status: this.dbExists() ? 200 : 404 });
  }

  private putDb(dbName: string): Response {
    if (this.dbExists()) {
      return couchError(
        412,
        "file_exists",
        "The database could not be created, the file already exists.",
      );
    }
    this.setMeta("created", "1");
    this.setMeta("db_name", dbName);
    return json({ ok: true });
  }

  /**
   * Deletes everything the vault holds. External copies (vectors, the FTS
   * index in R2) go first and any failure there aborts the request: the
   * SQLite rows stay, so the caller can retry instead of ending up with an
   * orphaned index that nothing can reach any more.
   */
  private deleteDb(): Promise<Response> {
    return this.withMaintenance(() => this.purgeDb());
  }

  private async purgeDb(): Promise<Response> {
    await this.removeAllVectors();
    const ref = this.vaultRef();
    if (ref) {
      const fullText = this.bindings().fullText;
      if (fullText) await fullText.deleteVault(ref);
      else await deleteFtsIndex(this.ftsBucket(), ref);
    }
    this.sqlExec("DELETE FROM checkpoint_work");
    this.sqlExec("DELETE FROM checkpoint_dirty");
    this.sqlExec(`DELETE FROM docs`);
    this.sqlExec(`DELETE FROM rev_body_chunks`);
    this.sqlExec(`DELETE FROM rev_metadata`);
    this.sqlExec(`DELETE FROM revs`);
    this.sqlExec(`DELETE FROM local_docs`);
    this.sqlExec(`DELETE FROM changes`);
    this.sqlExec(`DELETE FROM meta`);
    this.sqlExec(`DELETE FROM index_state`);
    return json({ ok: true });
  }

  // ---------------------------------------------------------------------
  // Internal API (used by the vault client, never exposed to LiveSync)
  // ---------------------------------------------------------------------

  private async handleInternalOp(body: InternalOp): Promise<Response> {
    switch (body.op) {
      case "contentGc": {
        const journal = this.journal();
        if (!journal) return json({ error: "R2_STORAGE_REQUIRED" }, { status: 409 });
        const work = this.checkpointWork();
        const garbage = await journal.collectGarbage({ execute: body.execute === true, roots: work ? [work.references, work.previous] : [] });
        return json({ execute: body.execute === true, keys: garbage });
      }
      case "listMarkdownPaths": {
        const missing = this.requireDb();
        if (missing) return json({ paths: [] });
        return json({
          paths: this.listNoteFiles()
            .map((file) => file.path)
            .filter((path) => path.endsWith(".md") && !path.startsWith("i:")),
        });
      }
      case "listNoteStats": {
        const missing = this.requireDb();
        if (missing) return json({ files: [] });
        return json({
          files: this.listNoteFiles()
            .filter((file) => file.path.endsWith(".md") && !file.path.startsWith("i:"))
            .map((file) => ({ path: file.path, mtime: file.mtime, size: file.size })),
        });
      }
      case "readNote": {
        const path = typeof body.path === "string" ? body.path : "";
        if (!path || !this.dbExists()) return json({ content: null });
        // Hidden files synced by LiveSync ("internal files") carry an "i:" prefix.
        const content = (await this.fileContent(path)) ?? (await this.fileContent(`i:${path}`));
        return json({ content });
      }
      case "readNotes": {
        // Batch read for FTS snippets: one DO round trip for all hits.
        const paths = Array.isArray(body.paths)
          ? body.paths
              .filter((p): p is string => typeof p === "string")
              .slice(0, 50)
          : [];
        const contents: Record<string, string | null> = {};
        for (const path of paths) contents[path] = null;
        if (this.dbExists() && paths.length > 0) {
          // Single pass over winning revisions; per-path lookups would repeat
          // the JSON-scan fallback that once blew the DO CPU limit.
          const wanted = new Set(paths);
          for (const row of this.listNoteRevisionsForFts(paths)) {
            if (wanted.has(row.fts_path) && contents[row.fts_path] == null) {
              contents[row.fts_path] = (await this.fileContentForRow(row));
            }
          }
        }
        return json({ contents });
      }
      case "resolveFtsHits":
        return this.resolveFtsHits(body);
      case "writeAttachment":
        return this.writeNote(body);
      case "readAttachment": {
        const path = typeof body.path === "string" ? body.path : "";
        if (!isSafeVaultPath(path)) return json({ error: "INVALID_PATH" }, { status: 400 });
        const row = await this.findNoteRow(path);
        if (!row) return json({ error: "NOT_FOUND" }, { status: 404 });
        const doc = cloneBody(row);
        if (doc.type !== "newnote") return json({ error: "NOT_BINARY" }, { status: 400 });
        const base64 = await this.fileContentForRow(row);
        if (base64 == null) return json({ error: "NOT_SYNCED" }, { status: 409 });
        if (base64.length > Math.ceil(REQUEST_LIMITS.maxAttachmentBytes / 3) * 4) return json({ error: "TOO_LARGE" }, { status: 413 });
        let size: number;
        try { size = atob(base64).length; } catch { return json({ error: "INVALID_BASE64" }, { status: 400 }); }
        if (size > REQUEST_LIMITS.maxAttachmentBytes) return json({ error: "TOO_LARGE" }, { status: 413 });
        return json({ path, base64, contentHash: await hashText(base64), contentType: doc.contentType ?? "application/octet-stream", size });
      }
      case "listFiles":
        return this.listFiles();
      case "writeNote":
        return this.writeNote(body);
      case "reindex":
        if (this.vaultRef()) await this.bindings().fullText?.beginRebuild?.(this.vaultRef()!);
        this.setMeta(INDEXED_SEQ_META_KEY, "0");
        this.requestFullTextRebuild();
        await this.scheduleIndexing(0);
        return json({ ok: true });
      case "ftsRebuild":
        if (!this.vaultRef() || await this.bindings().fullText?.beginRebuild?.(this.vaultRef()!) !== false) this.requestFullTextRebuild();
        await this.scheduleIndexing(0);
        return json({ ok: true });
      case "indexStatus":
        return json({
          ...(this.externalFullText()
            ? {
                fullText: {
                  indexed: this.first<{ count: number }>(
                    `SELECT COUNT(*) AS count FROM index_state WHERE fts_hash IS NOT NULL`,
                  )?.count ?? 0,
                  pending: this.first<{ count: number }>(
                    `SELECT COUNT(*) AS count FROM index_state WHERE fts_hash IS NULL`,
                  )?.count ?? 0,
                },
              }
            : {}),
          capacity: this.capacity(),
          checkpoint: this.checkpointProgress(),
          indexedSeq: this.indexedSeq(),
          currentSeq: this.currentSeq(),
          indexed: this.first<{ count: number }>(
            `SELECT COUNT(*) AS count FROM index_state WHERE pending = 0`,
          )?.count ?? 0,
          pending: this.first<{ count: number }>(
            `SELECT COUNT(*) AS count FROM index_state WHERE pending = 1`,
          )?.count ?? 0,
          fts: {
            generation: this.getMeta(FTS_GENERATION_META_KEY),
            rebuildAt: Number(this.getMeta(FTS_REBUILD_AT_META_KEY)) || null,
            error: this.getMeta(FTS_ERROR_META_KEY),
            ...(this.externalFullText() ? {} : { pending: this.countFtsPending() }),
          },
        });
      default:
        return json({ error: "Unknown op" }, { status: 400 });
    }
  }

  private async writeNote(body: InternalOp): Promise<Response> {
    const path = typeof body.path === "string" ? body.path : "";
    const content = typeof body.content === "string" ? body.content : null;
    const expectedBaseHash =
      typeof body.expectedBaseHash === "string" ? body.expectedBaseHash : "";
    const binary = body.op === "writeAttachment";
    if ((!binary && !path.endsWith(".md")) || !isSafeVaultPath(path) || content == null) {
      return json({ error: "Invalid Markdown note path" }, { status: 400 });
    }
    if (this.journal() && !expectedBaseHash) return json({ error: "EXPECTED_HASH_REQUIRED" }, { status: 400 });
    let byteSize = content ? enc.encode(content).byteLength : 0;
    if (binary && content != null) {
      if (content.length > Math.ceil(REQUEST_LIMITS.maxAttachmentBytes / 3) * 4) return json({ error: "TOO_LARGE" }, { status: 413 });
      if ((content.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(content) || /=/.test(content.slice(0, -2)) || !/^(?:[A-Za-z0-9+/]{2}|[A-Za-z0-9+/]=|==)$/.test(content.slice(-2)) && content.length !== 0)) return json({ error: "INVALID_BASE64" }, { status: 400 });
      byteSize = atob(content).length;
      if (byteSize > REQUEST_LIMITS.maxAttachmentBytes) return json({ error: "TOO_LARGE" }, { status: 413 });
    }
    if (!this.dbExists()) {
      return json({ error: "LiveSync database does not exist" }, { status: 409 });
    }

    const existing = (await this.findNoteRow(path, true));
    const existingDoc = existing ? cloneBody(existing) : null;
    const currentContent = existing && !docIsDeleted(existingDoc!)
      ? (await this.fileContentForRow(existing))
      : "";
    if (currentContent == null) {
      return json({ error: "CONFLICT", path, reason: "Note content is not fully synced" }, { status: 409 });
    }
    if (expectedBaseHash) {
      if ((await hashText(currentContent)) !== expectedBaseHash) {
        return json({ error: "CONFLICT", path }, { status: 409 });
      }
    }

    const pieces = splitNoteContentForChunks(content);
    const children: string[] = [];
    for (const piece of pieces) {
      const chunkId = await writeChunkId(piece);
      children.push(chunkId);
      const current = this.rawWinningRow(chunkId);
      if (current && !current.deleted) continue;
      const result = await this.insertRevision(
        { _id: chunkId, type: "leaf", data: piece },
        { newEdits: true },
      );
      if (!result.ok) {
        return json({ error: "WRITE_FAILED", path, reason: result.reason }, { status: 500 });
      }
    }

    const journal = this.journal();
    const binaryKey = binary && journal ? await journal.putBytes(Uint8Array.from(atob(content), (char) => char.charCodeAt(0))) : null;
    const now = Date.now();
    const noteDoc: DocBody = {
      _id: existing?.id ?? noteDocIdForPath(path, this.usesCaseInsensitiveIds()),
      path,
      ...(binaryKey ? { binaryKey } : {}),
      children,
      ctime:
        typeof existingDoc?.ctime === "number" && !docIsDeleted(existingDoc)
          ? existingDoc.ctime
          : now,
      mtime: now,
      size: byteSize,
      type: binary ? "newnote" : "plain",
      ...(binary ? { contentType: typeof body.contentType === "string" ? body.contentType : "application/octet-stream" } : {}),
      eden: {},
    };
    if (existing) noteDoc._rev = existing.rev;
    const result = await this.insertRevision(noteDoc, { newEdits: true });
    if (!result.ok) {
      const status = result.error === "conflict" ? 409 : 500;
      return json(
        { error: status === 409 ? "CONFLICT" : "WRITE_FAILED", path, reason: result.reason },
        { status },
      );
    }
    return json({ ok: true, path, rev: result.rev });
  }

  /** True when existing note ids look lower-cased relative to their paths. */
  private usesCaseInsensitiveIds(): boolean {
    const row = this.first<{ id: string; path: string }>(
      `SELECT d.id, m.path
       FROM docs d
       JOIN rev_metadata m ON m.id = d.id AND m.rev = d.winning_rev
       WHERE m.path IS NOT NULL AND m.path != lower(m.path)
       LIMIT 1`,
    );
    if (!row) return false;
    return row.id !== row.path && row.id.replace(/^\//, "") === row.path.toLowerCase();
  }

  private listNoteFiles(): LiveSyncFileRow[] {
    const files = this.rows<LiveSyncFileRow>(
      `SELECT m.path, m.size, m.mtime, m.type
       FROM docs d
       JOIN rev_metadata m ON m.id = d.id AND m.rev = d.winning_rev
       JOIN revs r ON r.id = d.id AND r.rev = d.winning_rev
       WHERE d.deleted = 0 AND m.path IS NOT NULL
         AND COALESCE(m.type, '') NOT IN ('leaf', 'chunkpack')
         AND m.soft_deleted = 0`,
    );
    files.push(...this.rows<LiveSyncFileRow>(
      `SELECT
         json_extract(r.body, '$.path') AS path,
         json_extract(r.body, '$.size') AS size,
         json_extract(r.body, '$.mtime') AS mtime,
         json_extract(r.body, '$.type') AS type
       FROM docs d
       JOIN revs r ON r.id = d.id AND r.rev = d.winning_rev
       WHERE d.deleted = 0
         AND r.body_chunked = 0
         AND json_type(r.body, '$.path') = 'text'
         AND COALESCE(json_extract(r.body, '$.deleted'), 0) != 1
         AND NOT EXISTS (
           SELECT 1 FROM rev_metadata m WHERE m.id = r.id AND m.rev = r.rev
         )`,
    ));
    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
  }

  private async findNoteRow(path: string, includeDeleted = false, hydrate = true): Promise<RevRow | null> {
    let row = this.first<RevRow>(
      `SELECT r.*
       FROM docs d
       JOIN revs r ON r.id = d.id AND r.rev = d.winning_rev
       JOIN rev_metadata m ON m.id = r.id AND m.rev = r.rev
       WHERE ${includeDeleted ? "1" : "d.deleted = 0"} AND m.path = ?
       LIMIT 1`,
      path,
    );
    if (!row) row = this.first<RevRow>(
      `SELECT r.*
       FROM docs d
       JOIN revs r ON r.id = d.id AND r.rev = d.winning_rev
       WHERE ${includeDeleted ? "1" : "d.deleted = 0"}
         AND r.body_chunked = 0
         AND json_extract(r.body, '$.path') = ?
       LIMIT 1`,
      path,
    );
    if (!row) return null;
    if (!hydrate) {
      const metadata = this.first<{ soft_deleted: number }>("SELECT soft_deleted FROM rev_metadata WHERE id=? AND rev=?", row.id, row.rev);
      return !includeDeleted && (row.deleted || metadata?.soft_deleted) ? null : row;
    }
    const hydrated = (await this.hydrateRevision(row));
    return !includeDeleted && docIsDeleted(cloneBody(hydrated)) ? null : hydrated;
  }

  private async fileContent(path: string): Promise<string | null> {
    const row = (await this.findNoteRow(path));
    return row ? (await this.fileContentForRow(row)) : null;
  }

  /** Reassemble a note's content from inline data or child chunks. */
  private async fileContentForRow(row: RevRow): Promise<string | null> {
    const doc = cloneBody((await this.hydrateRevision(row)));
    if (typeof doc.data === "string") return doc.data;
    if (Array.isArray(doc.data) && doc.data.every((piece) => typeof piece === "string")) {
      return (doc.data as string[]).join("");
    }
    const children = Array.isArray(doc.children)
      ? doc.children.filter((id): id is string => typeof id === "string")
      : [];
    if (children.length === 0) return typeof doc.children === "undefined" ? null : "";

    const eden =
      doc.eden && typeof doc.eden === "object"
        ? (doc.eden as Record<string, { data?: unknown }>)
        : {};
    const chunks = this.rows<RevRow>(
      `SELECT r.*
       FROM docs d
       JOIN revs r ON r.id = d.id AND r.rev = d.winning_rev
       WHERE d.deleted = 0
         AND r.id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(children),
    );
    const dataById = new Map(
      await Promise.all(chunks.map(async (chunk) => {
        const body = cloneBody((await this.hydrateRevision(chunk)));
        return [chunk.id, typeof body.data === "string" ? body.data : null] as const;
      })),
    );
    const content = children.map((id) => {
      const stored = dataById.get(id);
      if (typeof stored === "string") return stored;
      const edenChunk = eden[id];
      return typeof edenChunk?.data === "string" ? edenChunk.data : null;
    });
    return content.every((chunk): chunk is string => typeof chunk === "string")
      ? content.join("")
      : null;
  }

  // ---------------------------------------------------------------------
  // Vectorize indexing (runs in the alarm, driven by the changes feed)
  // ---------------------------------------------------------------------

  /** The vault this object holds, recovered from the object name. */
  protected vaultRef(): VaultRef | null {
    const name = this.ctx.id?.name;
    return this.resolvedVaultRef ?? (name ? parseVaultObjectName(name) : null);
  }

  /**
   * Errors propagate: indexing with a default policy would expose reserved
   * paths and excluded folders, so the alarm retries instead.
   */
  private loadPolicy(ref: VaultRef): Promise<VaultPolicy> {
    return this.host().loadVaultPolicy(ref);
  }

  private indexedSeq(): number {
    return Number(this.getMeta(INDEXED_SEQ_META_KEY) ?? "0") || 0;
  }

  private async scheduleIndexing(delayMs = INDEX_ALARM_DELAY_MS): Promise<void> {
    const storage = this.ctx.storage as Partial<DurableObjectStorage>;
    if (typeof storage.setAlarm !== "function" || !this.vaultRef()) return;
    try {
      const existing = typeof storage.getAlarm === "function" ? await storage.getAlarm() : null;
      const at = Date.now() + delayMs;
      // Reschedule when the stored alarm is in the past: a crash-looped alarm
      // the platform has given up on otherwise blocks every future setAlarm.
      if (existing == null || existing > at || existing <= Date.now()) {
        await storage.setAlarm(at);
      }
      this.lastIndexScheduleAt = Date.now();
    } catch (error) {
      console.warn("Failed to schedule LiveSync indexing", error);
    }
  }

  alarm(): Promise<void> {
    return this.exclusive(async () => {
      await this.resolveVaultIdentity();
      // Pure maintenance can use the last confirmed local head. A new instance or
      // lost applied marker reloads it; every canonical publication still uses CAS.
      if (!this.checkpointWork() || this.journalHead === undefined || this.getMeta("r2_applied_head_v3") !== this.journalHead) await this.restoreJournal();
      return this.withMaintenance(() => this.runAlarm());
    });
  }

  private async runAlarm(): Promise<void> {
    let nextTurn: "index" | "checkpoint" | undefined;
    try {
      const checkpointDue = this.journal() && (this.checkpointWork() || this.currentSeq() - Number(this.getMeta("checkpoint_seq") ?? 0) >= 4096);
      if (checkpointDue && this.getMeta("maintenance_turn") !== "index") {
        nextTurn = "index";
        if (!this.checkpointWork()) await this.requestCheckpoint(false);
        await this.runCheckpointSlice();
        this.setMeta("maintenance_turn", nextTurn);
        await this.scheduleIndexing(this.checkpointWork() ? 25 : 0);
        return;
      }
      nextTurn = "checkpoint";
      const { more, retry, worked } = await this.runIndexing();
      this.setMeta("maintenance_turn", nextTurn);
      if (this.checkpointWork()) await this.scheduleIndexing(25);
      else if (more || worked) await this.scheduleIndexing(0);
      else if (retry) await this.scheduleIndexing(INDEX_RETRY_DELAY_MS);
      else await this.maybeRunFtsBuild();
    } catch (error) {
      // A failed checkpoint may have restored SQLite; persist the other task's
      // next turn afterwards so repeated failures cannot monopolize maintenance.
      if (nextTurn) this.setMeta("maintenance_turn", nextTurn);
      console.warn("LiveSync maintenance failed", error);
      await this.scheduleIndexing(this.checkpointWork() ? 25 : INDEX_RETRY_DELAY_MS);
    }
  }

  private indexNeedsVersionUpgrade(): boolean {
    return this.getMeta(INDEX_VERSION_META_KEY) !== CURRENT_INDEX_VERSION;
  }

  private async runIndexing(): Promise<{
    more: boolean;
    retry: boolean;
    worked: boolean;
  }> {
    const ref = this.vaultRef();
    if (!ref || !this.dbExists()) return { more: false, retry: false, worked: false };
    if (this.indexNeedsVersionUpgrade()) {
      // Clearing hashes defeats the unchanged-note skip below, so every note is
      // re-embedded once under the new index version.
      this.sqlExec(`UPDATE index_state SET hash = NULL, fts_hash = NULL`);
      this.setMeta(INDEXED_SEQ_META_KEY, "0");
      this.setMeta(INDEX_VERSION_META_KEY, CURRENT_INDEX_VERSION);
      await this.bindings().fullText?.beginRebuild?.(ref);
    }
    const policy = await this.loadPolicy(ref);

    const since = this.indexedSeq();
    const changes = this.rows<ChangeRow>(
      `SELECT seq, id, rev, deleted FROM changes WHERE seq > ? ORDER BY seq LIMIT ?`,
      since,
      INDEX_BATCH_SIZE,
    );
    const ids = new Set(changes.map((change) => change.id));

    const fullText = this.bindings().fullText;
    // Vector-indexed notes not yet in the external full-text index.
    const fullTextBacklog = fullText
      ? this.rows<IndexStateRow>(
          `SELECT * FROM index_state
           WHERE fts_hash IS NULL AND pending = 0 AND hash IS NOT NULL AND doc_id IS NOT NULL
           ORDER BY path LIMIT ?`,
          FTS_BACKLOG_BATCH_SIZE,
        )
      : [];

    // Paths whose winning doc changed in this batch.
    const touchedPaths = new Map<string, RevRow | null>();
    let chunkArrived = false;
    for (const id of ids) {
      const row = this.rawWinningRow(id);
      if (!row) continue;
      const metadata = this.first<RevisionMetadata>("SELECT path,size,mtime,type,soft_deleted FROM rev_metadata WHERE id=? AND rev=?", row.id, row.rev);
      if (metadata?.path && metadata.type !== "leaf" && metadata.type !== "chunkpack") {
        touchedPaths.set(metadata.path, row.deleted || metadata.soft_deleted ? null : row);
        continue;
      }
      const doc = metadata ? null : cloneBody(await this.hydrateRevision(row));
      if (doc && isNoteDoc(doc)) { touchedPaths.set(doc.path, row.deleted || docIsDeleted(doc) ? null : row); continue; }
      if (!row.deleted && !metadata?.soft_deleted && (!doc || !docIsDeleted(doc))) chunkArrived = true;
      // Tombstones carry no path; recover it from the index state or an earlier revision.
      const previousPath =
        this.first<{ path: string }>(`SELECT path FROM index_state WHERE doc_id = ?`, id)?.path ??
        this.first<{ path: string }>(
          `SELECT path FROM rev_metadata WHERE id = ? AND path IS NOT NULL ORDER BY rowid DESC LIMIT 1`,
          id,
        )?.path;
      if (previousPath && !touchedPaths.has(previousPath)) {
        touchedPaths.set(previousPath, (await this.findNoteRow(previousPath, false, false)));
      }
    }
    if (chunkArrived) {
      if (this.getMeta("index_chunk_sweep") != null) this.setMeta("index_chunk_sweep_again", "1");
      else this.setMeta("index_chunk_sweep", "");
    }
    const sweep = this.getMeta("index_chunk_sweep");
    const pendingRows = sweep != null
      ? this.rows<IndexStateRow>("SELECT * FROM index_state WHERE pending=1 AND path>? ORDER BY path LIMIT 16", sweep)
      : this.rows<IndexStateRow>("SELECT * FROM index_state WHERE pending=1 AND attempts<? ORDER BY attempts,path LIMIT 16", INDEX_MAX_ATTEMPTS);
    // Chunk arrivals do not carry a path: re-check every pending note when a
    // chunk arrived, however often it was tried before. Without one, only
    // notes still under the periodic retry cap are re-checked.
    for (const pending of pendingRows) {
      if (touchedPaths.has(pending.path)) continue;
      if (sweep != null || pending.attempts < INDEX_MAX_ATTEMPTS) {
        touchedPaths.set(pending.path, (await this.findNoteRow(pending.path, false, false)));
      }
    }
    for (const backlog of fullTextBacklog) {
      if (touchedPaths.has(backlog.path)) continue;
      // doc_id is known here, so skip findNoteRow's JSON-scan fallback.
      const raw = this.rawWinningRow(backlog.doc_id!);
      touchedPaths.set(backlog.path, raw && !raw.deleted ? raw : null);
    }
    // Resume a chunk sweep ahead of newly arriving changes. Its durable cursor
    // advances only over attempted paths, so a time-budget deferral neither
    // consumes a retry nor strands a note already at the retry limit.
    if (sweep != null) {
      const ordered = new Map<string, RevRow | null>();
      for (const pending of pendingRows) if (touchedPaths.has(pending.path)) ordered.set(pending.path, touchedPaths.get(pending.path)!);
      for (const [path, row] of touchedPaths) ordered.set(path, row);
      touchedPaths.clear();
      for (const [path, row] of ordered) touchedPaths.set(path, row);
    }

    // One writer per run, opened on first use. A failed write leaves the note
    // pending so a later run retries it; the vectors are kept either way.
    let writer: Promise<FullTextIndexWriter> | undefined;
    const attemptedPaths = new Set<string>();
    const writeFullText = async (
      path: string,
      work: (writer: FullTextIndexWriter) => Promise<void>,
    ): Promise<boolean> => {
      try {
        attemptedPaths.add(path);
        writer ??= fullText!.openWriter(ref);
        await work(await writer);
        return true;
      } catch (error) {
        console.warn("Full-text index write failed", { path, error });
        return false;
      }
    };

    let retry = false;
    try {
      retry = await this.indexTouchedPaths(touchedPaths, { ref, policy, fullText, writeFullText });
    } finally {
      if (writer) {
        try { await (await writer).close(); }
        catch (error) {
          // A shared writer acknowledges staged notes only when its manifest is
          // published. Mark every attempted path for retry, including deletes.
          retry = true;
          for (const path of attemptedPaths) this.sqlExec(`INSERT INTO index_state (path,fts_hash,pending,attempts) VALUES (?,NULL,1,1)
            ON CONFLICT(path) DO UPDATE SET fts_hash=NULL,pending=1,attempts=index_state.attempts+1`, path);
          console.warn("Full-text publication failed", error);
        }
      }
    }

    if (sweep != null) {
      const deferredAt = pendingRows.findIndex(row => this.indexDeferredPaths.has(row.path));
      if (deferredAt >= 0) {
        if (deferredAt > 0) this.setMeta("index_chunk_sweep", pendingRows[deferredAt - 1]!.path);
      }
      else if (pendingRows.length === 16) this.setMeta("index_chunk_sweep", pendingRows.at(-1)!.path);
      else if (this.getMeta("index_chunk_sweep_again") === "1") { this.setMeta("index_chunk_sweep", ""); this.sqlExec("DELETE FROM meta WHERE key='index_chunk_sweep_again'"); }
      else this.sqlExec("DELETE FROM meta WHERE key='index_chunk_sweep'");
    }
    const lastSeq = changes.at(-1)?.seq ?? since;
    if (lastSeq > since) {
      this.setMeta(INDEXED_SEQ_META_KEY, String(lastSeq));
      if (!fullText) this.armFtsBuild(FTS_BUILD_DEBOUNCE_MS);
    }
    const more = changes.length >= INDEX_BATCH_SIZE || fullTextBacklog.length >= FTS_BACKLOG_BATCH_SIZE || this.indexSliceMore || this.getMeta("index_chunk_sweep") != null;
    if (!more && !retry && !this.hasFullTextBacklog() && !this.first(`SELECT 1 FROM index_state WHERE pending = 1 LIMIT 1`) && this.indexedSeq() >= this.currentSeq()) {
      await fullText?.completeRebuild?.(ref);
    }
    return {
      more,
      retry,
      worked: changes.length > 0,
    };
  }

  /** Track every vector a partially successful upsert might leave behind. */
  private recordPlannedChunks(path: string, docId: string, count: number): void {
    this.sqlExec(
      `INSERT INTO index_state (path, doc_id, hash, chunks, pending, attempts)
       VALUES (?, ?, NULL, ?, 1, 0)
       ON CONFLICT(path) DO UPDATE SET
         doc_id = excluded.doc_id, chunks = MAX(index_state.chunks, excluded.chunks), pending = 1`,
      path,
      docId,
      count,
    );
  }

  /** Brings vectors (and the external full-text index, if any) up to date for these notes. Returns whether to retry later. */
  private indexSliceMore = false;
  private indexDeferredPaths = new Set<string>();

  private async indexTouchedPaths(
    touchedPaths: Map<string, RevRow | null>,
    options: {
      ref: VaultRef;
      policy: VaultPolicy;
      fullText: FullTextIndex | undefined;
      writeFullText: (path: string, work: (writer: FullTextIndexWriter) => Promise<void>) => Promise<boolean>;
    },
  ): Promise<boolean> {
    const { ref, policy, fullText, writeFullText } = options;
    let retry = false;
    this.indexSliceMore = false;
    this.indexDeferredPaths.clear();
    const started = Date.now(); let processed = 0;
    for (const [path, source] of touchedPaths) {
      if (processed >= 16 || processed > 0 && Date.now() - started >= 50) {
        this.indexDeferredPaths.add(path);
        this.sqlExec(`INSERT INTO index_state (path,doc_id,pending,attempts) VALUES (?,?,1,0)
          ON CONFLICT(path) DO UPDATE SET doc_id=excluded.doc_id,pending=1`, path, source?.id ?? null);
        this.indexSliceMore = true; continue;
      }
      processed++;
      const row = source ? await this.hydrateRevision(source) : null;
      const state = this.first<IndexStateRow>(`SELECT * FROM index_state WHERE path = ?`, path);
      const indexable = row != null && cloneBody(row).type !== "newnote" && isIndexableMarkdownPath(path, policy);
      if (!indexable) {
        if (!state && fullText && !(await writeFullText(path, (w) => w.delete(path)))) {
          this.sqlExec(`INSERT INTO index_state (path, pending, attempts) VALUES (?, 1, 1)`, path);
          retry = true;
          continue;
        }
        if (state) {
          await removeNoteVectors(this.bindings(), { ref, path, chunks: state.chunks });
          if (fullText && !(await writeFullText(path, (w) => w.delete(path)))) {
            // Keep the row so the deletion is retried; only the vectors are gone.
            this.sqlExec(
              `UPDATE index_state SET chunks = 0, pending = 1, attempts = attempts + 1 WHERE path = ?`,
              path,
            );
            retry = true;
            continue;
          }
          this.sqlExec(`DELETE FROM index_state WHERE path = ?`, path);
        }
        continue;
      }
      const content = (await this.fileContentForRow(row));
      if (content == null) {
        // Chunks not replicated yet; mark pending. Periodic retries stop at
        // INDEX_MAX_ATTEMPTS, but the note stays pending and is re-checked
        // whenever a chunk arrives.
        const attempts =
          this.first<{ attempts: number }>(
            `INSERT INTO index_state (path, doc_id, hash, chunks, pending, attempts)
             VALUES (?, ?, NULL, 0, 1, 1)
             ON CONFLICT(path) DO UPDATE SET
               doc_id = excluded.doc_id, pending = 1, attempts = index_state.attempts + 1
             RETURNING attempts`,
            path,
            row.id,
          )?.attempts ?? INDEX_MAX_ATTEMPTS;
        if (attempts < INDEX_MAX_ATTEMPTS) retry = true;
        continue;
      }
      const hash = await hashText(content);
      if (!fullText) {
        if (state && !state.pending && state.hash === hash) continue;
        const chunks = await upsertNoteVectors(this.bindings(), {
          ref,
          path,
          content,
          hash,
          previousChunks: state?.chunks ?? 0,
          onChunksPlanned: (count) => this.recordPlannedChunks(path, row.id, count),
        });
        this.sqlExec(
          `INSERT INTO index_state (path, doc_id, hash, chunks, pending, attempts)
           VALUES (?, ?, ?, ?, 0, 0)
           ON CONFLICT(path) DO UPDATE SET
             doc_id = excluded.doc_id, hash = excluded.hash, chunks = excluded.chunks,
             pending = 0, attempts = 0`,
          path,
          row.id,
          hash,
          chunks,
        );
        continue;
      }

      // Vectors and the full-text index are tracked separately, so a failure
      // in one does not redo the other.
      const vectorsCurrent = state?.hash === hash;
      const fullTextCurrent = state?.fts_hash === hash;
      if (state && !state.pending && vectorsCurrent && fullTextCurrent) continue;
      const chunks = vectorsCurrent
        ? state!.chunks
        : await upsertNoteVectors(this.bindings(), {
            ref,
            path,
            content,
            hash,
            previousChunks: state?.chunks ?? 0,
            onChunksPlanned: (count) => this.recordPlannedChunks(path, row.id, count),
          });
      let ftsHash = state?.fts_hash ?? null;
      let ftsFailed = false;
      if (!fullTextCurrent) {
        const oversized = content.length > FTS_MAX_NOTE_CODE_UNITS;
        if (oversized) console.warn("Full-text index skipping oversized note", { path });
        const ok = await writeFullText(path, (w) =>
          oversized
            ? w.delete(path)
            : w.upsert({ path, content, contentHash: hash, mtime: this.noteMtimeForRow(row) }),
        );
        if (ok) ftsHash = hash;
        else ftsFailed = true;
      }
      this.sqlExec(
        `INSERT INTO index_state (path, doc_id, hash, fts_hash, chunks, pending, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           doc_id = excluded.doc_id, hash = excluded.hash, fts_hash = excluded.fts_hash,
           chunks = excluded.chunks, pending = excluded.pending,
           attempts = CASE WHEN excluded.pending = 1 THEN index_state.attempts + 1 ELSE 0 END`,
        path,
        row.id,
        hash,
        ftsHash,
        chunks,
        ftsFailed ? 1 : 0,
        ftsFailed ? 1 : 0,
      );
      if (ftsFailed) retry = true;
    }
    return retry;
  }

  /**
   * Whether notes wait for the full-text index with no pass scheduled to
   * take them: external index backlog, or (built-in) pending notes while
   * nothing is armed. An armed pass or a recorded error means the alarm, or
   * an explicit ftsRebuild, handles it.
   */
  private hasFullTextBacklog(): boolean {
    if (this.externalFullText()) {
      return (
        this.first<{ n: number }>(
          `SELECT 1 AS n FROM index_state
           WHERE fts_hash IS NULL AND pending = 0 AND hash IS NOT NULL LIMIT 1`,
        ) != null
      );
    }
    if (this.getMeta(FTS_ERROR_META_KEY)) return false;
    const due = Number(this.getMeta(FTS_REBUILD_AT_META_KEY)) || null;
    // A pass whose time has come but whose alarm was lost (reset, upgrade)
    // counts as backlog too; the alarm this schedules runs it.
    if (due != null) return due <= Date.now();
    return this.hasFtsPending();
  }

  /** Re-send every note to the full-text index (external: per note; built-in: new segments). */
  private requestFullTextRebuild(): void {
    // Resetting attempts also revives notes that gave up while the index was unreachable.
    this.sqlExec(`UPDATE index_state SET fts_hash = NULL, attempts = 0`);
    if (!this.externalFullText()) {
      this.sqlExec(`DELETE FROM meta WHERE key = ?`, FTS_ERROR_META_KEY);
      // The existing segments keep serving searches until the rebuilt ones
      // cover every note; then they are retired (see runFtsPass).
      this.setMeta(FTS_REBUILD_EPOCH_META_KEY, String(Date.now()));
      this.armFtsBuild(0);
    }
  }

  /**
   * The host's external full-text index, if any. Paths that never looked at
   * bindings before it existed treat a failing bindings() as "none", so they
   * keep behaving as they did.
   */
  private externalFullText(): FullTextIndex | undefined {
    try {
      return this.bindings().fullText;
    } catch {
      return undefined;
    }
  }

  private noteMtimeForRow(row: RevRow): number | null {
    const meta = this.first<{ mtime: number | null }>(
      `SELECT mtime FROM rev_metadata WHERE id = ? AND rev = ?`,
      row.id,
      row.rev,
    );
    if (meta?.mtime != null) return meta.mtime;
    const mtime = cloneBody(row).mtime;
    return typeof mtime === "number" ? mtime : null;
  }

  private ftsBucket(): R2Bucket {
    const bucket = this.bindings().bucket;
    if (!bucket) throw new Error("VaultBindings needs either bucket or fullText");
    return bucket;
  }

  // ---------------------------------------------------------------------
  // Built-in R2 full-text index: one immutable segment per pass, driven by
  // index_state.fts_hash (null or stale = the note waits for the index)
  // ---------------------------------------------------------------------

  private static readonly FTS_PENDING_WHERE = `pending = 0 AND hash IS NOT NULL AND doc_id IS NOT NULL
         AND (fts_hash IS NULL OR fts_hash != hash)`;

  private hasFtsPending(): boolean {
    return (
      this.first<{ n: number }>(
        `SELECT 1 AS n FROM index_state WHERE ${LiveSyncVaultDO.FTS_PENDING_WHERE} LIMIT 1`,
      ) != null
    );
  }

  private countFtsPending(): number {
    return (
      this.first<{ count: number }>(
        `SELECT COUNT(*) AS count FROM index_state WHERE ${LiveSyncVaultDO.FTS_PENDING_WHERE}`,
      )?.count ?? 0
    );
  }

  private armFtsBuild(delayMs: number): void {
    this.setMeta(FTS_REBUILD_AT_META_KEY, String(Date.now() + delayMs));
  }

  private async maybeRunFtsBuild(): Promise<void> {
    if (!this.vaultRef() || !this.dbExists() || this.externalFullText()) return;
    const dueRaw = this.getMeta(FTS_REBUILD_AT_META_KEY);
    let due = dueRaw ? Number(dueRaw) : null;
    if (due == null) {
      // Nothing armed: notes can still be waiting after a reset rolled the
      // arming back, or from before the index tracked them per note.
      if (this.getMeta(FTS_ERROR_META_KEY) || !this.hasFtsPending()) return;
      due = Date.now();
    }
    if (Date.now() < due) {
      await this.scheduleIndexing(due - Date.now());
      return;
    }
    try {
      const more = await this.runFtsPass();
      if (more) {
        this.armFtsBuild(0);
        await this.scheduleIndexing(0);
      } else {
        this.sqlExec(`DELETE FROM meta WHERE key = ?`, FTS_REBUILD_AT_META_KEY);
      }
    } catch (error) {
      console.warn("FTS pass failed", error);
      this.armFtsBuild(FTS_BUILD_RETRY_MS);
      await this.scheduleIndexing(FTS_BUILD_RETRY_MS);
    }
  }

  /**
   * One alarm event's worth of full-text work: index pending notes into a
   * new segment, or, once nothing is pending, one maintenance step (retire
   * the legacy generation, merge two segments). Returns whether another pass
   * is needed right away.
   */
  private async runFtsPass(): Promise<boolean> {
    const ref = this.vaultRef();
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
      this.setMeta(FTS_ERROR_META_KEY, message);
      return false;
    }
    const marker = { attempts };

    const pending = this.rows<{ path: string; doc_id: string; hash: string }>(
      `SELECT path, doc_id, hash FROM index_state
       WHERE ${LiveSyncVaultDO.FTS_PENDING_WHERE}
       ORDER BY path LIMIT ?`,
      FTS_SEGMENT_MAX_DOCS + 1,
    );
    if (pending.length > 0) {
      await markFtsPhase(bucket, ref, "segment-start", { ...marker, pending: pending.length });
      const manifest = await readFtsManifest(bucket, ref);
      const maxTotal = this.bindings().ftsMaxTotalCodeUnits ?? FTS_MAX_TOTAL_CODE_UNITS;
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
          console.warn("FTS pass over the size guard; rewriting a segment to drop stale text", { segment: rewrite.segments[0]?.id });
          await this.runFtsCompaction(ref, rewrite, marker, "current");
          return true;
        }
        const message = `vault exceeds the full-text size guard (${error.codeUnits.toLocaleString("en")}+ of ${error.limit.toLocaleString("en")} code units)`;
        console.warn("FTS pass aborted: vault exceeds size guard", { codeUnits: error.codeUnits });
        await markFtsPhase(bucket, ref, "too-large", { codeUnits: error.codeUnits });
        this.setMeta(FTS_ERROR_META_KEY, message);
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
      this.sqlExec(`DELETE FROM meta WHERE key = ?`, FTS_REBUILD_EPOCH_META_KEY);
      console.log("FTS outdated segments retired", { segments: outdated, rebuild: epoch != null });
      return true;
    }
    if (epoch != null) {
      // Nothing pending and nothing older than the rebuild: it is complete.
      this.sqlExec(`DELETE FROM meta WHERE key = ?`, FTS_REBUILD_EPOCH_META_KEY);
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
          keep === "indexed" ? this.ftsDocIsLive(doc.path, doc.hash ?? null) : this.ftsDocIsCurrent(doc.path, doc.hash ?? null),
        ),
      marker,
    });
    if (merged) this.setMeta(FTS_GENERATION_META_KEY, merged.segment.id);
    console.log("FTS segments compacted", {
      merged: plan.segments.map((s) => s.id),
      into: merged?.segment.id,
      docCount: merged?.segment.docCount,
    });
  }

  private ftsRebuildEpoch(): number | null {
    const raw = this.getMeta(FTS_REBUILD_EPOCH_META_KEY);
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
    const row = this.first<{ hash: string | null }>(`SELECT hash FROM index_state WHERE path = ?`, path);
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
      this.first<{ count: number }>(`SELECT COUNT(*) AS count FROM index_state WHERE fts_hash IS NOT NULL`)?.count ?? 0;
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
        const rev = self.rawWinningRow(row.doc_id);
        const full = rev ? (await self.fileContentForRow(rev)) : null;
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
        const mtime = rev ? self.noteMtimeForRow(rev) : null;
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
    if (result.dropped.length > 0) console.warn("FTS pass dropping notes with too many distinct terms", { paths: result.dropped });
    const settled = new Set([...result.docs.map((doc) => doc.path), ...result.dropped]);
    const indexed = written.filter((row) => settled.has(row.path));
    for (const row of [...indexed, ...skipped]) {
      this.sqlExec(
        `UPDATE index_state SET fts_hash = ? WHERE path = ? AND hash = ?`,
        row.hash,
        row.path,
        row.hash,
      );
    }
    if (result.segment) this.setMeta(FTS_GENERATION_META_KEY, result.segment.id);
    this.sqlExec(`DELETE FROM meta WHERE key = ?`, FTS_ERROR_META_KEY);
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
  private ftsDocIsLive(path: string, hash: string | null): boolean {
    const row = this.first<{ hash: string | null; fts_hash: string | null }>(
      `SELECT hash, fts_hash FROM index_state WHERE path = ?`,
      path,
    );
    if (!row) return false;
    if (hash == null) return row.fts_hash == null;
    return row.fts_hash === hash || (row.fts_hash == null && row.hash === hash);
  }

  /**
   * Check ranked search candidates against the vault's current state, drop
   * replaced/deleted versions and duplicate paths, and return the bodies of
   * the first `limit` survivors (for snippets) in one round trip.
   */
  private async resolveFtsHits(body: InternalOp & { candidates?: unknown; limit?: unknown }): Promise<Response> {
    const candidates = Array.isArray(body.candidates)
      ? body.candidates
          .filter(
            (c): c is { path: string; hash: string | null } =>
              typeof c === "object" && c != null && typeof (c as { path: unknown }).path === "string",
          )
          .slice(0, FTS_RESOLVE_MAX_CANDIDATES)
      : [];
    const limit = typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : 20;
    const hits: Array<{ path: string; hash: string | null; content: string | null }> = [];
    if (!this.dbExists()) return json({ hits });
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (hits.length >= limit) break;
      const hash = typeof candidate.hash === "string" ? candidate.hash : null;
      if (seen.has(candidate.path) || !this.ftsDocIsLive(candidate.path, hash)) continue;
      const docId = this.first<{ doc_id: string | null }>(
        `SELECT doc_id FROM index_state WHERE path = ?`,
        candidate.path,
      )?.doc_id;
      const rev = docId ? this.rawWinningRow(docId) : null;
      if (!rev || rev.deleted) continue;
      const metadata = this.first<{ path: string | null; soft_deleted: number }>(
        `SELECT path, soft_deleted FROM rev_metadata WHERE id = ? AND rev = ?`, rev.id, rev.rev,
      );
      if (metadata && (metadata.soft_deleted || metadata.path !== candidate.path)) continue;
      if (docIsDeleted(cloneBody((await this.hydrateRevision(rev))))) continue;
      const content = (await this.fileContentForRow(rev));
      if (content == null || (hash != null && (await hashText(content)) !== hash)) continue;
      seen.add(candidate.path);
      hits.push({ path: candidate.path, hash, content });
    }
    return json({ hits });
  }

  /**
   * Winning note revisions with their paths in one pass. Per-path lookups
   * (findNoteRow) are unusable here: their fallback JSON-scans every winning
   * rev body per call, which blows the DO CPU limit on a full rebuild.
   */
  private listNoteRevisionsForFts(paths?: string[]): Array<
    RevRow & { fts_path: string; fts_mtime: number | null }
  > {
    const pathBindings = paths ? [JSON.stringify(paths)] : [];
    type FtsRevRow = RevRow & { fts_path: string; fts_mtime: number | null };
    const rows = this.rows<FtsRevRow>(
      `SELECT r.*, m.path AS fts_path, m.mtime AS fts_mtime
       FROM docs d
       JOIN rev_metadata m ON m.id = d.id AND m.rev = d.winning_rev
       JOIN revs r ON r.id = d.id AND r.rev = d.winning_rev
       WHERE d.deleted = 0 AND m.path IS NOT NULL
         AND COALESCE(m.type, '') NOT IN ('leaf', 'chunkpack')
         AND m.soft_deleted = 0
         ${paths ? "AND m.path IN (SELECT value FROM json_each(?))" : ""}`,
      ...pathBindings,
    );
    rows.push(...this.rows<FtsRevRow>(
      `SELECT r.*,
         json_extract(r.body, '$.path') AS fts_path,
         json_extract(r.body, '$.mtime') AS fts_mtime
       FROM docs d
       JOIN revs r ON r.id = d.id AND r.rev = d.winning_rev
       WHERE d.deleted = 0
         AND r.body_chunked = 0
         AND json_type(r.body, '$.path') = 'text'
         AND COALESCE(json_extract(r.body, '$.type'), '') NOT IN ('leaf', 'chunkpack')
         ${paths ? "AND json_extract(r.body, '$.path') IN (SELECT value FROM json_each(?))" : ""}
         AND COALESCE(json_extract(r.body, '$.deleted'), 0) != 1
         AND NOT EXISTS (
           SELECT 1 FROM rev_metadata m WHERE m.id = r.id AND m.rev = r.rev
         )`,
      ...pathBindings,
    ));
    return rows;
  }

  private async removeAllVectors(): Promise<void> {
    const ref = this.vaultRef();
    if (!ref) return;
    const rows = this.rows<IndexStateRow>(`SELECT * FROM index_state WHERE chunks > 0`);
    for (const row of rows) {
      await removeNoteVectors(this.bindings(), { ref, path: row.path, chunks: row.chunks });
    }
  }

  private dbInfo(dbName: string): Response {
    const missing = this.requireDb();
    if (missing) return missing;
    const docCount = this.first<{ count: number }>(
      `SELECT COUNT(*) AS count FROM docs WHERE deleted = 0`,
    )?.count ?? 0;
    const deletedCount = this.first<{ count: number }>(
      `SELECT COUNT(*) AS count FROM docs WHERE deleted = 1`,
    )?.count ?? 0;
    const updateSeq = this.currentSeq();
    return json({
      db_name: this.getMeta("db_name") ?? dbName,
      doc_count: docCount,
      doc_del_count: deletedCount,
      update_seq: updateSeq,
      committed_update_seq: updateSeq,
      compact_running: false,
      disk_format_version: 8,
      instance_start_time: "0",
      purge_seq: 0,
      sizes: { active: 0, disk: 0, external: 0 },
    });
  }

  private listFiles(): Response {
    const missing = this.requireDb();
    if (missing) return missing;
    return json({ files: this.listNoteFiles() });
  }

  private async readFile(path: string): Promise<Response> {
    const missing = this.requireDb();
    if (missing) return missing;
    if (!path) return couchError(400, "bad_request", "File path is required.");
    const row = (await this.findNoteRow(path));
    if (!row) return couchError(404, "not_found", "File not found.");
    return json({ content: (await this.fileContentForRow(row)) });
  }

  private currentSeq(): number {
    return Math.max(Number(this.getMeta("monotonic_seq") ?? 0), this.first<{ seq: number }>(`SELECT COALESCE(MAX(seq), 0) AS seq FROM changes`)?.seq ?? 0);
  }

  private nextSeq(): number {
    return this.currentSeq() + 1;
  }

  // --- change notifications -------------------------------------------------
  //
  // Longpoll/continuous waiting lives in the Worker (see ChangeWatcher). The
  // object never blocks and never arms a timer for it, so between writes it can
  // hibernate; the Worker-held WebSockets below survive hibernation and are the
  // only thing the object needs to wake for.

  private acceptWatcher(): Response {
    if (typeof this.ctx.acceptWebSocket !== "function") {
      return couchError(501, "not_implemented", "WebSockets unavailable");
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private notifyWatchers(): void {
    if (typeof this.ctx.getWebSockets !== "function") return;
    const message = JSON.stringify({ type: "change", seq: this.currentSeq() });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        // peer already gone; the runtime reaps it
      }
    }
  }

  webSocketMessage(): void {
    // Watchers only listen; nothing is expected from them.
  }

  webSocketClose(socket: WebSocket): void {
    try {
      socket.close();
    } catch {
      // already closed
    }
  }

  webSocketError(socket: WebSocket): void {
    try {
      socket.close(1011, "error");
    } catch {
      // already closed
    }
  }

  private rawLeafRevs(id: string): RevRow[] {
    return this.rows<RevRow>(
      `SELECT r.* FROM revs r
       WHERE r.id = ?
         AND NOT EXISTS (
           SELECT 1 FROM revs child WHERE child.id = r.id AND child.parent_rev = r.rev
         )`,
      id,
    );
  }

  private revisionBody(row: RevRow): string {
    if (!row.body_chunked) return row.body;
    const chunks = this.rows<{ body: string }>(
      `SELECT body FROM rev_body_chunks
       WHERE id = ? AND rev = ?
       ORDER BY chunk_index`,
      row.id,
      row.rev,
    );
    if (chunks.length === 0) {
      throw new Error(`Missing chunked LiveSync revision body: ${row.id}@${row.rev}`);
    }
    return chunks.map((chunk) => chunk.body).join("");
  }

  private async hydrateRevision(row: RevRow): Promise<RevRow> {
    if (row.body_chunked === 2) {
      const pointer = JSON.parse(row.body) as { r2: string; part?: string };
      const journal = this.journal();
      if (!journal) throw new Error("Missing content bucket binding");
      if (pointer.part === "body") {
        const stored = JSON.parse(await journal.body(pointer.r2)) as { format: number; body: DocBody; history: unknown };
        if (stored.format !== 3) throw new Error("Unsupported revision envelope");
        return { ...row, body: JSON.stringify(stored.body), body_chunked: 0, rev_history: JSON.stringify(stored.history) };
      }
      const history = row.rev_history ? JSON.parse(row.rev_history) as { r2?: string } : null;
      // Legacy body/history objects are independent; settle both reads before continuing.
      const parts = await Promise.allSettled([journal.body(pointer.r2), history?.r2 ? journal.body(history.r2) : Promise.resolve(row.rev_history)]);
      for (const result of parts) if (result.status === "rejected") throw result.reason;
      return { ...row, body: (parts[0] as PromiseFulfilledResult<string>).value, body_chunked: 0, rev_history: (parts[1] as PromiseFulfilledResult<string | null>).value };
    }
    return row.body_chunked ? { ...row, body: this.revisionBody(row), body_chunked: 0 } : row;
  }

  private async descendantLeafRevs(id: string, rev: string): Promise<RevRow[]> {
    const start = this.rawRevRow(id, rev);
    if (!start) {
      if (!(await this.archivedRevRow(id, rev))) return [];
      const leaves = await this.leafRevs(id);
      const result: RevRow[] = [];
      for (const leaf of leaves) {
        let ancestor: RevRow | null = leaf;
        const seen = new Set<string>();
        while (ancestor) {
          if (ancestor.rev === rev) { result.push(leaf); break; }
          if (seen.has(ancestor.rev)) throw new Error("Revision ancestry cycle");
          seen.add(ancestor.rev);
          ancestor = ancestor.parent_rev ? this.rawRevRow(id, ancestor.parent_rev) ?? await this.archivedRevRow(id, ancestor.parent_rev) : null;
        }
      }
      return result;
    }
    const leaves: RevRow[] = [];
    const pending = [start];
    while (pending.length > 0) {
      const row = pending.pop()!;
      const children = this.rows<RevRow>(
        `SELECT * FROM revs WHERE id = ? AND parent_rev = ?`,
        id,
        row.rev,
      );
      if (children.length === 0) leaves.push(row);
      else pending.push(...children);
    }
    return Promise.all(leaves.map((row) => this.hydrateRevision(row)));
  }

  private async leafRevs(id: string): Promise<RevRow[]> {
    return Promise.all(this.rawLeafRevs(id).map((row) => this.hydrateRevision(row)));
  }

  private recalculateWinner(id: string): void {
    const leaves = this.rawLeafRevs(id);
    if (leaves.length === 0) {
      this.sqlExec(`DELETE FROM docs WHERE id = ?`, id);
      return;
    }
    const winner = leaves.sort(compareWinning).at(-1)!;
    // updated_seq is the document's latest change, not the winner's own seq:
    // a _changes reader must learn that the winner changed (e.g. the old
    // winner was deleted) even when the new winner's revision is old.
    this.sqlExec(
      `INSERT INTO docs (id, winning_rev, deleted, updated_seq)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) FROM changes WHERE id = ?))
       ON CONFLICT(id) DO UPDATE SET
         winning_rev = excluded.winning_rev,
         deleted = excluded.deleted,
         updated_seq = excluded.updated_seq`,
      id,
      winner.rev,
      winner.deleted,
      id,
    );
  }

  private rawWinningRow(id: string): RevRow | null {
    const doc = this.first<DocRow>(`SELECT * FROM docs WHERE id = ?`, id);
    if (!doc?.winning_rev) return null;
    return this.first<RevRow>(`SELECT * FROM revs WHERE id = ? AND rev = ?`, id, doc.winning_rev);
  }

  private async winningRow(id: string): Promise<RevRow | null> {
    const row = this.rawWinningRow(id);
    return row ? (await this.hydrateRevision(row)) : null;
  }

  private rawRevRow(id: string, rev: string): RevRow | null {
    return this.first<RevRow>(`SELECT * FROM revs WHERE id = ? AND rev = ?`, id, rev);
  }

  private async revRow(id: string, rev: string): Promise<RevRow | null> {
    const row = this.rawRevRow(id, rev) ?? await this.archivedRevRow(id, rev);
    return row?.body_available ? (await this.hydrateRevision(row)) : null;
  }

  private conflictsFor(id: string, winningRev: string): string[] {
    return this.rawLeafRevs(id)
      .filter((row) => !row.deleted && row.rev !== winningRev)
      .map((row) => row.rev);
  }

  /**
   * Connects a revision's ancestors (nearest first) into the stored tree:
   * ancestors the replicator skipped become body-less stubs, and an
   * ancestor stored earlier with a shorter history gets its missing parent
   * filled in. Walk the complete supplied path: an existing parent may itself
   * have arrived with a shorter, incomplete history.
   */
  private linkAncestors(id: string, ancestors: string[], seq: number): void {
    for (const [index, rev] of ancestors.entries()) {
      const parentRev = ancestors[index + 1] ?? null;
      const existing = this.rawRevRow(id, rev);
      if (existing) {
        if (existing.parent_rev) continue;
        if (!parentRev) break;
        this.sqlExec(
          `UPDATE revs SET parent_rev = ? WHERE id = ? AND rev = ?`,
          parentRev,
          id,
          rev,
        );
        continue;
      }
      const parsed = parseRev(rev);
      if (!parsed) break;
      this.sqlExec(
        `INSERT INTO revs
           (id, rev, gen, parent_rev, body, body_chunked, body_available, deleted, seq, rev_history)
         VALUES (?, ?, ?, ?, '{}', 0, 0, 0, ?, NULL)`,
        id,
        rev,
        parsed.gen,
        parentRev,
        seq,
      );
    }
  }

  private async writeRevision(row: {
    id: string;
    rev: string;
    gen: number;
    parentRev: string | null;
    ancestors?: string[];
    body: string;
    metadata: RevisionMetadata;
    deleted: number;
    seq: number;
    revHistory: string;
  }): Promise<void> {
    const journal = this.journal();
    const key = journal ? await journal.putBody(JSON.stringify({ format: 3, body: JSON.parse(row.body), history: JSON.parse(row.revHistory) })) : null;
    const historyKey = key;
    // Stop hot ancestry at the archived tree; the full lineage stays in R2.
    if (journal && row.ancestors) {
      const hot: string[] = [];
      for (const rev of row.ancestors) {
        if (!this.rawRevRow(row.id,rev) && await this.archivedRevRow(row.id, rev)) break;
        hot.push(rev);
      }
      row.ancestors = hot;
    }
    const chunks = key ? null : splitRevisionBody(row.body);
    this.ctx.storage.transactionSync(() => {
      if (row.ancestors) this.linkAncestors(row.id, row.ancestors, row.seq);
      this.sqlExec(
        `INSERT INTO revs
           (id, rev, gen, parent_rev, body, body_chunked, body_available, deleted, seq, rev_history)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(id, rev) DO UPDATE SET
           body = excluded.body, body_chunked = excluded.body_chunked, body_available = 1,
           parent_rev = COALESCE(revs.parent_rev, excluded.parent_rev),
           deleted = excluded.deleted, seq = excluded.seq,
           rev_history = COALESCE(excluded.rev_history, revs.rev_history)`,
        row.id,
        row.rev,
        row.gen,
        row.parentRev,
        key ? JSON.stringify({ r2: key, part: "body" }) : chunks ? "{}" : row.body,
        key ? 2 : chunks ? 1 : 0,
        row.deleted,
        row.seq,
        historyKey ? JSON.stringify({ r2: historyKey, part: "history" }) : row.revHistory,
      );
      if (chunks) {
        for (const [chunkIndex, chunk] of chunks.entries()) {
          this.sqlExec(
            `INSERT INTO rev_body_chunks (id, rev, chunk_index, body)
             VALUES (?, ?, ?, ?)`,
            row.id,
            row.rev,
            chunkIndex,
            chunk,
          );
        }
      }
      this.sqlExec(
        `INSERT INTO rev_metadata (id, rev, path, size, mtime, type, soft_deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id, rev) DO UPDATE SET path = excluded.path, size = excluded.size,
           mtime = excluded.mtime, type = excluded.type, soft_deleted = excluded.soft_deleted`,
        row.id,
        row.rev,
        row.metadata.path,
        row.metadata.size,
        row.metadata.mtime,
        row.metadata.type,
        row.metadata.soft_deleted,
      );
      this.sqlExec(
        `INSERT INTO changes (seq, id, rev, deleted) VALUES (?, ?, ?, ?)`,
        row.seq,
        row.id,
        row.rev,
        row.deleted,
      );
      this.setMeta("monotonic_seq", String(row.seq));
      this.recalculateWinner(row.id);
    });
    if (!this.journal()) this.notifyWatchers();
    void this.scheduleIndexing();
  }

  private publicDoc(row: RevRow, options?: { conflicts?: boolean; revs?: boolean }): DocBody {
    const body = options?.revs ? bodyWithRevisions(row) : cloneBody(row);
    body._id = row.id;
    body._rev = row.rev;
    if (row.deleted) body._deleted = true;
    if (options?.conflicts) {
      const conflicts = this.conflictsFor(row.id, row.rev);
      if (conflicts.length > 0) body._conflicts = conflicts;
    }
    return body;
  }

  private async insertRevision(doc: DocBody, options: { newEdits: boolean }): Promise<{
    ok: boolean;
    id: string;
    rev?: string;
    error?: string;
    reason?: string;
  }> {
    assertDocumentSize(doc);
    const id = docIdFromBody(doc);
    if (!id) return { ok: false, id: "", error: "bad_request", reason: "Document id is required." };

    if (options.newEdits) {
      let parentRev = typeof doc._rev === "string" ? doc._rev : null;
      const deletedWinner = this.rawWinningRow(id);
      if (deletedWinner && deletedWinner.deleted && !parentRev) parentRev = deletedWinner.rev;
      const rev = await newRevision(doc, parentRev);
      // Check the tree after the only await, so nothing changed in between.
      const current = this.rawWinningRow(id);
      if (!parentRev && current) {
        return { ok: false, id, error: "conflict", reason: "Document update conflict." };
      }
      // Any current leaf may be extended, not only the winner: deleting a
      // losing revision is how CouchDB conflicts are resolved.
      const parent = parentRev
        ? this.rawLeafRevs(id).find((leaf) => leaf.rev === parentRev) ?? null
        : null;
      if (parentRev && !parent) {
        return { ok: false, id, error: "conflict", reason: "Document update conflict." };
      }
      const seq = this.nextSeq();
      const deleted = doc._deleted === true ? 1 : 0;
      const parsed = parseRev(rev)!;
      const stored: DocBody = { ...withoutMeta(doc), _id: id, _rev: rev };
      if (deleted) stored._deleted = true;
      await this.writeRevision({
        id,
        rev,
        gen: parsed.gen,
        parentRev,
        body: JSON.stringify(stored),
        metadata: revisionMetadata(stored),
        deleted,
        seq,
        revHistory: revisionHistory(stored, rev, parent ? (await this.hydrateRevision(parent)).rev_history : null),
      });
      return { ok: true, id, rev };
    }

    if (typeof doc._rev !== "string" || !parseRev(doc._rev)) {
      return { ok: false, id, error: "bad_request", reason: "Invalid rev format." };
    }
    const hotExisting = this.rawRevRow(id, doc._rev);
    const existing = hotExisting ?? await this.archivedRevRow(id, doc._rev);
    if (existing?.body_available) return { ok: true, id, rev: doc._rev };

    const parsed = parseRev(doc._rev)!;
    const seq = this.nextSeq();
    const deleted = doc._deleted === true ? 1 : 0;
    const ancestors = ancestorsFromRevisions(doc);
    if (existing && !hotExisting && this.journal()) {
      // A late body may also extend incomplete ancestry. These old ancestors
      // belong in the archive, and newly connected hot ancestors cease to be leaves.
      for (let offset = 0; offset < ancestors.length; offset += 128) {
        const records: RevRow[] = [];
        const hotRows: RevRow[] = [];
        for (let i = offset; i < Math.min(offset + 128, ancestors.length); i++) {
          const rev = ancestors[i]!;
          const hot = this.rawRevRow(id, rev);
          const known = hot ?? await this.archivedRevRow(id, rev);
          records.push(known ? { ...known, parent_rev: known.parent_rev ?? ancestors[i + 1] ?? null } : {
            id, rev, gen: parseRev(rev)!.gen, parent_rev: ancestors[i + 1] ?? null,
            body: "{}", body_chunked: 0, body_available: 0, deleted: 0, seq, rev_history: null,
          });
          if (hot) hotRows.push(hot);
        }
        await this.archiveRows(id, records);
        for (const hot of hotRows) {
          this.sqlExec("DELETE FROM rev_metadata WHERE id = ? AND rev = ?", id, hot.rev);
          this.sqlExec("DELETE FROM revs WHERE id = ? AND rev = ?", id, hot.rev);
        }
      }
      const body = JSON.stringify({ ...withoutMeta(doc), _id: id, _rev: doc._rev });
      const r2 = await this.journal()!.putBody(JSON.stringify({ format: 3, body: JSON.parse(body), history: JSON.parse(revisionHistory(doc, doc._rev)) }));
      await this.archiveRows(id, [{ ...existing, parent_rev: existing.parent_rev ?? ancestors[0] ?? null, body: JSON.stringify({ r2, part: "body" }), body_chunked: 2, body_available: 1, deleted, rev_history: JSON.stringify({ r2, part: "history" }) }]);
      this.sqlExec("INSERT INTO changes (seq,id,rev,deleted) VALUES (?,?,?,?)", seq, id, doc._rev, deleted);
      this.setMeta("monotonic_seq", String(seq));
      this.recalculateWinner(id);
      return { ok: true, id, rev: doc._rev };
    }
    const stored: DocBody = { ...withoutMeta(doc), _id: id, _rev: doc._rev };
    await this.writeRevision({
      id,
      rev: doc._rev,
      gen: parsed.gen,
      parentRev: ancestors[0] ?? null,
      ancestors,
      body: JSON.stringify(stored),
      metadata: revisionMetadata(stored),
      deleted,
      seq,
      revHistory: revisionHistory(doc, doc._rev),
    });
    return { ok: true, id, rev: doc._rev };
  }

  private async handleDoc(request: Request, id: string): Promise<Response> {
    const missing = this.requireDb();
    if (missing) return missing;
    if (!id) return couchError(400, "bad_request", "Document id is required.");
    const url = new URL(request.url);

    if (request.method === "GET") {
      const openRevs = url.searchParams.get("open_revs");
      if (openRevs) return (await this.handleOpenRevs(id, openRevs, url));
      const rev = url.searchParams.get("rev");
      const row = rev ? (await this.revRow(id, rev)) : (await this.winningRow(id));
      if (!row) return couchError(404, "not_found", "missing");
      if (row.deleted && !rev) return couchError(404, "not_found", "deleted");
      return json(this.publicDoc(row, {
        conflicts: boolParam(url.searchParams.get("conflicts")),
        revs: boolParam(url.searchParams.get("revs")),
      }), { headers: { etag: `"${row.rev}"` } });
    }

    if (request.method === "PUT") {
      const body = await readJsonBody(request);
      body._id = id;
      const rev = url.searchParams.get("rev");
      if (rev && typeof body._rev !== "string") body._rev = rev;
      const result = await this.insertRevision(body, {
        newEdits: url.searchParams.get("new_edits") !== "false",
      });
      if (!result.ok) return couchError(result.error === "conflict" ? 409 : 400, result.error!, result.reason!);
      return json({ ok: true, id: result.id, rev: result.rev });
    }

    if (request.method === "DELETE") {
      const rev = url.searchParams.get("rev");
      if (!rev) return couchError(400, "bad_request", "rev is required.");
      const body: DocBody = { _id: id, _rev: rev, _deleted: true };
      const result = await this.insertRevision(body, { newEdits: true });
      if (!result.ok) return couchError(409, "conflict", "Document update conflict.");
      return json({ ok: true, id, rev: result.rev });
    }

    return couchError(405, "method_not_allowed", "Method not allowed");
  }

  private async handleOpenRevs(id: string, openRevs: string, url: URL): Promise<Response> {
    let revs: string[];
    if (openRevs === "all") {
      revs = (await this.leafRevs(id)).map((row) => row.rev);
    } else {
      try {
        const parsed = JSON.parse(openRevs) as unknown;
        if (!Array.isArray(parsed)) {
          return couchError(400, "bad_request", "open_revs must be an array.");
        }
        revs = parsed.filter((rev): rev is string => typeof rev === "string");
      } catch {
        return couchError(400, "bad_request", "Invalid open_revs.");
      }
    }
    const includeRevs = boolParam(url.searchParams.get("revs"));
    const latest = boolParam(url.searchParams.get("latest"));
    const rows = (await Promise.all(revs.map(async (rev): Promise<Array<{ ok: DocBody } | { missing: string }>> => {
      const found = latest
        ? (await this.descendantLeafRevs(id, rev))
        : [(await this.revRow(id, rev))].filter((row): row is RevRow => row !== null);
      if (found.length === 0) return [{ missing: rev }];
      return found.map((row) => ({ ok: this.publicDoc(row, { revs: includeRevs }) }));
    }))).flat();
    return json(rows);
  }

  private async handleLocalDoc(request: Request, id: string): Promise<Response> {
    const missing = this.requireDb();
    if (missing) return missing;
    if (!id) return couchError(400, "bad_request", "Local document id is required.");
    const url = new URL(request.url);

    if (request.method === "GET") {
      const row = this.first<LocalDocRow>(`SELECT * FROM local_docs WHERE id = ?`, id);
      if (!row) return couchError(404, "not_found", "missing");
      const pointer = JSON.parse(row.body) as { r2?: string };
      const journal = this.journal();
      const content = journal && typeof pointer.r2 === "string" ? await journal.body(pointer.r2) : row.body;
      return json({ ...JSON.parse(content), _id: `_local/${id}`, _rev: row.rev });
    }

    if (request.method === "PUT") {
      const body = await readJsonBody(request);
      assertDocumentSize(body);
      const existing = this.first<LocalDocRow>(`SELECT * FROM local_docs WHERE id = ?`, id);
      const expectedRev = typeof body._rev === "string" ? body._rev : url.searchParams.get("rev");
      if (existing && existing.rev !== expectedRev) {
        return couchError(409, "conflict", "Document update conflict.");
      }
      if (!existing && expectedRev) {
        return couchError(409, "conflict", "Document update conflict.");
      }
      const hash = await sha1Hex(`${stableJson(withoutMeta(body))}\n${existing?.rev ?? ""}`);
      const latest = this.first<LocalDocRow>(`SELECT * FROM local_docs WHERE id = ?`, id);
      if ((latest?.rev ?? null) !== (existing?.rev ?? null)) {
        return couchError(409, "conflict", "Document update conflict.");
      }
      const rev = `0-${hash.slice(0, 16)}`;
      const localBody = JSON.stringify(withoutMeta(body));
      const journal = this.journal();
      const persistentBody = journal ? JSON.stringify({ r2: await journal.putBody(localBody) }) : localBody;
      this.sqlExec(
        `INSERT INTO local_docs (id, rev, body) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET rev = excluded.rev, body = excluded.body`,
        id,
        rev,
        persistentBody,
      );
      return json({ ok: true, id: `_local/${id}`, rev });
    }

    if (request.method === "DELETE") {
      const existing = this.first<LocalDocRow>(`SELECT * FROM local_docs WHERE id = ?`, id);
      if (!existing) return couchError(404, "not_found", "missing");
      const expectedRev = url.searchParams.get("rev");
      if (expectedRev && existing.rev !== expectedRev) {
        return couchError(409, "conflict", "Document update conflict.");
      }
      this.sqlExec(`DELETE FROM local_docs WHERE id = ?`, id);
      return json({ ok: true, id: `_local/${id}`, rev: existing.rev });
    }

    return couchError(405, "method_not_allowed", "Method not allowed");
  }

  private async handleBulkDocs(request: Request): Promise<Response> {
    const missing = this.requireDb();
    if (missing) return missing;
    const body = await readJsonBody(request);
    const docs = Array.isArray(body.docs) ? (body.docs as DocBody[]) : [];
    const newEdits = body.new_edits !== false;
    const results = [];
    for (const doc of docs) {
      const result = await this.insertRevision(doc, { newEdits });
      results.push(
        result.ok
          ? { ok: true, id: result.id, rev: result.rev }
          : { id: result.id, error: result.error, reason: result.reason },
      );
    }
    return json(results);
  }

  private async handleRevsDiff(request: Request): Promise<Response> {
    const missing = this.requireDb();
    if (missing) return missing;
    const body = await readJsonBody(request);
    const result: Record<string, { missing: string[] }> = {};
    for (const [id, revs] of Object.entries(body)) {
      if (!Array.isArray(revs)) continue;
      const missingRevs: string[] = [];
      for (const rev of revs) if (typeof rev === "string" && !this.rawRevRow(id, rev) && !(await this.archivedRevRow(id, rev))) missingRevs.push(rev);
      if (missingRevs.length > 0) result[id] = { missing: missingRevs };
    }
    return json(result);
  }

  private async handleBulkGet(request: Request): Promise<Response> {
    const missing = this.requireDb();
    if (missing) return missing;
    const url = new URL(request.url);
    const body = await readJsonBody(request);
    const includeRevs = boolParam(body.revs) || boolParam(url.searchParams.get("revs"));
    const latest = boolParam(body.latest) || boolParam(url.searchParams.get("latest"));
    const docs = Array.isArray(body.docs)
      ? (body.docs as Array<{ id?: unknown; rev?: unknown }>)
      : [];
    const results = await Promise.all(docs.map(async (item) => {
      const id = typeof item.id === "string" ? item.id : "";
      const rev = typeof item.rev === "string" ? item.rev : "";
      const rows =
        id && rev
          ? latest
            ? (await this.descendantLeafRevs(id, rev))
            : [(await this.revRow(id, rev))].filter((row): row is RevRow => row !== null)
          : id
            ? (await this.leafRevs(id))
            : [];
      return {
        id,
        docs:
          rows.length > 0
            ? rows.map((row) => ({
                ok: this.publicDoc(row, { revs: includeRevs }),
              }))
            : [{ error: { id, rev, error: "not_found", reason: "missing" } }],
      };
    }));
    return json({ results });
  }

  private async allDocsOptions(request: Request): Promise<Record<string, unknown>> {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await readJsonBody(request) : {};
    return {
      ...Object.fromEntries(url.searchParams.entries()),
      ...body,
    };
  }

  private async handleAllDocs(request: Request): Promise<Response> {
    const missing = this.requireDb();
    if (missing) return missing;
    const options = await this.allDocsOptions(request);
    const includeDocs = boolParam(options.include_docs);
    const conflicts = boolParam(options.conflicts);
    const keys = Array.isArray(options.keys) ? (options.keys as string[]) : null;
    const totalRows = this.first<{ count: number }>(
      `SELECT COUNT(*) AS count FROM docs WHERE deleted = 0`,
    )?.count ?? 0;
    if (keys) {
      return json({
        total_rows: totalRows,
        offset: 0,
        rows: await Promise.all(keys.map((key) => this.allDocsRow(key, includeDocs, conflicts))),
      });
    }

    const descending = boolParam(options.descending);
    const inclusiveEnd = options.inclusive_end === undefined || boolParam(options.inclusive_end);
    const startKey = allDocsKey(options.startkey ?? options.start_key);
    const endKey = allDocsKey(options.endkey ?? options.end_key);
    const clauses = ["deleted = 0"];
    const args: unknown[] = [];
    if (startKey !== null) {
      clauses.push(descending ? "id <= ?" : "id >= ?");
      args.push(startKey);
    }
    if (endKey !== null) {
      clauses.push(
        descending ? (inclusiveEnd ? "id >= ?" : "id > ?") : inclusiveEnd ? "id <= ?" : "id < ?",
      );
      args.push(endKey);
    }
    const skip = Math.max(numberParam(options.skip, 0), 0);
    const limit = options.limit === undefined ? -1 : Math.max(numberParam(options.limit, -1), 0);
    const rows = await Promise.all(this.rows<DocRow>(
      `SELECT * FROM docs WHERE ${clauses.join(" AND ")}
       ORDER BY id ${descending ? "DESC" : "ASC"}
       LIMIT ? OFFSET ?`,
      ...args,
      limit,
      skip,
    ).map((row) => this.allDocsRow(row.id, includeDocs, conflicts)));
    return json({ total_rows: totalRows, offset: skip, rows });
  }

  private async allDocsRow(id: string, includeDoc: boolean, conflicts: boolean): Promise<Record<string, unknown>> {
    const row = (await this.winningRow(id));
    if (!row) return { key: id, error: "not_found" };
    const value: Record<string, unknown> = { rev: row.rev };
    if (row.deleted) value.deleted = true;
    const out: Record<string, unknown> = { id, key: id, value };
    if (includeDoc) out.doc = row.deleted ? null : this.publicDoc(row, { conflicts });
    return out;
  }

  private async handleFind(request: Request): Promise<Response> {
    const missing = this.requireDb();
    if (missing) return missing;
    const body = await readJsonBody(request);
    const selector = (body.selector ?? {}) as Selector;
    const limit = numberParam(body.limit, 25);
    const docs = (await Promise.all(this.rows<DocRow>(`SELECT * FROM docs ORDER BY id`)
      .map((row) => this.winningRow(row.id))))
      .filter((row): row is RevRow => row !== null && !row.deleted)
      .map((row) => this.publicDoc(row))
      .filter((doc) => matchesSelector(doc, selector))
      .slice(0, limit);
    return json({ docs, warning: "no matching index found, create an index to optimize query time" });
  }

  private async handleCompact(): Promise<Response> {
    if (this.journal()) {
      const missing = this.requireDb();
      if (missing) return missing;
      await this.requestCheckpoint();
      return json({ ok: true, pending: true, capacity: this.capacity() }, { status: 202 });
    }
    const missing = this.requireDb();
    if (missing) return missing;
    const sql = { exec: this.sqlExec.bind(this) };
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        `DELETE FROM rev_body_chunks
         WHERE EXISTS (
           SELECT 1 FROM revs child
           WHERE child.id = rev_body_chunks.id AND child.parent_rev = rev_body_chunks.rev
         )`,
      );
      sql.exec(
        `DELETE FROM rev_metadata
         WHERE EXISTS (
           SELECT 1 FROM revs child
           WHERE child.id = rev_metadata.id AND child.parent_rev = rev_metadata.rev
         )`,
      );
      sql.exec(
        `UPDATE revs SET body = '{}', body_chunked = 0, body_available = 0
         WHERE EXISTS (
           SELECT 1 FROM revs child
           WHERE child.id = revs.id AND child.parent_rev = revs.rev
         )`,
      );
      sql.exec(
        `UPDATE changes
         SET rev = (SELECT winning_rev FROM docs WHERE docs.id = changes.id),
             deleted = (SELECT deleted FROM docs WHERE docs.id = changes.id)
         WHERE seq IN (SELECT MAX(seq) FROM changes GROUP BY id)`,
      );
      sql.exec(
        `DELETE FROM changes WHERE seq NOT IN (SELECT MAX(seq) FROM changes GROUP BY id)`,
      );
    });
    return json({ ok: true }, { status: 202 });
  }

  private async handleChanges(request: Request): Promise<Response> {
    const missing = this.requireDb();
    if (missing) return missing;
    const url = new URL(request.url);
    const body = request.method === "POST" ? await readJsonBody(request) : {};
    const options: Record<string, unknown> = {
      ...Object.fromEntries(url.searchParams.entries()),
      ...body,
    };
    if (typeof options.selector === "string") {
      try {
        options.selector = JSON.parse(options.selector);
      } catch {
        return couchError(400, "bad_request", "Invalid selector.");
      }
    }
    const since = normalizeSince(options.since, this.currentSeq());
    // Longpoll and continuous feeds are driven by the Worker, which re-asks
    // after a change notification; here every feed answers immediately.
    const batch = (await this.changeBatch(options, since));
    const idle = batch.rows.length === 0 && batch.lastSeq === since;
    return json(
      {
        results: await Promise.all(batch.rows.map((row) => this.changeResult(row, options))),
        last_seq: batch.lastSeq,
        pending: batch.pending,
      },
      idle ? { headers: { [CHANGES_IDLE_HEADER]: "1" } } : undefined,
    );
  }

  private async changeBatch(options: Record<string, unknown>, since: number): Promise<ChangeBatch> {
    const limit = Math.min(Math.max(numberParam(options.limit, 1000), 1), 5000);
    const selector = (options.selector ?? null) as Selector | null;
    const style = String(options.style ?? "main_only");
    const scanLimit = selector ? Math.min(limit * 10, 5000) : limit;
    const rows: ChangeRow[] = [];
    let lastSeq = since;

    // The limit applies to matching rows, not scanned documents. In particular,
    // a run of chunks must not look like the end of a filtered replication.
    while (rows.length < limit) {
      // Each document appears once, at its latest change (including when
      // deleting a winning revision reveals an older winner).
      const candidates = this.rows<ChangeRow>(
        `SELECT updated_seq AS seq, id, winning_rev AS rev, deleted
         FROM docs
         WHERE updated_seq > ?
         ORDER BY updated_seq
         LIMIT ?`,
        lastSeq,
        scanLimit,
      );
      for (const row of candidates) {
        lastSeq = row.seq;
        if (style === "all_docs") {
          const leaves = this.rawLeafRevs(row.id);
          const matching = selector
            ? (await Promise.all(leaves.map((leaf) => this.hydrateRevision(leaf)))).filter((leaf) => matchesSelector(this.publicDoc(leaf), selector))
            : leaves;
          if (matching.length === 0) continue;
          rows.push({ ...row, revs: matching.map((leaf) => leaf.rev) });
        } else {
          if (selector) {
            const winning = this.rawWinningRow(row.id);
            if (!winning || !matchesSelector(this.publicDoc((await this.hydrateRevision(winning))), selector)) continue;
          }
          rows.push(row);
        }
        if (rows.length === limit) break;
      }
      if (rows.length < limit && candidates.length < scanLimit) {
        lastSeq = this.currentSeq();
        break;
      }
    }
    return {
      rows,
      lastSeq,
      pending: this.first<{ count: number }>(
        `SELECT COUNT(*) AS count FROM docs WHERE updated_seq > ?`,
        lastSeq,
      )?.count ?? 0,
    };
  }

  private async changeResult(row: ChangeRow, options: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {
      seq: row.seq,
      id: row.id,
      changes: (row.revs ?? [row.rev]).map((rev) => ({ rev })),
    };
    if (row.deleted) result.deleted = true;
    if (boolParam(options.include_docs)) {
      const rev = (await this.revRow(row.id, row.rev));
      if (rev) {
        result.doc = this.publicDoc(rev, {
          conflicts: boolParam(options.conflicts),
          revs: boolParam(options.revs),
        });
      }
    }
    return result;
  }
}
