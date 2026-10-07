import { env, runInDurableObject } from "cloudflare:test";
import { it, expect, afterEach } from "vitest";
import { PersistentVaultDO, type TestEnv } from "./entry.js";
import type { VaultBindings } from "../../packages/livesync-workers/src/types.js";
import { R2Journal, contentPrefix } from "../../packages/livesync-workers/src/storage/r2-journal.js";
import { drainCheckpoint, stopCheckpointAlarms } from "./checkpoint-helpers.js";
const bindings = env as unknown as TestEnv;
const cacheTables = ["docs", "revs", "rev_metadata", "local_docs", "changes", "rev_body_chunks", "meta", "index_state"];
const created: DurableObjectStub[] = [];
afterEach(() => stopCheckpointAlarms(created.splice(0)));
function stub(name: string) { const object = bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName(`${name}:vault`)); created.push(object); return object; }
async function revisions(object: DurableObjectStub, count = 8) {
  for (let i = 1; i <= count; i++) {
    const response = await object.fetch("https://db/_bulk_docs", { method: "POST", body: JSON.stringify({ new_edits: false, docs: [{ _id: "note", _rev: `${i}-r${i}`, _revisions: { start: i, ids: Array.from({ length: i }, (_, j) => `r${i-j}`) }, type: "plain", path: "Note.md", data: `body ${i}` }] }) });
    expect(response.status).toBe(200);
  }
}
it("compacts metadata while preserving history, conflict ancestry, monotonic feed and indexing backlog", async () => {
  const object = stub("compact-capacity");
  await object.fetch("https://db/", { method: "PUT" });
  await revisions(object);
  const feed = await (await object.fetch("https://db/_changes?style=all_docs&revs=true&include_docs=true")).json();
  expect((await object.fetch("https://db/_compact", { method: "POST" })).status).toBe(202);
  await drainCheckpoint(object);
  await runInDurableObject(object, async (_instance, state) => {
    expect(state.storage.sql.exec("SELECT * FROM revs").toArray()).toHaveLength(1);
    expect(state.storage.sql.exec("SELECT * FROM rev_metadata").toArray()).toHaveLength(1);
    expect(JSON.parse(state.storage.sql.exec<{ rev_history: string }>("SELECT rev_history FROM revs").one().rev_history)).toHaveProperty("r2");
  });
  expect(await (await object.fetch("https://db/_changes?style=all_docs&revs=true&include_docs=true")).json()).toEqual(feed);
  expect(await (await object.fetch("https://db/note?rev=1-r1")).json()).toMatchObject({ data: "body 1" });
  expect(await (await object.fetch("https://db/_revs_diff", { method: "POST", body: '{"note":["1-r1","8-r8","9-unknown"]}' })).json()).toEqual({ note: { missing: ["9-unknown"] } });
  await runInDurableObject(object, async (instance: PersistentVaultDO, state) => {
    await instance.alarm();
    expect((state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='indexed_seq'").toArray()[0]?.value)).toBeDefined();
  });
  await object.fetch("https://db/_compact", { method: "POST" });
  await drainCheckpoint(object);
  await runInDurableObject(object, async (_instance, state) => { expect(state.storage.sql.exec("SELECT * FROM changes").toArray()).toHaveLength(1); });
  await runInDurableObject(object, async (_instance, state) => { for (const table of cacheTables) state.storage.sql.exec(`DELETE FROM ${table}`); });
  expect(await (await object.fetch("https://db/note?rev=1-r1")).json()).toMatchObject({ data: "body 1" });
  expect(await (await object.fetch("https://db/_changes?style=all_docs&revs=true&include_docs=true")).json()).toEqual(feed);
  expect((await object.fetch("https://db/note", { method: "PUT", body: '{"_rev":"8-r8","data":"new"}' })).status).toBe(200);
  expect((await (await object.fetch("https://db/_changes?since=8")).json() as { last_seq: number }).last_seq).toBe(9);
});
it("restores from a paged checkpoint without reading old commits and keeps them protected from GC", async () => {
  const journal = new R2Journal(bindings.CONTENT, contentPrefix("checkpoint", "one"));
  const old = await journal.commit([{ sql: "old", args: [] }]);
  async function* pages() { for (let i=0; i<3; i++) yield [{ sql: `page${i}`, args: [i] }]; }
  const checkpoint = await journal.snapshot(pages());
  const snap = await journal.commit([], old, checkpoint);
  const head = await journal.commit([{ sql: "after", args: [] }], snap);
  const batches = [];
  for await (const batch of journal.replay(head)) batches.push(batch);
  expect(batches.flatMap(batch => batch.statements.map(statement => statement.sql))).toEqual(["page0", "page1", "page2", "after"]);
  expect(batches[0]?.reset).toBe(true);
  const incremental = [];
  for await (const batch of journal.replay(head, snap)) incremental.push(batch);
  expect(incremental).toEqual([{ statements: [{ sql: "after", args: [] }], reset: false, commit: head }]);
  expect(await journal.collectGarbage({ graceMs: -1 })).not.toContain(checkpoint.r2);
  await bindings.CONTENT.delete(old);
  const recovered = [];
  for await (const batch of journal.replay(head)) recovered.push(batch);
  expect(recovered).toEqual(batches);
});
it("refuses growth with capacity headroom while preserving reads and maintenance", async () => {
  const object = stub("headroom");
  await object.fetch("https://db/", { method: "PUT" });
  await revisions(object, 2);
  await runInDurableObject(object, async (instance: PersistentVaultDO) => {
    const mutable = instance as unknown as { bindings(): VaultBindings };
    const original = mutable.bindings.bind(instance);
    mutable.bindings = () => ({ ...original(), sqliteMaxBytes: 1, sqliteHeadroomBytes: 0 });
    try {
      expect((await instance.fetch(new Request("https://db/blocked", { method: "PUT", body: '{"data":"no"}' }))).status).toBe(507);
      expect((await instance.fetch(new Request("https://db/note"))).status).toBe(200);
      expect((await instance.fetch(new Request("https://db/_revs_diff", { method: "POST", body: '{"note":["2-r2"]}' }))).status).toBe(200);
      expect((await instance.fetch(new Request("https://db/_compact", { method: "POST" }))).status).toBe(202);
    } finally { mutable.bindings = original; }
  });
  expect((await object.fetch("https://db/blocked")).status).toBe(404);
});
for (const boundary of ["objects/", "snapshot-page", "snapshot-manifest", "commits/", "head.json", "head-after"]) {
  it(`recovers a compaction failure at ${boundary} without losing acknowledged revisions`, async () => {
    const object = stub(`compact-fault-${boundary.replace(/\W/g, "")}`);
    await object.fetch("https://db/", { method: "PUT" });
    await revisions(object, 3);
    await runInDurableObject(object, async (instance: PersistentVaultDO) => {
      const mutable = instance as unknown as { bindings(): VaultBindings };
      const original = mutable.bindings.bind(instance);
      let fired = false;
      const bucket = original().contentBucket!;
      const faultBucket = new Proxy(bucket, { get(target, property) {
        if (property !== "put") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
        return async (key: string, value: Parameters<R2Bucket["put"]>[1], options?: R2PutOptions) => {
          const text = value instanceof Uint8Array ? new TextDecoder().decode(value) : "";
          const matches = boundary === "snapshot-page" ? text.startsWith('{"statements":') : boundary === "snapshot-manifest" ? text.startsWith('{"references":') : boundary === "head-after" ? key.endsWith("head.json") : key.includes(boundary);
          if (!fired && matches) {
            fired = true;
            if (boundary === "head-after") await target.put(key, value, options);
            throw new Error(`Injected compaction ${boundary}`);
          }
          return target.put(key, value, options);
        };
      } });
      mutable.bindings = () => ({ ...original(), contentBucket: faultBucket });
      try {
        expect((await instance.fetch(new Request("https://db/_compact", { method: "POST" }))).status).toBe(202);
        for (let slices=0; slices<100 && !fired; slices++) await instance.alarm();
      }
      finally { mutable.bindings = original; }
      expect(fired).toBe(true);
    });
    for (let i=1; i<=3; i++) expect(await (await object.fetch(`https://db/note?rev=${i}-r${i}`)).json()).toMatchObject({ data: `body ${i}` });
    expect((await object.fetch("https://db/_compact", { method: "POST" })).status).toBe(202);
  await drainCheckpoint(object);
    await runInDurableObject(object, async (_instance, state) => { for (const table of cacheTables) state.storage.sql.exec(`DELETE FROM ${table}`); });
    expect(await (await object.fetch("https://db/note?rev=1-r1")).json()).toMatchObject({ data: "body 1" });
  });
}
it("retains conflict leaves and deleted leaves after compaction, reconstruction and stale replication", async () => {
  const object = stub("compact-conflicts");
  await object.fetch("https://db/", { method: "PUT" });
  await object.fetch("https://db/_bulk_docs", { method: "POST", body: JSON.stringify({ new_edits: false, docs: [
    { _id: "doc", _rev: "2-a", _revisions: { start: 2, ids: ["a", "root"] }, data: "A" },
    { _id: "doc", _rev: "2-b", _revisions: { start: 2, ids: ["b", "root"] }, data: "B" },
  ] }) });
  await object.fetch("https://db/doc?rev=2-b", { method: "DELETE" });
  const expected = await (await object.fetch("https://db/_changes?style=all_docs&include_docs=true&revs=true")).json();
  expect((await object.fetch("https://db/_compact", { method: "POST" })).status).toBe(202);
  await drainCheckpoint(object);
  await runInDurableObject(object, async (_instance, state) => { for (const table of cacheTables) state.storage.sql.exec(`DELETE FROM ${table}`); });
  expect(await (await object.fetch("https://db/_changes?style=all_docs&include_docs=true&revs=true")).json()).toEqual(expected);
  expect((await object.fetch('https://db/doc?open_revs=["1-root"]&latest=true')).status).toBe(200);
  const latest = await (await object.fetch('https://db/doc?open_revs=["1-root"]&latest=true')).json() as unknown[];
  expect(latest).toHaveLength(2);
  await object.fetch("https://db/_bulk_docs", { method: "POST", body: '{"new_edits":false,"docs":[{"_id":"doc","_rev":"2-b","data":"B"}]}' });
  expect(await (await object.fetch("https://db/_changes?style=all_docs&include_docs=true&revs=true")).json()).toEqual(expected);
});

it("bounds checkpoint catalogs as well as row pages", async () => {
  const journal = new R2Journal(bindings.CONTENT, contentPrefix("catalogs", "one"));
  async function* pages() { for (let i=0; i<130; i++) yield [{ sql: "row", args: [i] }]; }
  const checkpoint = await journal.snapshot(pages());
  const catalog = JSON.parse(await journal.body(checkpoint.r2)) as { references: unknown[]; previous: { r2: string } };
  expect(catalog.references).toHaveLength(2);
  expect(JSON.parse(await journal.body(catalog.previous.r2)).references).toHaveLength(128);
  const head = await journal.commit([], null, checkpoint);
  const values: number[] = [];
  for await (const batch of journal.replay(head)) for (const statement of batch.statements) values.push(Number(statement.args[0]));
  expect(values.sort((a,b) => a-b)).toEqual(Array.from({ length: 130 }, (_,i) => i));
});

it("compacts a reverse-inserted ancestry across multiple archive pages without creating false leaves", async () => {
  const object = stub("deep-compaction");
  await object.fetch("https://db/", { method: "PUT" });
  await object.fetch("https://db/_bulk_docs", { method: "POST", body: JSON.stringify({ new_edits: false, docs: [
    { _id: "deep", _rev: "131-g131", _revisions: { start: 131, ids: Array.from({ length: 131 }, (_, i) => `g${131-i}`) }, data: "leaf" },
  ] }) });
  expect((await object.fetch("https://db/_compact", { method: "POST" })).status).toBe(202);
  await drainCheckpoint(object);
  await runInDurableObject(object, async (_instance, state) => { expect(state.storage.sql.exec("SELECT * FROM revs").toArray()).toHaveLength(1); });
  const leaves = await (await object.fetch('https://db/deep?open_revs=["1-g1"]&latest=true')).json() as unknown[];
  expect(leaves).toHaveLength(1);
});

it("replays only unapplied commits and preserves derived index progress on incremental recovery", async () => {
  const object = stub("incremental-cache");
  await object.fetch("https://db/", { method: "PUT" });
  await revisions(object, 1);
  let applied = "";
  let progress: unknown;
  await runInDurableObject(object, async (instance: PersistentVaultDO, state) => {
    await instance.alarm();
    applied = state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='r2_applied_head_v3'").one().value;
    progress = state.storage.sql.exec("SELECT * FROM index_state").toArray();
  });
  const journal = new R2Journal(bindings.CONTENT, contentPrefix("incremental-cache", "vault"));
  await journal.commit([{ sql: "INSERT INTO meta (key,value) VALUES (?,?)", args: ["incremental_probe", "applied"] }], applied);
  // A read should not touch the previous manifest when its head is already applied locally.
  await bindings.CONTENT.delete(applied);
  expect((await object.fetch("https://db/note")).status).toBe(200);
  await runInDurableObject(object, async (_instance, state) => {
    expect(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='incremental_probe'").one().value).toBe("applied");
    expect(state.storage.sql.exec("SELECT * FROM index_state").toArray()).toEqual(progress);
  });
});

it("publishes the current update together with its automatic checkpoint at the revision cadence", async () => {
  const object = stub("automatic-checkpoint");
  await object.fetch("https://db/", { method: "PUT" });
  await revisions(object, 2);
  // Reach the cadence without issuing thousands of redundant integration requests.
  await runInDurableObject(object, async (_instance, state) => { state.storage.sql.exec("INSERT INTO meta (key,value) VALUES ('monotonic_seq','4095') ON CONFLICT(key) DO UPDATE SET value='4095'"); });
  expect((await object.fetch("https://db/note", { method: "PUT", body: '{"_rev":"2-r2","data":"automatic"}' })).status).toBe(200);
  await drainCheckpoint(object);
  await runInDurableObject(object, async (_instance, state) => {
    expect(state.storage.sql.exec("SELECT * FROM revs").toArray()).toHaveLength(1);
    expect(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='checkpoint_seq'").one().value).toBe("4096");
    for (const table of cacheTables) state.storage.sql.exec(`DELETE FROM ${table}`);
  });
  expect(await (await object.fetch("https://db/note")).json()).toMatchObject({ data: "automatic" });
  expect(await (await object.fetch("https://db/note?rev=1-r1")).json()).toMatchObject({ data: "body 1" });
  expect((await (await object.fetch("https://db/_changes?since=2")).json() as { last_seq: number }).last_seq).toBe(4096);
});

it("extends archived incomplete ancestry when an offline client supplies a late ancestor body", async () => {
  const object = stub("late-cold-parent");
  await object.fetch("https://db/", { method: "PUT" });
  const bulk = (docs: unknown[]) => object.fetch("https://db/_bulk_docs", { method: "POST", body: JSON.stringify({ new_edits: false, docs }) });
  await bulk([{ _id: "doc", _rev: "4-d", _revisions: { start: 4, ids: ["d", "c"] }, data: "D" }, { _id: "doc", _rev: "2-b", data: "B" }]);
  await object.fetch("https://db/_compact", { method: "POST" });
  await drainCheckpoint(object);
  expect((await bulk([{ _id: "doc", _rev: "3-c", _revisions: { start: 3, ids: ["c", "b", "a"] }, data: "C" }])).status).toBe(200);
  expect(await (await object.fetch("https://db/doc?rev=2-b")).json()).toMatchObject({ data: "B" });
  expect(await (await object.fetch('https://db/doc?open_revs=["1-a"]&latest=true')).json()).toEqual([expect.objectContaining({ ok: expect.objectContaining({ _rev: "4-d" }) })]);
  await runInDurableObject(object, async (_instance, state) => { for (const table of cacheTables) state.storage.sql.exec(`DELETE FROM ${table}`); });
  expect(await (await object.fetch('https://db/doc?open_revs=["1-a"]&latest=true')).json()).toEqual([expect.objectContaining({ ok: expect.objectContaining({ _rev: "4-d" }) })]);
});
