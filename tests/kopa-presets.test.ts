import { describe, expect, it } from "vitest";
import { KOPA_FACTORY_PRESETS } from "../src/presets/kopa-factory";
import { kopaParams } from "../src/instruments/definitions";
import { clampInstrumentParam } from "../src/instruments/definitions";
import { getPresetMetadata } from "../src/presets/catalog";
import { KopaProcessor } from "../src/kopa/dsp/kopaProcessor";

/**
 * KOPA factory presets (KOPA plan §3.5).
 *
 * The audit: every preset is a real kick (audible, finite, in-range), ids are
 * unique, and the catalog routes the instrument to the DRUMS plateau — a kick
 * that normalized against the bass family would audition ~9 dB off.
 */

const PARAM_IDS = new Set(kopaParams.map((param) => param.id));
const SR = 48000;
const BLOCK = 128;

function renderPreset(params: Record<string, number>, seconds = 0.6): Float32Array {
  const processor = new KopaProcessor({ sampleRate: SR });
  processor.applyParams({ ...Object.fromEntries(kopaParams.map((p) => [p.id, p.default])), ...params });
  processor.postEvent({ type: "noteOn", pitch: 36, velocity: 1, when: 0 });
  const frames = Math.ceil(seconds * SR);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let frame = 0;
  while (frame < frames) {
    const count = Math.min(BLOCK, frames - frame);
    processor.process(left.subarray(frame, frame + count), right.subarray(frame, frame + count), frame);
    frame += count;
  }
  return left;
}

describe("KOPA factory presets — schema audit", () => {
  it("every preset is a KOPA instrument with a unique id and a real name", () => {
    const ids = new Set<string>();
    for (const preset of KOPA_FACTORY_PRESETS) {
      expect(preset.instrument, preset.id).toBe("kopa");
      expect(ids.has(preset.id), `duplicate id ${preset.id}`).toBe(false);
      ids.add(preset.id);
      expect(preset.name.length, preset.id).toBeGreaterThan(2);
    }
    expect(ids.size).toBe(KOPA_FACTORY_PRESETS.length);
    expect(KOPA_FACTORY_PRESETS.length).toBeGreaterThanOrEqual(16);
  });

  it("every parameter id exists in the KOPA schema", () => {
    for (const preset of KOPA_FACTORY_PRESETS) {
      for (const key of Object.keys(preset.params)) {
        expect(PARAM_IDS.has(key), `${preset.id} carries unknown param "${key}"`).toBe(true);
      }
    }
  });

  it("every value is inside its declared range (no preset clamps on load)", () => {
    for (const preset of KOPA_FACTORY_PRESETS) {
      for (const [key, value] of Object.entries(preset.params)) {
        const clamped = clampInstrumentParam("kopa", key, value);
        expect(clamped, `${preset.id}.${key}=${value} clamps to ${clamped}`).toBe(value);
      }
    }
  });

  it("covers the discovery metadata the browser filters on", () => {
    for (const preset of KOPA_FACTORY_PRESETS) {
      expect(preset.genre, preset.id).not.toBeNull();
      expect(preset.mood.length, preset.id).toBeGreaterThan(0);
      expect(preset.tags.length, preset.id).toBeGreaterThan(1);
    }
  });

  it("the catalog routes KOPA to the DRUMS plateau (not bass)", () => {
    for (const preset of KOPA_FACTORY_PRESETS) {
      const metadata = getPresetMetadata(preset);
      expect(metadata.useCase, preset.id).toBe("drums");
    }
  });

  it("every preset renders an audible, finite kick (peak > 0.02, no NaN/Inf)", () => {
    for (const preset of KOPA_FACTORY_PRESETS) {
      const left = renderPreset(preset.params);
      let peak = 0;
      for (const value of left) {
        expect(Number.isFinite(value), `${preset.id} produced non-finite samples`).toBe(true);
        peak = Math.max(peak, Math.abs(value));
      }
      expect(peak, `${preset.id} is silent (peak=${peak})`).toBeGreaterThan(0.02);
      expect(peak, `${preset.id} exceeds headroom (peak=${peak})`).toBeLessThanOrEqual(1.2);
    }
  });

  it("presets are not duplicates of one another (parameter fingerprints differ)", () => {
    const fingerprints = new Set(
      KOPA_FACTORY_PRESETS.map((preset) =>
        Object.entries(preset.params)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => `${key}=${value}`)
          .join(","),
      ),
    );
    expect(fingerprints.size).toBe(KOPA_FACTORY_PRESETS.length);
  });
});
