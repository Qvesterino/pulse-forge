import { describe, expect, it } from "vitest";
import { CORE_EFFECT_PRESETS } from "../src/effects/presets";

const ACTIVE_PARAMS_BY_MODE: ReadonlyArray<ReadonlySet<string>> = [
  new Set(["mode", "time", "sync", "feedback", "decay", "shift", "diffuse", "freeze", "drive", "tone", "mix"]),
  new Set(["mode", "resonance", "focus", "focusWidth", "drive", "tone", "mix"]),
  new Set([
    "mode",
    "time",
    "sync",
    "feedback",
    "decay",
    "shift",
    "diffuse",
    "resonance",
    "focus",
    "focusWidth",
    "drive",
    "tone",
    "mix",
  ]),
];

describe("PORTAL factory presets", () => {
  it("only store controls that affect their selected mode", () => {
    for (const preset of CORE_EFFECT_PRESETS.filter((candidate) => candidate.type === "portal")) {
      const rawMode = preset.params.mode ?? 0;
      const mode = Number.isFinite(rawMode) ? Math.max(0, Math.min(2, Math.round(rawMode))) : 0;
      const inactive = Object.keys(preset.params).filter((id) => !ACTIVE_PARAMS_BY_MODE[mode]!.has(id));
      expect(inactive, `${preset.id} stores inactive ${inactive.join(", ")}`).toEqual([]);
    }
  });
});
