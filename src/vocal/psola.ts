/**
 * TD-PSOLA (KROK 3 of HUM A HIT, 2026-10-12) — time-domain pitch shift
 * with FORMANT PRESERVATION.
 *
 * Why: resample-by-ratio moves formants WITH the pitch — a +12 st hum reads
 * as a chipmunk because the spectral envelope (the vocal resonances) doubles
 * too. TD-PSOLA keeps the envelope: the signal is cut at pitch-synchronous
 * epochs, and Hann windows centered on the source epochs are overlap-added
 * at the TARGET period spacing — each window carries the original formant
 * content, only the fundamental spacing changes.
 *
 * The pipeline for a hum lead:
 *   findEpochs       — global period (autocorrelation, first-strong-peak +
 *                      parabolic refinement) then pitch-synchronous snapping
 *                      (each next epoch = local energy max within ±25 % of
 *                      the period — follows vibrato, skips gate jitter)
 *   psolaShiftPitch  — synthesis epochs at targetPeriod = period / ratio,
 *                      each Hann window lifted from the NEAREST source epoch
 *
 * Pure DSP over Float32Array — no AudioContext, deterministic. Returns null
 * when the epochs are unusable (caller falls back to resample).
 */

const WINDOW = 4096;

export interface PsolaEpochs {
  /** Pitch-synchronous epoch positions (samples). */
  epochs: number[];
  /** The global period in samples (parabolically refined). */
  period: number;
}

/** The loudest WINDOW-sample window's start. */
function loudestWindowStart(audio: Float32Array): number {
  let best = 0;
  let bestRms = -1;
  for (let start = 0; start + WINDOW <= audio.length; start += WINDOW / 2) {
    let sum = 0;
    for (let i = 0; i < WINDOW; i++) sum += audio[start + i] * audio[start + i];
    const rms = Math.sqrt(sum / WINDOW);
    if (rms > bestRms) {
      bestRms = rms;
      best = start;
    }
  }
  return best;
}

/** Autocorrelation period estimate — first-strong-peak + parabolic refine. */
function estimatePeriod(audio: Float32Array, sampleRate: number, start: number): number | null {
  const minLag = Math.max(2, Math.floor(sampleRate / 500));
  const maxLag = Math.min(WINDOW - 2, Math.floor(sampleRate / 60));
  let energy = 0;
  for (let i = 0; i < WINDOW; i++) energy += audio[start + i] * audio[start + i];
  if (energy < 1e-6) return null;
  let bestScore = 0;
  const scores: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < WINDOW - lag; i++) sum += audio[start + i] * audio[start + i + lag];
    const score = sum / (WINDOW - lag);
    scores[lag] = score;
    if (score > bestScore) bestScore = score;
  }
  if (bestScore <= 0) return null;
  // First LOCAL maximum ≥ 0.8 of the best — the fundamental (a global max
  // lands on period multiples; a threshold scan picks peak shoulders).
  let bestLag = 0;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (scores[lag] >= bestScore * 0.8 && scores[lag] >= scores[lag - 1] && scores[lag] >= scores[lag + 1]) {
      bestLag = lag;
      break;
    }
  }
  if (bestLag === 0) return null;
  const left = scores[bestLag - 1];
  const center = scores[bestLag];
  const right = scores[bestLag + 1];
  const denom = left - 2 * center + right;
  const shift = denom !== 0 ? (0.5 * (left - right)) / denom : 0;
  return bestLag + Math.max(-1, Math.min(1, shift));
}

/**
 * Pitch-synchronous epochs: the first energy peak, then each next epoch
 * snapped to the local |audio| maximum within ±25 % of the period. Returns
 * null when the audio is too short/silent to carry a period.
 */
export function findEpochs(audio: Float32Array, sampleRate: number): PsolaEpochs | null {
  if (audio.length < WINDOW) return null;
  const start = loudestWindowStart(audio);
  const period = estimatePeriod(audio, sampleRate, start);
  if (period === null || period < 2) return null;
  // First epoch: the strongest sample inside the first period after the
  // loud window starts.
  const searchFrom = Math.min(start, Math.max(0, audio.length - Math.ceil(period)));
  let first = searchFrom;
  let bestAmp = -1;
  for (let i = searchFrom; i < Math.min(audio.length, searchFrom + Math.ceil(period)); i++) {
    if (Math.abs(audio[i]) > bestAmp) {
      bestAmp = Math.abs(audio[i]);
      first = i;
    }
  }
  const epochs: number[] = [first];
  const reach = Math.floor(period * 0.25);
  let next = first;
  while (next + period * 0.5 < audio.length) {
    next += period;
    const from = Math.max(0, Math.floor(next - reach));
    const to = Math.min(audio.length - 1, Math.ceil(next + reach));
    let snap = Math.floor(next);
    let bestAmp = -1;
    for (let i = from; i <= to; i++) {
      if (Math.abs(audio[i]) > bestAmp) {
        bestAmp = Math.abs(audio[i]);
        snap = i;
      }
    }
    // Monotonic guard: an epoch must advance past the previous one.
    if (snap <= epochs[epochs.length - 1]) snap = epochs[epochs.length - 1] + Math.max(1, Math.round(period));
    epochs.push(snap);
  }
  return { epochs, period: Math.round(period) };
}

/**
 * TD-PSOLA pitch shift, time-scale 1 (same length as the input). Ratio > 1
 * raises the pitch. Returns null when fewer than 2 usable epochs — the
 * caller falls back to plain resampling.
 */
export function psolaShiftPitch(audio: Float32Array, sampleRate: number, ratio: number): Float32Array | null {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio === 1) return audio === null ? null : audio.slice();
  const found = findEpochs(audio, sampleRate);
  if (!found || found.epochs.length < 2) return null;
  const { epochs, period } = found;
  const targetPeriod = Math.max(2, period / ratio);
  const half = period; // window half-length = one source period
  const padded = new Float32Array(audio.length + 2 * half);
  padded.set(audio, half);

  const out = new Float32Array(audio.length);
  // Synthesis epochs walk the output at the target spacing. The TEXTBOOK
  // mapping is index-proportional: synthesis epoch k pulls analysis epoch
  // floor(k / ratio) — each source window is reused `ratio` times in a row
  // (pitch up) or skipped (pitch down), which keeps the OLA sum coherent.
  // A nearest-to-time mapping instead lets synthesis positions drift across
  // source windows — amplitude modulation and a mushy render.
  let k = 0;
  for (let t = 0; t < audio.length; t += targetPeriod) {
    const srcIndex = Math.min(epochs.length - 1, Math.floor(k / ratio));
    k += 1;
    const center = epochs[srcIndex];
    const from = center - half;
    for (let i = -half; i < half; i++) {
      const read = from + i;
      const write = t + i;
      if (read < 0 || read >= audio.length) continue;
      if (write < 0 || write >= out.length) continue;
      const h = 0.5 * (1 + Math.cos((Math.PI * i) / half)); // Hann
      out[write] += padded[half + read] * h;
    }
  }
  return out;
}
