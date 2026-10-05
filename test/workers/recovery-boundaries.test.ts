import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { PersistentVaultDO, type TestEnv } from "./entry.js";
const bindings = env as unknown as TestEnv;
const tables = ["docs", "revs", "rev_metadata", "local_docs", "changes", "rev_body_chunks", "meta", "index_state", "_sql_schema_migrations"];
function stub(name: string) { return bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName(`${name}:vault`)); }
async function put(object: DurableObjectStub, id: string, body: unknown) {
  return object.fetch(`https://db/${id}`, { method: "PUT", body: JSON.stringify(body) });
}
async function reopen(object: DurableObjectStub, completely = false) {
  await runInDurableObject(object, async (_instance, state) => {
    if (completely) {
      // Drop content, indexes and schema versioning, then construct a fresh instance over the actual DO storage.
      for (const table of tables) state.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
      const fresh = new PersistentVaultDO(state, bindings);
      expect((await fresh.fetch(new Request("https://db/"))).status).toBe(200);
    } else {
      for (const table of tables.filter((table) => table !== "_sql_schema_migrations")) state.storage.sql.exec(`DELETE FROM ${table}`);
    }
  });
}
describe("SQL and R2 acknowledgement boundaries", () => {
  for (const boundary of ["INSERT INTO changes", "r2_applied_head"]) {
    it(`recovers after SQL failure at ${boundary}`, async () => {
      const object = stub(`sql-${boundary.replace(/\W/g, "")}`);
      await object.fetch("https://db/", { method: "PUT" });
      await runInDurableObject(object, async (instance: PersistentVaultDO) => {
        const mutable = instance as unknown as { sqlExec(sql: string, ...args: unknown[]): SqlStorageCursor<Record<string, SqlStorageValue>> };
        const original = mutable.sqlExec.bind(instance);
        let failed = false;
        mutable.sqlExec = (sql, ...args) => {
          if (!failed && (boundary === "r2_applied_head" ? /^INSERT/i.test(sql) && args.includes(boundary) : sql.includes(boundary))) { failed = true; throw new Error("Injected SQL failure"); }
          return original(sql, ...args);
        };
        try {
          const response = await instance.fetch(new Request("https://db/_bulk_docs", { method: "POST", body: '{"new_edits":false,"docs":[{"_id":"doc","_rev":"1-stable","data":"durable"}]}' }));
          expect(response.status).toBe(500);
          expect(failed).toBe(true);
        } finally { mutable.sqlExec = original; }
      });
      expect((await object.fetch("https://db/doc")).status).toBe(boundary === "r2_applied_head" ? 200 : 404);
      expect((await object.fetch("https://db/_bulk_docs", { method: "POST", body: '{"new_edits":false,"docs":[{"_id":"doc","_rev":"1-stable","data":"durable"}]}' })).status).toBe(200);
      await reopen(object, true);
      expect((await (await object.fetch("https://db/doc")).json() as { data: string }).data).toBe("durable");
      expect((await (await object.fetch("https://db/_changes")).json() as { results: unknown[] }).results).toHaveLength(1);
    });
  }
  it("restores exact conflicts, deleted leaves and local checkpoint updates/deletion after complete schema loss", async () => {
    const object = stub("all-state");
    await object.fetch("https://db/", { method: "PUT" });
    await object.fetch("https://db/_bulk_docs", { method: "POST", body: JSON.stringify({ new_edits: false, docs: [
      { _id: "doc", _rev: "2-a", _revisions: { start: 2, ids: ["a", "root"] }, data: "A" },
      { _id: "doc", _rev: "2-b", _revisions: { start: 2, ids: ["b", "root"] }, data: "B" },
    ] }) });
    const first = await (await put(object, "_local/progress", { last_seq: 2 })).json() as { rev: string };
    const second = await (await put(object, "_local/progress", { _rev: first.rev, last_seq: 3, nested: { bytes: "😀" } })).json() as { rev: string };
    await object.fetch("https://db/doc?rev=2-b", { method: "DELETE" });
    const expected = await (await object.fetch("https://db/_changes?style=all_docs&include_docs=true&revs=true")).json();
    await reopen(object, true);
    expect(await (await object.fetch("https://db/_changes?style=all_docs&include_docs=true&revs=true")).json()).toEqual(expected);
    expect(await (await object.fetch("https://db/_local/progress")).json()).toMatchObject({ _rev: second.rev, last_seq: 3, nested: { bytes: "😀" } });
    expect((await (await object.fetch("https://db/doc?rev=2-b")).json() as { data: string }).data).toBe("B");
    expect((await object.fetch(`https://db/_local/progress?rev=${second.rev}`, { method: "DELETE" })).status).toBe(200);
    await reopen(object, true);
    expect((await object.fetch("https://db/_local/progress")).status).toBe(404);
  });
  it("does not resurrect purged documents or checkpoints after reconstruction and database recreation", async () => {
    const object = stub("purge-state");
    await object.fetch("https://db/", { method: "PUT" });
    await put(object, "old", { data: "obsolete" });
    await put(object, "_local/progress", { last_seq: 1 });
    expect((await object.fetch("https://db/", { method: "DELETE" })).status).toBe(200);
    await reopen(object);
    expect((await object.fetch("https://db/", { method: "HEAD" })).status).toBe(404);
    expect((await object.fetch("https://db/", { method: "PUT" })).status).toBe(200);
    expect((await object.fetch("https://db/old")).status).toBe(404);
    expect((await object.fetch("https://db/_local/progress")).status).toBe(404);
    expect((await (await object.fetch("https://db/_changes")).json() as { results: unknown[] }).results).toHaveLength(0);
  });
});

it("executes orphan collection but refuses collection or restoration with a missing committed manifest", async () => {
  const { R2Journal, contentPrefix } = await import("../../packages/livesync-workers/src/storage/r2-journal.js");
  const journal = new R2Journal(bindings.CONTENT, contentPrefix("gc-review", "stable"));
  const body = await journal.putBody('{"data":"retain"}');
  const committed = await journal.commit([{ sql: "INSERT INTO revs VALUES (?)", args: [JSON.stringify({ r2: body })] }]);
  const orphan = await journal.putBody('{"data":"orphan"}');
  expect(await journal.collectGarbage({ execute: true, graceMs: -1 })).toContain(orphan);
  expect(await bindings.CONTENT.get(orphan)).toBeNull();
  expect(await journal.body(body)).toBe('{"data":"retain"}');
  const uncollected = await journal.putBody('{"data":"leave-on-corruption"}');
  await bindings.CONTENT.delete(committed);
  await expect(journal.history()).rejects.toThrow("Missing committed manifest");
  await expect(journal.collectGarbage({ execute: true, graceMs: -1 })).rejects.toThrow("Missing journal");
  expect(await bindings.CONTENT.get(uncollected)).not.toBeNull();
});
