import { describe, expect, it } from "vitest";
import { evaluateAuditGate } from "../scripts/lib/plugin-audit-gate.mjs";

/**
 * The gate's host column answers "did the plugin do anything in this graph?".
 * An effect can report a zero delta for two opposite reasons, and folding them
 * into one count is what made the audit point at six plugins when two were
 * already explained:
 *
 *  - it carries an `hostExemptReason`, i.e. the fixture cannot excite it by
 *    design (no key/modulator track to duck against) and zero is CORRECT;
 *  - it carries no reason, i.e. nothing accounts for the silence.
 *
 * These tests pin the split, and pin the reason filter against a loophole: an
 * effect must not be able to exempt itself by writing an empty string.
 */
function effect(overrides: Record<string, unknown> = {}) {
  return {
    type: "rezonans",
    hostProcesses: false,
    deadParams: [],
    defaultFinite: true,
    rapidSwingFinite: true,
    automationFinite: true,
    ...overrides,
  };
}

function stats(effects: unknown[]) {
  return evaluateAuditGate({ effects, instruments: [] }).stats;
}

describe("plugin-audit gate — host processing column", () => {
  it("keeps an explained zero out of the not-processing count", () => {
    const s = stats([effect({ hostExemptReason: "host has no modulator track" })]);
    expect(s.notProcessing).toEqual([]);
    expect(s.hostExempt.map((e: { type: string }) => e.type)).toEqual(["rezonans"]);
  });

  it("counts an unexplained zero as not processing", () => {
    const s = stats([effect()]);
    expect(s.notProcessing).toEqual(["rezonans"]);
    expect(s.hostExempt).toEqual([]);
  });

  it("still reports an exempt effect that DID process", () => {
    // Exemption is about the fixture, not about the outcome: if the effect
    // moves the output, the reason no longer applies but the audit trail of
    // why it was exempt should survive.
    const s = stats([effect({ hostProcesses: true, hostExemptReason: "no key track" })]);
    expect(s.notProcessing).toEqual([]);
    expect(s.hostExempt[0]).toMatchObject({ type: "rezonans", hostProcesses: true });
  });

  it("separates a processed effect from both columns", () => {
    const s = stats([effect({ hostProcesses: true })]);
    expect(s.notProcessing).toEqual([]);
    expect(s.hostExempt).toEqual([]);
  });

  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
  ])("refuses to accept %s as an exemption", (_label, reason) => {
    // Without this an effect could silence the column simply by emitting "".
    const s = stats([effect({ hostExemptReason: reason })]);
    expect(s.hostExempt).toEqual([]);
    expect(s.notProcessing).toEqual(["rezonans"]);
  });

  it("keeps exempt and unexplained lists disjoint when both are present", () => {
    const s = stats([
      effect({ type: "vocoder", hostExemptReason: "no modulator track" }),
      effect({ type: "sirka" }),
      effect({ type: "eq", hostProcesses: true }),
    ]);
    expect(s.notProcessing).toEqual(["sirka"]);
    expect(s.hostExempt.map((e: { type: string }) => e.type)).toEqual(["vocoder"]);
  });

  it("does not let the split change pass/fail", () => {
    // The split is reporting only. If exempting everything turned the gate
    // green, it would be a way to hide real failures.
    const all = [effect({ hostExemptReason: "justified" }), effect({ type: "sirka", sweepError: "boom" })];
    expect(evaluateAuditGate({ effects: all, instruments: [] }).ok).toBe(false);
    expect(evaluateAuditGate({ effects: all, instruments: [] }).failures).toHaveLength(1);
  });
});

describe("plugin-audit gate — what stays non-fatal", () => {
  it("does not fail on dead parameters", () => {
    // There are 144 of them and no agreed bar; gating here would be red on
    // arrival and would teach everyone to ignore the gate.
    const s = stats([effect({ hostProcesses: true, deadParams: ["a", "b", "c"] })]);
    expect(s.deadParameters).toBe(3);
    expect(evaluateAuditGate({ effects: [effect({ deadParams: ["a"] })], instruments: [] }).ok).toBe(true);
  });

  it("counts gated parameters apart from dead ones", () => {
    // A gated parameter is inert only while a sibling switch is off. It is not
    // dead, and adding the two counts together would put a work-list entry on
    // something that already works.
    const s = stats([
      effect({ type: "reverseSwell", deadParams: [], gatedParams: ["time", "reach", "curve"] }),
      effect({ type: "sirka", deadParams: ["lowFreq"], gatedParams: [] }),
    ]);
    expect(s.gatedParameters).toBe(3);
    expect(s.deadParameters).toBe(1);
    expect(s.gatedByEffect).toEqual([{ type: "reverseSwell", gated: 3 }]);
  });

  it("treats a missing gated list as zero, not as a crash", () => {
    // Older reports have no gatedParams field at all.
    const s = stats([effect({ type: "eq" })]);
    expect(s.gatedParameters).toBe(0);
    expect(s.gatedByEffect).toEqual([]);
  });

  it("does not fail on gated parameters", () => {
    const r = evaluateAuditGate({ effects: [effect({ gatedParams: ["time"] })], instruments: [] });
    expect(r.ok).toBe(true);
  });

  it("does not fail on an effect that does not process", () => {
    // Reported, never fatal — an unexcitable fixture is not a plugin defect
    // and must not be able to redden the gate on arrival.
    expect(evaluateAuditGate({ effects: [effect()], instruments: [] }).ok).toBe(true);
  });

  it("still fails on a measurement that threw", () => {
    const r = evaluateAuditGate({
      effects: [effect({ sweepError: "x" }), effect({ type: "eq", hostError: "y" })],
      instruments: [],
    });
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(2);
  });

  it("still fails on a non-finite render", () => {
    const r = evaluateAuditGate({
      effects: [
        effect({ defaultFinite: false }),
        effect({ type: "a", rapidSwingFinite: false }),
        effect({ type: "b", automationFinite: false }),
      ],
      instruments: [],
    });
    expect(r.failures).toHaveLength(3);
  });

  it("fails on runner notes but not on console noise", () => {
    const noise = evaluateAuditGate({
      effects: [],
      instruments: [{ kind: "texture", unstableParams: ["note"] }],
      interactions: { notes: ["some console noise"] },
    });
    expect(noise.ok).toBe(true);

    const runner = evaluateAuditGate({
      effects: [],
      instruments: [{ kind: "texture", unstableParams: ["runner: boom"] }],
      interactions: { notes: ["runner: boom"] },
    });
    expect(runner.failures).toHaveLength(2);
  });
});
