/**
 * Shared waveshaping curves for the Saturation / Distortion character
 * engine (registry factories). Pure functions — unit-testable without
 * WebAudio.
 *
 * Modes (stable enum indices — serialized in the "character" param):
 *   0 Warm   — symmetric tanh, the classic glue saturation
 *   1 Tube   — asymmetric (even-harmonic lift), biased operating point
 *   2 Fold   — sine wavefolder, harmonic series grows with drive
 *   3 Hard   — clipped cubic, aggressive and compressed
 *
 * `bias` shifts the operating point (asymmetric transfer) — positive bias
 * pushes the negative half of the waveform into the curve harder (the
 * classic "tube bias" flavor). DC from the shift is removed by eval­uating
 * the offset curve symmetrically (f(x+b) − f(b)) so the effect never
 * thumps the output.
 */

export type CharacterMode = 0 | 1 | 2 | 3 | 4;

export const CHARACTER_MODE_COUNT = 5;

export const CHARACTER_MODE_LABELS = ["Warm", "Tube", "Fold", "Hard", "Tape"] as const;

/** Transfer function for one sample position x ∈ [−1, 1]. */
export function characterTransfer(mode: CharacterMode, x: number, drive: number, bias: number): number {
  // Per-mode drive scaling: fold needs radians, hard clips early.
  const b = Math.max(-1, Math.min(1, bias));
  const shift = b * 0.35;
  const shaped = (u: number): number => {
    switch (mode) {
      case 0: {
        const k = 1 + drive * 9;
        return Math.tanh(u * k) / Math.tanh(k);
      }
      case 1: {
        const k = 1 + drive * 7;
        const t = Math.tanh(u * k);
        // Even-harmonic lift: squared term biased positive, blended by drive.
        const even = t * Math.abs(t);
        return (t + 0.45 * drive * even) / (1 + 0.45 * drive);
      }
      case 2: {
        // Wavefolder: drive opens the fold count. Normalized to |y| ≤ 1.
        const k = 1 + drive * 7;
        return Math.sin(u * k) / Math.max(1, k);
      }
      case 3: {
        const k = 1 + drive * 5;
        const u2 = u * k;
        // 80/20 hard-clip/tanh shoulder: aggressive edge, forgiving corner.
        const hard = Math.max(-1, Math.min(1, u2));
        return 0.8 * hard + 0.2 * Math.tanh(u2);
      }
      case 4: {
        // Tape: arctan sigmoid — softer knee than tanh, gentle early
        // compression and a slightly rounded top (head saturation) with a
        // whisper of even harmonics from the bias shift.
        const k = 1 + drive * 6;
        return Math.atan(u * k) / Math.atan(k);
      }
      default:
        return Math.tanh(u);
    }
  };
  // Bias: evaluate the shifted operating point and remove the DC the shift
  // introduces (y(0) = 0 by construction — no output thump).
  const y = shaped(x + shift) - shaped(shift);
  // Bound: modes can overshoot near ±1 at high drive.
  return Math.max(-1, Math.min(1, y));
}

/** Build a WaveShaper curve (length 2048, x from −1 to 1). */
export function characterCurve(mode: CharacterMode, drive: number, bias: number): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = characterTransfer(mode, x, drive, bias);
  }
  return curve;
}
