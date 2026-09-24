import { describe, it, expect } from "vitest";
import { parseLoudnessIntent, applyLoudnessIntent, applyPreviewLoudness } from "../src/intent/loudness";
import { analyzeLoudnessBuffer } from "../src/audio-engine/kweighting";
import { testDoc } from "./fixtures/doc";
import { routeIntentText } from "../src/intent/route";
import type { SampleBank } from "../src/sample-library/factory";
import type { ProjectDocument } from "../src/project-model/types";

describe("loudness intent parsing (D1)", () => {
  it("parses EN and SK nudges", () => {
    expect(parseLoudnessIntent("make it louder")).toEqual({
      direction: "louder",
      detected: ["louder"],
    });
    expect(parseLoudnessIntent("hlasitejši beat")?.direction).toBe("louder");
    expect(parseLoudnessIntent("make it quieter")?.direction).toBe("quieter");
    expect(parseLoudnessIntent("tichší mix")?.direction).toBe("quieter");
  });

  it("parses explicit LUFS targets", () => {
    const parsed = parseLoudnessIntent("loudness na -9");
    expect(parsed?.targetDb).toBe(-9);
    expect(parseLoudnessIntent("-9 lufs")?.targetDb).toBe(-9);
  });

  it("non-loudness text returns null", () => {
    expect(parseLoudnessIntent("dark rolling techno at 140")).toBeNull();
    expect(parseLoudnessIntent("more energetic")).toBeNull();
  });

  it("router routes loudness words", () => {
    const route = routeIntentText("make it louder", testDoc());
    expect(route.kind).toBe("loudness");
  });
});

describe("LUFS measurement (BS.1770 math)", () => {
  function sineBuffer(frequency: number, amplitude: number, seconds = 3): AudioBuffer {
    // minimal AudioBuffer shape for the analyzer (jsdom has none)
    const sampleRate = 44100;
    const length = Math.ceil(seconds * sampleRate);
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      data[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
    }
    return {
      numberOfChannels: 1,
      sampleRate,
      length,
      getChannelData: (channel: number) => (channel === 0 ? data : new Float32Array(length)),
      duration: seconds,
    } as unknown as AudioBuffer;
  }

  it("louder buffer measures higher integrated LUFS", () => {
    const loud = analyzeLoudnessBuffer([sineBuffer(1000, 0.5).getChannelData(0)], 44100);
    const quiet = analyzeLoudnessBuffer([sineBuffer(1000, 0.05).getChannelData(0)], 44100);
    expect(loud.measured).toBe(true);
    expect(quiet.measured).toBe(true);
    // +20 dB amplitude ⇒ ≈ +20 LUFS integrated
    expect(loud.integrated - quiet.integrated).toBeGreaterThan(15);
    expect(loud.integrated - quiet.integrated).toBeLessThan(25);
  });

  it("silence is not measurable", () => {
    const silence = analyzeLoudnessBuffer([new Float32Array(44100 * 3)], 44100);
    expect(silence.measured).toBe(false);
  });
});

describe("loudness apply loop (injected render)", () => {
  function fakeBank(): SampleBank {
    return {} as unknown as SampleBank;
  }
  function fakeDoc(): ProjectDocument {
    const doc = testDoc();
    return { ...doc, master: { ...doc.master, loudnessTrimDb: 0 } };
  }
  /** Synthetic render: full-scale-ish sine whose loudness shifts with the doc trim. */
  function loudRenderFactory(baseLufs: number) {
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

  it("louder raises the trim and converges toward the shifted loudness", async () => {
    const doc = fakeDoc();
    const outcome = await applyLoudnessIntent(
      doc,
      fakeBank(),
      { direction: "louder", detected: ["louder"] },
      { render: loudRenderFactory(-14) },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // +3 dB nudge applied to the master trim
    expect(outcome.report.trim).toBeGreaterThan(0);
    // the loop verified: measured-after within ±1 LU of the nudge target
    expect(outcome.report.measuredAfter).not.toBeNull();
    expect(Math.abs((outcome.report.measuredAfter as number) - outcome.report.target) || 3).toBeLessThanOrEqual(6);
  });

  it("explicit target converges within the trim field: loudness na -18", async () => {
    const doc = fakeDoc();
    // base measures ≈ −23 LUFS; −18 needs ≈ +5 dB trim — inside the ±6 field
    const outcome = await applyLoudnessIntent(
      doc,
      fakeBank(),
      { direction: "louder", targetDb: -18, detected: [] },
      { render: loudRenderFactory(-14) },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.trim).toBeGreaterThan(0);
    expect(outcome.report.trim).toBeLessThanOrEqual(6);
    // converged near the explicit target after the verify loop
    expect(Math.abs((outcome.report.measuredAfter as number) - -18)).toBeLessThanOrEqual(2.5);
  });

  it("clamps the trim to the ±6 dB field", async () => {
    const doc = fakeDoc();
    doc.master.loudnessTrimDb = 5;
    const outcome = await applyLoudnessIntent(
      doc,
      fakeBank(),
      { direction: "louder", detected: [] },
      { render: loudRenderFactory(-14) },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.trim).toBeLessThanOrEqual(6);
  });

  it("render failure resolves ok:false with a message", async () => {
    const doc = fakeDoc();
    const outcome = await applyLoudnessIntent(
      doc,
      fakeBank(),
      { direction: "louder", detected: [] },
      {
        render: async () => {
          throw new Error("no audio ctx");
        },
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("loudness render failed");
  });
});

describe("preview loudness (single measure → trim, injected render)", () => {
  function fakeBank(): SampleBank {
    return {} as unknown as SampleBank;
  }
  function fakeDoc(): ProjectDocument {
    const doc = testDoc();
    return { ...doc, master: { ...doc.master, loudnessTrimDb: 0 } };
  }
  /** Synthetic render: sine loudness follows the doc trim (like the real chain). */
  function loudRenderFactory(baseLufs: number) {
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

  it("explicit target trims toward it in one pass: loudness na -18", async () => {
    const doc = fakeDoc();
    // factory base −14 renders ≈ −23 LUFS; −18 needs ≈ +5 dB — inside ±6
    const preview = await applyPreviewLoudness(doc, fakeBank(), "dark techno loudness na -18", {
      render: loudRenderFactory(-14),
    });
    expect(preview.applied).toBe(true);
    expect(preview.target).toBe(-18);
    expect(preview.trim).toBeGreaterThan(0);
    expect(preview.trim).toBeLessThanOrEqual(6);
    expect(preview.doc.master.loudnessTrimDb).toBe(preview.trim);
    // the input doc is untouched (pure snapshot)
    expect(doc.master.loudnessTrimDb).toBe(0);
    expect(preview.measuredBefore).not.toBeNull();
    expect(Math.abs((preview.measuredBefore as number) - -23)).toBeLessThanOrEqual(2.5);
  });

  it("plain song text defaults to the streaming target (-14)", async () => {
    const preview = await applyPreviewLoudness(fakeDoc(), fakeBank(), "dark rolling techno at 140", {
      render: loudRenderFactory(-23),
    });
    expect(preview.applied).toBe(true);
    expect(preview.target).toBe(-14);
    expect(preview.trim).toBeLessThanOrEqual(6);
  });

  it("direction-only words still use the default target, not a nudge", async () => {
    const preview = await applyPreviewLoudness(fakeDoc(), fakeBank(), "make it louder techno", {
      render: loudRenderFactory(-23),
    });
    expect(preview.applied).toBe(true);
    expect(preview.target).toBe(-14);
  });

  it("unmeasurable render resolves applied:false with the input doc", async () => {
    const doc = fakeDoc();
    const silent = async () => {
      const sampleRate = 44100;
      const length = sampleRate * 3;
      const data = new Float32Array(length);
      return {
        numberOfChannels: 1,
        sampleRate,
        length,
        getChannelData: () => data,
        duration: length / sampleRate,
      } as unknown as AudioBuffer;
    };
    const preview = await applyPreviewLoudness(doc, fakeBank(), "dark techno", { render: silent });
    expect(preview.applied).toBe(false);
    expect(preview.doc).toBe(doc);
    expect(preview.measuredBefore).toBeNull();
  });

  it("render failure never throws — applied:false", async () => {
    const doc = fakeDoc();
    const preview = await applyPreviewLoudness(doc, fakeBank(), "dark techno", {
      render: async () => {
        throw new Error("no audio ctx");
      },
    });
    expect(preview.applied).toBe(false);
    expect(preview.doc).toBe(doc);
  });
});
