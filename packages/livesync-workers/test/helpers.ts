import { vi } from "vitest";
import {
  DEFAULT_VAULT_POLICY,
  LiveSyncVaultDO,
  workersAiEmbedder,
  type VaultBindings,
  type VaultHost,
  type VaultPolicy,
  type VaultRef,
} from "../src/index.js";

export const TEST_SECRET = "test-secret";

export type TestEnv = {
  policy: VaultPolicy;
  ftsMaxTotalCodeUnits?: number;
  /** false leaves vectorize/embedder out of the bindings (semantic search off). */
  semanticSearch?: boolean;
  AI: { run: ReturnType<typeof vi.fn> };
  VECTORIZE: { upsert: ReturnType<typeof vi.fn>; deleteByIds: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> };
  FTS_BUCKET: R2Bucket;
  VAULT_DB: DurableObjectNamespace;
  upserted: VectorizeVector[];
  deletedIds: string[];
};

export function testEnv(overrides: Partial<TestEnv> = {}): TestEnv {
  const upserted: VectorizeVector[] = [];
  const deletedIds: string[] = [];
  return {
    policy: { ...DEFAULT_VAULT_POLICY },
    AI: {
      run: vi.fn(async (_model: string, input: { text: string[] }) => ({
        data: input.text.map((_, index) => [index, 1]),
      })),
    },
    VECTORIZE: {
      upsert: vi.fn(async (vectors: VectorizeVector[]) => {
        upserted.push(...vectors);
      }),
      deleteByIds: vi.fn(async (ids: string[]) => {
        deletedIds.push(...ids);
      }),
      query: vi.fn(async () => ({ matches: [] })),
    },
    FTS_BUCKET: { put: vi.fn(async () => null), get: vi.fn(async () => null), list: vi.fn(async () => ({ objects: [], truncated: false })), delete: vi.fn(async () => {}) } as unknown as R2Bucket,
    VAULT_DB: {} as DurableObjectNamespace,
    upserted,
    deletedIds,
    ...overrides,
  };
}

export function testHost(env: TestEnv, ref?: VaultRef): VaultHost {
  return {
    async verifyCredential(username, password) {
      return username === "sync-user" && password === "sync-pass" && ref ? ref : null;
    },
    async loadVaultPolicy() {
      return env.policy;
    },
    internalSecret: TEST_SECRET,
  };
}

export function testBindings(env: TestEnv): VaultBindings {
  return {
    vaultDb: env.VAULT_DB,
    bucket: env.FTS_BUCKET,
    ...(env.semanticSearch === false
      ? {}
      : {
          vectorize: env.VECTORIZE as unknown as VectorizeIndex,
          embedder: workersAiEmbedder(env.AI as unknown as Ai),
        }),
    vectorIsolation: "metadata",
    ...(env.ftsMaxTotalCodeUnits !== undefined ? { ftsMaxTotalCodeUnits: env.ftsMaxTotalCodeUnits } : {}),
  };
}

export class TestVaultDO extends LiveSyncVaultDO<TestEnv> {
  protected host(): VaultHost {
    return testHost(this.env);
  }
  protected bindings(): VaultBindings {
    return testBindings(this.env);
  }
}
