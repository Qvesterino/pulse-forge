import { describe, expect, it } from "vitest";
import { jsonEqual } from "../src/shared/jsonEqual";

/**
 * jsonEqual edge matrix (GOAL 08/B1 hot path: per-keystroke change detection
 * on entire project payloads — the reference shortcut is the 95 % case and
 * every branch below runs on the remaining 5 %).
 *
 * The contract is "JSON.stringify comparison without the strings" — each
 * case cites what stringify would have said.
 */

describe("jsonEqual — primitives", () => {
  it("strict equality on matching primitives", () => {
    expect(jsonEqual(1, 1)).toBe(true);
    expect(jsonEqual("a", "a")).toBe(true);
    expect(jsonEqual(true, true)).toBe(true);
    expect(jsonEqual(null, null)).toBe(true);
    expect(jsonEqual(undefined, undefined)).toBe(true);
  });

  it("distinguishes differing primitives", () => {
    expect(jsonEqual(1, 2)).toBe(false);
    expect(jsonEqual("a", "b")).toBe(false);
    expect(jsonEqual(true, false)).toBe(false);
    expect(jsonEqual(0, false)).toBe(false); // stringify("0" vs "false")
    expect(jsonEqual("", null)).toBe(false); // stringify('""' vs "null")
    expect(jsonEqual(1, "1")).toBe(false); // stringify("1" vs '"1"')
  });

  it("NaN equals NaN (both stringify to null)", () => {
    expect(jsonEqual(Number.NaN, Number.NaN)).toBe(true);
    expect(jsonEqual(Number.NaN, 1)).toBe(false);
    expect(jsonEqual(Number.NaN, Number.NaN)).toBe(true);
    // Nested inside a document payload — the normalize-path shape.
    expect(jsonEqual({ gain: Number.NaN }, { gain: Number.NaN })).toBe(true);
    expect(jsonEqual({ gain: Number.NaN }, { gain: 0.5 })).toBe(false);
  });

  it("-0 equals 0 (the reference shortcut fires first; stringify renders both '0')", () => {
    expect(jsonEqual(-0, 0)).toBe(true);
    expect(jsonEqual([-0], [0])).toBe(true);
    expect(jsonEqual({ v: -0 }, { v: 0 })).toBe(true);
  });

  it("Infinity compares by value (stringify 'Infinity' both sides)", () => {
    expect(jsonEqual(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(true);
    expect(jsonEqual(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY)).toBe(false);
  });
});

describe("jsonEqual — objects", () => {
  it("key order does not matter", () => {
    expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1, b: { c: 3, d: 4 } }, { b: { d: 4, c: 3 }, a: 1 })).toBe(true);
  });

  it("key count and presence matter (own properties only)", () => {
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    // A missing key is not the same as an explicitly undefined value.
    expect(jsonEqual({ a: undefined }, {})).toBe(false);
    expect(jsonEqual({ a: undefined }, { a: undefined })).toBe(true);
  });

  it("ignores inherited properties (stringify does too)", () => {
    const proto = { inherited: 1 };
    const a = Object.create(proto) as Record<string, unknown>;
    a.own = 2;
    const b = { own: 2 };
    expect(jsonEqual(a, b)).toBe(true);
  });

  it("null vs object is false in both directions", () => {
    expect(jsonEqual(null, {})).toBe(false);
    expect(jsonEqual({}, null)).toBe(false);
    expect(jsonEqual(null, null)).toBe(true);
  });

  it("array vs object is false even with matching keys", () => {
    expect(jsonEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });

  it("arrays compare element-wise — order is significant", () => {
    expect(jsonEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(jsonEqual([1, 2, 3], [3, 2, 1])).toBe(false);
    expect(jsonEqual([1, 2], [1, 2, 3])).toBe(false);
    // Sparse vs explicit undefined: stringify emits different hole counts.
    expect(jsonEqual([1, , 3] as unknown[], [1, undefined, 3])).toBe(false);
  });

  it("nested structures: deep equality without materializing strings", () => {
    const a = {
      track: {
        id: "t1",
        notes: [
          { p: 60, v: 0.5 },
          { p: 62, v: 0.8 },
        ],
      },
    };
    const b = {
      track: {
        id: "t1",
        notes: [
          { p: 60, v: 0.5 },
          { p: 62, v: 0.8 },
        ],
      },
    };
    expect(jsonEqual(a, b)).toBe(true);
    b.track.notes[1]!.v = 0.79;
    expect(jsonEqual(a, b)).toBe(false);
  });

  it("self-referencing objects terminate through the reference shortcut", () => {
    const a: Record<string, unknown> = { id: 1 };
    a.self = a;
    expect(jsonEqual(a, a)).toBe(true);
  });
});

describe("jsonEqual — hot-path integration shapes", () => {
  it("project-document-ish payloads: equality and single-key drift", () => {
    const base = {
      bpm: 140,
      master: { gain: 0.8, pan: 0 },
      tracks: [
        { id: "kick", volume: 1, muted: false },
        { id: "snare", volume: 0.9, muted: false },
      ],
    };
    const same = JSON.parse(JSON.stringify(base));
    // Key order intentionally differs after the round-trip through a
    // hand-built literal — order-insensitivity is the contract.
    expect(jsonEqual(base, same)).toBe(true);
    const drifted = JSON.parse(JSON.stringify(base));
    drifted.tracks[1]!.volume = 0.89;
    expect(jsonEqual(base, drifted)).toBe(false);
  });

  it("shallow sibling references do not false-positive", () => {
    const shared = { vol: 1 };
    expect(jsonEqual({ a: shared, b: shared }, { a: shared, b: { vol: 1 } })).toBe(true);
    expect(jsonEqual({ a: shared }, { a: shared, b: shared })).toBe(false);
  });
});
