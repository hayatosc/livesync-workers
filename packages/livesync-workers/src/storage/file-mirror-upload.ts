import { MirrorHash, MIRROR_HASH_FORMAT, hex } from "./file-mirror-hash.js";
import { decodeBytes, encodeBytes, decodeMirrorPiece, type MirrorDecoderState } from "./file-mirror-codec.js";

export const MIRROR_LIMITS = Object.freeze({
  fileBytes: 100 * 1024 * 1024,
  partBytes: 8 * 1024 * 1024,
  envelopeBytes: 4 * 1024 * 1024,
  sources: 8192,
  manifestBytes: 4 * 1024 * 1024,
  calls: 64,
});
const HASH_FORMAT = MIRROR_HASH_FORMAT;
const PAGE_BYTES = 1024 * 1024;

export class FileMirrorPending extends Error {}
export class FileMirrorUnsupported extends Error {}
export class FileMirrorChanged extends Error {}
export class FileMirrorYield extends Error {}
export class FileMirrorWorkError extends Error {
  constructor(
    readonly error: unknown,
    readonly bytes: number,
  ) {
    super(String(error));
  }
}

export type MirrorReference = {
  id: string;
  rev: string;
  r2: string | null;
  envelope: boolean;
  eden: string | null;
  childId: string | null;
  childRev: string | null;
};
export type MirrorMetadata = {
  docId: string;
  rev: string;
  root: MirrorReference;
  type: "plain" | "newnote";
  contentType: string;
  mtime: number | null;
  declaredSize: number | null;
  fingerprint: string;
};
export type MirrorSnapshot = MirrorMetadata & { sources: MirrorReference[]; small: boolean };
export type MirrorIO = { get(key: string): Promise<R2ObjectBody | null> };
export type MirrorReader = {
  snapshot(path: string, io: MirrorIO): Promise<MirrorSnapshot | null>;
  read(source: MirrorReference, metadata: MirrorMetadata, io: MirrorIO): Promise<readonly string[]>;
  current(path: string, metadata: MirrorMetadata | null, sources: Iterable<MirrorReference>): Promise<boolean>;
};
type Cursor = {
  source: number;
  piece: number;
  offset: number;
  decoder: MirrorDecoderState;
  spill: string;
  ended: boolean;
};
type Part = R2UploadedPart & { md5: string };
type Job = {
  version: string;
  id: string;
  epoch: string;
  metadata: MirrorMetadata;
  count: number;
  cursor: Cursor;
  total: number;
  uploaded: number;
  hash: string;
  parts: Part[];
  uploadId: string | null;
  tailBytes: number;
  started: number;
  progress: number;
  digest: string | null;
};
type Exclusive = <T>(fn: () => Promise<T>) => Promise<T>;
type Result =
  | { kind: "ready"; metadata: MirrorMetadata; digest: string | null; bytes: number }
  | { kind: "pending" | "deferred" | "removed"; bytes: number };

/** Only a bounded unfinished part is local; acknowledged parts live in R2 multipart storage. */
export class R2MirrorUploader {
  private readonly sql: SqlStorage;
  constructor(
    private readonly storage: Pick<DurableObjectStorage, "sql" | "transactionSync">,
    private readonly bucket: R2Bucket,
    private readonly prefix: string,
  ) {
    this.sql = storage.sql;
  }

  static init(sql: Pick<SqlStorage, "exec">): void {
    sql.exec("CREATE TABLE IF NOT EXISTS file_mirror_jobs (path TEXT PRIMARY KEY, state TEXT NOT NULL)");
    sql.exec(
      "CREATE TABLE IF NOT EXISTS file_mirror_sources (path TEXT NOT NULL, position INTEGER NOT NULL, reference TEXT NOT NULL, PRIMARY KEY(path,position))",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS file_mirror_tail (path TEXT NOT NULL, position INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(path,position))",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS file_mirror_abandoned (key TEXT NOT NULL, upload_id TEXT NOT NULL, PRIMARY KEY(key,upload_id))",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS file_mirror_dependencies (path TEXT NOT NULL, child_id TEXT NOT NULL, PRIMARY KEY(path,child_id))",
    );
    sql.exec("CREATE INDEX IF NOT EXISTS file_mirror_child ON file_mirror_dependencies(child_id)");
    sql.exec("CREATE TABLE IF NOT EXISTS file_mirror_digests(path TEXT PRIMARY KEY, hash TEXT)");
  }

  private job(path: string): Job | null {
    const row = this.sql.exec<{ state: string }>("SELECT state FROM file_mirror_jobs WHERE path=?", path).toArray()[0];
    return row ? (JSON.parse(row.state) as Job) : null;
  }
  private save(path: string, job: Job): void {
    this.sql.exec(
      "INSERT INTO file_mirror_jobs(path,state) VALUES (?,?) ON CONFLICT(path) DO UPDATE SET state=excluded.state",
      path,
      JSON.stringify(job),
    );
  }
  *references(path: string): Generator<MirrorReference> {
    let after = -1;
    for (;;) {
      const rows = this.sql
        .exec<{ position: number; reference: string }>(
          "SELECT position,reference FROM file_mirror_sources WHERE path=? AND position>? ORDER BY position LIMIT 32",
          path,
          after,
        )
        .toArray();
      for (const row of rows) {
        after = row.position;
        yield JSON.parse(row.reference) as MirrorReference;
      }
      if (rows.length < 32) return;
    }
  }
  roots(): unknown[] {
    const roots: unknown[] = [];
    for (const { path, state } of this.sql.exec<{ path: string; state: string }>(
      "SELECT path,state FROM file_mirror_jobs",
    )) {
      const job = JSON.parse(state) as Job;
      if (job.metadata.root.r2) roots.push({ r2: job.metadata.root.r2 });
      for (const ref of this.references(path)) if (ref.r2) roots.push({ r2: ref.r2 });
    }
    return roots;
  }
  reset(): void {
    for (const row of this.sql.exec<{ path: string }>("SELECT path FROM file_mirror_jobs").toArray())
      this.forget(row.path, true);
    this.sql.exec("DELETE FROM file_mirror_dependencies");
    this.sql.exec("DELETE FROM file_mirror_digests");
  }
  private forget(path: string, abandon = false): void {
    const job = this.job(path);
    this.storage.transactionSync(() => {
      if (abandon && job?.uploadId)
        this.sql.exec(
          "INSERT OR IGNORE INTO file_mirror_abandoned(key,upload_id) VALUES (?,?)",
          this.prefix + path,
          job.uploadId,
        );
      this.sql.exec("DELETE FROM file_mirror_jobs WHERE path=?", path);
      this.sql.exec("DELETE FROM file_mirror_sources WHERE path=?", path);
      this.sql.exec("DELETE FROM file_mirror_tail WHERE path=?", path);
    });
  }
  async cleanup(invoke: <T>(fn: () => Promise<T>) => Promise<T>, all = false): Promise<void> {
    const rows = this.sql
      .exec<{ key: string; upload_id: string }>(
        `SELECT key,upload_id FROM file_mirror_abandoned LIMIT ${all ? 1000 : 2}`,
      )
      .toArray();
    for (const row of rows) {
      try {
        await invoke(() => this.bucket.resumeMultipartUpload(row.key, row.upload_id).abort());
      } catch (error) {
        if (!/NoSuchUpload|does not exist|not found|already.*(?:completed|aborted)/i.test(String(error))) throw error;
      }
      this.sql.exec("DELETE FROM file_mirror_abandoned WHERE key=? AND upload_id=?", row.key, row.upload_id);
    }
  }
  hasCleanup(): boolean {
    return this.sql.exec("SELECT 1 FROM file_mirror_abandoned LIMIT 1").toArray().length > 0;
  }

  progress(): { path: string; phase: string; decodedBytes: number; uploadedBytes: number; targetRev: string } | null {
    const row = this.sql
      .exec<{ path: string; state: string }>("SELECT path,state FROM file_mirror_jobs ORDER BY path LIMIT 1")
      .toArray()[0];
    if (!row) return null;
    const job = JSON.parse(row.state) as Job;
    return {
      path: row.path,
      phase: job.digest ? "publishing" : job.uploadId ? "uploading" : "decoding",
      decodedBytes: job.total,
      uploadedBytes: job.uploaded,
      targetRev: job.metadata.rev,
    };
  }

  private ready(
    path: string,
    metadata: MirrorMetadata,
    digest: string | null,
    sources: Iterable<MirrorReference>,
  ): void {
    this.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM file_mirror_dependencies WHERE path=?", path);
      for (const ref of sources)
        if (ref.childId)
          this.sql.exec(
            "INSERT OR IGNORE INTO file_mirror_dependencies(path,child_id) VALUES (?,?)",
            path,
            ref.childId,
          );
      this.sql.exec(
        "UPDATE file_mirror_state SET doc_id=?,fingerprint=?,status='ready',attempts=0,error=NULL WHERE path=?",
        metadata.docId,
        metadata.fingerprint,
        path,
      );
      this.sql.exec(
        "INSERT INTO file_mirror_digests(path,hash) VALUES (?,?) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash",
        path,
        digest,
      );
      this.sql.exec("DELETE FROM file_mirror_jobs WHERE path=?", path);
      this.sql.exec("DELETE FROM file_mirror_sources WHERE path=?", path);
      this.sql.exec("DELETE FROM file_mirror_tail WHERE path=?", path);
    });
  }

  private persistTail(path: string, job: Job, buffer: Uint8Array): void {
    // A small file can overtake the active large job, but cannot add a second cache.
    if (this.sql.exec("SELECT 1 FROM file_mirror_jobs WHERE path<>? LIMIT 1", path).toArray().length > 0) {
      this.forget(path, true);
      return;
    }
    this.storage.transactionSync(() => {
      // Keep complete pages immutable across partial checkpoints; replace only the final page.
      const fullPages = Math.floor(job.tailBytes / PAGE_BYTES);
      this.sql.exec("DELETE FROM file_mirror_tail WHERE path=? AND position>=?", path, fullPages);
      for (let offset = fullPages * PAGE_BYTES; offset < buffer.byteLength; offset += PAGE_BYTES) {
        const part = buffer.slice(offset, Math.min(buffer.byteLength, offset + PAGE_BYTES));
        this.sql.exec(
          "INSERT INTO file_mirror_tail(path,position,data) VALUES (?,?,?)",
          path,
          offset / PAGE_BYTES,
          part,
        );
      }
      job.tailBytes = buffer.byteLength;
      this.save(path, job);
    });
  }
  private loadTail(path: string, job: Job, buffer: Uint8Array): void {
    let copied = 0;
    for (const row of this.sql.exec<{ position: number; data: ArrayBuffer }>(
      "SELECT position,data FROM file_mirror_tail WHERE path=? ORDER BY position",
      path,
    )) {
      const bytes = new Uint8Array(row.data);
      if (row.position * PAGE_BYTES !== copied || copied + bytes.byteLength > job.tailBytes)
        throw new Error("Invalid mirror tail checkpoint");
      buffer.set(bytes, copied);
      copied += bytes.byteLength;
    }
    if (copied !== job.tailBytes) throw new Error("Missing mirror tail checkpoint");
  }

  async step(
    path: string,
    previousFingerprint: string | null,
    epoch: string,
    reader: MirrorReader,
    io: MirrorIO,
    invoke: <T>(fn: () => Promise<T>) => Promise<T>,
    requestExclusive: Exclusive,
    budgetBytes: number,
  ): Promise<Result> {
    const sameEpoch = () =>
      this.sql.exec<{ value: string }>("SELECT value FROM file_mirror_meta WHERE key='epoch'").toArray()[0]?.value ===
      epoch;
    const exclusive: Exclusive = (fn) =>
      requestExclusive(async () => {
        if (!sameEpoch()) throw new FileMirrorChanged();
        return fn();
      });
    let job = await exclusive(async () => this.job(path));
    if (
      job &&
      (job.version !== HASH_FORMAT ||
        job.epoch !== epoch ||
        Date.now() - job.progress > 24 * 60 * 60_000 ||
        Date.now() - job.started > 6 * 24 * 60 * 60_000 ||
        !(await exclusive(() => reader.current(path, job!.metadata, this.references(path)))))
    ) {
      await exclusive(async () => this.forget(path, true));
      job = null;
    }
    if (!job) {
      const snapshot = await reader.snapshot(path, io);
      if (!snapshot) {
        await exclusive(async () => {
          if (!(await reader.current(path, null, []))) throw new FileMirrorChanged();
          await invoke(() => this.bucket.delete(this.prefix + path));
          this.forget(path, true);
          this.sql.exec("DELETE FROM file_mirror_dependencies WHERE path=?", path);
          this.sql.exec("DELETE FROM file_mirror_digests WHERE path=?", path);
          this.sql.exec("DELETE FROM file_mirror_state WHERE path=?", path);
        });
        return { kind: "removed", bytes: 0 };
      }
      if (snapshot.fingerprint === previousFingerprint) {
        await exclusive(async () => {
          if (!(await reader.current(path, snapshot, snapshot.sources))) throw new FileMirrorChanged();
          const digest =
            this.sql
              .exec<{ hash: string | null }>("SELECT hash FROM file_mirror_digests WHERE path=?", path)
              .toArray()[0]?.hash ?? null;
          this.ready(path, snapshot, digest, snapshot.sources);
        });
        return { kind: "ready", metadata: snapshot, digest: null, bytes: 0 };
      }
      // A backfill/rebuild can adopt an existing format-2 object without re-exporting it.
      const existing = await invoke(() => this.bucket.head(this.prefix + path));
      if (
        existing?.customMetadata?.mirrorFormat === "2" &&
        existing.customMetadata.sourceFingerprint === snapshot.fingerprint &&
        (snapshot.declaredSize == null || existing.size === snapshot.declaredSize)
      ) {
        const digest = existing.customMetadata.contentHash ?? null;
        await exclusive(async () => {
          if (!(await reader.current(path, snapshot, snapshot.sources))) throw new FileMirrorChanged();
          this.ready(path, snapshot, digest, snapshot.sources);
        });
        return { kind: "ready", metadata: snapshot, digest, bytes: 0 };
      }
      const occupied = await exclusive(
        async () => this.sql.exec("SELECT 1 FROM file_mirror_jobs LIMIT 1").toArray().length > 0,
      );
      if (occupied && !snapshot.small) return { kind: "deferred", bytes: 0 };
      if (snapshot.sources.length > MIRROR_LIMITS.sources) throw new FileMirrorUnsupported("MANIFEST_TOO_LARGE");
      if (snapshot.declaredSize != null && snapshot.declaredSize > MIRROR_LIMITS.fileBytes)
        throw new FileMirrorUnsupported("FILE_TOO_LARGE");
      const hasher = new MirrorHash();
      const { sources, small: _small, ...metadata } = snapshot;
      job = {
        version: HASH_FORMAT,
        id: crypto.randomUUID(),
        epoch,
        metadata,
        count: sources.length,
        cursor: { source: 0, piece: 0, offset: 0, decoder: { carry: "", padded: false }, spill: "", ended: false },
        total: 0,
        uploaded: 0,
        hash: hasher.save(),
        parts: [],
        uploadId: null,
        tailBytes: 0,
        started: Date.now(),
        progress: Date.now(),
        digest: null,
      };
      const initial = job;
      await exclusive(async () => {
        if (!(await reader.current(path, metadata, sources))) throw new FileMirrorChanged();
        this.storage.transactionSync(() => {
          let size = 0;
          this.sql.exec("DELETE FROM file_mirror_dependencies WHERE path=?", path);
          for (let i = 0; i < sources.length; i++) {
            const ref = sources[i]!;
            const encoded = JSON.stringify(ref);
            size += new TextEncoder().encode(encoded).byteLength;
            if (size > MIRROR_LIMITS.manifestBytes) throw new FileMirrorUnsupported("MANIFEST_TOO_LARGE");
            this.sql.exec("INSERT INTO file_mirror_sources(path,position,reference) VALUES (?,?,?)", path, i, encoded);
            if (ref.childId)
              this.sql.exec(
                "INSERT OR IGNORE INTO file_mirror_dependencies(path,child_id) VALUES (?,?)",
                path,
                ref.childId,
              );
          }
          this.save(path, initial);
        });
      });
    }
    const active = job;
    if (active.digest) {
      const completed = await invoke(() => this.bucket.head(this.prefix + path));
      if (
        completed?.customMetadata?.mirrorJobId === active.id &&
        completed.customMetadata.sourceFingerprint === active.metadata.fingerprint &&
        completed.size === active.total &&
        (!active.parts.length || completed.etag === (await this.multipartEtag(active.parts)))
      ) {
        await exclusive(async () => {
          if (!(await reader.current(path, active.metadata, this.references(path)))) throw new FileMirrorChanged();
          this.ready(path, active.metadata, active.digest, this.references(path));
        });
        return { kind: "ready", metadata: active.metadata, digest: active.digest, bytes: 0 };
      }
    }
    const hasher = new MirrorHash();
    try {
      hasher.load(active.hash);
    } catch {
      await exclusive(async () => this.forget(path, true));
      throw new FileMirrorChanged();
    }
    const buffer = new Uint8Array(MIRROR_LIMITS.partBytes);
    await exclusive(async () => this.loadTail(path, active, buffer));
    let used = active.tailBytes;
    let newBytes = 0;
    let uploadedBytes = 0;
    let attemptedBytes = 0;
    const failure = (error: unknown) =>
      new FileMirrorWorkError(error, Math.max(newBytes, uploadedBytes, attemptedBytes));
    let pieces: readonly string[] | null = null;
    let sourceIndex = -1;
    const validateLength = (decoded: number) => {
      if (active.total + decoded > MIRROR_LIMITS.fileBytes) throw new FileMirrorUnsupported("FILE_TOO_LARGE");
      if (active.metadata.declaredSize != null && active.total + decoded > active.metadata.declaredSize)
        throw new FileMirrorUnsupported("SIZE_MISMATCH");
    };
    const append = (bytes: Uint8Array) => {
      const take = Math.min(bytes.length, buffer.length - used, budgetBytes - newBytes);
      const output = bytes.subarray(0, take);
      buffer.set(output, used);
      hasher.update(output);
      used += take;
      newBytes += take;
      active.total += take;
      // Only bytes crossing a part/budget boundary need a serializable spill.
      active.cursor.spill = take < bytes.length ? encodeBytes(bytes.subarray(take)) : "";
    };
    try {
      while (used < buffer.length && newBytes < budgetBytes) {
        if (active.cursor.spill) {
          append(decodeBytes(active.cursor.spill));
          continue;
        }
        if (active.cursor.ended) break;
        if (active.cursor.source >= active.count) {
          const final = decodeMirrorPiece(active.metadata.type, "", active.cursor.decoder, true);
          active.cursor.ended = true;
          validateLength(final.byteLength);
          append(final);
          continue;
        }
        if (sourceIndex !== active.cursor.source) {
          const row = await exclusive(async () =>
            this.sql
              .exec<{ reference: string }>(
                "SELECT reference FROM file_mirror_sources WHERE path=? AND position=?",
                path,
                active.cursor.source,
              )
              .one(),
          );
          pieces = await reader.read(JSON.parse(row.reference) as MirrorReference, active.metadata, io);
          sourceIndex = active.cursor.source;
        }
        const piece = pieces![active.cursor.piece];
        if (piece == null) {
          active.cursor.source++;
          active.cursor.piece = 0;
          active.cursor.offset = 0;
          continue;
        }
        if (piece.startsWith("\u000eLZ\u001d")) throw new FileMirrorUnsupported("UNSUPPORTED_CONTENT: compressed");
        if (active.cursor.offset >= piece.length) {
          active.cursor.piece++;
          active.cursor.offset = 0;
          continue;
        }
        const text = piece.slice(active.cursor.offset, active.cursor.offset + 16384);
        const output = decodeMirrorPiece(active.metadata.type, text, active.cursor.decoder);
        active.cursor.offset += text.length;
        validateLength(output.byteLength);
        append(output);
      }
      // Exhaustion at the exact 8 MiB boundary still qualifies for one direct PUT.
      if (
        !active.cursor.spill &&
        sourceIndex === active.cursor.source &&
        pieces &&
        active.cursor.offset === pieces[active.cursor.piece]?.length &&
        active.cursor.piece === pieces.length - 1 &&
        active.cursor.source === active.count - 1 &&
        !active.cursor.decoder.carry
      ) {
        active.cursor.ended = true;
      }
      active.hash = hasher.save();
      active.progress = Date.now();
      const done = active.cursor.ended && !active.cursor.spill;
      if (done && active.metadata.declaredSize != null && active.metadata.declaredSize !== active.total)
        throw new FileMirrorUnsupported("SIZE_MISMATCH");
      if ((!done && used < buffer.length) || used > budgetBytes) {
        await exclusive(async () => this.persistTail(path, active, buffer.subarray(0, used)));
        return { kind: "pending", bytes: newBytes };
      }
      if (!(await exclusive(() => reader.current(path, active.metadata, this.references(path)))))
        throw new FileMirrorChanged();
      if (done) active.digest = hasher.digest();
      if (!active.uploadId && done && !active.parts.length) {
        // Successful small copies never write their bytes to SQLite. A caught failure
        // checkpoints the buffer; a process loss can safely repeat this bounded PUT.
        await exclusive(async () => {
          if (!(await reader.current(path, active.metadata, this.references(path)))) throw new FileMirrorChanged();
          attemptedBytes = used;
          await invoke(() =>
            this.bucket.put(this.prefix + path, buffer.subarray(0, used), {
              sha256: active.digest!,
              httpMetadata: { contentType: active.metadata.contentType },
              customMetadata: this.metadata(active, true),
            }),
          );
          this.ready(path, active.metadata, active.digest, this.references(path));
        });
        return { kind: "ready", metadata: active.metadata, digest: active.digest, bytes: Math.max(newBytes, used) };
      }
      if (!active.uploadId) {
        const upload = await invoke(() =>
          this.bucket.createMultipartUpload(this.prefix + path, {
            httpMetadata: { contentType: active.metadata.contentType },
            customMetadata: this.metadata(active, false),
          }),
        );
        active.uploadId = upload.uploadId;
        await exclusive(async () => {
          const saved = this.job(path)!;
          this.save(path, {
            ...active,
            cursor: saved.cursor,
            hash: saved.hash,
            total: saved.total,
            tailBytes: saved.tailBytes,
          });
        });
      }
      const upload = this.bucket.resumeMultipartUpload(this.prefix + path, active.uploadId);
      if (used > 0) {
        const expected = hex(new Uint8Array(await crypto.subtle.digest("MD5", buffer.subarray(0, used))));
        attemptedBytes = used;
        const part = await invoke(() => upload.uploadPart(active.parts.length + 1, buffer.subarray(0, used)));
        // Workers binding part ETags are opaque completion tokens (Miniflare
        // deliberately generates random ones). Check the completed object's MD5 instead.
        if (!(await exclusive(() => reader.current(path, active.metadata, this.references(path)))))
          throw new FileMirrorChanged();
        active.parts.push({ ...part, md5: expected });
        active.uploaded += used;
        active.tailBytes = 0;
        uploadedBytes = used;
        used = 0;
        await exclusive(async () =>
          this.storage.transactionSync(() => {
            this.save(path, active);
            this.sql.exec("DELETE FROM file_mirror_tail WHERE path=?", path);
          }),
        );
      }
      if (!done) return { kind: "pending", bytes: Math.max(newBytes, uploadedBytes) };
      const expectedEtag = await this.multipartEtag(active.parts);
      await exclusive(async () => {
        if (!(await reader.current(path, active.metadata, this.references(path)))) throw new FileMirrorChanged();
        this.save(path, active);
        const completed = await invoke(() =>
          upload.complete(active.parts.map(({ partNumber, etag }) => ({ partNumber, etag }))),
        );
        if (completed.size !== active.total || completed.etag !== expectedEtag)
          throw new Error("Multipart object checksum mismatch");
        this.ready(path, active.metadata, active.digest, this.references(path));
      });
      return {
        kind: "ready",
        metadata: active.metadata,
        digest: active.digest,
        bytes: Math.max(newBytes, uploadedBytes),
      };
    } catch (error) {
      const reset = await requestExclusive(async () => {
        if (sameEpoch()) return false;
        if (active.uploadId)
          this.sql.exec(
            "INSERT OR IGNORE INTO file_mirror_abandoned(key,upload_id) VALUES (?,?)",
            this.prefix + path,
            active.uploadId,
          );
        return true;
      });
      if (reset) throw failure(new FileMirrorChanged());
      if (!active.digest) active.hash = hasher.save();
      if (/NoSuchUpload|multipart.*(?:does not exist|not found)/i.test(String(error))) {
        await exclusive(async () => this.forget(path, true));
        throw failure(new FileMirrorChanged());
      }
      if (
        error instanceof FileMirrorChanged ||
        error instanceof FileMirrorUnsupported ||
        String(error).includes("INVALID_ENCODING")
      ) {
        await exclusive(async () => this.forget(path, true));
        if (String(error).includes("INVALID_ENCODING")) throw failure(new FileMirrorUnsupported("INVALID_ENCODING"));
        throw failure(error);
      }
      // An I/O budget yield is normal; a storage error preserves the same retryable part.
      await exclusive(async () => this.persistTail(path, active, buffer.subarray(0, used)));
      if (error instanceof FileMirrorYield) return { kind: "pending", bytes: newBytes };
      throw failure(error);
    }
  }

  private metadata(job: Job, hash: boolean): Record<string, string> {
    return {
      mirrorFormat: "2",
      mirrorJobId: job.id,
      sourceRev: job.metadata.rev,
      sourceFingerprint: job.metadata.fingerprint,
      ...(hash && job.digest ? { contentHash: job.digest } : {}),
      ...(job.metadata.mtime == null ? {} : { mtime: String(job.metadata.mtime) }),
    };
  }

  private async multipartEtag(parts: Part[]): Promise<string> {
    const bytes = new Uint8Array(parts.length * 16);
    for (let i = 0; i < parts.length; i++)
      for (let j = 0; j < 16; j++) bytes[i * 16 + j] = parseInt(parts[i]!.md5.slice(j * 2, j * 2 + 2), 16);
    return `${hex(new Uint8Array(await crypto.subtle.digest("MD5", bytes)))}-${parts.length}`;
  }
}
