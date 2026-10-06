import { SegmenterFullTextIndex } from "../../packages/livesync-workers/src/search/segmenter-index.js";
import { LiveSyncVaultDO } from "../../packages/livesync-workers/src/durable/livesync-db.js";
import { handleLiveSyncRequest } from "../../packages/livesync-workers/src/livesync/handler.js";
import { DEFAULT_VAULT_POLICY, type VaultHost } from "../../packages/livesync-workers/src/types.js";
export type TestEnv = { CONTENT: R2Bucket; SEARCH: R2Bucket; VAULT_DB: DurableObjectNamespace; LEGACY_DB: DurableObjectNamespace };
export const host: VaultHost = {
  internalSecret: "integration-secret",
  async verifyCredential(user, password) {
    return password === "integration-pass" && ["alice", "bob"].includes(user)
      ? { tenantId: user, databaseName: "vault" } : null;
  },
  async loadVaultPolicy() { return DEFAULT_VAULT_POLICY; },
};
export class PersistentVaultDO extends LiveSyncVaultDO<TestEnv> {
  protected host() { return host; }
  protected bindings() { return { vaultDb: this.env.VAULT_DB, contentBucket: this.env.CONTENT, bucket: this.env.SEARCH, fullText: new SegmenterFullTextIndex(this.env.SEARCH) }; }
}
export default {
  fetch(request: Request, env: TestEnv) {
    return handleLiveSyncRequest(request, { host, bindings: { vaultDb: env.VAULT_DB } });
  },
};

export class LegacyVaultDO extends LiveSyncVaultDO<TestEnv> {
  protected host() { return host; }
  protected bindings() { return { vaultDb: this.env.VAULT_DB, bucket: this.env.SEARCH }; }
}
