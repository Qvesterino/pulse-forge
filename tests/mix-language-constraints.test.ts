import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { classifyPads } from "../src/assist/patternOps";
import { mergeProposalConstraints, resolveMixLanguageConstraints } from "../src/intent/mix-language-constraints";
import { checkProposalConstraints } from "../src/intent/proposal-constraints";
import { planMixIdea } from "../src/mcp/mix-idea";
import { buildMixPreview } from "../src/mcp/mix-preview";

function project() {
  const doc = createProjectFromTemplate("house");
  const drum = doc.tracks.find((t) => t.kind === "drum")!;
  if (drum.kind !== "drum") throw new Error("missing drums");
  const kick = classifyPads(drum.pads).kicks[0];
  if (!kick) throw new Error("missing kick");
  drum.pads = drum.pads.filter((pad) => !classifyPads([pad]).kicks.length || pad.id === kick.id);
  const bass = doc.tracks.find((t) => t.kind === "instrument" && t.instrument === "808");
  if (!bass) throw new Error("missing bass");
  return { doc, drum, kick, bass };
}

describe("natural language mix constraints", () => {
  it.each([
    "make bass warmer, keep kick",
    "teplejsia basa, kick nechaj tak",
    "teplejšia basa, zachovaj kick",
    "warmer bass, don't touch kick",
  ])("protects the kick's parent track and removes the protected clause: %s", (text) => {
    const { doc, drum, kick } = project();
    const result = resolveMixLanguageConstraints(doc, text);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.constraints.protect).toEqual([["tracks", { id: drum.id }]]);
    expect(result.selections[0]).toMatchObject({
      trackId: drum.id,
      padId: kick.id,
      mode: "protect",
      protectsParentTrack: true,
    });
    expect(result.plannerText).not.toContain("kick");
    const plan = planMixIdea(doc, result.plannerText);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(checkProposalConstraints(doc, plan.command.execute(doc), result.constraints).ok).toBe(true);
  });

  it("limits edits to a named bass and keeps the kick, including its drum effects", () => {
    const { doc, bass, drum } = project();
    const result = resolveMixLanguageConstraints(doc, "warmer bass, uprav len basu, kick nechaj tak");
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.constraints).toEqual({
      allow: [["tracks", { id: bass.id }]],
      protect: [["tracks", { id: drum.id }]],
    });
    const plan = planMixIdea(doc, result.plannerText);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(checkProposalConstraints(doc, plan.command.execute(doc), result.constraints).ok).toBe(true);
  });

  it("asks which kick and accepts a specific pad id on retry", () => {
    const { doc, drum, kick } = project();
    drum.pads.push({ ...kick, id: "kick-alt-id", name: "Kick Alt" });
    const ambiguous = resolveMixLanguageConstraints(doc, "warmer bass, keep kick");
    expect(ambiguous.status).toBe("clarify");
    if (ambiguous.status === "clarify") expect(ambiguous.choices).toHaveLength(2);
    const resolved = resolveMixLanguageConstraints(doc, "warmer bass, keep kick-alt-id");
    expect(resolved.status).toBe("ready");
    if (resolved.status === "ready") expect(resolved.selections[0].padId).toBe("kick-alt-id");
  });

  it("asks whether 808 means a bass track or an 808 drum pad", () => {
    const { doc, drum, kick } = project();
    drum.pads.push({ ...kick, id: "pad-808", name: "808 Kick" });
    const result = resolveMixLanguageConstraints(doc, "warmer bass, keep 808");
    expect(result.status).toBe("clarify");
    if (result.status === "clarify") expect(result.choices).toHaveLength(2);
  });

  it("rejects unknown, unsupported, contradictory or incomplete requests", () => {
    const { doc } = project();
    for (const text of [
      "warmer bass, keep missing",
      "warmer bass but keep kick out",
      "warmer bass, only change bass, keep bass",
      "make only the bass warmer",
    ]) {
      expect(resolveMixLanguageConstraints(doc, text).status, text).toBe("clarify");
    }
    expect(resolveMixLanguageConstraints(doc, "warmer bass").status).toBe("none");
  });

  it("intersects explicit and natural constraints rather than weakening either", () => {
    expect(
      mergeProposalConstraints(
        { allow: [["tracks", { id: "a" }]] },
        { allow: [["tracks", { id: "b" }]], protect: [["master"]] },
      ),
    ).toEqual({ allow: [], protect: [["master"]] });
    expect(mergeProposalConstraints({ allow: [["tracks"]] }, { allow: [["tracks", { id: "a" }]] })).toEqual({
      allow: [["tracks", { id: "a" }]],
    });
  });

  it("rejects an unsafe whole-drum change before rendering", async () => {
    const { doc } = project();
    const resolution = resolveMixLanguageConstraints(doc, "punchier drums, keep kick");
    expect(resolution.status).toBe("ready");
    if (resolution.status !== "ready") return;
    const plan = planMixIdea(doc, resolution.plannerText);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    let renders = 0;
    await expect(
      buildMixPreview(
        doc,
        plan,
        async () => {
          renders++;
          throw new Error("unexpected render");
        },
        { constraints: resolution.constraints },
      ),
    ).rejects.toThrow(/Constraint violation/);
    expect(renders).toBe(0);
  });
});
