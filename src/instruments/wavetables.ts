/**
 * Wavetable data model and math — pure functions, no audio nodes.
 *
 * A wavetable is a stack of single-cycle frames (FRAME_SIZE samples each).
 * Playback crossfades between two adjacent frames based on the morph
 * position, which turns any static pair of frames into a moving timbre.
 */

export const FRAME_SIZE = 2048;
export const MAX_FRAMES = 16;

export interface Wavetable {
  name: string;
  frames: Float32Array[];
}

/* ---------------- factory tables (additive / phase math) ---------------- */

/** Remove DC offset and peak-normalize a frame in place-ish (returns new array). */
function normalizeFrame(frame: Float32Array): Float32Array {
  let mean = 0;
  for (let i = 0; i < frame.length; i++) mean += frame[i];
  mean /= frame.length;
  let peak = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] - mean;
    frame[i] = v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  if (peak > 0.00001) {
    const scale = 0.98 / peak;
    for (let i = 0; i < frame.length; i++) frame[i] *= scale;
  }
  return frame;
}

function buildFrame(count: number, fill: (i: number, n: number) => number): Float32Array {
  const frame = new Float32Array(count);
  for (let i = 0; i < count; i++) frame[i] = fill(i, count);
  return normalizeFrame(frame);
}

/** Inverse-FFT-style additive synthesis: harmonics amplitudes -> waveform. */
/** Frame 0 = pure sine, last frame = full saw (all partials at 1/h). */
function sineGrowTable(): Wavetable {
  const frames: Float32Array[] = [];
  const N = 8;
  const maxH = 64;
  for (let k = 0; k < N; k++) {
    const harmonics = 1 + Math.round((k / (N - 1)) * (maxH - 1));
    frames.push(
      buildFrame(FRAME_SIZE, (i, count) => {
        let v = 0;
        const w = (2 * Math.PI * i) / count;
        for (let h = 1; h <= harmonics; h++) v += (1 / h) * Math.sin(w * h);
        return v;
      }),
    );
  }
  return { name: "Sine Grow", frames };
}

/** Pulse-width sweep: duty 50% -> 8%, both odd and even harmonics. */
function pwmTable(): Wavetable {
  const frames: Float32Array[] = [];
  const N = 8;
  const H = 96;
  for (let k = 0; k < N; k++) {
    const duty = 0.5 - (k / (N - 1)) * 0.42;
    frames.push(
      buildFrame(FRAME_SIZE, (i, count) => {
        let v = 0;
        const w = (2 * Math.PI * i) / count;
        for (let h = 1; h <= H; h++) {
          const amp = (2 / (h * Math.PI)) * Math.sin(h * Math.PI * duty);
          v += amp * Math.sin(w * h);
        }
        return v;
      }),
    );
  }
  return { name: "PWM", frames };
}

/** Vowel-ish formant morph: two gaussian bumps gliding across the spectrum. */
function formantTable(): Wavetable {
  const frames: Float32Array[] = [];
  const N = 8;
  const H = 80;
  const gauss = (x: number, mu: number, sigma: number) => Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma));
  for (let k = 0; k < N; k++) {
    const t = k / (N - 1);
    const f1 = 4 + t * 3; // low formant creeps up
    const f2 = 22 - t * 12; // high formant glides down — ah -> ee -> oo-ish
    frames.push(
      buildFrame(FRAME_SIZE, (i, count) => {
        let v = 0;
        const w = (2 * Math.PI * i) / count;
        for (let h = 1; h <= H; h++) {
          const amp = (1 / h) * (gauss(h, f1, 3) + 0.8 * gauss(h, f2, 6));
          v += amp * Math.sin(w * h);
        }
        return v;
      }),
    );
  }
  return { name: "Formant", frames };
}

/** Digital/hollow spectra: harmonic gates driven by the frame position. */
function digitalTable(): Wavetable {
  const frames: Float32Array[] = [];
  const N = 8;
  const H = 72;
  for (let k = 0; k < N; k++) {
    const t = k / (N - 1);
    const gate = 2 + t * 7; // more gated gaps -> more hollow
    frames.push(
      buildFrame(FRAME_SIZE, (i, count) => {
        let v = 0;
        const w = (2 * Math.PI * i) / count;
        for (let h = 1; h <= H; h++) {
          const amp = Math.abs(Math.sin((h * Math.PI) / gate)) / Math.pow(h, 0.8);
          v += amp * Math.sin(w * h);
        }
        return v;
      }),
    );
  }
  return { name: "Digital", frames };
}

/** Two-operator FM with rising modulation index (0 -> 5, ratio 1:2). */
function fmTable(): Wavetable {
  const frames: Float32Array[] = [];
  const N = 8;
  for (let k = 0; k < N; k++) {
    const index = (k / (N - 1)) * 5;
    frames.push(
      buildFrame(FRAME_SIZE, (i, count) => {
        const phase = (2 * Math.PI * i) / count;
        return Math.sin(phase + index * Math.sin(2 * phase));
      }),
    );
  }
  return { name: "FM Drive", frames };
}

export const FACTORY_WAVETABLES: Wavetable[] = [sineGrowTable(), pwmTable(), formantTable(), digitalTable(), fmTable()];

export const FACTORY_TABLE_OPTIONS = FACTORY_WAVETABLES.map((t, i) => ({
  value: i,
  label: t.name,
}));

/* ---------------- extraction from arbitrary sample data ---------------- */

function sampleAt(data: Float32Array, pos: number): number {
  const i0 = Math.floor(pos);
  const frac = pos - i0;
  const a = data[i0] ?? 0;
  const b = data[i0 + 1] ?? a;
  return a + (b - a) * frac;
}

/**
 * Detect the fundamental period of `window` via normalized autocorrelation.
 * Returns the period in samples (fractional), or null when no periodicity
 * above the confidence threshold is found.
 */
export function detectPeriod(window: Float32Array, minLag: number, maxLag: number): number | null {
  let energy = 0;
  for (let i = 0; i < window.length; i++) energy += window[i] * window[i];
  if (energy < 1e-7) return null;

  let bestLag = -1;
  let best = 0;
  const correlations = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    let tailEnergy = 0;
    for (let i = 0; i + lag < window.length; i++) {
      sum += window[i] * window[i + lag];
      tailEnergy += window[i + lag] * window[i + lag];
    }
    const norm = Math.sqrt(energy * Math.max(tailEnergy, 1e-12));
    const r = sum / norm;
    correlations[lag] = r;
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }
  if (bestLag < 0 || best < 0.35) return null;

  // Prefer the shortest lag whose correlation is near the global max, so a
  // period multiple of the fundamental doesn't win.
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (
      correlations[lag] >= 0.9 * best &&
      correlations[lag] >= correlations[lag - 1] &&
      correlations[lag] >= correlations[lag + 1]
    ) {
      bestLag = lag;
      best = correlations[lag];
      break;
    }
  }

  // Parabolic interpolation around the peak for sub-sample precision.
  const l = correlations[bestLag - 1] ?? 0;
  const c = correlations[bestLag];
  const r = correlations[bestLag + 1] ?? 0;
  const denom = l - 2 * c + r;
  const delta = denom !== 0 ? (0.5 * (l - r)) / denom : 0;
  return bestLag + Math.max(-0.5, Math.min(0.5, delta));
}

/**
 * Extract a wavetable from arbitrary sample data: detect the fundamental
 * period, then slice consecutive cycles into fixed-size frames. Each frame
 * linearly crossfades between two adjacent source cycles, which keeps the
 * loop wrap seamless even when the detected period is fractional.
 *
 * Returns a single-frame table (centered slice) when no periodicity is
 * found — playable, but the morph slider does nothing.
 */
export function extractWavetable(data: Float32Array, sampleRate: number): Wavetable | null {
  if (data.length < FRAME_SIZE / 4) return null;

  const winLen = Math.min(Math.round(sampleRate * 0.05), Math.floor(data.length / 2));
  const winStart = Math.max(
    0,
    Math.min(data.length - winLen - 1, Math.round(data.length * 0.4) - Math.floor(winLen / 2)),
  );
  const window = data.subarray(winStart, winStart + winLen);

  const minLag = Math.max(8, Math.floor(sampleRate / 4000));
  const maxLag = Math.min(Math.floor(sampleRate / 30), Math.floor(window.length / 2));
  const period = detectPeriod(window, minLag, maxLag);

  if (period === null || period < 2) {
    // Aperiodic source: fall back to one frame cut from the analysis window.
    const fallback = new Float32Array(FRAME_SIZE);
    for (let i = 0; i < FRAME_SIZE; i++) {
      fallback[i] = sampleAt(window, (i / FRAME_SIZE) * (window.length - 1));
    }
    return { name: "Imported", frames: [normalizeFrame(fallback)] };
  }

  const cyclesAvailable = Math.floor((data.length - winStart) / period) - 1;
  const frameCount = Math.max(1, Math.min(MAX_FRAMES, cyclesAvailable));
  const frames: Float32Array[] = [];
  for (let k = 0; k < frameCount; k++) {
    const base = winStart + k * period;
    const next = winStart + (k + 1) * period;
    const hasNext = (k + 2) * period + winStart <= data.length;
    frames.push(
      buildFrame(FRAME_SIZE, (i, count) => {
        const t = i / count;
        const a = sampleAt(data, base + t * period);
        if (!hasNext) return a;
        // Linear crossfade between adjacent source cycles: constant-sum for
        // correlated content (no amplitude warp), while evolving timbres
        // smear smoothly across the frame. The wrap stays seamless because
        // the faded-in cycle k+1 ends where cycle k begins.
        const b = sampleAt(data, next + t * period);
        return a * (1 - t) + b * t;
      }),
    );
  }
  return { name: "Imported", frames };
}

/* ---------------- morph helpers ---------------- */

/** Adjacent frame pair + blend factor for a morph position in [0, 1]. */
export function morphFrames(
  frames: Float32Array[],
  morph: number,
): { a: Float32Array; b: Float32Array; blend: number } {
  if (frames.length === 0) throw new Error("empty wavetable");
  if (frames.length === 1) return { a: frames[0], b: frames[0], blend: 0 };
  const pos = Math.min(1, Math.max(0, morph)) * (frames.length - 1);
  const ia = Math.min(frames.length - 2, Math.floor(pos));
  return { a: frames[ia], b: frames[ia + 1], blend: pos - ia };
}
