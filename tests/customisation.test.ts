import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PAD_KEYS, bindPadKey, getPadKeys, initPadKeys, isPadKey, resetPadKeys } from "../src/ui/padKeys";
import { createDefaultProject, normalizeProject } from "../src/project-model/schema";
import { createInstrumentTrack, setPadColor, setPadLoop, setTrackColor } from "../src/commands/commands";
import { getDrumTrack, type InstrumentTrack } from "../src/project-model/types";
import { decodeBindsCode, encodeBindsCode } from "../src/export/bindsCode";
import { importPadKeys } from "../src/ui/padKeys";

describe("padKeys store", () => {
  beforeEach(() => {
    localStorage.clear();
    resetPadKeys();
  });

  it("defaults to the QWERTY two-row grid", () => {
    expect(getPadKeys()).toEqual([...DEFAULT_PAD_KEYS]);
    expect(isPadKey("q")).toBe(true);
    expect(isPadKey("1")).toBe(false);
  });

  it("bindPadKey swaps an occupied key instead of duplicating", () => {
    bindPadKey(0, "h"); // 'h' is slot 13's key — occupied, so the slots swap
    const keys = getPadKeys();
    expect(keys[0]).toBe("h");
    expect(keys[13]).toBe("q");
    // Uniqueness preserved.
    expect(new Set(keys).size).toBe(16);
  });

  it("rejects reserved and multi-character keys", () => {
    resetPadKeys();
    bindPadKey(0, " "); // reserved
    bindPadKey(0, "escape"); // reserved
    bindPadKey(0, "ab"); // multi-char
    expect(getPadKeys()[0]).toBe("q");
    expect(isPadKey("escape")).toBe(false);
  });

  it("persists across init (simulated reload)", () => {
    bindPadKey(0, "z");
    const loaded = initPadKeys();
    expect(loaded[0]).toBe("z");
  });
});

describe("setPadColor", () => {
  it("sets a hex colour on a pad and clears it with null", () => {
    let doc = createDefaultProject();
    const drum = getDrumTrack(doc);
    const padId = drum.pads[0].id;
    doc = setPadColor(doc, drum.id, padId, "#FF00AA").execute(doc);
    expect(getDrumTrack(doc).pads[0].color).toBe("#ff00aa");
    doc = setPadColor(doc, drum.id, padId, null).execute(doc);
    expect(getDrumTrack(doc).pads[0].color).toBeUndefined();
  });

  it("survives normalizeProject and drops invalid colours", () => {
    let doc = createDefaultProject();
    const drum = getDrumTrack(doc);
    doc = setPadColor(doc, drum.id, drum.pads[0].id, "#00cc88").execute(doc);
    doc = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.id === drum.id
          ? { ...t, pads: (t as typeof drum).pads.map((p, i) => (i === 1 ? { ...p, color: "not-a-color" } : p)) }
          : t,
      ),
    };
    const normalized = normalizeProject(doc);
    const pads = getDrumTrack(normalized).pads;
    expect(pads[0].color).toBe("#00cc88");
    expect(pads[1].color).toBeUndefined();
  });

  it("throws for unknown tracks and pads", () => {
    const doc = createDefaultProject();
    const drum = getDrumTrack(doc);
    expect(() => setPadColor(doc, "nope", drum.pads[0].id, "#00ff00")).toThrow(/not found/u);
    expect(() => setPadColor(doc, drum.id, "no-pad", "#00ff00")).toThrow(/not found/u);
  });
});

describe("setTrackColor", () => {
  it("works on instrument tracks too (collab-visible doc field)", () => {
    let doc = createDefaultProject();
    const inst = doc.tracks.find((t) => t.kind === "instrument")!;
    doc = setTrackColor(doc, inst.id, "#22d3ee").execute(doc);
    expect(doc.tracks.find((t) => t.id === inst.id)!.color).toBe("#22d3ee");
    const normalized = normalizeProject(doc);
    expect(normalized.tracks.find((t) => t.id === inst.id)!.color).toBe("#22d3ee");
  });
});

describe("setPadLoop", () => {
  it("arms a loop region on the pad and clears it", () => {
    let doc = createDefaultProject();
    const drum = getDrumTrack(doc);
    const padId = drum.pads[0].id;
    doc = setPadLoop(doc, drum.id, padId, true, 0.12, 0.48).execute(doc);
    let pad = getDrumTrack(doc).pads[0];
    expect(pad.sliceLoop).toBe(true);
    expect(pad.sliceLoopStart).toBeCloseTo(0.12, 4);
    expect(pad.sliceLoopEnd).toBeCloseTo(0.48, 4);
    // Loop must survive normalization (schema sanitize).
    const normalized = normalizeProject(doc);
    expect(getDrumTrack(normalized).pads[0].sliceLoop).toBe(true);
    doc = setPadLoop(doc, drum.id, padId, false).execute(doc);
    expect(getDrumTrack(doc).pads[0].sliceLoop).toBe(false);
  });

  it("rejects a too-short loop region", () => {
    const doc = createDefaultProject();
    const drum = getDrumTrack(doc);
    expect(() => setPadLoop(doc, drum.id, drum.pads[0].id, true, 0.1, 0.1)).toThrow(/too short/u);
  });
});

describe("sampler pitch + ADSR params", () => {
  it("exposes the full ADSR and pitch envelope controls", () => {
    const doc = createDefaultProject();
    const samplerTrack = createInstrumentTrack(doc, "sampler").execute(doc);
    const track = samplerTrack.tracks.find(
      (t): t is InstrumentTrack => t.kind === "instrument" && t.instrument === "sampler",
    )!;
    // Sanity: a fresh sampler track carries the new params with safe defaults.
    expect(track.params.sustain).toBe(1); // legacy hold-at-peak default
    expect(track.params.decay).toBeGreaterThan(0);
    expect(track.params.pitchDrop).toBe(0);
    expect(track.params.loopStart).toBe(0);
    expect(track.params.loopEnd).toBe(1);
  });
});

describe("BINDS share codes", () => {
  it("round-trips a keymap through encode/decode", () => {
    const keys = ["z", "x", "c", "v", "a", "s", "d", "f", "1", "2", "3", "4", "5", "6", "7", "8"];
    const code = encodeBindsCode(keys);
    expect(code.startsWith("PFBIND1:")).toBe(true);
    const decoded = decodeBindsCode(code);
    expect(decoded).toEqual(keys);
  });

  it("rejects payloads that are not in the BINDS format", () => {
    // A raw base64 body is not lz-string compressed — decode fails cleanly.
    expect(decodeBindsCode("PFBIND1:" + btoa("not lz data"))).toBeNull();
  });

  it("rejects non-PFBIND strings", () => {
    expect(decodeBindsCode("hello")).toBeNull();
    expect(decodeBindsCode("")).toBeNull();
  });
});

describe("importPadKeys", () => {
  it("installs a keymap and persists it across init", () => {
    localStorage.clear();
    initPadKeys();
    importPadKeys(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "o", "p", "k", "l", "m", "n"]);
    const loaded = initPadKeys();
    expect(loaded.slice(0, 4)).toEqual(["1", "2", "3", "4"]);
  });
});
