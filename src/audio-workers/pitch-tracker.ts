/**
 * Pitch Tracker Web Worker (hum-to-melody).
 *
 * Monophonic f0 tracker over raw mono PCM — YIN-style difference function
 * with cumulative-mean normalization, tuned for the HUMMED voice range
 * (~70…1050 Hz). Runs off the main thread: a 10 s take is ~500 frames of
 * ~400k ops each. Pure math — no AudioContext.
 *
 * Input:  { channelData: Float32Array, sampleRate: number }
 * Output: { frames: { timeSec, midi, clarity, rms }[] }
 *
 * `midi` is a continuous value (69 = A4); `clarity` 0..1 gates voicing —
 * segmentation into notes happens on the main thread (hum-to-notes.ts).
 */

export interface PitchFrame {
  timeSec: number;
  midi: number;
  clarity: number;
  rms: number;
}

export interface PitchTrackRequest {
  channelData: Float32Array;
  sampleRate: number;
}

export interface PitchTrackResponse {
  frames: PitchFrame[];
}

export const PITCH_TRACK_MIN_HZ = 70;
export const PITCH_TRACK_MAX_HZ = 1050;
/** Frames below this clarity are unvoiced (noise / breath / room). */
export const PITCH_CLARITY_GATE = 0.5;

export function trackPitch(data: Float32Array, sampleRate: number): PitchFrame[] {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || data.length < 2048) return [];

  const tauMin = Math.max(2, Math.floor(sampleRate / PITCH_TRACK_MAX_HZ));
  const tauMax = Math.min(Math.floor(sampleRate / PITCH_TRACK_MIN_HZ), Math.floor(data.length / 2) - 1);
  if (tauMax <= tauMin) return [];
  // Window long enough to cover 2 full periods at the lowest f0.
  const window = tauMax * 2;
  const hop = Math.max(64, Math.round(sampleRate * 0.01)); // ~10 ms
  const framesExpected = Math.floor((data.length - window) / hop) + 1;
  if (framesExpected < 4) return [];

  const frames: PitchFrame[] = [];
  let prevTau = 0;
  const diff = new Float64Array(tauMax + 1);
  const cmnd = new Float64Array(tauMax + 1);

  for (let f = 0; f < framesExpected; f++) {
    const start = f * hop;
    // Frame RMS for the voicing/velocity side-channel.
    let energy = 0;
    for (let i = start; i < start + window; i++) energy += data[i] * data[i];
    const rms = Math.sqrt(energy / window);

    // YIN difference function d(tau).
    for (let tau = tauMin; tau <= tauMax; tau++) {
      let sum = 0;
      for (let i = start; i < start + window - tau; i++) {
        const delta = data[i] - data[i + tau];
        sum += delta * delta;
      }
      diff[tau] = sum;
    }
    // Cumulative mean normalized difference d'(tau) (0 = perfectly periodic).
    let running = 0;
    cmnd[0] = 1;
    let bestTau = 0;
    let bestValue = 1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      running += diff[tau];
      cmnd[tau] = running === 0 ? 1 : (diff[tau] * (tau - tauMin + 1)) / running;
      if (cmnd[tau] < bestValue) {
        bestValue = cmnd[tau];
        bestTau = tau;
      }
    }
    // YIN absolute threshold: take the FIRST dip below it and descend to that
    // valley's local minimum. The global minimum would pick subharmonics —
    // every multiple of the true period is an equally perfect period
    // (d'(3τ) ≈ 0), which lands octaves and fifths BELOW the hummed pitch.
    let tauPick = bestTau;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmnd[tau] < 0.1) {
        let valley = tau;
        while (valley + 1 <= tauMax && cmnd[valley + 1] < cmnd[valley]) valley++;
        tauPick = valley;
        bestValue = cmnd[valley];
        break;
      }
    }
    // Parabolic refinement around the picked dip (sub-sample period → stabler
    // midi). Refines tauPick, not the global minimum — they differ when the
    // threshold path picked the first valley over a deeper subharmonic one.
    if (tauPick > tauMin && tauPick < tauMax) {
      const i0 = Math.round(tauPick - 1);
      const i1 = Math.round(tauPick);
      const i2 = Math.round(tauPick + 1);
      const s0 = cmnd[i0];
      const s1 = cmnd[i1];
      const s2 = cmnd[i2];
      const denom = 2 * (2 * s1 - s2 - s0);
      if (Math.abs(denom) > 1e-12) {
        const shift = (s2 - s0) / denom;
        if (Math.abs(shift) < 1) tauPick = tauPick + shift;
      }
    }

    if (rms < 1e-4 || bestValue > 1 - PITCH_CLARITY_GATE || bestTau === 0) {
      frames.push({ timeSec: start / sampleRate, midi: 0, clarity: Math.max(0, 1 - bestValue), rms });
      prevTau = 0;
      continue;
    }

    // Octave-jump correction against the previous frame: halves/doubles of
    // the previous period are accepted only when clearly better, otherwise
    // the previous period wins (hum glides stay on one octave).
    if (prevTau > 0) {
      const half = prevTau / 2;
      const dbl = prevTau * 2;
      if (tauPick > half * 1.3 && tauPick < half * 2.7 && cmnd[Math.round(half)] < bestValue + 0.1 && half >= tauMin) {
        tauPick = half;
      } else if (
        tauPick > dbl * 0.75 &&
        tauPick < dbl * 1.3 &&
        cmnd[Math.round(dbl)] < bestValue + 0.1 &&
        dbl <= tauMax
      ) {
        tauPick = dbl;
      }
    }
    prevTau = tauPick;

    const hz = sampleRate / tauPick;
    const midi = 69 + 12 * Math.log2(hz / 440);
    frames.push({ timeSec: start / sampleRate, midi: Number.isFinite(midi) ? midi : 0, clarity: Math.max(0, 1 - bestValue), rms });
  }
  return frames;
}

if (typeof self !== "undefined" && typeof (self as unknown as { postMessage?: unknown }).postMessage === "function") {
  (self as unknown as { onmessage: (e: MessageEvent<PitchTrackRequest>) => void }).onmessage = (
    e: MessageEvent<PitchTrackRequest>,
  ) => {
    // Validate before processing — extensions may postMessage into workers
    // that happen to have an onmessage handler (onset-detector contract).
    const { channelData, sampleRate } = e.data ?? {};
    if (!(channelData instanceof Float32Array) || typeof sampleRate !== "number" || !Number.isFinite(sampleRate)) {
      return; // not our message — ignore silently
    }
    const frames = trackPitch(channelData, sampleRate);
    (self as unknown as { postMessage: (msg: PitchTrackResponse) => void }).postMessage({ frames });
  };
}
