import {
  AuthThrottledError,
  SegmenterFullTextIndex,
  constantTimeEquals,
  createVault,
  normalizeDatabaseName,
  normalizeExcludedFolders,
  workersAiEmbedder,
  type Vault,
  type VaultBindings,
  type VaultHost,
  type VaultPolicy,
  type VaultRef,
} from "livesync-workers";
import { TENANT_ID, type Env } from "./env.js";
import { AUTH_LOCK_SECONDS, isLockedOut, recordAuthFailure } from "./throttle.js";

export class ConfigError extends Error {}

export type SecretName = "SESSION_SECRET" | "ADMIN_PASSWORD" | "LIVESYNC_PASSWORD";

/**
 * Whether a secret is usable. Empty values and the "change-me…" placeholders that
 * older .dev.vars.example files shipped are treated as unset, so a deploy that kept
 * them does not silently run with a well-known password.
 */
export function secretValue(env: Env, name: SecretName): string | undefined {
  const value = env[name]?.trim();
  if (!value || /^change[-_ ]?me/i.test(value)) return undefined;
  return value;
}

export function requireSecret(env: Env, name: SecretName): string {
  const value = secretValue(env, name);
  if (!value)
    throw new ConfigError(
      `Missing secret ${name}. Add it in the Cloudflare dashboard (Settings → Variables and Secrets) or deploy with: cf deploy --secrets-file .dev.vars`,
    );
  return value;
}

export const DEFAULT_LIVESYNC_USERNAME = "obsidian";

export function liveSyncUsername(env: Env): string {
  return env.LIVESYNC_USERNAME?.trim() || DEFAULT_LIVESYNC_USERNAME;
}

export function vaultRef(env: Env): VaultRef {
  return {
    tenantId: TENANT_ID,
    vaultId: env.LIVESYNC_VAULT_ID?.trim() || "primary",
    databaseName: normalizeDatabaseName(env.LIVESYNC_DATABASE),
  };
}

export type VaultConfig = {
  vaultId: string;
  tenantId: string;
  databaseName: string;
  displayName: string;
  ownerId: string;
  readers?: string[];
  username: string;
  passwordSecret: string;
};
export function vaultConfigs(env: Env): VaultConfig[] {
  if (!env.VAULTS_JSON)
    return [
      {
        ...vaultRef(env),
        vaultId: vaultRef(env).vaultId!,
        displayName: vaultRef(env).databaseName,
        ownerId: "admin",
        username: liveSyncUsername(env),
        passwordSecret: "LIVESYNC_PASSWORD",
      },
    ];
  let configs: VaultConfig[];
  try {
    configs = JSON.parse(env.VAULTS_JSON) as VaultConfig[];
  } catch {
    throw new ConfigError("Invalid VAULTS_JSON");
  }
  if (!Array.isArray(configs) || !configs.length) throw new ConfigError("VAULTS_JSON must contain vaults");
  const identities = new Set<string>();
  const usernames = new Set<string>();
  for (const config of configs) {
    if (
      ![
        config.vaultId,
        config.tenantId,
        config.databaseName,
        config.displayName,
        config.ownerId,
        config.username,
        config.passwordSecret,
      ].every((value) => typeof value === "string" && value.length > 0 && value.length <= 128) ||
      !/^[A-Z][A-Z0-9_]*$/.test(config.passwordSecret) ||
      normalizeDatabaseName(config.databaseName) !== config.databaseName ||
      (config.readers &&
        (!Array.isArray(config.readers) || !config.readers.every((reader) => typeof reader === "string")))
    )
      throw new ConfigError("Invalid vault configuration");
    // MCP selects vaultId, so it must also be unique within this registry.
    if (identities.has(config.vaultId) || usernames.has(config.username))
      throw new ConfigError("Duplicate vault ID or username");
    identities.add(config.vaultId);
    usernames.add(config.username);
  }
  return configs;
}
export function authorizedVaults(env: Env, principal: string, write = false): VaultConfig[] {
  return vaultConfigs(env).filter(
    (config) => config.ownerId === principal || (!write && config.readers?.includes(principal)),
  );
}

export function vaultPolicy(env: Env): VaultPolicy {
  return {
    reservedPaths: [],
    excludedFolders: normalizeExcludedFolders((env.VAULT_EXCLUDED_FOLDERS ?? "").split(",")),
    // Only used to pick "today" when appendToDailyNote gets no date; clients are told to pass one.
    timeZone: "UTC",
  };
}

/** With `request`, failed credentials count towards the per-IP lockout. */
export function vaultHost(env: Env, request?: Request): VaultHost {
  return {
    async verifyCredential(username, password) {
      if (request && (await isLockedOut(env, request))) throw new AuthThrottledError(AUTH_LOCK_SECONDS);
      for (const config of vaultConfigs(env)) {
        const expected = env[config.passwordSecret];
        if (typeof expected !== "string" || !expected.trim() || /^change[-_ ]?me/i.test(expected.trim())) continue;
        const userOk = constantTimeEquals(username, config.username);
        const passOk = constantTimeEquals(password, expected.trim());
        if (userOk && passOk)
          return { tenantId: config.tenantId, vaultId: config.vaultId, databaseName: config.databaseName };
      }
      if (request && (await recordAuthFailure(env, request))) throw new AuthThrottledError(AUTH_LOCK_SECONDS);
      return null;
    },
    async loadVaultPolicy(ref) {
      if (!vaultConfigs(env).some((config) => config.vaultId === ref.vaultId && config.tenantId === ref.tenantId))
        throw new ConfigError("Unknown vault identity");
      return vaultPolicy(env);
    },
    internalSecret: requireSecret(env, "SESSION_SECRET"),
    // Library default: the Obsidian app origins plus this Worker's own origin.
    // Echoing any Origin with credentials would let a page on another site read
    // the vault with Basic credentials the browser has cached for /livesync.
    serverName: "livesync-workers",
  };
}

export function semanticSearchOn(env: Env): boolean {
  return /^(on|true|1|yes)$/i.test((env.SEMANTIC_SEARCH ?? "").trim());
}

export function vaultBindings(env: Env): VaultBindings {
  if (!env.CONTENT_BUCKET || !env.FTS_BUCKET)
    throw new ConfigError(
      "CONTENT_BUCKET and FTS_BUCKET are required; SQLite content fallback is disabled for this Worker",
    );
  if (semanticSearchOn(env) && (!env.AI || !env.VECTORIZE))
    throw new ConfigError("Semantic search requires optional AI and VECTORIZE bindings");
  const capacityValue = (value: string | undefined, fallback: number, max: number) => {
    const result = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(result) || result < 0 || result > max)
      throw new ConfigError("Invalid SQLite capacity setting");
    return result;
  };
  const sqliteMaxBytes = capacityValue(env.SQLITE_MAX_BYTES, 900_000_000, 9_500_000_000);
  const sqliteHeadroomBytes = capacityValue(env.SQLITE_HEADROOM_BYTES, 100_000_000, sqliteMaxBytes);
  if (sqliteHeadroomBytes >= sqliteMaxBytes) throw new ConfigError("SQLite headroom must be below its limit");
  return {
    sqliteMaxBytes,
    sqliteHeadroomBytes,
    vaultDb: env.VAULT_DB,
    bucket: env.FTS_BUCKET,
    contentBucket: env.CONTENT_BUCKET,
    fileMirror: true,
    fullText: new SegmenterFullTextIndex(env.FTS_BUCKET),
    ...(semanticSearchOn(env) ? { vectorize: env.VECTORIZE, embedder: workersAiEmbedder(env.AI) } : {}),
    vectorIsolation: "namespace",
  };
}

export function vaultFor(env: Env, requestedVaultId?: string, principal = "admin", write = false): Vault {
  const configs = authorizedVaults(env, principal, write);
  const config = requestedVaultId ? configs.find((entry) => entry.vaultId === requestedVaultId) : configs[0];
  if (!config) throw new ConfigError("Vault access denied");
  return createVault(vaultBindings(env), {
    ref: { tenantId: config.tenantId, vaultId: config.vaultId, databaseName: config.databaseName },
    policy: vaultPolicy(env),
    internalSecret: requireSecret(env, "SESSION_SECRET"),
  });
}

/** Connection settings for the same authorized default vault used by admin tools. */
export function setupVaultConfig(env: Env): VaultConfig {
  const config = authorizedVaults(env, "admin")[0];
  if (!config) throw new ConfigError("Vault access denied");
  return config;
}
export function setupVaultPassword(env: Env, config = setupVaultConfig(env)): string {
  const value = env[config.passwordSecret];
  if (typeof value !== "string" || !value.trim() || /^change[-_ ]?me/i.test(value.trim()))
    throw new ConfigError(`Missing secret ${config.passwordSecret}`);
  return value.trim();
}
