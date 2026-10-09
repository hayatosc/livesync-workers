import { env, runInDurableObject } from "cloudflare:test";
import { it, expect } from "vitest";
import { PersistentVaultDO, type TestEnv } from "../workers/entry.js";
import type { VaultBindings } from "../../packages/livesync-workers/src/types.js";
const bindings = env as unknown as TestEnv;
const delayMs = 2; // Explicit synthetic per CONTENT operation; not remote R2 latency.
const quantile = (values: number[], q: number) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * q) - 1)] ?? 0;
const report: unknown[] = [];
async function fixture(name: string, count: number) {
  const stub = bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName(`perf-${name}:vault`));
  await stub.fetch("https://db/", { method: "PUT" });
  await runInDurableObject(stub, async (instance: PersistentVaultDO, state) => {
    const scheduler = instance as unknown as { scheduleIndexing(delay?: number): Promise<void> };
    const original = scheduler.scheduleIndexing.bind(instance);
    scheduler.scheduleIndexing = async () => {};
    await state.storage.deleteAlarm();
    try {
      for (let start = 0; start < count; start += 128) {
        const docs = Array.from({ length: Math.min(128, count - start) }, (_, i) => ({
          _id: `note-${start + i}`,
          _rev: "1-root",
          type: "plain",
          path: `folder/${start + i}.md`,
          data: `original ${start + i}`,
        }));
        expect(
          (
            await instance.fetch(
              new Request("https://db/_bulk_docs", {
                method: "POST",
                body: JSON.stringify({ new_edits: false, docs }),
              }),
            )
          ).status,
        ).toBe(200);
      }
      if (
        state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='checkpoint_work'").toArray()
          .length
      ) {
        for (let i = 0; state.storage.sql.exec("SELECT * FROM checkpoint_work").toArray().length; i++) {
          if (i > 2000) throw new Error("Fixture checkpoint did not finish");
          await instance.alarm();
        }
      }
    } finally {
      scheduler.scheduleIndexing = original;
    }
  });
  return stub;
}
async function measure(
  name: string,
  stub: DurableObjectStub,
  requests: Array<{ path: string; method: string; body: unknown }>,
  checkpoint = false,
  concurrent = false,
  throttle = false,
) {
  await runInDurableObject(stub, async (instance: PersistentVaultDO, state) => {
    const mutable = instance as unknown as {
      bindings(): VaultBindings;
      scheduleIndexing(delay?: number): Promise<void>;
    };
    const original = mutable.bindings.bind(instance);
    const scheduling = mutable.scheduleIndexing.bind(instance);
    mutable.scheduleIndexing = async () => {};
    await state.storage.deleteAlarm();
    const counts: Record<string, number> = { get: 0, put: 0, head: 0, list: 0, delete: 0 };
    let failed = false;
    let clientRetries = 0;
    let peakSqliteBytes = state.storage.sql.databaseSize;
    const bucket = original().contentBucket!;
    const proxy = new Proxy(bucket, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          if (Object.hasOwn(counts, String(property))) counts[String(property)] = (counts[String(property)] ?? 0) + 1;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (throttle && !failed && property === "put" && String(args[0]).endsWith("head.json")) {
            failed = true;
            throw Object.assign(new Error("Injected benchmark 429"), { status: 429 });
          }
          return value.apply(target, args);
        };
      },
    });
    mutable.bindings = () => ({ ...original(), contentBucket: proxy });
    const latencies: number[] = [];
    const started = Date.now();
    let foregroundMs = 0;
    try {
      const invoke = async (request: (typeof requests)[number]) => {
        if (checkpoint) {
          const high = state.storage.sql
            .exec<{ seq: number }>("SELECT COALESCE(MAX(seq),0) AS seq FROM changes")
            .one().seq;
          state.storage.sql.exec(
            "INSERT INTO meta (key,value) VALUES ('monotonic_seq',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            String(high + 4095),
          );
        }
        const before = Date.now();
        const call = () =>
          instance.fetch(
            new Request(`https://db${request.path}`, { method: request.method, body: JSON.stringify(request.body) }),
          );
        let response = await call();
        if (throttle && response.status === 500) {
          await response.text();
          clientRetries++;
          await new Promise((resolve) => setTimeout(resolve, 250));
          response = await call(); // new_edits=false makes the simulated client retry idempotent.
        }
        expect(response.status).toBe(200);
        await response.text();
        latencies.push(Date.now() - before);
        peakSqliteBytes = Math.max(peakSqliteBytes, state.storage.sql.databaseSize);
      };
      if (concurrent) await Promise.all(requests.map(invoke));
      else for (const request of requests) await invoke(request);
      foregroundMs = Date.now() - started;
      const foregroundR2Operations = { ...counts };
      let alarms = 0;
      if (
        state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='checkpoint_work'").toArray()
          .length
      ) {
        while (state.storage.sql.exec("SELECT * FROM checkpoint_work").toArray().length) {
          await instance.alarm();
          peakSqliteBytes = Math.max(peakSqliteBytes, state.storage.sql.databaseSize);
          if (++alarms > 1000) throw new Error("Checkpoint did not converge");
        }
      }
      report.push({
        name,
        samples: latencies.length,
        p50Ms: quantile(latencies, 0.5),
        p95Ms: quantile(latencies, 0.95),
        foregroundMs,
        endToEndMs: Date.now() - started,
        foregroundR2Operations,
        contentR2Operations: counts,
        sqliteBytes: state.storage.sql.databaseSize,
        checkpointAlarms: alarms,
        peakSqliteBytes,
        clientRetries,
      });
    } finally {
      mutable.bindings = original;
      mutable.scheduleIndexing = scheduling;
    }
  });
}
it("reports protocol latency, end-to-end time, R2 calls and SQLite bytes on local Workers bindings", async () => {
  const normal = await fixture("normal", 1);
  const requests = Array.from({ length: 20 }, (_, i) => ({
    path: "/_bulk_docs",
    method: "POST",
    body: {
      new_edits: false,
      docs: [
        {
          _id: "note-0",
          _rev: `${i + 2}-u${i}`,
          _revisions: {
            start: i + 2,
            ids: [`u${i}`, ...(i ? Array.from({ length: i }, (_, j) => `u${i - j - 1}`) : []), "root"],
          },
          type: "plain",
          path: "folder/0.md",
          data: `updated ${i}`,
        },
      ],
    },
  }));
  await measure("normal-updates", normal, requests);
  const initial = await fixture("initial", 0);
  await measure(
    "initial-sync",
    initial,
    Array.from({ length: 8 }, (_, batch) => ({
      path: "/_bulk_docs",
      method: "POST",
      body: {
        new_edits: false,
        docs: Array.from({ length: 32 }, (_, i) => ({
          _id: `initial-${batch * 32 + i}`,
          _rev: "1-new",
          data: "first sync",
        })),
      },
    })),
  );
  await measure(
    "offline-return-hot",
    normal,
    Array.from({ length: 8 }, () => ({
      path: "/_revs_diff",
      method: "POST",
      body: { "note-0": ["1-root", ...Array.from({ length: 20 }, (_, i) => `${i + 2}-u${i}`), "22-new"] },
    })),
  );
  const concurrent = await fixture("concurrent", 0);
  await measure(
    "concurrent-writers",
    concurrent,
    Array.from({ length: 20 }, (_, i) => ({
      path: `/concurrent-${i}`,
      method: "PUT",
      body: { data: `concurrent ${i}` },
    })),
    false,
    true,
  );
  const interrupted = await fixture("interrupted", 0);
  await measure(
    "injected-head-429",
    interrupted,
    [
      {
        path: "/_bulk_docs",
        method: "POST",
        body: { new_edits: false, docs: [{ _id: "retry", _rev: "1-stable", data: "retry safely" }] },
      },
    ],
    false,
    false,
    true,
  );
  const cold = await fixture("cold", 1);
  await cold.fetch("https://db/_bulk_docs", {
    method: "POST",
    body: JSON.stringify({
      new_edits: false,
      docs: Array.from({ length: 512 }, (_, i) => ({
        _id: "note-0",
        _rev: `${i + 2}-h${i + 2}`,
        _revisions: { start: i + 2, ids: [`h${i + 2}`, i ? `h${i + 1}` : "root"] },
        data: `cold ${i}`,
      })),
    }),
  });
  await cold.fetch("https://db/_compact", { method: "POST" });
  await runInDurableObject(cold, async (instance: PersistentVaultDO, state) => {
    if (
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='checkpoint_work'").toArray()
        .length
    ) {
      for (let i = 0; state.storage.sql.exec("SELECT * FROM checkpoint_work").toArray().length; i++) {
        if (i > 1000) throw new Error("Cold fixture checkpoint did not finish");
        await instance.alarm();
      }
    }
  });
  await measure(
    "cold-archive-updates",
    cold,
    Array.from({ length: 10 }, (_, i) => ({
      path: "/_bulk_docs",
      method: "POST",
      body: {
        new_edits: false,
        docs: [
          {
            _id: "note-0",
            _rev: `${i + 514}-h${i + 514}`,
            _revisions: { start: i + 514, ids: [`h${i + 514}`, `h${i + 513}`] },
            data: `new after archive ${i}`,
          },
        ],
      },
    })),
  );
  await measure("long-offline-cold-return", cold, [
    { path: "/_changes", method: "POST", body: { since: 0, style: "all_docs" } },
    ...Array.from({ length: 8 }, () => ({
      path: "/_revs_diff",
      method: "POST",
      body: { "note-0": ["1-root", "129-h129", "257-h257", "513-h513", "524-pending"] },
    })),
  ]);
  for (const size of [128, 1024, 4096]) {
    for (let sample = 0; sample < (size === 4096 ? 3 : 5); sample++) {
      const object = await fixture(`boundary-${size}-${sample}`, size);
      await measure(
        `checkpoint-boundary-${size}`,
        object,
        [{ path: "/boundary", method: "PUT", body: { data: "durable boundary" } }],
        true,
      );
    }
  }
  console.log(
    "PERFORMANCE_JSON " +
      JSON.stringify({
        label: process.env.PERF_LABEL,
        runtime: "local workerd + real local SQLite/R2 bindings",
        syntheticContentOperationDelayMs: delayMs,
        productionLatency: false,
        results: report,
      }),
  );
});
