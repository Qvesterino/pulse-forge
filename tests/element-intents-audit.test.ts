import { describe, expect, it } from "vitest";
import { createProjectFromTemplate } from "../src/project-model/templates";
import { parseProductionIntent } from "../src/intent/production";
import { applyProductionIntentCommand } from "../src/commands/commands";
import { classifyPads } from "../src/assist/patternOps";
import type { DrumTrack, ProjectDocument } from "../src/project-model/types";

/**
 * ELEMENT-LEVEL INTENTS (vibe-code wave): "kick more knock" names a PAD
 * family — the production intent resolves it to the drum track and the
 * planner adds a per-pad GAIN adjustment for exactly that family. Other
 * pads keep their gain.
 */

const docWithDrums = (): { doc: ProjectDocument; drum: DrumTrack } => {
  const doc = createProjectFromTemplate("house");
  const drum = doc.tracks.find((t): t is DrumTrack => t.kind === "drum")!;
  return { doc, drum };
};

const padGains = (doc: ProjectDocument, drum: DrumTrack): Map<string, number> => {
  const track = doc.tracks.find((t) => t.id === drum.id) as DrumTrack;
  return new Map(track.pads.map((p) => [p.id, p.gain]));
};

describe("element-level intent parsing", () => {
  it('"kick more knock" resolves the kick pad family', () => {
    const intent = parseProductionIntent("kick more knock")!;
    expect(intent.targets).toContain("kick");
    expect(intent.padTargets).toContain("kick");
    expect(intent.goals.map((g) => g.concept)).toContain("punchier"); // knock → punchier
  });

  it('"hats washy" — washy is not a concept, hats parse as a target alone → no production (falls to generation)', () => {
    // "washy" matches no concept — parse returns null so the text flows to
    // generation. Element-level verbs without a production concept are the
    // pattern-verbs layer's job, not production's.
    expect(parseProductionIntent("hats washy")).toBeNull();
  });

  it("SK: 'kopák razantnejší' resolves kick + punchier", () => {
    const intent = parseProductionIntent("kopák razantnejší")!;
    expect(intent.targets).toContain("kick");
    expect(intent.goals.map((g) => g.concept)).toContain("punchier");
  });
});

describe("applyProductionIntentCommand with pad families", () => {
  it("kick pads gain, other families keep their gain, ONE undo restores", () => {
    const { doc, drum } = docWithDrums();
    const before = padGains(doc, drum);
    const intent = parseProductionIntent("kick more knock")!;
    const cmd = applyProductionIntentCommand(doc, intent);
    const next = cmd.execute(doc);
    const after = padGains(next, drum);

    const fams = classifyPads(drum.pads);
    const kicks = new Set(fams.kicks.map((p) => p.id));
    let kickChanged = 0;
    for (const [id, gain] of before) {
      const now = after.get(id)!;
      if (kicks.has(id)) {
        if (now > gain) kickChanged++;
      } else {
        expect(now, `pad ${id} must keep its gain`).toBe(gain);
      }
    }
    expect(kickChanged).toBeGreaterThan(0);
    expect(cmd.undo(next)).toEqual(doc);
  });

  it("deterministic: same intent re-applied → same pad gains", () => {
    const { doc, drum } = docWithDrums();
    const intent = parseProductionIntent("kick more knock")!;
    const a = applyProductionIntentCommand(doc, intent).execute(doc);
    const b = applyProductionIntentCommand(doc, intent).execute(doc);
    expect(padGains(a, drum)).toEqual(padGains(b, drum));
  });
});
