import { env } from "cloudflare:test";
import { it, expect } from "vitest";
import type { TestEnv } from "./entry.js";
import { drainCheckpoint } from "./checkpoint-helpers.js";
const bindings = env as unknown as TestEnv;
it("preserves filtered replication completion, conflict leaves, ancestor history and bulk API behavior", async () => {
  const stub = bindings.VAULT_DB.get(bindings.VAULT_DB.idFromName("protocol:vault"));
  await stub.fetch("https://db/", { method: "PUT" });
  const docs = Array.from({ length: 12 }, (_, i) => ({
    _id: `chunk-${i}`,
    _rev: "1-chunk",
    type: "leaf",
    data: "binary-or-text",
  }));
  const branches = [
    {
      _id: "note",
      _rev: "2-a",
      _revisions: { start: 2, ids: ["a", "root"] },
      type: "plain",
      path: "Note.md",
      data: "branch A",
    },
    {
      _id: "note",
      _rev: "2-b",
      _revisions: { start: 2, ids: ["b", "root"] },
      type: "plain",
      path: "Note.md",
      data: "branch B",
    },
  ];
  expect(
    (
      await stub.fetch("https://db/_bulk_docs", {
        method: "POST",
        body: JSON.stringify({ docs: [...docs, ...branches], new_edits: false }),
      })
    ).status,
  ).toBe(200);
  const changes = (await (
    await stub.fetch("https://db/_changes", {
      method: "POST",
      body: JSON.stringify({ since: 0, limit: 1, style: "all_docs", selector: { type: "plain" }, include_docs: true }),
    })
  ).json()) as { results: Array<{ id: string; changes: Array<{ rev: string }> }>; last_seq: number };
  expect(changes.results).toHaveLength(1);
  expect(changes.results[0]?.id).toBe("note");
  expect(changes.results[0]?.changes.map((change) => change.rev).sort()).toEqual(["2-a", "2-b"]);
  expect(changes.last_seq).toBe(14);
  const current = (await (await stub.fetch("https://db/note?conflicts=true&revs=true")).json()) as {
    _rev: string;
    _conflicts: string[];
    _revisions: unknown;
  };
  expect(current._rev).toBe("2-b");
  expect(current._conflicts).toEqual(["2-a"]);
  const open = (await (await stub.fetch("https://db/note?open_revs=all&revs=true")).json()) as unknown[];
  expect(open).toHaveLength(2);
  const diff = await (
    await stub.fetch("https://db/_revs_diff", { method: "POST", body: '{"note":["2-a","2-b","3-missing"]}' })
  ).json();
  expect(diff).toEqual({ note: { missing: ["3-missing"] } });
  expect(
    (
      await stub.fetch("https://db/_bulk_get", {
        method: "POST",
        body: '{"docs":[{"id":"note","rev":"2-a"}],"revs":true}',
      })
    ).status,
  ).toBe(200);
  expect((await stub.fetch("https://db/_compact", { method: "POST" })).status).toBe(202);
  await drainCheckpoint(stub);
  expect((await stub.fetch("https://db/note?rev=2-a")).status).toBe(200);
  const suppliedAncestor = await stub.fetch("https://db/_bulk_docs", {
    method: "POST",
    body: JSON.stringify({
      new_edits: false,
      docs: [{ _id: "note", _rev: "1-root", type: "plain", path: "Note.md", data: "original body" }],
    }),
  });
  expect(suppliedAncestor.status).toBe(200);
  expect(((await (await stub.fetch("https://db/note?rev=1-root")).json()) as { data: string }).data).toBe(
    "original body",
  );
  const conflictDelete = await stub.fetch("https://db/note?rev=2-b", { method: "DELETE" });
  expect(conflictDelete.status).toBe(200);
  expect(((await (await stub.fetch("https://db/note")).json()) as { _rev: string })._rev).toBe("2-a");
});
