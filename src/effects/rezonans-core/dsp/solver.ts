/**
 * REZONANS — harmony target solver.
 *
 * The single place musical policy lives. It answers one question per voice:
 * "given the note the singer just sang and the musical context the host
 * supplied, what pitch should this voice sing?" Everything downstream is DSP.
 *
 * The input masks (scale, chord) are computed HOST-SIDE from
 * `SCALE_INTERVALS` / `CHORD_INTERVALS` (ADR 0040 decision 10), so this module
 * never carries a scale table and an arbitrary user scale costs no worklet
 * change.
 *
 * Pure, allocation-free and deterministic: no RNG, no hidden state. The same
 * (f0, context) always yields the same ratios, which is what makes the
 * live/offline parity golden meaningful.
 */

import { hzToMidi, MAX_RATIO, MIN_RATIO, nearestAllowedPc, nthScaleTone, type HarmonyMode } from "./harmony.js";

export interface SolverContext {
  mode: HarmonyMode;
  keyRootPc: number;
  scaleMask: number;
  chordMask: number;
  /** 0 = always scale degree, 1 = always chord tone. */
  chordFollow: number;
}

/** The MIDI note with pitch class `pc` nearest to `refMidi` (±6 covers all). */
function nearestMidiWithPc(refMidi: number, pc: number): number {
  const base = Math.round(refMidi);
  let best = base;
  let bestDist = Infinity;
  for (let d = -6; d <= 6; d++) {
    const cand = base + d;
    const candPc = ((cand % 12) + 12) % 12;
    if (candPc !== pc) continue;
    const dist = Math.abs(cand - refMidi);
    if (dist < bestDist) {
      bestDist = dist;
      best = cand;
    }
  }
  return best;
}

export const SOLVER_VOICES = 4;

export class HarmonySolver {
  /**
   * Resolved MIDI target per voice — diagnostics and hold-on-unvoiced.
   *
   * Reset fills `-1`, not `0`: MIDI 0 is 8.2 Hz, a pitch that could never be
   * sung, and the panel reads this array directly as "no target yet". Zero
   * would render as a bogus sub-bass note before the first sung vowel.
   */
  readonly lastMidi = new Float64Array(SOLVER_VOICES);

  /**
   * Resolve one pitch ratio per voice into `out`.
   *
   * The caller does NOT invoke this while the singer is unvoiced: holding the
   * previous ratio and fading is the safe response there, because chasing an
   * unreliable f0 is how a harmonizer turns consonants into robot noise.
   */
  solve(f0: number, ctx: SolverContext, degree: Float64Array, out: Float64Array): void {
    if (!(f0 > 0)) return;
    const refMidi = hzToMidi(f0);
    const refPc = ((Math.round(refMidi) % 12) + 12) % 12;

    for (let i = 0; i < SOLVER_VOICES; i++) {
      const d = Math.round(degree[i] ?? 0);
      let targetMidi: number;

      switch (ctx.mode) {
        case "interval": {
          // An interval is a distance from the singer's current pitch. Keep
          // the fractional MIDI part so vibrato and expressive intonation pass
          // through the harmonies instead of being quantized to equal tone.
          targetMidi = refMidi + d;
          break;
        }

        case "degrees": {
          const pc = nthScaleTone(ctx.scaleMask, ctx.keyRootPc, d);
          targetMidi = pc >= 0 ? nearestMidiWithPc(refMidi, pc) : refMidi;
          break;
        }

        case "chordTones": {
          const scalePc = nthScaleTone(ctx.scaleMask, ctx.keyRootPc, d);
          const scaleMidi = scalePc >= 0 ? nearestMidiWithPc(refMidi, scalePc) : refMidi;
          if (ctx.chordMask === 0) {
            // No chord lane, or before the first bar: the scale is all we know.
            targetMidi = scaleMidi;
            break;
          }
          // Keep each voice's configured scale-degree identity when snapping
          // it into the current chord. Snapping every voice from the singer's
          // pitch class made all enabled voices choose the same chord member.
          const chordAnchorPc = scalePc >= 0 ? scalePc : refPc;
          const chordPc = nearestAllowedPc(ctx.chordMask, chordAnchorPc);
          const chordMidi = nearestMidiWithPc(scaleMidi, chordPc);

          // `chordFollow` is a proximity-weighted candidate choice, not a
          // pitch crossfade. Blending adjacent note targets would create
          // detuned intermediate pitches; the processor glides the selected
          // target and this decision remains deterministic offline.
          const w = Math.max(0, Math.min(1, ctx.chordFollow));
          // `w = 0` means scale-only and `w = 1` means chord-only. Weight the
          // candidate being followed DOWN as its preference increases; the
          // previous polarity made the advertised CHORD FOLLOW setting choose
          // the scale candidate almost every time.
          const chordScore = Math.abs(chordMidi - refMidi) * (1 - w);
          const scaleScore = Math.abs(scaleMidi - refMidi) * w;
          targetMidi = chordScore <= scaleScore ? chordMidi : scaleMidi;
          break;
        }

        case "off":
        default:
          targetMidi = refMidi;
          break;
      }

      this.lastMidi[i] = targetMidi;
      const ratio = Math.pow(2, (targetMidi - refMidi) / 12);
      out[i] = ratio < MIN_RATIO ? MIN_RATIO : ratio > MAX_RATIO ? MAX_RATIO : ratio;
    }
  }

  reset(): void {
    this.lastMidi.fill(-1);
  }
}
