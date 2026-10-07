import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerVaultTools, vaultInstructions, type VaultScope } from "livesync-workers/mcp";
import type { Env } from "./env.js";
import { authorizedVaults, vaultFor } from "./host.js";
import { VERSION } from "./version.js";

export type McpProps = {
  userId: string;
  label?: string;
  scope: string[];
};

// cf's generated bindings narrow the portable Env to this deployment's schema.
export class VaultMCP extends McpAgent<Env & Cloudflare.Env, unknown, McpProps> {
  server = new McpServer(
    { name: "livesync-workers", version: VERSION },
    { instructions: vaultInstructions() },
  );

  async init(): Promise<void> {
    registerVaultTools(this.server, {
      vault: async (vaultId, scope) => vaultFor(this.env, vaultId, this.props?.userId ?? "", scope === "vault:append" || scope === "vault:write"),
      listVaults: async () => authorizedVaults(this.env, this.props?.userId ?? "").map(({ vaultId, displayName }) => ({ vaultId, displayName })),
      hasScope: (scope: VaultScope) => this.props?.scope?.includes(scope) ?? false,
    });
  }
}
