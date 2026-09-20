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
};

interface CueSpec {
  assetId: string;
  /** "before-seam": the cue REGION ends exactly at the section boundary. */
  place: "before-seam" | "at-seam";
  /** Shift from the anchor in whole bars (at-seam cues only). */
  offsetBars?: number;
  gain?: number;
}

/**
 * Transition type → cue specs. `fill` stays drum-only (the roll IS the
 * sound); `riser` keeps its drum build and adds the sweep asset on top;
 * `impact` is the classic pair — reverse-suck swelling INTO the seam, boom
 * landing ON it; `drop` fires the impact plus a downlifter right after the
 * seam; `break` lays a quiet sweep under the dropout silence; `custom` gets
 * a soft noise accent (foley-style snap) so it is not silent.
 */
const TRANSITION_CUES: Partial<Record<ArrangementTransitionType, CueSpec[]>> = {
  riser: [{ assetId: "factory.fx.riser", place: "before-seam" }],
  impact: [
    { assetId: "factory.fx.impact", place: "at-seam" },
    { assetId: "factory.fx.reverse", place: "before-seam", gain: 0.8 },
  ],
  drop: [
    { assetId: "factory.fx.impact", place: "at-seam" },
    { assetId: "factory.fx.downlifter", place: "at-seam", gain: 0.8 },
  ],
  break: [{ assetId: "factory.fx.sweep", place: "before-seam", gain: 0.55 }],
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
}

/**
 * Pure bar-math for cue clips. Deterministic ids (`cue-<transitionId>-<n>`).
 * Clip regions COVER the asset (length = ceil(seconds / barSeconds), min 1)
 * with stretchRate 1 — a one-shot that is shorter than its region simply
 * ends early, so the curated/mastered asset keeps its exact character.
 */
export function buildTransitionCueClips(
  seams: TransitionSeam[],
  bpm: number,
  trackId: string,
): AudioClip[] {
  const effectiveBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const barSeconds = 240 / effectiveBpm;
  const clips: AudioClip[] = [];
  for (const seam of seams) {
    const specs = TRANSITION_CUES[seam.type];
    if (!specs) continue;
    specs.forEach((spec, n) => {
      const seconds = CUE_ASSET_SECONDS[spec.assetId] ?? 1.5;
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
        bufferId: spec.assetId,
        startBar,
        lengthBars,
        offsetSec: 0,
        trimStart: 0,
        trimEnd: 0,
        gain: spec.gain ?? 1,
        fadeIn: 0.004,
        fadeOut: 0.03,
        stretchRate: 1,
        reverse: false,
      });
    });
  }
  return clips;
}
