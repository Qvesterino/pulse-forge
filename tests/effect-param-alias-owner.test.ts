import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EFFECT_META, EFFECT_PARAM_ALIASES } from "../src/effects/definitions";
import { getEffectCatalogEntry } from "../src/plugin-catalog";
import { setEffectParam } from "../src/commands/effectParams";
import { addEffectToTracks } from "../src/commands/commands";
import { testDoc } from "./fixtures/doc";
import type { EffectType, ProjectDocument } from "../src/project-model/types";

/**
 * R-08 — the eq legacy aliases are declared ONCE, in the registry
 * (deprecated/aliasOf ParamDefs); the command layer's map is DERIVED from
 * that declaration (EFFECT_PARAM_ALIASES), never hand-written next to it.
 *
 * The duplicate used to agree only by luck: the hand-written table in
 * setEffectParam could drift from the registry's aliasOf declarations with
 * nothing catching it. Also pinned: the MCP catalog does NOT advertise the
 * aliases as settable (they are not — the canonical id is the one the
 * runtime consumes), and a legacy-id write keeps BOTH keys in sync.
 */

function eqTrackId(doc: ProjectDocument): string {
  return doc.tracks.find((track) => track.kind === "instrument")!.id;
}

describe("the param alias table has one owner", () => {
  it("census: every declared alias points at a real, non-deprecated param of the same effect", () => {
    const offenders: string[] = [];
    for (const [type, meta] of Object.entries(EFFECT_META) as [EffectType, (typeof EFFECT_META)[EffectType]][]) {
      for (const param of meta.params) {
        if (param.deprecated !== true) continue;
        if (!param.aliasOf) {
          offenders.push(`${type}.${param.id}: deprecated without aliasOf`);
          continue;
        }
        const canonical = meta.params.find((candidate) => candidate.id === param.aliasOf);
        if (!canonical) offenders.push(`${type}.${param.id}: aliasOf "${param.aliasOf}" is not a ParamDef`);
        else if (canonical.deprecated === true) {
          offenders.push(`${type}.${param.id}: aliasOf "${param.aliasOf}" is itself deprecated`);
        }
      }
    }
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  it("the derived map agrees with the registry exactly", () => {
    for (const [type, aliases] of Object.entries(EFFECT_PARAM_ALIASES)) {
      const meta = EFFECT_META[type as EffectType];
      const expected = Object.fromEntries(
        meta.params
          .filter((param) => param.deprecated === true && param.aliasOf)
          .map((param) => [param.id, param.aliasOf]),
      );
      expect(aliases, type).toEqual(expected);
    }
    // eq is the effect that carries the aliases today — the map must know it.
    expect(Object.keys(EFFECT_PARAM_ALIASES.eq ?? {})).toContain("lowGain");
  });

  it("scan guard: no hand-written alias table survives in src/commands or src/project-model", () => {
    const offenders: string[] = [];
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          scan(full);
          continue;
        }
        if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
        const text = readFileSync(full, "utf-8");
        // A hand-written table mapping the legacy ids would re-declare the
        // registry's aliasOf truth; the derived map is the only allowed owner.
        if (/lowGain:\s*"lowShelfGain"/.test(text)) offenders.push(full);
        if (/["']lowGain["'],\s*["']lowShelfGain["']/.test(text)) offenders.push(full);
      }
    };
    scan(join(process.cwd(), "src", "commands"));
    scan(join(process.cwd(), "src", "project-model"));
    expect(offenders, offenders.join("; ")).toEqual([]);
  });

  it("the MCP catalog does not advertise the aliases as settable", () => {
    const eq = getEffectCatalogEntry("eq");
    expect(eq).not.toBeNull();
    const ids = eq!.parameters.map((parameter) => parameter.id);
    expect(ids).toContain("lowShelfGain");
    expect(ids, "deprecated aliases must not reach the agent surface").not.toContain("lowGain");
  });

  it("a legacy-id write keeps BOTH keys in sync (old-document contract)", () => {
    const doc = testDoc();
    const trackId = eqTrackId(doc);
    const withEq = addEffectToTracks(doc, [trackId], "eq").execute(doc);
    const fxId = withEq.tracks.find((track) => track.id === trackId)!.effects[0]!.id;

    const next = setEffectParam(withEq, trackId, fxId, "lowGain", -6).execute(withEq);
    const fx = next.tracks.find((track) => track.id === trackId)!.effects[0]!;
    expect(fx.params.lowGain).toBe(-6);
    expect(fx.params.lowShelfGain).toBe(-6);

    // And the canonical id writes the canonical key (the alias key stays
    // whatever it was — the runtime prefers the canonical key regardless).
    const next2 = setEffectParam(next, trackId, fxId, "lowShelfGain", 3).execute(next);
    const fx2 = next2.tracks.find((track) => track.id === trackId)!.effects[0]!;
    expect(fx2.params.lowShelfGain).toBe(3);
  });
});
