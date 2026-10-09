// Vault paths and LiveSync note documents.
import { hashText } from "../search/chunk-md.js";
import { isHiddenPath, isReservedPath, type VaultPolicy } from "../types.js";
import type { DocBody } from "./rows.js";
import { WRITE_CHUNK_CODE_UNITS, WRITE_CHUNK_HASH_SALT, WRITE_CHUNK_PREFIX } from "./settings.js";

function isExcludedByFolders(path: string, excludedFolders: string[]): boolean {
  const normalized = path.replace(/^\/+|\/+$/g, "");
  return excludedFolders.some(
    (folder) => normalized === folder || normalized.startsWith(`${folder}/`),
  );
}

export function isIndexableMarkdownPath(path: string, policy: VaultPolicy): boolean {
  return (
    path.endsWith(".md") &&
    !isReservedPath(path, policy.reservedPaths) &&
    !isExcludedByFolders(path, policy.excludedFolders) &&
    // "i:" marks files LiveSync's hidden file sync carries (".obsidian/…").
    !(policy.excludeHiddenPaths && (path.startsWith("i:") || isHiddenPath(path)))
  );
}

export function isSafeVaultPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

export function isNoteDoc(doc: DocBody): doc is DocBody & { path: string } {
  return typeof doc.path === "string" && doc.type !== "leaf" && doc.type !== "chunkpack";
}

export function docIsDeleted(doc: DocBody): boolean {
  return doc._deleted === true || doc.deleted === true;
}

/** Split note content into LiveSync chunk pieces (surrogate-pair safe). */
export function splitNoteContentForChunks(content: string): string[] {
  const pieces: string[] = [];
  for (let start = 0; start < content.length;) {
    let end = Math.min(start + WRITE_CHUNK_CODE_UNITS, content.length);
    const lastCodeUnit = content.charCodeAt(end - 1);
    if (end < content.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
      end -= 1;
    }
    pieces.push(content.slice(start, end));
    start = end;
  }
  return pieces;
}

export async function writeChunkId(piece: string): Promise<string> {
  const digest = await hashText(`${WRITE_CHUNK_HASH_SALT}\n${piece.length}\n${piece}`);
  return `${WRITE_CHUNK_PREFIX}k${digest.slice(0, 40)}`;
}

/**
 * Derive a LiveSync document id for a path the way the plugin does without
 * path obfuscation: ids starting with "_" are prefixed with "/", and ids are
 * lower-cased when the vault appears to be using case-insensitive ids.
 */
export function noteDocIdForPath(path: string, caseInsensitive: boolean): string {
  let id = caseInsensitive ? path.toLowerCase() : path;
  if (id.startsWith("_")) id = `/${id}`;
  return id;
}
