import { describe, expect, it } from "vitest";
import {
  TEMPO_DIVISION_BEATS,
  TEMPO_NOTE_DIVISIONS,
  tempoDivisionBeatsById,
  tempoDivisionOptions,
} from "../src/effects/tempoDivisions";

/**
 * Shared tempo-division contract — ONE musical order consumed by every
 * tempo-synced effect (delay, duckDelay, chorus, phaser, flanger, tremolo,
 * freqShifter, RYFT, stepGate, stutter). Projects persist NUMERIC ids, so a
 * re-order here would silently re-time every synced echo in every saved
 * project — these pins make the table itself load-bearing.
 */

const STRAIGHT: Record<string, number> = { "1/1": 4, "1/2": 2, "1/4": 1, "1/8": 0.5, "1/16": 0.25, "1/32": 0.125 };
const DOTTED: Record<string, number> = { "1/2D": 3, "1/4D": 1.5, "1/8D": 0.75, "1/16D": 0.375, "1/32D": 0.1875 };
const TRIPLET: Record<string, number> = {
  "1/2T": 4 / 3,
  "1/4T": 2 / 3,
  "1/8T": 1 / 3,
  "1/16T": 1 / 6,
  "1/32T": 1 / 12,
};

describe("TEMPO_NOTE_DIVISIONS — musical math", () => {
  it("covers the full 16-division grid (5 straight + 5 dotted + 5 triplets + 1/1)", () => {
    expect(TEMPO_NOTE_DIVISIONS).toHaveLength(16);
    const labels = TEMPO_NOTE_DIVISIONS.map((d) => d.label);
    expect(new Set(labels).size).toBe(16);
    for (const label of [...Object.keys(STRAIGHT), ...Object.keys(DOTTED), ...Object.keys(TRIPLET)]) {
      expect(labels, `${label} present`).toContain(label);
    }
  });

  it("straight divisions halve musically", () => {
    for (const [label, beats] of Object.entries(STRAIGHT)) {
      expect(TEMPO_DIVISION_BEATS[label as keyof typeof TEMPO_DIVISION_BEATS]).toBe(beats);
    }
  });

  it("dotted divisions are 1.5× their straight twin (musical definition)", () => {
    const pairs: [string, string][] = [
      ["1/2D", "1/2"],
      ["1/4D", "1/4"],
      ["1/8D", "1/8"],
      ["1/16D", "1/16"],
      ["1/32D", "1/32"],
    ];
    for (const [dotted, straight] of pairs) {
      const d = TEMPO_DIVISION_BEATS[dotted as keyof typeof TEMPO_DIVISION_BEATS];
      const s = TEMPO_DIVISION_BEATS[straight as keyof typeof TEMPO_DIVISION_BEATS];
      expect(d, dotted).toBeCloseTo(s * 1.5, 10);
      expect(DOTTED[dotted]).toBeCloseTo(d, 10);
    }
  });

  it("triplet divisions are 2/3× their straight twin (musical definition)", () => {
    const pairs: [string, string][] = [
      ["1/2T", "1/2"],
      ["1/4T", "1/4"],
      ["1/8T", "1/8"],
      ["1/16T", "1/16"],
      ["1/32T", "1/32"],
    ];
    for (const [triplet, straight] of pairs) {
      const t = TEMPO_DIVISION_BEATS[triplet as keyof typeof TEMPO_DIVISION_BEATS];
      const s = TEMPO_DIVISION_BEATS[straight as keyof typeof TEMPO_DIVISION_BEATS];
      expect(t, triplet).toBeCloseTo(s * (2 / 3), 10);
      expect(TRIPLET[triplet]).toBeCloseTo(t, 10);
    }
  });

  it("every label maps into the beats lookup (no undefined holes)", () => {
    for (const { label, beats } of TEMPO_NOTE_DIVISIONS) {
      expect(TEMPO_DIVISION_BEATS[label]).toBe(beats);
      expect(Number.isFinite(beats)).toBe(true);
      expect(beats).toBeGreaterThan(0);
    }
  });
});

describe("tempoDivisionOptions — serialized id mapping", () => {
  // A plausible effect idOrder: legacy ids keep their indices, the shared
  // musical order only governs DROPDOWN ordering.
  const ID_ORDER = [
    "OFF",
    "1/1",
    "1/2",
    "1/4",
    "1/8",
    "1/16",
    "1/32",
    "1/2T",
    "1/4T",
    "1/8T",
    "1/16T",
    "1/32T",
    "1/2D",
    "1/4D",
    "1/8D",
    "1/16D",
    "1/32D",
  ];

  it("maps labels to their persisted idOrder indices (OFF is NOT a division — effects add it themselves)", () => {
    const options = tempoDivisionOptions(ID_ORDER);
    const byLabel = new Map(options.map((o) => [o.label, o.value]));
    expect(byLabel.get("OFF")).toBeUndefined(); // OFF lives outside the 16-division grid
    expect(byLabel.get("1/4")).toBe(3);
    expect(byLabel.get("1/32T")).toBe(11); // this idOrder places triplets before dotted
  });

  it("dropdown follows the shared musical order, not idOrder", () => {
    const options = tempoDivisionOptions(ID_ORDER);
    expect(options.map((o) => o.label)).toEqual(TEMPO_NOTE_DIVISIONS.map((d) => d.label));
  });

  it("labels missing from idOrder are filtered out (legacy prefix support)", () => {
    const legacy = ["OFF", "1/4", "1/8", "1/16"];
    const options = tempoDivisionOptions(legacy);
    expect(options.map((o) => o.label)).toEqual(["1/4", "1/8", "1/16"]);
    expect(options.every((o) => o.value >= 0)).toBe(true);
  });

  it("values are unique and in idOrder bounds (persisted ids stay unambiguous)", () => {
    const options = tempoDivisionOptions(ID_ORDER);
    const values = options.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(ID_ORDER.length);
  });

  it("custom optionOrder reorders the dropdown without touching ids", () => {
    const options = tempoDivisionOptions(ID_ORDER, ["1/4", "1/1"]);
    expect(options.map((o) => o.label)).toEqual(["1/4", "1/1"]);
    expect(options[0]!.value).toBe(ID_ORDER.indexOf("1/4"));
  });
});

describe("tempoDivisionBeatsById — resolver table", () => {
  it("resolves persisted ids to beats, OFF to 0", () => {
    const beats = tempoDivisionBeatsById(["OFF", "1/4", "1/8T"]);
    expect(beats).toEqual([0, 1, 1 / 3]);
  });

  it("unknown labels resolve to 0, never NaN (defensive against drift)", () => {
    const beats = tempoDivisionBeatsById(["1/4", "NOT_A_DIVISION"]);
    expect(beats).toEqual([1, 0]);
    expect(beats.every((b) => Number.isFinite(b))).toBe(true);
  });
});
