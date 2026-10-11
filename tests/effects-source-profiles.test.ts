import { describe, expect, it } from "vitest";
import { BEATMAKING_EFFECT_CHAINS } from "../src/effects/chains";
import { CORE_EFFECT_PRESETS } from "../src/effects/presets";
import { SOURCE_PROFILE_IDS, SOURCE_PROFILES } from "../src/effects/sourceProfiles";

/**
 * Source-first macro dock data — the beatmaker's quick-start surface. A
 * broken profile here means a dock button that loads a chain with dead
 * macros, so the whole table gets coherence pins: ids unique, chains exist,
 * macro targets point at REAL slots inside their chain, and macro defaults
 * are valid positions on every one of their target lerps.
 */

describe("SOURCE_PROFILES — table shape", () => {
  it("covers exactly the declared profile ids, each once", () => {
    const ids = SOURCE_PROFILES.map((p) => p.id);
    expect([...ids].sort()).toEqual([...SOURCE_PROFILE_IDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every profile has label, description and 2–4 macros with unique labels", () => {
    for (const profile of SOURCE_PROFILES) {
      expect(profile.label.length).toBeGreaterThan(0);
      expect(profile.description.length).toBeGreaterThan(0);
      expect(profile.macros.length).toBeGreaterThanOrEqual(2);
      expect(profile.macros.length).toBeLessThanOrEqual(4);
      const labels = profile.macros.map((m) => m.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it("every chainId resolves to a real beatmaking chain", () => {
    const chainIds = new Set(BEATMAKING_EFFECT_CHAINS.map((c) => c.id));
    for (const profile of SOURCE_PROFILES) {
      expect(chainIds.has(profile.chainId), `${profile.id} → ${profile.chainId}`).toBe(true);
    }
  });
});

describe("SOURCE_PROFILES — macro targets are chain-coherent", () => {
  const chainById = new Map(BEATMAKING_EFFECT_CHAINS.map((c) => [c.id, c]));

  it("target slots exist inside the referenced chain", () => {
    for (const profile of SOURCE_PROFILES) {
      const chain = chainById.get(profile.chainId)!;
      for (const macroDef of profile.macros) {
        for (const target of macroDef.targets) {
          expect(
            target.slot,
            `${profile.id}.${macroDef.label} slot ${target.slot} vs ${chain.id} (${chain.effects.length} slots)`,
          ).toBeLessThan(chain.effects.length);
          expect(target.slot).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("macro defaults are valid positions and targets are finite, ordered lerps", () => {
    for (const profile of SOURCE_PROFILES) {
      for (const macroDef of profile.macros) {
        expect(macroDef.defaultValue, `${profile.id}.${macroDef.label} default`).toBeGreaterThanOrEqual(0);
        expect(macroDef.defaultValue).toBeLessThanOrEqual(1);
        for (const t of macroDef.targets) {
          expect(Number.isFinite(t.from)).toBe(true);
          expect(Number.isFinite(t.to)).toBe(true);
          // A macro that moves a param from X to X is a dead knob — forbid it.
          expect(t.from, `${profile.id}.${macroDef.label} → ${t.paramId}`).not.toBe(t.to);
          expect(t.paramId.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("each macro moves at least one knob (no decorative rows in the dock)", () => {
    for (const profile of SOURCE_PROFILES) {
      for (const macroDef of profile.macros) {
        expect(macroDef.targets.length, `${profile.id}.${macroDef.label}`).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

describe("BEATMAKING_EFFECT_CHAINS — every item resolves to a real factory preset", () => {
  const presetById = new Map(CORE_EFFECT_PRESETS.map((preset) => [preset.id, preset]));

  it("preset ids exist and match the declared effect type", () => {
    // applyEffectChainPreset throws on a missing/mismatched preset — a dead
    // chain entry would surface as a broken +CHAIN item, not a silent no-op.
    for (const chain of BEATMAKING_EFFECT_CHAINS) {
      for (const item of chain.effects) {
        const preset = presetById.get(item.presetId);
        expect(preset, `${chain.id} → ${item.presetId}`).toBeDefined();
        expect(preset!.type, `${chain.id} → ${item.presetId}`).toBe(item.type);
      }
    }
  });

  it("ships the BASS PHONE READY chain (GROW + air EQ)", () => {
    const chain = BEATMAKING_EFFECT_CHAINS.find((candidate) => candidate.id === "bass-phone-ready");
    expect(chain).toBeDefined();
    expect(chain!.effects.map((item) => item.type)).toEqual(["bassHarmonic", "eq"]);
    expect(chain!.effects[0]!.presetId).toBe("bassharmonic-808-phone");
    expect(chain!.effects[1]!.presetId).toBe("eq-air");
  });
});
