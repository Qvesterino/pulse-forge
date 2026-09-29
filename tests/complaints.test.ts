import { describe, it, expect } from "vitest";
import { routeIntentText } from "../src/intent/route";
import { parseComplaintIntent, diagnoseComplaint, type ComplaintIntent } from "../src/intent/complaints";
import type { SongSectionMeter } from "../src/intent/song-audio-review";
import { createScene, setSceneRole } from "../src/commands/commands";
import { parseProductionIntent, planProductionActions } from "../src/intent/production";
import type { ProjectDocument } from "../src/project-model/types";
import { testDoc } from "./fixtures/doc";

/**
 * LISTENING LOOP (Phase C) — complaint → measured diagnosis → EXECUTABLE
 * bounded proposals. The producer's complaint must never silently mutate:
 * the route yields a diagnosis and verified suggestion chips, and nothing
 * changes until a chip is picked (then the existing routes execute it).
 */

function meter(role: string, rmsDbfs: number): SongSectionMeter {
  return { role, startSecond: 0, seconds: 8, rmsDbfs, peakDbfs: rmsDbfs + 4 };
}

describe("complaint parsing", () => {
  it("EN + SK complaints extract kind and role", () => {
    const drop = parseComplaintIntent("drop pôsobí prázdno");
    expect(drop).toMatchObject({ kind: "empty", role: "drop" });
    const harsh = parseComplaintIntent("the lead is harsh");
    expect(harsh).toMatchObject({ kind: "harsh", family: "lead" });
    expect(parseComplaintIntent("bez razancie na bicích")?.kind).toBe("noPunch");
    expect(parseComplaintIntent("chorus je muddy")?.role).toBe("chorus");
  });

  it("no role/family → null (a complaint must point at something)", () => {
    expect(parseComplaintIntent("muddy")).toBeNull();
    expect(parseComplaintIntent("sounds empty")).toBeNull();
  });

  it("genre prompts with complaint words stay prompts", () => {
    const doc = testDoc();
    expect(routeIntentText("dark empty techno at 140", doc).kind).toBe("pattern");
    expect(routeIntentText("empty warehouse techno", doc).kind).toBe("pattern");
  });
});

describe("complaint diagnosis", () => {
  it("empty section + quiet measurement → evidence confirms and proposes density/energy", () => {
    const intent = parseComplaintIntent("the drop feels empty") as ComplaintIntent;
    const meters = [
      meter("intro", -18),
      meter("drop", -24), // 6 dB below median (-18)
      meter("chorus", -15),
    ];
    const diagnosis = diagnoseComplaint(intent, meters);
    expect(diagnosis?.measurement).toContain("-24.0");
    expect(diagnosis?.measurement).toContain("pod mediánom");
    expect(diagnosis?.proposals.map((proposal) => proposal.instruction)).toEqual([
      "more energy in the drop",
      "more density in the drop",
    ]);
  });

  it("measurement showing the section is FINE says so honestly", () => {
    const intent = parseComplaintIntent("the drop feels empty") as ComplaintIntent;
    const meters = [
      meter("intro", -24),
      meter("drop", -12), // above median
      meter("chorus", -20),
    ];
    const diagnosis = diagnoseComplaint(intent, meters);
    expect(diagnosis?.measurement).toContain("nad mediánom");
  });

  it("no meters → honest 'podľa slov' diagnosis, proposals still bounded", () => {
    const intent = parseComplaintIntent("the drop feels empty") as ComplaintIntent;
    const diagnosis = diagnoseComplaint(intent);
    expect(diagnosis?.measurement).toBe("");
    expect(diagnosis?.proposals.map((proposal) => proposal.instruction)).toEqual([
      "more energy in the drop",
      "more density in the drop",
    ]);
  });

  it("harsh → softer production proposal for the named family", () => {
    const intent = parseComplaintIntent("the lead is harsh") as ComplaintIntent;
    const diagnosis = diagnoseComplaint(intent);
    expect(diagnosis?.proposals[0].instruction).toBe("make the lead softer");
  });

  it("noPunch → punchier drums production proposal", () => {
    const intent = parseComplaintIntent("no punch in the drums") as ComplaintIntent;
    const diagnosis = diagnoseComplaint(intent);
    expect(diagnosis?.proposals[0].instruction).toBe("make the drums punchier");
  });
});

describe("proposal execution through existing routes", () => {
  it("a proposed density revision EXECUTES via the revise flow", async () => {
    // the revise proposal is executed in the panel through reviseSection —
    // here we verify the same API the bridge would call
    const { reviseSection } = await import("../src/intent/song");
    const doc = testDoc();
    const scene = createScene(doc, "Drop").execute(doc);
    const withRole = setSceneRole(scene, scene.scenes[scene.scenes.length - 1].id, "drop").execute(scene);
    // a pattern with intent provenance so revise has something to reshape
    const pattern = {
      ...withRole.patterns[0],
      id: "pattern-revise-x",
      generation: { intent: { genre: "house", seed: "revise-x", energy: 0.5, density: 0.5 } },
    };
    const withPattern = {
      ...withRole,
      patterns: [...withRole.patterns, pattern],
      scenes: withRole.scenes.map((candidate) =>
        candidate.id === scene.scenes[scene.scenes.length - 1].id
          ? { ...candidate, patternId: "pattern-revise-x" }
          : candidate,
      ),
    } as ProjectDocument;
    const outcome = reviseSection(withPattern, "drop", "density", 0.2);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const revisedDensity = outcome.pattern.generation?.intent
        ? (JSON.parse(JSON.stringify(outcome.pattern.generation.intent)) as { density?: number }).density
        : undefined;
      expect(revisedDensity).toBeCloseTo(0.7, 5);
    }
  });

  it("a proposed production fix EXECUTES through the production command", () => {
    const doc = testDoc();
    const intent = parseComplaintIntent("no punch in the drums") as ComplaintIntent;
    const diagnosis = diagnoseComplaint(intent);
    // the production proposal maps to the existing production command
    const productionIntent = parseProductionIntent("make the drums punchier")!;
    const actions = planProductionActions(doc, productionIntent);
    expect(actions.actions.length).toBeGreaterThan(0);
    void diagnosis;
  });
});
