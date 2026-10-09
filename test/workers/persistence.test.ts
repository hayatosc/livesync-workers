import { env, SELF, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { TestEnv, PersistentVaultDO } from "./entry.js";
import { R2Journal, contentPrefix } from "../../packages/livesync-workers/src/storage/r2-journal.js";
const bindings = env as unknown as TestEnv;
function stub(user: string) {
  return bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName(`${user}:vault`));
}
async function request(user: string, path: string, method = "GET", body?: unknown) {
  return SELF.fetch(`https://test/livesync/vault${path}`, {
    method,
    headers: { Authorization: `Basic ${btoa(`${user}:integration-pass`)}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function eraseCache(user: string) {
  await runInDurableObject(stub(user), async (_instance: PersistentVaultDO, state) => {
    for (const table of [
      "docs",
      "revs",
      "rev_metadata",
      "local_docs",
      "changes",
      "rev_body_chunks",
      "meta",
      "index_state",
    ]) {
      state.storage.sql.exec(`DELETE FROM ${table}`);
    }
    // The persisted applied-head marker detects cache loss even if the instance survives.
  });
}
describe("R2 authoritative content in real Workers bindings", () => {
  it("preserves revision bodies, binary chunks, histories, tombstones and progress after DO rebuild", async () => {
    const user = "alice";
    expect((await request(user, "", "PUT")).status).toBe(200);
    const binary = btoa(String.fromCharCode(0, 255, 128, 42, 0));
    const docs = [
      { _id: "chunk", _rev: "1-leaf", type: "leaf", data: binary },
      {
        _id: "Attachments/sample.pdf",
        _rev: "2-file",
        _revisions: { start: 2, ids: ["file", "original"] },
        path: "Attachments/sample.pdf",
        type: "newnote",
        children: ["chunk"],
        size: 5,
      },
      { _id: "日本語.md", _rev: "1-a", path: "日本語.md", type: "plain", data: "日本語の本文 😀", size: 22 },
    ];
    expect((await request(user, "/_bulk_docs", "POST", { docs, new_edits: false })).status).toBe(200);
    const checkpoint = await request(user, "/_local/progress", "PUT", { last_seq: 3 });
    expect(checkpoint.status).toBe(200);
    await eraseCache(user);
    const restored = (await (await request(user, "/chunk")).json()) as { data: string };
    expect(restored.data).toBe(binary);
    const history = (await (await request(user, "/Attachments%2Fsample.pdf?revs=true")).json()) as {
      _revisions: unknown;
    };
    expect(history._revisions).toEqual({ start: 2, ids: ["file", "original"] });
    expect((await request(user, "/_local/progress")).status).toBe(200);
    expect((await request(user, "/日本語.md?rev=1-a", "DELETE")).status).toBe(200);
    await eraseCache(user);
    expect((await request(user, "/日本語.md")).status).toBe(404);
    const feed = (await (await request(user, "/_changes?since=3")).json()) as { results: Array<{ deleted?: boolean }> };
    expect(feed.results.some((row) => row.deleted)).toBe(true);
    await runInDurableObject(stub(user), async (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ body: string; body_chunked: number }>("SELECT body, body_chunked FROM revs WHERE body_available = 1")
        .toArray();
      expect(
        rows.every(
          (row) =>
            row.body_chunked === 2 &&
            Object.keys(JSON.parse(row.body)).sort().join() === "part,r2" &&
            JSON.parse(row.body).part === "body",
        ),
      ).toBe(true);
      expect(state.storage.sql.exec("SELECT * FROM rev_body_chunks").toArray()).toHaveLength(0);
    });
  });

  it("serializes concurrent revision updates and isolates authenticated owners", async () => {
    await request("bob", "", "PUT");
    const created = (await (await request("bob", "/race", "PUT", { data: "original" })).json()) as { rev: string };
    const responses = await Promise.all(
      ["first", "second"].map((data) => request("bob", "/race", "PUT", { _rev: created.rev, data })),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await request("alice", "/race")).status).toBe(404);
    expect((await SELF.fetch("https://test/livesync/vault/race")).status).toBe(401);
    expect(
      (await stub("bob").fetch("https://db/internal/op", { method: "POST", body: '{"op":"readNote","path":"race"}' }))
        .status,
    ).toBe(403);
  });

  it("keeps the previous head if publication fails, and collects only uncommitted objects", async () => {
    const journal = new R2Journal(bindings.CONTENT, contentPrefix("faults", "stable-id"));
    const body = await journal.putBody('{"data":"persisted"}');
    await journal.commit([{ sql: "INSERT INTO test VALUES (?)", args: [JSON.stringify({ r2: body })] }]);
    const original = await journal.head();
    const garbage = await journal.putBody('{"data":"not-committed"}');
    const collected = await journal.collectGarbage({ graceMs: -1 });
    expect(collected).toContain(garbage);
    expect(collected).not.toContain(body);
    expect(await journal.head()).toEqual(original);
    expect(await journal.body(body)).toBe('{"data":"persisted"}');
    await expect(journal.body(`${contentPrefix("other", "stable-id")}objects/x`)).rejects.toThrow("Cross-vault");
  });
});

describe("storage boundary failures using real R2", () => {
  for (const boundary of ["objects/", "commits/", "head.json", "head-after"]) {
    it(`recovers and retries at ${boundary}`, async () => {
      const name = `fault-${boundary.replace(/\W/g, "")}:vault`;
      const object = bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName(name));
      await object.fetch("https://db/", { method: "PUT" });
      await runInDurableObject(object, async (instance: PersistentVaultDO) => {
        const original = (
          instance as unknown as {
            bindings(): { contentBucket: R2Bucket; bucket: R2Bucket; vaultDb: DurableObjectNamespace };
          }
        ).bindings.bind(instance);
        let fired = false;
        const bucket = original().contentBucket;
        const faultBucket = new Proxy(bucket, {
          get(target, property) {
            if (property !== "put") {
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            }
            return async (key: string, value: Parameters<R2Bucket["put"]>[1], options?: R2PutOptions) => {
              const matches = boundary === "head-after" ? key.endsWith("head.json") : key.includes(boundary);
              if (!fired && matches) {
                fired = true;
                if (boundary === "head-after") await target.put(key, value, options);
                throw new Error(`Injected ${boundary} failure`);
              }
              return target.put(key, value, options);
            };
          },
        });
        const mutable = instance as unknown as { bindings(): ReturnType<typeof original> };
        mutable.bindings = () => ({ ...original(), contentBucket: faultBucket });
        try {
          const response = await instance.fetch(
            new Request("https://db/_bulk_docs", {
              method: "POST",
              body: JSON.stringify({
                new_edits: false,
                docs: [{ _id: "doc", _rev: "1-idempotent", data: "success must survive" }],
              }),
            }),
          );
          expect(response.status).toBe(500);
        } finally {
          mutable.bindings = original;
        }
        expect(fired).toBe(true);
      });
      const beforeRetry = await object.fetch("https://db/doc");
      expect(beforeRetry.status).toBe(boundary === "head-after" ? 200 : 404);
      const retry = await object.fetch("https://db/_bulk_docs", {
        method: "POST",
        body: JSON.stringify({
          new_edits: false,
          docs: [{ _id: "doc", _rev: "1-idempotent", data: "success must survive" }],
        }),
      });
      expect(retry.status).toBe(200);
      expect((await object.fetch("https://db/doc")).status).toBe(200);
      const feed = (await (await object.fetch("https://db/_changes")).json()) as { results: unknown[] };
      expect(feed.results).toHaveLength(1);
    });
  }
});

it("fences stale journal writers and preserves exactly one head when two writers race", async () => {
  const journal = new R2Journal(bindings.CONTENT, contentPrefix("cas-owner", "vault"));
  const commits = await Promise.allSettled([
    journal.commit([{ sql: "INSERT INTO test VALUES (?)", args: ["one"] }], null),
    journal.commit([{ sql: "INSERT INTO test VALUES (?)", args: ["two"] }], null),
  ]);
  expect(commits.filter((commit) => commit.status === "fulfilled")).toHaveLength(1);
  expect(commits.filter((commit) => commit.status === "rejected")).toHaveLength(1);
  expect(await journal.history()).toHaveLength(1);
  await expect(journal.commit([], null)).rejects.toThrow("Stale vault writer");
});
