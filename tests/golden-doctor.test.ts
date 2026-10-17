import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  collectGoldenDoctor,
  collectVoiceSummaries,
  diffRecords,
  formatGoldenDoctor,
  summarizeVoice,
  type DoctorCase,
  type VoiceSummaryFile,
} from "./helpers/golden-doctor";

/**
 * GOLDEN DOCTOR GATE (Package 3, 2026-10-17)
 *
 * Two jobs: prove the doctor's diffs are real (a formatter that always prints
 * "clean" would be worse than no tool), and pin the committed semantic
 * summaries so a hash re-pin cannot happen without the reviewer seeing WHAT
 * moved. `npm run goldens:doctor` prints the same evidence interactively.
 */

const SUMMARIES_PATH = resolve(__dirname, "fixtures/multivoice-golden.summaries.json");

function committedSummaries(): VoiceSummaryFile {
  return JSON.parse(readFileSync(SUMMARIES_PATH, "utf8")) as VoiceSummaryFile;
}

describe("golden doctor — diff primitives", () => {
  it("reports changed fields with from → to and stays empty for identical input", () => {
    expect(diffRecords({ a: 1, b: "x" }, { a: 1, b: "x" })).toEqual([]);
    const diffs = diffRecords({ a: 1, b: "x", c: 3 }, { a: 2, b: "x", c: 3 });
    expect(diffs).toEqual([{ field: "a", from: 1, to: 2 }]);
  });

  it("treats float noise as equal and null/missing as a change", () => {
    expect(diffRecords({ density: 0.5 }, { density: 0.5 + 1e-12 })).toEqual([]);
    expect(diffRecords({ pitchMax: null }, { pitchMax: 72 })).toEqual([{ field: "pitchMax", from: null, to: 72 }]);
    expect(diffRecords({ pitchMax: 72 }, {})).toEqual([{ field: "pitchMax", from: 72, to: null }]);
  });

  it("summarizes a voice by its role counts and progression", () => {
    const summary = summarizeVoice({
      bass: [{}, {}] as never,
      chord: [{}] as never,
      lead: [] as never,
      progressionName: "i-VI (slide bed)",
      progressionDegree: 3,
    });
    expect(summary).toEqual({ bass: 2, chord: 1, lead: 0, progression: "i-VI (slide bed)", degree: 3 });
  });

  it("names the failure mode: STRUCTURAL drift vs values-only drift vs clean", () => {
    const structural: DoctorCase = {
      artifact: "multivoice",
      label: "drill",
      expectedHash: "aaaa",
      actualHash: "bbbb",
      hashChanged: true,
      diffs: [{ field: "lead", from: 24, to: 26 }],
      summaryStatus: "changed",
    };
    const valuesOnly: DoctorCase = { ...structural, diffs: [], summaryStatus: "match" };
    const clean: DoctorCase = {
      ...structural,
      actualHash: "aaaa",
      hashChanged: false,
      diffs: [],
      summaryStatus: "match",
    };

    expect(formatGoldenDoctor([structural])).toContain("STRUCTURAL");
    expect(formatGoldenDoctor([structural])).toContain("lead: 24 → 26");
    expect(formatGoldenDoctor([valuesOnly])).toContain("values-only drift");
    expect(formatGoldenDoctor([clean])).toContain("✓ clean");
  });
});

describe("golden doctor — committed artifacts", () => {
  it("the committed voice summaries match live generation (re-bless to re-pin)", () => {
    const committed = committedSummaries();
    const live = collectVoiceSummaries();
    expect(
      live,
      "a multi-voice case changed shape — review `npm run goldens:doctor`, then re-bless with --bless together with the hash",
    ).toEqual(committed);
  });

  it("every doctor-covered artifact matches its committed hash right now", () => {
    const cases = collectGoldenDoctor(committedSummaries());
    const changed = cases.filter((item) => item.hashChanged).map((item) => item.label);
    expect(changed, "a frozen artifact drifted — the doctor names the semantic diff for the re-pin review").toEqual([]);
  });

  it("the doctor covers both artifacts and a non-trivial case count", () => {
    const cases = collectGoldenDoctor(committedSummaries());
    expect(new Set(cases.map((item) => item.artifact))).toEqual(new Set(["multivoice", "ai-baseline"]));
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });
});
