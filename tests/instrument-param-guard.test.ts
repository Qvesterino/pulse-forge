import { describe, expect, it } from "vitest";
import { clampInstrumentParam, defaultInstrumentParams, INSTRUMENT_META } from "../src/instruments/definitions";
import { createInstrumentTrackModel, normalizeProject } from "../src/project-model/schema";
import { setInstrumentParam } from "../src/commands/instrument";
import { createProjectFromTemplate } from "../src/project-model/templates";
import type { InstrumentTrack, ProjectDocument } from "../src/project-model/types";

/**
 * PLUGIN AUDIT (re-run 2026-10) — instrument param guards.
 *
 * The effects side learned this lesson in clampEffectParam: Math.min/max both
 * return NaN unchanged, and a NaN reaching a voice graph's setTargetAtTime
 * throws TypeError in real browsers — killing the engine sync. The instrument
 * twin had NO finite guard, and normalizeProject copied KNOWN instrument param
 * keys verbatim (no type check, no finite check, no clamp) — a hostile/corrupt
 * doc put cutoff 1e308, NaN, or even a STRING into the runtime's setParameter.
 */

function instrumentDoc(): { doc: ProjectDocument; track: InstrumentTrack } {
  const base = createProjectFromTemplate("house");
  const track = createInstrumentTrackModel("analog", 0);
  const doc = { ...base, tracks: [...base.tracks, track] } as ProjectDocument;
  return { doc, track };
}

describe("instrument param finite guards", () => {
  it("clampInstrumentParam drops non-finite values to the def default (was NaN passthrough)", () => {
    expect(clampInstrumentParam("analog", "oscBDetune", Number.NaN)).toBe(8);
    expect(clampInstrumentParam("analog", "oscBDetune", Number.POSITIVE_INFINITY)).toBe(8);
    expect(clampInstrumentParam("analog", "oscBDetune", 999)).toBe(50);
    expect(clampInstrumentParam("analog", "oscBDetune", -999)).toBe(-50);
    // Unknown param ids still pass through untouched (forward compat).
    expect(clampInstrumentParam("analog", "futureParam", 7)).toBe(7);
  });

  it("setInstrumentParam stores the default for a NaN ask (command boundary)", () => {
    const { doc, track } = instrumentDoc();
    const cmd = setInstrumentParam(doc, track.id, "oscBDetune", Number.NaN);
    const next = cmd.execute(doc);
    const updated = next.tracks.find((t) => t.id === track.id) as InstrumentTrack;
    expect(Number.isFinite(updated.params.oscBDetune!)).toBe(true);
    expect(updated.params.oscBDetune).toBe(
      INSTRUMENT_META.analog.params.find((p) => p.id === "oscBDetune")!.default,
    );
  });

  it("normalizeProject clamps known instrument params on load (was verbatim copy)", () => {
    const { doc, track } = instrumentDoc();
    const defaults = defaultInstrumentParams("analog");
    const hostile = {
      ...doc,
      tracks: doc.tracks.map((t) =>
        t.id === track.id
          ? {
              ...t,
              params: {
                ...defaults,
                oscBDetune: 1e9, // out of range → clamped to 50
                cutoff: Number.NaN, // non-finite → default
                filterEnv: "loud", // wrong type → default
              },
            }
          : t,
      ),
    } as ProjectDocument;
    const normalized = normalizeProject(hostile);
    const healed = normalized.tracks.find((t) => t.id === track.id) as InstrumentTrack;
    expect(healed.params.oscBDetune).toBe(50);
    const cutoffDef = INSTRUMENT_META.analog.params.find((p) => p.id === "cutoff");
    if (cutoffDef) expect(healed.params.cutoff).toBe(cutoffDef.default);
    const envDef = INSTRUMENT_META.analog.params.find((p) => p.id === "filterEnv");
    if (envDef) expect(healed.params.filterEnv).toBe(envDef.default);
    // Every known key is finite post-normalize — the engine's setParameter
    // loop can never see a non-number.
    for (const def of INSTRUMENT_META.analog.params) {
      expect(Number.isFinite(healed.params[def.id]), `${def.id} finite`).toBe(true);
    }
  });

  it("normalizeProject is canonical: a clean instrument doc survives normalization identity", () => {
    const { doc, track } = instrumentDoc();
    const normalized = normalizeProject(doc);
    const healed = normalized.tracks.find((t) => t.id === track.id) as InstrumentTrack;
    expect(healed.params).toEqual(defaultInstrumentParams("analog"));
  });
});
