/** Decoder state is persisted with the source cursor, never with canonical revisions. */
export type MirrorDecoderState = { carry: string; padded: boolean };

export function encodeBytes(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

export function decodeBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Calls consume at most 16K code units; concatenation is confined to one decoder piece. */
export function decodeMirrorPiece(type: "plain" | "newnote", input: string, state: MirrorDecoderState, final = false): Uint8Array {
  if (type === "plain") {
    let text = state.carry + input;
    state.carry = "";
    if (!final && text.length && /[\ud800-\udbff]/.test(text.at(-1)!)) {
      state.carry = text.at(-1)!;
      text = text.slice(0, -1);
    }
    return new TextEncoder().encode(text);
  }
  const clean = input.replace(/[\t\n\f\r ]/g, "");
  if (/[^A-Za-z0-9+/=]/.test(clean) || state.padded && clean.length) throw new Error("INVALID_ENCODING");
  let text = state.carry + clean;
  state.carry = "";
  if (text.includes("=")) {
    // Padding may itself be split between LiveSync children or decoder pieces.
    if (!final && text.endsWith("=") && text.length % 4 === 3 && !text.slice(0, -1).includes("=")) {
      const end = text.length - 3;
      state.carry = text.slice(end);
      text = text.slice(0, end);
    } else {
      if (text.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/.test(text)) throw new Error("INVALID_ENCODING");
      state.padded = true;
    }
  } else if (!final) {
    const end = text.length - text.length % 4;
    state.carry = text.slice(end);
    text = text.slice(0, end);
  } else if (text.length % 4 === 1) throw new Error("INVALID_ENCODING");
  return decodeBytes(text);
}
