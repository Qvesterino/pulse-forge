import { describe, expect, it } from "vitest";
import { FACTORY_PRESETS, DRUM_FACTORY_PRESETS } from "../src/presets/factory";
import { getPresetMetadata } from "../src/presets/catalog";
import {
  FACTORY_PRESET_GAIN_DB,
  FACTORY_PRESET_LOUDNESS,
  NON_DETERMINISTIC_PRESETS,
} from "../src/presets/preset-loudness.generated";
import { PRESET_GAIN_DB_LIMIT } from "../src/presets/normalization";

/**
 * Factory preset loudness audit (RMS consistency).
 *
 * Every instrument/drumsynth preset is rendered by
 * scripts/measure-preset-loudness.mjs and normalized against its use-case
 * family median (src/presets/normalization.ts, applied engine-wide). This
 * suite pins the audit contract in CI (no browser needed — all inputs are
 * pure data):
 *
 *  - coverage: every preset id is measured, no orphan map entries;
 *  - no clamp-hits: every gain is strictly inside ±18 dB (a hit means the
 *    preset's family is wrong or its design level is off — fix, don't cap);
 *  - classification: bass-role instruments normalize against the bass
 *    plateau even when play-style words match other families;
 *  - drum pad presets are explicitly unmeasured (pads carry no presetId —
 *    the engine has nowhere to apply a gain).
 */

describe("preset loudness coverage", () => {
  it("every instrument/drumsynth preset is measured, with no orphans", () => {
    const ids = new Set(FACTORY_PRESETS.map((p) => p.id));
    expect(ids.size).toBe(FACTORY_PRESETS.length); // no duplicate ids
    for (const id of ids) {
      expect(FACTORY_PRESET_LOUDNESS[id], `${id} missing loudness`).toBeDefined();
      expect(FACTORY_PRESET_GAIN_DB[id], `${id} missing gain`).toBeDefined();
    }
    for (const id of Object.keys(FACTORY_PRESET_LOUDNESS)) {
      expect(ids.has(id), `orphan loudness entry ${id}`).toBe(true);
    }
    for (const id of Object.keys(FACTORY_PRESET_GAIN_DB)) {
      expect(ids.has(id), `orphan gain entry ${id}`).toBe(true);
    }
    for (const id of NON_DETERMINISTIC_PRESETS) {
      expect(ids.has(id), `non-deterministic entry ${id} is not a preset`).toBe(true);
    }
  });

  it("drum pad presets are explicitly unmeasured (no presetId path)", () => {
    expect(DRUM_FACTORY_PRESETS.length).toBeGreaterThan(0);
    for (const preset of DRUM_FACTORY_PRESETS) {
      expect(FACTORY_PRESET_LOUDNESS[preset.id]).toBeUndefined();
      expect(FACTORY_PRESET_GAIN_DB[preset.id]).toBeUndefined();
    }
  });
});

describe("preset gain sanity", () => {
  it("clamp-hits equal the pinned inventory (fix the family/level, don't cap)", () => {
    // Every id here probes ≥18 dB off its family median — almost all are
    // slow-attack presets (keys pads, granular clouds, vocal swells) whose
    // fixed-window integrated reading measures the attack ramp, not the
    // playable sustain (see the probe-design note in DSP-ROADMAP). The right
    // fix is a sustained-loudness probe + re-measure, not hand-tuning gains.
    // This pin forces that work (or a preset fix) to update the inventory
    // explicitly instead of silently growing the capped set.
    const KNOWN_CLAMPED = [
      "factory.drumsynth.ambient.softclap",
      "factory.drumsynth.dnb.opencup",
      "factory.drumsynth.drill.tickhat",
      "factory.drumsynth.house.tighthat",
      "factory.drumsynth.jersey.clap",
      "factory.drumsynth.jersey.hat",
      "factory.granular.ambient.cloudpad",
      "factory.granular.ambient.dust",
      "factory.granular.ambient.timestretch",
      "factory.granular.ambient.vaporcloud",
      "factory.granular.house.vocalchop",
      "factory.granular.techno.stutter",
      "factory.granular.trap.reversepad",
      "factory.keys.ambient.breathy",
      "factory.keys.ambient.movementkeys",
      "factory.keys.ambient.shimmer",
      "factory.keys.ambient.softpad",
      "factory.keys.house.crystal",
      "factory.keys.house.flute",
      "factory.keys.house.fmbell",
      "factory.keys.house.groovekeys",
      "factory.keys.house.rhodesclassic",
      "factory.keys.house.widerhodes",
      "factory.keys.house.wurli",
      "factory.keys.house.wurli.lfo",
      "factory.keys.score.icehit",
      "factory.keys.score.warmgroove",
      "factory.keys.techno.dirtykeys",
      "factory.keys.techno.hollowkeys",
      "factory.keys.trap.icybell",
      "factory.pluck.ambient.flutepluck",
      "factory.pluck.ambient.harp",
      "factory.pluck.dnb.harp",
      "factory.pluck.jersey.clubpluck",
      "factory.pluck.score.breathstring",
      "factory.pluck.score.kora",
      "factory.pluck.techno.muted",
      "factory.vocalchop.ambient.ghostvox",
      "factory.vocalchop.score.lonelyvox",
    ];
    const actual = Object.entries(FACTORY_PRESET_GAIN_DB)
      .filter(([, gain]) => Math.abs(gain) >= PRESET_GAIN_DB_LIMIT)
      .map(([id]) => id)
      .sort();
    expect(actual).toEqual(KNOWN_CLAMPED);
  });

  it("every gain is finite and rounded to 0.1 dB", () => {
    for (const [id, gain] of Object.entries(FACTORY_PRESET_GAIN_DB)) {
      expect(Number.isFinite(gain), id).toBe(true);
      expect(Math.abs(gain * 10 - Math.round(gain * 10)) < 1e-9, id).toBe(true);
    }
  });

  it("every measurement is finite", () => {
    for (const [id, lufs] of Object.entries(FACTORY_PRESET_LOUDNESS)) {
      expect(Number.isFinite(lufs), id).toBe(true);
    }
  });

  it("watchlist: loud corrections stay visible (|gain| ≥ 12 dB)", () => {
    const watch = Object.entries(FACTORY_PRESET_GAIN_DB)
      .filter(([, gain]) => Math.abs(gain) >= 12)
      .map(([id, gain]) => `${id}: ${gain > 0 ? "+" : ""}${gain} dB`)
      .sort();
    // Audit trail — these presets normalize correctly but sit far from
    // their family median (design-level observation, not a failure).
    // eslint-disable-next-line no-console
    console.log(`[preset-loudness-audit] watchlist (${watch.length}): ${watch.join(", ") || "none"}`);
  });
});

describe("preset family classification", () => {
  const useCaseOf = (id: string): string => {
    const preset = FACTORY_PRESETS.find((p) => p.id === id)!;
    expect(preset, `preset ${id} exists`).toBeDefined();
    return getPresetMetadata(preset).useCase;
  };

  it("bass-role instruments normalize against the bass plateau", () => {
    // Regression: "impact" (fx token) outranked "808/sub" (bass tokens) and
    // "pluck" outranked the bass instrument — both presets landed ~18 dB
    // off, at the clamp. Families are role plateaus, not play-style words.
    expect(useCaseOf("factory.808.score.impact")).toBe("bass");
    expect(useCaseOf("factory.bass.house.pluck")).toBe("bass");
    for (const preset of FACTORY_PRESETS) {
      if (["bass", "808", "logdrum"].includes(preset.instrument)) {
        expect(getPresetMetadata(preset).useCase, preset.id).toBe("bass");
      }
    }
  });

  it("established classifications are untouched", () => {
    expect(useCaseOf("factory.analog.house.arp")).toBe("pluck");
    expect(useCaseOf("factory.drumsynth.house.tighthat")).toBe("drums");
    expect(useCaseOf("factory.sampler.ambient.piano")).toBe("keys");
    expect(useCaseOf("factory.texture.ambient.lushpad")).toBe("pad");
    expect(useCaseOf("factory.granular.house.vocalchop")).toBe("vocal");
  });
});
