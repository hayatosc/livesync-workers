// CouchDB revision ids, histories and winner selection.
import type { DocBody, RevisionMetadata, RevRow } from "./rows.js";

const enc = new TextEncoder();
const inlineRevisionBodyMaxBytes = 1_000_000;
const revisionBodyChunkCodeUnits = 250_000;

export function splitRevisionBody(body: string): string[] | null {
  if (enc.encode(body).byteLength <= inlineRevisionBodyMaxBytes) return null;

  const chunks: string[] = [];
  for (let start = 0; start < body.length; ) {
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

export function revisionMetadata(doc: DocBody): RevisionMetadata {
  return {
    soft_deleted: doc.deleted === true ? 1 : 0,
    path: typeof doc.path === "string" ? doc.path : null,
    size: typeof doc.size === "number" ? doc.size : null,
    mtime: typeof doc.mtime === "number" ? doc.mtime : null,
    type: typeof doc.type === "string" ? doc.type : null,
  };
}

export function parseRev(rev: string): { gen: number; hash: string } | null {
  const match = /^(\d+)-(.+)$/.exec(rev);
  if (!match) return null;
  return { gen: Number(match[1]), hash: match[2]! };
}

export function withoutMeta(doc: DocBody): DocBody {
  const out: DocBody = {};
  for (const [key, value] of Object.entries(doc)) {
    if (key !== "_rev" && key !== "_revisions" && key !== "_conflicts") {
      out[key] = value;
    }
  }
  return out;
}

export function stableJson(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`)
    .join(",")}}`;
}

export async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function newRevision(doc: DocBody, parentRev: string | null): Promise<string> {
  const parent = parentRev ? parseRev(parentRev) : null;
  const gen = (parent?.gen ?? 0) + 1;
  const hash = await sha1Hex(`${stableJson(withoutMeta(doc))}\n${parentRev ?? ""}`);
  return `${gen}-${hash.slice(0, 32)}`;
}

export function docIdFromBody(doc: DocBody): string | null {
  return typeof doc._id === "string" && doc._id ? doc._id : null;
}

export function cloneBody(row: RevRow): DocBody {
  return JSON.parse(row.body) as DocBody;
}

/**
 * Ancestors of a replicated revision, nearest first, from its `_revisions`
 * path (`ids[0]` is the revision itself). Replicators send only leaves, so
 * the generations in between must be recorded from this list or the
 * previously stored ancestor stays a leaf and surfaces as a conflict.
 */
export function ancestorsFromRevisions(doc: DocBody): string[] {
  const rev = typeof doc._rev === "string" ? parseRev(doc._rev) : null;
  const revisions = doc._revisions as { start?: unknown; ids?: unknown } | undefined;
  if (!rev || !revisions || !Array.isArray(revisions.ids)) return [];
  const ids = revisions.ids.filter((id): id is string => typeof id === "string");
  const ancestors: string[] = [];
  for (let index = 1; index < ids.length && rev.gen - index >= 1; index += 1) {
    ancestors.push(`${rev.gen - index}-${ids[index]}`);
  }
  return ancestors;
}

export function revisionHistory(doc: DocBody, rev: string, parentHistory?: string | null): string {
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

export function bodyWithRevisions(row: RevRow): DocBody {
  const body = cloneBody(row);
  if (row.rev_history) {
    body._revisions = JSON.parse(row.rev_history);
  }
  return body;
}

export function compareWinning(a: RevRow, b: RevRow): number {
  if (a.deleted !== b.deleted) return a.deleted ? -1 : 1;
  if (a.gen !== b.gen) return a.gen - b.gen;
  return compareCodePoints(a.rev, b.rev);
}

export function compareCodePoints(a: string, b: string): number {
  const aPoints = Array.from(a, (char) => char.codePointAt(0)!);
  const bPoints = Array.from(b, (char) => char.codePointAt(0)!);
  const length = Math.min(aPoints.length, bPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (aPoints[index] !== bPoints[index]) return aPoints[index]! - bPoints[index]!;
  }
  return aPoints.length - bPoints.length;
}
