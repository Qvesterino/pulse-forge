/**
 * Hum re-attack detection (onset-assisted segmentation).
 *
 * The stock onset-detector fires on energy FLUX against the surrounding
 * material — designed for percussive hits in sparse audio. A re-articulated
 * hummed note ("da-da" on ONE pitch) never passes its envelope test: the
 * material on BOTH sides of the attack is equally loud, so the settled
 * envelope never exceeds 1.5× the local mean.
 *
 * What characterizes a hum re-attack instead is a DIP: the voice drops
 * (consonant / breath) and jumps back up while the pitch stays voiced.
 * This detector finds those envelope dips: a local minimum below ~half of
 * the preceding level that recovers to ≥80% of it within ~150 ms. Pure and
 * deterministic — no worker needed (one envelope pass, ~ms for a take).
 */

export interface HumReAttackOptions {
  /** Dip depth relative to the level BEFORE the dip (0.5 = half). */
  dipRatio?: number;
  /** Recovery relative to the pre-dip level required after the dip. */
  recoveryRatio?: number;
}

export function detectHumReAttacks(
  data: Float32Array,
  sampleRate: number,
  options: HumReAttackOptions = {},
): number[] {
  const dipRatio = options.dipRatio ?? 0.5;
  const recoveryRatio = options.recoveryRatio ?? 0.8;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || data.length < sampleRate * 0.3) return [];

  // Envelope: 12 ms RMS windows, 6 ms hop — fine enough to catch a ~60 ms dip.
  const windowSize = Math.max(64, Math.round(sampleRate * 0.012));
  const hop = Math.max(32, Math.round(sampleRate * 0.006));
  const frames = Math.max(0, Math.floor((data.length - windowSize) / hop) + 1);
  if (frames < 8) return [];
  const env = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = start; i < start + windowSize; i++) sum += data[i] * data[i];
    env[f] = Math.sqrt(sum / windowSize);
  }
  // Light 3-tap smoothing so a single noisy frame can't fake a dip.
  const smooth = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const a = env[Math.max(0, f - 1)];
    const b = env[f];
    const c = env[Math.min(frames - 1, f + 1)];
    smooth[f] = (a + b + c) / 3;
  }
  // Sample-rate-derived frame spans.
  const beforeSpan = Math.max(2, Math.round((0.3 * frames) / (data.length / sampleRate)));
  const afterSpan = Math.max(2, Math.round((0.15 * frames) / (data.length / sampleRate)));

  const reAttacks: number[] = [];
  for (let f = 1; f < frames - 1; f++) {
    // Local minimum only.
    if (smooth[f] > smooth[f - 1] || smooth[f] > smooth[f + 1]) continue;
    const min = smooth[f];
    if (min < 1e-4) continue; // digital silence — a run gap, not an articulation

    let prevMax = 0;
    for (let j = Math.max(0, f - beforeSpan); j < f; j++) prevMax = Math.max(prevMax, smooth[j]);
    let nextMax = 0;
    for (let j = f; j < Math.min(frames, f + afterSpan); j++) nextMax = Math.max(nextMax, smooth[j]);

    // The dip: clearly below what came before, and the voice comes back.
    if (min < prevMax * dipRatio && nextMax >= prevMax * recoveryRatio && nextMax > min * 1.8) {
      // Report the RECOVERY point (where the new note starts sounding).
      let rise = f;
      while (rise + 1 < frames && smooth[rise + 1] < nextMax * 0.7) rise++;
      const timeSec = ((rise + 1) * hop + windowSize * 0.5) / sampleRate;
      // Deduplicate: one report per dip (the local-min scan visits it once,
      // but plateau dips can produce neighbors).
      const last = reAttacks[reAttacks.length - 1];
      if (last === undefined || timeSec - last > 0.1) reAttacks.push(timeSec);
    }
  }
  return reAttacks;
}
