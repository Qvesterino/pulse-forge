import { describe, expect, it } from "vitest";
import { applyMasterMatchEqCommand } from "../src/commands/commands";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { referenceLoudnessTrim, setMatchEqReference } from "../src/intent/match-eq";
import { SONG_LOUDNESS_TRIM_LIMIT_DB } from "../src/intent/genre-reference.generated";

/**
 * REFERENCE MIX CONDITIONING (reference conditioning wave) — the LEVEL half
 * of "znej ako ref". The match EQ matches tonal shape; these tests pin the
 * loudness half: the reference's own BS.1770 loudness derives a master trim
 * clamped to the same ±6 dB the per-genre trim uses.
 */

const SR = 16000;

/** Sine at a given peak amplitude — its integrated LUFS is deterministic. */
function sinePcm(freq: number, seconds: number, amp: number): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

describe("referenceLoudnessTrim — derivation", () => {
  it("no reference → null; clearReference resets it", () => {
    setMatchEqReference(null);
    expect(referenceLoudnessTrim()).toBeNull();
    const pcm = sinePcm(220, 3, 0.5);
    setMatchEqReference(pcm);
    expect(referenceLoudnessTrim()).not.toBeNull();
    setMatchEqReference(null);
    expect(referenceLoudnessTrim()).toBeNull();
  });

  it("a loud master reference → positive trim, a dynamic one → negative", () => {
    // sine LUFS ≈ −0.69 − 3.01 + 20·log10(amp): 0.5 → ≈ −10.7 (loud master),
    // 0.12 → ≈ −19.5 (dynamic master). Match moves the trim toward the ref.
    setMatchEqReference(sinePcm(220, 3, 0.5));
    const loudTrim = referenceLoudnessTrim();
    setMatchEqReference(sinePcm(220, 3, 0.12));
    const dynTrim = referenceLoudnessTrim();
    expect(loudTrim).not.toBeNull();
    expect(dynTrim).not.toBeNull();
    expect(loudTrim!.trimDb).toBeGreaterThan(dynTrim!.trimDb);
    expect(loudTrim!.trimDb).toBeGreaterThan(0);
    expect(dynTrim!.trimDb).toBeLessThan(0);
    expect(loudTrim!.refLufs).toBeGreaterThan(dynTrim!.refLufs);
  });

  it("implausible reference loudness declines the level match (sanity window)", () => {
    // room-tone level: matching its level would ask for a −52 dB trim —
    // the derivation declines instead of clamping into nonsense.
    setMatchEqReference(sinePcm(220, 3, 0.001));
    expect(referenceLoudnessTrim()).toBeNull();
    // absurdly hot as well
    setMatchEqReference(sinePcm(220, 3, 1.4));
    expect(referenceLoudnessTrim()).toBeNull();
    setMatchEqReference(null);
  });

  it("trim respects the ±6 dB per-genre limit inside the window", () => {
    // ≈ −19.5 LUFS reference → raw −5.5 dB → inside the clamp
    setMatchEqReference(sinePcm(220, 3, 0.12));
    const trim = referenceLoudnessTrim();
    expect(trim).not.toBeNull();
    expect(Math.abs(trim!.trimDb)).toBeLessThanOrEqual(SONG_LOUDNESS_TRIM_LIMIT_DB);
  });

  it("shorter than one loudness block → null; round trip with another reference works", () => {
    setMatchEqReference(sinePcm(220, 0.2, 0.5));
    expect(referenceLoudnessTrim()).toBeNull();
    setMatchEqReference(sinePcm(440, 3, 0.4));
    const again = referenceLoudnessTrim();
    expect(again).not.toBeNull();
    // deterministic
    expect(referenceLoudnessTrim()).toEqual(again);
  });
});

describe("applyMasterMatchEqCommand — level half rides the same one-undo step", () => {
  it("installs matchEq + loudnessTrimDb in ONE command; undo restores both", () => {
    const doc = createProjectFromTemplate("house");
    const curve = { low: 1.5, lowMid: -0.5, highMid: 0, high: 3 };
    const command = applyMasterMatchEqCommand(doc, curve, 2.5);
    const next = command.execute(doc);
    expect(next.master.matchEq).toEqual(curve);
    expect(next.master.loudnessTrimDb).toBe(2.5);
    expect(command.label).toContain("Match EQ");
    expect(command.label).toContain("loudness +2.5 dB");
    const restored = command.undo(next) as typeof doc;
    expect(restored.master.matchEq).toEqual(doc.master.matchEq);
    expect(restored.master.loudnessTrimDb).toBe(doc.master.loudnessTrimDb);
  });

  it("undefined trim leaves the existing trim untouched", () => {
    const doc = createProjectFromTemplate("house");
    const before = doc.master.loudnessTrimDb;
    const command = applyMasterMatchEqCommand(doc, { low: 0, lowMid: 0, highMid: 0, high: 1 });
    const next = command.execute(doc);
    expect(next.master.loudnessTrimDb).toBe(before);
  });

  it("trim clamps to ±6 like every master level control", () => {
    const doc = createProjectFromTemplate("house");
    const next = applyMasterMatchEqCommand(doc, null, 12).execute(doc);
    expect(next.master.loudnessTrimDb).toBeLessThanOrEqual(SONG_LOUDNESS_TRIM_LIMIT_DB);
    const next2 = applyMasterMatchEqCommand(doc, null, -12).execute(doc);
    expect(next2.master.loudnessTrimDb).toBeGreaterThanOrEqual(-SONG_LOUDNESS_TRIM_LIMIT_DB);
  });
});
