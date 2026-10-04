import type { ArrangementTransitionType, AudioClip } from "../project-model/types";

/**
 * T3 wave 2 — REAL transition cue sounds. The drum-row treatments
 * (transitions.ts) shape the pattern; these cues put an actual FX asset on a
 * dedicated arrangement lane so a build HAS a riser, a drop HAS an impact.
 *
 * Cues are plain AudioClips on the "FX Cues" instrument track: the live
 * scheduler and the offline renderer already play audioClips in song mode,
 * so exports match playback with zero engine changes. Assets are `factory.*`
 * ids — present in the synthesized bank by construction (and overridden by
 * the curated layer when it lands).
 */

export const FX_CUE_TRACK_NAME = "FX Cues";

/** Nominal rendered seconds of each cue asset — mirrors `DURATIONS` in
 *  src/sample-library/factory.ts (kept in sync by a source-grep pin test). */
export const CUE_ASSET_SECONDS: Record<string, number> = {
  "factory.fx.riser": 2.0,
  "factory.fx.downlifter": 2.0,
  "factory.fx.impact": 1.1,
  "factory.fx.sweep": 1.5,
  "factory.fx.reverse": 1.25,
  "factory.fx.noise": 0.35,
  "factory.fx.subdrop": 1.5,
  // Transition-pack siblings (2026-10-04): quick 1-bar cousins of the long
  // family, played when the outgoing section cannot fit the long asset.
  "factory.fx.impact2": 0.9,
  "factory.fx.riser-short": 0.85,
  "factory.fx.noise-down": 0.95,
};

interface CueSpec {
  assetId: string;
  /** "before-seam": the cue REGION ends exactly at the section boundary. */
  place: "before-seam" | "at-seam";
  /** Shift from the anchor in whole bars (at-seam cues only). */
  offsetBars?: number;
  gain?: number;
  /**
   * Short sibling used when the OUTGOING section cannot fit `assetId`'s full
   * region (measured: `outgoingBars < ceil(seconds / barSeconds)`). Fires on
   * user-tightened or one-bar run-ups where the long asset would be cut
   * mid-build (fadeOut on a 2 s riser's last 15 % reads as a click); a real
   * section keeps the long build.
   */
  shortAssetId?: string;
  /** Gain override for the short variant (its own nominal level). */
  shortGain?: number;
  /**
   * Richer sibling used when the INCOMING section is long enough to earn it
   * (measured across SONG_FORMS: the 16-bar hooks of trance / eurodance /
   * latin / detroit / postrock / ukg / amapiano get the cinematic
   * metal-ring hit; the 8-bar loops of jersey / hyperpop / chiptune /
   * boombap / dnb keep the tight sub thump the drum kit implies).
   */
  longAssetId?: string;
  /** Incoming-section bar threshold at/above which `longAssetId` fires. */
  longAtOrAboveBars?: number;
  /** Gain override for the long variant. */
  longGain?: number;
}

/**
 * Transition type → cue specs. `fill` stays drum-only (the roll IS the
 * sound); `riser` keeps its drum build and adds the sweep asset on top;
 * `impact` is the classic pair — reverse-suck swelling INTO the seam, boom
 * landing ON it; `drop` fires the impact plus a sub-drop right after the
 * seam; `break` layers the quiet mid sweep with a falling-air tail into the
 * dropout silence; `custom` gets a soft noise accent (foley-style snap) so
 * it is not silent.
 *
 * Transition-pack siblings (2026-10-04): `riser` swaps in the 0.85 s
 * `riser-short` only when the outgoing window cannot fit the 2 s build;
 * `impact` swaps in the cinematic `impact2` on 16-bar incoming sections;
 * `break` carries `noise-down` as the at-seam falling-air partner.
 */
const TRANSITION_CUES: Partial<Record<ArrangementTransitionType, CueSpec[]>> = {
  riser: [
    {
      assetId: "factory.fx.riser",
      place: "before-seam",
      shortAssetId: "factory.fx.riser-short",
      shortGain: 0.95,
    },
  ],
  impact: [
    {
      assetId: "factory.fx.impact",
      place: "at-seam",
      longAssetId: "factory.fx.impact2",
      longAtOrAboveBars: 16,
      longGain: 0.9,
    },
    { assetId: "factory.fx.reverse", place: "before-seam", gain: 0.8 },
  ],
  drop: [
    { assetId: "factory.fx.impact", place: "at-seam" },
    // The drill/trap staple: a sub pitch-fall under the incoming section
    // (replaces the generic downlifter air sweep).
    { assetId: "factory.fx.subdrop", place: "at-seam", gain: 0.9 },
  ],
  break: [
    { assetId: "factory.fx.sweep", place: "before-seam", gain: 0.55 },
    // Falling-air tail into the new section — the descent partner of the
    // impact pair's at-seam boom. Quiet: the dropout silence is the moment.
    { assetId: "factory.fx.noise-down", place: "at-seam", gain: 0.4 },
  ],
  custom: [{ assetId: "factory.fx.noise", place: "at-seam", gain: 0.5 }],
};

/** Primary cue asset for the transition's `cueAssetId` metadata (null = drum-only). */
export function transitionCueAsset(type: ArrangementTransitionType): string | null {
  const specs = TRANSITION_CUES[type];
  return specs && specs.length > 0 ? specs[0].assetId : null;
}

export interface TransitionSeam {
  id: string;
  type: ArrangementTransitionType;
  /** Bar where the incoming section starts (the seam itself). */
  seamBar: number;
  /** Bar where the outgoing section starts — before-seam cues never start earlier. */
  outgoingStartBar: number;
  /**
   * Optional bars of the section that STARTS at this seam. Selects the short
   * sibling for at-seam cues on long incoming sections (see `shortBelowBars`
   * interpretation per placement). Omitted = no short swap for at-seam cues.
   */
  incomingBars?: number;
}

/**
 * Which asset a spec plays at this seam. Short sibling fires when the
 * OUTGOING section cannot fit the long asset's region (`outgoingBars <
 * ceil(seconds / barSeconds)` — a user-tightened or one-bar run-up);
 * long sibling fires when the INCOMING section reaches its threshold
 * (a 16-bar hook earns the richer hit). Both default to the base asset.
 */
function assetForSeam(spec: CueSpec, seam: TransitionSeam, barSeconds: number): { assetId: string; gain: number } {
  let assetId = spec.assetId;
  let gain = spec.gain ?? 1;
  if (spec.shortAssetId) {
    const longSeconds = CUE_ASSET_SECONDS[spec.assetId] ?? 1.5;
    const longWantedBars = Math.max(1, Math.ceil(longSeconds / barSeconds));
    const outgoingBars = seam.seamBar - seam.outgoingStartBar;
    if (outgoingBars < longWantedBars) {
      assetId = spec.shortAssetId;
      gain = spec.shortGain ?? gain;
    }
  }
  if (spec.longAssetId && spec.longAtOrAboveBars !== undefined) {
    const incomingBars = seam.incomingBars ?? 0;
    if (incomingBars >= spec.longAtOrAboveBars) {
      assetId = spec.longAssetId;
      gain = spec.longGain ?? gain;
    }
  }
  return { assetId, gain };
}

/**
 * Pure bar-math for cue clips. Deterministic ids (`cue-<transitionId>-<n>`).
 * Clip regions COVER the asset (length = ceil(seconds / barSeconds), min 1)
 * with stretchRate 1 — a one-shot that is shorter than its region simply
 * ends early, so the curated/mastered asset keeps its exact character.
 */
export function buildTransitionCueClips(seams: TransitionSeam[], bpm: number, trackId: string): AudioClip[] {
  const effectiveBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const barSeconds = 240 / effectiveBpm;
  const clips: AudioClip[] = [];
  for (const seam of seams) {
    const specs = TRANSITION_CUES[seam.type];
    if (!specs) continue;
    specs.forEach((spec, n) => {
      const { assetId, gain } = assetForSeam(spec, seam, barSeconds);
      const seconds = CUE_ASSET_SECONDS[assetId] ?? 1.5;
      const wantedBars = Math.max(1, Math.ceil(seconds / barSeconds));
      let startBar: number;
      let lengthBars: number;
      if (spec.place === "before-seam") {
        startBar = Math.max(seam.outgoingStartBar, seam.seamBar - wantedBars);
        lengthBars = Math.max(1, seam.seamBar - startBar);
      } else {
        startBar = seam.seamBar + (spec.offsetBars ?? 0);
        lengthBars = wantedBars;
      }
      clips.push({
        id: `cue-${seam.id}-${n}`,
        trackId,
        bufferId: assetId,
        startBar,
        lengthBars,
        offsetSec: 0,
        trimStart: 0,
        trimEnd: 0,
        gain,
        fadeIn: 0.004,
        fadeOut: 0.03,
        stretchRate: 1,
        reverse: false,
      });
    });
  }
  return clips;
}
