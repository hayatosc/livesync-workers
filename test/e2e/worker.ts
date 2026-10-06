// Local E2E entrypoint only. Never referenced by the production Wrangler configuration.
import { LiveSyncVaultDO, handleLiveSyncRequest, vaultObjectName } from "livesync-workers";
import { vaultBindings, vaultHost, vaultConfigs } from "../../worker/host.js";
import type { Env } from "../../worker/env.js";
export class E2EVaultDO extends LiveSyncVaultDO<Env> {
  private readonly storage: DurableObjectStorage;
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env); this.storage = ctx.storage; }
  protected host() { return vaultHost(this.env); }
  protected bindings() { return vaultBindings(this.env); }
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/e2e/checkpoint-status") {
      if (request.headers.get("X-E2E-Token") !== this.env.SESSION_SECRET) return new Response("Forbidden", { status: 403 });
      return Response.json({ pending: this.storage.sql.exec("SELECT id FROM checkpoint_work").toArray().length > 0 });
    }
    if (new URL(request.url).pathname === "/e2e/reset-cache") {
      if (request.headers.get("X-E2E-Token") !== this.env.SESSION_SECRET) return new Response("Forbidden", { status: 403 });
      this.storage.transactionSync(() => {
        for (const table of ["docs", "revs", "rev_metadata", "local_docs", "changes", "rev_body_chunks", "meta", "index_state"]) this.storage.sql.exec(`DELETE FROM ${table}`);
      });
      return Response.json({ ok: true });
    }
    return super.fetch(request);
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/e2e/ready") return Response.json({ localE2E: true });
    if ((url.pathname === "/e2e/reset-cache" && request.method === "POST") || url.pathname === "/e2e/checkpoint-status") {
      if (request.headers.get("X-E2E-Token") !== env.SESSION_SECRET) return new Response("Forbidden", { status: 403 });
      const config = vaultConfigs(env).find((v) => v.vaultId === url.searchParams.get("vaultId"));
      if (!config) return new Response("Not Found", { status: 404 });
      return env.VAULT_DB.get(env.VAULT_DB.idFromName(vaultObjectName(config))).fetch(request);
    }
    return handleLiveSyncRequest(request, { host: vaultHost(env), bindings: vaultBindings(env) });
  },
};
