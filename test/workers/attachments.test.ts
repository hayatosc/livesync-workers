import { env, runInDurableObject } from "cloudflare:test";
import { it, expect } from "vitest";
import type { TestEnv, PersistentVaultDO } from "./entry.js";
import { hashText } from "../../packages/livesync-workers/src/search/chunk-md.js";
import { R2Journal, contentPrefix } from "../../packages/livesync-workers/src/storage/r2-journal.js";
const bindings = env as unknown as TestEnv;
it("stores raw binary originals, retains history during GC and rejects oversize/path-traversal uploads", async () => {
  const stub = bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName("attachments:vault"));
  await stub.fetch("https://db/", { method: "PUT" });
  const binary = "\0\xff".repeat(80_000);
  const base64 = btoa(binary);
  const emptyHash = await hashText("");
  const op = (body: unknown) => stub.fetch("https://db/internal/op", { method: "POST", headers: { "X-LiveSync-Internal": "integration-secret" }, body: JSON.stringify(body) });
  expect((await op({ op: "writeAttachment", path: "資料/Original.pdf", content: base64, expectedBaseHash: emptyHash, contentType: "application/pdf" })).status).toBe(200);
  const read = await (await op({ op: "readAttachment", path: "資料/Original.pdf" })).json() as { base64: string; size: number };
  expect(read.base64).toBe(base64);
  expect(read.size).toBe(binary.length);
  let binaryKey = "";
  await runInDurableObject(stub, async (_instance: PersistentVaultDO, state) => {
    const row = state.storage.sql.exec<{ body: string }>("SELECT body FROM revs WHERE id = ?", "資料/Original.pdf").one();
    const pointer = JSON.parse(row.body) as { r2: string };
    const envelope = await (await bindings.CONTENT.get(pointer.r2))!.json<{ binaryKey: string; children: string[] }>();
    binaryKey = envelope.binaryKey;
    expect(envelope.children.length).toBeGreaterThan(1);
    const raw = await (await bindings.CONTENT.get(binaryKey))!.arrayBuffer();
    expect(new Uint8Array(raw)).toEqual(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  });
  const garbage = await new R2Journal(bindings.CONTENT, contentPrefix("attachments", "vault")).collectGarbage({ graceMs: -1 });
  expect(garbage).not.toContain(binaryKey);
  for (const path of ["../escape.pdf", "/absolute.pdf", "a//b.pdf", "a\\b.pdf", "null\0byte.pdf"]) {
    expect((await op({ op: "writeAttachment", path, content: "AQID", expectedBaseHash: emptyHash })).status).toBe(400);
  }
  const tooLarge = btoa("a".repeat(10 * 1024 * 1024 + 1));
  expect((await op({ op: "writeAttachment", path: "oversize.pdf", content: tooLarge, expectedBaseHash: emptyHash })).status).toBe(413);
});

it("enforces decoded attachment limits on documents received through LiveSync", async () => {
  const stub = bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName("attachment-read-limit:vault"));
  await stub.fetch("https://db/", { method: "PUT" });
  const data = btoa("a".repeat(10 * 1024 * 1024 + 1));
  const docs: unknown[] = [];
  const children: string[] = [];
  for (let offset = 0; offset < data.length; offset += 60_000) {
    const id = `h:${offset}`;
    children.push(id);
    docs.push({ _id: id, _rev: "1-chunk", type: "leaf", data: data.slice(offset, offset + 60_000) });
  }
  docs.push({ _id: "large.pdf", _rev: "1-note", type: "newnote", path: "large.pdf", children, size: 1 });
  expect((await stub.fetch("https://db/_bulk_docs", { method: "POST", body: JSON.stringify({ docs, new_edits: false }) })).status).toBe(200);
  expect((await stub.fetch("https://db/internal/op", { method: "POST", headers: { "X-LiveSync-Internal": "integration-secret" }, body: JSON.stringify({ op: "readAttachment", path: "large.pdf" }) })).status).toBe(413);
});
