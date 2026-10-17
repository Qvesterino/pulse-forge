import { describe, expect, it } from "vitest";
import { ProjectStore } from "../../src/store/ProjectStore";
import { mutateTsarPatch, mutationReveal, type TsarMutation } from "../../src/tsar/mutations";
import { TSAR_PARAM_DEFS } from "../../src/tsar/params";
import { applyInstrumentPatch } from "../../src/commands/instrument";
import { defaultInstrumentParams } from "../../src/instruments/definitions";
import { createProjectFromTemplate } from "../../src/project-model/templates";
import type { InstrumentTrack } from "../../src/project-model/types";

/**
 * TSAR Patch Mutations — deterministic param-space variants + the blind A/B
 * ladder's "keep winner" command. The tournament itself is UI state; what
 * must hold is: same seed → same variants, only sound-shaping axes move
 * (loudness/tuning/rhythm identity untouched), every value stays in range,
 * and applying a winner is ONE undoable command.
 */

const BASE: Record<string, number> = {
  srcAEngine: 1,
  srcALevel: 0.8,
  srcACutoff: 8000,
  srcAQ: 0.8,
  srcAMorph: 0.2,
  srcAAtk: 0.005,
  srcADec: 0.6,
  srcASus: 0.7,
  srcARel: 0.4,
  srcBCutoff: 4000,
  srcBLevel: 0,
  morph: 0,
  sub: 0.3,
  noise: 0,
  tone: 0,
  drive: 0.2,
  width: 0.5,
  level: 0.8,
  velocity: 0.7,
  srcARoot: 60,
  arpOn: 1,
  arpRate: 8,
  mod1Amt: 0,
};

const identityAxes: Array<[string, number]> = [
  ["level", BASE.level!],
  ["velocity", BASE.velocity!],
  ["srcARoot", BASE.srcARoot!],
  ["arpOn", BASE.arpOn!],
  ["arpRate", BASE.arpRate!],
  ["mod1Amt", BASE.mod1Amt!],
  ["srcAEngine", BASE.srcAEngine!],
];

describe("mutateTsarPatch", () => {
  it("is deterministic — same (base, seed) yields identical variants", () => {
    const a = mutateTsarPatch(BASE, 424242);
    const b = mutateTsarPatch(BASE, 424242);
    expect(a).toEqual(b);
  });

  it("different seeds explore different corners of the space", () => {
    const a = mutateTsarPatch(BASE, 1);
    const b = mutateTsarPatch(BASE, 2);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("produces the requested count as full audition-ready patches", () => {
    const variants = mutateTsarPatch(BASE, 99, 4);
    expect(variants).toHaveLength(4);
    for (const variant of variants) {
      for (const key of Object.keys(BASE)) {
        expect(variant.params[key], `${variant.id} lost ${key}`).toBeDefined();
      }
    }
  });

  it("every mutated value stays inside its parameter definition", () => {
    for (const variant of mutateTsarPatch(BASE, 777, 8)) {
      for (const [key, value] of Object.entries(variant.params)) {
        const def = TSAR_PARAM_DEFS[key];
        if (!def) continue;
        expect(value, `${variant.id}.${key}`).toBeGreaterThanOrEqual(def.min);
        expect(value, `${variant.id}.${key}`).toBeLessThanOrEqual(def.max);
      }
    }
  });

  it("only sound-shaping axes move — loudness, tuning, rhythm and the mod matrix stay put", () => {
    const variants: TsarMutation[] = mutateTsarPatch(BASE, 31337, 8);
    for (const variant of variants) {
      for (const [key, expected] of identityAxes) {
        expect(variant.params[key], `${variant.id}.${key} moved`).toBe(expected);
      }
      expect(variant.moved.length).toBeGreaterThanOrEqual(1);
      expect(variant.moved.length).toBeLessThanOrEqual(6);
    }
  });

  it("the reveal names the moved axes, strongest first", () => {
    const [first] = mutateTsarPatch(BASE, 555, 1);
    expect(first).toBeDefined();
    const reveal = mutationReveal(BASE, first!);
    expect(reveal.length).toBeGreaterThan(0);
    expect(reveal.length).toBeLessThanOrEqual(4);
    // Every reveal entry references a definition label, not a raw param id.
    for (const entry of reveal) expect(entry).toMatch(/^[A-Z0-9 .%▲▼-]+$/);
  });
});

describe("applyInstrumentPatch (the KEEP WINNER command)", () => {
  function tsarDoc(): { store: ProjectStore; trackId: string } {
    const doc = createProjectFromTemplate("house");
    // The house template carries no TSAR track — clone an instrument track
    // into one with the full TSAR default patch (the command only needs
    // kind/instrument/id plus a params map).
    const base = doc.tracks.find((t): t is InstrumentTrack => t.kind === "instrument");
    if (!base) throw new Error("house template has no instrument track");
    const track: InstrumentTrack = {
      ...base,
      id: "tsar-mutation-test",
      instrument: "tsar",
      params: { ...defaultInstrumentParams("tsar") },
      presetId: "factory-presets:tsar-analog-warm",
    };
    doc.tracks.push(track);
    const store = new ProjectStore(doc);
    return { store, trackId: track.id };
  }

  it("replaces the whole parameter map and clears the preset id in ONE command", () => {
    const { store, trackId } = tsarDoc();
    const before = store.doc.tracks.find((t) => t.id === trackId) as InstrumentTrack;
    before.presetId = "some-preset";
    const winner = mutateTsarPatch(before.params, 8, 1)[0]!;
    const command = applyInstrumentPatch(store.doc, trackId, winner.params, "mutation winner");
    const executed = command.execute(store.doc);
    const after = executed.tracks.find((t) => t.id === trackId) as InstrumentTrack;
    expect(after.presetId).toBeNull();
    expect(after.params).toEqual(winner.params);
  });

  it("undoes back to the exact pre-mutation patch (and re-does)", () => {
    const { store, trackId } = tsarDoc();
    const before = store.doc.tracks.find((t) => t.id === trackId) as InstrumentTrack;
    const originalParams = { ...before.params };
    const originalPresetId = before.presetId ?? null;
    const winner = mutateTsarPatch(before.params, 9, 1)[0]!;
    const command = applyInstrumentPatch(store.doc, trackId, winner.params);
    const once = command.undo(command.execute(store.doc));
    const undone = once.tracks.find((t) => t.id === trackId) as InstrumentTrack;
    expect(undone.params).toEqual(originalParams);
    expect(undone.presetId).toBe(originalPresetId);
    const redone = command.execute(once);
    expect((redone.tracks.find((t) => t.id === trackId) as InstrumentTrack).params).toEqual(winner.params);
  });

  it("clamps out-of-range incoming values instead of trusting the caller", () => {
    const { store, trackId } = tsarDoc();
    const command = applyInstrumentPatch(store.doc, trackId, { level: 42, srcACutoff: -5 });
    const applied = command.execute(store.doc);
    const track = applied.tracks.find((t) => t.id === trackId) as InstrumentTrack;
    expect(track.params.level).toBeLessThanOrEqual(TSAR_PARAM_DEFS.level!.max);
    expect(track.params.srcACutoff).toBeGreaterThanOrEqual(TSAR_PARAM_DEFS.srcACutoff!.min);
  });
});
