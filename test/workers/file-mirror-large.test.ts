import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { R2FileMirror, fileMirrorPrefix } from "../../packages/livesync-workers/src/storage/file-mirror.js";
import { hex } from "../../packages/livesync-workers/src/storage/file-mirror-hash.js";
import type { MirrorReader } from "../../packages/livesync-workers/src/storage/file-mirror-upload.js";
import type { VaultBindings } from "../../packages/livesync-workers/src/types.js";
import { PersistentVaultDO, type TestEnv } from "./entry.js";

const bindings = env as unknown as TestEnv;
const MiB = 1024 * 1024;
const chunkBytes = 3 * 256 * 1024;
const ref = (name: string) => ({ tenantId: name, databaseName: "vault" });
const key = (name: string) => fileMirrorPrefix(ref(name)) + "Attachments/Large.pdf";

async function fixture(name: string, size: number, declared = size) {
  const object = bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName(`${name}:vault`));
  await runInDurableObject(object, (instance: PersistentVaultDO) => {
    const mutable = instance as unknown as { bindings(): VaultBindings; scheduleIndexing(): Promise<void> };
    const original = mutable.bindings.bind(instance);
    mutable.bindings = () => ({ ...original(), fileMirror: true });
    mutable.scheduleIndexing = async () => {};
  });
  expect((await object.fetch("https://db/", { method: "PUT" })).status).toBe(200);
  const repeated = Math.floor(size / chunkBytes), remainder = size % chunkBytes;
  const docs: unknown[] = [
    { _id: "h:large", _rev: "1-a", type: "leaf", data: btoa("\x7f".repeat(chunkBytes)) },
    { _id: "h:tail", _rev: "1-a", type: "leaf", data: btoa("\x7f".repeat(remainder)) },
    { _id: "pdf", _rev: "1-a", path: "Attachments/Large.pdf", type: "newnote", size: declared,
      children: [...Array<string>(repeated).fill("h:large"), ...(remainder ? ["h:tail"] : [])] },
  ];
  const response = await object.fetch("https://db/_bulk_docs", { method: "POST", body: JSON.stringify({ new_edits: false, docs }) });
  expect(response.status).toBe(200);
  expect((await response.json<Array<{ ok: boolean }>>()).every(row => row.ok)).toBe(true);
  return object;
}

function reader(instance: PersistentVaultDO): MirrorReader {
  return (instance as unknown as { mirrorReader(): MirrorReader }).mirrorReader();
}
async function pass(instance: PersistentVaultDO, state: DurableObjectState, name: string, bucket = bindings.CONTENT) {
  state.storage.sql.exec("DELETE FROM file_mirror_meta WHERE key='run_at'");
  const mirror = new R2FileMirror(state.storage, bucket, ref(name));
  await mirror.run(reader(instance), operation => operation());
  return mirror;
}
async function drain(object: DurableObjectStub, name: string) {
  await runInDurableObject(object, async (instance: PersistentVaultDO, state) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const mirror = await pass(instance, state, name);
      if (mirror.status().pending === 0 && !mirror.status().rebuilding) {
        expect(mirror.status().errors).toBe(0);
        return;
      }
    }
    const errors = JSON.stringify(state.storage.sql.exec("SELECT path,status,error FROM file_mirror_state").toArray());
    console.error(errors);
    throw new Error(errors);
  });
}

async function streamDigest(stream: ReadableStream<Uint8Array>) {
  const digest = new crypto.DigestStream("SHA-256");
  await stream.pipeTo(digest);
  return hex(new Uint8Array(await digest.digest));
}
async function expectedDigest(size: number) {
  let remaining = size;
  return streamDigest(new ReadableStream<Uint8Array>({ pull(controller) {
    if (!remaining) return controller.close();
    const count = Math.min(64 * 1024, remaining);
    controller.enqueue(new Uint8Array(count).fill(127)); remaining -= count;
  } }));
}

it.each([0, MiB, 8 * MiB, 8 * MiB + 1, 10 * MiB + 1, 20 * MiB, 50 * MiB, 100 * MiB])(
  "exports %i bytes with exact streamed SHA-256 and no complete-file staging", async size => {
    const name = `large-boundary-${size}`;
    const object = await fixture(name, size);
    let partCalls = 0, creates = 0, completes = 0;
    const bucket = new Proxy(bindings.CONTENT, { get(target, property) {
      if (property === "createMultipartUpload") return (...args: Parameters<R2Bucket["createMultipartUpload"]>) => { creates++; return target.createMultipartUpload(...args); };
      if (property === "resumeMultipartUpload") return (path: string, uploadId: string) => {
        const upload = target.resumeMultipartUpload(path, uploadId);
        return new Proxy(upload, { get(partTarget, partProperty) {
          if (partProperty === "uploadPart") return (...args: Parameters<R2MultipartUpload["uploadPart"]>) => { partCalls++; return partTarget.uploadPart(...args); };
          if (partProperty === "complete") return (...args: Parameters<R2MultipartUpload["complete"]>) => { completes++; return partTarget.complete(...args); };
          const method = Reflect.get(partTarget, partProperty);
          return typeof method === "function" ? method.bind(partTarget) : method;
        } });
      };
      const method = Reflect.get(target, property);
      return typeof method === "function" ? method.bind(target) : method;
    } });
    await runInDurableObject(object, async (instance: PersistentVaultDO, state) => {
      for (let i = 0; i < 100; i++) {
        const before = partCalls;
        const mirror = await pass(instance, state, name, bucket);
        expect(partCalls - before).toBeLessThanOrEqual(2);
        expect(state.storage.sql.exec<{ n: number }>("SELECT COALESCE(SUM(length(data)),0) AS n FROM file_mirror_tail").one().n).toBe(0);
        if (!mirror.status().pending && !mirror.status().rebuilding) break;
      }
    });
    expect(partCalls).toBe(size <= 8 * MiB ? 0 : Math.ceil(size / (8 * MiB)));
    expect(creates).toBe(size <= 8 * MiB ? 0 : 1);
    expect(completes).toBe(size <= 8 * MiB ? 0 : 1);
    const output = await bindings.CONTENT.get(key(name));
    expect(output?.size).toBe(size);
    expect(output?.httpMetadata?.contentType).toBe("application/pdf");
    const digest = await streamDigest(output!.body);
    expect(digest).toBe(await expectedDigest(size));
    expect(output!.customMetadata?.mirrorFormat).toBe("2");
    if (size <= 8 * MiB) expect(output!.customMetadata?.contentHash).toBe(digest);
    else expect(output!.customMetadata?.contentHash).toBeUndefined();
    await runInDurableObject(object, (_instance, state) => {
      expect(state.storage.sql.exec<{ hash: string }>("SELECT hash FROM file_mirror_digests").one().hash).toBe(digest);
      expect(state.storage.sql.exec("SELECT 1 FROM file_mirror_tail").toArray()).toHaveLength(0);
      expect(state.storage.sql.exec("SELECT 1 FROM file_mirror_jobs").toArray()).toHaveLength(0);
    });
    expect((await bindings.CONTENT.list({ prefix: fileMirrorPrefix(ref(name)) })).objects).toHaveLength(1);
  }, 60_000);

it.each([100 * MiB + 1, 20 * MiB])("keeps the previous copy when actual size %i is above the limit or mismatched", async size => {
  const name = `large-invalid-${size}`;
  const object = await fixture(name, size, size > 100 * MiB ? 100 * MiB : 1);
  await bindings.CONTENT.put(key(name), "previous complete copy");
  await runInDurableObject(object, async (instance: PersistentVaultDO, state) => {
    for (let i = 0; i < 100; i++) {
      const mirror = await pass(instance, state, name);
      if (mirror.status().errors) break;
    }
    const row = state.storage.sql.exec<{ status: string; error: string }>("SELECT status,error FROM file_mirror_state").one();
    expect(row.status).toBe("blocked");
    expect(row.error).toContain(size > 100 * MiB ? "FILE_TOO_LARGE" : "SIZE_MISMATCH");
    expect(state.storage.sql.exec("SELECT 1 FROM file_mirror_jobs").toArray()).toHaveLength(0);
    await pass(instance, state, name);
    expect(state.storage.sql.exec("SELECT 1 FROM file_mirror_abandoned").toArray()).toHaveLength(0);
  });
  expect(await (await bindings.CONTENT.get(key(name)))!.text()).toBe("previous complete copy");
}, 60_000);

it("resumes after a lost part acknowledgement and a lost complete acknowledgement across reconstruction", async () => {
  const name = "large-lost-ack";
  const object = await fixture(name, 20 * MiB);
  let losePart = true, loseComplete = true;
  const uploaded: number[] = [];
  const bucket = new Proxy(bindings.CONTENT, { get(target, property) {
    if (property === "resumeMultipartUpload") return (path: string, uploadId: string) => {
      const upload = target.resumeMultipartUpload(path, uploadId);
      return new Proxy(upload, { get(partTarget, partProperty) {
        if (partProperty === "uploadPart") return async (number: number, value: Parameters<R2MultipartUpload["uploadPart"]>[1]) => {
          uploaded.push(number);
          const result = await partTarget.uploadPart(number, value);
          if (losePart) { losePart = false; throw new Error("Lost part acknowledgement"); }
          return result;
        };
        if (partProperty === "complete") return async (parts: R2UploadedPart[]) => {
          const result = await partTarget.complete(parts);
          if (loseComplete) { loseComplete = false; throw new Error("Lost complete acknowledgement"); }
          return result;
        };
        const method = Reflect.get(partTarget, partProperty);
        return typeof method === "function" ? method.bind(partTarget) : method;
      } });
    };
    const method = Reflect.get(target, property);
    return typeof method === "function" ? method.bind(target) : method;
  } });
  await runInDurableObject(object, async (instance: PersistentVaultDO, state) => {
    await pass(instance, state, name, bucket);
    expect(state.storage.sql.exec<{ n: number }>("SELECT SUM(length(data)) AS n FROM file_mirror_tail").one().n).toBe(8 * MiB);
    expect(state.storage.sql.exec<{ n: number }>("SELECT MAX(length(data)) AS n FROM file_mirror_tail").one().n).toBeLessThanOrEqual(MiB);
    // These byte rows never reach the canonical commit journal.
    const head = await bindings.CONTENT.get(`content/v1/${name}/vault/head.json`);
    expect(head).not.toBeNull();
    const manifest = await head!.json<{ commit: string }>();
    const commit = await (await bindings.CONTENT.get(manifest.commit))!.text();
    expect(commit).not.toContain("file_mirror_");
    expect(state.storage.sql.exec("SELECT 1 FROM checkpoint_dirty WHERE table_name LIKE 'file_mirror_%'").toArray()).toHaveLength(0);
    const fresh = new PersistentVaultDO(state, bindings);
    await fresh.fetch(new Request("https://db/"));
    for (let i = 0; i < 10; i++) {
      state.storage.sql.exec("UPDATE file_mirror_state SET retry_at=0");
      const mirror = await pass(fresh, state, name, bucket);
      if (!mirror.status().pending) break;
    }
    expect(new R2FileMirror(state.storage, bucket, ref(name)).status()).toMatchObject({ saved: 1, pending: 0 });
    expect(uploaded).toEqual([1, 1, 2, 3]);
    expect(state.storage.sql.exec("SELECT 1 FROM file_mirror_tail").toArray()).toHaveLength(0);
  });
  expect(await streamDigest((await bindings.CONTENT.get(key(name)))!.body)).toBe(await expectedDigest(20 * MiB));
});

it("bounds R2 calls, caches only an unfinished part, and lets a small change overtake a large job", async () => {
  const name = "large-budget";
  const object = await fixture(name, 20 * MiB);
  const bytes = 96 * 1024;
  const children = Array.from({ length: 100 }, (_, i) => `h:distinct-${i}`);
  const response = await object.fetch("https://db/_bulk_docs", { method: "POST", body: JSON.stringify({ new_edits: false, docs: [
    ...children.map((_id, i) => ({ _id, _rev: "1-a", type: "leaf", data: btoa(String.fromCharCode(i) + "\x7f".repeat(bytes - 1)) })),
    { _id: "pdf", _rev: "2-b", _revisions: { start: 2, ids: ["b", "a"] }, path: "Attachments/Large.pdf", type: "newnote", size: children.length * bytes, children },
    { _id: "a-small", _rev: "1-a", path: "Note.md", type: "plain", data: "latest small change" },
  ] }) });
  expect(response.status).toBe(200);
  let calls = 0;
  const publications: string[] = [];
  const bucket = new Proxy(bindings.CONTENT, { get(target, property) {
    const method = Reflect.get(target, property);
    if (property === "resumeMultipartUpload") return (path: string, uploadId: string) => {
      const upload = target.resumeMultipartUpload(path, uploadId);
      return new Proxy(upload, { get(partTarget, partProperty) {
        const partMethod = Reflect.get(partTarget, partProperty);
        return typeof partMethod !== "function" ? partMethod : (...args: unknown[]) => {
          calls++;
          if (partProperty === "complete") publications.push("large");
          return partMethod.apply(partTarget, args);
        };
      } });
    };
    if (["get", "head", "list", "put", "delete", "createMultipartUpload"].includes(String(property))) return (...args: unknown[]) => {
      calls++;
      if (property === "put" && args[0] === fileMirrorPrefix(ref(name)) + "Note.md") publications.push("small");
      return method.apply(target, args);
    };
    return typeof method === "function" ? method.bind(target) : method;
  } });
  await runInDurableObject(object, async (instance: PersistentVaultDO, state) => {
    const mutable = instance as unknown as { bindings(): VaultBindings };
    const original = mutable.bindings.bind(instance);
    mutable.bindings = () => ({ ...original(), contentBucket: bucket });
    try {
      let yielded = false;
      for (let i = 0; i < 10; i++) {
        calls = 0;
        await pass(instance, state, name, bucket);
        expect(calls).toBeLessThanOrEqual(64);
        const tail = state.storage.sql.exec<{ n: number }>("SELECT COALESCE(SUM(length(data)),0) AS n FROM file_mirror_tail").one().n;
        expect(tail).toBeLessThanOrEqual(8 * MiB);
        if (tail) { yielded = true; break; }
      }
      expect(yielded).toBe(true);
      expect(await bindings.CONTENT.head(key(name))).toBeNull();
      expect(state.storage.sql.exec<{ n: number }>("SELECT MAX(length(data)) AS n FROM file_mirror_tail").one().n).toBeLessThanOrEqual(MiB);
      expect(new R2FileMirror(state.storage, bucket, ref(name)).uploader.roots().length).toBeGreaterThan(0);
      calls = 0;
      await pass(instance, state, name, bucket);
      expect(calls).toBeLessThanOrEqual(64);
      expect(publications[0]).toBe("small");
      expect(await (await bindings.CONTENT.get(fileMirrorPrefix(ref(name)) + "Note.md"))!.text()).toBe("latest small change");
    } finally { mutable.bindings = original; }
  });
  await drain(object, name);
  expect((await bindings.CONTENT.head(key(name)))!.size).toBe(children.length * bytes);
});

it("requeues the previous size limit and restarts incompatible hash checkpoints", async () => {
  const name = "large-upgrade";
  const object = await fixture(name, 20 * MiB);
  await runInDurableObject(object, async (instance: PersistentVaultDO, state) => {
    state.storage.sql.exec("INSERT INTO file_mirror_state(path,doc_id,status,error) VALUES (?,'pdf','blocked','Error: File exceeds the 10 MiB mirror limit')", "Attachments/Large.pdf");
    await pass(instance, state, name);
    expect(state.storage.sql.exec<{ status: string }>("SELECT status FROM file_mirror_state").one().status).toBe("queued");
    const saved = state.storage.sql.exec<{ state: string }>("SELECT state FROM file_mirror_jobs").one().state;
    state.storage.sql.exec("UPDATE file_mirror_jobs SET state=json_set(state,'$.version','incompatible-test-version')");
    await pass(instance, state, name);
    const restarted = state.storage.sql.exec<{ state: string }>("SELECT state FROM file_mirror_jobs").one().state;
    expect(JSON.parse(restarted).id).not.toBe(JSON.parse(saved).id);
  });
  await drain(object, name);
  expect(await streamDigest((await bindings.CONTENT.get(key(name)))!.body)).toBe(await expectedDigest(20 * MiB));
});

it("does not resurrect job state when recovery resets the epoch during a part upload", async () => {
  const name = "large-epoch-reset";
  const object = await fixture(name, 20 * MiB);
  await bindings.CONTENT.put(key(name), "previous");
  await runInDurableObject(object, async (instance: PersistentVaultDO, state) => {
    let reset = false;
    const bucket = new Proxy(bindings.CONTENT, { get(target, property) {
      if (property === "resumeMultipartUpload") return (path: string, uploadId: string) => {
        const upload = target.resumeMultipartUpload(path, uploadId);
        return new Proxy(upload, { get(partTarget, partProperty) {
          if (partProperty === "uploadPart") return async (...args: Parameters<R2MultipartUpload["uploadPart"]>) => {
            const result = await partTarget.uploadPart(...args);
            if (!reset) { reset = true; new R2FileMirror(state.storage, target, ref(name)).reset(); }
            return result;
          };
          const method = Reflect.get(partTarget, partProperty);
          return typeof method === "function" ? method.bind(partTarget) : method;
        } });
      };
      const method = Reflect.get(target, property);
      return typeof method === "function" ? method.bind(target) : method;
    } });
    await pass(instance, state, name, bucket);
    expect(reset).toBe(true);
    expect(state.storage.sql.exec("SELECT 1 FROM file_mirror_jobs").toArray()).toHaveLength(0);
    expect(state.storage.sql.exec("SELECT 1 FROM file_mirror_tail").toArray()).toHaveLength(0);
    expect(state.storage.sql.exec("SELECT 1 FROM file_mirror_abandoned").toArray()).toHaveLength(1);
    expect(await (await bindings.CONTENT.get(key(name)))!.text()).toBe("previous");
  });
  await drain(object, name);
  expect(await streamDigest((await bindings.CONTENT.get(key(name)))!.body)).toBe(await expectedDigest(20 * MiB));
});
