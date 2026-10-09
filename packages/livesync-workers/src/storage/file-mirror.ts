import type { VaultRef } from "../types.js";
import { R2MirrorUploader, MIRROR_LIMITS, FileMirrorChanged, FileMirrorYield, FileMirrorPending, FileMirrorUnsupported, FileMirrorWorkError, type MirrorReader } from "./file-mirror-upload.js";
export { FileMirrorPending, FileMirrorUnsupported } from "./file-mirror-upload.js";

const SCAN_BATCH_SIZE = 32;
const WRITE_BATCH_SIZE = 8;
const WRITE_BATCH_BYTES = 16 * 1024 * 1024;
const WRITE_SLICE_MS = 1_000;
const CHANGE_BATCH_DELAY_MS = 5_000;

export type FileMirrorStatus = {
  prefix: string;
  saved: number;
  pending: number;
  errors: number;
  rebuilding: boolean;
  stale: number;
  active: { path: string; phase: string; decodedBytes: number; uploadedBytes: number; targetRev: string } | null;
};

export function fileMirrorPrefix(ref: VaultRef): string {
  return `files/v1/${encodeURIComponent(ref.tenantId)}/${encodeURIComponent(ref.vaultId ?? ref.databaseName)}/`;
}

function originalPath(path: string): string {
  return path.startsWith("i:") ? path.slice(2) : path;
}

/** Derived latest files. Callers serialize maintenance/purge, but uploads release the request lock. */
export class R2FileMirror {
  readonly prefix: string;

  private readonly sql: SqlStorage;
  readonly uploader: R2MirrorUploader;
  constructor(storage: Pick<DurableObjectStorage, "sql" | "transactionSync">, private readonly bucket: R2Bucket, ref: VaultRef) {
    this.sql = storage.sql;
    this.prefix = fileMirrorPrefix(ref);
    this.uploader = new R2MirrorUploader(storage, bucket, this.prefix);
  }

  static init(sql: Pick<SqlStorage, "exec">): void {
    sql.exec(`CREATE TABLE IF NOT EXISTS file_mirror_state (
      path TEXT PRIMARY KEY, doc_id TEXT, fingerprint TEXT,
      status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, error TEXT
    )`);
    sql.exec("CREATE INDEX IF NOT EXISTS idx_file_mirror_pending ON file_mirror_state (status, attempts, path)");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_file_mirror_doc ON file_mirror_state (doc_id)");
    sql.exec("CREATE TABLE IF NOT EXISTS file_mirror_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    if (!sql.exec<{ name: string }>("PRAGMA table_info(file_mirror_state)").toArray().some(row => row.name === "retry_at")) {
      sql.exec("ALTER TABLE file_mirror_state ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0");
    }
    R2MirrorUploader.init(sql);
  }

  private get(key: string): string | null {
    return this.sql.exec<{ value: string }>("SELECT value FROM file_mirror_meta WHERE key=?", key).toArray()[0]?.value ?? null;
  }

  private set(key: string, value: string): void {
    this.sql.exec("INSERT INTO file_mirror_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);
  }

  reset(): void {
    this.uploader.reset();
    this.sql.exec("DELETE FROM file_mirror_state");
    this.sql.exec("DELETE FROM file_mirror_meta");
    this.set("epoch", crypto.randomUUID());
  }

  hasWork(currentSeq: number): boolean {
    return this.uploader.hasCleanup() || this.get("listed") !== "1" || this.get("scanned") !== "1" || Number(this.get("seq") ?? 0) < currentSeq ||
      this.sql.exec("SELECT 1 FROM file_mirror_state WHERE status IN ('queued','retry') LIMIT 1").toArray().length > 0;
  }

  /** Keep a fixed window from the first committed change; backfills and active batches keep moving. */
  changesCommitted(previousSeq: number): void {
    if (!this.hasWork(previousSeq) && this.get("run_at") == null) {
      this.set("run_at", String(Date.now() + CHANGE_BATCH_DELAY_MS));
    }
  }

  status(): FileMirrorStatus {
    const counts = new Map(this.sql.exec<{ status: string; n: number }>(
      "SELECT status,COUNT(*) AS n FROM file_mirror_state GROUP BY status",
    ).toArray().map(row => [row.status, row.n]));
    return {
      prefix: this.prefix,
      saved: counts.get("ready") ?? 0,
      pending: (counts.get("queued") ?? 0) + (counts.get("waiting") ?? 0) + (counts.get("retry") ?? 0),
      errors: (counts.get("blocked") ?? 0) + (counts.get("retry") ?? 0),
      rebuilding: this.get("listed") !== "1" || this.get("scanned") !== "1",
      stale: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM file_mirror_state WHERE fingerprint IS NOT NULL AND status<>'ready'").one().n,
      active: this.uploader.progress(),
    };
  }

  private queue(path: string, docId: string | null = null): void {
    this.sql.exec(`INSERT INTO file_mirror_state (path,doc_id) VALUES (?,?)
      ON CONFLICT(path) DO UPDATE SET doc_id=COALESCE(excluded.doc_id,file_mirror_state.doc_id),status='queued',attempts=0,error=NULL,retry_at=0`,
    path, docId);
  }

  private queueDocument(id: string): boolean {
    const paths = this.sql.exec<{ path: string; is_source: number }>(`SELECT DISTINCT path,1 AS is_source FROM rev_metadata
      WHERE id=? AND path IS NOT NULL AND COALESCE(type,'') NOT IN ('leaf','chunkpack')
      UNION SELECT path,0 AS is_source FROM file_mirror_state WHERE doc_id=?`, id, id).toArray();
    for (const row of paths) this.queue(row.is_source ? originalPath(row.path) : row.path, id);
    for (const row of this.sql.exec<{ path: string }>("SELECT path FROM file_mirror_dependencies WHERE child_id=?", id)) this.queue(row.path);
    return paths.length > 0;
  }

  private async discover(invoke: <T>(fn: () => Promise<T>) => Promise<T>): Promise<void> {
    if (this.get("epoch") == null) this.set("epoch", crypto.randomUUID());
    if (this.get("format") !== "2") {
      this.sql.exec("UPDATE file_mirror_state SET status='queued',attempts=0,error=NULL,retry_at=0 WHERE status='blocked' AND error LIKE '%mirror limit%'");
      this.set("format", "2");
    }
    // Existing copies are queued too: a recovered DO must remove stale files,
    // even if compaction or purge removed their document/change rows.
    if (this.get("listed") !== "1") {
      const cursor = this.get("list_cursor");
      const page = await invoke(() => this.bucket.list({ prefix: this.prefix, limit: SCAN_BATCH_SIZE, ...(cursor ? { cursor } : {}) }));
      for (const object of page.objects) this.queue(object.key.slice(this.prefix.length));
      if (page.truncated) this.set("list_cursor", page.cursor);
      else this.set("listed", "1");
    }
    if (this.get("scanned") !== "1") {
      const rows = this.sql.exec<{ id: string }>("SELECT id FROM docs WHERE id>? ORDER BY id LIMIT ?", this.get("scan_cursor") ?? "", SCAN_BATCH_SIZE).toArray();
      for (const row of rows) this.queueDocument(row.id);
      if (rows.length === SCAN_BATCH_SIZE) this.set("scan_cursor", rows.at(-1)!.id);
      else this.set("scanned", "1");
    }
    const changes = this.sql.exec<{ seq: number; id: string }>(
      "SELECT seq,id FROM changes WHERE seq>? ORDER BY seq LIMIT ?", Number(this.get("seq") ?? 0), SCAN_BATCH_SIZE,
    ).toArray();
    let chunkArrived = false;
    for (const id of new Set(changes.map(row => row.id))) {
      if (!this.queueDocument(id)) chunkArrived = true;
    }
    if (chunkArrived) {
      this.sql.exec("UPDATE file_mirror_state SET status='queued',attempts=0,error=NULL WHERE status IN ('waiting','blocked')");
    }
    if (changes.length > 0) this.set("seq", String(changes.at(-1)!.seq));
  }

  async run(
    reader: MirrorReader,
    exclusive: <T>(operation: () => Promise<T>) => Promise<T>,
  ): Promise<{ more: boolean; retry: boolean; runAt?: number; retryAt?: number }> {
    let calls = 0;
    const invoke = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (calls >= MIRROR_LIMITS.calls) throw new FileMirrorYield();
      calls++; return fn();
    };
    const io = { get: async (key: string) => {
      if (calls >= MIRROR_LIMITS.calls - 4) throw new FileMirrorYield();
      return invoke(() => this.bucket.get(key));
    } };
    await this.uploader.cleanup(invoke);
    const work = await exclusive(async () => {
      const runAt = Number(this.get("run_at") ?? 0);
      if (runAt > Date.now()) return { batch: [], runAt };
      if (runAt) this.sql.exec("DELETE FROM file_mirror_meta WHERE key='run_at'");
      await this.discover(invoke);
      const batch = this.sql.exec<{ path: string; fingerprint: string | null }>(`SELECT path,fingerprint FROM file_mirror_state
        WHERE status='queued' OR (status='retry' AND retry_at<=?) ORDER BY CASE WHEN path>? THEN 0 ELSE 1 END,
        CASE status WHEN 'queued' THEN 0 ELSE 1 END,attempts,path LIMIT ?`, Date.now(), this.get("last_path") ?? "", WRITE_BATCH_SIZE).toArray();
      return { batch, runAt: null };
    });
    if (work.runAt != null) return { more: false, retry: false, runAt: work.runAt };
    const batch = work.batch;
    const started = Date.now();
    let processedBytes = 0;
    for (const entry of batch) {
      if (Date.now() - started >= WRITE_SLICE_MS && entry !== batch[0]) break;
      const epoch = await exclusive(async () => this.get("epoch"));
      try {
        const key = this.prefix + entry.path;
        if (!entry.path || entry.path.startsWith("/") || entry.path.includes("\\") || /[\u0000-\u001f\u007f]/.test(entry.path) ||
            entry.path.split("/").some(part => !part || part === "." || part === "..") || new TextEncoder().encode(key).length > 1024) {
          throw new FileMirrorUnsupported("Invalid or oversized original file path");
        }
        if (processedBytes >= WRITE_BATCH_BYTES || calls >= MIRROR_LIMITS.calls - 4) break;
        let result = await this.uploader.step(entry.path, entry.fingerprint, epoch!, reader, io, invoke, exclusive, WRITE_BATCH_BYTES - processedBytes);
        processedBytes += result.bytes;
        if (result.kind === "pending" && result.bytes > 0 && processedBytes < WRITE_BATCH_BYTES && calls < MIRROR_LIMITS.calls - 4 && Date.now() - started < WRITE_SLICE_MS) {
          result = await this.uploader.step(entry.path, entry.fingerprint, epoch!, reader, io, invoke, exclusive, WRITE_BATCH_BYTES - processedBytes);
          processedBytes += result.bytes;
        }
        await exclusive(async () => {
          if (this.get("epoch") !== epoch) return;
          this.set("last_path", entry.path);
          if (result.kind === "pending") this.sql.exec("UPDATE file_mirror_state SET status='queued',attempts=0,error=NULL,retry_at=0 WHERE path=?", entry.path);
        });
      } catch (error) {
        const problem = error instanceof FileMirrorWorkError ? error.error : error;
        if (error instanceof FileMirrorWorkError) processedBytes += error.bytes;
        await exclusive(async () => {
          if (this.get("epoch") !== epoch) return;
          this.set("last_path", entry.path);
          const status = problem instanceof FileMirrorChanged || problem instanceof FileMirrorYield ? "queued" : problem instanceof FileMirrorPending ? "waiting" : problem instanceof FileMirrorUnsupported ? "blocked" : "retry";
          const attempts = this.sql.exec<{ attempts: number }>("SELECT attempts FROM file_mirror_state WHERE path=?", entry.path).toArray()[0]?.attempts ?? 0;
          const retryAt = status === "retry" ? Date.now() + Math.max(1, Math.floor(Math.random() * Math.min(15 * 60_000, 5000 * 2 ** Math.min(attempts, 8)))) : 0;
          this.sql.exec("UPDATE file_mirror_state SET status=?,attempts=attempts+1,error=?,retry_at=? WHERE path=?", status, String(problem).slice(0, 512), retryAt, entry.path);
        });
      }
    }
    return exclusive(async () => {
      const retryAt = this.sql.exec<{ next: number | null }>("SELECT MIN(retry_at) AS next FROM file_mirror_state WHERE status='retry'").one().next;
      return {
        more: this.uploader.hasCleanup() || this.get("listed") !== "1" || this.get("scanned") !== "1" ||
          this.sql.exec("SELECT 1 FROM changes WHERE seq>? LIMIT 1", Number(this.get("seq") ?? 0)).toArray().length > 0 ||
          this.sql.exec("SELECT 1 FROM file_mirror_state WHERE status='queued' LIMIT 1").toArray().length > 0,
        retry: retryAt != null, ...(retryAt == null ? {} : { retryAt }),
      };
    });
  }

  async deleteVault(): Promise<void> {
    this.uploader.reset();
    while (this.uploader.hasCleanup()) await this.uploader.cleanup(fn => fn(), true);
    // Re-list the first page after deleting it; no cursor can skip a removed key.
    for (;;) {
      const page = await this.bucket.list({ prefix: this.prefix, limit: 256 });
      if (page.objects.length === 0) break;
      await this.bucket.delete(page.objects.map(object => object.key));
    }
    this.reset();
  }
}
