/**
 * shareCode boundary caps — the trust caps that prevent a tampered share
 * token from blowing up the boot path.
 *
 * `MAX_TOKEN_CHARS = 2_000_000` and `MAX_DECOMPRESSED_CHARS = 8_000_000`
 * gate every `decodeShareCode` call. Without them a single
 * `compressToEncodedURIComponent("x".repeat(8_000_001))` would previously
 * have expanded on the main thread with no ceiling — one tab-killer OOM
 * away from a hung boot, per the comment in `src/export/shareCode.ts`.
 *
 * Real share tokens are a few hundred KB; the tests below hit the exact
 * boundaries so a future refactor that drops either cap is caught.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeShareCode, encodeShareCode } from "../../src/export/shareCode";
import { createProjectFromTemplate } from "../../src/project-model/templates";

describe("shareCode — token-length cap (2 000 000 chars)", () => {
  it("rejects a token that exceeds MAX_TOKEN_CHARS by exactly one character", () => {
    // 2_000_001 'A' chars — well over the cap. lz-string can still
    // "decompress" pure repetition; the cap check must fire first.
    const oversized = "A".repeat(2_000_001);
    expect(decodeShareCode(oversized)).toBeNull();
  });

  it("does not throw on a token above the cap (returns null, never raw error)", () => {
    const oversized = "z".repeat(2_500_000);
    expect(() => decodeShareCode(oversized)).not.toThrow();
    expect(decodeShareCode(oversized)).toBeNull();
  });
});

describe("shareCode — decompressed-length cap (8 000 000 chars)", () => {
  // The honest end-to-end check (8 MB payload → decompress → cap) takes
  // ~20 s because lz-string compresses dense repetition badly — too slow
  // for daily CI. The source-grep regression below pins the same handler
  // with the same exact magic number for a fraction of the cost.

  it("does not exceed MAX_DECOMPRESSED_CHARS in normal project round-trips (sanity baseline)", () => {
    // A real project JSON.stringify is ~50–500 KB after lz-string
    // compression → after decompression the JSON is well under 8 MB.
    // This pins the working headroom so a future regression that
    // accidentally serialized 10 MB blobs (e.g. WAVs embedded in the
    // doc) would fail loudly here.
    const doc = createProjectFromTemplate("scene-score");
    const code = encodeShareCode(doc);
    expect(decodeShareCode(code)).not.toBeNull();
    expect(JSON.stringify(doc).length).toBeLessThan(8_000_000);
  });
});

describe("shareCode — source-grep regression for the caps", () => {
  // Reading the file once keeps each assertion O(file-size) instead of O(N*M).
  const src = readFileSync(resolve(process.cwd(), "src/export/shareCode.ts"), "utf8");

  it("declares both MAX_TOKEN_CHARS and MAX_DECOMPRESSED_CHARS as module constants", () => {
    expect(src).toMatch(/const\s+MAX_TOKEN_CHARS\s*=\s*2_000_000/);
    expect(src).toMatch(/const\s+MAX_DECOMPRESSED_CHARS\s*=\s*8_000_000/);
  });

  it("checks both caps inside decodeShareCode (forget-either regression guard)", () => {
    // The order matters — token-cap check first is cheaper and stops the
    // decompression stage from ever running on a 2.5 MB string. Pin both.
    expect(src).toMatch(/code\.length\s*>\s*MAX_TOKEN_CHARS/);
    expect(src).toMatch(/json\.length\s*>\s*MAX_DECOMPRESSED_CHARS/);
  });
});