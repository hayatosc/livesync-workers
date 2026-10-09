// SQLite row shapes and request bodies of the vault Durable Object.

export type DocBody = Record<string, unknown>;

export type DocRow = {
  id: string;
  winning_rev: string | null;
  deleted: number;
  updated_seq: number;
};

export type RevRow = {
  id: string;
  rev: string;
  gen: number;
  parent_rev: string | null;
  body: string;
  body_chunked: number;
  body_available: number;
  deleted: number;
  seq: number;
  rev_history: string | null;
};

export type LocalDocRow = {
  id: string;
  rev: string;
  body: string;
};

export type ChangeRow = {
  seq: number;
  id: string;
  rev: string;
  deleted: number;
  revs?: string[];
};

export type ChangeBatch = {
  rows: ChangeRow[];
  lastSeq: number;
  pending: number;
};

export type RevisionMetadata = {
  soft_deleted: number;
  path: string | null;
  size: number | null;
  mtime: number | null;
  type: string | null;
};

export type LiveSyncFileRow = {
  path: string;
  size: number | null;
  mtime: number | null;
  type: string | null;
};

export type Selector = Record<string, unknown>;

export type IndexStateRow = {
  path: string;
  doc_id: string | null;
  hash: string | null;
  chunks: number;
  pending: number;
  attempts: number;
  /** Content hash last written to the full-text index (null = not there yet). */
  fts_hash: string | null;
};

export type InternalOp = {
  execute?: unknown;
  contentType?: unknown;
  op: string;
  path?: unknown;
  paths?: unknown;
  content?: unknown;
  expectedBaseHash?: unknown;
};
