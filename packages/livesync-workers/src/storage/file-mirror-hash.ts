import { SHA256 } from "@stablelib/sha256";

export const MIRROR_HASH_FORMAT = "@stablelib/sha256/2.0.1/v1";
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Uses the library's public checkpoint API; no dynamic Wasm compilation. */
export class MirrorHash {
  private readonly hash = new SHA256();
  update(bytes: Uint8Array): void { this.hash.update(bytes); }
  digest(): string { return hex(this.hash.digest()); }
  save(): string {
    const state = this.hash.saveState();
    return JSON.stringify({ state: Array.from(state.state), buffer: state.buffer ? Array.from(state.buffer) : null,
      bufferLength: state.bufferLength, bytesHashed: state.bytesHashed });
  }
  load(text: string): void {
    const saved: unknown = JSON.parse(text);
    if (!saved || typeof saved !== "object" || !("state" in saved) || !("buffer" in saved) ||
        !("bufferLength" in saved) || !("bytesHashed" in saved) ||
        !Array.isArray(saved.state) || saved.state.length !== 8 || !saved.state.every(Number.isInteger) ||
        saved.buffer !== null && (!Array.isArray(saved.buffer) || saved.buffer.length > 128 || !saved.buffer.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) ||
        typeof saved.bufferLength !== "number" || !Number.isInteger(saved.bufferLength) || saved.bufferLength < 0 || saved.bufferLength >= 64 ||
        typeof saved.bytesHashed !== "number" || !Number.isSafeInteger(saved.bytesHashed) || saved.bytesHashed < 0 ||
        saved.bufferLength !== saved.bytesHashed % 64 || saved.bufferLength > 0 && (!Array.isArray(saved.buffer) || saved.buffer.length < saved.bufferLength)) {
      throw new Error("Invalid mirror hash checkpoint");
    }
    this.hash.restoreState({ state: Int32Array.from(saved.state), buffer: saved.buffer === null ? undefined : Uint8Array.from(saved.buffer),
      bufferLength: saved.bufferLength, bytesHashed: saved.bytesHashed });
  }
}
