/** Enforced limits, also used by the CouchDB configuration shim. All bytes are UTF-8. */
export const REQUEST_LIMITS = Object.freeze({
  maxRequestBytes: 16 * 1024 * 1024,
  maxDocumentBytes: 4 * 1024 * 1024,
  maxBulkDocuments: 1000,
  maxAttachmentBytes: 10 * 1024 * 1024,
});
export class RequestLimitError extends Error {
  readonly status = 413;
  constructor(readonly limit: keyof typeof REQUEST_LIMITS) {
    super(`${limit} exceeds ${REQUEST_LIMITS[limit]}`);
  }
}
/** Bound retained bytes even with missing/false Content-Length and tiny stream chunks. */
export async function readBoundedText(request: Request, maximum = REQUEST_LIMITS.maxRequestBytes): Promise<string> {
  const declared = request.headers.get("Content-Length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximum) {
    void request.body?.cancel().catch(() => {});
    throw new RequestLimitError("maxRequestBytes");
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  let bytes = new Uint8Array(Math.min(65536, maximum));
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > maximum - length) {
        void reader.cancel().catch(() => {});
        throw new RequestLimitError("maxRequestBytes");
      }
      const needed = length + value.byteLength;
      if (needed > bytes.byteLength) {
        const grown = new Uint8Array(Math.min(maximum, Math.max(needed, bytes.byteLength * 2)));
        grown.set(bytes.subarray(0, length)); bytes = grown;
      }
      bytes.set(value, length); length = needed;
    }
    return new TextDecoder().decode(bytes.subarray(0, length));
  } finally { reader.releaseLock(); }
}
const parsed = new WeakMap<Request, Record<string, unknown>>();
export async function readBoundedJson(request: Request): Promise<Record<string, unknown>> {
  const previous = parsed.get(request);
  if (previous) return previous;
  const text = await readBoundedText(request);
  let body: Record<string, unknown> = {};
  try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; }
  catch { /* Retain the existing malformed-JSON response behavior. */ }
  if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
  parsed.set(request, body);
  return body;
}
export function assertDocumentSize(document: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(document) ?? "").byteLength > REQUEST_LIMITS.maxDocumentBytes) {
    throw new RequestLimitError("maxDocumentBytes");
  }
}
export function assertBulkLimits(body: Record<string, unknown>): void {
  if (!Array.isArray(body.docs)) return;
  if (body.docs.length > REQUEST_LIMITS.maxBulkDocuments) throw new RequestLimitError("maxBulkDocuments");
  // Validate the complete batch before the first immutable object or SQL write.
  for (const document of body.docs) assertDocumentSize(document);
}
