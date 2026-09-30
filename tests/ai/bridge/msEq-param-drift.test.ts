import { describe, expect, it } from "vitest";
import { testDoc } from "../../fixtures/doc";
import { normalizeProject } from "../../../src/project-model/schema";
import type { MidSideEqCommand } from "../../../src/ai/bridge/types";
import { __validateBridgeCommandForTest, applyBridgeCommandForTest } from "../../../src/ai/bridge/executor";

/**
 * AUDIT (intent, 2026-09-30) — D-3 reproduction.
 *
 * The AI bridge's `applyMidSideEq` wrote the OLD msEq param surface
 * (lowFreq / highFreq / lowGain / midGain / highGain / comp / soloLow /
 * soloMid / soloHigh / mix — the 3-band crossover layout). The `msEq` effect
 * was later redesigned into a 4-band M/S EQ (midLowFreq, midLowGain,
 * midHighFreq, midHighGain, sideLowFreq, sideLowGain, sideHighFreq,
 * sideHighGain), so every id the bridge still writes is a DEAD KEY that
 * `normalizeEffects` strips.
 *
 * Net effect: the M/S EQ intent "worked" in the sense that it inserted a
 * correctly-typed effect, but every musically meaningful value it computed was
 * discarded on load — the user got a default, silent-to-the-request M/S EQ.
 * This is exactly the "valid command, wrong DAW state" failure the audit
 * targets, and it is invisible to the existing bridge specs because they assert
 * on `MSEQ_RANGES` (the stale mirror) rather than on the real effect.
 */

const cmd: MidSideEqCommand = {
  kind: "ms-eq",
  label: "scooped snare",
  rationale: "audit repro",
  target: { namePattern: "Drums", regex: false, preferKind: "any" },
  shape: "scooped",
  intensity: 0.8,
};

describe("D-3: ms-eq intent params survive normalizeProject", () => {
  it("the command validates", () => {
    const check = __validateBridgeCommandForTest(testDoc(), cmd);
    expect(check.ok, `ms-eq must remain a valid command: ${JSON.stringify(check)}`).toBe(true);
  });

  it("every param the bridge writes is a live msEq param", () => {
    const doc = testDoc();
    const applied = applyBridgeCommandForTest(doc, cmd);

    const written = applied.tracks.find((t) => /drums/i.test(t.name))!.effects.find((fx) => fx.type === "msEq")!.params;

    const normalized = normalizeProject(applied);
    const survived = Object.keys(
      normalized.tracks.find((t) => /drums/i.test(t.name))!.effects.find((fx) => fx.type === "msEq")!.params,
    );

    const dropped = Object.keys(written).filter((k) => !survived.includes(k));
    expect(
      dropped,
      `these bridge-written msEq params are dead keys stripped by normalizeEffects — the intent does nothing audible: ${dropped.join(", ")}`,
    ).toEqual([]);
  });

  it("the intent actually changes the M/S EQ gains (not a default-inserted no-op)", () => {
    const doc = testDoc();
    const normalized = normalizeProject(applyBridgeCommandForTest(doc, cmd));
    const params = normalized.tracks
      .find((t) => /drums/i.test(t.name))!
      .effects.find((fx) => fx.type === "msEq")!.params;

    // "scooped" must move a gain away from the registry default of 0 dB.
    const gains = ["midLowGain", "midHighGain", "sideLowGain", "sideHighGain"].map((k) => params[k] ?? 0);
    expect(
      gains.some((g) => g !== 0),
      `scooped M/S EQ left every gain at the default: ${JSON.stringify(params)}`,
    ).toBe(true);
  });
});
