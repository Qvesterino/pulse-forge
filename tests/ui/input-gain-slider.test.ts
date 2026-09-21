/**
 * Input-gain slider — regression tests for the mic trim control.
 *
 * The slider lives inside `ArrangementPanel.tsx` (3211 lines, way too big
 * to mount in jsdom). The interesting contract is in three places:
 *
 *  1. `clampInputGainDb(value)` in `src/audio-engine/PcmMicRecorder.ts`
 *     — pure function, exported, unit-tested directly.
 *  2. `ArrangementPanel` initial state uses
 *     `useState(() => clampInputGainDb(loadRecordingInputGainDb()))` so
 *     storage hydration must be clamped at construction time.
 *  3. `changeInputGain(db)` handler must:
 *     - clamp the value,
 *     - persist via `saveRecordingInputGainDb`,
 *     - apply live via `recRef.current?.setInputGainDb`,
 *     - reset the peak-hold clip flag via `resetMicClip`.
 *
 * The grep section below pins the wiring so a future refactor that drops
 * any of these calls is caught in CI without spinning up the full panel.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  clampInputGainDb,
  MAX_INPUT_GAIN_DB,
  MIN_INPUT_GAIN_DB,
} from "../../src/audio-engine/PcmMicRecorder";

describe("clampInputGainDb", () => {
  it("returns the value unchanged when inside the legal range", () => {
    expect(clampInputGainDb(0)).toBe(0);
    expect(clampInputGainDb(-12.5)).toBe(-12.5);
    expect(clampInputGainDb(6)).toBe(6);
  });

  it("clamps values above MAX_INPUT_GAIN_DB down to the max", () => {
    expect(clampInputGainDb(99)).toBe(MAX_INPUT_GAIN_DB);
    expect(clampInputGainDb(MAX_INPUT_GAIN_DB + 0.1)).toBe(MAX_INPUT_GAIN_DB);
  });

  it("clamps values below MIN_INPUT_GAIN_DB up to the min", () => {
    expect(clampInputGainDb(-99)).toBe(MIN_INPUT_GAIN_DB);
    expect(clampInputGainDb(MIN_INPUT_GAIN_DB - 0.1)).toBe(MIN_INPUT_GAIN_DB);
  });

  it("falls back to 0 dB for non-finite input (NaN / Infinity / -Infinity)", () => {
    // Without this guard, NaN would propagate into the GainNode param
    // (Math.pow(10, NaN/20) = NaN) and silence the take silently.
    expect(clampInputGainDb(Number.NaN)).toBe(0);
    expect(clampInputGainDb(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampInputGainDb(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("rounds to 0.1 dB so the slider readout and storage stay aligned", () => {
    // Math.round(value * 10) / 10 — the UI also displays .toFixed(1).
    // A regression that dropped the rounding would let storage drift
    // away from the displayed value by up to 0.05 dB.
    expect(clampInputGainDb(-6.27)).toBe(-6.3);
    expect(clampInputGainDb(2.7777)).toBe(2.8);
  });

  it("preserves the contract: MIN < MAX and the band includes 0", () => {
    expect(MIN_INPUT_GAIN_DB).toBeLessThan(0);
    expect(MAX_INPUT_GAIN_DB).toBeGreaterThan(0);
    expect(MIN_INPUT_GAIN_DB).toBeLessThanOrEqual(MAX_INPUT_GAIN_DB);
  });
});

describe("ArrangementPanel — input-gain wiring (source-grep regression)", () => {
  // Reading the file once keeps each assertion O(file-size), not O(N*M).
  const src = readFileSync(resolve(process.cwd(), "src/ui/ArrangementPanel.tsx"), "utf8");

  it("imports the input-gain helpers and storage from recordingInput + PcmMicRecorder", () => {
    expect(src).toMatch(/from\s+["']\.\.\/audio-engine\/recordingInput["']/);
    expect(src).toMatch(/loadRecordingInputGainDb/);
    expect(src).toMatch(/saveRecordingInputGainDb/);
    expect(src).toMatch(/from\s+["']\.\.\/audio-engine\/PcmMicRecorder["']/);
    expect(src).toMatch(/clampInputGainDb/);
    expect(src).toMatch(/MIN_INPUT_GAIN_DB/);
    expect(src).toMatch(/MAX_INPUT_GAIN_DB/);
  });

  it("initialises inputGainDb state from persisted storage via the clamp helper", () => {
    // Hydration contract: the first read of storage happens inside the
    // useState initializer (lazy) and is clamped immediately, so a
    // corrupted storage value never lands as an unclamped slider value.
    expect(src).toMatch(
      /useState<number>\(\(\)\s*=>\s*clampInputGainDb\(loadRecordingInputGainDb\(\)\)\)/,
    );
  });

  it("wires the slider to changeInputGain via onChange", () => {
    expect(src).toMatch(/aria-label="Microphone input gain"/);
    expect(src).toMatch(/type="range"/);
    expect(src).toMatch(/min=\{MIN_INPUT_GAIN_DB\}/);
    expect(src).toMatch(/max=\{MAX_INPUT_GAIN_DB\}/);
    expect(src).toMatch(
      /onChange=\{\s*\(event\)\s*=>\s*changeInputGain\(Number\(event\.target\.value\)\)\s*\}/,
    );
  });

  it("changeInputGain clamps, persists, applies live, and resets the clip flag", () => {
    // Match the whole handler body — pins the order so a future
    // refactor that drops any of the four calls is caught immediately.
    expect(src).toMatch(
      /const\s+changeInputGain\s*=\s*\(db:\s*number\):\s*void\s*=>\s*\{[\s\S]*?clampInputGainDb\(db\)[\s\S]*?setInputGainDb\(clamped\)[\s\S]*?saveRecordingInputGainDb\(clamped\)[\s\S]*?recRef\.current\?\.setInputGainDb\(clamped\)[\s\S]*?resetMicClip\(\)[\s\S]*?\};/,
    );
  });

  it("disables the slider while the recorder is busy (idle-only trim)", () => {
    // A regression that dropped `disabled` would let the user move the
    // slider mid-take and reapply the trim while the gain node is live
    // — audibly jumping the level.
    expect(src).toMatch(/disabled=\{recState !== "idle"\}/);
  });
});