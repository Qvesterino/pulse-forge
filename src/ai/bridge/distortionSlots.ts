/**
 * Distortion parameter contract for the AI bridge.
 *
 * Same whitelist hazard as every other `*Slots.ts` here.
 *
 * Canonical ids (verified in three places):
 *   - src/effects/definitions.ts → `distortionParams`
 *   - src/effects/registry.ts → the `distortion` `apply()` switch
 *   - src/effects/characterCurve.ts → `CHARACTER_MODE_LABELS` / `CharacterMode`
 *
 * ⚠️ `character` IS A DISCRETE ENUM, NOT A CONTINUOUS KNOB:
 *
 *     CHARACTER_MODE_LABELS = ["Warm", "Tube", "Fold", "Hard", "Tape"]
 *     type CharacterMode = 0 | 1 | 2 | 3 | 4
 *
 * `distortionParams` declares it with `kind: "enum", step: 1`. The curve
 * engine switches on the integer, so a fractional write does not interpolate
 * — `character: 2.5` is not "halfway between Fold and Hard", it is whatever
 * the switch's fallthrough does with a non-integer. Every spec here rounds to
 * an integer BEFORE it is written, and `distortionSpec` returns the rounded
 * value so the test can assert the snap happened.
 *
 * The five characters, and what they actually do (from characterCurve.ts):
 *   - 0 WARM  — tanh-ish soft clip, gentle even harmonics. The transparent
 *               default; a good "just a little dirt" choice.
 *   - 1 TUBE  — asymmetric (bias shifts the transfer), so it produces odd
 *               harmonics and compresses the negative half harder. Sounds
 *               like a pushed power amp.
 *   - 2 FOLD  — needs radians, saturates late and hard; the classic rock
 *               "fold" that keeps bite instead of rounding off.
 *   - 3 HARD  — clips early, most aggressive, most compressed.
 *   - 4 TAPE  — bounded compression with a softer knee than Warm; sits
 *               between saturation and clipping without the fizz.
 *
 * The `bias` param is the tube/asymmetry control: it shifts the transfer
 * function. It is what turns a symmetric distortion into an even/odd
 * (chime vs. growl) colouring, so a "warm" character with a non-zero bias is
 * a deliberate choice, not an accident — the specs keep bias at 0 unless the
 * character is asymmetric by design.
 */

import { CHARACTER_MODE_COUNT, CHARACTER_MODE_LABELS, type CharacterMode } from "../../effects/characterCurve";

export type DistortionCharacter = CharacterMode;
export type GuitarVoice = "clean-push" | "palm-muted" | "high-gain" | "crunch" | "lead";

/** `distortionParams`. */
export const DISTORTION_RANGES = {
  /** 0…1 pre-gain into the clipper. */
  drive: { min: 0, max: 1, default: 0.4 },
  /** ENUM index 0…4 — Warm / Tube / Fold / Hard / Tape. NOT continuous. */
  character: { min: 0, max: 4, default: 0 },
  /** −1…1 transfer-curve shift. Asymmetry / even-odd colouring. */
  bias: { min: -1, max: 1, default: 0 },
  /** Post-clip tone in Hz. */
  tone: { min: 500, max: 12000, default: 5000 },
  /** Pre-clip high-pass in Hz — keeps inaudible sub out of the clipper. */
  preHpfHz: { min: 20, max: 400, default: 20 },
  /** Dry/wet. */
  mix: { min: 0, max: 1, default: 1 },
  /** Post-effect trim in dB. */
  output: { min: -12, max: 12, default: 0 },
} as const;

export interface DistortionSpec {
  readonly drive: number;
  /** Always an integer index into CHARACTER_MODE_LABELS. */
  readonly character: DistortionCharacter;
  readonly bias: number;
  readonly toneHz: number;
  readonly preHpfHz: number;
  readonly mix: number;
  readonly outputDb: number;
}

/** The character enum, re-exported so recipes do not import the engine directly. */
export const DISTORTION_CHARACTER_LABELS = CHARACTER_MODE_LABELS;
export const DISTORTION_CHARACTER_COUNT = CHARACTER_MODE_COUNT;

/**
 * Snap any number to a valid character index.
 *
 * Exported because it is the one piece of the bridge that must never be
 * skipped: `characterCurve` switches on the integer, so a fractional value
 * does not interpolate. A recipe author computing an "intensity" that lands
 * on 2.5 gets Fold or Hard depending on the fallthrough, not the average.
 */
export function snapCharacter(value: number): DistortionCharacter {
  if (!Number.isFinite(value)) return 0;
  const snapped = Math.round(value);
  return Math.max(0, Math.min(CHARACTER_MODE_COUNT - 1, snapped)) as DistortionCharacter;
}

/**
 * Guitar voice → distortion numbers, scaled by intensity (0…1).
 *
 * The mapping is written the way a guitarist would actually dial it in:
 *
 *   - CLEAN-PUSH: barely any drive, Warm, tone pushed up. This is the
 *     "I barely touched the guitar" sound — a studio guitar through a warm
 *     amp with the pre-gain barely opened.
 *   - PALM-MUTED: moderate drive, Tube with a NEGATIVE bias. Muted riffs
 *     are all about the chug; the asymmetry is what gives the attack some
 *     bark instead of a flat buzz. Low tone so it sits under the vocals.
 *   - HIGH-GAIN: the System of a Down / modern alt-metal recipe. Hard
 *     character, high drive, LOW pre-HPF left wide open (the guitar's own
 *     low end is part of the tone), and the output TRIMMED because a hard
 *     clipper with no makeup gain leaves a wall of compressed level. Dark
 *     tone — a high-gain sound is about the mid, and the top end is
 *     normally rolled off by the cab.
 *   - CRUNCH: Fold, the middle ground. Keeps bite where Warm rounds off.
 *   - LEAD: Tape, which is bounded and sits back less in the mix than a Hard
 *     clip — a lead needs to be audible, not dominant.
 *
 * The output trims are the part a recipe author usually forgets: drive
 * without makeup is a level change dressed up as a tone change.
 */
export function distortionSpec(voice: GuitarVoice, intensity: number): DistortionSpec | null {
  const t = Math.min(1, Math.max(0, intensity));
  const base: Record<GuitarVoice, DistortionSpec> = {
    "clean-push": { drive: 0.12, character: 0, bias: 0, toneHz: 8000, preHpfHz: 80, mix: 1, outputDb: 0 },
    "palm-muted": { drive: 0.42, character: 1, bias: -0.25, toneHz: 4200, preHpfHz: 100, mix: 1, outputDb: -2 },
    "high-gain": { drive: 0.78, character: 3, bias: 0, toneHz: 3200, preHpfHz: 40, mix: 1, outputDb: -6 },
    crunch: { drive: 0.5, character: 2, bias: 0, toneHz: 5000, preHpfHz: 80, mix: 1, outputDb: -3 },
    lead: { drive: 0.6, character: 4, bias: 0, toneHz: 6000, preHpfHz: 90, mix: 1, outputDb: -4 },
  };
  const s = base[voice];
  if (!s) return null;
  return {
    ...s,
    // More intensity = more drive and a darker, more compressed tone.
    drive: round2(Math.min(1, s.drive * (1 + 0.5 * t))),
    toneHz: round2(Math.max(DISTORTION_RANGES.tone.min, s.toneHz * (1 - 0.2 * t))),
    // A louder, harder clip needs a bigger trim, or "more distortion" also
    // means "louder" and the suggestion gets rejected for the wrong reason.
    outputDb: round2(Math.max(DISTORTION_RANGES.output.min, s.outputDb - 2 * t)),
    // The enum is NOT scaled with intensity — it is snapped, not interpolated.
    character: snapCharacter(s.character),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
