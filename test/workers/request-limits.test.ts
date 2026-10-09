import { env, runInDurableObject, SELF } from "cloudflare:test";
import { it, expect, afterEach } from "vitest";
import type { PersistentVaultDO, TestEnv } from "./entry.js";
import { host } from "./entry.js";
import { handleLiveSyncRequest } from "../../packages/livesync-workers/src/livesync/handler.js";
import { REQUEST_LIMITS } from "../../packages/livesync-workers/src/livesync/limits.js";
import { R2Journal, contentPrefix } from "../../packages/livesync-workers/src/storage/r2-journal.js";
import { stopCheckpointAlarms } from "./checkpoint-helpers.js";
const bindings = env as unknown as TestEnv;
const created: DurableObjectStub[] = [];
afterEach(() => stopCheckpointAlarms(created.splice(0)));
const utf8 = new TextEncoder();
async function fixture(name: string) {
  const stub = bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName(`${name}:vault`));
  created.push(stub);
  await runInDurableObject(stub, async (instance: PersistentVaultDO, state) => {
    (instance as unknown as { scheduleIndexing(): Promise<void> }).scheduleIndexing = async () => {};
    await state.storage.deleteAlarm();
  });
  expect((await stub.fetch("https://db/", { method: "PUT" })).status).toBe(200);
  return stub;
}
const post = (stub: DurableObjectStub, docs: unknown[]) =>
  stub.fetch("https://db/_bulk_docs", { method: "POST", body: JSON.stringify({ new_edits: false, docs }) });
function documentAtSize(id: string, bytes: number) {
  const doc = { _id: id, _rev: "1-fixed", data: "" };
  const remaining = bytes - utf8.encode(JSON.stringify(doc)).byteLength;
  doc.data = "字😀".repeat(Math.floor(remaining / 7)) + "a".repeat(remaining % 7);
  expect(utf8.encode(JSON.stringify(doc)).byteLength).toBe(bytes);
  return doc;
}
it("advertises the enforced byte and bulk-count limits in complete and individual config routes", async () => {
  const headers = { Authorization: `Basic ${btoa("alice:integration-pass")}` };
  const root = "https://worker/livesync/_node/_local/_config";
  expect(await (await SELF.fetch(root, { headers })).json()).toMatchObject({
    chttpd: { max_http_request_size: String(REQUEST_LIMITS.maxRequestBytes) },
    couchdb: { max_document_size: String(REQUEST_LIMITS.maxDocumentBytes) },
    livesync: { max_bulk_docs: String(REQUEST_LIMITS.maxBulkDocuments) },
  });
  for (const [section, key, value] of [
    ["chttpd", "max_http_request_size", REQUEST_LIMITS.maxRequestBytes],
    ["couchdb", "max_document_size", REQUEST_LIMITS.maxDocumentBytes],
    ["livesync", "max_bulk_docs", REQUEST_LIMITS.maxBulkDocuments],
  ] as const) {
    expect(await (await SELF.fetch(`${root}/${section}/${key}`, { headers })).json()).toBe(String(value));
  }
});
it("accepts the exact bulk count and rejects one more before any revision or journal write", async () => {
  const stub = await fixture("bulk-count");
  const docs = Array.from({ length: REQUEST_LIMITS.maxBulkDocuments }, (_, i) => ({
    _id: `n-${i}`,
    _rev: "1-fixed",
    data: "small",
  }));
  const rejected = [{ _id: "would-be-written", _rev: "1-fixed" }, ...docs];
  const journal = new R2Journal(bindings.CONTENT, contentPrefix("bulk-count", "vault"));
  const before = await journal.head();
  expect((await post(stub, rejected)).status).toBe(413);
  expect(
    (await stub.fetch("https://db/_bulk_get", { method: "POST", body: JSON.stringify({ docs: rejected }) })).status,
  ).toBe(413);
  expect(await journal.head()).toEqual(before);
  expect((await stub.fetch("https://db/would-be-written")).status).toBe(404);
  const accepted = await post(stub, docs);
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toHaveLength(REQUEST_LIMITS.maxBulkDocuments);
}, 20_000);
it("pages large changes feeds before R2 reads exhaust one invocation", async () => {
  const stub = await fixture("changes-page-limit");
  const docs = Array.from({ length: 130 }, (_, index) => ({ _id: `note-${index}`, _rev: "1-fixed", data: index }));
  expect((await post(stub, docs)).status).toBe(200);
  const first = (await (await stub.fetch("https://db/_changes?since=0&limit=1704&include_docs=true")).json()) as {
    results: Array<{ doc: { data: number } }>;
    last_seq: number;
    pending: number;
  };
  expect(first.results).toHaveLength(128);
  expect(first.results[0]?.doc.data).toBe(0);
  expect(first.last_seq).toBe(128);
  expect(first.pending).toBe(2);
  const second = (await (
    await stub.fetch(`https://db/_changes?since=${first.last_seq}&limit=1704&include_docs=true`)
  ).json()) as { results: Array<{ doc: { data: number } }>; last_seq: number; pending: number };
  expect(second.results.map((row) => row.doc.data)).toEqual([128, 129]);
  expect(second.last_seq).toBe(130);
  expect(second.pending).toBe(0);

  const streamPage = async (since: number) => {
    const response = await handleLiveSyncRequest(
      new Request(
        `https://worker/livesync/vault/_changes?feed=continuous&since=${since}&limit=1704&include_docs=true&style=all_docs&conflicts=true&revs=true&timeout=1000`,
        { headers: { Authorization: `Basic ${btoa("alice:integration-pass")}`, Origin: "capacitor://localhost" } },
      ),
      {
        host: {
          ...host,
          async verifyCredential() {
            return { tenantId: "changes-page-limit", databaseName: "vault" };
          },
        },
        bindings: { vaultDb: bindings.VAULT_DB },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("capacitor://localhost");
    return (await response.text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)) as Array<{ doc?: { data: number }; last_seq?: number }>;
  };
  const firstStream = await streamPage(0);
  expect(firstStream).toHaveLength(129);
  expect(firstStream.at(-1)?.last_seq).toBe(128);
  const secondStream = await streamPage(firstStream.at(-1)!.last_seq!);
  expect(secondStream.at(-1)?.last_seq).toBe(130);
  expect([...firstStream, ...secondStream].filter((row) => row.doc).map((row) => row.doc!.data)).toEqual(
    docs.map((doc) => doc.data),
  );
}, 20_000);
it("counts canonical document UTF-8 bytes, accepts the boundary and preflights every document", async () => {
  const stub = await fixture("document-byte-limit");
  const exact = documentAtSize("exact", REQUEST_LIMITS.maxDocumentBytes);
  expect((await post(stub, [exact])).status).toBe(200);
  const journal = new R2Journal(bindings.CONTENT, contentPrefix("document-byte-limit", "vault"));
  const before = await journal.head();
  const oversized = documentAtSize("too-large", REQUEST_LIMITS.maxDocumentBytes + 1);
  expect((await post(stub, [{ _id: "first", _rev: "1-fixed" }, oversized])).status).toBe(413);
  expect(await journal.head()).toEqual(before);
  expect((await stub.fetch("https://db/first")).status).toBe(404);
}, 15_000);
it("enforces document limits for direct PUT and local progress documents", async () => {
  const stub = await fixture("put-limits");
  const oversized = documentAtSize("too-large", REQUEST_LIMITS.maxDocumentBytes + 1);
  for (const path of ["too-large", "_local/progress"]) {
    expect((await stub.fetch(`https://db/${path}`, { method: "PUT", body: JSON.stringify(oversized) })).status).toBe(
      413,
    );
    expect((await stub.fetch(`https://db/${path}`)).status).toBe(404);
  }
});
it("accepts exact streamed request bytes and cancels overflow with absent or understated Content-Length", async () => {
  const stub = await fixture("stream-limits");
  await runInDurableObject(stub, async (instance: PersistentVaultDO, state) => {
    const head = state.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key='r2_applied_head_v3'")
      .one().value;
    for (const extra of [0, 1])
      for (const declared of [undefined, "1", "invalid"]) {
        let remaining = REQUEST_LIMITS.maxRequestBytes - 2 + extra;
        let canceled = false;
        let reads = 0;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(utf8.encode("{}"));
          },
          pull(controller) {
            reads++;
            if (!remaining) {
              if (extra) controller.enqueue(new Uint8Array([32]));
              else controller.close();
              return;
            }
            const size = Math.min(65536, remaining);
            controller.enqueue(new Uint8Array(size).fill(32));
            remaining -= size;
          },
          cancel() {
            canceled = true;
          },
        });
        const response = await instance.fetch(
          new Request("https://db/_revs_diff", {
            method: "POST",
            headers: declared ? { "Content-Length": declared } : {},
            body,
          }),
        );
        expect(response.status).toBe(extra ? 413 : 200);
        if (extra) expect(canceled).toBe(true);
        expect(reads).toBeLessThan(260);
        expect(
          state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='r2_applied_head_v3'").one()
            .value,
        ).toBe(head);
      }
  });
}, 15_000);
it("rejects declared oversize without reading and bounds direct internal JSON entrypoints", async () => {
  const stub = await fixture("internal-byte-limit");
  await runInDurableObject(stub, async (instance: PersistentVaultDO) => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(utf8.encode("{}"));
      },
    });
    expect(
      (
        await instance.fetch(
          new Request("https://db/internal/op", {
            method: "POST",
            headers: {
              "X-LiveSync-Internal": "integration-secret",
              "Content-Length": String(REQUEST_LIMITS.maxRequestBytes + 1),
            },
            body,
          }),
        )
      ).status,
    ).toBe(413);
    expect(pulls).toBeLessThanOrEqual(1);
  });
});
it("bounds the public POST changes proxy before parsing or forwarding", async () => {
  const body = `{}${" ".repeat(REQUEST_LIMITS.maxRequestBytes - 1)}`;
  const response = await SELF.fetch("https://worker/livesync/vault/_changes", {
    method: "POST",
    headers: { Authorization: `Basic ${btoa("alice:integration-pass")}`, Origin: "https://client.example" },
    body,
  });
  expect(response.status).toBe(413);
  expect(await response.json()).toMatchObject({ error: "request_entity_too_large" });
}, 15_000);
