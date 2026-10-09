import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { R2FileMirror, fileMirrorPrefix } from "../../packages/livesync-workers/src/storage/file-mirror.js";
import { hashText } from "../../packages/livesync-workers/src/search/chunk-md.js";
import type { VaultBindings } from "../../packages/livesync-workers/src/types.js";
import { PersistentVaultDO, type TestEnv } from "./entry.js";

const bindings = env as unknown as TestEnv;
const ref = (name: string) => ({ tenantId: name, databaseName: "vault" });
const key = (name: string, path: string) => fileMirrorPrefix(ref(name)) + path;

async function fixture(name: string) {
  const object = bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName(`${name}:vault`));
  await runInDurableObject(object, async (instance: PersistentVaultDO) => enableMirror(instance));
  expect((await object.fetch("https://db/", { method: "PUT" })).status).toBe(200);
  return object;
}

function enableMirror(instance: PersistentVaultDO): void {
  const mutable = instance as unknown as { bindings(): VaultBindings };
  const original = mutable.bindings.bind(instance);
  mutable.bindings = () => ({ ...original(), fileMirror: true });
}

async function bulk(object: DurableObjectStub, docs: unknown[]) {
  const response = await object.fetch("https://db/_bulk_docs", {
    method: "POST", body: JSON.stringify({ new_edits: false, docs }),
  });
  expect(response.status).toBe(200);
  const results = await response.json<Array<{ ok?: boolean }>>();
  expect(results.every(result => result.ok)).toBe(true);
}

async function drain(object: DurableObjectStub, name: string) {
  await runInDurableObject(object, async (instance: PersistentVaultDO, state) => {
    const mirror = new R2FileMirror(state.storage, bindings.CONTENT, ref(name));
    for (let attempt = 0; attempt < 100; attempt++) {
      // Explicitly advance the mirror's persisted deadline when manually draining work.
      state.storage.sql.exec("DELETE FROM file_mirror_meta WHERE key='run_at'");
      state.storage.sql.exec("UPDATE file_mirror_state SET retry_at=0");
      await instance.alarm();
      const seq = Number(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='monotonic_seq'").toArray()[0]?.value ?? 0);
      if (!mirror.hasWork(seq)) return;
    }
    throw new Error("File mirror did not catch up: " + JSON.stringify(state.storage.sql.exec("SELECT path,status,error FROM file_mirror_state").toArray()));
  });
}

it("writes original UTF-8 paths, Markdown, hidden files and decoded binary from LiveSync and MCP", async () => {
  const name = "files-originals";
  const object = await fixture(name);
  const binary = "\0\xff\x80abc".repeat(20_000);
  const base64 = btoa(binary);
  await bulk(object, [
    { _id: "h:text", _rev: "1-a", type: "leaf", data: "日本語 😀\r\n" },
    { _id: "h:image-a", _rev: "1-a", type: "leaf", data: base64.slice(0, 70_003) },
    { _id: "h:image-b", _rev: "1-a", type: "leaf", data: base64.slice(70_003) },
    { _id: "note", _rev: "1-a", path: "資料/Note.md", type: "plain", children: ["h:text", "h:eden"], eden: { "h:eden": { data: "![pic](../Images/photo.png)\n" } }, mtime: 1234 },
    { _id: "image", _rev: "1-a", path: "Images/photo.png", type: "newnote", children: ["h:image-a", "h:image-b"], size: binary.length },
    { _id: "i:settings", _rev: "1-a", path: "i:.obsidian/settings.json", type: "plain", data: '{"test":true}' },
    { _id: "i:literal", _rev: "1-a", path: "i:i:literal.txt", type: "plain", data: "literal prefix" },
  ]);
  const op = (body: unknown) => object.fetch("https://db/internal/op", {
    method: "POST", headers: { "X-LiveSync-Internal": "integration-secret" }, body: JSON.stringify(body),
  });
  expect((await op({ op: "writeAttachment", path: "Attachments/original.pdf", content: "AAH/", expectedBaseHash: await hashText(""), contentType: "application/pdf" })).status).toBe(200);
  expect((await op({ op: "writeNote", path: "MCP.md", content: "MCP text", expectedBaseHash: await hashText("") })).status).toBe(200);
  await drain(object, name);
  const note = await bindings.CONTENT.get(key(name, "資料/Note.md"));
  expect(await note!.text()).toBe("日本語 😀\r\n![pic](../Images/photo.png)\n");
  expect(note!.httpMetadata?.contentType).toBe("text/markdown; charset=utf-8");
  expect(note!.customMetadata?.mtime).toBe("1234");
  const image = await bindings.CONTENT.get(key(name, "Images/photo.png"));
  expect(new Uint8Array(await image!.arrayBuffer())).toEqual(Uint8Array.from(binary, char => char.charCodeAt(0)));
  expect(image!.httpMetadata?.contentType).toBe("image/png");
  expect(await (await bindings.CONTENT.get(key(name, ".obsidian/settings.json")))!.text()).toBe('{"test":true}');
  expect(await (await bindings.CONTENT.get(key(name, "i:literal.txt")))!.text()).toBe("literal prefix");
  expect(new Uint8Array(await (await bindings.CONTENT.get(key(name, "Attachments/original.pdf")))!.arrayBuffer())).toEqual(new Uint8Array([0, 1, 255]));
  expect(await (await bindings.CONTENT.get(key(name, "MCP.md")))!.text()).toBe("MCP text");
  const status = await (await op({ op: "indexStatus" })).json<{ fileMirror: { saved: number; pending: number; errors: number } }>();
  expect(status.fileMirror).toMatchObject({ saved: 6, pending: 0, errors: 0 });
});

it("exports eight files in one pass despite R2 latency, then continues the backfill immediately", async () => {
  const name = "files-batch-latency";
  const object = await fixture(name);
  await bulk(object, Array.from({ length: 11 }, (_, i) => ({ _id: `note-${i}`, _rev: "1-a", path: `${i}.md`, type: "plain", data: `content ${i}` })));
  await runInDurableObject(object, async (instance: PersistentVaultDO, state) => {
    const mutable = instance as unknown as { bindings(): VaultBindings; scheduleIndexing(delay?: number): Promise<void> };
    const original = mutable.bindings.bind(instance);
    const schedule = mutable.scheduleIndexing;
    const delays: number[] = [];
    let puts = 0;
    const bucket = new Proxy(bindings.CONTENT, { get(target, property) {
      const value = Reflect.get(target, property);
      if (property !== "put") return typeof value === "function" ? value.bind(target) : value;
      return async (path: string, ...args: unknown[]) => {
        if (path.startsWith(fileMirrorPrefix(ref(name)))) {
          puts++;
          await new Promise(resolve => setTimeout(resolve, 60));
        }
        return value.apply(target, [path, ...args]);
      };
    } });
    mutable.bindings = () => ({ ...original(), contentBucket: bucket });
    mutable.scheduleIndexing = async delay => { delays.push(delay ?? 1500); };
    await state.storage.deleteAlarm();
    try {
      await instance.alarm();
      expect(puts).toBe(8);
      expect(new R2FileMirror(state.storage, bucket, ref(name)).status()).toMatchObject({ saved: 8, pending: 3 });
      expect(delays).toContain(0);
      await instance.alarm();
      expect(puts).toBe(11);
      expect(new R2FileMirror(state.storage, bucket, ref(name)).status()).toMatchObject({ saved: 11, pending: 0 });
    } finally { mutable.bindings = original; mutable.scheduleIndexing = schedule; }
  });
});

it("coalesces committed edits for five seconds without extending the deadline across DO reconstruction", async () => {
  const name = "files-change-window";
  const object = await fixture(name);
  await bulk(object, [{ _id: "note", _rev: "1-a", path: "Note.md", type: "plain", data: "old" }]);
  await drain(object, name);
  await runInDurableObject(object, async (instance: PersistentVaultDO, state) => {
    const mutable = instance as unknown as { scheduleIndexing(delay?: number): Promise<void> };
    const schedule = mutable.scheduleIndexing;
    mutable.scheduleIndexing = async () => {};
    await state.storage.deleteAlarm();
    const update = (rev: string, ids: string[], content: string) => instance.fetch(new Request("https://db/_bulk_docs", {
      method: "POST", body: JSON.stringify({ new_edits: false, docs: [{ _id: "note", _rev: rev, _revisions: { start: ids.length, ids }, path: "Note.md", type: "plain", data: content }] }),
    }));
    const deadline = () => Number(state.storage.sql.exec<{ value: string }>("SELECT value FROM file_mirror_meta WHERE key='run_at'").one().value);
    try {
      const started = Date.now();
      expect((await update("2-b", ["b", "a"], "intermediate")).status).toBe(200);
      const firstDeadline = deadline();
      expect(firstDeadline).toBeGreaterThanOrEqual(started + 5000);
      expect(firstDeadline).toBeLessThanOrEqual(Date.now() + 5000);
      expect((await update("3-c", ["c", "b", "a"], "latest")).status).toBe(200);
      expect(deadline()).toBe(firstDeadline);

      const fresh = new PersistentVaultDO(state, bindings);
      enableMirror(fresh);
      const delays: number[] = [];
      (fresh as unknown as { scheduleIndexing(delay?: number): Promise<void> }).scheduleIndexing = async delay => { delays.push(delay ?? 1500); };
      expect(await (await fresh.fetch(new Request("https://db/note"))).json()).toMatchObject({ data: "latest" });
      expect(deadline()).toBe(firstDeadline);
      await fresh.alarm();
      expect(await (await bindings.CONTENT.get(key(name, "Note.md")))!.text()).toBe("old");
      expect(delays.some(delay => delay > 0 && delay <= 5000)).toBe(true);

      state.storage.sql.exec("UPDATE file_mirror_meta SET value=? WHERE key='run_at'", String(Date.now() - 1));
      await fresh.alarm();
      expect(await (await bindings.CONTENT.get(key(name, "Note.md")))!.text()).toBe("latest");
      expect(state.storage.sql.exec("SELECT 1 FROM file_mirror_meta WHERE key='run_at'").toArray()).toHaveLength(0);
    } finally { mutable.scheduleIndexing = schedule; }
  });
});

it.each(["work", "batch", "alarm"])("honors a future mirror retry deadline for %s", async check => {
  const name = `files-retry-deadline-${check}`;
  const object = await fixture(name);
  await bulk(object, [
    { _id: "note", _rev: "1-a", path: "Note.txt", type: "plain", data: "old" },
    { _id: "retry", _rev: "1-a", path: "Retry.txt", type: "plain", data: "last complete copy" },
  ]);
  await drain(object, name);
  await runInDurableObject(object, async (instance: PersistentVaultDO, state) => {
    const retryAt = Date.now() + 10 * 60_000;
    state.storage.sql.exec("UPDATE file_mirror_state SET status='retry',retry_at=?,error='Injected R2 failure' WHERE path='Retry.txt'", retryAt);
    const mirror = new R2FileMirror(state.storage, bindings.CONTENT, ref(name));
    const seq = Number(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='monotonic_seq'").one().value);
    if (check === "work") {
      expect(mirror.hasWork(seq)).toBe(false);
      state.storage.sql.exec("UPDATE file_mirror_state SET retry_at=0 WHERE path='Retry.txt'");
      expect(mirror.hasWork(seq)).toBe(true);
      return;
    }
    if (check === "batch") {
      const mutable = instance as unknown as { scheduleIndexing(delay?: number): Promise<void> };
      const schedule = mutable.scheduleIndexing;
      mutable.scheduleIndexing = async () => {};
      try {
        const started = Date.now();
        const response = await instance.fetch(new Request("https://db/_bulk_docs", { method: "POST", body: JSON.stringify({
          new_edits: false, docs: [{ _id: "note", _rev: "2-b", _revisions: { start: 2, ids: ["b", "a"] }, path: "Note.txt", type: "plain", data: "latest" }],
        }) }));
        expect(response.status).toBe(200);
        const deadline = state.storage.sql.exec<{ value: string }>("SELECT value FROM file_mirror_meta WHERE key='run_at'").toArray()[0];
        expect(deadline).toBeDefined();
        expect(Number(deadline!.value)).toBeGreaterThanOrEqual(started + 5000);
        expect(Number(deadline!.value)).toBeLessThanOrEqual(Date.now() + 5000);
        expect(await (await bindings.CONTENT.get(key(name, "Note.txt")))!.text()).toBe("old");
      } finally { mutable.scheduleIndexing = schedule; }
      return;
    }
    await state.storage.setAlarm(retryAt);
    const fresh = new PersistentVaultDO(state, bindings);
    enableMirror(fresh);
    expect((await fresh.fetch(new Request("https://db/note"))).status).toBe(200);
    expect(await state.storage.getAlarm()).toBe(retryAt);
    await fresh.alarm();
    expect(await state.storage.getAlarm()).toBe(retryAt);
  });
});

it.each([false, true])("bounds decoded and attempted upload bytes per pass, including failures: %s", async fail => {
  const name = `files-batch-bytes-${fail}`;
  const object = await fixture(name);
  await bulk(object, Array.from({ length: 3 }, (_, i) => ({ _id: `note-${i}`, _rev: "1-a", path: `${i}.md`, type: "plain", data: "small source" })));
  await runInDurableObject(object, async (_instance: PersistentVaultDO, state) => {
    await state.storage.deleteAlarm();
    let failPut = fail, attemptedBytes = 0;
    const bucket = new Proxy(bindings.CONTENT, { get(target, property) {
      const method = Reflect.get(target, property);
      if (property === "put") return async (path: string, value: Uint8Array, options: R2PutOptions) => {
        attemptedBytes += value.byteLength;
        if (failPut && path.endsWith("/0.md")) throw new Error("Injected failed bounded PUT");
        return target.put(path, value, options);
      };
      return typeof method === "function" ? method.bind(target) : method;
    } });
    const mirror = new R2FileMirror(state.storage, bucket, ref(name));
    const data = "x".repeat(7 * 1024 * 1024);
    const root = { id: "fake", rev: "1-a", r2: null, envelope: false, eden: null, childId: null, childRev: null };
    const reader = {
      snapshot: async (path: string) => ({ docId: `note-${path[0]}`, rev: "1-a", root, type: "plain" as const,
        contentType: "text/plain", declaredSize: data.length, mtime: null, fingerprint: path, sources: [root], small: true }),
      read: async () => [data], current: async () => true,
    };
    const exclusive = <T>(operation: () => Promise<T>) => operation();
    expect(await mirror.run(reader, exclusive)).toMatchObject({ more: true });
    const first = mirror.status();
    expect(first.saved).toBeGreaterThanOrEqual(fail ? 0 : 1);
    expect(first.saved).toBeLessThan(3);
    // Two complete files plus at most 2 MiB of the third fit in the 16 MiB budget.
    const tail = state.storage.sql.exec<{ n: number }>("SELECT COALESCE(SUM(length(data)),0) AS n FROM file_mirror_tail").one().n;
    expect(first.saved * data.length + tail).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(attemptedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    failPut = false;
    for (let attempt = 0; attempt < 3 && mirror.status().pending; attempt++) {
      state.storage.sql.exec("UPDATE file_mirror_state SET retry_at=0");
      attemptedBytes = 0;
      await mirror.run(reader, exclusive);
      expect(attemptedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    }
    expect(mirror.status()).toMatchObject({ saved: 3, pending: 0 });
  });
});

it("follows the current winner, path changes, soft deletion and tombstones", async () => {
  const name = "files-edits";
  const object = await fixture(name);
  await bulk(object, [{ _id: "note", _rev: "1-a", path: "Old.md", type: "plain", data: "old" }]);
  await drain(object, name);
  await bulk(object, [{ _id: "note", _rev: "2-b", _revisions: { start: 2, ids: ["b", "a"] }, path: "New.md", type: "plain", data: "new" }]);
  await drain(object, name);
  expect(await bindings.CONTENT.get(key(name, "Old.md"))).toBeNull();
  expect(await (await bindings.CONTENT.get(key(name, "New.md")))!.text()).toBe("new");
  await bulk(object, [{ _id: "note", _rev: "2-c", _revisions: { start: 2, ids: ["c", "a"] }, path: "New.md", type: "plain", data: "winning conflict" }]);
  await drain(object, name);
  expect(await (await bindings.CONTENT.get(key(name, "New.md")))!.text()).toBe("winning conflict");
  await bulk(object, [{ _id: "note", _rev: "3-d", _revisions: { start: 3, ids: ["d", "c", "a"] }, path: "New.md", type: "plain", deleted: true }]);
  await drain(object, name);
  expect(await bindings.CONTENT.get(key(name, "New.md"))).toBeNull();
  await bulk(object, [{ _id: "note", _rev: "4-e", _revisions: { start: 4, ids: ["e", "d", "c", "a"] }, _deleted: true }]);
  await drain(object, name);
  // Deleting one conflict branch can reveal another live winner.
  expect(await (await bindings.CONTENT.get(key(name, "New.md")))!.text()).toBe("new");
  await bulk(object, [{ _id: "note", _rev: "3-f", _revisions: { start: 3, ids: ["f", "b", "a"] }, _deleted: true }]);
  await drain(object, name);
  expect(await bindings.CONTENT.get(key(name, "New.md"))).toBeNull();
});

it("waits for missing chunks and resumes every pending file when a chunk arrives", async () => {
  const name = "files-chunks";
  const object = await fixture(name);
  await bulk(object, Array.from({ length: 24 }, (_, i) => ({ _id: `note-${i}`, _rev: "1-a", path: `${i}.md`, type: "plain", children: ["h:later"] })));
  await drain(object, name);
  expect((await bindings.CONTENT.list({ prefix: fileMirrorPrefix(ref(name)) })).objects).toHaveLength(0);
  await runInDurableObject(object, async (_instance, state) => {
    expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM file_mirror_state WHERE status='waiting'").one().n).toBe(24);
  });
  await bulk(object, [{ _id: "h:later", _rev: "1-a", type: "leaf", data: "complete" }]);
  await drain(object, name);
  expect((await bindings.CONTENT.list({ prefix: fileMirrorPrefix(ref(name)) })).objects).toHaveLength(24);
  expect(await (await bindings.CONTENT.get(key(name, "23.md")))!.text()).toBe("complete");
});

it("updates a copied file when only its child revision changes", async () => {
  const name = "files-child-winner";
  const object = await fixture(name);
  await bulk(object, [
    { _id: "h:child", _rev: "1-a", type: "leaf", data: "old child" },
    { _id: "note", _rev: "1-a", path: "Note.md", type: "plain", children: ["h:child"] },
  ]);
  await drain(object, name);
  const previous = (await bindings.CONTENT.head(key(name, "Note.md")))!.customMetadata!.sourceFingerprint;
  await bulk(object, [{ _id: "h:child", _rev: "2-b", _revisions: { start: 2, ids: ["b", "a"] }, type: "leaf", data: "new child" }]);
  await drain(object, name);
  const output = (await bindings.CONTENT.get(key(name, "Note.md")))!;
  expect(await output.text()).toBe("new child");
  expect(output.customMetadata!.sourceFingerprint).not.toBe(previous);
  expect(output.customMetadata!.sourceRev).toBe("1-a");
});

it("backfills existing documents and repairs stale copies after SQLite cache loss", async () => {
  const name = "files-recovery";
  const object = await fixture(name);
  await bulk(object, [{ _id: "note", _rev: "1-a", path: "Restored.md", type: "plain", data: "original" }]);
  await drain(object, name);
  await bindings.CONTENT.delete(key(name, "Restored.md"));
  await bindings.CONTENT.put(key(name, "Deleted.md"), "stale deleted file");
  await bindings.CONTENT.put(key(name, "i:Deleted.md"), "stale file with a literal prefix");
  await runInDurableObject(object, async (_instance, state) => {
    for (const table of ["docs", "revs", "rev_metadata", "local_docs", "changes", "rev_body_chunks", "meta", "index_state", "file_mirror_state", "file_mirror_meta"]) state.storage.sql.exec(`DELETE FROM ${table}`);
    const fresh = new PersistentVaultDO(state, bindings);
    enableMirror(fresh);
    expect((await fresh.fetch(new Request("https://db/"))).status).toBe(200);
  });
  await drain(object, name);
  expect(await (await bindings.CONTENT.get(key(name, "Restored.md")))!.text()).toBe("original");
  expect(await bindings.CONTENT.get(key(name, "Deleted.md"))).toBeNull();
  expect(await bindings.CONTENT.get(key(name, "i:Deleted.md"))).toBeNull();
  expect((await object.fetch("https://db/note")).status).toBe(200);
});

it("pages through existing files and supports an authenticated rebuild of manually removed copies", async () => {
  const name = "files-backfill";
  const object = await fixture(name);
  await bulk(object, Array.from({ length: 70 }, (_, i) => ({ _id: `note-${i}`, _rev: "1-a", path: `${i}.md`, type: "plain", data: `original ${i}` })));
  for (let i = 0; i < 40; i++) await bindings.CONTENT.put(key(name, `stale-${i}.md`), "stale");
  await drain(object, name);
  expect((await bindings.CONTENT.list({ prefix: fileMirrorPrefix(ref(name)) })).objects).toHaveLength(70);
  await bindings.CONTENT.delete(key(name, "0.md"));
  await bindings.CONTENT.put(key(name, "1.md"), "manually overwritten");
  const rebuild = (secret?: string) => object.fetch("https://db/internal/op", {
    method: "POST", headers: secret ? { "X-LiveSync-Internal": secret } : {}, body: '{"op":"filesRebuild"}',
  });
  expect((await rebuild()).status).toBe(403);
  expect((await rebuild("integration-secret")).status).toBe(200);
  await drain(object, name);
  expect(await (await bindings.CONTENT.get(key(name, "0.md")))!.text()).toBe("original 0");
  expect(await (await bindings.CONTENT.get(key(name, "1.md")))!.text()).toBe("original 1");
});

it("retries failed copies without blocking replication, and catches edits during an upload", async () => {
  const name = "files-concurrent";
  const object = await fixture(name);
  await bulk(object, [{ _id: "h:large", _rev: "1-a", type: "leaf", data: "x".repeat(1024 * 1024) }, { _id: "note", _rev: "1-a", path: "Note.md", type: "plain", children: Array(10).fill("h:large") }]);
  await runInDurableObject(object, async (instance: PersistentVaultDO, state) => {
    const mutable = instance as unknown as { bindings(): VaultBindings };
    const original = mutable.bindings.bind(instance);
    let mode: "fail" | "hold" | "pass" = "fail";
    let entered!: () => void, release!: () => void;
    const uploading = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const bucket = new Proxy(bindings.CONTENT, { get(target, property) {
      const value = Reflect.get(target, property);
      if (property !== "resumeMultipartUpload") return typeof value === "function" ? value.bind(target) : value;
      return (path: string, uploadId: string) => {
        const upload = target.resumeMultipartUpload(path, uploadId);
        return new Proxy(upload, { get(partTarget, partProperty) {
          const method = Reflect.get(partTarget, partProperty);
          if (partProperty !== "uploadPart") return typeof method === "function" ? method.bind(partTarget) : method;
          return async (...args: unknown[]) => {
            if (mode === "fail") throw new Error("Injected file copy failure");
            if (mode === "hold") { mode = "pass"; entered(); await blocked; }
            return method.apply(partTarget, args);
          };
        } });
      };
    } });
    mutable.bindings = () => ({ ...original(), contentBucket: bucket });
    try {
      await instance.alarm();
      expect(state.storage.sql.exec<{ status: string }>("SELECT status FROM file_mirror_state WHERE path='Note.md'").one().status).toBe("retry");
      expect((await instance.fetch(new Request("https://db/note"))).status).toBe(200);
      mode = "hold";
      state.storage.sql.exec("UPDATE file_mirror_state SET retry_at=0");
      const alarm = instance.alarm();
      try {
        await uploading;
        const write = instance.fetch(new Request("https://db/_bulk_docs", {
          method: "POST", body: JSON.stringify({ new_edits: false, docs: [{ _id: "note", _rev: "2-b", _revisions: { start: 2, ids: ["b", "a"] }, path: "Note.md", type: "plain", data: "latest" }] }),
        }));
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const response = await Promise.race([write, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Replication blocked behind a file upload")), 1000);
          })]);
          expect(response.status).toBe(200);
        } finally { clearTimeout(timer); }
      } finally { release(); await alarm; }
    } finally { mutable.bindings = original; }
  });
  await drain(object, name);
  expect(await (await bindings.CONTENT.get(key(name, "Note.md")))!.text()).toBe("latest");
});

it("waits for an in-flight mirror upload before internal purge removes the vault", async () => {
  const name = "files-internal-purge";
  const object = await fixture(name);
  await bulk(object, [{ _id: "note", _rev: "1-a", path: "Note.md", type: "plain", data: "original" }]);
  await runInDurableObject(object, async (instance: PersistentVaultDO, state) => {
    const mutable = instance as unknown as { bindings(): VaultBindings; scheduleIndexing(delay?: number): Promise<void> };
    const original = mutable.bindings.bind(instance);
    const schedule = mutable.scheduleIndexing;
    let entered!: () => void, release!: () => void;
    const uploading = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let uploadPending = false;
    let listedDuringUpload = false;
    const bucket = new Proxy(bindings.CONTENT, { get(target, property) {
      const value = Reflect.get(target, property);
      if (property === "list") return (options?: R2ListOptions) => {
        if (uploadPending && options?.prefix === fileMirrorPrefix(ref(name))) listedDuringUpload = true;
        return target.list(options);
      };
      if (property !== "put") return typeof value === "function" ? value.bind(target) : value;
      return async (path: string, ...args: unknown[]) => {
        if (path.startsWith(fileMirrorPrefix(ref(name)))) {
          uploadPending = true;
          entered();
          await blocked;
          const result = await value.apply(target, [path, ...args]);
          uploadPending = false;
          return result;
        }
        return value.apply(target, [path, ...args]);
      };
    } });
    mutable.bindings = () => ({ ...original(), contentBucket: bucket });
    // Keep the race under explicit control; no subsequent alarm should remove a stray copy.
    mutable.scheduleIndexing = async () => {};
    await state.storage.deleteAlarm();
    let purge: Promise<Response> | undefined;
    const alarm = instance.alarm();
    try {
      await uploading;
      purge = instance.fetch(new Request("https://db/internal/purge", {
        method: "POST", headers: { "X-LiveSync-Internal": "integration-secret" },
      }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const finished = await Promise.race([purge.then(() => true), new Promise<boolean>(resolve => {
          timer = setTimeout(() => resolve(false), 100);
        })]);
        expect(finished).toBe(false);
        expect(listedDuringUpload).toBe(false);
      } finally { clearTimeout(timer); }
    } finally {
      release();
      try { await alarm; if (purge) expect((await purge).status).toBe(200); }
      finally { mutable.bindings = original; mutable.scheduleIndexing = schedule; }
    }
    expect((await bindings.CONTENT.list({ prefix: fileMirrorPrefix(ref(name)) })).objects).toHaveLength(0);
    expect((await instance.fetch(new Request("https://db/", { method: "HEAD" }))).status).toBe(404);
  });
});

it("keeps unsupported content out of file copies and confines writes and purge to one vault", async () => {
  const name = "files-safety";
  const object = await fixture(name);
  const other = await fixture("files-other");
  await bulk(other, [{ _id: "note", _rev: "1-a", path: "Note.md", type: "plain", data: "other vault" }]);
  await bulk(object, [
    { _id: "note", _rev: "1-a", path: "Note.md", type: "plain", data: "this vault" },
    { _id: "encrypted", _rev: "1-a", path: "Encrypted.md", type: "plain", children: ["h:encrypted"] },
    { _id: "h:encrypted", _rev: "1-a", type: "leaf", e_: true, data: "%ciphertext" },
    { _id: "compressed", _rev: "1-a", path: "Compressed.md", type: "plain", data: "\u000eLZ\u001dcompressed" },
    { _id: "invalid", _rev: "1-a", path: "../escape.md", type: "plain", data: "invalid" },
    { _id: "oversized", _rev: "1-a", path: "Huge.md", type: "plain", data: "small", size: 100 * 1024 * 1024 + 1 },
    { _id: "h:repeated", _rev: "1-a", type: "leaf", data: "AAAA".repeat(256) },
    { _id: "repeated", _rev: "1-a", path: "Repeated.png", type: "newnote", children: Array.from({ length: 15_000 }, () => "h:repeated"), size: 1 },
  ]);
  await drain(object, name);
  await drain(other, "files-other");
  expect((await bindings.CONTENT.list({ prefix: fileMirrorPrefix(ref(name)) })).objects.map(object => object.key)).toEqual([key(name, "Note.md")]);
  await runInDurableObject(object, async (_instance, state) => {
    expect(new R2FileMirror(state.storage, bindings.CONTENT, ref(name)).status()).toMatchObject({ saved: 1, errors: 5 });
  });
  expect((await object.fetch("https://db/", { method: "DELETE" })).status).toBe(200);
  expect((await bindings.CONTENT.list({ prefix: fileMirrorPrefix(ref(name)) })).objects).toHaveLength(0);
  expect(await (await bindings.CONTENT.get(key("files-other", "Note.md")))!.text()).toBe("other vault");
});
