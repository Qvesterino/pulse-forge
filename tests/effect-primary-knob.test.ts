import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { EFFECT_META, EFFECT_PRIMARY_KNOB } from "../src/effects/definitions";
import { getEffectCatalogEntry } from "../src/plugin-catalog";
import type { EffectType } from "../src/project-model/types";

const types = Object.keys(EFFECT_META) as EffectType[];

/**
 * The effects with NO primary knob, and why. A knob-less effect is not a
 * defect — it is the honest answer for an effect whose knobs are musical
 * quantities (a band EQ), whose intensity the param layer already owns
 * (the width role owns `haasWidener.width`), whose knobs live behind dotted
 * ids (the namespaced flagships), or which is a toolbox rather than an
 * effect (`utility`).
 *
 * The list is the census: any effect NOT on it must declare a knob.
 */
const KNOB_LESS: Record<string, string> = {
  eq: "every knob is a musical quantity (bands)",
  msEq: "every knob is a musical quantity (bands)",
  haasWidener: "the width role owns `width` with calibrated semantics",
  utility: "a toolbox — gain/pan/width/DC, no single intensity",
  prud: "no fractional knob (two bands with dB amounts)",
  ultina: "namespaced knobs (global.*)",
  ozvena: "namespaced knobs (global.dryWet)",
  morphdynamics: "namespaced knobs (global.mix)",
};

/** The two knobs whose range is a musical quantity, not a share of the range. */
const MUSICAL: Record<string, string> = {
  compressor: "ratio",
  rezonans: "formant",
};

/** The knobs that were already the intent layer's answer — they must not move. */
const ESTABLISHED: Record<string, string> = {
  delay: "mix",
  reverb: "mix",
  saturation: "drive",
  distortion: "drive",
  chorus: "mix",
  flanger: "mix",
  phaser: "mix",
  tremolo: "mix",
  bitcrusher: "mix",
  compressor: "ratio",
  pump: "amount",
  sidechain: "amount",
  bassHarmonic: "drive",
  skrutka: "dispersion",
  rezonans: "formant",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

describe("the primary knob is DECLARED on the effect", () => {
  it("every declared knob is a real parameter of its own effect", () => {
    for (const type of types) {
      const knob = EFFECT_META[type].primaryKnob;
      if (!knob) continue;
      const ids = EFFECT_META[type].params.map((param) => param.id);
      expect(ids, `${type}.primaryKnob = "${knob}"`).toContain(knob);
    }
  });

  it("the map is DERIVED from the registry — there is no second table", () => {
    for (const type of types) {
      expect(EFFECT_PRIMARY_KNOB[type] ?? null, type).toBe(EFFECT_META[type].primaryKnob ?? null);
    }
    const declared = types.filter((type) => EFFECT_META[type].primaryKnob != null);
    expect(Object.keys(EFFECT_PRIMARY_KNOB).length).toBe(declared.length);
  });

  it("the knob-less effects are exactly the ones with a written reason", () => {
    const knobLess = types.filter((type) => EFFECT_META[type].primaryKnob == null).sort();
    expect(knobLess).toEqual(Object.keys(KNOB_LESS).sort());
  });

  it("CENSUS: every effect that HAS a fractional knob declares one", () => {
    const silent: string[] = [];
    for (const type of types) {
      if (EFFECT_META[type].primaryKnob) continue;
      const hasFraction = EFFECT_META[type].params.some((param) => param.min === 0 && param.max === 1);
      if (hasFraction && !KNOB_LESS[type]) silent.push(type);
    }
    expect(silent, "an effect with a fractional knob and no primary knob").toEqual([]);
  });

  it("a knob is a SHARE of its range, so 'more X' is a nudge and not a leap", () => {
    for (const type of types) {
      const knob = EFFECT_META[type].primaryKnob;
      if (!knob) continue;
      if (MUSICAL[type] === knob) continue;
      const param = EFFECT_META[type].params.find((candidate) => candidate.id === knob);
      expect(param, `${type}.${knob}`).toBeDefined();
      expect([param!.min, param!.max], `${type}.${knob} must be 0..1`).toEqual([0, 1]);
    }
  });

  it("the established knobs do not move", () => {
    for (const [type, knob] of Object.entries(ESTABLISHED)) {
      expect(EFFECT_PRIMARY_KNOB[type as EffectType], type).toBe(knob);
    }
  });

  it("the intent layer and the MCP catalog read the SAME answer", () => {
    for (const type of types) {
      const entry = getEffectCatalogEntry(type);
      expect(entry, type).not.toBeNull();
      expect(entry!.primaryKnob, type).toBe(EFFECT_PRIMARY_KNOB[type] ?? null);
    }
  });

  it("there is exactly ONE effect→knob map in src/, and it lives in the registry", () => {
    const owners: string[] = [];
    for (const file of walk("src")) {
      const source = readFileSync(file, "utf8");
      if (/const\s+EFFECT_(?:PRIMARY_)?KNOB\b/.test(source)) owners.push(relative(".", file).replace(/\\/g, "/"));
    }
    expect(owners).toEqual(["src/effects/definitions.ts"]);
  });
});
