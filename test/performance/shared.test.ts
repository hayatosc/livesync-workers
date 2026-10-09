import { env, runInDurableObject } from "cloudflare:test";
import { it, expect } from "vitest";
import { SegmenterFullTextIndex } from "../../packages/livesync-workers/src/search/segmenter-index.js";
import type { VaultBindings } from "../../packages/livesync-workers/src/types.js";
import type { PersistentVaultDO, TestEnv } from "../workers/entry.js";
const bindings = env as unknown as TestEnv;
const result: unknown[] = [];
const delayMs = 2;
function metered(bucket: R2Bucket, counts: Record<string, number>) {
  return new Proxy(bucket, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const name = String(key);
        if (name in counts) counts[name] = (counts[name] ?? 0) + 1;
        await new Promise((r) => setTimeout(r, delayMs));
        return value.apply(target, args);
      };
    },
  });
}
const counts = () => ({ get: 0, put: 0, list: 0, delete: 0, head: 0 });
it("measures shared lookup and durable save operations on local Workers bindings", async () => {
  for (const size of [32, 128, 512]) {
    const ops = counts();
    const index = new SegmenterFullTextIndex(metered(bindings.SEARCH, ops));
    const ref = { tenantId: `measured-${size}`, vaultId: "one", databaseName: "vault" };
    await index.beginRebuild(ref);
    const writer = await index.openWriter(ref);
    const start = Date.now();
    for (let i = 0; i < size; i++)
      await writer.upsert({
        path: `folder/n${String(i).padStart(4, "0")}.md`,
        content: `# 東京 API\n日本語の検索 API 識別子 foo_bar ${i === 0 ? "needle" : "ordinary"}`,
        contentHash: `h${i}`,
        mtime: null,
      });
    await writer.close();
    await index.completeRebuild(ref);
    result.push({ name: `index-build-${size}`, ms: Date.now() - start, operations: { ...ops } });
    for (const query of ["needle", '"東京 API"', "missing"]) {
      Object.assign(ops, counts());
      const latencies = [];
      for (let i = 0; i < 5; i++) {
        const before = Date.now();
        const found = await index.search(ref, query, 10);
        expect(found.docCount).toBe(size);
        expect(found.hits.length).toBe(query === "missing" ? 0 : query === "needle" ? 1 : 10);
        latencies.push(Date.now() - before);
      }
      const sorted = [...latencies].sort((a, b) => a - b);
      result.push({
        name: `search-${size}-${query}`,
        samples: latencies,
        p50Ms: sorted[2],
        p95Ms: sorted[4],
        operations: { ...ops },
      });
    }
  }
  const stub = bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName("measured-save:vault"));
  await stub.fetch("https://db/", { method: "PUT" });
  await runInDurableObject(stub, async (instance: PersistentVaultDO, state) => {
    const mutable = instance as unknown as {
      bindings(): VaultBindings;
      scheduleIndexing(delay?: number): Promise<void>;
    };
    const original = mutable.bindings.bind(instance);
    const scheduling = mutable.scheduleIndexing.bind(instance);
    const ops = counts();
    const bucket = metered(original().contentBucket!, ops);
    mutable.bindings = () => ({ ...original(), contentBucket: bucket });
    mutable.scheduleIndexing = async () => {};
    await state.storage.deleteAlarm();
    try {
      for (const [name, batches, count] of [
        ["normal", 20, 1],
        ["bulk-burst", 4, 25],
        ["initial", 1, 128],
      ] as const) {
        Object.assign(ops, counts());
        const latencies = [];
        const started = Date.now();
        for (let batch = 0; batch < batches; batch++) {
          const before = Date.now();
          const docs = Array.from({ length: count }, (_, i) => ({
            _id: `${name}-${batch}-${i}`,
            _rev: "1-fixed",
            data: "saved",
            type: "plain",
          }));
          const response = await instance.fetch(
            new Request("https://db/_bulk_docs", { method: "POST", body: JSON.stringify({ new_edits: false, docs }) }),
          );
          expect(response.status).toBe(200);
          latencies.push(Date.now() - before);
        }
        const sorted = [...latencies].sort((a, b) => a - b);
        result.push({
          name,
          samples: latencies,
          p50Ms: sorted[Math.ceil(sorted.length / 2) - 1],
          p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
          elapsedMs: Date.now() - started,
          operations: { ...ops },
          sqliteBytes: state.storage.sql.databaseSize,
        });
      }
      Object.assign(ops, counts());
      const diffTimes = [];
      for (let i = 0; i < 8; i++) {
        const before = Date.now();
        expect(
          (
            await instance.fetch(
              new Request("https://db/_revs_diff", {
                method: "POST",
                body: JSON.stringify({ "normal-0-0": ["1-fixed", "2-missing"] }),
              }),
            )
          ).status,
        ).toBe(200);
        diffTimes.push(Date.now() - before);
      }
      result.push({ name: "offline-catchup", samples: diffTimes, operations: { ...ops } });
      Object.assign(ops, counts());
      const concurrentStart = Date.now();
      const concurrentTimes: number[] = [];
      await Promise.all(
        Array.from({ length: 16 }, async (_, i) => {
          const before = Date.now();
          expect(
            (
              await instance.fetch(
                new Request(`https://db/concurrent-${i}`, {
                  method: "PUT",
                  body: JSON.stringify({ data: "concurrent" }),
                }),
              )
            ).status,
          ).toBe(200);
          concurrentTimes.push(Date.now() - before);
        }),
      );
      const sorted = concurrentTimes.sort((a, b) => a - b);
      result.push({
        name: "concurrent-16",
        p50Ms: sorted[7],
        p95Ms: sorted[15],
        elapsedMs: Date.now() - concurrentStart,
        operations: { ...ops },
      });
      Object.assign(ops, counts());
      let throttled = false;
      const throttle = new Proxy(bucket, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key !== "put") return typeof value === "function" ? value.bind(target) : value;
          return async (name: string, ...args: unknown[]) => {
            if (name.endsWith("head.json") && !throttled) {
              throttled = true;
              throw Object.assign(new Error("Injected 429"), { status: 429 });
            }
            return value.apply(target, [name, ...args]);
          };
        },
      });
      mutable.bindings = () => ({ ...original(), contentBucket: throttle });
      const retryStart = Date.now();
      expect(
        (
          await instance.fetch(
            new Request("https://db/retry-durable", {
              method: "PUT",
              body: JSON.stringify({ data: "retry survived" }),
            }),
          )
        ).status,
      ).toBe(200);
      result.push({ name: "head-429-retry", elapsedMs: Date.now() - retryStart, operations: { ...ops } });
      mutable.bindings = () => ({ ...original(), contentBucket: bucket });
      Object.assign(ops, counts());
      for (const table of [
        "docs",
        "revs",
        "rev_metadata",
        "local_docs",
        "changes",
        "rev_body_chunks",
        "meta",
        "index_state",
      ])
        state.storage.sql.exec(`DELETE FROM ${table}`);
      const restoreStart = Date.now();
      expect(await (await instance.fetch(new Request("https://db/retry-durable"))).json()).toMatchObject({
        data: "retry survived",
      });
      result.push({
        name: "cache-loss-restore",
        elapsedMs: Date.now() - restoreStart,
        operations: { ...ops },
        sqliteBytes: state.storage.sql.databaseSize,
      });
    } finally {
      mutable.bindings = original;
      mutable.scheduleIndexing = scheduling;
      await state.storage.deleteAlarm();
    }
  });
  const fair = bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName("measured-maintenance:vault"));
  await runInDurableObject(fair, async (instance: PersistentVaultDO, state) => {
    const mutable = instance as unknown as {
      bindings(): VaultBindings;
      scheduleIndexing(delay?: number): Promise<void>;
    };
    const original = mutable.bindings.bind(instance);
    const scheduling = mutable.scheduleIndexing.bind(instance);
    mutable.scheduleIndexing = async () => {};
    await state.storage.deleteAlarm();
    try {
      await instance.fetch(new Request("https://db/", { method: "PUT" }));
      await instance.fetch(
        new Request("https://db/_bulk_docs", {
          method: "POST",
          body: JSON.stringify({
            new_edits: false,
            docs: Array.from({ length: 128 }, (_, i) => ({
              _id: `fair-${i}`,
              _rev: "1-fixed",
              path: `fair-${i}.md`,
              type: "plain",
              data: "東京 API",
            })),
          }),
        }),
      );
      const contentOps = counts(),
        searchOps = counts();
      const content = metered(original().contentBucket!, contentOps);
      const search = new SegmenterFullTextIndex(metered(bindings.SEARCH, searchOps));
      mutable.bindings = () => ({ ...original(), contentBucket: content, fullText: search });
      expect((await instance.fetch(new Request("https://db/_compact", { method: "POST" }))).status).toBe(202);
      const began = Date.now();
      let firstIndexAlarm: number | null = null,
        checkpointFinishedAlarm: number | null = null;
      const progress = [];
      for (let alarm = 1; alarm <= 300; alarm++) {
        const before = Date.now();
        await instance.alarm();
        const pendingCheckpoint = state.storage.sql.exec("SELECT * FROM checkpoint_work").toArray().length > 0;
        const indexed = state.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM index_state WHERE pending=0 AND fts_hash IS NOT NULL")
          .one().n;
        if (indexed && firstIndexAlarm === null) firstIndexAlarm = alarm;
        if (!pendingCheckpoint && checkpointFinishedAlarm === null) checkpointFinishedAlarm = alarm;
        progress.push({ alarm, ms: Date.now() - before, indexed, pendingCheckpoint });
        if (!pendingCheckpoint && indexed === 128) break;
      }
      expect(progress.at(-1)?.indexed).toBe(128);
      expect(progress.at(-1)?.pendingCheckpoint).toBe(false);
      result.push({
        name: "checkpoint-indexing-128",
        elapsedMs: Date.now() - began,
        firstIndexAlarm,
        checkpointFinishedAlarm,
        progress,
        contentOperations: contentOps,
        searchOperations: searchOps,
        sqliteBytes: state.storage.sql.databaseSize,
      });
    } finally {
      mutable.bindings = original;
      mutable.scheduleIndexing = scheduling;
      await state.storage.deleteAlarm();
    }
  });
  console.log(
    "SHARED_PERFORMANCE_JSON " +
      JSON.stringify({
        label: process.env.PERF_LABEL,
        runtime: "local workerd, local official SQLite/R2 bindings",
        artificialOperationDelayMs: delayMs,
        productionMeasurement: false,
        results: result,
      }),
  );
}, 120_000);
