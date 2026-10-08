import type { VaultRef } from "../types.js";

const SCAN_BATCH_SIZE = 32;
const WRITE_BATCH_SIZE = 8;
const WRITE_BATCH_BYTES = 16 * 1024 * 1024;
const WRITE_SLICE_MS = 1_000;
const CHANGE_BATCH_DELAY_MS = 5_000;

export type MirroredFile = {
  docId: string;
  bytes: Uint8Array;
  contentType: string;
  contentHash: string;
  mtime: number | null;
};

export type FileMirrorStatus = {
  prefix: string;
  saved: number;
  pending: number;
  errors: number;
  rebuilding: boolean;
};

export class FileMirrorPending extends Error {}
export class FileMirrorUnsupported extends Error {}

export function fileMirrorPrefix(ref: VaultRef): string {
  return `files/v1/${encodeURIComponent(ref.tenantId)}/${encodeURIComponent(ref.vaultId ?? ref.databaseName)}/`;
}

function originalPath(path: string): string {
  return path.startsWith("i:") ? path.slice(2) : path;
}

/** Derived latest files. Callers serialize maintenance/purge, but uploads release the request lock. */
export class R2FileMirror {
  readonly prefix: string;

  constructor(private readonly sql: Pick<SqlStorage, "exec">, private readonly bucket: R2Bucket, ref: VaultRef) {
    this.prefix = fileMirrorPrefix(ref);
  }

  static init(sql: Pick<SqlStorage, "exec">): void {
    sql.exec(`CREATE TABLE IF NOT EXISTS file_mirror_state (
      path TEXT PRIMARY KEY, doc_id TEXT, fingerprint TEXT,
      status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, error TEXT
    )`);
    sql.exec("CREATE INDEX IF NOT EXISTS idx_file_mirror_pending ON file_mirror_state (status, attempts, path)");
    sql.exec("CREATE INDEX IF NOT EXISTS idx_file_mirror_doc ON file_mirror_state (doc_id)");
    sql.exec("CREATE TABLE IF NOT EXISTS file_mirror_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  private get(key: string): string | null {
    return this.sql.exec<{ value: string }>("SELECT value FROM file_mirror_meta WHERE key=?", key).toArray()[0]?.value ?? null;
  }

  private set(key: string, value: string): void {
    this.sql.exec("INSERT INTO file_mirror_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);
  }

  reset(): void {
    this.sql.exec("DELETE FROM file_mirror_state");
    this.sql.exec("DELETE FROM file_mirror_meta");
    this.set("epoch", crypto.randomUUID());
  }

  hasWork(currentSeq: number): boolean {
    return this.get("listed") !== "1" || this.get("scanned") !== "1" || Number(this.get("seq") ?? 0) < currentSeq ||
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
    };
  }

  private queue(path: string, docId: string | null = null): void {
    this.sql.exec(`INSERT INTO file_mirror_state (path,doc_id) VALUES (?,?)
      ON CONFLICT(path) DO UPDATE SET doc_id=COALESCE(excluded.doc_id,file_mirror_state.doc_id),status='queued',attempts=0,error=NULL`,
    path, docId);
  }

  private queueDocument(id: string): boolean {
    const paths = this.sql.exec<{ path: string; is_source: number }>(`SELECT DISTINCT path,1 AS is_source FROM rev_metadata
      WHERE id=? AND path IS NOT NULL AND COALESCE(type,'') NOT IN ('leaf','chunkpack')
      UNION SELECT path,0 AS is_source FROM file_mirror_state WHERE doc_id=?`, id, id).toArray();
    for (const row of paths) this.queue(row.is_source ? originalPath(row.path) : row.path, id);
    return paths.length > 0;
  }

  private async discover(): Promise<void> {
    if (this.get("epoch") == null) this.set("epoch", crypto.randomUUID());
    // Existing copies are queued too: a recovered DO must remove stale files,
    // even if compaction or purge removed their document/change rows.
    if (this.get("listed") !== "1") {
      const cursor = this.get("list_cursor");
      const page = await this.bucket.list({ prefix: this.prefix, limit: SCAN_BATCH_SIZE, ...(cursor ? { cursor } : {}) });
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
    readFile: (path: string) => Promise<MirroredFile | null>,
    exclusive: <T>(operation: () => Promise<T>) => Promise<T>,
  ): Promise<{ more: boolean; retry: boolean; runAt?: number }> {
    const work = await exclusive(async () => {
      const runAt = Number(this.get("run_at") ?? 0);
      if (runAt > Date.now()) return { batch: [], runAt };
      if (runAt) this.sql.exec("DELETE FROM file_mirror_meta WHERE key='run_at'");
      await this.discover();
      const batch = this.sql.exec<{ path: string; fingerprint: string | null }>(`SELECT path,fingerprint FROM file_mirror_state
        WHERE status IN ('queued','retry') ORDER BY CASE status WHEN 'queued' THEN 0 ELSE 1 END,attempts,path LIMIT ?`, WRITE_BATCH_SIZE).toArray();
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
        const file = await exclusive(() => readFile(entry.path));
        // Files are reconstructed one at a time; a deferred file remains queued for the next alarm.
        if (file && processedBytes + file.bytes.byteLength > WRITE_BATCH_BYTES) break;
        processedBytes += file?.bytes.byteLength ?? 0;
        const fingerprint = file ? JSON.stringify([file.contentHash, file.contentType, file.mtime]) : null;
        if (!file) await this.bucket.delete(key);
        else if (entry.fingerprint !== fingerprint) {
          await this.bucket.put(key, file.bytes, {
            httpMetadata: { contentType: file.contentType },
            customMetadata: { contentHash: file.contentHash, ...(file.mtime == null ? {} : { mtime: String(file.mtime) }) },
          });
        }
        await exclusive(async () => {
          if (this.get("epoch") !== epoch) return;
          if (!file) this.sql.exec("DELETE FROM file_mirror_state WHERE path=?", entry.path);
          else this.sql.exec("UPDATE file_mirror_state SET doc_id=?,fingerprint=?,status='ready',attempts=0,error=NULL WHERE path=?",
            file.docId, fingerprint, entry.path);
        });
      } catch (error) {
        await exclusive(async () => {
          if (this.get("epoch") !== epoch) return;
          const status = error instanceof FileMirrorPending ? "waiting" : error instanceof FileMirrorUnsupported ? "blocked" : "retry";
          this.sql.exec("UPDATE file_mirror_state SET status=?,attempts=attempts+1,error=? WHERE path=?", status, String(error).slice(0, 512), entry.path);
        });
      }
    }
    return exclusive(async () => ({
      more: this.get("listed") !== "1" || this.get("scanned") !== "1" ||
        this.sql.exec("SELECT 1 FROM changes WHERE seq>? LIMIT 1", Number(this.get("seq") ?? 0)).toArray().length > 0 ||
        this.sql.exec("SELECT 1 FROM file_mirror_state WHERE status='queued' LIMIT 1").toArray().length > 0,
      retry: this.sql.exec("SELECT 1 FROM file_mirror_state WHERE status='retry' LIMIT 1").toArray().length > 0,
    }));
  }

  async deleteVault(): Promise<void> {
    // Re-list the first page after deleting it; no cursor can skip a removed key.
    for (;;) {
      const page = await this.bucket.list({ prefix: this.prefix, limit: 256 });
      if (page.objects.length === 0) break;
      await this.bucket.delete(page.objects.map(object => object.key));
    }
    this.reset();
  }
}
