import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { EFFECT_DEFS } from "../src/effects/registry";
import { roleOfTrack, rolePresetFor, ROLE_LABELS, type FxTrackRole } from "../src/effects/role-presets";
import { addEffectWithLandingCommand } from "../src/commands/commands";
import type { EffectType, InstrumentTrack, ProjectDocument } from "../src/project-model/types";

/**
 * Role-aware landings (FX-ADD-REWORK-ROADMAP Wave B): Vinyl on an 808 is
 * tape-ish dust, on the kit it is sizzle. Every reachable table entry holds
 * REAL param ids that clamp into ParamDef ranges, the composite command
 * lands add+tune in ONE undo step, and roles mirror the production-intent
 * heuristics.
 */

const ROLES: FxTrackRole[] = ["drums", "bass", "chords", "lead"];
const ALL_TYPES = Object.keys(EFFECT_DEFS) as EffectType[];

const tracksByRole = (d: ProjectDocument): Record<string, InstrumentTrack> => {
  const out: Record<string, InstrumentTrack> = {};
  for (const t of d.tracks) {
    const role = roleOfTrack(t);
    if (role && !out[role] && t.kind === "instrument") out[role] = t as InstrumentTrack;
  }
  return out;
};

describe("roleOfTrack", () => {
  it("classifies the house template: drums, 808 bass, chords keys", () => {
    const d = createProjectFromTemplate("house");
    expect(roleOfTrack(d.tracks.find((t) => t.kind === "drum")!)).toBe("drums");
    const roles = tracksByRole(d);
    expect(roles.bass!.name.toLowerCase()).toMatch(/808|bass|sub/);
    expect(roles.chords).toBeDefined();
  });

  it("returns null for group tracks — no landings on buses", () => {
    // No group track in the templates — assert the contract through a
    // synthetic track shape instead of inventing project structure.
    const fake = { kind: "group", name: "BUS", effects: [] } as unknown as Parameters<typeof roleOfTrack>[0];
    expect(roleOfTrack(fake)).toBeNull();
  });
});

describe("rolePresetFor table", () => {
  it("the table is populated and every reachable entry is a real param in range", () => {
    let entries = 0;
    for (const type of ALL_TYPES) {
      const def = EFFECT_DEFS[type];
      for (const role of ROLES) {
        const preset = rolePresetFor(type, role);
        if (!preset) continue;
        entries++;
        expect(Object.keys(preset).length, `${type}.${role} not empty`).toBeGreaterThan(0);
        for (const [paramId, value] of Object.entries(preset)) {
          const param = def.params.find((pd) => pd.id === paramId);
          expect(param, `${type}.${role}.${paramId} is a real param of ${type}`).toBeDefined();
          expect(value, `${type}.${role}.${paramId} inside range`).toBeGreaterThanOrEqual(param!.min);
          expect(value, `${type}.${role}.${paramId} inside range`).toBeLessThanOrEqual(param!.max);
        }
      }
    }
    expect(entries, "the landing table actually has content").toBeGreaterThan(15);
  });

  it("the canonical case: vinyl lands softer on bass than on drums", () => {
    const bass = rolePresetFor("vinyl", "bass")!;
    const drums = rolePresetFor("vinyl", "drums")!;
    expect(bass.amount).toBeLessThan(drums.amount);
    expect(bass.crackle).toBeLessThan(drums.crackle);
    // Bass vinyl favors wobble over crackle — tape-ish dust.
    expect(bass.wow).toBeGreaterThan(bass.crackle);
  });

  it("no landing for absent pairs — factory defaults stay", () => {
    expect(rolePresetFor("beatMangler", "bass")).toBeNull();
    expect(rolePresetFor("haasWidener", "drums")).toBeNull();
    expect(rolePresetFor("vinyl", null)).toBeNull();
  });

  it("roles have display labels", () => {
    expect(ROLE_LABELS.bass).toMatch(/808/);
  });

  it("addEffectWithLandingCommand lands add+tune in ONE undo step", () => {
    const d = createProjectFromTemplate("house");
    const bass = tracksByRole(d).bass!;
    const landing = rolePresetFor("vinyl", "bass")!;
    const cmd = addEffectWithLandingCommand(d, bass.id, "vinyl", landing);
    const next = cmd.execute(d);
    const track = next.tracks.find((t) => t.id === bass.id) as InstrumentTrack;
    const fx = track.effects.find((f) => f.type === "vinyl")!;
    expect(fx).toBeDefined();
    expect(fx.params.amount).toBe(landing.amount);
    expect(fx.params.mix).toBe(1);
    // ONE undo removes the device entirely — add+tune undoes together.
    const restored = cmd.undo(next);
    const restoredTrack = restored.tracks.find((t) => t.id === bass.id) as InstrumentTrack;
    expect(restoredTrack.effects.some((f) => f.type === "vinyl")).toBe(false);
  });

  it("exaggerated landing values clamp to the device's ranges", () => {
    const d = createProjectFromTemplate("house");
    const drums = d.tracks.find((t) => t.kind === "drum")!;
    const cmd = addEffectWithLandingCommand(d, drums.id, "svFilter", { cutoff: 99999, resonance: -5, mix: 2 });
    const next = cmd.execute(d);
    const fx = (next.tracks.find((t) => t.id === drums.id) as InstrumentTrack).effects.find((f) => f.type === "svFilter")!;
    const cutoffDef = EFFECT_DEFS.svFilter.params.find((p) => p.id === "cutoff")!;
    expect(fx.params.cutoff).toBe(cutoffDef.max);
    expect(fx.params.resonance).toBe(0);
    expect(fx.params.mix).toBe(1);
  });

  it("unknown landing param ids are skipped — the device still lands", () => {
    const d = createProjectFromTemplate("house");
    const bass = tracksByRole(d).bass!;
    const cmd = addEffectWithLandingCommand(d, bass.id, "vinyl", { noSuchParam: 3, amount: 0.4 });
    const next = cmd.execute(d);
    const fx = (next.tracks.find((t) => t.id === bass.id) as InstrumentTrack).effects.find((f) => f.type === "vinyl")!;
    expect(fx.params.amount).toBe(0.4);
  });
});

