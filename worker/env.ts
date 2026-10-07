export interface Env {
  VAULT_DB: DurableObjectNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  /** Optional. Counts failed sign-ins per IP; see worker/throttle.ts. */
  AUTH_FAILURE_LIMITER?: RateLimit;
  FTS_BUCKET: R2Bucket;
  CONTENT_BUCKET: R2Bucket;
  /** Immutable default vault ID. Never derive it from the display/database name. */
  LIVESYNC_VAULT_ID?: string;
  /** Static vault registry; credentials are references to existing environment secrets. */
  VAULTS_JSON?: string;
  [secretName: string]: unknown;
  VECTORIZE: VectorizeIndex;
  AI: Ai;

  // Variables (wrangler.jsonc `vars`, or added in the dashboard).
  SQLITE_MAX_BYTES?: string;
  SQLITE_HEADROOM_BYTES?: string;
  LIVESYNC_DATABASE?: string;
  LIVESYNC_USERNAME?: string;
  VAULT_EXCLUDED_FOLDERS?: string;
  /** Optional. "off" runs without semantic search (no embeddings, no Vectorize usage). */
  SEMANTIC_SEARCH?: string;
  /** Optional. Extra scopes for MCP_STATIC_TOKEN, e.g. "vault:append,vault:write". */
  MCP_STATIC_TOKEN_SCOPES?: string;

  // Secrets.
  LIVESYNC_PASSWORD?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  MCP_STATIC_TOKEN?: string;
}

export const TENANT_ID = "default";
