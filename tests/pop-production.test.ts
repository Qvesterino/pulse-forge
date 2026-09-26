import { describe, it, expect } from "vitest";
import { testDoc } from "./fixtures/doc";
import { normalizeIntent } from "../src/intent/normalize";
import { planSongForm, buildSong, applySongCommand } from "../src/intent/song";
import { planMixProfile, applyMixIntent } from "../src/intent/mix";
import { composeFullTrack, POP_LOUDNESS_TARGET_LUFS } from "../src/intent/compose";
import { applyLoudnessIntent } from "../src/intent/loudness";
import type { SampleBank } from "../src/sample-library/factory";
import type { ProjectDocument } from "../src/project-model/types";

/**
 * POP PRODUCTION (Wave 4) — pop form (verse/pre-chorus/chorus, early hook),
 * pop mix (bright tilt + vocal glue + low-end control) and pop loudness
 * (−9 LUFS club target instead of streaming −14).
 */

describe("pop song form (style-gated, any genre)", () => {
  it("pop style gets verse/pre-chorus/chorus/bridge with an early hook", () => {
    const form = planSongForm(normalizeIntent({ genre: "house", seed: "pop-form", style: "pop" }));
    const roles = form.sections.map((s) => s.role);
    expect(roles).toEqual(["intro", "verse", "build", "chorus", "verse", "chorus", "bridge", "chorus", "outro"]);
    expect(form.sections.map((s) => s.label)).toContain("Pre-Chorus");
    expect(form.totalBars).toBe(56);
    // Pop rule: chorus before ~45 s — first chorus starts at bar 16 (≈31 s @124).
    const firstChorus = form.sections.findIndex((s) => s.role === "chorus");
    const barsBefore = form.sections.slice(0, firstChorus).reduce((sum, s) => sum + s.bars, 0);
    expect(barsBefore).toBe(16);
    expect((barsBefore * 4 * 60) / 124).toBeLessThan(45);
  });

  it("style wins over genre: trap+pop gets the pop form, plain trap keeps its own", () => {
    const pop = planSongForm(normalizeIntent({ genre: "trap", seed: "x", style: "pop" }));
    expect(pop.sections.map((s) => s.label)).toContain("Pre-Chorus");
    const plain = planSongForm(normalizeIntent({ genre: "trap", seed: "x" }));
    expect(plain.sections.map((s) => s.label)).not.toContain("Pre-Chorus");
  });

  it("plain house keeps the legacy form (no pre-chorus, intro is 8 bars)", () => {
    const form = planSongForm(normalizeIntent({ genre: "house", seed: "x" }));
    expect(form.sections[0]).toMatchObject({ role: "intro", bars: 8 });
    expect(form.sections.map((s) => s.label)).not.toContain("Pre-Chorus");
  });

  it("a pop song builds and installs end to end", async () => {
    const doc = testDoc();
    const build = await buildSong(doc, normalizeIntent({ genre: "house", seed: "pop-e2e", style: "pop" }), {
      yieldBetweenSections: false,
    });
    expect(build.sections.map((s) => s.label)).toContain("Chorus 1");
    const next = applySongCommand(doc, build).execute(doc);
    expect(next.scenes.some((s) => s.name === "Chorus 1")).toBe(true);
  }, 60_000);
});

describe("pop mix profile (bright + glue + low-end control)", () => {
  const pop = normalizeIntent({ genre: "house", seed: "pop-mix", style: "pop" });

  it("defaults to bright tilt with vocal glue and hp control", () => {
    const profile = planMixProfile(pop);
    expect(profile.summary.join(" ")).toContain("pop:");
    const glue = profile.decisions.filter((d) => d.effectType === "compressor" && d.params.ratio === 3);
    expect(glue.length).toBeGreaterThanOrEqual(2); // chords + lead
    const hp = profile.decisions.filter((d) => d.effectType === "eq" && d.params.hpFreq === 40);
    expect(hp.length).toBeGreaterThanOrEqual(2);
  });

  it("explicit mood tone still wins over the pop default", () => {
    const dark = planMixProfile(normalizeIntent({ genre: "house", seed: "x", style: "pop", mood: "dark" }));
    expect(dark.summary.join(" ")).not.toContain("tone: bright");
  });

  it("non-pop neutral intents get no pop decisions", () => {
    const plain = planMixProfile(normalizeIntent({ genre: "house", seed: "x" }));
    expect(plain.summary.join(" ")).not.toContain("pop:");
  });

  it("applies as one undo step", () => {
    const doc = testDoc();
    const cmd = applyMixIntent(doc, planMixProfile(pop));
    const next = cmd.execute(doc);
    expect(next.tracks.flatMap((t) => (t.kind === "instrument" ? t.effects : [])).length).toBeGreaterThan(0);
    expect(() => applyMixIntent(next, planMixProfile(pop))).toThrow(/changed nothing/);
  });
});

describe("pop loudness target (−9 LUFS club level)", () => {
  function loudRender(baseLufs: number) {
    return async (doc: ProjectDocument) => {
      const trim = doc.master?.loudnessTrimDb ?? 0;
      const amplitude = Math.min(1, 0.5 * Math.pow(10, (baseLufs + trim) / 20));
      const sampleRate = 44100;
      const length = sampleRate * 3;
      const data = new Float32Array(length);
      for (let i = 0; i < length; i++) data[i] = amplitude * Math.sin((2 * Math.PI * 997 * i) / sampleRate);
      return {
        numberOfChannels: 1,
        sampleRate,
        length,
        getChannelData: (channel: number) => (channel === 0 ? data : new Float32Array(length)),
        duration: length / sampleRate,
      } as unknown as AudioBuffer;
    };
  }

  it("pop-styled songs trim toward −9, others toward streaming −14", async () => {
    const bank = {} as unknown as SampleBank;
    const pop = await composeFullTrack(testDoc(), "house pop at 122", {
      input: { genre: "house" },
      seed: "pop-loud",
      loudness: true,
      bank,
      render: loudRender(-14),
    });
    expect(pop.loudness).not.toBeNull();
    const installed = pop.commands.song.execute(testDoc());
    const outcome = await pop.loudness!.run(installed);
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) expect(outcome.report.target).toBe(POP_LOUDNESS_TARGET_LUFS);

    const plain = await composeFullTrack(testDoc(), "house at 124", {
      input: { genre: "house" },
      seed: "plain-loud",
      loudness: true,
      bank,
      render: loudRender(-14),
    });
    const installedPlain = plain.commands.song.execute(testDoc());
    const outcomePlain = await plain.loudness!.run(installedPlain);
    expect(outcomePlain?.ok).toBe(true);
    if (outcomePlain?.ok) expect(outcomePlain.report.target).toBe(-14);
  }, 120_000);

  it("explicit loudness words still win over the pop default", async () => {
    const bank = {} as unknown as SampleBank;
    const result = await composeFullTrack(testDoc(), "house pop loudness na -12", {
      input: { genre: "house" },
      seed: "pop-loud-words",
      loudness: true,
      bank,
      render: loudRender(-14),
    });
    const installed = result.commands.song.execute(testDoc());
    const outcome = await result.loudness!.run(installed);
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) expect(outcome.report.target).toBe(-12);
  }, 120_000);
});

describe("pop loudness plumbing", () => {
  it("applyLoudnessIntent honors an explicit −9 target", async () => {
    const bank = {} as unknown as SampleBank;
    const doc = testDoc();
    const outcome = await applyLoudnessIntent(
      doc,
      bank,
      { direction: "louder", targetDb: -9, detected: [] },
      {
        render: async () => {
          const sampleRate = 44100;
          const length = sampleRate * 2;
          const data = new Float32Array(length);
          for (let i = 0; i < length; i++) data[i] = 0.4 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
          return {
            numberOfChannels: 1,
            sampleRate,
            length,
            getChannelData: () => data,
            duration: length / sampleRate,
          } as unknown as AudioBuffer;
        },
      },
    );
    expect(outcome.ok).toBe(true);
  });
});
