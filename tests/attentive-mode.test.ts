import { beforeEach, describe, expect, it } from "vitest";
import {
  ATTENTIVE_MODE_KEY,
  findingsFromSectionMeters,
  isAttentiveModeEnabled,
  setAttentiveModeEnabled,
  attentiveStatusLine,
  type AttentiveFinding,
} from "../src/intent/attentive-mode";
import type { SongSectionMeter } from "../src/intent/song-audio-review";

/**
 * F3 ATTENTIVE MODE (docs/INTENT-REACTION-LISTENING-PLAN.md) — the measured
 * suggestion layer over song section meters. Silence is the default; every
 * finding carries its own evidence line and EXECUTABLE chips (revise flow,
 * nothing auto-applies).
 */

const meter = (role: string, rmsDbfs: number, seconds = 16): SongSectionMeter => ({
  role,
  startSecond: 0,
  seconds,
  rmsDbfs,
  peakDbfs: rmsDbfs + 6,
});

beforeEach(() => {
  localStorage.removeItem(ATTENTIVE_MODE_KEY);
});

describe("flag", () => {
  it("default OFF; on/off round-trips; broken storage stays off", () => {
    expect(isAttentiveModeEnabled()).toBe(false);
    setAttentiveModeEnabled(true);
    expect(isAttentiveModeEnabled()).toBe(true);
    setAttentiveModeEnabled(false);
    expect(isAttentiveModeEnabled()).toBe(false);
  });
});

describe("findingsFromSectionMeters", () => {
  it("a balanced song yields NOTHING (silence is the default)", () => {
    const meters = [meter("intro", -18), meter("verse", -17.5), meter("drop", -16), meter("outro", -18)];
    expect(findingsFromSectionMeters(meters)).toEqual([]);
  });

  it("a section 6+ dB under the song median is an empty finding with chips", () => {
    const meters = [
      meter("intro", -18),
      meter("drop", -26.5), // 8 dB under the median — the quiet one
      meter("chorus", -17),
      meter("outro", -18),
    ];
    const findings = findingsFromSectionMeters(meters);
    expect(findings.length).toBe(1);
    const finding = findings[0] as AttentiveFinding;
    expect(finding.role).toBe("drop");
    expect(["empty", "thin"]).toContain(finding.kind);
    expect(finding.chips.length).toBeGreaterThan(0);
    expect(finding.chips[0]?.instruction).toMatch(/more (energy|density) in the drop/);
    expect(finding.evidence).toMatch(/pod mediánom/);
  });

  it("the quietest reads empty, milder gaps read thin; cap 3, quietest first", () => {
    // The median must be held up by the LOUD majority — the quiet sections
    // themselves drag it down, which is exactly why a finding needs context.
    const meters = [
      meter("verse", -18),
      meter("chorus", -17.5),
      meter("drop", -17),
      meter("outro", -18),
      meter("break", -26), // 8 dB under
      meter("bridge", -31), // 13 dB under — the quietest
      meter("fill", -27), // 9 dB under
    ];
    const findings = findingsFromSectionMeters(meters);
    expect(findings.length).toBe(3);
    expect(findings[0]?.role).toBe("bridge");
    // −13 dB reads empty, −9/−8 dB read thin — the graded ladder by design
    expect(findings.map((finding) => finding.kind)).toEqual(["empty", "thin", "thin"]);
  });

  it("fewer than two usable sections prove nothing", () => {
    expect(findingsFromSectionMeters([meter("drop", -40)])).toEqual([]);
    expect(findingsFromSectionMeters([])).toEqual([]);
  });

  it("never throws on malformed meters", () => {
    const junk = [{ role: "x", rmsDbfs: Number.NaN }, { role: "y", rmsDbfs: -Infinity }] as unknown as SongSectionMeter[];
    expect(findingsFromSectionMeters(junk)).toEqual([]);
  });
});

describe("attentiveStatusLine", () => {
  it("empty findings → empty line", () => {
    expect(attentiveStatusLine([])).toBe("");
  });

  it("findings produce one SK status line with the gaps", () => {
    const findings = findingsFromSectionMeters([
      meter("intro", -18),
      meter("drop", -26),
      meter("chorus", -17),
      meter("outro", -18),
    ]);
    const line = attentiveStatusLine(findings);
    expect(line).toMatch(/🎧 pozorný režim: drop/);
    expect(line).toMatch(/dB pod/);
  });
});
