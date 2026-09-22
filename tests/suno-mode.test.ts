import { describe, it, expect } from "vitest";
import { testDoc } from "./fixtures/doc";
import { parseSongLength, planSongForm, buildSong, applySongCommand } from "../src/intent/song";
import { composeFullTrack } from "../src/intent/compose";
import type { LoudnessRenderFn } from "../src/intent/loudness";
import { normalizeIntent } from "../src/intent/normalize";
import type { SampleBank } from "../src/sample-library/factory";
import type { ProjectDocument } from "../src/project-model/types";

describe("parseSongLength (#6 dynamic form)", () => {
  it("exact durations: clock and minute words, EN + SK", () => {
    expect(parseSongLength("techno 3 minutes")).toEqual({ kind: "exact", minutes: 3, label: "3 min" });
    expect(parseSongLength("techno at 128, 2:30 long")).toEqual({
      kind: "exact",
      minutes: 2.5,
      label: "2:30",
    });
    expect(parseSongLength("house na 3 minuty")).toEqual({ kind: "exact", minutes: 3, label: "3 min" });
  });

  it("named edits: short, radio, extended, epic journey", () => {
    expect(parseSongLength("short techno banger")?.kind).toBe("short");
    expect(parseSongLength("krátky beat")?.kind).toBe("short");
    expect(parseSongText("radio edit house")?.kind).toBe("radio");
    expect(parseSongText("extended mix techno")?.kind).toBe("extended");
    expect(parseSongText("epic journey techno")?.kind).toBe("epic");
    expect(parseSongText("dlhá verzia techno")?.kind).toBe("epic");
    // "epic" alone stays a TRAIT — only the journey phrase means length
    expect(parseSongText("epic techno")).toBeNull();
  });

  it("no length words → null", () => {
    expect(parseSongText("dark rolling techno at 138")).toBeNull();
  });
});

function parseSongText(text: string) {
  return parseSongLength(text);
}

describe("applySongLength through planSongForm", () => {
  const intent = normalizeIntent({ genre: "house", seed: "form-test", energy: 0.7 });
  const base = planSongForm(intent);
  const total = (sections: { bars: number }[]) => sections.reduce((sum, s) => sum + s.bars, 0);

  it("house base form is 44 bars (intro 8, A 12, break 4, B 12, outro 8)", () => {
    expect(base.totalBars).toBe(44);
    expect(base.sections.length).toBe(7);
  });

  it("short halves the bookends and keeps only the first cycle", () => {
    const short = planSongForm(intent, undefined, { kind: "short", label: "short" });
    expect(total(short.sections)).toBeLessThan(base.totalBars);
    expect(short.sections.some((s) => s.label === "Break")).toBe(false);
    expect(short.sections.some((s) => s.label === "Build B")).toBe(false);
    // intro/outro halved to 4 bars
    expect(short.sections[0].bars).toBe(4);
    expect(short.sections[short.sections.length - 1].bars).toBe(4);
  });

  it("extended/epic add stamped core cycles with unique labels", () => {
    const extended = planSongForm(intent, undefined, { kind: "extended", label: "extended" });
    expect(extended.totalBars).toBe(base.totalBars + 12);
    const epic = planSongForm(intent, undefined, { kind: "epic", label: "epic" });
    expect(epic.totalBars).toBe(base.totalBars + 24);
    // labels stay unique (stamped letters)
    const labels = epic.sections.map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(epic.sections.some((s) => s.marker?.name.includes(" C"))).toBe(true);
  });

  it("exact minutes greedily approaches the target at the intent's bpm", () => {
    const twoMin = planSongForm(intent, undefined, { kind: "exact", minutes: 2, label: "2 min" });
    // 2 min @ 124 bpm (bpmRange absent → genre default) ≈ 62 → roundBars 60
    expect(total(twoMin.sections)).toBeGreaterThanOrEqual(57);
    expect(total(twoMin.sections)).toBeLessThanOrEqual(72);
    // deterministic
    const again = planSongForm(intent, undefined, { kind: "exact", minutes: 2, label: "2 min" });
    expect(again.sections.map((s) => s.label)).toEqual(twoMin.sections.map((s) => s.label));
  });

  it("standard/radio leave the form untouched", () => {
    expect(planSongForm(intent, undefined, { kind: "radio", label: "radio" }).totalBars).toBe(44);
    expect(planSongForm(intent, undefined, { kind: "standard", label: "std" }).totalBars).toBe(44);
  });
});

describe("composeFullTrack (SUNO MODE)", () => {
  it("one sentence → song + mix commands; loudness skipped without a bank", async () => {
    const doc = testDoc();
    const result = await composeFullTrack(doc, "dark rolling techno at 132, extended mix", {
      loudness: true, // bank absent on purpose → loudness must SKIP, not throw
      onProgress: () => {},
    });
    expect(result.build.sections.length).toBeGreaterThan(7); // extended adds a cycle
    expect(result.lengthHint?.kind).toBe("extended");
    expect(result.commands.song).toBeDefined();
    expect(result.commands.mix).not.toBeNull();
    expect(result.loudness).toBeNull();
    expect(result.skipped.some((reason) => reason.startsWith("loudness"))).toBe(true);
  });

  it("full pipeline with an injected render runs the loudness stage", async () => {
    const doc = testDoc();
    const result = await composeFullTrack(doc, "energetic trap at 140, 2 minutes", {
      loudness: true,
      bank: {} as unknown as SampleBank,
      render: (async () => ({}) as unknown as AudioBuffer) as unknown as LoudnessRenderFn,
    });
    expect(result.lengthHint?.kind).toBe("exact");
    expect(result.loudness).not.toBeNull();
    // runner applies AFTER install — it renders the FINISHED mix; the fake
    // buffer is not a real render, so the stage reports ok:false, not a throw
    const loudness = await result.loudness?.run(doc as unknown as ProjectDocument);
    expect(loudness?.ok).toBe(false);
  });

  it("applies cleanly: song + mix commands execute into the doc without throwing", async () => {
    const doc = testDoc();
    const result = await composeFullTrack(doc, "deep house radio edit", { loudness: false });
    // radio edit keeps the standard form
    expect(result.build.totalBars).toBe(44);
    const withSong = result.commands.song.execute(doc);
    expect(() => result.commands.mix?.execute(withSong)).not.toThrow();
  });
});
