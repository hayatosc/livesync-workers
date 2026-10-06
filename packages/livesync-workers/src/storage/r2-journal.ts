/** R2 is authoritative. A single vault DO serializes writers; head CAS also fences stale writers. */
export type JournalStatement = { sql: string; args: Array<string | number | null> };
export type JournalCommit = { version: 1 | 2; previous: string | null; statements: JournalStatement[]; checkpoint?: { r2: string; format?: 2 } };
export type JournalHead = { version: 1; commit: string };
export class JournalConflict extends Error {}

export function contentPrefix(tenantId: string, vaultId: string): string {
  if (!tenantId || !vaultId) throw new Error("Vault identity is required");
  return `content/v1/${encodeURIComponent(tenantId)}/${encodeURIComponent(vaultId)}/`;
}

export class R2Journal {
  constructor(readonly bucket: R2Bucket, readonly prefix: string) {}
  private observed: { commit: string | null; etag: string | null } | null = null;
  private get headKey() { return `${this.prefix}head.json`; }

  async head(): Promise<{ commit: string | null; etag: string | null }> {
    const object = await this.bucket.get(this.headKey);
    if (!object) return this.observed = { commit: null, etag: null };
    const head = await object.json<JournalHead>();
    if (head.version !== 1 || !head.commit.startsWith(`${this.prefix}commits/`)) {
      throw new Error("Invalid content journal head");
    }
    return this.observed = { commit: head.commit, etag: object.etag };
  }

  /** Retry only explicit throttling/unavailability; CAS still fences every head write. */
  private async put(key: string, value: Parameters<R2Bucket["put"]>[1], options?: R2PutOptions): Promise<R2Object | null> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.bucket.put(key,value,options); }
      catch (error) {
        const status = (error as { status?: number; statusCode?: number }).status ?? (error as { statusCode?: number }).statusCode;
        if (attempt >= 3 || !(status === 429 || status === 503 || /\b(?:429|503)\b|TooManyRequests|Too Many Requests|SlowDown/i.test(String(error)))) throw error;
        await new Promise(resolve => setTimeout(resolve,250 * 2 ** attempt));
      }
    }
  }

  async putBody(body: string): Promise<string> {
    return this.putBytes(new TextEncoder().encode(body));
  }

  async putBytes(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hash = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
    const key = `${this.prefix}objects/${hash}`;
    await this.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" } });
    return key;
  }

  async body(key: string): Promise<string> {
    if (!key.startsWith(`${this.prefix}objects/`)) throw new Error("Cross-vault content reference");
    const object = await this.bucket.get(key);
    if (!object) throw new Error(`Missing persistent content: ${key}`);
    return object.text();
  }

  async commit(statements: JournalStatement[], expected?: string | null, checkpoint?: { r2: string; format?: 2 }): Promise<string> {
    const previous = expected !== undefined && this.observed?.commit === expected ? this.observed : await this.head();
    if (expected !== undefined && previous.commit !== expected) throw new JournalConflict("Stale vault writer");
    const key = `${this.prefix}commits/${crypto.randomUUID()}.json`;
    const commit: JournalCommit = { version: checkpoint?.format === 2 ? 2 : 1, previous: previous.commit, statements, ...(checkpoint ? { checkpoint } : {}) };
    const immutable = await this.put(key, JSON.stringify(commit), { onlyIf: { etagDoesNotMatch: "*" } });
    if (!immutable && await (await this.bucket.get(key))?.text() !== JSON.stringify(commit)) throw new JournalConflict("Commit key already exists; retry with a new immutable key");
    const head: JournalHead = { version: 1, commit: key };
    const result = await this.put(this.headKey, JSON.stringify(head), {
      onlyIf: previous.etag ? { etagMatches: previous.etag } : { etagDoesNotMatch: "*" },
    });
    if (!result) {
      const current = await this.head();
      if (current.commit === key) return key; // A transient failure lost only the acknowledgement.
      throw new JournalConflict("The vault journal changed; reload and retry");
    }
    this.observed = { commit: key, etag: result.etag };
    return key;
  }

  /** Checkpoint pages/catalogs are immutable and bounded; head CAS publishes the root. */
  async snapshot(pages: AsyncIterable<JournalStatement[]>): Promise<{ r2: string }> {
    let references: Array<{ r2: string }> = [];
    let previous: { r2: string } | null = null;
    for await (const statements of pages) {
      references.push({ r2: await this.putBody(JSON.stringify({ statements })) });
      if (references.length === 128) {
        previous = { r2: await this.putBody(JSON.stringify({ references, previous })) };
        references = [];
      }
    }
    return { r2: await this.putBody(JSON.stringify({ references, previous })) };
  }

  /** Bounded statement memory. Stop at local applied head, or the nearest checkpoint. */
  async *replay(head: string | null, stop: string | null = null): AsyncGenerator<{ statements: JournalStatement[]; reset?: boolean; commit?: string }> {
    const keys: string[] = [];
    const seen = new Set<string>();
    let key = head;
    while (key && key !== stop) {
      if (!key.startsWith(`${this.prefix}commits/`) || seen.has(key)) throw new Error("Invalid journal replay chain");
      seen.add(key); keys.push(key);
      const object = await this.bucket.get(key);
      if (!object) throw new Error("Missing committed manifest during replay");
      const value = await object.json<JournalCommit>();
      if (value.version !== 1 && value.version !== 2) throw new Error("Unsupported journal version");
      if (value.checkpoint) break;
      key = value.previous;
    }
    // A vanished/stale local marker must not turn a full replay into an append.
    let reset = key !== stop;
    for (const commitKey of keys.reverse()) {
      const object = await this.bucket.get(commitKey);
      if (!object) throw new Error("Missing committed manifest during replay");
      const value = await object.json<JournalCommit>();
      if (value.checkpoint) {
        let catalog: { r2: string } | null = value.checkpoint;
        const catalogs = new Set<string>();
        const root = JSON.parse(await this.body(catalog.r2)) as { ordered?: boolean };
        const keys: string[] = [];
        while (catalog) {
          if (catalogs.has(catalog.r2)) throw new Error("Checkpoint catalog cycle");
          catalogs.add(catalog.r2); keys.push(catalog.r2);
          const manifest: { previous?: { r2: string } | null } = JSON.parse(await this.body(catalog.r2));
          catalog = manifest.previous ?? null;
        }
        // Old checkpoints contain independent INSERT rows; new overlays require creation order.
        if (root.ordered) keys.reverse();
        let first = true;
        for (const key of keys) {
          const manifest = JSON.parse(await this.body(key)) as { references: Array<{ r2: string }> };
          for (const page of manifest.references) {
            const data = JSON.parse(await this.body(page.r2)) as { statements: JournalStatement[] };
            yield { statements: data.statements, reset: first };
            first = false;
          }
        }
        // Also handles empty checkpoints.
        yield { statements: [], reset: first, commit: commitKey };
        reset = false;
      } else {
        yield { statements: value.statements, reset, commit: commitKey };
        reset = false;
      }
    }
  }

  async history(head?: string | null): Promise<JournalCommit[]> {
    let key = head === undefined ? (await this.head()).commit : head;
    const commits: JournalCommit[] = [];
    const seen = new Set<string>();
    while (key) {
      if (!key.startsWith(`${this.prefix}commits/`) || seen.has(key)) throw new Error("Invalid content journal chain");
      seen.add(key);
      const object = await this.bucket.get(key);
      if (!object) throw new Error(`Missing committed manifest: ${key}`);
      const commit = await object.json<JournalCommit>();
      if (![1,2].includes(commit.version) || !Array.isArray(commit.statements)) throw new Error("Unsupported content journal version");
      commits.push(commit);
      key = commit.previous;
    }
    return commits.reverse();
  }

  /** Dry run by default. Only unreachable objects older than the grace period are candidates. */
  async collectGarbage(options: { execute?: boolean; graceMs?: number; roots?: unknown[] } = {}): Promise<string[]> {
    const before = await this.head();
    const live = new Set<string>([this.headKey]);
    const protect = async (value: unknown): Promise<void> => {
      if (typeof value === "string") { try { await protect(JSON.parse(value)); } catch (error) { if (!(error instanceof SyntaxError)) throw error; } return; }
      if (!value || typeof value !== "object") return;
      const pointer = (value as { r2?: unknown }).r2;
      if (typeof pointer === "string") {
        if (!pointer.startsWith(`${this.prefix}objects/`)) throw new Error("Cross-vault content reference");
        if (!live.has(pointer)) {
          live.add(pointer);
          const object = await this.bucket.get(pointer);
          if (!object) throw new Error("Missing committed object during garbage collection");
          // Raw binary originals need no JSON decoding.
          try { await protect(await object.json()); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        }
      }
      const binary = (value as { binaryKey?: unknown }).binaryKey;
      if (typeof binary === "string") {
        if (!binary.startsWith(`${this.prefix}objects/`)) throw new Error("Cross-vault binary reference");
        live.add(binary);
      }
      for (const entry of Object.values(value)) if (entry !== pointer) await protect(entry);
    };
    await protect(options.roots);
    let key = before.commit;
    const seen = new Set<string>();
    while (key) {
      if (!key.startsWith(`${this.prefix}commits/`) || seen.has(key)) throw new Error("Invalid journal during garbage collection");
      seen.add(key);
      live.add(key);
      const object = await this.bucket.get(key);
      if (!object) throw new Error("Missing journal during garbage collection");
      const commit = await object.json<JournalCommit>();
      await protect(commit.checkpoint);
      await protect(commit.statements);
      key = commit.previous;
    }
    const garbage: string[] = [];
    let cursor: string | undefined;
    const cutoff = Date.now() - (options.graceMs ?? 24 * 60 * 60_000);
    do {
      const page = await this.bucket.list({ prefix: this.prefix, ...(cursor ? { cursor } : {}) });
      for (const object of page.objects) {
        if (!live.has(object.key) && object.uploaded.getTime() < cutoff) garbage.push(object.key);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (options.execute) {
      // Caller must hold the vault's writer lock for the whole collection.
      if ((await this.head()).commit !== before.commit) throw new JournalConflict("Vault changed during collection");
      for (let i = 0; i < garbage.length; i += 1000) await this.bucket.delete(garbage.slice(i, i + 1000));
    }
    return garbage;
  }
}
