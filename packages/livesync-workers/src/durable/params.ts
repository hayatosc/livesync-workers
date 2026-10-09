// Request body and query parameter parsing for the CouchDB-compatible API.
import { readBoundedJson } from "../livesync/limits.js";

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  return readBoundedJson(request);
}

export function normalizeSince(value: unknown, currentSeq: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  if (value === "now") return currentSeq;
  return 0;
}


export function boolParam(value: unknown): boolean {
  return value === true || value === "true";
}

export function allDocsKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith('"')) return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}
