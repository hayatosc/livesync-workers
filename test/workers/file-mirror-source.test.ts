import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { MirrorSourceReader } from "../../packages/livesync-workers/src/storage/file-mirror-source.js";
import type {
  MirrorMetadata,
  MirrorReference,
} from "../../packages/livesync-workers/src/storage/file-mirror-upload.js";
import type { TestEnv } from "./entry.js";

const bindings = env as unknown as TestEnv;
const prefix = "content/v1/source-bounds/vault/";
const source: MirrorReference = {
  id: "chunk",
  rev: "1-a",
  r2: `${prefix}objects/source`,
  envelope: false,
  eden: null,
  childId: null,
  childRev: null,
};
const metadata: MirrorMetadata = {
  docId: "note",
  rev: "1-a",
  root: source,
  type: "plain",
  contentType: "text/plain",
  mtime: null,
  declaredSize: null,
  fingerprint: "source-test",
};

it.each(["exact", "underreported", "oversized"])("bounds source reads with %s R2 size metadata", async (kind) => {
  await bindings.CONTENT.put(source.r2!, '{"data":"bounded source"}');
  const stored = (await bindings.CONTENT.get(source.r2!))!;
  const input = new TextEncoder().encode('{"data":"bounded source"}');
  let reads = 0,
    cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads++;
        controller.enqueue(input);
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const size = kind === "exact" ? input.length : kind === "underreported" ? input.length - 1 : 4 * 1024 * 1024 + 1;
  const object = new Proxy(stored, {
    get(target, property) {
      if (property === "size") return size;
      if (property === "body") return body;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const vault = bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName(`source-bounds-${kind}:vault`));
  try {
    await runInDurableObject(vault, async (_instance, state) => {
      const reader = new MirrorSourceReader(
        state.storage.sql,
        prefix,
        async () => null,
        (operation) => operation(),
        () => "",
      );
      const result = reader.read(source, metadata, { get: async () => object });
      if (kind === "exact") expect(await result).toEqual(["bounded source"]);
      else await expect(result).rejects.toThrow("SOURCE_TOO_LARGE");
    });
    expect(reads).toBe(kind === "oversized" ? 0 : 1);
    if (kind === "oversized") expect(cancelled).toBe(true);
  } finally {
    await stored.body.cancel();
    if (!body.locked) await body.cancel();
  }
});
