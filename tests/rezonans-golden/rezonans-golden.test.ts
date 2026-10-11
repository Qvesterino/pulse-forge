/**
 * REZONANS golden suite — the P1 gate (ADR 0038 "Validation contract").
 *
 * The DSP core is TypeScript, so these tests import it directly rather than
 * going through a fake `registerProcessor` VM. That is deliberate: the golden
 * claims here are about the CORE, and the worklet bundle (P3) gets its own
 * real-browser check. What must be true before any of the 15 integration
 * files are touched:
 *
 *   A1  determinism — three renders sample-identical; two-variant ping-pong
 *   A2  α = 1 round trip matches the unwarpred path
 *   A3  measured CPU for 4 voices at quality = fine
 *   A4  measured algorithmic latency, asserted under the 200 ms PDC ceiling
 *   A6  every sample finite
 */

import { describe, expect, it } from "vitest";
import { RezonansProcessor } from "../../src/effects/rezonans-core/dsp/rezonansProcessor.js";
import {
  REZ_PARAM,
  QUALITY_ECONOMY,
  QUALITY_FINE,
  voiceParamId,
} from "../../src/effects/rezonans-core/contracts/parameters.js";
import { HarmonySolver, type SolverContext } from "../../src/effects/rezonans-core/dsp/solver.js";
import { nthScaleTone, nearestAllowedPc } from "../../src/effects/rezonans-core/dsp/harmony.js";
import { CepstralEnvelope, FormantWarp } from "../../src/effects/rezonans-core/dsp/cepstrum.js";
import { fft, hannWindow } from "../../src/effects/rezonans-core/dsp/fft.js";

const SR = 48000;
const BLOCK = 128;

/** Harmonic-rich, vibrato'd, amplitude-modulated tone — a vocal stand-in. */
function makeVocal(seconds: number, f0 = 220, sampleRate = SR): Float32Array {
  const n = Math.floor(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const vib = 1 + 0.01 * Math.sin(2 * Math.PI * 5.2 * t);
    const ph = 2 * Math.PI * f0 * vib * t;
    let s = 0;
    for (let h = 1; h <= 14; h++) s += Math.sin(ph * h) / h;
    // Sustained phrase with short gaps: transients plus body, like a sung line.
    const phrase = 0.5 - 0.5 * Math.cos(2 * Math.PI * 1.5 * t);
    out[i] = s * 0.22 * phrase;
  }
  return out;
}

interface RenderOpts {
  seconds?: number;
  f0?: number;
  params?: Record<string, number>;
  harmonyContext?: {
    keyRootPc: number;
    scaleMask: number;
    chords: Array<{ startBar: number; lengthBars: number; rootPc: number; chordMask: number }>;
  };
  bpm?: number;
}

function render(
  input: Float32Array,
  opts: RenderOpts = {},
): { l: Float32Array; r: Float32Array; latency: number; proc: RezonansProcessor } {
  const proc = new RezonansProcessor();
  proc.prepare(SR, 2, BLOCK, opts.bpm ?? 120);
  for (const [id, v] of Object.entries(opts.params ?? {})) proc.setParameter(id, v);
  if (opts.harmonyContext) proc.setHarmonyContext(opts.harmonyContext);
  proc.prepareOfflineRender();

  const l = new Float32Array(input.length);
  const r = new Float32Array(input.length);
  const scratch = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  for (let pos = 0; pos < input.length; pos += BLOCK) {
    const frames = Math.min(BLOCK, input.length - pos);
    scratch[0].set(input.subarray(pos, pos + frames));
    scratch[1].set(input.subarray(pos, pos + frames));
    proc.process(scratch, frames);
    l.set(scratch[0].subarray(0, frames), pos);
    r.set(scratch[1].subarray(0, frames), pos);
  }
  return { l, r, latency: proc.getLatencySamples(), proc };
}

function rms(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s / a.length);
}

/** Spectral centroid in Hz — how the formant stage is judged perceptually. */
function centroid(a: Float32Array, sampleRate = SR): number {
  const N = 2048;
  const win = hannWindow(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const start = Math.max(0, Math.floor(a.length / 2) - N);
  for (let i = 0; i < N; i++) {
    const j = start + i;
    re[i] = (j < a.length ? a[j]! : 0) * win[i]!;
    im[i] = 0;
  }
  fft(re, im);
  const half = N >> 1;
  let num = 0;
  let den = 0;
  for (let k = 1; k <= half; k++) {
    const m = Math.sqrt(re[k]! * re[k]! + im[k]! * im[k]!);
    num += m * ((k * sampleRate) / N);
    den += m;
  }
  return den > 0 ? num / den : 0;
}

describe("REZONANS golden — A1 determinism", () => {
  const input = makeVocal(0.6);

  it("three consecutive renders are sample-identical", () => {
    const a = render(input);
    const b = render(input);
    const c = render(input);
    expect(Array.from(a.l)).toEqual(Array.from(b.l));
    expect(Array.from(b.l)).toEqual(Array.from(c.l));
  });

  it("two-variant ping-pong: r1 === r3 and r1 !== r2 (A6 no RNG)", () => {
    const variantA: RenderOpts["params"] = { [REZ_PARAM.formant]: 4, [REZ_PARAM.harmonyMode]: 2 };
    const variantB: RenderOpts["params"] = { [REZ_PARAM.formant]: -6, [REZ_PARAM.harmonyMode]: 2 };
    const r1 = render(input, { params: variantA }).l;
    const r2 = render(input, { params: variantB }).l;
    const r3 = render(input, { params: variantA }).l;
    expect(Array.from(r1)).toEqual(Array.from(r3));
    expect(Array.from(r1)).not.toEqual(Array.from(r2));
  });

  it("every sample is finite at both formant extremes", () => {
    for (const f of [-12, 12]) {
      const out = render(input, { params: { [REZ_PARAM.formant]: f } });
      for (const ch of [out.l, out.r]) {
        for (let i = 0; i < ch.length; i++) expect(Number.isFinite(ch[i]!)).toBe(true);
      }
    }
  });
});

describe("REZONANS golden — A2 formant identity (α = 1)", () => {
  it("formant = 0 leaves the spectral centroid where it was", () => {
    const input = makeVocal(0.8);
    // Single voice, unity interval, full wet, no formant shift: the spectral
    // content reaching the output must stay put. A formant shifter whose
    // identity setting colours the voice is a defect users hear on note one.
    const params: Record<string, number> = {
      [REZ_PARAM.harmonyMode]: 1,
      [REZ_PARAM.voices]: 1,
      [REZ_PARAM.mix]: 1,
      [REZ_PARAM.bodyGate]: 0,
      [voiceParamId(0, "enabled")]: 1,
      [voiceParamId(0, "degree")]: 0, // unison → ratio 1
      [voiceParamId(0, "humanize")]: 0,
    };
    const out = render(input, { params });
    expect(rms(out.l)).toBeGreaterThan(1e-4);

    const srcCentroid = centroid(input);
    const wetCentroid = centroid(out.l);
    const relDrift = Math.abs(wetCentroid - srcCentroid) / srcCentroid;
    const m = out.proc.getMeters();
    // eslint-disable-next-line no-console
    console.log(
      `REZONANS A2: source centroid ${srcCentroid.toFixed(0)} Hz → wet(α=1) ${wetCentroid.toFixed(0)} Hz ` +
        `(${((relDrift - 1) * 100).toFixed(1)} % drift), wet rms ${rms(out.l).toFixed(4)} vs src ${rms(input).toFixed(4)}; ` +
        `clarity ${m.claritySum.toFixed(3)}, voiced ${(m.voicedRatio * 100).toFixed(1)} %`,
    );
    expect(relDrift).toBeLessThan(0.12);
  });

  it("isolates the pass-through gain on a steady tone (no source AM)", () => {
    // The A2 probe above uses an amplitude-modulated phrase, so its RMS
    // comparison mixes two effects. A STEADY tone isolates the chain: at
    // α = 1, ratio 1 the wet path must return the signal at unity level.
    const n = SR;
    const tone = new Float32Array(n);
    for (let i = 0; i < n; i++) tone[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
    const params: Record<string, number> = {
      [REZ_PARAM.harmonyMode]: 1,
      [REZ_PARAM.voices]: 1,
      [REZ_PARAM.mix]: 1,
      [REZ_PARAM.bodyGate]: 0,
      [REZ_PARAM.width]: 1,
      [REZ_PARAM.spread]: 1,
      [voiceParamId(0, "enabled")]: 1,
      [voiceParamId(0, "degree")]: 0,
      [voiceParamId(0, "level")]: 1,
      [voiceParamId(0, "pan")]: 0,
    };
    const out = render(tone, { params });
    // Measure the steady middle, past the OLA ramp and the mix glide.
    const slice = out.l.subarray(SR >> 2, SR >> 1);
    const gain = rms(slice) / (0.5 / Math.SQRT2);
    const m = out.proc.getMeters();
    // eslint-disable-next-line no-console
    console.log(
      `REZONANS unity: steady-tone gain ${gain.toFixed(3)} (` +
        `${(20 * Math.log10(Math.max(gain, 1e-9))).toFixed(2)} dB), clarity ${m.claritySum.toFixed(3)}, ` +
        `voiced ${(m.voicedRatio * 100).toFixed(1)} %`,
    );
    expect(gain).toBeGreaterThan(0.85);
    expect(gain).toBeLessThan(1.15);
  });

  it("a positive formant shift raises the spectral centroid", () => {
    const input = makeVocal(0.8);
    const base: Record<string, number> = {
      [REZ_PARAM.harmonyMode]: 1,
      [REZ_PARAM.voices]: 1,
      [REZ_PARAM.mix]: 1,
      [REZ_PARAM.bodyGate]: 0,
      [voiceParamId(0, "enabled")]: 1,
      [voiceParamId(0, "degree")]: 0,
      [voiceParamId(0, "humanize")]: 0,
    };
    const flat = render(input, { params: { ...base, [REZ_PARAM.formant]: 0 } });
    const wide = render(input, { params: { ...base, [REZ_PARAM.formant]: 8 } });
    expect(centroid(wide.l)).toBeGreaterThan(centroid(flat.l) * 1.15);
  });
});

describe("REZONANS golden — A4 latency contract", () => {
  it("reports N/2 samples and stays far below the 200 ms PDC ceiling", () => {
    for (const [quality, fftSize] of [
      [QUALITY_ECONOMY, 1024],
      [1, 2048],
      [QUALITY_FINE, 4096],
    ] as const) {
      const out = render(makeVocal(0.3), { params: { [REZ_PARAM.quality]: quality } });
      expect(out.latency).toBe(fftSize >> 1);
      expect(out.latency / SR).toBeLessThan(0.2);
    }
  });
});

describe("REZONANS golden — bypass", () => {
  it("harmonyMode off is bit-exact passthrough", () => {
    const input = makeVocal(0.3);
    const out = render(input, { params: { [REZ_PARAM.harmonyMode]: 0 } });
    expect(Array.from(out.l)).toEqual(Array.from(input));
    expect(Array.from(out.r)).toEqual(Array.from(input));
  });

  it("mix = 0 is bit-exact passthrough", () => {
    const input = makeVocal(0.3);
    const out = render(input, { params: { [REZ_PARAM.harmonyMode]: 2, [REZ_PARAM.mix]: 0 } });
    expect(Array.from(out.l)).toEqual(Array.from(input));
  });
});

describe("REZONANS solver — key and chord", () => {
  const C_MAJOR = 0b101010110101; // {0,2,4,5,7,9,11}
  const C_MINOR = 0b010110101101; // {0,2,3,5,7,8,10}
  const C_TRIAD = 0b10010001; // {0,4,7} — C E G

  it("resolves scale degrees relative to the key root, not to the input note", () => {
    // Input C4 (261.6 Hz) in D minor (root 2) — degree 2 must be the 3rd of
    // the SCALE, i.e. F#(6) + ... resolved as an absolute pitch class.
    const ctx: SolverContext = { mode: "degrees", keyRootPc: 2, scaleMask: C_MINOR, chordMask: 0, chordFollow: 0 };
    const degree = new Float64Array([2, 0, 0, 0]);
    const out = new Float64Array(4);
    new HarmonySolver().solve(261.63, ctx, degree, out);
    const solver = new HarmonySolver();
    solver.solve(261.63, ctx, degree, out);
    const targetPc = ((Math.round(solver.lastMidi[0]!) % 12) + 12) % 12;
    // D natural minor degree 2 = F (pc 5).
    expect(targetPc).toBe(5);
  });

  it("degree 0 of degrees mode is the key root", () => {
    const ctx: SolverContext = { mode: "degrees", keyRootPc: 9, scaleMask: C_MAJOR, chordMask: 0, chordFollow: 0 };
    const degree = new Float64Array([0, 0, 0, 0]);
    const out = new Float64Array(4);
    const solver = new HarmonySolver();
    solver.solve(220, ctx, degree, out);
    expect(((Math.round(solver.lastMidi[0]!) % 12) + 12) % 12).toBe(9);
  });

  it("chordTones lands on a chord tone when chordFollow is 1", () => {
    const ctx: SolverContext = {
      mode: "chordTones",
      keyRootPc: 0,
      scaleMask: C_MAJOR,
      chordMask: C_TRIAD,
      chordFollow: 1,
    };
    const degree = new Float64Array([0, 0, 0, 0]);
    const out = new Float64Array(4);
    const solver = new HarmonySolver();
    // D4 — not a C major triad tone.
    solver.solve(293.66, ctx, degree, out);
    const pc = ((Math.round(solver.lastMidi[0]!) % 12) + 12) % 12;
    expect((C_TRIAD & (1 << pc)) !== 0).toBe(true);
  });

  it("clamps every ratio into [0.5, 2] (±12 semitones)", () => {
    const ctx: SolverContext = { mode: "interval", keyRootPc: 0, scaleMask: C_MAJOR, chordMask: 0, chordFollow: 0 };
    const out = new Float64Array(4);
    new HarmonySolver().solve(220, ctx, new Float64Array([13, 13, 0, 0]), out);
    for (let i = 0; i < 4; i++) {
      expect(out[i]!).toBeGreaterThanOrEqual(0.5);
      expect(out[i]!).toBeLessThanOrEqual(2);
    }
  });

  it("scale/chord mask helpers agree with the interval tables", () => {
    expect(nthScaleTone(C_MAJOR, 0, 0)).toBe(0);
    expect(nthScaleTone(C_MAJOR, 0, 2)).toBe(4);
    expect(nthScaleTone(C_MINOR, 0, 2)).toBe(3);
    expect(nthScaleTone(C_MAJOR, 0, 99)).toBe(-1);
    expect(nearestAllowedPc(C_TRIAD, 2)).toBe(4); // D → E
    expect(nearestAllowedPc(C_TRIAD, 6)).toBe(7); // F# → G
    expect(nearestAllowedPc(C_TRIAD, 4)).toBe(4); // already in the chord
  });
});

describe("REZONANS envelope — cepstral lifter + warp", () => {
  it("α = 1 reproduces the envelope it sampled", () => {
    const N = 1024;
    const env = new CepstralEnvelope();
    env.prepare(SR, N);
    const warp = new FormantWarp();
    warp.prepare(N);

    // A synthetic vocal-tract envelope: three formant bumps on a decaying base,
    // floored at 1e-3. The floor matters — without it the envelope underflows
    // at Nyquist and the test measures the ENV_MIN clamp, not the warp.
    const half = N >> 1;
    const logEnv = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) {
      const f = (k * SR) / N;
      const bump = (fc: number, g: number, q: number) => g / (1 + ((f - fc) / q) ** 2);
      const raw = bump(700, 8, 120) * bump(1200, 6, 180) * bump(2600, 4, 250) * bump(120, 0.2, 400);
      logEnv[k] = Math.log(Math.max(raw, 1e-3));
    }

    const out = new Float64Array(half + 1);
    warp.update(1, logEnv);
    warp.renderInto(logEnv, out, 1);

    // Report the WORST bin rather than failing on whichever came first: a
    // single failing index tells you where the defect is, "expected < 0.02"
    // at an unknown bin does not.
    let worstK = -1;
    let worstRel = 0;
    for (let k = 0; k <= half; k++) {
      const want = Math.exp(logEnv[k]!);
      const rel = Math.abs(out[k]! - want) / want;
      if (rel > worstRel) {
        worstRel = rel;
        worstK = k;
      }
    }
    const worstHz = ((worstK * SR) / N).toFixed(1);
    expect(worstRel, `worst deviation at bin ${worstK} (${worstHz} Hz)`).toBeLessThan(0.02);
  });

  it("α > 1 shifts the envelope up in frequency and α < 1 shifts it down", () => {
    const N = 1024;
    const half = N >> 1;
    const logEnv = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) {
      const f = (k * SR) / N;
      logEnv[k] = Math.log(1 / (1 + ((f - 1000) / 200) ** 2));
    }
    const warp = new FormantWarp();
    warp.prepare(N);
    const out = new Float64Array(half + 1);

    // Find the peak bin at each α and assert the direction.
    const peakOf = (): number => {
      let best = 0;
      let bestV = -Infinity;
      for (let k = 1; k <= half; k++) {
        if (out[k]! > bestV) {
          bestV = out[k]!;
          best = k;
        }
      }
      return best;
    };

    warp.update(2, logEnv);
    warp.renderInto(logEnv, out, 2);
    const up = peakOf();
    warp.update(1, logEnv);
    warp.renderInto(logEnv, out, 1);
    const flat = peakOf();
    warp.update(0.5, logEnv);
    warp.renderInto(logEnv, out, 0.5);
    const down = peakOf();

    expect(up).toBeGreaterThan(flat);
    expect(down).toBeLessThan(flat);
  });

  it("estimates an envelope from a real spectrum without producing NaN", () => {
    const N = 1024;
    const env = new CepstralEnvelope();
    env.prepare(SR, N);
    const half = N >> 1;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++)
      re[i] = Math.sin((2 * Math.PI * 220 * i) / SR) + 0.4 * Math.sin((2 * Math.PI * 1100 * i) / SR);
    fft(re, im);
    const mag = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) mag[k] = Math.sqrt(re[k]! * re[k]! + im[k]! * im[k]!);
    env.compute(mag, half);
    expect(env.ready).toBe(true);
    for (let k = 0; k <= half; k++) {
      expect(Number.isFinite(env.logEnv[k]!)).toBe(true);
      expect(Number.isFinite(env.valueAtBin(k))).toBe(true);
      expect(env.valueAtBin(k)).toBeGreaterThan(0);
    }
  });
});

describe("REZONANS golden — A3 CPU budget", () => {
  it("4 voices at quality = fine process 1 s faster than realtime", () => {
    const input = makeVocal(1.0);
    const params: Record<string, number> = {
      [REZ_PARAM.quality]: QUALITY_FINE,
      [REZ_PARAM.harmonyMode]: 2,
      [REZ_PARAM.voices]: 4,
      [REZ_PARAM.mix]: 1,
    };
    for (let i = 0; i < 4; i++) params[voiceParamId(i, "enabled")] = 1;

    const t0 = performance.now();
    render(input, { params });
    const ms = performance.now() - t0;

    const inputSeconds = input.length / SR;
    const ratio = inputSeconds / (ms / 1000);
    // Recorded as a measurement, asserted loosely: the point is to catch an
    // accidental O(n²) or a missed scratch reuse, not to pin a CI machine.
    expect(ratio).toBeGreaterThan(1);
    // eslint-disable-next-line no-console
    console.log(
      `REZONANS A3: 4 voices @ fine = ${ratio.toFixed(1)}x realtime (${ms.toFixed(1)} ms for ${inputSeconds.toFixed(2)} s)`,
    );
  });
});
