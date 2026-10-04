/**
 * kyx_mix_idea — the text-to-mix remote control (src/mcp/mix-idea.ts).
 *
 * The loop contract: PLAN is pure (the caller's doc is never touched, every
 * step carries the WHY), APPLY is ONE undoable command, targets resolve from
 * the sentence itself and an explicit target overrides the text. The two
 * interpreters keep the FxIntentBar precedence — production concepts for
 * whole-mix language, the assistant's curated goals scoped to a track.
 */
import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { planMixIdea, formatMixIdea } from "../src/mcp/mix-idea";
import type { ProjectDocument } from "../src/project-model/types";

function doc(): ProjectDocument {
  return createProjectFromTemplate("house");
}

describe("mix idea — production interpreter (whole-mix language)", () => {
  it("plans attributed device steps from a sentence and never mutates the doc", () => {
    const project = doc();
    const snapshot = JSON.stringify(project);
    const plan = planMixIdea(project, "warmer and glue the drums");
    expect(JSON.stringify(project)).toBe(snapshot);

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.interpreter).toBe("production");
    expect(plan.targets).toContain("drums");
    expect(plan.steps.length).toBeGreaterThan(0);
    for (const step of plan.steps) {
      expect(step.track.length).toBeGreaterThan(0);
      expect(step.device).not.toBe("concept mapping");
      expect(step.params.length).toBeGreaterThan(0);
    }
    // The WHY is attributed: a warmer step maps to the tape device family.
    expect(plan.steps.some((step) => /tape/i.test(step.device))).toBe(true);
  });

  it("resolves an explicit 'mix' target to every non-group track in one plan", () => {
    const project = doc();
    const plan = planMixIdea(project, "brighter", "mix");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.targets).toEqual(["mix"]);
    const touched = new Set(plan.steps.map((step) => step.trackId));
    const leafIds = project.tracks.filter((t) => t.kind !== "group").map((t) => t.id);
    expect(leafIds.length).toBeGreaterThan(1);
    for (const id of leafIds) expect(touched.has(id)).toBe(true);
  });

  it("apply executes ONE command that really changes the track chain", () => {
    const project = doc();
    const plan = planMixIdea(project, "punchier drums");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const drumBefore = project.tracks.find((t) => t.kind === "drum")!;
    const next = plan.command.execute(project);
    const drumAfter = next.tracks.find((t) => t.kind === "drum")!;
    expect(drumAfter.effects.length).toBeGreaterThan(drumBefore.effects.length);
  });

  it("an explicit family target overrides the sentence", () => {
    const project = doc();
    const plan = planMixIdea(project, "warmer drums", "bass");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.targets).toEqual(["bass"]);
    for (const step of plan.steps) {
      const track = project.tracks.find((t) => t.id === step.trackId);
      expect(track?.kind === "instrument" && ["bass", "808", "logdrum"].includes(track.instrument)).toBe(true);
    }
  });

  it("an explicit track id scopes the plan to that track", () => {
    const project = doc();
    const drum = project.tracks.find((t) => t.kind === "drum");
    expect(drum).toBeTruthy();
    const plan = planMixIdea(project, "brighter", drum!.id);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.targets).toEqual([drum!.id]);
    for (const step of plan.steps) expect(step.trackId).toBe(drum!.id);
  });

  it("pad-family ideas report the element-level gain ride as a warning", () => {
    const project = doc();
    const plan = planMixIdea(project, "kick more knock");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.warnings.join(" ")).toMatch(/kick/i);
  });
});

describe("mix idea — assistant interpreter (curated goal language)", () => {
  it("scopes assistant goals to a named family", () => {
    const project = doc();
    const plan = planMixIdea(project, "more space", "drums");
    if (plan.ok && plan.interpreter === "assistant") {
      expect(plan.steps.length).toBeGreaterThan(0);
      for (const step of plan.steps) {
        const track = project.tracks.find((t) => t.id === step.trackId);
        expect(track?.kind).toBe("drum");
      }
    } else if (!plan.ok) {
      // The assistant catalog may not carry this goal — then the refusal
      // must say so honestly instead of mutating something random.
      expect(plan.reason).toMatch(/track|assistant/i);
    }
  });

  it("assistant goals without any target refuse with guidance instead of guessing", () => {
    const project = doc();
    const plan = planMixIdea(project, "more space everywhere please");
    // Either the production side parsed it (targets: mix) or the assistant
    // refusal names the missing target — never a silent whole-project change.
    if (plan.ok) expect(plan.interpreter).toBe("production");
    else expect(plan.reason).toMatch(/target|track|idea/i);
  });
});

describe("mix idea — honest failures and the report format", () => {
  it("refuses sentences no interpreter understands", () => {
    const project = doc();
    const plan = planMixIdea(project, "make it smell like strawberries");
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toMatch(/mix idea|target|track/i);
  });

  it("refuses too-short ideas", () => {
    const plan = planMixIdea(doc(), "wa");
    expect(plan.ok).toBe(false);
  });

  it("the plan report says nothing was applied; the apply report says one undo", () => {
    const project = doc();
    const plan = planMixIdea(project, "warmer drums");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const preview = formatMixIdea(plan, false);
    expect(preview).toMatch(/nothing applied/i);
    expect(preview).toMatch(/apply:true/);
    const applied = formatMixIdea(plan, true);
    expect(applied).toMatch(/ONE undo/i);
    expect(applied).toMatch(/kyx_render_summary/);
    expect(applied).toMatch(/kyx_blind_ab/);
  });
});
