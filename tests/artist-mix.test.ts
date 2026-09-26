import { describe, expect, it } from "vitest";
import { parseIntentText } from "../src/intent/text-parser";
import { normalizeIntent } from "../src/intent/normalize";
import { planMixProfile, masterTiltForIntent } from "../src/intent/mix";
import { ARTIST_MIX_PROFILES } from "../src/intent/artist-mix";

/**
 * ARTIST MIX SIGNATURES (Vlna 8) — "drake type beat" carries the drake
 * mix/master character, not just the groove/BPM. Artist signature sits
 * ABOVE the genre default but BELOW explicit user words.
 */

const normalize = (text: string) => normalizeIntent(parseIntentText(text).input);

describe("artist mix signatures", () => {
  it("every signature key is a real roster label", async () => {
    const { ARTIST_PRESETS } = await import("../src/intent/artists");
    for (const key of Object.keys(ARTIST_MIX_PROFILES)) {
      expect(
        ARTIST_PRESETS.some((p) => p.label === key),
        `signature "${key}" has no roster entry with that label`,
      ).toBe(true);
    }
  }, 30000);

  it("drake → dark tone + lush space (vs the trap dry default)", () => {
    const drake = planMixProfile(normalize("drake type beat"));
    expect(drake.summary).toContain("tone: dark");
    expect(drake.summary.join(" ")).toMatch(/lush reverb/);
    // The same ask WITHOUT the artist reference reads the trap dry default.
    const plain = planMixProfile(normalize("trap beat"));
    expect(plain.summary.join(" ")).toMatch(/drier/);
  });

  it("artist tone wins over the genre default but loses to explicit overrides", () => {
    // The MIX route extracts explicit comparatives into overrides (route.ts)
    // before calling planMixProfile — reproduce that call shape here.
    const brighter = planMixProfile(normalize("drake type beat"), { tone: "bright" });
    expect(brighter.summary).toContain("tone: bright");
  });

  it("fred again pumps even at lower energy (signature forces the pump)", () => {
    const profile = planMixProfile(normalize("fred again type beat at 120"));
    expect(profile.summary.join(" ")).toMatch(/pump: sidechain/i);
  });

  it("the song master tilt follows the artist signature", () => {
    // Seven lions (bright signature) on trap — trap has NO genre tilt
    // default, so the signature must supply the bright tilt (house's bright
    // value — the same tone table).
    const intent = normalize("seven lions type beat");
    expect(masterTiltForIntent(intent)).toBe(-1.5); // the bright tilt (mix.ts tone table)
    // No artist reference → the genre path (trap → undefined).
    expect(masterTiltForIntent(normalize("trap beat"))).toBeUndefined();
  });
});
