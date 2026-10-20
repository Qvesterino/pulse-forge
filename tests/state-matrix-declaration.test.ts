import { describe, expect, it } from "vitest";
import { STATE_EXPECTATIONS, STATE_ROLES, STATES, evaluateExpectation, type StateReading } from "../src/ui/stateMatrix";

/**
 * THE DECLARATION, PINNED — both directions.
 *
 * The state matrix is one declaration with two readers: the gate
 * (`scripts/state-matrix.mts --gate`) and, later, the Diagnostics panel's
 * STATE tab. A declaration that drifts from its readers is worse than no
 * declaration, because the gate would go green over a surface nobody checked.
 *
 * Two directions, because both failures are real:
 *
 *   a declaration naming a role or state that does not exist — the rule is
 *   never evaluated, and it looks like coverage.
 *
 *   a role or state with NO declaration — the surface is never checked, and
 *   it looks like the matrix is complete.
 */

const roleIds = new Set(STATE_ROLES.map((r) => r.id));
const stateIds = new Set(STATES.map((s) => s.id));

describe("state matrix declaration", () => {
  it("names only roles and states that exist", () => {
    for (const e of STATE_EXPECTATIONS) {
      expect(roleIds.has(e.role), `expectation for unknown role "${e.role}"`).toBe(true);
      expect(stateIds.has(e.state), `expectation for unknown state "${e.state}"`).toBe(true);
    }
  });

  it("has no duplicate (state, role) pairs", () => {
    const seen = new Set<string>();
    for (const e of STATE_EXPECTATIONS) {
      const key = `${e.state}::${e.role}`;
      expect(seen.has(key), `duplicate expectation for ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it("gives every expectation at least one rule and a reason", () => {
    for (const e of STATE_EXPECTATIONS) {
      expect(Object.keys(e.expect).length, `expectation ${e.state}/${e.role} asserts nothing`).toBeGreaterThan(0);
      expect(e.because.trim().length, `expectation ${e.state}/${e.role} has no reason`).toBeGreaterThan(20);
    }
  });

  it("covers every drivable state", () => {
    const covered = new Set(STATE_EXPECTATIONS.map((e) => e.state));
    for (const s of STATES) {
      if (!s.drivable) continue;
      expect(covered.has(s.id), `state "${s.id}" has no declaration at all`).toBe(true);
    }
  });

  it("uses ranges that are not empty and not inverted", () => {
    const ranges = ["insetMarks", "borderMarks", "rings", "outlines"] as const;
    for (const e of STATE_EXPECTATIONS) {
      for (const key of ranges) {
        const range = e.expect[key];
        if (!range) continue;
        if (range.min !== undefined && range.max !== undefined) {
          expect(range.min, `inverted range on ${e.state}/${e.role}.${key}`).toBeLessThanOrEqual(range.max);
        }
        expect(range.min ?? 0).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("pins colours in the normalised sRGB form the reader produces", () => {
    for (const e of STATE_EXPECTATIONS) {
      if (e.expect.insetColour !== undefined) {
        expect(e.expect.insetColour, `insetColour on ${e.state}/${e.role} is not normalised`).toMatch(
          /^rgba?\(\d{1,3}, \d{1,3}, \d{1,3}(, 0?\.\d+)?\)$/,
        );
      }
      if (e.expect.borderColour !== undefined) {
        expect(e.expect.borderColour, `borderColour on ${e.state}/${e.role} is not normalised`).toMatch(
          /^rgba?\(\d{1,3}, \d{1,3}, \d{1,3}(, 0?\.\d+)?\)$/,
        );
      }
    }
  });

  it("does not declare an exact ring count — the grid animates box-shadow", () => {
    // A pinned ring count would be flaky by construction: the column the
    // playhead left keeps a fading ring, so the count moves with the frame.
    for (const e of STATE_EXPECTATIONS) {
      const range = e.expect.rings;
      if (!range) continue;
      expect(range.min, `exact ring count pinned on ${e.state}/${e.role}`).not.toBe(range.max);
    }
  });
});

/** A reading with everything zero — the "nothing is marked" baseline. */
const blank = (over: Partial<StateReading> = {}): StateReading => ({
  roleId: "x",
  matched: 0,
  visible: 0,
  fontSize: null,
  fontWeight: null,
  letterSpacing: null,
  topLight: null,
  bottomLight: null,
  hasAccent: false,
  accent: null,
  background: null,
  color: null,
  sample: null,
  accentCount: 0,
  accentColors: [],
  accentIndexes: [],
  accentSample: null,
  ringCount: 0,
  outlineCount: 0,
  outlineAccent: null,
  outlineWidth: null,
  borderAccent: null,
  borderAccentCount: 0,
  borderAccentSample: null,
  contrast: null,
  compositedBackground: null,
  backgroundResolved: false,
  backgroundNote: null,
  contrastFloor: 4.5,
  largeText: false,
  onScreen: false,
  pixelContrast: null,
  ...over,
});

describe("expectation evaluation", () => {
  it("passes a reading that satisfies the rule", () => {
    const e = {
      state: "idle",
      role: "rowPad",
      expect: { insetMarks: { min: 1, max: 1 }, insetColour: "rgb(245, 158, 11)" },
      because: "x",
    };
    const r = evaluateExpectation(e, blank({ visible: 16, accentCount: 1, accent: "rgb(245, 158, 11)" }), undefined);
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("fails and says WHY when the count is out of range", () => {
    const e = { state: "idle", role: "rowPad", expect: { insetMarks: { min: 1, max: 1 } }, because: "x" };
    const r = evaluateExpectation(e, blank({ accentCount: 0 }), undefined);
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain("0 inset marks");
  });

  it("treats a missing reading as a failure, not as a pass", () => {
    const e = { state: "idle", role: "rowPad", expect: { insetMarks: { min: 0 } }, because: "x" };
    const r = evaluateExpectation(e, undefined, undefined);
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain("not read");
  });

  it("catches a selection that did NOT move", () => {
    const e = { state: "selected", role: "rowPad", expect: { markMovedFromIdle: true }, because: "x" };
    const idle = blank({ accentSample: "1Kick Deep" });
    const same = blank({ accentSample: "1Kick Deep" });
    const moved = blank({ accentSample: "2Kick Punch" });
    expect(evaluateExpectation(e, same, idle).ok).toBe(false);
    expect(evaluateExpectation(e, moved, idle).ok).toBe(true);
  });

  it("catches a transport that does not advance", () => {
    const e = { state: "playing", role: "positionReadout", expect: { textChangedFromIdle: true }, because: "x" };
    const idle = blank({ sample: "1.1.1" });
    expect(evaluateExpectation(e, blank({ sample: "1.1.1" }), idle).ok).toBe(false);
    expect(evaluateExpectation(e, blank({ sample: "1.3.2" }), idle).ok).toBe(true);
  });

  it("catches a focus ring that is missing", () => {
    const e = { state: "focus", role: "transportBtn", expect: { outlines: { min: 1, max: 1 } }, because: "x" };
    expect(evaluateExpectation(e, blank({ outlineCount: 0 }), undefined).ok).toBe(false);
    expect(evaluateExpectation(e, blank({ outlineCount: 1 }), undefined).ok).toBe(true);
    expect(evaluateExpectation(e, blank({ outlineCount: 2 }), undefined).ok).toBe(false);
  });
});
