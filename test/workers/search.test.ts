import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { SegmenterFullTextIndex, analyzeWords } from "../../packages/livesync-workers/src/search/segmenter-index.js";
import { createVault } from "../../packages/livesync-workers/src/vault/client.js";
import { DEFAULT_VAULT_POLICY, vaultObjectName } from "../../packages/livesync-workers/src/types.js";
import { hashText } from "../../packages/livesync-workers/src/search/chunk-md.js";
import type { TestEnv, PersistentVaultDO } from "./entry.js";
const bindings = env as unknown as TestEnv;
const index = new SegmenterFullTextIndex(bindings.SEARCH);
const ref = { tenantId: "search-owner", vaultId: "immutable-id", databaseName: "old-name" };
async function put(path: string, content: string) {
  const writer = await index.openWriter(ref);
  await writer.upsert({ path, content, contentHash: content, mtime: null });
  await writer.close();
}
describe("Workers Intl.Segmenter positional index", () => {
  it("normalizes mixed Japanese, English, identifiers and graphemes with original offsets", () => {
    const text = "😀 日本語 ＡＰＩ foo_bar Cafe\u0301 東京";
    const tokens = analyzeWords(text);
    expect(tokens.map((word) => word.term)).toContain("api");
    expect(tokens.map((word) => word.term)).toContain("foo_bar");
    expect(tokens.map((word) => word.term)).toContain("café");
    expect(tokens.find((word) => word.term === "café")?.end).toBe(text.indexOf(" 東京"));
    for (const token of tokens) expect(text.slice(token.start, token.end).normalize("NFKC").toLowerCase()).toBe(token.term);
    expect(tokens.map((word) => word.position)).toEqual(tokens.map((_, i) => i));
  });
  it("ANDs words, matches quoted phrases by consecutive positions, ranks fields and keeps original highlights", async () => {
    await index.beginRebuild(ref);
    await put("Projects/API.md", "# 東京 API\n日本語の検索 ＡＰＩ foo_bar 😀 café");
    await put("Other/body.md", "text 東京 is useful API\n日本語の検索");
    await index.completeRebuild(ref);
    const result = await index.search(ref, '"東京 API"', 10);
    expect(result.hits.map((hit) => hit.path)).toEqual(["Projects/API.md"]);
    const words = await index.search(ref, "東京 API", 10);
    expect(words.hits.map((hit) => hit.path)).toEqual(["Projects/API.md", "Other/body.md"]);
    const normalized = await index.search(ref, "api", 10);
    expect(normalized.hits[0]?.snippets.some((snippet) => snippet.match === "ＡＰＩ")).toBe(true);
    expect((await index.search(ref, "foo_bar", 10)).hits).toHaveLength(1);
    expect((await index.search({ ...ref, vaultId: "other-vault" }, "API", 10)).hits).toHaveLength(0);
    expect((await index.search({ ...ref, databaseName: "renamed" }, "API", 10)).hits).toHaveLength(2);
  });
  it("serves the active generation until a versioned rebuild is published and propagates deletions", async () => {
    await index.beginRebuild(ref);
    await put("new.md", "新しい検索資料");
    expect((await index.search(ref, "API", 10)).hits).toHaveLength(2);
    await index.completeRebuild(ref);
    expect((await index.search(ref, "API", 10)).hits).toHaveLength(0);
    expect((await index.search(ref, "資料", 10)).hits).toHaveLength(1);
    const writer = await index.openWriter(ref);
    await writer.delete("new.md");
    expect((await index.search(ref, "資料", 10)).hits).toHaveLength(0);
  });
});

it("rebuilds derived search from the recovered DO and rejects stale/deleted hits before indexing catches up", async () => {
  const ref = { tenantId: "search-recovery", vaultId: "stable", databaseName: "display" };
  const stub = bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName(vaultObjectName(ref)));
  await stub.fetch("https://db/", { method: "PUT" });
  const vault = createVault({ vaultDb: bindings.VAULT_DB, contentBucket: bindings.CONTENT, bucket: bindings.SEARCH, fullText: index }, {
    ref, policy: DEFAULT_VAULT_POLICY, internalSecret: "integration-secret",
  });
  await vault.writeNote("Projects/one.md", "# 東京 API\n検索の本文", await hashText(""));
  await vault.writeNote("Other/two.md", "東京の本文", await hashText(""));
  await runInDurableObject(stub, async (instance: PersistentVaultDO) => { await instance.alarm(); });
  expect((await vault.grep("東京", 10, "Projects"))).toMatchObject({ status: "ready", hits: [{ path: "Projects/one.md" }] });
  const note = await (await stub.fetch("https://db/Projects%2Fone.md")).json() as { _rev: string };
  await stub.fetch(`https://db/Projects%2Fone.md?rev=${note._rev}`, { method: "DELETE" });
  expect(await vault.grep("API", 10)).toMatchObject({ status: "ready", hits: [] });
  await runInDurableObject(stub, async (_instance, state) => {
    for (const table of ["docs", "revs", "rev_metadata", "local_docs", "changes", "rev_body_chunks", "meta", "index_state"]) state.storage.sql.exec(`DELETE FROM ${table}`);
  });
  expect(await vault.exists()).toBe(true);
  await runInDurableObject(stub, async (instance: PersistentVaultDO) => { await instance.alarm(); });
  expect(await vault.grep("API", 10)).toMatchObject({ status: "ready", hits: [] });
  expect(await vault.grep("東京", 10)).toMatchObject({ status: "ready", hits: [{ path: "Other/two.md" }] });
});

it("retains unchanged notes when an old index version starts a new generation", async () => {
  const ref = { tenantId: "index-upgrade", vaultId: "stable", databaseName: "display" };
  const stub = bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName(vaultObjectName(ref)));
  await stub.fetch("https://db/", { method: "PUT" });
  const vault = createVault({ vaultDb: bindings.VAULT_DB, contentBucket: bindings.CONTENT, bucket: bindings.SEARCH, fullText: index }, { ref, policy: DEFAULT_VAULT_POLICY, internalSecret: "integration-secret" });
  await vault.writeNote("existing.md", "東京 API", await hashText(""));
  await runInDurableObject(stub, async (instance: PersistentVaultDO, state) => {
    await instance.alarm();
    expect(state.storage.sql.exec<{ fts_hash: string }>("SELECT fts_hash FROM index_state").one().fts_hash).toBeTruthy();
    state.storage.sql.exec("UPDATE meta SET value = 'old' WHERE key = 'index_version'");
    await instance.alarm();
  });
  expect(await vault.grep("東京", 10)).toMatchObject({ status: "ready", hits: [{ path: "existing.md" }] });
});
