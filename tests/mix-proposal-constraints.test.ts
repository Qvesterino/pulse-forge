import { describe, expect, it, vi } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { planMixIdea } from "../src/mcp/mix-idea";
import { applyAndVerifyMixPreview, buildMixPreview, mixPreviewProposal, previewMixIdea } from "../src/mcp/mix-preview";
import { validateMusicalProposal } from "../src/intent/validate-musical-proposal";
import type { Services } from "../src/services";
import { ProjectStore } from "../src/store/ProjectStore";

function setup() {
  const doc = createProjectFromTemplate("house");
  const plan = planMixIdea(doc, "warmer and glue the drums");
  if (!plan.ok) throw new Error(plan.reason);
  const trackId = plan.steps[0].trackId;
  const render = vi.fn(async () => ({
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(44100).fill(0.01),
    sampleRate: 44100,
    duration: 1,
  }));
  return { doc, plan, trackId, render };
}

describe("mix proposal safety", () => {
  it("applies a permitted proposal as one undoable command", async () => {
    const store = new ProjectStore(createProjectFromTemplate("house"));
    const before = structuredClone(store.getDoc());
    const plan = planMixIdea(before, "warmer and glue the drums");
    if (!plan.ok) throw new Error(plan.reason);
    const render = async () => ({
      numberOfChannels: 1,
      getChannelData: () => new Float32Array(44100).fill(0.01),
      sampleRate: 44100,
      duration: 1,
    });
    const lane = await buildMixPreview(before, plan, render, { projectRevision: store.getRevision(), constraints: {} });
    const outcome = await applyAndVerifyMixPreview({ store, bank: {} } as unknown as Services, lane);
    expect(outcome.applied).toBe(true);
    expect(store.undoStackLength).toBe(1);
    expect(store.getDoc()).not.toEqual(before);
    store.undo();
    expect(store.getDoc()).toEqual(before);
  });

  it("refuses protected changes before either render", async () => {
    const { doc, plan, trackId, render } = setup();
    await expect(
      buildMixPreview(doc, plan, render, {
        constraints: { protect: [["tracks", { id: trackId }]] },
      }),
    ).rejects.toThrow(/Constraint violation/);
    expect(render).not.toHaveBeenCalled();
  });

  it("refuses a changed constraint or command before apply without a store write", async () => {
    const { doc, plan, trackId, render } = setup();
    const lane = await buildMixPreview(doc, plan, render, { projectRevision: 4, constraints: {} });
    const execute = vi.fn();
    const services = { store: { getDoc: () => doc, getRevision: () => 4, execute }, bank: {} } as unknown as Services;
    lane.constraints = { protect: [["tracks", { id: trackId }]] };
    const refused = await applyAndVerifyMixPreview(services, lane);
    expect(refused.applied).toBe(false);
    expect(refused.reason).toMatch(/constraints changed/);
    expect(execute).not.toHaveBeenCalled();
    lane.constraints = {};
    lane.command = { ...lane.command, execute: (d) => d };
    expect((await applyAndVerifyMixPreview(services, lane)).reason).toMatch(/no longer produces/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects another project even if revisions happen to match", async () => {
    const { doc, plan, render } = setup();
    const lane = await buildMixPreview(doc, plan, render, { projectRevision: 4 });
    const execute = vi.fn();
    const services = {
      store: { getDoc: () => ({ ...doc, id: "different" }), getRevision: () => 4, execute },
      bank: {},
    } as unknown as Services;
    expect((await applyAndVerifyMixPreview(services, lane)).applied).toBe(false);
    const newer = { store: { getDoc: () => doc, getRevision: () => 5, execute }, bank: {} } as unknown as Services;
    expect((await applyAndVerifyMixPreview(newer, lane)).reason).toMatch(/changed after preview/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an unknown protected track instead of silently protecting nothing", async () => {
    const { doc } = setup();
    const services = { store: { getDoc: () => doc }, bank: {} } as unknown as Services;
    const result = await previewMixIdea(services, {
      idea: "warmer drums",
      constraints: { protect: [["tracks", { id: "missing" }]] },
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("Unknown track") });
  });

  it("validates project, range, candidate, evidence and consistency with clear errors", async () => {
    const { doc, plan, render } = setup();
    const lane = await buildMixPreview(doc, plan, render, { projectRevision: 4, constraints: {} });
    const proposal = mixPreviewProposal(lane);
    expect(validateMusicalProposal(proposal).ok).toBe(true);
    const cases: Array<[string, (p: typeof proposal) => void]> = [
      [
        "base.projectId",
        (p) => {
          p.base.projectId = "";
        },
      ],
      [
        "base.revision",
        (p) => {
          p.base.revision = -1;
        },
      ],
      [
        "scope.audition",
        (p) => {
          p.scope.audition = { startTick: 9, endTick: 2 };
        },
      ],
      [
        "candidates",
        (p) => {
          p.candidates = [];
        },
      ],
      [
        "before/after evidence",
        (p) => {
          p.evidence = [];
        },
      ],
      [
        "evidence.value",
        (p) => {
          p.evidence[0].value = NaN;
        },
      ],
      [
        "constraints",
        (p) => {
          p.scope.writeScope = "unrestricted";
        },
      ],
    ];
    for (const [reason, mutate] of cases) {
      const broken = structuredClone(proposal);
      mutate(broken);
      const result = validateMusicalProposal(broken);
      expect(result.ok, reason).toBe(false);
      if (!result.ok) expect(result.reason).toContain(reason);
    }
  });
});
