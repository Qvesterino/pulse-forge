import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { parseSectionRequests } from "../src/intent/sections";
import { planSongForm, buildSong, applySongCommand } from "../src/intent/song";
import { normalizeIntent } from "../src/intent/normalize";
import { generateLocalResult } from "../src/intent/pipeline";
import { applyGenerationResultWithFxCommand } from "../src/commands/commands";
import type { ProjectDocument, InstrumentTrack } from "../src/project-model/types";

/**
 * Wave 1+2+3 — the full sentence path:
 * "wobbly drill with a 16-bar intro and a vinyl break" →
 *   • "wobbly" rides the generation as IntentSpec.fx (global chain),
 *   • "16-bar intro" reshapes the song form,
 *   • "vinyl break" scopes vinyl to the break via sceneAutomation,
 * all in ONE undoable apply.
 */

const fxOf = (d: ProjectDocument, trackId: string) => {
  const track = d.tracks.find((t) => t.id === trackId);
  return track && "effects" in track ? track.effects : [];
};

const drumTrackOf = (d: ProjectDocument) => d.tracks.find((t) => t.kind === "drum")!;

describe("parseSectionRequests", () => {
  it("parses the flagship sentence: bars, scoped fx, remainder", () => {
    const parse = parseSectionRequests("wobbly drill with a 16-bar intro and a vinyl break")!;
    expect(parse).not.toBeNull();
    expect(parse.requests).toContainEqual({ role: "intro", bars: 16 });
    expect(parse.scopedFx).toHaveLength(1);
    expect(parse.scopedFx[0]!.role).toBe("break");
    expect(parse.scopedFx[0]!.fx.goals[0]!.concept).toBe("lofi");
    // The fx + section words are consumed; the generation vocabulary stays.
    expect(parse.remainingText).toContain("wobbly");
    expect(parse.remainingText).toContain("drill");
    expect(parse.remainingText).not.toContain("vinyl");
    expect(parse.remainingText).not.toContain("intro");
  });

  it("repeats: 'chorus twice', '2x drop', 'drop 3x'", () => {
    expect(parseSectionRequests("trap with chorus twice")!.requests).toContainEqual({ role: "chorus", repeats: 2 });
    expect(parseSectionRequests("2x drop")!.requests).toContainEqual({ role: "drop", repeats: 2 });
    expect(parseSectionRequests("drop 3x")!.requests).toContainEqual({ role: "drop", repeats: 3 });
  });

  it("omit: 'no break' and SK 'bez breaku'", () => {
    expect(parseSectionRequests("trap beat no break")!.requests).toContainEqual({ role: "break", omit: true });
    expect(parseSectionRequests("trap beat bez breaku")!.requests).toContainEqual({ role: "break", omit: true });
  });

  it("SK aliases: 'bez mostika' → bridge, '16 taktov intro'", () => {
    expect(parseSectionRequests("techno bez mostika")!.requests).toContainEqual({ role: "bridge", omit: true });
    expect(parseSectionRequests("16 taktov intro")!.requests).toContainEqual({ role: "intro", bars: 16 });
  });

  it("accent-tolerant both ways: 'zaver' and 'mostik' spellings", () => {
    expect(parseSectionRequests("no zaver")!.requests).toContainEqual({ role: "outro", omit: true });
    expect(parseSectionRequests("bez mostiku")!.requests).toContainEqual({ role: "bridge", omit: true });
  });

  it("a bare role mention is not a request", () => {
    // "mostik" alone names a section but requests nothing — the form keeps
    // its shape. Actions (bars/repeats/omit/scoped fx) are the requests.
    expect(parseSectionRequests("techno s dlhým mostíkom")).toBeNull();
  });

  it("returns null without section vocabulary", () => {
    expect(parseSectionRequests("dark rolling techno at 140")).toBeNull();
    expect(parseSectionRequests("make the bass deeper")).toBeNull();
  });
});

describe("applySectionRequests / planSongForm", () => {
  const intent = normalizeIntent({ genre: "trap", seed: "sec-test" });

  it("reshapes the form: resize, duplicate, omit", () => {
    const parse = parseSectionRequests("8-bar intro, chorus twice, no break")!;
    const form = planSongForm(intent, parse);
    const intro = form.sections.find((s) => s.role === "intro")!;
    expect(intro.bars).toBe(8);
    const choruses = form.sections.filter((s) => s.role === "chorus");
    expect(choruses.length).toBeGreaterThanOrEqual(2);
    expect(form.sections.some((s) => s.role === "break")).toBe(false);
    expect(form.totalBars).toBe(form.sections.reduce((sum, s) => sum + s.bars, 0));
  });

  it("scoped fx attaches to the first matching section only", () => {
    const parse = parseSectionRequests("vinyl break")!;
    const form = planSongForm(intent, parse);
    const withFx = form.sections.filter((s) => s.fx);
    expect(withFx).toHaveLength(1);
    expect(withFx[0]!.role).toBe("break");
    expect(withFx[0]!.fx!.goals[0]!.concept).toBe("lofi");
  });

  it("an over-eager 'no' never empties the form", () => {
    const parse = parseSectionRequests("no intro, no outro")!;
    const form = planSongForm(intent, parse);
    expect(form.sections.length).toBeGreaterThan(0);
  });
});

describe("IntentSpec.fx (wave 1)", () => {
  it("normalizeIntent sanitizes and keeps fx", () => {
    const kept = normalizeIntent({
      genre: "drill",
      fx: { targets: ["drums"], goals: [{ concept: "wobbly", amount: 0.9 }], sourceText: "wobbly" },
    });
    expect(kept.fx?.goals[0]).toEqual({ concept: "wobbly", amount: 0.9 });
    const dropped = normalizeIntent({ genre: "drill", fx: { garbage: true } });
    expect(dropped.fx ?? null).toBeNull();
  });

  it("generation carries fx into the plan — preview parity for USE", () => {
    const doc = createProjectFromTemplate("drill");
    const intent = normalizeIntent({
      genre: "drill",
      seed: "fx-parity",
      fx: { targets: ["drums"], goals: [{ concept: "wobbly", amount: 0.7 }], sourceText: "wobbly drill" },
    });
    const result = generateLocalResult(doc, intent, "apply");
    expect(result.proposal).not.toBeNull();
    expect(result.plan.intent.fx?.goals[0]!.concept).toBe("wobbly");
  });

  it("applyGenerationResultWithFxCommand installs pattern + FX in ONE undo step", () => {
    const doc = createProjectFromTemplate("drill");
    const intent = normalizeIntent({
      genre: "drill",
      seed: "fx-use",
      fx: { targets: ["drums"], goals: [{ concept: "wobbly", amount: 0.7 }], sourceText: "wobbly" },
    });
    const result = generateLocalResult(doc, intent, "apply");
    const cmd = applyGenerationResultWithFxCommand(doc, result);
    const next = cmd.execute(doc);
    const drums = fxOf(next, drumTrackOf(next).id);
    expect(drums.some((f) => f.type === "beatMangler")).toBe(true);
    // One undo restores the exact previous document.
    expect(cmd.undo(next)).toEqual(doc);
  });
});

describe("song build end-to-end: 'wobbly drill with a 16-bar intro and a vinyl break'", () => {
  it("builds the reshaped form and installs gated section FX", async () => {
    const doc = createProjectFromTemplate("drill");
    const sections = parseSectionRequests("wobbly drill with a 16-bar intro and a vinyl break")!;
    const build = await buildSong(
      doc,
      normalizeIntent({
        genre: "drill",
        seed: "wave-e2e",
        fx: { targets: ["drums"], goals: [{ concept: "wobbly", amount: 0.7 }], sourceText: "wobbly drill" },
      }),
      { sections, yieldBetweenSections: false },
    );

    // Form reshaped: 16-bar intro, vinyl scoped to the break.
    const intro = build.sections.find((s) => s.role === "intro")!;
    expect(intro.bars).toBe(16);
    const brk = build.sections.find((s) => s.role === "break");
    expect(brk?.fx?.goals[0]!.concept).toBe("lofi");

    const applied = applySongCommand(doc, build).execute(doc);

    // Global fx: beatMangler on the drum track, audible everywhere (static).
    const drumsId = drumTrackOf(applied).id;
    const mangler = fxOf(applied, drumsId).find((f) => f.type === "beatMangler");
    expect(mangler).toBeDefined();
    expect(mangler!.volumeSteps).toHaveLength(16);

    // Scoped + break recipe merge into ONE vinyl instance, mix-gated to the
    // break: neutral 0 in every OTHER scene's lane, active in the break's.
    const vinyls = fxOf(applied, drumsId).filter((f) => f.type === "vinyl");
    expect(vinyls).toHaveLength(1);
    expect(vinyls[0]!.params.mix).toBe(0);
    const vinylLanes = applied.sceneAutomation.filter(
      (lane) => lane.target.kind === "fxParam" && lane.target.fxId === vinyls[0]!.id && lane.target.paramId === "mix",
    );
    expect(vinylLanes.length).toBe(build.sections.length);
    const breakSceneId = `scene-${brk!.pattern.id}`;
    for (const lane of vinylLanes) {
      const isBreak = lane.sceneId === breakSceneId;
      const activeValue = lane.points[lane.points.length - 1]!.value;
      if (isBreak) expect(activeValue).toBe(1);
      else expect(activeValue).toBe(0);
    }

    // Recipes: intro/build ramps land on a music track as svFilter cutoff
    // lanes scoped per scene (the drill template names its music tracks
    // differently — target by installed effect, not by name).
    const filterTrack = applied.tracks.find(
      (t): t is InstrumentTrack => t.kind === "instrument" && t.effects.some((f) => f.type === "svFilter"),
    );
    expect(filterTrack).toBeDefined();
    const filters = fxOf(applied, filterTrack!.id).filter((f) => f.type === "svFilter");
    expect(filters.length).toBeGreaterThanOrEqual(1);
    const rampLanes = applied.sceneAutomation.filter(
      (lane) =>
        lane.target.kind === "fxParam" &&
        lane.target.fxId === filters[0]!.id &&
        lane.target.paramId === "cutoff" &&
        lane.target.trackId === filterTrack!.id,
    );
    expect(rampLanes.length).toBeGreaterThanOrEqual(1);
    const introRamp = rampLanes.find((lane) => lane.sceneId === `scene-${intro.pattern.id}`);
    expect(introRamp).toBeDefined();
    expect(introRamp!.points[0]!.value).toBeLessThan(introRamp!.points[introRamp!.points.length - 1]!.value);

    // ONE undo restores the pre-song document.
    const cmd = applySongCommand(doc, build);
    expect(cmd.undo(applied)).toEqual(doc);
  });

  it("is deterministic for a fixed seed", async () => {
    const doc = createProjectFromTemplate("drill");
    const sections = parseSectionRequests("vinyl break")!;
    const input = normalizeIntent({ genre: "drill", seed: "det-song" });
    const a = await buildSong(doc, input, { sections, yieldBetweenSections: false });
    const b = await buildSong(doc, input, { sections, yieldBetweenSections: false });
    // Pattern content is seed-deterministic — ids are random uids.
    const content = (build: typeof a) =>
      build.sections.map((s) =>
        JSON.stringify({ rows: s.pattern.rows, notes: s.pattern.notes, role: s.role, bars: s.bars, label: s.label }),
      );
    expect(content(a)).toEqual(content(b));
    // Lane shape (kind, param, points order) is deterministic too.
    const laneShape = (applied: ProjectDocument) =>
      applied.sceneAutomation.map((lane) =>
        JSON.stringify({ kind: lane.target.kind, param: lane.target.paramId, points: lane.points }),
      );
    expect(laneShape(applySongCommand(doc, a).execute(doc))).toEqual(
      laneShape(applySongCommand(doc, b).execute(doc)),
    );
  });
});
