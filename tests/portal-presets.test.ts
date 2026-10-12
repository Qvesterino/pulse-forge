import { describe, expect, it } from "vitest";
import { CORE_EFFECT_PRESETS } from "../src/effects/presets";
import { isPortalParamActiveInMode } from "../src/ui/effectEditorRegistry";

// The per-mode active set is imported, NOT copied. This file used to carry its
// own table and the two drifted: the panel already treated MOTION as live in
// DELAY while this test called it inactive, and the failure surfaced as a
// mystery on a preset that was doing exactly the right thing. One rule, one
// home — the registry decides, and everything else asks.
describe("PORTAL factory presets", () => {
  it("only store controls that affect their selected mode", () => {
    for (const preset of CORE_EFFECT_PRESETS.filter((candidate) => candidate.type === "portal")) {
      const rawMode = preset.params.mode ?? 0;
      const mode = Number.isFinite(rawMode) ? Math.max(0, Math.min(2, Math.round(rawMode))) : 0;
      const inactive = Object.keys(preset.params).filter((id) => !isPortalParamActiveInMode(id, mode));
      expect(inactive, `${preset.id} stores inactive ${inactive.join(", ")}`).toEqual([]);
    }
  });
});
