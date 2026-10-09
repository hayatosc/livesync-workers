import { REQUEST_LIMITS } from "../livesync/limits.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inferDailyNotePath, listVaultDirectory } from "../vault/paths.js";
import { hashText } from "../search/chunk-md.js";
import type { Vault } from "../vault/client.js";
import { dateStringIn } from "../types.js";

export { withMcpSessionIsolation } from "./sessions.js";

export const VAULT_SCOPES = ["vault:read", "vault:append", "vault:write"] as const;
export type VaultScope = (typeof VAULT_SCOPES)[number];

/** Every tool registerVaultTools adds, for status pages and docs. */
export const VAULT_TOOL_NAMES = [
  "listVaults",
  "listDirectory",
  "listNotes",
  "listRecentNotes",
  "listFiles",
  "readNote",
  "readDailyNote",
  "readAttachment",
  "searchNotes",
  "grepNotes",
  "vaultStatus",
  "appendToDailyNote",
  "appendToNote",
  "writeNote",
  "uploadAttachment",
] as const;

export const VAULT_SCOPE_DESCRIPTIONS: Record<VaultScope, string> = {
  "vault:read": "Read and search vault notes (required)",
  "vault:append": "Append to the end of vault notes",
  "vault:write": "Create and overwrite vault notes",
};

export type VaultToolContext = {
  /** The caller's vault, or null when no vault is connected yet. */
  vault: (vaultId?: string, scope?: VaultScope) => Promise<Vault | null>;
  listVaults?: () => Promise<Array<{ vaultId: string; displayName: string }>>;
  /** Scope check, evaluated on every tool call. */
  hasScope: (scope: VaultScope) => boolean;
  /** Name shown in tool descriptions. Default "Obsidian". */
  vaultLabel?: string;
};

export type VaultInstructionsOptions = {
  /** Name shown in the instructions. Default "Obsidian". */
  vaultLabel?: string;
  /** Extra paragraphs appended after the vault guidance (e.g. for host-specific tools). */
  extra?: string[];
};

/**
 * Server-level `instructions` for the MCP `initialize` response. Clients such as
 * Claude Code and Claude.ai put this text in the model's system prompt, so it is the
 * one place a vault owner's `AGENTS.md` can be surfaced before any tool is called.
 *
 * Pass the result as `new McpServer(info, { instructions: vaultInstructions() })`.
 */
export function vaultInstructions(options: VaultInstructionsOptions = {}): string {
  const label = options.vaultLabel ?? "Obsidian";
  const paragraphs = [
    `This server gives access to the user's ${label} vault: a folder of Markdown notes.`,
    `Before doing anything else with the vault, call readNote with path "AGENTS.md". If it exists, it is the vault owner's guide for AI agents: how the vault is organized, where daily notes live, and the conventions to follow when writing or appending to notes. Follow it. If readNote reports NOT_FOUND, there is no such guide; continue without it and do not create one unless asked.`,
    `Searching: grepNotes is full-text word search with Japanese segmentation and quoted word phrases and is the better choice for names, terms and Japanese keywords; searchNotes is semantic and better for vague or conceptual queries. Paths are vault-relative (e.g. "Projects/Plan.md"); readNote suggests similar paths when it misses.`,
    `Writing: prefer appendToDailyNote / appendToNote when adding to a note is enough. writeNote overwrites and needs the contentHash from readNote for existing notes. Write tools also require the vault:append / vault:write scopes, which the user may not have granted.`,
    ...(options.extra ?? []),
  ];
  return paragraphs.join("\n\n");
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function clampLimit(limit: number | undefined, fallback: number, max: number) {
  if (!limit) return fallback;
  return Math.min(Math.max(Math.trunc(limit), 1), max);
}

/** Similar existing paths shown when readNote misses, so callers can self-correct. */
function suggestSimilarPaths(paths: string[], requested: string): string[] {
  const base = (requested.split("/").at(-1) ?? requested).replace(/\.md$/i, "").toLowerCase();
  if (!base) return [];
  return paths.filter((path) => path.toLowerCase().includes(base)).slice(0, 5);
}

/**
 * Register the vault tools (`VAULT_TOOL_NAMES`) on an MCP server. Writing tools
 * need vault:append (appendToDailyNote, appendToNote) or vault:write (writeNote,
 * uploadAttachment); everything else needs vault:read.
 */
export function registerVaultTools(server: McpServer, ctx: VaultToolContext): void {
  const label = ctx.vaultLabel ?? "Obsidian";

  const requireScope = (scope: VaultScope) => {
    if (!ctx.hasScope(scope)) throw new Error(`Missing required OAuth scope: ${scope}`);
  };
  const readyVault = async (scope: VaultScope = "vault:read", vaultId?: string): Promise<Vault> => {
    requireScope("vault:read");
    if (scope !== "vault:read") requireScope(scope);
    const vault = await ctx.vault(vaultId, scope);
    if (!vault) throw new Error(`${label} vault is not connected`);
    if (vaultId && (vault.ref.vaultId ?? vault.ref.databaseName) !== vaultId)
      throw new Error("Vault selection mismatch");
    return vault;
  };

  server.tool(
    "listDirectory",
    "List Markdown files and subdirectories directly under a vault-relative directory.",
    {
      vaultId: z.string().min(1).max(128).optional().describe("Immutable vault ID; omit for the default vault."),
      path: z.string().optional().describe("Vault-relative directory path. Omit or use empty string for root."),
    },
    async ({ path, vaultId }) => {
      const vault = await readyVault("vault:read", vaultId);
      const paths = await vault.listMarkdownPaths();
      return textResult(listVaultDirectory(paths, path ?? ""));
    },
  );

  server.tool(
    "listNotes",
    "List vault-relative Markdown note paths. Response includes the total count so you can tell when results are truncated.",
    {
      vaultId: z.string().min(1).max(128).optional().describe("Immutable vault ID; omit for the default vault."),
      prefix: z
        .string()
        .optional()
        .describe("Only return paths starting with this vault-relative prefix, e.g. 'daily notes/'."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of note paths to return. Default is 100."),
    },
    async ({ prefix, limit, vaultId }) => {
      const vault = await readyVault("vault:read", vaultId);
      let paths = await vault.listMarkdownPaths();
      if (prefix) paths = paths.filter((path) => path.startsWith(prefix));
      return textResult({ total: paths.length, paths: paths.slice(0, clampLimit(limit, 100, 500)) });
    },
  );

  server.tool(
    "listRecentNotes",
    "List Markdown notes sorted by modification time (newest first), with mtime and size.",
    {
      vaultId: z.string().min(1).max(128).optional().describe("Immutable vault ID; omit for the default vault."),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum number of notes to return. Default is 20."),
    },
    async ({ limit, vaultId }) => {
      const vault = await readyVault("vault:read", vaultId);
      const files = await vault.listNoteStats();
      files.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
      return textResult({
        total: files.length,
        notes: files.slice(0, clampLimit(limit, 20, 100)).map((file) => ({
          path: file.path,
          modifiedAt: file.mtime != null ? new Date(file.mtime).toISOString() : null,
          size: file.size,
        })),
      });
    },
  );

  server.tool(
    "readNote",
    "Read a Markdown note by vault-relative path.",
    {
      vaultId: z.string().min(1).max(128).optional().describe("Immutable vault ID; omit for the default vault."),
      path: z.string().min(1).describe("Vault-relative Markdown path, e.g. Projects/Plan.md"),
    },
    async ({ path, vaultId }) => {
      const vault = await readyVault("vault:read", vaultId);
      const content = await vault.readNote(path);
      if (content == null) {
        const paths = await vault.listMarkdownPaths();
        return textResult({
          error: "NOT_FOUND",
          path,
          similarPaths: suggestSimilarPaths(paths, path),
        });
      }
      return textResult({
        path,
        content,
        // Pass back to writeNote as expectedContentHash when overwriting.
        contentHash: await hashText(content),
      });
    },
  );

  server.tool(
    "searchNotes",
    `Search indexed ${label} notes semantically.`,
    {
      vaultId: z.string().min(1).max(128).optional().describe("Immutable vault ID; omit for the default vault."),
      query: z.string().min(1).describe("Search query."),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum search hits to return. Default is 8."),
    },
    async ({ query, limit, vaultId }) => {
      const vault = await readyVault("vault:read", vaultId);
      if (!vault.semanticSearch) {
        return textResult({
          hits: [],
          error: "SEMANTIC_SEARCH_DISABLED",
          message: "Semantic search is turned off for this vault. Use grepNotes instead.",
        });
      }
      const hits = await vault.search(query, clampLimit(limit, 8, 20));
      return textResult({ hits });
    },
  );

  server.tool(
    "grepNotes",
    `Full-text search over ${label} notes using Japanese word segmentation and BM25. Words are ANDed; double quotes select a consecutive-word phrase. Inflection and arbitrary substring matching are not guaranteed.`,
    {
      vaultId: z.string().min(1).max(128).optional().describe("Immutable vault ID; omit for the default vault."),
      query: z.string().min(1).max(200).describe("Search words or quoted phrases."),
      folder: z.string().optional().describe("Limit to a vault-relative folder and its descendants."),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum search hits to return. Default is 20."),
    },
    async ({ query, limit, folder, vaultId }) => {
      const vault = await readyVault("vault:read", vaultId);
      const result = await vault.grep(query, clampLimit(limit, 20, 50), folder);
      if (result.status === "building") {
        return textResult({
          status: "building",
          message: "The full-text index is being built; retry shortly.",
          debug: result.debug ?? null,
        });
      }
      if (result.status === "query-too-long") {
        return textResult({
          status: "query-too-long",
          message: `The query has too many terms (at most ${result.maxTokens} index terms, about ${result.maxTokens * 2} CJK characters or ${result.maxTokens} words); search for a shorter phrase.`,
        });
      }
      return textResult(result);
    },
  );

  server.tool(
    "readDailyNote",
    "Read a daily note by date using Obsidian daily-notes settings when available.",
    {
      vaultId: z.string().min(1).max(128).optional().describe("Immutable vault ID; omit for the default vault."),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("Daily note date in YYYY-MM-DD format."),
    },
    async ({ date, vaultId }) => {
      const vault = await readyVault("vault:read", vaultId);
      const [paths, settings] = await Promise.all([vault.listMarkdownPaths(), vault.dailyNoteSettings()]);
      const path = inferDailyNotePath(paths, date, settings);
      const content = await vault.readNote(path);
      if (content == null) return textResult({ error: "NOT_FOUND", date, path });
      return textResult({ date, path, content, contentHash: await hashText(content) });
    },
  );

  server.tool(
    "appendToDailyNote",
    "Append a Markdown block to the end of a daily note (created if missing). Requires the vault:append scope.",
    {
      vaultId: z.string().min(1).max(128).optional().describe("Immutable vault ID; omit for the default vault."),
      text: z.string().min(1).max(20_000).describe("Markdown block to append."),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe(
          "Daily note date (YYYY-MM-DD). Pass today's date in the user's local time zone; if omitted, today in the vault's configured time zone (see vaultStatus) is used.",
        ),
    },
    async ({ text, date, vaultId }) => {
      const vault = await readyVault("vault:append", vaultId);
      const targetDate = date ?? dateStringIn(vault.policy.timeZone);
      const [paths, settings] = await Promise.all([vault.listMarkdownPaths(), vault.dailyNoteSettings()]);
      const path = inferDailyNotePath(paths, targetDate, settings);
      const result = await vault.appendToNote(path, text, { createIfMissing: true });
      if (!result.ok) return textResult({ error: result.error, date: targetDate, path });
      return textResult({ ok: true, date: targetDate, path, created: result.created });
    },
  );

  server.tool(
    "appendToNote",
    "Append a Markdown block to the end of an existing note. Fails with NOT_FOUND when the note does not exist. Requires the vault:append scope.",
    {
      vaultId: z.string().min(1).max(128).optional().describe("Immutable vault ID; omit for the default vault."),
      path: z.string().min(1).describe("Vault-relative Markdown path, e.g. Projects/Plan.md"),
      text: z.string().min(1).max(20_000).describe("Markdown block to append."),
    },
    async ({ path, text, vaultId }) => {
      const vault = await readyVault("vault:append", vaultId);
      const result = await vault.appendToNote(path, text);
      if (!result.ok) {
        if (result.error === "NOT_FOUND") {
          const paths = await vault.listMarkdownPaths();
          return textResult({
            error: "NOT_FOUND",
            path,
            similarPaths: suggestSimilarPaths(paths, path),
          });
        }
        return textResult({ error: result.error, path });
      }
      return textResult({ ok: true, path });
    },
  );

  server.tool(
    "writeNote",
    "Create or overwrite a vault note. Overwriting an existing note requires expectedContentHash (the contentHash returned by readNote), which detects concurrent edits. Prefer appendToDailyNote/appendToNote when appending is enough. Requires the vault:write scope.",
    {
      vaultId: z.string().min(1).max(128).optional().describe("Immutable vault ID; omit for the default vault."),
      path: z.string().min(1).describe("Vault-relative Markdown path, e.g. Projects/Plan.md"),
      content: z.string().max(200_000).describe("Full note content (replaces the existing content)."),
      expectedContentHash: z
        .string()
        .optional()
        .describe("contentHash from readNote of the version being replaced. Required when the note already exists."),
    },
    async ({ path, content, expectedContentHash, vaultId }) => {
      const vault = await readyVault("vault:write", vaultId);
      const current = await vault.readNote(path);
      if (current != null && !expectedContentHash) {
        return textResult({
          error: "HASH_REQUIRED",
          path,
          message: "Note already exists. Call readNote first and pass its contentHash as expectedContentHash.",
        });
      }
      const result = await vault.writeNote(path, content, current == null ? await hashText("") : expectedContentHash!);
      if (!result.ok) return textResult({ error: result.error, path });
      return textResult({ ok: true, path, created: current == null });
    },
  );

  server.tool(
    "vaultStatus",
    "Show vault connection state and search index progress. Useful when other tools fail or search returns nothing.",
    { vaultId: z.string().min(1).max(128).optional() },
    async ({ vaultId }) => {
      requireScope("vault:read");
      const vault = await ctx.vault(vaultId);
      if (vaultId && vault && (vault.ref.vaultId ?? vault.ref.databaseName) !== vaultId)
        throw new Error("Vault selection mismatch");
      if (!vault || !(await vault.exists())) {
        return textResult({ connected: false, index: null });
      }
      const index = await vault.indexStatus();
      return textResult({ connected: true, timeZone: vault.policy.timeZone, index });
    },
  );
  server.tool(
    "listVaults",
    "List vaults the current principal can access; IDs survive display-name changes.",
    {},
    async () => {
      requireScope("vault:read");
      if (ctx.listVaults) return textResult({ vaults: await ctx.listVaults() });
      const vault = await ctx.vault();
      return textResult({
        vaults: vault
          ? [{ vaultId: vault.ref.vaultId ?? vault.ref.databaseName, displayName: vault.ref.databaseName }]
          : [],
      });
    },
  );
  server.tool(
    "listFiles",
    "List notes and binary attachments in one vault.",
    { vaultId: z.string().optional() },
    async ({ vaultId }) => {
      const vault = await readyVault("vault:read", vaultId);
      if (!vault.listFiles) throw new Error("Attachment operations are unavailable");
      return textResult({ files: await vault.listFiles() });
    },
  );
  server.tool(
    "readAttachment",
    "Read the original binary attachment as base64 (maximum 10 MiB).",
    {
      vaultId: z.string().optional(),
      path: z.string().min(1),
    },
    async ({ vaultId, path }) => {
      const vault = await readyVault("vault:read", vaultId);
      if (!vault.readAttachment) throw new Error("Attachment operations are unavailable");
      return textResult((await vault.readAttachment(path)) ?? { error: "NOT_FOUND", path });
    },
  );
  server.tool(
    "uploadAttachment",
    "Create or replace a binary attachment without changing its vault path. Requires vault:write and the previous contentHash when overwriting. Maximum 10 MiB decoded.",
    {
      vaultId: z.string().optional(),
      path: z.string().min(1),
      base64: z.string().max(Math.ceil(REQUEST_LIMITS.maxAttachmentBytes / 3) * 4),
      contentType: z.string().max(200).optional(),
      expectedContentHash: z.string().optional(),
    },
    async ({ vaultId, path, base64, contentType, expectedContentHash }) => {
      const vault = await readyVault("vault:write", vaultId);
      if (!vault.readAttachment || !vault.writeAttachment) throw new Error("Attachment operations are unavailable");
      const current = await vault.readAttachment(path);
      if (current && !expectedContentHash) return textResult({ error: "HASH_REQUIRED", path });
      const result = await vault.writeAttachment(
        path,
        base64,
        current ? expectedContentHash! : await hashText(""),
        contentType,
      );
      return textResult(result);
    },
  );
}
