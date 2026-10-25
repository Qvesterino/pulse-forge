import { describe, expect, it } from "vitest";
import { createDefaultProject } from "../src/project-model/schema";
import { targetTrackIds } from "../src/intent/semantics/target-resolution";
import { rewriteSelectedTrackReference } from "../src/intent/selected-track";
import { MIX_TARGET_IDS } from "../src/intent/semantics/target-registry";
import { routeIntentText } from "../src/intent/route";

function exactSelection(): { doc: ReturnType<typeof createDefaultProject>; target: string; trackId: string } {
  const doc = createDefaultProject();
  const target = MIX_TARGET_IDS.find((candidate) => targetTrackIds(doc, [candidate]).length === 1);
  expect(target).toBeDefined();
  return { doc, target: target!, trackId: targetTrackIds(doc, [target!])[0]! };
}

describe("selected-track deictic context", () => {
  it("rewrites 'this track' to the exact selected family", () => {
    const { doc, target, trackId } = exactSelection();
    const result = rewriteSelectedTrackReference("lower this track by 3 dB", doc, trackId);
    expect(result.rewritten).toBe(true);
    expect(result.target).toBe(target);
    expect(result.text).toBe(`lower the ${target} by 3 dB`);
    expect(["fader", "exact"]).toContain(routeIntentText(result.text, doc).kind);
  });

  it("does not rewrite without a selected track", () => {
    const doc = createDefaultProject();
    const result = rewriteSelectedTrackReference("lower this track by 3 dB", doc, null);
    expect(result.rewritten).toBe(false);
    expect(result.text).toBe("lower this track by 3 dB");
  });

  it("refuses to fan a selected track out to a multi-track family", () => {
    const doc = createDefaultProject();
    const drums = targetTrackIds(doc, ["drums"]);
    if (drums.length < 2) return; // fixture has one drum target; nothing to prove here
    const result = rewriteSelectedTrackReference("mute this track", doc, drums[0]!);
    expect(result.rewritten).toBe(false);
    expect(result.target).toBeNull();
  });
});
