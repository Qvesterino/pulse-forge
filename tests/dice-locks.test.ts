import { describe, it, expect } from "vitest";
import { testDoc } from "./fixtures/doc";
import { applyDiceLocks, DEFAULT_DICE_LOCKS } from "../src/intent/dice";
import { getActivePattern, getDrumTrack } from "../src/project-model/types";

describe("dice locks", () => {
  it("drums lock copies all rows", () => {
    const doc = testDoc();
    const prev = getActivePattern(doc);
    // Make next with different rows
    const next = {
      ...prev,
      rows: Object.fromEntries(Object.entries(prev.rows).map(([k, v]) => [k, v.map((x) => (x > 0 ? 0 : 0.5))])),
    };
    const out = applyDiceLocks(prev, next, { ...DEFAULT_DICE_LOCKS, drums: true }, doc);
    expect(out.rows).toEqual(prev.rows);
  });
  it("kick lock copies only kicks", () => {
    const doc = testDoc();
    const prev = getActivePattern(doc);
    const drumPads = getDrumTrack(doc).pads;
    const kickId = drumPads.find((p) => p.name.toLowerCase().includes("kick"))?.id;
    if (!kickId) return;
    const next = { ...prev, rows: { ...prev.rows, [kickId]: new Array(16).fill(0.9) } };
    const out = applyDiceLocks(prev, next, { ...DEFAULT_DICE_LOCKS, kick: true }, doc);
    expect(out.rows[kickId]).toEqual(prev.rows[kickId]);
    // Other pads unchanged from next
    const otherId = drumPads.find((p) => p.id !== kickId)?.id;
    if (otherId) expect(out.rows[otherId]).toEqual(next.rows[otherId]);
  });
  it("null prev returns next unchanged", () => {
    const doc = testDoc();
    const prev = getActivePattern(doc);
    const out = applyDiceLocks(null, prev, DEFAULT_DICE_LOCKS, doc);
    expect(out).toEqual(prev);
  });
});
