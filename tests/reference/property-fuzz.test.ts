/**
 * Property-based invariants for `analyzeReference` — seeded, no dependencies.
 *
 * `tests/reference/golden.test.ts` pins *known* outputs. This file pins the
 * contract that must hold for **every** input, including inputs nobody would
 * write by hand: clipped buffers, DC-offset-only buffers, single-sample
 * buffers, metadata whose `duration` disagrees with the PCM length, reversed
 * tempo ranges, hop sizes larger than the FFT window, and analysis rates above
 * the source rate.
 *
 * The generator is a seeded mulberry32 PRNG, so a failure reproduces exactly
 * from the seed printed in the assertion message. That is the whole reason
 * this is hand-rolled rather than `fast-check`: the seed is the counterexample.
 *
 * Two invariants carry the most weight:
 *
 *   1. **No NaN / Infinity anywhere in the result.** The F1 promise is "ticho
 *      a krátke súbory → poctivé null + warning, nie vymyslené čísla". A NaN
 *      BPM is worse than a null BPM: it serializes into the project document
 *      and detonates later in a comparison the user never sees.
 *   2. **Nullable sides stay internally consistent.** `bpm === null` must come
 *      with an empty candidate list and a null beat interval; a non-null `bpm`
 *      must have `beatIntervalSeconds === 60 / bpm`. A half-null rhythm is the
 *      shape that makes a UI panel render `NaN BPM` in the transport readout.
 */

import { describe, expect, it } from "vitest";
import { analyzeReference } from "../../src/reference/analysis/analyzeReference";
import { PITCH_CLASSES, type ReferenceMap, type ReferenceOptions } from "../../src/reference/types";
import { FIXTURE_SR, clickTrack, makeMetadata } from "./_fixtures";

/** Deterministic 32-bit PRNG (mulberry32). Same seed → same stream. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STABILITIES = ["stable", "mostly-stable", "variable", "unknown"] as const;

/** Recursively assert every number in the tree is finite. */
function assertNoNonFinite(value: unknown, path: string, seed: number): void {
  if (typeof value === "number") {
    expect(Number.isFinite(value), `seed=${seed} path=${path} → ${value}`).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoNonFinite(v, `${path}[${i}]`, seed));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) assertNoNonFinite(v, `${path}.${k}`, seed);
  }
}

/**
 * The full invariant set for one ReferenceMap. Throws with the seed so the
 * failing input is reproducible without a shrinker.
 */
function assertInvariants(result: ReferenceMap, onsetEnvelope: number[], seed: number): void {
  const { rhythm, tonal, diagnostics } = result;
  const fail = (msg: string): never => {
    throw new Error(`seed=${seed}: ${msg}\nrhythm=${JSON.stringify(rhythm)}\ntonal=${JSON.stringify(tonal)}`);
  };

  assertNoNonFinite(result, "result", seed);
  assertNoNonFinite(onsetEnvelope, "onsetEnvelope", seed);

  // --- shape -------------------------------------------------------------
  if (!Array.isArray(result.warnings)) fail("warnings must be an array");
  if (!Array.isArray(diagnostics.tempoRange) || diagnostics.tempoRange.length !== 2) {
    fail("tempoRange must be a 2-tuple");
  }
  const [tempoMin, tempoMax] = diagnostics.tempoRange;

  // --- rhythm ------------------------------------------------------------
  if (rhythm.confidence < 0 || rhythm.confidence > 1) fail(`rhythm.confidence out of 0..1: ${rhythm.confidence}`);
  if (!STABILITIES.includes(rhythm.stability as (typeof STABILITIES)[number])) {
    fail(`unknown stability: ${rhythm.stability}`);
  }

  if (rhythm.bpm === null) {
    // Honest-null contract: no half-populated rhythm.
    if (rhythm.beatIntervalSeconds !== null) fail("bpm===null but beatIntervalSeconds is set");
    if (rhythm.beatTimes.length !== 0) fail("bpm===null but beatTimes is non-empty");
    if (rhythm.candidates.length !== 0) fail("bpm===null but candidates is non-empty");
    if (!rhythm.warning) fail("bpm===null without a warning");
  } else {
    if (rhythm.bpm < tempoMin || rhythm.bpm > tempoMax) {
      fail(`bpm ${rhythm.bpm} outside the reported tempoRange [${tempoMin}, ${tempoMax}]`);
    }
    if (rhythm.beatIntervalSeconds === null) fail("bpm set but beatIntervalSeconds is null");
    else if (Math.abs(rhythm.beatIntervalSeconds - 60 / rhythm.bpm) > 1e-6) {
      fail(`beatIntervalSeconds ${rhythm.beatIntervalSeconds} !== 60/bpm ${60 / rhythm.bpm}`);
    }
    if (rhythm.beatOffsetSeconds === null) fail("bpm set but beatOffsetSeconds is null");
    const primary = rhythm.candidates.find((c) => c.relation === "primary");
    if (!primary) fail("bpm set without a primary candidate");
    else if (Math.abs(primary.bpm - rhythm.bpm) > 1e-6) {
      fail(`primary candidate ${primary.bpm} !== bpm ${rhythm.bpm}`);
    }
    // Beat grid must be a strictly increasing, in-bounds sequence.
    let previous = -1;
    for (const t of rhythm.beatTimes) {
      if (t < 0) fail(`negative beat time ${t}`);
      if (t < previous) fail(`beat times not monotonic: ${t} after ${previous}`);
      previous = t;
    }
  }

  // --- tonal -------------------------------------------------------------
  if (tonal.confidence < 0 || tonal.confidence > 1) fail(`tonal.confidence out of 0..1: ${tonal.confidence}`);
  if (tonal.chroma.length !== 12) fail(`chroma must have 12 bins, got ${tonal.chroma.length}`);
  for (const bin of tonal.chroma) {
    if (bin < 0) fail(`negative chroma bin ${bin}`);
  }
  if (diagnostics.tonalFrameCount > 0) {
    const sum = tonal.chroma.reduce((a, b) => a + b, 0);
    if (sum <= 0) fail("chroma has frames but sums to 0");
    // extractChroma normalizes by the total, so a live chroma sums to 1.
    if (Math.abs(sum - 1) > 1e-6) fail(`normalized chroma sums to ${sum}, expected 1`);
  }

  if (tonal.tonic === null) {
    if (tonal.mode !== null) fail("tonic===null but mode is set");
    if (tonal.camelot !== null) fail("tonic===null but camelot is set");
    if (tonal.candidates.length !== 0) fail("tonic===null but candidates is non-empty");
    if (!tonal.warning) fail("tonic===null without a warning");
  } else {
    if (!(PITCH_CLASSES as readonly string[]).includes(tonal.tonic)) fail(`tonic not a pitch class: ${tonal.tonic}`);
    if (tonal.mode !== "major" && tonal.mode !== "minor") fail(`mode not major|minor: ${tonal.mode}`);
    if (typeof tonal.camelot !== "string" || !/^\d{1,2}[AB]$/.test(tonal.camelot)) {
      fail(`camelot is not a Camelot wheel code: ${tonal.camelot}`);
    }
    if (tonal.candidates.length === 0) fail("tonic set but candidates is empty");
    if (tonal.candidates.length > 5) fail(`candidates should cap at 5, got ${tonal.candidates.length}`);
    // Candidates must be sorted by descending score.
    for (let i = 1; i < tonal.candidates.length; i++) {
      if (tonal.candidates[i - 1].score < tonal.candidates[i].score) fail("tonal candidates not sorted by score desc");
    }
  }

  // --- diagnostics -------------------------------------------------------
  if (diagnostics.processingMs < 0) fail(`negative processingMs ${diagnostics.processingMs}`);
  if (diagnostics.frameCount < 0) fail(`negative frameCount ${diagnostics.frameCount}`);
  if (diagnostics.tonalFrameCount < 0) fail(`negative tonalFrameCount`);
  if (diagnostics.peakAmplitude < 0) fail(`negative peakAmplitude ${diagnostics.peakAmplitude}`);
  if (diagnostics.analysisSampleRate <= 0) fail(`non-positive analysisSampleRate ${diagnostics.analysisSampleRate}`);
  if (diagnostics.analysisSampleRate > Math.max(1, result.metadata.sampleRate)) {
    fail(`analysisSampleRate ${diagnostics.analysisSampleRate} exceeds source ${result.metadata.sampleRate}`);
  }
  if (diagnostics.onsetEnvelopeLength !== onsetEnvelope.length && onsetEnvelope.length !== 0) {
    // The display envelope is max-pooled to ~1500 buckets, so it is only
    // required to be a reduction of the full envelope, never longer than it.
    if (onsetEnvelope.length > diagnostics.onsetEnvelopeLength) {
      fail(`display envelope (${onsetEnvelope.length}) longer than source (${diagnostics.onsetEnvelopeLength})`);
    }
  }
  for (const v of onsetEnvelope) {
    if (v < 0) fail(`negative onset envelope bucket ${v}`);
  }
}

// ---------------------------------------------------------------------------
// Signal generators — deliberately awkward, all seeded from one PRNG.
// ---------------------------------------------------------------------------

type SignalKind = "noise" | "clicks" | "tonal" | "dc" | "clipped" | "impulses" | "ramp" | "square";

function makeSignal(kind: SignalKind, seconds: number, sampleRate: number, rand: () => number): Float32Array {
  const n = Math.max(0, Math.floor(seconds * sampleRate));
  const out = new Float32Array(n);
  switch (kind) {
    case "noise":
      for (let i = 0; i < n; i++) out[i] = rand() * 2 - 1;
      break;
    case "clicks": {
      const bpm = 40 + rand() * 160;
      const period = Math.max(1, Math.round((60 / bpm) * sampleRate));
      for (let i = 0; i < n; i += period) {
        const len = Math.min(period, Math.max(1, Math.round(0.02 * sampleRate)));
        for (let j = i; j < Math.min(n, i + len); j++) out[j] = (rand() * 2 - 1) * 0.9;
      }
      break;
    }
    case "tonal": {
      const f = 55 * Math.pow(2, Math.floor(rand() * 36) / 12);
      for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * f * i) / sampleRate) * 0.5;
      break;
    }
    case "dc":
      // Pure DC has no AC content — preprocess strips the mean, so this must
      // land in the silent branch rather than being analysed as music.
      out.fill(0.7);
      break;
    case "clipped":
      for (let i = 0; i < n; i++) out[i] = rand() > 0.5 ? 1 : -1;
      break;
    case "impulses":
      for (let i = 0; i < n; i++) if (rand() < 0.001) out[i] = 1;
      break;
    case "ramp":
      for (let i = 0; i < n; i++) out[i] = n > 1 ? (i / n) * 2 - 1 : 0;
      break;
    case "square":
      for (let i = 0; i < n; i++) out[i] = Math.floor(i / Math.max(1, sampleRate * 0.1)) % 2 ? 0.8 : -0.8;
      break;
  }
  return out;
}

const KINDS: SignalKind[] = ["noise", "clicks", "tonal", "dc", "clipped", "impulses", "ramp", "square"];
const DURATIONS = [0, 0.05, 0.4, 1, 2.5, 6, 11];
const SAMPLE_RATES = [8000, 16000, 22050, 44100, 48000];

/** Hostile but valid options — never an FFT size that the radix-2 core rejects. */
function makeOptions(rand: () => number): Partial<ReferenceOptions> {
  const roll = rand();
  if (roll < 0.12) return { tempoMin: 200, tempoMax: 60 }; // reversed
  if (roll < 0.2) return { tempoMin: 120, tempoMax: 120 }; // degenerate single point
  if (roll < 0.3) return { keyRegion: "full" };
  if (roll < 0.4) return { fftSize: 512, hopSize: 1024 }; // hop > fft
  if (roll < 0.5) return { fftSize: 1024, hopSize: 128 };
  if (roll < 0.6) return { analysisSampleRate: 96000 }; // above every source rate
  if (roll < 0.7) return { analysisSampleRate: 4000 };
  return {};
}

describe("reference property fuzz — invariants hold for every input", () => {
  it("holds across 160 seeded random signals × option combinations", () => {
    const CASES = 160;
    for (let seed = 1; seed <= CASES; seed++) {
      const rand = mulberry32(seed);
      const kind = KINDS[Math.floor(rand() * KINDS.length)];
      const seconds = DURATIONS[Math.floor(rand() * DURATIONS.length)];
      const sampleRate = SAMPLE_RATES[Math.floor(rand() * SAMPLE_RATES.length)];
      const mono = makeSignal(kind, seconds, sampleRate, rand);
      // Every third case lies about duration — the decoder can hand us a
      // header that disagrees with the decoded PCM, and the analyzer must not
      // index past the buffer because of it.
      const declared = rand() < 0.33 ? seconds * (0.5 + rand() * 2) : seconds;
      const metadata = makeMetadata(declared, { sampleRate, name: `fuzz-${seed}` });
      const options = makeOptions(rand);

      let out: ReturnType<typeof analyzeReference>;
      try {
        out = analyzeReference({ mono, metadata, options });
      } catch (error) {
        throw new Error(
          `seed=${seed} threw (kind=${kind}, ${seconds}s @ ${sampleRate}Hz, options=${JSON.stringify(options)}): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      assertInvariants(out.result, out.onsetEnvelope, seed);
    }
  });

  it("never throws for a buffer whose header duration is wildly wrong", () => {
    const rand = mulberry32(0xbeef);
    for (const declared of [0, 0.001, 3600, -5]) {
      const mono = clickTrack(120, 4);
      const metadata = makeMetadata(declared, { name: `wrong-${declared}` });
      expect(() => analyzeReference({ mono, metadata })).not.toThrow();
      rand();
    }
  });

  it("survives degenerate buffer lengths — empty, one sample, sub-frame", () => {
    for (const n of [0, 1, 7, 100, 2047]) {
      const mono = new Float32Array(n);
      for (let i = 0; i < n; i++) mono[i] = Math.sin(i * 0.3) * 0.8;
      const metadata = makeMetadata(n / FIXTURE_SR, { name: `len-${n}` });
      let out: ReturnType<typeof analyzeReference>;
      expect(() => {
        out = analyzeReference({ mono, metadata });
      }, `length=${n}`).not.toThrow();
      // Short buffers legitimately report null rhythm — the point is that the
      // null is well-formed, not that a number was invented.
      expect(out!.result.rhythm.bpm === null || typeof out!.result.rhythm.bpm === "number").toBe(true);
    }
  });
});

describe("reference property fuzz — explicit boundaries", () => {
  it("rejects a non-power-of-two FFT size instead of producing garbage", () => {
    // ReferenceFft is radix-2; a 1000-sample window cannot be transformed. The
    // throw is the honest outcome — silently zeroing the spectrum would report
    // a fabricated tempo. fftSize is internal, so this guards a future caller.
    const mono = clickTrack(120, 4);
    expect(() => analyzeReference({ mono, metadata: makeMetadata(4), options: { fftSize: 1000 } })).toThrow(
      /power of two/i,
    );
  });

  it("reports silence for a DC-only buffer rather than analysing the offset", () => {
    // preprocess removes the mean, so a constant buffer is genuinely silent.
    // Reporting a tempo here would be the "vymyslené čísla" failure the F1
    // contract forbids.
    const mono = new Float32Array(FIXTURE_SR * 3).fill(0.8);
    const out = analyzeReference({ mono, metadata: makeMetadata(3, { name: "dc" }) });
    expect(out.result.rhythm.bpm).toBeNull();
    expect(out.result.tonal.tonic).toBeNull();
    expect(out.result.warnings.join(" ")).toMatch(/silent/i);
  });

  it("keeps tempoMin above tempoMax from producing a BPM outside both bounds", () => {
    // A reversed range means no candidate can satisfy the filter, so rhythm
    // must fall back to the honest null rather than clamping a number through.
    const mono = clickTrack(128, 8);
    const out = analyzeReference({
      mono,
      metadata: makeMetadata(8, { name: "reversed" }),
      options: { tempoMin: 200, tempoMax: 60 },
    });
    expect(out.result.diagnostics.tempoRange).toEqual([200, 60]);
    if (out.result.rhythm.bpm !== null) {
      const [min, max] = out.result.diagnostics.tempoRange;
      expect(out.result.rhythm.bpm).toBeGreaterThanOrEqual(Math.min(min, max));
      expect(out.result.rhythm.bpm).toBeLessThanOrEqual(Math.max(min, max));
    }
  });

  it("is deterministic under repeated calls with the same options", () => {
    // The same guard as determinism.test.ts, but across the hostile option set
    // rather than only the defaults — a non-power-of-two-free option combo that
    // reordered its candidate list would only show up here.
    const rand = mulberry32(0xfeed);
    for (let i = 0; i < 12; i++) {
      const kind = KINDS[Math.floor(rand() * KINDS.length)];
      const mono = makeSignal(kind, 3, FIXTURE_SR, rand);
      const metadata = makeMetadata(3, { name: `det-${i}` });
      const options = makeOptions(rand);
      const a = analyzeReference({ mono, metadata, options });
      const b = analyzeReference({ mono, metadata, options });
      expect({ ...a.result, diagnostics: { ...a.result.diagnostics, processingMs: 0 } }).toStrictEqual({
        ...b.result,
        diagnostics: { ...b.result.diagnostics, processingMs: 0 },
      });
    }
  });
});
