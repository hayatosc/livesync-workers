import { expect, it } from "vitest";
import { decodeMirrorPiece } from "../src/storage/file-mirror-codec.js";
import { MirrorHash } from "../src/storage/file-mirror-hash.js";

it("decodes base64 and surrogate pairs across arbitrary source boundaries", () => {
  const decode = (type: "plain" | "newnote", pieces: string[]) => {
    const state = { carry: "", padded: false };
    return Uint8Array.from(pieces.flatMap(piece => Array.from(decodeMirrorPiece(type, piece, state)))
      .concat(Array.from(decodeMirrorPiece(type, "", state, true))));
  };
  for (const value of ["YQ==", "YWJjZA==", "YWJjZA", "YWJjZGU=", " YW\nJj\tZA==\r ", ""]) {
    for (let offset = 0; offset <= value.length; offset++) {
      expect(decode("newnote", [value.slice(0, offset), value.slice(offset)]))
        .toEqual(Uint8Array.from(atob(value), char => char.charCodeAt(0)));
    }
  }
  for (const text of ["日本語 😀\r\n", "\ud800x\udfff", "\ud800"]) {
    for (let offset = 0; offset <= text.length; offset++) {
      expect(decode("plain", [text.slice(0, offset), text.slice(offset)])).toEqual(new TextEncoder().encode(text));
    }
  }
  for (const value of ["A", "YQ===", "Y=Q=", "YQ==YQ==", "YWJj_", "YQ="]) {
    expect(() => decode("newnote", Array.from(value))).toThrow("INVALID_ENCODING");
  }
});

it("resumes SHA-256 at non-block boundaries and rejects invalid saved state", async () => {
  const hash = new MirrorHash();
  hash.update(new TextEncoder().encode("a"));
  const state = hash.save();
  expect(state.length).toBeLessThan(4096);
  const resumed = new MirrorHash();
  resumed.load(state);
  resumed.update(new TextEncoder().encode("bc"));
  expect(resumed.digest()).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const empty = new MirrorHash();
  expect(empty.digest()).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(() => new MirrorHash().load('{"state":[]}')).toThrow("Invalid mirror hash checkpoint");
});
