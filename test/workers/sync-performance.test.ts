import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import type { PersistentVaultDO, TestEnv } from "./entry.js";
import type { FullTextNote, VaultBindings, VaultRef } from "../../packages/livesync-workers/src/types.js";
import { stopCheckpointAlarms } from "./checkpoint-helpers.js";

const bindings = env as unknown as TestEnv;
const created: DurableObjectStub[] = [];
afterEach(() => stopCheckpointAlarms(created.splice(0)));
async function fixture(name: string) {
  const stub = bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName(`${name}:vault`));
  created.push(stub);
  await runInDurableObject(stub, async (instance: PersistentVaultDO, state) => {
    (instance as unknown as { scheduleIndexing(): Promise<void> }).scheduleIndexing = async () => {};
    await state.storage.deleteAlarm();
  });
  await stub.fetch("https://db/", { method: "PUT" });
  return stub;
}
const bulk = (docs: unknown[]) => new Request("https://db/_bulk_docs", {
  method: "POST", body: JSON.stringify({ new_edits: false, docs }),
});

it("filters long runs and conflict leaves from SQL without any revision-body R2 reads", async () => {
  const stub = await fixture("metadata-changes");
  await stub.fetch(bulk([
    ...Array.from({ length: 75 }, (_, i) => ({ _id: `chunk-${i}`, _rev: "1-fixed", type: "leaf", data: "excluded" })),
    { _id: "note", _rev: "2-a", type: "plain", path: "note.md", data: "A" },
    { _id: "note", _rev: "2-b", type: "leaf", data: "B" },
    { _id: "note-2", _rev: "1-fixed", type: "plain", path: "other.md", data: "C" },
  ]));
  await runInDurableObject(stub, async (instance: PersistentVaultDO) => {
    const mutable = instance as unknown as { bindings(): VaultBindings };
    const original = mutable.bindings.bind(instance);
    let bodyReads = 0;
    const bucket = original().contentBucket!;
    const proxy = new Proxy(bucket, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key !== "get") return typeof value === "function" ? value.bind(target) : value;
      return (name: string, ...args: unknown[]) => {
        if (name.includes("/objects/")) bodyReads++;
        return value.apply(target, [name, ...args]);
      };
    } });
    mutable.bindings = () => ({ ...original(), contentBucket: proxy });
    try {
      const changes = async (since: number, style: string) => (await instance.fetch(new Request("https://db/_changes", {
        method: "POST", body: JSON.stringify({ since, limit: 1, style, selector: { type: { $ne: "leaf" } } }),
      }))).json() as Promise<{ results: Array<{ id: string; changes: Array<{ rev: string }> }>; last_seq: number; pending: number }>;
      const first = await changes(0, "all_docs");
      expect(first.results).toEqual([{ id: "note", seq: 77, changes: [{ rev: "2-a" }] }]);
      expect(first.last_seq).toBe(77);
      expect(first.pending).toBe(1);
      const second = await changes(first.last_seq, "all_docs");
      expect(second.results.map(row => row.id)).toEqual(["note-2"]);
      const main = await changes(0, "main_only");
      expect(main.results.map(row => row.id)).toEqual(["note-2"]);
      expect(bodyReads).toBe(0);
    } finally { mutable.bindings = original; }
  });
});

it("falls back for absent/null/non-scalar metadata, custom fields and missing legacy metadata", async () => {
  const stub = await fixture("selector-fallback");
  await stub.fetch(bulk([
    { _id: "missing", _rev: "1-fixed", data: "missing" },
    { _id: "null", _rev: "1-fixed", type: null, data: "null" },
    { _id: "object", _rev: "1-fixed", type: { nested: "value" }, data: "object" },
    { _id: "false", _rev: "1-fixed", _deleted: false, deleted: false, data: "false" },
    { _id: "legacy", _rev: "1-fixed", type: "plain", data: "custom" },
  ]));
  await runInDurableObject(stub, async (instance: PersistentVaultDO, state) => {
    state.storage.sql.exec("DELETE FROM rev_metadata WHERE id='legacy'");
    const selected = async (selector: unknown) => {
      const data = await (await instance.fetch(new Request("https://db/_changes", {
        method: "POST", body: JSON.stringify({ style: "all_docs", selector }),
      }))).json() as { results: Array<{ id: string }> };
      return data.results.map(row => row.id);
    };
    expect(await selected({ type: null })).toEqual(["null"]);
    expect(await selected({ type: { $exists: false } })).toEqual(["missing", "false"]);
    expect(await selected({ "type.nested": "value" })).toEqual(["object"]);
    expect(await selected({ _deleted: false, deleted: false })).toEqual(["false"]);
    expect(await selected({ $and: [{ type: "plain" }, { data: "custom" }] })).toEqual(["legacy"]);
    expect(await selected({ $or: [{ _id: "null" }, { data: "custom" }] })).toEqual(["null", "legacy"]);
  });
});

it("uploads replication envelopes with bounded concurrency while preserving sequence, duplicate and ancestry semantics", async () => {
  const stub = await fixture("parallel-bulk");
  await runInDurableObject(stub, async (instance: PersistentVaultDO, state) => {
    const mutable = instance as unknown as { bindings(): VaultBindings };
    const original = mutable.bindings.bind(instance);
    let active = 0, peak = 0;
    const proxy = new Proxy(original().contentBucket!, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key !== "put") return typeof value === "function" ? value.bind(target) : value;
      return async (name: string, ...args: unknown[]) => {
        if (!name.includes("/objects/")) return value.apply(target, [name, ...args]);
        active++; peak = Math.max(peak, active);
        try { await new Promise(resolve => setTimeout(resolve, 10)); return await value.apply(target, [name, ...args]); }
        finally { active--; }
      };
    } });
    mutable.bindings = () => ({ ...original(), contentBucket: proxy });
    try {
      const docs = Array.from({ length: 10 }, (_, i) => ({ _id: `n-${i}`, _rev: "2-fixed", _revisions: { start: 2, ids: ["fixed", "root"] }, data: `value-${i}` }));
      const response = await instance.fetch(bulk([...docs, { ...docs[0], data: "duplicate must not overwrite" }, { _id: "bad", _rev: "invalid" }]));
      expect(response.status).toBe(200);
      const results = await response.json() as Array<{ error?: string }>;
      expect(results.at(-1)?.error).toBe("bad_request");
      expect(peak).toBe(4);
      expect(active).toBe(0);
      expect(state.storage.sql.exec<{ seq: number }>("SELECT seq FROM changes ORDER BY seq").toArray().map(row => row.seq)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
      expect(await (await instance.fetch(new Request("https://db/n-0?revs=true"))).json()).toMatchObject({ data: "value-0", _revisions: { start: 2, ids: ["fixed", "root"] } });
    } finally { mutable.bindings = original; }
  });
});

it("settles failed uploads before returning and does not publish a partially staged batch", async () => {
  const stub = await fixture("parallel-bulk-failure");
  await runInDurableObject(stub, async (instance: PersistentVaultDO, state) => {
    const mutable = instance as unknown as { bindings(): VaultBindings };
    const original = mutable.bindings.bind(instance);
    let active = 0, started = 0, settled = 0;
    const proxy = new Proxy(original().contentBucket!, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key !== "put") return typeof value === "function" ? value.bind(target) : value;
      return async (name: string, ...args: unknown[]) => {
        if (!name.includes("/objects/")) return value.apply(target, [name, ...args]);
        const first = started++ === 0; active++;
        try { if (first) throw new Error("Injected immutable upload failure"); await new Promise(resolve => setTimeout(resolve, 20)); return await value.apply(target, [name, ...args]); }
        finally { active--; settled++; }
      };
    } });
    mutable.bindings = () => ({ ...original(), contentBucket: proxy });
    try {
      expect((await instance.fetch(bulk(Array.from({ length: 8 }, (_, i) => ({ _id: `n-${i}`, _rev: "1-fixed", data: "saved" }))))).status).toBe(500);
      expect(started).toBe(4); expect(settled).toBe(4); expect(active).toBe(0);
      expect(state.storage.sql.exec("SELECT * FROM docs").toArray()).toHaveLength(0);
    } finally { mutable.bindings = original; }
    expect((await instance.fetch(bulk([{ _id: "retry", _rev: "1-fixed", data: "saved" }]))).status).toBe(200);
    expect(await (await instance.fetch(new Request("https://db/retry"))).json()).toMatchObject({ data: "saved" });
  });
});

it("prepares multiple notes despite R2 latency, bounds reads and coalesces shared chunks", async () => {
  const stub = await fixture("parallel-index-preparation");
  await stub.fetch(bulk([
    { _id: "h:shared", _rev: "1-fixed", type: "leaf", data: "東京 API" },
    ...Array.from({ length: 20 }, (_, i) => ({ _id: `n-${i}`, _rev: "1-fixed", type: "plain", path: `n-${i}.md`, children: ["h:shared"] })),
  ]));
  await runInDurableObject(stub, async (instance: PersistentVaultDO, state) => {
    const mutable = instance as unknown as { bindings(): VaultBindings };
    const original = mutable.bindings.bind(instance);
    let active = 0, peak = 0, reads = 0;
    const proxy = new Proxy(original().contentBucket!, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key !== "get") return typeof value === "function" ? value.bind(target) : value;
      return async (name: string, ...args: unknown[]) => {
        if (!name.includes("/objects/")) return value.apply(target, [name, ...args]);
        reads++; active++; peak = Math.max(peak, active);
        try { await new Promise(resolve => setTimeout(resolve, 60)); return await value.apply(target, [name, ...args]); }
        finally { active--; }
      };
    } });
    mutable.bindings = () => ({ ...original(), contentBucket: proxy });
    try {
      await instance.alarm();
      expect(peak).toBe(4); expect(active).toBe(0);
      expect(reads).toBe(17); // 16 notes + one shared chunk, fetched once in this snapshot.
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM index_state WHERE pending=0 AND fts_hash IS NOT NULL").one().n).toBe(16);
      await instance.alarm();
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM index_state WHERE pending=0 AND fts_hash IS NOT NULL").one().n).toBe(20);
    } finally { mutable.bindings = original; }
  });
});

it("rearms a lost alarm for publishable pending notes even when the change cursor is caught up", async () => {
  const stub = await fixture("resume-pending-index");
  await stub.fetch(bulk([{ _id: "note", _rev: "1-fixed", type: "plain", path: "note.md", data: "東京 API" }]));
  await runInDurableObject(stub, async (instance: PersistentVaultDO, state) => {
    await instance.alarm();
    state.storage.sql.exec("UPDATE index_state SET pending=1,fts_hash=NULL,attempts=0");
    const mutable = instance as unknown as { scheduleIndexing(): Promise<void>; lastIndexScheduleAt: number };
    const scheduling = mutable.scheduleIndexing;
    let scheduled = 0;
    mutable.lastIndexScheduleAt = 0;
    mutable.scheduleIndexing = async () => { scheduled++; };
    try {
      expect((await instance.fetch(new Request("https://db/"))).status).toBe(200);
      expect(scheduled).toBe(1);
      // A permanently missing chunk remains capped instead of spinning on reads.
      state.storage.sql.exec("UPDATE index_state SET attempts=20");
      mutable.lastIndexScheduleAt = 0;
      expect((await instance.fetch(new Request("https://db/"))).status).toBe(200);
      expect(scheduled).toBe(1);
    } finally { mutable.scheduleIndexing = scheduling; }
  });
});

it("continues pending-only batches without requiring another foreground request", async () => {
  const stub = await fixture("continue-pending-index");
  await stub.fetch(bulk(Array.from({ length: 32 }, (_, i) => ({ _id: `n-${i}`, _rev: "1-fixed", type: "plain", path: `n-${i}.md`, data: "東京 API" }))));
  await runInDurableObject(stub, async (instance: PersistentVaultDO, state) => {
    for (let i = 0; i < 10; i++) {
      await instance.alarm();
      if (state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM index_state WHERE pending=0 AND fts_hash IS NOT NULL").one().n === 32) break;
    }
    expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM index_state WHERE pending=0 AND fts_hash IS NOT NULL").one().n).toBe(32);
    state.storage.sql.exec("UPDATE index_state SET pending=1,fts_hash=NULL,attempts=0");
    const mutable = instance as unknown as { scheduleIndexing(delay?: number): Promise<void> };
    const scheduling = mutable.scheduleIndexing;
    const scheduled: Array<number | undefined> = [];
    mutable.scheduleIndexing = async delay => { scheduled.push(delay); };
    try {
      await instance.alarm();
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM index_state WHERE pending=1").one().n).toBe(16);
      expect(scheduled).toContain(0);
      scheduled.length = 0;
      await instance.alarm();
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM index_state WHERE pending=1").one().n).toBe(0);
      expect(scheduled).toHaveLength(0);
    } finally { mutable.scheduleIndexing = scheduling; }
  });
});

it("reduces over-limit index batches durably and finishes without losing pending notes", async () => {
  const stub = await fixture("adaptive-publication-batch");
  await stub.fetch(bulk(Array.from({ length: 16 }, (_, i) => ({ _id: `n-${i}`, _rev: "1-fixed", type: "plain", path: `n-${i}.md`, data: "東京 API" }))));
  await runInDurableObject(stub, async (instance: PersistentVaultDO, state) => {
    const mutable = instance as unknown as { bindings(): VaultBindings };
    const original = mutable.bindings.bind(instance);
    const fullText = original().fullText!;
    const sizes: number[] = [];
    const limited = new Proxy(fullText, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key !== "openWriter") return typeof value === "function" ? value.bind(target) : value;
      return async (ref: VaultRef) => {
        const writer = await target.openWriter(ref); let count = 0;
        return {
          upsert: async (note: FullTextNote) => { count++; await writer.upsert(note); },
          delete: (path: string) => writer.delete(path),
          close: async () => {
            sizes.push(count);
            if (count > 4) throw new Error("Too many API requests by single Worker invocation.");
            await writer.close();
          },
        };
      };
    } });
    mutable.bindings = () => ({ ...original(), fullText: limited });
    try {
      await instance.alarm();
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM index_state WHERE pending=1").one().n).toBe(16);
      expect(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='index_publication_batch_size'").one().value).toBe("8");
      await instance.alarm();
      expect(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='index_publication_batch_size'").one().value).toBe("4");
      for (let i = 0; i < 8; i++) {
        await instance.alarm();
        if (state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM index_state WHERE pending=1").one().n === 0) break;
      }
      expect(sizes.slice(0, 2)).toEqual([16, 8]);
      expect(sizes.slice(2).every(size => size <= 4)).toBe(true);
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM index_state WHERE pending=0 AND fts_hash IS NOT NULL").one().n).toBe(16);
      const searched = await fullText.search({tenantId:"adaptive-publication-batch",databaseName:"vault"},"東京",20);
      expect(searched.docCount).toBe(16);
      expect(searched.hits).toHaveLength(16);
    } finally { mutable.bindings = original; }
  });
});
