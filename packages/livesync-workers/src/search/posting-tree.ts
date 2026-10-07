/** Immutable copy-on-write ordered pages. Only a manifest CAS makes a new root visible. */
import { mapBatches, limitConcurrency } from "../storage/concurrency.js";
export type TreeRef = { r2: string; first: string; last: string };
export type Entry<T> = { key: string; value: T };
type Node<T> = { entries: Entry<T>[] } | { children: TreeRef[] };
// Keep ordinary postings in fewer pages without exceeding the byte/memory bound.
export const POSTING_PAGE_ROWS = 256;
const PAGE_BYTES = 512 * 1024;
const FANOUT = 32;
const encoder = new TextEncoder();
export class PostingTree<T> {
  private cache = new Map<string, Node<T>>();
  private io = limitConcurrency(4);
  constructor(private readonly bucket: R2Bucket, readonly prefix: string) {}
  private async load(ref: TreeRef): Promise<Node<T>> {
    if (!ref.r2.startsWith(this.prefix)) throw new Error("Cross-vault posting reference");
    const cached = this.cache.get(ref.r2); if (cached) return cached;
    const { node, size } = await this.io(async () => {
      const object = await this.bucket.get(ref.r2);
      if (!object) throw new Error("Missing shared posting page");
      return { node: await object.json<Node<T>>(), size: object.size };
    });
    // Oversized single-note postings are streamed, not retained across passes.
    if (size <= PAGE_BYTES) {
      if (this.cache.size >= 16) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(ref.r2, node);
    }
    return node;
  }
  private async save(node: Node<T>): Promise<TreeRef> {
    const r2 = `${this.prefix}${crypto.randomUUID()}.json`;
    await this.io(() => this.bucket.put(r2, JSON.stringify(node), { onlyIf: { etagDoesNotMatch: "*" } }));
    const first = "entries" in node ? node.entries[0]!.key : node.children[0]!.first;
    const last = "entries" in node ? node.entries.at(-1)!.key : node.children.at(-1)!.last;
    return { r2, first, last };
  }
  async get(root: TreeRef | null, key: string): Promise<T | null> {
    if (!root || key < root.first || key > root.last) return null;
    const node = await this.load(root);
    if ("entries" in node) return node.entries.find(entry => entry.key === key)?.value ?? null;
    const child = node.children.find(ref => key >= ref.first && key <= ref.last);
    return child ? this.get(child, key) : null;
  }
  async *range(root: TreeRef | null, start = "", end?: string): AsyncGenerator<Entry<T>> {
    if (!root || root.last < start || (end !== undefined && root.first >= end)) return;
    const node = await this.load(root);
    if ("entries" in node) {
      for (const entry of node.entries) if (entry.key >= start && (end === undefined || entry.key < end)) yield entry;
    } else for (const child of node.children) yield* this.range(child, start, end);
  }
  async references(root: TreeRef | null, protect: (value: T) => Promise<void>, live: Set<string>): Promise<void> {
    if (!root || live.has(root.r2)) return;
    live.add(root.r2);
    const node = await this.load(root);
    if ("entries" in node) for (const entry of node.entries) await protect(entry.value);
    else for (const child of node.children) await this.references(child, protect, live);
  }
  private async leaves(entries: Entry<T>[]): Promise<TreeRef[]> {
    const pages: Entry<T>[][] = []; let page: Entry<T>[] = []; let bytes = 0;
    for (const entry of entries) {
      const size = encoder.encode(JSON.stringify(entry)).byteLength;
      if (page.length && (page.length >= POSTING_PAGE_ROWS || bytes + size > PAGE_BYTES)) { pages.push(page); page = []; bytes = 0; }
      page.push(entry); bytes += size;
    }
    if (page.length) pages.push(page);
    return this.savePages(pages.map(entries => ({ entries })));
  }
  private async savePages(nodes: Node<T>[]): Promise<TreeRef[]> {
    const refs: TreeRef[] = [];
    // Every started immutable upload settles before an error returns to the publisher.
    for (let offset = 0; offset < nodes.length; offset += 4) {
      const settled = await Promise.allSettled(nodes.slice(offset, offset + 4).map(node => this.save(node)));
      for (const result of settled) { if (result.status === "rejected") throw result.reason; refs.push(result.value); }
    }
    return refs;
  }
  private async branches(children: TreeRef[]): Promise<TreeRef[]> {
    const nodes: Node<T>[] = [];
    for (let offset = 0; offset < children.length; offset += FANOUT) nodes.push({ children: children.slice(offset, offset + FANOUT) });
    return this.savePages(nodes);
  }
  private async update(root: TreeRef | null, changes: Entry<T | null>[]): Promise<TreeRef[]> {
    if (!changes.length) return root ? [root] : [];
    const node = root ? await this.load(root) : { entries: [] };
    if ("entries" in node) {
      const entries = new Map(node.entries.map(entry => [entry.key, entry.value]));
      for (const change of changes) { if (change.value === null) entries.delete(change.key); else entries.set(change.key, change.value); }
      return this.leaves([...entries].map(([key,value]) => ({key,value})).sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    }
    const groups = node.children.map(() => [] as Entry<T | null>[]);
    for (const change of changes) {
      let index = 0;
      while (index + 1 < node.children.length && node.children[index + 1]!.first <= change.key) index++;
      groups[index]!.push(change);
    }
    const children = await mapBatches(node.children.map((child, index) => ({ child, changes: groups[index]! })), 4,
      ({ child, changes }) => this.update(child, changes));
    return this.branches(children.flat());
  }
  async apply(root: TreeRef | null, changes: Map<string, T | null>): Promise<TreeRef | null> {
    let refs = await this.update(root, [...changes].map(([key,value]) => ({key,value})).sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    while (refs.length > 1) refs = await this.branches(refs);
    return refs[0] ?? null;
  }
}
