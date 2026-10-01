import { describe, expect, it, vi } from "vitest";
import { chunkMarkdown } from "../src/search/chunk-md.js";
import { upsertNoteVectors } from "../src/search/vector-index.js";

describe("embedding chunk boundaries", () => {
  it("keeps the complete body of a long single line in bounded chunks", () => {
    const path = "note.md";
    const prefix = `[${path}]\n`;
    const content = "a".repeat(5000) + " tailneedle";
    const chunks = chunkMarkdown(path, content);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.text.length <= 4000)).toBe(true);
    expect(chunks.map((chunk) => chunk.text.slice(prefix.length)).join("")).toBe(content);
  });

  it("counts the path prefix in the embedding limit and bounds long heading lines", () => {
    const path = "folder/".repeat(100) + "note.md";
    const content = "## " + "h".repeat(5000) + "\n" + "body";
    const chunks = chunkMarkdown(path, content);
    expect(chunks.every((chunk) => chunk.text.length <= 4000)).toBe(true);
    expect(chunks.at(-1)!.text.endsWith("body")).toBe(true);
  });
});

describe("vector cleanup planning", () => {
  it("records the complete cleanup bound before any batch can partially succeed", async () => {
    const events: string[] = [];
    const embed = vi.fn(async (texts: string[]) => {
      events.push("embed");
      return texts.map(() => [1, 2]);
    });
    let batches = 0;
    const upsert = vi.fn(async () => {
      events.push("upsert");
      if (++batches === 2) throw new Error("second batch failed");
      return { mutationId: "m" };
    });
    const content = Array.from({ length: 60 }, (_, index) => `## ${index}\nbody\n`).join("");
    await expect(upsertNoteVectors({
      embedder: { embed }, vectorize: { upsert } as unknown as VectorizeIndex,
    }, {
      ref: { tenantId: "u", databaseName: "v" }, path: "a.md", content,
      hash: "h", previousChunks: 0,
      onChunksPlanned: (count) => events.push(`planned:${count}`),
    })).rejects.toThrow("second batch failed");
    expect(events).toEqual(["planned:60", "embed", "upsert", "embed", "upsert"]);
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it("does not truncate the tail of long single-line text before embedding", async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 2]));
    await upsertNoteVectors({
      embedder: { embed }, vectorize: { upsert: async () => ({ mutationId: "m" }) } as unknown as VectorizeIndex,
    }, {
      ref: { tenantId: "u", databaseName: "v" }, path: "a.md",
      content: "a".repeat(5000) + " tailneedle", hash: "h", previousChunks: 0,
    });
    const embedded = embed.mock.calls.flatMap(([texts]) => texts);
    expect(embedded.every((text) => text.length <= 4000)).toBe(true);
    expect(embedded.some((text) => text.includes("tailneedle"))).toBe(true);
  });
});
