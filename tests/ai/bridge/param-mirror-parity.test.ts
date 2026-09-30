import { describe, expect, it } from "vitest";
import { EFFECT_DEFS } from "../../../src/effects/registry";
import { COMPRESSOR_RANGES } from "../../../src/ai/bridge/compressorSlots";
import { EQ_BANDS } from "../../../src/ai/bridge/eqSlots";
import { SIDECHAIN_RANGES } from "../../../src/ai/bridge/sidechainSlots";
import { REVERB_RANGES, DELAY_RANGES } from "../../../src/ai/bridge/spaceSlots";
import { HAAS_RANGES, MSEQ_RANGES } from "../../../src/ai/bridge/stereoSlots";
import { TRANSIENT_RANGES } from "../../../src/ai/bridge/transientSlots";

/**
 * AUDIT (intent, 2026-09-30) — registry ↔ AI-bridge parameter parity.
 *
 * The AI bridge's per-effect range tables are HAND-MAINTAINED MIRRORS of the
 * `ParamDef` whitelist in `src/effects/definitions.ts` (reached here through
 * `EFFECT_DEFS`). They are the bridge's validation surface: a key the mirror does
 * not know about is a real, engine-backed parameter that the AI layer cannot
 * range-check, and a value the mirror believes exists but the registry dropped
 * would be clamped away by `normalizeEffects` and the effect would silently do
 * nothing.
 *
 * This has already broken once: the DE-ESS feature added `scMode` / `scBandHz`
 * to the compressor, and `COMPRESSOR_RANGES` was not updated, so every
 * bridge-written compressor carried two params its own contract disowned
 * (`tests/ai/bridge/compressor.test.ts` caught it as
 * `expected [ Array(10) ] to include 'scMode'`).
 *
 * These assertions make the mirror a checked invariant instead of a convention.
 */

type Range = { min: number; max: number; default: number };
type Mirror = Record<string, Range>;

/** Param ids from an effect definition, with the numeric range metadata. */
function registryParams(effectType: keyof typeof EFFECT_DEFS): Map<string, Range> {
  const def = EFFECT_DEFS[effectType] as { params?: { id: string; min: number; max: number; default: number }[] };
  const out = new Map<string, Range>();
  for (const p of def.params ?? []) out.set(p.id, { min: p.min, max: p.max, default: p.default });
  return out;
}

const MIRRORS: Array<{ label: string; effect: keyof typeof EFFECT_DEFS; mirror: Mirror }> = [
  { label: "COMPRESSOR_RANGES", effect: "compressor", mirror: COMPRESSOR_RANGES as unknown as Mirror },
  { label: "SIDECHAIN_RANGES", effect: "sidechain", mirror: SIDECHAIN_RANGES as unknown as Mirror },
  { label: "REVERB_RANGES", effect: "reverb", mirror: REVERB_RANGES as unknown as Mirror },
  { label: "DELAY_RANGES", effect: "delay", mirror: DELAY_RANGES as unknown as Mirror },
  { label: "HAAS_RANGES", effect: "haasWidener", mirror: HAAS_RANGES as unknown as Mirror },
  { label: "MSEQ_RANGES", effect: "msEq", mirror: MSEQ_RANGES as unknown as Mirror },
  { label: "TRANSIENT_RANGES", effect: "transient", mirror: TRANSIENT_RANGES as unknown as Mirror },
];

describe("AI bridge ↔ effect registry parameter parity", () => {
  for (const { label, effect, mirror } of MIRRORS) {
    describe(label, () => {
      const registry = registryParams(effect);

      it("the registry actually exposes the params this table claims to mirror", () => {
        expect(
          registry.size,
          `${label} mirrors "${effect}" but that definition exposes no params — the effect key or the table is wrong`,
        ).toBeGreaterThan(0);
      });

      it("covers every registry param (no unknown-to-the-bridge keys)", () => {
        const missing = [...registry.keys()].filter((id) => !(id in mirror));
        expect(
          missing,
          `${label} is missing ${missing.join(", ")} — the AI layer cannot range-check these; ` +
            `the bridge would emit params its own contract disowns (the scMode/scBandHz regression)`,
        ).toEqual([]);
      });

      it("invents no param the registry does not have (no dead keys)", () => {
        const extra = Object.keys(mirror).filter((id) => !registry.has(id));
        expect(
          extra,
          `${label} declares ${extra.join(", ")} but "${effect}" has no such param — ` +
            `normalizeEffects would strip these and the effect would silently do nothing`,
        ).toEqual([]);
      });

      it("mirrors min/max/default exactly, not approximately", () => {
        const drift: string[] = [];
        for (const [id, r] of registry) {
          const m = mirror[id];
          if (!m) continue;
          if (m.min !== r.min || m.max !== r.max || m.default !== r.default) {
            drift.push(
              `${id}: bridge[${m.min}..${m.max} d=${m.default}] vs registry[${r.min}..${r.max} d=${r.default}]`,
            );
          }
        }
        expect(drift, `${label} range drift vs the registry:\n  ${drift.join("\n  ")}`).toEqual([]);
      });

      it("has a default inside its own range (a bridge-inserted effect must be legal)", () => {
        for (const [id, m] of Object.entries(mirror)) {
          expect(
            Number.isFinite(m.default) && m.default >= m.min && m.default <= m.max,
            `${label}.${id} default ${m.default} is outside [${m.min}, ${m.max}]`,
          ).toBe(true);
        }
      });
    });
  }

  it("EQ_BANDS gain/frequency ids all exist on the eq definition", () => {
    const registry = registryParams("eq");
    const bad: string[] = [];
    for (const [band, spec] of Object.entries(EQ_BANDS)) {
      if (spec.gainId && !registry.has(spec.gainId)) bad.push(`${band} → gainId "${spec.gainId}"`);
    }
    expect(
      bad,
      `EQ_BANDS points at params the eq definition does not expose; applyEqMove would throw at execution time:\n  ${bad.join("\n  ")}`,
    ).toEqual([]);
  });
});
