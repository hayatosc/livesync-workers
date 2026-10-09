import { MirrorHash } from "./file-mirror-hash.js";
import {
  MIRROR_LIMITS,
  FileMirrorChanged,
  FileMirrorPending,
  FileMirrorUnsupported,
  type MirrorReference,
  type MirrorMetadata,
  type MirrorSnapshot,
  type MirrorReader,
  type MirrorIO,
} from "./file-mirror-upload.js";

type Revision = { id: string; rev: string; body: string; body_chunked: number };
type Body = Record<string, unknown>;
const enc = new TextEncoder();
const MIME: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
};

function object(value: unknown): Body {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new FileMirrorUnsupported("UNSUPPORTED_CONTENT: invalid document");
  return value as Body;
}
function data(body: Body): readonly string[] | null {
  if (body.e_ === true) throw new FileMirrorUnsupported("UNSUPPORTED_CONTENT: encrypted");
  const pieces =
    typeof body.data === "string"
      ? [body.data]
      : Array.isArray(body.data) && body.data.every((piece) => typeof piece === "string")
        ? (body.data as string[])
        : null;
  if (pieces?.some((piece) => piece.startsWith("\u000eLZ\u001d")))
    throw new FileMirrorUnsupported("UNSUPPORTED_CONTENT: compressed");
  return pieces;
}

/** Keeps one bounded envelope cached, never all child bodies. Metadata selection is serialized by the DO. */
export class MirrorSourceReader implements MirrorReader {
  private cache: { key: string; body: Body } | null = null;
  constructor(
    private readonly sql: SqlStorage,
    private readonly contentPrefix: string,
    private readonly select: (path: string) => Promise<Revision | null>,
    private readonly exclusive: <T>(fn: () => Promise<T>) => Promise<T>,
    private readonly localBody: (id: string, rev: string) => string,
  ) {}

  private reference(row: Revision): MirrorReference {
    let r2: string | null = null;
    let envelope = false;
    if (row.body_chunked === 2) {
      const pointer = object(JSON.parse(row.body));
      if (typeof pointer.r2 !== "string" || !pointer.r2.startsWith(`${this.contentPrefix}objects/`))
        throw new FileMirrorUnsupported("UNSUPPORTED_CONTENT: cross-vault reference");
      r2 = pointer.r2;
      envelope = pointer.part === "body";
    }
    return { id: row.id, rev: row.rev, r2, envelope, eden: null, childId: null, childRev: null };
  }
  private child(id: string): Revision | null {
    return (
      this.sql
        .exec<Revision & Record<string, SqlStorageValue>>(
          `SELECT r.id,r.rev,r.body,r.body_chunked FROM docs d JOIN revs r ON r.id=d.id AND r.rev=d.winning_rev
      WHERE d.id=? AND d.deleted=0`,
          id,
        )
        .toArray()[0] ?? null
    );
  }

  private async body(ref: MirrorReference, io: MirrorIO): Promise<Body> {
    const key = JSON.stringify([ref.id, ref.rev, ref.r2, ref.envelope]);
    if (this.cache?.key === key) return this.cache.body;
    this.cache = null;
    let text: string;
    if (ref.r2) {
      if (!ref.r2.startsWith(`${this.contentPrefix}objects/`))
        throw new FileMirrorUnsupported("UNSUPPORTED_CONTENT: cross-vault reference");
      const stored = await io.get(ref.r2);
      if (!stored) throw new Error("Missing persistent mirror source");
      if (stored.size > MIRROR_LIMITS.envelopeBytes) {
        await stored.body.cancel().catch(() => {});
        throw new FileMirrorUnsupported("SOURCE_TOO_LARGE");
      }
      const reader = stored.body.getReader();
      const bytes = new Uint8Array(stored.size);
      let count = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          if (count + next.value.byteLength > bytes.length) throw new FileMirrorUnsupported("SOURCE_TOO_LARGE");
          bytes.set(next.value, count);
          count += next.value.byteLength;
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(0, count));
    } else text = await this.exclusive(async () => this.localBody(ref.id, ref.rev));
    if (
      !ref.r2 &&
      (text.length > MIRROR_LIMITS.envelopeBytes || enc.encode(text).byteLength > MIRROR_LIMITS.envelopeBytes)
    )
      throw new FileMirrorUnsupported("SOURCE_TOO_LARGE");
    let body = object(JSON.parse(text));
    if (ref.envelope) {
      if (body.format !== 3) throw new FileMirrorUnsupported("UNSUPPORTED_CONTENT: revision envelope");
      body = object(body.body);
    }
    if (body.e_ === true) throw new FileMirrorUnsupported("UNSUPPORTED_CONTENT: encrypted");
    this.cache = { key, body };
    return body;
  }

  async snapshot(path: string, io: MirrorIO): Promise<MirrorSnapshot | null> {
    const row = await this.exclusive(() => this.select(path));
    if (!row) return null;
    const root = this.reference(row);
    const body = await this.body(root, io);
    if (body.type !== "plain" && body.type !== "newnote")
      throw new FileMirrorUnsupported("UNSUPPORTED_CONTENT: file type");
    const declaredSize =
      typeof body.size === "number" && Number.isSafeInteger(body.size) && body.size >= 0 ? body.size : null;
    if (declaredSize != null && declaredSize > MIRROR_LIMITS.fileBytes)
      throw new FileMirrorUnsupported("FILE_TOO_LARGE");
    const type = body.type;
    const inline = data(body);
    const children = Array.isArray(body.children)
      ? body.children.filter((id): id is string => typeof id === "string")
      : [];
    if (children.some((id) => id.startsWith("h:++encrypted")))
      throw new FileMirrorUnsupported("UNSUPPORTED_CONTENT: encrypted");
    if (children.length > MIRROR_LIMITS.sources) throw new FileMirrorUnsupported("MANIFEST_TOO_LARGE");
    const eden = body.eden && typeof body.eden === "object" ? object(body.eden) : {};
    const sources = await this.exclusive(async () => {
      const current = await this.select(path);
      if (!current || current.id !== row.id || current.rev !== row.rev) throw new FileMirrorChanged();
      if (inline) return [root];
      if (!Array.isArray(body.children)) throw new FileMirrorPending("MISSING_CHUNK");
      return children.map((id) => {
        const child = this.child(id);
        if (!child && !eden[id]) throw new FileMirrorPending("MISSING_CHUNK");
        const source = child ? this.reference(child) : { ...root };
        return { ...source, childId: id, childRev: child?.rev ?? null, eden: eden[id] ? id : null };
      });
    });
    const contentType =
      typeof body.contentType === "string" &&
      body.contentType.length <= 128 &&
      !/[\u0000-\u001f\u007f]/.test(body.contentType)
        ? body.contentType
        : (MIME[path.split(".").at(-1)!.toLowerCase()] ?? "application/octet-stream");
    const mtime = typeof body.mtime === "number" && Number.isFinite(body.mtime) ? body.mtime : null;
    const hash = new MirrorHash();
    hash.update(enc.encode(JSON.stringify([path, row.id, row.rev, root, type, contentType, mtime, declaredSize])));
    let descriptorBytes = 0;
    for (const ref of sources) {
      const encoded = enc.encode(JSON.stringify(ref));
      descriptorBytes += encoded.byteLength;
      if (descriptorBytes > MIRROR_LIMITS.manifestBytes) throw new FileMirrorUnsupported("MANIFEST_TOO_LARGE");
      hash.update(encoded);
    }
    return {
      docId: row.id,
      rev: row.rev,
      root,
      type,
      contentType,
      mtime,
      declaredSize,
      fingerprint: hash.digest(),
      sources,
      small: inline != null || (declaredSize != null && declaredSize <= MIRROR_LIMITS.partBytes),
    };
  }

  async read(ref: MirrorReference, metadata: MirrorMetadata, io: MirrorIO): Promise<readonly string[]> {
    const body = await this.body(ref, io);
    if (ref.childRev == null && ref.eden) {
      const eden = object(body.eden);
      return data(object(eden[ref.eden])) ?? [];
    }
    const pieces = data(body);
    if (pieces) return pieces;
    if (ref.eden) {
      const root = await this.body(metadata.root, io);
      return data(object(object(root.eden)[ref.eden])) ?? [];
    }
    throw new FileMirrorPending("MISSING_CHUNK");
  }

  async current(path: string, metadata: MirrorMetadata | null, sources: Iterable<MirrorReference>): Promise<boolean> {
    const row = await this.select(path);
    if (!metadata) return row == null;
    if (!row || row.id !== metadata.docId || row.rev !== metadata.rev) return false;
    for (const ref of sources) if (ref.childId && (this.child(ref.childId)?.rev ?? null) !== ref.childRev) return false;
    return true;
  }
}
